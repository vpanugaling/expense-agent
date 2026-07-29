const { validatePrefixes } = require('../prefix-validator');

describe('validatePrefixes', () => {
  test('passes for disjoint prefixes', () => {
    expect(() => validatePrefixes(['receipt_', 'card_purchase_', 'card_ppay_'])).not.toThrow();
  });

  test('passes for empty list', () => {
    expect(() => validatePrefixes([])).not.toThrow();
  });

  test('passes for single prefix', () => {
    expect(() => validatePrefixes(['receipt_'])).not.toThrow();
  });

  test('throws when one prefix is a proper prefix of another', () => {
    expect(() => validatePrefixes(['card_', 'card_purchase_'])).toThrow(/collision/i);
  });

  test('throws when prefixes are listed in reverse order (longer first)', () => {
    expect(() => validatePrefixes(['card_purchase_', 'card_'])).toThrow(/collision/i);
  });

  test('error message names both offending prefixes', () => {
    let err;
    try {
      validatePrefixes(['card_', 'card_purchase_']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('card_');
    expect(err.message).toContain('card_purchase_');
  });

  test('throws for duplicate prefixes', () => {
    expect(() => validatePrefixes(['receipt_', 'receipt_'])).toThrow(/duplicate/i);
  });

  test('handles three-way collision by reporting the first pair found', () => {
    expect(() => validatePrefixes(['a_', 'a_b_', 'a_b_c_'])).toThrow(/collision/i);
  });

  test('rejects non-string prefixes with a clear error', () => {
    expect(() => validatePrefixes(['receipt_', null])).toThrow(/prefix/i);
    expect(() => validatePrefixes(['receipt_', undefined])).toThrow(/prefix/i);
    expect(() => validatePrefixes(['receipt_', 42])).toThrow(/prefix/i);
  });

  test('rejects empty-string prefix (would swallow every callback)', () => {
    expect(() => validatePrefixes(['receipt_', ''])).toThrow(/empty/i);
  });
});
