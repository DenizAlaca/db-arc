import { paths, ensureDir, readJson, writeJson } from './store.js';
import { promptTerms } from './text.js';

const EMPTY = { projectSummary: null, tables: {}, modules: {}, glossary: {} };

export function loadKnowledge(projectDir) { return { ...EMPTY, ...readJson(paths(projectDir).knowledge, {}) }; }
export function saveKnowledge(projectDir, k) { ensureDir(projectDir); writeJson(paths(projectDir).knowledge, k); return k; }

export function annotateTable(projectDir, table, { description, aliases }) {
  const k = loadKnowledge(projectDir);
  const cur = k.tables[table] ?? {};
  k.tables[table] = {
    ...cur,
    ...(description ? { description } : {}),
    aliases: [...new Set([...(cur.aliases ?? []), ...(aliases ?? [])])],
  };
  return saveKnowledge(projectDir, k);
}

export function learn(projectDir, text, tables) {
  const k = loadKnowledge(projectDir);
  for (const [term] of promptTerms(text)) {
    if (term.length < 3) continue;
    const g = (k.glossary[term] ??= {});
    for (const t of tables) g[t] = Math.min((g[t] ?? 0) + 1, 10);
  }
  return saveKnowledge(projectDir, k);
}

export function enrich(model, k) {
  for (const t of model.tables) {
    const info = k.tables[t.name];
    if (info?.description) t.description = info.description;
    if (info?.aliases?.length) t.aliases = info.aliases;
  }
  for (const m of model.modules) {
    const info = k.modules[m.id] ?? k.modules[m.name];
    if (info?.name) m.label = info.name;
    if (info?.description) m.description = info.description;
  }
  if (k.projectSummary) model.purpose = { ...model.purpose, summary: k.projectSummary, auto: false };
  return model;
}
