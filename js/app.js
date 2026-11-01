/* Melodust Web — app shell: nav, router, player bar, shortcuts, PWA */
(function () {
  'use strict';
  const M = window.M;
  const { $, $$, esc, icon } = M;
  const audio = M.audio;

  const NAV = [['library', 'music', 'nav.library'], ['search', 'search', 'nav.search'], ['playlists', 'playlist', 'nav.playlists'], ['queue', 'queue', 'nav.queue'], ['lyrics', 'lyrics', 'nav.lyrics'], ['visualizer', 'viz', 'nav.visualizer'], ['radio', 'radio', 'radio.title'], ['settings', 'settings', 'nav.settings'], ['whatsnew', 'star', 'nav.whatsnew'], ['about', 'info', 'nav.about']];

  /* ---------- chrome (nav + static labels) ---------- */
  M.buildChrome = () => {
    $('#nav').innerHTML = NAV.map(([id, ic, key]) => `<a href="#/${id}" data-v="${id}">${icon(ic)}<span>${esc(M.t(key))}</span></a>`).join('');
    const fix = { btnMenu: 'menu', btnPlay: 'play', btnPrev: 'prev', btnNext: 'next', btnShuffle: 'shuffle', btnRepeat: 'repeat', btnFav: 'heart', btnMini: 'mini', btnMute: 'volume' };
    Object.entries(fix).forEach(([id, ic]) => { const b = $('#' + id); b.innerHTML = icon(ic); });
    $('#btnShuffle').title = M.t('w.shuffle'); $('#btnRepeat').title = M.t('w.repeat'); $('#btnMini').title = M.t('w.mini'); $('#btnMute').title = M.t('w.volume');
    $('#btnInstall').innerHTML = icon('download') + `<span>${esc(M.t('w.install'))}</span>`;
    $('#linkDesktop').textContent = M.t('w.getDesktop');
    $('#btnMini').hidden = !window.documentPictureInPicture;
    $('#drop span').textContent = M.t('lib.empty.sub');
    syncBar(); markNav();
  };
  const markNav = () => { const v = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'library'; $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v)); };

  /* ---------- router ---------- */
  M.route = () => {
    const v = (location.hash.match(/^#\/(\w+)/) || [])[1];
    const name = M.views[v] ? v : 'library';
    M.runCleanup();
    const el = $('#view'); el.innerHTML = ''; el.scrollTop = 0;
    el.className = 'v-' + name;
    $('#viewTitle').textContent = M.t(M.views[name].title);
    $('#side').classList.remove('open');
    markNav();
    M.views[name].render(el);
  };
  window.addEventListener('hashchange', M.route);

  /* ---------- range widgets ---------- */
  function range(el, get, set, commit) {
    const fill = $('.fill', el), thumb = $('.thumb', el);
    let drag = false;
    const paint = (p) => { p = M.clamp(p, 0, 1); fill.style.width = p * 100 + '%'; thumb.style.left = p * 100 + '%'; };
    const pos = (e) => { const r = el.getBoundingClientRect(); return M.clamp((e.clientX - r.left) / r.width, 0, 1); };
    el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); const p = pos(e); paint(p); set(p, false); e.preventDefault(); });
    el.addEventListener('pointermove', (e) => { if (!drag) return; const p = pos(e); paint(p); set(p, false); });
    el.addEventListener('pointerup', (e) => { if (!drag) return; drag = false; const p = pos(e); set(p, true); });
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const d = e.key === 'ArrowLeft' ? -1 : 1; commit && commit(d); e.preventDefault(); e.stopPropagation(); } });
    return { paint, get dragging() { return drag; } };
  }
  const seekR = range($('#seek'), null, (p, end) => { const d = audio.duration; if (isFinite(d)) { $('#tCur').textContent = M.fmtTime(p * d); if (end) M.seek(p * d); } }, (d) => M.seek(audio.currentTime + d * 5));
  const volR = range($('#vol'), null, (p) => M.setVolume(p), (d) => M.setVolume(M.S.volume + d * 0.05));

  /* ---------- player bar sync ---------- */
  function syncTrack() {
    const tr = M.curTrack();
    const cov = tr && M.coverUrl(tr);
    $('#npCover').innerHTML = cov ? `<img src="${cov}" alt="">` : icon('music');
    $('#npTitle').textContent = tr ? tr.title : M.t('player.nothing');
    $('#npArtist').textContent = tr ? (tr.artist || tr.album || '') : '';
    syncFav();
    $('#tDur').textContent = tr && tr.duration ? M.fmtTime(tr.duration) : '0:00';
    $('#player').classList.toggle('radio', !!(tr && tr.radio));
  }
  function syncFav() { const tr = M.curTrack(); $('#btnFav').classList.toggle('on', !!(tr && M.isFav(tr.id))); $('#btnFav').disabled = !tr || !!tr.radio; }
  function syncPlay() { $('#btnPlay').innerHTML = icon(M.isPlaying() ? 'pause' : 'play'); document.body.classList.toggle('playing', M.isPlaying()); }
  function syncMode() {
    $('#btnShuffle').classList.toggle('on', M.S.shuffle);
    const r = $('#btnRepeat'); r.classList.toggle('on', M.S.repeat !== 'off'); r.dataset.badge = M.S.repeat === 'one' ? '1' : '';
    $('#btn8d').classList.toggle('on', M.S.d8); $('#lbl8d').textContent = M.t(M.S.d8 ? 'common.on' : 'common.off');
  }
  function syncVol() { volR.paint(M.S.muted ? 0 : M.S.volume); $('#btnMute').innerHTML = icon(M.S.muted || M.S.volume === 0 ? 'mute' : 'volume'); }
  function syncTime() {
    const d = audio.duration, c = audio.currentTime;
    if (!seekR.dragging) { $('#tCur').textContent = M.fmtTime(c); if (isFinite(d) && d > 0) { $('#tDur').textContent = M.fmtTime(d); seekR.paint(c / d); } else seekR.paint(0); }
    const radio = M.curTrack() && M.curTrack().radio; if (radio) { $('#tDur').textContent = 'LIVE'; }
  }
  function syncAB() {
    const d = audio.duration || 1, { a, b } = M.ab;
    const A = $('#abA'), B = $('#abB');
    A.style.display = a == null ? 'none' : 'block'; B.style.display = b == null ? 'none' : 'block';
    if (a != null) A.style.left = (a / d) * 100 + '%'; if (b != null) B.style.left = (b / d) * 100 + '%';
    const btn = $('#btnAB'); btn.classList.toggle('on', a != null);
    btn.title = a == null ? M.t('ab.start') : b == null ? M.t('ab.end', M.fmtTime(a)) : M.t('ab.active', M.fmtTime(a), M.fmtTime(b));
    btn.textContent = a == null ? 'A–B' : b == null ? 'A–' : 'A–B ✓';
  }
  function syncBar() { syncTrack(); syncPlay(); syncMode(); syncVol(); syncTime(); syncAB(); }
  M.on('track', () => { syncTrack(); syncTime(); syncAB(); });
  M.on('state', syncPlay); M.on('mode', syncMode); M.on('volume', syncVol); M.on('time', syncTime); M.on('ab', syncAB); M.on('fav', syncFav);

  $('#btnPlay').onclick = () => M.toggle();
  $('#btnNext').onclick = () => M.next(); $('#btnPrev').onclick = () => M.prev();
  $('#btnShuffle').onclick = () => M.toggleShuffle(); $('#btnRepeat').onclick = () => M.cycleRepeat();
  $('#btn8d').onclick = () => M.toggle8d(); $('#btnAB').onclick = () => M.abClick();
  $('#btnMute').onclick = () => M.toggleMute();
  $('#btnFav').onclick = () => { const tr = M.curTrack(); if (tr) M.toggleFav(tr.id); };
  $('.np', $('#player')).onclick = (e) => { if (e.target.closest('button')) return; const tr = M.curTrack(); if (tr && !tr.radio) location.hash = '#/lyrics'; };
  $('#btnMenu').onclick = () => $('#side').classList.toggle('open');
  $('#main').addEventListener('click', () => $('#side').classList.remove('open'));

  /* ---------- mini player (Document Picture-in-Picture) ---------- */
  let miniWin = null;
  async function toggleMini() {
    if (!window.documentPictureInPicture) return;
    if (miniWin) { miniWin.close(); return; }
    try {
      const w = await window.documentPictureInPicture.requestWindow({ width: 380, height: 150 });
      miniWin = w;
      $$('link[rel=stylesheet]').forEach((l) => { const c = w.document.createElement('link'); c.rel = 'stylesheet'; c.href = l.href; w.document.head.appendChild(c); });
      w.document.documentElement.style.cssText = document.documentElement.style.cssText;
      w.document.body.className = 'mini-body';
      w.document.body.innerHTML = `<div class="mini"><div class="cover" id="mC"></div><div class="mt"><b id="mT"></b><span id="mA"></span><div class="mc"><button class="icon" id="mP">${icon('prev')}</button><button class="play sm" id="mPl"></button><button class="icon" id="mN">${icon('next')}</button></div><div class="mbar"><i id="mF"></i></div></div></div>`;
      const q = (id) => w.document.getElementById(id);
      const upd = () => {
        const tr = M.curTrack(), cov = tr && M.coverUrl(tr);
        q('mC').innerHTML = cov ? `<img src="${cov}" alt="">` : icon('music');
        q('mT').textContent = tr ? tr.title : M.t('player.nothing'); q('mA').textContent = tr ? tr.artist || '' : '';
        q('mPl').innerHTML = icon(M.isPlaying() ? 'pause' : 'play');
        const d = audio.duration; q('mF').style.width = (isFinite(d) && d ? (audio.currentTime / d) * 100 : 0) + '%';
        w.document.documentElement.style.cssText = document.documentElement.style.cssText;
      };
      q('mP').onclick = () => M.prev(); q('mN').onclick = () => M.next(); q('mPl').onclick = () => M.toggle();
      const evs = ['track', 'state', 'time', 'theme'];
      const hs = evs.map((e) => { const h = () => upd(); M.bus.addEventListener(e, h); return [e, h]; });
      w.addEventListener('pagehide', () => { hs.forEach(([e, h]) => M.bus.removeEventListener(e, h)); miniWin = null; });
      upd();
    } catch (e) { M.toast(String(e.message || e)); }
  }
  $('#btnMini').onclick = toggleMini;

  /* ---------- keyboard ---------- */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && e.target.type !== 'range' || tag === 'textarea' || tag === 'select';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); location.hash = '#/search'; return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMini(); return; }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight') { e.preventDefault(); M.next(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft') { e.preventDefault(); M.prev(); }
    else if (e.key === ' ' && tag !== 'button' && tag !== 'a') { e.preventDefault(); M.toggle(); }
    else if (e.key === 'ArrowUp' && tag !== 'range') { e.preventDefault(); M.setVolume(M.S.volume + 0.05); }
    else if (e.key === 'ArrowDown' && tag !== 'range') { e.preventDefault(); M.setVolume(M.S.volume - 0.05); }
    else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) M.toggleMute();
  });

  /* ---------- file inputs / drag & drop ---------- */
  $('#fileFolder').onchange = (e) => { M.addFileList(e.target.files, false); e.target.value = ''; };
  $('#fileAudio').onchange = (e) => { M.addFileList(e.target.files, true); e.target.value = ''; };
  $('#fileLrc').onchange = (e) => { M.importLyrics(e.target.files[0]); e.target.value = ''; };
  $('#fileM3u').onchange = (e) => { if (e.target.files[0]) M.importM3u(e.target.files[0]); e.target.value = ''; };
  $('#filePhoto').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    await M.db.kvSet('bgphoto', f); M.S.bg = 'custom'; M.saveS(); await M.applyBg(); if (location.hash === '#/settings') M.route();
  };
  $('#fileBackup').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || !j.settings || !j.user) throw new Error('bad');
      if (!(await M.confirm(M.t('bk.confirm'), 'OK'))) return;
      M.ls.set('mw.settings', Object.assign({}, M.S, j.settings));
      M.ls.set('mw.user', Object.assign({}, M.U, j.user, { queue: M.U.queue }));
      M.toast(M.t('bk.done', (j.user.fav || []).length, (j.user.playlists || []).length).replace(/Restart.*|Перезапусти.*/i, '').trim());
      setTimeout(() => location.reload(), 900);
    } catch { M.toast(M.t('bk.error')); }
  };

  async function readEntry(entry, path, out) {
    if (entry.isFile) { const f = await new Promise((r) => entry.file(r, () => r(null))); if (f) { try { Object.defineProperty(f, 'webkitRelativePath', { value: path + entry.name }); } catch { /* ignore */ } out.push(f); } }
    else if (entry.isDirectory) {
      const rd = entry.createReader(); let batch;
      do { batch = await new Promise((r) => rd.readEntries(r, () => r([]))); for (const c of batch) await readEntry(c, path + entry.name + '/', out); } while (batch.length);
    }
  }
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#drop').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    const items = [...e.dataTransfer.items];
    // Chromium: real, persistable handles
    if (M.hasFS && items[0] && items[0].getAsFileSystemHandle) {
      const hs = await Promise.all(items.map((i) => i.getAsFileSystemHandle().catch(() => null)));
      const loose = [];
      for (const h of hs) { if (!h) continue; if (h.kind === 'directory') await M.addDirHandle(h); else loose.push(await h.getFile()); }
      if (loose.length) await M.addFileList(loose, true);
      return;
    }
    const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const out = [];
    for (const en of entries) await readEntry(en, '', out);
    const loose = !entries.some((x) => x.isDirectory);
    if (out.length) M.addFileList(out, loose);
  });

  /* ---------- PWA ---------- */
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

  /* ---------- boot ---------- */
  (async function boot() {
    M.setLang(M.S.lang);
    M.applyTheme(M.S.c1, M.S.c2);
    M.applyBg();
    M.initEngine();
    M.buildChrome();
    M.fillIcons();
    if (!location.hash) location.hash = '#/library'; else M.route();
    await M.loadLibrary();
    M.restoreQueue();
    syncBar();
    if (M.sync) M.sync.init();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    document.body.classList.add('ready');
  })();
})();
