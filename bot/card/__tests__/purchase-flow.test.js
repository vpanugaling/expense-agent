const { createPurchaseFlow } = require('../purchase-flow');
const { createMockBot } = require('../../test-utils/mock-bot');

function make(overrides = {}) {
  const bot = createMockBot();
  const onConfirm = jest.fn();
  const now = () => new Date('2026-03-15T00:00:00Z');
  const flow = createPurchaseFlow({ bot, onConfirm, now, ...overrides });
  return { flow, bot, onConfirm };
}

const sampleTx = {
  card_name: 'BPI-Gold',
  tx_date: '2026-03-15',
  amount: 500,
  category: 'Groceries',
  notes: '',
};

describe('createPurchaseFlow', () => {
  test('start sends summary with card_purchase_* buttons', async () => {
    const { flow, bot } = make();
    await flow.start(100, sampleTx);
    const msg = bot.lastSent();
    expect(msg.chatId).toBe(100);
    expect(msg.text).toContain('BPI-Gold');
    expect(msg.text).toContain('Groceries');
    expect(msg.text).toContain('500');
    const buttons = msg.options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(buttons).toEqual(expect.arrayContaining([
      'card_purchase_confirm',
      'card_purchase_edit_amount',
      'card_purchase_edit_category',
      'card_purchase_edit_date',
      'card_purchase_cancel',
    ]));
  });

  test('confirm invokes onConfirm with the purchase data', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, data] = onConfirm.mock.calls[0];
    expect(data).toMatchObject({
      card_name: 'BPI-Gold',
      tx_date: '2026-03-15',
      amount: 500,
      category: 'Groceries',
    });
  });

  test('edit amount → text input updates amount', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_amount');
    await flow.handleTextInput(1, '750.25');
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm.mock.calls[0][1].amount).toBe(750.25);
  });

  test('edit amount rejects non-positive input', async () => {
    const { flow, bot } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_amount');
    await flow.handleTextInput(1, '0');
    expect(bot.lastSent().text).toMatch(/invalid/i);
  });

  test('edit category by number maps to CATEGORIES index', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_category');
    await flow.handleTextInput(1, '1');
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm.mock.calls[0][1].category).toBe('Groceries');
  });

  test('edit category by alias uses findCategory', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_category');
    await flow.handleTextInput(1, 'grab');
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm.mock.calls[0][1].category).toBe('Transportation');
  });

  test('edit date "today" resolves against injected now()', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_date');
    await flow.handleTextInput(1, 'today');
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm.mock.calls[0][1].tx_date).toBe('2026-03-15');
  });

  test('edit date ISO YYYY-MM-DD accepted verbatim', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_edit_date');
    await flow.handleTextInput(1, '2026-04-01');
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm.mock.calls[0][1].tx_date).toBe('2026-04-01');
  });

  test('cancel sends cancellation message and does not confirm', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.start(1, sampleTx);
    await flow.handleCallback(1, 'card_purchase_cancel');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/cancel/i);
  });

  test('stale callback (no pending) sends friendly message', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.handleCallback(1, 'card_purchase_confirm');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/no pending/i);
  });

  test('foreign prefix is not handled (delegation-safe)', async () => {
    const { flow } = make();
    await flow.start(1, sampleTx);
    const handled = await flow.handleCallback(1, 'receipt_confirm');
    expect(handled).toBe(false);
  });
});
