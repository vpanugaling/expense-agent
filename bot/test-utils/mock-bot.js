function createMockBot() {
  const sent = [];
  const edits = [];
  const answered = [];
  let messageIdCounter = 1;

  async function sendMessage(chatId, text, options) {
    sent.push({ chatId, text, options });
    return { message_id: messageIdCounter++ };
  }

  // editMessageText mirrors node-telegram-bot-api's signature:
  // editMessageText(text, { chat_id, message_id, ... }). Recorded separately
  // from sendMessage so tests can assert on in-place updates.
  async function editMessageText(text, options) {
    edits.push({ text, options });
  }

  async function answerCallbackQuery(id, options) {
    answered.push({ id, options });
  }

  const getFile = jest.fn(async (fileId) => ({
    file_id: fileId,
    file_path: `path/to/${fileId}`,
  }));

  return {
    sendMessage,
    editMessageText,
    answerCallbackQuery,
    getFile,
    sentMessages: () => sent.slice(),
    editedMessages: () => edits.slice(),
    answeredCallbacks: () => answered.slice(),
    lastSent: () => (sent.length === 0 ? undefined : sent[sent.length - 1]),
    lastEdited: () => (edits.length === 0 ? undefined : edits[edits.length - 1]),
    reset: () => {
      sent.length = 0;
      edits.length = 0;
      answered.length = 0;
    },
  };
}

module.exports = { createMockBot };
