const { validateNickname, validateLimit, validateDay, validateAmount } = require('./validators');
const { nextDueDate, computeBalances, deriveCycleMonth, computeDueDate, computeOpenCycles, computeCardDue } = require('./balance');
const { findCategory } = require('../categories');

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

// /card tx <nickname> purchase <amount> <category> [note...]
// /card tx <nickname> payment <amount> [note...]      (no category — payments
// don't get bucketed the way purchases do; the cycle they clear is picked
// interactively via inline buttons in handleTx.)
function parseCardTx(argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    return {
      valid: false,
      error: 'Usage: /card tx <nickname> purchase <amount> <category> [note]\n   or /card tx <nickname> payment <amount> [note]',
    };
  }
  const [nickname, subtypeRaw, amountRaw, ...rest] = parts;
  const subtype = subtypeRaw.toLowerCase();
  if (subtype !== 'purchase' && subtype !== 'payment') {
    return { valid: false, error: `Unknown transaction type "${subtypeRaw}". Use "purchase" or "payment".` };
  }
  const amt = validateAmount(amountRaw);
  if (!amt.valid) return { valid: false, error: amt.error };

  if (subtype === 'payment') {
    return {
      valid: true,
      values: {
        nickname,
        subtype,
        amount: amt.value,
        category: null,
        notes: rest.join(' '),
      },
    };
  }

  // Purchase requires a category as the 4th positional token.
  if (rest.length < 1) {
    return { valid: false, error: 'Usage: /card tx <nickname> purchase <amount> <category> [note]' };
  }
  const [categoryRaw, ...noteParts] = rest;
  const category = findCategory(categoryRaw);
  if (!category) {
    return { valid: false, error: `Unknown category "${categoryRaw}".` };
  }
  return {
    valid: true,
    values: {
      nickname,
      subtype,
      amount: amt.value,
      category,
      notes: noteParts.join(' '),
    },
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CYCLE_MONTH = /^\d{4}-\d{2}$/;

// /card statement <nickname> <amount> [due_date] [cycle_month]
// due_date and cycle_month are positional: to override cycle_month the user
// must also provide due_date. Both are validated by shape here; semantic
// defaults are filled in by handleStatement using card.statement_day/due_day.
function parseCardStatement(argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) {
    return { valid: false, error: 'Usage: /card statement <nickname> <amount> [due_date YYYY-MM-DD] [cycle_month YYYY-MM]' };
  }
  const [nickname, amountRaw, dueRaw, cycleRaw] = parts;
  const amt = validateAmount(amountRaw);
  if (!amt.valid) return { valid: false, error: amt.error };
  let due_date = null;
  if (dueRaw !== undefined) {
    if (!ISO_DATE.test(dueRaw)) return { valid: false, error: 'due_date must be YYYY-MM-DD' };
    due_date = dueRaw;
  }
  let cycle_month = null;
  if (cycleRaw !== undefined) {
    if (!CYCLE_MONTH.test(cycleRaw)) return { valid: false, error: 'cycle_month must be YYYY-MM' };
    cycle_month = cycleRaw;
  }
  return { valid: true, values: { nickname, statement_amount: amt.value, due_date, cycle_month } };
}

function parseCardRename(argsText) {
  const parts = String(argsText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    return { valid: false, error: 'Usage: /card rename <old-nickname> <new-nickname>' };
  }
  const [oldName, newName] = parts;
  const n = validateNickname(newName);
  if (!n.valid) return { valid: false, error: `New nickname: ${n.error}` };
  return { valid: true, values: { oldName, newName: n.value } };
}

function formatPeso(n) {
  return Number(n).toLocaleString('en-US');
}

const RENAME_TABS = ['CreditCards', 'CardTransactions', 'CardStatements'];

function missingTabMessage(tab = 'CreditCards') {
  const columns = {
    CreditCards: 'card_name, last4, credit_limit, statement_day, due_day, created_at',
    CardTransactions: 'timestamp, card_name, tx_date, type, amount, category, notes, statement_cycle',
    CardStatements: 'card_name, cycle_month, statement_amount, due_date, closed_at',
  }[tab];
  return `⚠️ ${tab} tab not found. Please create a "${tab}" tab with columns: ${columns}.`;
}

function toIsoDate(d) {
  return d.toISOString().split('T')[0];
}

function createCardCommands({ bot, cardSheets, purchaseFlow, paymentFlow, now = () => new Date() }) {
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
        return bot.sendMessage(chatId, missingTabMessage());
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

    const transactions = await cardSheets.listTransactions();
    const balances = computeBalances(transactions);
    const today = now();
    const lines = ['💳 *Your cards*', ''];
    for (const c of cards) {
      const balance = balances[c.card_name] || 0;
      lines.push(
        `*${c.card_name}* (••${c.last4})\n` +
          `  Limit: ₱${formatPeso(c.credit_limit)} • Balance: ₱${formatPeso(balance)}\n` +
          `  Next due: ${nextDueDate(c.due_day, today)}`,
      );
    }
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  async function handleDue(chatId) {
    let cards;
    try {
      cards = await cardSheets.listCards();
    } catch (err) {
      if (err.code === 'MISSING_TAB') return bot.sendMessage(chatId, missingTabMessage('CreditCards'));
      throw err;
    }
    if (cards.length === 0) {
      return bot.sendMessage(chatId, '💳 You have no cards yet. Add one with /card add.');
    }

    const [statements, transactions] = await Promise.all([
      cardSheets.listStatements(),
      cardSheets.listTransactions(),
    ]);
    const today = now();
    const rows = cards
      .map((c) => computeCardDue(c, statements, transactions, today))
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

    const lines = ['📅 *Upcoming due dates*', ''];
    for (const r of rows) {
      const tail =
        r.source === 'statement'
          ? `₱${formatPeso(r.outstanding)} due (cycle ${r.cycle_month})`
          : '_projected — no open statement_';
      lines.push(`*${r.card_name}* — ${r.due_date}\n  ${tail}`);
    }
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  async function handleStatement(chatId, argsText) {
    const parsed = parseCardStatement(argsText);
    if (!parsed.valid) return bot.sendMessage(chatId, `⚠️ ${parsed.error}`);
    const { nickname, statement_amount, due_date: explicitDue, cycle_month: explicitCycle } = parsed.values;

    let card;
    try {
      card = await cardSheets.findCard(nickname);
    } catch (err) {
      if (err.code === 'MISSING_TAB') return bot.sendMessage(chatId, missingTabMessage('CreditCards'));
      throw err;
    }
    if (!card) return bot.sendMessage(chatId, `⚠️ Card "${nickname}" not found.`);

    const today = now();
    const cycle_month = explicitCycle || deriveCycleMonth(card.statement_day, today);
    const due_date = explicitDue || computeDueDate(card.due_day, cycle_month);

    // Duplicate check via findStatement (returns null if the tab is missing,
    // which is fine — addStatement will surface MISSING_TAB below).
    const existing = await cardSheets.findStatement(card.card_name, cycle_month);
    if (existing) {
      return bot.sendMessage(
        chatId,
        `⚠️ Statement for ${card.card_name} cycle ${cycle_month} already exists (₱${Number(existing.statement_amount).toLocaleString()}).`,
      );
    }

    try {
      await cardSheets.addStatement({
        card_name: card.card_name,
        cycle_month,
        statement_amount,
        due_date,
        closed_at: today.toISOString(),
      });
    } catch (err) {
      if (err.code === 'MISSING_TAB') return bot.sendMessage(chatId, missingTabMessage('CardStatements'));
      throw err;
    }

    return bot.sendMessage(
      chatId,
      `✅ Statement closed for *${card.card_name}*\n` +
        `Cycle: ${cycle_month} • Amount: ₱${Number(statement_amount).toLocaleString()}\n` +
        `Due: ${due_date}`,
      { parse_mode: 'Markdown' },
    );
  }

  async function handleTx(chatId, argsText) {
    const parsed = parseCardTx(argsText);
    if (!parsed.valid) return bot.sendMessage(chatId, `⚠️ ${parsed.error}`);
    const { nickname, subtype, amount, category, notes } = parsed.values;

    let card;
    try {
      card = await cardSheets.findCard(nickname);
    } catch (err) {
      if (err.code === 'MISSING_TAB') return bot.sendMessage(chatId, missingTabMessage());
      throw err;
    }
    if (!card) return bot.sendMessage(chatId, `⚠️ Card "${nickname}" not found.`);

    const tx_date = toIsoDate(now());

    if (subtype === 'payment') {
      // Compute open cycles inline so paymentFlow stays pure (no sheet coupling).
      // Missing CardStatements/CardTransactions tabs → [] → paymentFlow shows the
      // "no open cycles" message.
      const [statements, transactions] = await Promise.all([
        cardSheets.listStatements(),
        cardSheets.listTransactions(),
      ]);
      const cycles = computeOpenCycles(card.card_name, statements, transactions);
      await paymentFlow.start(chatId, {
        card_name: card.card_name,
        cycles,
        amount,
        tx_date,
      });
      return;
    }

    await purchaseFlow.start(chatId, {
      card_name: card.card_name,
      tx_date,
      amount,
      category,
      notes,
    });
  }

  async function handleRename(chatId, argsText) {
    const parsed = parseCardRename(argsText);
    if (!parsed.valid) {
      return bot.sendMessage(chatId, `⚠️ ${parsed.error}`);
    }
    const { oldName, newName } = parsed.values;

    // Load the old card first — this both validates existence and gives us
    // the canonically-stored card_name to use in success/error messages.
    let oldCard;
    try {
      oldCard = await cardSheets.findCard(oldName);
    } catch (err) {
      if (err.code === 'MISSING_TAB') return bot.sendMessage(chatId, missingTabMessage());
      throw err;
    }
    if (!oldCard) {
      return bot.sendMessage(chatId, `⚠️ Card "${oldName}" not found.`);
    }

    // Collision check: reject only if the new name is taken by a DIFFERENT card.
    // Case-only rename of the same card is allowed.
    const collision = await cardSheets.findCard(newName);
    if (collision && collision.card_name.toLowerCase() !== oldCard.card_name.toLowerCase()) {
      return bot.sendMessage(
        chatId,
        `⚠️ Card "${collision.card_name}" already exists. Choose a different nickname.`,
      );
    }

    // Forward pass. First tab (CreditCards) is required; the others are
    // optional because they may not exist yet in a fresh setup.
    const canonicalOld = oldCard.card_name;
    const written = [];
    try {
      for (const tab of RENAME_TABS) {
        const optional = tab !== 'CreditCards';
        const { changed } = await cardSheets.renameCardInTab(tab, canonicalOld, newName, { optional });
        if (changed > 0) written.push(tab);
      }
    } catch (forwardErr) {
      // Rollback: reverse order, only tabs actually written.
      const rolledBack = [];
      const rollbackFailed = [];
      for (const tab of [...written].reverse()) {
        try {
          await cardSheets.renameCardInTab(tab, newName, canonicalOld, { optional: true });
          rolledBack.push(tab);
        } catch (rbErr) {
          rollbackFailed.push({ tab, error: rbErr.message });
        }
      }
      // Also include the tab we were attempting when forward failed (nothing
      // was written to it, so no rollback needed there — it's the failure point).
      const failedTab = RENAME_TABS.find((t) => !written.includes(t)) || 'unknown';

      if (rollbackFailed.length === 0) {
        return bot.sendMessage(
          chatId,
          `❌ Rename failed on ${failedTab} (${forwardErr.message}).\n` +
            `Rolled back cleanly: ${rolledBack.join(', ') || 'none'}.\n` +
            `Sheet is in original state.`,
        );
      }
      const rbList = rollbackFailed.map((r) => `${r.tab} (${r.error})`).join(', ');
      return bot.sendMessage(
        chatId,
        `🚨 Rename failed on ${failedTab} (${forwardErr.message}) AND rollback failed.\n` +
          `Rolled back cleanly: ${rolledBack.join(', ') || 'none'}.\n` +
          `Rollback failed: ${rbList}.\n` +
          `Please manually reconcile the affected tabs.`,
      );
    }

    return bot.sendMessage(
      chatId,
      `✅ Renamed *${canonicalOld}* → *${newName}* (updated: ${written.join(', ')})`,
      { parse_mode: 'Markdown' },
    );
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
          '/card list — show all registered cards\n' +
          '/card due — show upcoming due dates\n' +
          '/card rename <old-nickname> <new-nickname>\n' +
          '/card tx <nickname> purchase <amount> <category> [note]\n' +
          '/card tx <nickname> payment <amount> [note]\n' +
          '/card statement <nickname> <amount> [due_date] [cycle_month]',
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
    if (sub === 'rename') {
      await handleRename(chatId, subArgs);
      return true;
    }
    if (sub === 'tx') {
      await handleTx(chatId, subArgs);
      return true;
    }
    if (sub === 'statement') {
      await handleStatement(chatId, subArgs);
      return true;
    }
    if (sub === 'due') {
      await handleDue(chatId);
      return true;
    }

    await bot.sendMessage(
      chatId,
      `⚠️ Unknown subcommand "${sub}". Available: /card add, /card list, /card due, /card rename, /card tx, /card statement`,
    );
    return true;
  }

  return { handleAdd, handleList, handleRename, handleTx, handleStatement, handleDue, dispatch };
}

module.exports = { parseCardAdd, parseCardRename, parseCardTx, parseCardStatement, createCardCommands };
