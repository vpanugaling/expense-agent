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

describe('createCardSheets.listTransactions', () => {
  test('returns coerced transactions', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't1', card_name: 'BPI-Gold', tx_date: '2026-03-01', type: 'purchase', amount: '500', category: 'Groceries', notes: '', statement_cycle: '', tx_id: 'p_abc', paid_purchases: '' },
        { timestamp: 't2', card_name: 'BPI-Gold', tx_date: '2026-03-05', type: 'payment', amount: '200', category: '', notes: '', statement_cycle: '2026-02', tx_id: 'p_def', paid_purchases: '' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ card_name: 'BPI-Gold', type: 'purchase', amount: 500, category: 'Groceries' });
    expect(txs[1]).toMatchObject({ card_name: 'BPI-Gold', type: 'payment', amount: 200, statement_cycle: '2026-02' });
  });

  test('returns [] when the CardTransactions tab is missing (fresh setup)', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    expect(await sheets.listTransactions()).toEqual([]);
  });

  test('returns tx_id verbatim when column present on the row', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't1', card_name: 'BPI', tx_date: '2026-03-01', type: 'purchase', amount: '500', tx_id: 'p_known123' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].tx_id).toBe('p_known123');
  });

  test('synthesizes ps_-prefixed tx_id for legacy rows without a tx_id column', async () => {
    const T = '2026-03-01T10:00:00.000Z';
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: T, card_name: 'BPI', tx_date: '2026-03-01', type: 'purchase', amount: '500' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].tx_id).toBe(`ps_${Date.parse(T)}_0`);
  });

  test('appends row-index suffix to synthesized ids so same-timestamp legacy rows do not collide', async () => {
    const T = '2026-03-01T10:00:00.000Z';
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: T, card_name: 'BPI', tx_date: '2026-03-01', type: 'purchase', amount: '100' },
        { timestamp: T, card_name: 'BPI', tx_date: '2026-03-01', type: 'purchase', amount: '200' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].tx_id).toBe(`ps_${Date.parse(T)}_0`);
    expect(txs[1].tx_id).toBe(`ps_${Date.parse(T)}_1`);
    expect(txs[0].tx_id).not.toBe(txs[1].tx_id);
  });

  test('parses paid_purchases CSV into string[]', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't', card_name: 'BPI', tx_date: '2026-03-01', type: 'payment', amount: '300', paid_purchases: 'p_a,p_b,p_c' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].paid_purchases).toEqual(['p_a', 'p_b', 'p_c']);
  });

  test('returns paid_purchases: [] when column is absent', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't', card_name: 'BPI', tx_date: '2026-03-01', type: 'payment', amount: '300' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].paid_purchases).toEqual([]);
  });

  test('returns paid_purchases: [] when column value is an empty string', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't', card_name: 'BPI', tx_date: '2026-03-01', type: 'payment', amount: '300', paid_purchases: '' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].paid_purchases).toEqual([]);
  });

  test('trims whitespace inside paid_purchases CSV and drops empty segments', async () => {
    const doc = createFakeDoc({
      CardTransactions: [
        { timestamp: 't', card_name: 'BPI', tx_date: '2026-03-01', type: 'payment', amount: '300', paid_purchases: ' p_a , p_b ,,p_c ' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const txs = await sheets.listTransactions();
    expect(txs[0].paid_purchases).toEqual(['p_a', 'p_b', 'p_c']);
  });
});

describe('createCardSheets.addTransaction', () => {
  test('appends a row with all transaction fields and returns generated tx_id', async () => {
    const doc = createFakeDoc({ CardTransactions: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const result = await sheets.addTransaction({
      timestamp: '2026-03-10T00:00:00.000Z',
      card_name: 'BPI-Gold',
      tx_date: '2026-03-10',
      type: 'purchase',
      amount: 1234.5,
      category: 'Groceries',
      notes: 'SM',
      statement_cycle: '',
    });
    expect(result.tx_id).toMatch(/^p_[0-9a-z]+_[0-9a-f]{4}$/);
    const snap = doc.sheetsByTitle.CardTransactions._snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      timestamp: '2026-03-10T00:00:00.000Z',
      card_name: 'BPI-Gold',
      tx_date: '2026-03-10',
      type: 'purchase',
      amount: 1234.5,
      category: 'Groceries',
      notes: 'SM',
      statement_cycle: '',
      tx_id: result.tx_id,
      paid_purchases: '',
    });
  });

  test('generates a fresh tx_id per call (no collisions across successive calls)', async () => {
    const doc = createFakeDoc({ CardTransactions: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const { tx_id } = await sheets.addTransaction({
        timestamp: new Date().toISOString(),
        card_name: 'BPI',
        tx_date: '2026-03-10',
        type: 'purchase',
        amount: 100,
      });
      expect(tx_id).toMatch(/^p_[0-9a-z]+_[0-9a-f]{4}$/);
      expect(seen.has(tx_id)).toBe(false);
      seen.add(tx_id);
    }
  });

  test('honors optional { txId } override verbatim (for deterministic tests)', async () => {
    const doc = createFakeDoc({ CardTransactions: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const result = await sheets.addTransaction({
      timestamp: 't',
      card_name: 'BPI',
      tx_date: '2026-03-10',
      type: 'purchase',
      amount: 100,
      txId: 'p_override_test',
    });
    expect(result.tx_id).toBe('p_override_test');
    expect(doc.sheetsByTitle.CardTransactions._snapshot()[0].tx_id).toBe('p_override_test');
  });

  test('writes paid_purchases as CSV when array provided', async () => {
    const doc = createFakeDoc({ CardTransactions: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    await sheets.addTransaction({
      timestamp: 't',
      card_name: 'BPI',
      tx_date: '2026-03-10',
      type: 'payment',
      amount: 300,
      paid_purchases: ['p_a', 'p_b', 'p_c'],
    });
    expect(doc.sheetsByTitle.CardTransactions._snapshot()[0].paid_purchases).toBe('p_a,p_b,p_c');
  });

  test('writes empty string when paid_purchases is [] or absent', async () => {
    const doc = createFakeDoc({ CardTransactions: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    await sheets.addTransaction({
      timestamp: 't1',
      card_name: 'BPI',
      tx_date: '2026-03-10',
      type: 'purchase',
      amount: 100,
    });
    await sheets.addTransaction({
      timestamp: 't2',
      card_name: 'BPI',
      tx_date: '2026-03-10',
      type: 'payment',
      amount: 100,
      paid_purchases: [],
    });
    const snap = doc.sheetsByTitle.CardTransactions._snapshot();
    expect(snap[0].paid_purchases).toBe('');
    expect(snap[1].paid_purchases).toBe('');
  });

  test('propagates MISSING_TAB when CardTransactions is absent', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.addTransaction({ card_name: 'X', type: 'purchase' })).rejects.toMatchObject({
      code: 'MISSING_TAB',
    });
  });
});

describe('createCardSheets.listStatements', () => {
  test('returns coerced statements', async () => {
    const doc = createFakeDoc({
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '5000', due_date: '2026-03-15', closed_at: 't1' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const stmts = await sheets.listStatements();
    expect(stmts).toEqual([{
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      statement_amount: 5000,
      due_date: '2026-03-15',
      closed_at: 't1',
    }]);
  });

  test('returns [] when the CardStatements tab is missing (fresh setup)', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    expect(await sheets.listStatements()).toEqual([]);
  });
});

describe('createCardSheets.findStatement', () => {
  test('returns the row for (card_name, cycle_month) — case-insensitive on card_name', async () => {
    const doc = createFakeDoc({
      CardStatements: [
        { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: '5000', due_date: '2026-03-15' },
        { card_name: 'Metrobank', cycle_month: '2026-02', statement_amount: '3000', due_date: '2026-03-25' },
      ],
    });
    const sheets = createCardSheets({ getDoc: async () => doc });
    const row = await sheets.findStatement('bpi-gold', '2026-02');
    expect(row).toMatchObject({ card_name: 'BPI-Gold', cycle_month: '2026-02' });
  });

  test('returns null when no matching cycle exists', async () => {
    const doc = createFakeDoc({ CardStatements: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    expect(await sheets.findStatement('BPI-Gold', '2026-02')).toBeNull();
  });

  test('returns null when CardStatements is missing', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    expect(await sheets.findStatement('BPI-Gold', '2026-02')).toBeNull();
  });
});

describe('createCardSheets.addStatement', () => {
  test('appends a row with all statement fields', async () => {
    const doc = createFakeDoc({ CardStatements: [] });
    const sheets = createCardSheets({ getDoc: async () => doc });
    await sheets.addStatement({
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      statement_amount: 5000,
      due_date: '2026-03-15',
      closed_at: '2026-03-01T00:00:00.000Z',
    });
    expect(doc.sheetsByTitle.CardStatements._snapshot()).toEqual([{
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      statement_amount: 5000,
      due_date: '2026-03-15',
      closed_at: '2026-03-01T00:00:00.000Z',
    }]);
  });

  test('propagates MISSING_TAB when CardStatements is absent', async () => {
    const sheets = createCardSheets({ getDoc: async () => createFakeDoc({}) });
    await expect(sheets.addStatement({ card_name: 'X' })).rejects.toMatchObject({
      code: 'MISSING_TAB',
    });
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
