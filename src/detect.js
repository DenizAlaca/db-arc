import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { frameworkSources, jdbcToUrl } from './frameworks.js';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'bin', 'obj', '.next', '.venv', 'venv', '__pycache__', 'Pods', '.gradle', 'target', '.dbscope', 'coverage']);

export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

export function sourceFromString(str, cwd = process.cwd()) {
  const s = String(str).trim();
  if (/^postgres(ql)?:\/\//i.test(s)) return { type: 'postgres', url: s };
  if (/^mysql2?:\/\/|^mariadb:\/\//i.test(s)) return { type: 'mysql', url: s.replace(/^(mysql2|mariadb):/, 'mysql:') };
  if (/^mongodb(\+srv)?:\/\//i.test(s)) return { type: 'mongodb', url: s };
  if (/^rediss?:\/\//i.test(s)) return { type: 'redis', url: s };
  if (/^firestore:\/\//i.test(s)) return { type: 'firestore', projectId: s.slice(12) || undefined };
  if (/\.json$/i.test(s) && existsSync(resolve(cwd, s))) { const fs = firestoreFromKeyFile(resolve(cwd, s)); if (fs) return fs; }
  if (/^(sqlserver|mssql):\/\//i.test(s)) {
    const u = new URL(s.replace(/^\w+:/, 'http:'));
    return { type: 'mssql', config: { server: u.hostname, port: +u.port || 1433, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) } };
  }
  if (/^oracle:\/\//i.test(s)) return { type: 'oracle', url: s };
  if (/^dynamodb(\+https?)?:\/\//i.test(s)) return { type: 'dynamodb', url: s };
  if (/^(cassandra|scylla|scylladb)(\+tls)?:\/\//i.test(s)) return { type: 'cassandra', url: s };
  if (/^(elasticsearch|elastic|opensearch)(\+https?)?:\/\//i.test(s)) return { type: 'elasticsearch', url: s };
  if (/^(neo4j|bolt)(\+s|\+ssc)?:\/\//i.test(s)) return { type: 'neo4j', url: s };
  if (/^(clickhouse|ch)(\+https?)?:\/\//i.test(s)) return { type: 'clickhouse', url: s };
  if (/^libsql:\/\//i.test(s) || /^https?:\/\/[^/]*\.turso\.io/i.test(s)) return { type: 'libsql', url: s };
  if (/^jdbc:/i.test(s)) { const u = jdbcToUrl(s); return u ? sourceFromString(u, cwd) : null; }
  if (/^file:|^sqlite:/i.test(s)) return { type: 'sqlite', file: resolve(cwd, s.replace(/^(file|sqlite):(\/\/)?/i, '')) };
  const p = resolve(cwd, s);
  if (existsSync(p)) {
    if (/\.prisma$/.test(p)) return { type: 'prisma', file: p };
    if (/\.sql$/i.test(p)) return { type: 'sql', files: [p] };
    if (statSync(p).isDirectory()) { const files = walk(p, (f) => /\.sql$/i.test(f), 4); if (files.length) return { type: 'sql', files }; }
    return { type: 'sqlite', file: p };
  }
  if (/[;=]/.test(s)) return fromAdoString(s, cwd);
  return null;
}

function fromAdoString(s, cwd) {
  const kv = {};
  for (const part of s.split(';')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  const ds = kv['data source'] ?? kv['datasource'] ?? kv['filename'];
  if (ds && /\.(db|sqlite3?|db3)$/i.test(ds)) return { type: 'sqlite', file: resolve(cwd, ds) };
  const database = kv.database ?? kv['initial catalog'];
  const user = kv.username ?? kv['user id'] ?? kv.uid ?? kv.user;
  const password = kv.password ?? kv.pwd;
  if (kv.host) {
    const port = kv.port ?? 5432;
    return { type: 'postgres', url: `postgres://${encodeURIComponent(user ?? '')}:${encodeURIComponent(password ?? '')}@${kv.host}:${port}/${database}` };
  }
  const server = kv.server ?? ds ?? kv.address;
  if (server) {
    if (kv.port && +kv.port === 3306 || kv['sslmode'] && !kv['trustservercertificate']) {
      return { type: 'mysql', config: { host: server, port: +(kv.port ?? 3306), user, password, database } };
    }
    const [host, inst] = server.replace(/^tcp:/i, '').split('\\');
    const [h, port] = host.split(',');
    return { type: 'mssql', config: { server: h, port: port ? +port : undefined, user, password, database, options: { instanceName: inst, encrypt: kv.encrypt !== 'False', trustServerCertificate: true } } };
  }
  return null;
}

function firestoreFromKeyFile(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.type === 'service_account' && j.private_key) return { type: 'firestore', credentials: j, projectId: j.project_id, keyFile: p };
  } catch {}
  return null;
}

const pick = (env, keys) => { for (const k of keys) if (env[k]) return env[k]; };

function fromEnv(env, cwd) {
  const urlKey = Object.keys(env).find((k) => /^(DATABASE_URL|DB_URL|DB_URI|DATABASE_URI|POSTGRES_URL|PG_URL|MYSQL_URL|MONGO_URL|MONGO_URI|MONGODB_URI|MONGODB_URL|SQLITE_PATH|SQLITE_FILE|DATABASE_PATH|DB_PATH|DB_FILE)$/i.test(k) && env[k])
    ?? Object.keys(env).find((k) => /(DATABASE|DB)_(URL|URI)$/i.test(k) && env[k]);
  if (urlKey) { const s = sourceFromString(env[urlKey], cwd); if (s) return { ...s, via: urlKey }; }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) { const s = firestoreFromKeyFile(resolve(cwd, env.GOOGLE_APPLICATION_CREDENTIALS)); if (s) return { ...s, via: 'GOOGLE_APPLICATION_CREDENTIALS' }; }
  if (env.FIREBASE_SERVICE_ACCOUNT) { try { const j = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); return { type: 'firestore', credentials: j, projectId: j.project_id, via: 'FIREBASE_SERVICE_ACCOUNT' }; } catch {} }
  const redis = pick(env, ['REDIS_URL', 'REDIS_URI']);
  const host = pick(env, ['DB_HOST', 'DATABASE_HOST', 'POSTGRES_HOST', 'PGHOST', 'MYSQL_HOST', 'DB_SERVER', 'DB_ADDRESS']);
  const database = pick(env, ['DB_DATABASE', 'DB_NAME', 'DATABASE_NAME', 'POSTGRES_DB', 'PGDATABASE', 'MYSQL_DATABASE']);
  if (!host || !database) return redis ? { type: 'redis', url: redis, via: 'REDIS_URL' } : null;
  const user = pick(env, ['DB_USERNAME', 'DB_USER', 'DATABASE_USER', 'POSTGRES_USER', 'PGUSER', 'MYSQL_USER']) ?? '';
  const password = pick(env, ['DB_PASSWORD', 'DB_PASS', 'DATABASE_PASSWORD', 'POSTGRES_PASSWORD', 'PGPASSWORD', 'MYSQL_PASSWORD']) ?? '';
  const port = pick(env, ['DB_PORT', 'DATABASE_PORT', 'POSTGRES_PORT', 'PGPORT', 'MYSQL_PORT']);
  const hint = (pick(env, ['DB_CONNECTION', 'DB_DIALECT', 'DB_TYPE', 'DB_CLIENT', 'DB_DRIVER', 'DATABASE_TYPE', 'TYPEORM_CONNECTION']) ?? '').toLowerCase();
  const kind = /pg|postgres/.test(hint) || port == 5432 || env.POSTGRES_HOST || env.PGHOST ? 'postgres'
    : /mysql|maria/.test(hint) || port == 3306 || env.MYSQL_HOST ? 'mysql'
    : /mssql|sqlsrv|sqlserver|tedious/.test(hint) || port == 1433 ? 'mssql'
    : /mongo/.test(hint) || port == 27017 ? 'mongodb' : 'postgres';
  const via = 'DB_* env';
  if (kind === 'postgres') return { type: kind, url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port ?? 5432}/${database}`, via };
  if (kind === 'mysql') return { type: kind, config: { host, port: +(port ?? 3306), user, password, database }, via };
  if (kind === 'mongodb') return { type: kind, url: `mongodb://${user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : ''}${host}:${port ?? 27017}/${database}`, via };
  const instanceName = pick(env, ['DB_INSTANCE']);
  return { type: 'mssql', config: { server: host, port: port ? +port : undefined, user, password, database, options: { instanceName, encrypt: !/false/i.test(env.DB_ENCRYPT ?? 'true'), trustServerCertificate: true } }, via };
}

function walk(dir, test, depth, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(p, test, depth - 1, out); }
    else if (test(p)) out.push(p);
  }
  return out;
}

const SQLITE_MAGIC = 'SQLite format 3\0';
function isSqlite(p) {
  try {
    const fd = openSync(p, 'r'); const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0); closeSync(fd);
    return buf.toString('latin1') === SQLITE_MAGIC;
  } catch { return false; }
}

export function detectAll(projectDir) {
  const cwd = resolve(projectDir);
  const found = [];
  const add = (s, via) => { if (s && !found.some((f) => JSON.stringify({ ...f, via: 0 }) === JSON.stringify({ ...s, via: 0 }))) found.push({ ...s, via: s.via ?? via }); };

  const cfgPath = join(cwd, '.dbscope', 'config.json');
  if (existsSync(cfgPath)) {
    try { const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); if (cfg.db) add(sourceFromString(cfg.db, cwd), '.dbscope/config.json'); } catch {}
  }
  add(fromEnv(process.env, cwd), 'process env');

  const mergedEnv = { ...process.env };
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local', 'backend/.env', 'server/.env', 'api/.env', '.env.example']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    const vars = parseDotenv(readFileSync(p, 'utf8'));
    add(fromEnv(vars, cwd), name);
    if (name !== '.env.example') for (const [k, v] of Object.entries(vars)) mergedEnv[k] ??= v;
  }
  for (const [str, via] of frameworkSources(cwd, mergedEnv, walk)) { try { add(sourceFromString(str, cwd), via); } catch {} }

  for (const p of walk(cwd, (f) => /appsettings(\.\w+)?\.json$/i.test(f), 4)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\/\/.*$/gm, ''));
      for (const [k, v] of Object.entries(j.ConnectionStrings ?? {})) add(sourceFromString(v, cwd), `${relative(cwd, p)}:${k}`);
    } catch {}
  }
  for (const p of walk(cwd, (f) => basename(f) === 'schema.prisma', 4)) add({ type: 'prisma', file: p }, relative(cwd, p));

  for (const p of walk(cwd, (f) => /\.json$/i.test(f) && /(adminsdk|service[-_]?account|firebase.*key|credentials)/i.test(basename(f)), 3)) add(firestoreFromKeyFile(p), relative(cwd, p));
  if (existsSync(join(cwd, '.firebaserc'))) {
    try { const pid = JSON.parse(readFileSync(join(cwd, '.firebaserc'), 'utf8')).projects?.default; if (pid) add({ type: 'firestore', projectId: pid }, '.firebaserc'); } catch {}
  }

  const testy = (f) => /(^|\/)(e2e|tests?|spec|fixtures?|samples?|backups?|tmp|temp)(\/|$)|backup|\.bak/i.test(relative(cwd, f));
  walk(cwd, (f) => /\.(db|sqlite|sqlite3|db3)$/i.test(f), 4).filter(isSqlite)
    .sort((a, b) => testy(a) - testy(b) || statSync(b).size - statSync(a).size)
    .forEach((p) => add({ type: 'sqlite', file: p }, relative(cwd, p)));

  const sqlFiles = walk(cwd, (f) => extname(f).toLowerCase() === '.sql', 5)
    .filter((f) => /create\s+table/i.test(readFileSync(f, 'utf8').slice(0, 2_000_000)));
  if (sqlFiles.length) add({ type: 'sql', files: sqlFiles }, `${sqlFiles.length} .sql file(s)`);

  return found;
}

export function detect(projectDir, explicit) {
  if (explicit) {
    const s = sourceFromString(explicit, projectDir);
    if (!s) throw new Error(`Bağlantı anlaşılamadı: ${explicit}`);
    return { ...s, via: 'argument' };
  }
  return detectAll(projectDir)[0] ?? null;
}

export function describeSource(s) {
  if (!s) return 'none';
  const mask = (u) => u.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@');
  if (s.url) return `${s.type} ${mask(s.url)}`;
  if (s.file) return `${s.type} ${s.file}`;
  if (s.type === 'firestore') return `firestore project=${s.projectId ?? '(default)'}${s.keyFile ? ' key=' + basename(s.keyFile) : ''}`;
  if (s.type === 'code') return `code models in ${basename(s.dir)}`;
  if (s.files) return `${s.type} (${s.files.length} files)`;
  if (s.config) return `${s.type} ${s.config.user ?? ''}@${s.config.host ?? s.config.server}/${s.config.database}`;
  return s.type;
}
