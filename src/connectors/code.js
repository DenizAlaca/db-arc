import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import rails from './code/rails.js';
import laravel from './code/laravel.js';
import { django, sqlalchemy } from './code/python.js';
import { typeorm, sequelize, mongoose, drizzle } from './code/js.js';
import efcore from './code/csharp.js';
import jpa from './code/jvm.js';
import gorm from './code/go.js';
import ecto from './code/ecto.js';

export const PARSERS = [rails, laravel, django, sqlalchemy, typeorm, sequelize, mongoose, drizzle, efcore, jpa, gorm, ecto];

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'bin', 'obj', 'target', 'venv', '__pycache__', 'Pods', 'coverage', 'out', 'tmp', 'log', 'logs', 'storage', 'public', 'assets', 'static', 'site-packages', 'bower_components', 'jspm_packages', 'deps', '_build', 'DerivedData']);
const EXTS = new Set(['.rb', '.php', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.cs', '.java', '.kt', '.go', '.ex', '.exs']);
const MAX_SIZE = 1024 * 1024;

function* walk(root, maxDepth, budget = { n: Infinity }) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget.n-- <= 0) return;
      if (e.isDirectory()) { if (depth < maxDepth && !e.name.startsWith('.') && !SKIP.has(e.name)) stack.push([join(dir, e.name), depth + 1]); continue; }
      if (!e.isFile()) continue;
      const ext = extname(e.name);
      if (!EXTS.has(ext)) continue;
      const path = join(dir, e.name);
      yield { path, rel: relative(root, path).split('\\').join('/'), ext };
    }
  }
}

function head(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

export function hasModels(dir) {
  for (const f of walk(dir, 6, { n: 20000 })) {
    const ps = PARSERS.filter((p) => p.want(f.rel, f.ext));
    if (!ps.length) continue;
    const txt = head(f.path, 65536);
    if (ps.some((p) => p.detect.test(txt))) return true;
  }
  return false;
}

export function scan(dir) {
  const buckets = new Map(PARSERS.map((p) => [p.id, { p, files: [], hit: false }]));
  for (const f of walk(dir, 8)) {
    const ps = PARSERS.filter((p) => p.want(f.rel, f.ext));
    if (!ps.length) continue;
    let src;
    try { if (statSync(f.path).size > MAX_SIZE) continue; src = readFileSync(f.path, 'utf8'); } catch { continue; }
    const file = { ...f, src };
    for (const p of ps) {
      const b = buckets.get(p.id);
      if (p.detect.test(src)) { b.hit = true; b.files.push(file); }
      else if (p.keep.test(src)) b.files.push(file);
    }
  }
  return [...buckets.values()].filter((b) => b.hit);
}

export async function introspect({ dir }) {
  const found = [], tables = [], used = new Set(), names = new Map();
  for (const { p, files } of scan(dir)) {
    let res;
    try { res = p.parse(files); } catch { continue; }
    if (!res?.tables.length) continue;
    found.push(p.id);
    for (const f of res.used) used.add(f);
    for (const t of res.tables) {
      const prev = names.get(t.name);
      if (prev) { for (const c of t.columns) if (!prev.columns.some((x) => x.name === c.name)) prev.columns.push(c); for (const fk of t.fks) if (!prev.fks.some((x) => x.columns[0] === fk.columns[0])) prev.fks.push(fk); Object.assign(prev.samples, t.samples); if (!prev.pk.length) prev.pk = t.pk; continue; }
      names.set(t.name, t);
      tables.push(t);
    }
  }
  if (!tables.length) throw new Error(`Model dosyası bulunamadı: ${dir} (desteklenen: ${PARSERS.map((p) => p.id).join(', ')})`);
  return { dialect: `code:${found.join(',')}`, database: `${used.size} model file(s)`, tables };
}
