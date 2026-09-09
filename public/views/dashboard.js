/**
 * The Burn Rate dashboard.
 *
 * Row for row this follows the "Burn Rate" tab of the source workbook: opening
 * cash by account, income, cost of sale, gross margin, other income,
 * expenditure, surplus/deficit, balance sheet movements, closing cash, closing
 * per bank statements, the difference, and gross burn — with a "% of Total
 * Burn" column beside every month.
 */
import { el, clear, fmt, fmtR, fmtPct, monthLabel, signClass, api, toast } from '../lib.js';
import { incomeVsBurn, cashTrend, burnComposition } from '../charts.js';

/** Month the KPI tiles and composition card describe. */
let focus = null;

export async function render(root, state) {
  clear(root);
  root.append(el('div', { class: 'empty' }, el('span', { class: 'spin' }), ' Loading…'));

  const d = await api.get('/api/dashboard');
  state.dashboard = d;
  clear(root);

  if (!d.periods.length) {
    root.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('p', {}, 'No transactions yet.'),
      el('button', { class: 'btn primary', onclick: () => state.go('import') }, 'Import a bank statement'))));
    return;
  }

  const m = d.metrics;
  // The headline figures describe one month; default to the latest month that
  // has been reported rather than one still being imported.
  if (!focus || !d.periods.includes(focus)) focus = d.focusPeriod ?? d.periods[d.periods.length - 1];

  root.append(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h2', {}, 'Burn Rate Analysis'),
        el('p', {}, `Cash movement across ${d.accounts.length} accounts over `
          + `${d.periods.length} reporting month${d.periods.length === 1 ? '' : 's'}, `
          + `${monthLabel(d.periods[0], { short: true })} to ${monthLabel(d.periods[d.periods.length - 1], { short: true })}.`)),
      el('div', { class: 'spacer' }),
      el('label', { class: 'field' }, 'Headline month',
        el('select', {
          onchange: (e) => { focus = e.target.value; render(root, state); },
        }, d.periods.map((p) => el('option', { value: p, selected: p === focus },
          monthLabel(p, { short: true }) + (d.totals[p].status === 'in_progress' ? ' (in progress)' : ''))))),
      el('button', { class: 'btn', onclick: () => exportCsv(d) }, 'Export CSV')),
  );

  // --- alerts -------------------------------------------------------------
  const alerts = [];
  const offBy = d.periods.filter((p) => d.totals[p].difference !== null && Math.abs(d.totals[p].difference) >= 0.01);
  if (offBy.length) {
    alerts.push(el('div', { class: 'banner critical' }, el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Reconciliation difference. '),
        `${offBy.map((p) => `${monthLabel(p, { short: true })} is out by ${fmtR(d.totals[p].difference)}`).join('; ')}. `,
        'The calculated closing balance does not agree to the bank statements — see Accounts & Reconciliation.')));
  }
  const n = d.periods.reduce((s, p) => s + d.unallocated.materialCounts[p], 0);
  if (n) {
    const value = d.periods.reduce((s, p) => s + d.unallocated.values[p], 0);
    alerts.push(el('div', { class: 'banner warn' }, el('span', { class: 'ico' }, '?'),
      el('div', {}, el('strong', {}, `${n} transaction${n === 1 ? '' : 's'} not yet allocated, `
        + `${fmtR(value, { blankZero: false })} net. `),
        'They are included in the closing cash balance on their own line, but not in any income or expense category. ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); state.go('transactions', { status: 'unallocated' }); } },
          'Review them'), '.')));
  }
  const missing = d.periods.filter((p) => d.totals[p].missingStatements.length);
  if (missing.length) {
    alerts.push(el('div', { class: 'banner info' }, el('span', { class: 'ico' }, 'i'),
      el('div', {}, el('strong', {}, 'Closing balances outstanding. '),
        missing.map((p) => `${monthLabel(p, { short: true })}: ${d.totals[p].missingStatements.join(', ')}`).join('; '),
        '. Capture them under Accounts & Reconciliation so the month can be reconciled.')));
  }
  if (m.inProgress.length) {
    alerts.push(el('div', { class: 'banner info' }, el('span', { class: 'ico' }, 'i'),
      el('div', {}, el('strong', {},
        `${m.inProgress.map((p) => monthLabel(p, { short: true })).join(', ')} `
        + `${m.inProgress.length === 1 ? 'is' : 'are'} still in progress. `),
        'No bank statement closing balance has been captured, so '
        + `${m.inProgress.length === 1 ? 'this month is' : 'these months are'} excluded from the `
        + 'average burn and runway figures.')));
  }
  if (d.gaps.length) {
    alerts.push(el('div', { class: 'banner warn' }, el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Missing month'
        + (d.gaps.length === 1 ? '' : 's') + '. '),
        `No transactions have been imported for ${d.gaps.map((g) => monthLabel(g, { short: true })).join(', ')}. `,
        'Cash carried forward across the gap, so period-on-period movement will not agree.')));
  }
  if (alerts.length) root.append(...alerts);

  // --- KPI tiles ----------------------------------------------------------
  const t = d.totals[focus];
  const fLabel = monthLabel(focus, { short: true });
  root.append(el('div', { class: 'kpis' },
    kpi('Cash on hand', fmtR(t.closingCash, { blankZero: false }), `Closing balance, ${fLabel}`,
        t.closingCash < 0 ? 'neg' : ''),
    kpi('Net cash burn', fmtR(t.netBurn, { blankZero: false }),
        t.netBurn > 0 ? `Cash consumed in ${fLabel}` : `Cash generated in ${fLabel}`,
        t.netBurn > 0 ? 'neg' : 'pos'),
    kpi('Gross burn', fmtR(t.grossBurn, { blankZero: false }), `Cost of sale + expenditure, ${fLabel}`),
    kpi('Avg net burn', fmtR(m.avgNetBurn, { blankZero: false }),
        m.periodsUsed.length
          ? `Mean of ${m.periodsUsed.map((p) => monthLabel(p, { short: true })).join(', ')}`
          : 'No reported months yet',
        m.avgNetBurn > 0 ? 'neg' : 'pos'),
    kpi('Runway', m.runwayMonths === null ? 'n/a' : `${m.runwayMonths.toFixed(1)} months`,
        m.runwayMonths === null ? 'Cash generative — no burn to project' : 'Cash on hand ÷ average net burn',
        m.runwayMonths !== null && m.runwayMonths < 6 ? 'neg' : '')));

  // --- charts -------------------------------------------------------------
  root.append(el('div', { class: 'chart-grid' },
    card('Income against burn', 'Both series in rands on one scale', incomeVsBurn(d.periods, d.totals)),
    card('Closing cash balance', 'Calculated closing cash by month', cashTrend(d.periods, d.totals)),
  ));
  root.append(card(`Largest burn categories — ${monthLabel(focus)}`,
    'Share of gross burn', burnComposition(d, focus)));

  // --- the report ---------------------------------------------------------
  root.append(reportCard(d, state));
}

const kpi = (k, v, s, cls = '') =>
  el('div', { class: 'kpi' }, el('div', { class: 'k' }, k),
    el('div', { class: `v ${cls}`.trim() }, v), el('div', { class: 's' }, s));

const card = (title, sub, ...body) =>
  el('div', { class: 'card' },
    el('header', {}, el('h3', {}, title), sub ? el('span', { class: 'sub' }, sub) : null),
    el('div', { class: 'body' }, ...body));

/* ------------------------------------------------------------------ report */

function reportCard(d, state) {
  const cols = d.periods;
  const table = el('table', { class: 'report' });

  const head = el('tr', {}, el('th', { colspan: 2 }, 'Acc'));
  for (const p of cols) {
    const st = d.totals[p].status;
    head.append(
      el('th', { class: 'period', title: st === 'in_progress' ? 'No statement closing balance captured yet' : '' },
        el('span', { class: 'm' }, monthLabel(p, { short: true })),
        st === 'in_progress' ? 'In progress' : st === 'unreconciled' ? 'Actual — unreconciled' : 'Actual'),
      el('th', { class: 'period' }, '% of Total Burn'));
  }
  table.append(el('thead', {}, head));
  const body = el('tbody');
  table.append(body);

  const row = (opts) => {
    const { code = '', label, values, pct = null, cls = '', onClick = null, count = null } = opts;
    const tr = el('tr', { class: `${cls}${onClick ? ' clickable' : ''}`.trim() });
    if (onClick) {
      tr.addEventListener('click', onClick);
      tr.tabIndex = 0;
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(e); });
    }
    tr.append(el('td', { class: 'code' }, code), el('td', { class: 'label' }, label));
    for (const p of cols) {
      const v = values?.[p];
      tr.append(
        el('td', { class: `num${signClass(v)}` }, v === null || v === undefined ? '—' : fmt(v)),
        el('td', { class: 'num pct' }, pct ? fmtPct(pct[p]) : ''));
    }
    if (count && cols.every((p) => !values?.[p]) && cols.every((p) => !count[p])) tr.classList.add('zero');
    return tr;
  };

  const spacer = () => el('tr', { class: 'spacer' }, el('td', { colspan: 2 + cols.length * 2 }));
  const sectionHead = (text) => el('tr', { class: 'section-head' },
    el('td', { colspan: 2 + cols.length * 2 }, el('span', {}, text)));

  const totalsRow = (key) => Object.fromEntries(cols.map((p) => [p, d.totals[p][key]]));
  const drill = (query) => (e) => { e.preventDefault(); state.go('transactions', query); };

  // Opening cash balance, by account.
  body.append(row({ label: 'Opening Cash balance', values: Object.fromEntries(cols.map((p) => [p, d.totals[p].openingCash])), cls: 'total' }));
  for (const a of d.cash) body.append(row({ label: a.name, values: a.opening, cls: 'subtle' }));
  body.append(spacer());

  // Income.
  body.append(row({ label: 'INCOME', values: totalsRow('income'), cls: 'grand' }));
  body.append(sectionHead(d.sections.revenue.title));
  for (const l of d.sections.revenue.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(row({ label: 'Total revenue', values: d.sections.revenue.total, cls: 'total' }));
  body.append(spacer());

  // Cost of sale.
  body.append(sectionHead('Cost of Sale'));
  for (const l of d.sections.cos.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, pct: l.pct, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(row({ label: 'Total cost of sale', values: d.sections.cos.total, pct: d.sections.cos.pct, cls: 'total' }));
  body.append(row({ label: 'Gross Margin', values: totalsRow('grossMargin'), cls: 'grand' }));
  body.append(spacer());

  // Other income.
  body.append(sectionHead('Other Income'));
  for (const l of d.sections.other_income.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(row({ label: 'Total other income', values: d.sections.other_income.total, cls: 'total' }));
  body.append(spacer());

  // Expenditure.
  body.append(row({ label: 'EXPENDITURE', values: totalsRow('expenditure'), pct: d.sections.expense.pct, cls: 'grand' }));
  for (const l of d.sections.expense.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, pct: l.pct, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(spacer());
  body.append(row({ label: 'Surplus / Deficit', values: totalsRow('surplus'), cls: 'grand' }));
  body.append(spacer());

  // Balance sheet movements.
  body.append(row({ label: 'Balance sheet movements', values: totalsRow('bsMovements'), cls: 'total' }));
  body.append(sectionHead('Investment from investor'));
  for (const l of d.sections.funding.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(sectionHead('Transfers'));
  for (const l of d.sections.transfer.lines) {
    body.append(row({ code: l.code, label: l.name, values: l.values, count: l.counts,
                      onClick: drill({ code: l.code }) }));
  }
  body.append(spacer());

  // Anything still unallocated has to appear, or the closing balance will not tie.
  if (cols.some((p) => d.unallocated.materialCounts[p] || d.unallocated.values[p])) {
    body.append(row({ label: 'Not yet allocated', values: d.unallocated.values, cls: 'total',
                      onClick: drill({ status: 'unallocated' }) }));
    body.append(spacer());
  }

  // Closing and reconciliation.
  body.append(row({ label: 'Closing Cash balance', values: totalsRow('closingCash'), cls: 'grand' }));
  body.append(row({ label: 'Closing per Bank Statements', values: totalsRow('statementClosing'), cls: 'total' }));
  for (const a of d.cash) body.append(row({ label: a.name, values: a.statement, cls: 'subtle' }));
  const diff = totalsRow('difference');
  const diffRow = row({ label: 'Difference', values: diff, cls: 'total' });
  if (cols.some((p) => diff[p] !== null && Math.abs(diff[p]) >= 0.01)) diffRow.style.color = 'var(--critical)';
  body.append(diffRow, spacer());

  // Ratios.
  body.append(sectionHead('Ratio'));
  body.append(row({ label: 'Gross Burn Analysis', values: totalsRow('grossBurn'), cls: 'total' }));
  body.append(row({ label: 'Net cash burn', values: totalsRow('netBurn') }));
  body.append(row({ label: 'Net cash flow', values: totalsRow('netCashFlow') }));

  return el('div', { class: 'card' },
    el('header', {},
      el('h3', {}, 'Burn Rate'),
      el('span', { class: 'sub' }, 'Select any line to review the transactions behind it'),
      el('div', { class: 'spacer' })),
    el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table)));
}

/* ------------------------------------------------------------------ export */

function exportCsv(d) {
  const rows = [];
  const cols = d.periods;
  rows.push(['Code', 'Line', ...cols.flatMap((p) => [monthLabel(p, { short: true }), '% of total burn'])]);

  const push = (code, label, values, pct) =>
    rows.push([code, label, ...cols.flatMap((p) => {
      const v = values?.[p];
      return [v === null || v === undefined ? '' : v.toFixed(2), pct ? (pct[p] ?? 0).toFixed(4) : ''];
    })]);

  push('', 'Opening Cash balance', Object.fromEntries(cols.map((p) => [p, d.totals[p].openingCash])));
  for (const a of d.cash) push('', `  ${a.name}`, a.opening);
  push('', 'INCOME', Object.fromEntries(cols.map((p) => [p, d.totals[p].income])));
  for (const l of d.sections.revenue.lines) push(l.code, l.name, l.values);
  push('', 'Total revenue', d.sections.revenue.total);
  for (const l of d.sections.cos.lines) push(l.code, l.name, l.values, l.pct);
  push('', 'Total cost of sale', d.sections.cos.total, d.sections.cos.pct);
  push('', 'Gross Margin', Object.fromEntries(cols.map((p) => [p, d.totals[p].grossMargin])));
  for (const l of d.sections.other_income.lines) push(l.code, l.name, l.values);
  push('', 'Total other income', d.sections.other_income.total);
  push('', 'EXPENDITURE', Object.fromEntries(cols.map((p) => [p, d.totals[p].expenditure])), d.sections.expense.pct);
  for (const l of d.sections.expense.lines) push(l.code, l.name, l.values, l.pct);
  push('', 'Surplus / Deficit', Object.fromEntries(cols.map((p) => [p, d.totals[p].surplus])));
  for (const l of d.sections.funding.lines) push(l.code, l.name, l.values);
  for (const l of d.sections.transfer.lines) push(l.code, l.name, l.values);
  push('', 'Balance sheet movements', Object.fromEntries(cols.map((p) => [p, d.totals[p].bsMovements])));
  push('', 'Not yet allocated', d.unallocated.values);
  push('', 'Closing Cash balance', Object.fromEntries(cols.map((p) => [p, d.totals[p].closingCash])));
  push('', 'Closing per Bank Statements', Object.fromEntries(cols.map((p) => [p, d.totals[p].statementClosing])));
  for (const a of d.cash) push('', `  ${a.name}`, a.statement);
  push('', 'Difference', Object.fromEntries(cols.map((p) => [p, d.totals[p].difference])));
  push('', 'Gross Burn Analysis', Object.fromEntries(cols.map((p) => [p, d.totals[p].grossBurn])));
  push('', 'Net cash burn', Object.fromEntries(cols.map((p) => [p, d.totals[p].netBurn])));

  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `burn-rate-${cols[0]}-to-${cols[cols.length - 1]}.csv` });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Burn rate report exported', 'ok');
}
