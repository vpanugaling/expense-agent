const { nextDueDate, computeOpenCycles } = require('./balance');
const { buildPurchaseIndex } = require('./purchases');
const { escapeMd } = require('../markdown');

const MS_PER_DAY = 86400000;

// UTC calendar arithmetic. Both today and dueDate are treated as calendar
// dates — no time component — so DST shifts in the host's local zone can't
// nudge the diff off by one day. Asia/Manila (UTC+8) has no DST, but the
// reminder logic should stay portable if this ever runs elsewhere.
function shouldRemind(today, dueDate) {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const [y, m, d] = String(dueDate).split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const diff = Math.round((target - t) / MS_PER_DAY);
  if (diff === 0) return 'T-0';
  if (diff === 3) return 'T-3';
  return null;
}

// Two-phase: Phase 1 walks cards for projected-due reminders (based on
// card.due_day). Phase 2 groups statements by card and calls computeOpenCycles
// ONCE per card with ALL that card's statements — this preserves overpayment
// carryforward across cycles (P2 fix). The previous per-statement call passed
// [singleStatement] to computeOpenCycles, which meant credit from an overpaid
// earlier cycle could not flow to a later open cycle, producing a spurious
// "cycle B is still open" reminder even after the balance was fully cleared.
//
// A card with an open statement matching both phases will emit both — the
// card-level nudge is generic ("your card is due"), the statement-level one
// carries outstanding.
function computeCardReminders(cards, statements, transactions, today = new Date()) {
  const out = [];

  for (const c of cards) {
    const projected = nextDueDate(c.due_day, today);
    const when = shouldRemind(today, projected);
    if (when) {
      out.push({ type: 'card', card_name: c.card_name, due_date: projected, when });
    }
  }

  const cardsByName = new Map();
  for (const c of cards) cardsByName.set(String(c.card_name).toLowerCase(), c);

  const statementsByCard = new Map();
  for (const s of statements) {
    const key = String(s.card_name).toLowerCase();
    if (!statementsByCard.has(key)) statementsByCard.set(key, []);
    statementsByCard.get(key).push(s);
  }

  const purchaseIndex = buildPurchaseIndex(transactions);

  for (const [key, stmts] of statementsByCard) {
    const card = cardsByName.get(key);
    // Orphan statement (no matching card row) — skip; reminders need the card
    // context for cycle derivation and would otherwise crash on null.card.
    if (!card) continue;
    const open = computeOpenCycles(card, stmts, transactions, purchaseIndex);
    const openByMonth = new Map(open.map((o) => [o.cycle_month, o]));
    for (const s of stmts) {
      const openCycle = openByMonth.get(s.cycle_month);
      if (!openCycle) continue;
      const when = shouldRemind(today, s.due_date);
      if (!when) continue;
      out.push({
        type: 'statement',
        card_name: s.card_name,
        cycle_month: s.cycle_month,
        due_date: s.due_date,
        outstanding: openCycle.outstanding,
        when,
      });
    }
  }

  return out;
}

function formatReminder(r) {
  const label = r.when === 'T-0' ? 'due today' : 'due in 3 days';
  const name = escapeMd(r.card_name);
  if (r.type === 'card') {
    return `🔔 *${name}* is ${label} (${r.due_date}).`;
  }
  const outstanding = Number(r.outstanding).toLocaleString();
  return `🔔 *${name}* statement (cycle ${r.cycle_month}) is ${label} — ₱${outstanding} outstanding (${r.due_date}).`;
}

function createReminders({
  bot,
  cardSheets,
  allowedUserIds,
  cron,
  now = () => new Date(),
  disabled = false,
}) {
  async function loadInputs() {
    // Missing CreditCards → treat as no cards; listStatements/Transactions
    // already return [] on MISSING_TAB via the sheets adapter.
    let cards = [];
    try {
      cards = await cardSheets.listCards();
    } catch (err) {
      if (err.code !== 'MISSING_TAB') throw err;
    }
    const [statements, transactions] = await Promise.all([
      cardSheets.listStatements(),
      cardSheets.listTransactions(),
    ]);
    return { cards, statements, transactions };
  }

  async function run() {
    const { cards, statements, transactions } = await loadInputs();
    const reminders = computeCardReminders(cards, statements, transactions, now());
    for (const r of reminders) {
      const text = formatReminder(r);
      for (const uid of allowedUserIds) {
        try {
          await bot.sendMessage(uid, text, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error(`reminder send failed (uid=${uid}):`, err.message);
        }
      }
    }
  }

  function start() {
    if (disabled) return null;
    return cron.schedule('0 21 * * *', run, { timezone: 'Asia/Manila' });
  }

  return { run, start };
}

module.exports = {
  shouldRemind,
  computeCardReminders,
  formatReminder,
  createReminders,
};
