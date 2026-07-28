const NICKNAME_REGEX = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_NICKNAMES = new Set(['purchase', 'payment']);
const AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;
const INTEGER_REGEX = /^\d+$/;

function validateNickname(input) {
  if (input === null || input === undefined) {
    return { valid: false, error: 'Nickname is required' };
  }
  const trimmed = String(input).trim();
  if (!NICKNAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Nickname must be 1-32 characters using letters, numbers, underscore, or hyphen only',
    };
  }
  if (RESERVED_NICKNAMES.has(trimmed.toLowerCase())) {
    return {
      valid: false,
      error: `Nickname cannot be a reserved word (${[...RESERVED_NICKNAMES].join(', ')})`,
    };
  }
  return { valid: true, value: trimmed };
}

function parsePositiveAmount(input) {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!AMOUNT_REGEX.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function validateAmount(input) {
  const value = parsePositiveAmount(input);
  if (value === null) {
    return {
      valid: false,
      error: 'Amount must be a positive number with up to 2 decimal places',
    };
  }
  return { valid: true, value };
}

function validateLimit(input) {
  const value = parsePositiveAmount(input);
  if (value === null) {
    return {
      valid: false,
      error: 'Credit limit must be a positive number with up to 2 decimal places',
    };
  }
  return { valid: true, value };
}

function validateDay(input) {
  if (input === null || input === undefined) {
    return { valid: false, error: 'Day is required' };
  }
  const trimmed = String(input).trim();
  if (!INTEGER_REGEX.test(trimmed)) {
    return { valid: false, error: 'Day must be an integer between 1 and 31' };
  }
  const n = Number(trimmed);
  if (n < 1 || n > 31) {
    return { valid: false, error: 'Day must be between 1 and 31' };
  }
  return { valid: true, value: n };
}

module.exports = {
  validateNickname,
  validateAmount,
  validateLimit,
  validateDay,
};
