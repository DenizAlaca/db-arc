import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function paths(projectDir) {
  const dir = join(resolve(projectDir), '.dbscope');
  return {
    dir,
    model: join(dir, 'model.json'),
    knowledge: join(dir, 'knowledge.json'),
    events: join(dir, 'events.jsonl'),
    server: join(dir, 'server.json'),
    config: join(dir, 'config.json'),
    schemaMd: join(dir, 'SCHEMA.md'),
  };
}

export function ensureDir(projectDir) {
  const p = paths(projectDir);
  if (!existsSync(p.dir)) mkdirSync(p.dir, { recursive: true });
  const gi = join(p.dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n');
  return p;
}

export const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
export const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2));

export function loadModel(projectDir) { return readJson(paths(projectDir).model); }

export function logEvent(projectDir, event) {
  const p = ensureDir(projectDir);
  const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), ...event };
  appendFileSync(p.events, JSON.stringify(e) + '\n');
  return e;
}

export function readEvents(projectDir, limit = 300) {
  try {
    const lines = readFileSync(paths(projectDir).events, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
