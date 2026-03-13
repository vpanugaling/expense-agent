const { findCategory, CATEGORIES, CATEGORY_ALIASES } = require('./index');

describe('findCategory', () => {
  describe('exact match', () => {
    test('returns category for exact match', () => {
      expect(findCategory('Groceries')).toBe('Groceries');
      expect(findCategory('Eating out')).toBe('Eating out');
      expect(findCategory('Medical/Pharmacy')).toBe('Medical/Pharmacy');
    });

    test('is case insensitive', () => {
      expect(findCategory('groceries')).toBe('Groceries');
      expect(findCategory('GROCERIES')).toBe('Groceries');
      expect(findCategory('GrOcErIeS')).toBe('Groceries');
    });

    test('trims whitespace', () => {
      expect(findCategory('  Groceries  ')).toBe('Groceries');
      expect(findCategory('\tGroceries\n')).toBe('Groceries');
    });
  });

  describe('alias match', () => {
    test('returns mapped category for known aliases', () => {
      expect(findCategory('grocery')).toBe('Groceries');
      expect(findCategory('supermarket')).toBe('Groceries');
      expect(findCategory('food')).toBe('Eating out');
      expect(findCategory('grab')).toBe('Transportation');
      expect(findCategory('meds')).toBe('Medical/Pharmacy');
      expect(findCategory('netflix')).toBe('Subscriptions');
    });

    test('alias matching is case insensitive', () => {
      expect(findCategory('GROCERY')).toBe('Groceries');
      expect(findCategory('Grab')).toBe('Transportation');
    });
  });

  describe('partial match', () => {
    test('returns category for partial match', () => {
      expect(findCategory('grocer')).toBe('Groceries');
      expect(findCategory('transport')).toBe('Transportation');
      expect(findCategory('sub')).toBe('Subscriptions');
    });
  });

  describe('invalid input', () => {
    test('returns null for unknown category', () => {
      expect(findCategory('xyz123')).toBeNull();
      expect(findCategory('notacategory')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(findCategory('')).toBeNull();
    });

    test('returns null for whitespace only', () => {
      expect(findCategory('   ')).toBeNull();
    });
  });
});

describe('CATEGORIES', () => {
  test('contains expected categories', () => {
    expect(CATEGORIES).toContain('Groceries');
    expect(CATEGORIES).toContain('Eating out');
    expect(CATEGORIES).toContain('Transportation');
    expect(CATEGORIES).toContain('Other');
  });

  test('has 18 categories', () => {
    expect(CATEGORIES).toHaveLength(18);
  });
});

describe('CATEGORY_ALIASES', () => {
  test('all aliases map to valid categories', () => {
    for (const [alias, category] of Object.entries(CATEGORY_ALIASES)) {
      expect(CATEGORIES).toContain(category);
    }
  });
});
