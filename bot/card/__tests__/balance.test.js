const { nextDueDate, computeBalances, deriveCycleMonth, computeDueDate } = require('../balance');

// All dates are treated as UTC calendar dates (no time component).
// See balance.js — using getUTC*/Date.UTC avoids TZ drift under jest.
function utc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('nextDueDate', () => {
  test('returns this month when today is before due_day', () => {
    expect(nextDueDate(15, utc(2026, 3, 10))).toBe('2026-03-15');
  });

  test('returns today when today equals due_day', () => {
    expect(nextDueDate(15, utc(2026, 3, 15))).toBe('2026-03-15');
  });

  test('returns next month when today is after due_day', () => {
    expect(nextDueDate(15, utc(2026, 3, 20))).toBe('2026-04-15');
  });

  test('clamps due_day=31 in a 30-day month', () => {
    // Today 4/15 → next due is 4/30 (April has 30 days)
    expect(nextDueDate(31, utc(2026, 4, 15))).toBe('2026-04-30');
  });

  test('clamps due_day=31 in February (non-leap)', () => {
    expect(nextDueDate(31, utc(2027, 2, 15))).toBe('2027-02-28');
  });

  test('clamps due_day=31 in February (leap)', () => {
    expect(nextDueDate(31, utc(2028, 2, 15))).toBe('2028-02-29');
  });

  test('rolls year over from December to January', () => {
    expect(nextDueDate(15, utc(2026, 12, 20))).toBe('2027-01-15');
  });

  test('handles due_day=1 correctly (today after → next month 1st)', () => {
    expect(nextDueDate(1, utc(2026, 3, 15))).toBe('2026-04-01');
  });
});

describe('computeBalances', () => {
  test('returns empty map when there are no transactions', () => {
    expect(computeBalances([])).toEqual({});
  });

  test('sums purchases per card', () => {
    const balances = computeBalances([
      { card_name: 'BPI-Gold', type: 'purchase', amount: 100 },
      { card_name: 'BPI-Gold', type: 'purchase', amount: 250 },
      { card_name: 'Metrobank', type: 'purchase', amount: 500 },
    ]);
    expect(balances).toEqual({ 'BPI-Gold': 350, Metrobank: 500 });
  });

  test('subtracts payments from purchases', () => {
    const balances = computeBalances([
      { card_name: 'BPI-Gold', type: 'purchase', amount: 1000 },
      { card_name: 'BPI-Gold', type: 'payment', amount: 300 },
    ]);
    expect(balances).toEqual({ 'BPI-Gold': 700 });
  });

  test('allows negative balance from overpayment', () => {
    const balances = computeBalances([
      { card_name: 'BPI-Gold', type: 'purchase', amount: 100 },
      { card_name: 'BPI-Gold', type: 'payment', amount: 250 },
    ]);
    expect(balances).toEqual({ 'BPI-Gold': -150 });
  });

  test('coerces string amounts', () => {
    const balances = computeBalances([
      { card_name: 'BPI-Gold', type: 'purchase', amount: '1000.50' },
      { card_name: 'BPI-Gold', type: 'payment', amount: '250' },
    ]);
    expect(balances['BPI-Gold']).toBeCloseTo(750.5);
  });

  test('ignores rows with unknown type', () => {
    const balances = computeBalances([
      { card_name: 'BPI-Gold', type: 'purchase', amount: 100 },
      { card_name: 'BPI-Gold', type: 'weird', amount: 999 },
    ]);
    expect(balances).toEqual({ 'BPI-Gold': 100 });
  });
});

describe('deriveCycleMonth', () => {
  test('returns current month when today.day >= statement_day', () => {
    expect(deriveCycleMonth(25, utc(2026, 3, 25))).toBe('2026-03');
    expect(deriveCycleMonth(25, utc(2026, 3, 30))).toBe('2026-03');
  });

  test('returns previous month when today.day < statement_day', () => {
    expect(deriveCycleMonth(25, utc(2026, 3, 20))).toBe('2026-02');
    expect(deriveCycleMonth(25, utc(2026, 3, 1))).toBe('2026-02');
  });

  test('rolls year over from January to previous December', () => {
    expect(deriveCycleMonth(25, utc(2026, 1, 10))).toBe('2025-12');
  });

  test('handles statement_day=1 (today.day always >= 1 → current month)', () => {
    expect(deriveCycleMonth(1, utc(2026, 3, 1))).toBe('2026-03');
    expect(deriveCycleMonth(1, utc(2026, 3, 15))).toBe('2026-03');
  });

  test('handles statement_day=31 correctly in short months', () => {
    // Feb only has 28 days; today.day (28) < 31 → cycle rolls to previous month
    expect(deriveCycleMonth(31, utc(2026, 2, 28))).toBe('2026-01');
    // March 31 → cycle_month = March
    expect(deriveCycleMonth(31, utc(2026, 3, 31))).toBe('2026-03');
  });
});

describe('computeDueDate', () => {
  test('returns due_day in the month AFTER cycle_month', () => {
    expect(computeDueDate(15, '2026-03')).toBe('2026-04-15');
  });

  test('rolls year over from December cycle to January due', () => {
    expect(computeDueDate(15, '2026-12')).toBe('2027-01-15');
  });

  test('clamps due_day=31 in February (non-leap)', () => {
    expect(computeDueDate(31, '2027-01')).toBe('2027-02-28');
  });

  test('clamps due_day=31 in February (leap)', () => {
    expect(computeDueDate(31, '2028-01')).toBe('2028-02-29');
  });

  test('clamps due_day=31 in a 30-day month', () => {
    expect(computeDueDate(31, '2026-03')).toBe('2026-04-30');
  });
});
