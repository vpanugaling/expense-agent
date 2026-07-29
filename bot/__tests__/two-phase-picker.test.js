const { createTwoPhasePicker } = require('../two-phase-picker');
const { createMockBot } = require('../test-utils/mock-bot');

// Minimal fake confirmFlow with the surface the picker abstraction uses:
// start(chatId, seed), handleCallback(chatId, cb), handleTextInput(chatId, text).
function createFakeConfirmFlow() {
  const started = [];
  const callbacks = [];
  const texts = [];
  return {
    start: jest.fn(async (chatId, seed) => {
      started.push({ chatId, seed });
    }),
    handleCallback: jest.fn(async (chatId, cb) => {
      callbacks.push({ chatId, cb });
      return true;
    }),
    handleTextInput: jest.fn(async (chatId, text) => {
      texts.push({ chatId, text });
      return true;
    }),
    _started: () => started.slice(),
    _callbacks: () => callbacks.slice(),
    _texts: () => texts.slice(),
  };
}

function makePickerRender() {
  return jest.fn((state) => ({
    text: `state: ${JSON.stringify(state)}`,
    keyboard: [[{ text: 'stub', callback_data: 'x' }]],
  }));
}

function wire({ prefix = 'card_ppay_', onPick, onCancel } = {}) {
  const bot = createMockBot();
  const confirmFlow = createFakeConfirmFlow();
  const pickerRender = makePickerRender();
  const picker = createTwoPhasePicker({
    prefix,
    bot,
    pickerRender,
    onPick: onPick || jest.fn(() => ({ keepPicking: true })),
    onCancel,
    confirmFlow,
  });
  return { bot, confirmFlow, pickerRender, picker };
}

describe('createTwoPhasePicker.start', () => {
  it('sends the picker message with rendered text + inline keyboard', async () => {
    const { bot, pickerRender, picker } = wire();
    await picker.start(1, { foo: 'bar' });
    expect(pickerRender).toHaveBeenCalledWith({ foo: 'bar' });
    const last = bot.lastSent();
    expect(last.chatId).toBe(1);
    expect(last.text).toContain('bar');
    expect(last.options.reply_markup.inline_keyboard).toEqual([[{ text: 'stub', callback_data: 'x' }]]);
  });

  it('captures message_id from bot.sendMessage return value', async () => {
    const { picker } = wire();
    await picker.start(1, { foo: 'bar' });
    expect(picker._hasPending(1)).toBe(true);
  });
});

describe('createTwoPhasePicker.handleCallback — foreign prefix', () => {
  it('returns false for callbacks not matching prefix (does not call pickerRender)', async () => {
    const { picker, pickerRender } = wire();
    await picker.start(1, { foo: 'bar' });
    pickerRender.mockClear();
    const handled = await picker.handleCallback(1, 'receipt_confirm');
    expect(handled).toBe(false);
    expect(pickerRender).not.toHaveBeenCalled();
  });
});

describe('createTwoPhasePicker.handleCallback — picker phase', () => {
  it('calls onPick and re-renders in place when keepPicking: true', async () => {
    const onPick = jest.fn((state, token) => ({
      keepPicking: true,
      nextState: { ...state, toggled: token },
    }));
    const { picker, bot, pickerRender } = wire({ onPick });
    await picker.start(1, { foo: 'bar' });
    pickerRender.mockClear();
    await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    expect(onPick).toHaveBeenCalledWith({ foo: 'bar' }, 'toggle_p_a');
    // Re-rendered with next state.
    expect(pickerRender).toHaveBeenCalledWith({ foo: 'bar', toggled: 'toggle_p_a' });
    // Edited in place — no new sendMessage for the render.
    const edited = bot.lastEdited();
    expect(edited).toBeDefined();
    expect(edited.options).toMatchObject({ chat_id: 1 });
    expect(edited.options.message_id).toBeGreaterThan(0);
  });

  it('surfaces onPick warning as a chat message when keepPicking: true', async () => {
    const onPick = jest.fn(() => ({ keepPicking: true, warning: '⚠️ pick another one' }));
    const { picker, bot } = wire({ onPick });
    await picker.start(1, { foo: 'bar' });
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warnMsg = bot.sentMessages().find((m) => m.text.includes('pick another'));
    expect(warnMsg).toBeDefined();
  });

  it('leaves picker phase and delegates to confirmFlow.start on terminal pick', async () => {
    const onPick = jest.fn(() => ({
      keepPicking: false,
      confirmSeed: { card_name: 'BPI', amount: 500, paid_purchases: ['p_a'] },
    }));
    const { picker, confirmFlow } = wire({ onPick });
    await picker.start(1, { foo: 'bar' });
    await picker.handleCallback(1, 'card_ppay_pick_done');
    expect(picker._hasPending(1)).toBe(false);
    expect(confirmFlow.start).toHaveBeenCalledWith(1, {
      card_name: 'BPI',
      amount: 500,
      paid_purchases: ['p_a'],
    });
  });

  it('surfaces terminal-pick warning to chat before delegating', async () => {
    const onPick = jest.fn(() => ({
      keepPicking: false,
      confirmSeed: { amount: 500 },
      warning: '⚠️ Multi-cycle',
    }));
    const { picker, bot, confirmFlow } = wire({ onPick });
    await picker.start(1, { foo: 'bar' });
    await picker.handleCallback(1, 'card_ppay_pick_done');
    const warnMsg = bot.sentMessages().find((m) => m.text.includes('Multi-cycle'));
    expect(warnMsg).toBeDefined();
    expect(confirmFlow.start).toHaveBeenCalled();
  });

  it('pick_cancel clears state and fires onCancel (never reaches confirmFlow.onStale)', async () => {
    const onCancel = jest.fn(async () => {});
    const { picker, confirmFlow } = wire({ onCancel });
    await picker.start(1, { foo: 'bar' });
    await picker.handleCallback(1, 'card_ppay_pick_cancel');
    expect(picker._hasPending(1)).toBe(false);
    expect(onCancel).toHaveBeenCalledWith(1);
    // Confirm-flow must NOT see the cancel (which would onStale otherwise).
    expect(confirmFlow.handleCallback).not.toHaveBeenCalled();
  });

  it('picker callback with no pending state returns true (silently swallowed, no crash)', async () => {
    const onPick = jest.fn();
    const { picker } = wire({ onPick });
    // No start() first — simulates an old button on a stale message.
    const handled = await picker.handleCallback(1, 'card_ppay_pick_toggle_p_a');
    expect(handled).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('createTwoPhasePicker.handleCallback — confirm phase delegation', () => {
  it('delegates non-pick_ callbacks to confirmFlow.handleCallback', async () => {
    const { picker, confirmFlow } = wire();
    await picker.handleCallback(1, 'card_ppay_confirm');
    expect(confirmFlow.handleCallback).toHaveBeenCalledWith(1, 'card_ppay_confirm');
  });

  it('delegates edit_* callbacks too', async () => {
    const { picker, confirmFlow } = wire();
    await picker.handleCallback(1, 'card_ppay_edit_amount');
    expect(confirmFlow.handleCallback).toHaveBeenCalledWith(1, 'card_ppay_edit_amount');
  });
});

describe('createTwoPhasePicker.handleTextInput', () => {
  it('delegates unconditionally to confirmFlow.handleTextInput (picker is button-only)', async () => {
    const { picker, confirmFlow } = wire();
    await picker.handleTextInput(1, 'some text');
    expect(confirmFlow.handleTextInput).toHaveBeenCalledWith(1, 'some text');
  });
});

describe('createTwoPhasePicker — T2 concurrency', () => {
  it('T2(a): two chats\' picker state remains isolated across interleaved callbacks', async () => {
    const onPick = jest.fn((state, token) => ({
      keepPicking: true,
      nextState: { ...state, lastToken: token },
    }));
    const { picker, pickerRender } = wire({ onPick });
    await picker.start(1, { chat: 1, sel: [] });
    await picker.start(2, { chat: 2, sel: [] });
    pickerRender.mockClear();

    await picker.handleCallback(1, 'card_ppay_pick_toggle_A');
    await picker.handleCallback(2, 'card_ppay_pick_toggle_B');
    await picker.handleCallback(1, 'card_ppay_pick_toggle_C');

    // onPick calls per chat should carry the correct starting state — chat 1
    // never sees chat 2's toggles.
    const chat1Calls = onPick.mock.calls.filter((c) => c[0].chat === 1);
    const chat2Calls = onPick.mock.calls.filter((c) => c[0].chat === 2);
    expect(chat1Calls).toHaveLength(2);
    expect(chat2Calls).toHaveLength(1);
    expect(chat1Calls[1][0].lastToken).toBe('toggle_A'); // 2nd call sees 1st mutation
    expect(chat2Calls[0][0].lastToken).toBeUndefined();
  });

  it('T2(b): re-start() on same chat silently replaces state; old-token buttons resolve against new state', async () => {
    // "no-op" for the old-token case here means: onPick receives the NEW
    // state and the token; caller-provided onPick decides what to do with
    // an unknown token. The abstraction itself does not filter tokens.
    const onPick = jest.fn((state, token) => ({
      keepPicking: true,
      nextState: { ...state, lastToken: token },
    }));
    const { picker } = wire({ onPick });
    await picker.start(1, { generation: 'old', sel: [] });
    await picker.start(1, { generation: 'new', sel: [] });
    onPick.mockClear();
    // An "old" button fires — it targets whatever state is currently pending
    // (which is 'new'). This is the design decision documented on the module.
    await picker.handleCallback(1, 'card_ppay_pick_toggle_stale');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ generation: 'new' });
  });

  it('T2(c): picker state survives dispatches to other prefixes (does NOT get cleared)', async () => {
    const { picker } = wire();
    await picker.start(1, { foo: 'bar' });
    // A totally unrelated callback fires — picker ignores it and returns false.
    const handled = await picker.handleCallback(1, 'receipt_confirm');
    expect(handled).toBe(false);
    // Picker state is intact.
    expect(picker._hasPending(1)).toBe(true);
  });
});
