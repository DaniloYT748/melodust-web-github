/* Melodust Web — views */
(function () {
  'use strict';
  const M = window.M;
  const { $, $$, esc, icon, t } = Object.assign({}, M, { t: (...a) => M.t(...a) });

  /* ---------- view-scoped subscriptions ---------- */
  let subs = [];
  const sub = (evt, fn) => { const h = (e) => fn(e.detail); M.bus.addEventListener(evt, h); subs.push([evt, h]); };
  M.clearSubs = () => { subs.forEach(([e, h]) => M.bus.removeEventListener(e, h)); subs = []; };
  let rafId = 0, cleanup = null;
  M.setCleanup = (fn) => { cleanup = fn; };
  M.runCleanup = () => { M.clearSubs(); cancelAnimationFrame(rafId); if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; } };
  const scroller = () => $('#view');

  /* ---------- virtual track list ---------- */
  const ROW = 58;
  function trackList(host, opts) {
    // opts: { ids, onPlay(id,i), extra(id,i)->menu items, reorder(from,to), showAlbum }
    host.classList.add('tlist');
    host.innerHTML = '<div class="tl-in"></div>';
    const inner = host.firstChild;
    let ids = opts.ids || [];
    let last = '';
    const sc = scroller();
    function rowHtml(id, i) {
      const tr = M.trackById(id);
      if (!tr) return '';
      const cur = M.curTrack();
      const playing = cur && cur.id === id;
      const cov = M.coverUrl(tr);
      const bars = playing ? `<span class="eqb${M.isPlaying() ? ' on' : ''}"><i></i><i></i><i></i></span>` : '';
      return `<div class="row${playing ? ' playing' : ''}" data-i="${i}" data-id="${esc(id)}" style="top:${i * ROW}px"${opts.reorder ? ' draggable="true"' : ''}>
        <div class="rc">${cov ? `<img src="${cov}" alt="" loading="lazy">` : icon('music')}${bars}</div>
        <div class="rt"><b>${esc(tr.title)}</b><span>${esc(tr.artist || '')}</span></div>
        <div class="ra">${esc(tr.album || '')}</div>
        <div class="rd">${tr.duration ? M.fmtTime(tr.duration) : ''}</div>
        <button class="icon sm rfav${M.isFav(id) ? ' on' : ''}" data-act="fav" aria-label="Favorite">${icon('heart')}</button>
        <button class="icon sm" data-act="more" aria-label="More">${icon('more')}</button>
      </div>`;
    }
    function paint(force) {
      const hostTop = host.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const vTop = sc.scrollTop - hostTop, vH = sc.clientHeight;
      const a = Math.max(0, Math.floor(vTop / ROW) - 4), b = Math.min(ids.length, Math.ceil((vTop + vH) / ROW) + 4);
      const key = a + ':' + b + ':' + ids.length + ':' + (M.curTrack() || {}).id + ':' + M.isPlaying();
      if (!force && key === last) return;
      last = key;
      let h = '';
      for (let i = a; i < b; i++) h += rowHtml(ids[i], i);
      inner.innerHTML = h;
    }
    function setIds(n) { ids = n; inner.style.height = ids.length * ROW + 'px'; last = ''; paint(true); }
    let ticking = false;
    const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; paint(); }); };
    sc.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const prevCleanup = cleanup;
    M.setCleanup(() => { sc.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (prevCleanup) prevCleanup(); });

    const rowOf = (e) => e.target.closest('.row');
    host.addEventListener('click', (e) => {
      const r = rowOf(e); if (!r) return;
      const id = r.dataset.id, i = +r.dataset.i;
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'fav') { M.toggleFav(id); return; }
      if (act && act.dataset.act === 'more') { const b = act.getBoundingClientRect(); M.trackMenu(b.left - 180, b.bottom, id, i, opts); return; }
      opts.onPlay(id, i);
    });
    host.addEventListener('contextmenu', (e) => { const r = rowOf(e); if (!r) return; e.preventDefault(); M.trackMenu(e.clientX, e.clientY, r.dataset.id, +r.dataset.i, opts); });
    if (opts.reorder) {
      let from = -1;
      host.addEventListener('dragstart', (e) => { const r = rowOf(e); if (!r) return; from = +r.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(from)); r.classList.add('drag'); });
      host.addEventListener('dragover', (e) => { if (from < 0) return; e.preventDefault(); $$('.row.over', host).forEach((x) => x.classList.remove('over')); const r = rowOf(e); if (r) r.classList.add('over'); });
      host.addEventListener('drop', (e) => { const r = rowOf(e); if (r && from >= 0) { e.preventDefault(); opts.reorder(from, +r.dataset.i); } from = -1; });
      host.addEventListener('dragend', () => { from = -1; $$('.row.drag,.row.over', host).forEach((x) => x.classList.remove('drag', 'over')); });
    }
    setIds(ids);
    sub('track', () => paint(true)); sub('state', () => paint(true)); sub('fav', () => paint(true));
    return { setIds, repaint: () => paint(true), get ids() { return ids; } };
  }

  /* ---------- track context menu / dialogs ---------- */
  M.trackMenu = (x, y, id, i, opts = {}) => {
    const tr = M.trackById(id);
    const items = [
      { icon: 'play', label: t('pl.play'), run: () => opts.onPlay && opts.onPlay(id, i) },
      { icon: 'next', label: t('menu.playNext'), run: () => M.enqueue([id], true) },
      { icon: 'queue', label: t('menu.addQueue'), run: () => M.enqueue([id], false) },
      { icon: 'playlist', label: t('menu.addPlaylist'), run: () => M.pickPlaylist([id]) },
      { icon: 'heart', label: M.isFav(id) ? t('menu.unfav') : t('menu.fav'), run: () => M.toggleFav(id) }
    ];
    if (opts.extra) items.push(...opts.extra(id, i));
    if (tr && !tr.radio) items.push('-', { icon: 'info', label: t('menu.info'), run: () => M.trackInfo(tr) });
    M.showMenu(x, y, items);
  };
  M.pickPlaylist = (ids) => {
    const list = M.U.playlists;
    M.dialog(`<h3>${esc(t('menu.addPlaylist'))}</h3><div class="pick">${list.map((p) => `<button class="pk" data-id="${p.id}">${icon('playlist')}<span>${esc(p.name)}</span><small>${p.ids.length}</small></button>`).join('')}<button class="pk new">${icon('plus')}<span>${esc(t('menu.newPlaylist'))}</span></button></div><div class="dlg-actions"><button class="ghost" data-close>${esc(t('pl.cancel'))}</button></div>`, (d, close) => {
      $$('.pk[data-id]', d).forEach((b) => (b.onclick = () => { close(); M.addToPlaylist(M.U.playlists.find((p) => p.id === b.dataset.id), ids); }));
      $('.pk.new', d).onclick = async () => { close(); const p = await M.newPlaylist(null, ids); if (p) M.toast(p.name); };
    });
  };
  M.trackInfo = (tr) => {
    const rows = [['info.title', tr.title], ['info.artist', tr.artist], ['info.album', tr.album], ['info.genre', tr.genre], ['info.year', tr.year], ['info.duration', tr.duration ? M.fmtTime(tr.duration) : ''], ['info.format', (tr.ext || '').toUpperCase()], ['info.size', M.fmtSize(tr.size)], ['info.bitrate', tr.duration ? Math.round((tr.size * 8) / tr.duration / 1000) + ' kbps' : ''], ['info.modified', tr.mtime ? new Date(tr.mtime).toLocaleString() : '']].filter((r) => r[1]);
    const cov = M.coverUrl(tr);
    M.dialog(`<h3>${esc(t('menu.info'))}</h3>${cov ? `<img class="info-cover" src="${cov}" alt="">` : ''}<dl class="info">${rows.map((r) => `<dt>${esc(t(r[0]))}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl><div class="dlg-actions"><button class="primary" data-close>${esc(t('common.close'))}</button></div>`);
  };

  /* ---------- small UI builders ---------- */
  const slider = (id, min, max, step, val, fmt) => `<div class="sl"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output id="${id}_o">${fmt(val)}</output></div>`;
  const toggle = (id, on) => `<button class="tg${on ? ' on' : ''}" id="${id}" role="switch" aria-checked="${!!on}"><i></i></button>`;
  const section = (title, body, sub) => `<section class="card"><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${body}</section>`;
  const setTg = (el, on) => { el.classList.toggle('on', on); el.setAttribute('aria-checked', on); };
  const empty = (title, sub, btns) => `<div class="empty"><div class="empty-ic">${icon('music')}</div><h2>${esc(title)}</h2><p>${esc(sub)}</p><div class="btns">${btns || ''}</div></div>`;

  M.views = {};

  /* ======================= LIBRARY ======================= */
  const lf = { q: '', fmt: '', genre: '', year: '', album: null };
  const filtered = () => {
    const q = lf.q.trim().toLowerCase();
    return M.lib.tracks.filter((t) =>
      (!lf.fmt || t.ext === lf.fmt) && (!lf.genre || t.genre === lf.genre) && (!lf.year || t.year === lf.year) &&
      (lf.album == null || (t.album || '') === lf.album) &&
      (!q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q)));
  };
  const uniq = (k) => [...new Set(M.lib.tracks.map((x) => x[k]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  M.views.library = {
    title: 'nav.library',
    render(el, opts = {}) {
      const search = !!opts.search;
      const draw = () => {
        const has = M.lib.tracks.length > 0;
        const perm = M.lib.needsPerm ? `<div class="banner"><div>${icon('info')}<span><b>${esc(t('w.restore'))}</b> — ${esc(t('w.restore.sub'))}</span></div><button class="primary" id="bReconnect">${esc(t('w.restore'))}</button></div>` : '';
        const addBtns = `<button class="primary" id="bFolder">${icon('folder')}<span>${esc(M.hasFS ? t('lib.openFolder') : t('lib.openFolder'))}</span></button><button class="ghost" id="bFiles">${icon('plus')}<span>${esc(t('w.addFiles'))}</span></button>`;
        if (!has && !M.scan.running) { el.innerHTML = perm + empty(t('lib.empty.title'), t('lib.empty.sub'), addBtns) + `<p class="privacy">${esc(t('w.privacy'))}</p>`; wire(); return; }
        const fmts = uniq('ext'), genres = uniq('genre'), years = uniq('year').reverse();
        const sel = (id, label, arr, val) => `<select id="${id}" aria-label="${esc(label)}"><option value="">${esc(label)}</option>${arr.map((x) => `<option${x === val ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
        el.innerHTML = `${perm}
        <div class="toolbar">
          <label class="searchbox">${icon('search')}<input id="fq" type="search" placeholder="${esc(t(search ? 'search.placeholder' : 'filter.search'))}" value="${esc(lf.q)}" autocomplete="off"></label>
          <div class="filters">${sel('ffmt', t('filter.allFormats'), fmts, lf.fmt)}${sel('fgenre', t('filter.allGenres'), genres, lf.genre)}${sel('fyear', t('filter.allYears'), years, lf.year)}
            <select id="fsort" aria-label="${esc(t('lib.sort'))}">${['Title', 'Artist', 'Album', 'Duration', 'Recently added', 'Most played'].map((k) => `<option value="${k}"${M.S.sort === k ? ' selected' : ''}>${esc(t('lib.sort'))}: ${esc(t('sort.' + k))}</option>`).join('')}</select>
            <div class="seg"><button id="vList" class="${M.S.view === 'list' ? 'on' : ''}" aria-label="${esc(t('view.list'))}">${icon('list')}</button><button id="vGrid" class="${M.S.view === 'grid' ? 'on' : ''}" aria-label="${esc(t('view.grid'))}">${icon('grid')}</button></div>
          </div>
          <div class="adds">${addBtns}</div>
        </div>
        <div class="meta"><span id="cnt"></span><span id="scanSt"></span><button class="link" id="fclr" hidden>${esc(t('filter.clear'))}</button></div>
        <div id="scanbar" class="scanbar" hidden><i></i></div>
        <div id="list"></div>`;
        wire(); fill();
      };
      const wire = () => {
        const on = (id, fn) => { const n = $('#' + id, el); if (n) n.onclick = fn; };
        on('bFolder', () => M.pickFolder()); on('bFiles', () => M.pickFiles()); on('bReconnect', () => M.reconnect());
        on('fclr', () => { Object.assign(lf, { q: '', fmt: '', genre: '', year: '', album: null }); draw(); });
        on('vList', () => { M.S.view = 'list'; M.saveS(); lf.album = null; draw(); }); on('vGrid', () => { M.S.view = 'grid'; M.saveS(); draw(); });
        const q = $('#fq', el); if (q) { q.oninput = M.debounce(() => { lf.q = q.value; fill(); }, 120); if (search) q.focus(); }
        [['ffmt', 'fmt'], ['fgenre', 'genre'], ['fyear', 'year']].forEach(([id, k]) => { const s = $('#' + id, el); if (s) s.onchange = () => { lf[k] = s.value; fill(); }; });
        const so = $('#fsort', el); if (so) so.onchange = () => { M.S.sort = so.value; M.saveS(); M.sortLib(); };
      };
      let tl = null;
      const fill = () => {
        const host = $('#list', el); if (!host) return;
        const list = filtered();
        $('#cnt', el).textContent = t('lib.tracks', list.length);
        const any = lf.q || lf.fmt || lf.genre || lf.year || lf.album != null;
        $('#fclr', el).hidden = !any;
        scanUi();
        if (M.S.view === 'grid' && lf.album == null && !lf.q) { grid(host, list); tl = null; return; }
        const ids = list.map((x) => x.id);
        if (!list.length) { host.innerHTML = `<div class="none">${esc(t('search.none'))}</div>`; tl = null; return; }
        if (lf.album != null && M.S.view === 'grid') $('#cnt', el).innerHTML = `<button class="link" id="bk">← ${esc(t('common.back'))}</button> ${esc(lf.album || '—')} · ${esc(t('lib.tracks', list.length))}`, ($('#bk', el).onclick = () => { lf.album = null; fill(); });
        if (tl && host.firstChild && host.firstChild.className === 'tl-in') tl.setIds(ids);
        else tl = trackList(host, { ids, onPlay: (id) => M.playTrackIn(tl.ids, id) });
      };
      const grid = (host, list) => {
        const m = new Map();
        list.forEach((x) => { const k = x.album || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
        const albums = [...m.entries()].sort((a, b) => (a[0] || '￿').localeCompare(b[0] || '￿'));
        host.innerHTML = `<div class="grid">${albums.map(([name, tr], i) => { const c = tr.find((x) => x.cover); const cu = c && M.coverUrl(c); return `<button class="alb" data-k="${i}"><div class="ac">${cu ? `<img src="${cu}" alt="" loading="lazy">` : icon('music')}<span class="aplay" data-p="${i}">${icon('play')}</span></div><b>${esc(name || '—')}</b><span>${esc(tr[0].artist || '')} · ${tr.length}</span></button>`; }).join('')}</div>`;
        $('#cnt', el).textContent = t('lib.tracks', list.length);
        host.onclick = (e) => {
          const b = e.target.closest('.alb'); if (!b) return;
          const [name, tr] = albums[+b.dataset.k];
          if (e.target.closest('.aplay')) { const s = tr.slice().sort((a, b) => (a.no || 0) - (b.no || 0)); M.setQueue(s.map((x) => x.id), 0); return; }
          lf.album = name; fill();
        };
      };
      const scanUi = () => {
        const sb = $('#scanbar', el), st = $('#scanSt', el); if (!sb) return;
        if (M.scan.running) { sb.hidden = false; const p = M.scan.total ? M.scan.done / M.scan.total : 0; sb.firstChild.style.width = Math.round(p * 100) + '%'; st.textContent = t('lib.scanning', M.scan.done, M.scan.total); }
        else { sb.hidden = true; st.textContent = ''; }
      };
      draw();
      sub('lib', M.debounce(() => { if (!$('#fq', el) || (M.lib.tracks.length && !tl && M.S.view === 'list')) draw(); else if (!M.lib.tracks.length) draw(); else fill(); }, 250));
      sub('scan', () => { if (!M.lib.tracks.length) draw(); else scanUi(); });
      sub('lang', draw);
    }
  };
  M.views.search = { title: 'nav.search', render: (el) => M.views.library.render(el, { search: true }) };

  /* ======================= PLAYLISTS ======================= */
  let plSel = 'fav';
  M.views.playlists = {
    title: 'nav.playlists',
    render(el) {
      let tl = null;
      const idsFor = () => {
        if (plSel === 'fav') return M.U.fav.filter((i) => M.lib.byId.has(i));
        if (plSel === 'recent') return M.U.recent.filter((i) => M.lib.byId.has(i));
        const p = M.U.playlists.find((x) => x.id === plSel); return p ? p.ids.filter((i) => M.lib.byId.has(i)) : [];
      };
      const draw = () => {
        if (plSel !== 'fav' && plSel !== 'recent' && !M.U.playlists.some((p) => p.id === plSel)) plSel = 'fav';
        const chip = (id, ic, name, n) => `<button class="pchip${plSel === id ? ' on' : ''}" data-id="${id}">${icon(ic)}<span>${esc(name)}</span><small>${n}</small></button>`;
        const pl = M.U.playlists.find((p) => p.id === plSel);
        const ids = idsFor();
        const titleTxt = plSel === 'fav' ? t('fav.title') : plSel === 'recent' ? t('recent.title') : pl.name;
        const acts = [];
        if (ids.length) acts.push(`<button class="primary" id="pPlay">${icon('play')}<span>${esc(t('pl.play'))}</span></button><button class="ghost" id="pShuf">${icon('shuffle')}<span>${esc(t('pl.shuffle'))}</span></button>`);
        if (pl) acts.push(`<button class="ghost" id="pRen">${esc(t('pl.rename'))}</button><button class="ghost" id="pExp">${icon('download')}<span>${esc(t('pl.export'))}</span></button><button class="ghost danger" id="pDel">${icon('trash')}<span>${esc(t('pl.delete'))}</span></button>`);
        if (plSel === 'recent' && ids.length) acts.push(`<button class="ghost danger" id="pClr">${esc(t('recent.clear'))}</button>`);
        el.innerHTML = `<div class="pchips">${chip('fav', 'heart', t('fav.title'), M.U.fav.length)}${chip('recent', 'history', t('recent.title'), M.U.recent.length)}${M.U.playlists.map((p) => chip(p.id, 'playlist', p.name, p.ids.length)).join('')}<button class="pchip add" id="pNew">${icon('plus')}<span>${esc(t('pl.new'))}</span></button><button class="pchip add" id="pImp">${icon('download')}<span>${esc(t('pl.import'))}</span></button></div>
        <div class="pl-head"><h2>${esc(titleTxt)}</h2><div class="btns">${acts.join('')}</div></div><div id="list"></div>`;
        const host = $('#list', el);
        if (!ids.length) host.innerHTML = `<div class="none">${esc(plSel === 'fav' ? t('fav.empty') : plSel === 'recent' ? t('recent.empty') : t('pl.empty'))}</div>`;
        else tl = trackList(host, {
          ids, onPlay: (id) => M.playTrackIn(tl.ids, id),
          reorder: pl ? (from, to) => { const a = pl.ids; const [x] = a.splice(from, 1); a.splice(to, 0, x); M.saveU(); draw(); } : null,
          extra: pl ? (id) => [{ icon: 'trash', label: t('menu.removePlaylist'), run: () => { pl.ids = pl.ids.filter((x) => x !== id); M.saveU(); draw(); } }] : null
        });
        $$('.pchip[data-id]', el).forEach((b) => (b.onclick = () => { plSel = b.dataset.id; draw(); }));
        const on = (id, fn) => { const n = $('#' + id, el); if (n) n.onclick = fn; };
        on('pNew', async () => { const p = await M.newPlaylist(); if (p) { plSel = p.id; draw(); } });
        on('pImp', () => $('#fileM3u').click());
        on('pPlay', () => M.setQueue(ids, 0));
        on('pShuf', () => { const was = M.S.shuffle; M.S.shuffle = true; M.setQueue(ids, Math.floor(Math.random() * ids.length)); M.S.shuffle = was; });
        on('pRen', async () => { const n = await M.prompt(t('pl.rename'), pl.name); if (n) { pl.name = n; M.saveU(); draw(); } });
        on('pDel', async () => { if (await M.confirm(t('pl.deleteConfirm', pl.name), t('pl.delete'))) { M.U.playlists = M.U.playlists.filter((x) => x !== pl); M.saveU(); plSel = 'fav'; draw(); } });
        on('pExp', () => {
          const txt = '#EXTM3U\n' + ids.map((i) => { const tr = M.trackById(i); return `#EXTINF:${Math.round(tr.duration || 0)},${tr.artist ? tr.artist + ' - ' : ''}${tr.title}\n${tr.rel}`; }).join('\n') + '\n';
          M.download(pl.name + '.m3u', new Blob([txt], { type: 'audio/x-mpegurl' }));
        });
        on('pClr', async () => { if (await M.confirm(t('recent.clearConfirm'), t('recent.clear'))) { M.U.recent = []; M.saveU(); draw(); } });
      };
      draw();
      sub('fav', () => { if (plSel === 'fav') draw(); }); sub('playlists', draw); sub('recent', () => { if (plSel === 'recent') draw(); }); sub('lang', draw);
      sub('lib', draw);
    }
  };
  M.download = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
  M.importM3u = async (file) => {
    const txt = await file.text();
    const names = txt.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.trim().replace(/\\/g, '/'));
    const byName = new Map();
    M.lib.tracks.forEach((tr) => { byName.set(tr.rel.toLowerCase(), tr.id); const base = tr.name.toLowerCase(); if (!byName.has(base)) byName.set(base, tr.id); });
    const ids = [];
    names.forEach((n) => { const l = n.toLowerCase(); const id = byName.get(l) || byName.get(l.split('/').pop()); if (id && !ids.includes(id)) ids.push(id); });
    const p = await M.newPlaylist(file.name.replace(/\.[^.]+$/, ''), ids);
    if (p) { plSel = p.id; M.toast(`${p.name}: ${ids.length}/${names.length}`); if (location.hash === '#/playlists') M.route(); else location.hash = '#/playlists'; }
  };

  /* ======================= QUEUE ======================= */
  M.views.queue = {
    title: 'nav.queue',
    render(el) {
      let tl = null;
      const draw = () => {
        if (!M.q.ids.length) { el.innerHTML = empty(t('queue.empty'), '', ''); tl = null; return; }
        el.innerHTML = `<div class="pl-head"><h2>${esc(t('w.queue.count', M.q.ids.length))}</h2><div class="btns"><button class="ghost" id="qClr">${icon('trash')}<span>${esc(t('queue.clear'))}</span></button></div></div><p class="sub">${esc(t('queue.hint'))}</p><div id="list"></div>`;
        tl = trackList($('#list', el), {
          ids: M.q.ids.slice(), onPlay: (id, i) => M.playIndex(i, true),
          reorder: (a, b) => M.queueMove(a, b),
          extra: (id, i) => [{ icon: 'trash', label: t('menu.removeQueue'), run: () => M.queueRemove(i) }]
        });
        $('#qClr', el).onclick = () => M.queueClearUpcoming();
        const cur = $(`.row.playing`, el); if (!cur && M.q.index > 3) scroller().scrollTop = M.q.index * ROW - 120;
      };
      draw();
      sub('queue', () => { if (tl && M.q.ids.length) { tl.setIds(M.q.ids.slice()); $('.pl-head h2', el).textContent = t('w.queue.count', M.q.ids.length); } else draw(); });
      sub('lang', draw);
    }
  };

  /* ======================= LYRICS ======================= */
  M.views.lyrics = {
    title: 'nav.lyrics',
    render(el) {
      let lastIdx = -2;
      const draw = () => {
        const tr = M.curTrack();
        if (!tr) { el.innerHTML = empty(t('player.nothing'), '', ''); return; }
        const cov = M.coverUrl(tr), L = M.lyrics;
        let body = '';
        if (L.status === 'searching') body = `<div class="lyr-msg"><div class="spin"></div>${esc(t('lyrics.searching'))}</div>`;
        else if (L.status === 'none') body = `<div class="lyr-msg">${esc(t('lyrics.none'))}</div>`;
        else if (L.lines) body = `<div class="lyr" id="lyr">${L.lines.map((l, i) => `<p data-i="${i}" data-t="${l.t}">${esc(l.text) || '♪'}</p>`).join('')}</div>`;
        else if (L.plain) body = `<pre class="lyr-plain">${esc(L.plain)}</pre>`;
        el.innerHTML = `<div class="lyr-wrap"><aside class="lyr-side">${cov ? `<img src="${cov}" alt="">` : `<div class="ph">${icon('music')}</div>`}<h2>${esc(tr.title)}</h2><p>${esc(tr.artist || '')}</p>
          <div class="btns"><button class="ghost" id="lImp">${icon('plus')}<span>${esc(t('lyrics.import'))}</span></button></div>
          <small class="sub">${L.status === 'ok' ? esc(L.lines ? t('lyrics.synced') : t('lyrics.plain')) + ' · ' + esc(t('w.fromWeb')) : ''}</small></aside><div class="lyr-main">${body}</div></div>`;
        $('#lImp', el).onclick = () => $('#fileLrc').click();
        const lyr = $('#lyr', el); if (lyr) lyr.onclick = (e) => { const p = e.target.closest('p'); if (p) M.seek(+p.dataset.t); };
        lastIdx = -2; hl(true);
      };
      const hl = (instant) => {
        const L = M.lyrics; if (!L.lines) return;
        const now = M.audio.currentTime + 0.15;
        let idx = -1; for (let i = 0; i < L.lines.length; i++) { if (L.lines[i].t <= now) idx = i; else break; }
        if (idx === lastIdx) return; lastIdx = idx;
        const ps = $$('#lyr p', el);
        ps.forEach((p, i) => { p.classList.toggle('now', i === idx); p.classList.toggle('past', i < idx); });
        const p = ps[idx]; if (p) { const box = scroller(); const y = p.offsetTop - box.clientHeight / 2 + p.clientHeight / 2 - 40; box.scrollTo({ top: Math.max(0, y), behavior: instant ? 'auto' : 'smooth' }); }
      };
      M.loadLyrics(M.curTrack()); draw();
      sub('lyrics', draw); sub('track', (tr) => { M.loadLyrics(tr); draw(); }); sub('time', () => hl()); sub('lang', draw);
    }
  };

  /* ======================= VISUALIZER ======================= */
  M.views.visualizer = {
    title: 'nav.visualizer',
    render(el) {
      el.innerHTML = `<div class="viz-wrap"><div class="viz-bar">${['Pulse', 'Bars', 'Wave'].map((m) => `<button class="pill${M.S.vizMode === m ? ' on' : ''}" data-m="${m}">${esc(t('viz.' + m.toLowerCase()))}</button>`).join('')}<span class="grow"></span><button class="icon" id="vFs" aria-label="Fullscreen">${icon('mini')}</button></div><div class="viz-stage"><canvas id="cv"></canvas><div class="viz-np" id="vNp"></div></div></div>`;
      const cv = $('#cv', el), g = cv.getContext('2d'), stage = $('.viz-stage', el);
      let W = 0, H = 0, dpr = 1;
      const resize = () => { dpr = Math.min(2, devicePixelRatio || 1); W = stage.clientWidth; H = stage.clientHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
      resize();
      const ro = new ResizeObserver(resize); ro.observe(stage);
      M.setCleanup(() => ro.disconnect());
      $$('.pill', el).forEach((b) => (b.onclick = () => { M.S.vizMode = b.dataset.m; M.saveS(); $$('.pill', el).forEach((x) => x.classList.toggle('on', x === b)); }));
      $('#vFs', el).onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen && stage.requestFullscreen(); };
      const np = () => { const tr = M.curTrack(); $('#vNp', el).innerHTML = tr ? `<b>${esc(tr.title)}</b><span>${esc(tr.artist || '')}</span>` : esc(t('player.nothing')); };
      np(); sub('track', np);
      const N = 64; const bars = new Float32Array(N), peaks = new Float32Array(N); let kick = 0, rot = 0, ring = [];
      const fd = new Uint8Array(1024), td = new Uint8Array(2048);
      const grad = (x0, y0, x1, y1) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, M.cur.c1); gr.addColorStop(1, M.cur.c2); return gr; };
      const frame = () => {
        rafId = requestAnimationFrame(frame);
        if (!W) return;
        const an = M.analyser; let bass = 0;
        if (an && M.isPlaying()) {
          an.getByteFrequencyData(fd); an.getByteTimeDomainData(td);
          for (let i = 0; i < N; i++) {
            const a = Math.floor(Math.pow(i / N, 1.8) * 480) + 2, b = Math.floor(Math.pow((i + 1) / N, 1.8) * 480) + 3;
            let s = 0; for (let k = a; k < b; k++) s += fd[k]; bars[i] += ((s / (b - a)) / 255 - bars[i]) * 0.45;
            if (bars[i] > peaks[i]) peaks[i] = bars[i]; else peaks[i] *= 0.97;
          }
          for (let i = 0; i < 6; i++) bass += fd[i + 1]; bass /= 6 * 255;
        } else { for (let i = 0; i < N; i++) { bars[i] *= 0.9; peaks[i] *= 0.95; } bass = 0; }
        kick += (bass - kick) * (bass > kick ? 0.6 : 0.12);
        g.clearRect(0, 0, W, H);
        const m = M.S.vizMode;
        if (m === 'Bars') {
          const bw = W / N, base = H * 0.78, mh = H * 0.62;
          for (let i = 0; i < N; i++) {
            const h = Math.max(3, bars[i] * mh), x = i * bw + bw * 0.18;
            g.fillStyle = M.gradAt(i / (N - 1)); g.globalAlpha = 0.95;
            g.beginPath(); g.roundRect(x, base - h, bw * 0.64, h, 4); g.fill();
            g.globalAlpha = 0.22; g.beginPath(); g.roundRect(x, base + 4, bw * 0.64, h * 0.4, 4); g.fill();
            g.globalAlpha = 1; g.fillStyle = '#fff'; g.fillRect(x, base - peaks[i] * mh - 6, bw * 0.64, 2);
          }
        } else if (m === 'Wave') {
          g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
          for (let pass = 0; pass < 3; pass++) {
            g.beginPath();
            for (let i = 0; i < 2048; i += 8) { const x = (i / 2048) * W, v = (td[i] - 128) / 128; const y = H / 2 + v * H * (0.28 - pass * 0.05) * (1 + kick); i ? g.lineTo(x, y) : g.moveTo(x, y); }
            g.strokeStyle = grad(0, 0, W, 0); g.globalAlpha = 1 - pass * 0.3; g.lineWidth = 4 - pass; g.shadowColor = M.cur.c1; g.shadowBlur = pass === 0 ? 18 : 0; g.stroke();
          }
          g.shadowBlur = 0; g.globalAlpha = 1;
        } else { // Pulse
          rot += 0.003 + kick * 0.02;
          const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * 0.16, r = r0 * (1 + kick * 0.55);
          if (bass > 0.55 && (!ring.length || ring[ring.length - 1].r > r0 * 1.4)) ring.push({ r: r0, a: 0.6 });
          ring = ring.filter((x) => x.a > 0.01);
          ring.forEach((x) => { x.r += 5 + kick * 6; x.a *= 0.955; g.beginPath(); g.arc(cx, cy, x.r, 0, 7); g.strokeStyle = M.cur.c2; g.globalAlpha = x.a; g.lineWidth = 3; g.stroke(); });
          g.globalAlpha = 1;
          const gr = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 1.9); gr.addColorStop(0, M.cur.c1 + 'cc'); gr.addColorStop(0.45, M.cur.c2 + '44'); gr.addColorStop(1, 'transparent');
          g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r * 1.9, 0, 7); g.fill();
          const tr = M.curTrack(), cu = tr && M.coverUrl(tr);
          g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fillStyle = grad(cx - r, cy - r, cx + r, cy + r); g.fill();
          if (cu) { if (!frame.img || frame.src !== cu) { frame.img = new Image(); frame.img.src = cu; frame.src = cu; } if (frame.img.complete && frame.img.naturalWidth) { g.save(); g.beginPath(); g.arc(cx, cy, r * 0.93, 0, 7); g.clip(); g.translate(cx, cy); g.rotate(rot); g.drawImage(frame.img, -r, -r, r * 2, r * 2); g.restore(); } }
          const S = 96;
          for (let i = 0; i < S; i++) {
            const a = (i / S) * Math.PI * 2 + rot, v = bars[Math.floor((i % (S / 2)) / (S / 2) * (N - 1))], len = 6 + v * Math.min(W, H) * 0.22;
            g.strokeStyle = M.gradAt((i % (S / 2)) / (S / 2)); g.lineWidth = 3; g.lineCap = 'round'; g.globalAlpha = 0.9;
            g.beginPath(); g.moveTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10)); g.lineTo(cx + Math.cos(a) * (r + 10 + len), cy + Math.sin(a) * (r + 10 + len)); g.stroke();
          }
          g.globalAlpha = 1;
        }
      };
      frame();
    }
  };

  /* ======================= RADIO ======================= */
  M.views.radio = {
    title: 'radio.title',
    render(el) {
      const draw = () => {
        const cur = M.curTrack();
        el.innerHTML = `<p class="sub">${esc(t('radio.sub'))}</p>
        <form class="card form" id="rf"><div class="f2"><input id="rn" placeholder="${esc(t('radio.name'))}" maxlength="60" required><input id="ru" type="url" placeholder="${esc(t('radio.url'))}" required></div><button class="primary" type="submit">${icon('play')}<span>${esc(t('radio.addPlay'))}</span></button></form>
        <div class="stations">${M.U.radio.map((s, i) => `<div class="st${cur && cur.id === 'radio:' + s.url ? ' playing' : ''}"><button class="stp" data-i="${i}">${icon(cur && cur.id === 'radio:' + s.url && M.isPlaying() ? 'pause' : 'play')}</button><div><b>${esc(s.name)}</b><span>${esc(s.url)}</span></div><button class="icon sm" data-d="${i}" aria-label="${esc(t('radio.remove'))}">${icon('trash')}</button></div>`).join('')}</div>
        <p class="sub small">HTTPS · CORS</p>`;
        $('#rf', el).onsubmit = (e) => {
          e.preventDefault();
          const name = $('#rn', el).value.trim(), url = $('#ru', el).value.trim();
          if (!name || !url) return;
          if (!M.U.radio.some((s) => s.url === url)) M.U.radio.push({ name, url });
          M.saveU(); M.playRadio({ name, url }); draw();
        };
        $$('.stp', el).forEach((b) => (b.onclick = () => { const s = M.U.radio[+b.dataset.i]; const c = M.curTrack(); if (c && c.id === 'radio:' + s.url) M.toggle(); else M.playRadio(s); }));
        $$('[data-d]', el).forEach((b) => (b.onclick = () => { M.U.radio.splice(+b.dataset.d, 1); M.saveU(); draw(); }));
      };
      draw(); sub('track', draw); sub('state', draw); sub('lang', draw);
    }
  };

  /* ======================= SETTINGS ======================= */
  M.views.settings = {
    title: 'settings.title',
    render(el) {
      const S = M.S;
      const sp = (v) => v.toFixed(2).replace(/0$/, '') + '×';
      const presetOpts = Object.keys(M.EQ_PRESETS).map((k) => `<option>${k}</option>`).join('');
      const bgs = Object.keys(M.BGS).map((k) => `<button class="bgsw${S.bg === k ? ' on' : ''}" data-bg="${k}" style="background:${M.BGS[k].replace(/"/g, "'")}" title="${esc(t(k))}"><span>${esc(t(k))}</span></button>`).join('') + `<button class="bgsw${S.bg === 'custom' ? ' on' : ''}" data-bg="custom" id="bgCustom"><span>${esc(t('theme.custom'))}</span></button>`;
      const sleeps = [0, 15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}">${m ? esc(t('w.sleep.min', m)) : esc(t('settings.off'))}</option>`).join('');
      el.innerHTML = `<div class="sgrid">
      ${section(t('settings.gradient'), `<div class="swatches">${M.PRESETS.map((p, i) => `<button class="sw${S.c1 === p[0] && S.c2 === p[1] ? ' on' : ''}" data-i="${i}" style="background:linear-gradient(135deg,${p[0]},${p[1]})" aria-label="${p[0]} → ${p[1]}"></button>`).join('')}</div>
        <div class="f2"><label class="cp"><span>${esc(t('settings.gradient.start'))}</span><input type="color" id="c1" value="${S.c1}"><input id="h1" value="${S.c1}" maxlength="7"></label><label class="cp"><span>${esc(t('settings.gradient.end'))}</span><input type="color" id="c2" value="${S.c2}"><input id="h2" value="${S.c2}" maxlength="7"></label></div>
        <div class="row-s"><div><b>${esc(t('settings.dynamicUi'))}</b><small>${esc(t('settings.dynamicUi.sub'))}</small></div>${toggle('tDyn', S.dynamic)}</div>`)}
      ${section(t('settings.themeBg'), `<div class="bgs">${bgs}</div>`, t('settings.themeBg.sub'))}
      ${section(t('settings.language'), `<select id="lang">${M.LANGS.map(([c, l]) => `<option value="${c}"${S.lang === c ? ' selected' : ''}>${c === 'system' ? esc(t('settings.system')) : esc(l)}</option>`).join('')}</select>`)}
      ${section(t('sync.title'), `<div id="syncBox"></div>`)}
      ${section(t('settings.playback'), `<label class="ctl"><span>${esc(t('settings.speed'))}</span>${slider('sSpeed', 0.5, 2, 0.05, S.speed, sp)}</label>
        <div class="row-s"><div><b>${esc(t('w.preservePitch'))}</b></div>${toggle('tPitch', S.keepPitch)}</div>
        <label class="ctl"><span>${esc(t('settings.sleep'))}</span><select id="sSleep">${sleeps}</select></label>`)}
      ${section(t('player.8d'), `<div class="row-s"><div><b>${esc(t('player.8d'))}</b><small>${esc(t('w.8d.sub'))}</small></div>${toggle('t8d', S.d8)}</div><label class="ctl"><span>${esc(t('w.8d.speed'))}</span>${slider('s8s', 3, 20, 1, S.d8speed, (v) => v + ' s')}</label>`)}
      ${section(t('settings.eq'), `<div class="row-s"><div><b>${esc(t('settings.eq'))}</b></div>${toggle('tEq', S.eqOn)}</div><label class="ctl"><span>${esc(t('settings.preset'))}</span><select id="eqPre"><option value="">—</option>${presetOpts}</select></label><div class="eq" id="eq">${M.EQ_F.map((f, i) => `<div class="eqb2"><output>${S.eq[i] > 0 ? '+' : ''}${S.eq[i]}</output><input type="range" min="-12" max="12" step="1" value="${S.eq[i]}" data-i="${i}" orient="vertical" aria-label="${f} Hz"><span>${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`).join('')}</div>`)}
      ${section(t('snd.bass'), `<label class="ctl"><span>${esc(t('snd.boostDb'))}</span>${slider('sBass', 0, 15, 1, S.bass, (v) => '+' + v + ' dB')}</label><label class="ctl"><span>${esc(t('snd.night'))}</span><select id="sNight"><option value="off">${esc(t('snd.night.off'))}</option><option value="light">${esc(t('snd.night.light'))}</option><option value="strong">${esc(t('snd.night.strong'))}</option></select></label><small class="sub">${esc(t('snd.night.sub'))}</small>`)}
      ${section(t('settings.library'), `<div class="dirs">${M.lib.dirs.length ? M.lib.dirs.map((d) => `<div class="dir">${icon('folder')}<span>${esc(d.name)}</span><small>${M.lib.tracks.filter((x) => x.dirId === d.id).length}</small></div>`).join('') : `<small class="sub">${esc(t('settings.noFolders'))}</small>`}</div><div class="btns"><button class="ghost" id="lAdd">${icon('folder')}<span>${esc(t('settings.addFolder'))}</span></button><button class="ghost" id="lRes">${esc(t('settings.rescan'))}</button><button class="ghost danger" id="lClr">${icon('trash')}<span>${esc(t('w.lib.remove'))}</span></button></div>`)}
      ${section(t('tools.title'), `<div class="btns"><button class="ghost" id="bkE">${icon('download')}<span>${esc(t('tools.export'))}</span></button><button class="ghost" id="bkI"><span>${esc(t('tools.import'))}</span></button></div><small class="sub">${esc(t('w.backup.note'))}</small>`)}
      ${section(t('hk.title'), `<ul class="keys"><li>${esc(t('hk.playpause'))}</li><li>${esc(t('hk.nextprev'))}</li><li>${esc(t('hk.volume'))}</li><li>${esc(t('hk.mute'))}</li><li>${esc(t('hk.search'))}</li><li>${esc(t('hk.mini'))}</li></ul>`)}
      </div>`;
      const on = (id, ev, fn) => { const n = $('#' + id, el); if (n) n[ev] = fn; };
      if (M.sync) M.sync.mount($('#syncBox', el), sub);
      // gradient
      const setGrad = (a, b) => { S.c1 = a; S.c2 = b; M.saveS(); if (!S.dynamic || !(M.curTrack() && M.coverUrl(M.curTrack()))) M.applyTheme(a, b); M.emit('theme'); };
      $$('.sw', el).forEach((b) => (b.onclick = () => { const p = M.PRESETS[+b.dataset.i]; setGrad(p[0], p[1]); $$('.sw', el).forEach((x) => x.classList.toggle('on', x === b)); $('#c1', el).value = $('#h1', el).value = p[0]; $('#c2', el).value = $('#h2', el).value = p[1]; }));
      [['c1', 'h1', 0], ['c2', 'h2', 1]].forEach(([c, h, k]) => {
        on(c, 'oninput', () => { const v = $('#' + c, el).value.toUpperCase(); $('#' + h, el).value = v; setGrad(...(k ? [S.c1, v] : [v, S.c2])); });
        on(h, 'onchange', () => { const v = $('#' + h, el).value.trim(); if (M.validHex(v)) { const x = ('#' + v.replace('#', '')).toUpperCase(); $('#' + c, el).value = x; setGrad(...(k ? [S.c1, x] : [x, S.c2])); } });
      });
      on('tDyn', 'onclick', (e) => { S.dynamic = !S.dynamic; setTg(e.currentTarget, S.dynamic); M.saveS(); if (S.dynamic) M.themeFromCover(); else M.applyTheme(S.c1, S.c2); });
      $$('.bgsw', el).forEach((b) => (b.onclick = () => {
        if (b.dataset.bg === 'custom') { $('#filePhoto').click(); return; }
        S.bg = b.dataset.bg; M.saveS(); M.applyBg(); $$('.bgsw', el).forEach((x) => x.classList.toggle('on', x === b));
      }));
      on('lang', 'onchange', (e) => { S.lang = e.target.value; M.saveS(); M.setLang(S.lang); M.buildChrome(); M.emit('lang'); M.route(); });
      // playback
      on('sSpeed', 'oninput', (e) => { const v = +e.target.value; $('#sSpeed_o', el).textContent = sp(v); M.setSpeed(v); });
      on('tPitch', 'onclick', (e) => { S.keepPitch = !S.keepPitch; setTg(e.currentTarget, S.keepPitch); M.applyElement(); });
      const sl = $('#sSleep', el); sl.value = '0'; sl.onchange = () => M.setSleep(+sl.value);
      on('t8d', 'onclick', (e) => { M.toggle8d(); setTg(e.currentTarget, S.d8); });
      on('s8s', 'oninput', (e) => { S.d8speed = +e.target.value; $('#s8s_o', el).textContent = S.d8speed + ' s'; M.applyAudio(); });
      // EQ
      const eqSync = () => $$('#eq input', el).forEach((r, i) => { r.value = S.eq[i]; r.previousElementSibling.textContent = (S.eq[i] > 0 ? '+' : '') + S.eq[i]; });
      $$('#eq input', el).forEach((r) => (r.oninput = () => { const i = +r.dataset.i; S.eq[i] = +r.value; r.previousElementSibling.textContent = (S.eq[i] > 0 ? '+' : '') + S.eq[i]; $('#eqPre', el).value = ''; M.applyAudio(); }));
      on('tEq', 'onclick', (e) => { S.eqOn = !S.eqOn; setTg(e.currentTarget, S.eqOn); M.applyAudio(); });
      on('eqPre', 'onchange', (e) => { const p = M.EQ_PRESETS[e.target.value]; if (p) { S.eq = p.slice(); eqSync(); M.applyAudio(); } });
      on('sBass', 'oninput', (e) => { S.bass = +e.target.value; $('#sBass_o', el).textContent = '+' + S.bass + ' dB'; M.applyAudio(); });
      const nt = $('#sNight', el); nt.value = S.night; nt.onchange = () => { S.night = nt.value; M.applyAudio(); };
      // library
      on('lAdd', 'onclick', () => M.pickFolder()); on('lRes', 'onclick', () => M.rescan());
      on('lClr', 'onclick', async () => { if (await M.confirm(t('w.lib.remove') + '?', t('pl.delete'))) { await M.removeAllTracks(); M.route(); } });
      on('bkE', 'onclick', () => M.download('melodust-backup.json', new Blob([JSON.stringify({ v: 1, settings: M.S, user: { fav: M.U.fav, playlists: M.U.playlists, recent: M.U.recent, radio: M.U.radio, plays: M.U.plays } })], { type: 'application/json' })));
      on('bkI', 'onclick', () => $('#fileBackup').click());
      sub('lib', () => { /* refresh folder counts */ });
    }
  };

  /* ======================= WHAT'S NEW / ABOUT ======================= */
  M.views.whatsnew = {
    title: 'nav.whatsnew',
    render(el) {
      const grp = (h, keys) => `<section class="card"><h3>${esc(h)}</h3><ul class="chk">${keys.map((k) => `<li>${icon('check')}<span>${esc(t(k))}</span></li>`).join('')}</ul></section>`;
      el.innerHTML = `<div class="sgrid one">${grp('Web', ['w.wn.1', 'w.wn.2', 'w.wn.3', 'w.wn.4', 'w.wn.5'])}${grp(t('wn.h1'), ['wn.s1', 'wn.s2', 'wn.s3', 'wn.s4', 'wn.s5', 'wn.s6', 'wn.s7'])}${grp('1.0.6', ['wn.n1', 'wn.n2', 'wn.n3', 'wn.n4', 'wn.n5'])}${grp('1.0.5', ['whatsnew.n7', 'whatsnew.n8', 'whatsnew.n9'])}</div>`;
    }
  };
  M.views.about = {
    title: 'nav.about',
    render(el) {
      el.innerHTML = `<div class="about"><img src="icons/icon-192.png" alt="" width="96" height="96"><h2>Melodust <small>Web</small></h2><p class="tag">${esc(t('app.tagline'))}</p><p>${esc(t('w.about.text'))}</p>
        <p class="privacy">${esc(t('w.privacy'))}</p>
        <div class="btns"><a class="ghost" href="https://xgroupsoftware.xyz" target="_blank" rel="noopener">${esc(t('about.website'))}</a><a class="ghost" href="https://t.me/xgroup_software" target="_blank" rel="noopener">${esc(t('about.telegram'))}</a></div>
        <p class="sub">${esc(t('about.created'))} · © XGroup SoftWare</p></div>`;
    }
  };
})();
