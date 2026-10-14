import { SAMPLE_COL_RE } from './common.js';

export async function introspect({ url, samples = true }) {
  const { default: pg } = await import('pg').catch(() => { throw new Error('PostgreSQL için "pg" paketi gerekli: npm i pg'); });
  const client = new pg.Client({ connectionString: url, statement_timeout: 15000, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const q = async (sql, p) => (await client.query(sql, p)).rows;
  try {
    const schemaFilter = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%'`;
    const rels = await q(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind, c.reltuples::bigint AS rows,
             obj_description(c.oid) AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND ${schemaFilter} AND NOT c.relispartition ORDER BY 2,3`);
    const cols = await q(`
      SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
             col_description(a.attrelid,a.attnum) AS comment, t.typtype, t.oid AS typoid
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
      WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') AND ${schemaFilter} ORDER BY a.attrelid, a.attnum`);
    const cons = await q(`
      SELECT con.conrelid AS oid, con.contype, con.conname,
             ARRAY(SELECT attname FROM unnest(con.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.n ORDER BY o)::text[] AS cols,
             rn.nspname AS ref_schema, rc.relname AS ref_table,
             ARRAY(SELECT attname FROM unnest(con.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.n ORDER BY o)::text[] AS ref_cols
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class rc ON rc.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
      WHERE con.contype IN ('p','f') AND ${schemaFilter}`);
    const enums = await q(`SELECT enumtypid AS typoid, array_agg(enumlabel::text ORDER BY enumsortorder) AS labels FROM pg_enum GROUP BY 1`);
    const enumMap = new Map(enums.map((e) => [e.typoid, e.labels]));
    const multiSchema = new Set(rels.map((r) => r.schema)).size > 1;
    const nameOf = (schema, name) => (multiSchema && schema !== 'public' ? `${schema}.${name}` : name);

    const byOid = new Map();
    for (const r of rels) {
      byOid.set(r.oid, { name: nameOf(r.schema, r.name), schema: r.schema, rawName: r.name, kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table', comment: r.comment || undefined, columns: [], pk: [], fks: [], rows: Number(r.rows), samples: {} });
    }
    for (const c of cols) {
      const t = byOid.get(c.oid); if (!t) continue;
      t.columns.push({ name: c.name, type: c.type, nullable: c.nullable, pk: false, comment: c.comment || undefined });
      if (enumMap.has(c.typoid)) t.samples[c.name] = enumMap.get(c.typoid);
    }
    for (const c of cons) {
      const t = byOid.get(c.oid); if (!t) continue;
      if (c.contype === 'p') { t.pk = c.cols; for (const col of t.columns) if (c.cols.includes(col.name)) col.pk = true; }
      else t.fks.push({ columns: c.cols, refTable: nameOf(c.ref_schema, c.ref_table), refColumns: c.ref_cols });
    }
    const tables = [...byOid.values()];
    for (const t of tables) {
      if (t.rows >= 0 || t.kind !== 'table') { if (t.rows < 0) t.rows = null; continue; }
      try { t.rows = Number((await q(`SELECT count(*) AS n FROM (SELECT 1 FROM "${t.schema}"."${t.rawName}" LIMIT 100001) x`))[0].n); } catch { t.rows = null; }
    }
    if (samples) {
      for (const t of tables) {
        if (t.kind !== 'table' || !t.rows || t.rows > 2_000_000) continue;
        for (const c of t.columns) {
          if (t.samples[c.name] || c.pk || !SAMPLE_COL_RE.test(c.name) || !/char|text/.test(c.type)) continue;
          try {
            const vals = await q(`SELECT "${c.name}" AS v FROM "${t.schema}"."${t.rawName}" WHERE "${c.name}" IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 9`);
            if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((r) => r.v);
          } catch {}
        }
      }
    }
    for (const t of tables) { delete t.rawName; }
    const db = (await q('SELECT current_database() AS d'))[0].d;
    return { dialect: 'postgres', database: db, tables };
  } finally {
    await client.end().catch(() => {});
  }
}
