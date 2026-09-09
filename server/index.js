import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './api.js';
import { getDb } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = 40 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = async (req) => {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
};

/* ------------------------------------------------------------------ routes */

const ROUTES = [
  ['GET',  /^\/api\/meta$/,               async () => api.meta()],
  ['GET',  /^\/api\/dashboard$/,          async (_r, _m, q) => api.dashboard(q)],
  ['GET',  /^\/api\/reconciliation$/,     async (_r, _m, q) => api.reconciliation(q)],

  ['GET',  /^\/api\/accounts$/,           async () => api.getAccounts()],
  ['POST', /^\/api\/accounts$/,           async (req) => api.saveAccount(await json(req))],
  ['POST', /^\/api\/account-periods$/,    async (req) => api.saveAccountPeriod(await json(req))],

  ['GET',  /^\/api\/transactions$/,       async (_r, _m, q) => api.getTransactions(q)],
  ['PATCH', /^\/api\/transactions\/(\d+)$/, async (req, m) => api.updateTransaction(Number(m[1]), await json(req))],
  ['GET',  /^\/api\/transactions\/(\d+)\/suggest$/, async (_r, m) => api.suggestFor(Number(m[1]))],
  ['POST', /^\/api\/transactions\/bulk$/, async (req) => api.bulkCategorise(await json(req))],
  ['POST', /^\/api\/transactions\/delete$/, async (req) => api.deleteTransactions((await json(req)).ids)],
  ['POST', /^\/api\/categorise$/,         async (req) => api.categoriseUnallocated(await json(req))],

  ['POST', /^\/api\/import\/preview$/,    async (req, _m, q) => {
    const buf = await readBody(req, MAX_UPLOAD);
    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.xlsx');
    return api.previewImport(buf, filename, {
      dayFirst: q.dayFirst !== 'false',
      swapDayMonth: q.swapDayMonth === 'true',
    });
  }],
  ['POST', /^\/api\/import\/commit$/,     async (req) => api.commitImport(await json(req, 60 * 1024 * 1024))],
  ['GET',  /^\/api\/imports$/,            async () => api.getImports()],
  ['DELETE', /^\/api\/imports\/(\d+)$/,   async (_r, m) => api.deleteBatch(Number(m[1]))],

  ['GET',  /^\/api\/rules$/,              async () => api.getRules()],
  ['POST', /^\/api\/rules$/,              async (req) => api.saveRule(await json(req))],
  ['DELETE', /^\/api\/rules\/(\d+)$/,     async (_r, m) => api.deleteRule(Number(m[1]))],

  ['GET',  /^\/api\/coa$/,                async () => api.getCoa()],
  ['POST', /^\/api\/coa$/,                async (req) => api.saveCoa(await json(req))],
];

async function serveStatic(url, res) {
  const rel = url === '/' ? '/index.html' : url;
  const path = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    if (!extname(rel)) return serveStatic('/index.html', res);   // SPA fallback
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Several paths are served by more than one method, so gather every route
  // whose pattern matches before deciding whether the method is allowed.
  const pathMatches = ROUTES
    .map(([method, pattern, handler]) => ({ method, handler, m: url.pathname.match(pattern) }))
    .filter((r) => r.m);
  const route = pathMatches.find((r) => r.method === req.method);

  if (route) {
    try {
      const result = await route.handler(req, route.m, query);
      return send(res, 200, result ?? {});
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
      return send(res, status, { error: err.message || 'Server error' });
    }
  }
  if (pathMatches.length) {
    const allow = [...new Set(pathMatches.map((r) => r.method))].join(', ');
    return send(res, 405, { error: `${req.method} not allowed on ${url.pathname}` }, { Allow: allow });
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(url.pathname, res);
});

getDb();
server.listen(PORT, HOST, () => {
  console.log(`Burn Rate Analysis running at http://${HOST}:${PORT}`);
});
