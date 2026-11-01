/* Melodust Web — engine: library, queue, audio graph, lyrics, radio */
(function () {
  'use strict';
  const M = window.M;
  const audio = M.$('#audio');
  M.audio = audio;

  /* ---------- tiny event bus ---------- */
  const bus = new EventTarget();
  M.bus = bus;
  M.on = (n, fn) => bus.addEventListener(n, (e) => fn(e.detail));
  M.emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));

  /* ============================== LIBRARY ============================== */
  const EXT = /\.(mp3|flac|ogg|oga|opus|wav|m4a|aac|weba|webm|mp4|m4b)$/i;
  M.lib = { tracks: [], byId: new Map(), dirs: [], session: new Map(), covers: new Map(), needsPerm: false };
  M.extra = new Map(); // non-library tracks (radio)
  M.scan = { running: false, done: 0, total: 0, cancel: false };
  M.hasFS = typeof window.showDirectoryPicker === 'function';
  M.trackById = (id) => M.lib.byId.get(id) || M.extra.get(id);
  M.coverUrl = (tr) => {
    if (!tr || !tr.cover) return null;
    let u = M.lib.covers.get(tr.id);
    if (!u) { u = URL.createObjectURL(tr.cover); M.lib.covers.set(tr.id, u); }
    return u;
  };

  const sortTracks = () => {
    const k = M.S.sort;
    const cmp = {
      Title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
      Artist: (a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.album.localeCompare(b.album) || (a.no || 0) - (b.no || 0),
      Album: (a, b) => a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }) || (a.no || 0) - (b.no || 0),
      Duration: (a, b) => a.duration - b.duration,
      'Recently added': (a, b) => b.added - a.added,
      'Most played': (a, b) => (M.U.plays[b.id] || 0) - (M.U.plays[a.id] || 0)
    }[k] || ((a, b) => 0);
    M.lib.tracks.sort(cmp);
  };
  M.sortLib = () => { sortTracks(); M.emit('lib'); };

  M.loadLibrary = async () => {
    const [tracks, dirs] = await Promise.all([M.db.tracksAll(), M.db.kvGet('dirs')]);
    M.lib.dirs = dirs || [];
    M.lib.tracks = tracks;
    M.lib.byId = new Map(tracks.map((t) => [t.id, t]));
    sortTracks();
    await checkPerm();
    M.emit('lib');
  };
  const saveDirs = () => M.db.kvSet('dirs', M.lib.dirs);

  async function checkPerm() {
    let need = false;
    for (const d of M.lib.dirs) {
      if (!d.handle) { if (M.lib.tracks.some((t) => t.dirId === d.id && !M.lib.session.has(t.id))) need = true; continue; }
      try { if ((await d.handle.queryPermission({ mode: 'read' })) !== 'granted') need = true; } catch { need = true; }
    }
    M.lib.needsPerm = need && M.lib.tracks.length > 0;
  }

  // Ask the browser again for folder access (must be called from a click)
  M.reconnect = async () => {
    let ok = true;
    for (const d of M.lib.dirs) {
      if (!d.handle) continue;
      try { if ((await d.handle.requestPermission({ mode: 'read' })) !== 'granted') ok = false; } catch { ok = false; }
    }
    // folders that can't be restored (Firefox/Safari): let the user pick them again
    const lost = M.lib.dirs.filter((d) => !d.handle && M.lib.tracks.some((t) => t.dirId === d.id && !M.lib.session.has(t.id)));
    if (lost.length) { M.pickFolder(); return; }
    await checkPerm();
    M.emit('lib');
    if (ok) M.rescan();
  };

  async function* walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') yield* walk(h, prefix + name + '/');
      else if (EXT.test(name)) yield { rel: prefix + name, handle: h };
    }
  }

  const trackId = (dirName, rel, size) => dirName + '/' + rel + '|' + size;

  M.addDirHandle = async (handle) => {
    let dir = null;
    for (const d of M.lib.dirs) { if (d.handle && (await d.handle.isSameEntry(handle))) { dir = d; break; } }
    if (!dir) { dir = { id: M.uid(), name: handle.name, handle }; M.lib.dirs.push(dir); await saveDirs(); }
    await scanDir(dir);
  };
  M.pickFolder = async () => {
    if (M.hasFS) {
      try { await M.addDirHandle(await window.showDirectoryPicker({ mode: 'read', id: 'melodust-music' })); }
      catch (e) { if (e && e.name !== 'AbortError') M.toast(String(e.message || e)); }
    } else {
      M.$('#fileFolder').click();
    }
  };
  M.pickFiles = () => M.$('#fileAudio').click();

  // fallback: <input webkitdirectory> / drag&drop / loose files
  M.addFileList = async (files, loose) => {
    files = [...files].filter((f) => EXT.test(f.name) || f.type.startsWith('audio/'));
    if (!files.length) { M.toast(M.t('w.noFiles')); return; }
    const entries = [];
    for (const f of files) {
      let dirName = '(files)', rel = f.name;
      if (!loose && f.webkitRelativePath) {
        const parts = f.webkitRelativePath.split('/');
        dirName = parts.shift(); rel = parts.join('/');
      }
      let dir = M.lib.dirs.find((d) => d.name === dirName && !d.handle);
      if (!dir) { dir = { id: 's:' + dirName, name: dirName, handle: null }; M.lib.dirs.push(dir); }
      entries.push({ dir, rel, getFile: async () => f, size: f.size, mtime: f.lastModified });
    }
    await saveDirs();
    await ingest(entries, false);
  };

  async function scanDir(dir) {
    if (M.scan.running) return;
    M.scan = { running: true, done: 0, total: 0, cancel: false };
    M.emit('scan');
    const entries = [];
    try {
      for await (const it of walk(dir.handle, '')) {
        if (M.scan.cancel) break;
        entries.push({ dir, rel: it.rel, handle: it.handle, getFile: () => it.handle.getFile() });
        if (entries.length % 50 === 0) { M.scan.total = entries.length; M.emit('scan'); }
      }
      // need sizes for ids → resolve lazily during ingest
      await ingest(entries, true);
    } catch (e) { M.toast(String(e.message || e)); }
    M.scan.running = false; M.emit('scan');
    if (!entries.length) M.toast(M.t('w.noFiles'));
  }

  M.rescan = async () => {
    if (M.scan.running) return;
    for (const d of M.lib.dirs) if (d.handle) {
      try { if ((await d.handle.queryPermission({ mode: 'read' })) === 'granted') await scanDir(d); } catch { /* skip */ }
    }
  };

  async function thumb(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, 384 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return await new Promise((r) => c.toBlob((b) => r(b || blob), 'image/jpeg', 0.85));
    } catch { return blob; }
  }
  const readTags = (file) => new Promise((res) => {
    if (!window.jsmediatags) return res(null);
    try { window.jsmediatags.read(file, { onSuccess: (t) => res(t.tags), onError: () => res(null) }); } catch { res(null); }
  });
  // Ogg Vorbis / Opus comments (jsmediatags can't read these)
  async function readVorbis(file) {
    try {
      const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
      const find = (m) => { outer: for (let i = 0; i < buf.length - m.length; i++) { for (let k = 0; k < m.length; k++) if (buf[i + k] !== m.charCodeAt(k)) continue outer; return i + m.length; } return -1; };
      let p = find('OpusTags');
      if (p < 0) { const v = find('vorbis'); if (v < 0) return null; let q = -1; for (let i = 0; i < buf.length - 7; i++) if (buf[i] === 3 && buf[i + 1] === 0x76 && buf[i + 2] === 0x6f && buf[i + 3] === 0x72) { q = i + 7; break; } p = q; }
      if (p < 0) return null;
      const dv = new DataView(buf.buffer);
      const td = new TextDecoder();
      p += 4 + dv.getUint32(p, true);
      const n = dv.getUint32(p, true); p += 4;
      const out = {};
      for (let i = 0; i < n && p + 4 <= buf.length; i++) {
        const len = dv.getUint32(p, true); p += 4;
        if (len > 20000 || p + len > buf.length) break;
        const s = td.decode(buf.subarray(p, p + len)); p += len;
        const eq = s.indexOf('=');
        if (eq > 0) { const k = s.slice(0, eq).toLowerCase(); if (!(k in out)) out[k] = s.slice(eq + 1); }
      }
      return { title: out.title, artist: out.artist || out.albumartist, album: out.album, genre: out.genre, year: (out.date || out.year || '').slice(0, 4), track: out.tracknumber };
    } catch { return null; }
  }
  const probeDuration = (file) => new Promise((res) => {
    const a = new Audio(); a.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (v) => { clearTimeout(to); a.src = ''; URL.revokeObjectURL(url); res(v); };
    const to = setTimeout(() => done(0), 5000);
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = url;
  });

  async function ingest(entries, fromFS) {
    if (!fromFS) { M.scan = { running: true, done: 0, total: 0, cancel: false }; }
    M.scan.running = true; M.scan.total = entries.length; M.scan.done = 0; M.emit('scan');
    const seen = new Set(); // ids found in this pass (for pruning removed files)
    const fresh = [];
    let idx = 0;
    const worker = async () => {
      while (idx < entries.length && !M.scan.cancel) {
        const e = entries[idx++];
        try {
          const file = await e.getFile();
          const id = trackId(e.dir.name, e.rel, file.size);
          seen.add(id);
          if (!e.dir.handle) M.lib.session.set(id, file);
          let tr = M.lib.byId.get(id);
          if (!tr) {
            let tags = await readTags(file);
            if ((!tags || !tags.title) && /\.(ogg|oga|opus)$/i.test(file.name)) tags = Object.assign({}, tags, (await readVorbis(file)) || {});
            let title = tags && tags.title, artist = tags && tags.artist;
            const base = file.name.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}\s*[-._)]\s*/, '');
            if (!title) {
              const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
              if (m && !artist) { artist = m[1]; title = m[2]; } else title = base;
            }
            let cover = null;
            if (tags && tags.picture) {
              try { cover = await thumb(new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format || 'image/jpeg' })); } catch { cover = null; }
            }
            const duration = await probeDuration(file);
            tr = {
              id, dirId: e.dir.id, rel: e.rel, name: file.name, size: file.size, mtime: file.lastModified,
              title: String(title).trim(), artist: String(artist || '').trim(), album: String((tags && tags.album) || '').trim(),
              genre: String((tags && tags.genre) || '').trim(), year: String((tags && tags.year) || '').slice(0, 4),
              no: parseInt(tags && tags.track, 10) || 0, duration, cover, added: Date.now(),
              ext: (file.name.split('.').pop() || '').toLowerCase()
            };
            fresh.push(tr);
            M.lib.byId.set(id, tr);
            M.lib.tracks.push(tr);
            if (fresh.length % 25 === 0) { await M.db.tracksPut(fresh.splice(0)); sortTracks(); M.emit('lib'); }
          } else if (tr.dirId !== e.dir.id) {
            tr.dirId = e.dir.id; fresh.push(tr);
          }
        } catch { /* unreadable file: skip */ }
        M.scan.done++;
        if (M.scan.done % 5 === 0) M.emit('scan');
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (fresh.length) await M.db.tracksPut(fresh);
    // prune files that disappeared from folders we fully scanned
    if (fromFS && !M.scan.cancel && entries.length) {
      const dirId = entries[0].dir.id;
      const gone = M.lib.tracks.filter((t) => t.dirId === dirId && !seen.has(t.id)).map((t) => t.id);
      if (gone.length) {
        const gs = new Set(gone);
        M.lib.tracks = M.lib.tracks.filter((t) => !gs.has(t.id)); gone.forEach((i) => M.lib.byId.delete(i));
        await M.db.tracksDel(gone);
      }
    }
    M.scan.running = false;
    sortTracks(); await checkPerm(); M.emit('scan'); M.emit('lib');
  }

  M.removeAllTracks = async () => {
    M.lib.tracks = []; M.lib.byId = new Map(); M.lib.dirs = []; M.lib.session.clear();
    M.lib.covers.forEach((u) => URL.revokeObjectURL(u)); M.lib.covers.clear();
    await M.db.tracksClear(); await M.db.kvSet('dirs', []);
    M.lib.needsPerm = false; M.emit('lib');
  };

  async function getFile(tr) {
    if (M.lib.session.has(tr.id)) return M.lib.session.get(tr.id);
    const dir = M.lib.dirs.find((d) => d.id === tr.dirId);
    if (!dir || !dir.handle) throw new Error('missing');
    let p = await dir.handle.queryPermission({ mode: 'read' });
    if (p !== 'granted') p = await dir.handle.requestPermission({ mode: 'read' });
    if (p !== 'granted') throw new Error('perm');
    let h = dir.handle;
    const parts = tr.rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
    return (await h.getFileHandle(parts[parts.length - 1])).getFile();
  }
  M.getFile = getFile;

  /* ============================== AUDIO GRAPH ============================== */
  const EQ_F = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  M.EQ_F = EQ_F;
  M.EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], Bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], Treble: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
    Rock: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5], Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2], Jazz: [3, 2, 1, 2, -2, -2, 0, 1, 2, 3],
    Classical: [4, 3, 2, 2, -1, -1, 0, 2, 3, 4], Vocal: [-2, -3, -2, 1, 4, 4, 3, 1, 0, -1], Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5]
  };
  let ctx = null, G = null;
  M.analyser = null;

  function buildGraph() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });
    const src = ctx.createMediaElementSource(audio);
    G = {};
    G.bass = ctx.createBiquadFilter(); G.bass.type = 'lowshelf'; G.bass.frequency.value = 110;
    G.eq = EQ_F.map((f) => { const b = ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b; });
    G.comp = ctx.createDynamicsCompressor();
    // dry / 8D branches
    G.dry = ctx.createGain();
    G.wet = ctx.createGain();
    G.pan = ctx.createStereoPanner();
    G.back = ctx.createGain(); G.back.gain.value = 0.85;
    G.lp = ctx.createBiquadFilter(); G.lp.type = 'lowpass'; G.lp.frequency.value = 9000; G.lp.Q.value = 0.4;
    G.sum = ctx.createGain();
    M.analyser = G.an = ctx.createAnalyser(); G.an.fftSize = 2048; G.an.smoothingTimeConstant = 0.78;
    // chain: src → bass → eq… → comp → (dry | pan→lp→back→wet) → sum → analyser → out
    let n = src; n.connect(G.bass); n = G.bass;
    G.eq.forEach((b) => { n.connect(b); n = b; });
    n.connect(G.comp);
    G.comp.connect(G.dry); G.dry.connect(G.sum);
    G.comp.connect(G.pan); G.pan.connect(G.lp); G.lp.connect(G.back); G.back.connect(G.wet); G.wet.connect(G.sum);
    G.sum.connect(G.an); G.an.connect(ctx.destination);
    // LFOs run on the audio thread (keep going when the tab is in background)
    G.sinOsc = ctx.createOscillator(); G.sinOsc.type = 'sine';
    G.cosOsc = ctx.createOscillator();
    G.cosOsc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
    G.sinG = ctx.createGain(); G.sinG.gain.value = 0.95; // pan depth
    G.lpG = ctx.createGain(); G.lpG.gain.value = 4500;   // brightness depth (behind = darker)
    G.bkG = ctx.createGain(); G.bkG.gain.value = 0.12;   // loudness depth
    G.sinOsc.connect(G.sinG); G.sinG.connect(G.pan.pan);
    G.cosOsc.connect(G.lpG); G.lpG.connect(G.lp.frequency);
    G.cosOsc.connect(G.bkG); G.bkG.connect(G.back.gain);
    G.sinOsc.start(); G.cosOsc.start();
    applyAudio();
  }

  function applyAudio() {
    if (!G) return;
    const t = ctx.currentTime;
    G.bass.gain.setTargetAtTime(M.S.bass, t, 0.05);
    G.eq.forEach((b, i) => b.gain.setTargetAtTime(M.S.eqOn ? M.S.eq[i] : 0, t, 0.05));
    const nm = { off: [0, 1, 0.003, 0.25], light: [-28, 3, 0.01, 0.25], strong: [-40, 8, 0.005, 0.2] }[M.S.night] || [0, 1, 0.003, 0.25];
    G.comp.threshold.value = nm[0]; G.comp.ratio.value = nm[1]; G.comp.attack.value = nm[2]; G.comp.release.value = nm[3]; G.comp.knee.value = 12;
    G.dry.gain.setTargetAtTime(M.S.d8 ? 0 : 1, t, 0.08);
    G.wet.gain.setTargetAtTime(M.S.d8 ? 1 : 0, t, 0.08);
    const f = 1 / M.clamp(M.S.d8speed, 2, 30);
    G.sinOsc.frequency.setTargetAtTime(f, t, 0.1);
    G.cosOsc.frequency.setTargetAtTime(f, t, 0.1);
    // night mode: makeup gain so it doesn't get quieter
    G.sum.gain.setTargetAtTime(M.S.night === 'strong' ? 1.5 : M.S.night === 'light' ? 1.2 : 1, t, 0.1);
  }
  M.applyAudio = () => { applyAudio(); M.saveS(); };

  function applyElement() {
    audio.volume = M.clamp(M.S.volume, 0, 1);
    audio.muted = !!M.S.muted;
    audio.playbackRate = M.S.speed;
    audio.preservesPitch = M.S.keepPitch; audio.mozPreservesPitch = M.S.keepPitch; audio.webkitPreservesPitch = M.S.keepPitch;
  }
  M.applyElement = () => { applyElement(); M.saveS(); };

  /* ============================== QUEUE / PLAYBACK ============================== */
  M.q = { ids: [], index: -1 };
  M.cur = M.cur || {};
  let objUrl = null, loadTok = 0, errStreak = 0, pendingSeek = 0;
  M.ab = { a: null, b: null };
  const shuffleArr = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  M.curTrack = () => M.trackById(M.q.ids[M.q.index]);
  M.isPlaying = () => !audio.paused && !audio.ended;

  M.setQueue = (ids, start = 0, play = true) => {
    ids = ids.filter((i) => M.trackById(i));
    if (!ids.length) return;
    let list = ids.slice();
    if (M.S.shuffle) {
      const first = list.splice(start, 1);
      list = first.concat(shuffleArr(list)); start = 0;
    }
    M.q.ids = list; M.q.index = start;
    M.ab = { a: null, b: null };
    M.emit('queue');
    return playIndex(start, play);
  };
  M.playTrackIn = (list, id) => { const i = list.indexOf(id); return M.setQueue(list, i < 0 ? 0 : i); };
  M.enqueue = (ids, next) => {
    ids = ids.filter((i) => M.trackById(i));
    if (!ids.length) return;
    if (!M.q.ids.length) { M.setQueue(ids, 0, false); return; }
    if (next) M.q.ids.splice(M.q.index + 1, 0, ...ids); else M.q.ids.push(...ids);
    M.emit('queue'); M.persistQueue();
  };

  async function playIndex(i, autoplay = true) {
    if (i < 0 || i >= M.q.ids.length) return;
    M.q.index = i;
    const tr = M.curTrack();
    const tok = ++loadTok;
    M.emit('track', tr); M.emit('queue');
    buildGraph();
    applyElement();
    try {
      if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
      if (tr.radio) {
        audio.src = await resolveStream(tr.url);
      } else {
        const f = await getFile(tr);
        if (tok !== loadTok) return;
        objUrl = URL.createObjectURL(f);
        audio.src = objUrl;
      }
      audio.playbackRate = M.S.speed; applyElement();
      if (pendingSeek) { const p = pendingSeek; pendingSeek = 0; audio.addEventListener('loadedmetadata', () => { audio.currentTime = p; }, { once: true }); }
      if (autoplay) { if (ctx.state === 'suspended') await ctx.resume(); await audio.play(); }
      if (tok !== loadTok) return;
      errStreak = 0;
      if (autoplay && !tr.radio) {
        M.U.plays[tr.id] = (M.U.plays[tr.id] || 0) + 1;
        M.U.recent = [tr.id, ...M.U.recent.filter((x) => x !== tr.id)].slice(0, 100);
        M.saveU(); M.emit('recent');
      }
      updateMediaSession(tr);
      themeFromCover(tr);
      M.persistQueue();
    } catch (e) {
      if (tok !== loadTok) return;
      if (e && e.name === 'AbortError') return;
      if (e && e.name === 'NotAllowedError') { M.emit('state'); return; }
      const msg = e && (e.message === 'perm' || e.message === 'missing' || e.name === 'NotFoundError') ? M.t('w.missing') : (e && e.name === 'NotSupportedError' ? M.t('w.cantPlay') : String((e && e.message) || e));
      M.toast(tr.radio ? M.t('radio.failed', msg) : msg);
      if (++errStreak < 3 && !tr.radio && M.q.ids.length > 1) { setTimeout(() => M.next(true), 400); } else errStreak = 0;
      M.emit('state');
    }
  }
  M.playIndex = playIndex;

  M.toggle = async () => {
    if (!M.q.ids.length) { if (M.lib.tracks.length) M.setQueue(M.lib.tracks.map((t) => t.id), 0); return; }
    if (!audio.src) { await playIndex(M.q.index < 0 ? 0 : M.q.index, true); return; }
    buildGraph();
    if (audio.paused) { try { if (ctx.state === 'suspended') await ctx.resume(); await audio.play(); } catch (e) { M.toast(String(e.message || e)); } } else audio.pause();
  };
  M.next = (auto) => {
    if (!M.q.ids.length) return;
    const t = M.curTrack();
    if (t && t.radio) return;
    let i = M.q.index + 1;
    if (i >= M.q.ids.length) {
      if (M.S.repeat === 'all' || !auto) i = 0; else { audio.pause(); audio.currentTime = 0; M.emit('state'); return; }
    }
    playIndex(i, true);
  };
  M.prev = () => {
    if (!M.q.ids.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    let i = M.q.index - 1; if (i < 0) i = M.S.repeat === 'all' ? M.q.ids.length - 1 : 0;
    playIndex(i, true);
  };
  M.seek = (t) => { if (isFinite(audio.duration)) audio.currentTime = M.clamp(t, 0, audio.duration); };
  M.setVolume = (v) => { M.S.volume = M.clamp(v, 0, 1); if (v > 0) M.S.muted = false; applyElement(); M.saveS(); M.emit('volume'); };
  M.toggleMute = () => { M.S.muted = !M.S.muted; applyElement(); M.saveS(); M.emit('volume'); };
  M.toggleShuffle = () => {
    M.S.shuffle = !M.S.shuffle;
    if (M.S.shuffle && M.q.ids.length > 1) {
      const upcoming = shuffleArr(M.q.ids.slice(M.q.index + 1));
      M.q.ids = M.q.ids.slice(0, M.q.index + 1).concat(upcoming); M.emit('queue');
    }
    M.saveS(); M.emit('mode');
  };
  M.cycleRepeat = () => { M.S.repeat = { off: 'all', all: 'one', one: 'off' }[M.S.repeat] || 'off'; M.saveS(); M.emit('mode'); };
  M.toggle8d = () => { buildGraph(); M.S.d8 = !M.S.d8; M.applyAudio(); M.emit('mode'); };
  M.setSpeed = (v) => { M.S.speed = v; M.applyElement(); };

  // queue editing
  M.queueRemove = (i) => {
    if (i === M.q.index) return;
    M.q.ids.splice(i, 1); if (i < M.q.index) M.q.index--;
    M.emit('queue'); M.persistQueue();
  };
  M.queueMove = (from, to) => {
    if (from === to || to < 0 || to >= M.q.ids.length) return;
    const cur = M.q.ids[M.q.index];
    const [x] = M.q.ids.splice(from, 1); M.q.ids.splice(to, 0, x);
    M.q.index = M.q.ids.indexOf(cur); M.emit('queue'); M.persistQueue();
  };
  M.queueClearUpcoming = () => { M.q.ids.length = M.q.index + 1; M.emit('queue'); M.persistQueue(); };

  audio.addEventListener('ended', () => {
    if (M.S.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    M.next(true);
  });
  audio.addEventListener('play', () => { M.emit('state'); if (M.S.sleepMode === 'track') {} });
  audio.addEventListener('pause', () => M.emit('state'));
  audio.addEventListener('loadedmetadata', () => {
    M.emit('time');
    const t = M.curTrack();
    if (t && !t.radio && isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) { t.duration = audio.duration; M.db.tracksPut([t]); }
  });
  audio.addEventListener('timeupdate', () => {
    if (M.ab.a != null && M.ab.b != null && audio.currentTime >= M.ab.b) audio.currentTime = M.ab.a;
    M.emit('time');
  });
  audio.addEventListener('error', () => {
    if (!audio.src || audio.src === location.href) return;
    const t = M.curTrack();
    if (t && t.radio) M.toast(M.t('radio.failed', (audio.error && audio.error.message) || 'CORS / format'));
    else if (audio.error && audio.error.code === 4) { M.toast(M.t('w.cantPlay')); if (++errStreak < 3 && M.q.ids.length > 1) setTimeout(() => M.next(true), 400); }
  });
  // smooth UI time updates while playing (timeupdate is only ~4 Hz)
  (function raf() { if (M.isPlaying() && !document.hidden) M.emit('time'); requestAnimationFrame(raf); })();

  /* A-B repeat */
  M.abClick = () => {
    if (M.ab.a == null) M.ab.a = audio.currentTime;
    else if (M.ab.b == null) { if (audio.currentTime > M.ab.a + 0.5) M.ab.b = audio.currentTime; else M.ab = { a: null, b: null }; }
    else M.ab = { a: null, b: null };
    M.emit('ab');
  };

  /* sleep timer */
  let sleepT = null;
  M.sleepAt = 0;
  M.setSleep = (min) => {
    clearTimeout(sleepT); M.sleepAt = 0;
    if (min > 0) {
      M.sleepAt = Date.now() + min * 60000;
      sleepT = setTimeout(() => {
        const t0 = audio.volume; let k = 0;
        const iv = setInterval(() => { k++; audio.volume = Math.max(0, t0 * (1 - k / 20)); if (k >= 20) { clearInterval(iv); audio.pause(); audio.volume = M.S.volume; M.sleepAt = 0; M.emit('state'); } }, 100);
      }, min * 60000);
    }
    M.emit('sleep');
  };

  /* session persistence */
  M.persistQueue = M.debounce(() => {
    const ids = M.q.ids.filter((i) => !String(i).startsWith('radio:'));
    M.U.queue = { ids, index: Math.max(0, ids.indexOf(M.q.ids[M.q.index])), pos: audio.currentTime || 0 };
    M.saveU();
  }, 800);
  setInterval(() => { if (M.isPlaying()) M.persistQueue(); }, 5000);
  M.restoreQueue = () => {
    const s = M.U.queue;
    if (!s || !s.ids || !s.ids.length) return;
    const ids = s.ids.filter((i) => M.lib.byId.has(i));
    if (!ids.length) return;
    const idx = ids.indexOf(s.ids[s.index]);
    M.q.ids = ids; M.q.index = idx < 0 ? 0 : idx;
    pendingSeek = s.pos || 0;
    M.emit('queue'); M.emit('track', M.curTrack()); updateMediaSession(M.curTrack());
    themeFromCover(M.curTrack());
  };
  window.addEventListener('pagehide', () => { M.persistQueue(); M.ls.set('mw.user', M.U); M.ls.set('mw.settings', M.S); });

  /* media session */
  function updateMediaSession(tr) {
    if (!('mediaSession' in navigator) || !tr) return;
    const cover = M.coverUrl(tr);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: tr.title, artist: tr.artist || '', album: tr.album || '', artwork: cover ? [{ src: cover, sizes: '384x384', type: 'image/jpeg' }] : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }] });
    } catch { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
    set('play', () => M.toggle()); set('pause', () => M.toggle());
    set('previoustrack', () => M.prev()); set('nexttrack', () => M.next());
    set('seekto', (d) => M.seek(d.seekTime));
    set('seekbackward', () => M.seek(audio.currentTime - 10)); set('seekforward', () => M.seek(audio.currentTime + 10));
  }

  /* dynamic UI colours from the cover */
  async function themeFromCover(tr) {
    document.title = tr ? `${tr.title}${tr.artist ? ' — ' + tr.artist : ''} · Melodust` : 'Melodust Web';
    if (!M.S.dynamic) return;
    const url = tr && M.coverUrl(tr);
    if (!url) { M.applyTheme(M.S.c1, M.S.c2); return; }
    const rgb = await M.dominantColor(url);
    if (!rgb) return;
    if (M.curTrack() !== tr) return;
    M.applyTheme(M.rgb2hex(...rgb), M.rgb2hex(...M.shiftHue(rgb, 40)));
    M.emit('theme');
  }
  M.themeFromCover = () => themeFromCover(M.curTrack());

  /* ============================== LYRICS ============================== */
  M.lyrics = { id: null, status: 'idle', lines: null, plain: null };
  M.parseLrc = (txt) => {
    const lines = [];
    for (const raw of String(txt).split(/\r?\n/)) {
      const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
      if (!tags.length) continue;
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of tags) lines.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')), text });
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  };
  async function fetchJson(url) {
    const c = new AbortController(); const to = setTimeout(() => c.abort(), 9000);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); } catch { return null; } finally { clearTimeout(to); }
  }
  M.loadLyrics = async (tr) => {
    if (!tr || tr.radio) { M.lyrics = { id: null, status: 'none', lines: null, plain: null }; M.emit('lyrics'); return; }
    if (M.lyrics.id === tr.id && M.lyrics.status !== 'idle') return;
    M.lyrics = { id: tr.id, status: 'searching', lines: null, plain: null }; M.emit('lyrics');
    const cached = await M.db.kvGet('lyr:' + tr.id);
    let data = cached;
    if (!data && navigator.onLine !== false) {
      const q = new URLSearchParams({ track_name: tr.title, artist_name: tr.artist || '', album_name: tr.album || '' });
      if (tr.duration) q.set('duration', Math.round(tr.duration));
      let r = tr.artist ? await fetchJson('https://lrclib.net/api/get?' + q) : null;
      if (!r || (!r.syncedLyrics && !r.plainLyrics)) {
        const s = await fetchJson('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: tr.title, artist_name: tr.artist || '' }));
        r = Array.isArray(s) ? s.find((x) => x.syncedLyrics) || s.find((x) => x.plainLyrics) : null;
      }
      if (r && (r.syncedLyrics || r.plainLyrics)) { data = { synced: r.syncedLyrics || null, plain: r.plainLyrics || null }; M.db.kvSet('lyr:' + tr.id, data); }
    }
    if (M.lyrics.id !== tr.id) return;
    if (data && (data.synced || data.plain)) {
      const lines = data.synced ? M.parseLrc(data.synced) : null;
      M.lyrics = { id: tr.id, status: 'ok', lines: lines && lines.length ? lines : null, plain: data.plain || (lines ? null : data.synced) };
    } else M.lyrics = { id: tr.id, status: 'none', lines: null, plain: null };
    M.emit('lyrics');
  };
  M.importLyrics = async (file) => {
    const tr = M.curTrack(); if (!tr || !file) return;
    const txt = await file.text();
    const lines = M.parseLrc(txt);
    const data = lines.length ? { synced: txt, plain: null } : { synced: null, plain: txt };
    await M.db.kvSet('lyr:' + tr.id, data);
    M.lyrics = { id: tr.id, status: 'ok', lines: lines.length ? lines : null, plain: lines.length ? null : txt };
    M.emit('lyrics');
  };
  M.on('track', (tr) => { if (M.lyrics.id !== (tr && tr.id)) { M.lyrics = { id: null, status: 'idle', lines: null, plain: null }; } if (location.hash === '#/lyrics') M.loadLyrics(tr); });

  /* ============================== RADIO ============================== */
  async function resolveStream(url) {
    if (!/\.(pls|m3u8?|asx)(\?|$)/i.test(url)) return url;
    try {
      const r = await fetch(url); const txt = await r.text();
      const m = txt.match(/^(?:File\d+=)?(https?:\/\/\S+)/m);
      if (m) return m[1].trim();
    } catch { /* CORS */ }
    return url;
  }
  M.playRadio = (st) => {
    const id = 'radio:' + st.url;
    M.extra.set(id, { id, radio: true, title: st.name, artist: M.t('radio.title'), album: '', duration: 0, url: st.url });
    return M.setQueue([id], 0, true);
  };

  /* ============================== FAVORITES / PLAYLISTS ============================== */
  M.isFav = (id) => M.U.fav.includes(id);
  M.toggleFav = (id) => {
    const i = M.U.fav.indexOf(id);
    if (i < 0) M.U.fav.unshift(id); else M.U.fav.splice(i, 1);
    M.saveU(); M.emit('fav');
  };
  M.newPlaylist = async (name, ids) => {
    name = name || (await M.prompt(M.t('pl.name'), M.t('pl.default')));
    if (!name) return null;
    const p = { id: M.uid(), name, ids: ids ? ids.slice() : [] };
    M.U.playlists.push(p); M.saveU(); M.emit('playlists'); return p;
  };
  M.addToPlaylist = (pl, ids) => {
    let n = 0; ids.forEach((i) => { if (!pl.ids.includes(i)) { pl.ids.push(i); n++; } });
    M.saveU(); M.emit('playlists'); M.toast(`${pl.name} +${n}`);
  };

  /* init */
  M.initEngine = () => { applyElement(); };
})();
