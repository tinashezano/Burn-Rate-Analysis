/**
 * Accounts and reconciliation.
 *
 * For each bank or cash account this traces the beginning balance, the
 * movement in the month and the calculated ending balance, then sets that
 * against the closing balance printed on the bank statement. Anything other
 * than a zero difference means a transaction is missing, duplicated or
 * misdated.
 */
import { el, clear, fmt, fmtR, monthLabel, signClass, api, toast, modal, formValues } from '../lib.js';

export async function render(root, state) {
  clear(root);
  root.append(el('div', { class: 'empty' }, el('span', { class: 'spin' }), ' Loading…'));

  const [recon, accounts] = await Promise.all([api.get('/api/reconciliation'), api.get('/api/accounts')]);
  clear(root);

  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h2', {}, 'Accounts & Reconciliation'),
      el('p', {}, 'Every bank and cash account from its opening balance, through the month’s '
        + 'movements, to its closing balance — checked against the bank statement.')),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn', onclick: () => accountDialog(null, state, root) }, 'Add account')));

  if (!recon.periods.length) {
    root.append(el('div', { class: 'card' }, el('div', { class: 'empty' }, 'Import a statement to begin.')));
    return;
  }

  const unreconciled = [];
  for (const a of recon.cash) {
    for (const p of recon.periods) {
      if (a.difference[p] !== null && Math.abs(a.difference[p]) >= 0.01) unreconciled.push({ a, p });
    }
  }
  root.append(unreconciled.length
    ? el('div', { class: 'banner critical' }, el('span', { class: 'ico' }, '!'),
        el('div', {}, el('strong', {}, `${unreconciled.length} account-month${unreconciled.length === 1 ? '' : 's'} do not reconcile. `),
          unreconciled.slice(0, 4).map(({ a, p }) => `${a.name} ${monthLabel(p, { short: true })} ${fmtR(a.difference[p])}`).join('; '),
          unreconciled.length > 4 ? ` and ${unreconciled.length - 4} more.` : '.'))
    : el('div', { class: 'banner ok' }, el('span', { class: 'ico' }, '✓'),
        el('div', {}, el('strong', {}, 'All captured balances reconcile. '),
          'Every account’s calculated closing balance agrees to its bank statement.')));

  for (const p of recon.periods) root.append(periodCard(p, recon, state, root));
  root.append(accountsCard(accounts, state, root));
}

function periodCard(period, recon, state, root) {
  const t = recon.totals[period];
  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Account'),
    el('th', { class: 'num' }, 'Opening balance'),
    el('th', { class: 'num' }, 'Movement'),
    el('th', { class: 'num' }, 'Calculated closing'),
    el('th', { class: 'num' }, 'Per bank statement'),
    el('th', { class: 'num' }, 'Difference'),
    el('th', {}, ''))));

  const body = el('tbody');
  for (const a of recon.cash) {
    const diff = a.difference[period];
    const hasActivity = a.movement[period] !== 0 || a.statement[period] !== null || a.opening[period] !== 0;
    if (!hasActivity) continue;
    const ok = diff !== null && Math.abs(diff) < 0.01;
    body.append(el('tr', {},
      el('td', {}, a.name,
        a.account_number ? el('div', { class: 'muted', style: 'font-size:11.5px' }, a.account_number) : null),
      el('td', { class: `num${signClass(a.opening[period])}` }, fmt(a.opening[period], { blankZero: false })),
      el('td', { class: `num${signClass(a.movement[period])}` }, fmt(a.movement[period], { blankZero: false })),
      el('td', { class: `num${signClass(a.closing[period])}` }, fmt(a.closing[period], { blankZero: false })),
      el('td', { class: `num${signClass(a.statement[period])}` },
        a.statement[period] === null
          ? el('span', { class: 'badge none' }, 'not captured')
          : fmt(a.statement[period], { blankZero: false })),
      el('td', { class: 'num' }, diff === null
        ? el('span', { class: 'muted' }, '—')
        : el('span', { class: 'badge ' + (ok ? 'manual' : 'none') }, ok ? '✓ reconciled' : fmt(diff, { blankZero: false }))),
      el('td', {}, el('button', { class: 'btn sm',
        onclick: () => balanceDialog(a, period, state, root) }, 'Edit balances'))));
  }

  const ok = t.difference !== null && Math.abs(t.difference) < 0.01;
  body.append(el('tr', { style: 'font-weight:600;background:var(--surface-2)' },
    el('td', {}, 'Total'),
    el('td', { class: `num${signClass(t.openingCash)}` }, fmt(t.openingCash, { blankZero: false })),
    el('td', { class: `num${signClass(t.netCashFlow)}` }, fmt(t.netCashFlow, { blankZero: false })),
    el('td', { class: `num${signClass(t.closingCash)}` }, fmt(t.closingCash, { blankZero: false })),
    el('td', { class: `num${signClass(t.statementClosing)}` }, fmt(t.statementClosing, { blankZero: false })),
    el('td', { class: 'num' }, t.difference === null ? '—'
      : el('span', { class: 'badge ' + (ok ? 'manual' : 'none') }, ok ? '✓ nil' : fmt(t.difference, { blankZero: false }))),
    el('td', {})));
  table.append(body);

  const unallocValue = recon.unallocated.values[period] ?? 0;
  const unallocCount = recon.unallocated.materialCounts?.[period] ?? 0;
  return el('div', { class: 'card' },
    el('header', {},
      el('h3', {}, monthLabel(period)),
      el('span', { class: 'sub' },
        `Net cash flow ${fmtR(t.netCashFlow, { blankZero: false })}`
        + (unallocCount
          ? ` · includes ${fmtR(unallocValue, { blankZero: false })} across `
            + `${unallocCount} unallocated transaction${unallocCount === 1 ? '' : 's'}`
          : ''))),
    el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table)));
}

function balanceDialog(account, period, state, root) {
  let form;
  modal({
    title: `${account.name} — ${monthLabel(period)}`,
    render: () => (form = el('div', {},
      el('p', { style: 'margin-top:0;color:var(--text-2)' },
        'Leave the opening balance blank to carry forward the previous month’s closing '
        + 'balance. The statement closing balance is what the reconciliation is checked against.'),
      el('div', { class: 'form-grid' },
        el('label', { class: 'field' }, 'Opening balance',
          el('input', { type: 'number', step: '0.01', name: 'opening_balance',
                        value: account.opening[period] ?? '', placeholder: 'Carry forward' })),
        el('label', { class: 'field' }, 'Closing balance per bank statement',
          el('input', { type: 'number', step: '0.01', name: 'statement_closing',
                        value: account.statement[period] ?? '', placeholder: 'Not captured' })),
        el('label', { class: 'field wide' }, 'Note',
          el('input', { type: 'text', name: 'note', placeholder: 'Optional' }))),
      el('div', { class: 'banner info', style: 'margin-top:14px' }, el('span', { class: 'ico' }, 'i'),
        el('div', {}, `Movement in this month is ${fmtR(account.movement[period], { blankZero: false })}, `
          + `so the calculated closing balance is ${fmtR(account.closing[period], { blankZero: false })}.`)))),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        await api.post('/api/account-periods', {
          account_id: account.id, period, note: v.note,
          opening_balance: v.opening_balance === '' ? null : v.opening_balance,
          statement_closing: v.statement_closing === '' ? null : v.statement_closing,
        });
        toast('Balances saved', 'ok');
        render(root, state);
      } },
    ],
  });
}

function accountsCard(data, state, root) {
  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Account'), el('th', {}, 'Number'), el('th', {}, 'Type'),
    el('th', { class: 'num' }, 'Transactions'), el('th', { class: 'num' }, 'Unallocated'),
    el('th', {}, 'Date range'), el('th', {}, 'Status'), el('th', {}, ''))));
  const body = el('tbody');
  for (const a of data.accounts) {
    body.append(el('tr', {},
      el('td', {}, a.name),
      el('td', { class: 'muted', style: 'font-family:var(--mono);font-size:12px' }, a.account_number || '—'),
      el('td', { class: 'muted' }, a.kind.replace('_', ' ')),
      el('td', { class: 'num' }, (a.stats.n ?? 0).toLocaleString('en-ZA')),
      el('td', { class: 'num' }, a.stats.unallocated
        ? el('span', { class: 'badge none' }, a.stats.unallocated) : '—'),
      el('td', { class: 'muted', style: 'font-size:12.5px' },
        a.stats.first_date ? `${a.stats.first_date} → ${a.stats.last_date}` : '—'),
      el('td', {}, el('span', { class: `badge ${a.active ? 'manual' : ''}` }, a.active ? 'active' : 'inactive')),
      el('td', {}, el('button', { class: 'btn sm', onclick: () => accountDialog(a, state, root) }, 'Edit'))));
  }
  table.append(body);
  return el('div', { class: 'card' },
    el('header', {}, el('h3', {}, 'Accounts'),
      el('span', { class: 'sub' }, 'Bank, credit card and cash accounts tracked by this file')),
    el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table)));
}

function accountDialog(account, state, root) {
  let form;
  modal({
    title: account ? `Edit ${account.name}` : 'Add account',
    render: () => (form = el('div', { class: 'form-grid' },
      el('label', { class: 'field wide' }, 'Name',
        el('input', { type: 'text', name: 'name', value: account?.name ?? '', placeholder: 'Nedbank Current Account' })),
      el('label', { class: 'field' }, 'Short code',
        el('input', { type: 'text', name: 'code', value: account?.code ?? '', placeholder: 'NED-CURR' })),
      el('label', { class: 'field' }, 'Account number',
        el('input', { type: 'text', name: 'account_number', value: account?.account_number ?? '' })),
      el('label', { class: 'field' }, 'Type',
        el('select', { name: 'kind' },
          ['bank', 'credit_card', 'cash'].map((k) =>
            el('option', { value: k, selected: account?.kind === k }, k.replace('_', ' '))))),
      el('label', { class: 'field' }, 'Sort order',
        el('input', { type: 'number', name: 'sort_order', value: account?.sort_order ?? 100 })),
      account ? el('label', { class: 'checkline wide' },
        el('input', { type: 'checkbox', name: 'active', checked: !!account.active }), 'Active') : null)),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = formValues(form);
        await api.post('/api/accounts', {
          id: account?.id, name: v.name, code: v.code, account_number: v.account_number,
          kind: v.kind, sort_order: Number(v.sort_order) || 100,
          active: account ? v.active : true,
        });
        toast('Account saved', 'ok');
        await state.refreshMeta();
        render(root, state);
      } },
    ],
  });
}
