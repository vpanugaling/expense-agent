const { createConfirmFlow } = require('../confirm-flow');
const { escapeMd } = require('../markdown');
const { validateAmount } = require('./validators');

const PREFIX = 'card_payment_';
const PICK_PREFIX = `${PREFIX}pick_`;

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
  return async function renderPayment(chatId, data) {
    const amount = Number(data.amount || 0);
    const summary =
      `💳 *Payment preview*\n\n` +
      `• *Card:* ${escapeMd(data.card_name)}\n` +
      `• *Cycle:* ${data.statement_cycle}\n` +
      `• *Amount:* ₱${amount.toLocaleString()}\n` +
      `• *Date:* ${data.tx_date}\n`;

    await bot.sendMessage(chatId, summary, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: `${PREFIX}confirm` },
            { text: '✏️ Edit Amount', callback_data: `${PREFIX}edit_amount` },
          ],
          [{ text: '📅 Edit Date', callback_data: `${PREFIX}edit_date` }],
          [{ text: '❌ Cancel', callback_data: `${PREFIX}cancel` }],
        ],
      },
    });
  };
}

function createPaymentFlow({ bot, onConfirm, now = () => new Date() }) {
  // Two-phase state:
  //   1. pendingPicker — user has been shown the cycle picker; no cycle chosen yet.
  //   2. confirmFlow's internal pending — cycle is bound, user is on the confirm preview.
  // The picker's cancel button must be intercepted here BEFORE confirm-flow sees it,
  // because during the picker phase confirm-flow has no pending state and would otherwise
  // fire onStale ("no pending payment") when the user hits Cancel legitimately.
  const pendingPicker = new Map();
  const editors = buildEditors(now);
  const render = buildRender(bot);

  const confirmFlow = createConfirmFlow({
    prefix: PREFIX,
    bot,
    editors,
    render,
    onConfirm,
    onCancel: async (chatId) => {
      await bot.sendMessage(chatId, '❌ Payment cancelled.');
    },
    onStale: async (chatId) => {
      await bot.sendMessage(chatId, '⚠️ No pending payment. Start a new one with /card tx.');
    },
  });

  async function start(chatId, { card_name, cycles, amount, tx_date }) {
    if (!cycles || cycles.length === 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ ${card_name} has no open statement cycles. Close one with /card statement first.`,
      );
      return;
    }
    pendingPicker.set(chatId, { card_name, cycles, amount, tx_date });
    const buttons = cycles.map((c) => [{
      text: `${c.cycle_month} · ₱${Number(c.outstanding).toLocaleString()} (due ${c.due_date})`,
      callback_data: `${PICK_PREFIX}${c.cycle_month}`,
    }]);
    buttons.push([{ text: '❌ Cancel', callback_data: `${PREFIX}cancel` }]);
    await bot.sendMessage(
      chatId,
      `💳 Which cycle is this payment for?\n\n*${escapeMd(card_name)}* — ₱${Number(amount).toLocaleString()}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      },
    );
  }

  async function handleCallback(chatId, callbackData) {
    if (typeof callbackData !== 'string' || !callbackData.startsWith(PREFIX)) return false;

    // Phase 1: picker click.
    if (callbackData.startsWith(PICK_PREFIX)) {
      const cycleMonth = callbackData.slice(PICK_PREFIX.length);
      const pending = pendingPicker.get(chatId);
      if (!pending) {
        await bot.sendMessage(chatId, '⚠️ No pending payment. Start a new one with /card tx.');
        return true;
      }
      const cycle = pending.cycles.find((c) => c.cycle_month === cycleMonth);
      if (!cycle) {
        await bot.sendMessage(chatId, `⚠️ Cycle ${cycleMonth} not found.`);
        return true;
      }
      pendingPicker.delete(chatId);
      await confirmFlow.start(chatId, {
        card_name: pending.card_name,
        statement_cycle: cycleMonth,
        amount: pending.amount,
        tx_date: pending.tx_date,
      });
      return true;
    }

    // Cancel during picker phase: consume it here so confirm-flow doesn't onStale.
    if (
      callbackData === `${PREFIX}cancel` &&
      pendingPicker.has(chatId) &&
      !confirmFlow._hasPending(chatId)
    ) {
      pendingPicker.delete(chatId);
      await bot.sendMessage(chatId, '❌ Payment cancelled.');
      return true;
    }

    return confirmFlow.handleCallback(chatId, callbackData);
  }

  async function handleTextInput(chatId, text) {
    return confirmFlow.handleTextInput(chatId, text);
  }

  return { start, handleCallback, handleTextInput };
}

module.exports = { createPaymentFlow };
