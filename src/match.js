import { promptTerms, identTerms, fold, stem, estimateTokens } from './text.js';
import { formatTable, LEGEND } from './format.js';
import { sig } from './session.js';

const GENERIC = new Set(['order', 'sort', 'type', 'status', 'state', 'item', 'group', 'event', 'log', 'session', 'setting', 'key', 'value', 'table', 'list', 'page', 'view', 'option', 'filter', 'count', 'note', 'code', 'name', 'time', 'date', 'job', 'task', 'message', 'file', 'image', 'config', 'rule', 'target', 'template']);
const DB_INTENT = /\b(tablo|tablosu|kolon|sutun|alan|sorgu|query|sql|join|index|migration|migrasyon|sema|schema|veri ?taban|database|db|kayit|rapor|report|endpoint|api|repository|entity|model|crud|insert|update|delete|select|foreign|iliski|relation)\w*/;

function tableIndex(model, knowledge) {
  if (model.__index) return model.__index;
  const idx = model.tables.map((t) => {
    const nameTerms = new Set(t.terms ?? identTerms(t.name));
    const aliasTerms = new Set((t.aliases ?? knowledge?.tables?.[t.name]?.aliases ?? []).flatMap((a) => [stem(fold(a)), ...identTerms(a)]));
    const colTerms = new Map();
    for (const c of t.columns) for (const w of identTerms(c.name)) colTerms.set(w, (colTerms.get(w) ?? 0) + 1);
    const sampleTerms = new Set(Object.values(t.samples ?? {}).flat().flatMap((v) => identTerms(String(v))));
    const descTerms = new Set(identTerms(t.description ?? knowledge?.tables?.[t.name]?.description ?? ''));
    return { t, nameTerms, aliasTerms, colTerms, sampleTerms, descTerms, lname: t.name.toLowerCase(), joined: [...nameTerms].join('') };
  });
  Object.defineProperty(model, '__index', { value: idx, enumerable: false, configurable: true });
  return idx;
}

export function matchPrompt(model, prompt, knowledge = {}, opts = {}) {
  const maxPrimary = opts.maxPrimary ?? 8;
  const maxNeighbors = opts.maxNeighbors ?? 6;
  const terms = promptTerms(prompt);
  const lowerPrompt = fold(prompt);
  const glossary = knowledge.glossary ?? {};
  const scored = [];

  for (const e of tableIndex(model, knowledge)) {
    let score = 0, colScore = 0, strong = false; const why = [];
    if (e.lname.length > 3 && new RegExp(`\\b${e.lname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lowerPrompt)) { score += 12; strong = true; why.push('name'); }
    for (const [term, w] of terms) {
      if (e.nameTerms.has(term)) { score += (e.nameTerms.size === 1 ? 8 : 6) * w; strong = true; why.push(term); }
      else if (e.joined === term) { score += 8 * w; strong = true; why.push(term); }
      else if (e.aliasTerms.has(term)) { score += 6 * w; strong = true; why.push(`alias:${term}`); }
      else if (term.length >= 4 && [...e.nameTerms].some((n) => n.length >= 4 && (n.startsWith(term) || term.startsWith(n)))) { score += 3 * w; strong = true; why.push(`~${term}`); }
      if (e.colTerms.has(term) && colScore < 2.5) { const add = Math.min(e.colTerms.get(term), 2) * 0.7 * w; colScore += add; score += add; why.push(`col:${term}`); }
      if (e.sampleTerms.has(term)) { score += 2.5 * w; why.push(`value:${term}`); }
      if (e.descTerms.has(term) && term.length >= 4) { score += 5 * w; strong = true; why.push(`desc:${term}`); }
      const g = glossary[term]?.[e.t.name];
      if (g) { score += Math.min(g, 5) * 1.5 * w; strong = true; why.push(`learned:${term}`); }
    }
    if (score > 0) scored.push({ table: e.t.name, score, strong, why: [...new Set(why)].slice(0, 6), t: e.t });
  }
  for (const s of scored) {
    const nt = s.t.terms ?? [];
    const covered = nt.filter((w) => terms.has(w)).length;
    if (nt.length > 1 && covered === nt.length) s.score += 4;
    s.score += Math.min(s.t.importance ?? 0, 10) * 0.05;
  }
  for (const s of scored) s.score = +s.score.toFixed(2);
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  const threshold = Math.max(opts.minScore ?? 5, top * 0.4);
  let primary = scored.filter((s) => s.strong && s.score >= threshold).slice(0, maxPrimary);
  const strongTerms = new Set(primary.flatMap((p) => p.why.filter((w) => !/^(col|value):/.test(w)).map((w) => w.replace(/^(alias|learned|desc):|^~/, ''))));
  const explicit = primary.some((p) => p.why.includes('name') || p.why.some((w) => /^(alias|learned|desc):/.test(w)));
  if (!explicit && strongTerms.size <= 1 && [...strongTerms].every((t) => GENERIC.has(t) && terms.get(t) === 1) && !DB_INTENT.test(lowerPrompt)) primary = [];

  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const chosen = new Set(primary.map((p) => p.table));
  const neighborScore = new Map();
  for (const p of primary) {
    if (p.score < top * 0.55) continue;
    for (const r of p.t.refs ?? []) if (!chosen.has(r.table) && byName.has(r.table)) neighborScore.set(r.table, (neighborScore.get(r.table) ?? 0) + 2 + (byName.get(r.table).importance ?? 0) * 0.05);
    for (const r of p.t.referencedBy ?? []) {
      if (chosen.has(r.table)) continue;
      const nt = byName.get(r.table); if (!nt) continue;
      const linksPrimaries = (nt.refs ?? []).filter((x) => chosen.has(x.table)).length;
      if (linksPrimaries >= 2 || nt.role === 'junction' || nt.role === 'detail') neighborScore.set(r.table, (neighborScore.get(r.table) ?? 0) + linksPrimaries + 1);
    }
  }
  const neighbors = [...neighborScore].filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).slice(0, maxNeighbors).map(([table, score]) => ({ table, score: +score.toFixed(2) }));
  const modules = [...new Set(primary.map((p) => p.t.module))].map((id) => model.modules.find((m) => m.id === id)).filter(Boolean);

  return {
    terms: [...terms.keys()],
    primary: primary.map(({ t, strong, ...rest }) => rest),
    neighbors,
    modules: modules.map((m) => ({ id: m.id, name: m.label ?? m.name })),
  };
}

export function buildContext(model, match, { session = null, budget = 1400, maxCols = 16 } = {}) {
  const empty = { text: '', tokens: 0, baselineTokens: 0, newTables: [], reusedTables: [] };
  if (!match.primary.length) return empty;
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const focus = new Set(match.terms);
  const sent = session?.sent ?? {};

  const baseline = [
    ...match.primary.map((p) => formatTable(byName.get(p.table), 'full', { nullability: true })),
    ...match.neighbors.map((n) => formatTable(byName.get(n.table), 'full', { nullability: true })),
  ].join('\n');

  const items = [];
  const reused = [];
  for (const p of match.primary) {
    const text = formatTable(byName.get(p.table), 'full', { maxCols, focus });
    const prev = sent[p.table];
    if (prev && prev.sig === sig(text)) reused.push(p.table);
    else items.push({ table: p.table, mode: 'full', text, score: p.score });
  }
  for (const n of match.neighbors) {
    const text = formatTable(byName.get(n.table), 'keys');
    if (sent[n.table]) { reused.push(n.table); continue; }
    items.push({ table: n.table, mode: 'keys', text, score: n.score });
  }

  let est = items.reduce((a, i) => a + estimateTokens(i.text), 0);
  for (let i = items.length - 1; est > budget && i >= 0; i--) {
    const it = items[i];
    if (it.mode === 'keys') { est -= estimateTokens(it.text); items.splice(i, 1); continue; }
    const keys = formatTable(byName.get(it.table), 'keys');
    est -= estimateTokens(it.text) - estimateTokens(keys);
    Object.assign(it, { mode: 'keys', text: keys });
  }

  const lines = [];
  const showHeader = !session?.header;
  if (!items.length) {
    lines.push(`[dbscope] Relevant tables already in context above: ${reused.join(', ')}.`);
  } else {
    if (showHeader) {
      lines.push(`[dbscope] ${model.dialect}:${model.database} (${model.tables.length} tables). ${LEGEND}`);
      const purpose = model.purpose?.auto === false
        ? model.purpose.summary.split(/(?<=[.!?])\s/)[0].slice(0, 180)
        : model.purpose?.domains?.slice(0, 2).map((d) => d.name).join(' + ');
      if (purpose) lines.push(`Project: ${purpose}`);
    } else lines.push('[dbscope] tables for this prompt:');
    const full = items.filter((i) => i.mode === 'full');
    const keys = items.filter((i) => i.mode === 'keys');
    for (const i of full) lines.push('- ' + i.text);
    if (keys.length) { lines.push('Related (keys only):'); for (const i of keys) lines.push('- ' + i.text); }
    const seenMods = new Set(session?.modules ?? []);
    const modLines = (match.modules ?? []).map((m) => model.modules.find((x) => x.id === m.id)).filter((m) => m?.description && !seenMods.has(m.id));
    for (const m of modLines) { lines.push(`Module ${m.label ?? m.name}: ${m.description}`); seenMods.add(m.id); }
    if (session) session.modules = [...seenMods];
    if (reused.length) lines.push(`Already in context: ${reused.join(', ')}.`);
    if (showHeader) lines.push('More detail: dbscope MCP tools describe_tables / find_path / search_schema — no need to scan migrations or models.');
  }
  const text = lines.join('\n');

  if (session) {
    for (const i of items) {
      const prev = sent[i.table];
      if (i.mode === 'full' || !prev) sent[i.table] = { sig: sig(i.text), mode: i.mode };
    }
    session.sent = sent;
    if (items.length) session.header = true;
    session.prompts = (session.prompts ?? 0) + 1;
  }
  return {
    text,
    tokens: estimateTokens(text),
    baselineTokens: estimateTokens(baseline) + 120,
    newTables: items.map((i) => ({ table: i.table, mode: i.mode })),
    reusedTables: reused,
  };
}

export function findPath(model, from, to) {
  const inDeg = new Map();
  for (const r of model.relations) inDeg.set(r.to, (inDeg.get(r.to) ?? 0) + 1);
  const hubCut = Math.max(6, model.tables.length * 0.25);
  const adj = new Map(model.tables.map((t) => [t.name, []]));
  for (const r of model.relations) {
    const via = `${r.from}.${r.fromCol} → ${r.to}.${r.toCol}${r.inferred ? ' (inferred)' : ''}`;
    const cost = 1 + ((inDeg.get(r.to) ?? 0) > hubCut ? 4 : 0) + (r.inferred ? 0.2 : 0);
    adj.get(r.from)?.push({ to: r.to, via, cost });
    adj.get(r.to)?.push({ to: r.from, via, cost });
  }
  const dist = new Map([[from, 0]]); const prev = new Map(); const done = new Set();
  while (true) {
    let cur = null, best = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < best) { best = d; cur = n; }
    if (cur === null || cur === to) break;
    done.add(cur);
    for (const e of adj.get(cur) ?? []) {
      const nd = best + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, via: e.via }); }
    }
  }
  if (!dist.has(to)) return null;
  const steps = [];
  for (let n = to; prev.get(n); n = prev.get(n).from) steps.unshift(prev.get(n).via);
  return steps;
}
