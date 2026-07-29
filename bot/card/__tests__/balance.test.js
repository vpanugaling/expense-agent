const { nextDueDate, computeBalances } = require('../balance');

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
