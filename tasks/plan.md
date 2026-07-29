# Implementation Plan: Credit Card Tracking (Post-Review)

## Overview

Extend the existing Telegram expense bot ([bot/index.js](bot/index.js)) with manual credit-card tracking per [SPEC.md](SPEC.md). Work is sliced vertically so each phase leaves the bot in a working, deployable state.

**This plan incorporates 14 decisions from the plan-mode code review.** The most consequential change: a new **Phase 0 (Foundation)** that extracts shared infrastructure (categories module, sheets-client singleton, validators, confirm-flow module) and retrofits the existing receipt flow onto that infrastructure — before any card feature work. This resolves DRY violations, callback-dispatch coupling, and the total absence of automated coverage for existing behavior in one shot.

**Spec follow-up (not in scope of this plan):** [SPEC.md](SPEC.md) needs to be synced with decisions 4A (`/card rename` command + uniqueness), 5A (`cycle_month` derivation), 6A (default `due_date`), 7A (TZ requirement), and 8A (nickname regex). Recommend updating SPEC.md as the last step of Task 0.

## Architecture Decisions (from review)

| # | Decision | Rationale |
|---|---|---|
| 1A | Extract shared `bot/confirm-flow.js` used by receipt + card | Avoids duplicating the confirm state machine (DRY) |
| 2A | Prefix-based callback registry; migrate existing to `receipt_*` | Explicit dispatch, scales to future modules |
| 3A | Extract shared `bot/categories.js` | Eliminates circular-import risk between index.js and card/ |
| 4A | Uniqueness check + `/card rename` command | Nickname stays the join key; escape hatch for typos |
| 5A | Derive `cycle_month` from `statement_day` + today | Fixes plan/spec contradiction; correct for late entries |
| 6A | Default `due_date` = `due_day` in month AFTER `cycle_month` | Matches CC billing convention; composes with 5A |
| 7A | `TZ` env in docker-compose + explicit timezone to `node-cron` | Reminders fire at the right wall-clock time (Docker defaults to UTC) |
| 8A | Central `bot/card/validators.js` | Single source of validation truth (DRY, edge cases) |
| 9A | `SheetAdapter` seam + in-memory fake for tests | Sheets I/O becomes testable without mocking the library |
| 10A | Full state-machine tests for confirm-flow with mock bot | Shared module warrants direct coverage |
| 11A | Full `/card rename` tests via 9A seam | Rename is the highest-blast-radius operation |
| 11bA | Best-effort rollback on partial rename failure | Safer than leaving partial state |
| 12A | Retrofit receipt-flow tests using 9A/10A | Guardrail for the 1A/2A migration + future edits |
| 13A | `bot/sheets-client.js` singleton with 5-min TTL | Cuts ~150-300ms per command; less quota burn |
| 14A | Two-phase reminder cron with early exit | Skip expensive reads on the ~27/30 days no reminder fires |

## Revised Dependency Graph

```
                            bot/categories.js  (3A)
                                   │
                                   ▼
bot/sheets-client.js  (13A)        │        bot/card/validators.js  (8A)
        │                          │                   │
        ▼                          ▼                   ▼
   bot/card/sheets.js  (9A adapter seam)      bot/card/commands.js
        │                          │                   │
        ▼                          ▼                   ▼
   bot/card/balance.js  ◄──► bot/confirm-flow.js  (1A)
        │                          │
        │                          ▼
        │              bot/index.js dispatcher  (2A prefix registry)
        │                          │
        ▼                          ▼
   bot/card/reminders.js  (14A two-phase, 7A explicit TZ)
```

Bottom-up build order: shared foundation (categories, sheets-client, validators, confirm-flow) → sheets adapter → balance math + commands → reminders.

## Task List

### Phase 0: Foundation & Receipt Refactor

- [ ] Task 0: Extract shared infrastructure + retrofit receipt-flow tests

### Checkpoint: Foundation
- [ ] `cd bot && npm test` passes (existing tests + new receipt-flow tests + new confirm-flow tests)
- [ ] Manual: send a receipt photo; full confirm/edit/cancel flow still works end-to-end
- [ ] `TZ=Asia/Manila` present in docker-compose
- [ ] No behavior change for the user; internal refactor only
- [ ] SPEC.md updated to reflect decisions 4A/5A/6A/7A/8A
- [ ] Human review before Phase 1

### Phase 1: Card Registration

- [ ] Task 1: Card model + `/card add` (with uniqueness) + `/card list`
- [ ] Task 1b: `/card rename` with rollback

### Checkpoint: Registration
- [ ] `cd bot && npm test` passes
- [ ] Manual: register a card, see it in `/card list` with balance 0
- [ ] Manual: attempt duplicate add → rejected with clear message
- [ ] Manual: rename a card → all three tabs updated; simulated partial failure rolls back cleanly (verify via sheet adapter test)
- [ ] Human review before Phase 2

### Phase 2: Purchase Flow

- [ ] Task 2: `/card tx purchase` end-to-end

### Checkpoint: Purchase
- [ ] `cd bot && npm test` passes
- [ ] Manual: log a purchase; verify Confirm / Edit Amount / Edit Category / Edit Date / Cancel all work
- [ ] `CardTransactions` row appears only on Confirm
- [ ] `/card list` running balance updates
- [ ] Human review before Phase 3

### Phase 3: Statement + Payment

- [ ] Task 3: `/card statement` — close a cycle
- [ ] Task 4: `/card tx payment` with cycle picker

### Checkpoint: Statement + Payment
- [ ] `cd bot && npm test` passes
- [ ] Manual: close a statement mid-cycle (after statement_day) and before statement_day; verify `cycle_month` derives correctly for both
- [ ] Manual: log a payment; cycle picker lists open cycles
- [ ] Overpayment → negative balance without error
- [ ] Once a cycle is fully paid it disappears from the next payment's picker
- [ ] Human review before Phase 4

### Phase 4: Due Visibility + Reminders

- [ ] Task 5: `/card due` command
- [ ] Task 6: `node-cron` reminder job (two-phase, explicit TZ)

### Checkpoint: Complete
- [ ] `cd bot && npm test` passes
- [ ] Manual: `/card due` sorts soonest-first, uses statement due when available
- [ ] Manual: temporarily set cron to `*/1 * * * *`; verify T-3/T-0 messages arrive to every `ALLOWED_USER_IDS`
- [ ] Existing receipt / `/add` / `/budget` / `/summary` flows unchanged
- [ ] Ready for review

## Detailed Tasks

### Task 0: Extract shared infrastructure + retrofit receipt-flow tests

**Description:** Foundational refactor. Extract five shared modules and migrate the existing receipt flow onto them. No user-visible behavior change. Establishes the seam and test infrastructure that every subsequent task depends on.

**Sub-steps:**
1. **`bot/categories.js`** — move `CATEGORIES`, `CATEGORY_ALIASES`, `findCategory` out of `bot/index.js`. Update `bot/index.test.js` to import from new location.
2. **`bot/sheets-client.js`** — lazy singleton exposing `getDoc()` with a 5-min TTL. Refresh on TTL expiry or 4xx error. `bot/index.js` migrates to use it.
3. **`bot/card/validators.js`** — new module with pure functions: `validateNickname(s)` (regex `/^[A-Za-z0-9_-]{1,32}$/`, reject `purchase`/`payment`), `validateAmount(x)` (positive, ≤ 2 decimals), `validateDay(n)` (1–31), `validateLimit(x)` (positive). Full unit tests.
4. **`bot/confirm-flow.js`** — extract shared state machine. Signature: `createConfirmFlow({ prefix, editors, onConfirm })` → `{ start, handleCallback, handleTextInput }`. Editors is a map like `{ amount: parseAmount, date: parseDate, category: findCategoryFn }`. Both `handleCallback` and `handleTextInput` return `true` if handled, `false` otherwise (for delegation-safe fall-through — see step 6).
5. **Migrate receipt flow** in `bot/index.js` onto `confirm-flow.js`. Rename existing `callback_data` values: `confirm` → `receipt_confirm`, `edit_total` → `receipt_edit_total`, etc.
6. **Prefix-based callback registry** in `bot/index.js`: `handleCallback` looks up handler by `callback_data` prefix (`receipt_`, `card_`). Same pattern for text-input dispatch.
7. **Sheet-adapter seam:** `bot/card/sheets.js` (created empty) will accept an injected sheet-like dep rather than instantiating `GoogleSpreadsheet` itself. Wire this up during Task 1.
8. **Test infrastructure:** `bot/test-utils/mock-bot.js` (mock `sendMessage` / `answerCallbackQuery`), `bot/test-utils/fake-sheet.js` (in-memory sheet with `sheetsByTitle`, `getRows`, `addRow`).
9. **Retrofit receipt-flow tests** (~8): happy-path confirm writes correct `Expenses` row; each Edit path updates + re-renders; Cancel discards; stale callback with no pending entry produces friendly message; auth guard still fires.
10. **Confirm-flow state-machine tests** (~15): direct tests of `bot/confirm-flow.js` covering start → callback → text-input sequences, stale-button, mid-edit cancel, edit-by-number vs edit-by-name.
11. **Timezone plumbing:** add `TZ=Asia/Manila` to `docker-compose.yml`'s bot service. (Cron itself lands in Task 6, but establishing the env var here means every subsequent task inherits the correct time base.)
12. **Sync SPEC.md** with decisions 4A/5A/6A/7A/8A.

**Acceptance criteria:**
- [ ] `bot/categories.js`, `bot/sheets-client.js`, `bot/card/validators.js`, `bot/confirm-flow.js`, `bot/card/sheets.js` (scaffold) exist.
- [ ] `bot/index.js` no longer defines `CATEGORIES` etc.; imports from `bot/categories.js`.
- [ ] Receipt flow works end-to-end in a real Telegram session; identical UX to before.
- [ ] All prior tests still pass; new receipt tests + confirm-flow tests pass.
- [ ] `docker-compose.yml` sets `TZ=Asia/Manila` for the bot service.
- [ ] SPEC.md reflects the updated `cycle_month`/`due_date` rules, TZ requirement, nickname regex, and `/card rename` command.

**Verification:**
- [ ] `cd bot && npm test` — all green.
- [ ] Manual: full receipt happy-path in Telegram.
- [ ] Manual: each receipt edit button (Total/Category/Date) plus Cancel.

**Dependencies:** None.

**Files likely touched:**
- `bot/categories.js` (new)
- `bot/sheets-client.js` (new)
- `bot/confirm-flow.js` (new)
- `bot/card/validators.js` (new)
- `bot/card/sheets.js` (new, scaffold only)
- `bot/test-utils/mock-bot.js` (new)
- `bot/test-utils/fake-sheet.js` (new)
- `bot/__tests__/confirm-flow.test.js` (new)
- `bot/__tests__/receipt-flow.test.js` (new)
- `bot/card/__tests__/validators.test.js` (new)
- `bot/index.js` (major refactor: extract categories, migrate to confirm-flow + sheets-client + prefix registry)
- `bot/index.test.js` (update imports)
- `docker-compose.yml` (add TZ)
- `SPEC.md` (sync decisions)

**Estimated scope:** Large — but split across ~14 files of mostly-mechanical work. This is the "pay all foundational debt at once" task. Do not begin Phase 1 until Task 0 is fully verified.

---

### Task 1: Card model + `/card add` (with uniqueness) + `/card list`

**Description:** Implement `/card add` and `/card list`. Wire `/card` routing into `bot/index.js`. Use `validators.js` (from Task 0) and the sheet-adapter seam.

**Acceptance criteria:**
- [ ] `/card add BPI-Gold 1234 80000 25 15` writes to `CreditCards` after validation via `validators.js`; confirms success.
- [ ] Duplicate nickname rejected with message: `Card 'BPI-Gold' already exists. Use /card rename to change.`
- [ ] Invalid nickname (spaces, reserved words `purchase`/`payment`, >32 chars, wrong charset) rejected with a clear message.
- [ ] Malformed limit / days out of range rejected.
- [ ] `/card list` shows every card: nickname, last4, limit, current balance (0 for now, or computed if Task 2+ shipped), next due date.
- [ ] Missing `CreditCards` tab → setup message; no crash.

**Verification:**
- [ ] `cd bot && npm test` — new tests for `parseCardAdd`, uniqueness rejection, formatting of `/card list`.
- [ ] Sheet-adapter integration tests: happy add, dup rejection, missing-tab response, list-empty message.
- [ ] Manual: happy path in Telegram + duplicate rejection.

**Dependencies:** Task 0.

**Files likely touched:**
- `bot/card/commands.js` (new — `parseCardAdd`, `handleCardAdd`, `handleCardList`)
- `bot/card/sheets.js` (implement adapter-based readers/writers)
- `bot/card/balance.js` (new — `nextDueDate` helper stub, filled in Tasks 3–5)
- `bot/card/__tests__/commands.test.js` (new)
- `bot/card/__tests__/sheets.test.js` (new — uses `fake-sheet.js`)
- `bot/card/__tests__/balance.test.js` (new)
- `bot/index.js` (register `/card` route in `handleQuery`; `card_` prefix in registry)

**Estimated scope:** Medium (7 files).

---

### Task 1b: `/card rename` with rollback

**Description:** Add `/card rename <old> <new>`. Rewrites `card_name` across `CreditCards`, `CardTransactions`, `CardStatements` in that order. On any write failure, revert already-written rows (best-effort rollback). Reject when `<new>` already exists.

**Acceptance criteria:**
- [ ] `/card rename BPI-Gold BPI-Gold-Old` rewrites all 3 tabs; success message.
- [ ] `<new>` already exists → error, no writes.
- [ ] `<old>` not found → error, no writes.
- [ ] `<new>` fails validators.js → error, no writes.
- [ ] Simulated failure on tab 2 → tab 1 rows reverted; error message names which tabs were successfully rolled back and which weren't (if rollback itself fails).
- [ ] Case-insensitive match on `<old>`; `<new>` stored as-typed.

**Verification:**
- [ ] `cd bot && npm test` — new tests covering happy, collision, missing, invalid, partial-failure-with-rollback, partial-failure-with-rollback-also-failing.
- [ ] Manual: rename a card end-to-end; run `/card list` and cycle picker on subsequent commands to verify no stale references.

**Dependencies:** Task 1.

**Files likely touched:**
- `bot/card/commands.js` (add `handleCardRename`)
- `bot/card/sheets.js` (add `renameCard` with rollback)
- `bot/card/__tests__/commands.test.js` (extend)
- `bot/card/__tests__/sheets.test.js` (extend)

**Estimated scope:** Small (4 files).

---

### Task 2: `/card tx purchase` end-to-end

**Description:** Implement `/card tx <nickname> purchase <amount> <category> [note]`. Uses `confirm-flow.js` from Task 0 with prefix `card_tx_`. On Confirm, writes to `CardTransactions` (`type=purchase`, `statement_cycle` empty). Implements `runningBalance` in `balance.js` so `/card list` reflects writes.

**Acceptance criteria:**
- [ ] Happy path opens confirm with all fields visible; Confirm writes the row.
- [ ] Every editor (Amount/Category/Date) works and re-renders the summary.
- [ ] Cancel discards, no row.
- [ ] Unknown nickname / unknown category → clear error, no state stored.
- [ ] Amount validated via `validators.js` (positive, ≤ 2 decimals).
- [ ] `/card list` balance updates.

**Verification:**
- [ ] `cd bot && npm test` — new tests for `parseCardTxPurchase`, `runningBalance`, sheet-adapter write.
- [ ] Manual: happy + each edit path + cancel.

**Dependencies:** Task 0, Task 1.

**Files likely touched:**
- `bot/card/commands.js` (extend)
- `bot/card/sheets.js` (add `appendTransaction`)
- `bot/card/balance.js` (add `runningBalance`)
- `bot/card/__tests__/*` (extend)

**Estimated scope:** Medium (4 files).

---

### Task 3: `/card statement` — close a cycle

**Description:** Implement `/card statement <nickname> <amount> [due_date] [cycle_month]`. Applies decisions 5A (derive `cycle_month`) and 6A (default `due_date`).

Cycle-month derivation (pure fn `deriveCycleMonth(statementDay, today)`):
```
If today.day >= statementDay → cycle_month = format(today, 'YYYY-MM')
Else                         → cycle_month = format(today - 1 month, 'YYYY-MM')
```

Default `due_date` when omitted: `due_day` in the month following `cycle_month`.

**Acceptance criteria:**
- [ ] `/card statement BPI-Gold 12340` on 2026-04-03 with `statement_day=25` → `cycle_month=2026-03`, `due_date=2026-04-15` (assuming `due_day=15`).
- [ ] Same command on 2026-03-24 → `cycle_month=2026-02`, `due_date=2026-03-15`.
- [ ] Explicit `[due_date]` and `[cycle_month]` overrides honored.
- [ ] Duplicate `(card_name, cycle_month)` rejected.
- [ ] Unknown nickname → error, no write.

**Verification:**
- [ ] `cd bot && npm test` — new tests for `deriveCycleMonth`, `computeDueDate`, sheet-adapter write.
- [ ] Manual: happy, mid-cycle entry, before-statement-day entry.

**Dependencies:** Task 1.

**Files likely touched:**
- `bot/card/commands.js` (add `parseCardStatement`, `handleCardStatement`)
- `bot/card/sheets.js` (add `appendStatement`, `findStatement`)
- `bot/card/balance.js` (add `deriveCycleMonth`, `computeDueDate`)
- `bot/card/__tests__/balance.test.js` (extend)

**Estimated scope:** Small (4 files).

---

### Task 4: `/card tx payment` with cycle picker

**Description:** Implement `/card tx <nickname> payment <amount> [note]`. Uses an inline-keyboard picker step BEFORE the confirm-flow. Picker lists open cycles (per `openCycles` in `balance.js`); on selection, `statement_cycle` is set on the pending tx and the confirm flow opens.

**Acceptance criteria:**
- [ ] Picker lists open cycles as `Mar 2026 — ₱12,340 due Apr 15` buttons.
- [ ] Selection routes into confirm-flow with `statement_cycle` prefilled.
- [ ] Confirm writes `CardTransactions` row (`type=payment`, `statement_cycle` set, `category` empty).
- [ ] Overpayment allowed; `/card list` shows negative balance.
- [ ] No open cycles → prompt with "Log without cycle link" or "Cancel".
- [ ] Cycle disappears from picker once SUM(linked payments) ≥ `statement_amount`.

**Verification:**
- [ ] `cd bot && npm test` — new tests for `openCycles`, picker rendering, sheet-adapter write.
- [ ] Manual: happy + overpayment + no-cycles paths.

**Dependencies:** Task 0, Task 1, Task 2, Task 3.

**Files likely touched:**
- `bot/card/commands.js` (add `parseCardTxPayment`, `handleCardTxPayment`, picker logic)
- `bot/card/balance.js` (add `openCycles`)
- `bot/card/__tests__/balance.test.js` (extend)
- `bot/card/__tests__/commands.test.js` (extend)

**Estimated scope:** Medium (4 files).

---

### Task 5: `/card due` command

**Description:** Show next-upcoming due per card, sorted soonest-first. Uses open-cycle due date if available; otherwise computed estimate from `due_day`.

**Acceptance criteria:**
- [ ] Output: nickname, days until due, due date, statement amount ("—" if no open statement).
- [ ] Sort ascending by days-until-due.
- [ ] No cards → friendly message.

**Verification:**
- [ ] `cd bot && npm test` — tests for `nextDueForCard`.
- [ ] Manual: mixed cards (some with open statements, some without).

**Dependencies:** Task 1, Task 3.

**Files likely touched:**
- `bot/card/commands.js` (add `handleCardDue`)
- `bot/card/balance.js` (add `nextDueForCard` composing existing helpers)
- `bot/card/__tests__/balance.test.js` (extend)

**Estimated scope:** Small (3 files).

---

### Task 6: `node-cron` reminder job (two-phase, explicit TZ)

**Description:** Register `node-cron` job on startup (skipped when `NODE_ENV=test`). Schedule: `0 21 * * *` with explicit `{ timezone: process.env.TZ || 'Asia/Manila' }`. Two-phase execution (14A):

- **Phase 1:** Read `CreditCards` only. Compute estimated next-due for each card from `due_day`. If no card's estimate is 0 or 3 days from today, exit — no further reads.
- **Phase 2:** For matching cards, read `CardStatements` to get authoritative statement amounts. Send message to every `ALLOWED_USER_IDS`.

Pure `shouldRemind(dueDate, today)` helper — unit-tested at week/month/leap-year/DST boundaries.

**Acceptance criteria:**
- [ ] `node-cron` added to `bot/package.json`.
- [ ] Cron registered only when `!isTest`; test suite still runs offline.
- [ ] `shouldRemind` returns true iff days-until-due is 0 or 3.
- [ ] Two-phase behavior: no `CardStatements` read on days with no matching card.
- [ ] Existing startup log unchanged.
- [ ] `docker-compose.yml` sets `TZ=Asia/Manila` (done in Task 0; verify).

**Verification:**
- [ ] `cd bot && npm test` — `shouldRemind` boundaries, two-phase branch logic.
- [ ] Manual: temp schedule `*/1 * * * *`, observe message; revert.
- [ ] Manual: verify no reminder on off-days (change today's date via test only).

**Dependencies:** Task 1, Task 3, Task 5.

**Files likely touched:**
- `bot/package.json` (add dep)
- `bot/card/reminders.js` (new)
- `bot/card/__tests__/reminders.test.js` (new)
- `bot/index.js` (register cron in non-test startup)

**Estimated scope:** Small (4 files).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Task 0 refactor breaks receipt flow silently | High | 12A retrofit tests provide guardrail; manual receipt check in Foundation checkpoint. |
| Sheet-adapter fake diverges from real `google-spreadsheet` API | Medium | Keep the fake minimal — only implement the surface the code uses. Reviewed at each task's PR. |
| `cycle_month` off-by-one at statement_day exact boundary | Medium | `deriveCycleMonth` explicitly tested at `today.day == statementDay` (should be current month, not previous). |
| `docker-compose.yml` TZ change unclear on why | Low | Add a one-line comment referencing decision 7A. |
| Rename rollback itself fails | Medium | Surface both errors clearly; user has enough context to recover manually. Test case covers this. |
| Cron fires twice if bot restarts around 9pm | Low | Accept — spec explicitly allows this. |
| Sheets-client TTL invalidates during an active flow | Low | Cache holds the doc, not row data. Row reads are always fresh. |

## Open Questions

None at plan time. Reopen if implementation surfaces new decisions.

---

# Extension Plan: Purchase-Tagged Payments (2026-07-29)

Reference: SPEC.md → "Feature Extension: Purchase-Tagged Payments".

## Overview

Convert `/card tx <nickname> payment <amount>` from a cycle-picker flow into a multi-select **unpaid-purchase picker**. The picker shows a live running total that updates on every toggle via `editMessageText`. The payment row records which purchases it covers (`paid_purchases` CSV of `tx_id`s) and derives its `statement_cycle` from those purchases. Legacy cycle-only payments still work; the internal `paymentFlow` module stays in-tree but is unwired from this command.

## Architecture Decisions

- **Additive sheet schema.** Add `tx_id` and `paid_purchases` columns to `CardTransactions`. Existing rows keep working; `tx_id` for legacy rows is *synthesized on read* (deterministic from `timestamp`) rather than written back. No destructive migration.
- **Paid state is derived, never stored on purchase rows.** A purchase is "paid" iff its `tx_id` appears in some payment row's `paid_purchases`. Preserves audit trail — corrections happen via new rows, not mutation.
- **Callback prefix `card_ppay_`** (NOT `card_purchase_payment_` as the spec draft suggested — that would prefix-collide with `card_purchase_` used by the purchase-tx confirm flow, letting purchase-flow see every ppay callback before rejecting it). Picker: `card_ppay_pick_{toggle_<txid>|done|cancel}`. Confirm: `card_ppay_{confirm|cancel|edit_amount|edit_date}`. **This is a spec correction — Task E3 updates SPEC.md to match.**
- **In-place render via `editMessageText`.** Picker state is one message that the bot edits on every toggle. Keeps chat clean; requires `messageId` tracking in per-chat state and a matching method on `test-utils/mock-bot.js`.
- **No purchase-set editor in the confirm phase.** Confirm allows only Edit Amount / Edit Date / Cancel. To change the tagged set, user cancels and starts over. Keeps confirm-flow's contract clean (each edit field is a scalar).
- **`payment-flow.js` stays.** Removal is under "Ask first" per SPEC boundaries. Task E3 unwires it from `/card tx payment` only.

### Approved plan-mode performance decisions (2026-07-29)

Three decisions from `code-review-plan-mode` Performance section. All three selected recommended option.

- **P1 — Optional `purchaseIndex` argument on `computeOpenCycles` and `computeCardDue`.** Signatures: `computeOpenCycles(card, statements, transactions, purchaseIndex?)` and `computeCardDue(card, statements, transactions, today, purchaseIndex?)`. Callers that loop over many cards (e.g., `/card list`, reminders) build the `Map<tx_id, purchase>` once and pass it. Standalone callers pass `undefined` and the fn builds lazily. Makes the perf contract visible in the signature. Folded into Task E4.
- **P2 — Fix `computeCardReminders` in Task E4.** Existing bug: per-statement call passes `[s]` to `computeOpenCycles`, disabling carryforward — reminders fire for cycles already covered by prior overpayment. New shape: group statements by card, call `computeOpenCycles(card, cardStatements, transactions, purchaseIndex)` once per card, then walk returned open cycles matching by `cycle_month`. Regression test: overpaid cycle A + open cycle B for same card → no reminder emitted on B's due date. Since E4 already updates `reminders.js` for CQ3's signature change, folding this in has zero drift risk.
- **P3 — Accept `editMessageText` chattiness; document ~30-item ceiling.** SPEC "Picker" section (updated in E3) adds: *"Each toggle triggers an editMessageText round-trip; expect ~200ms perceived latency per tap. For >30 unpaid purchases, the UX degrades — treat 30 as a practical ceiling."* Existing risk table already flags "purchase count grows unboundedly" as a low-risk deferred item.

### Approved plan-mode test decisions (2026-07-29)

Four decisions from `code-review-plan-mode` Test section. All four selected recommended option.

- **T1 — Dedicated end-to-end integration test.** Add `bot/card/__tests__/purchase-payment-e2e.test.js` in Task E3. Wires real `createCardCommands` + real `purchasePicker` + real `two-phase-picker` + real `sheets` (backed by `fake-sheet`). Walks `/card tx X payment 500` → toggle 2 purchases → Done → confirm-flow Confirm. Asserts fake-sheet row has correct `p_`-prefixed `tx_id`, CSV `paid_purchases`, empty `statement_cycle` on multi-cycle, single-cycle derivation on single, and `computeBalances` reflects the write. One additional test covers the empty-unpaid short-circuit path.
- **T2 — Concurrent picker state and re-`start()` behavior.** Task E2a's tests include: (a) two chats' picker state remains isolated, (b) same chat's `start()` while already in picker phase silently replaces state — old picker's buttons no-op via foreign-callback filter (test asserts the old callback returns without state mutation), (c) picker state survives unrelated command dispatches. Forces the design decision on (b): replace state silently; the old message's buttons become inert. Document in a comment on `two-phase-picker.js`.
- **T3 — Legacy cycle-only payment behavior in `listUnpaidPurchases`.** Task E0's tests include: (a) legacy cycle-only payment (empty `paid_purchases`) leaves its purchases as "unpaid" in the picker, (b) purchase-tagged payment correctly marks its purchases paid, (c) mixed history (legacy cycle-paid + purchase-tagged in same card) shows only the legacy-cycle purchases as unpaid. Document the quirk in `purchases.js` header comment: *legacy cycle-paid purchases surface in the picker forever — this is the audit-trail cost of not backfilling*.
- **T4 — Enforce `sum(paid_purchases) === amountTyped` at picker Done.** Removes the "stuck cycle" failure mode where underpay-tagging drops purchases off the picker while leaving the cycle short. Task E2b changes: `onPick` for `done` checks `sum !== amountTyped` → returns `keepPicking: true` with a warning message like `Selected ₱${sum} doesn't match payment amount ₱${amountTyped}. Adjust selection or Cancel.`. Task E2b tests cover all three cases (equal → proceeds; over → blocked; under → blocked). Task E3 updates SPEC.md to state this constraint explicitly.

### Approved plan-mode code-quality decisions (2026-07-29)

Four decisions from `code-review-plan-mode` Code Quality section. All four selected recommended option.

- **CQ1 — Delete `payment-flow.js` and its test file in Task E3** as part of unwiring `/card tx payment`. Once E3 lands, nothing invokes it. Reason for parent SPEC's "removal is under 'Ask first'" boundary is satisfied by this plan-mode approval. Task E2b is simplified: only build `purchase-picker.js` on the shared abstraction — no legacy refactor. `commands.test.js` payment tests already end-to-end-verify the abstraction via `purchasePicker`.
- **CQ2 — Distinct `tx_id` prefixes: `ps_` for synthesized (legacy read), `p_` for generated (fresh writes).** Task E0's `synthesizeTxId` returns `ps_<epoch-ms>`; Task E1's `sheets.addTransaction` generates `p_<epoch36>_<rand4hex>`. Grep, logs, and audit trail immediately distinguish reconstructed-from-timestamp vs assigned-at-write. Eliminates the collision risk when a legacy row and a fresh write share a clock second.
- **CQ3 — `computeOpenCycles` and `computeCardDue` take `card` (not `cardName`).** New signatures: `computeOpenCycles(card, statements, transactions)`, `computeCardDue(card, statements, transactions, today)`. Internally: `const target = card.card_name.toLowerCase()`. Removes the redundant-argument foot-gun where callers pass `cardName` alongside `card` and they can drift.
- **CQ4 — Add `hydratePurchases(txIds, transactions) → Purchase[]` helper in Task E0.** Pure fn; builds `Map<tx_id, purchase>` from transactions and returns purchases in the order of `txIds` (unknown ids skipped, no throw — matches "corrections via new rows, not mutation"). Task E4's `resolvePaymentCycle` composes `hydratePurchases` + `inferCycleFromPurchases`, keeping `balance.js` off raw sheet-row access. Callers can share one Map across many payments in a single `computeOpenCycles` call.

### Approved plan-mode architecture decisions (2026-07-29)

Four decisions from `code-review-plan-mode` Architecture section. All four selected recommended option (Option A).

- **1A — `statement_cycle` on payment rows is derived on read, not stored.** The single source of truth is `paid_purchases`; the cycle is a *view* over that list, not a field to keep in sync. `sheets.addTransaction` writes `paid_purchases` and leaves `statement_cycle` empty on purchase-tagged payments. `computeOpenCycles` (and any code today that reads `tx.statement_cycle`) instead resolves the cycle at read time by looking up each purchase and inferring the cycle via `inferCycleFromPurchases`. Legacy cycle-only payments (empty `paid_purchases`) keep using their stored `statement_cycle` as before — the two shapes coexist under one derivation function. Eliminates the dual-source-of-truth failure mode where a user's future purchase edit silently invalidates a payment row's cached cycle.
- **2A — Startup-time prefix-registry validator.** `bot/index.js` adds ~15 lines at startup that asserts no registered `flowHandlers` key is a proper prefix of another. Fails fast at boot rather than at first misrouted callback. Codifies the collision class that surfaced in `card_ppay_` vs `card_purchase_`. Runs once; zero runtime cost.
- **3A — Extract `bot/two-phase-picker.js` shared abstraction.** Signature: `createTwoPhasePicker({ prefix, pickerRender, onPick, confirmFlow })`. Handles per-chat pending-picker state, callback dispatch during picker phase, delegation to `confirmFlow.start` on Done, and foreign-prefix passthrough. Both `bot/card/payment-flow.js` (cycle picker) and `bot/card/purchase-picker.js` (purchase multi-select) sit on top of it. Refactor lands in Task E2 — new `purchase-picker.js` is built on the abstraction, and `payment-flow.js` is retrofitted onto it in the same task so both flows exercise the shared code from day one.
- **4A — `sheets.addTransaction` generates `tx_id` internally.** Callers no longer pass `tx_id`; addTransaction generates it (`p_<epoch36>_<rand4hex>`) and returns the assigned id on the row it wrote. Optional `{ txId }` override in the options argument for tests that need determinism. Removes the "every caller must remember to generate a fresh id" foot-gun and the "id format leaks to every call site" DRY problem. Task E1 owns the change; Task E3's onConfirm site simply consumes the returned id (e.g., for the confirmation message).

## Dependency Graph

```
purchases.js (pure fns)                                    ← Task E0
     │
     ├── sheets.js extension (tx_id gen internal, paid_purchases r/w)  ← Task E1
     │       │
     │       └── two-phase-picker.js (shared abstraction) ─┐   ← Task E2a
     │              │                                       │
     │              ├── purchase-picker.js (multi-select)  │   ← Task E2b
     │              └── payment-flow.js refactor           │   ← Task E2b
     │                     │                                │
     │                     └── commands.handleTx + index.js wiring  ← Task E3
     │                                     │
     │                                     └── prefix-registry validator  ← Task E3b
     │
     └── balance.js: derived-cycle read + regression tests  ← Task E4
```

Task E0 has no dependencies. Task E4 gains a small code change (derive statement_cycle at read time) plus the regression tests.

## Task List

### Phase A: Pure Foundation

- [ ] **Task E0** — `bot/card/purchases.js` with four pure functions + unit tests
  - `synthesizeTxId(row)` — deterministic. `ps_<epoch-ms>` from `Date.parse(row.timestamp)` when `tx_id` absent; passthrough otherwise. Fallback appends a short row-index suffix if two rows share the same timestamp. **`ps_` prefix distinguishes synthesized (legacy read) from generated (`p_`, written by `sheets.addTransaction`) per CQ2.**
  - `listUnpaidPurchases(cardName, transactions)` — case-insensitive card match. Returns purchase rows (each annotated with resolved `tx_id`) whose ID does not appear in any payment row's `paid_purchases`. Legacy cycle-only payments (empty `paid_purchases`) contribute nothing here.
  - `inferCycleFromPurchases(purchases, statementDay)` — returns `{ cycle_month: 'YYYY-MM' }` if all in one cycle; `{ multi: true, cycles: [...] }` if spanning; `{ empty: true }` if input is empty. Reuses `deriveCycleMonth` from `balance.js`.
  - **`hydratePurchases(txIds, transactions) → Purchase[]` (CQ4)** — pure. Builds `Map<tx_id, purchase>` from `transactions` (purchase rows only, tx_id resolved via `synthesizeTxId`). Returns purchases in the order of `txIds`. Unknown `txIds` are silently skipped (never throws — matches "corrections happen via new rows, not mutation" from Architecture Decisions). Callers may share one Map across many payments in a single read.
  - **Acceptance:** all four functions pure (no I/O), unit-tested with fake data. Coverage includes: `ps_` prefix on synthesized ids, row-index tiebreak on timestamp collision, statement_day boundary in `inferCycleFromPurchases`, `hydratePurchases` skips unknown ids without throwing. **T3 tests in `listUnpaidPurchases`:** (a) legacy cycle-only payment leaves its purchases as unpaid, (b) purchase-tagged payment correctly marks its purchases paid, (c) mixed history (legacy + purchase-tagged) shows only legacy purchases as unpaid. Document the quirk in `purchases.js` header comment.
  - **Verify:** `cd bot && npm test card/__tests__/purchases.test.js` — new tests pass. Full suite stays green.
  - **Files:** `bot/card/purchases.js`, `bot/card/__tests__/purchases.test.js`.
  - **Scope:** S (2 files).
  - **Dependencies:** none.

### Phase B: Sheet Extension

- [ ] **Task E1** — `bot/card/sheets.js` supports `tx_id` (generated internally) and `paid_purchases`
  - `listTransactions` — reads `tx_id` (synthesizes `ps_`-prefixed ids for legacy rows via `synthesizeTxId` per CQ2) and `paid_purchases` (returns as `string[]`, not raw CSV, so callers don't reparse).
  - `addTransaction` — generates `tx_id` internally as **`p_<epoch36>_<rand4hex>`** (CQ2 distinct prefix from synthesized `ps_`), accepts optional `{ txId }` override for tests, accepts `paid_purchases` (array, joined to CSV on write), and **returns `{ tx_id }`** (the id it wrote). **Callers no longer pass `tx_id`.** Purchase-tagged payment rows leave `statement_cycle` empty on write — the cycle is derived on read (Architecture Decision 1A). Legacy cycle-only payments still write `statement_cycle` as before.
  - **Acceptance:** `listTransactions` never returns empty `tx_id`; `addTransaction` writes both new columns; `addTransaction` return value includes the generated id; deterministic-id path via `{ txId }` override works for tests; no caller in the tree passes a caller-generated `tx_id`.
  - **Verify:** `cd bot && npm test card/__tests__/sheets.test.js` — new column tests + existing sheets tests green (existing tests updated to consume the returned id, not pass one). Full suite green.
  - **Files:** `bot/card/sheets.js`, `bot/card/__tests__/sheets.test.js`, `bot/index.js` (existing `paymentFlow` + `purchaseFlow` onConfirm sites drop the id argument; use returned id if surfaced in confirmation text).
  - **Scope:** S (3 files).
  - **Dependencies:** Task E0 (imports `synthesizeTxId`).

### Phase C: Interactive Picker

- [ ] **Task E2a** — Extract `bot/two-phase-picker.js` shared abstraction (Architecture Decision 3A)
  - Signature: `createTwoPhasePicker({ prefix, pickerRender, onPick, confirmFlow })` → `{ start, handleCallback, handleTextInput }`.
    - `prefix` — the flowHandler namespace (`card_pay_` for cycle picker, `card_ppay_` for purchase picker).
    - `pickerRender(state) → { text, keyboard }` — pure function producing the picker message body + inline keyboard. Called on `start` and on every picker-phase callback that mutates state.
    - `onPick(state, callbackToken) → { keepPicking: bool, nextState?, confirmSeed?, warning? }` — the picker-specific state transition. `keepPicking: true` → re-render in place via `editMessageText`. `keepPicking: false` → picker phase ends, `confirmFlow.start(chatId, confirmSeed)` fires with an optional user-facing warning threaded through.
    - `confirmFlow` — the already-constructed `createConfirmFlow({ prefix, ... })` instance.
  - Owns per-chat `pendingPicker` Map, initial send + `message_id` capture, `editMessageText` re-renders, foreign-prefix passthrough, and the `pick_cancel` intercept that must run before confirm-flow's `onStale`.
  - `handleTextInput` delegates unconditionally to `confirmFlow.handleTextInput` — picker phase is button-only.
  - **Acceptance:** unit tests for the abstraction alone (fake `pickerRender`/`onPick`); both keepPicking and terminal-pick paths covered; foreign-prefix returns false without calling `pickerRender`; message_id captured from the mock's `sendMessage` return value. **T2 concurrent-state tests:** (a) two chats' picker state remains isolated across interleaved callbacks; (b) same chat's `start()` while already in picker phase silently replaces state — old picker's buttons no-op via foreign-callback filter (old callback returns without mutating new state); (c) picker state survives dispatches to other flowHandlers. Design decision on (b): replace silently; old message's buttons become inert. Document in a comment on `two-phase-picker.js`.
  - **Verify:** `cd bot && npm test test-utils/__tests__/two-phase-picker.test.js` — new tests pass.
  - **Files:** `bot/two-phase-picker.js`, `bot/__tests__/two-phase-picker.test.js`, `bot/test-utils/mock-bot.js` (add `editMessageText` recorder + let `sendMessage` return `{ message_id }`).
  - **Scope:** M (3 files; abstraction + tests).
  - **Dependencies:** none new beyond confirm-flow already existing.

- [ ] **Task E2b** — `purchase-picker.js` built on the abstraction (CQ1: no legacy refactor)
  - `bot/card/purchase-picker.js` — implements `pickerRender` and `onPick` for the multi-select case:
    - State: `{ card_name, statement_day, amountTyped, allPurchases: [{tx_id, tx_date, amount, category}], selectedIds: Set }`.
    - `pickerRender(state)` — header `💳 *${card_name}* — payment of ₱${amountTyped}\nSelected: ₱${sum} / ₱${amountTyped} · ${selected.size} of ${all.length} purchases`; one button per purchase with `[ ]` / `[x]` prefix; Done + Cancel buttons.
    - `onPick(state, token)` — `toggle_<txid>` flips membership → `keepPicking: true` with updated state; `done` → **T4 sum enforcement:** if `sum(selected.amount) !== state.amountTyped` → `keepPicking: true` with warning `Selected ₱${sum} doesn't match payment amount ₱${amountTyped}. Adjust selection or Cancel.`; else zero-selection warns and stays; else infers cycle via `inferCycleFromPurchases`, returns `keepPicking: false` with `confirmSeed = { card_name, amount, tx_date, paid_purchases: [...selectedIds], statement_cycle: singleCycle || '', warning: multiCycleWarning? }`.
    - Confirm-phase editors: `amount` (validateAmount), `date` (dataKey `tx_date`). No category, no cycle, no purchase-set editor.
    - Empty purchases at `start()` — warn and return without instantiating picker state.
  - **Not in scope (CQ1):** `payment-flow.js` is NOT refactored onto the shared abstraction. It will be deleted in Task E3 (per code-quality decision CQ1 — dead once E3 unwires the only production caller).
  - **Acceptance:** in-place toggle via `editMessageText`; accurate running total; multi-cycle sets `statement_cycle=''` and surfaces warning; zero-selection Done warns; foreign-prefix returns false. **T4 tests (all 3 cases):** sum equals typed amount → Done proceeds to confirm; sum > typed amount → Done blocked with mismatch warning; sum < typed amount → Done blocked with same warning.
  - **Verify:** `cd bot && npm test card/__tests__/purchase-picker.test.js` — new picker tests pass.
  - **Files:** `bot/card/purchase-picker.js`, `bot/card/__tests__/purchase-picker.test.js`.
  - **Scope:** M (2 files).
  - **Dependencies:** Task E0 (imports `listUnpaidPurchases`, `inferCycleFromPurchases`), Task E1 (needs `tx_id` on read), Task E2a (shared abstraction).

### Phase D: Wire the Command

- [ ] **Task E3** — `handleTx` routes to `purchasePicker`; wire in `index.js`; delete `payment-flow.js` (CQ1); SPEC corrected
  - `createCardCommands` signature: **remove** `paymentFlow` param, **add** `purchasePicker`. Payment branch: load transactions, filter via `listUnpaidPurchases(card.card_name, transactions)`, call `purchasePicker.start(chatId, { card_name, amount, purchases: unpaid, statement_day: card.statement_day })`.
  - `index.js` — construct `purchasePicker` with `onConfirm` that writes the row via `sheets.addTransaction` (which generates and returns the `p_<epoch36>_<rand4hex>` `tx_id`), then sends confirmation message (may include the returned id). Register in `flowHandlers`. **Stop constructing `paymentFlow` entirely.**
  - **Delete `bot/card/payment-flow.js` and `bot/card/__tests__/payment-flow.test.js`** (CQ1). Nothing invokes them after this task. `commands.test.js` payment tests end-to-end verify the shared abstraction via `purchasePicker`, so coverage is preserved.
  - Update `commands.test.js` payment tests: `wire()` helper takes `purchasePicker` mock; payment path asserts `purchasePicker.start` was called with the unpaid list. Remove any surviving `paymentFlow` references.
  - Update `SPEC.md` "Callback Naming" section to reflect `card_ppay_`; remove `card_pay_` references (or note them as removed). **T4 SPEC addition:** state the `sum(paid_purchases) === amountTyped` constraint under the picker flow — user cannot Done with a mismatch. **P3 SPEC addition:** under Picker, add: *"Each toggle triggers an editMessageText round-trip; expect ~200ms perceived latency per tap. For >30 unpaid purchases, the UX degrades — treat 30 as a practical ceiling."*
  - **T1 end-to-end integration test:** add `bot/card/__tests__/purchase-payment-e2e.test.js`. Wires real `createCardCommands` + real `purchasePicker` + real `two-phase-picker` + real `sheets` (backed by `fake-sheet`). Walks `/card tx X payment` → toggle purchases → Done → confirm → Confirm. Asserts row shape (correct `p_`-prefixed `tx_id`, CSV `paid_purchases`, empty `statement_cycle` on multi-cycle, single-cycle derivation on single) and that `computeBalances` reflects the write. Second test covers the empty-unpaid short-circuit path.
  - **Acceptance:** `/card tx X payment 500` triggers the new picker; empty-unpaid warning path works; happy path writes the correct row (fake-sheet snapshot: `paid_purchases` CSV, empty `statement_cycle` on multi-cycle, generated `p_`-prefixed `tx_id`); `payment-flow.js` no longer exists in the tree; `grep -r paymentFlow bot/` returns zero hits; integration test file exists and passes.
  - **Verify:** `cd bot && npm test` — full suite green (net test count drops by whatever `payment-flow.test.js` contributed, offset by new tests elsewhere including the e2e file).
  - **Files:** `bot/card/commands.js`, `bot/card/__tests__/commands.test.js`, `bot/card/__tests__/purchase-payment-e2e.test.js` (new — T1), `bot/index.js`, `SPEC.md`, **DELETE** `bot/card/payment-flow.js`, **DELETE** `bot/card/__tests__/payment-flow.test.js`.
  - **Scope:** M (5 files touched + 2 deleted).
  - **Dependencies:** Task E2b.

- [ ] **Task E3b** — Startup-time prefix-registry validator (Architecture Decision 2A)
  - In `bot/index.js`, after all `flowHandlers` are registered and before the bot starts polling/webhook, add ~15 lines that assert no registered prefix is a proper prefix of another. On collision, throw at boot with a message naming both offenders (e.g., `Callback prefix collision: "card_ppay_" is not a prefix of "card_pay_" but "card_pa" would collide — check registrations`).
  - Runs once at boot; no runtime cost per callback.
  - **Acceptance:** validator throws when a collision exists (unit-testable by extracting the check into `validatePrefixes(prefixes: string[])`); passes with current registrations (`receipt_`, `card_`, `card_pay_`, `card_ppay_`, `card_purchase_`, `card_statement_`, etc. — verify all distinct with no proper-prefix pairs).
  - **Verify:** `cd bot && npm test __tests__/prefix-validator.test.js` — collision + non-collision cases pass. Boot with real registrations succeeds.
  - **Files:** `bot/prefix-validator.js` (extracted pure fn), `bot/__tests__/prefix-validator.test.js`, `bot/index.js` (invoke at boot).
  - **Scope:** XS (3 files, ~15 loc + tests).
  - **Dependencies:** Task E3 (need final flowHandler set to validate against).

### Phase E: Regression

- [ ] **Task E4** — `balance.js` derives statement_cycle on read (CQ3 sig; CQ4 hydration; P1 index reuse); reminders fix (P2); regression tests
  - Code change in `bot/card/balance.js`:
    - Add pure helper `resolvePaymentCycle(payment, card, purchaseIndex)` — returns `payment.statement_cycle` when non-empty; else calls `hydratePurchases(payment.paid_purchases, purchaseIndex)` + `inferCycleFromPurchases(hydrated, card.statement_day)`. Single-cycle → returns cycle string. Multi-cycle → returns `''` (unlinked, matches legacy empty-cycle semantics). Empty/all-unknown → `''`.
    - **CQ3 + P1 signature updates:** `computeOpenCycles(card, statements, transactions, purchaseIndex?)` and `computeCardDue(card, statements, transactions, today, purchaseIndex?)`. Both drop the redundant `cardName` argument; internally derive `target = card.card_name.toLowerCase()`. When `purchaseIndex` is omitted, build lazily; when provided, reuse.
    - **CQ4 hydration + P1 reuse:** helper `buildPurchaseIndex(transactions) → Map<tx_id, purchase>` exposed from `balance.js` (or re-exported from `purchases.js`) so callers that loop can build once.
    - Update all call sites: `commands.js` (`/card list`, `/card due` — build index once, pass it), `reminders.js` (see P2 below), all tests.
  - **P2 reminders fix** in `bot/card/reminders.js`:
    - Refactor `computeCardReminders`: group statements by `card_name`, resolve `card` object per group from `cards` input (matching `card.card_name` case-insensitively), build `purchaseIndex` once from `transactions`, then call `computeOpenCycles(card, cardStatements, transactions, purchaseIndex)` **once per card** and walk the returned open cycles matching by `cycle_month` for reminder emission.
    - Skip statements whose card is missing from `cards` (defensive — shouldn't happen but don't crash).
    - **Regression test:** overpaid cycle A + open cycle B on same card, run `computeCardReminders` on B's due date → no `type: 'statement'` reminder emitted (credit covers it). Add a second test: 3 statements across 2 cards → `computeOpenCycles` invoked exactly 2 times (assert via spy). Fixes the existing carryforward-miss bug.
  - **Regression tests:**
    - `balance.test.js`: `resolvePaymentCycle` unit tests (stored cycle wins; single-cycle derivation; multi-cycle returns `''`; empty returns `''`; unknown tx_ids silently skipped). Purchase-tagged single-cycle credits derived cycle like legacy. Purchase-tagged multi-cycle contributes zero to `computeOpenCycles` but full amount to `computeBalances`. Overpayment carryforward preserved for new shape. Legacy cycle-only payments still work. New signature: existing tests updated to pass `card` — no shim. `purchaseIndex` reuse: passing a pre-built index gives identical output.
    - `reminders.test.js`: **P2 tests:** (a) overpaid cycle A + open cycle B on same card → no statement-reminder on B's due date (carryforward covers it); (b) 3 statements across 2 cards → `computeOpenCycles` invoked exactly 2 times (spy-based assertion).
  - **Acceptance:** `resolvePaymentCycle` and `hydratePurchases` are pure fns with unit tests; `computeOpenCycles` / `computeCardDue` take `card` object + optional `purchaseIndex`; `buildPurchaseIndex` exposed; all call sites updated; both payment shapes round-trip identically through balance module; reminders correctly suppress spurious cycle-B reminders when cycle-A overpayment covers them; reminders make one `computeOpenCycles` call per card, not per statement.
  - **Verify:** `cd bot && npm test card/__tests__/balance.test.js card/__tests__/reminders.test.js` — new tests green. Full suite green after call-site updates.
  - **Files:** `bot/card/balance.js`, `bot/card/__tests__/balance.test.js`, `bot/card/commands.js` (call-site sig update, build index once for `/card list` + `/card due`), `bot/card/reminders.js` (P2 refactor + CQ3 sig update), `bot/card/__tests__/reminders.test.js` (P2 tests).
  - **Scope:** M (5 files — grew by one test file for P2 coverage).
  - **Dependencies:** Task E1 (payment row shape includes new fields), Task E0 (imports `inferCycleFromPurchases`, `hydratePurchases`).

### Checkpoint: Extension Complete

- [ ] Full `cd bot && npm test` green (currently 316; expect ~370+ with the shared-abstraction + validator tests).
- [ ] Manual Telegram walkthrough:
  - [ ] Register `TestCard`; log 3 purchases (`Groceries ₱120`, `Dining ₱200`, `Transport ₱80`).
  - [ ] `/card tx TestCard payment 400` — picker appears; header shows `Selected: ₱0 / ₱400`.
  - [ ] Toggle Groceries → header updates to `Selected: ₱120 / ₱400 · 1 of 3`. Same message edited (no new message).
  - [ ] Toggle Dining → header `Selected: ₱320 / ₱400 · 2 of 3`.
  - [ ] Done → confirm preview shows `Covers 2 purchases (₱320) · Cycle 2026-07 · Excess ₱80 credits cycle`.
  - [ ] Confirm → sheet row appears with `paid_purchases` = both tx_ids and `statement_cycle` derived.
  - [ ] `/card tx TestCard payment 100` again — Transport still unpaid; Groceries/Dining gone from picker.
  - [ ] `/card list` — balance dropped by ₱400.
- [ ] Legacy cycle-only payment (from an earlier task) still counts in `/card list` and `/card due`.
- [ ] SPEC.md callback naming reflects `card_ppay_`.
- [ ] Human review before shipping.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Callback-data prefix collision with existing `card_purchase_` | High | Use `card_ppay_` (Architecture Decisions); SPEC updated in Task E3. |
| `editMessageText` not present on real Telegram client / mock — silent breakage | Medium | Task E2 adds it to `test-utils/mock-bot.js`; `node-telegram-bot-api` supports it natively. |
| Telegram callback data 64-byte limit exceeded | Low | `card_ppay_pick_toggle_p_<8hex>` ≈ 30 bytes. Safe unless tx_id format grows. |
| Multi-select state lost if bot restarts mid-picker | Low | Accept for v1 (matches parent spec's stateless behavior); user re-runs `/card tx`. Comment in code. |
| Purchase count grows unboundedly, breaking the keyboard | Low | Documented in SPEC as deferred; realistically <30 unpaid at a time. |
| Cycle inference wrong at statement_day boundary | Medium | `inferCycleFromPurchases` reuses `deriveCycleMonth` (already boundary-tested). Task E0 adds coverage of the boundary. |
| Legacy purchase rows without `tx_id` collide via `synthesizeTxId` (same timestamp) | Very Low | Timestamps are ISO ms; parent code writes `new Date().toISOString()`. Task E0 adds unit test + row-index tiebreak. |

## Open Questions

None at plan time. Any surfaced during implementation get appended here.

