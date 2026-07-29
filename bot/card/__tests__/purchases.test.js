const {
  synthesizeTxId,
  listUnpaidPurchases,
  inferCycleFromPurchases,
  hydratePurchases,
  buildPurchaseIndex,
  resolvePaymentCycle,
} = require('../purchases');

// Deterministic timestamps for stable ids.
const T1 = '2026-07-01T10:00:00.000Z'; // epoch-ms 1782000000000
const T2 = '2026-07-05T10:00:00.000Z';
const T3 = '2026-07-20T10:00:00.000Z';
const T4 = '2026-08-01T10:00:00.000Z';

describe('synthesizeTxId', () => {
  it('returns existing tx_id verbatim when present', () => {
    expect(synthesizeTxId({ tx_id: 'p_abc123', timestamp: T1 })).toBe('p_abc123');
  });

  it('synthesizes ps_-prefixed id from timestamp when tx_id absent', () => {
    const id = synthesizeTxId({ tx_id: '', timestamp: T1 });
    expect(id).toMatch(/^ps_\d+$/);
    expect(id).toBe(`ps_${Date.parse(T1)}`);
  });

  it('synthesizes ps_-prefixed id when tx_id undefined', () => {
    const id = synthesizeTxId({ timestamp: T2 });
    expect(id).toMatch(/^ps_/);
  });

  it('appends row-index suffix when rowIndex given (tiebreak on duplicate timestamps)', () => {
    const id = synthesizeTxId({ timestamp: T1 }, 3);
    expect(id).toBe(`ps_${Date.parse(T1)}_3`);
  });

  it('returns a stable but unparseable fallback when timestamp is not parseable', () => {
    const id = synthesizeTxId({ timestamp: 'not-a-date' }, 5);
    expect(id).toBe('ps_0_5');
  });
});

describe('hydratePurchases', () => {
  const txs = [
    { timestamp: T1, card_name: 'BPI', type: 'purchase', amount: 100, tx_id: 'p_a' },
    { timestamp: T2, card_name: 'BPI', type: 'purchase', amount: 200, tx_id: 'p_b' },
    { timestamp: T3, card_name: 'BPI', type: 'payment', amount: 50, tx_id: 'p_pay' }, // payment, ignored
    { timestamp: T4, card_name: 'BPI', type: 'purchase', amount: 300 }, // legacy, ps_-synthesized
  ];

  it('returns purchases in the order of provided txIds', () => {
    const out = hydratePurchases(['p_b', 'p_a'], txs);
    expect(out.map((p) => p.tx_id)).toEqual(['p_b', 'p_a']);
    expect(out.map((p) => p.amount)).toEqual([200, 100]);
  });

  it('silently skips unknown tx_ids without throwing', () => {
    const out = hydratePurchases(['p_a', 'unknown', 'p_b'], txs);
    expect(out.map((p) => p.tx_id)).toEqual(['p_a', 'p_b']);
  });

  it('returns empty array for empty input', () => {
    expect(hydratePurchases([], txs)).toEqual([]);
  });

  it('indexes payment rows out — payments are not purchases', () => {
    expect(hydratePurchases(['p_pay'], txs)).toEqual([]);
  });

  it('resolves synthesized tx_id for legacy purchase rows without tx_id column', () => {
    const legacyId = `ps_${Date.parse(T4)}`;
    const out = hydratePurchases([legacyId], txs);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(300);
  });
});

describe('listUnpaidPurchases', () => {
  const purchase = (overrides) => ({
    type: 'purchase',
    card_name: 'BPI',
    timestamp: T1,
    amount: 100,
    tx_id: '',
    ...overrides,
  });
  const payment = (overrides) => ({
    type: 'payment',
    card_name: 'BPI',
    timestamp: T1,
    amount: 100,
    paid_purchases: [],
    ...overrides,
  });

  it('matches card name case-insensitively', () => {
    const txs = [
      purchase({ tx_id: 'p_a', card_name: 'BPI' }),
      purchase({ tx_id: 'p_b', card_name: 'bpi' }),
      purchase({ tx_id: 'p_c', card_name: 'Other' }),
    ];
    const out = listUnpaidPurchases('bpi', txs);
    expect(out.map((p) => p.tx_id).sort()).toEqual(['p_a', 'p_b']);
  });

  it('excludes purchases whose tx_id appears in any payment paid_purchases', () => {
    const txs = [
      purchase({ tx_id: 'p_a', amount: 100 }),
      purchase({ tx_id: 'p_b', amount: 200 }),
      purchase({ tx_id: 'p_c', amount: 300 }),
      payment({ paid_purchases: ['p_a', 'p_c'] }),
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out.map((p) => p.tx_id)).toEqual(['p_b']);
  });

  it('T3(a): legacy cycle-only payments (empty paid_purchases) leave their purchases as unpaid', () => {
    const txs = [
      purchase({ tx_id: 'p_a', amount: 100 }),
      purchase({ tx_id: 'p_b', amount: 200 }),
      payment({ amount: 300, paid_purchases: [] }), // cycle-only payment
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out.map((p) => p.tx_id).sort()).toEqual(['p_a', 'p_b']);
  });

  it('T3(b): purchase-tagged payment correctly marks its purchases paid', () => {
    const txs = [
      purchase({ tx_id: 'p_a', amount: 100 }),
      purchase({ tx_id: 'p_b', amount: 200 }),
      payment({ amount: 300, paid_purchases: ['p_a', 'p_b'] }),
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out).toEqual([]);
  });

  it('T3(c): mixed history shows only legacy-cycle purchases as unpaid', () => {
    const txs = [
      purchase({ tx_id: 'p_a', amount: 100 }), // covered by legacy cycle payment
      purchase({ tx_id: 'p_b', amount: 200 }), // covered by legacy cycle payment
      purchase({ tx_id: 'p_c', amount: 300 }), // covered by purchase-tagged
      purchase({ tx_id: 'p_d', amount: 400 }), // unpaid
      payment({ amount: 300, paid_purchases: [] }), // legacy cycle-only
      payment({ amount: 300, paid_purchases: ['p_c'] }),
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out.map((p) => p.tx_id).sort()).toEqual(['p_a', 'p_b', 'p_d']);
  });

  it('synthesizes ps_ tx_id on returned purchases for legacy rows without tx_id', () => {
    const txs = [
      purchase({ tx_id: '', timestamp: T2 }), // legacy purchase, no tx_id
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out).toHaveLength(1);
    expect(out[0].tx_id).toBe(`ps_${Date.parse(T2)}`);
  });

  it('returns empty array when no purchases exist', () => {
    expect(listUnpaidPurchases('BPI', [])).toEqual([]);
    expect(listUnpaidPurchases('BPI', [payment({ paid_purchases: [] })])).toEqual([]);
  });

  it('ignores payments from other cards when computing paid set', () => {
    // Cross-card contamination guard: another card's payment tagging tx_id p_a
    // must not mark BPI's p_a as paid.
    const txs = [
      purchase({ tx_id: 'p_a', card_name: 'BPI' }),
      purchase({ tx_id: 'p_a', card_name: 'Other' }),
      payment({ card_name: 'Other', paid_purchases: ['p_a'] }),
    ];
    const out = listUnpaidPurchases('BPI', txs);
    expect(out.map((p) => p.tx_id)).toEqual(['p_a']);
  });
});

describe('inferCycleFromPurchases', () => {
  const purchase = (tx_date, amount = 100) => ({
    tx_date,
    amount,
    type: 'purchase',
  });

  it('single-cycle: all purchases in same cycle returns { cycle_month }', () => {
    // statement_day=25 → purchases on 2026-07-03 belong to cycle 2026-06
    // (because day 3 < statement_day 25, so previous month closed)
    // Actually let's use post-statement-day purchases so they are all in one cycle.
    const purchases = [
      purchase('2026-07-26'),
      purchase('2026-08-05'),
      purchase('2026-08-20'),
    ];
    // For statement_day=25: 07-26 >= 25 → cycle 2026-07; 08-05 < 25 → cycle 2026-07; 08-20 < 25 → cycle 2026-07
    const out = inferCycleFromPurchases(purchases, 25);
    expect(out).toEqual({ cycle_month: '2026-07' });
  });

  it('multi-cycle: purchases spanning cycles returns { multi: true, cycles }', () => {
    const purchases = [
      purchase('2026-07-10'), // statement_day=25: day 10<25 → cycle 2026-06
      purchase('2026-07-26'), // day 26>=25 → cycle 2026-07
    ];
    const out = inferCycleFromPurchases(purchases, 25);
    expect(out.multi).toBe(true);
    expect(out.cycles.sort()).toEqual(['2026-06', '2026-07']);
  });

  it('empty: no purchases returns { empty: true }', () => {
    expect(inferCycleFromPurchases([], 25)).toEqual({ empty: true });
  });

  it('statement_day boundary: tx_date on exactly the statement day belongs to current month', () => {
    const purchases = [purchase('2026-07-25')];
    const out = inferCycleFromPurchases(purchases, 25);
    expect(out).toEqual({ cycle_month: '2026-07' });
  });

  it('statement_day boundary: tx_date one day before statement_day belongs to previous month', () => {
    const purchases = [purchase('2026-07-24')];
    const out = inferCycleFromPurchases(purchases, 25);
    expect(out).toEqual({ cycle_month: '2026-06' });
  });

  it('single purchase produces single-cycle result', () => {
    const purchases = [purchase('2026-07-15')];
    const out = inferCycleFromPurchases(purchases, 10);
    expect(out).toEqual({ cycle_month: '2026-07' });
  });
});

describe('buildPurchaseIndex', () => {
  it('indexes only purchases, keyed by resolved tx_id', () => {
    const txs = [
      { timestamp: T1, card_name: 'BPI', type: 'purchase', amount: 100, tx_id: 'p_a' },
      { timestamp: T2, card_name: 'BPI', type: 'purchase', amount: 200, tx_id: 'p_b' },
      { timestamp: T3, card_name: 'BPI', type: 'payment', amount: 50, tx_id: 'p_pay' },
    ];
    const idx = buildPurchaseIndex(txs);
    expect(idx.size).toBe(2);
    expect(idx.get('p_a').amount).toBe(100);
    expect(idx.get('p_b').amount).toBe(200);
    expect(idx.has('p_pay')).toBe(false);
  });

  it('synthesizes ids for legacy purchase rows', () => {
    const txs = [{ timestamp: T4, card_name: 'BPI', type: 'purchase', amount: 300 }];
    const idx = buildPurchaseIndex(txs);
    const legacyId = `ps_${Date.parse(T4)}`;
    expect(idx.get(legacyId).amount).toBe(300);
  });

  it('first occurrence of a duplicate id wins (matches hydratePurchases)', () => {
    const txs = [
      { timestamp: T1, card_name: 'BPI', type: 'purchase', amount: 100, tx_id: 'p_a' },
      { timestamp: T2, card_name: 'BPI', type: 'purchase', amount: 999, tx_id: 'p_a' },
    ];
    const idx = buildPurchaseIndex(txs);
    expect(idx.get('p_a').amount).toBe(100);
  });
});

describe('resolvePaymentCycle', () => {
  const purchases = [
    { tx_date: '2026-07-10', card_name: 'BPI', type: 'purchase', amount: 100, tx_id: 'p_a' }, // cycle 2026-06 (day 10 < 25)
    { tx_date: '2026-07-26', card_name: 'BPI', type: 'purchase', amount: 200, tx_id: 'p_b' }, // cycle 2026-07
    { tx_date: '2026-07-28', card_name: 'BPI', type: 'purchase', amount: 300, tx_id: 'p_c' }, // cycle 2026-07
  ];
  const idx = buildPurchaseIndex(purchases);

  it('returns stored statement_cycle when non-empty (legacy cycle-only payments)', () => {
    const payment = { statement_cycle: '2026-05', paid_purchases: [] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('2026-05');
  });

  it('stored statement_cycle overrides purchase-derived cycle when both present', () => {
    const payment = { statement_cycle: '2026-03', paid_purchases: ['p_b', 'p_c'] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('2026-03');
  });

  it('derives single cycle from tagged purchases when statement_cycle empty', () => {
    const payment = { statement_cycle: '', paid_purchases: ['p_b', 'p_c'] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('2026-07');
  });

  it('returns empty for multi-cycle purchase-tagged payments', () => {
    const payment = { statement_cycle: '', paid_purchases: ['p_a', 'p_b'] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('');
  });

  it('returns empty when no cycle info at all', () => {
    const payment = { statement_cycle: '', paid_purchases: [] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('');
  });

  it('silently skips unknown tx_ids in paid_purchases', () => {
    const payment = { statement_cycle: '', paid_purchases: ['p_b', 'unknown', 'p_c'] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('2026-07');
  });

  it('all-unknown tx_ids collapse to empty (hydration returns nothing)', () => {
    const payment = { statement_cycle: '', paid_purchases: ['ghost1', 'ghost2'] };
    expect(resolvePaymentCycle(payment, 25, idx)).toBe('');
  });
});
