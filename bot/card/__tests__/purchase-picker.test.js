const { createPurchasePicker } = require('../purchase-picker');
const { createMockBot } = require('../../test-utils/mock-bot');

const now = () => new Date('2026-07-30T00:00:00Z');

function make(overrides = {}) {
  const bot = createMockBot();
  const onConfirm = jest.fn();
  const picker = createPurchasePicker({ bot, onConfirm, now, ...overrides });
  return { picker, bot, onConfirm };
}

// A slice of purchases spanning 2 cycles for statement_day=25:
//   2026-07-10 → cycle 2026-06 (day 10 < 25)
//   2026-07-26 → cycle 2026-07 (day 26 >= 25)
//   2026-08-01 → cycle 2026-07 (day 1 < 25)
const P_A = { tx_id: 'p_a', tx_date: '2026-07-10', amount: 100, category: 'Groceries' };
const P_B = { tx_id: 'p_b', tx_date: '2026-07-26', amount: 200, category: 'Dining' };
const P_C = { tx_id: 'p_c', tx_date: '2026-08-01', amount: 300, category: 'Transport' };

const singleCyclePurchases = [P_B, P_C]; // both in 2026-07

function startArgs(overrides = {}) {
  return {
    card_name: 'BPI',
    amount: 500,
    tx_date: '2026-07-30',
    statement_day: 25,
    purchases: [P_A, P_B, P_C],
    ...overrides,
  };
}

describe('createPurchasePicker.start', () => {
  test('empty purchases → warns and does not open picker', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs({ purchases: [] }));
    expect(bot.lastSent().text).toMatch(/no unpaid purchases/i);
    // No pick_* callback should be handled as pending.
    const handled = await picker.handleCallback(1, 'card_ppay_pick_done');
    // Foreign for picker (no state); the abstraction swallows silently → returns true.
    expect(handled).toBe(true);
  });

  test('renders header with running total 0/amount and one row per purchase', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs());
    const msg = bot.lastSent();
    expect(msg.text).toContain('BPI');
    expect(msg.text).toContain('500');
    expect(msg.text).toMatch(/Selected:.*₱0.*₱500/);
    expect(msg.text).toMatch(/0 of 3/);
    const buttons = msg.options.reply_markup.inline_keyboard;
    // 3 purchase rows + 1 done/cancel row.
    expect(buttons).toHaveLength(4);
    const cbs = buttons.flat().map((b) => b.callback_data);
    expect(cbs).toEqual(expect.arrayContaining([
      'card_ppay_pick_toggle_p_a',
      'card_ppay_pick_toggle_p_b',
      'card_ppay_pick_toggle_p_c',
      'card_ppay_pick_done',
      'card_ppay_pick_cancel',
    ]));
    // Unselected purchases render with an empty checkbox.
    for (const btn of buttons.flat()) {
      if (btn.callback_data.startsWith('card_ppay_pick_toggle_')) {
        expect(btn.text.startsWith('[ ]')).toBe(true);
      }
    }
  });
});

describe('createPurchasePicker — toggle', () => {
  test('toggling a purchase updates header total and marks it selected in the re-render', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs());
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b'); // 200
    const edited = bot.lastEdited();
    expect(edited).toBeDefined();
    expect(edited.text).toMatch(/Selected:.*₱200.*₱500/);
    expect(edited.text).toMatch(/1 of 3/);
    const bBtn = edited.options.reply_markup.inline_keyboard
      .flat()
      .find((b) => b.callback_data === 'card_ppay_pick_toggle_p_b');
    expect(bBtn.text.startsWith('[x]')).toBe(true);
  });

  test('toggling twice unselects (total returns to 0)', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs());
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    expect(bot.lastEdited().text).toMatch(/Selected:.*₱0.*₱500/);
    expect(bot.lastEdited().text).toMatch(/0 of 3/);
  });

  test('unknown toggle id (stale button) is a silent no-op — state unchanged', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs());
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a'); // 100
    const beforeEdits = bot.editedMessages().length;
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_ghost');
    // Either no edit fires, or edit fires with unchanged selection.
    const last = bot.lastEdited();
    expect(last.text).toMatch(/Selected:.*₱100.*₱500/);
    expect(bot.editedMessages().length).toBeGreaterThanOrEqual(beforeEdits);
  });
});

describe('createPurchasePicker — T4 Done sum-enforcement', () => {
  test('sum equals typed amount → Done transitions to confirm preview', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 500, purchases: [P_B, P_C] })); // 200+300=500, both in 2026-07
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_c');
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const confirmMsg = bot.sentMessages().find((m) => m.text.includes('Payment preview'));
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg.text).toContain('2026-07');
    expect(onConfirm).not.toHaveBeenCalled(); // confirm still needs a click
  });

  test('sum > typed amount → Done blocked with mismatch warning', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 200 })); // amount 200 but selecting 300
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_c'); // 300
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warn = bot.sentMessages().find((m) => m.text.includes("doesn't match"));
    expect(warn).toBeDefined();
    expect(warn.text).toMatch(/₱300/);
    expect(warn.text).toMatch(/₱200/);
    expect(onConfirm).not.toHaveBeenCalled();
    // Confirm preview should NOT have been shown.
    const confirmMsg = bot.sentMessages().find((m) => m.text.includes('Payment preview'));
    expect(confirmMsg).toBeUndefined();
  });

  test('sum < typed amount → Done blocked with mismatch warning', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs({ amount: 500 })); // amount 500 but selecting 100
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a'); // 100
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warn = bot.sentMessages().find((m) => m.text.includes("doesn't match"));
    expect(warn).toBeDefined();
    const confirmMsg = bot.sentMessages().find((m) => m.text.includes('Payment preview'));
    expect(confirmMsg).toBeUndefined();
  });

  test('zero selection → Done blocked with "select at least one" warning', async () => {
    const { picker, bot } = make();
    await picker.start(1, startArgs());
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warn = bot.sentMessages().find((m) => m.text.match(/select at least one/i));
    expect(warn).toBeDefined();
  });
});

describe('createPurchasePicker — cycle inference on Done', () => {
  test('single-cycle: statement_cycle prefilled on confirm data', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 500, purchases: singleCyclePurchases }));
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_c');
    await picker.handleCallback(1, 'card_ppay_pick_done');
    // Confirm the confirm-preview
    await picker.handleCallback(1, 'card_ppay_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, data] = onConfirm.mock.calls[0];
    expect(data.statement_cycle).toBe('2026-07');
    expect(data.paid_purchases.sort()).toEqual(['p_b', 'p_c']);
    expect(data.amount).toBe(500);
    expect(data.card_name).toBe('BPI');
  });

  test('multi-cycle: statement_cycle set to empty and warning surfaced', async () => {
    // P_A (2026-06) + P_B (2026-07) → multi-cycle. Sum = 300.
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 300, purchases: [P_A, P_B] }));
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warn = bot.sentMessages().find((m) => m.text.match(/multiple cycles/i));
    expect(warn).toBeDefined();
    await picker.handleCallback(1, 'card_ppay_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, data] = onConfirm.mock.calls[0];
    expect(data.statement_cycle).toBe('');
    expect(data.paid_purchases.sort()).toEqual(['p_a', 'p_b']);
  });
});

describe('createPurchasePicker — cancel', () => {
  test('pick_cancel clears state and warns without invoking onConfirm', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs());
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    await picker.handleCallback(1, 'card_ppay_pick_cancel');
    expect(bot.lastSent().text).toMatch(/cancel/i);
    expect(onConfirm).not.toHaveBeenCalled();
    // A subsequent click on a stale button is silently swallowed.
    const handled = await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    expect(handled).toBe(true);
  });
});

describe('createPurchasePicker — foreign prefix', () => {
  test('returns false for callbacks not matching card_ppay_ prefix', async () => {
    const { picker } = make();
    const handled = await picker.handleCallback(1, 'receipt_confirm');
    expect(handled).toBe(false);
  });
});

describe('createPurchasePicker — confirm-phase editors', () => {
  test('edit_amount route works (validated via confirm-flow)', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 500, purchases: singleCyclePurchases }));
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_c');
    await picker.handleCallback(1, 'card_ppay_pick_done');
    // In confirm phase, tap Edit Amount → picker sends the prompt.
    await picker.handleCallback(1, 'card_ppay_edit_amount');
    const prompt = bot.sentMessages().find((m) => m.text.match(/type the correct amount/i));
    expect(prompt).toBeDefined();
    // Type a new amount.
    await picker.handleTextInput(1, '450');
    // Confirm.
    await picker.handleCallback(1, 'card_ppay_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][1].amount).toBe(450);
  });

  test('edit_date route works too', async () => {
    const { picker, bot, onConfirm } = make();
    await picker.start(1, startArgs({ amount: 500, purchases: singleCyclePurchases }));
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_c');
    await picker.handleCallback(1, 'card_ppay_pick_done');
    await picker.handleCallback(1, 'card_ppay_edit_date');
    await picker.handleTextInput(1, '2026-08-15');
    await picker.handleCallback(1, 'card_ppay_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][1].tx_date).toBe('2026-08-15');
  });
});
