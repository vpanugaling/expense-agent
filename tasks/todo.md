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

- [ ] **Task 5** — `/card due`
  - Acceptance: lists each card with next due, sorted soonest-first; uses statement due when available.
  - Verify: `cd bot && npm test`; manual with mixed cards.
  - Files: `bot/card/commands.js`, `bot/card/balance.js`, `bot/card/__tests__/balance.test.js`.

- [ ] **Task 6** — `node-cron` reminder job (two-phase, explicit TZ)
  - Acceptance: fires daily 9pm PHT via explicit `{ timezone }`; two-phase (cards first, statements only if match); T-3 and T-0 messages to every `ALLOWED_USER_IDS`; skipped when `NODE_ENV=test`.
  - Verify: `cd bot && npm test` (`shouldRemind` boundaries incl. leap/DST + two-phase logic); manual `*/1 * * * *` observe; revert.
  - Files: `bot/package.json`, `bot/card/reminders.js`, `bot/card/__tests__/reminders.test.js`, `bot/index.js`.

- [ ] **Checkpoint: Complete** — all tests pass, `/card due` correct, reminder observed live, existing flows unchanged, TZ verified in prod container. Ready for review.
