# Burn Rate Analysis

A web application for monthly cash burn analysis from bank statements. It imports
statements, keeps every transaction in one database, allocates transactions to a
chart of accounts, and produces a Burn Rate dashboard that reconciles to the
bank.

The dashboard follows the layout, headings and calculations of the **"Burn Rate"**
tab of the source workbook (`Qwili_Burn_Analysis.xlsx`), line for line.

## Running it

```bash
npm install
npm run seed      # loads the workbook data (skip for an empty file)
npm start         # http://127.0.0.1:4000
```

Requires Node 22.5 or later (it uses the built-in `node:sqlite`). The only
runtime dependency is SheetJS, for reading `.xlsx` uploads.

```bash
npm test          # checks the dashboard against the workbook's own figures
npm run reset     # wipes transactions and reloads the seed data
```

The database is a single SQLite file at `data/burn-rate.db` (override with
`BURN_DB`). Back it up by copying that file.

## What it does

**Import.** Drop an `.xlsx`, `.xls` or `.csv` statement onto the Import page.
The parser finds the header row, works out which columns hold the date,
narrative and amount (or a debit/credit pair), and reads the opening and closing
balances. A single file may contain several accounts stacked one after another —
each is detected separately and matched to an account by number or name. The
preview shows what was found, checks that opening + movements = closing, and
warns when statement dates look day/month swapped, before anything is written.

**One transaction database.** Every imported row lands in a single
`transactions` table with its account, date, reporting month, narrative, signed
amount and allocation. Re-importing a file adds nothing: identity is
(account, date, narrative, amount, *n*th occurrence), so two genuinely separate
payments of the same amount on the same day both survive while true duplicates
are skipped.

**Automatic categorisation.** Explicit rules run first. Where none matches, the
transaction is compared against how the same narrative was allocated before —
reference numbers and dates are stripped, so `PSTK_11243051016499363130` and
`PSTK_11253991016503312146` are recognised as the same payee. Exact matches on
the same account are near-certain; fuzzy token matches are offered at lower
confidence. Anything below 60% confidence is left unallocated for a human.

**Manual review.** The Transactions page filters by account, month, category,
direction, status or free text. Change one allocation inline, apply it to every
transaction with the same narrative, or select many and allocate them together.
"Remember this as a rule" turns a decision into a rule for future imports.

**Reconciliation.** Every account is tracked from its opening balance, through
the month's movements, to its calculated closing balance, and set against the
closing balance on the bank statement. The difference must be nil. Statement
balances are captured automatically on import where the file contains them, and
can be entered by hand.

**The dashboard updates itself.** Every figure is computed from the transaction
table on request — there is nothing to refresh or recalculate after an import or
an edit.

## How the report is calculated

| Line | Calculation |
|---|---|
| Opening Cash balance | Per account: the captured opening balance, else the prior month's statement close, else the prior month's calculated close |
| Revenue / Other income | Sum of transaction amounts for each code |
| Cost of sale / Expenditure | Sum of amounts, sign-flipped so spend reads positive |
| Gross Margin | Revenue − Cost of sale |
| Surplus / Deficit | (Revenue + Other income) − (Cost of sale + Expenditure) |
| Balance sheet movements | Funding and inter-account transfers, at their true signed cash effect |
| Closing Cash balance | Opening + Surplus/Deficit + Balance sheet movements + anything unallocated |
| Closing per Bank Statements | Sum of the captured statement closing balances |
| Difference | Closing Cash balance − Closing per Bank Statements |
| Gross Burn Analysis | Cost of sale + Expenditure |
| % of Total Burn | Line ÷ gross burn for that month |
| Net cash burn | Gross burn − Income |
| Runway | Cash on hand ÷ average net burn over the last three reported months |

Because the closing balance is built from the same transactions that drive every
other line, the difference row is a real check on the data rather than an
arithmetic identity: it goes non-zero when a transaction is missing, duplicated
or in the wrong month.

## Where this differs from the workbook

The seeded figures reproduce the workbook exactly for 167 of the 171 line-by-line
checks in `test/verify.js`. The remaining differences are workbook errors, and
the tests assert the corrected figures:

1. **`722*` Inventory/COS - Routers, August.** Burn Rate row 30 has no formula at
   all in the August column, so R31,011.55 of cost of sale is dropped. This
   raises August cost of sale to R3,424,685.20 and lowers gross margin to
   −R638,986.63.
2. **Other income, August.** Cells `I43` and `I44` still reference the
   April–June sheet, so August other income shows as nil instead of R29,014.90.
3. **`470*` Salaries and wages, August.** Cell `I67` is
   `=-SUMIFS(...)+1997` — a hardcoded plug. The true total is R648,430.26, not
   R650,427.26.
4. **Transfer signs.** The workbook negates transfer rows 79–83 but not row 84.
   Every balance-sheet line here carries its true signed cash effect, so
   `Closing = Opening + Surplus + Balance sheet movements` is an identity. This
   changes no reported total, because transfer pairs net to zero either way.

Two further points about the source data:

- **Statement dates were stored day/month swapped.** Excel read the DD/MM source
  as MM/DD, so 1 August 2026 was stored as 9 January 2026. The seed corrects
  this; the importer offers the same correction as a checkbox.
- **July 2026 is missing** from the workbook entirely, and the June closing
  balance (R166,647.22) does not equal the August opening balance
  (R156,362.69). The dashboard reports the gap rather than hiding it.

Unallocated transactions appear on their own line in the report instead of being
silently dropped, so the difference row stays honest. Zero-value statement notes
(VAT summaries, "provisional statement" markers) are counted separately from
transactions that actually move cash.

## Layout

```
server/
  index.js       HTTP server, routing, static files
  db.js          SQLite schema and migrations
  coa.js         chart of accounts and report sections
  parse.js       statement parsing: headers, dates, amounts, account blocks
  categorise.js  rules engine and learning from previous allocations
  dashboard.js   the burn rate calculation
  api.js         request handlers
public/
  app.js         router
  lib.js         DOM helpers, formatting, API client
  charts.js      inline SVG charts
  views/         one module per page
scripts/seed.js  loads data/qwili-seed.json
test/verify.js   checks the dashboard against the workbook
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meta` | accounts, periods, chart of accounts, review counts |
| GET | `/api/dashboard` | the full burn rate report |
| GET | `/api/reconciliation` | per-account balances and differences |
| GET/POST | `/api/accounts` | list and save accounts |
| POST | `/api/account-periods` | save opening and statement closing balances |
| GET | `/api/transactions` | filtered register |
| PATCH | `/api/transactions/:id` | re-allocate, optionally applying to similar |
| GET | `/api/transactions/:id/suggest` | suggested allocation and why |
| POST | `/api/transactions/bulk` | allocate many at once |
| POST | `/api/transactions/delete` | delete transactions |
| POST | `/api/categorise` | run auto-categorisation |
| POST | `/api/import/preview` | parse an upload without writing |
| POST | `/api/import/commit` | write a previewed import |
| GET/DELETE | `/api/imports[/:id]` | import history; undo a batch |
| GET/POST/DELETE | `/api/rules[/:id]` | categorisation rules |
| GET/POST | `/api/coa` | chart of accounts |

Uploads are sent as a raw body with the filename in an `X-Filename` header.

## Notes for deployment

The server binds to `127.0.0.1` by default and has no authentication, so it is
safe on a single workstation as written. Before putting it on a shared machine
or a network, put it behind an authenticating reverse proxy — client financial
data is readable by anyone who can reach the port.
