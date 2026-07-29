const { escapeMd } = require('../markdown');

describe('escapeMd', () => {
  test('leaves plain text untouched', () => {
    expect(escapeMd('hello world')).toBe('hello world');
  });

  test('escapes underscores', () => {
    expect(escapeMd('my_card')).toBe('my\\_card');
    expect(escapeMd('a_b_c')).toBe('a\\_b\\_c');
  });

  test('escapes asterisks', () => {
    expect(escapeMd('bold*text')).toBe('bold\\*text');
  });

  test('escapes backticks', () => {
    expect(escapeMd('code`snippet')).toBe('code\\`snippet');
  });

  test('escapes opening brackets', () => {
    expect(escapeMd('[link]')).toBe('\\[link]');
  });

  test('escapes all special chars together', () => {
    expect(escapeMd('_*`[')).toBe('\\_\\*\\`\\[');
  });

  test('handles empty string', () => {
    expect(escapeMd('')).toBe('');
  });

  test('coerces non-string inputs to string', () => {
    expect(escapeMd(123)).toBe('123');
    expect(escapeMd(null)).toBe('');
    expect(escapeMd(undefined)).toBe('');
  });

  test('escapes a payload that would otherwise close italic prematurely', () => {
    // "*Card:* my_card" would render "_card" as start of italic; escaping fixes it.
    const s = `*Card:* ${escapeMd('my_card')}`;
    expect(s).toBe('*Card:* my\\_card');
  });
});
