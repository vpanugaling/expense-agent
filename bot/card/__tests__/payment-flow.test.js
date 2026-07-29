const { createPaymentFlow } = require('../payment-flow');
const { createMockBot } = require('../../test-utils/mock-bot');

function make(overrides = {}) {
  const bot = createMockBot();
  const onConfirm = jest.fn();
  const now = () => new Date('2026-03-15T00:00:00Z');
  const flow = createPaymentFlow({ bot, onConfirm, now, ...overrides });
  return { flow, bot, onConfirm };
}

const openCycles = [
  { cycle_month: '2026-01', due_date: '2026-02-15', statement_amount: 1000, paid: 0, outstanding: 1000 },
  { cycle_month: '2026-02', due_date: '2026-03-15', statement_amount: 800, paid: 300, outstanding: 500 },
];

const payload = {
  card_name: 'BPI-Gold',
  cycles: openCycles,
  amount: 400,
  tx_date: '2026-03-15',
};

describe('createPaymentFlow — cycle picker', () => {
  test('start with no cycles sends a "no open cycles" message and does not open picker', async () => {
    const { flow, bot } = make();
    await flow.start(1, { ...payload, cycles: [] });
    expect(bot.lastSent().text).toMatch(/no open statement cycles/i);
    const handled = await flow.handleCallback(1, 'card_payment_pick_2026-01');
    // Nothing pending, so the picker click should be treated as stale.
    expect(handled).toBe(true);
    expect(bot.lastSent().text).toMatch(/no pending/i);
  });

  test('start with cycles renders one button per cycle plus cancel', async () => {
    const { flow, bot } = make();
    await flow.start(1, payload);
    const msg = bot.lastSent();
    expect(msg.text).toContain('BPI-Gold');
    expect(msg.text).toContain('400');
    const buttons = msg.options.reply_markup.inline_keyboard.flat();
    const cbs = buttons.map((b) => b.callback_data);
    expect(cbs).toEqual(expect.arrayContaining([
      'card_payment_pick_2026-01',
      'card_payment_pick_2026-02',
      'card_payment_cancel',
    ]));
    // Cycle button text should include outstanding + due date.
    const janBtn = buttons.find((b) => b.callback_data === 'card_payment_pick_2026-01');
    expect(janBtn.text).toContain('2026-01');
    expect(janBtn.text).toContain('1,000');
    expect(janBtn.text).toContain('2026-02-15');
  });

  test('cancel during picker phase sends cancellation message and does not confirm', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_cancel');
    expect(bot.lastSent().text).toMatch(/cancel/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('picking an unknown cycle warns and keeps picker open', async () => {
    const { flow, bot } = make();
    await flow.start(1, payload);
    const handled = await flow.handleCallback(1, 'card_payment_pick_2099-12');
    expect(handled).toBe(true);
    expect(bot.lastSent().text).toMatch(/not found/i);
  });

  test('picking a cycle transitions to confirm preview with the cycle bound', async () => {
    const { flow, bot } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-02');
    const msg = bot.lastSent();
    expect(msg.text).toContain('BPI-Gold');
    expect(msg.text).toContain('2026-02');
    expect(msg.text).toContain('400');
    const cbs = msg.options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(cbs).toEqual(expect.arrayContaining([
      'card_payment_confirm',
      'card_payment_edit_amount',
      'card_payment_edit_date',
      'card_payment_cancel',
    ]));
    // No category editor on payments.
    expect(cbs).not.toContain('card_payment_edit_category');
  });
});

describe('createPaymentFlow — confirm phase', () => {
  test('confirm invokes onConfirm with card_name, statement_cycle, amount, tx_date', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, data] = onConfirm.mock.calls[0];
    expect(data).toMatchObject({
      card_name: 'BPI-Gold',
      statement_cycle: '2026-01',
      amount: 400,
      tx_date: '2026-03-15',
    });
  });

  test('edit amount → text input updates amount', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_edit_amount');
    await flow.handleTextInput(1, '750');
    await flow.handleCallback(1, 'card_payment_confirm');
    expect(onConfirm.mock.calls[0][1].amount).toBe(750);
  });

  test('edit amount rejects non-positive input', async () => {
    const { flow, bot } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_edit_amount');
    await flow.handleTextInput(1, '0');
    expect(bot.lastSent().text).toMatch(/invalid/i);
  });

  test('edit date "today" resolves against injected now()', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_edit_date');
    await flow.handleTextInput(1, 'today');
    await flow.handleCallback(1, 'card_payment_confirm');
    expect(onConfirm.mock.calls[0][1].tx_date).toBe('2026-03-15');
  });

  test('edit date ISO YYYY-MM-DD accepted verbatim', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_edit_date');
    await flow.handleTextInput(1, '2026-04-01');
    await flow.handleCallback(1, 'card_payment_confirm');
    expect(onConfirm.mock.calls[0][1].tx_date).toBe('2026-04-01');
  });

  test('cancel during confirm phase sends cancellation and does not confirm', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.start(1, payload);
    await flow.handleCallback(1, 'card_payment_pick_2026-01');
    await flow.handleCallback(1, 'card_payment_cancel');
    expect(bot.lastSent().text).toMatch(/cancel/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('stale confirm (no pending) sends friendly message', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.handleCallback(1, 'card_payment_confirm');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/no pending/i);
  });

  test('foreign prefix is not handled (delegation-safe)', async () => {
    const { flow } = make();
    await flow.start(1, payload);
    const handled = await flow.handleCallback(1, 'card_purchase_confirm');
    expect(handled).toBe(false);
  });
});
