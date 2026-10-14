import { splitIdent, stem, identTerms } from './text.js';
import { formatTable } from './format.js';
import { estimateTokens } from './text.js';

const key = (name) => splitIdent(name).map(stem).join('_');
const META_COL = /^(id|created_?at|updated_?at|deleted_?at|created_?by|updated_?by|created_?on|modified_?(at|on)|version|row_?version|timestamp|is_?deleted|tenant_?id|sort_?order|position|concurrency_?stamp)$/i;

export function analyze(raw, source) {
  const tables = raw.tables.map((t) => ({ ...t, refs: [], referencedBy: [] }));
  const byName = new Map(tables.map((t) => [t.name, t]));
  const byKey = new Map();
  for (const t of tables) {
    const k = key(t.name.split('.').pop());
    if (!byKey.has(k)) byKey.set(k, t);
    const k2 = k.replace(/^(tbl|tb|t|app|core|dbo)_/, '');
    if (!byKey.has(k2)) byKey.set(k2, t);
  }
  const findTable = (name) => byName.get(name) ?? tables.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) ?? byKey.get(key(name));
  const pkOf = (t) => (t.pk.length === 1 ? t.pk[0] : t.columns.find((c) => /^id$/i.test(c.name))?.name ?? t.pk[0] ?? 'id');

  for (const t of tables) {
    for (const fk of t.fks) {
      const target = findTable(fk.refTable);
      fk.columns.forEach((col, i) => t.refs.push({ column: col, table: target?.name ?? fk.refTable, refColumn: fk.refColumns[i] ?? (target ? pkOf(target) : 'id'), inferred: false }));
    }
  }

  let inferredCount = 0;
  for (const t of tables) {
    const own = splitIdent(t.name.split('.').pop()).map(stem);
    for (const c of t.columns) {
      if (t.refs.some((r) => r.column === c.name)) continue;
      if (t.pk.length === 1 && t.pk[0] === c.name) continue;
      const m = /^(?:fk_?)?(.+?)_?(id|uuid|guid|code|no)$/i.exec(c.name) ?? /^fk_?(.+)$/i.exec(c.name);
      if (!m || /^(id|uuid|guid)$/i.test(c.name)) continue;
      const suffix = (m[2] ?? 'id').toLowerCase();
      const words = splitIdent(m[1]).map(stem);
      if (!words.length) continue;
      const cands = [];
      for (let i = 0; i < words.length; i++) cands.push(words.slice(i).join('_'));
      for (let j = own.length - 1; j > 0; j--) cands.push([...own.slice(0, j), ...words].join('_'));
      let target = null;
      for (const cand of cands) { target = byKey.get(cand); if (target) break; }
      if (!target) {
        const base = words.join('_');
        const hits = [...byKey.entries()].filter(([k]) => k.endsWith('_' + base) && k.startsWith(own[0] + '_')).map(([, v]) => v);
        if (new Set(hits).size === 1) target = hits[0];
      }
      if (!target) continue;
      if (suffix !== 'id' && suffix !== 'uuid' && suffix !== 'guid') {
        const tc = target.columns.find((x) => x.name.toLowerCase() === 'code' || x.name.toLowerCase() === suffix);
        if (!tc) continue;
        t.refs.push({ column: c.name, table: target.name, refColumn: tc.name, inferred: true });
      } else {
        t.refs.push({ column: c.name, table: target.name, refColumn: pkOf(target), inferred: true });
      }
      inferredCount++;
    }
  }

  for (const t of tables) for (const r of t.refs) {
    const target = byName.get(r.table);
    if (target) target.referencedBy.push({ table: t.name, column: r.column, refColumn: r.refColumn, inferred: r.inferred });
  }

  for (const t of tables) {
    const out = new Set(t.refs.map((r) => r.table).filter((n) => n !== t.name));
    const inc = new Set(t.referencedBy.map((r) => r.table).filter((n) => n !== t.name));
    t.outDegree = out.size; t.inDegree = inc.size;
    t.neighbors = [...new Set([...out, ...inc])];
    t.importance = +(t.inDegree * 2 + t.outDegree + Math.log10((t.rows ?? 0) + 1) + t.columns.length / 15).toFixed(2);
    t.role = classify(t);
    t.terms = [...new Set(identTerms(t.name.split('.').pop()))];
  }

  const modules = detectModules(tables, byName);
  const purpose = inferPurpose(tables, modules);

  const relations = [];
  for (const t of tables) for (const r of t.refs) relations.push({ from: t.name, fromCol: r.column, to: r.table, toCol: r.refColumn, inferred: r.inferred });

  const fullSchema = tables.map((t) => formatTable(t, 'full')).join('\n');
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    dialect: raw.dialect,
    database: raw.database,
    source,
    stats: {
      tables: tables.length,
      columns: tables.reduce((a, t) => a + t.columns.length, 0),
      relations: relations.length,
      inferredRelations: inferredCount,
      rows: tables.reduce((a, t) => a + (t.rows ?? 0), 0),
    },
    fullSchemaTokens: estimateTokens(fullSchema),
    tables: tables.map(({ fks, ...t }) => t),
    relations,
    modules,
    purpose,
  };
}

function classify(t) {
  const n = t.name.toLowerCase();
  if (t.kind === 'view') return 'view';
  if (/migration|schema_version|flyway|liquibase|knex_|sequelizemeta|idempotency|outbox|inbox|job_?lease|joblease|^locks?$|queue|^cache|^(user_|auth_|django_)?sessions?$|refresh_?tokens?|personal_access_tokens|password_resets|failed_jobs|^jobs$/.test(n)) return 'system';
  if (/log|audit|histor|events?$|ledger|movement|tracking|attempt|notification/.test(n)) return 'log';
  const fkCols = new Set(t.refs.map((r) => r.column));
  const payload = t.columns.filter((c) => !fkCols.has(c.name) && !META_COL.test(c.name) && !t.pk.includes(c.name));
  const detailName = /line|item|detail|option|setting|config|rule|tier/.test(n);
  if (fkCols.size >= 2 && payload.length <= 1 && t.outDegree >= 2 && !detailName) return 'junction';
  const LOOKUP_COLS = /^(id|code|key|name|title|label|description|value|sort_?order|display_?order|is_?active|color|icon)$/i;
  if (t.outDegree === 0 && t.columns.length <= 6 && (/types?$|status(es)?$|reasons?$|kinds?$|codes?$|lookup|enum|currenc|countr|cit(y|ies)$|languages?$|units?$/.test(n)
    || (t.inDegree > 0 && t.columns.every((c) => LOOKUP_COLS.test(c.name))))) return 'lookup';
  if (t.inDegree >= 3) return 'core';
  if (t.outDegree >= 1 && detailName) return 'detail';
  return 'entity';
}

function detectModules(tables, byName) {
  const n = tables.length;
  const deg = (t) => t.neighbors.length;
  const hubCut = Math.max(8, Math.ceil(n * 0.12));
  const hubs = new Set(tables.filter((t) => deg(t) >= hubCut).map((t) => t.name));
  const skip = (t) => t.role === 'system' && deg(t) === 0;

  const W = new Map(tables.map((t) => [t.name, new Map()]));
  const link = (a, b, w) => { if (a === b) return; W.get(a).set(b, (W.get(a).get(b) ?? 0) + w); W.get(b).set(a, (W.get(b).get(a) ?? 0) + w); };
  for (const t of tables) for (const r of t.refs) if (byName.has(r.table)) link(t.name, r.table, hubs.has(r.table) || hubs.has(t.name) ? 0.25 : 1);
  const first = new Map();
  for (const t of tables) { const w = t.terms[0]; if (w) { if (!first.has(w)) first.set(w, []); first.get(w).push(t.name); } }
  for (const [, group] of first) if (group.length >= 2 && group.length <= n / 3) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) link(group[i], group[j], 0.8);

  const label = new Map(tables.map((t) => [t.name, t.name]));
  const order = [...tables].sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));
  for (let iter = 0; iter < 30; iter++) {
    let changed = 0;
    for (const t of order) {
      if (skip(t)) continue;
      const score = new Map();
      for (const [nb, w] of W.get(t.name)) score.set(label.get(nb), (score.get(label.get(nb)) ?? 0) + w);
      if (!score.size) continue;
      const own = score.get(label.get(t.name)) ?? 0;
      let best = label.get(t.name), bw = own;
      for (const [l, w] of score) if (w > bw + 1e-9 || (Math.abs(w - bw) < 1e-9 && l < best)) { best = l; bw = w; }
      if (best !== label.get(t.name)) { label.set(t.name, best); changed++; }
    }
    if (!changed) break;
  }

  const groups = new Map();
  for (const t of tables) { const l = label.get(t.name); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(t); }
  for (const [l, members] of [...groups]) {
    if (members.length > 1) continue;
    const t = members[0];
    let best = null, bw = 0;
    for (const [nb, w] of W.get(t.name)) if (w > bw && groups.get(label.get(nb))?.length > 1) { best = label.get(nb); bw = w; }
    groups.delete(l);
    const target = best ?? (t.role === 'system' ? '__system' : '__misc');
    label.set(t.name, target);
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(t);
  }

  const modules = [];
  let i = 0;
  for (const [l, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    members.sort((a, b) => b.importance - a.importance);
    const counts = new Map();
    for (const t of members) for (const w of t.terms.slice(0, 1)) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    const name = l === '__system' ? 'System' : l === '__misc' ? 'Misc' : top && top[1] >= Math.max(2, members.length * 0.3) ? cap(top[0]) : members[0].name.split('.').pop();
    const id = `m${i++}`;
    for (const t of members) t.module = id;
    modules.push({ id, name, tables: members.map((t) => t.name), anchor: members[0].name });
  }
  const seen = new Map();
  for (const m of modules) { const c = seen.get(m.name) ?? 0; seen.set(m.name, c + 1); if (c) m.name = `${m.name} (${m.anchor})`; }
  return modules;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const DOMAINS = {
  'E-ticaret': ['product', 'order', 'cart', 'basket', 'category', 'checkout', 'coupon', 'shipment', 'shipping', 'wishlist', 'variant', 'sku', 'review', 'inventory', 'stock'],
  'Lojistik': ['delivery', 'route', 'shipment', 'vehicle', 'driver', 'warehouse', 'tracking', 'zone', 'location', 'parcel', 'cargo'],
  'Ulaşım / Biletleme': ['ticket', 'trip', 'seat', 'bus', 'route', 'station', 'journey', 'passenger', 'vehicle', 'schedule', 'fare', 'stop'],
  'Rezervasyon / Konaklama': ['reservation', 'booking', 'room', 'hotel', 'guest', 'availability', 'appointment', 'slot', 'calendar'],
  'Finans / Muhasebe': ['account', 'transaction', 'ledger', 'invoice', 'payment', 'balance', 'tax', 'journal', 'wallet', 'currency', 'settlement', 'cash'],
  'POS / Perakende': ['pos', 'terminal', 'receipt', 'cash', 'register', 'shift', 'device', 'printer', 'session', 'stock'],
  'Sadakat / Pazarlama': ['loyalty', 'campaign', 'coupon', 'reward', 'point', 'promotion', 'tier', 'banner', 'push', 'segment'],
  'CRM': ['customer', 'contact', 'lead', 'deal', 'opportunity', 'company', 'note', 'activity', 'call', 'pipeline'],
  'İK / Personel': ['employee', 'staff', 'attendance', 'shift', 'payroll', 'salary', 'leave', 'department', 'position'],
  'İçerik / Blog / CMS': ['post', 'article', 'page', 'comment', 'tag', 'media', 'author', 'content', 'menu', 'slug'],
  'Sosyal / Mesajlaşma': ['message', 'channel', 'friend', 'follow', 'like', 'conversation', 'chat', 'guild', 'member', 'reaction', 'server'],
  'Eğitim': ['course', 'lesson', 'student', 'teacher', 'exam', 'grade', 'enrollment', 'class', 'quiz'],
  'Sağlık': ['patient', 'doctor', 'appointment', 'prescription', 'diagnosis', 'clinic', 'treatment'],
  'Oyun': ['game', 'player', 'score', 'level', 'match', 'leaderboard', 'achievement'],
  'SaaS / Çok kiracılı': ['tenant', 'plan', 'subscription', 'organization', 'workspace', 'feature', 'billing'],
  'Kimlik / Yetki': ['user', 'role', 'permission', 'token', 'session', 'login', 'password', 'claim'],
  'Stok / Tedarik': ['stock', 'warehouse', 'supplier', 'purchase', 'inventory', 'transfer', 'count'],
};

function inferPurpose(tables, modules) {
  const scores = [];
  const domainTerms = Object.entries(DOMAINS).map(([d, ws]) => [d, new Set(ws.map(stem))]);
  for (const [domain, set] of domainTerms) {
    let s = 0; const ev = new Set();
    for (const t of tables) {
      if (t.role === 'system') continue;
      const hits = t.terms.filter((w) => set.has(w));
      if (hits.length) { s += (1 + Math.min(t.importance, 12) / 4) * (hits.length > 1 ? 1.3 : 1); ev.add(t.name); }
    }
    if (s) scores.push({ name: domain, score: s, evidence: [...ev].slice(0, 6), coverage: ev.size });
  }
  scores.sort((a, b) => b.score - a.score);
  const total = scores.reduce((a, d) => a + d.score, 0) || 1;
  const domains = scores.slice(0, 5).map((d) => ({ ...d, confidence: +(d.score / total).toFixed(2), score: +d.score.toFixed(1) }));
  const core = [...tables].filter((t) => t.role !== 'system' && t.role !== 'log').sort((a, b) => b.importance - a.importance).slice(0, 8).map((t) => t.name);
  const mods = modules.filter((m) => m.name !== 'Misc' && m.name !== 'System').slice(0, 8).map((m) => `${m.name} (${m.tables.length})`);
  const main = domains[0]?.name ?? 'Genel amaçlı uygulama';
  const secondary = domains.slice(1, 3).filter((d) => d.confidence >= 0.12).map((d) => d.name);
  const summary =
    `${tables.length} tablolu şema büyük olasılıkla bir **${main}** sistemi` +
    (secondary.length ? `; ayrıca ${secondary.join(' ve ')} yetenekleri içeriyor` : '') + '. ' +
    `Çekirdek varlıklar: ${core.slice(0, 6).join(', ')}. ` +
    (mods.length ? `Modüller: ${mods.join(', ')}.` : '');
  return { domains, core, summary, auto: true };
}
