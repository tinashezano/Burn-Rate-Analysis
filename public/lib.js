/* Shared helpers: DOM building, formatting and the JSON API client. */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/* ------------------------------------------------------------- formatting */

const money0 = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money for report cells: blank for zero so the eye follows the real numbers. */
export function fmt(n, { blankZero = true, decimals = 2 } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (blankZero && Math.abs(n) < 0.005) return '—';
  const f = decimals === 0 ? money0 : money2;
  return n < 0 ? `(${f.format(Math.abs(n))})` : f.format(n);
}

export function fmtR(n, opts) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = fmt(n, { blankZero: false, ...opts });
  return s.startsWith('(') ? `(R ${s.slice(1)}` : `R ${s}`;
}

export const fmtPct = (v) =>
  v === null || v === undefined || !isFinite(v) || Math.abs(v) < 0.00005 ? '—' : `${(v * 100).toFixed(1)}%`;

export function monthLabel(period, { short = false } = {}) {
  if (!period) return '—';
  const d = new Date(`${period}T00:00:00`);
  return d.toLocaleDateString('en-ZA', { month: short ? 'short' : 'long', year: 'numeric' });
}

export const dateLabel = (iso) =>
  !iso ? '—' : new Date(`${iso}T00:00:00`).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit' });

/** Adds the sign class the number tables use, without colouring zeroes. */
export const signClass = (n) => (n === null || n === undefined || Math.abs(n) < 0.005 ? '' : n < 0 ? ' neg' : '');

/* --------------------------------------------------------------- API client */

async function request(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Unexpected response from ${path}`); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p, q) => request('GET', q ? `${p}?${new URLSearchParams(q)}` : p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, buf, filename, q) =>
    request('POST', q ? `${p}?${new URLSearchParams(q)}` : p, buf, { 'X-Filename': encodeURIComponent(filename) }),
};

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`.trim(), role: 'status' }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, kind === 'err' ? 6000 : 3200);
  setTimeout(() => node.remove(), kind === 'err' ? 6400 : 3600);
}

/* ------------------------------------------------------------------- modal */

/**
 * Opens the shared dialog. `render(close)` returns the body; buttons come from
 * `actions`, whose handlers may return false to keep the dialog open.
 */
export function modal({ title, render, actions = [], width }) {
  const dlg = document.getElementById('modal');
  clear(dlg);
  if (width) dlg.style.width = width;
  const close = () => dlg.close();
  const body = el('div', { class: 'body' });
  body.append(render(close));
  const footer = el('div', { class: 'footer' });
  dlg.append(
    el('header', {}, title),
    body,
    el('footer', {},
      actions.map((a) => el('button', {
        class: `btn ${a.kind || ''}`.trim(),
        onclick: async (e) => {
          e.preventDefault();
          const btn = e.currentTarget;
          btn.disabled = true;
          try { if (await a.onClick?.(close) !== false) close(); }
          catch (err) { toast(err.message, 'err'); }
          finally { btn.disabled = false; }
        },
      }, a.label)),
      footer),
  );
  dlg.showModal();
  const focusable = body.querySelector('input, select, textarea, button');
  focusable?.focus();
  return dlg;
}

export const confirmDialog = (title, message, confirmLabel = 'Confirm') =>
  new Promise((resolve) => {
    let decided = false;
    const dlg = modal({
      title,
      render: () => el('p', { style: 'margin:0' }, message),
      actions: [
        { label: 'Cancel', onClick: () => { decided = true; resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: () => { decided = true; resolve(true); } },
      ],
    });
    dlg.addEventListener('close', () => { if (!decided) resolve(false); }, { once: true });
  });

/** Reads the value of every [name] control inside a container. */
export function formValues(root) {
  const out = {};
  for (const f of root.querySelectorAll('[name]')) {
    out[f.name] = f.type === 'checkbox' ? f.checked : f.value;
  }
  return out;
}
