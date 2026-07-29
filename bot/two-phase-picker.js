// createTwoPhasePicker wraps a two-step Telegram interaction:
//   Phase 1 (picker): an inline-keyboard message that mutates in place
//                     via editMessageText on every tap.
//   Phase 2 (confirm): delegates to the injected confirmFlow.
//
// The same `prefix` namespaces both phases. Picker callbacks use
// `${prefix}pick_<token>`; confirm callbacks use `${prefix}<action>` and
// are handed to confirmFlow.handleCallback.
//
// The `pick_cancel` intercept runs BEFORE confirmFlow sees the callback.
// Otherwise, during picker phase the confirmFlow has no pending state and
// would fire onStale for a legitimate Cancel tap.
//
// ---- Concurrency semantics ----
//
// Per-chat state is keyed by chatId — different chats never interfere.
//
// Re-calling `start()` on the same chat *silently replaces* the pending
// state. Telegram does not delete the previous inline-keyboard message,
// so old buttons remain visible and can still fire. Those callbacks are
// resolved against the NEW state via the caller's `onPick`. The
// abstraction does not filter stale tokens; callers whose tokens might
// become invalid after a replacement (e.g. `toggle_<txid>` referring to a
// purchase not in the new picker) should treat unknown tokens as no-ops
// in their `onPick` implementation. This is a deliberate trade-off — a
// state-generation counter would be more defensive but adds complexity
// disproportionate to the single-user bot's actual concurrency risk.
function createTwoPhasePicker({ prefix, bot, pickerRender, onPick, onCancel, confirmFlow }) {
  const PICK_PREFIX = `${prefix}pick_`;
  const pendingPicker = new Map();

  async function renderAndSend(chatId, state) {
    const { text, keyboard } = pickerRender(state);
    return bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function renderAndEdit(chatId, entry) {
    const { text, keyboard } = pickerRender(entry.state);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: entry.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function start(chatId, initialState) {
    const sent = await renderAndSend(chatId, initialState);
    pendingPicker.set(chatId, { state: initialState, messageId: sent.message_id });
  }

  async function handleCallback(chatId, callbackData) {
    if (typeof callbackData !== 'string' || !callbackData.startsWith(prefix)) return false;

    if (callbackData.startsWith(PICK_PREFIX)) {
      const token = callbackData.slice(PICK_PREFIX.length);
      const entry = pendingPicker.get(chatId);
      // Stale button on a replaced/ended picker — swallow silently.
      // Returning true prevents downstream flowHandlers from also seeing it.
      if (!entry) return true;

      if (token === 'cancel') {
        pendingPicker.delete(chatId);
        if (onCancel) await onCancel(chatId);
        return true;
      }

      const result = onPick(entry.state, token) || {};
      if (result.keepPicking) {
        if (result.nextState) entry.state = result.nextState;
        if (result.warning) await bot.sendMessage(chatId, result.warning);
        await renderAndEdit(chatId, entry);
        return true;
      }

      // Terminal pick: hand off to confirmFlow.
      pendingPicker.delete(chatId);
      if (result.warning) await bot.sendMessage(chatId, result.warning);
      await confirmFlow.start(chatId, result.confirmSeed);
      return true;
    }

    // Confirm-phase callback: delegate.
    return confirmFlow.handleCallback(chatId, callbackData);
  }

  async function handleTextInput(chatId, text) {
    return confirmFlow.handleTextInput(chatId, text);
  }

  return {
    start,
    handleCallback,
    handleTextInput,
    _hasPending: (chatId) => pendingPicker.has(chatId),
  };
}

module.exports = { createTwoPhasePicker };
