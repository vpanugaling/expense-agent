const { parseCardAdd, parseCardRename, parseCardTx, parseCardStatement, createCardCommands } = require('../commands');
const { createCardSheets } = require('../sheets');
const { createFakeDoc } = require('../../test-utils/fake-sheet');
const { createMockBot } = require('../../test-utils/mock-bot');

function wire(tabs = { CreditCards: [] }, { now = () => new Date('2026-03-10T00:00:00Z'), purchaseFlow, paymentFlow } = {}) {
  const bot = createMockBot();
  const doc = createFakeDoc(tabs);
  const cardSheets = createCardSheets({ getDoc: async () => doc });
  const pFlow = purchaseFlow || { start: jest.fn(async () => {}) };
  const payFlow = paymentFlow || { start: jest.fn(async () => {}) };
  const commands = createCardCommands({ bot, cardSheets, purchaseFlow: pFlow, paymentFlow: payFlow, now });
  return { bot, doc, cardSheets, purchaseFlow: pFlow, paymentFlow: payFlow, commands };
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

  test('reflects computed balance from CardTransactions', async () => {
    const { bot, commands } = wire({
      CreditCards: [
        { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
      ],
      CardTransactions: [
        { card_name: 'BPI-Gold', type: 'purchase', amount: '1000', tx_date: '2026-03-01' },
        { card_name: 'BPI-Gold', type: 'purchase', amount: '500', tx_date: '2026-03-05' },
        { card_name: 'BPI-Gold', type: 'payment', amount: '200', tx_date: '2026-03-08' },
      ],
    });
    await commands.handleList(1);
    const text = bot.lastSent().text;
    expect(text).toContain('1,300'); // 1000 + 500 - 200
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleList(1);
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });
});

describe('parseCardRename', () => {
  test('accepts two nicknames', () => {
    const r = parseCardRename('BPI-Gold BPI-Platinum');
    expect(r.valid).toBe(true);
    expect(r.values).toEqual({ oldName: 'BPI-Gold', newName: 'BPI-Platinum' });
  });

  test('rejects wrong argument count', () => {
    expect(parseCardRename('BPI-Gold').valid).toBe(false);
    expect(parseCardRename('BPI-Gold BPI-Platinum extra').valid).toBe(false);
    expect(parseCardRename('').valid).toBe(false);
  });

  test('rejects invalid new nickname', () => {
    expect(parseCardRename('BPI-Gold "bad name"').valid).toBe(false);
    expect(parseCardRename('BPI-Gold payment').valid).toBe(false);
  });
});

describe('createCardCommands.handleRename', () => {
  function baseTabs() {
    return {
      CreditCards: [
        { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
        { card_name: 'Metrobank', last4: '5678', credit_limit: '50000', statement_day: '5', due_day: '25' },
      ],
      CardTransactions: [
        { card_name: 'BPI-Gold', tx_date: '2026-03-01', type: 'purchase', amount: '500' },
        { card_name: 'BPI-Gold', tx_date: '2026-03-05', type: 'payment', amount: '200' },
        { card_name: 'Metrobank', tx_date: '2026-03-02', type: 'purchase', amount: '300' },
      ],
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '500' },
      ],
    };
  }

  test('rewrites card_name in all three tabs on happy path', async () => {
    const { bot, doc, commands } = wire(baseTabs());
    await commands.handleRename(1, 'BPI-Gold BPI-Platinum');
    const cards = doc.sheetsByTitle.CreditCards._snapshot();
    const txs = doc.sheetsByTitle.CardTransactions._snapshot();
    const stmts = doc.sheetsByTitle.CardStatements._snapshot();
    expect(cards.find((c) => c.last4 === '1234').card_name).toBe('BPI-Platinum');
    expect(cards.find((c) => c.last4 === '5678').card_name).toBe('Metrobank');
    expect(txs.filter((t) => t.card_name === 'BPI-Platinum')).toHaveLength(2);
    expect(txs.filter((t) => t.card_name === 'Metrobank')).toHaveLength(1);
    expect(stmts[0].card_name).toBe('BPI-Platinum');
    expect(bot.lastSent().text).toMatch(/Renamed/);
    expect(bot.lastSent().text).toContain('BPI-Gold');
    expect(bot.lastSent().text).toContain('BPI-Platinum');
  });

  test('succeeds when only CreditCards tab exists (no tx/stmts tabs yet)', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleRename(1, 'BPI-Gold BPI-Platinum');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Platinum');
    expect(bot.lastSent().text).toMatch(/Renamed/);
  });

  test('is case-insensitive on old nickname', async () => {
    const { doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleRename(1, 'bpi-gold BPI-Platinum');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Platinum');
  });

  test('rejects when old card is not found (case-insensitive)', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleRename(1, 'Unknown BPI-Platinum');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Gold');
    expect(bot.lastSent().text).toMatch(/not found/i);
  });

  test('rejects when new nickname collides case-insensitively with a different card', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [
        { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
        { card_name: 'Metrobank', last4: '5678', credit_limit: '50000', statement_day: '5', due_day: '25' },
      ],
    });
    await commands.handleRename(1, 'BPI-Gold metrobank');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Gold');
    expect(bot.lastSent().text).toMatch(/already exists/i);
  });

  test('allows case-only rename of the same card', async () => {
    const { doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleRename(1, 'BPI-Gold bpi-gold');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('bpi-gold');
  });

  test('rejects invalid new nickname without writing', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleRename(1, 'BPI-Gold payment');
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Gold');
    expect(bot.lastSent().text).toMatch(/⚠️/);
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleRename(1, 'BPI-Gold BPI-Platinum');
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });

  test('rolls back CreditCards cleanly when CardTransactions save fails', async () => {
    const { bot, doc, commands } = wire(baseTabs());
    const txSheet = doc.sheetsByTitle.CardTransactions;
    const originalGetRows = txSheet.getRows.bind(txSheet);
    txSheet.getRows = async () => {
      const rows = await originalGetRows();
      for (const r of rows) r.save = async () => { throw new Error('tx write failed'); };
      return rows;
    };

    await commands.handleRename(1, 'BPI-Gold BPI-Platinum');

    // CreditCards must be rolled back to the original name
    const cards = doc.sheetsByTitle.CreditCards._snapshot();
    expect(cards.find((c) => c.last4 === '1234').card_name).toBe('BPI-Gold');
    // Message names the failed tab and confirms rollback
    const text = bot.lastSent().text;
    expect(text).toMatch(/failed/i);
    expect(text).toContain('CardTransactions');
    expect(text).toMatch(/rolled back/i);
    expect(text).toContain('CreditCards');
  });

  test('surfaces both errors clearly when rollback itself fails', async () => {
    const { bot, doc, commands } = wire(baseTabs());
    const txSheet = doc.sheetsByTitle.CardTransactions;
    const origTxGetRows = txSheet.getRows.bind(txSheet);
    txSheet.getRows = async () => {
      const rows = await origTxGetRows();
      for (const r of rows) r.save = async () => { throw new Error('tx write failed'); };
      return rows;
    };
    // Fail rollback: forward save on CreditCards succeeds, but any save AFTER
    // the CardTransactions failure (i.e. rollback) fails. Toggle via a flag
    // that flips when the tx failure fires above.
    let txHasFailed = false;
    const txSheetOriginal = txSheet.getRows;
    txSheet.getRows = async () => {
      const rows = await txSheetOriginal();
      for (const r of rows) r.save = async () => { txHasFailed = true; throw new Error('tx write failed'); };
      return rows;
    };
    const ccSheet = doc.sheetsByTitle.CreditCards;
    const origCcGetRows = ccSheet.getRows.bind(ccSheet);
    ccSheet.getRows = async () => {
      const rows = await origCcGetRows();
      if (txHasFailed) {
        for (const r of rows) r.save = async () => { throw new Error('rollback write failed'); };
      }
      return rows;
    };

    await commands.handleRename(1, 'BPI-Gold BPI-Platinum');

    const text = bot.lastSent().text;
    expect(text).toMatch(/rollback.*failed|failed.*rollback|manually reconcile/i);
    expect(text).toContain('CardTransactions');
    expect(text).toContain('CreditCards');
  });
});

describe('parseCardTx', () => {
  test('accepts a well-formed purchase', () => {
    const r = parseCardTx('BPI-Gold purchase 500 Groceries');
    expect(r.valid).toBe(true);
    expect(r.values).toEqual({
      nickname: 'BPI-Gold',
      subtype: 'purchase',
      amount: 500,
      category: 'Groceries',
      notes: '',
    });
  });

  test('joins trailing tokens into notes', () => {
    const r = parseCardTx('BPI-Gold purchase 500 Groceries SM North');
    expect(r.valid).toBe(true);
    expect(r.values.notes).toBe('SM North');
  });

  test('resolves category alias via findCategory', () => {
    const r = parseCardTx('BPI-Gold purchase 300 grab');
    expect(r.valid).toBe(true);
    expect(r.values.category).toBe('Transportation');
  });

  test('rejects unknown subtype', () => {
    expect(parseCardTx('BPI-Gold refund 500 Groceries').valid).toBe(false);
  });

  test('rejects missing arguments', () => {
    expect(parseCardTx('BPI-Gold purchase 500').valid).toBe(false);
    expect(parseCardTx('BPI-Gold purchase').valid).toBe(false);
    expect(parseCardTx('BPI-Gold').valid).toBe(false);
    expect(parseCardTx('').valid).toBe(false);
  });

  test('rejects invalid amount', () => {
    expect(parseCardTx('BPI-Gold purchase 0 Groceries').valid).toBe(false);
    expect(parseCardTx('BPI-Gold purchase abc Groceries').valid).toBe(false);
    expect(parseCardTx('BPI-Gold purchase -5 Groceries').valid).toBe(false);
  });

  test('rejects unknown category', () => {
    expect(parseCardTx('BPI-Gold purchase 500 Nonsense').valid).toBe(false);
  });

  test('accepts a well-formed payment (no category)', () => {
    const r = parseCardTx('BPI-Gold payment 1000');
    expect(r.valid).toBe(true);
    expect(r.values).toEqual({
      nickname: 'BPI-Gold',
      subtype: 'payment',
      amount: 1000,
      category: null,
      notes: '',
    });
  });

  test('payment joins trailing tokens into notes', () => {
    const r = parseCardTx('BPI-Gold payment 1000 partial payment');
    expect(r.valid).toBe(true);
    expect(r.values).toMatchObject({ subtype: 'payment', amount: 1000, notes: 'partial payment' });
  });

  test('payment rejects invalid amount', () => {
    expect(parseCardTx('BPI-Gold payment 0').valid).toBe(false);
    expect(parseCardTx('BPI-Gold payment abc').valid).toBe(false);
    expect(parseCardTx('BPI-Gold payment -5').valid).toBe(false);
  });

  test('payment rejects missing amount', () => {
    expect(parseCardTx('BPI-Gold payment').valid).toBe(false);
  });

  test('payment subtype is case-insensitive', () => {
    const r = parseCardTx('BPI-Gold PAYMENT 500');
    expect(r.valid).toBe(true);
    expect(r.values.subtype).toBe('payment');
  });
});

describe('createCardCommands.handleTx (purchase)', () => {
  test('happy path starts the purchase flow with resolved data', async () => {
    const { commands, purchaseFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleTx(1, 'BPI-Gold purchase 500 Groceries SM');
    expect(purchaseFlow.start).toHaveBeenCalledTimes(1);
    const [chatId, data] = purchaseFlow.start.mock.calls[0];
    expect(chatId).toBe(1);
    expect(data).toEqual({
      card_name: 'BPI-Gold',
      tx_date: '2026-03-10',
      amount: 500,
      category: 'Groceries',
      notes: 'SM',
    });
  });

  test('uses canonical stored card_name even if user typed different case', async () => {
    const { commands, purchaseFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleTx(1, 'bpi-gold purchase 500 Groceries');
    expect(purchaseFlow.start.mock.calls[0][1].card_name).toBe('BPI-Gold');
  });

  test('card not found → error message, flow not started', async () => {
    const { bot, commands, purchaseFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleTx(1, 'Unknown purchase 500 Groceries');
    expect(purchaseFlow.start).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/not found/i);
  });

  test('invalid args → error message, flow not started', async () => {
    const { bot, commands, purchaseFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    await commands.handleTx(1, 'BPI-Gold purchase 0 Groceries');
    expect(purchaseFlow.start).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/⚠️/);
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands, purchaseFlow } = wire({});
    await commands.handleTx(1, 'BPI-Gold purchase 500 Groceries');
    expect(purchaseFlow.start).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });
});

describe('createCardCommands.handleTx (payment)', () => {
  const cardRow = { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' };

  test('happy path starts the payment flow with open cycles computed', async () => {
    const { commands, paymentFlow, purchaseFlow } = wire({
      CreditCards: [cardRow],
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-01', statement_amount: '1000', due_date: '2026-02-15', closed_at: '' },
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '800', due_date: '2026-03-15', closed_at: '' },
      ],
      CardTransactions: [
        { card_name: 'BPI-Gold', type: 'payment', amount: '300', statement_cycle: '2026-02' },
      ],
    });
    await commands.handleTx(1, 'BPI-Gold payment 400');
    expect(purchaseFlow.start).not.toHaveBeenCalled();
    expect(paymentFlow.start).toHaveBeenCalledTimes(1);
    const [chatId, data] = paymentFlow.start.mock.calls[0];
    expect(chatId).toBe(1);
    expect(data.card_name).toBe('BPI-Gold');
    expect(data.tx_date).toBe('2026-03-10');
    expect(data.amount).toBe(400);
    expect(data.cycles.map((c) => c.cycle_month)).toEqual(['2026-01', '2026-02']);
    expect(data.cycles[1].outstanding).toBe(500);
  });

  test('uses canonical stored card_name even if user typed different case', async () => {
    const { commands, paymentFlow } = wire({
      CreditCards: [cardRow],
      CardStatements: [{ card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '800', due_date: '2026-03-15', closed_at: '' }],
    });
    await commands.handleTx(1, 'bpi-gold payment 400');
    expect(paymentFlow.start.mock.calls[0][1].card_name).toBe('BPI-Gold');
  });

  test('card not found → error message, flow not started', async () => {
    const { bot, commands, paymentFlow } = wire({ CreditCards: [cardRow] });
    await commands.handleTx(1, 'Unknown payment 400');
    expect(paymentFlow.start).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/not found/i);
  });

  test('no statements at all → flow starts with cycles=[] (payment-flow handles the empty case)', async () => {
    const { commands, paymentFlow } = wire({ CreditCards: [cardRow] });
    await commands.handleTx(1, 'BPI-Gold payment 400');
    expect(paymentFlow.start).toHaveBeenCalledTimes(1);
    expect(paymentFlow.start.mock.calls[0][1].cycles).toEqual([]);
  });

  test('fully-paid cycles are filtered out of the picker', async () => {
    const { commands, paymentFlow } = wire({
      CreditCards: [cardRow],
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-01', statement_amount: '1000', due_date: '2026-02-15', closed_at: '' },
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '800', due_date: '2026-03-15', closed_at: '' },
      ],
      CardTransactions: [
        { card_name: 'BPI-Gold', type: 'payment', amount: '1000', statement_cycle: '2026-01' },
      ],
    });
    await commands.handleTx(1, 'BPI-Gold payment 400');
    const cycles = paymentFlow.start.mock.calls[0][1].cycles;
    expect(cycles.map((c) => c.cycle_month)).toEqual(['2026-02']);
  });

  test('invalid amount → error message, flow not started', async () => {
    const { bot, commands, paymentFlow } = wire({ CreditCards: [cardRow] });
    await commands.handleTx(1, 'BPI-Gold payment 0');
    expect(paymentFlow.start).not.toHaveBeenCalled();
    expect(bot.lastSent().text).toMatch(/⚠️/);
  });
});

describe('parseCardStatement', () => {
  test('accepts nickname + amount (derive due_date and cycle_month later)', () => {
    const r = parseCardStatement('BPI-Gold 5000');
    expect(r.valid).toBe(true);
    expect(r.values).toEqual({ nickname: 'BPI-Gold', statement_amount: 5000, due_date: null, cycle_month: null });
  });

  test('accepts explicit due_date', () => {
    const r = parseCardStatement('BPI-Gold 5000 2026-03-15');
    expect(r.valid).toBe(true);
    expect(r.values).toMatchObject({ statement_amount: 5000, due_date: '2026-03-15', cycle_month: null });
  });

  test('accepts explicit due_date and cycle_month', () => {
    const r = parseCardStatement('BPI-Gold 5000 2026-03-15 2026-02');
    expect(r.valid).toBe(true);
    expect(r.values).toMatchObject({ due_date: '2026-03-15', cycle_month: '2026-02' });
  });

  test('rejects missing arguments', () => {
    expect(parseCardStatement('BPI-Gold').valid).toBe(false);
    expect(parseCardStatement('').valid).toBe(false);
  });

  test('rejects invalid amount', () => {
    expect(parseCardStatement('BPI-Gold 0').valid).toBe(false);
    expect(parseCardStatement('BPI-Gold -100').valid).toBe(false);
    expect(parseCardStatement('BPI-Gold abc').valid).toBe(false);
  });

  test('rejects malformed due_date', () => {
    expect(parseCardStatement('BPI-Gold 5000 2026-3-15').valid).toBe(false);
    expect(parseCardStatement('BPI-Gold 5000 March-15').valid).toBe(false);
  });

  test('rejects malformed cycle_month', () => {
    expect(parseCardStatement('BPI-Gold 5000 2026-03-15 2026-2').valid).toBe(false);
    expect(parseCardStatement('BPI-Gold 5000 2026-03-15 202602').valid).toBe(false);
  });

  test('rejects extra arguments', () => {
    expect(parseCardStatement('BPI-Gold 5000 2026-03-15 2026-02 extra').valid).toBe(false);
  });
});

describe('createCardCommands.handleStatement', () => {
  const cards = [
    { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
  ];

  test('happy path derives cycle_month + due_date and writes the row', async () => {
    // today = 2026-03-10, statement_day=25 → 10 < 25 → cycle_month = 2026-02
    // due_day=15, cycle_month=2026-02 → due_date = 2026-03-15
    const { bot, doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'BPI-Gold 5000');
    const rows = doc.sheetsByTitle.CardStatements._snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      statement_amount: 5000,
      due_date: '2026-03-15',
    });
    expect(rows[0].closed_at).toBe('2026-03-10T00:00:00.000Z');
    expect(bot.lastSent().text).toMatch(/statement/i);
    expect(bot.lastSent().text).toContain('2026-02');
    expect(bot.lastSent().text).toContain('2026-03-15');
  });

  test('derives cycle_month = current month when today.day >= statement_day', async () => {
    // today = 2026-03-25 (== statement_day 25) → cycle_month = 2026-03
    // due_day=15, cycle=2026-03 → 2026-04-15
    const { doc, commands } = wire(
      { CreditCards: cards, CardStatements: [] },
      { now: () => new Date('2026-03-25T00:00:00Z') },
    );
    await commands.handleStatement(1, 'BPI-Gold 5000');
    const row = doc.sheetsByTitle.CardStatements._snapshot()[0];
    expect(row.cycle_month).toBe('2026-03');
    expect(row.due_date).toBe('2026-04-15');
  });

  test('uses explicit due_date when provided', async () => {
    const { doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'BPI-Gold 5000 2026-03-20');
    const row = doc.sheetsByTitle.CardStatements._snapshot()[0];
    expect(row.due_date).toBe('2026-03-20');
    expect(row.cycle_month).toBe('2026-02'); // still derived
  });

  test('uses explicit cycle_month when provided', async () => {
    const { doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'BPI-Gold 5000 2026-03-20 2026-01');
    const row = doc.sheetsByTitle.CardStatements._snapshot()[0];
    expect(row.cycle_month).toBe('2026-01');
    expect(row.due_date).toBe('2026-03-20');
  });

  test('uses canonical stored card_name even if user typed different case', async () => {
    const { doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'bpi-gold 5000');
    expect(doc.sheetsByTitle.CardStatements._snapshot()[0].card_name).toBe('BPI-Gold');
  });

  test('rejects duplicate (card_name, cycle_month)', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: cards,
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '4500', due_date: '2026-03-15', closed_at: 'earlier' },
      ],
    });
    await commands.handleStatement(1, 'BPI-Gold 5000');
    expect(doc.sheetsByTitle.CardStatements._snapshot()).toHaveLength(1); // no new row
    expect(bot.lastSent().text).toMatch(/already exists|duplicate/i);
    expect(bot.lastSent().text).toContain('2026-02');
  });

  test('card not found → error, no write', async () => {
    const { bot, doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'Unknown 5000');
    expect(doc.sheetsByTitle.CardStatements._snapshot()).toHaveLength(0);
    expect(bot.lastSent().text).toMatch(/not found/i);
  });

  test('missing CreditCards tab shows setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleStatement(1, 'BPI-Gold 5000');
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });

  test('missing CardStatements tab shows setup message', async () => {
    const { bot, commands } = wire({ CreditCards: cards });
    await commands.handleStatement(1, 'BPI-Gold 5000');
    expect(bot.lastSent().text).toMatch(/CardStatements.*(not found|create)/i);
  });

  test('invalid args produce a user-visible error without writing', async () => {
    const { bot, doc, commands } = wire({ CreditCards: cards, CardStatements: [] });
    await commands.handleStatement(1, 'BPI-Gold 0');
    expect(doc.sheetsByTitle.CardStatements._snapshot()).toHaveLength(0);
    expect(bot.lastSent().text).toMatch(/⚠️/);
  });
});

describe('createCardCommands.handleDue', () => {
  const cardA = { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' };
  const cardB = { card_name: 'Metrobank', last4: '5678', credit_limit: '50000', statement_day: '10', due_day: '5' };

  test('missing CreditCards tab → setup message', async () => {
    const { bot, commands } = wire({});
    await commands.handleDue(1);
    expect(bot.lastSent().text).toMatch(/CreditCards.*(not found|create)/i);
  });

  test('no cards registered → empty message', async () => {
    const { bot, commands } = wire({ CreditCards: [] });
    await commands.handleDue(1);
    expect(bot.lastSent().text).toMatch(/no cards/i);
  });

  test('projected due for card with no statements (uses card.due_day)', async () => {
    const { bot, commands } = wire({ CreditCards: [cardA] }, { now: () => new Date('2026-03-10T00:00:00Z') });
    await commands.handleDue(1);
    const text = bot.lastSent().text;
    expect(text).toContain('BPI-Gold');
    expect(text).toContain('2026-03-15');
  });

  test('statement-backed due when an open cycle exists', async () => {
    const { bot, commands } = wire(
      {
        CreditCards: [cardA],
        CardStatements: [{ card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '1000', due_date: '2026-03-20', closed_at: '' }],
      },
      { now: () => new Date('2026-03-10T00:00:00Z') },
    );
    await commands.handleDue(1);
    const text = bot.lastSent().text;
    expect(text).toContain('BPI-Gold');
    expect(text).toContain('2026-03-20');
    expect(text).toContain('1,000');
  });

  test('sorts multiple cards soonest-first', async () => {
    const { bot, commands } = wire(
      {
        CreditCards: [cardA, cardB],
        CardStatements: [
          { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '1000', due_date: '2026-03-20', closed_at: '' },
          { card_name: 'Metrobank', cycle_month: '2026-02', statement_amount: '500', due_date: '2026-03-05', closed_at: '' },
        ],
      },
      { now: () => new Date('2026-03-01T00:00:00Z') },
    );
    await commands.handleDue(1);
    const text = bot.lastSent().text;
    const idxMetro = text.indexOf('Metrobank');
    const idxBpi = text.indexOf('BPI-Gold');
    expect(idxMetro).toBeGreaterThan(-1);
    expect(idxBpi).toBeGreaterThan(-1);
    expect(idxMetro).toBeLessThan(idxBpi);
  });

  test('fully-paid cycles do not skew sort — projected fallback applies', async () => {
    const { bot, commands } = wire(
      {
        CreditCards: [cardA],
        CardStatements: [{ card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '1000', due_date: '2026-03-20', closed_at: '' }],
        CardTransactions: [{ card_name: 'BPI-Gold', type: 'payment', amount: '1000', statement_cycle: '2026-02' }],
      },
      { now: () => new Date('2026-03-01T00:00:00Z') },
    );
    await commands.handleDue(1);
    const text = bot.lastSent().text;
    // Projected: next due is 2026-03-15 (due_day=15, today=03-01)
    expect(text).toContain('2026-03-15');
    expect(text).not.toContain('2026-03-20');
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

  test('routes /card tx to handleTx (purchase)', async () => {
    const { commands, purchaseFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    const handled = await commands.dispatch(1, '/card tx BPI-Gold purchase 500 Groceries');
    expect(handled).toBe(true);
    expect(purchaseFlow.start).toHaveBeenCalledTimes(1);
  });

  test('routes /card tx to handleTx (payment) — payment flow starts, purchase does not', async () => {
    const { commands, purchaseFlow, paymentFlow } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    const handled = await commands.dispatch(1, '/card tx BPI-Gold payment 400');
    expect(handled).toBe(true);
    expect(paymentFlow.start).toHaveBeenCalledTimes(1);
    expect(purchaseFlow.start).not.toHaveBeenCalled();
  });

  test('routes /card statement to handleStatement', async () => {
    const { doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
      CardStatements: [],
    });
    const handled = await commands.dispatch(1, '/card statement BPI-Gold 5000');
    expect(handled).toBe(true);
    expect(doc.sheetsByTitle.CardStatements._snapshot()).toHaveLength(1);
  });

  test('routes /card due to handleDue', async () => {
    const { bot, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    const handled = await commands.dispatch(1, '/card due');
    expect(handled).toBe(true);
    expect(bot.lastSent().text).toContain('BPI-Gold');
  });

  test('routes /card rename to handleRename', async () => {
    const { bot, doc, commands } = wire({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' }],
    });
    const handled = await commands.dispatch(1, '/card rename BPI-Gold BPI-Platinum');
    expect(handled).toBe(true);
    expect(doc.sheetsByTitle.CreditCards._snapshot()[0].card_name).toBe('BPI-Platinum');
    expect(bot.lastSent().text).toMatch(/Renamed/);
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
