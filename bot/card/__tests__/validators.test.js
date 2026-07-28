const {
  validateNickname,
  validateAmount,
  validateDay,
  validateLimit,
} = require('../validators');

describe('validateNickname', () => {
  test('accepts alphanumeric with underscore and hyphen', () => {
    expect(validateNickname('BPI-Gold')).toEqual({ valid: true, value: 'BPI-Gold' });
    expect(validateNickname('bpi_gold_1234')).toEqual({ valid: true, value: 'bpi_gold_1234' });
    expect(validateNickname('a')).toEqual({ valid: true, value: 'a' });
  });

  test('trims surrounding whitespace before validating', () => {
    expect(validateNickname('  BPI-Gold  ')).toEqual({ valid: true, value: 'BPI-Gold' });
  });

  test('rejects empty and whitespace-only', () => {
    expect(validateNickname('').valid).toBe(false);
    expect(validateNickname('   ').valid).toBe(false);
  });

  test('rejects strings with spaces', () => {
    expect(validateNickname('BPI Gold').valid).toBe(false);
  });

  test('rejects special characters', () => {
    expect(validateNickname('BPI/Gold').valid).toBe(false);
    expect(validateNickname('BPI.Gold').valid).toBe(false);
    expect(validateNickname('BPI@Gold').valid).toBe(false);
  });

  test('rejects strings longer than 32 characters', () => {
    expect(validateNickname('a'.repeat(32)).valid).toBe(true);
    expect(validateNickname('a'.repeat(33)).valid).toBe(false);
  });

  test('rejects reserved words purchase and payment (case insensitive)', () => {
    expect(validateNickname('purchase').valid).toBe(false);
    expect(validateNickname('PURCHASE').valid).toBe(false);
    expect(validateNickname('Payment').valid).toBe(false);
    expect(validateNickname('PAYMENT').valid).toBe(false);
  });

  test('coerces non-string inputs safely', () => {
    expect(validateNickname(null).valid).toBe(false);
    expect(validateNickname(undefined).valid).toBe(false);
    expect(validateNickname(12345)).toEqual({ valid: true, value: '12345' });
  });
});

describe('validateAmount', () => {
  test('accepts positive integers', () => {
    expect(validateAmount('100')).toEqual({ valid: true, value: 100 });
    expect(validateAmount(100)).toEqual({ valid: true, value: 100 });
  });

  test('accepts up to 2 decimal places', () => {
    expect(validateAmount('1234.5')).toEqual({ valid: true, value: 1234.5 });
    expect(validateAmount('1234.56')).toEqual({ valid: true, value: 1234.56 });
    expect(validateAmount('0.99')).toEqual({ valid: true, value: 0.99 });
  });

  test('rejects zero and negative', () => {
    expect(validateAmount('0').valid).toBe(false);
    expect(validateAmount('-1').valid).toBe(false);
    expect(validateAmount(-100).valid).toBe(false);
  });

  test('rejects more than 2 decimal places', () => {
    expect(validateAmount('1.234').valid).toBe(false);
    expect(validateAmount('1.00000001').valid).toBe(false);
  });

  test('rejects non-numeric input', () => {
    expect(validateAmount('abc').valid).toBe(false);
    expect(validateAmount('12abc').valid).toBe(false);
    expect(validateAmount('').valid).toBe(false);
    expect(validateAmount('   ').valid).toBe(false);
  });

  test('rejects currency symbols in input', () => {
    expect(validateAmount('₱100').valid).toBe(false);
    expect(validateAmount('$100').valid).toBe(false);
    expect(validateAmount('100,000').valid).toBe(false);
  });

  test('trims whitespace before parsing', () => {
    expect(validateAmount('  100  ')).toEqual({ valid: true, value: 100 });
  });

  test('rejects null and undefined', () => {
    expect(validateAmount(null).valid).toBe(false);
    expect(validateAmount(undefined).valid).toBe(false);
  });
});

describe('validateDay', () => {
  test('accepts integers 1 through 31', () => {
    for (const d of [1, 15, 25, 31]) {
      expect(validateDay(d)).toEqual({ valid: true, value: d });
      expect(validateDay(String(d))).toEqual({ valid: true, value: d });
    }
  });

  test('rejects 0 and negative', () => {
    expect(validateDay('0').valid).toBe(false);
    expect(validateDay('-1').valid).toBe(false);
  });

  test('rejects 32 and above', () => {
    expect(validateDay('32').valid).toBe(false);
    expect(validateDay('100').valid).toBe(false);
  });

  test('rejects non-integer', () => {
    expect(validateDay('1.5').valid).toBe(false);
    expect(validateDay('15.0').valid).toBe(false);
  });

  test('rejects non-numeric', () => {
    expect(validateDay('abc').valid).toBe(false);
    expect(validateDay('').valid).toBe(false);
    expect(validateDay(null).valid).toBe(false);
    expect(validateDay(undefined).valid).toBe(false);
  });
});

describe('validateLimit', () => {
  test('accepts positive amounts like validateAmount', () => {
    expect(validateLimit('80000')).toEqual({ valid: true, value: 80000 });
    expect(validateLimit('80000.50')).toEqual({ valid: true, value: 80000.5 });
  });

  test('rejects zero and negative', () => {
    expect(validateLimit('0').valid).toBe(false);
    expect(validateLimit('-100').valid).toBe(false);
  });

  test('error message mentions credit limit', () => {
    const result = validateLimit('abc');
    expect(result.valid).toBe(false);
    expect(result.error.toLowerCase()).toContain('limit');
  });
});
