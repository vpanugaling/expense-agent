const { synthesizeTxId } = require('./purchases');

// generateTxId mints a fresh purchase/payment id at write time. Format:
// `p_<epoch36>_<rand4hex>`. The `p_` prefix (generated) is intentionally
// distinct from `ps_` (synthesized from legacy rows) so grep and logs can
// tell them apart. The 4-hex random suffix disambiguates ids minted within
// the same millisecond — good enough for a single-user bot.
function generateTxId() {
  const epoch = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `p_${epoch}_${rand}`;
}

// paid_purchases is stored as a comma-separated string in the sheet and
// exposed as string[] on read. Whitespace inside segments is trimmed; empty
// segments are dropped so a stray leading/trailing comma or double-comma
// (from manual edits in the sheet) does not surface an empty-id.
function parsePaidPurchases(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
    return rows.map((row, i) => {
      const base = {
        timestamp: row.get('timestamp'),
        card_name: row.get('card_name'),
        tx_date: row.get('tx_date'),
        type: row.get('type'),
        amount: Number(row.get('amount')),
        category: row.get('category') || '',
        notes: row.get('notes') || '',
        statement_cycle: row.get('statement_cycle') || '',
        paid_purchases: parsePaidPurchases(row.get('paid_purchases')),
      };
      // Legacy rows written before Task E1 lack the tx_id column. We
      // synthesize a stable ps_-prefixed id using timestamp + row index so
      // downstream code (payment tagging, hydration) has a unique key even
      // if two legacy rows share a timestamp.
      base.tx_id = synthesizeTxId({ tx_id: row.get('tx_id'), timestamp: base.timestamp }, i);
      return base;
    });
  }

  // Missing tab → [] so /card list and /card due don't break on fresh setups
  // that have no statements yet.
  async function listStatements() {
    let sheet;
    try {
      sheet = await getTab('CardStatements');
    } catch (err) {
      if (err.code === 'MISSING_TAB') return [];
      throw err;
    }
    const rows = await sheet.getRows();
    return rows.map((row) => ({
      card_name: row.get('card_name'),
      cycle_month: row.get('cycle_month'),
      statement_amount: Number(row.get('statement_amount')),
      due_date: row.get('due_date'),
      closed_at: row.get('closed_at'),
    }));
  }

  async function findStatement(cardName, cycleMonth) {
    const target = String(cardName).toLowerCase();
    const stmts = await listStatements();
    return stmts.find((s) => String(s.card_name).toLowerCase() === target && s.cycle_month === cycleMonth) || null;
  }

  async function addStatement(stmt) {
    const sheet = await getTab('CardStatements');
    await sheet.addRow({
      card_name: stmt.card_name,
      cycle_month: stmt.cycle_month,
      statement_amount: stmt.statement_amount,
      due_date: stmt.due_date,
      closed_at: stmt.closed_at,
    });
  }

  // addTransaction mints tx_id internally so callers cannot skew the id
  // scheme. The optional { txId } override exists solely for tests that
  // need deterministic ids; production callers should not use it.
  // Returns { tx_id } so callers that need to reference the row later
  // (e.g. payment tagging paid_purchases) do not have to re-read the sheet.
  async function addTransaction(tx) {
    const sheet = await getTab('CardTransactions');
    const txId = tx.txId || generateTxId();
    const paidCsv = Array.isArray(tx.paid_purchases) ? tx.paid_purchases.join(',') : '';
    await sheet.addRow({
      timestamp: tx.timestamp,
      card_name: tx.card_name,
      tx_date: tx.tx_date,
      type: tx.type,
      amount: tx.amount,
      category: tx.category || '',
      notes: tx.notes || '',
      statement_cycle: tx.statement_cycle || '',
      tx_id: txId,
      paid_purchases: paidCsv,
    });
    return { tx_id: txId };
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

  return {
    getTab,
    listCards,
    findCard,
    addCard,
    listTransactions,
    addTransaction,
    listStatements,
    findStatement,
    addStatement,
    renameCardInTab,
  };
}

module.exports = { createCardSheets };
