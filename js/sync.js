/* Melodust Web — account sync: favorites, playlists, history, radio, play counts and settings
   follow the account across devices in real time (WebSocket, with HTTP polling as a fallback).
   Audio files never leave the device. Conflict rule: last write wins per record (see syncdoc.js). */
(function () {
  'use strict';
  const M = window.M, Doc = window.MWDoc;
  const CFG = Object.assign({ api: '', disabled: false }, window.MW_SYNC || {});
  const base = String(CFG.api || '').replace(/\/+$/, '');
  const origin = base || location.origin;
  M.syncAvailable = !CFG.disabled && /^https?:/.test(origin);

  const S = { status: 'off', devices: 0, mode: 'ws' }; // status: off | connecting | online | offline
  let A = M.ls.get('mw.account', null);                 // { token, user }
  let doc = null, outbox = new Map(), since = 0, linked = false;
  let active = false, applying = false, offset = 0;
  let ws = null, wsReady = false, wsEver = false, wsFails = 0, retry = 0, retryT = 0, hbT = 0, pollT = 0, wsRetryT = 0, polling = false;
  let mid = 0;
  const inflight = new Map(), sent = new WeakSet();

  const nowT = () => Date.now() + offset;
  const setStatus = (status, extra) => { Object.assign(S, { status }, extra); M.emit('sync', S); };
  const okey = (op) => (op.k === 'hc' ? 'hc' : op.k + ':' + op.id);

  /* ---------- persistence of the replica ---------- */
  const persist = M.debounce(() => {
    if (!doc) return;
    M.db.kvSet('syncstate', { doc, outbox: [...outbox.values()], since, linked });
  }, 800);

  async function loadState() {
    const st = await M.db.kvGet('syncstate');
    doc = st && st.doc ? Doc.fixDoc(st.doc) : Doc.emptyDoc();
    outbox = new Map(((st && st.outbox) || []).map((o) => [okey(o), o]));
    since = (st && st.since) || 0;
    linked = !!(st && st.linked);
  }

  /* ---------- local change detection ---------- */
  const eqArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Compare what the app holds (M.U / M.S) with the replica and turn differences into ops.
  function detect(skipSettings) {
    if (!doc || !active) return 0;
    const U = M.U, now = nowT(), ops = [];
    const bump = (e, t) => Math.max(t, e ? e.t + 1 : 0);

    // favorites (newest first == larger timestamp)
    const favSet = new Set(U.fav);
    U.fav.forEach((id, i) => { const e = Doc.get(doc.f, id); if (!e || !e.on) ops.push({ k: 'f', id, on: true, t: bump(e, now - i) }); });
    for (const id in doc.f) if (doc.f[id].on && !favSet.has(id)) ops.push({ k: 'f', id, on: false, t: bump(doc.f[id], now) });

    // playlists
    const plIds = new Set();
    U.playlists.forEach((p, i) => {
      plIds.add(p.id);
      const e = Doc.get(doc.p, p.id), name = String(p.name || '').slice(0, 80), ids = p.ids.slice(0, Doc.LIM.ids);
      if (!e || e.del || e.name !== name || !eqArr(e.ids, ids)) ops.push({ k: 'p', id: p.id, name, ids, c: e ? e.c : now + i, del: false, t: bump(e, now) });
    });
    for (const id in doc.p) { const e = doc.p[id]; if (!e.del && !plIds.has(id)) ops.push({ k: 'p', id, name: e.name, ids: [], c: e.c, del: true, t: bump(e, now) }); }

    // radio stations
    const urls = new Set();
    U.radio.forEach((s, i) => {
      urls.add(s.url);
      const e = Doc.get(doc.r, s.url), name = String(s.name || '').slice(0, 80);
      if (!e || e.del || e.name !== name) ops.push({ k: 'r', id: s.url, name, del: false, t: bump(e, now - U.radio.length + i) });
    });
    for (const id in doc.r) { const e = doc.r[id]; if (!e.del && !urls.has(id)) ops.push({ k: 'r', id, name: e.name, del: true, t: bump(e, now) }); }

    // recent history
    const R = U.recent, proj = recentFromDoc();
    if (!R.length) { if (proj.length) ops.push({ k: 'hc', t: Math.max(now, doc.hc.t + 1) }); }
    else {
      const have = new Set(proj);
      R.forEach((id, i) => { if (!have.has(id) || (i === 0 && proj[0] !== id)) ops.push({ k: 'h', id, t: bump(Doc.get(doc.h, id), now - i) }); });
    }

    // play counts (merged as max per track)
    for (const id in U.plays) { const n = U.plays[id], e = Doc.get(doc.n, id); if (Number.isInteger(n) && n > 0 && (!e || n > e.n)) ops.push({ k: 'n', id, n }); }

    // settings
    if (!skipSettings) {
      Doc.SETTING_KEYS.forEach((key) => {
        if (key === 'bg' && M.S.bg === 'custom') return; // photo background stays on this device
        const v = M.S[key], e = Doc.get(doc.s, key);
        if (v === undefined) return;
        if (!e || JSON.stringify(e.v) !== JSON.stringify(v)) ops.push({ k: 's', id: key, v: Doc.clone(v), t: bump(e, now) });
      });
    }

    let n = 0;
    ops.forEach((raw) => { const op = Doc.validateOp(raw); if (op && Doc.applyOp(doc, op)) { outbox.set(okey(op), op); n++; } });
    if (n) persist();
    return n;
  }

  function recentFromDoc() {
    return Object.keys(doc.h).filter((id) => doc.h[id].t > doc.hc.t).sort((a, b) => doc.h[b].t - doc.h[a].t).slice(0, 100);
  }

  const schedDetect = M.debounce(() => {
    if (!active || !doc || applying) return;
    if (detect()) kick();
  }, 500);

  // hook every place the app saves user data / settings
  const origSaveU = M.saveU, origSaveS = M.saveS;
  M.saveU = () => { origSaveU(); schedDetect(); };
  M.saveS = () => { origSaveS(); schedDetect(); };

  /* ---------- applying remote ops to the app ---------- */
  function applyRemote(ops) {
    if (!Array.isArray(ops) || !ops.length) return;
    if (detect(!linked)) kick(); // stamp (and send) edits still waiting for the debounce, so they aren't overwritten
    const ch = new Set();
    ops.forEach((raw) => { const op = Doc.validateOp(raw); if (op && Doc.applyOp(doc, op)) ch.add(op.k === 's' ? 's:' + op.id : op.k); });
    if (ch.size) { rebuild(ch); persist(); }
  }

  function rebuild(ch) {
    applying = true;
    try {
      const U = M.U, St = M.S, ev = new Set(), skeys = new Set();
      ch.forEach((c) => { if (c.startsWith('s:')) skeys.add(c.slice(2)); });
      if (ch.has('f')) {
        U.fav = Object.keys(doc.f).filter((id) => doc.f[id].on).sort((a, b) => doc.f[b].t - doc.f[a].t || (a < b ? -1 : 1)); ev.add('fav');
      }
      if (ch.has('p')) {
        const old = new Map(U.playlists.map((p) => [p.id, p]));
        U.playlists = Object.keys(doc.p).filter((id) => !doc.p[id].del).sort((a, b) => doc.p[a].c - doc.p[b].c || (a < b ? -1 : 1)).map((id) => {
          const p = old.get(id) || { id }; p.name = doc.p[id].name; p.ids = doc.p[id].ids.slice(); return p;
        });
        ev.add('playlists');
      }
      if (ch.has('r')) {
        U.radio = Object.keys(doc.r).filter((u) => !doc.r[u].del).sort((a, b) => doc.r[a].t - doc.r[b].t).map((url) => ({ name: doc.r[url].name, url }));
        ev.add('radio');
      }
      if (ch.has('h') || ch.has('hc')) { U.recent = recentFromDoc(); ev.add('recent'); }
      if (ch.has('n')) { const pl = {}; for (const id in doc.n) pl[id] = doc.n[id].n; U.plays = pl; }
      skeys.forEach((k) => { St[k] = Doc.clone(doc.s[k].v); });
      M.ls.set('mw.user', U); M.ls.set('mw.settings', St);

      if (skeys.has('lang')) { M.setLang(St.lang); M.buildChrome(); M.emit('lang'); }
      if (skeys.has('c1') || skeys.has('c2') || skeys.has('dynamic')) {
        if (!St.dynamic || !(M.curTrack() && M.coverUrl(M.curTrack()))) M.applyTheme(St.c1, St.c2); else if (M.themeFromCover) M.themeFromCover();
        M.emit('theme');
      }
      if (skeys.has('bg')) M.applyBg();
      if (['bass', 'eq', 'eqOn', 'night', 'd8', 'd8speed'].some((k) => skeys.has(k))) { M.applyAudio(); M.emit('mode'); }
      if (skeys.has('speed') || skeys.has('keepPitch')) M.applyElement();
      if (skeys.has('sort')) M.sortLib();
      ev.forEach((e) => M.emit(e));
      refreshView(ch, skeys);
    } finally { applying = false; }
  }

  function refreshView(ch, skeys) {
    const v = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'library';
    const d = M.$('#dialog'), busy = (d && !d.hidden) || (document.activeElement && M.$('#view').contains(document.activeElement) && /^(input|select|textarea)$/i.test(document.activeElement.tagName));
    if (busy) return;
    if ((v === 'playlists' && (ch.has('f') || ch.has('p') || ch.has('h') || ch.has('hc'))) || (v === 'radio' && ch.has('r')) ||
        (v === 'settings' && skeys.size) || (v === 'library' && (skeys.has('view') || skeys.has('sort')))) M.route();
  }

  /* ---------- transport ---------- */
  const wsUrl = () => origin.replace(/^http/i, 'ws') + '/ws';

  function connect() {
    if (!active || ws || polling || !A) return;
    if (S.mode === 'poll') { startPoll(); return; }
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch { wsFailed(); return; }
    ws = sock; wsReady = false;
    sock.onopen = () => {
      sock.send(JSON.stringify({ t: 'auth', token: A.token, since, id: 0, ops: [] }));
    };
    sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    sock.onerror = () => {};
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      clearInterval(hbT); inflight.clear();
      const was = wsReady; wsReady = false;
      if (e.code === 4001) { authLost(); return; }
      if (!active) return;
      if (!was && !wsEver) { wsFails++; if (wsFails >= 2) { S.mode = 'poll'; startPoll(); wsRetryT = setTimeout(() => { if (active && S.mode === 'poll') { wsFails = 1; stopPoll(); S.mode = 'ws'; connect(); } }, 300000); return; } }
      setStatus('offline');
      const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)); // 1s, 2s, 4s … 30s
      clearTimeout(retryT); retryT = setTimeout(connect, delay);
    };
  }
  function wsFailed() { wsFails = 2; S.mode = 'poll'; startPoll(); }

  function onMsg(m) {
    if (m.t === 'ready') {
      offset = (+m.now || Date.now()) - Date.now();
      wsReady = true; wsEver = true; wsFails = 0; retry = 0;
      S.devices = m.devices || 1;
      applyRemote(m.ops); since = Math.max(since, +m.seq || 0);
      linked = true; detect(); persist();
      setStatus('online');
      clearInterval(hbT); hbT = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);
      flush();
    } else if (m.t === 'ops') {
      applyRemote(m.ops); since = Math.max(since, +m.seq || 0); persist();
    } else if (m.t === 'ack') {
      const ops = inflight.get(m.id); inflight.delete(m.id);
      if (ops) ops.forEach((o) => { if (outbox.get(okey(o)) === o) outbox.delete(okey(o)); });
      persist(); M.emit('sync', S);
    } else if (m.t === 'presence') {
      S.devices = m.devices || 1; M.emit('sync', S);
    } else if (m.t === 'err' && m.code === 'auth') authLost();
  }

  function flush() {
    if (!ws || !wsReady || ws.readyState !== 1) return;
    const list = [...outbox.values()].filter((o) => !sent.has(o));
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500), id = ++mid;
      chunk.forEach((o) => sent.add(o)); inflight.set(id, chunk);
      ws.send(JSON.stringify({ t: 'push', id, ops: chunk }));
    }
  }

  /* HTTP fallback: one request pushes local ops and pulls remote ones */
  let pollBusy = false;
  const pollEvery = () => (document.hidden ? 60000 : 12000);
  async function pollOnce() {
    if (!active || !A || !doc || pollBusy) return;
    pollBusy = true;
    try {
      const batch = [...outbox.values()].slice(0, 1000);
      const r = await call('/api/sync', { since, ops: batch }, A.token);
      offset = (+r.now || Date.now()) - Date.now();
      batch.forEach((o) => { if (outbox.get(okey(o)) === o) outbox.delete(okey(o)); });
      applyRemote(r.ops); since = Math.max(since, +r.seq || 0);
      S.devices = r.devices || 1;
      if (!linked) { linked = true; detect(); }
      persist(); setStatus('online');
    } catch (e) {
      if (e.status === 401) authLost(); else setStatus('offline');
    } finally { pollBusy = false; }
  }
  function schedulePoll(ms) {
    clearTimeout(pollT);
    if (polling) pollT = setTimeout(async () => { await pollOnce(); schedulePoll(pollEvery()); }, ms);
  }
  function startPoll() {
    if (polling) return; polling = true;
    pollOnce().then(() => schedulePoll(pollEvery()));
  }
  function stopPoll() { polling = false; clearTimeout(pollT); }

  // push local changes now (WebSocket: flush, polling: request immediately)
  const kick = M.debounce(() => {
    if (polling) { clearTimeout(pollT); pollOnce().then(() => schedulePoll(pollEvery())); } else flush();
  }, 150);

  function stopAll() {
    active = false; stopPoll();
    clearTimeout(retryT); clearTimeout(wsRetryT); clearInterval(hbT);
    if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } }
    wsReady = false; wsFails = 0; retry = 0; S.mode = 'ws'; inflight.clear();
  }

  function start() {
    if (active || !A || !doc) return;
    active = true;
    detect(!linked); // first link: don't let local settings override the account's settings
    persist();
    connect();
  }

  function authLost() {
    stopAll(); A = null; M.ls.set('mw.account', null); M.db.kvDel('syncstate'); doc = null; outbox = new Map(); since = 0; linked = false;
    setStatus('off'); M.toast(M.t('sync.expired'));
  }

  window.addEventListener('online', () => { if (!active) return; if (ws && wsReady) { setStatus('online'); flush(); } else if (!ws && !polling) { clearTimeout(retryT); connect(); } else if (polling) pollOnce(); });
  window.addEventListener('offline', () => { if (active) setStatus('offline'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) { if (polling) pollOnce(); else if (!ws) { clearTimeout(retryT); connect(); } } });
  window.addEventListener('pagehide', () => { if (doc && active) { detect(); M.db.kvSet('syncstate', { doc, outbox: [...outbox.values()], since, linked }); } });

  /* ---------- API ---------- */
  async function call(path, body, token) {
    let r;
    try {
      r = await fetch(origin + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) });
    } catch { throw Object.assign(new Error('network'), { code: 'network' }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'server'), { status: r.status, code: j.error || 'server' });
    return j;
  }

  async function enter(path, username, password, email) {
    const j = await call(path, email ? { username, password, email } : { username, password });
    stopAll();
    A = { token: j.token, user: j.user };
    M.ls.set('mw.account', A);
    doc = Doc.emptyDoc(); outbox = new Map(); since = 0; linked = false;
    await M.db.kvDel('syncstate');
    start();
    return j.user;
  }

  async function logout() {
    const tok = A && A.token;
    stopAll(); A = null; M.ls.set('mw.account', null); await M.db.kvDel('syncstate');
    doc = null; outbox = new Map(); since = 0; linked = false;
    setStatus('off');
    if (tok) call('/api/logout', {}, tok).catch(() => {});
  }

  M.sync = {
    S,
    account: () => A,
    async init() {
      if (!M.syncAvailable || !A) { setStatus('off'); return; }
      await loadState();
      start();
    },
    login: (u, p) => enter('/api/login', u, p),
    register: (u, p, email) => enter('/api/register', u, p, email),
    forgot: (email) => call('/api/forgot', { email, lang: M.S.lang }),
    reset: (token, password) => call('/api/reset', { token, password }),
    me: () => (A ? call('/api/me', {}, A.token) : Promise.reject(new Error('auth'))),
    setEmail: (email, password) => call('/api/email', { email, password }, A && A.token),
    logout,
    now() { if (!active) return; detect(); if (polling) pollOnce(); else if (!ws) { clearTimeout(retryT); connect(); } else flush(); },
    pending: () => outbox.size
  };

  /* ---------- UI: settings section ---------- */
  const esc = M.esc, t = (k, ...a) => M.t(k, ...a);

  function statusText() {
    if (S.status === 'online') return t(S.mode === 'poll' ? 'sync.st.poll' : 'sync.st.online') + (S.devices > 1 ? ' · ' + t('sync.devices', S.devices) : '');
    if (S.status === 'connecting') return t('sync.st.connecting');
    return t('sync.st.offline');
  }

  M.sync.mount = (box, sub) => {
    const draw = () => {
      if (!M.syncAvailable) { box.innerHTML = `<p class="sub">${esc(t('sync.err.unavailable'))}</p>`; return; }
      if (!A) {
        box.innerHTML = `<p class="sub">${esc(t('sync.about'))}</p><div class="btns"><button class="primary" id="syIn">${esc(t('sync.signin'))}</button></div>`;
        M.$('#syIn', box).onclick = () => authDialog('login');
        return;
      }
      box.innerHTML = `<div class="row-s"><div><b>${esc(A.user)}</b><small id="syStat">${esc(statusText())}</small></div><span class="sy-dot ${S.status}" aria-hidden="true"></span></div>
        <div class="row-s"><div><b>Email</b><small id="syMail">…</small></div><button class="ghost" id="syEm">${esc(t('sync.emailBtn'))}</button></div>
        <div class="btns"><button class="ghost" id="syNow">${esc(t('sync.now'))}</button><button class="ghost danger" id="syOut">${esc(t('sync.signout'))}</button></div>
        <small class="sub">${esc(t('sync.what'))}</small>`;
      M.sync.me().then((r) => { const el = M.$('#syMail', box); if (el) el.textContent = r.email || t('sync.noEmail'); }).catch(() => { const el = M.$('#syMail', box); if (el) el.textContent = '—'; });
      M.$('#syEm', box).onclick = () => emailDialog(draw);
      M.$('#syNow', box).onclick = () => { M.sync.now(); M.toast(t('sync.synced')); };
      M.$('#syOut', box).onclick = async () => { await logout(); M.toast(t('sync.out')); draw(); };
    };
    draw();
    sub('sync', () => { if (!box.isConnected) return; if (A && M.$('#syStat', box)) { M.$('#syStat', box).textContent = statusText(); const d = M.$('.sy-dot', box); if (d) d.className = 'sy-dot ' + S.status; } else draw(); });
  };

  function authDialog(mode) {
    const reg = mode === 'register';
    M.dialog(`<h3>${esc(t(reg ? 'sync.register' : 'sync.login'))}</h3>
      <input id="syU" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="${esc(t('sync.username'))}">
      <input id="syP" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="128" placeholder="${esc(t('sync.password'))}">
      ${reg ? `<input id="syP2" type="password" autocomplete="new-password" maxlength="128" placeholder="${esc(t('sync.password2'))}">
      <input id="syE" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="${esc(t('sync.email'))}">` : `<div class="btns"><button class="ghost" id="syFg">${esc(t('sync.forgot'))}</button></div>`}
      <p class="sub small">${esc(t('sync.hint'))}</p>
      <p class="sy-err" id="syErr" hidden></p>
      <div class="dlg-actions"><button class="ghost" id="sySw">${esc(t(reg ? 'sync.toLogin' : 'sync.toRegister'))}</button><button class="primary" id="syGo">${esc(t(reg ? 'sync.register' : 'sync.login'))}</button></div>`, (d, close) => {
      const U = M.$('#syU', d), P = M.$('#syP', d), P2 = M.$('#syP2', d), EM = M.$('#syE', d), E = M.$('#syErr', d), Go = M.$('#syGo', d);
      const fail = (code) => { E.textContent = t('sync.err.' + code); if (E.textContent === 'sync.err.' + code) E.textContent = t('sync.err.server'); E.hidden = false; };
      const go = async () => {
        E.hidden = true;
        const u = U.value.trim(), p = P.value;
        if (!/^[\p{L}\p{N}_.\-]{3,32}$/u.test(u)) return fail('invalid_username');
        if (p.length < 8 || p.length > 128) return fail('weak_password');
        if (reg && P2.value !== p) return fail('mismatch');
        const em = reg ? EM.value.trim() : '';
        if (em && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(em)) return fail('invalid_email');
        Go.disabled = true;
        try {
          const name = await (reg ? M.sync.register(u, p, em) : M.sync.login(u, p));
          close(); M.toast(t('sync.welcome', name));
          if (location.hash === '#/settings') M.route();
        } catch (e) { Go.disabled = false; fail(e.code || 'server'); }
      };
      Go.onclick = go;
      d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); };
      M.$('#sySw', d).onclick = () => { close(); authDialog(reg ? 'login' : 'register'); };
      const fg = M.$('#syFg', d); if (fg) fg.onclick = () => { close(); forgotDialog(); };
      U.focus();
    });
  }

  /* ---------- password recovery & email ---------- */
  const EMAIL_OK = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
  const showErr = (E, code) => { E.textContent = t('sync.err.' + code); if (E.textContent === 'sync.err.' + code) E.textContent = t('sync.err.server'); E.hidden = false; };

  function forgotDialog() {
    M.dialog(`<h3>${esc(t('sync.forgotTitle'))}</h3>
      <p class="sub small">${esc(t('sync.forgotHint'))}</p>
      <input id="syE" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="Email">
      <p class="sy-err" id="syErr" hidden></p>
      <div class="dlg-actions"><button class="ghost" id="syBk">${esc(t('sync.back'))}</button><button class="primary" id="syGo">${esc(t('sync.forgotSend'))}</button></div>`, (d, close) => {
      const I = M.$('#syE', d), E = M.$('#syErr', d), Go = M.$('#syGo', d);
      const go = async () => {
        E.hidden = true; const em = I.value.trim();
        if (!EMAIL_OK.test(em)) return showErr(E, 'invalid_email');
        Go.disabled = true;
        try { await M.sync.forgot(em); close(); M.toast(t('sync.forgotSent')); } catch (e) { Go.disabled = false; showErr(E, e.code || 'server'); }
      };
      Go.onclick = go;
      d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); };
      M.$('#syBk', d).onclick = () => { close(); authDialog('login'); };
      I.focus();
    });
  }

  function resetDialog(token) {
    M.dialog(`<h3>${esc(t('sync.resetTitle'))}</h3>
      <input id="syP" type="password" autocomplete="new-password" maxlength="128" placeholder="${esc(t('sync.newPassword'))}">
      <input id="syP2" type="password" autocomplete="new-password" maxlength="128" placeholder="${esc(t('sync.password2'))}">
      <p class="sy-err" id="syErr" hidden></p>
      <div class="dlg-actions"><button class="primary" id="syGo">${esc(t('sync.save'))}</button></div>`, (d, close) => {
      const P = M.$('#syP', d), P2 = M.$('#syP2', d), E = M.$('#syErr', d), Go = M.$('#syGo', d);
      const go = async () => {
        E.hidden = true;
        if (P.value.length < 8 || P.value.length > 128) return showErr(E, 'weak_password');
        if (P.value !== P2.value) return showErr(E, 'mismatch');
        Go.disabled = true;
        try { await M.sync.reset(token, P.value); close(); M.toast(t('sync.resetDone')); setTimeout(() => authDialog('login'), 300); } catch (e) { Go.disabled = false; showErr(E, e.code || 'server'); }
      };
      Go.onclick = go;
      d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); };
      P.focus();
    });
  }

  function emailDialog(done) {
    M.dialog(`<h3>${esc(t('sync.emailTitle'))}</h3>
      <p class="sub small">${esc(t('sync.emailHint'))}</p>
      <input id="syE" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="Email">
      <input id="syP" type="password" autocomplete="current-password" maxlength="128" placeholder="${esc(t('sync.password'))}">
      <p class="sy-err" id="syErr" hidden></p>
      <div class="dlg-actions"><button class="primary" id="syGo">${esc(t('sync.save'))}</button></div>`, (d, close) => {
      const I = M.$('#syE', d), P = M.$('#syP', d), E = M.$('#syErr', d), Go = M.$('#syGo', d);
      M.sync.me().then((r) => { if (r.email && !I.value) I.value = r.email; }).catch(() => {});
      const go = async () => {
        E.hidden = true; const em = I.value.trim();
        if (em && !EMAIL_OK.test(em)) return showErr(E, 'invalid_email');
        if (!P.value) return showErr(E, 'bad_credentials');
        Go.disabled = true;
        try { const r = await M.sync.setEmail(em, P.value); close(); M.toast(t(r.email ? 'sync.emailSaved' : 'sync.emailRemoved')); if (done) done(); } catch (e) { Go.disabled = false; showErr(E, e.code || 'server'); }
      };
      Go.onclick = go;
      d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') go(); };
      I.focus();
    });
  }

  // link from the recovery email: https://site/?reset=TOKEN
  (function () {
    let token = '';
    try { token = new URLSearchParams(location.search).get('reset') || ''; } catch { /* ignore */ }
    if (!/^[\w-]{20,100}$/.test(token) || !M.syncAvailable) return;
    try { const u = new URL(location.href); u.searchParams.delete('reset'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); } catch { /* ignore */ }
    const open = () => setTimeout(() => resetDialog(token), 400);
    if (document.readyState === 'complete') open(); else window.addEventListener('load', open);
  })();
})();
