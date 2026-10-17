// IGV-style canvas viewer for the core's SAM output: reads coloured by cluster (YC
// tag), strand or a deletion of 50 bp or more, mates optionally joined in one row,
// and the cut site and protospacer marked.

const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
                       '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const PALETTE_DARK  = ['#3987e5', '#d95926', '#199e70', '#c98500',
                       '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_LIGHT = '#898781';
const OTHER_DARK  = '#898781';

// A canvas past the browser's size limit (32,767 px a side; ~16.7 M px in all on
// iOS Safari) draws nothing, so rows are capped and whatever is left out is counted
// in a note.
const MAX_ROWS = 400;
const MAX_CANVAS_PX = 16e6;

// ---- parsing ----

export function parseSam(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line || line[0] === '@') continue;
    const f = line.split('\t');
    if (f.length < 11) continue;
    const cigar = parseCigar(f[5]);
    const pos = parseInt(f[3], 10);
    const rec = {
      name: f[0],
      flag: parseInt(f[1], 10),
      ref: f[2],
      pos,
      mapq: parseInt(f[4], 10),
      cigarText: f[5],
      cigar,
      tlen: parseInt(f[8], 10),
      seq: f[9],
      tags: parseTags(f.slice(11)),
    };
    layout(rec);
    out.push(rec);
  }
  return out;
}

function parseCigar(s) {
  const ops = [];
  if (!s || s === '*') return ops;
  const re = /(\d+)([MIDNSHP=X*])/g;
  let m;
  while ((m = re.exec(s)) !== null) ops.push({ len: parseInt(m[1], 10), op: m[2] });
  return ops;
}

function parseTags(fields) {
  const t = {};
  for (const raw of fields) {
    if (!raw) continue;
    const i = raw.indexOf(':');
    if (i < 0) continue;
    // SAM optional fields are TAG:TYPE:VALUE; keep only the value
    const parts = raw.split(':');
    if (parts.length < 3) { t[parts[0]] = parts.slice(1).join(':'); continue; }
    t[parts[0]] = parts.slice(2).join(':');
  }
  return t;
}

// Turn the CIGAR into matched blocks, deletions, insertions and soft clips in
// reference coordinates (1-based, from SAM POS; ends exclusive).
function layout(rec) {
  let ref = rec.pos, q = 0;
  rec.blocks = []; rec.dels = []; rec.ins = []; rec.clips = [];
  for (const { len, op } of rec.cigar) {
    switch (op) {
      case 'M': case '=': case 'X':
        rec.blocks.push({ start: ref, end: ref + len }); ref += len; q += len; break;
      case 'D': case 'N':
        rec.dels.push({ start: ref, end: ref + len, len }); ref += len; break;
      case 'I':
        rec.ins.push({ at: ref, len }); q += len; break;
      case 'S':
        rec.clips.push({ at: ref, len }); q += len; break;
      default: break;
    }
  }
  rec.refStart = rec.blocks.length ? rec.blocks[0].start : rec.pos;
  rec.refEnd = rec.blocks.length ? rec.blocks[rec.blocks.length - 1].end : rec.pos;
  rec.maxDel = rec.dels.reduce((a, d) => Math.max(a, d.len), 0);
  rec.reverse = (rec.flag & 16) !== 0;
  rec.first = (rec.flag & 64) !== 0;
}

// ---- cluster grouping ----

export function buildClusters(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = r.tags.YC || 'none';
    if (!byKey.has(key)) byKey.set(key, { key, records: [], starts: [], ends: [], sizes: [] });
    const c = byKey.get(key);
    c.records.push(r);
    c.starts.push(r.refStart);
    c.ends.push(r.refEnd);
    if (r.maxDel > 0) c.sizes.push(r.maxDel);
  }
  const list = [...byKey.values()];
  for (const c of list) {
    c.count = c.records.length;
    c.pairs = Math.round(c.count / 2);
    c.start = median(c.starts);
    c.end = median(c.ends);
    c.delSize = c.sizes.length ? median(c.sizes) : 0;
    // Not Math.min(...a): spreading a large array overflows the call stack.
    c.span = [c.starts.reduce((a, b) => Math.min(a, b), Infinity),
              c.ends.reduce((a, b) => Math.max(a, b), -Infinity)];
  }
  list.sort((a, b) => b.count - a.count);
  list.forEach((c, i) => { c.index = i; });
  const map = new Map(list.map((c) => [c.key, c]));
  for (const r of records) r.cluster = map.get(r.tags.YC || 'none');
  return list;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// ---- packing ----

// Group mates by read name (if viewPairs), then stack the items first-fit in at most
// maxRows rows, at least minGapBp apart. Items that don't fit get row -1 and are
// counted in `hidden`.
function packRows(records, viewPairs, minGapBp, maxRows) {
  let items;
  if (viewPairs) {
    const byName = new Map();
    for (const r of records) {
      if (!byName.has(r.name.replace(/\/[12]$/, ''))) byName.set(r.name.replace(/\/[12]$/, ''), []);
      byName.get(r.name.replace(/\/[12]$/, '')).push(r);
    }
    items = [...byName.values()].map((mates) => ({
      mates,
      start: Math.min(...mates.map((m) => m.refStart)),
      end: Math.max(...mates.map((m) => m.refEnd)),
      cluster: mates[0].cluster,
    }));
  } else {
    items = records.map((r) => ({ mates: [r], start: r.refStart, end: r.refEnd, cluster: r.cluster }));
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  const rowEnds = [];
  let hidden = 0;
  for (const it of items) {
    let row = 0;
    while (row < rowEnds.length && rowEnds[row] + minGapBp > it.start) row++;
    if (row >= maxRows) { it.row = -1; hidden++; continue; }
    rowEnds[row] = it.end;
    it.row = row;
  }
  return { items, rows: rowEnds.length, hidden };
}

// ---- viewer ----

export class AlignmentViewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.records = [];
    this.clusters = [];
    this.refLen = opts.refLen || 10000;
    this.cut = opts.cut || null;
    this.target = opts.target || null;
    this.viewStart = 0;
    this.viewEnd = this.refLen;
    this.viewPairs = true;
    this.colourBy = 'cluster';
    this.rowH = 11;
    this.readH = 8;
    this.topH = 46;
    this.dark = false;
    this.hover = null;
    this.onHover = opts.onHover || (() => {});
    this._bindEvents();
  }

  setData(records, refLen) {
    this.records = records;
    if (refLen) this.refLen = refLen;
    this.clusters = buildClusters(records);
    this.resetView();
    return this.clusters;
  }

  resetView() {
    if (this.records.length) {
      let lo = Infinity, hi = -Infinity;
      for (const r of this.records) { lo = Math.min(lo, r.refStart); hi = Math.max(hi, r.refEnd); }
      const pad = Math.max(120, (hi - lo) * 0.06);
      this.viewStart = Math.max(0, Math.floor(lo - pad));
      this.viewEnd = Math.min(this.refLen, Math.ceil(hi + pad));
    } else {
      this.viewStart = 0; this.viewEnd = this.refLen;
    }
    if (this.viewEnd - this.viewStart < 60) this.viewEnd = this.viewStart + 60;
    this.draw();
  }

  setTheme(dark) { this.dark = dark; this.draw(); }
  setViewPairs(v) { this.viewPairs = v; this.draw(); }
  setColourBy(v) { this.colourBy = v; this.draw(); }

  focusCluster(cluster) {
    const pad = Math.max(150, (cluster.span[1] - cluster.span[0]) * 0.1);
    this.viewStart = Math.max(0, Math.floor(cluster.span[0] - pad));
    this.viewEnd = Math.min(this.refLen, Math.ceil(cluster.span[1] + pad));
    this.draw();
  }

  // ---- coordinates, zoom and pan ----
  get width() { return this.canvas.clientWidth; }
  bpPerPx() { return (this.viewEnd - this.viewStart) / this.width; }
  x(bp) { return (bp - this.viewStart) / this.bpPerPx(); }
  bp(px) { return this.viewStart + px * this.bpPerPx(); }

  zoom(factor, anchorPx) {
    const anchorBp = this.bp(anchorPx ?? this.width / 2);
    const span = (this.viewEnd - this.viewStart) * factor;
    const clamped = Math.max(60, Math.min(this.refLen, span));
    const frac = (anchorBp - this.viewStart) / (this.viewEnd - this.viewStart);
    let s = anchorBp - clamped * frac;
    let e = s + clamped;
    if (s < 0) { s = 0; e = clamped; }
    if (e > this.refLen) { e = this.refLen; s = Math.max(0, e - clamped); }
    this.viewStart = s; this.viewEnd = e;
    this.draw();
  }

  panBp(delta) {
    const span = this.viewEnd - this.viewStart;
    let s = this.viewStart + delta;
    s = Math.max(0, Math.min(this.refLen - span, s));
    this.viewStart = s; this.viewEnd = s + span;
    this.draw();
  }

  // ---- events ----
  _bindEvents() {
    const c = this.canvas;
    let dragging = false, lastX = 0;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, e.clientX - r.left);
    }, { passive: false });
    c.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; c.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', () => { dragging = false; c.style.cursor = 'grab'; });
    c.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      if (dragging) {
        this.panBp(-(e.clientX - lastX) * this.bpPerPx());
        lastX = e.clientX;
        return;
      }
      const hit = this._hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit !== this.hover) { this.hover = hit; this.draw(); }
      this.onHover(hit, e);
    });
    c.addEventListener('mouseleave', () => {
      if (this.hover) { this.hover = null; this.draw(); }
      this.onHover(null);
    });
  }

  _hitTest(px, py) {
    if (!this._packed) return null;
    const row = Math.floor((py - this.topH) / this.rowH);
    if (row < 0) return null;
    for (const it of this._packed.items) {
      if (it.row !== row) continue;
      for (const m of it.mates) {
        if (px >= this.x(m.refStart) - 2 && px <= this.x(m.refEnd) + 2) return m;
      }
    }
    return null;
  }

  // ---- drawing ----
  colourFor(rec) {
    const pal = this.dark ? PALETTE_DARK : PALETTE_LIGHT;
    const other = this.dark ? OTHER_DARK : OTHER_LIGHT;
    if (this.colourBy === 'strand') return rec.reverse ? pal[1] : pal[0];
    if (this.colourBy === 'deletion') return rec.maxDel >= 50 ? pal[7] : other;
    const c = rec.cluster;
    if (!c) return other;
    return c.index < pal.length ? pal[c.index] : other;
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth;
    const fit = Math.floor((MAX_CANVAS_PX / Math.max(1, cssW * dpr) / dpr - this.topH - 16) / this.rowH);
    const packed = packRows(this.records, this.viewPairs, this.bpPerPx() * 4,
                            Math.max(10, Math.min(MAX_ROWS, fit)));
    this._packed = packed;
    // canvas height follows the packed rows, never below 130 px
    const cssH = Math.max(130, this.topH + packed.rows * this.rowH + 16);
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.style.height = cssH + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const th = this.dark
      ? { bg: '#1a1a19', grid: '#2c2c2a', axis: '#383835', text: '#c3c2b7', muted: '#898781',
          band: 'rgba(57,135,229,0.13)', cut: '#e66767', join: '#5a5954', gap: '#6d6c66' }
      : { bg: '#fcfcfb', grid: '#e1e0d9', axis: '#c3c2b7', text: '#52514e', muted: '#898781',
          band: 'rgba(42,120,214,0.11)', cut: '#d03b3b', join: '#c3c2b7', gap: '#a9a89f' };

    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    this._drawRuler(ctx, cssW, th);
    this._drawMarkers(ctx, cssW, cssH, th);

    // reads; a thin line joins the two mates of a pair across the gap between them
    const yTop = this.topH;
    for (const it of packed.items) {
      if (it.row < 0) continue;
      const y = yTop + it.row * this.rowH;
      if (this.viewPairs && it.mates.length === 2) {
        const a = Math.min(it.mates[0].refEnd, it.mates[1].refEnd);
        const b = Math.max(it.mates[0].refStart, it.mates[1].refStart);
        if (b > a) {
          ctx.strokeStyle = th.join;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(this.x(a), y + this.readH / 2);
          ctx.lineTo(this.x(b), y + this.readH / 2);
          ctx.stroke();
        }
      }
      for (const m of it.mates) this._drawRead(ctx, m, y, th);
    }
    ctx.strokeStyle = th.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, this.topH - 0.5); ctx.lineTo(cssW, this.topH - 0.5); ctx.stroke();

    if (packed.hidden) {
      const what = this.viewPairs ? 'pairs' : 'reads';
      ctx.fillStyle = th.muted;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`${packed.hidden.toLocaleString()} more ${what} stacked here are not drawn ` +
                   `(first ${packed.rows} rows shown); every record is in the SAM file.`, 6, cssH - 4);
    }
  }

  _drawRead(ctx, rec, y, th) {
    const h = this.readH;
    const isHover = this.hover === rec;
    const col = this.colourFor(rec);

    // deletions: a thin line, IGV style; 50 bp or more is thicker, in the cut colour,
    // with a size label when there is room
    for (const d of rec.dels) {
      const x1 = this.x(d.start), x2 = this.x(d.end);
      ctx.strokeStyle = d.len >= 50 ? th.cut : th.gap;
      ctx.lineWidth = d.len >= 50 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, y + h / 2); ctx.lineTo(x2, y + h / 2); ctx.stroke();
      if (d.len >= 50 && x2 - x1 > 34) {
        ctx.fillStyle = th.text;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const label = d.len >= 1000 ? (d.len / 1000).toFixed(1) + 'kb' : d.len + 'bp';
        const w = ctx.measureText(label).width + 6;
        ctx.fillStyle = th.bg;
        ctx.fillRect((x1 + x2) / 2 - w / 2, y - 1, w, h + 2);
        ctx.fillStyle = th.text;
        ctx.fillText(label, (x1 + x2) / 2, y + h - 1);
        ctx.textAlign = 'left';
      }
    }

    // aligned blocks
    ctx.fillStyle = col;
    for (const b of rec.blocks) {
      const x1 = this.x(b.start), x2 = this.x(b.end);
      const w = Math.max(1, x2 - x1);
      if (x2 < -20 || x1 > this.width + 20) continue;
      roundRect(ctx, x1, y, w, h, Math.min(3, w / 2));
      ctx.fill();
    }

    // insertions: a tick at the insertion point
    if (rec.ins.length) {
      ctx.fillStyle = this.dark ? '#9085e9' : '#4a3aa7';
      for (const i of rec.ins) {
        const x1 = this.x(i.at);
        ctx.fillRect(x1 - 1, y - 1, 2.5, h + 2);
      }
    }

    if (isHover) {
      ctx.strokeStyle = this.dark ? '#ffffff' : '#0b0b0b';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(this.x(rec.refStart) - 1.5, y - 1.5, this.x(rec.refEnd) - this.x(rec.refStart) + 3, h + 3);
    }
  }

  _drawRuler(ctx, w, th) {
    const span = this.viewEnd - this.viewStart;
    const step = niceStep(span / 8);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let p = Math.ceil(this.viewStart / step) * step; p <= this.viewEnd; p += step) {
      const x = this.x(p);
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, 26); ctx.lineTo(x + 0.5, this.canvas.clientHeight); ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(formatBp(p), x, 22);
    }
    ctx.textAlign = 'left';
  }

  _drawMarkers(ctx, w, h, th) {
    if (this.target) {
      const x1 = this.x(this.target[0]), x2 = this.x(this.target[1]);
      ctx.fillStyle = th.band;
      ctx.fillRect(x1, 26, Math.max(2, x2 - x1), h - 26);
      ctx.fillStyle = th.muted;
      ctx.font = '10px system-ui, sans-serif';
      if (x2 - x1 > 46) ctx.fillText('protospacer', x1 + 3, 36);
    }
    if (this.cut != null) {
      const x = this.x(this.cut);
      ctx.strokeStyle = th.cut;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, 26); ctx.lineTo(x + 0.5, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = th.cut;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('cut ' + formatBp(this.cut), x + 4, 36);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function formatBp(p) {
  const v = Math.round(p);
  return v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'kb' : String(v);
}

export const PALETTES = { light: PALETTE_LIGHT, dark: PALETTE_DARK, otherLight: OTHER_LIGHT, otherDark: OTHER_DARK };
