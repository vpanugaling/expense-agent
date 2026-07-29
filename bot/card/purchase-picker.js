const { createConfirmFlow } = require('../confirm-flow');
const { createTwoPhasePicker } = require('../two-phase-picker');
const { escapeMd } = require('../markdown');
const { validateAmount } = require('./validators');
const { inferCycleFromPurchases } = require('./purchases');

const PREFIX = 'card_ppay_';
const TOGGLE = 'toggle_';

function toIsoDate(d) {
  return d.toISOString().split('T')[0];
}

// buildEditors — the confirm-phase field editors. Deliberately narrow:
// only amount and date. Not category (payment rows have none) and NOT the
// purchase selection (per plan: to change the tagged set, user cancels
// and starts over — keeps confirm-flow's scalar-editor contract clean).
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

function buildConfirmRender(bot) {
  return async function renderConfirm(chatId, data) {
    const amount = Number(data.amount || 0);
    const cycleLine = data.statement_cycle
      ? `• *Cycle:* ${data.statement_cycle}\n`
      : `• *Cycle:* _(multi-cycle — unlinked)_\n`;
    const paidCount = Array.isArray(data.paid_purchases) ? data.paid_purchases.length : 0;
    const summary =
      `💳 *Payment preview*\n\n` +
      `• *Card:* ${escapeMd(data.card_name)}\n` +
      cycleLine +
      `• *Amount:* ₱${amount.toLocaleString()}\n` +
      `• *Date:* ${data.tx_date}\n` +
      `• *Covers:* ${paidCount} purchase(s)\n`;
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

function sumSelected(state) {
  const set = new Set(state.selectedIds);
  return state.allPurchases.reduce((acc, p) => acc + (set.has(p.tx_id) ? Number(p.amount) : 0), 0);
}

function renderPicker(state) {
  const selected = new Set(state.selectedIds);
  const sum = sumSelected(state);
  const header =
    `💳 *${escapeMd(state.card_name)}* — payment of ₱${Number(state.amountTyped).toLocaleString()}\n` +
    `Selected: ₱${sum.toLocaleString()} / ₱${Number(state.amountTyped).toLocaleString()} · ${selected.size} of ${state.allPurchases.length} purchases`;
  const buttons = state.allPurchases.map((p) => [{
    text: `${selected.has(p.tx_id) ? '[x]' : '[ ]'} ${p.tx_date} · ₱${Number(p.amount).toLocaleString()} · ${p.category || ''}`.trim(),
    callback_data: `${PREFIX}pick_${TOGGLE}${p.tx_id}`,
  }]);
  buttons.push([
    { text: '✅ Done', callback_data: `${PREFIX}pick_done` },
    { text: '❌ Cancel', callback_data: `${PREFIX}pick_cancel` },
  ]);
  return { text: header, keyboard: buttons };
}

function handlePickerToken(state, token) {
  if (token === 'done') {
    if (state.selectedIds.length === 0) {
      return { keepPicking: true, warning: '⚠️ Select at least one purchase or Cancel.' };
    }
    const selected = new Set(state.selectedIds);
    const selectedPurchases = state.allPurchases.filter((p) => selected.has(p.tx_id));
    const sum = selectedPurchases.reduce((s, p) => s + Number(p.amount), 0);
    if (sum !== Number(state.amountTyped)) {
      return {
        keepPicking: true,
        warning: `⚠️ Selected ₱${sum.toLocaleString()} doesn't match payment amount ₱${Number(state.amountTyped).toLocaleString()}. Adjust selection or Cancel.`,
      };
    }
    const cycleInfo = inferCycleFromPurchases(selectedPurchases, state.statement_day);
    const confirmSeed = {
      card_name: state.card_name,
      amount: Number(state.amountTyped),
      tx_date: state.tx_date,
      paid_purchases: state.selectedIds.slice(),
      statement_cycle: cycleInfo.cycle_month || '',
    };
    const warning = cycleInfo.multi
      ? `⚠️ Selected purchases span multiple cycles (${cycleInfo.cycles.join(', ')}). This payment will be recorded as unlinked (no statement_cycle).`
      : undefined;
    return { keepPicking: false, confirmSeed, warning };
  }

  if (token.startsWith(TOGGLE)) {
    const txid = token.slice(TOGGLE.length);
    // Stale token — id no longer present in this state (e.g. after a re-start).
    // Silently no-op: the abstraction will still re-render, which is fine.
    if (!state.allPurchases.find((p) => p.tx_id === txid)) {
      return { keepPicking: true };
    }
    const has = state.selectedIds.includes(txid);
    const nextIds = has
      ? state.selectedIds.filter((x) => x !== txid)
      : [...state.selectedIds, txid];
    return { keepPicking: true, nextState: { ...state, selectedIds: nextIds } };
  }

  return { keepPicking: true };
}

function createPurchasePicker({ bot, onConfirm, now = () => new Date() }) {
  const editors = buildEditors(now);
  const confirmRender = buildConfirmRender(bot);
  const confirmFlow = createConfirmFlow({
    prefix: PREFIX,
    bot,
    editors,
    render: confirmRender,
    onConfirm,
    onCancel: async (chatId) => {
      await bot.sendMessage(chatId, '❌ Payment cancelled.');
    },
    onStale: async (chatId) => {
      await bot.sendMessage(chatId, '⚠️ No pending payment. Start a new one with /card tx.');
    },
  });

  const picker = createTwoPhasePicker({
    prefix: PREFIX,
    bot,
    pickerRender: renderPicker,
    onPick: handlePickerToken,
    onCancel: async (chatId) => {
      await bot.sendMessage(chatId, '❌ Payment cancelled.');
    },
    confirmFlow,
  });

  async function start(chatId, { card_name, amount, purchases, statement_day, tx_date }) {
    if (!purchases || purchases.length === 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ ${card_name} has no unpaid purchases. Log a purchase first with /card tx <card> purchase.`,
      );
      return;
    }
    await picker.start(chatId, {
      card_name,
      statement_day,
      amountTyped: Number(amount),
      tx_date,
      allPurchases: purchases,
      selectedIds: [],
    });
  }

  return {
    start,
    handleCallback: picker.handleCallback,
    handleTextInput: picker.handleTextInput,
  };
}

module.exports = { createPurchasePicker };
