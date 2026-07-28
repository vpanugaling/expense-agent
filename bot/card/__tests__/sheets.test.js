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
