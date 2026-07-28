const { createCardSheets } = require('../sheets');
const { createFakeDoc } = require('../../test-utils/fake-sheet');

describe('createCardSheets', () => {
  test('returns an object exposing getTab', () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    expect(typeof sheets.getTab).toBe('function');
  });

  test('getTab returns the named sheet from the injected doc', async () => {
    const doc = createFakeDoc({ CreditCards: [{ nickname: 'BPI-Gold' }] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const tab = await sheets.getTab('CreditCards');
    expect(tab).toBe(doc.sheetsByTitle.CreditCards);
  });

  test('getTab throws MISSING_TAB error when the sheet is absent', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.getTab('CreditCards')).rejects.toMatchObject({
      code: 'MISSING_TAB',
      message: expect.stringContaining('CreditCards'),
    });
  });

  test('getTab calls getDoc on every invocation (no local caching)', async () => {
    const getDoc = jest.fn(async () => createFakeDoc({ CreditCards: [] }));
    const sheets = createCardSheets({ getDoc });
    await sheets.getTab('CreditCards');
    await sheets.getTab('CreditCards');
    expect(getDoc).toHaveBeenCalledTimes(2);
  });
});

describe('createCardSheets.listCards', () => {
  test('returns [] when the tab is empty', async () => {
    const doc = createFakeDoc({ CreditCards: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    expect(await sheets.listCards()).toEqual([]);
  });

  test('coerces numeric columns to numbers', async () => {
    const doc = createFakeDoc({
      CreditCards: [
        {
          card_name: 'BPI-Gold',
          last4: '1234',
          credit_limit: '80000',
          statement_day: '25',
          due_day: '15',
          created_at: '2026-03-01T00:00:00Z',
        },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const cards = await sheets.listCards();
    expect(cards).toEqual([
      {
        card_name: 'BPI-Gold',
        last4: '1234',
        credit_limit: 80000,
        statement_day: 25,
        due_day: 15,
        created_at: '2026-03-01T00:00:00Z',
      },
    ]);
  });

  test('propagates MISSING_TAB when CreditCards is absent', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.listCards()).rejects.toMatchObject({ code: 'MISSING_TAB' });
  });
});

describe('createCardSheets.findCard', () => {
  const doc = () => createFakeDoc({
    CreditCards: [
      { card_name: 'BPI-Gold', last4: '1234', credit_limit: '80000', statement_day: '25', due_day: '15' },
      { card_name: 'Metrobank-Titanium', last4: '5678', credit_limit: '50000', statement_day: '5', due_day: '25' },
    ],
  });

  test('returns the matching card', async () => {
    const sheets = createCardSheets({ getDoc: async () => doc() });
    const card = await sheets.findCard('BPI-Gold');
    expect(card.card_name).toBe('BPI-Gold');
    expect(card.credit_limit).toBe(80000);
  });

  test('is case-insensitive on card_name', async () => {
    const sheets = createCardSheets({ getDoc: async () => doc() });
    expect((await sheets.findCard('bpi-gold')).card_name).toBe('BPI-Gold');
    expect((await sheets.findCard('BPI-GOLD')).card_name).toBe('BPI-Gold');
  });

  test('returns null when no match', async () => {
    const sheets = createCardSheets({ getDoc: async () => doc() });
    expect(await sheets.findCard('Unknown')).toBeNull();
  });
});

describe('createCardSheets.addCard', () => {
  test('appends a row with all card fields', async () => {
    const doc = createFakeDoc({ CreditCards: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    await sheets.addCard({
      card_name: 'BPI-Gold',
      last4: '1234',
      credit_limit: 80000,
      statement_day: 25,
      due_day: 15,
      created_at: '2026-03-01T00:00:00Z',
    });
    expect(doc.sheetsByTitle.CreditCards._snapshot()).toEqual([
      {
        card_name: 'BPI-Gold',
        last4: '1234',
        credit_limit: 80000,
        statement_day: 25,
        due_day: 15,
        created_at: '2026-03-01T00:00:00Z',
      },
    ]);
  });

  test('propagates MISSING_TAB when CreditCards is absent', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.addCard({ card_name: 'X' })).rejects.toMatchObject({ code: 'MISSING_TAB' });
  });
});

describe('createCardSheets.renameCardInTab', () => {
  test('rewrites matching rows and returns the count of rows changed', async () => {
    const doc = createFakeDoc({
      CreditCards: [
        { card_name: 'BPI-Gold', last4: '1234' },
        { card_name: 'Metrobank', last4: '5678' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const result = await sheets.renameCardInTab('CreditCards', 'BPI-Gold', 'BPI-Platinum');
    expect(result).toEqual({ changed: 1 });
    const rows = doc.sheetsByTitle.CreditCards._snapshot();
    expect(rows[0].card_name).toBe('BPI-Platinum');
    expect(rows[1].card_name).toBe('Metrobank');
  });

  test('matches case-insensitively on card_name', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { card_name: 'BPI-Gold', amount: 100 },
        { card_name: 'bpi-gold', amount: 200 },
        { card_name: 'Other', amount: 300 },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const result = await sheets.renameCardInTab('CardTransactions', 'bpi-gold', 'BPI-Platinum');
    expect(result).toEqual({ changed: 2 });
    const rows = doc.sheetsByTitle.CardTransactions._snapshot();
    expect(rows.map((r) => r.card_name)).toEqual(['BPI-Platinum', 'BPI-Platinum', 'Other']);
  });

  test('returns { changed: 0 } when tab is missing and { optional: true }', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    const result = await sheets.renameCardInTab('CardTransactions', 'A', 'B', { optional: true });
    expect(result).toEqual({ changed: 0 });
  });

  test('throws MISSING_TAB when tab is missing and not optional', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.renameCardInTab('CreditCards', 'A', 'B')).rejects.toMatchObject({
      code: 'MISSING_TAB',
    });
  });

  test('returns { changed: 0 } when tab exists but no rows match', async () => {
    const doc = createFakeDoc({
      CardTransactions: [{ card_name: 'Other', amount: 100 }],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const result = await sheets.renameCardInTab('CardTransactions', 'Missing', 'New', { optional: true });
    expect(result).toEqual({ changed: 0 });
    expect(doc.sheetsByTitle.CardTransactions._snapshot()[0].card_name).toBe('Other');
  });

  test('propagates save() errors', async () => {
    const doc = createFakeDoc({
      CreditCards: [{ card_name: 'BPI-Gold', last4: '1234' }],
    });
    const originalGetRows = doc.sheetsByTitle.CreditCards.getRows.bind(doc.sheetsByTitle.CreditCards);
    doc.sheetsByTitle.CreditCards.getRows = async () => {
      const rows = await originalGetRows();
      for (const r of rows) r.save = async () => { throw new Error('write failed'); };
      return rows;
    };
    const sheets = createCardSheets({ getDoc: async () => doc });
    await expect(sheets.renameCardInTab('CreditCards', 'BPI-Gold', 'New')).rejects.toThrow('write failed');
  });
});
