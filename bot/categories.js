const CATEGORIES = [
  'Groceries', 'Eating out', 'Coffee/snacks', 'Transportation', 'Fuel',
  'Utilities', 'Rent/dues', 'Internet/mobile load', 'Household supplies',
  'Personal care', 'Medical/Pharmacy', 'Kids/Family', 'Shopping',
  'Subscriptions', 'Gifts/Donations', 'Travel', 'Fees/Bank charges', 'Other'
];

const PAYMENT_METHODS = ['Cash', 'GCash', 'Card', 'Bank Transfer', 'Other'];

const CATEGORY_ALIASES = {
  'grocery': 'Groceries', 'supermarket': 'Groceries',
  'food': 'Eating out', 'eating': 'Eating out', 'restaurant': 'Eating out', 'dine': 'Eating out', 'dining': 'Eating out',
  'coffee': 'Coffee/snacks', 'snacks': 'Coffee/snacks', 'cafe': 'Coffee/snacks',
  'transport': 'Transportation', 'grab': 'Transportation', 'taxi': 'Transportation', 'fare': 'Transportation',
  'gas': 'Fuel', 'petrol': 'Fuel',
  'utility': 'Utilities', 'electric': 'Utilities', 'water': 'Utilities', 'meralco': 'Utilities',
  'rent': 'Rent/dues', 'dues': 'Rent/dues', 'hoa': 'Rent/dues',
  'internet': 'Internet/mobile load', 'mobile': 'Internet/mobile load', 'load': 'Internet/mobile load', 'data': 'Internet/mobile load', 'wifi': 'Internet/mobile load',
  'household': 'Household supplies', 'supplies': 'Household supplies', 'cleaning': 'Household supplies',
  'personal': 'Personal care', 'salon': 'Personal care', 'haircut': 'Personal care',
  'medical': 'Medical/Pharmacy', 'medicine': 'Medical/Pharmacy', 'pharmacy': 'Medical/Pharmacy', 'meds': 'Medical/Pharmacy', 'doctor': 'Medical/Pharmacy', 'hospital': 'Medical/Pharmacy',
  'kids': 'Kids/Family', 'family': 'Kids/Family', 'children': 'Kids/Family',
  'shopping': 'Shopping', 'shop': 'Shopping', 'clothes': 'Shopping', 'lazada': 'Shopping', 'shopee': 'Shopping',
  'subscription': 'Subscriptions', 'netflix': 'Subscriptions', 'spotify': 'Subscriptions',
  'gift': 'Gifts/Donations', 'gifts': 'Gifts/Donations', 'donation': 'Gifts/Donations',
  'travel': 'Travel', 'vacation': 'Travel', 'hotel': 'Travel', 'flight': 'Travel',
  'fees': 'Fees/Bank charges', 'bank': 'Fees/Bank charges', 'atm': 'Fees/Bank charges',
  'other': 'Other', 'misc': 'Other'
};

function findCategory(input) {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return null;
  const exact = CATEGORIES.find(c => c.toLowerCase() === normalized);
  if (exact) return exact;
  const aliasMatch = CATEGORY_ALIASES[normalized];
  if (aliasMatch) return aliasMatch;
  const partial = CATEGORIES.find(c => c.toLowerCase().includes(normalized));
  if (partial) return partial;
  return null;
}

module.exports = { CATEGORIES, PAYMENT_METHODS, CATEGORY_ALIASES, findCategory };
