import { writeFileSync } from 'node:fs';
import { detect, detectAll, describeSource } from './detect.js';
import { introspect } from './connectors/index.js';
import { analyze } from './analyze.js';
import { ensureDir, loadModel, writeJson, logEvent, readJson, paths } from './store.js';
import { loadKnowledge, enrich } from './knowledge.js';
import { matchPrompt, buildContext } from './match.js';
import { formatTable, LEGEND } from './format.js';
import { loadSession, saveSession } from './session.js';

const FILE_TYPES = new Set(['prisma', 'sql', 'code']);
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: ${ms / 1000}s içinde yanıt yok`)), ms))]);

async function candidatesFor(projectDir, { db, source, cfg }) {
  if (source) return [source];
  if (db ?? cfg.db) return [detect(projectDir, db ?? cfg.db)];
  const all = detectAll(projectDir);
  try {
    const code = await import('./connectors/code.js');
    if (code.hasModels?.(projectDir)) all.push({ type: 'code', dir: projectDir, via: 'ORM/model files' });
  } catch {}
  const pref = all.findIndex((s) => s.via === cfg.preferVia);
  if (pref > 0) all.unshift(...all.splice(pref, 1));
  return [...all.filter((s) => !FILE_TYPES.has(s.type)), ...all.filter((s) => FILE_TYPES.has(s.type))];
}

export async function runAnalysis(projectDir, { db, samples, source, multi } = {}) {
  const p = ensureDir(projectDir);
  const cfg = readJson(p.config, {});
  const candidates = await candidatesFor(projectDir, { db, source, cfg });
  if (!candidates.length) throw new Error('Veritabanı bulunamadı. --db ile bağlantı verin (postgres://…, mysql://…, mongodb://…, sqlserver://…, oracle://…, redis://…, firestore://<project>, dosya.db, schema.prisma, schema.sql, serviceAccount.json) ya da Claude ile submit_schema kullanın.');
  const useMulti = (multi ?? cfg.multi ?? true) && candidates.length > 1;
  const ok = [];
  const errors = [];
  for (const s of candidates) {
    if (FILE_TYPES.has(s.type) && ok.length) continue;
    if (ok.length >= 6) break;
    try {
      const raw = await withTimeout(introspect(s, { samples: samples ?? cfg.samples }), 20000, describeSource(s));
      if (!raw.tables?.length) throw new Error('tablo bulunamadı');
      const sig = raw.tables.map((t) => t.name.toLowerCase()).sort().join('|');
      if (ok.some((o) => o.sig === sig)) continue;
      ok.push({ s, raw, sig });
      if (!useMulti) break;
    } catch (e) {
      errors.push(`${describeSource(s)} (${s.via}): ${e.message || e.code || e.errors?.[0]?.message || String(e)}`);
    }
  }
  if (!ok.length) throw new Error('Hiçbir kaynağa bağlanılamadı:\n  ' + errors.join('\n  '));
  const label = ok.map((o) => `${describeSource(o.s)} (via ${o.s.via})`).join(' + ');
  const meta = { sources: ok.map((o) => ({ label: describeSource(o.s), via: o.s.via, type: o.s.type, tables: o.raw.tables.length })), sourceErrors: errors };
  if (ok.length === 1) return saveModel(projectDir, ok[0].raw, label, meta);
  const counts = new Map();
  for (const o of ok) counts.set(o.s.type, (counts.get(o.s.type) ?? 0) + 1);
  const tables = [];
  for (const o of ok) {
    const prefix = counts.get(o.s.type) > 1 ? String(o.raw.database).split(/[\\/]/).pop().replace(/\.\w+$/, '') : o.raw.dialect;
    const names = new Set(o.raw.tables.map((t) => t.name));
    for (const t of o.raw.tables) {
      tables.push({ ...t, name: `${prefix}.${t.name}`, fks: (t.fks ?? []).map((f) => ({ ...f, refTable: names.has(f.refTable) ? `${prefix}.${f.refTable}` : f.refTable })) });
    }
  }
  return saveModel(projectDir, { dialect: ok.map((o) => o.raw.dialect).join('+'), database: ok.map((o) => o.raw.database).join(' + '), tables }, label, meta);
}

export function importSchema(projectDir, raw, label = 'submitted schema') {
  if (!raw?.tables?.length) throw new Error('Şema boş: { dialect, database, tables:[{ name, columns:[{name,type,pk?,nullable?}], fks?:[{columns,refTable,refColumns}] }] }');
  raw.tables = raw.tables.map((t) => ({
    kind: 'table', fks: [], samples: {}, rows: null, ...t,
    columns: (t.columns ?? []).map((c) => (typeof c === 'string' ? { name: c, type: '', nullable: true, pk: false } : { nullable: true, pk: false, type: '', ...c })),
    pk: t.pk ?? (t.columns ?? []).filter((c) => c.pk).map((c) => c.name),
  }));
  return saveModel(projectDir, { dialect: raw.dialect ?? 'custom', database: raw.database ?? 'custom', tables: raw.tables }, label);
}

function saveModel(projectDir, raw, sourceLabel, meta = {}) {
  const p = ensureDir(projectDir);
  const model = { ...analyze(raw, sourceLabel), ...meta };
  writeJson(p.model, model);
  writeSchemaMd(projectDir, enrich(model, loadKnowledge(projectDir)));
  logEvent(projectDir, { type: 'analyze', source: sourceLabel, stats: model.stats, fullSchemaTokens: model.fullSchemaTokens });
  return model;
}

export function writeSchemaMd(projectDir, model) {
  const lines = [`# DB map: ${model.database} (${model.dialect})`, '', model.purpose?.summary ?? '', '', LEGEND, ''];
  for (const m of model.modules) {
    lines.push(`## ${m.label ?? m.name}${m.description ? ' — ' + m.description : ''}`);
    for (const name of m.tables) lines.push('- ' + formatTable(model.tables.find((t) => t.name === name), 'full'));
    lines.push('');
  }
  writeFileSync(paths(projectDir).schemaMd, lines.join('\n'));
}

export function getModel(projectDir) {
  const model = loadModel(projectDir);
  if (!model) return null;
  return enrich(model, loadKnowledge(projectDir));
}

export function contextForPrompt(projectDir, prompt, { source = 'hook', log = true, sessionId = null } = {}) {
  const model = getModel(projectDir);
  if (!model) return { text: '', tokens: 0, match: null };
  const knowledge = loadKnowledge(projectDir);
  const match = matchPrompt(model, prompt, knowledge);
  const session = loadSession(projectDir, sessionId);
  const ctx = buildContext(model, match, { session });
  if (session && match.primary.length) saveSession(projectDir, session);
  if (log) {
    logEvent(projectDir, {
      type: 'prompt', source, prompt: String(prompt).slice(0, 1200), sessionId: sessionId ?? undefined,
      primary: match.primary, neighbors: match.neighbors, modules: match.modules, terms: match.terms.slice(0, 30),
      injectedTokens: ctx.tokens, baselineTokens: ctx.baselineTokens, fullSchemaTokens: model.fullSchemaTokens,
      newTables: ctx.newTables, reusedTables: ctx.reusedTables,
    });
  }
  return { ...ctx, match };
}
