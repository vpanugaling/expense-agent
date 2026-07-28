const { createConfirmFlow } = require('./confirm-flow');
const { createMockBot } = require('./test-utils/mock-bot');

function makeFlow(overrides = {}) {
  const bot = createMockBot();
  const renderCalls = [];
  const confirmCalls = [];
  const cancelCalls = [];
  const staleCalls = [];

  const render = jest.fn(async (chatId, data) => {
    renderCalls.push({ chatId, data: { ...data } });
    await bot.sendMessage(chatId, `SUMMARY: ${JSON.stringify(data)}`);
  });

  const onConfirm = jest.fn(async (chatId, data) => {
    confirmCalls.push({ chatId, data: { ...data } });
  });

  const onCancel = jest.fn(async (chatId) => {
    cancelCalls.push({ chatId });
    await bot.sendMessage(chatId, 'CANCELLED');
  });

  const onStale = jest.fn(async (chatId) => {
    staleCalls.push({ chatId });
    await bot.sendMessage(chatId, 'STALE');
  });

  const editors = {
    total: {
      parse: (input) => {
        const n = Number(String(input).trim());
        return Number.isFinite(n) && n > 0 ? { valid: true, value: n } : null;
      },
      prompt: 'Type the correct total:',
      invalidMessage: 'Invalid total.',
    },
    category: {
      parse: (input) => {
        const s = String(input).trim();
        return s === 'Food' || s === 'Transport' ? { valid: true, value: s } : null;
      },
      prompt: 'Type the correct category:',
      invalidMessage: 'Invalid category.',
    },
    date: {
      parse: (input) => {
        const s = String(input).trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { valid: true, value: s } : null;
      },
      prompt: 'Type the correct date:',
      invalidMessage: 'Invalid date.',
    },
  };

  const flow = createConfirmFlow({
    prefix: 'test_',
    bot,
    editors,
    render,
    onConfirm,
    onCancel,
    onStale,
    ...overrides,
  });

  return { flow, bot, render, onConfirm, onCancel, onStale, renderCalls, confirmCalls, cancelCalls, staleCalls };
}

describe('createConfirmFlow', () => {
  test('start stores pending data and calls render', async () => {
    const { flow, render } = makeFlow();
    await flow.start(42, { total: 100, category: 'Food', date: '2026-01-01' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(42, { total: 100, category: 'Food', date: '2026-01-01' });
  });

  test('handleCallback returns false for foreign prefix', async () => {
    const { flow } = makeFlow();
    await flow.start(1, { total: 100 });
    const handled = await flow.handleCallback(1, 'card_confirm');
    expect(handled).toBe(false);
  });

  test('handleCallback on confirm calls onConfirm with pending data and clears state', async () => {
    const { flow, onConfirm } = makeFlow();
    await flow.start(7, { total: 250, category: 'Food' });
    const handled = await flow.handleCallback(7, 'test_confirm');
    expect(handled).toBe(true);
    expect(onConfirm).toHaveBeenCalledWith(7, { total: 250, category: 'Food' });

    const again = await flow.handleCallback(7, 'test_confirm');
    expect(again).toBe(true);
  });

  test('handleCallback on cancel calls onCancel and clears state', async () => {
    const { flow, onCancel } = makeFlow();
    await flow.start(3, { total: 100 });
    const handled = await flow.handleCallback(3, 'test_cancel');
    expect(handled).toBe(true);
    expect(onCancel).toHaveBeenCalledWith(3);
  });

  test('handleCallback on edit_<field> sends prompt and sets awaiting state', async () => {
    const { flow, bot } = makeFlow();
    await flow.start(9, { total: 100 });
    const handled = await flow.handleCallback(9, 'test_edit_total');
    expect(handled).toBe(true);
    expect(bot.lastSent()).toEqual({
      chatId: 9,
      text: 'Type the correct total:',
      options: undefined,
    });
  });

  test('handleCallback with matching prefix but no pending calls onStale', async () => {
    const { flow, onStale } = makeFlow();
    const handled = await flow.handleCallback(11, 'test_confirm');
    expect(handled).toBe(true);
    expect(onStale).toHaveBeenCalledWith(11);
  });

  test('handleCallback with matching prefix but unknown action returns false', async () => {
    const { flow } = makeFlow();
    await flow.start(1, { total: 100 });
    const handled = await flow.handleCallback(1, 'test_bogus');
    expect(handled).toBe(false);
  });

  test('handleTextInput returns false when chat is not awaiting an edit', async () => {
    const { flow } = makeFlow();
    await flow.start(4, { total: 100 });
    const handled = await flow.handleTextInput(4, 'random text');
    expect(handled).toBe(false);
  });

  test('handleTextInput updates pending and re-renders on valid parse', async () => {
    const { flow, render, renderCalls } = makeFlow();
    await flow.start(5, { total: 100, category: 'Food' });
    await flow.handleCallback(5, 'test_edit_total');
    const handled = await flow.handleTextInput(5, '450.50');
    expect(handled).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
    expect(renderCalls[1].data).toEqual({ total: 450.5, category: 'Food' });
  });

  test('handleTextInput sends invalidMessage and keeps awaiting state on invalid parse', async () => {
    const { flow, bot } = makeFlow();
    await flow.start(6, { total: 100 });
    await flow.handleCallback(6, 'test_edit_total');
    const handled = await flow.handleTextInput(6, 'abc');
    expect(handled).toBe(true);
    expect(bot.lastSent().text).toBe('Invalid total.');
    // Still awaiting: another valid input should succeed
    const handled2 = await flow.handleTextInput(6, '200');
    expect(handled2).toBe(true);
  });

  test('handleTextInput while awaiting but pending was cleared → onStale, returns true', async () => {
    const { flow, onStale } = makeFlow();
    await flow.start(8, { total: 100 });
    await flow.handleCallback(8, 'test_edit_total');
    await flow.handleCallback(8, 'test_cancel'); // clears pending
    const handled = await flow.handleTextInput(8, '200');
    expect(handled).toBe(true);
    expect(onStale).toHaveBeenCalledWith(8);
  });

  test('after confirm, subsequent callbacks are stale', async () => {
    const { flow, onStale, onConfirm } = makeFlow();
    await flow.start(10, { total: 100 });
    await flow.handleCallback(10, 'test_confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flow.handleCallback(10, 'test_confirm');
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  test('after cancel, subsequent callbacks are stale', async () => {
    const { flow, onStale } = makeFlow();
    await flow.start(12, { total: 100 });
    await flow.handleCallback(12, 'test_cancel');
    await flow.handleCallback(12, 'test_edit_total');
    expect(onStale).toHaveBeenCalledWith(12);
  });

  test('independent chats keep independent state', async () => {
    const { flow, onConfirm } = makeFlow();
    await flow.start(100, { total: 100 });
    await flow.start(200, { total: 999 });
    await flow.handleCallback(100, 'test_confirm');
    expect(onConfirm).toHaveBeenCalledWith(100, { total: 100 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flow.handleCallback(200, 'test_confirm');
    expect(onConfirm).toHaveBeenLastCalledWith(200, { total: 999 });
  });

  test('editing one field does not touch other fields', async () => {
    const { flow, renderCalls } = makeFlow();
    await flow.start(1, { total: 100, category: 'Food', date: '2026-01-01' });
    await flow.handleCallback(1, 'test_edit_category');
    await flow.handleTextInput(1, 'Transport');
    expect(renderCalls[renderCalls.length - 1].data).toEqual({
      total: 100,
      category: 'Transport',
      date: '2026-01-01',
    });
  });

  test('after successful edit, awaiting state is cleared', async () => {
    const { flow } = makeFlow();
    await flow.start(1, { total: 100 });
    await flow.handleCallback(1, 'test_edit_total');
    await flow.handleTextInput(1, '200');
    // Next text should not be treated as edit input
    const handled = await flow.handleTextInput(1, '999');
    expect(handled).toBe(false);
  });

  test('handleCallback for edit while another edit is awaiting switches the awaited field', async () => {
    const { flow, bot } = makeFlow();
    await flow.start(1, { total: 100, category: 'Food' });
    await flow.handleCallback(1, 'test_edit_total');
    await flow.handleCallback(1, 'test_edit_category');
    // Text input should now be interpreted as category, not total
    await flow.handleTextInput(1, 'Transport');
    const summaries = bot.sentMessages().filter(m => m.text.startsWith('SUMMARY'));
    const last = summaries[summaries.length - 1];
    expect(last.text).toContain('"category":"Transport"');
    expect(last.text).toContain('"total":100');
  });
});
