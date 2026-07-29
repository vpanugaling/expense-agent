function rowToCard(row) {
  return {
    card_name: row.get('card_name'),
    last4: row.get('last4'),
    credit_limit: Number(row.get('credit_limit')),
    statement_day: Number(row.get('statement_day')),
    due_day: Number(row.get('due_day')),
    created_at: row.get('created_at'),
  };
}

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

  async function listCards() {
    const sheet = await getTab('CreditCards');
    const rows = await sheet.getRows();
    return rows.map(rowToCard);
  }

  async function findCard(cardName) {
    const target = String(cardName).trim().toLowerCase();
    const cards = await listCards();
    return cards.find((c) => String(c.card_name).toLowerCase() === target) || null;
  }

  // Missing tab returns [] intentionally — /card list renders zero-balance
  // for every card in that scenario rather than showing a setup message.
  async function listTransactions() {
    let sheet;
    try {
      sheet = await getTab('CardTransactions');
    } catch (err) {
      if (err.code === 'MISSING_TAB') return [];
      throw err;
    }
    const rows = await sheet.getRows();
    return rows.map((row) => ({
      timestamp: row.get('timestamp'),
      card_name: row.get('card_name'),
      tx_date: row.get('tx_date'),
      type: row.get('type'),
      amount: Number(row.get('amount')),
      category: row.get('category') || '',
      notes: row.get('notes') || '',
      statement_cycle: row.get('statement_cycle') || '',
    }));
  }

  async function addTransaction(tx) {
    const sheet = await getTab('CardTransactions');
    await sheet.addRow({
      timestamp: tx.timestamp,
      card_name: tx.card_name,
      tx_date: tx.tx_date,
      type: tx.type,
      amount: tx.amount,
      category: tx.category || '',
      notes: tx.notes || '',
      statement_cycle: tx.statement_cycle || '',
    });
  }

  async function addCard(card) {
    const sheet = await getTab('CreditCards');
    await sheet.addRow({
      card_name: card.card_name,
      last4: card.last4,
      credit_limit: card.credit_limit,
      statement_day: card.statement_day,
      due_day: card.due_day,
      created_at: card.created_at,
    });
  }

  // Rewrite card_name in every row whose current card_name matches oldName
  // (case-insensitively). Returns { changed } — the count of rows saved.
  // { optional: true } converts MISSING_TAB into { changed: 0 } so callers can
  // treat not-yet-created tabs (CardTransactions, CardStatements) as no-ops.
  async function renameCardInTab(tabName, oldName, newName, { optional = false } = {}) {
    let sheet;
    try {
      sheet = await getTab(tabName);
    } catch (err) {
      if (err.code === 'MISSING_TAB' && optional) return { changed: 0 };
      throw err;
    }
    const rows = await sheet.getRows();
    const target = String(oldName).toLowerCase();
    let changed = 0;
    for (const row of rows) {
      if (String(row.get('card_name')).toLowerCase() === target) {
        row.set('card_name', newName);
        await row.save();
        changed += 1;
      }
    }
    return { changed };
  }

  return { getTab, listCards, findCard, addCard, listTransactions, addTransaction, renameCardInTab };
}

module.exports = { createCardSheets };
