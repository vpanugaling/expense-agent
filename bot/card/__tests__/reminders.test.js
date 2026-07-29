const {
  shouldRemind,
  computeCardReminders,
  formatReminder,
  createReminders,
} = require('../reminders');
const { createMockBot } = require('../../test-utils/mock-bot');

function utc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('shouldRemind', () => {
  test('returns "T-0" when due is today', () => {
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-15')).toBe('T-0');
  });

  test('returns "T-3" when due is exactly 3 days away', () => {
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-18')).toBe('T-3');
  });

  test('returns null for 1, 2, or 4 days out', () => {
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-16')).toBeNull();
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-17')).toBeNull();
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-19')).toBeNull();
  });

  test('returns null for past dates', () => {
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-14')).toBeNull();
    expect(shouldRemind(utc(2026, 3, 15), '2026-03-12')).toBeNull();
  });

  test('crosses month boundary: T-3 from Mar 30 → Apr 2', () => {
    expect(shouldRemind(utc(2026, 3, 30), '2026-04-02')).toBe('T-3');
  });

  test('crosses year boundary: T-3 from Dec 30 → Jan 2', () => {
    expect(shouldRemind(utc(2026, 12, 30), '2027-01-02')).toBe('T-3');
  });

  test('leap-year: T-3 from Feb 26 → Feb 29 (2028 leap)', () => {
    expect(shouldRemind(utc(2028, 2, 26), '2028-02-29')).toBe('T-3');
  });

  test('non-leap: T-3 from Feb 25 → Feb 28 (2027 non-leap)', () => {
    expect(shouldRemind(utc(2027, 2, 25), '2027-02-28')).toBe('T-3');
  });

  test('DST changes have no effect (uses UTC calendar arithmetic)', () => {
    // Asia/Manila has no DST, but even if the system's local TZ shifts,
    // computing on UTC calendar dates keeps T-3 stable.
    expect(shouldRemind(utc(2026, 3, 8), '2026-03-11')).toBe('T-3');
    expect(shouldRemind(utc(2026, 11, 1), '2026-11-04')).toBe('T-3');
  });
});

describe('computeCardReminders (two-phase)', () => {
  const cardA = { card_name: 'BPI-Gold', due_day: 15, statement_day: 25 };
  const cardB = { card_name: 'Metrobank', due_day: 5, statement_day: 10 };

  test('empty inputs → no reminders', () => {
    expect(computeCardReminders([], [], [], utc(2026, 3, 15))).toEqual([]);
  });

  test('Phase 1: projected card-level reminder when card due_day == today', () => {
    const out = computeCardReminders([cardA], [], [], utc(2026, 3, 15));
    expect(out).toEqual([
      { type: 'card', card_name: 'BPI-Gold', due_date: '2026-03-15', when: 'T-0' },
    ]);
  });

  test('Phase 1: projected card-level reminder for T-3', () => {
    const out = computeCardReminders([cardA], [], [], utc(2026, 3, 12));
    expect(out).toEqual([
      { type: 'card', card_name: 'BPI-Gold', due_date: '2026-03-15', when: 'T-3' },
    ]);
  });

  test('Phase 1: no reminder when nothing matches', () => {
    expect(computeCardReminders([cardA], [], [], utc(2026, 3, 10))).toEqual([]);
  });

  test('Phase 2: statement-level reminder for open statement with matching due_date', () => {
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-15' },
    ];
    // today == 03-15 also matches Phase 1 for cardA (due_day=15); we get both.
    const out = computeCardReminders([cardA], statements, [], utc(2026, 3, 15));
    const statementMsg = out.find((r) => r.type === 'statement');
    expect(statementMsg).toMatchObject({
      type: 'statement',
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      due_date: '2026-03-15',
      outstanding: 1000,
      when: 'T-0',
    });
  });

  test('Phase 2: fully-paid statements are skipped', () => {
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-15' },
    ];
    const transactions = [
      { card_name: 'BPI-Gold', type: 'payment', amount: 1000, statement_cycle: '2026-02' },
    ];
    const out = computeCardReminders([cardA], statements, transactions, utc(2026, 3, 15));
    expect(out.filter((r) => r.type === 'statement')).toEqual([]);
  });

  test('Phase 2: partial-paid statements yield reminder with remaining outstanding', () => {
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-15' },
    ];
    const transactions = [
      { card_name: 'BPI-Gold', type: 'payment', amount: 300, statement_cycle: '2026-02' },
    ];
    const out = computeCardReminders([cardA], statements, transactions, utc(2026, 3, 15));
    const s = out.find((r) => r.type === 'statement');
    expect(s.outstanding).toBe(700);
  });

  test('Phase 2: skips statements whose due_date does not match T-0/T-3', () => {
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-20' },
    ];
    const out = computeCardReminders([cardA], statements, [], utc(2026, 3, 15));
    expect(out.filter((r) => r.type === 'statement')).toEqual([]);
  });

  test('multi-card: each card evaluated independently in Phase 1', () => {
    // today = 03-05 → cardB due_day=5 matches T-0; cardA due_day=15 → 10 days out, no match
    const out = computeCardReminders([cardA, cardB], [], [], utc(2026, 3, 5));
    expect(out).toEqual([
      { type: 'card', card_name: 'Metrobank', due_date: '2026-03-05', when: 'T-0' },
    ]);
  });

  test('P2: overpayment on cycle A carries forward and suppresses reminder for cycle B', () => {
    // Cycle 2026-02: $1000 statement, $1500 paid → $500 credit carries forward.
    // Cycle 2026-03: $400 statement, no direct payment → the $500 credit
    // covers it entirely. Previously (per-statement computeOpenCycles) cycle B
    // would still emit a reminder because carryforward only worked when both
    // statements were passed together.
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-10' },
      { card_name: 'BPI-Gold', cycle_month: '2026-03', statement_amount: 400, due_date: '2026-03-15' },
    ];
    const transactions = [
      { card_name: 'BPI-Gold', type: 'payment', amount: 1500, statement_cycle: '2026-02' },
    ];
    const out = computeCardReminders([cardA], statements, transactions, utc(2026, 3, 15));
    expect(out.filter((r) => r.type === 'statement')).toEqual([]);
  });

  test('orphan statement (no matching card) is silently skipped', () => {
    const statements = [
      { card_name: 'Ghost', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-15' },
    ];
    const out = computeCardReminders([cardA], statements, [], utc(2026, 3, 15));
    expect(out.filter((r) => r.type === 'statement')).toEqual([]);
  });

  test('purchase-tagged payment settles cycle → no statement reminder emitted', () => {
    const statements = [
      { card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 200, due_date: '2026-03-15' },
    ];
    const transactions = [
      // Purchase in cycle 2026-02 (day 26 >= statement_day 25 wait cardA statement_day=25, so 2026-02-26 → cycle 2026-02).
      { card_name: 'BPI-Gold', type: 'purchase', tx_date: '2026-02-26', amount: 200, tx_id: 'p_x' },
      // Purchase-tagged payment with empty statement_cycle, tagging p_x.
      { card_name: 'BPI-Gold', type: 'payment', amount: 200, statement_cycle: '', paid_purchases: ['p_x'] },
    ];
    const out = computeCardReminders([cardA], statements, transactions, utc(2026, 3, 15));
    expect(out.filter((r) => r.type === 'statement')).toEqual([]);
  });
});

describe('formatReminder', () => {
  test('card T-0 renders "due today" with card name and date', () => {
    const s = formatReminder({ type: 'card', card_name: 'BPI-Gold', due_date: '2026-03-15', when: 'T-0' });
    expect(s).toContain('BPI-Gold');
    expect(s).toContain('due today');
    expect(s).toContain('2026-03-15');
  });

  test('card T-3 renders "due in 3 days"', () => {
    const s = formatReminder({ type: 'card', card_name: 'BPI-Gold', due_date: '2026-03-18', when: 'T-3' });
    expect(s).toContain('due in 3 days');
  });

  test('statement T-0 renders cycle, outstanding (localized), and date', () => {
    const s = formatReminder({
      type: 'statement',
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      due_date: '2026-03-15',
      outstanding: 1234.5,
      when: 'T-0',
    });
    expect(s).toContain('BPI-Gold');
    expect(s).toContain('2026-02');
    expect(s).toContain('due today');
    expect(s).toContain('1,234.5');
    expect(s).toContain('2026-03-15');
  });

  test('statement T-3 renders "due in 3 days"', () => {
    const s = formatReminder({
      type: 'statement',
      card_name: 'BPI-Gold',
      cycle_month: '2026-02',
      due_date: '2026-03-18',
      outstanding: 700,
      when: 'T-3',
    });
    expect(s).toContain('due in 3 days');
    expect(s).toContain('700');
  });
});

describe('createReminders.run', () => {
  function makeSheets(overrides = {}) {
    return {
      listCards: jest.fn(async () => overrides.cards || []),
      listStatements: jest.fn(async () => overrides.statements || []),
      listTransactions: jest.fn(async () => overrides.transactions || []),
    };
  }

  test('sends one message per reminder per allowed user', async () => {
    const bot = createMockBot();
    const cardSheets = makeSheets({
      cards: [{ card_name: 'BPI-Gold', due_day: 15, statement_day: 25 }],
    });
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111', '222'],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 15),
    });
    await reminders.run();
    const sent = bot.sentMessages();
    expect(sent).toHaveLength(2); // 1 reminder × 2 users
    expect(sent.map((s) => s.chatId).sort()).toEqual(['111', '222']);
    for (const msg of sent) {
      expect(msg.text).toContain('BPI-Gold');
      expect(msg.text).toContain('2026-03-15');
    }
  });

  test('sends nothing when no reminders match today', async () => {
    const bot = createMockBot();
    const cardSheets = makeSheets({
      cards: [{ card_name: 'BPI-Gold', due_day: 15, statement_day: 25 }],
    });
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111'],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 10),
    });
    await reminders.run();
    expect(bot.sentMessages()).toEqual([]);
  });

  test('sends statement reminder with outstanding + cycle', async () => {
    const bot = createMockBot();
    const cardSheets = makeSheets({
      cards: [{ card_name: 'BPI-Gold', due_day: 15, statement_day: 25 }],
      statements: [{ card_name: 'BPI-Gold', cycle_month: '2026-02', statement_amount: 1000, due_date: '2026-03-15' }],
    });
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111'],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 15),
    });
    await reminders.run();
    const statementMsg = bot.sentMessages().find((s) => /cycle.*2026-02/i.test(s.text));
    expect(statementMsg).toBeDefined();
    expect(statementMsg.text).toContain('1,000');
  });

  test('empty allowedUserIds → no messages sent, no crash', async () => {
    const bot = createMockBot();
    const cardSheets = makeSheets({
      cards: [{ card_name: 'BPI-Gold', due_day: 15, statement_day: 25 }],
    });
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: [],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 15),
    });
    await reminders.run();
    expect(bot.sentMessages()).toEqual([]);
  });

  test('one user send failure does not block delivery to other users', async () => {
    const bot = createMockBot();
    // Replace sendMessage: throw for '111', succeed for '222'.
    const delivered = [];
    bot.sendMessage = jest.fn(async (uid, text, options) => {
      if (uid === '111') throw new Error('user blocked');
      delivered.push({ uid, text, options });
    });
    const cardSheets = makeSheets({
      cards: [{ card_name: 'BPI-Gold', due_day: 15, statement_day: 25 }],
    });
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111', '222'],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 15),
    });
    await reminders.run();
    // Both users were attempted (per-user try/catch continued the loop)
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    // Successful delivery reached '222' despite '111' throwing
    expect(delivered).toHaveLength(1);
    expect(delivered[0].uid).toBe('222');
  });

  test('missing CreditCards tab does not crash (treated as no cards)', async () => {
    const bot = createMockBot();
    const cardSheets = {
      listCards: jest.fn(async () => { const e = new Error('miss'); e.code = 'MISSING_TAB'; throw e; }),
      listStatements: jest.fn(async () => []),
      listTransactions: jest.fn(async () => []),
    };
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111'],
      cron: { schedule: jest.fn() },
      now: () => utc(2026, 3, 15),
    });
    await reminders.run();
    expect(bot.sentMessages()).toEqual([]);
  });
});

describe('createReminders.start', () => {
  test('registers cron at 21:00 with Asia/Manila timezone', () => {
    const bot = createMockBot();
    const cardSheets = {
      listCards: jest.fn(async () => []),
      listStatements: jest.fn(async () => []),
      listTransactions: jest.fn(async () => []),
    };
    const schedule = jest.fn(() => ({ stop: jest.fn() }));
    const reminders = createReminders({
      bot,
      cardSheets,
      allowedUserIds: ['111'],
      cron: { schedule },
    });
    const task = reminders.start();
    expect(schedule).toHaveBeenCalledTimes(1);
    const [spec, , opts] = schedule.mock.calls[0];
    expect(spec).toBe('0 21 * * *');
    expect(opts).toEqual({ timezone: 'Asia/Manila' });
    expect(task).toBeTruthy();
  });

  test('returns null and does not register when disabled', () => {
    const schedule = jest.fn();
    const reminders = createReminders({
      bot: createMockBot(),
      cardSheets: {
        listCards: jest.fn(),
        listStatements: jest.fn(),
        listTransactions: jest.fn(),
      },
      allowedUserIds: ['111'],
      cron: { schedule },
      disabled: true,
    });
    const task = reminders.start();
    expect(schedule).not.toHaveBeenCalled();
    expect(task).toBeNull();
  });
});
