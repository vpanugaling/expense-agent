const { validateNickname, validateLimit, validateDay } = require('./validators');
const { nextDueDate } = require('./balance');

const LAST4_REGEX = /^\d{4}$/;

function parseCardAdd(argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    return { valid: false, error: 'Usage: /card add <nickname> <last4> <credit_limit> <statement_day> <due_day>' };
  }
  const [nickname, last4, limit, stmtDay, dueDay] = parts;

  const n = validateNickname(nickname);
  if (!n.valid) return { valid: false, error: n.error };

  if (!LAST4_REGEX.test(last4)) {
    return { valid: false, error: 'last4 must be exactly 4 digits' };
  }

  const l = validateLimit(limit);
  if (!l.valid) return { valid: false, error: l.error };

  const s = validateDay(stmtDay);
  if (!s.valid) return { valid: false, error: `statement_day: ${s.error}` };

  const d = validateDay(dueDay);
  if (!d.valid) return { valid: false, error: `due_day: ${d.error}` };

  return {
    valid: true,
    values: {
      card_name: n.value,
      last4,
      credit_limit: l.value,
      statement_day: s.value,
      due_day: d.value,
    },
  };
}

function formatPeso(n) {
  return Number(n).toLocaleString('en-US');
}

function createCardCommands({ bot, cardSheets, now = () => new Date() }) {
  async function handleAdd(chatId, argsText) {
    const parsed = parseCardAdd(argsText);
    if (!parsed.valid) {
      return bot.sendMessage(chatId, `⚠️ ${parsed.error}`);
    }
    const { card_name, last4, credit_limit, statement_day, due_day } = parsed.values;

    try {
      const existing = await cardSheets.findCard(card_name);
      if (existing) {
        return bot.sendMessage(
          chatId,
          `⚠️ Card "${existing.card_name}" already exists. Use /card rename to change its nickname.`,
        );
      }

      await cardSheets.addCard({
        card_name,
        last4,
        credit_limit,
        statement_day,
        due_day,
        created_at: now().toISOString(),
      });

      return bot.sendMessage(
        chatId,
        `✅ Registered *${card_name}* (••${last4})\n` +
          `Limit: ₱${formatPeso(credit_limit)}\n` +
          `Statement: day ${statement_day} • Due: day ${due_day}`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      if (err.code === 'MISSING_TAB') {
        return bot.sendMessage(
          chatId,
          '⚠️ CreditCards tab not found. Please create a "CreditCards" tab with columns: card_name, last4, credit_limit, statement_day, due_day, created_at.',
        );
      }
      throw err;
    }
  }

  async function handleList(chatId) {
    let cards;
    try {
      cards = await cardSheets.listCards();
    } catch (err) {
      if (err.code === 'MISSING_TAB') {
        return bot.sendMessage(
          chatId,
          '⚠️ CreditCards tab not found. Please create a "CreditCards" tab with columns: card_name, last4, credit_limit, statement_day, due_day, created_at.',
        );
      }
      throw err;
    }

    if (cards.length === 0) {
      return bot.sendMessage(chatId, '💳 You have no cards yet. Add one with /card add <nickname> <last4> <credit_limit> <statement_day> <due_day>');
    }

    const today = now();
    const lines = ['💳 *Your cards*', ''];
    for (const c of cards) {
      lines.push(
        `*${c.card_name}* (••${c.last4})\n` +
          `  Limit: ₱${formatPeso(c.credit_limit)} • Balance: ₱0\n` +
          `  Next due: ${nextDueDate(c.due_day, today)}`,
      );
    }
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  async function dispatch(chatId, text) {
    const trimmed = String(text || '').trim();
    if (!/^\/card(\s|$)/.test(trimmed)) return false;

    const rest = trimmed.slice('/card'.length).trim();
    if (rest === '') {
      await bot.sendMessage(
        chatId,
        '💳 *Card commands*\n\n' +
          'Usage:\n' +
          '/card add <nickname> <last4> <credit_limit> <statement_day> <due_day>\n' +
          '/card list — show all registered cards',
        { parse_mode: 'Markdown' },
      );
      return true;
    }

    const spaceIdx = rest.indexOf(' ');
    const sub = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
    const subArgs = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

    if (sub === 'add') {
      await handleAdd(chatId, subArgs);
      return true;
    }
    if (sub === 'list') {
      await handleList(chatId);
      return true;
    }

    await bot.sendMessage(
      chatId,
      `⚠️ Unknown subcommand "${sub}". Available: /card add, /card list`,
    );
    return true;
  }

  return { handleAdd, handleList, dispatch };
}

module.exports = { parseCardAdd, createCardCommands };
