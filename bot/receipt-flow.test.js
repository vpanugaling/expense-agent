const { createReceiptFlow } = require('./receipt-flow');
const { createMockBot } = require('./test-utils/mock-bot');

function make(overrides = {}) {
  const bot = createMockBot();
  const onConfirm = jest.fn();
  const now = () => new Date('2026-03-15T00:00:00Z');
  const flow = createReceiptFlow({ bot, onConfirm, now, ...overrides });
  return { flow, bot, onConfirm };
}

const sampleExtracted = {
  merchant: 'Kopi',
  total: 150,
  currency: 'PHP',
  category: 'Eating out',
  payment_method: 'Cash',
  receipt_date: '2026-03-10',
  notes: '',
  confidence: 0.9,
  ocr_confidence: 0.85,
};

describe('createReceiptFlow', () => {
  test('start sends a summary with receipt_* callback buttons', async () => {
    const { flow, bot } = make();
    await flow.start(100, sampleExtracted);
    const msg = bot.lastSent();
    expect(msg.chatId).toBe(100);
    expect(msg.text).toContain('Kopi');
    expect(msg.text).toContain('Eating out');
    const buttons = msg.options.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    expect(buttons).toEqual(expect.arrayContaining([
      'receipt_confirm',
      'receipt_edit_total',
      'receipt_edit_category',
      'receipt_edit_date',
      'receipt_cancel',
    ]));
  });

  test('confirm callback invokes onConfirm with extracted (receipt_date preserved)', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [, data] = onConfirm.mock.calls[0];
    expect(data.merchant).toBe('Kopi');
    expect(data.total).toBe(150);
    expect(data.receipt_date).toBe('2026-03-10');
    expect(data.ocr_confidence).toBe(0.85);
  });

  test('edit total → text input updates total and re-renders', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_total');
    await flow.handleTextInput(1, '450.50');
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][1].total).toBe(450.5);
  });

  test('edit category by number maps to CATEGORIES index', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_category');
    // 1 = Groceries (first category)
    await flow.handleTextInput(1, '1');
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm.mock.calls[0][1].category).toBe('Groceries');
  });

  test('edit category by alias uses findCategory', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_category');
    await flow.handleTextInput(1, 'grab');
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm.mock.calls[0][1].category).toBe('Transportation');
  });

  test('edit date "today" resolves against injected now()', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_date');
    await flow.handleTextInput(1, 'today');
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm.mock.calls[0][1].receipt_date).toBe('2026-03-15');
  });

  test('edit date ISO YYYY-MM-DD accepted verbatim', async () => {
    const { flow, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_date');
    await flow.handleTextInput(1, '2026-04-01');
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm.mock.calls[0][1].receipt_date).toBe('2026-04-01');
  });

  test('cancel sends cancellation message and does not confirm', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_cancel');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/cancel/i);
  });

  test('stale callback (no pending) sends friendly message', async () => {
    const { flow, bot, onConfirm } = make();
    await flow.handleCallback(1, 'receipt_confirm');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/no pending/i);
  });

  test('foreign prefix is not handled (delegation-safe)', async () => {
    const { flow } = make();
    await flow.start(1, sampleExtracted);
    const handled = await flow.handleCallback(1, 'card_confirm');
    expect(handled).toBe(false);
  });

  test('invalid total text keeps awaiting state', async () => {
    const { flow, bot } = make();
    await flow.start(1, sampleExtracted);
    await flow.handleCallback(1, 'receipt_edit_total');
    await flow.handleTextInput(1, 'abc');
    expect(bot.lastSent().text).toMatch(/invalid/i);
    // Still awaiting: valid input should now succeed
    const handled = await flow.handleTextInput(1, '99');
    expect(handled).toBe(true);
  });
});
