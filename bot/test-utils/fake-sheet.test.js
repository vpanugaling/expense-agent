const { createFakeDoc, createFakeSheet } = require('./fake-sheet');

describe('createFakeSheet', () => {
  test('getRows returns initial rows with .get accessors', async () => {
    const sheet = createFakeSheet([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    const rows = await sheet.getRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].get('name')).toBe('Alice');
    expect(rows[0].get('age')).toBe(30);
    expect(rows[1].get('name')).toBe('Bob');
  });

  test('addRow appends a row and returns it with .get', async () => {
    const sheet = createFakeSheet();
    const row = await sheet.addRow({ merchant: 'Kopi', total: 150 });
    expect(row.get('merchant')).toBe('Kopi');
    const rows = await sheet.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].get('merchant')).toBe('Kopi');
  });

  test('row.set mutates the row and persists via getRows', async () => {
    const sheet = createFakeSheet([{ status: 'open' }]);
    const rows = await sheet.getRows();
    rows[0].set('status', 'closed');
    await rows[0].save();
    const fresh = await sheet.getRows();
    expect(fresh[0].get('status')).toBe('closed');
  });

  test('row.get returns undefined for missing key', async () => {
    const sheet = createFakeSheet([{ a: 1 }]);
    const rows = await sheet.getRows();
    expect(rows[0].get('missing')).toBeUndefined();
  });

  test('getRows returns rows in insertion order across addRow calls', async () => {
    const sheet = createFakeSheet([{ id: 1 }]);
    await sheet.addRow({ id: 2 });
    await sheet.addRow({ id: 3 });
    const rows = await sheet.getRows();
    expect(rows.map(r => r.get('id'))).toEqual([1, 2, 3]);
  });

  test('_snapshot returns a plain-object copy of all rows', async () => {
    const sheet = createFakeSheet([{ a: 1 }, { a: 2 }]);
    expect(sheet._snapshot()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('_snapshot reflects addRow', async () => {
    const sheet = createFakeSheet();
    await sheet.addRow({ x: 'first' });
    await sheet.addRow({ x: 'second' });
    expect(sheet._snapshot()).toEqual([{ x: 'first' }, { x: 'second' }]);
  });
});

describe('createFakeDoc', () => {
  test('exposes sheetsByTitle keyed by tab name', () => {
    const doc = createFakeDoc({
      Expenses: [{ total: 100 }],
      Budgets: [{ category: 'Food', limit: 500 }],
    });
    expect(doc.sheetsByTitle.Expenses).toBeDefined();
    expect(doc.sheetsByTitle.Budgets).toBeDefined();
  });

  test('exposes sheetsByIndex in insertion order', () => {
    const doc = createFakeDoc({
      First: [],
      Second: [],
    });
    expect(doc.sheetsByIndex[0]).toBe(doc.sheetsByTitle.First);
    expect(doc.sheetsByIndex[1]).toBe(doc.sheetsByTitle.Second);
  });

  test('missing tab returns undefined', () => {
    const doc = createFakeDoc({ Expenses: [] });
    expect(doc.sheetsByTitle.Missing).toBeUndefined();
  });

  test('sheets on the doc are independent', async () => {
    const doc = createFakeDoc({ A: [], B: [] });
    await doc.sheetsByTitle.A.addRow({ x: 1 });
    const aRows = await doc.sheetsByTitle.A.getRows();
    const bRows = await doc.sheetsByTitle.B.getRows();
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(0);
  });

  test('loadInfo is a no-op that resolves', async () => {
    const doc = createFakeDoc({});
    await expect(doc.loadInfo()).resolves.toBeUndefined();
  });
});
