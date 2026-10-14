const NS = 'http://www.w3.org/2000/svg';
const W = 252, HEAD = 36, ROW = 20, FOOT = 22, GAP = 30, MPAD = 28, MLABEL = 40;

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const SHORT = [[/char|text|string|citext|clob/i, 'str'], [/bigint|bigserial|int8|long/i, 'bigint'], [/int|serial/i, 'int'], [/timestamp|datetime/i, 'ts'], [/^date$/i, 'date'], [/bool|^bit$/i, 'bool'], [/numeric|decimal|money/i, 'dec'], [/real|float|double|number/i, 'num'], [/uuid|uniqueidentifier|guid/i, 'uuid'], [/json/i, 'json']];
const shortType = (t) => { const s = String(t ?? ''); for (const [re, o] of SHORT) if (re.test(s)) return o; return s.toLowerCase().replace(/\(.*\)/, '').slice(0, 10); };

export class ERView {
  constructor(root, minimap) {
    this.root = root;
    this.mini = minimap;
    this.svg = el('svg', { class: 'ersvg' });
    root.appendChild(this.svg);
    const defs = el('defs', {}, this.svg);
    const small = el('pattern', { id: 'gridS', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M24 0H0V24', fill: 'none', stroke: '#101b2b', 'stroke-width': 1 }, small);
    const big = el('pattern', { id: 'grid', width: 120, height: 120, patternUnits: 'userSpaceOnUse' }, defs);
    el('rect', { width: 120, height: 120, fill: 'url(#gridS)' }, big);
    el('path', { d: 'M120 0H0V120', fill: 'none', stroke: '#16243a', 'stroke-width': 1.2 }, big);
    const glow = el('filter', { id: 'glow', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
    el('feGaussianBlur', { stdDeviation: 6, result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
    for (const [id, color] of [['arr', '#4f6688'], ['arrHl', '#22d3ee']]) {
      const m = el('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      el('path', { d: 'M0 1 L9 5 L0 9 z', fill: color }, m);
      const c = el('marker', { id: id + 'S', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 5, markerHeight: 5 }, defs);
      el('circle', { cx: 5, cy: 5, r: 3.4, fill: 'none', stroke: color, 'stroke-width': 2 }, c);
    }
    this.vp = el('g', {}, this.svg);
    el('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: 'url(#grid)' }, this.vp);
    this.gZones = el('g', {}, this.vp);
    this.gEdges = el('g', {}, this.vp);
    this.gCards = el('g', {}, this.vp);
    this.view = { x: 40, y: 60, k: 0.6 };
    this.cards = new Map();
    this.pos = new Map();
    this.expanded = new Set();
    this.hl = null;
    this.onSelect = () => {};
    this.bindEvents();
    new ResizeObserver(() => this.drawMinimap()).observe(root);
  }

  setModel(model, opts) {
    const same = this.model?.generatedAt === model.generatedAt;
    this.model = model;
    this.opts = opts;
    if (!same) { this.pos.clear(); this.expanded.clear(); }
    this.render(!same);
  }

  setOptions(opts) { this.opts = { ...this.opts, ...opts }; this.render(false); }

  visibleTables() {
    const { hideSystem } = this.opts;
    return this.model.tables.filter((t) => !hideSystem || !['system', 'log'].includes(t.role));
  }

  cardRows(t) {
    const refBy = new Map((t.refs ?? []).map((r) => [r.column, r]));
    const expanded = this.opts.expandAll || this.expanded.has(t.name);
    let rows = expanded ? t.columns : t.columns.filter((c) => c.pk || refBy.has(c.name));
    if (!rows.length) rows = t.columns.slice(0, 4);
    return { rows, refBy, expanded, hidden: t.columns.length - rows.length };
  }

  cardHeight(t) {
    const { rows, hidden, expanded } = this.cardRows(t);
    return HEAD + rows.length * ROW + (hidden || (expanded && t.columns.length > 4) ? FOOT : 8);
  }

  layout(tables) {
    const visible = new Set(tables.map((t) => t.name));
    const byName = new Map(tables.map((t) => [t.name, t]));
    const boxes = [];
    for (const mod of this.model.modules) {
      const ts = mod.tables.filter((n) => visible.has(n)).map((n) => byName.get(n)).sort((a, b) => b.importance - a.importance);
      if (!ts.length) continue;
      const cols = Math.max(1, Math.min(4, Math.round(Math.sqrt(ts.length / 1.3))));
      const colH = new Array(cols).fill(0);
      const place = [];
      for (const t of ts) {
        const c = colH.indexOf(Math.min(...colH));
        place.push({ t, cx: c, cy: colH[c] });
        colH[c] += this.cardHeight(t) + GAP;
      }
      boxes.push({ mod, place, w: cols * (W + GAP) - GAP + MPAD * 2, h: Math.max(...colH) - GAP + MPAD * 2 + MLABEL });
    }
    const area = boxes.reduce((a, b) => a + (b.w + 90) * (b.h + 90), 0);
    const maxW = Math.max(Math.sqrt(area) * 1.7, ...boxes.map((b) => b.w));
    let x = 0, y = 0, rowH = 0;
    for (const b of boxes.sort((p, q) => q.h * q.w - p.h * p.w)) {
      if (x > 0 && x + b.w > maxW) { x = 0; y += rowH + 90; rowH = 0; }
      for (const p of b.place) if (!this.pos.has(p.t.name)) this.pos.set(p.t.name, { x: x + MPAD + p.cx * (W + GAP), y: y + MLABEL + MPAD + p.cy });
      x += b.w + 90;
      rowH = Math.max(rowH, b.h);
    }
  }

  render(refit) {
    const tables = this.visibleTables();
    this.layout(tables);
    this.gCards.replaceChildren();
    this.gEdges.replaceChildren();
    this.gZones.replaceChildren();
    this.cards.clear();
    for (const t of tables) this.drawCard(t);
    this.drawZones();
    this.drawEdges();
    this.applyHighlight();
    if (refit) this.fit(null, false);
    else this.applyView();
  }

  drawCard(t) {
    const color = this.opts.colors.get(t.module) ?? '#4f6688';
    const p = this.pos.get(t.name);
    const { rows, refBy, expanded, hidden } = this.cardRows(t);
    const h = this.cardHeight(t);
    const g = el('g', { class: `card role-${t.role}`, transform: `translate(${p.x},${p.y})`, 'data-t': t.name }, this.gCards);
    el('rect', { class: 'card-glow', x: -3, y: -3, width: W + 6, height: h + 6, rx: 11 }, g);
    el('rect', { class: 'card-bg', width: W, height: h, rx: 8 }, g);
    const head = el('g', { class: 'card-head' }, g);
    el('rect', { class: 'card-headbg', width: W, height: HEAD, rx: 8 }, head);
    el('rect', { width: W, height: 3, rx: 1.5, fill: color, class: 'card-strip' }, head);
    el('circle', { cx: 14, cy: HEAD / 2 + 1, r: 3.5, fill: color, class: 'card-dot' }, head);
    el('text', { class: 'card-title', x: 25, y: HEAD / 2 + 5 }, head).textContent = trunc(t.name, 24);
    const meta = [t.role !== 'entity' ? t.role : null, t.rows != null ? fmtRows(t.rows) : null].filter(Boolean).join(' · ');
    el('text', { class: 'card-meta', x: W - 10, y: HEAD / 2 + 5, 'text-anchor': 'end' }, head).textContent = meta;
    const bigSize = Math.min(30, (W - 24) / (t.name.length * 0.62));
    el('text', { class: 'card-big', x: W / 2, y: h / 2 + bigSize / 3, 'text-anchor': 'middle', 'font-size': bigSize.toFixed(1), fill: color }, g).textContent = t.name;
    const title = el('title', {}, g);
    title.textContent = `${t.name}${t.description ? ' — ' + t.description : ''}`;
    const rowsY = new Map();
    rows.forEach((c, i) => {
      const y = HEAD + i * ROW;
      const r = refBy.get(c.name);
      const row = el('g', { class: `row${c.pk ? ' pk' : ''}${r ? ' fk' : ''}`, transform: `translate(0,${y})` }, g);
      el('rect', { class: 'row-bg', width: W, height: ROW }, row);
      if (c.pk || r) el('text', { class: `row-badge ${c.pk ? 'pk' : 'fk'}`, x: 10, y: 14 }, row).textContent = c.pk ? 'PK' : 'FK';
      el('text', { class: 'row-name', x: 34, y: 14 }, row).textContent = trunc(c.name, r ? 17 : 22);
      const right = r ? `→ ${trunc(r.table, 13)}` : shortType(c.type);
      el('text', { class: `row-type${r ? ' ref' : ''}${r?.inferred ? ' inf' : ''}`, x: W - 10, y: 14, 'text-anchor': 'end' }, row).textContent = right;
      rowsY.set(c.name, y + ROW / 2);
    });
    if (hidden || (expanded && t.columns.length > 4)) {
      const f = el('g', { class: 'card-foot', transform: `translate(0,${HEAD + rows.length * ROW})` }, g);
      el('rect', { width: W, height: FOOT, class: 'foot-bg' }, f);
      el('text', { x: W / 2, y: 15, 'text-anchor': 'middle' }, f).textContent = expanded ? '▴ daralt' : `▾ +${hidden} kolon`;
    }
    this.cards.set(t.name, { t, g, h, rowsY, color });
  }

  drawZones() {
    for (const mod of this.model.modules) {
      const cs = mod.tables.map((n) => this.cards.get(n)).filter(Boolean);
      if (!cs.length) continue;
      const box = this.bbox(cs);
      const color = this.opts.colors.get(mod.id);
      const g = el('g', { class: 'zone', 'data-m': mod.id }, this.gZones);
      el('rect', { x: box.x - MPAD, y: box.y - MPAD - MLABEL + 6, width: box.w + MPAD * 2, height: box.h + MPAD * 2 + MLABEL - 6, rx: 14, fill: color, 'fill-opacity': 0.035, stroke: color, 'stroke-opacity': 0.28, 'stroke-dasharray': '2 6' }, g);
      const label = el('text', { class: 'zone-label', x: box.x - MPAD + 16, y: box.y - MPAD - MLABEL + 34, fill: color }, g);
      label.textContent = `${(mod.label ?? mod.name).toUpperCase()}  ·  ${cs.length}`;
    }
  }

  drawEdges() {
    this.edges = [];
    const { showInferred, showHubs } = this.opts;
    const inDeg = new Map();
    for (const r of this.model.relations) inDeg.set(r.to, (inDeg.get(r.to) ?? 0) + 1);
    const hubCut = Math.max(8, this.model.tables.length * 0.2);
    const seen = new Set();
    for (const r of this.model.relations) {
      if (!this.cards.has(r.from) || !this.cards.has(r.to)) continue;
      if (r.inferred && !showInferred) continue;
      const hub = (inDeg.get(r.to) ?? 0) > hubCut;
      if (hub && !showHubs) continue;
      const key = `${r.from}.${r.fromCol}>${r.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const color = this.cards.get(r.from).color;
      const path = el('path', { class: `edge${r.inferred ? ' inferred' : ''}${hub ? ' hub' : ''}`, stroke: color, 'marker-end': 'url(#arr)', 'marker-start': 'url(#arrS)' }, this.gEdges);
      el('title', {}, path).textContent = `${r.from}.${r.fromCol} → ${r.to}.${r.toCol}${r.inferred ? ' (isimden çıkarıldı)' : ''}`;
      const e = { r, path };
      this.edges.push(e);
      this.routeEdge(e);
    }
  }

  routeEdge({ r, path }) {
    const a = this.cards.get(r.from), b = this.cards.get(r.to);
    const pa = this.pos.get(r.from), pb = this.pos.get(r.to);
    const y1 = pa.y + (a.rowsY.get(r.fromCol) ?? HEAD / 2);
    const y2 = pb.y + (b.rowsY.get(r.toCol) ?? HEAD / 2);
    let d;
    if (r.from === r.to) {
      const x = pa.x + W;
      d = `M${x},${y1} C${x + 50},${y1} ${x + 50},${y2} ${x},${y2}`;
    } else {
      const ax = pa.x + W / 2, bx = pb.x + W / 2;
      let x1, x2, d1, d2;
      if (Math.abs(ax - bx) < W * 0.7) { x1 = pa.x + W; x2 = pb.x + W; d1 = 1; d2 = 1; }
      else if (bx > ax) { x1 = pa.x + W; x2 = pb.x; d1 = 1; d2 = -1; }
      else { x1 = pa.x; x2 = pb.x + W; d1 = -1; d2 = 1; }
      const c = d1 === d2 ? 50 + Math.min(Math.abs(y2 - y1) * 0.18, 120) : Math.max(40, Math.min(170, Math.abs(x2 - x1) / 2));
      d = `M${x1},${y1} C${x1 + d1 * c},${y1} ${x2 + d2 * c},${y2} ${x2},${y2}`;
    }
    path.setAttribute('d', d);
  }

  highlight(sets, { fit = true } = {}) {
    this.hl = { primary: new Set(sets.primary ?? []), neighbor: new Set(sets.neighbor ?? []), reused: new Set(sets.reused ?? []) };
    this.applyHighlight();
    if (fit) {
      const names = [...this.hl.primary, ...this.hl.neighbor, ...this.hl.reused].filter((n) => this.cards.has(n));
      if (names.length) this.fit(names);
    }
  }

  clearHighlight() { this.hl = null; this.applyHighlight(); }

  applyHighlight() {
    const hl = this.hl;
    const any = hl && (hl.primary.size || hl.neighbor.size || hl.reused.size);
    this.svg.classList.toggle('has-hl', !!any);
    for (const [name, c] of this.cards) {
      const cls = c.g.classList;
      cls.remove('hl-primary', 'hl-neighbor', 'hl-reused', 'dim');
      if (!any) continue;
      if (hl.primary.has(name)) cls.add('hl-primary');
      else if (hl.neighbor.has(name)) cls.add('hl-neighbor');
      else if (hl.reused.has(name)) cls.add('hl-reused');
      else cls.add('dim');
    }
    const on = (n) => any && (hl.primary.has(n) || hl.neighbor.has(n) || hl.reused.has(n));
    for (const e of this.edges ?? []) {
      const lit = on(e.r.from) && on(e.r.to);
      e.path.classList.toggle('hl', !!lit);
      e.path.setAttribute('marker-end', lit ? 'url(#arrHl)' : 'url(#arr)');
      e.path.setAttribute('marker-start', lit ? 'url(#arrHlS)' : 'url(#arrS)');
      if (lit) this.gEdges.appendChild(e.path);
    }
    for (const z of this.gZones.children) {
      const mod = this.model.modules.find((m) => m.id === z.dataset.m);
      z.classList.toggle('dim', !!any && !mod?.tables.some(on));
    }
    this.drawMinimap();
  }

  select(name) {
    for (const [n, c] of this.cards) c.g.classList.toggle('selected', n === name);
  }

  focus(name) {
    const c = this.cards.get(name);
    if (!c) return;
    this.fit([name], true, 1.1);
    this.select(name);
  }

  toggleExpand(name) {
    this.expanded.has(name) ? this.expanded.delete(name) : this.expanded.add(name);
    this.render(false);
    this.cards.get(name)?.g.parentNode.appendChild(this.cards.get(name).g);
  }

  bbox(cards) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cards) {
      const p = this.pos.get(c.t.name);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + W); y1 = Math.max(y1, p.y + c.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  worldBox() {
    const b = this.bbox([...this.cards.values()]);
    return { x: b.x - 80, y: b.y - 90, w: b.w + 160, h: b.h + 170 };
  }

  fit(names, animate = true, maxK = 1.2) {
    if (!this.cards.size) return;
    const cs = names ? names.map((n) => this.cards.get(n)).filter(Boolean) : [...this.cards.values()];
    const b = names ? this.bbox(cs) : this.worldBox();
    const inset = this.insetRight ?? 0;
    const vw = (this.svg.clientWidth || 800) - inset, vh = this.svg.clientHeight || 600;
    const pad = names ? 120 : 20;
    const k = Math.min(maxK, (vw - pad * 2) / b.w, (vh - pad * 2 - 40) / b.h);
    const target = { k, x: (vw - b.w * k) / 2 - b.x * k, y: (vh - b.h * k) / 2 - b.y * k + 20 };
    animate ? this.animateTo(target) : (this.view = target, this.applyView());
  }

  animateTo(target, ms = 420) {
    const from = { ...this.view };
    const t0 = performance.now();
    cancelAnimationFrame(this.anim);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      this.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      this.applyView();
      if (p < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  zoomAt(cx, cy, f) {
    const r = this.svg.getBoundingClientRect();
    const k = Math.max(0.06, Math.min(2.5, this.view.k * f));
    const px = cx - r.left, py = cy - r.top;
    this.view = { k, x: px - ((px - this.view.x) * k) / this.view.k, y: py - ((py - this.view.y) * k) / this.view.k };
    this.applyView();
  }

  zoomBy(f) {
    const r = this.svg.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const k = Math.max(0.06, Math.min(2.5, this.view.k * f));
    const px = c.x - r.left, py = c.y - r.top;
    this.animateTo({ k, x: px - ((px - this.view.x) * k) / this.view.k, y: py - ((py - this.view.y) * k) / this.view.k }, 220);
  }

  applyView() {
    const { x, y, k } = this.view;
    this.vp.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    this.svg.classList.toggle('lod1', k < 0.55);
    this.svg.classList.toggle('lod2', k < 0.3);
    this.drawMinimap();
  }

  drawMinimap() {
    if (!this.mini || !this.cards.size) return;
    cancelAnimationFrame(this.miniRaf);
    this.miniRaf = requestAnimationFrame(() => {
      const cv = this.mini, ctx = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const cw = 220, ch = 150;
      if (cv.width !== cw * dpr) { cv.width = cw * dpr; cv.height = ch * dpr; cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const b = this.worldBox();
      const s = Math.min((cw - 12) / b.w, (ch - 12) / b.h);
      const ox = (cw - b.w * s) / 2 - b.x * s, oy = (ch - b.h * s) / 2 - b.y * s;
      this.miniMap = { s, ox, oy };
      const any = this.svg.classList.contains('has-hl');
      for (const [name, c] of this.cards) {
        const p = this.pos.get(name);
        const lit = c.g.classList.contains('hl-primary') || c.g.classList.contains('hl-neighbor') || c.g.classList.contains('hl-reused');
        ctx.globalAlpha = any && !lit ? 0.18 : 0.9;
        ctx.fillStyle = c.g.classList.contains('hl-primary') ? '#22d3ee' : c.g.classList.contains('hl-neighbor') ? '#a78bfa' : c.color;
        ctx.fillRect(ox + p.x * s, oy + p.y * s, Math.max(1.5, W * s), Math.max(1.5, c.h * s));
      }
      ctx.globalAlpha = 1;
      const vw = this.svg.clientWidth, vh = this.svg.clientHeight;
      const k = this.view.k;
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(ox + (-this.view.x / k) * s, oy + (-this.view.y / k) * s, (vw / k) * s, (vh / k) * s);
    });
  }

  bindEvents() {
    const svg = this.svg;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5 && !e.shiftKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView(); }
    }, { passive: false });

    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const cardEl = e.target.closest('.card');
      const foot = e.target.closest('.card-foot');
      drag = { sx: e.clientX, sy: e.clientY, moved: false, card: cardEl?.dataset.t, foot: !!foot, head: !!e.target.closest('.card-head'), vx: this.view.x, vy: this.view.y };
      if (drag.card) drag.p0 = { ...this.pos.get(drag.card) };
      svg.setPointerCapture(e.pointerId);
      if (!drag.card || !drag.head) svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.card && drag.head) {
        const p = { x: drag.p0.x + dx / this.view.k, y: drag.p0.y + dy / this.view.k };
        this.pos.set(drag.card, p);
        const c = this.cards.get(drag.card);
        c.g.setAttribute('transform', `translate(${p.x},${p.y})`);
        c.g.parentNode.appendChild(c.g);
        for (const ed of this.edges) if (ed.r.from === drag.card || ed.r.to === drag.card) this.routeEdge(ed);
      } else {
        this.view.x = drag.vx + dx;
        this.view.y = drag.vy + dy;
        this.applyView();
      }
    });
    const end = () => {
      if (!drag) return;
      svg.classList.remove('panning');
      if (drag.card && drag.head && drag.moved) { this.gZones.replaceChildren(); this.drawZones(); this.applyHighlight(); }
      if (!drag.moved) {
        if (drag.foot) this.toggleExpand(drag.card);
        else if (drag.card) { this.select(drag.card); this.onSelect(drag.card); }
        else this.onBackground?.();
      }
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', (e) => { const c = e.target.closest('.card'); if (c) this.toggleExpand(c.dataset.t); });

    if (this.mini) {
      const go = (e) => {
        if (!this.miniMap) return;
        const r = this.mini.getBoundingClientRect();
        const { s, ox, oy } = this.miniMap;
        const wx = (e.clientX - r.left - ox) / s, wy = (e.clientY - r.top - oy) / s;
        this.view.x = this.svg.clientWidth / 2 - wx * this.view.k;
        this.view.y = this.svg.clientHeight / 2 - wy * this.view.k;
        this.applyView();
      };
      let down = false;
      this.mini.addEventListener('pointerdown', (e) => { down = true; this.mini.setPointerCapture(e.pointerId); go(e); });
      this.mini.addEventListener('pointermove', (e) => down && go(e));
      this.mini.addEventListener('pointerup', () => (down = false));
    }
  }
}

function fmtRows(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
