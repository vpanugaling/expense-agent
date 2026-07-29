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

module.exports = { nextDueDate, computeBalances, deriveCycleMonth, computeDueDate };
