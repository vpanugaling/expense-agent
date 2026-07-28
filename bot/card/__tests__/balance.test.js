const { nextDueDate } = require('../balance');

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
