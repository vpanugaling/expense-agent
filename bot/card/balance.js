function daysInMonth(year, monthZeroIdx) {
  return new Date(Date.UTC(year, monthZeroIdx + 1, 0)).getUTCDate();
}

function iso(year, monthZeroIdx, day) {
  const clamped = Math.min(day, daysInMonth(year, monthZeroIdx));
  return `${year}-${String(monthZeroIdx + 1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function nextDueDate(dueDay, today = new Date()) {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();

  if (day <= dueDay) {
    return iso(year, month, dueDay);
  }
  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;
  return iso(nextYear, nextMonth, dueDay);
}

function formatYearMonth(year, monthZeroIdx) {
  return `${year}-${String(monthZeroIdx + 1).padStart(2, '0')}`;
}

// SPEC: if today.day >= statement_day, the current month is the cycle that
// just closed. Otherwise the last-closed cycle is the previous month.
function deriveCycleMonth(statementDay, today = new Date()) {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();
  if (day >= statementDay) return formatYearMonth(year, month);
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  return formatYearMonth(prevYear, prevMonth);
}

// SPEC: default due_date is due_day in the month AFTER cycle_month, with the
// same end-of-month clamp used by nextDueDate.
function computeDueDate(dueDay, cycleMonth) {
  const [yearStr, monthStr] = String(cycleMonth).split('-');
  const year = Number(yearStr);
  const monthZeroIdx = Number(monthStr) - 1;
  const nextMonth = (monthZeroIdx + 1) % 12;
  const nextYear = monthZeroIdx === 11 ? year + 1 : year;
  return iso(nextYear, nextMonth, dueDay);
}

// Sum(purchases) − Sum(payments) per card_name. Returns { [card_name]: number }.
// Negative balances (overpayment) are preserved intentionally — SPEC says so.
function computeBalances(transactions) {
  const balances = {};
  for (const tx of transactions) {
    const sign = tx.type === 'purchase' ? 1 : tx.type === 'payment' ? -1 : 0;
    if (sign === 0) continue;
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) continue;
    balances[tx.card_name] = (balances[tx.card_name] || 0) + sign * amount;
  }
  return balances;
}

// SPEC: an "open cycle" is a statement whose linked payments (sum of payment
// tx with matching statement_cycle) fall short of statement_amount. Cycles are
// returned oldest-first so the picker prompts the user to clear the most
// overdue cycle first. Payments with empty statement_cycle are unlinked and
// ignored here — they are not applied to any cycle.
function computeOpenCycles(cardName, statements, transactions) {
  const target = String(cardName).toLowerCase();
  const paidMap = {};
  for (const tx of transactions) {
    if (tx.type !== 'payment') continue;
    if (String(tx.card_name).toLowerCase() !== target) continue;
    if (!tx.statement_cycle) continue;
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) continue;
    paidMap[tx.statement_cycle] = (paidMap[tx.statement_cycle] || 0) + amount;
  }
  const open = [];
  for (const s of statements) {
    if (String(s.card_name).toLowerCase() !== target) continue;
    const statementAmount = Number(s.statement_amount);
    const paid = paidMap[s.cycle_month] || 0;
    if (paid >= statementAmount) continue;
    open.push({
      cycle_month: s.cycle_month,
      due_date: s.due_date,
      statement_amount: statementAmount,
      paid,
      outstanding: statementAmount - paid,
    });
  }
  open.sort((a, b) => String(a.cycle_month).localeCompare(String(b.cycle_month)));
  return open;
}

// SPEC: /card due uses the statement's actual due_date when a cycle is still
// open (so you're reminded of the real bill you owe). If no cycle is open
// — either no statement has been closed yet, or every closed statement is
// fully paid — we fall back to the projected due from the card's due_day.
function computeCardDue(card, statements, transactions, today = new Date()) {
  const open = computeOpenCycles(card.card_name, statements, transactions);
  if (open.length > 0) {
    const soonest = open[0];
    return {
      card_name: card.card_name,
      due_date: soonest.due_date,
      cycle_month: soonest.cycle_month,
      outstanding: soonest.outstanding,
      source: 'statement',
    };
  }
  return {
    card_name: card.card_name,
    due_date: nextDueDate(card.due_day, today),
    cycle_month: null,
    outstanding: null,
    source: 'projected',
  };
}

module.exports = { nextDueDate, computeBalances, deriveCycleMonth, computeDueDate, computeOpenCycles, computeCardDue };
