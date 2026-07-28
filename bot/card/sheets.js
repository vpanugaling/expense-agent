function createCardSheets({ getDoc }) {
  async function getTab(name) {
    const doc = await getDoc();
    const sheet = doc.sheetsByTitle[name];
    if (!sheet) {
      const err = new Error(`Sheet tab "${name}" not found`);
      err.code = 'MISSING_TAB';
      err.tabName = name;
      throw err;
    }
    return sheet;
  }

  return { getTab };
}

module.exports = { createCardSheets };
