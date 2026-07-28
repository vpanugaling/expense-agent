const { GoogleSpreadsheet } = require('google-spreadsheet');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function createSheetsClient({
  sheetId,
  auth,
  SpreadsheetClass = GoogleSpreadsheet,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
}) {
  let cachedPromise = null;
  let cachedAt = 0;

  function invalidate() {
    cachedPromise = null;
    cachedAt = 0;
  }

  async function getDoc() {
    const t = now();
    if (cachedPromise && (t - cachedAt) < ttlMs) {
      return cachedPromise;
    }
    cachedAt = t;
    cachedPromise = (async () => {
      const doc = new SpreadsheetClass(sheetId, auth);
      try {
        await doc.loadInfo();
        return doc;
      } catch (err) {
        invalidate();
        throw err;
      }
    })();
    return cachedPromise;
  }

  return { getDoc, invalidate };
}

module.exports = { createSheetsClient };
