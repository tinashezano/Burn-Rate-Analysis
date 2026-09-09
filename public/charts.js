/**
 * Small inline-SVG charts.
 *
 * Colours are the validated categorical slots 1-3 read from CSS custom
 * properties, so light and dark mode both come from the same declarations.
 * Every chart carries a legend when it draws two series and direct labels on
 * the values, so identity never rests on colour alone.
 */
import { el, fmt, monthLabel } from './lib.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const niceCeil = (v) => {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag * 2) / 2 * mag;
};

const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return n.toFixed(0);
};

/** Tooltip shared by every chart on the page. */
function tip() {
  let node = document.getElementById('chartTip');
  if (!node) {
    node = el('div', { id: 'chartTip', role: 'tooltip' });
    node.style.cssText = `position:fixed;z-index:200;pointer-events:none;display:none;
      background:var(--surface);border:1px solid var(--border-strong);border-radius:6px;
      padding:7px 10px;font-size:12px;box-shadow:var(--shadow);white-space:nowrap;color:var(--text)`;
    document.body.append(node);
  }
  return node;
}

function bindTip(node, html) {
  node.addEventListener('pointerenter', (e) => {
    const t = tip(); t.innerHTML = html; t.style.display = 'block';
    t.style.left = `${Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 12)}px`;
    t.style.top = `${e.clientY - 38}px`;
  });
  node.addEventListener('pointermove', (e) => {
    const t = tip();
    t.style.left = `${Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 12)}px`;
    t.style.top = `${e.clientY - 38}px`;
  });
  node.addEventListener('pointerleave', () => { tip().style.display = 'none'; });
}

/**
 * Grouped bars comparing income against gross burn per month, with the closing
 * cash balance drawn as a line on the *same* scale — all three are rands, so
 * one axis serves them all.
 */
export function incomeVsBurn(periods, totals) {
  const W = 720, H = 260, padL = 54, padR = 14, padT = 16, padB = 42;
  const iw = W - padL - padR, ih = H - padT - padB;
  if (!periods.length) return el('div', { class: 'empty' }, 'No periods to chart yet.');

  const values = periods.flatMap((p) => [totals[p].income, totals[p].grossBurn, Math.max(0, totals[p].closingCash)]);
  const max = niceCeil(Math.max(1, ...values));
  const y = (v) => padT + ih - (v / max) * ih;
  const bandW = iw / periods.length;
  const barW = Math.min(38, (bandW - 14) / 2 - 1);   // 2px surface gap between the pair

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%',
                             role: 'img', 'aria-label': 'Income versus gross burn by month' });

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(
      svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v), opacity: i ? .55 : 1 }),
      svgEl('text', { class: 'axis', x: padL - 7, y: y(v) + 3.5, 'text-anchor': 'end' }, compact(v)));
  }

  periods.forEach((p, i) => {
    const t = totals[p];
    const cx = padL + bandW * i + bandW / 2;
    const pairs = [
      { v: t.income, color: 'var(--series-1)', name: 'Income', dx: -barW - 1 },
      { v: t.grossBurn, color: 'var(--series-2)', name: 'Gross burn', dx: 1 },
    ];
    for (const b of pairs) {
      const h = Math.max(1, (Math.max(0, b.v) / max) * ih);
      const rect = svgEl('rect', {
        class: 'bar', x: cx + b.dx, y: padT + ih - h, width: barW, height: h,
        rx: 4, ry: 4, fill: b.color,
      });
      bindTip(rect, `<strong>${monthLabel(p, { short: true })}</strong><br>${b.name}: R ${fmt(b.v, { blankZero: false })}`);
      svg.append(rect);
    }
    svg.append(svgEl('text', { class: 'axis', x: cx, y: H - 24, 'text-anchor': 'middle' },
      monthLabel(p, { short: true })));
    const net = t.netBurn;
    svg.append(svgEl('text', {
      class: 'dlabel', x: cx, y: H - 10, 'text-anchor': 'middle',
      fill: net > 0 ? 'var(--critical)' : 'var(--good)',
    }, `${net > 0 ? '−' : '+'}${compact(Math.abs(net))}`));
  });

  return el('div', {},
    svg,
    el('div', { class: 'legend', style: 'margin-top:8px' },
      el('span', {}, el('i', { style: 'background:var(--series-1)' }), 'Income'),
      el('span', {}, el('i', { style: 'background:var(--series-2)' }), 'Gross burn (cost of sale + expenditure)'),
      el('span', { class: 'muted' }, 'Figure below each month is net cash burn')));
}

/** Closing cash by month — one series, so no legend box; the title names it. */
export function cashTrend(periods, totals) {
  const W = 720, H = 220, padL = 54, padR = 42, padT = 16, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  if (periods.length < 2) return el('div', { class: 'empty' }, 'At least two months are needed for a trend.');

  const vals = periods.map((p) => totals[p].closingCash);
  const lo = Math.min(0, ...vals), hi = niceCeil(Math.max(1, ...vals));
  const y = (v) => padT + ih - ((v - lo) / (hi - lo)) * ih;
  const x = (i) => padL + (periods.length === 1 ? iw / 2 : (iw * i) / (periods.length - 1));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%',
                             role: 'img', 'aria-label': 'Closing cash balance by month' });
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) / 4) * i;
    svg.append(
      svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v), opacity: i ? .55 : 1 }),
      svgEl('text', { class: 'axis', x: padL - 7, y: y(v) + 3.5, 'text-anchor': 'end' }, compact(v)));
  }
  svg.append(svgEl('polyline', {
    fill: 'none', stroke: 'var(--series-3)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    points: periods.map((p, i) => `${x(i)},${y(totals[p].closingCash)}`).join(' '),
  }));
  periods.forEach((p, i) => {
    const v = totals[p].closingCash;
    // Anchor the end labels inward so neither is clipped by the frame.
    const anchor = i === 0 ? 'start' : i === periods.length - 1 ? 'end' : 'middle';
    // 2px surface ring keeps overlapping markers legible.
    const dot = svgEl('circle', { cx: x(i), cy: y(v), r: 4.5, fill: 'var(--series-3)',
                                  stroke: 'var(--surface)', 'stroke-width': 2 });
    bindTip(dot, `<strong>${monthLabel(p, { short: true })}</strong><br>Closing cash: R ${fmt(v, { blankZero: false })}`);
    svg.append(dot,
      svgEl('text', { class: 'axis', x: x(i), y: H - 12, 'text-anchor': anchor }, monthLabel(p, { short: true })),
      svgEl('text', { class: 'dlabel', x: x(i), y: y(v) - 11, 'text-anchor': anchor }, compact(v)));
  });
  return svg;
}

/** Top burn categories for one month — one hue, ordered by magnitude. */
export function burnComposition(dashboard, period, limit = 10) {
  const lines = [...dashboard.sections.cos.lines, ...dashboard.sections.expense.lines]
    .map((l) => ({ name: l.name, code: l.code, value: l.values[period], pct: l.pct?.[period] ?? 0 }))
    .filter((l) => l.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
  if (!lines.length) return el('div', { class: 'empty' }, 'No spend recorded in this month.');

  const max = Math.max(...lines.map((l) => l.value));
  return el('div', {},
    lines.map((l) => el('div', { style: 'display:grid;grid-template-columns:1fr 110px 56px;gap:14px;align-items:center;padding:5px 0' },
      el('div', {},
        el('div', { style: 'font-size:12.5px;margin-bottom:4px;display:flex;gap:8px;align-items:baseline' },
          el('span', { class: 'muted', style: 'font-family:var(--mono);font-size:11px;flex:none;min-width:44px' }, l.code),
          el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, l.name)),
        el('div', { style: 'height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden' },
          el('div', { style: `height:100%;width:${(l.value / max) * 100}%;background:var(--series-2);border-radius:4px` }))),
      el('div', { class: 'num', style: 'font-size:12px' }, fmt(l.value, { blankZero: false, decimals: 0 })),
      el('div', { class: 'num muted', style: 'font-size:11.5px' }, `${(l.pct * 100).toFixed(1)}%`))));
}
