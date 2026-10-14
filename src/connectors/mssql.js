import { SAMPLE_COL_RE } from './common.js';

export async function introspect({ config, samples = true }) {
  const { default: sql } = await import('mssql').catch(() => { throw new Error('SQL Server için "mssql" paketi gerekli: npm i mssql'); });
  const pool = await sql.connect({ options: { trustServerCertificate: true, encrypt: true, ...config.options }, requestTimeout: 30000, ...config });
  const q = async (s) => (await pool.request().query(s)).recordset;
  try {
    const rels = await q(`SELECT o.object_id oid, s.name sch, o.name n, o.type t,
        (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=o.object_id AND p.index_id IN (0,1)) r
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY 2,3`);
    const cols = await q(`SELECT c.object_id oid, c.name n, TYPE_NAME(c.user_type_id) ty, c.max_length ml, c.precision pr, c.scale sc, c.is_nullable nl,
        CASE WHEN EXISTS(SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id=ic.object_id AND i.index_id=ic.index_id
          WHERE i.is_primary_key=1 AND ic.object_id=c.object_id AND ic.column_id=c.column_id) THEN 1 ELSE 0 END pk
      FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY c.object_id, c.column_id`);
    const fks = await q(`SELECT fk.parent_object_id oid, fk.name cn, pc.name c, rs.name rsch, ro.name rt, rc.name rc
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
      JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id
      JOIN sys.objects ro ON ro.object_id=fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=ro.schema_id
      JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id ORDER BY fk.name, fkc.constraint_column_id`);
    const multi = new Set(rels.map((r) => r.sch)).size > 1;
    const nm = (s, n) => (multi && s !== 'dbo' ? `${s}.${n}` : n);
    const map = new Map(rels.map((r) => [r.oid, { name: nm(r.sch, r.n), kind: r.t.trim() === 'V' ? 'view' : 'table', columns: [], pk: [], fks: [], rows: Number(r.r ?? 0), samples: {} }]));
    for (const c of cols) {
      const t = map.get(c.oid); if (!t) continue;
      t.columns.push({ name: c.n, type: /char|binary/.test(c.ty) ? `${c.ty}(${c.ml === -1 ? 'max' : /^n/.test(c.ty) ? c.ml / 2 : c.ml})` : /decimal|numeric/.test(c.ty) ? `${c.ty}(${c.pr},${c.sc})` : c.ty, nullable: !!c.nl, pk: !!c.pk });
      if (c.pk) t.pk.push(c.n);
    }
    const fkMap = new Map();
    for (const f of fks) {
      const key = f.oid + '|' + f.cn;
      if (!fkMap.has(key)) { const e = { columns: [], refTable: nm(f.rsch, f.rt), refColumns: [] }; fkMap.set(key, e); map.get(f.oid)?.fks.push(e); }
      fkMap.get(key).columns.push(f.c); fkMap.get(key).refColumns.push(f.rc);
    }
    const tables = [...map.values()];
    if (samples) for (const t of tables) {
      if (t.kind !== 'table' || !t.rows || t.rows > 2_000_000) continue;
      const [sch, tn] = t.name.includes('.') ? t.name.split('.') : ['dbo', t.name];
      for (const c of t.columns) {
        if (c.pk || !SAMPLE_COL_RE.test(c.name) || !/char|text/i.test(c.type)) continue;
        try {
          const vals = await q(`SELECT TOP 9 [${c.name}] v FROM [${sch}].[${tn}] WHERE [${c.name}] IS NOT NULL GROUP BY [${c.name}] ORDER BY COUNT(*) DESC`);
          if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((r) => r.v);
        } catch {}
      }
    }
    const db = (await q('SELECT DB_NAME() d'))[0].d;
    return { dialect: 'mssql', database: db, tables };
  } finally {
    await pool.close().catch(() => {});
  }
}
