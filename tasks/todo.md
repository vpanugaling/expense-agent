# Credit Card Tracking — Task List (Post-Review)

Reference: [SPEC.md](../SPEC.md), [tasks/plan.md](plan.md). All 14 review decisions folded in.

## Phase 0: Foundation & Receipt Refactor

- [x] **Task 0** — Extract shared infrastructure + retrofit receipt-flow tests (all 9 sub-tasks complete; manual Telegram verification still pending — see Checkpoint)
  - Sub-tasks:
    - [x] Extract `bot/categories.js` (3A) — commit 979673e
    - [x] Extract `bot/sheets-client.js` singleton with 5-min TTL (13A) — commit e027fb0
    - [x] Create `bot/card/validators.js` with unit tests (8A) — commit 5d6a15b
    - [x] Create `bot/confirm-flow.js` shared state machine (1A) — commit 6485f29
    - [x] Migrate receipt flow onto confirm-flow; rename callback_data → `receipt_*` (1A + 2A) — commit 13c1980
    - [x] Add prefix-based callback registry in `bot/index.js` (2A) — commit 13c1980
    - [x] Scaffold `bot/card/sheets.js` with adapter seam (9A) — commit ffb097d
    - [x] Create `bot/test-utils/mock-bot.js` and `fake-sheet.js` (9A + 10A) — commit 4783a4c
    - [x] Write ~15 confirm-flow state-machine tests (10A) — commit 6485f29 (17 tests)
    - [x] Write ~8 receipt-flow regression tests (12A) — commit 13c1980 (11 tests)
    - [x] Add `TZ=Asia/Manila` to docker-compose.yml (7A) — commit 46a3f1b
    - [x] Sync SPEC.md with decisions 4A/5A/6A/7A/8A — commit 39139b7
  - Acceptance: no user-visible behavior change; existing tests + new tests all pass; receipt flow works end-to-end in Telegram.
  - Verify: `cd bot && npm test`; manual receipt happy + each edit + cancel.
  - Files: `bot/categories.js`, `bot/sheets-client.js`, `bot/confirm-flow.js`, `bot/card/validators.js`, `bot/card/sheets.js`, `bot/test-utils/*`, tests, `bot/index.js`, `docker-compose.yml`, `SPEC.md`.

- [ ] **Checkpoint: Foundation** — tests green, receipt flow unchanged, TZ set, SPEC synced. Human review before Phase 1.

## Phase 1: Card Registration

- [x] **Task 1** — Card model + `/card add` (with uniqueness) + `/card list`
  - Acceptance: `/card add` writes to `CreditCards` after validation; duplicate nicknames rejected; `/card list` shows registered cards with balance 0 and next due; missing tab → setup message.
  - Verify: `cd bot && npm test` (new commands + sheet-adapter tests); manual in Telegram.
  - Files: `bot/card/commands.js`, `bot/card/sheets.js`, `bot/card/balance.js`, `bot/card/__tests__/*`, `bot/index.js`.
  - Status: 129/129 tests pass (19 new commands tests, 12 sheets tests, 8 balance tests). Manual Telegram verification pending.

- [x] **Task 1b** — `/card rename` with best-effort rollback
  - Acceptance: renames across 3 tabs; collision/missing/invalid rejected; simulated tab-2 failure triggers rollback; rollback-of-rollback failure surfaces both errors clearly.
  - Verify: `cd bot && npm test` (rename tests via 9A seam); manual rename.
  - Files: `bot/card/commands.js`, `bot/card/sheets.js`, `bot/card/__tests__/*`.
  - Status: 149/149 tests pass (+20 rename tests). CardTransactions/CardStatements treated as optional (may not exist yet); case-only rename of same card allowed; rollback + rollback-of-rollback paths covered.

- [ ] **Checkpoint: Registration** — tests green, duplicate rejected, rename verified, human review before Phase 2.

## Phase 2: Purchase Flow

- [x] **Task 2** — `/card tx purchase` end-to-end
  - Acceptance: purchase flow with Confirm / Edit Amount / Edit Category / Edit Date / Cancel via `confirm-flow.js`; writes `CardTransactions` (type=purchase) only on Confirm; `/card list` balance updates; amount validated.
  - Verify: `cd bot && npm test`; manual happy + edit + cancel.
  - Files: `bot/card/commands.js`, `bot/card/sheets.js`, `bot/card/balance.js`, `bot/card/__tests__/*`.
  - Status: 184/184 tests pass (+35 for Task 2: purchase-flow, sheets.addTransaction, sheets.listTransactions, balance.computeBalances, parseCardTx, handleTx, /card list balance rendering). Manual Telegram verification pending.

- [ ] **Checkpoint: Purchase** — tests green, all confirm buttons validated, running balance correct, human review before Phase 3.

## Phase 3: Statement + Payment

- [x] **Task 3** — `/card statement` closes a cycle (5A + 6A)
  - Acceptance: `cycle_month` derived from `statement_day` + today; `due_date` defaults to `due_day` in month after `cycle_month`; both overridable; duplicate cycle rejected.
  - Verify: `cd bot && npm test` (`deriveCycleMonth`, `computeDueDate` boundaries); manual mid-cycle + before-statement-day entries.
  - Files: `bot/card/commands.js`, `bot/card/sheets.js`, `bot/card/balance.js`, `bot/card/__tests__/balance.test.js`.
  - Status: 220/220 tests pass (+36 for Task 3: 10 balance boundary tests, 8 sheets tests for listStatements/findStatement/addStatement, 7 parseCardStatement tests, 10 handleStatement tests, 1 dispatch test). Manual Telegram verification pending.

- [x] **Task 4** — `/card tx payment` with cycle picker
  - Acceptance: picker lists open cycles; selection sets `statement_cycle`; Confirm writes payment row; overpayment → negative balance; no-cycles branch works; fully-paid cycles drop off picker.
  - Verify: `cd bot && npm test` (`openCycles` + picker); manual happy + overpayment + no-cycles.
  - Files: `bot/card/commands.js`, `bot/card/balance.js`, `bot/card/payment-flow.js`, `bot/card/__tests__/*`, `bot/index.js`.
  - Status: 257/257 tests pass (+37 for Task 4: 13 `computeOpenCycles` boundary tests, 13 payment-flow tests, 6 `parseCardTx` payment tests, 5 `handleTx` payment tests). Manual Telegram verification pending.

- [ ] **Checkpoint: Statement + Payment** — tests green, cycle derivation correct at boundaries, cycle picker behavior correct, human review before Phase 4.

## Phase 4: Due Visibility + Reminders

- [x] **Task 5** — `/card due`
  - Acceptance: lists each card with next due, sorted soonest-first; uses statement due when available.
  - Verify: `cd bot && npm test`; manual with mixed cards.
  - Files: `bot/card/commands.js`, `bot/card/balance.js`, `bot/card/__tests__/balance.test.js`, `bot/card/__tests__/commands.test.js`.
  - Status: 270/270 tests pass (+13 for Task 5: 6 `computeCardDue` tests, 6 `handleDue` tests, 1 dispatch route test). Manual Telegram verification pending.

- [x] **Task 6** — `node-cron` reminder job (two-phase, explicit TZ)
  - Acceptance: fires daily 9pm PHT via explicit `{ timezone }`; two-phase (cards first, statements only if match); T-3 and T-0 messages to every `ALLOWED_USER_IDS`; skipped when `NODE_ENV=test`.
  - Verify: `cd bot && npm test` (`shouldRemind` boundaries incl. leap/DST + two-phase logic); manual `*/1 * * * *` observe; revert.
  - Files: `bot/package.json`, `bot/card/reminders.js`, `bot/card/__tests__/reminders.test.js`, `bot/index.js`.
  - Status: 294/294 tests pass (+24 for Task 6: 9 `shouldRemind` boundary tests incl. leap year, month/year rollover, DST-safe UTC arithmetic; 8 `computeCardReminders` two-phase tests; 4 `createReminders.run` tests; 2 `createReminders.start` cron-schedule tests). Manual `*/1 * * * *` observation pending.

- [ ] **Checkpoint: Complete** — all tests pass, `/card due` correct, reminder observed live, existing flows unchanged, TZ verified in prod container. Ready for review.

---

# Extension: Purchase-Tagged Payments (2026-07-29)

Reference: [SPEC.md](../SPEC.md) → "Feature Extension: Purchase-Tagged Payments"; [tasks/plan.md](plan.md) → "Extension Plan".

## Phase A: Pure Foundation

- [ ] **Task E0** — `bot/card/purchases.js` (4 pure fns) + unit tests
  - Acceptance: `synthesizeTxId` (`ps_`-prefixed per CQ2), `listUnpaidPurchases`, `inferCycleFromPurchases`, `hydratePurchases` (CQ4) all pure; case-insensitive card match; multi-cycle/empty/single-cycle branches covered; statement_day boundary covered; `hydratePurchases` skips unknown ids without throwing. **T3 tests:** legacy cycle-only payment leaves purchases as unpaid; purchase-tagged marks paid; mixed history shows only legacy as unpaid; quirk documented in header comment.
  - Verify: `cd bot && npm test card/__tests__/purchases.test.js`; full suite still green.
  - Files: `bot/card/purchases.js`, `bot/card/__tests__/purchases.test.js`.
  - Deps: none.

## Phase B: Sheet Extension

- [ ] **Task E1** — `sheets.js` generates `tx_id` internally (`p_` prefix per CQ2); adds `paid_purchases`
  - Acceptance: `addTransaction` generates `tx_id` as `p_<epoch36>_<rand4hex>`, accepts optional `{ txId }` override for tests, returns `{ tx_id }`; `paid_purchases` written as CSV, read back as `string[]`; `listTransactions` synthesizes `ps_`-prefixed ids for legacy rows; purchase-tagged payments write empty `statement_cycle` (derived on read per 1A); no caller passes a caller-generated `tx_id`.
  - Verify: `cd bot && npm test card/__tests__/sheets.test.js`; full suite green.
  - Files: `bot/card/sheets.js`, `bot/card/__tests__/sheets.test.js`, `bot/index.js` (purchase/payment onConfirm sites drop the id arg; consume returned id).
  - Deps: E0.

## Phase C: Interactive Picker

- [ ] **Task E2a** — Extract `bot/two-phase-picker.js` shared abstraction (Architecture 3A)
  - Acceptance: `createTwoPhasePicker({ prefix, pickerRender, onPick, confirmFlow })` handles picker-phase state, `editMessageText` re-renders, foreign-prefix passthrough, `pick_cancel` intercept before confirmFlow onStale; `handleTextInput` delegates to confirmFlow; unit-tested with fake `pickerRender`/`onPick`. **T2 concurrency tests:** two-chat isolation; re-`start()` on same chat replaces state silently (old buttons no-op); picker state survives unrelated dispatches.
  - Verify: `cd bot && npm test __tests__/two-phase-picker.test.js`.
  - Files: `bot/two-phase-picker.js`, `bot/__tests__/two-phase-picker.test.js`, `bot/test-utils/mock-bot.js` (add `editMessageText`; `sendMessage` returns `{ message_id }`).
  - Deps: none new.

- [ ] **Task E2b** — `purchase-picker.js` on the shared abstraction (CQ1: no legacy refactor)
  - Acceptance: in-place toggle via `editMessageText`; accurate running total; multi-cycle sets `statement_cycle=''` + surfaces warning; zero-selection Done warns; foreign-prefix returns false. **T4 enforcement:** Done blocks if `sum(selected) !== amountTyped` with warning; tests cover all 3 cases (equal proceeds; over/under blocked). `payment-flow.js` NOT touched here (deleted in E3 per CQ1).
  - Verify: `cd bot && npm test card/__tests__/purchase-picker.test.js`.
  - Files: `bot/card/purchase-picker.js`, `bot/card/__tests__/purchase-picker.test.js`.
  - Deps: E0, E1, E2a.

## Phase D: Wire the Command

- [ ] **Task E3** — `handleTx` routes to picker; `index.js` wires it; **delete `payment-flow.js` (CQ1)**; SPEC corrected to `card_ppay_`; **T1 e2e integration test**
  - Acceptance: `/card tx X payment 500` triggers purchase-picker; empty-unpaid path warns; happy path writes row with generated `p_`-prefixed `tx_id`, `paid_purchases` CSV, empty `statement_cycle` on multi-cycle; `grep -r paymentFlow bot/` returns zero hits; SPEC callback naming updated (`card_ppay_` in, `card_pay_` out); SPEC states T4 sum-equals-amount constraint; e2e test file exists and passes.
  - Verify: `cd bot && npm test`; full suite green.
  - Files: `bot/card/commands.js`, `bot/card/__tests__/commands.test.js`, `bot/card/__tests__/purchase-payment-e2e.test.js` (T1), `bot/index.js`, `SPEC.md`; **DELETE** `bot/card/payment-flow.js`, **DELETE** `bot/card/__tests__/payment-flow.test.js`.
  - Deps: E2b.

- [ ] **Task E3b** — Startup-time prefix-registry validator (Architecture 2A)
  - Acceptance: `validatePrefixes(prefixes)` throws on any proper-prefix collision, names both offenders; passes with current registrations; invoked at boot before polling/webhook.
  - Verify: `cd bot && npm test __tests__/prefix-validator.test.js`.
  - Files: `bot/prefix-validator.js`, `bot/__tests__/prefix-validator.test.js`, `bot/index.js` (invoke at boot).
  - Deps: E3.

## Phase E: Regression

- [ ] **Task E4** — `balance.js` derives statement_cycle on read (1A) + CQ3 sig + CQ4 hydration + P1 index reuse; P2 reminders fix; regression tests
  - Acceptance: `resolvePaymentCycle(payment, card, purchaseIndex)` resolves stored cycle when present else `hydratePurchases` + `inferCycleFromPurchases`; `computeOpenCycles(card, statements, transactions, purchaseIndex?)` + `computeCardDue(card, statements, transactions, today, purchaseIndex?)` drop `cardName` (CQ3) and accept optional pre-built index (P1); `buildPurchaseIndex(transactions)` helper exposed; purchase-tagged single-cycle credits derived cycle like legacy; multi-cycle contributes zero to cycles but full amount to `computeBalances`; overpayment carryforward preserved; legacy payments unaffected; unknown tx_ids silently skipped. **P2:** `computeCardReminders` groups statements by card, calls `computeOpenCycles` once per card (not per statement) — overpaid cycle A no longer emits spurious reminder for open cycle B.
  - Verify: `cd bot && npm test card/__tests__/balance.test.js card/__tests__/reminders.test.js`; full suite green after call-site updates.
  - Files: `bot/card/balance.js`, `bot/card/__tests__/balance.test.js`, `bot/card/commands.js`, `bot/card/reminders.js`, `bot/card/__tests__/reminders.test.js`.
  - Deps: E1, E0.

- [ ] **Checkpoint: Extension Complete** — full suite green (~370+); manual walkthrough per plan; SPEC synced; human review before ship.
