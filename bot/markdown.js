// Telegram legacy "Markdown" parse mode treats _ * ` [ as active. When any of
// these show up in user-controlled fields (card_name, notes, etc.) rendered
// inside a Markdown message, the parser can silently mangle output or reject
// the send. Escape at the point of interpolation, not on the way into storage,
// so raw values remain grep-able and comparable.
const SPECIALS = /[_*`[]/g;

function escapeMd(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(SPECIALS, '\\$&');
}

module.exports = { escapeMd };
