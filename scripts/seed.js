/**
 * Loads the Qwili workbook extract into the database.
 *
 * The dataset in data/qwili-seed.json was read from the "ALL Bank statement
 * Aug" and "All Bank Statements- Apr- Jun26" tabs of the source workbook,
 * with the day/month order of the statement dates corrected (Excel had stored
 * them as MM/DD from DD/MM source data).
 *
 *   node scripts/seed.js            # seed if the database is empty
 *   node scripts/seed.js --reset    # wipe transactions first, then seed
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from '../server/db.js';
import { fingerprint } from '../server/parse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const reset = process.argv.includes('--reset');
const db = getDb();

const existing = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
if (existing && !reset) {
  console.log(`Database already holds ${existing} transactions. Use --reset to reload.`);
  process.exit(0);
}
if (reset) {
  db.exec('DELETE FROM transactions; DELETE FROM account_periods; DELETE FROM import_batches; DELETE FROM rules;');
  console.log('Cleared existing transactions, periods, imports and rules.');
}

const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'qwili-seed.json'), 'utf8'));

const insAcc = db.prepare(
  `INSERT INTO accounts (code, name, account_number, kind, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)
   ON CONFLICT(code) DO UPDATE SET name = excluded.name, account_number = excluded.account_number,
   kind = excluded.kind, sort_order = excluded.sort_order`);
for (const a of seed.accounts) insAcc.run(a.code, a.name, a.number, a.kind, a.sort);
const accountId = new Map(
  db.prepare('SELECT id, code FROM accounts').all().map((a) => [a.code, a.id]));

const batchId = db.prepare(
  `INSERT INTO import_batches (filename, account_id, imported_at, row_count, skipped_count, auto_count, note)
   VALUES (?, NULL, ?, 0, 0, 0, ?)`)
  .run('Qwili_Burn_Analysis.xlsx', nowIso(), 'Seeded from the source workbook').lastInsertRowid;

const insTxn = db.prepare(
  `INSERT INTO transactions (account_id, txn_date, period, description, amount, coa_code, label,
     categorised_by, rule_id, confidence, batch_id, source, fingerprint, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
const knownCodes = new Set(db.prepare('SELECT code FROM coa').all().map((c) => c.code));

let n = 0, unknown = new Map(), occurrence = new Map();
db.exec('BEGIN');
try {
  for (const t of seed.transactions) {
    const accId = accountId.get(t.account);
    const code = t.code && knownCodes.has(t.code) ? t.code : null;
    if (t.code && !code) unknown.set(t.code, (unknown.get(t.code) ?? 0) + 1);
    const rec = { accountId: accId, date: t.date, description: t.description, amount: t.amount };
    const key = `${accId}|${t.date}|${t.description.toLowerCase().trim()}|${t.amount.toFixed(2)}`;
    const occ = occurrence.get(key) ?? 0;
    occurrence.set(key, occ + 1);
    insTxn.run(accId, t.date, t.period, t.description, t.amount, code, t.label,
               code ? 'import' : 'none', code ? 1 : 0, batchId, t.source, fingerprint(rec, occ),
               nowIso(), nowIso());
    n++;
  }

  const insPeriod = db.prepare(
    `INSERT INTO account_periods (account_id, period, opening_balance, statement_closing, note)
     VALUES (?, ?, ?, ?, '') ON CONFLICT(account_id, period) DO UPDATE SET
     opening_balance = excluded.opening_balance, statement_closing = excluded.statement_closing`);
  for (const p of seed.periods) {
    insPeriod.run(accountId.get(p.account), p.period, p.opening ?? null, p.statement_closing ?? null);
  }
  db.prepare('UPDATE import_batches SET row_count = ? WHERE id = ?').run(n, batchId);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

console.log(`Seeded ${n} transactions across ${seed.accounts.length} accounts and ${seed.periods.length} account-periods.`);
if (unknown.size) {
  console.log('Allocation codes in the workbook that are not in the chart of accounts:');
  for (const [c, k] of unknown) console.log(`  ${c} (${k} transactions) -> left unallocated for review`);
}
const un = db.prepare('SELECT COUNT(*) n FROM transactions WHERE coa_code IS NULL').get().n;
console.log(`${un} transactions are unallocated and waiting for review.`);
