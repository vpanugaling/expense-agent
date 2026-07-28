const { parseCardAdd, createCardCommands } = require('../commands');
const { createCardSheets } = require('../sheets');
const { createFakeDoc } = require('../../test-utils/fake-sheet');
const { createMockBot } = require('../../test-utils/mock-bot');

function wire(tabs = { CreditCards: [] }, { now = () => new Date('2026-03-10T00:00:00Z') } = {}) {
  const bot = createMockBot();
  const doc = createFakeDoc(tabs);
  const cardSheets = createCardSheets({ getDoc: async () => doc });
  const commands = createCardCommands({ bot, cardSheets, now });
  return { bot, doc, cardSheets, commands };
}

describe('parseCardAdd', () => {
  test('accepts a well-formed add', () => {
    const r = parseCardAdd('BPI-Gold 1234 80000 25 15');
    expect(r.valid).toBe(true);
    expect(r.values).toEqual({
      card_name: 'BPI-Gold',
      last4: '1234',
      credit_limit: 80000,
      statement_day: 25,
      due_day: 15,
    });
  });

  test('rejects wrong argument count', () => {
    expect(parseCardAdd('BPI-Gold 1234 80000 25').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 1234 80000 25 15 extra').valid).toBe(false);
    expect(parseCardAdd('').valid).toBe(false);
  });

  test('rejects invalid nickname (space)', () => {
    const r = parseCardAdd('BPI Gold 1234 80000 25 15');
    expect(r.valid).toBe(false);
  });

  test('rejects reserved-word nickname', () => {
    expect(parseCardAdd('purchase 1234 80000 25 15').valid).toBe(false);
    expect(parseCardAdd('payment 1234 80000 25 15').valid).toBe(false);
  });

  test('rejects last4 that is not exactly 4 digits', () => {
    expect(parseCardAdd('BPI-Gold 12345 80000 25 15').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold abcd 80000 25 15').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 123 80000 25 15').valid).toBe(false);
  });

  test('rejects non-positive credit_limit', () => {
    expect(parseCardAdd('BPI-Gold 1234 0 25 15').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 1234 -100 25 15').valid).toBe(false);
  });

  test('rejects out-of-range statement_day / due_day', () => {
    expect(parseCardAdd('BPI-Gold 1234 80000 0 15').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 1234 80000 32 15').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 1234 80000 25 0').valid).toBe(false);
    expect(parseCardAdd('BPI-Gold 1234 80000 25 32').valid).toBe(false);
  });
});

describe('createCardCommands.handleAdd', () => {
  test('happy path writes the row and sends a confirmation', async () => {
    const { bot, doc, commands } = wire();
    await commands.handleAdd(1, 'BPI-Gold 1234 80000 25 15');
    const rows = doc.sheetsByTitle.CreditCards._snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_name: 'BPI-Gold',
      last4: '1234',
      credit_limit: 80000,
      statement_day: 25,
      due_day: 15,
    });
    expect(rows[0].created_at).toBe('2026-03-10T00:00:00.000Z');
    expect(bot.lastSent().text).toMatch(/Registered/);
    expect(bot.lastSent().text).toContain('BPI-Gold');
    expect(bot.lastSent().text).toContain('1234');
  });

  test('rejects duplicate nickname (case-insensitive) without writing', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleAdd(1, 'bpi-gold 9999 90000 5 10');
    expect(doc.sheetsByTitle.CreditCards._snapshot()).toHaveLength(1);
    expect(bot.lastSent().text).toMatch(/already exists/);
    expect(bot.lastSent().text).toMatch(/rename/);
  });

  test('invalid args produce a user-visible error without writing', async () => {
    const { bot, doc, commands } = wire();
    await commands.handleAdd(1, 'BPI Gold 1234 80000 25 15');
    expect(doc.sheetsByTitle.CreditCards._snapshot()).toHaveLength(0);
    expect(bot.lastSent().text).toMatch(/⚠️/);
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleAdd(1, 'BPI-Gold 1234 80000 25 15');
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });
});

describe('createCardCommands.handleList', () => {
  test('empty list shows a friendly message', async () => {
    const { bot, commands } = wire();
    await commands.handleList(1);
    expect(bot.lastSent().text).toMatch(/no cards/i);
  });

  test('renders each card with limit, balance, and next due', async () => {
    const { bot, commands } = wire({
      CreditCards: [
        { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
        { card_name: 'Metrobank-Titanium', last4: '5678', credit_limit: '50000', statement_day: '5', due_day: '25' },
      ],
    }, { now: () => new Date('2026-03-10T00:00:00Z') });
    await commands.handleList(1);
    const text = bot.lastSent().text;
    expect(text).toContain('BPI-Gold');
    expect(text).toContain('1234');
    expect(text).toContain('80,000');
    expect(text).toContain('2026-03-15'); // due_day=15, today=3/10 → this month
    expect(text).toContain('Metrobank-Titanium');
    expect(text).toContain('2026-03-25'); // due_day=25, today=3/10 → this month
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleList(1);
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });
});

describe('createCardCommands.dispatch', () => {
  test('routes /card add to handleAdd', async () => {
    const { doc, commands } = wire();
    const handled = await commands.dispatch(1, '/card add BPI-Gold 1234 80000 25 15');
    expect(handled).toBe(true);
    expect(doc.sheetsByTitle.CreditCards._snapshot()).toHaveLength(1);
  });

  test('routes /card list to handleList', async () => {
    const { bot, commands } = wire();
    const handled = await commands.dispatch(1, '/card list');
    expect(handled).toBe(true);
    expect(bot.lastSent().text).toMatch(/no cards/i);
  });

  test('bare /card shows usage', async () => {
    const { bot, commands } = wire();
    await commands.dispatch(1, '/card');
    expect(bot.lastSent().text).toMatch(/usage|available/i);
  });

  test('unknown subcommand shows help', async () => {
    const { bot, commands } = wire();
    await commands.dispatch(1, '/card frobnicate');
    expect(bot.lastSent().text).toMatch(/unknown|available/i);
  });

  test('non-/card text returns false (delegation-safe)', async () => {
    const { commands } = wire();
    const handled = await commands.dispatch(1, '/budget Food 8000');
    expect(handled).toBe(false);
  });
});
