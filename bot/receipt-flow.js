const { CATEGORIES, findCategory } = require('./categories');
const { createConfirmFlow } = require('./confirm-flow');

function toIsoDate(d) {
  return d.toISOString().split('T')[0];
}

function buildEditors(now) {
  return {
    total: {
      parse: (input) => {
        const n = parseFloat(String(input).replace(/[^0-9.]/g, ''));
        return !isNaN(n) && n > 0 ? { valid: true, value: n } : null;
      },
      prompt: '✏️ Type the correct total (e.g., 450.50):',
      invalidMessage: '⚠️ Invalid number. Please type the total (e.g., 450.50):',
    },
    category: {
      dataKey: 'category',
      parse: (input) => {
        const trimmed = String(input).trim();
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= CATEGORIES.length) {
          return { valid: true, value: CATEGORIES[num - 1] };
        }
        const c = findCategory(trimmed);
        return c ? { valid: true, value: c } : null;
      },
      prompt:
        `📁 Reply with category name or number:\n\n` +
        CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n'),
      invalidMessage: `⚠️ Invalid category. Try again or type a number (1-${CATEGORIES.length}).`,
    },
    date: {
      dataKey: 'receipt_date',
      parse: (input) => {
        const s = String(input).trim().toLowerCase();
        const today = now();
        if (s === 'today') return { valid: true, value: toIsoDate(today) };
        if (s === 'yesterday') {
          const y = new Date(today);
          y.setDate(y.getDate() - 1);
          return { valid: true, value: toIsoDate(y) };
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { valid: true, value: s };
        const natural = new Date(s);
        if (!isNaN(natural.getTime())) return { valid: true, value: toIsoDate(natural) };
        return null;
      },
      prompt: '📅 Type the correct date (YYYY-MM-DD or "today", "yesterday"):',
      invalidMessage: '⚠️ Invalid date format. Try YYYY-MM-DD, "today", or "yesterday".',
    },
  };
}

function buildRender(bot) {
  return async function renderReceipt(chatId, data) {
    const total = Number(data.total || 0);
    const confidence = Number(data.confidence || 0);
    const summary =
      `📸 *Receipt Extracted:*\n\n` +
      `• *Merchant:* ${data.merchant || 'Unknown'}\n` +
      `• *Total:* ₱${total.toLocaleString()}\n` +
      `• *Category:* ${data.category || 'Other'}\n` +
      `• *Payment:* ${data.payment_method || 'Cash'}\n` +
      `• *Date:* ${data.receipt_date || 'Unknown'}\n` +
      `• *AI confidence:* ${(confidence * 100).toFixed(0)}%`;

    await bot.sendMessage(chatId, summary, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: 'receipt_confirm' },
            { text: '✏️ Edit Total', callback_data: 'receipt_edit_total' },
          ],
          [
            { text: '📁 Edit Category', callback_data: 'receipt_edit_category' },
            { text: '📅 Edit Date', callback_data: 'receipt_edit_date' },
          ],
          [{ text: '❌ Cancel', callback_data: 'receipt_cancel' }],
        ],
      },
    });
  };
}

function createReceiptFlow({ bot, onConfirm, now = () => new Date() }) {
  const editors = buildEditors(now);
  const render = buildRender(bot);

  return createConfirmFlow({
    prefix: 'receipt_',
    bot,
    editors,
    render,
    onConfirm,
    onCancel: async (chatId) => {
      await bot.sendMessage(chatId, '❌ Receipt cancelled. Send another photo when ready.');
    },
    onStale: async (chatId) => {
      await bot.sendMessage(chatId, '⚠️ No pending receipt. Please send a new photo.');
    },
  });
}

module.exports = { createReceiptFlow };
