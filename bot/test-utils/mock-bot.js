function createMockBot() {
  const sent = [];
  const answered = [];
  let messageIdCounter = 1;

  async function sendMessage(chatId, text, options) {
    sent.push({ chatId, text, options });
    return { message_id: messageIdCounter++ };
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
    answerCallbackQuery,
    getFile,
    sentMessages: () => sent.slice(),
    answeredCallbacks: () => answered.slice(),
    lastSent: () => (sent.length === 0 ? undefined : sent[sent.length - 1]),
    reset: () => {
      sent.length = 0;
      answered.length = 0;
    },
  };
}

module.exports = { createMockBot };
