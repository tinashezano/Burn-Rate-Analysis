import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_OF_ACCOUNTS } from './coa.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.BURN_DB || join(ROOT, 'data', 'burn-rate.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  account_number TEXT DEFAULT '',
  kind           TEXT NOT NULL DEFAULT 'bank',   -- bank | credit_card | cash
  currency       TEXT NOT NULL DEFAULT 'ZAR',
  sort_order     INTEGER NOT NULL DEFAULT 100,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coa (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  section    TEXT NOT NULL,   -- revenue|cos|other_income|expense|funding|transfer
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     INTEGER NOT NULL DEFAULT 1
);

-- One row per account per reporting month: the opening balance and the closing
-- balance as printed on the bank statement. Reconciliation compares the
-- calculated closing balance against statement_closing.
CREATE TABLE IF NOT EXISTS account_periods (
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,               -- 'YYYY-MM-01'
  opening_balance   REAL,                        -- NULL = carry forward prior close
  statement_closing REAL,                        -- NULL = not yet captured
  note              TEXT DEFAULT '',
  PRIMARY KEY (account_id, period)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id           INTEGER PRIMARY KEY,
  filename     TEXT NOT NULL,
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  imported_at  TEXT NOT NULL,
  row_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  auto_count   INTEGER NOT NULL DEFAULT 0,
  note         TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  txn_date     TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  period       TEXT NOT NULL,                    -- reporting month 'YYYY-MM-01'
  description  TEXT NOT NULL DEFAULT '',
  amount       REAL NOT NULL,                    -- signed: + money in, - money out
  coa_code     TEXT REFERENCES coa(code) ON DELETE SET NULL,
  label        TEXT DEFAULT '',                  -- free-text allocation note
  categorised_by TEXT NOT NULL DEFAULT 'none',   -- none|auto|manual|import
  rule_id      INTEGER,
  confidence   REAL NOT NULL DEFAULT 0,
  batch_id     INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  source       TEXT DEFAULT '',
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_txn_period  ON transactions(period);
CREATE INDEX IF NOT EXISTS ix_txn_account ON transactions(account_id, period);
CREATE INDEX IF NOT EXISTS ix_txn_code    ON transactions(coa_code, period);
CREATE INDEX IF NOT EXISTS ix_txn_fp      ON transactions(fingerprint);

-- Learned and hand-written categorisation rules.
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  pattern    TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',   -- contains|exact|starts|regex
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = any account
  coa_code   TEXT NOT NULL REFERENCES coa(code) ON DELETE CASCADE,
  label      TEXT DEFAULT '',
  priority   INTEGER NOT NULL DEFAULT 100,
  origin     TEXT NOT NULL DEFAULT 'manual',     -- manual|learned
  hits       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rules_active ON rules(active, priority);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at DESC);
`;

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  syncChartOfAccounts(db);
  return db;
}

/** Upserts the built-in chart of accounts without disturbing user edits. */
function syncChartOfAccounts(d) {
  const ins = d.prepare(
    `INSERT INTO coa (code, name, section, sort_order, active) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(code) DO NOTHING`
  );
  for (const a of CHART_OF_ACCOUNTS) ins.run(a.code, a.name, a.section, a.sort);
}

export function audit(entity, entityId, action, detail = '') {
  getDb().prepare(
    'INSERT INTO audit_log (at, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), entity, String(entityId), action, detail);
}

export function nowIso() {
  return new Date().toISOString();
}
