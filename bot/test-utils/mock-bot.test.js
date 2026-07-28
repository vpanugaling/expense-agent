const { createMockBot } = require('./mock-bot');

describe('createMockBot', () => {
  test('sendMessage records chatId, text, and options', async () => {
    const bot = createMockBot();
    await bot.sendMessage(123, 'hello', { parse_mode: 'Markdown' });
    expect(bot.sentMessages()).toEqual([
      { chatId: 123, text: 'hello', options: { parse_mode: 'Markdown' } },
    ]);
  });

  test('sendMessage returns a message-like object with an id', async () => {
    const bot = createMockBot();
    const result = await bot.sendMessage(1, 'a');
    expect(result).toHaveProperty('message_id');
    expect(typeof result.message_id).toBe('number');
  });

  test('multiple sendMessage calls preserve order', async () => {
    const bot = createMockBot();
    await bot.sendMessage(1, 'first');
    await bot.sendMessage(1, 'second');
    await bot.sendMessage(2, 'third');
    const sent = bot.sentMessages();
    expect(sent.map(m => m.text)).toEqual(['first', 'second', 'third']);
  });

  test('lastSent returns the most recent message or undefined', async () => {
    const bot = createMockBot();
    expect(bot.lastSent()).toBeUndefined();
    await bot.sendMessage(1, 'only');
    expect(bot.lastSent()).toEqual({ chatId: 1, text: 'only', options: undefined });
  });

  test('answerCallbackQuery records the id', async () => {
    const bot = createMockBot();
    await bot.answerCallbackQuery('cb-1');
    await bot.answerCallbackQuery('cb-2', { text: 'ack' });
    expect(bot.answeredCallbacks()).toEqual([
      { id: 'cb-1', options: undefined },
      { id: 'cb-2', options: { text: 'ack' } },
    ]);
  });

  test('reset clears both send and answer history', async () => {
    const bot = createMockBot();
    await bot.sendMessage(1, 'a');
    await bot.answerCallbackQuery('cb-1');
    bot.reset();
    expect(bot.sentMessages()).toEqual([]);
    expect(bot.answeredCallbacks()).toEqual([]);
  });

  test('getFile is a mockable stub returning file_path by default', async () => {
    const bot = createMockBot();
    const file = await bot.getFile('file-abc');
    expect(file).toHaveProperty('file_path');
    expect(bot.getFile.mock).toBeDefined();
    expect(bot.getFile).toHaveBeenCalledWith('file-abc');
  });

  test('sentMessages() returns a snapshot that does not affect internal state', async () => {
    const bot = createMockBot();
    await bot.sendMessage(1, 'a');
    const snapshot = bot.sentMessages();
    snapshot.pop();
    expect(bot.sentMessages()).toHaveLength(1);
  });
});
