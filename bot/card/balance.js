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

module.exports = { nextDueDate };
