import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readEvents } from './store.js';

export const transcriptDir = (projectDir) => join(homedir(), '.claude', 'projects', resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));

function parseTranscript(file) {
  const byMsg = new Map();
  const tools = {};
  let prompts = 0, first = null, last = null, sessionId = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) { first ??= e.timestamp; last = e.timestamp; }
    sessionId ??= e.sessionId;
    if (e.type === 'user' && typeof e.message?.content === 'string' && !e.isMeta) prompts++;
    if (e.type === 'assistant' && e.message?.usage) {
      byMsg.set(e.message.id ?? e.uuid, e.message.usage);
      for (const c of e.message.content ?? []) if (c.type === 'tool_use') tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
  }
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const x of byMsg.values()) {
    u.input += x.input_tokens ?? 0; u.cacheWrite += x.cache_creation_input_tokens ?? 0;
    u.cacheRead += x.cache_read_input_tokens ?? 0; u.output += x.output_tokens ?? 0;
  }
  return { sessionId, first, last, prompts, turns: byMsg.size, usage: u, tools };
}

export function sessionUsage(projectDir, limit = 40) {
  const dir = transcriptDir(projectDir);
  if (!existsSync(dir)) return { dir, sessions: [], summary: null };
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, limit);
  const dbSessions = new Set(readEvents(projectDir, 5000).map((e) => e.sessionId).filter(Boolean));
  const sessions = files.map(({ f }) => parseTranscript(f)).filter((s) => s.turns > 0).map((s) => {
    const explore = Object.entries(s.tools).filter(([k]) => /^(Read|Grep|Glob)$/.test(k)).reduce((a, [, v]) => a + v, 0);
    const dbTools = Object.entries(s.tools).filter(([k]) => k.startsWith('mcp__dbscope')).reduce((a, [, v]) => a + v, 0);
    const totalIn = s.usage.input + s.usage.cacheWrite + s.usage.cacheRead;
    return { ...s, explore, dbTools, totalIn, dbscope: dbSessions.has(s.sessionId) || dbTools > 0 };
  });
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((a, s) => a + k(s), 0) / arr.length) : null);
  const group = (arr) => ({
    sessions: arr.length,
    perPromptInput: avg(arr.filter((s) => s.prompts), (s) => s.totalIn / s.prompts),
    perPromptOutput: avg(arr.filter((s) => s.prompts), (s) => s.usage.output / s.prompts),
    perPromptExplore: arr.length ? +(arr.reduce((a, s) => a + s.explore, 0) / Math.max(1, arr.reduce((a, s) => a + s.prompts, 0))).toFixed(2) : null,
    perPromptTurns: arr.length ? +(arr.reduce((a, s) => a + s.turns, 0) / Math.max(1, arr.reduce((a, s) => a + s.prompts, 0))).toFixed(2) : null,
  });
  return { dir, sessions, summary: { with: group(sessions.filter((s) => s.dbscope)), without: group(sessions.filter((s) => !s.dbscope)) } };
}
