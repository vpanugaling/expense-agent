const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { google } = require('googleapis');

// Env
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const SHEET_ID = process.env.SHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OCR_BASE_URL = process.env.OCR_BASE_URL || 'http://ocr:8080';
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS.split(',');
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'PHP';
const GOOGLE_CREDENTIALS_PATH = '/secrets/google-sa.json';

// Categories & payment methods
const CATEGORIES = [
  'Groceries', 'Eating out', 'Coffee/snacks', 'Transportation', 'Fuel',
  'Utilities', 'Rent/dues', 'Internet/mobile load', 'Household supplies',
  'Personal care', 'Medical/Pharmacy', 'Kids/Family', 'Shopping',
  'Subscriptions', 'Gifts/Donations', 'Travel', 'Fees/Bank charges', 'Other'
];

const PAYMENT_METHODS = ['Cash', 'GCash', 'Card', 'Bank Transfer', 'Other'];

const app = express();
app.use(express.raw({ type: 'application/json' }));

app.use((req, res, next) => {
  console.log('📥 Webhook hit:', req.method, req.url, 'Body length:', req.body?.length || 'undefined');
  next();
});

// Telegram bot (no polling, webhook only)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Google auth client
const gCreds = require(GOOGLE_CREDENTIALS_PATH);
const auth = new google.auth.GoogleAuth({
  credentials: gCreds,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets'
  ]
});
const drive = google.drive({ version: 'v3', auth });

// ✅ Gemini call with exponential backoff retry
async function callGemini(payload) {
  let delay = 3000;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        payload,
        { timeout: 30000 }
      );
    } catch (err) {
      if (err.response?.status === 429 && attempt < 4) {
        console.log(`⏳ Rate limited (attempt ${attempt}/4). Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2; // 3s → 6s → 12s
      } else {
        throw err;
      }
    }
  }
}

// Webhook endpoint
app.post('/telegram/webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    console.log('🚫 Unauthorized webhook:', req.headers['x-telegram-bot-api-secret-token']);
    return res.status(403).send('Forbidden');
  }

  let update;
  try {
    update = JSON.parse(req.body);
    console.log('📨 Incoming update:', JSON.stringify({
      chatId: update.message?.chat?.id,
      userId: update.message?.from?.id,
      text: update.message?.text,
      photo: !!update.message?.photo
    }, null, 2));
  } catch (e) {
    console.error('❌ Invalid JSON:', e);
    return res.status(400).send('Bad Request');
  }

  try {
    const userId = update.message?.from?.id?.toString();
    console.log('🔍 Checking user', userId, 'against ALLOWED_USER_IDS:', ALLOWED_USER_IDS);

    if (update.message && update.message.photo) {
      await handleReceipt(update.message);
    } else if (update.message && update.message.text) {
      await handleQuery(update.message);
    } else {
      console.log('📭 Ignored non-message update');
    }
  } catch (e) {
    console.error('❌ Handler error:', e);
  }

  res.send('OK');
});

// Handle receipt photo
async function handleReceipt(message) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();

  if (!ALLOWED_USER_IDS.includes(userId)) {
    return bot.sendMessage(chatId, '❌ Not authorized to use this bot.');
  }

  const photos = message.photo;
  const largestPhoto = photos[photos.length - 1];
  const fileId = largestPhoto.file_id;

  await bot.sendMessage(chatId, '📸 Processing your receipt...');

  try {
    // 1) Download file from Telegram
    console.log('⬇️ Downloading photo from Telegram...');
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const imgResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imgResp.data);
    console.log(`✅ Photo downloaded: ${imageBuffer.length} bytes`);

    // 2) SKIP Drive upload (service account quota issue)
    const driveFileUrl = 'https://drive.google.com/drive/folders/TEST - Drive upload disabled';
    console.log('⏭️ Drive upload skipped (service account quota limitation)');

    // 3) OCR (local service)
    console.log('🔍 Sending to OCR...');
    const form = new FormData();
    form.append('image', imageBuffer, { filename: 'receipt.jpg' });

    const ocrResp = await axios.post(`${OCR_BASE_URL}/ocr`, form, {
      headers: form.getHeaders(),
      timeout: 30000
    });
    const ocrText = ocrResp.data.text || '';
    const ocrConf = ocrResp.data.confidence || 0;
    console.log(`✅ OCR extracted (${ocrConf.toFixed(2)}): "${ocrText.substring(0, 100)}..."`);

    // 4) Gemini: extract + categorize
    console.log('🤖 Asking Gemini to analyze...');
    const geminiPrompt = `You are a strict JSON API. Given OCR text of a receipt, extract:

- receipt_date: ISO date YYYY-MM-DD (guess if only date-like string)
- merchant: short merchant name  
- total: number (final total amount)
- currency: always "${DEFAULT_CURRENCY}"
- category: one of [${CATEGORIES.join(', ')}]
- payment_method: one of [${PAYMENT_METHODS.join(', ')}]
- notes: short free-text notes if helpful
- confidence: 0.0-1.0 of your extraction confidence

OCR text:
${ocrText}

Return ONLY JSON with these keys. No markdown, no extra text.`;

    // ✅ Using retry wrapper instead of direct axios.post
    const gemResp = await callGemini({
      contents: [{ parts: [{ text: geminiPrompt }] }]
    });

    const rawText = gemResp.data.candidates[0].content.parts[0].text.trim();
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/, '')
      .trim();

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error from Gemini:', rawText);
      await bot.sendMessage(chatId, `⚠️ Could not parse AI response. OCR text:\n\`${ocrText.substring(0, 500)}\``);
      return;
    }

    const confidence = Number(extracted.confidence || 0);
    console.log('✅ Gemini extracted:', JSON.stringify(extracted, null, 2));

    // 5) Append to Sheets
    console.log('📊 Adding to Google Sheets...');
    const doc = new GoogleSpreadsheet(SHEET_ID, auth); // ✅ pass auth directly (v4+ compatible)
    await doc.loadInfo();

    // ✅ Safe fallback to first sheet index
    const sheet = doc.sheetsByTitle['Expenses'] || doc.sheetsByIndex;

    await sheet.addRow({
      timestamp: new Date().toISOString(),
      receipt_date: extracted.receipt_date || '',
      merchant: extracted.merchant || '',
      total: Number(extracted.total || 0),
      currency: extracted.currency || DEFAULT_CURRENCY,
      category: extracted.category || 'Other',
      payment_method: extracted.payment_method || 'Other',
      notes: extracted.notes || '',
      drive_file_url: driveFileUrl,
      ocr_confidence: ocrConf,
      needs_confirmation: confidence < 0.7
    });

    const summary = `**Merchant**: ${extracted.merchant || 'Unknown'}\n**Total**: ₱${Number(extracted.total || 0).toLocaleString()}\n**Category**: ${extracted.category || 'Other'}\n**Payment**: ${extracted.payment_method || 'Cash'}\n**AI confidence**: ${(confidence * 100).toFixed(0)}%`;

    await bot.sendMessage(chatId, `✅ **Receipt added to sheet!**\n\n${summary}\n\n📁 Drive: ${driveFileUrl}\n\nOCR text:\n\`${ocrText.substring(0, 300)}...\``);
    console.log('🎉 Receipt fully processed!');

  } catch (err) {
    console.error('handleReceipt error:', err.message);
    console.error('Full error:', err);
    await bot.sendMessage(chatId, `❌ Error processing receipt:\n\`${err.message}\`\n\nPlease try again or check logs.`);
  }
}

// Basic query handler
async function handleQuery(message) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();

  if (!ALLOWED_USER_IDS.includes(userId)) return;

  console.log('✅ User authorized, handling query:', message.text);

  await bot.sendMessage(chatId,
    `👋 **Expense Bot Ready!**\n\n` +
    `📸 *Send me a receipt photo* and I will:\n` +
    `• Extract merchant/total with OCR\n` +
    `• Auto-categorize (Groceries/Fuel/etc)\n` +
    `• Log to Google Sheets\n\n` +
    `*Ready when you are!*`
  );
}

// Start Express
const port = 3000;
app.listen(port, () => {
  console.log(`Bot server running on port ${port}`);
});
