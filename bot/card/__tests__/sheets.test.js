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
