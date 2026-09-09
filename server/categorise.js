import { getDb, nowIso, audit } from './db.js';

/**
 * Normalises a bank narrative so that variants of the same payee collapse
 * together: case, punctuation, card/reference digits and dates are stripped.
 * "PSTK_11243051016499363130" and "PSTK_11253991016503312146" both become
 * "pstk", which is what makes learning from previous allocations work.
 */
export function normalise(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[*#]/g, ' ')
    .replace(/\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/g, ' ')  // dates
    .replace(/\d{4,}/g, ' ')                                   // long reference numbers
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(pty|ltd|inc|cc|the|and|ref|payment|pmt|eft|debit|credit|card|purchase|za|zar)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(desc) {
  return normalise(desc).split(' ').filter((t) => t.length > 2);
}

/** Jaccard overlap of the significant tokens of two narratives. */
function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function ruleMatches(rule, description) {
  const desc = String(description || '');
  const pat = rule.pattern;
  switch (rule.match_type) {
    case 'exact':  return normalise(desc) === normalise(pat);
    case 'starts': return normalise(desc).startsWith(normalise(pat));
    case 'regex':
      try { return new RegExp(pat, 'i').test(desc); } catch { return false; }
    default:       return normalise(desc).includes(normalise(pat));
  }
}

/**
 * Suggests an allocation for one transaction.
 *
 * Explicit rules win. Failing that, the transaction is matched against
 * previously allocated transactions: an exact normalised-narrative match on the
 * same account is treated as near-certain, a fuzzy token match is offered with
 * a lower confidence for the reviewer to confirm.
 */
export function suggest({ description, accountId, amount }, ctx) {
  const c = ctx || buildContext();

  for (const rule of c.rules) {
    if (rule.account_id && rule.account_id !== accountId) continue;
    if (ruleMatches(rule, description)) {
      return { coa_code: rule.coa_code, label: rule.label || '', confidence: 0.99,
               by: 'auto', rule_id: rule.id, reason: `rule: ${rule.match_type} "${rule.pattern}"` };
    }
  }

  const key = normalise(description);
  if (key) {
    const exact = c.history.get(key);
    if (exact) {
      const sameAccount = exact.byAccount.get(accountId);
      const pick = sameAccount?.top ?? exact.top;
      if (pick) {
        const pool = sameAccount ?? exact;
        const share = pick.count / pool.total;
        return { coa_code: pick.code, label: pick.label || '', by: 'auto', rule_id: null,
                 confidence: Math.min(0.97, 0.6 + 0.37 * share),
                 reason: `matches ${pick.count} previously allocated transaction(s) with the same narrative` };
      }
    }
    // Fuzzy fallback across learned narratives.
    let best = null;
    for (const [histKey, entry] of c.history) {
      const score = similarity(key, histKey);
      if (score >= 0.6 && (!best || score > best.score)) best = { score, entry, histKey };
    }
    if (best?.entry.top) {
      return { coa_code: best.entry.top.code, label: best.entry.top.label || '', by: 'auto',
               rule_id: null, confidence: Math.min(0.85, best.score * 0.9),
               reason: `similar to previously allocated "${best.histKey}" (${Math.round(best.score * 100)}% match)` };
    }
  }
  return { coa_code: null, label: '', confidence: 0, by: 'none', rule_id: null,
           reason: 'no previous allocation or rule matched' };
}

/** Loads rules and the allocation history once, for bulk categorisation. */
export function buildContext() {
  const db = getDb();
  const rules = db.prepare(
    'SELECT * FROM rules WHERE active = 1 ORDER BY priority, id').all();

  const history = new Map();
  const rows = db.prepare(`
    SELECT account_id, description, coa_code, label, COUNT(*) AS n
    FROM transactions
    WHERE coa_code IS NOT NULL AND description <> ''
    GROUP BY account_id, description, coa_code, label`).all();

  for (const r of rows) {
    const key = normalise(r.description);
    if (!key) continue;
    let entry = history.get(key);
    if (!entry) { entry = { total: 0, counts: new Map(), top: null, byAccount: new Map() }; history.set(key, entry); }
    tally(entry, r);
    let acc = entry.byAccount.get(r.account_id);
    if (!acc) { acc = { total: 0, counts: new Map(), top: null }; entry.byAccount.set(r.account_id, acc); }
    tally(acc, r);
  }
  return { rules, history };
}

function tally(bucket, r) {
  bucket.total += r.n;
  const cur = bucket.counts.get(r.coa_code) || { code: r.coa_code, count: 0, label: r.label };
  cur.count += r.n;
  if (r.label && !cur.label) cur.label = r.label;
  bucket.counts.set(r.coa_code, cur);
  if (!bucket.top || cur.count > bucket.top.count) bucket.top = cur;
}

/** Re-runs categorisation over transactions that have no allocation yet. */
export function categoriseUnallocated({ accountId = null, period = null, overwrite = false } = {}) {
  const db = getDb();
  const where = [overwrite ? '1=1' : 'coa_code IS NULL'];
  const params = [];
  if (accountId) { where.push('account_id = ?'); params.push(accountId); }
  if (period) { where.push('period = ?'); params.push(period); }
  const rows = db.prepare(
    `SELECT id, account_id, description, amount FROM transactions WHERE ${where.join(' AND ')}`).all(...params);

  const ctx = buildContext();
  const upd = db.prepare(
    `UPDATE transactions SET coa_code = ?, label = CASE WHEN label = '' THEN ? ELSE label END,
     categorised_by = 'auto', rule_id = ?, confidence = ?, updated_at = ? WHERE id = ?`);

  let applied = 0;
  db.exec('BEGIN');
  try {
    for (const t of rows) {
      const s = suggest({ description: t.description, accountId: t.account_id, amount: t.amount }, ctx);
      if (s.coa_code && s.confidence >= 0.6) {
        upd.run(s.coa_code, s.label, s.rule_id, s.confidence, nowIso(), t.id);
        if (s.rule_id) db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(s.rule_id);
        applied++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  audit('categorise', accountId ?? 'all', 'auto-run', `${applied}/${rows.length} allocated`);
  return { examined: rows.length, applied };
}

/**
 * Applies a category to one transaction and, optionally, to every other
 * transaction sharing its normalised narrative — the "apply to similar" action
 * a reviewer uses to clear a whole payee at once.
 */
export function applyCategory({ id, coaCode, label, applySimilar = false, createRule = false, scopeAccount = true }) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (coaCode && !db.prepare('SELECT 1 FROM coa WHERE code = ?').get(coaCode)) {
    throw Object.assign(new Error(`Unknown account code ${coaCode}`), { status: 400 });
  }

  db.prepare(
    `UPDATE transactions SET coa_code = ?, label = ?, categorised_by = 'manual',
     confidence = 1, rule_id = NULL, updated_at = ? WHERE id = ?`
  ).run(coaCode || null, label ?? t.label, nowIso(), id);
  audit('transaction', id, 'categorise', `${t.coa_code ?? '(none)'} -> ${coaCode ?? '(none)'}`);

  let alsoUpdated = 0;
  if (applySimilar && coaCode) {
    const key = normalise(t.description);
    const candidates = db.prepare(
      `SELECT id, description FROM transactions
       WHERE id <> ? AND (coa_code IS NULL OR coa_code <> ?) ${scopeAccount ? 'AND account_id = ?' : ''}`
    ).all(...(scopeAccount ? [id, coaCode, t.account_id] : [id, coaCode]));
    const upd = db.prepare(
      `UPDATE transactions SET coa_code = ?, label = CASE WHEN label = '' THEN ? ELSE label END,
       categorised_by = 'manual', confidence = 1, updated_at = ? WHERE id = ?`);
    db.exec('BEGIN');
    try {
      for (const c of candidates) {
        if (normalise(c.description) === key) { upd.run(coaCode, label ?? '', nowIso(), c.id); alsoUpdated++; }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit('transaction', id, 'apply-similar', `${alsoUpdated} transactions updated`);
  }

  let rule = null;
  if (createRule && coaCode) {
    const pattern = normalise(t.description).split(' ').slice(0, 3).join(' ') || t.description;
    const existing = db.prepare(
      'SELECT * FROM rules WHERE pattern = ? AND coa_code = ? AND active = 1').get(pattern, coaCode);
    if (existing) rule = existing;
    else {
      db.prepare(
        `INSERT INTO rules (pattern, match_type, account_id, coa_code, label, priority, origin, created_at)
         VALUES (?, 'contains', ?, ?, ?, 50, 'learned', ?)`
      ).run(pattern, scopeAccount ? t.account_id : null, coaCode, label ?? '', nowIso());
      rule = db.prepare('SELECT * FROM rules WHERE id = last_insert_rowid()').get();
      audit('rule', rule.id, 'create', `${pattern} -> ${coaCode}`);
    }
  }

  return { updated: 1, alsoUpdated, rule };
}
