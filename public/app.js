/* Bootstrap and router. Views are re-rendered on navigation, so the dashboard
   always reflects the current state of the transaction database. */
import { el, api, toast } from './lib.js';
import * as dashboard from './views/dashboard.js';
import * as transactions from './views/transactions.js';
import * as accounts from './views/accounts.js';
import * as importer from './views/import.js';
import * as rules from './views/rules.js';
import * as coa from './views/coa.js';

const VIEWS = { dashboard, transactions, accounts, import: importer, rules, coa };

const state = {
  meta: { accounts: [], periods: [], coa: [], counts: {} },
  dashboard: null,
  go,
  refreshMeta,
};

async function refreshMeta() {
  state.meta = await api.get('/api/meta');
  const pill = document.getElementById('reviewPill');
  const n = (state.meta.counts.unallocated ?? 0) + (state.meta.counts.low_confidence ?? 0);
  pill.hidden = !n;
  pill.textContent = n > 999 ? '999+' : n;
  document.getElementById('entityName').textContent =
    state.meta.accounts.length ? `${state.meta.accounts.length} accounts · ${(state.meta.counts.transactions ?? 0).toLocaleString('en-ZA')} transactions` : '';
}

let current = null;

async function go(name, params = {}) {
  if (!VIEWS[name]) name = 'dashboard';
  current = name;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === name;
    tab.toggleAttribute('aria-current', active);
    if (active) tab.setAttribute('aria-current', 'page');
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.id === `view-${name}`);
  }
  const hash = Object.keys(params).length
    ? `#${name}?${new URLSearchParams(params)}` : `#${name}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);

  const root = document.getElementById(`view-${name}`);
  try {
    await VIEWS[name].render(root, state, params);
  } catch (err) {
    root.replaceChildren(el('div', { class: 'banner critical' },
      el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Something went wrong. '), err.message)));
    toast(err.message, 'err');
  }
  window.scrollTo({ top: 0 });
}

function fromHash() {
  const raw = location.hash.replace(/^#/, '');
  const [name, qs] = raw.split('?');
  return { name: name || 'dashboard', params: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} };
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) go(tab.dataset.view);
});
addEventListener('hashchange', () => {
  const { name, params } = fromHash();
  if (name !== current || Object.keys(params).length) go(name, params);
});

(async () => {
  try {
    await refreshMeta();
    const { name, params } = fromHash();
    await go(name, params);
  } catch (err) {
    document.querySelector('main').replaceChildren(el('div', { class: 'banner critical' },
      el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Could not reach the server. '), err.message)));
  }
})();
