const { CATEGORIES, findCategory } = require('../categories');
const { createConfirmFlow } = require('../confirm-flow');
const { validateAmount } = require('./validators');

function toIsoDate(d) {
  return d.toISOString().split('T')[0];
}

function buildEditors(now) {
  return {
    amount: {
      parse: (input) => {
        const r = validateAmount(input);
        return r.valid ? { valid: true, value: r.value } : null;
      },
      prompt: '✏️ Type the correct amount (e.g., 450.50):',
      invalidMessage: '⚠️ Invalid amount. Please type a positive number (e.g., 450.50):',
    },
    category: {
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
      dataKey: 'tx_date',
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
  return async function renderPurchase(chatId, data) {
    const amount = Number(data.amount || 0);
    const summary =
      `💳 *Purchase preview*\n\n` +
      `• *Card:* ${data.card_name}\n` +
      `• *Amount:* ₱${amount.toLocaleString()}\n` +
      `• *Category:* ${data.category || 'Other'}\n` +
      `• *Date:* ${data.tx_date}\n` +
      (data.notes ? `• *Note:* ${data.notes}\n` : '');

    await bot.sendMessage(chatId, summary, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: 'card_purchase_confirm' },
            { text: '✏️ Edit Amount', callback_data: 'card_purchase_edit_amount' },
          ],
          [
            { text: '📁 Edit Category', callback_data: 'card_purchase_edit_category' },
            { text: '📅 Edit Date', callback_data: 'card_purchase_edit_date' },
          ],
          [{ text: '❌ Cancel', callback_data: 'card_purchase_cancel' }],
        ],
      },
    });
  };
}

function createPurchaseFlow({ bot, onConfirm, now = () => new Date() }) {
  const editors = buildEditors(now);
  const render = buildRender(bot);

  return createConfirmFlow({
    prefix: 'card_purchase_',
    bot,
    editors,
    render,
    onConfirm,
    onCancel: async (chatId) => {
      await bot.sendMessage(chatId, '❌ Purchase cancelled.');
    },
    onStale: async (chatId) => {
      await bot.sendMessage(chatId, '⚠️ No pending purchase. Start a new one with /card tx.');
    },
  });
}

module.exports = { createPurchaseFlow };
