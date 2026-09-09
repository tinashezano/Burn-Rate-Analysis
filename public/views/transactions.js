/**
 * The transaction register: every imported transaction in one place, with
 * filtering, inline re-categorisation, bulk actions and an "apply to similar"
 * shortcut for clearing a whole payee at once.
 */
import { el, clear, fmt, fmtR, dateLabel, monthLabel, signClass, api, toast, modal, confirmDialog, formValues } from '../lib.js';

const PAGE = 100;
let filters = { status: 'all', limit: PAGE, offset: 0, sort: 'date', dir: 'desc' };
const selected = new Set();

export async function render(root, state, params = {}) {
  if (Object.keys(params).length) {
    filters = { status: 'all', limit: PAGE, offset: 0, sort: 'date', dir: 'desc', ...params };
    selected.clear();
  }
  clear(root);
  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h2', {}, 'Transactions'),
      el('p', {}, 'Every imported transaction. Change an allocation here and the dashboard '
        + 'updates the moment you return to it.')),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn', onclick: () => runAutoCategorise(root, state) }, 'Auto-categorise unallocated')));

  const filterBar = el('div', { class: 'card' });
  const results = el('div', { class: 'card' });
  root.append(filterBar, results);
  renderFilters(filterBar, state, root);
  await load(results, state, root);
}

function renderFilters(host, state, root) {
  clear(host);
  const reload = () => { filters.offset = 0; selected.clear(); render(root, state, filters); };

  host.append(el('div', { class: 'body' }, el('div', { class: 'toolbar' },
    field('Search', el('input', {
      type: 'search', name: 'search', value: filters.search ?? '', placeholder: 'Narrative or note…',
      style: 'min-width:220px',
      onchange: (e) => { filters.search = e.target.value.trim() || undefined; reload(); },
    })),
    field('Account', select(
      [{ v: '', t: 'All accounts' }, ...state.meta.accounts.map((a) => ({ v: String(a.id), t: a.name }))],
      filters.account_id ?? '', (v) => { filters.account_id = v || undefined; reload(); })),
    field('Month', select(
      [{ v: '', t: 'All months' }, ...state.meta.periods.map((p) => ({ v: p, t: monthLabel(p, { short: true }) }))],
      filters.period ?? '', (v) => { filters.period = v || undefined; reload(); })),
    field('Category', select(
      [{ v: '', t: 'All categories' }, ...state.meta.coa.map((c) => ({ v: c.code, t: `${c.code} — ${c.name}` }))],
      filters.code ?? '', (v) => { filters.code = v || undefined; reload(); })),
    field('Status', select([
      { v: 'all', t: 'All' },
      { v: 'review', t: 'Needs review' },
      { v: 'unallocated', t: 'Unallocated' },
      { v: 'auto', t: 'Auto-allocated' },
      { v: 'manual', t: 'Manually allocated' },
    ], filters.status ?? 'all', (v) => { filters.status = v; reload(); })),
    field('Direction', select([
      { v: '', t: 'In and out' }, { v: 'in', t: 'Money in' }, { v: 'out', t: 'Money out' },
    ], filters.direction ?? '', (v) => { filters.direction = v || undefined; reload(); })),
    el('button', {
      class: 'btn',
      onclick: () => { filters = { status: 'all', limit: PAGE, offset: 0, sort: 'date', dir: 'desc' }; selected.clear(); render(root, state, filters); },
    }, 'Clear filters'))));
}

const field = (label, control) => el('label', { class: 'field' }, label, control);

const select = (options, value, onChange) =>
  el('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => el('option', { value: o.v, selected: String(o.v) === String(value) }, o.t)));

async function load(host, state, root) {
  clear(host);
  host.append(el('div', { class: 'empty' }, el('span', { class: 'spin' }), ' Loading…'));

  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== 'all'));
  const data = await api.get('/api/transactions', query);
  clear(host);

  const s = data.summary;
  host.append(el('header', {},
    el('h3', {}, `${data.total.toLocaleString('en-ZA')} transaction${data.total === 1 ? '' : 's'}`),
    el('span', { class: 'sub' },
      `Money in ${fmtR(s.money_in ?? 0, { blankZero: false })} · `
      + `Money out ${fmtR(Math.abs(s.money_out ?? 0), { blankZero: false })} · `
      + `Net ${fmtR((s.money_in ?? 0) + (s.money_out ?? 0), { blankZero: false })}`
      + (s.unallocated ? ` · ${s.unallocated} unallocated` : '')),
    el('div', { class: 'spacer' }),
    el('span', { id: 'bulkbar' })));

  if (!data.rows.length) {
    host.append(el('div', { class: 'empty' }, 'No transactions match these filters.'));
    return;
  }

  const table = el('table');
  const allChecked = data.rows.every((r) => selected.has(r.id));
  table.append(el('thead', {}, el('tr', {},
    el('th', { class: 'rowsel' }, el('input', {
      type: 'checkbox', checked: allChecked, 'aria-label': 'Select all rows on this page',
      onchange: (e) => {
        for (const r of data.rows) e.target.checked ? selected.add(r.id) : selected.delete(r.id);
        load(host, state, root);
      },
    })),
    sortableTh('Date', 'date', host, state, root),
    el('th', {}, 'Account'),
    sortableTh('Description', 'description', host, state, root),
    sortableTh('Amount', 'amount', host, state, root, 'num'),
    el('th', {}, 'Allocated to'),
    el('th', {}, 'Source'),
    el('th', {}, ''))));

  const body = el('tbody');
  for (const t of data.rows) body.append(txnRow(t, host, state, root));
  table.append(body);
  host.append(el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table)));

  // Pager.
  const from = data.offset + 1, to = Math.min(data.offset + data.rows.length, data.total);
  host.append(el('div', { class: 'body', style: 'display:flex;align-items:center;gap:12px;border-top:1px solid var(--border)' },
    el('span', { class: 'muted', style: 'font-size:12.5px' }, `Showing ${from}–${to} of ${data.total.toLocaleString('en-ZA')}`),
    el('div', { class: 'spacer', style: 'margin-left:auto' }),
    el('button', { class: 'btn sm', disabled: data.offset === 0,
      onclick: () => { filters.offset = Math.max(0, data.offset - PAGE); load(host, state, root); } }, 'Previous'),
    el('button', { class: 'btn sm', disabled: to >= data.total,
      onclick: () => { filters.offset = data.offset + PAGE; load(host, state, root); } }, 'Next')));

  renderBulkBar(host, state, root);
}

function sortableTh(label, key, host, state, root, cls = '') {
  const active = filters.sort === key;
  return el('th', {
    class: `${cls} ${active ? 'muted' : ''}`.trim(), style: 'cursor:pointer',
    onclick: () => {
      filters.dir = active && filters.dir === 'desc' ? 'asc' : 'desc';
      filters.sort = key; filters.offset = 0;
      load(host, state, root);
    },
  }, label, active ? (filters.dir === 'desc' ? ' ↓' : ' ↑') : '');
}

function txnRow(t, host, state, root) {
  const tr = el('tr', { class: selected.has(t.id) ? 'selected' : '' });
  const badgeClass = t.coa_code
    ? (t.categorised_by === 'auto' && t.confidence < 0.9 ? 'low' : t.categorised_by)
    : 'none';
  const badgeText = t.coa_code
    ? (t.categorised_by === 'auto' ? (t.confidence < 0.9 ? 'check' : 'auto') : t.categorised_by)
    : 'unallocated';

  tr.append(
    el('td', { class: 'rowsel' }, el('input', {
      type: 'checkbox', checked: selected.has(t.id), 'aria-label': `Select ${t.description}`,
      onchange: (e) => {
        e.target.checked ? selected.add(t.id) : selected.delete(t.id);
        tr.classList.toggle('selected', e.target.checked);
        renderBulkBar(host, state, root);
      },
    })),
    el('td', { class: 'num' }, dateLabel(t.txn_date)),
    el('td', { class: 'muted', style: 'font-size:12.5px' }, t.account_name),
    el('td', {}, el('div', { class: 'txn-desc', title: t.description }, t.description || '—'),
      t.label ? el('div', { class: 'muted', style: 'font-size:11.5px' }, t.label) : null),
    el('td', { class: `num${signClass(t.amount)}` }, fmt(t.amount, { blankZero: false })),
    el('td', {},
      categorySelect(t, state, host, root),
      el('span', { class: `badge ${badgeClass}`, style: 'margin-left:6px' }, badgeText)),
    el('td', { class: 'muted', style: 'font-size:11.5px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
               title: t.source || '' }, t.source || '—'),
    el('td', {}, el('button', { class: 'btn sm', onclick: () => openDetail(t, state, host, root) }, 'Detail')),
  );
  return tr;
}

function categorySelect(t, state, host, root) {
  return el('select', {
    style: 'max-width:230px;font-size:12.5px',
    'aria-label': `Allocation for ${t.description}`,
    onchange: async (e) => {
      const code = e.target.value || null;
      try {
        await api.patch(`/api/transactions/${t.id}`, { coa_code: code });
        t.coa_code = code;
        toast(code ? `Allocated to ${code}` : 'Allocation cleared', 'ok');
        await state.refreshMeta();
        load(host, state, root);
      } catch (err) { toast(err.message, 'err'); }
    },
  },
  el('option', { value: '', selected: !t.coa_code }, '— unallocated —'),
  state.meta.coa.map((c) => el('option', { value: c.code, selected: c.code === t.coa_code },
    `${c.code} ${c.name}`)));
}

/* -------------------------------------------------------------- bulk edits */

function renderBulkBar(host, state, root) {
  const bar = host.querySelector('#bulkbar');
  if (!bar) return;
  clear(bar);
  if (!selected.size) return;
  bar.append(
    el('span', { class: 'muted', style: 'font-size:12.5px;margin-right:8px' }, `${selected.size} selected`),
    el('button', { class: 'btn sm', onclick: () => bulkDialog(state, host, root) }, 'Allocate selected'),
    ' ',
    el('button', { class: 'btn sm danger', onclick: async () => {
      if (!await confirmDialog('Delete transactions',
        `Permanently delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}? `
        + 'The affected months will no longer reconcile until the balances are corrected.', 'Delete')) return;
      try {
        const r = await api.post('/api/transactions/delete', { ids: [...selected] });
        toast(`${r.deleted} deleted`, 'ok');
        selected.clear();
        await state.refreshMeta();
        load(host, state, root);
      } catch (err) { toast(err.message, 'err'); }
    } }, 'Delete'),
    ' ',
    el('button', { class: 'btn sm', onclick: () => { selected.clear(); load(host, state, root); } }, 'Clear'));
}

function bulkDialog(state, host, root) {
  let form;
  modal({
    title: `Allocate ${selected.size} transaction${selected.size === 1 ? '' : 's'}`,
    render: () => (form = el('div', { class: 'form-grid' },
      el('label', { class: 'field wide' }, 'Category',
        el('select', { name: 'coa_code' },
          el('option', { value: '' }, '— clear the allocation —'),
          state.meta.coa.map((c) => el('option', { value: c.code }, `${c.code} — ${c.name}`)))),
      el('label', { class: 'field wide' }, 'Note (optional)',
        el('input', { type: 'text', name: 'label', placeholder: 'Leave blank to keep existing notes' })))),
    actions: [
      { label: 'Cancel' },
      { label: 'Allocate', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        const r = await api.post('/api/transactions/bulk', { ids: [...selected], coa_code: v.coa_code || null, label: v.label });
        toast(`${r.updated} transactions allocated`, 'ok');
        selected.clear();
        await state.refreshMeta();
        load(host, state, root);
      } },
    ],
  });
}

/* ------------------------------------------------------------------ detail */

async function openDetail(t, state, host, root) {
  let suggestion = null;
  try { suggestion = await api.get(`/api/transactions/${t.id}/suggest`); } catch { /* advisory only */ }
  let form;

  modal({
    title: 'Transaction detail',
    render: () => (form = el('div', {},
      el('div', { class: 'form-grid', style: 'margin-bottom:14px' },
        readonly('Date', dateLabel(t.txn_date)),
        readonly('Account', t.account_name),
        readonly('Amount', fmtR(t.amount, { blankZero: false })),
        readonly('Reporting month', monthLabel(t.period, { short: true })),
        el('div', { class: 'wide' }, readonly('Narrative', t.description || '—')),
        el('div', { class: 'wide' }, readonly('Source', t.source || '—'))),
      suggestion?.coa_code ? el('div', { class: 'banner info' }, el('span', { class: 'ico' }, '★'),
        el('div', {}, el('strong', {}, `Suggested: ${suggestion.coa_code} `),
          `(${Math.round(suggestion.confidence * 100)}% confidence) — ${suggestion.reason}`)) : null,
      el('div', { class: 'form-grid' },
        el('label', { class: 'field wide' }, 'Category',
          el('select', { name: 'coa_code' },
            el('option', { value: '' }, '— unallocated —'),
            state.meta.coa.map((c) => el('option', { value: c.code, selected: c.code === t.coa_code },
              `${c.code} — ${c.name}`)))),
        el('label', { class: 'field wide' }, 'Note',
          el('input', { type: 'text', name: 'label', value: t.label || '' })),
        el('label', { class: 'checkline wide' },
          el('input', { type: 'checkbox', name: 'applySimilar' }),
          'Apply to every other transaction with the same narrative on this account'),
        el('label', { class: 'checkline wide' },
          el('input', { type: 'checkbox', name: 'createRule' }),
          'Remember this as a rule for future imports')))),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        const r = await api.patch(`/api/transactions/${t.id}`, {
          coa_code: v.coa_code || null, label: v.label,
          applySimilar: v.applySimilar, createRule: v.createRule,
        });
        toast(r.alsoUpdated ? `Saved — ${r.alsoUpdated} similar transaction(s) also updated` : 'Saved', 'ok');
        await state.refreshMeta();
        load(host, state, root);
      } },
    ],
  });
}

const readonly = (label, value) =>
  el('label', { class: 'field' }, label,
    el('div', { style: 'padding:6px 0;font-size:13px;font-weight:500' }, value));

/* --------------------------------------------------------- auto-categorise */

async function runAutoCategorise(root, state) {
  let form;
  modal({
    title: 'Auto-categorise',
    render: () => (form = el('div', {},
      el('p', { style: 'margin-top:0' },
        'Unallocated transactions are matched against your rules and against how '
        + 'the same narratives were allocated before. Anything below 60% confidence '
        + 'is left alone for you to review.'),
      el('div', { class: 'form-grid' },
        el('label', { class: 'field' }, 'Account',
          el('select', { name: 'accountId' }, el('option', { value: '' }, 'All accounts'),
            state.meta.accounts.map((a) => el('option', { value: a.id }, a.name)))),
        el('label', { class: 'field' }, 'Month',
          el('select', { name: 'period' }, el('option', { value: '' }, 'All months'),
            state.meta.periods.map((p) => el('option', { value: p }, monthLabel(p, { short: true }))))),
        el('label', { class: 'checkline wide' },
          el('input', { type: 'checkbox', name: 'overwrite' }),
          'Also re-check transactions that already have a category')))),
    actions: [
      { label: 'Cancel' },
      { label: 'Run', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        const r = await api.post('/api/categorise', {
          accountId: v.accountId ? Number(v.accountId) : null,
          period: v.period || null, overwrite: v.overwrite,
        });
        toast(`${r.applied} of ${r.examined} transactions allocated`, 'ok');
        await state.refreshMeta();
        render(root, state, filters);
      } },
    ],
  });
}
