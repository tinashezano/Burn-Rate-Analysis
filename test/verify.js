/**
 * Checks the dashboard engine against the source workbook's "Burn Rate" tab.
 *
 * Every expected figure below was read from the workbook. Where the app is
 * expected to differ, the reason is stated and the difference is asserted
 * explicitly rather than tolerated.
 */
import { buildDashboard } from '../server/dashboard.js';
import { getDb } from '../server/db.js';

let pass = 0, fail = 0;
const fmt = (n) => (n === null || n === undefined ? 'null' : Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function check(name, actual, expected, tol = 0.02) {
  const ok = expected === null ? actual === null : Math.abs(actual - expected) <= tol;
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}: expected ${fmt(expected)}, got ${fmt(actual)} (delta ${fmt(actual - expected)})`); }
}

const db = getDb();
if (!db.prepare('SELECT COUNT(*) n FROM transactions').get().n) {
  console.error('No transactions loaded. Run `npm run seed` first.');
  process.exit(1);
}

const d = buildDashboard({});
const P = { apr: '2026-04-01', may: '2026-05-01', jun: '2026-06-01', aug: '2026-08-01' };

console.log('\nWorkbook "Burn Rate" tab — headline rows');
// Row 8 Opening Cash balance
check('Opening cash Apr', d.totals[P.apr].openingCash, 318958.40);
check('Opening cash May', d.totals[P.may].openingCash, 45368.58);
check('Opening cash Jun', d.totals[P.jun].openingCash, 256294.59);
check('Opening cash Aug', d.totals[P.aug].openingCash, 156362.69);

// Row 18 Revenue
check('Revenue Apr', d.totals[P.apr].revenue, 3173337.36);
check('Revenue May', d.totals[P.may].revenue, 2842680.88);
check('Revenue Jun', d.totals[P.jun].revenue, 2506885.11);
check('Revenue Aug', d.totals[P.aug].revenue, 2785698.57);

// Row 26 Cost of Sale
check('Cost of sale Apr', d.totals[P.apr].cos, 3544840.87);
check('Cost of sale May', d.totals[P.may].cos, 2883605.90);
check('Cost of sale Jun', d.totals[P.jun].cos, 2405864.36);
// Aug differs from the workbook by 31,011.55 — see the corrections block below.
check('Cost of sale Aug', d.totals[P.aug].cos, 3424685.20);

// Row 39 Gross Margin
check('Gross margin Apr', d.totals[P.apr].grossMargin, -371503.51);
check('Gross margin May', d.totals[P.may].grossMargin, -40925.02);
check('Gross margin Jun', d.totals[P.jun].grossMargin, 101020.75);
check('Gross margin Aug', d.totals[P.aug].grossMargin, -638986.63);

// Row 46 Expenditure
check('Expenditure Apr', d.totals[P.apr].expenditure, 695457.31);
check('Expenditure May', d.totals[P.may].expenditure, 469350.97);
check('Expenditure Jun', d.totals[P.jun].expenditure, 309168.12);

// Row 99 Gross Burn
check('Gross burn Apr', d.totals[P.apr].grossBurn, 4240298.18);
check('Gross burn May', d.totals[P.may].grossBurn, 3352956.87);
check('Gross burn Jun', d.totals[P.jun].grossBurn, 2715032.48);

// Row 70 Surplus / Deficit
check('Surplus/deficit Apr', d.totals[P.apr].surplus, -1066960.82);
check('Surplus/deficit May', d.totals[P.may].surplus, -310275.99);
check('Surplus/deficit Jun', d.totals[P.jun].surplus, -208147.37);

// Row 86 / 88 Closing cash
check('Closing cash Apr', d.totals[P.apr].closingCash, 45368.58);
check('Closing cash May', d.totals[P.may].closingCash, 256294.59);
check('Closing cash Jun', d.totals[P.jun].closingCash, 166647.22);
check('Statement closing Apr', d.totals[P.apr].statementClosing, 45368.58);
check('Statement closing May', d.totals[P.may].statementClosing, 256294.59);
check('Statement closing Jun', d.totals[P.jun].statementClosing, 166647.22);
check('Statement closing Aug', d.totals[P.aug].statementClosing, 3927862.72);

console.log('\nReconciliation — the difference row must be zero in every month');
for (const [label, p] of Object.entries(P)) {
  check(`Difference ${label}`, d.totals[p].difference, 0);
}

console.log('\nReconciliation — every account, every month');
for (const acc of d.cash) {
  for (const p of d.periods) {
    if (acc.statement[p] === null) continue;
    check(`${acc.name} ${p}`, acc.difference[p], 0);
  }
}

console.log('\nSpot checks on individual allocation lines');
const line = (section, code, p) => d.sections[section].lines.find((l) => l.code === code).values[p];
check('720* Kazang Apr', line('cos', '720*', P.apr), 1422636.76);
check('256* MTN recharge Apr', line('cos', '256*', P.apr), 890002);
check('259* Physical goods Apr', line('cos', '259*', P.apr), 796132.74);
check('316* Merchant commission Apr', line('cos', '316*', P.apr), 266082.97);
check('300* Accounting fees Apr', line('expense', '300*', P.apr), 36576.69);
check('427* Rent Apr', line('expense', '427*', P.apr), 111828.02);
check('470* Salaries Apr', line('expense', '470*', P.apr), 317457.07);
check('230.1* Payat Apr', line('revenue', '230.1*', P.apr), 1865695.80);
check('230.2* Paystacks Apr', line('revenue', '230.2*', P.apr), 1314280.54);
check('861* Investor cash Apr', line('funding', '861*', P.apr), 999371);
check('236* Refund Apr', line('revenue', '236*', P.apr), -6638.98);
check('% of burn: 720* Apr', line('cos', '720*', P.apr) / d.totals[P.apr].grossBurn, 0.3355039, 1e-6);

console.log('\nKnown workbook errors this app corrects');
// I67 on the Burn Rate tab is =-SUMIFS(...)+1997 — a hardcoded plug.
check('470* Salaries Aug (workbook plugs in +1,997)', line('expense', '470*', P.aug), 648430.26);
// I43/I44 still point at the April-June sheet, so August other income is lost.
check('Other income Aug (workbook reads the wrong sheet and shows 0)', d.totals[P.aug].otherIncome, 29014.90);
// Burn Rate row 30 (722* Routers) has no formula in the August column at all,
// so two August purchases are missing from the workbook's cost of sale.
check('722* Routers Aug (missing from the workbook entirely)', line('cos', '722*', P.aug), 31011.55);
check('Cost of sale Aug is 31,011.55 higher than the workbook',
      d.totals[P.aug].cos - 3393673.65, 31011.55);

console.log('\nData integrity');
const orphan = db.prepare(
  `SELECT COUNT(*) n FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL`).get().n;
check('No transactions without an account', orphan, 0);
const badPeriod = db.prepare(
  `SELECT COUNT(*) n FROM transactions WHERE period NOT LIKE '____-__-01'`).get().n;
check('Every transaction has a valid reporting month', badPeriod, 0);
const dupFp = db.prepare(
  'SELECT COUNT(*) n FROM (SELECT fingerprint FROM transactions GROUP BY fingerprint HAVING COUNT(*) > 1)').get().n;
check('No duplicate fingerprints', dupFp, 0);
check('July 2026 is reported as a gap', d.gaps.includes('2026-07-01') ? 1 : 0, 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
