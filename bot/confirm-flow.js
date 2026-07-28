function createConfirmFlow({
  prefix,
  bot,
  editors,
  render,
  onConfirm,
  onCancel,
  onStale,
}) {
  const pending = new Map();
  const awaiting = new Map();

  function clear(chatId) {
    pending.delete(chatId);
    awaiting.delete(chatId);
  }

  async function start(chatId, data) {
    pending.set(chatId, { ...data });
    awaiting.delete(chatId);
    await render(chatId, pending.get(chatId));
  }

  async function handleCallback(chatId, callbackData) {
    if (typeof callbackData !== 'string' || !callbackData.startsWith(prefix)) {
      return false;
    }
    const action = callbackData.slice(prefix.length);

    const isKnown =
      action === 'confirm' ||
      action === 'cancel' ||
      (action.startsWith('edit_') && editors[action.slice('edit_'.length)]);

    if (!isKnown) return false;

    if (!pending.has(chatId)) {
      await onStale(chatId);
      return true;
    }

    if (action === 'confirm') {
      const data = pending.get(chatId);
      pending.delete(chatId);
      await onConfirm(chatId, data);
      return true;
    }

    if (action === 'cancel') {
      pending.delete(chatId);
      await onCancel(chatId);
      return true;
    }

    const field = action.slice('edit_'.length);
    awaiting.set(chatId, field);
    await bot.sendMessage(chatId, editors[field].prompt);
    return true;
  }

  async function handleTextInput(chatId, text) {
    const field = awaiting.get(chatId);
    if (!field) return false;

    if (!pending.has(chatId)) {
      awaiting.delete(chatId);
      await onStale(chatId);
      return true;
    }

    const result = editors[field].parse(text);
    if (!result || !result.valid) {
      await bot.sendMessage(chatId, editors[field].invalidMessage);
      return true;
    }

    const data = pending.get(chatId);
    data[field] = result.value;
    awaiting.delete(chatId);
    await render(chatId, data);
    return true;
  }

  return {
    start,
    handleCallback,
    handleTextInput,
    _hasPending: (chatId) => pending.has(chatId),
    _isAwaiting: (chatId) => awaiting.has(chatId),
    _clear: clear,
  };
}

module.exports = { createConfirmFlow };
