const { createSheetsClient } = require('./sheets-client');

function makeFakeDoc() {
  return {
    loadInfoCalls: 0,
    async loadInfo() { this.loadInfoCalls++; },
  };
}

function makeFakes(overrides = {}) {
  const docs = [];
  const FakeSpreadsheet = jest.fn(function (sheetId, auth) {
    this.sheetId = sheetId;
    this.auth = auth;
    this.loadInfoCalls = 0;
    this.loadInfo = async () => { this.loadInfoCalls++; };
    docs.push(this);
  });

  let currentTime = 1_000_000;
  const now = jest.fn(() => currentTime);
  const advance = (ms) => { currentTime += ms; };

  const client = createSheetsClient({
    sheetId: 'sheet-abc',
    auth: { fake: 'auth' },
    SpreadsheetClass: FakeSpreadsheet,
    now,
    ttlMs: 5 * 60 * 1000,
    ...overrides,
  });

  return { client, FakeSpreadsheet, docs, advance };
}

describe('createSheetsClient', () => {
  test('first getDoc() constructs a doc and calls loadInfo', async () => {
    const { client, FakeSpreadsheet, docs } = makeFakes();
    const doc = await client.getDoc();
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(1);
    expect(FakeSpreadsheet).toHaveBeenCalledWith('sheet-abc', { fake: 'auth' });
    expect(docs).toHaveLength(1);
    expect(doc.loadInfoCalls).toBe(1);
  });

  test('second call within TTL returns cached doc without re-instantiating', async () => {
    const { client, FakeSpreadsheet, advance } = makeFakes();
    const first = await client.getDoc();
    advance(60 * 1000);
    const second = await client.getDoc();
    expect(second).toBe(first);
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(1);
  });

  test('call after TTL expires creates a fresh doc', async () => {
    const { client, FakeSpreadsheet, advance } = makeFakes();
    const first = await client.getDoc();
    advance(5 * 60 * 1000 + 1);
    const second = await client.getDoc();
    expect(second).not.toBe(first);
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(2);
  });

  test('invalidate() forces fresh doc on next call', async () => {
    const { client, FakeSpreadsheet } = makeFakes();
    const first = await client.getDoc();
    client.invalidate();
    const second = await client.getDoc();
    expect(second).not.toBe(first);
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(2);
  });

  test('concurrent getDoc() calls only construct one doc', async () => {
    const { client, FakeSpreadsheet } = makeFakes();
    const [a, b, c] = await Promise.all([
      client.getDoc(),
      client.getDoc(),
      client.getDoc(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(1);
  });

  test('loadInfo failure does not poison the cache', async () => {
    let attempt = 0;
    const FakeSpreadsheet = jest.fn(function () {
      this.loadInfo = async () => {
        attempt++;
        if (attempt === 1) throw new Error('boom');
      };
    });
    const client = createSheetsClient({
      sheetId: 'sheet-abc',
      auth: {},
      SpreadsheetClass: FakeSpreadsheet,
      now: () => 1_000_000,
      ttlMs: 5 * 60 * 1000,
    });

    await expect(client.getDoc()).rejects.toThrow('boom');
    const doc = await client.getDoc();
    expect(doc).toBeDefined();
    expect(FakeSpreadsheet).toHaveBeenCalledTimes(2);
  });
});
