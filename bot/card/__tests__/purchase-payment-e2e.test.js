// End-to-end integration test for the purchase-tagged payment flow.
// Wires real createCardCommands → real createPurchasePicker → real
// createTwoPhasePicker → real createCardSheets (fake-sheet backed) so that
// dispatch, picker rendering, sum-enforcement, confirm-flow, and the sheet
// write all run in one path. Guards against wiring regressions no single
// unit test can catch.

const { createCardCommands } = require('../commands');
const { createCardSheets } = require('../sheets');
const { createPurchasePicker } = require('../purchase-picker');
const { computeBalances } = require('../balance');
const { createFakeDoc } = require('../../test-utils/fake-sheet');
const { createMockBot } = require('../../test-utils/mock-bot');

function wireE2E(initialTx = []) {
  const bot = createMockBot();
  const doc = createFakeDoc({
    CreditCards: [
      { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
    ],
    CardTransactions: initialTx,
  });
  const cardSheets = createCardSheets({ getDoc: async () => doc });
  const now = () => new Date('2026-07-30T00:00:00Z');
  const onConfirm = jest.fn(async (chatId, data) => {
    await cardSheets.addTransaction({
      timestamp: now().toISOString(),
      card_name: data.card_name,
      tx_date: data.tx_date,
      type: 'payment',
      amount: data.amount,
      category: '',
      notes: '',
      statement_cycle: data.statement_cycle || '',
      paid_purchases: data.paid_purchases || [],
    });
  });
  const purchasePicker = createPurchasePicker({ bot, onConfirm, now });
  const purchaseFlow = { start: jest.fn(async () => {}) };
  const commands = createCardCommands({ bot, cardSheets, purchaseFlow, purchasePicker, now });
  return { bot, doc, cardSheets, purchasePicker, purchaseFlow, commands, onConfirm };
}

describe('purchase-tagged payment e2e (dispatch → picker → sheet)', () => {
  test('single-cycle happy path writes a payment row with tx_id (p_), CSV paid_purchases, statement_cycle', async () => {
    // Two unpaid purchases both in cycle 2026-07 (statement_day=25).
    const initialTx = [
      { timestamp: '2026-07-26T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-26', type: 'purchase', amount: '200', category: 'Dining', tx_id: 'p_b' },
      { timestamp: '2026-07-28T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-28', type: 'purchase', amount: '300', category: 'Transport', tx_id: 'p_c' },
    ];
    const { commands, purchasePicker, doc, onConfirm } = wireE2E(initialTx);

    // /card tx BPI-Gold payment 500 → picker opens
    await commands.dispatch(1, '/card tx BPI-Gold payment 500');

    // Toggle both purchases → sum equals 500
    await purchasePicker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_toggle_p_c');
    // Done → confirm preview
    await purchasePicker.handleCallback(1, 'card_ppay_pick_done');
    // Confirm → sheet write
    await purchasePicker.handleCallback(1, 'card_ppay_confirm');

    expect(onConfirm).toHaveBeenCalledTimes(1);

    const rows = doc.sheetsByTitle.CardTransactions._snapshot();
    expect(rows).toHaveLength(3); // 2 purchases + 1 new payment
    const payment = rows.find((r) => r.type === 'payment');
    expect(payment).toBeDefined();
    expect(payment.card_name).toBe('BPI-Gold');
    expect(payment.amount).toBe(500);
    expect(payment.tx_date).toBe('2026-07-30');
    expect(payment.statement_cycle).toBe('2026-07');
    // paid_purchases stored as CSV string in the sheet.
    expect(typeof payment.paid_purchases).toBe('string');
    expect(payment.paid_purchases.split(',').sort()).toEqual(['p_b', 'p_c']);
    // Fresh tx_id minted at write-time uses the `p_` prefix.
    expect(payment.tx_id).toMatch(/^p_/);
    expect(payment.tx_id).not.toMatch(/^ps_/);
  });

  test('multi-cycle payment: statement_cycle written as empty string; balance drops by amount', async () => {
    // P_A is in cycle 2026-06 (day 10 < statement_day 25), P_B in cycle 2026-07.
    const initialTx = [
      { timestamp: '2026-07-10T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-10', type: 'purchase', amount: '100', category: 'Groceries', tx_id: 'p_a' },
      { timestamp: '2026-07-26T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-26', type: 'purchase', amount: '200', category: 'Dining', tx_id: 'p_b' },
    ];
    const { commands, purchasePicker, doc, cardSheets, bot } = wireE2E(initialTx);

    await commands.dispatch(1, '/card tx BPI-Gold payment 300');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_done');

    // Warning about multi-cycle should surface in the sent messages.
    const multiWarn = bot.sentMessages().find((m) => /multiple cycles/i.test(m.text));
    expect(multiWarn).toBeDefined();

    await purchasePicker.handleCallback(1, 'card_ppay_confirm');

    const rows = doc.sheetsByTitle.CardTransactions._snapshot();
    const payment = rows.find((r) => r.type === 'payment');
    expect(payment).toBeDefined();
    expect(payment.statement_cycle).toBe('');
    expect(payment.paid_purchases.split(',').sort()).toEqual(['p_a', 'p_b']);

    // Balance = purchases (100+200=300) − payment (300) = 0.
    const transactions = await cardSheets.listTransactions();
    const balances = computeBalances(transactions);
    expect(balances['BPI-Gold']).toBe(0);
  });

  test('sum mismatch at Done → no write; picker keeps state', async () => {
    const initialTx = [
      { timestamp: '2026-07-26T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-26', type: 'purchase', amount: '200', category: 'Dining', tx_id: 'p_b' },
    ];
    const { commands, purchasePicker, doc, onConfirm, bot } = wireE2E(initialTx);

    // Amount 500 but only purchase available is 200.
    await commands.dispatch(1, '/card tx BPI-Gold payment 500');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_toggle_p_b');
    await purchasePicker.handleCallback(1, 'card_ppay_pick_done');

    // Mismatch warning surfaced; no confirm preview shown.
    expect(bot.sentMessages().some((m) => /doesn't match/.test(m.text))).toBe(true);
    expect(bot.sentMessages().some((m) => /Payment preview/.test(m.text))).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    // No payment row written.
    const rows = doc.sheetsByTitle.CardTransactions._snapshot();
    expect(rows.filter((r) => r.type === 'payment')).toHaveLength(0);
  });

  test('paid purchases are filtered out on the next /card tx X payment invocation', async () => {
    // One purchase already tagged by an existing payment.
    const initialTx = [
      { timestamp: '2026-07-10T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-10', type: 'purchase', amount: '100', category: 'Groceries', tx_id: 'p_a' },
      { timestamp: '2026-07-26T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-26', type: 'purchase', amount: '200', category: 'Dining', tx_id: 'p_b' },
      { timestamp: '2026-07-27T00:00:00Z', card_name: 'BPI-Gold', tx_date: '2026-07-27', type: 'payment', amount: '100', tx_id: 'p_prev', paid_purchases: 'p_a' },
    ];
    const { commands, purchasePicker, bot } = wireE2E(initialTx);

    await commands.dispatch(1, '/card tx BPI-Gold payment 200');
    // Only p_b should be offered — p_a is already paid.
    const pickerMsg = bot.sentMessages().find((m) => /BPI-Gold/.test(m.text) && /Selected:/.test(m.text));
    expect(pickerMsg).toBeDefined();
    const cbs = pickerMsg.options.reply_markup.inline_keyboard
      .flat()
      .map((b) => b.callback_data)
      .filter((cb) => cb.startsWith('card_ppay_pick_toggle_'));
    expect(cbs).toEqual(['card_ppay_pick_toggle_p_b']);
  });
});
