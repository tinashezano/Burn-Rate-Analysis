import XLSX from 'xlsx';

/* ---------------------------------------------------------------- headers */

const HEADER_PATTERNS = {
  date:        [/^(transaction\s*)?date$/i, /^date$/i, /^posting date$/i, /^value date$/i, /^txn date$/i],
  description: [/^(statement\s*)?(reference|description|narrative|details|payee|particulars)$/i,
                /^transaction (description|reference|details)$/i],
  amount:      [/^(transaction\s*)?amount$/i, /^value$/i, /^amount \(zar\)$/i],
  debit:       [/^debits?$/i, /^money out$/i, /^withdrawals?$/i, /^payments?$/i],
  credit:      [/^credits?$/i, /^money in$/i, /^deposits?$/i, /^receipts?$/i],
  balance:     [/^bala?\s*nce$/i, /^running balance$/i, /^closing balance$/i],
  code:        [/^outset allocation$/i, /^allocation code$/i, /^account code$/i, /^coa$/i],
  label:       [/^allocation$/i, /^category$/i, /^classification$/i],
  period:      [/^month$/i, /^period$/i],
};

function headerRole(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  for (const [role, pats] of Object.entries(HEADER_PATTERNS)) {
    if (pats.some((p) => p.test(s))) return role;
  }
  return null;
}

/* ------------------------------------------------------------------ dates */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function fromSerial(n) {
  const ms = EXCEL_EPOCH + Math.round(n * 86400000);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/**
 * Reads a date cell into {y, m, d} parts without committing to an order for
 * ambiguous text like "03/08/2026" — the caller decides using `dayFirst`.
 */
function readDateParts(v, dayFirst) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate(), fromCell: true };
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) return { ...fromSerial(v), fromCell: true };
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], fromCell: true };
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m; a = +a; b = +b; y = +y;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    // A component above 12 settles the order regardless of the preference.
    if (a > 12) return { y, m: b, d: a, ambiguous: false };
    if (b > 12) return { y, m: a, d: b, ambiguous: false };
    return dayFirst ? { y, m: b, d: a, ambiguous: true } : { y, m: a, d: b, ambiguous: true };
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})$/);
  if (m) {
    const mi = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      let y = +m[3]; if (y < 100) y += 2000;
      return { y, m: mi + 1, d: +m[1], fromCell: true };
    }
  }
  const t = Date.parse(s);
  if (!isNaN(t)) { const d = new Date(t); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), fromCell: true }; }
  return null;
}

const iso = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
export const periodOf = (isoDate) => `${isoDate.slice(0, 7)}-01`;

/* ---------------------------------------------------------------- amounts */

function readNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;

  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }        // (1 234.56)
  if (/(^|\s)(dr|debit)$/i.test(s)) neg = true;                       // 1 234.56 DR
  s = s.replace(/(cr|dr|credit|debit)$/i, '').trim();
  s = s.replace(/[R$\u20ac\u00a3\s\u00a0']/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);

  // Decimal separator: whichever of "." and "," comes last. With only commas,
  // one or two trailing digits mean a decimal comma ("500,00"), while a full
  // group of three means a thousands separator ("1,234").
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) {
      s = s.replace(/\./g, '');
      const i = s.lastIndexOf(',');
      s = `${s.slice(0, i).replace(/,/g, '')}.${s.slice(i + 1)}`;
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (comma >= 0) {
    if (/,\d{1,2}$/.test(s)) {
      const i = s.lastIndexOf(',');
      s = `${s.slice(0, i).replace(/,/g, '')}.${s.slice(i + 1)}`;
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');                                        // 1.234.567, no decimals
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const OPENING_RE = /(brought forward|opening balance|balance b\/?f|b\/?fwd|balance brought)/i;
const CLOSING_RE = /(carried forward|closing balance|balance c\/?f|c\/?fwd)/i;

/* ----------------------------------------------------------------- blocks */

/**
 * Splits one worksheet into statement blocks. A single sheet may hold several
 * accounts stacked on top of each other (as the source workbook does), so each
 * header row starts a new block and any account name or number found above it
 * becomes that block's account hint.
 */
function findBlocks(grid) {
  const headerRows = [];
  for (let r = 0; r < grid.length; r++) {
    const roles = grid[r].map(headerRole);
    const found = new Set(roles.filter(Boolean));
    const hasAmount = found.has('amount') || (found.has('debit') && found.has('credit'));
    if (found.has('date') && (hasAmount || found.has('description'))) headerRows.push(r);
  }
  if (!headerRows.length) return [];

  const blocks = [];
  for (let i = 0; i < headerRows.length; i++) {
    const hr = headerRows[i];
    const end = i + 1 < headerRows.length ? headerRows[i + 1] : grid.length;
    const cols = {};
    grid[hr].forEach((cell, c) => {
      const role = headerRole(cell);
      if (role && cols[role] === undefined) cols[role] = c;
    });
    blocks.push({ headerRow: hr, endRow: end, cols, accountHint: accountHintAbove(grid, hr, i ? headerRows[i - 1] : 0) });
  }
  return blocks;
}

function accountHintAbove(grid, headerRow, floor) {
  let name = '', number = '';
  for (let r = headerRow; r >= Math.max(0, floor); r--) {
    const text = grid[r].map((v) => (v == null ? '' : String(v))).join(' ').trim();
    if (!text) continue;
    const num = text.match(/\b(\d{8,20})\b/);
    if (num && !number) number = num[1];
    const named = text.match(/account (?:description|name)\s*:?\s*(.+)/i);
    if (named && !name) name = named[1].replace(/\s{2,}/g, ' ').trim();
    if (!name && /acc(?:ount)?\b/i.test(text) && !/^account number/i.test(text) && text.length < 90) {
      const cleaned = text.replace(/account (number|description|name)\s*:?/ig, '').trim();
      if (cleaned && !/^\d+$/.test(cleaned)) name = cleaned;
    }
    if (name && number) break;
  }
  // Trim a trailing header echo such as "Date Description Amount".
  name = name.replace(/\b(date|description|amount|balance|reference)\b/ig, '').replace(/\s{2,}/g, ' ').trim();
  return { name, number };
}

/* ------------------------------------------------------------------ parse */

/**
 * Parses a statement file into blocks of candidate transactions.
 *
 * `dayFirst` controls how ambiguous text dates like 03/08/2026 are read
 * (true = 3 August, the South African convention). `swapDayMonth` re-reads
 * dates that the source spreadsheet itself already stored day/month swapped —
 * the preview flags when that is likely.
 */
export function parseStatement(buffer, filename, { dayFirst = true, swapDayMonth = false } = {}) {
  const isCsv = /\.(csv|txt|tsv)$/i.test(filename);
  const wb = isCsv
    ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const sheets = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, blankrows: true, raw: true });
    if (!grid.length) continue;
    const blocks = findBlocks(grid).map((b) => readBlock(grid, b, { dayFirst, swapDayMonth })).filter((b) => b.rows.length);
    if (blocks.length) sheets.push({ name, blocks });
  }
  return { sheets, sheetNames: wb.SheetNames };
}

function readBlock(grid, block, { dayFirst, swapDayMonth }) {
  const { cols } = block;
  const rows = [];
  let opening = null, closing = null, ambiguousDates = 0, lastBalance = null;

  for (let r = block.headerRow + 1; r < block.endRow; r++) {
    const row = grid[r] || [];
    const desc = cols.description !== undefined ? String(row[cols.description] ?? '').trim() : '';
    const balance = cols.balance !== undefined ? readNumber(row[cols.balance]) : null;

    let amount = null;
    if (cols.amount !== undefined) amount = readNumber(row[cols.amount]);
    if (amount === null && (cols.debit !== undefined || cols.credit !== undefined)) {
      const dr = cols.debit !== undefined ? readNumber(row[cols.debit]) : null;
      const cr = cols.credit !== undefined ? readNumber(row[cols.credit]) : null;
      if (dr !== null || cr !== null) amount = (cr ?? 0) - Math.abs(dr ?? 0);
    }

    if (OPENING_RE.test(desc)) { opening = balance ?? amount ?? opening; continue; }
    if (CLOSING_RE.test(desc)) { closing = balance ?? closing; continue; }
    if (amount === null) continue;

    let parts = cols.date !== undefined ? readDateParts(row[cols.date], dayFirst) : null;
    if (!parts) continue;
    if (parts.ambiguous) ambiguousDates++;
    if (swapDayMonth && parts.d <= 12) parts = { y: parts.y, m: parts.d, d: parts.m };

    const date = iso(parts);
    if (isNaN(Date.parse(date))) continue;

    let period = periodOf(date);
    if (cols.period !== undefined) {
      const p = readDateParts(row[cols.period], dayFirst);
      if (p) period = `${p.y}-${String(p.m).padStart(2, '0')}-01`;
    }

    if (balance !== null) lastBalance = balance;
    rows.push({
      sourceRow: r + 1,
      date, period, description: desc, amount: Math.round(amount * 100) / 100,
      balance,
      code: cols.code !== undefined ? (String(row[cols.code] ?? '').trim() || null) : null,
      label: cols.label !== undefined ? String(row[cols.label] ?? '').trim() : '',
    });
  }

  // A descending statement lists the newest row first; the running balance then
  // decreases toward the opening balance at the foot of the block. Two rows are
  // enough to tell the order apart.
  const descending = rows.length >= 2 && rows[0].date > rows[rows.length - 1].date;
  if (descending) rows.reverse();
  if (opening === null && descending && rows.length) {
    const first = rows[0];
    if (first.balance !== null) opening = Math.round((first.balance - first.amount) * 100) / 100;
  }
  if (closing === null) closing = descending ? (rows[rows.length - 1]?.balance ?? null) : lastBalance;

  const months = [...new Set(rows.map((r) => r.period))].sort();
  return {
    ...block, rows, opening, closing, descending, months,
    ambiguousDates,
    // Statements normally cover one month; a wider spread usually means the
    // source file stored day and month the wrong way round.
    dateOrderSuspect: months.length > 2 && ambiguousDates > 0,
  };
}

/**
 * Groups identical-looking transactions so duplicates can be counted rather
 * than guessed at. Two genuinely separate payments of the same amount, to the
 * same payee, on the same day are legitimate, so identity is
 * (account, date, narrative, amount, nth occurrence) — re-importing a file
 * adds nothing, while a file with one extra copy adds exactly one row.
 */
export function groupKey({ accountId, date, description, amount }) {
  const norm = String(description).toLowerCase().replace(/\s+/g, ' ').trim();
  return `${accountId}|${date}|${norm}|${amount.toFixed(2)}`;
}

export function fingerprint(row, occurrence) {
  return `${groupKey(row)}|${occurrence}`;
}
