// validatePrefixes guards the callback-registry contract at boot time. Every
// flow handler claims a prefix (e.g. 'receipt_', 'card_ppay_') and matches
// callbacks by startsWith; if one prefix is a proper prefix of another
// (e.g. 'card_' vs 'card_purchase_'), the shorter one silently swallows
// callbacks intended for the longer, producing UX bugs that only manifest
// under specific button taps. This function catches that at boot rather
// than at 3am when a user reports "the cancel button does nothing."
function validatePrefixes(prefixes) {
  for (const p of prefixes) {
    if (typeof p !== 'string') {
      throw new Error(`Invalid prefix: expected string, got ${p === null ? 'null' : typeof p}`);
    }
    if (p.length === 0) {
      throw new Error('Invalid prefix: empty string would match every callback');
    }
  }
  for (let i = 0; i < prefixes.length; i += 1) {
    for (let j = i + 1; j < prefixes.length; j += 1) {
      const a = prefixes[i];
      const b = prefixes[j];
      if (a === b) {
        throw new Error(`Duplicate prefix registered: "${a}"`);
      }
      if (a.startsWith(b) || b.startsWith(a)) {
        throw new Error(
          `Prefix collision: "${a}" and "${b}" — one is a proper prefix of the other. ` +
            `The shorter would silently swallow callbacks intended for the longer.`,
        );
      }
    }
  }
}

module.exports = { validatePrefixes };
