import http from 'node:http';
import { readFileSync, existsSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel, runAnalysis, contextForPrompt } from './engine.js';
import { readEvents, paths, ensureDir, writeJson, readJson, logEvent } from './store.js';
import { annotateTable, learn, loadKnowledge, saveKnowledge } from './knowledge.js';
import { detectAll, describeSource } from './detect.js';
import { findPath } from './match.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function staticFile(urlPath) {
  const p = resolve(ROOT, 'web', '.' + (urlPath === '/' ? '/index.html' : urlPath));
  return p.startsWith(join(ROOT, 'web')) && existsSync(p) && statSync(p).isFile() ? p : null;
}

const body = (req) => new Promise((ok, fail) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 5e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
});

export async function isAlive(projectDir) {
  const info = readJson(paths(projectDir).server);
  if (!info?.port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { signal: AbortSignal.timeout(600) });
    const j = await r.json();
    return j.project === resolve(projectDir) ? info : null;
  } catch { return null; }
}

export async function startServer(projectDir, { port = 4777, log = console.error } = {}) {
  projectDir = resolve(projectDir);
  const running = await isAlive(projectDir);
  if (running) return { ...running, reused: true };
  ensureDir(projectDir);
  const clients = new Set();
  const p = paths(projectDir);
  let analyzing = null;

  const send = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const broadcast = (type, data) => { for (const c of clients) c.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const f = staticFile(url.pathname);
        if (!f) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[f.slice(f.lastIndexOf('.'))] ?? 'application/octet-stream' });
        return res.end(readFileSync(f));
      }
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/format': {
          const model = getModel(projectDir);
          const t = model?.tables.find((x) => x.name === url.searchParams.get('table'));
          if (!t) return send(res, 404, { error: 'table not found' });
          const { formatTable } = await import('./format.js');
          const { estimateTokens } = await import('./text.js');
          const full = formatTable(t, 'full', { maxCols: 16 }), keys = formatTable(t, 'keys');
          return send(res, 200, { full, keys, fullTokens: estimateTokens(full), keysTokens: estimateTokens(keys) });
        }
        case 'GET /api/usage': {
          const { sessionUsage } = await import('./usage.js');
          return send(res, 200, sessionUsage(projectDir));
        }
        case 'GET /api/ping': return send(res, 200, { ok: true, project: projectDir });
        case 'GET /api/model': {
          const model = getModel(projectDir);
          return send(res, 200, { project: projectDir, model, analyzing: !!analyzing, knowledge: loadKnowledge(projectDir) });
        }
        case 'GET /api/events': return send(res, 200, readEvents(projectDir, +(url.searchParams.get('limit') ?? 300)));
        case 'GET /api/sources': return send(res, 200, detectAll(projectDir).map((s, i) => ({ i, label: describeSource(s), via: s.via, type: s.type })));
        case 'GET /api/path': {
          const model = getModel(projectDir);
          return send(res, 200, { path: model ? findPath(model, url.searchParams.get('from'), url.searchParams.get('to')) : null });
        }
        case 'GET /api/stream': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        case 'POST /api/match': {
          const { prompt } = await body(req);
          const r = contextForPrompt(projectDir, prompt ?? '', { source: 'ui' });
          return send(res, 200, r);
        }
        case 'POST /api/analyze': {
          const { db, sourceIndex } = await body(req);
          const cfg = readJson(p.config, {});
          let source;
          if (sourceIndex != null) {
            source = detectAll(projectDir)[sourceIndex];
            if (!source) return send(res, 400, { error: 'kaynak yok' });
            delete cfg.db; writeJson(p.config, { ...cfg, preferVia: source.via });
          } else if (db) writeJson(p.config, { ...cfg, db });
          analyzing ??= runAnalysis(projectDir, { db, source }).finally(() => { analyzing = null; });
          const model = await analyzing;
          return send(res, 200, { ok: true, stats: model.stats });
        }
        case 'POST /api/annotate': {
          const { table, description, aliases } = await body(req);
          annotateTable(projectDir, table, { description, aliases });
          logEvent(projectDir, { type: 'annotate', table, by: 'ui' });
          return send(res, 200, { ok: true });
        }
        case 'POST /api/summary': {
          const { summary } = await body(req);
          const k = loadKnowledge(projectDir); k.projectSummary = summary || null; saveKnowledge(projectDir, k);
          logEvent(projectDir, { type: 'summary', by: 'ui' });
          return send(res, 200, { ok: true });
        }
        case 'POST /api/learn': {
          const { prompt, tables } = await body(req);
          learn(projectDir, prompt, tables ?? []);
          logEvent(projectDir, { type: 'learn', prompt: String(prompt).slice(0, 300), tables, by: 'ui' });
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  let lastSize = existsSync(p.events) ? statSync(p.events).size : 0;
  const onEvents = () => {
    const size = existsSync(p.events) ? statSync(p.events).size : 0;
    if (size === lastSize) return;
    if (size < lastSize) lastSize = 0;
    const text = readFileSync(p.events, 'utf8').slice(lastSize);
    lastSize = size;
    for (const line of text.split('\n').filter(Boolean)) { try { broadcast('event', JSON.parse(line)); } catch {} }
  };
  watchFile(p.events, { interval: 500 }, onEvents);
  watchFile(p.model, { interval: 1000 }, () => broadcast('model', { at: Date.now() }));
  watchFile(p.knowledge, { interval: 1000 }, () => broadcast('model', { at: Date.now() }));
  const ka = setInterval(() => { for (const c of clients) c.write(': ka\n\n'); }, 20000);

  const listen = (port) => new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(port); });
  });
  let bound;
  for (let i = 0; i < 30 && !bound; i++) {
    try { bound = await listen(port + i); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  if (!bound) throw new Error('Boş port bulunamadı');
  const info = { port: bound, pid: process.pid, url: `http://localhost:${bound}`, startedAt: new Date().toISOString() };
  writeJson(p.server, info);
  log(`dbscope dashboard: ${info.url}  (project: ${projectDir})`);

  const close = () => { clearInterval(ka); unwatchFile(p.events); unwatchFile(p.model); unwatchFile(p.knowledge); server.close(); };
  return { ...info, server, close };
}
