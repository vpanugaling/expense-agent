function createFakeRow(data) {
  const store = { ...data };
  return {
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value;
    },
    save: async () => {},
    _data: store,
  };
}

function createFakeSheet(initialRows = []) {
  const rows = initialRows.map((r) => createFakeRow(r));

  return {
    async getRows() {
      return rows.slice();
    },
    async addRow(data) {
      const row = createFakeRow(data);
      rows.push(row);
      return row;
    },
    _snapshot() {
      return rows.map((r) => ({ ...r._data }));
    },
  };
}

function createFakeDoc(tabs = {}) {
  const sheetsByTitle = {};
  const sheetsByIndex = [];
  for (const [title, initialRows] of Object.entries(tabs)) {
    const sheet = createFakeSheet(initialRows);
    sheetsByTitle[title] = sheet;
    sheetsByIndex.push(sheet);
  }
  return {
    sheetsByTitle,
    sheetsByIndex,
    async loadInfo() {},
  };
}

module.exports = { createFakeRow, createFakeSheet, createFakeDoc };
