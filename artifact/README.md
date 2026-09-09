# Hosted version

`burn-rate.html` is the whole application as a single page, published as a
Claude Artifact so it can be opened and used without running a server:

**https://claude.ai/code/artifact/96905698-18f0-421e-8cdb-5a628ed5e297**

It carries the same burn rate calculation, statement parser, categorisation
engine and reconciliation as the Node app in the parent directory, and produces
figures that agree with it line for line.

## How it differs from the server version

| | Server app (`../server`) | Hosted page (`burn-rate.html`) |
|---|---|---|
| Storage | SQLite file on disk | The artifact's own document database |
| Access | Localhost, single machine | Anyone in the organisation who has the link |
| xlsx parsing | SheetJS on the server | SheetJS in the browser |
| Export | Writes a file | Offered through the viewer's download prompt |

Storage is shaped for a page rather than a server. Transactions are held in one
document per reporting month (`txns/YYYY-MM-01`), so a month loads in a single
read; an allocation a reviewer changes is written as a small `overrides/<id>`
document rather than by rewriting the month, which keeps every edit cheap.
`meta/config` holds the accounts and chart of accounts, `meta/periods` the
opening and statement closing balances.

## Re-seeding

`seed/` holds the documents the database was loaded with, extracted from the
source workbook. They map to document paths by filename: `meta_config.json` to
`meta/config`, `meta_periods.json` to `meta/periods`, and each
`txns_<period>.json` to `txns/<period>`.

## Updating the page

Edit `burn-rate.html` and republish it to the same artifact URL. The database
is separate from the page, so republishing does not disturb the transactions.
