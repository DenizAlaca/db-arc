import { SAMPLE_COL_RE, isTextish } from './common.js';

export function parseLibsqlUrl(url) {
  const u = new URL(String(url));
  const authToken = u.searchParams.get('authToken') || u.searchParams.get('auth_token') || process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || undefined;
  u.searchParams.delete('authToken'); u.searchParams.delete('auth_token');
  return { url: u.toString().replace(/\?$/, ''), authToken, name: u.hostname.split('.')[0] || u.hostname };
}

export async function introspect({ url, config, samples = true }) {
  const { createClient } = await import('@libsql/client').catch(() => { throw new Error('libSQL/Turso için "@libsql/client" paketi gerekli: npm i @libsql/client'); });
  const cfg = config ?? parseLibsqlUrl(url);
  const client = createClient({ url: cfg.url, authToken: cfg.authToken });
  const q = async (sql) => (await client.execute(sql)).rows;
  const id = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  try {
    const tables = [];
    const names = await q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '__EFMigrations%' ORDER BY name");
    for (const { name, type } of names) {
      const cols = await q(`PRAGMA table_info(${id(name)})`);
      const fks = await q(`PRAGMA foreign_key_list(${id(name)})`);
      const byId = new Map();
      for (const f of fks) {
        if (!byId.has(f.id)) byId.set(f.id, { columns: [], refTable: f.table, refColumns: [] });
        const e = byId.get(f.id);
        e.columns.push(f.from);
        if (f.to) e.refColumns.push(f.to);
      }
      let rows = null;
      try { rows = Number((await q(`SELECT COUNT(*) AS n FROM ${id(name)}`))[0].n); } catch {}
      const t = {
        name, kind: type,
        columns: cols.map((c) => ({ name: c.name, type: c.type || 'ANY', nullable: !Number(c.notnull), pk: Number(c.pk) > 0 })),
        pk: cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name),
        fks: [...byId.values()],
        rows,
        samples: {},
      };
      if (samples && rows) {
        for (const c of t.columns) {
          if (!SAMPLE_COL_RE.test(c.name) || c.pk) continue;
          try {
            const vals = await q(`SELECT ${id(c.name)} AS v, COUNT(*) AS n FROM ${id(name)} WHERE ${id(c.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 9`);
            if (vals.length && vals.length < 9 && (isTextish(c.type) || vals.length <= 8)) t.samples[c.name] = vals.map((r) => r.v);
          } catch {}
        }
      }
      tables.push(t);
    }
    return { dialect: 'libsql', database: cfg.name, tables };
  } finally {
    client.close();
  }
}
