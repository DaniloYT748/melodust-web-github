/* Melodust sync document: validation + conflict-free merge (last-writer-wins per record).
   Shared by the browser (window.MWDoc) and the Node server (require). Keep js/syncdoc.js and server/syncdoc.js identical. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MWDoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIM = { f: 50000, p: 500, r: 500, h: 200, n: 50000, s: 40, ids: 5000 };
  const BUCKETS = ['f', 'p', 'r', 'h', 'n', 's'];
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const isNum = (v, a, b) => typeof v === 'number' && isFinite(v) && v >= a && v <= b;
  const isTime = (t) => isNum(t, 1, 4e12);
  const isStr = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && s !== '__proto__';
  const oneOf = (list) => (v) => list.includes(v);
  const hex = (v) => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);

  // Settings that follow the account. Per-device ones (volume, queue, sleep timer, custom photo background) are not here.
  const SETTINGS = {
    lang: oneOf(['system', 'en', 'uk', 'ru', 'zh', 'ko']),
    c1: hex, c2: hex,
    bg: (v) => typeof v === 'string' && /^theme\.[1-5]$/.test(v),
    dynamic: (v) => typeof v === 'boolean',
    bass: (v) => isNum(v, 0, 15),
    eq: (v) => Array.isArray(v) && v.length === 10 && v.every((x) => isNum(x, -12, 12)),
    eqOn: (v) => typeof v === 'boolean',
    night: oneOf(['off', 'light', 'strong']),
    d8: (v) => typeof v === 'boolean',
    d8speed: (v) => isNum(v, 3, 20),
    vizMode: (v) => typeof v === 'string' && /^[A-Za-z ]{1,24}$/.test(v),
    sort: (v) => typeof v === 'string' && /^[A-Za-z ]{1,24}$/.test(v),
    view: oneOf(['list', 'grid']),
    speed: (v) => isNum(v, 0.5, 2),
    keepPitch: (v) => typeof v === 'boolean'
  };
  const SETTING_KEYS = Object.keys(SETTINGS);

  const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

  function emptyDoc() {
    return { seq: 0, c: { f: 0, p: 0, r: 0, h: 0, n: 0, s: 0 }, f: {}, p: {}, r: {}, h: {}, hc: { t: 0, seq: 0 }, n: {}, s: {} };
  }
  // Make sure a doc loaded from storage has every field (and correct counters).
  function fixDoc(d) {
    if (!d || typeof d !== 'object') return emptyDoc();
    const e = emptyDoc();
    d.seq = isNum(d.seq, 0, Number.MAX_SAFE_INTEGER) ? d.seq : 0;
    d.c = d.c || e.c;
    BUCKETS.forEach((b) => { if (!d[b] || typeof d[b] !== 'object') d[b] = {}; d.c[b] = Object.keys(d[b]).length; });
    if (!d.hc || typeof d.hc !== 'object') d.hc = { t: 0, seq: 0 };
    return d;
  }
  const get = (bucket, id) => (own(bucket, id) ? bucket[id] : undefined);

  /* ---------- validation: returns a clean copy of the op, or null ---------- */
  function validateOp(o) {
    if (!o || typeof o !== 'object') return null;
    switch (o.k) {
      case 'f':
        if (!isStr(o.id, 512) || typeof o.on !== 'boolean' || !isTime(o.t)) return null;
        return { k: 'f', id: o.id, on: o.on, t: o.t };
      case 'p':
        if (!isStr(o.id, 64) || typeof o.name !== 'string' || o.name.length > 80 || typeof o.del !== 'boolean' || !isTime(o.t) || !isTime(o.c)) return null;
        if (!Array.isArray(o.ids) || o.ids.length > LIM.ids || !o.ids.every((i) => isStr(i, 512))) return null;
        return { k: 'p', id: o.id, name: o.name, ids: o.ids.slice(), c: o.c, del: o.del, t: o.t };
      case 'r':
        if (!isStr(o.id, 1024) || !/^https?:\/\//i.test(o.id) || typeof o.name !== 'string' || o.name.length > 80 || typeof o.del !== 'boolean' || !isTime(o.t)) return null;
        return { k: 'r', id: o.id, name: o.name, del: o.del, t: o.t };
      case 'h':
        if (!isStr(o.id, 512) || !isTime(o.t)) return null;
        return { k: 'h', id: o.id, t: o.t };
      case 'hc':
        if (!isTime(o.t)) return null;
        return { k: 'hc', t: o.t };
      case 'n':
        if (!isStr(o.id, 512) || !Number.isInteger(o.n) || o.n < 0 || o.n > 1e7) return null;
        return { k: 'n', id: o.id, n: o.n };
      case 's':
        if (typeof o.id !== 'string' || !own(SETTINGS, o.id) || !SETTINGS[o.id](o.v) || !isTime(o.t)) return null;
        return { k: 's', id: o.id, v: clone(o.v), t: o.t };
      default: return null;
    }
  }

  // Later timestamp wins; on an exact tie the larger payload wins, so every replica converges.
  const wins = (cur, t, key, curKey) => t > cur.t || (t === cur.t && key > curKey);

  function drop(doc, b, id) { if (own(doc[b], id)) { delete doc[b][id]; doc.c[b]--; } }

  function put(doc, b, id, entry, seq) {
    if (seq) entry.seq = seq;
    if (!own(doc[b], id)) doc.c[b]++;
    doc[b][id] = entry;
  }

  /* ---------- merge one (validated) op into the doc. Returns true if the doc changed. ---------- */
  function applyOp(doc, op, seq) {
    const k = op.k;
    if (k === 'hc') {
      if (op.t <= doc.hc.t) return false;
      doc.hc = { t: op.t, seq: seq || 0 };
      Object.keys(doc.h).forEach((id) => { if (doc.h[id].t <= op.t) drop(doc, 'h', id); });
      return true;
    }
    const cur = get(doc[k], op.id);
    if (!cur && doc.c[k] >= LIM[k]) return false;
    switch (k) {
      case 'f':
        if (cur && !wins(cur, op.t, String(op.on), String(cur.on))) return false;
        put(doc, 'f', op.id, { on: op.on, t: op.t }, seq); return true;
      case 'p': {
        const key = JSON.stringify([op.name, op.ids, op.del, op.c]);
        if (cur && !wins(cur, op.t, key, JSON.stringify([cur.name, cur.ids, cur.del, cur.c]))) return false;
        put(doc, 'p', op.id, { name: op.name, ids: op.ids.slice(), c: op.c, del: op.del, t: op.t }, seq); return true;
      }
      case 'r': {
        const key = JSON.stringify([op.name, op.del]);
        if (cur && !wins(cur, op.t, key, JSON.stringify([cur.name, cur.del]))) return false;
        put(doc, 'r', op.id, { name: op.name, del: op.del, t: op.t }, seq); return true;
      }
      case 'h': {
        if (op.t <= doc.hc.t) return false;
        if (cur && op.t <= cur.t) return false;
        put(doc, 'h', op.id, { t: op.t }, seq);
        while (doc.c.h > LIM.h) { // keep only the newest entries
          let oldest = null;
          for (const id in doc.h) if (oldest === null || doc.h[id].t < doc.h[oldest].t) oldest = id;
          drop(doc, 'h', oldest);
        }
        return own(doc.h, op.id);
      }
      case 'n':
        if (cur && op.n <= cur.n) return false;
        put(doc, 'n', op.id, { n: op.n }, seq); return true;
      case 's': {
        const key = JSON.stringify(op.v);
        if (cur && !wins(cur, op.t, key, JSON.stringify(cur.v))) return false;
        put(doc, 's', op.id, { v: clone(op.v), t: op.t }, seq); return true;
      }
      default: return false;
    }
  }

  /* ---------- turn stored entries back into ops (for sending to other devices) ---------- */
  function entryToOp(k, id, e) {
    switch (k) {
      case 'f': return { k, id, on: e.on, t: e.t };
      case 'p': return { k, id, name: e.name, ids: e.ids, c: e.c, del: e.del, t: e.t };
      case 'r': return { k, id, name: e.name, del: e.del, t: e.t };
      case 'h': return { k, id, t: e.t };
      case 'n': return { k, id, n: e.n };
      default: return { k, id, v: e.v, t: e.t };
    }
  }
  function opsSince(doc, since) {
    const out = [];
    BUCKETS.forEach((b) => { for (const id in doc[b]) { const e = doc[b][id]; if ((e.seq || 0) > since) out.push(entryToOp(b, id, e)); } });
    if (doc.hc.t && doc.hc.seq > since) out.push({ k: 'hc', t: doc.hc.t });
    return out;
  }

  return { LIM, BUCKETS, SETTINGS, SETTING_KEYS, emptyDoc, fixDoc, get, own, clone, validateOp, applyOp, opsSince, entryToOp };
});
