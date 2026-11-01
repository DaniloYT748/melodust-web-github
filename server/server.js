'use strict';
/* Melodust Sync Server
   - accounts (scrypt-hashed passwords, bearer session tokens)
   - real-time sync over WebSocket (/ws) with an HTTP fallback (POST /api/sync)
   - optionally serves the static site, so one process can host everything

   Config (environment variables):
     PORT              default 3000
     HOST              default 0.0.0.0
     DATA_DIR          default ./data  (db.json lives here)
     ALLOWED_ORIGINS   comma-separated list for CORS, default "*"
     ALLOW_REGISTER    "0" closes registration, default "1"
     REGISTER_LIMIT    sign-up attempts per IP per hour, default 5
     TRUST_PROXY       "1" to read the client IP from X-Forwarded-For (behind nginx/Apache)
     SERVE_STATIC      "0" to disable serving the site from the parent folder
     RESEND_API_KEY    Resend API key (re_...)  — enables password-recovery emails
     MAIL_FROM         sender, e.g. "Melodust <noreply@xgroupsoftware.xyz>" (domain verified in Resend)
     SITE_URL          public address of the site, used in the reset link, e.g. https://web.melodust.xgroupsoftware.xyz
                       (falls back to the first non-* entry of ALLOWED_ORIGINS)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Doc = require('./syncdoc.js');

const PORT = typeof PhusionPassenger !== 'undefined' ? 'passenger' : (+process.env.PORT || 3000); // eslint-disable-line no-undef
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== '0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const MAIL_FROM = process.env.MAIL_FROM || '';
const SITE_URL = (process.env.SITE_URL || ORIGINS.find((o) => o !== '*') || '').replace(/\/+$/, '');
const MAIL_ON = !!(RESEND_API_KEY && MAIL_FROM && SITE_URL);
const RESET_TTL = 30 * 60 * 1000;
const REGISTER_LIMIT = +process.env.REGISTER_LIMIT || 5; // sign-up attempts per IP per hour
const SITE_DIR = path.resolve(__dirname, '..');
const SERVE_STATIC = process.env.SERVE_STATIC !== '0' && fs.existsSync(path.join(SITE_DIR, 'index.html'));

const TOKEN_TTL = 90 * 24 * 3600 * 1000;
const MAX_TOKENS_PER_USER = 10;
const MAX_USERS = 5000;

/* ============================== storage ============================== */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, tokens: {}, resets: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') { console.error('Cannot read db.json:', e.message); process.exit(1); } }
if (!db.resets || typeof db.resets !== 'object') db.resets = {};
Object.values(db.users).forEach((u) => { u.doc = Doc.fixDoc(u.doc); });

let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { try { writeNow(); } catch (e) { console.error('save failed:', e.message); } }, 600);
}
function shutdown() { try { writeNow(); } catch { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

/* ============================== helpers ============================== */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
const normName = (s) => String(s || '').normalize('NFKC').trim();
const keyOf = (name) => normName(name).toLowerCase();
const NAME_RE = /^[\p{L}\p{N}_.\-]{3,32}$/u;
const DUMMY_SALT = crypto.randomBytes(16);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const normEmail = (s) => String(s || '').normalize('NFKC').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);
function userByEmail(email) { for (const k in db.users) if (db.users[k].email === email) return k; return null; }
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const buckets = new Map(); // rate limiting: key -> {n, reset}
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '?';
}

function newToken(userKey) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.tokens[sha(token)] = { u: userKey, exp: now + TOKEN_TTL, ext: now };
  const mine = Object.entries(db.tokens).filter(([, t]) => t.u === userKey).sort((a, b) => a[1].exp - b[1].exp);
  while (mine.length > MAX_TOKENS_PER_USER) { const [h] = mine.shift(); delete db.tokens[h]; closeSockets((s) => s.tokHash === h); }
  save();
  return token;
}
function auth(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const h = sha(token), t = db.tokens[h];
  if (!t) return null;
  const now = Date.now();
  if (t.exp < now) { delete db.tokens[h]; save(); return null; }
  const u = db.users[t.u];
  if (!u) return null;
  if (now - t.ext > 24 * 3600 * 1000) { t.ext = now; t.exp = now + TOKEN_TTL; save(); }
  return { u, key: t.u, hash: h };
}
function pruneTokens() {
  const now = Date.now(); let n = 0;
  for (const h in db.tokens) if (db.tokens[h].exp < now || !db.users[db.tokens[h].u]) { delete db.tokens[h]; n++; }
  for (const h in db.resets) if (db.resets[h].exp < now || !db.users[db.resets[h].u]) { delete db.resets[h]; n++; }
  if (n) save();
}
pruneTokens(); setInterval(pruneTokens, 3600000).unref();

/* ============================== realtime bookkeeping ============================== */
const conns = new Map();   // userKey -> Set<ws>
const pollSeen = new Map(); // tokenHash -> last poll time (counts as an online device)
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function devices(userKey) {
  const now = Date.now(); let n = (conns.get(userKey) || new Set()).size;
  for (const [h, t] of pollSeen) { if (now - t > 45000) pollSeen.delete(h); else if (db.tokens[h] && db.tokens[h].u === userKey) n++; }
  return n;
}
function broadcast(userKey, msg, except) { (conns.get(userKey) || new Set()).forEach((s) => { if (s !== except && s.authed) send(s, msg); }); }
function closeSockets(pred) { for (const set of conns.values()) set.forEach((s) => { if (pred(s)) s.close(4001, 'auth'); }); }

/* Core: pull what the caller is missing, merge what it sends. */
function syncOps(a, since, rawOps) {
  const doc = a.u.doc;
  const out = Number.isFinite(since) ? Doc.opsSince(doc, since) : [];
  const accepted = [];
  const limit = Date.now() + 30000;
  (Array.isArray(rawOps) ? rawOps.slice(0, 2000) : []).forEach((raw) => {
    const op = Doc.validateOp(raw);
    if (!op) return;
    if (op.t && op.t > limit) op.t = limit;
    const seq = doc.seq + 1;
    if (Doc.applyOp(doc, op, seq)) { doc.seq = seq; accepted.push(op); }
  });
  if (accepted.length) save();
  return { seq: doc.seq, ops: out, accepted };
}

/* ============================== HTTP ============================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const STATIC_RE = /^\/(index\.html|sw\.js|manifest\.webmanifest|(css|js|icons)\/[\w.\-]+)$/;

function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes('*') || ORIGINS.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req, max) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { rej(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { rej(Object.assign(new Error('bad_json'), { status: 400 })); } });
    req.on('error', rej);
  });
}
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };

async function register(req, res, ip) {
  if (!ALLOW_REGISTER) return json(res, 403, { error: 'closed' });
  if (limited('reg:' + ip, REGISTER_LIMIT, 3600000)) return json(res, 429, { error: 'rate_limited' });
  const b = await readBody(req, 4096);
  const name = normName(b.username), pw = typeof b.password === 'string' ? b.password : '';
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'invalid_username' });
  if (pw.length < 8 || pw.length > 128) return json(res, 400, { error: 'weak_password' });
  let email = '';
  if (b.email !== undefined && String(b.email).trim() !== '') {
    email = normEmail(b.email);
    if (!validEmail(email)) return json(res, 400, { error: 'invalid_email' });
  }
  const key = keyOf(name);
  if (db.users[key] || key === '__proto__') return json(res, 409, { error: 'exists' });
  if (email && userByEmail(email)) return json(res, 409, { error: 'email_taken' });
  if (Object.keys(db.users).length >= MAX_USERS) return json(res, 403, { error: 'closed' });
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt);
  if (db.users[key]) return json(res, 409, { error: 'exists' }); // re-check after the await
  if (email && userByEmail(email)) return json(res, 409, { error: 'email_taken' });
  db.users[key] = { name, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(), doc: Doc.emptyDoc() };
  if (email) db.users[key].email = email;
  json(res, 200, { token: newToken(key), user: name });
}

async function login(req, res, ip) {
  if (limited('login:' + ip, 20, 900000)) return json(res, 429, { error: 'rate_limited' });
  const b = await readBody(req, 4096);
  const key = keyOf(b.username), pw = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
  if (limited('user:' + key, 8, 900000)) return json(res, 429, { error: 'rate_limited' });
  const u = Object.prototype.hasOwnProperty.call(db.users, key) ? db.users[key] : null;
  const hash = await scrypt(pw, u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT); // same work whether or not the user exists
  if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) return json(res, 401, { error: 'bad_credentials' });
  json(res, 200, { token: newToken(key), user: u.name });
}

/* ============================== password recovery (Resend) ============================== */
const MAILS = {
  en: { s: 'Reset your Melodust password', h: 'Password reset', p: 'Someone (hopefully you) asked to reset the password of the account “{u}”. The link works for 30 minutes and only once.', b: 'Set a new password', i: 'If this wasn’t you, just ignore this email — your password stays the same.' },
  uk: { s: 'Відновлення пароля Melodust', h: 'Відновлення пароля', p: 'Хтось (сподіваємось, ти) попросив скинути пароль акаунта «{u}». Посилання діє 30 хвилин і лише один раз.', b: 'Встановити новий пароль', i: 'Якщо це був не ти, просто ігноруй цей лист — пароль залишиться тим самим.' },
  ru: { s: 'Восстановление пароля Melodust', h: 'Восстановление пароля', p: 'Кто-то (надеемся, ты) попросил сбросить пароль аккаунта «{u}». Ссылка действует 30 минут и только один раз.', b: 'Установить новый пароль', i: 'Если это был не ты, просто игнорируй это письмо — пароль останется прежним.' }
};

async function sendMail(to, subject, text, html) {
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 300));
}

function resetMail(lang, username, link) {
  const m = MAILS[lang] || MAILS.en, p = m.p.replace('{u}', username);
  const text = `${m.h}\n\n${p}\n\n${link}\n\n${m.i}\n`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1b22">
<h2 style="margin:0 0 12px">${esc(m.h)}</h2><p style="line-height:1.5">${esc(p)}</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#7c5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">${esc(m.b)}</a></p>
<p style="color:#666;font-size:13px;line-height:1.5">${esc(m.i)}</p></div>`;
  return { subject: m.s, text, html };
}

async function forgot(req, res, ip) {
  if (limited('fg:' + ip, 5, 3600000)) return json(res, 429, { error: 'rate_limited' });
  const b = await readBody(req, 4096);
  const email = normEmail(b.email);
  if (!validEmail(email)) return json(res, 400, { error: 'invalid_email' });
  if (!MAIL_ON) return json(res, 503, { error: 'mail_off' });
  if (limited('fgm:' + email, 3, 3600000)) return json(res, 200, { ok: true }); // silent: don't reveal anything
  const key = userByEmail(email);
  if (key) {
    for (const h in db.resets) if (db.resets[h].u === key) delete db.resets[h]; // only the newest link works
    const token = crypto.randomBytes(32).toString('base64url');
    db.resets[sha(token)] = { u: key, exp: Date.now() + RESET_TTL };
    save();
    const mail = resetMail(String(b.lang || ''), db.users[key].name, `${SITE_URL}/?reset=${token}`);
    sendMail(email, mail.subject, mail.text, mail.html).catch((e) => console.error('mail failed:', e.message));
  }
  json(res, 200, { ok: true }); // same answer whether or not the email is known
}

async function resetPassword(req, res, ip) {
  if (limited('rs:' + ip, 10, 3600000)) return json(res, 429, { error: 'rate_limited' });
  const b = await readBody(req, 4096);
  const token = typeof b.token === 'string' ? b.token : '', pw = typeof b.password === 'string' ? b.password : '';
  if (pw.length < 8 || pw.length > 128) return json(res, 400, { error: 'weak_password' });
  const h = token.length >= 20 && token.length <= 100 ? sha(token) : '';
  const r = h && Object.prototype.hasOwnProperty.call(db.resets, h) ? db.resets[h] : null;
  if (r) { delete db.resets[h]; save(); } // single use, burned before the slow hash
  if (!r || r.exp < Date.now() || !db.users[r.u]) return json(res, 400, { error: 'bad_token' });
  const u = db.users[r.u];
  const salt = crypto.randomBytes(16), hash = await scrypt(pw, salt);
  u.salt = salt.toString('hex'); u.hash = hash.toString('hex');
  for (const th in db.tokens) if (db.tokens[th].u === r.u) delete db.tokens[th]; // sign out every device
  closeSockets((s) => s.uk === r.u);
  save();
  json(res, 200, { ok: true });
}

async function setEmail(req, res, a) {
  if (limited('em:' + a.key, 10, 3600000)) return json(res, 429, { error: 'rate_limited' });
  const b = await readBody(req, 4096);
  const pw = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
  const hash = await scrypt(pw, Buffer.from(a.u.salt, 'hex'));
  if (!crypto.timingSafeEqual(hash, Buffer.from(a.u.hash, 'hex'))) return json(res, 403, { error: 'bad_credentials' }); // changing the recovery address needs the password
  const email = normEmail(b.email);
  if (!email) { delete a.u.email; save(); return json(res, 200, { email: '' }); }
  if (!validEmail(email)) return json(res, 400, { error: 'invalid_email' });
  const owner = userByEmail(email);
  if (owner && owner !== a.key) return json(res, 409, { error: 'email_taken' });
  a.u.email = email; save();
  json(res, 200, { email });
}

function serveStatic(req, res, url) {
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!STATIC_RE.test(p)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(SITE_DIR, p), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': /^\/(index\.html|sw\.js)$/.test(p) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  try {
    if (url.pathname.startsWith('/api/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      if (url.pathname === '/api/register') return await register(req, res, ip);
      if (url.pathname === '/api/login') return await login(req, res, ip);
      if (url.pathname === '/api/forgot') return await forgot(req, res, ip);
      if (url.pathname === '/api/reset') return await resetPassword(req, res, ip);
      const a = auth(bearer(req));
      if (!a) return json(res, 401, { error: 'auth' });
      if (url.pathname === '/api/logout') { delete db.tokens[a.hash]; save(); closeSockets((s) => s.tokHash === a.hash); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/me') return json(res, 200, { user: a.u.name, email: a.u.email || '', mail: MAIL_ON });
      if (url.pathname === '/api/email') return await setEmail(req, res, a);
      if (url.pathname === '/api/sync') {
        if (limited('sync:' + a.hash, 120, 60000)) return json(res, 429, { error: 'rate_limited' });
        const b = await readBody(req, 4 * 1024 * 1024);
        pollSeen.set(a.hash, Date.now());
        const r = syncOps(a, Number.isFinite(+b.since) ? +b.since : 0, b.ops);
        if (r.accepted.length) broadcast(a.key, { t: 'ops', seq: r.seq, ops: r.accepted });
        return json(res, 200, { seq: r.seq, now: Date.now(), devices: devices(a.key), ops: r.ops });
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (SERVE_STATIC && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res, url);
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status === 413 ? 'too_large' : e.status === 400 ? 'bad_json' : 'server' });
    if (!e.status) console.error(e);
  }
});

/* ============================== WebSocket ============================== */
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function announce(userKey) { const n = devices(userKey); broadcast(userKey, { t: 'presence', devices: n }); }

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.authed = false; ws.uk = null; ws.tokHash = null;
  ws.rate = { n: 0, reset: Date.now() + 10000 };
  const authTimer = setTimeout(() => { if (!ws.authed) ws.close(4002, 'auth timeout'); }, 10000);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', (data) => {
    const now = Date.now();
    if (now > ws.rate.reset) ws.rate = { n: 0, reset: now + 10000 };
    if (++ws.rate.n > 120) return ws.close(4008, 'rate');
    let m; try { m = JSON.parse(data.toString('utf8')); } catch { return ws.close(4003, 'bad json'); }
    if (!m || typeof m !== 'object') return ws.close(4003, 'bad msg');

    if (!ws.authed) {
      if (m.t !== 'auth') return ws.close(4003, 'auth first');
      const a = auth(m.token);
      if (!a) { send(ws, { t: 'err', code: 'auth' }); return ws.close(4001, 'auth'); }
      clearTimeout(authTimer);
      ws.authed = true; ws.uk = a.key; ws.tokHash = a.hash;
      if (!conns.has(a.key)) conns.set(a.key, new Set());
      conns.get(a.key).add(ws);
      const r = syncOps(a, Number.isFinite(+m.since) ? +m.since : 0, m.ops);
      send(ws, { t: 'ready', seq: r.seq, now: Date.now(), devices: devices(a.key), ops: r.ops, ack: m.id, user: a.u.name });
      if (r.accepted.length) broadcast(a.key, { t: 'ops', seq: r.seq, ops: r.accepted }, ws);
      announce(a.key);
      return;
    }
    // token may have been revoked / expired since connecting
    const tk = db.tokens[ws.tokHash];
    const a = tk && tk.exp > Date.now() && db.users[ws.uk] ? { u: db.users[ws.uk], key: ws.uk, hash: ws.tokHash } : null;
    if (!a) { send(ws, { t: 'err', code: 'auth' }); return ws.close(4001, 'auth'); }

    if (m.t === 'push') {
      const r = syncOps(a, Infinity, m.ops);
      send(ws, { t: 'ack', id: m.id, seq: r.seq });
      if (r.accepted.length) broadcast(a.key, { t: 'ops', seq: r.seq, ops: r.accepted }, ws);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong' });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.uk && conns.has(ws.uk)) {
      conns.get(ws.uk).delete(ws);
      if (!conns.get(ws.uk).size) conns.delete(ws.uk);
      announce(ws.uk);
    }
  });
});

const hb = setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch { /* ignore */ } });
}, 30000);
hb.unref();

if (require.main === module) {
  const done = () => console.log(`Melodust sync server on ${PORT === 'passenger' ? 'passenger' : HOST + ':' + PORT} · data: ${DB_FILE} · static: ${SERVE_STATIC ? 'on' : 'off'} · mail: ${MAIL_ON ? 'on' : 'off'}`);
  if (PORT === 'passenger') server.listen(PORT, done); else server.listen(PORT, HOST, done);
}
module.exports = { server, db };
