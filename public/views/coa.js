/**
 * The chart of accounts. `section` decides where a code lands on the Burn Rate
 * dashboard, so moving a code between sections rewrites the report.
 */
import { el, clear, api, toast, modal, formValues } from '../lib.js';

const SECTION_LABEL = {
  revenue: 'Revenue', cos: 'Cost of sale', other_income: 'Other income',
  expense: 'Expenditure', funding: 'Balance sheet — funding', transfer: 'Balance sheet — transfers',
};
const SECTION_NOTE = {
  revenue: 'Shown as received. Adds to income.',
  cos: 'Shown as positive spend. Part of gross burn.',
  other_income: 'Shown as received. Adds to income.',
  expense: 'Shown as positive spend. Part of gross burn.',
  funding: 'Signed cash effect. Sits below the surplus line.',
  transfer: 'Signed cash effect. Movements between your own accounts.',
};

export async function render(root, state) {
  clear(root);
  const coa = await api.get('/api/coa');

  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h2', {}, 'Chart of accounts'),
      el('p', {}, 'The allocation codes behind every line of the dashboard. '
        + 'A code’s section decides where its total appears in the report.')),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn primary', onclick: () => coaDialog(null, root, state) }, 'New code')));

  for (const [section, label] of Object.entries(SECTION_LABEL)) {
    const rows = coa.filter((c) => c.section === section);
    if (!rows.length) continue;
    const table = el('table');
    table.append(el('thead', {}, el('tr', {},
      el('th', { style: 'width:100px' }, 'Code'), el('th', {}, 'Name'),
      el('th', { class: 'num' }, 'Transactions'), el('th', {}, 'Status'), el('th', {}, ''))));
    const body = el('tbody');
    for (const c of rows) {
      body.append(el('tr', { style: c.active ? '' : 'opacity:.5' },
        el('td', { style: 'font-family:var(--mono);font-size:12px' }, c.code),
        el('td', {}, c.name),
        el('td', { class: 'num' }, c.usage_count ? c.usage_count.toLocaleString('en-ZA') : '—'),
        el('td', {}, el('span', { class: `badge ${c.active ? 'manual' : ''}` }, c.active ? 'active' : 'inactive')),
        el('td', {}, el('button', { class: 'btn sm', onclick: () => coaDialog(c, root, state) }, 'Edit'))));
    }
    table.append(body);
    root.append(el('div', { class: 'card' },
      el('header', {}, el('h3', {}, label), el('span', { class: 'sub' }, SECTION_NOTE[section])),
      el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table))));
  }
}

function coaDialog(code, root, state) {
  let form;
  modal({
    title: code ? `Edit ${code.code}` : 'New code',
    render: () => (form = el('div', {},
      code?.usage_count ? el('div', { class: 'banner info' }, el('span', { class: 'ico' }, 'i'),
        el('div', {}, `${code.usage_count} transactions use this code. Changing its section moves `
          + 'their total to a different line of the dashboard.')) : null,
      el('div', { class: 'form-grid' },
        el('label', { class: 'field' }, 'Code',
          el('input', { type: 'text', name: 'code', value: code?.code ?? '', placeholder: '450*' })),
        el('label', { class: 'field' }, 'Sort order',
          el('input', { type: 'number', name: 'sort_order', value: code?.sort_order ?? 100 })),
        el('label', { class: 'field wide' }, 'Name',
          el('input', { type: 'text', name: 'name', value: code?.name ?? '' })),
        el('label', { class: 'field wide' }, 'Section',
          el('select', { name: 'section' },
            Object.entries(SECTION_LABEL).map(([v, t]) =>
              el('option', { value: v, selected: code?.section === v }, t)))),
        code ? el('label', { class: 'checkline wide' },
          el('input', { type: 'checkbox', name: 'active', checked: !!code.active }), 'Active') : null))),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        await api.post('/api/coa', {
          code: v.code, original_code: code?.code, name: v.name, section: v.section,
          sort_order: Number(v.sort_order) || 100, active: code ? v.active : true,
        });
        toast('Code saved', 'ok');
        await state.refreshMeta();
        render(root, state);
      } },
    ],
  });
}
