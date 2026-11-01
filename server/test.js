'use strict';
/* Integration test: node test.js  (needs Node 22+ for the built-in WebSocket client) */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 4100 + Math.floor(Math.random() * 500);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sync-'));
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('http');
const MAILPORT = PORT + 600;
const mails = []; // captured "Resend" requests
const mailSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { mails.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"test"}'); });
});
const post = async (p, body, token) => {
  const r = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
function client(token, since = 0, ops = []) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, msgs: [], closed: null };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 'ready') res(c); };
    ws.onclose = (e) => { c.closed = e.code; if (!c.msgs.some((m) => m.t === 'ready')) res(c); };
    ws.onerror = () => {};
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, since, ops, id: 1 }));
    c.next = async (type, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const i = c.msgs.findIndex((m) => m.t === type); if (i >= 0) return c.msgs.splice(i, 1)[0]; await sleep(20); } throw new Error('timeout waiting for ' + type); };
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
}

(async () => {
  await new Promise((r) => mailSrv.listen(MAILPORT, '127.0.0.1', r));
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, {
    PORT, DATA_DIR: DATA, HOST: '127.0.0.1', REGISTER_LIMIT: '50',
    RESEND_API_KEY: 're_test_key', MAIL_FROM: 'Melodust <noreply@example.com>', SITE_URL: 'https://site.example.com', RESEND_API_URL: `http://127.0.0.1:${MAILPORT}/emails`
  }), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('on ') && r()));
  let pass = 0; const ok = (name) => { pass++; console.log('  ✓', name); };
  try {
    // --- accounts
    assert.strictEqual((await post('/api/register', { username: 'ab', password: 'longenough' })).body.error, 'invalid_username'); ok('rejects short username');
    assert.strictEqual((await post('/api/register', { username: 'Даніїл', password: 'short' })).body.error, 'weak_password'); ok('rejects weak password');
    const reg = await post('/api/register', { username: 'Даніїл', password: 'correct horse' });
    assert.strictEqual(reg.status, 200); assert.ok(reg.body.token); ok('registers (unicode name)');
    assert.strictEqual((await post('/api/register', { username: 'даніїл', password: 'correct horse' })).status, 409); ok('username is case-insensitive unique');
    assert.strictEqual((await post('/api/login', { username: 'Даніїл', password: 'wrong password' })).status, 401); ok('wrong password -> 401');
    const lg = await post('/api/login', { username: 'ДАНІЇЛ', password: 'correct horse' });
    assert.strictEqual(lg.status, 200); ok('login');
    assert.strictEqual((await post('/api/me', {}, 'x'.repeat(43))).status, 401); ok('bad token -> 401');

    // --- websocket: two devices
    const T1 = reg.body.token, T2 = lg.body.token;
    const A = await client(T1), B = await client(T2);
    assert.ok(A.msgs.some((m) => m.t === 'ready')); assert.strictEqual(B.msgs.find((m) => m.t === 'ready').devices, 2); ok('two devices online');
    const t0 = Date.now();
    A.ws.send(JSON.stringify({ t: 'push', id: 7, ops: [
      { k: 'f', id: 'Music/a.mp3|100', on: true, t: t0 },
      { k: 'p', id: 'pl1', name: 'Gym', ids: ['x', 'y'], c: t0, del: false, t: t0 },
      { k: 's', id: 'c1', v: '#112233', t: t0 }
    ] }));
    const ack = await A.next('ack'); assert.strictEqual(ack.id, 7);
    const ops = await B.next('ops'); assert.strictEqual(ops.ops.length, 3); ok('push is acked and broadcast to the other device');

    // --- last-write-wins
    B.ws.send(JSON.stringify({ t: 'push', id: 8, ops: [{ k: 'f', id: 'Music/a.mp3|100', on: false, t: t0 - 5000 }] }));
    await B.next('ack'); await sleep(100);
    assert.ok(!A.msgs.some((m) => m.t === 'ops')); ok('older write is ignored (no broadcast)');
    B.ws.send(JSON.stringify({ t: 'push', id: 9, ops: [{ k: 'f', id: 'Music/a.mp3|100', on: false, t: t0 + 5000 }] }));
    const o2 = await A.next('ops'); assert.strictEqual(o2.ops[0].on, false); ok('newer write wins and is broadcast');

    // --- validation
    A.ws.send(JSON.stringify({ t: 'push', id: 10, ops: [
      { k: 's', id: 'bass', v: 999, t: t0 }, { k: 's', id: 'volume', v: 1, t: t0 }, { k: 'f', id: '__proto__', on: true, t: t0 },
      { k: 'r', id: 'javascript:alert(1)', name: 'x', del: false, t: t0 }, { k: 'p', id: 'p', name: 'x', ids: [1], c: t0, del: false, t: t0 }, { k: 'zzz' }, null, 5
    ] }));
    await A.next('ack'); await sleep(100);
    assert.ok(!B.msgs.some((m) => m.t === 'ops')); ok('invalid ops are dropped');
    A.ws.send(JSON.stringify({ t: 'push', id: 11, ops: [{ k: 'f', id: 'future', on: true, t: Date.now() + 10 * 24 * 3600 * 1000 }] }));
    const fut = await B.next('ops'); assert.ok(fut.ops[0].t < Date.now() + 60000); ok('far-future timestamps are clamped');

    // --- polling fallback sees everything from the start
    const poll = await post('/api/sync', { since: 0, ops: [{ k: 'h', id: 'Music/a.mp3|100', t: t0 }, { k: 'n', id: 'Music/a.mp3|100', n: 3 }] }, T1);
    assert.strictEqual(poll.status, 200);
    const kinds = new Set(poll.body.ops.map((o) => o.k));
    ['f', 'p', 's'].forEach((k) => assert.ok(kinds.has(k), 'missing ' + k)); ok('HTTP polling returns full state');
    const bops = await B.next('ops'); assert.ok(bops.ops.some((o) => o.k === 'n')); ok('poll pushes reach websocket devices');
    const again = await post('/api/sync', { since: poll.body.seq, ops: [] }, T1);
    assert.strictEqual(again.body.ops.length, 0); ok('poll with current seq returns nothing');

    // --- history clear
    await post('/api/sync', { since: 0, ops: [{ k: 'hc', t: t0 + 1 }] }, T1);
    const st = await post('/api/sync', { since: 0, ops: [] }, T1);
    assert.ok(!st.body.ops.some((o) => o.k === 'h')); assert.ok(st.body.ops.some((o) => o.k === 'hc')); ok('history clear removes older entries');

    // --- new device starts from the server snapshot
    const C = await client(T1, 0); const rdy = C.msgs.find((m) => m.t === 'ready');
    assert.ok(rdy.ops.length >= 4); ok('new device receives snapshot on connect');

    // --- logout kills sockets
    await post('/api/logout', {}, T2); await sleep(150);
    assert.strictEqual(B.closed, 4001); ok('logout closes that device\'s socket');
    const bad = await client('nope'.repeat(8)); assert.strictEqual(bad.closed, 4001); ok('bad token on websocket -> close 4001');

    // --- email + password recovery (Resend is mocked)
    assert.strictEqual((await post('/api/register', { username: 'mailer', password: 'longenough', email: 'not-an-email' })).body.error, 'invalid_email'); ok('rejects invalid email');
    const mreg = await post('/api/register', { username: 'mailer', password: 'longenough', email: ' Mailer@Example.com ' });
    assert.strictEqual(mreg.status, 200); ok('registers with email');
    assert.strictEqual((await post('/api/register', { username: 'mailer2', password: 'longenough', email: 'mailer@example.com' })).body.error, 'email_taken'); ok('email is unique (case-insensitive)');
    assert.strictEqual((await post('/api/forgot', { email: 'nobody@example.com' })).status, 200);
    assert.strictEqual((await post('/api/forgot', { email: 'broken' })).body.error, 'invalid_email');
    await sleep(150); assert.strictEqual(mails.length, 0); ok('unknown email: same 200 answer, no mail sent');
    assert.strictEqual((await post('/api/forgot', { email: 'mailer@example.com', lang: 'uk' })).status, 200);
    await sleep(300); assert.strictEqual(mails.length, 1);
    const mail = mails[0]; assert.strictEqual(mail.auth, 'Bearer re_test_key'); assert.deepStrictEqual(mail.body.to, ['mailer@example.com']);
    assert.ok(mail.body.from.includes('noreply@example.com') && mail.body.html.includes('https://site.example.com/?reset=')); ok('reset mail goes through Resend with a link');
    const rtoken = /\?reset=([\w-]+)/.exec(mail.body.text)[1];
    assert.strictEqual((await post('/api/reset', { token: rtoken, password: 'short' })).body.error, 'weak_password');
    assert.strictEqual((await post('/api/reset', { token: 'x'.repeat(43), password: 'brand new pass' })).body.error, 'bad_token'); ok('bad token / weak password rejected');
    const mws = await client(mreg.body.token);
    assert.strictEqual((await post('/api/reset', { token: rtoken, password: 'brand new pass' })).status, 200);
    assert.strictEqual((await post('/api/reset', { token: rtoken, password: 'another pass 1' })).body.error, 'bad_token'); ok('reset works once, token is single-use');
    await sleep(150); assert.strictEqual(mws.closed, 4001);
    assert.strictEqual((await post('/api/me', {}, mreg.body.token)).status, 401); ok('reset signs out all old sessions');
    assert.strictEqual((await post('/api/login', { username: 'mailer', password: 'longenough' })).status, 401);
    const mlog = await post('/api/login', { username: 'mailer', password: 'brand new pass' }); assert.strictEqual(mlog.status, 200); ok('old password dead, new password works');
    const me = await post('/api/me', {}, mlog.body.token); assert.strictEqual(me.body.email, 'mailer@example.com');
    assert.strictEqual((await post('/api/email', { email: 'x@y.com', password: 'wrong' }, mlog.body.token)).status, 403); ok('changing email needs the current password');
    assert.strictEqual((await post('/api/email', { email: 'new@example.com', password: 'brand new pass' }, mlog.body.token)).body.email, 'new@example.com');
    assert.strictEqual((await post('/api/email', { email: 'new@example.com', password: 'correct horse' }, T1)).body.error, 'email_taken'); ok('email can be changed; duplicates refused');

    // --- static serving whitelist
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/js/syncdoc.js')).status, 200);
    assert.strictEqual((await fetch(base + '/server/data/db.json')).status, 404);
    assert.strictEqual((await fetch(base + '/server/server.js')).status, 404);
    assert.strictEqual((await fetch(base + '/..%2fserver/data/db.json')).status, 404); ok('static server only exposes site files');

    // --- persistence
    await sleep(900);
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
    assert.ok(saved.users['даніїл'] && saved.users['даніїл'].hash && !JSON.stringify(saved).includes('correct horse')); ok('state persisted, password not stored in clear');

    [A, B, C].forEach((c) => c.ws.close());
    console.log(`\nAll ${pass} checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); setTimeout(r, 3000); }); // wait: the server flushes db.json on exit
    mailSrv.close();
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir, not worth failing the test */ }
  }
})();
