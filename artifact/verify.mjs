/**
 * Checks the hosted single-page build against the source workbook.
 *
 * The page reads its data from the artifact's document store, which only
 * exists on claude.ai, so this serves burn-rate.html locally behind a stub
 * `claude.use("db")` backed by the same seed documents the live database was
 * loaded with, then reads the figures off the running page.
 *
 *   node artifact/verify.mjs
 *
 * Needs Playwright and a Chromium build; set CHROMIUM to override the path.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4100;

/* ---- the seed documents, keyed by the path the page reads them from ---- */
const docs = {};
for (const file of readdirSync(join(HERE, 'seed'))) {
  const body = JSON.parse(readFileSync(join(HERE, 'seed', file), 'utf8'));
  if (file === 'meta_config.json') docs['meta/config'] = body;
  else if (file === 'meta_periods.json') docs['meta/periods'] = body;
  else if (file.startsWith('txns_')) docs[`txns/${body.period}`] = body;
}

/* ---- wrap the page the way the Artifact runtime does ------------------- */
const STUB = `
const DOCS = ${JSON.stringify(docs)};
window.claude = { use: (name) => new Promise((resolve) => setTimeout(() => {
  if (name === "downloads") return resolve({ save: async () => ({}) });
  if (name !== "db") return resolve(null);
  const childrenOf = (c) => Object.keys(DOCS).filter((k) =>
    k.startsWith(c + "/") && k.split("/").length === c.split("/").length + 1);
  resolve({
    doc: (p) => ({
      get: async () => ({ id: p.split("/").pop(), exists: p in DOCS, data: () => DOCS[p] }),
      set: async (body) => { DOCS[p] = body; },
      delete: async () => { delete DOCS[p]; },
    }),
    collection: (c) => ({
      get: async () => ({ docs: childrenOf(c).map((k) => ({
        id: k.split("/").pop(), exists: true, data: () => DOCS[k] })) }),
    }),
  });
}, 30)) };`;

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
<script>${STUB}<\/script></head><body>${readFileSync(join(HERE, 'burn-rate.html'), 'utf8')}</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(PORT, '127.0.0.1');

/* ---- read the figures off the running page ----------------------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const tab = await browser.newPage({ viewport: { width: 1480, height: 1020 } });
const pageErrors = [];
tab.on('pageerror', (e) => pageErrors.push(e.message));
await tab.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await tab.waitForFunction(() => document.querySelector('.report tbody tr'), null, { timeout: 20000 });

const results = await tab.evaluate(() => {
  const r = buildReport();
  const P = { apr: '2026-04-01', may: '2026-05-01', jun: '2026-06-01', aug: '2026-08-01' };
  const line = (section, code, p) => r.sections[section].lines.find((l) => l.code === code).values[p];
  const out = [];
  const eq = (name, got, want) => out.push({ name, got, want, ok: Math.abs(got - want) < 0.02 });

  // Figures as printed on the workbook's "Burn Rate" tab.
  eq('Opening cash Apr', r.totals[P.apr].openingCash, 318958.40);
  eq('Revenue Apr', r.totals[P.apr].revenue, 3173337.36);
  eq('Cost of sale Apr', r.totals[P.apr].cos, 3544840.87);
  eq('Gross margin Apr', r.totals[P.apr].grossMargin, -371503.51);
  eq('Expenditure Apr', r.totals[P.apr].expenditure, 695457.31);
  eq('Surplus/deficit Apr', r.totals[P.apr].surplus, -1066960.82);
  eq('Gross burn Apr', r.totals[P.apr].grossBurn, 4240298.18);
  eq('Closing cash Apr', r.totals[P.apr].closingCash, 45368.58);
  eq('Closing cash May', r.totals[P.may].closingCash, 256294.59);
  eq('Closing cash Jun', r.totals[P.jun].closingCash, 166647.22);
  eq('Statement closing Aug', r.totals[P.aug].statementClosing, 3927862.72);
  eq('720* Kazang Apr', line('cos', '720*', P.apr), 1422636.76);
  eq('256* MTN recharge Apr', line('cos', '256*', P.apr), 890002);
  eq('470* Salaries Apr', line('expense', '470*', P.apr), 317457.07);
  eq('230.1* Payat Apr', line('revenue', '230.1*', P.apr), 1865695.80);
  eq('861* Investor cash Apr', line('funding', '861*', P.apr), 999371);

  // Workbook errors this build corrects — see ../README.md.
  eq('722* Routers Aug (absent from the workbook)', line('cos', '722*', P.aug), 31011.55);
  eq('Other income Aug (workbook reads the wrong sheet)', r.totals[P.aug].otherIncome, 29014.90);
  eq('470* Salaries Aug (workbook plugs in +1,997)', line('expense', '470*', P.aug), 648430.26);

  // The difference row must be nil in every month, and for every account.
  for (const p of Object.values(P)) eq(`Difference ${p}`, r.totals[p].difference, 0);
  let outstanding = 0;
  for (const a of r.cash) {
    for (const p of r.periods) {
      if (a.statement[p] !== null && Math.abs(a.difference[p]) >= 0.01) outstanding++;
    }
  }
  eq('Account-months that do not reconcile', outstanding, 0);
  eq('July 2026 reported as a gap', r.gaps.includes('2026-07-01') ? 1 : 0, 1);
  return out;
});

// Every view must render without throwing.
for (const view of ['transactions', 'accounts', 'import', 'rules']) {
  await tab.click(`.nav[data-v="${view}"]`);
  await tab.waitForTimeout(500);
}

await browser.close();
server.close();

for (const r of results) {
  console.log(r.ok ? `  ok   ${r.name}` : `  FAIL ${r.name}: expected ${r.want}, got ${r.got}`);
}
const failed = results.filter((r) => !r.ok).length;
// The CDN is unreachable in some sandboxes; that blocks fonts and SheetJS but
// not the calculation, so only real script errors count as failures here.
if (pageErrors.length) console.log('\nPage errors:\n' + pageErrors.map((e) => '  ' + e).join('\n'));
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed || pageErrors.length ? 1 : 0);
