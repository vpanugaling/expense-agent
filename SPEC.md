# Spec: Credit Card Tracking

## Objective

Extend the existing Telegram expense bot with **manual credit-card tracking**: register multiple cards, log purchases and payments per card, keep a running balance, record statement cycles on-demand, and receive proactive due-date reminders.

**Primary user:** the bot's single authorized owner (`ALLOWED_USER_IDS`), tracking personal credit cards in PHP.

**Success looks like:**
- Owner can register N cards via `/card add` and see them via `/card list` with current balance.
- Every purchase/payment is entered manually via `/card tx`, previewed with an inline keyboard, and only written to Google Sheets after explicit confirmation.
- Owner enters real statement amounts via `/card statement` when the bank statement arrives; payments are linked to a specific statement cycle.
- Bot posts a due-date reminder to all `ALLOWED_USER_IDS` at 9 pm local, 3 days before due and again on the due date itself.
- Card purchases do **not** touch the existing `Expenses` sheet or category budgets — they live in their own tab.

## Tech Stack

- **Runtime:** Node.js (existing bot container), Express, `node-telegram-bot-api`
- **Storage:** Google Sheets via `google-spreadsheet` (existing sheet, new tabs)
- **Scheduling:** `node-cron` (new dependency), runs in-process inside the bot container
- **Testing:** Jest (existing)

No OCR, no LLM, no photo input for this feature.

## Commands

Repo commands (unchanged from existing bot):

```
Install: cd bot && npm install
Test:    cd bot && npm test
Run dev: docker compose up bot
Deploy:  docker compose up -d --build bot
```

New Telegram commands introduced by this spec:

```
/card add <nickname> <last4> <limit> <statement_day> <due_day>
    → Register a card. All fields required.
    nickname: regex /^[A-Za-z0-9_-]{1,32}$/, must not equal 'purchase' or 'payment' (reserved)
    statement_day/due_day: 1–31
    Rejects if nickname already exists (see /card rename for typo escape hatch).
    Example: /card add BPI-Gold 1234 80000 25 15

/card list
    → List all cards with: nickname, last4, credit_limit, current_balance, next_due_date.

/card rename <old-nickname> <new-nickname>
    → Rewrite nickname across CreditCards, CardTransactions, and CardStatements.
    Rejects if <new-nickname> already exists or fails validation.
    On partial-write failure, best-effort rollback of tabs already written; error message
    names which tabs rolled back cleanly and which did not.

/card tx <nickname> purchase <amount> <category> [note]
    → Log a purchase. Opens confirm flow (Confirm / Edit Amount / Edit Category / Edit Date / Cancel).

/card tx <nickname> payment <amount> [note]
    → Log a payment. Bot first shows list of open statement cycles for that card as inline buttons.
    After cycle is picked, opens confirm flow (Confirm / Edit Amount / Edit Date / Cancel).

/card statement <nickname> <amount> [due_date] [cycle_month]
    → Close a cycle with the real statement amount from the bank.
    cycle_month (if omitted) is derived from card.statement_day and today (see Balance & Cycle Rules).
    due_date  (if omitted) defaults to card.due_day in the month AFTER cycle_month.
    Duplicate (card_name, cycle_month) rejected.

/card due
    → Show next upcoming due date for each card (nickname, days until due, statement amount if known).
```

Existing commands (`/add`, `/budget`, `/summary`, receipt photo flow) are **not modified**.

## Project Structure

```
bot/
  index.js              → existing bot; add /card command routing + card handlers here
  index.test.js         → existing test file; extend with card-flow tests
  package.json          → add node-cron dependency
  categories.js         → shared CATEGORIES / PAYMENT_METHODS / findCategory (extracted from index.js)
  sheets-client.js      → lazy singleton Google-Sheets doc with 5-min TTL, injected everywhere
  confirm-flow.js       → shared confirm/edit/cancel state machine used by receipt + card flows
  receipt-flow.js       → receipt-specific wiring of confirm-flow (existing behavior, refactored)
  test-utils/
    mock-bot.js         → bot fake for tests (records sendMessage / answerCallbackQuery)
    fake-sheet.js       → in-memory sheets fake matching the google-spreadsheet surface we use
  card/                 → NEW module directory for card logic (keeps index.js from bloating)
    commands.js         → parsing + routing for /card subcommands
    sheets.js           → sheet-adapter seam: createCardSheets({ getDoc }) → domain methods.
                          All I/O flows through here so tests inject fake-sheet.js
    balance.js          → running-balance + cycle computation (pure functions, easy to test)
    validators.js       → validateNickname/validateAmount/validateLimit/validateDay (pure)
    reminders.js        → node-cron job + due-date scanning + message formatting
  card/__tests__/       → unit tests for validators, sheet-adapter, balance, and command parsing
docker-compose.yml      → sets TZ=Asia/Manila on the bot container (see Reminders)
ocr/                    → unchanged (not touched by this feature)
```

## Sheet Schema

Three new tabs must exist in the same Google Sheet used by `Expenses`/`Budgets`. Bot will not auto-create them; if missing, `/card` commands respond with a setup message listing the required columns.

**`CreditCards`**
```
card_name | last4 | credit_limit | statement_day | due_day | created_at
```

**`CardTransactions`**
```
timestamp | card_name | tx_date | type | amount | category | notes | statement_cycle
```
- `type` ∈ {`purchase`, `payment`}
- `category` is only set for `purchase` (reuse the existing 18 categories from `CATEGORIES`)
- `statement_cycle` is only set for `payment` (format `YYYY-MM`, refers to the cycle the payment settles)
- `notes` is free-form for either type

**`CardStatements`**
```
card_name | cycle_month | statement_amount | due_date | closed_at
```
- `cycle_month` is `YYYY-MM` (the month the statement closed)
- One row per (card_name, cycle_month)

## Balance & Cycle Rules

- **Current balance** = SUM(purchases) − SUM(payments) across all time for that card. May be negative (overpayment allowed).
- **Open statement cycles** for a card = rows in `CardStatements` where `SUM(payments linked to that cycle) < statement_amount`. Payments are matched via the `statement_cycle` column on `CardTransactions`.
- **`cycle_month` derivation** (used when `/card statement` omits `[cycle_month]`, pure fn `deriveCycleMonth(statementDay, today)`):
  - If `today.day >= statement_day` → `cycle_month = format(today, 'YYYY-MM')` (this statement_day just passed → current month is the cycle that just closed)
  - Else → `cycle_month = format(today − 1 month, 'YYYY-MM')` (statement_day is still ahead this month → previous month is the cycle to close)
  - Rationale: correct even when the user logs the statement several days *after* it closed.
- **Default `due_date`** (used when `/card statement` omits `[due_date]`): `card.due_day` in the month AFTER `cycle_month`. Matches the standard CC billing convention (statement closes → grace period → due next month) and composes with the derivation above.
- **Next due date** for `/card due` and reminders:
  - If there is an open statement cycle, use its `due_date`.
  - Otherwise, compute from `card.due_day` for the current or next month, whichever comes first.
- **Payment cycle picker**: when logging a payment, bot lists open cycles as inline buttons (`Mar 2026 — ₱12,340 due Apr 15`). User must pick one before the confirm step. If no open cycles exist, bot warns and offers "Log without cycle link" or "Cancel".

## Reminders

- `node-cron` job registered on bot startup: schedule `0 21 * * *` with an **explicit** `{ timezone: process.env.TZ || 'Asia/Manila' }` option. Skipped when `NODE_ENV=test`.
- **Timezone plumbing:** `docker-compose.yml` sets `TZ=Asia/Manila` on the bot container so wall-clock time everywhere in the process matches PHT. Container default is UTC; without both the container `TZ` and the explicit `timezone` option to `node-cron`, the job would fire ~8 hours off.
- **Two-phase execution** to keep the ~27/30 no-reminder days cheap:
  1. Read `CreditCards` only. For each card, compute the estimated next-due date from `due_day`. If no card is 0 or 3 days from due, exit — no further reads.
  2. For matching cards, read `CardStatements` for the authoritative statement amount, then send.
- For each matching card, send a Telegram message to every ID in `ALLOWED_USER_IDS`.
- Message format:
  ```
  💳 *Due reminder*
  BPI-Gold (…1234) — ₱12,340 due in 3 days (Apr 15)
  ```
- Reminders are stateless (no dedupe store). Running the cron twice on the same day would double-send — acceptable for v1 since the schedule is once/day.

## Code Style

Mirror the existing `bot/index.js` conventions: `console.log` with emoji prefixes for observability, `bot.sendMessage` with Markdown, inline keyboards for choice UX. Prefer small pure functions in `card/balance.js` so tests don't need Sheets/Telegram mocks.

Example (confirm flow, matching the existing receipt pattern):

```js
async function sendCardTxConfirmation(chatId, tx) {
  const summary =
    `💳 *${tx.type === 'purchase' ? 'Purchase' : 'Payment'}:*\n\n` +
    `• *Card:* ${tx.card_name}\n` +
    `• *Amount:* ₱${Number(tx.amount).toLocaleString()}\n` +
    (tx.category ? `• *Category:* ${tx.category}\n` : '') +
    (tx.statement_cycle ? `• *Cycle:* ${tx.statement_cycle}\n` : '') +
    `• *Date:* ${tx.tx_date}` +
    (tx.notes ? `\n• *Note:* ${tx.notes}` : '');

  const keyboard = [
    [{ text: '✅ Confirm', callback_data: 'card_tx_confirm' },
     { text: '✏️ Edit Amount', callback_data: 'card_tx_edit_amount' }],
    [{ text: '📅 Edit Date', callback_data: 'card_tx_edit_date' }],
    [{ text: '❌ Cancel', callback_data: 'card_tx_cancel' }],
  ];
  if (tx.type === 'purchase') {
    keyboard[1].unshift({ text: '📁 Edit Category', callback_data: 'card_tx_edit_category' });
  }

  await bot.sendMessage(chatId, summary, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}
```

## Testing Strategy

- **Framework:** Jest (already in use). Run `cd bot && npm test`.
- **Unit tests** (`card/__tests__/`, and colocated `*.test.js` alongside shared modules): balance computation, cycle open/closed logic, command string parsing (`/card add …`, `/card tx …`), and all validators (nickname/amount/limit/day).
- **State-machine tests**: `bot/confirm-flow.test.js` covers start → callback → text-input transitions, stale-button, mid-edit cancel, delegation-safe fall-through.
- **Sheet I/O tests**: `bot/card/sheets.js` accepts an injected `getDoc` seam. Tests use `bot/test-utils/fake-sheet.js` (in-memory doc with `sheetsByTitle`/`sheetsByIndex`) so no `google-spreadsheet` mocking is required. `/card rename` is covered here — highest-blast-radius operation.
- **Receipt-flow regression tests**: `bot/receipt-flow.test.js` guardrails the receipt confirm/edit/cancel behavior through the new shared confirm-flow.
- **Reminder tests**: `shouldRemind(dueDate, today)` boundary tests (week/month/leap-year/DST) and two-phase branch logic (no `CardStatements` read on non-firing days).
- **Manual verification**: end-to-end walkthrough in a real Telegram chat before merging — register a card, log a purchase, log a payment linked to a statement, run `/card list` and `/card due`, force a reminder by temporarily changing the cron expression to `*/1 * * * *`; revert after observing.
- **Coverage expectation:** all pure functions covered. Sheet I/O covered via the fake-sheet seam, not by mocking `google-spreadsheet`.

## Boundaries

**Always:**
- Run `npm test` before committing.
- Route new commands through the existing `handleQuery` dispatch in `bot/index.js` — do not spin up a second Express handler.
- Reuse `CATEGORIES` from `bot/categories.js` for purchase categorization; do not duplicate it.
- Follow the shared `bot/confirm-flow.js` state machine for every write to Sheets that has a preview step (do not fork a second confirm implementation).
- Validate all user-supplied strings/numbers through `bot/card/validators.js`.
- Read/write card sheets only through `bot/card/sheets.js` (the adapter seam). Do not touch `google-spreadsheet` directly from card handlers.
- Namespace callback_data by feature prefix (`receipt_*`, `card_*`) so the dispatch registry can route by prefix.

**Ask first:**
- Adding any new dependency besides `node-cron`.
- Changing the sheet schemas after they are first written (breaks the user's spreadsheet).
- Modifying anything in the existing receipt / `/add` / `/budget` / `/summary` flows.
- Adding a persistent store for reminder dedupe (would introduce state beyond Sheets).

**Never:**
- Auto-create sheet tabs or write to `Expenses` / `Budgets` from card handlers.
- Add OCR, photo parsing, or LLM calls to any `/card` command.
- Commit `google-sa.json`, `.env`, or any secret material.
- Remove or bypass the `ALLOWED_USER_IDS` check on any handler.
- Skip failing tests to ship.

## Success Criteria

- [ ] `/card add`, `/card list`, `/card rename`, `/card tx` (purchase + payment), `/card statement`, `/card due` all work end-to-end against a real Google Sheet.
- [ ] `/card add` rejects duplicate nicknames and invalid strings (regex, reserved words, length).
- [ ] `/card rename` rewrites all three tabs, or rolls back partial writes with a clear error.
- [ ] `/card statement` derives `cycle_month` correctly for both mid-cycle and before-statement-day entries.
- [ ] Payments require the user to pick an open statement cycle before confirmation.
- [ ] Running balance in `/card list` matches SUM(purchases) − SUM(payments) for each card, including negative balances.
- [ ] Reminder cron fires at 9 pm PHT (verified inside the bot container with `TZ=Asia/Manila`) and posts a message to every `ALLOWED_USER_IDS` when a card is 3 days from due or on the due date.
- [ ] No existing feature (receipt scan, `/add`, `/budget`, `/summary`) is affected. Existing test suite still passes.
- [ ] Card purchases never appear in `/summary` output or the `Expenses` sheet.

## Open Questions

None at spec time — all clarifications resolved. Reopen this section if implementation surfaces new decisions.

---

# Feature Extension: Purchase-Tagged Payments

**Added:** 2026-07-29

## Objective

When logging a payment via `/card tx <nickname> payment <amount>`, the picker now lists the card's **unpaid purchases** instead of open statement cycles. The user multi-selects which purchases the payment covers. The `statement_cycle` a payment settles is *derived* from the tagged purchases' dates, not user-picked.

**Why:** Cycle-level payment tracking hides which specific purchases have been paid off. Purchase-level tagging answers "did I pay for last Tuesday's grocery run yet?"

**Impact summary:**
- `/card tx payment` no longer shows a cycle picker. It shows an unpaid-purchase picker (multi-select).
- Legacy payments (existing rows with only `statement_cycle`, no `paid_purchases`) continue to count toward `computeOpenCycles` and `computeBalances`. Backward-compatible.
- `/card list`, `/card due`, and reminders are unchanged — they still consume cycle-level state, which is now derived from tagged purchases where present.

## Sheet Schema Changes

**`CardTransactions`** — add two columns (order shown; existing columns unchanged):
```
timestamp | tx_id | card_name | tx_date | type | amount | category | notes | statement_cycle | paid_purchases
```
- `tx_id` — short opaque ID (e.g. `p_a1b2c3d4`), assigned when a row is written. Every purchase and payment gets one. Immutable.
- `paid_purchases` — comma-separated `tx_id` list. Set only on payment rows that tag purchases. Empty on purchase rows and on legacy cycle-only payments.

**Migration posture:** new columns are additive. Existing rows have empty `tx_id`/`paid_purchases`. On read, `sheets.js` synthesizes a stable `tx_id` for legacy rows (e.g. `p_<epoch-from-timestamp>`) so tagging works — but the sheet is *not* backfilled automatically. Manual backfill is out of scope for this feature.

## Payment-Picker Flow

1. `/card tx BPI-Gold payment 500`
2. Bot loads unpaid purchases for BPI-Gold. A purchase is "unpaid" iff no existing payment row references its `tx_id` in `paid_purchases`. **Legacy cycle-only payments do NOT auto-mark any specific purchase as paid** — they only reduce the cycle's outstanding balance, as before.
3. Bot renders a multi-select keyboard, one row per unpaid purchase: `[◻] 2026-07-15 · Groceries · ₱120`. Tapping toggles selection (label flips to `[✓]`). The message header shows a live running total that updates on every toggle: `Selected: ₱420 / ₱500 typed  · 3 of 7 purchases`. Bottom row: `[✅ Done]  [❌ Cancel]`.
4. On `[✅ Done]`: bot delegates to the shared confirm-flow with a preview: `Payment: ₱500 · Card: BPI-Gold · Covers 3 purchases (₱420) · Cycle: 2026-07 · Excess ₱80 credits cycle`. Confirm writes the payment row.
5. If BPI-Gold has zero unpaid purchases: `⚠️ No unpaid purchases for BPI-Gold. Add one first, or use /card statement to close a cycle.` (No cycle-picker fallback in this command.)
6. If the user selects zero purchases and hits Done: `⚠️ Select at least one purchase, or Cancel.`

## Cycle Derivation from Tagged Purchases

At Confirm time, the payment row's `statement_cycle` is derived:
- For each tagged purchase, compute `deriveCycleMonth(card.statement_day, tx_date)`.
- If all tagged purchases fall in the same cycle → that becomes `statement_cycle`.
- If they span multiple cycles → `statement_cycle` is empty. Preview warns: `⚠️ These purchases span multiple cycles (2026-06, 2026-07). Cycle balance will not be updated.`

## Overpayment Handling (payment.amount > SUM(tagged))

- Tagged purchases are marked paid (their `tx_id` appears in `paid_purchases`).
- Excess flows into cycle-level accounting via the existing `computeOpenCycles` carryforward (from the Critical #2 fix): the payment credits its derived cycle by the *full* `amount` — not just SUM(tagged). Excess beyond the cycle's outstanding rolls forward to later cycles.
- Multi-cycle selection (empty `statement_cycle`): excess has nowhere to land at the cycle level. It still appears in `computeBalances` (SUM purchases − SUM payments). Preview surfaces this: `⚠️ ₱X excess cannot credit any cycle (multi-cycle selection).`

## New / Modified Modules

- **`bot/card/purchases.js`** *(new)*: pure functions.
  - `synthesizeTxId(row)` — deterministic ID for legacy rows without `tx_id`.
  - `listUnpaidPurchases(cardName, transactions)` — returns purchases whose `tx_id` is not in any payment row's `paid_purchases`. Case-insensitive card match. Legacy purchase rows get IDs synthesized on the fly.
  - `inferCycleFromPurchases(purchases, statementDay)` — returns `{ cycle_month }` or `{ multi: true, cycles: [...] }` or `{ empty: true }`.
- **`bot/card/purchase-picker.js`** *(new)*: stateful multi-select picker, keyed by chatId. Same two-phase architecture as `payment-flow.js` (picker phase → confirm-flow delegation). Picker phase owns a Map of `{ card_name, amount, allPurchases, selectedIds: Set, messageId }`. Toggle callbacks recompute the running total (SUM of selectedIds' amounts) and re-render via `editMessageText` so the header shows `Selected: ₱X / ₱Y typed · N of M purchases` with updated `[✓]`/`[◻]` button labels. Storing `messageId` lets us edit in place instead of spamming new messages.
- **`bot/card/sheets.js`** *(extended)*: `addTransaction` generates a `tx_id` if absent. `listTransactions` synthesizes `tx_id` for legacy rows on read (so downstream code sees a consistent shape). No mutation of existing purchase rows — paid state is always derived from payment rows.
- **`bot/card/commands.js`** *(modified)*: `handleTx`, payment branch, now calls `purchasePicker.start(...)` instead of `paymentFlow.start(...)`.
- **`bot/card/balance.js`** *(extended)*: `computeOpenCycles` unchanged in shape. Its `paid` accounting continues to sum by `statement_cycle`, so purchase-tagged payments (which derive `statement_cycle`) settle their cycle correctly. New purity: no behavior change for legacy payments.
- **`bot/card/payment-flow.js`** *(removed in Task E3)*: the cycle-picker payment flow is deleted. The purchase-tagged picker replaces it entirely — a corrective legacy payment can still be logged manually by adding a row to `CardTransactions` with `paid_purchases` empty.
- **`bot/two-phase-picker.js`** *(new, generic)*: reusable picker→confirm state machine. `bot/card/purchase-picker.js` composes it with card-specific `pickerRender` and `onPick`. Documented concurrency posture: a re-`start()` on the same chat silently replaces the pending state; old inline-keyboard messages remain visible, but their callbacks resolve against the new state and unknown tokens are treated as no-ops by the caller's `onPick`.

## Callback Naming

Picker + confirm phases share the same prefix `card_ppay_` (short for "purchase-tagged payment"). The two-phase-picker abstraction owns the `pick_` sub-namespace; the confirm-flow owns the rest:
- `card_ppay_pick_toggle_<tx_id>` — toggle a purchase selection.
- `card_ppay_pick_done` — advance to confirm-flow (blocked unless SUM(selected) === typed amount; see T4 constraint).
- `card_ppay_pick_cancel` — abort picker phase (intercepted before confirm-flow onStale).
- `card_ppay_confirm` / `card_ppay_edit_amount` / `card_ppay_edit_date` / `card_ppay_cancel` — confirm-phase callbacks.

**T4 sum-enforcement invariant:** the picker's Done button blocks progression unless the sum of selected purchases exactly equals the typed payment amount. Editing the amount later in the confirm phase is allowed (scalar edit) but does *not* re-open the picker — to change the tagged set the user cancels and starts a new /card tx. This keeps the confirm-flow's scalar-editor contract clean.

**P3 chattiness note:** each toggle triggers a Telegram `editMessageText` (~200ms round-trip). Practical UX ceiling is ~30 purchases per picker before latency becomes annoying; pagination is deferred until a real user hits the limit.

## Testing Strategy

- Unit: `synthesizeTxId` determinism; `listUnpaidPurchases` (empty tags, tagged, multi-tagged, legacy rows, case-insensitive card match, other-card exclusion); `inferCycleFromPurchases` (single-cycle, multi-cycle, empty, statement_day boundary).
- Unit: `computeOpenCycles` regression — a payment with `paid_purchases` set still credits its `statement_cycle` correctly; overpayment carries through.
- Integration: `purchase-picker.js` — toggle state persists across re-renders, running total updates correctly on toggle (SUM matches typed amount when all selected sums to typed; header shows counts), `editMessageText` is called instead of `sendMessage` on toggle, Done → confirm-flow with the right data, picker-phase Cancel doesn't onStale, zero-selection Done shows warning, foreign-prefix delegation returns false.
- Integration: `handleTx` payment path — routes to purchase-picker (not paymentFlow), empty-unpaid shows warning, happy path writes `CardTransactions` row with `tx_id`, `paid_purchases` (CSV, ordered by selection), derived `statement_cycle`.
- Backward-compat: every existing card test suite passes unchanged (cycle-only payment logic is not modified).

## Boundaries (Extension)

**Always (in addition to parent spec):**
- Generate `tx_id` at write time. Never expose it as a required user input field.
- Preserve legacy cycle-only payment semantics — do not backfill or mutate their rows.
- Escape user-controlled fields (card_name, notes, purchase categories) in Markdown-mode messages via `bot/markdown.js` (`escapeMd`).

**Ask first:**
- Backfilling `tx_id` into existing sheet rows.
- Removing `bot/card/payment-flow.js` (cycle picker) — currently retained for potential future use.
- Any UX change to `/card list`, `/card due`, or reminders (this extension is scoped to `/card tx payment`).
- Pagination of the picker keyboard (only if a real user hits Telegram's message-size limit).

**Never:**
- Mutate a purchase row to mark it "paid" — paid state is always derived from payment rows' `paid_purchases`.
- Edit or delete a payment row's `paid_purchases` after write. To correct a mistake the user logs a corrective payment; the audit trail stays intact.

## Success Criteria (Extension)

- [ ] `/card tx <nickname> payment <amount>` lists unpaid purchases with toggle buttons.
- [ ] Confirm writes a `CardTransactions` row with `tx_id`, `paid_purchases` (CSV), and a derived `statement_cycle`.
- [ ] Multi-cycle selection warns the user and leaves `statement_cycle` empty; the payment still tags the purchases correctly.
- [ ] Overpayment excess flows through the cycle carryforward (Critical #2 semantics preserved).
- [ ] Legacy payments (cycle-only, no `paid_purchases`) still count toward `computeOpenCycles` and `computeBalances`.
- [ ] `/card list`, `/card due`, and reminders show unchanged output for pre-existing data.
- [ ] Existing 316-test suite stays green; new suites cover picker, purchases module, and inference.
- [ ] Manual Telegram walkthrough: register card → log 3 purchases → pay 2 of them → verify `/card list` balance drops by the tagged sum + excess.

## Open Questions (Extension)

- Pagination when a card has 30+ unpaid purchases? Deferred until it bites.

