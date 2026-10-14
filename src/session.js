import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { paths, readJson, writeJson } from './store.js';

const dir = (projectDir) => join(paths(projectDir).dir, 'sessions');
const file = (projectDir, sid) => join(dir(projectDir), String(sid).replace(/[^\w-]/g, '').slice(0, 80) + '.json');

export const sig = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10);

export function loadSession(projectDir, sid) {
  if (!sid) return null;
  return { id: sid, sent: {}, header: false, prompts: 0, ...readJson(file(projectDir, sid), {}) };
}

export function saveSession(projectDir, s) {
  if (!s?.id) return;
  const d = dir(projectDir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  s.updatedAt = new Date().toISOString();
  writeJson(file(projectDir, s.id), s);
}

export function resetSession(projectDir, sid) {
  const f = file(projectDir, sid);
  if (existsSync(f)) rmSync(f);
}

export function pruneSessions(projectDir, maxAgeDays = 7) {
  const d = dir(projectDir);
  if (!existsSync(d)) return;
  const cutoff = Date.now() - maxAgeDays * 864e5;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p); } catch {}
  }
}
