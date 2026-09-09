/**
 * Categorisation rules. A rule fixes an allocation for anything matching a
 * narrative pattern, and takes precedence over what the app learns from past
 * allocations.
 */
import { el, clear, api, toast, modal, confirmDialog, formValues } from '../lib.js';

export async function render(root, state) {
  clear(root);
  const rules = await api.get('/api/rules');

  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h2', {}, 'Categorisation rules'),
      el('p', {}, 'Rules run before anything else on import. Where no rule matches, the app '
        + 'falls back on how the same narrative was allocated before.')),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn primary', onclick: () => ruleDialog(null, state, root) }, 'New rule')));

  if (!rules.length) {
    root.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
      el('p', {}, 'No rules yet.'),
      el('p', { style: 'font-size:13px' },
        'Transactions are still categorised automatically from previous allocations. '
        + 'Add a rule when you want a narrative pinned to a category for good — or tick '
        + '“Remember this as a rule” when allocating a transaction.'))));
    return;
  }

  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', { class: 'num' }, 'Priority'), el('th', {}, 'When the narrative'), el('th', {}, 'Pattern'),
    el('th', {}, 'Account scope'), el('th', {}, 'Allocate to'),
    el('th', { class: 'num' }, 'Times used'), el('th', {}, 'Origin'), el('th', {}, ''))));
  const body = el('tbody');
  const verb = { contains: 'contains', exact: 'is exactly', starts: 'starts with', regex: 'matches regex' };
  for (const r of rules) {
    body.append(el('tr', { style: r.active ? '' : 'opacity:.5' },
      el('td', { class: 'num' }, r.priority),
      el('td', { class: 'muted' }, verb[r.match_type] ?? r.match_type),
      el('td', {}, el('code', { style: 'font-family:var(--mono);font-size:12px' }, r.pattern)),
      el('td', { class: 'muted' }, r.account_name || 'any account'),
      el('td', {}, `${r.coa_code} — ${r.coa_name ?? ''}`),
      el('td', { class: 'num' }, r.hits || '—'),
      el('td', {}, el('span', { class: `badge ${r.origin === 'learned' ? 'auto' : ''}` }, r.origin)),
      el('td', {},
        el('button', { class: 'btn sm', onclick: () => ruleDialog(r, state, root) }, 'Edit'), ' ',
        el('button', { class: 'btn sm danger', onclick: async () => {
          if (!await confirmDialog('Delete rule',
            `Delete the rule for "${r.pattern}"? Transactions already allocated by it keep their category.`,
            'Delete')) return;
          await api.del(`/api/rules/${r.id}`);
          toast('Rule deleted', 'ok');
          render(root, state);
        } }, 'Delete'))));
  }
  table.append(body);
  root.append(el('div', { class: 'card' }, el('div', { class: 'body flush' },
    el('div', { class: 'table-wrap' }, table))));
}

function ruleDialog(rule, state, root) {
  let form;
  modal({
    title: rule ? 'Edit rule' : 'New rule',
    render: () => (form = el('div', { class: 'form-grid' },
      el('label', { class: 'field wide' }, 'Pattern',
        el('input', { type: 'text', name: 'pattern', value: rule?.pattern ?? '', placeholder: 'kazang' })),
      el('label', { class: 'field' }, 'Match',
        el('select', { name: 'match_type' },
          [['contains', 'contains'], ['exact', 'is exactly'], ['starts', 'starts with'], ['regex', 'matches regex']]
            .map(([v, t]) => el('option', { value: v, selected: rule?.match_type === v }, t)))),
      el('label', { class: 'field' }, 'Priority',
        el('input', { type: 'number', name: 'priority', value: rule?.priority ?? 100 })),
      el('label', { class: 'field wide' }, 'Allocate to',
        el('select', { name: 'coa_code' },
          state.meta.coa.map((c) => el('option', { value: c.code, selected: rule?.coa_code === c.code },
            `${c.code} — ${c.name}`)))),
      el('label', { class: 'field wide' }, 'Only for account',
        el('select', { name: 'account_id' }, el('option', { value: '' }, 'Any account'),
          state.meta.accounts.map((a) => el('option', { value: a.id, selected: rule?.account_id === a.id }, a.name)))),
      el('label', { class: 'field wide' }, 'Note applied to matched transactions',
        el('input', { type: 'text', name: 'label', value: rule?.label ?? '', placeholder: 'Optional' })),
      rule ? el('label', { class: 'checkline wide' },
        el('input', { type: 'checkbox', name: 'active', checked: !!rule.active }), 'Active') : null)),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        await api.post('/api/rules', {
          id: rule?.id, pattern: v.pattern, match_type: v.match_type, coa_code: v.coa_code,
          account_id: v.account_id ? Number(v.account_id) : null, label: v.label,
          priority: Number(v.priority) || 100, active: rule ? v.active : true,
        });
        toast('Rule saved', 'ok');
        render(root, state);
      } },
    ],
  });
}
