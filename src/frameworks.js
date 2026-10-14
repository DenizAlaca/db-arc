import { readFileSync, existsSync } from 'node:fs';
import { join, relative, basename, resolve } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const enc = encodeURIComponent;

export function jdbcToUrl(jdbc, user, password) {
  const s = String(jdbc).trim().replace(/^jdbc:/i, '');
  const auth = user ? `${enc(user)}:${enc(password ?? '')}@` : '';
  let m;
  if ((m = /^(postgresql|postgres):\/\/([^/?]+)\/([^?;]+)(\?.*)?$/i.exec(s))) {
    const q = new URLSearchParams((m[4] ?? '').slice(1));
    const u = user ?? q.get('user'), p = password ?? q.get('password');
    return `postgres://${u ? `${enc(u)}:${enc(p ?? '')}@` : ''}${m[2]}/${m[3]}`;
  }
  if ((m = /^(mysql|mariadb):\/\/([^/?]+)\/([^?;]+)(\?.*)?$/i.exec(s))) {
    const q = new URLSearchParams((m[4] ?? '').slice(1));
    const u = user ?? q.get('user'), p = password ?? q.get('password');
    return `mysql://${u ? `${enc(u)}:${enc(p ?? '')}@` : ''}${m[2]}/${m[3]}`;
  }
  if ((m = /^sqlserver:\/\/([^;]+);(.*)$/i.exec(s))) {
    const kv = Object.fromEntries(m[2].split(';').filter(Boolean).map((x) => x.split('=')).map(([k, v]) => [k.toLowerCase(), v]));
    const u = user ?? kv.user, p = password ?? kv.password;
    return `sqlserver://${u ? `${enc(u)}:${enc(p ?? '')}@` : ''}${m[1]}/${kv.databasename ?? kv.database ?? ''}`;
  }
  if ((m = /^oracle:thin:@\/{0,2}([^/:]+)(?::(\d+))?[/:](.+)$/i.exec(s))) return `oracle://${auth}${m[1]}:${m[2] ?? 1521}/${m[3]}`;
  if ((m = /^sqlite:(.+)$/i.exec(s))) return m[1];
  if ((m = /^clickhouse:\/\/(.+)$/i.exec(s))) return `clickhouse://${auth}${m[1]}`;
  return null;
}

function envRef(expr, env) {
  const e = String(expr).trim();
  let m;
  if ((m = /^['"](.*)['"]$/.exec(e))) return m[1];
  if ((m = /(?:os\.environ\.get|os\.getenv|env|config|getenv|env\.str|env\.int)\(\s*['"]([A-Z0-9_]+)['"](?:\s*,\s*(?:default\s*=\s*)?['"]?([^'")]*)['"]?)?/i.exec(e))) return env[m[1]] ?? m[2] ?? null;
  if ((m = /os\.environ\[['"]([A-Z0-9_]+)['"]\]/.exec(e))) return env[m[1]] ?? null;
  if ((m = /ENV(?:\.fetch\(\s*|\[)['"]([A-Z0-9_]+)['"]\]?\)?(?:\s*\{\s*['"]([^'"]*)['"]\s*\}|\s*,\s*['"]([^'"]*)['"])?/.exec(e))) return env[m[1]] ?? m[2] ?? m[3] ?? null;
  if ((m = /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/.exec(e))) return env[m[1]] ?? m[2] ?? null;
  if ((m = /System\.get_env\(\s*"([A-Z0-9_]+)"\s*\)(?:\s*\|\|\s*"([^"]*)")?/.exec(e))) return env[m[1]] ?? m[2] ?? null;
  if (/^[\w.\-/:@]+$/.test(e)) return e;
  return null;
}

const build = (kind, { host, port, user, password, database }) => {
  if (!database) return null;
  const auth = user ? `${enc(user)}:${enc(password ?? '')}@` : '';
  const h = host || 'localhost';
  if (/postgres|psql|pg/i.test(kind)) return `postgres://${auth}${h}:${port || 5432}/${database}`;
  if (/mysql|maria/i.test(kind)) return `mysql://${auth}${h}:${port || 3306}/${database}`;
  if (/mssql|sqlserver|sql_server|tds/i.test(kind)) return `sqlserver://${auth}${h}:${port || 1433}/${database}`;
  if (/oracle/i.test(kind)) return `oracle://${auth}${h}:${port || 1521}/${database}`;
  if (/mongo/i.test(kind)) return `mongodb://${auth}${h}:${port || 27017}/${database}`;
  if (/sqlite/i.test(kind)) return database;
  return null;
};

function django(cwd, env, files) {
  const out = [];
  for (const p of files.filter((f) => /settings(\/[\w.]+)?\.py$|settings\.py$/.test(f))) {
    const src = read(p);
    const block = /DATABASES\s*=\s*\{([\s\S]*?)\n\}/.exec(src)?.[1];
    if (!block) continue;
    if (/dj_database_url/.test(block)) { const v = env.DATABASE_URL; if (v) out.push([v, relative(cwd, p)]); continue; }
    const get = (k) => { const m = new RegExp(`['"]${k}['"]\\s*:\\s*([^\\n]+?),?\\s*$`, 'm').exec(block); return m ? envRef(m[1], env) : null; };
    const engine = get('ENGINE') ?? '';
    let database = get('NAME');
    if (/sqlite/.test(engine)) { const f = /['"]([\w.\-/]+\.sqlite3?)['"]/.exec(block)?.[1] ?? 'db.sqlite3'; database = resolve(cwd, f); }
    const url = build(engine, { host: get('HOST'), port: get('PORT'), user: get('USER'), password: get('PASSWORD'), database });
    if (url) out.push([url, relative(cwd, p)]);
  }
  return out;
}

function rails(cwd, env) {
  const p = join(cwd, 'config', 'database.yml');
  if (!existsSync(p)) return [];
  const src = read(p).replace(/<%=\s*([\s\S]*?)\s*%>/g, (_, x) => envRef(x, env) ?? '');
  const sections = {};
  let cur = null;
  for (const line of src.split('\n')) {
    let m;
    if ((m = /^([\w-]+):/.exec(line))) { cur = m[1]; sections[cur] = {}; continue; }
    if (cur && (m = /^\s+([\w-]+):\s*(.+?)\s*$/.exec(line))) sections[cur][m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    if (cur && (m = /^\s+<<:\s*\*(\w+)/.exec(line))) sections[cur].__inherit = m[1];
  }
  const anchors = {};
  for (const line of src.split('\n')) { const m = /^([\w-]+):\s*&(\w+)/.exec(line); if (m) anchors[m[2]] = m[1]; }
  const resolveSec = (name) => { const s = sections[name] ?? {}; return s.__inherit ? { ...resolveSec(anchors[s.__inherit]), ...s } : s; };
  const d = resolveSec(sections.development ? 'development' : Object.keys(sections)[0]);
  if (d.url) return [[d.url, 'config/database.yml']];
  const database = /sqlite/.test(d.adapter ?? '') && d.database ? resolve(cwd, d.database) : d.database;
  const url = build(d.adapter ?? '', { host: d.host, port: d.port, user: d.username, password: d.password, database });
  return url ? [[url, 'config/database.yml']] : [];
}

function spring(cwd, env, files) {
  const out = [];
  for (const p of files.filter((f) => /application(-\w+)?\.(properties|ya?ml)$/.test(f))) {
    const src = read(p);
    const val = (k) => {
      const prop = new RegExp(`^spring\\.datasource\\.${k}\\s*[=:]\\s*(.+)$`, 'm').exec(src)?.[1];
      if (prop) return envRef(prop.trim(), env);
      const ds = /datasource:\s*\n((?:[ \t]+.+\n?)+)/.exec(src)?.[1];
      const y = ds && new RegExp(`^\\s+${k}:\\s*(.+)$`, 'm').exec(ds)?.[1];
      return y ? envRef(y.trim().replace(/^['"]|['"]$/g, ''), env) : null;
    };
    const url = val('url');
    if (url) { const u = jdbcToUrl(url, val('username'), val('password')); if (u) out.push([u, relative(cwd, p)]); }
    const mongo = /spring\.data\.mongodb\.uri\s*[=:]\s*(.+)/.exec(src)?.[1] ?? /mongodb:\s*\n\s+uri:\s*(.+)/.exec(src)?.[1];
    if (mongo) { const v = envRef(mongo.trim(), env); if (v) out.push([v, relative(cwd, p)]); }
  }
  return out;
}

function elixir(cwd, env, files) {
  const out = [];
  for (const p of files.filter((f) => /config\/(dev|config|runtime)\.exs$/.test(f))) {
    const src = read(p);
    const block = /config\s+:\w+,\s*[\w.]+Repo,([\s\S]*?)(?:\n\n|\nconfig\s)/.exec(src)?.[1];
    if (!block) continue;
    const get = (k) => { const m = new RegExp(`${k}:\\s*([^,\\n]+)`).exec(block); return m ? envRef(m[1], env) : null; };
    if (get('url')) { out.push([get('url'), relative(cwd, p)]); continue; }
    const adapter = /Ecto\.Adapters\.(\w+)/.exec(src)?.[1] ?? 'Postgres';
    const url = build(adapter.replace('MyXQL', 'mysql').replace('Tds', 'mssql').replace('SQLite3', 'sqlite'), { host: get('hostname'), port: get('port'), user: get('username'), password: get('password'), database: get('database') });
    if (url) out.push([url, relative(cwd, p)]);
  }
  return out;
}

function nodeConfigs(cwd, env) {
  const out = [];
  const tryJson = (p, pick) => { try { const j = JSON.parse(read(p)); pick(j); } catch {} };
  for (const name of ['ormconfig.json', 'config/ormconfig.json']) {
    const p = join(cwd, name);
    if (existsSync(p)) tryJson(p, (j) => [].concat(j).forEach((c) => {
      const url = c.url ?? build(c.type ?? '', { host: c.host, port: c.port, user: c.username, password: c.password, database: c.database });
      if (url) out.push([url, name]);
    }));
  }
  for (const name of ['config/config.json', 'config/database.json']) {
    const p = join(cwd, name);
    if (existsSync(p)) tryJson(p, (j) => {
      const c = j.development ?? j.dev ?? j;
      if (c.use_env_variable && env[c.use_env_variable]) out.push([env[c.use_env_variable], name]);
      const url = build(c.dialect ?? c.driver ?? '', { host: c.host, port: c.port, user: c.username ?? c.user, password: c.password, database: c.database ?? c.storage });
      if (url) out.push([url, name]);
    });
  }
  return out;
}

const COMPOSE_IMAGES = [
  [/postgres|postgis|timescale|supabase\/postgres/, 'postgres', 5432],
  [/mysql|mariadb|percona/, 'mysql', 3306],
  [/mssql|sql-server|azure-sql-edge/, 'mssql', 1433],
  [/mongo/, 'mongodb', 27017],
  [/redis|valkey|keydb/, 'redis', 6379],
  [/clickhouse/, 'clickhouse', 8123],
  [/neo4j/, 'neo4j', 7687],
  [/cassandra|scylla/, 'cassandra', 9042],
  [/elasticsearch|opensearch/, 'elasticsearch', 9200],
  [/dynamodb-local/, 'dynamodb', 8000],
  [/oracle|gvenzl/, 'oracle', 1521],
];

function compose(cwd, env) {
  const out = [];
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'docker-compose.dev.yml']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    const src = read(p).replace(/\$\{([A-Z0-9_]+)(?::?-([^}]*))?\}/g, (_, k, d) => env[k] ?? d ?? '');
    const services = src.split(/\n(?=  [\w-]+:\s*\n)/).slice(1);
    for (const svc of services) {
      const image = /image:\s*['"]?([^\s'"]+)/.exec(svc)?.[1] ?? '';
      const hit = COMPOSE_IMAGES.find(([re]) => re.test(image));
      if (!hit) continue;
      const [, kind, inner] = hit;
      const portM = new RegExp(`['"]?(?:[\\d.]+:)?(\\d+):${inner}['"]?`).exec(svc);
      const port = portM?.[1] ?? inner;
      const ev = (k) => new RegExp(`${k}\\s*[:=]\\s*['"]?([^'"\\n]+)`).exec(svc)?.[1]?.trim();
      const svcName = /^\s*([\w-]+):/.exec(svc)?.[1];
      let url = null;
      if (kind === 'postgres') url = `postgres://${enc(ev('POSTGRES_USER') ?? 'postgres')}:${enc(ev('POSTGRES_PASSWORD') ?? '')}@localhost:${port}/${ev('POSTGRES_DB') ?? ev('POSTGRES_USER') ?? 'postgres'}`;
      else if (kind === 'mysql') { const db = ev('MYSQL_DATABASE') ?? ev('MARIADB_DATABASE'); if (db) url = `mysql://${ev('MYSQL_USER') ? enc(ev('MYSQL_USER')) + ':' + enc(ev('MYSQL_PASSWORD') ?? '') : 'root:' + enc(ev('MYSQL_ROOT_PASSWORD') ?? ev('MARIADB_ROOT_PASSWORD') ?? '')}@localhost:${port}/${db}`; }
      else if (kind === 'mssql') url = `sqlserver://sa:${enc(ev('MSSQL_SA_PASSWORD') ?? ev('SA_PASSWORD') ?? '')}@localhost:${port}/master`;
      else if (kind === 'mongodb') url = `mongodb://${ev('MONGO_INITDB_ROOT_USERNAME') ? enc(ev('MONGO_INITDB_ROOT_USERNAME')) + ':' + enc(ev('MONGO_INITDB_ROOT_PASSWORD') ?? '') + '@' : ''}localhost:${port}/${ev('MONGO_INITDB_DATABASE') ?? 'test'}${ev('MONGO_INITDB_ROOT_USERNAME') ? '?authSource=admin' : ''}`;
      else if (kind === 'redis') url = `redis://localhost:${port}`;
      else if (kind === 'clickhouse') url = `clickhouse://${enc(ev('CLICKHOUSE_USER') ?? 'default')}:${enc(ev('CLICKHOUSE_PASSWORD') ?? '')}@localhost:${port}/${ev('CLICKHOUSE_DB') ?? 'default'}`;
      else if (kind === 'neo4j') { const [u, pw] = (ev('NEO4J_AUTH') ?? 'neo4j/neo4j').split('/'); url = `bolt://${enc(u)}:${enc(pw ?? '')}@localhost:${port}`; }
      else if (kind === 'cassandra') url = `cassandra://localhost:${port}`;
      else if (kind === 'elasticsearch') url = `elasticsearch://localhost:${port}`;
      else if (kind === 'dynamodb') url = `dynamodb://localhost:${port}`;
      if (url) out.push([url, `${name}:${svcName}`]);
    }
  }
  return out;
}

export function frameworkSources(cwd, env, walk) {
  const files = walk(cwd, (f) => /settings(\/[\w.]+)?\.py$|application(-\w+)?\.(properties|ya?ml)$|config\/(dev|config|runtime)\.exs$/.test(f), 6);
  return [...django(cwd, env, files), ...rails(cwd, env), ...spring(cwd, env, files), ...elixir(cwd, env, files), ...nodeConfigs(cwd, env), ...compose(cwd, env)];
}
