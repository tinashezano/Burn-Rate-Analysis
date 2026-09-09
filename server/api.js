import { getDb, nowIso, audit } from './db.js';
import { buildDashboard, listPeriods, listAccounts } from './dashboard.js';
import { parseStatement, groupKey, fingerprint, periodOf } from './parse.js';
import { suggest, buildContext, categoriseUnallocated, applyCategory, normalise } from './categorise.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* --------------------------------------------------------------- accounts */

export function getAccounts() {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort_order, name').all();
  const periods = db.prepare('SELECT * FROM account_periods ORDER BY period').all();
  const stats = db.prepare(
    `SELECT account_id, COUNT(*) n, MIN(txn_date) first_date, MAX(txn_date) last_date,
            SUM(CASE WHEN coa_code IS NULL THEN 1 ELSE 0 END) unallocated
     FROM transactions GROUP BY account_id`).all();
  const byId = new Map(stats.map((s) => [s.account_id, s]));
  return {
    accounts: accounts.map((a) => ({ ...a, stats: byId.get(a.id) ?? { n: 0, unallocated: 0 } })),
    periods,
  };
}

export function saveAccount(body) {
  const db = getDb();
  const { id, code, name, account_number = '', kind = 'bank', sort_order = 100, active = 1 } = body;
  if (!name?.trim()) throw bad('Account name is required');
  if (id) {
    db.prepare(`UPDATE accounts SET code = ?, name = ?, account_number = ?, kind = ?,
                sort_order = ?, active = ? WHERE id = ?`)
      .run(code, name.trim(), account_number, kind, sort_order, active ? 1 : 0, id);
    audit('account', id, 'update', name);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  }
  const finalCode = (code || name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  db.prepare(`INSERT INTO accounts (code, name, account_number, kind, sort_order, active)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(finalCode, name.trim(), account_number, kind, sort_order, active ? 1 : 0);
  const created = db.prepare('SELECT * FROM accounts WHERE id = last_insert_rowid()').get();
  audit('account', created.id, 'create', name);
  return created;
}

/** Saves the opening balance and/or bank-statement closing balance for a month. */
export function saveAccountPeriod(body) {
  const db = getDb();
  const { account_id, period, opening_balance, statement_closing, note = '' } = body;
  if (!account_id || !/^\d{4}-\d{2}-01$/.test(period || '')) throw bad('account_id and period (YYYY-MM-01) are required');
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  db.prepare(
    `INSERT INTO account_periods (account_id, period, opening_balance, statement_closing, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, period) DO UPDATE SET
       opening_balance = excluded.opening_balance,
       statement_closing = excluded.statement_closing,
       note = excluded.note`
  ).run(account_id, period, num(opening_balance), num(statement_closing), note);
  audit('account_period', `${account_id}/${period}`, 'save',
        `opening=${opening_balance ?? '-'} closing=${statement_closing ?? '-'}`);
  return db.prepare('SELECT * FROM account_periods WHERE account_id = ? AND period = ?').get(account_id, period);
}

/* ----------------------------------------------------------- transactions */

export function getTransactions(q = {}) {
  const db = getDb();
  const where = [], params = [];
  if (q.account_id) { where.push('t.account_id = ?'); params.push(Number(q.account_id)); }
  if (q.period) { where.push('t.period = ?'); params.push(q.period); }
  if (q.code) { where.push('t.coa_code = ?'); params.push(q.code); }
  if (q.status === 'unallocated') where.push('t.coa_code IS NULL');
  if (q.status === 'auto') where.push("t.categorised_by = 'auto'");
  if (q.status === 'review') where.push("(t.coa_code IS NULL OR (t.categorised_by = 'auto' AND t.confidence < 0.9))");
  if (q.status === 'manual') where.push("t.categorised_by = 'manual'");
  if (q.search) { where.push('(t.description LIKE ? OR t.label LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  if (q.min_amount) { where.push('ABS(t.amount) >= ?'); params.push(Number(q.min_amount)); }
  if (q.direction === 'in') where.push('t.amount > 0');
  if (q.direction === 'out') where.push('t.amount < 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sortMap = { date: 't.txn_date', amount: 't.amount', description: 't.description', account: 'a.name' };
  const sortCol = sortMap[q.sort] || 't.txn_date';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(q.limit) || 100, 1000);
  const offset = Number(q.offset) || 0;

  const rows = db.prepare(
    `SELECT t.*, a.name AS account_name, a.code AS account_code, c.name AS coa_name, c.section
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN coa c ON c.code = t.coa_code
     ${clause} ORDER BY ${sortCol} ${dir}, t.id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const agg = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) money_in,
            SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) money_out,
            SUM(CASE WHEN t.coa_code IS NULL THEN 1 ELSE 0 END) unallocated
     FROM transactions t JOIN accounts a ON a.id = t.account_id ${clause}`).get(...params);

  return { rows, total: agg.total ?? 0, summary: agg, limit, offset };
}

export function updateTransaction(id, body) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw bad('Transaction not found', 404);

  if ('coa_code' in body || 'applySimilar' in body || 'createRule' in body) {
    return applyCategory({
      id, coaCode: body.coa_code || null, label: body.label ?? t.label,
      applySimilar: !!body.applySimilar, createRule: !!body.createRule,
      scopeAccount: body.scopeAccount !== false,
    });
  }
  const fields = [], params = [];
  for (const k of ['description', 'label', 'period', 'txn_date']) {
    if (k in body) { fields.push(`${k} = ?`); params.push(body[k]); }
  }
  if ('amount' in body) { fields.push('amount = ?'); params.push(Number(body.amount)); }
  if (!fields.length) throw bad('Nothing to update');
  fields.push('updated_at = ?'); params.push(nowIso());
  db.prepare(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
  audit('transaction', id, 'update', Object.keys(body).join(','));
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function bulkCategorise(body) {
  const db = getDb();
  const { ids = [], coa_code, label } = body;
  if (!ids.length) throw bad('No transactions selected');
  if (coa_code && !db.prepare('SELECT 1 FROM coa WHERE code = ?').get(coa_code)) throw bad(`Unknown code ${coa_code}`);
  const upd = db.prepare(
    `UPDATE transactions SET coa_code = ?, label = COALESCE(NULLIF(?, ''), label),
     categorised_by = 'manual', confidence = 1, updated_at = ? WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const id of ids) upd.run(coa_code || null, label ?? '', nowIso(), Number(id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit('transaction', ids.join(','), 'bulk-categorise', `${ids.length} -> ${coa_code}`);
  return { updated: ids.length };
}

export function deleteTransactions(ids) {
  const db = getDb();
  if (!ids?.length) throw bad('No transactions selected');
  const del = db.prepare('DELETE FROM transactions WHERE id = ?');
  db.exec('BEGIN');
  try { for (const id of ids) del.run(Number(id)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  audit('transaction', ids.join(','), 'delete', `${ids.length} deleted`);
  return { deleted: ids.length };
}

export function suggestFor(id) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw bad('Transaction not found', 404);
  return suggest({ description: t.description, accountId: t.account_id, amount: t.amount });
}

/* ----------------------------------------------------------------- import */

/** Parses an uploaded file and returns a preview without writing anything. */
export function previewImport(buffer, filename, opts = {}) {
  const parsed = parseStatement(buffer, filename, opts);
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort_order').all();

  const blocks = [];
  for (const sheet of parsed.sheets) {
    for (const [i, b] of sheet.blocks.entries()) {
      blocks.push({
        id: `${sheet.name}::${i}`,
        sheet: sheet.name,
        accountHint: b.accountHint,
        suggestedAccountId: matchAccount(accounts, b.accountHint)?.id ?? null,
        columns: b.cols,
        rowCount: b.rows.length,
        opening: b.opening,
        closing: b.closing,
        descending: b.descending,
        months: b.months,
        dateOrderSuspect: b.dateOrderSuspect,
        sample: b.rows.slice(0, 8),
        rows: b.rows,
      });
    }
  }
  if (!blocks.length) {
    throw bad('No statement rows found. The file needs a header row with at least a date column and an amount (or debit/credit) column.');
  }
  return { filename, sheetNames: parsed.sheetNames, blocks, accounts };
}

function matchAccount(accounts, hint) {
  if (!hint) return null;
  if (hint.number) {
    const byNum = accounts.find((a) => a.account_number && a.account_number === hint.number);
    if (byNum) return byNum;
  }
  if (hint.name) {
    const wanted = new Set(normalise(hint.name).split(' ').filter(Boolean));
    if (!wanted.size) return null;
    let best = null;
    for (const a of accounts) {
      const have = normalise(a.name).split(' ').filter(Boolean);
      if (!have.length) continue;
      // Whole-token overlap only: "account" must not count as a hit for "acc".
      const hits = have.filter((t) => wanted.has(t)).length;
      const score = hits / have.length;
      if (hits >= 2 && score >= 0.6 && (!best || score > best.score)) best = { a, score };
    }
    if (best) return best.a;
  }
  return null;
}

/**
 * Commits a previewed import. Rows already present are skipped, everything
 * else is inserted and then run through auto-categorisation.
 */
export function commitImport({ filename, blocks, note = '' }) {
  const db = getDb();
  if (!blocks?.length) throw bad('Nothing to import');

  const ctx = buildContext();
  const existingCount = db.prepare(
    `SELECT COUNT(*) n FROM transactions WHERE account_id = ? AND txn_date = ?
     AND LOWER(TRIM(description)) = ? AND ROUND(amount, 2) = ?`);
  const ins = db.prepare(
    `INSERT INTO transactions (account_id, txn_date, period, description, amount, coa_code, label,
       categorised_by, rule_id, confidence, batch_id, source, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let inserted = 0, skipped = 0, auto = 0;
  const perAccount = new Map();
  const batchSeen = new Map();

  db.exec('BEGIN');
  try {
    const batchId = db.prepare(
      `INSERT INTO import_batches (filename, account_id, imported_at, row_count, skipped_count, auto_count, note)
       VALUES (?, ?, ?, 0, 0, 0, ?)`).run(filename, blocks[0].accountId ?? null, nowIso(), note).lastInsertRowid;

    for (const block of blocks) {
      const accountId = Number(block.accountId);
      if (!accountId) throw bad('Every block being imported must be assigned to an account');
      for (const row of block.rows || []) {
        const amount = Math.round(Number(row.amount) * 100) / 100;
        if (!isFinite(amount)) { skipped++; continue; }
        const rec = { accountId, date: row.date, description: row.description ?? '', amount };
        const key = groupKey(rec);

        // Position of this row within its identical-looking group, counting
        // what is already stored plus what this batch has added so far.
        const already = existingCount.get(accountId, row.date, rec.description.toLowerCase().trim(), amount).n;
        const seen = batchSeen.get(key) ?? 0;
        if (seen < already) { batchSeen.set(key, seen + 1); skipped++; continue; }
        batchSeen.set(key, seen + 1);

        const code = row.code && db.prepare('SELECT 1 FROM coa WHERE code = ?').get(row.code) ? row.code : null;
        let coa = code, by = code ? 'import' : 'none', conf = code ? 1 : 0, ruleId = null, label = row.label ?? '';
        if (!coa) {
          const s = suggest({ description: row.description, accountId, amount }, ctx);
          if (s.coa_code && s.confidence >= 0.6) {
            coa = s.coa_code; by = 'auto'; conf = s.confidence; ruleId = s.rule_id;
            if (!label) label = s.label;
            auto++;
          }
        }
        const period = row.period && /^\d{4}-\d{2}-01$/.test(row.period) ? row.period : periodOf(row.date);
        ins.run(accountId, row.date, period, rec.description, amount, coa, label, by, ruleId, conf,
                batchId, `${filename} :: ${block.sheet ?? ''}`.trim(), fingerprint(rec, seen), nowIso(), nowIso());
        inserted++;

        const stats = perAccount.get(accountId) ?? { periods: new Map() };
        const pv = stats.periods.get(period) ?? { movement: 0, n: 0 };
        pv.movement += amount; pv.n++;
        stats.periods.set(period, pv);
        perAccount.set(accountId, stats);
      }

      // Capture the statement's own opening/closing balances so the period
      // reconciles against the bank rather than against itself. The opening
      // belongs to the block's earliest month and the closing to its latest,
      // whatever order the rows happen to arrive in.
      if (block.rows?.length) {
        const months = block.rows
          .map((r) => (r.period && /^\d{4}-\d{2}-01$/.test(r.period) ? r.period : periodOf(r.date)))
          .sort();
        const first = months[0];
        const last = months[months.length - 1];
        if (block.opening !== null && block.opening !== undefined) {
          upsertPeriod(db, accountId, first, { opening_balance: Number(block.opening) });
        }
        if (block.closing !== null && block.closing !== undefined) {
          upsertPeriod(db, accountId, last, { statement_closing: Number(block.closing) });
        }
      }
    }

    db.prepare('UPDATE import_batches SET row_count = ?, skipped_count = ?, auto_count = ? WHERE id = ?')
      .run(inserted, skipped, auto, batchId);
    db.exec('COMMIT');
    audit('import', batchId, 'commit', `${filename}: ${inserted} in, ${skipped} skipped, ${auto} auto-allocated`);
    return { batchId, inserted, skipped, auto };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function upsertPeriod(db, accountId, period, fields) {
  const existing = db.prepare(
    'SELECT * FROM account_periods WHERE account_id = ? AND period = ?').get(accountId, period);
  if (!existing) {
    db.prepare(`INSERT INTO account_periods (account_id, period, opening_balance, statement_closing, note)
                VALUES (?, ?, ?, ?, '')`)
      .run(accountId, period, fields.opening_balance ?? null, fields.statement_closing ?? null);
    return;
  }
  // Never silently overwrite a balance an accountant has already captured.
  const opening = existing.opening_balance ?? fields.opening_balance ?? null;
  const closing = fields.statement_closing ?? existing.statement_closing ?? null;
  db.prepare('UPDATE account_periods SET opening_balance = ?, statement_closing = ? WHERE account_id = ? AND period = ?')
    .run(opening, closing, accountId, period);
}

export function getImports() {
  return getDb().prepare(
    `SELECT b.*, a.name AS account_name FROM import_batches b
     LEFT JOIN accounts a ON a.id = b.account_id ORDER BY b.id DESC LIMIT 50`).all();
}

export function deleteBatch(id) {
  const db = getDb();
  const n = db.prepare('DELETE FROM transactions WHERE batch_id = ?').run(id).changes;
  db.prepare('DELETE FROM import_batches WHERE id = ?').run(id);
  audit('import', id, 'delete', `${n} transactions removed`);
  return { deleted: n };
}

/* ------------------------------------------------------------------ rules */

export function getRules() {
  return getDb().prepare(
    `SELECT r.*, c.name AS coa_name, a.name AS account_name FROM rules r
     LEFT JOIN coa c ON c.code = r.coa_code
     LEFT JOIN accounts a ON a.id = r.account_id
     ORDER BY r.active DESC, r.priority, r.id`).all();
}

export function saveRule(body) {
  const db = getDb();
  const { id, pattern, match_type = 'contains', account_id = null, coa_code, label = '', priority = 100, active = 1 } = body;
  if (!pattern?.trim()) throw bad('Pattern is required');
  if (!coa_code) throw bad('An account code is required');
  if (!db.prepare('SELECT 1 FROM coa WHERE code = ?').get(coa_code)) throw bad(`Unknown code ${coa_code}`);
  if (match_type === 'regex') { try { new RegExp(pattern); } catch { throw bad('Invalid regular expression'); } }
  if (id) {
    db.prepare(`UPDATE rules SET pattern = ?, match_type = ?, account_id = ?, coa_code = ?,
                label = ?, priority = ?, active = ? WHERE id = ?`)
      .run(pattern.trim(), match_type, account_id || null, coa_code, label, priority, active ? 1 : 0, id);
    audit('rule', id, 'update', pattern);
    return db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  }
  db.prepare(`INSERT INTO rules (pattern, match_type, account_id, coa_code, label, priority, origin, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`)
    .run(pattern.trim(), match_type, account_id || null, coa_code, label, priority, nowIso());
  const rule = db.prepare('SELECT * FROM rules WHERE id = last_insert_rowid()').get();
  audit('rule', rule.id, 'create', pattern);
  return rule;
}

export function deleteRule(id) {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id);
  audit('rule', id, 'delete');
  return { deleted: 1 };
}

/* --------------------------------------------------------- chart of accts */

export function getCoa() {
  const db = getDb();
  return db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.coa_code = c.code) AS usage_count
     FROM coa c ORDER BY c.section, c.sort_order, c.code`).all();
}

export function saveCoa(body) {
  const db = getDb();
  const { code, name, section, sort_order = 100, active = 1, original_code } = body;
  if (!code?.trim() || !name?.trim()) throw bad('Code and name are required');
  const valid = ['revenue', 'cos', 'other_income', 'expense', 'funding', 'transfer'];
  if (!valid.includes(section)) throw bad(`Section must be one of ${valid.join(', ')}`);
  if (original_code && original_code !== code) {
    db.prepare('UPDATE coa SET code = ?, name = ?, section = ?, sort_order = ?, active = ? WHERE code = ?')
      .run(code.trim(), name.trim(), section, sort_order, active ? 1 : 0, original_code);
  } else {
    db.prepare(`INSERT INTO coa (code, name, section, sort_order, active) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(code) DO UPDATE SET name = excluded.name, section = excluded.section,
                sort_order = excluded.sort_order, active = excluded.active`)
      .run(code.trim(), name.trim(), section, sort_order, active ? 1 : 0);
  }
  audit('coa', code, 'save', name);
  return db.prepare('SELECT * FROM coa WHERE code = ?').get(code.trim());
}

/* ------------------------------------------------------------- dashboards */

export function dashboard(query = {}) {
  const periods = query.periods ? String(query.periods).split(',').filter(Boolean) : null;
  return buildDashboard({ periods });
}

export function reconciliation(query = {}) {
  const d = buildDashboard({ periods: query.periods ? String(query.periods).split(',') : null });
  return { periods: d.periods, cash: d.cash, totals: d.totals, gaps: d.gaps, unallocated: d.unallocated };
}

export function meta() {
  const db = getDb();
  return {
    periods: listPeriods(),
    accounts: listAccounts(),
    coa: db.prepare('SELECT code, name, section FROM coa WHERE active = 1 ORDER BY section, sort_order').all(),
    counts: db.prepare(
      `SELECT COUNT(*) transactions,
              SUM(CASE WHEN coa_code IS NULL THEN 1 ELSE 0 END) unallocated,
              SUM(CASE WHEN categorised_by = 'auto' AND confidence < 0.9 THEN 1 ELSE 0 END) low_confidence
       FROM transactions`).get(),
  };
}

export { categoriseUnallocated };
