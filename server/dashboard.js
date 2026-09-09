import { getDb } from './db.js';
import { SECTIONS, SECTION_ORDER } from './coa.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function listPeriods() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT period FROM transactions
    UNION SELECT period FROM account_periods
    ORDER BY period`).all();
  return rows.map((r) => r.period);
}

export function listAccounts() {
  return getDb().prepare(
    'SELECT * FROM accounts WHERE active = 1 ORDER BY sort_order, name').all();
}

/**
 * Builds the Burn Rate report for the requested periods.
 *
 * Follows the workbook's "Burn Rate" tab: opening cash by account, income,
 * cost of sale, gross margin, other income, expenditure, surplus/deficit,
 * balance sheet movements, closing cash, closing per bank statements and the
 * reconciling difference — plus a gross burn line and % of total burn columns.
 *
 * Two deliberate departures from the workbook, both to make the report tie:
 *  - every balance-sheet line carries its true signed cash effect (the workbook
 *    negates transfer rows 79-83 but not row 84);
 *  - transactions with no allocation are reported on their own line instead of
 *    being dropped, so the difference row reflects reality.
 */
export function buildDashboard({ periods } = {}) {
  const db = getDb();
  const allPeriods = listPeriods();
  const cols = (periods?.length ? periods : allPeriods).filter((p) => allPeriods.includes(p));
  const accounts = listAccounts();

  const coa = db.prepare('SELECT * FROM coa WHERE active = 1 ORDER BY section, sort_order').all();
  const coaByCode = new Map(coa.map((c) => [c.code, c]));

  // --- raw aggregates ------------------------------------------------------
  const byCode = new Map();   // `${code}|${period}` -> signed sum
  for (const row of db.prepare(
    `SELECT coa_code, period, SUM(amount) AS total, COUNT(*) AS n
     FROM transactions GROUP BY coa_code, period`).all()) {
    byCode.set(`${row.coa_code ?? ''}|${row.period}`, { total: row.total, n: row.n });
  }
  const byAccount = new Map();  // `${account_id}|${period}` -> signed sum
  for (const row of db.prepare(
    `SELECT account_id, period, SUM(amount) AS total, COUNT(*) AS n
     FROM transactions GROUP BY account_id, period`).all()) {
    byAccount.set(`${row.account_id}|${row.period}`, { total: row.total, n: row.n });
  }
  const apRows = db.prepare('SELECT * FROM account_periods').all();
  const apByKey = new Map(apRows.map((r) => [`${r.account_id}|${r.period}`, r]));

  const codeVal = (code, period) => byCode.get(`${code}|${period}`)?.total ?? 0;
  const codeCount = (code, period) => byCode.get(`${code}|${period}`)?.n ?? 0;

  // --- cash position per account, chained across every known period --------
  // The chain runs over all periods (not just the requested columns) so an
  // opening balance carried forward is still correct on a filtered view.
  const closingCalc = new Map();  // `${account_id}|${period}` -> number
  const openingOf = new Map();
  for (const acc of accounts) {
    let prevPeriod = null;
    for (const period of allPeriods) {
      const ap = apByKey.get(`${acc.id}|${period}`);
      let opening = ap?.opening_balance;
      if (opening === null || opening === undefined) {
        // Fall back to the prior month's statement close (what the workbook
        // does), then to the prior month's calculated close, then to zero.
        const prevAp = prevPeriod ? apByKey.get(`${acc.id}|${prevPeriod}`) : null;
        opening = prevAp?.statement_closing ?? (prevPeriod ? closingCalc.get(`${acc.id}|${prevPeriod}`) : null) ?? 0;
      }
      const movement = byAccount.get(`${acc.id}|${period}`)?.total ?? 0;
      openingOf.set(`${acc.id}|${period}`, opening);
      closingCalc.set(`${acc.id}|${period}`, opening + movement);
      prevPeriod = period;
    }
  }

  // --- section lines -------------------------------------------------------
  const sections = {};
  for (const key of SECTION_ORDER) {
    const meta = SECTIONS[key];
    const lines = coa.filter((c) => c.section === key).map((c) => {
      const values = {}, counts = {};
      for (const p of cols) {
        values[p] = r2(codeVal(c.code, p) * meta.sign);
        counts[p] = codeCount(c.code, p);
      }
      return { code: c.code, name: c.name, values, counts };
    });
    const total = {};
    for (const p of cols) total[p] = r2(lines.reduce((s, l) => s + l.values[p], 0));
    sections[key] = { key, title: meta.title, sign: meta.sign, lines, total };
  }

  // --- unallocated ---------------------------------------------------------
  // Zero-value rows (VAT summary notes, "provisional statement" markers and the
  // like) are counted separately: they are genuinely uncategorised but move no
  // cash, so nagging about them would bury the ones that matter.
  const unallocRows = db.prepare(`
    SELECT period, COUNT(*) AS n, SUM(amount) AS total,
           SUM(CASE WHEN ABS(amount) >= 0.005 THEN 1 ELSE 0 END) AS material
    FROM transactions
    WHERE coa_code IS NULL OR coa_code NOT IN (SELECT code FROM coa WHERE active = 1)
    GROUP BY period`).all();
  const unallocByPeriod = new Map(unallocRows.map((r) => [r.period, r]));
  const unallocated = { values: {}, counts: {}, materialCounts: {} };
  for (const p of cols) {
    const row = unallocByPeriod.get(p);
    unallocated.values[p] = r2(row?.total ?? 0);
    unallocated.counts[p] = row?.n ?? 0;
    unallocated.materialCounts[p] = row?.material ?? 0;
  }

  // --- totals --------------------------------------------------------------
  const totals = {};
  for (const p of cols) {
    const revenue = sections.revenue.total[p];
    const cos = sections.cos.total[p];                 // positive = spend
    const otherIncome = sections.other_income.total[p];
    const expenditure = sections.expense.total[p];     // positive = spend
    const funding = sections.funding.total[p];
    const transfers = sections.transfer.total[p];
    const unalloc = unallocated.values[p];

    const income = r2(revenue + otherIncome);
    const grossMargin = r2(revenue - cos);
    const surplus = r2(revenue + otherIncome - cos - expenditure);
    const bsMovements = r2(funding + transfers);
    const grossBurn = r2(cos + expenditure);
    const netBurn = r2(grossBurn - income);            // positive = burning cash

    const openingTotal = r2(accounts.reduce((s, a) => s + (openingOf.get(`${a.id}|${p}`) ?? 0), 0));
    const closingCalcTotal = r2(openingTotal + surplus + bsMovements + unalloc);

    const stmtParts = accounts.map((a) => apByKey.get(`${a.id}|${p}`)?.statement_closing);
    const known = stmtParts.filter((v) => v !== null && v !== undefined);
    const stmtTotal = known.length ? r2(known.reduce((s, v) => s + v, 0)) : null;
    const missingStatements = accounts
      .filter((a, i) => (stmtParts[i] === null || stmtParts[i] === undefined) &&
                        (byAccount.has(`${a.id}|${p}`) || apByKey.has(`${a.id}|${p}`)))
      .map((a) => a.name);

    const difference = stmtTotal === null ? null : r2(closingCalcTotal - stmtTotal);
    // A month with no statement balance captured anywhere is still being
    // worked on: it is shown in the report but kept out of the headline
    // figures, which would otherwise read as a month of near-zero activity.
    const status = stmtTotal === null ? 'in_progress'
      : (difference !== null && Math.abs(difference) < 0.01 && !missingStatements.length) ? 'reconciled'
      : 'unreconciled';

    totals[p] = {
      revenue, cos, otherIncome, expenditure, funding, transfers, unallocated: unalloc,
      income, grossMargin, surplus, bsMovements, grossBurn, netBurn,
      openingCash: openingTotal,
      closingCash: closingCalcTotal,
      statementClosing: stmtTotal,
      difference,
      missingStatements,
      status,
      netCashFlow: r2(surplus + bsMovements + unalloc),
    };
  }

  // --- % of total burn (workbook columns D/F/H/J) --------------------------
  for (const key of ['cos', 'expense']) {
    for (const line of sections[key].lines) {
      line.pct = {};
      for (const p of cols) {
        const burn = totals[p].grossBurn;
        line.pct[p] = burn ? line.values[p] / burn : 0;
      }
    }
    sections[key].pct = {};
    for (const p of cols) {
      const burn = totals[p].grossBurn;
      sections[key].pct[p] = burn ? sections[key].total[p] / burn : 0;
    }
  }

  // --- cash rows per account ----------------------------------------------
  const cash = accounts.map((a) => {
    const opening = {}, movement = {}, closing = {}, statement = {}, difference = {};
    for (const p of cols) {
      opening[p] = r2(openingOf.get(`${a.id}|${p}`) ?? 0);
      movement[p] = r2(byAccount.get(`${a.id}|${p}`)?.total ?? 0);
      closing[p] = r2(closingCalc.get(`${a.id}|${p}`) ?? 0);
      const s = apByKey.get(`${a.id}|${p}`)?.statement_closing;
      statement[p] = s ?? null;
      difference[p] = s === null || s === undefined ? null : r2(closing[p] - s);
    }
    return { id: a.id, code: a.code, name: a.name, kind: a.kind,
             account_number: a.account_number, opening, movement, closing, statement, difference };
  });

  // --- burn metrics --------------------------------------------------------
  // Headline figures use reported months only, so a part-imported month cannot
  // drag the average burn down or overstate the runway.
  const reported = cols.filter((p) => totals[p].status !== 'in_progress');
  const focusPeriod = reported[reported.length - 1] ?? cols[cols.length - 1] ?? null;
  const burnWindow = reported.slice(-3);
  const mean = (key) => (burnWindow.length
    ? r2(burnWindow.reduce((s, p) => s + totals[p][key], 0) / burnWindow.length) : 0);
  const avgNetBurn = mean('netBurn');
  const cashOnHand = focusPeriod ? totals[focusPeriod].closingCash : 0;
  const metrics = {
    periodsUsed: burnWindow,
    inProgress: cols.filter((p) => totals[p].status === 'in_progress'),
    avgNetBurn, avgGrossBurn: mean('grossBurn'), cashOnHand,
    runwayMonths: avgNetBurn > 0 ? r2(cashOnHand / avgNetBurn) : null,
  };

  // Months with no data between the first and last reported period.
  const gaps = findGaps(cols);

  return { periods: cols, allPeriods, accounts, sections, unallocated, totals, cash, metrics, gaps, focusPeriod };
}

function findGaps(cols) {
  if (cols.length < 2) return [];
  const gaps = [];
  const toIdx = (p) => { const [y, m] = p.split('-').map(Number); return y * 12 + (m - 1); };
  for (let i = 1; i < cols.length; i++) {
    for (let k = toIdx(cols[i - 1]) + 1; k < toIdx(cols[i]); k++) {
      gaps.push(`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`);
    }
  }
  return gaps;
}
