/**
 * Statement import.
 *
 * Drop a file, check what the parser found, point each block at an account,
 * then commit. Rows already in the database are skipped, and anything the
 * importer can allocate from your rules and past allocations is allocated on
 * the way in.
 */
import { el, clear, fmt, fmtR, dateLabel, monthLabel, signClass, api, toast, confirmDialog } from '../lib.js';

let preview = null;
let options = { dayFirst: true, swapDayMonth: false };
let lastFile = null;

export async function render(root, state) {
  clear(root);
  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h2', {}, 'Import bank statements'),
      el('p', {}, 'Excel (.xlsx, .xls) or CSV. A single file may hold several accounts '
        + 'stacked one after another — each is detected separately.'))));

  const zone = el('div', { class: 'dropzone', tabindex: '0', role: 'button' },
    el('strong', {}, 'Drop a statement here, or select a file'),
    el('span', {}, '.xlsx, .xls, .csv — up to 40 MB'));
  const fileInput = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,.txt,.tsv', style: 'display:none' });

  const pick = () => fileInput.click();
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], root, state);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0], root, state);
  });

  const optionsRow = el('div', { class: 'toolbar', style: 'margin-top:14px' },
    el('label', { class: 'checkline' },
      el('input', { type: 'checkbox', checked: options.dayFirst,
        onchange: (e) => { options.dayFirst = e.target.checked; if (lastFile) handleFile(lastFile, root, state); } }),
      'Ambiguous dates are day/month (03/08 = 3 August)'),
    el('label', { class: 'checkline' },
      el('input', { type: 'checkbox', checked: options.swapDayMonth,
        onchange: (e) => { options.swapDayMonth = e.target.checked; if (lastFile) handleFile(lastFile, root, state); } }),
      'Swap day and month (the source file stored them the wrong way round)'));

  root.append(el('div', { class: 'card' }, el('div', { class: 'body' }, zone, fileInput, optionsRow)));
  root.append(el('div', { id: 'previewHost' }));
  await renderHistory(root, state);
}

async function handleFile(file, root, state) {
  lastFile = file;
  const host = root.querySelector('#previewHost');
  clear(host);
  host.append(el('div', { class: 'card' }, el('div', { class: 'empty' },
    el('span', { class: 'spin' }), ` Reading ${file.name}…`)));
  try {
    const buf = await file.arrayBuffer();
    preview = await api.upload('/api/import/preview', buf, file.name, {
      dayFirst: String(options.dayFirst), swapDayMonth: String(options.swapDayMonth),
    });
    renderPreview(host, root, state);
  } catch (err) {
    clear(host);
    host.append(el('div', { class: 'banner critical' }, el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Could not read that file. '), err.message)));
  }
}

function renderPreview(host, root, state) {
  clear(host);
  const suspect = preview.blocks.some((b) => b.dateOrderSuspect);
  if (suspect && !options.swapDayMonth) {
    host.append(el('div', { class: 'banner warn' }, el('span', { class: 'ico' }, '!'),
      el('div', {}, el('strong', {}, 'Check the dates. '),
        'Rows in this statement fall across more than two months, which usually means '
        + 'the file stored day and month the wrong way round. Tick “Swap day and month” above '
        + 'and the preview will reload.')));
  }

  for (const block of preview.blocks) {
    const sel = el('select', {},
      el('option', { value: '' }, '— do not import this block —'),
      preview.accounts.map((a) => el('option', {
        value: a.id, selected: a.id === block.suggestedAccountId,
      }, a.name)));
    block._select = sel;

    const sample = el('table');
    sample.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', {}, 'Description'),
      el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Balance'),
      el('th', {}, 'Code in file'))));
    const tb = el('tbody');
    for (const r of block.sample) {
      tb.append(el('tr', {},
        el('td', { class: 'num' }, dateLabel(r.date)),
        el('td', {}, el('div', { class: 'txn-desc' }, r.description)),
        el('td', { class: `num${signClass(r.amount)}` }, fmt(r.amount, { blankZero: false })),
        el('td', { class: 'num muted' }, r.balance === null ? '—' : fmt(r.balance, { blankZero: false })),
        el('td', { class: 'muted', style: 'font-family:var(--mono);font-size:11.5px' }, r.code || '—')));
    }
    sample.append(tb);

    const found = Object.keys(block.columns).join(', ');
    host.append(el('div', { class: 'card' },
      el('header', {},
        el('h3', {}, block.accountHint.name || `${block.sheet} — block`),
        el('span', { class: 'sub' },
          `${block.rowCount} rows · ${block.months.map((m) => monthLabel(m, { short: true })).join(', ') || 'no month'} · `
          + `columns found: ${found}${block.descending ? ' · newest first' : ''}`),
        el('div', { class: 'spacer' }),
        el('label', { class: 'field' }, 'Import into', sel)),
      el('div', { class: 'body' },
        el('div', { class: 'toolbar', style: 'margin-bottom:12px' },
          stat('Account number in file', block.accountHint.number || '—'),
          stat('Opening balance', block.opening === null ? 'not found' : fmtR(block.opening, { blankZero: false })),
          stat('Closing balance', block.closing === null ? 'not found' : fmtR(block.closing, { blankZero: false })),
          stat('Net movement', fmtR(block.rows.reduce((s, r) => s + r.amount, 0), { blankZero: false }))),
        block.opening !== null && block.closing !== null
          ? checkBlock(block)
          : el('div', { class: 'banner info' }, el('span', { class: 'ico' }, 'i'),
              el('div', {}, 'No opening or closing balance was found in this block. You can capture '
                + 'them by hand afterwards under Accounts & Reconciliation.')),
        el('h4', { style: 'margin:14px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)' },
          `First ${block.sample.length} rows`),
        el('div', { class: 'table-wrap' }, sample))));
  }

  host.append(el('div', { class: 'card' }, el('div', { class: 'body', style: 'display:flex;gap:10px;align-items:center' },
    el('span', { class: 'muted', style: 'font-size:13px' },
      `${preview.blocks.reduce((s, b) => s + b.rowCount, 0)} rows ready from ${preview.filename}`),
    el('div', { style: 'margin-left:auto' }),
    el('button', { class: 'btn', onclick: () => { preview = null; clear(host); } }, 'Cancel'),
    ' ',
    el('button', { class: 'btn primary', onclick: (e) => commit(e.currentTarget, host, root, state) }, 'Import'))));
}

/** Does the statement's own opening + movement land on its own closing balance? */
function checkBlock(block) {
  const movement = block.rows.reduce((s, r) => s + r.amount, 0);
  const diff = Math.round((block.opening + movement - block.closing) * 100) / 100;
  return Math.abs(diff) < 0.01
    ? el('div', { class: 'banner ok' }, el('span', { class: 'ico' }, '✓'),
        el('div', {}, 'Opening balance plus the movements in this block equals the closing balance — '
          + 'the file is internally consistent.'))
    : el('div', { class: 'banner warn' }, el('span', { class: 'ico' }, '!'),
        el('div', {}, el('strong', {}, `Out by ${fmtR(diff)}. `),
          'Opening balance plus movements does not equal the closing balance in this file, so rows '
          + 'may be missing from it. Import it if you expect that, then reconcile the account.'));
}

const stat = (k, v) => el('div', {},
  el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);font-weight:600' }, k),
  el('div', { style: 'font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums' }, v));

async function commit(button, host, root, state) {
  const blocks = preview.blocks
    .filter((b) => b._select.value)
    .map((b) => ({ accountId: Number(b._select.value), sheet: b.sheet, rows: b.rows,
                   opening: b.opening, closing: b.closing }));
  if (!blocks.length) { toast('Choose an account for at least one block', 'err'); return; }

  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    const r = await api.post('/api/import/commit', { filename: preview.filename, blocks });
    toast(`${r.inserted} imported, ${r.skipped} already present, ${r.auto} auto-allocated`, 'ok');
    preview = null; lastFile = null;
    await state.refreshMeta();
    render(root, state);
  } catch (err) {
    toast(err.message, 'err');
    button.disabled = false;
    button.textContent = 'Import';
  }
}

async function renderHistory(root, state) {
  const batches = await api.get('/api/imports');
  if (!batches.length) return;
  const table = el('table');
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'File'), el('th', {}, 'Imported'),
    el('th', { class: 'num' }, 'Rows'), el('th', { class: 'num' }, 'Skipped'),
    el('th', { class: 'num' }, 'Auto-allocated'), el('th', {}, 'Note'), el('th', {}, ''))));
  const body = el('tbody');
  for (const b of batches) {
    body.append(el('tr', {},
      el('td', {}, b.filename),
      el('td', { class: 'muted', style: 'font-size:12.5px' }, new Date(b.imported_at).toLocaleString('en-ZA')),
      el('td', { class: 'num' }, b.row_count),
      el('td', { class: 'num muted' }, b.skipped_count || '—'),
      el('td', { class: 'num' }, b.auto_count || '—'),
      el('td', { class: 'muted', style: 'font-size:12.5px' }, b.note || '—'),
      el('td', {}, el('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog('Undo import',
          `Remove all ${b.row_count} transactions imported from ${b.filename}? `
          + 'Captured opening and closing balances are left in place.', 'Remove')) return;
        try {
          const r = await api.del(`/api/imports/${b.id}`);
          toast(`${r.deleted} transactions removed`, 'ok');
          await state.refreshMeta();
          render(root, state);
        } catch (err) { toast(err.message, 'err'); }
      } }, 'Undo'))));
  }
  table.append(body);
  root.append(el('div', { class: 'card' },
    el('header', {}, el('h3', {}, 'Import history')),
    el('div', { class: 'body flush' }, el('div', { class: 'table-wrap' }, table))));
}
