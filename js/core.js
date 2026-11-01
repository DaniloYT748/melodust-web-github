/* Melodust Web — core: i18n, icons, storage, settings, theme */
(function () {
  'use strict';
  const M = (window.M = window.M || {});

  /* ---------- helpers ---------- */
  M.$ = (s, r = document) => r.querySelector(s);
  M.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  M.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  M.fmtTime = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  M.fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
  M.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  M.uid = () => Math.random().toString(36).slice(2, 10);
  M.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  M.ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
  };

  /* ---------- i18n ---------- */
  const CODES = ['en', 'uk', 'ru', 'zh', 'ko'];
  M.LANGS = [['system', 'System'], ['en', 'English'], ['uk', 'Українська'], ['ru', 'Русский'], ['zh', '中文'], ['ko', '한국어']];
  M.lang = 'en';
  M.t = (key, ...args) => {
    const row = window.I18N_ROWS[key];
    let s = key;
    if (row) { const i = CODES.indexOf(M.lang); s = row[i < 0 ? 0 : i] || row[0]; }
    return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '') : s;
  };
  M.setLang = (code) => {
    let eff = code;
    if (code === 'system') {
      const two = (navigator.language || 'en').slice(0, 2).toLowerCase();
      eff = CODES.includes(two) ? two : 'en';
    }
    if (!CODES.includes(eff)) eff = 'en';
    M.lang = eff;
    document.documentElement.lang = eff;
    M.$$('[data-i18n]').forEach((el) => (el.textContent = M.t(el.dataset.i18n)));
  };

  /* ---------- icons ---------- */
  const P = {
    play: 'M8 5v14l11-7z', pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z', next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    folder: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    queue: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
    lyrics: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
    viz: 'M3 9h2v6H3zM7 5h2v14H7zM11 2h2v20h-2zM15 7h2v10h-2zM19 10h2v4h-2z',
    radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    mini: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    playlist: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    moon: 'M9 2c-1.05 0-2.05.16-3 .46 4.06 1.27 7 5.06 7 9.54 0 4.48-2.94 8.27-7 9.54.95.3 1.95.46 3 .46 5.52 0 10-4.48 10-10S14.52 2 9 2z',
    headphones: 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z', down: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
    history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    grid: 'M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z'
  };
  M.icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n] || ''}"/></svg>`;
  M.fillIcons = (root = document) => M.$$('[data-ic]', root).forEach((el) => (el.innerHTML = M.icon(el.dataset.ic) + (el.dataset.label ? `<span>${M.esc(M.t(el.dataset.label))}</span>` : '')));

  /* ---------- IndexedDB ---------- */
  let dbp;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('melodust-web', 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      d.createObjectStore('tracks', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  M.db = {
    kvGet: (k) => tx('kv', 'readonly', (s) => s.get(k)).catch(() => undefined),
    kvSet: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)).catch(() => {}),
    kvDel: (k) => tx('kv', 'readwrite', (s) => s.delete(k)).catch(() => {}),
    tracksAll: () => tx('tracks', 'readonly', (s) => s.getAll()).catch(() => []),
    tracksPut: (arr) => tx('tracks', 'readwrite', (s) => { arr.forEach((x) => s.put(x)); }),
    tracksDel: (ids) => tx('tracks', 'readwrite', (s) => { ids.forEach((x) => s.delete(x)); }),
    tracksClear: () => tx('tracks', 'readwrite', (s) => { s.clear(); })
  };

  /* ---------- settings & user data ---------- */
  const DEF = {
    lang: 'system', c1: '#A855F7', c2: '#EC4899', bg: 'theme.1', dynamic: true,
    volume: 0.8, muted: false, shuffle: false, repeat: 'off', speed: 1, keepPitch: true,
    bass: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqOn: true, night: 'off',
    d8: false, d8speed: 8, vizMode: 'Pulse', sort: 'Title', view: 'list', sleep: 0
  };
  M.S = Object.assign({}, DEF, M.ls.get('mw.settings', {}));
  M.saveS = M.debounce(() => M.ls.set('mw.settings', M.S), 200);
  // user data keyed by track key: favorites, playlists, recent
  M.U = Object.assign({ fav: [], playlists: [], recent: [], radio: [], plays: {}, queue: { ids: [], index: 0, pos: 0 } }, M.ls.get('mw.user', {}));
  M.saveU = M.debounce(() => M.ls.set('mw.user', M.U), 300);

  /* ---------- theme ---------- */
  M.PRESETS = [['#A855F7', '#EC4899'], ['#00F0FF', '#7C3AED'], ['#FF0055', '#FF8A00'], ['#2ECC71', '#00D4FF'], ['#F1C40F', '#FF5E62'], ['#3498DB', '#9B59B6'], ['#FF6B9D', '#FFC371'], ['#1ABC9C', '#3498DB'], ['#E74C3C', '#8E44AD'], ['#00C6FF', '#0072FF'], ['#F7971E', '#FFD200'], ['#FFFFFF', '#A0A0B8']];
  M.BGS = {
    'theme.1': 'radial-gradient(1200px 700px at 15% -10%, #2a1458 0%, transparent 60%), radial-gradient(900px 600px at 100% 110%, #3b0f4a 0%, transparent 55%), #0b0714',
    'theme.2': 'radial-gradient(1100px 700px at 10% 0%, #0b4d4a 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #3a1a6e 0%, transparent 55%), #07101a',
    'theme.3': 'radial-gradient(1100px 700px at 90% -10%, #6b1d3a 0%, transparent 60%), radial-gradient(900px 600px at 0% 110%, #6b3a10 0%, transparent 55%), #14080d',
    'theme.4': 'radial-gradient(1100px 700px at 0% 0%, #0b3a6e 0%, transparent 60%), radial-gradient(900px 600px at 100% 100%, #0a4a5a 0%, transparent 55%), #050c18',
    'theme.5': 'radial-gradient(1100px 700px at 100% 0%, #124a2a 0%, transparent 60%), radial-gradient(900px 600px at 0% 100%, #2a3a0f 0%, transparent 55%), #050f0a'
  };
  const hex2rgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  M.hex2rgb = hex2rgb;
  M.rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  M.validHex = (h) => /^#?[0-9a-fA-F]{6}$/.test(h || '');
  M.gradAt = (t) => {
    const a = hex2rgb(M.cur.c1), b = hex2rgb(M.cur.c2);
    return `rgb(${[0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).join(',')})`;
  };
  M.cur = { c1: M.S.c1, c2: M.S.c2 };
  M.applyTheme = (c1, c2) => {
    M.cur = { c1, c2 };
    const r = document.documentElement.style;
    r.setProperty('--c1', c1); r.setProperty('--c2', c2);
    r.setProperty('--c1-rgb', hex2rgb(c1).join(','));
    r.setProperty('--c2-rgb', hex2rgb(c2).join(','));
    const [R, G, B] = hex2rgb(c1);
    // readable text color for accent backgrounds
    r.setProperty('--on-accent', (0.299 * R + 0.587 * G + 0.114 * B) > 150 ? '#12091f' : '#fff');
  };
  M.applyBg = async () => {
    const bg = M.$('#bg');
    if (M.S.bg === 'custom') {
      const blob = await M.db.kvGet('bgphoto');
      if (blob) {
        if (M._bgUrl) URL.revokeObjectURL(M._bgUrl);
        M._bgUrl = URL.createObjectURL(blob);
        bg.style.background = `linear-gradient(rgba(8,5,16,.72),rgba(8,5,16,.82)), center/cover url("${M._bgUrl}")`;
        return;
      }
    }
    bg.style.background = M.BGS[M.S.bg] || M.BGS['theme.1'];
  };
  // dominant, readable colour from a cover image
  M.dominantColor = (url) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 32, 32);
        const d = x.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const sat = mx ? (mx - mn) / mx : 0;
          const wt = 0.15 + sat * sat * 3 + (mx > 40 ? 0.2 : 0);
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        r /= w; g /= w; b /= w;
        // make readable: lift dark colours
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        if (l < 110) { const k = 110 / Math.max(l, 20); r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k); }
        res([r, g, b]);
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  M.shiftHue = (rgb, deg) => {
    let [r, g, b] = rgb.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; }
    const s = mx ? d / mx : 0, v = mx;
    h = (h + deg + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(rr + m) * 255, (gg + m) * 255, (bb + m) * 255];
  };

  /* ---------- toast / dialog / menu ---------- */
  let toastT;
  M.toast = (msg) => {
    const el = M.$('#toast'); el.textContent = msg; el.hidden = false;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200);
  };
  M.dialog = (html, onMount) => {
    const d = M.$('#dialog');
    d.innerHTML = `<div class="dlg-back"></div><div class="dlg" role="dialog" aria-modal="true">${html}</div>`;
    d.hidden = false;
    const close = () => { d.hidden = true; d.innerHTML = ''; };
    M.$('.dlg-back', d).onclick = close;
    M.$$('[data-close]', d).forEach((b) => (b.onclick = close));
    if (onMount) onMount(d, close);
    const f = M.$('input,button.primary', d); if (f) f.focus();
    return close;
  };
  M.confirm = (text, okLabel) => new Promise((res) => {
    M.dialog(`<p>${M.esc(text)}</p><div class="dlg-actions"><button class="ghost" data-close>${M.esc(M.t('pl.cancel'))}</button><button class="primary" id="dOk">${M.esc(okLabel || 'OK')}</button></div>`, (d, close) => {
      M.$('#dOk', d).onclick = () => { close(); res(true); };
      M.$$('[data-close]', d).forEach((b) => { const o = b.onclick; b.onclick = () => { o(); res(false); }; });
      M.$('.dlg-back', d).onclick = () => { close(); res(false); };
    });
  });
  M.prompt = (title, value) => new Promise((res) => {
    M.dialog(`<h3>${M.esc(title)}</h3><input id="dIn" type="text" value="${M.esc(value || '')}" maxlength="80"><div class="dlg-actions"><button class="ghost" data-close>${M.esc(M.t('pl.cancel'))}</button><button class="primary" id="dOk">${M.esc(M.t('pl.create'))}</button></div>`, (d, close) => {
      const inp = M.$('#dIn', d); inp.select();
      const ok = () => { const v = inp.value.trim(); close(); res(v || null); };
      M.$('#dOk', d).onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      M.$$('[data-close]', d).forEach((b) => (b.onclick = () => { close(); res(null); }));
      M.$('.dlg-back', d).onclick = () => { close(); res(null); };
    });
  });
  M.showMenu = (x, y, items) => {
    const m = M.$('#menu');
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}"${it.disabled ? ' disabled' : ''}>${it.icon ? M.icon(it.icon) : '<i></i>'}<span>${M.esc(it.label)}</span></button>`).join('');
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
    m.onclick = (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      m.hidden = true; items[+b.dataset.i].run();
    };
  };
  document.addEventListener('pointerdown', (e) => { const m = M.$('#menu'); if (!m.hidden && !m.contains(e.target)) m.hidden = true; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { M.$('#menu').hidden = true; const d = M.$('#dialog'); if (!d.hidden) { d.hidden = true; d.innerHTML = ''; } } });
})();
