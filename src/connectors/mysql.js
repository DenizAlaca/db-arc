import { SAMPLE_COL_RE } from './common.js';

export async function introspect({ url, config, samples = true }) {
  const mysql = await import('mysql2/promise').catch(() => { throw new Error('MySQL için "mysql2" paketi gerekli: npm i mysql2'); });
  const conn = url ? await mysql.createConnection(url) : await mysql.createConnection(config);
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  try {
    const db = (await q('SELECT DATABASE() AS d'))[0].d;
    if (!db) throw new Error('MySQL bağlantısında veritabanı adı yok');
    const rels = await q(`SELECT TABLE_NAME n, TABLE_TYPE t, TABLE_ROWS r, TABLE_COMMENT c FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY 1`, [db]);
    const cols = await q(`SELECT TABLE_NAME t, COLUMN_NAME n, COLUMN_TYPE ty, IS_NULLABLE nl, COLUMN_KEY k, COLUMN_COMMENT c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
    const fks = await q(`SELECT TABLE_NAME t, CONSTRAINT_NAME cn, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY t, cn, ORDINAL_POSITION`, [db]);
    const map = new Map(rels.map((r) => [r.n, { name: r.n, kind: r.t === 'VIEW' ? 'view' : 'table', comment: r.c || undefined, columns: [], pk: [], fks: [], rows: Number(r.r ?? 0), samples: {} }]));
    for (const c of cols) {
      const t = map.get(c.t); if (!t) continue;
      const pk = c.k === 'PRI';
      t.columns.push({ name: c.n, type: c.ty, nullable: c.nl === 'YES', pk, comment: c.c || undefined });
      if (pk) t.pk.push(c.n);
      const en = /^enum\((.*)\)$/i.exec(c.ty);
      if (en) t.samples[c.n] = en[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    }
    const fkMap = new Map();
    for (const f of fks) {
      const key = f.t + '|' + f.cn;
      if (!fkMap.has(key)) { const e = { columns: [], refTable: f.rt, refColumns: [] }; fkMap.set(key, e); map.get(f.t)?.fks.push(e); }
      fkMap.get(key).columns.push(f.c); fkMap.get(key).refColumns.push(f.rc);
    }
    const tables = [...map.values()];
    if (samples) for (const t of tables) {
      if (t.kind !== 'table' || !t.rows || t.rows > 2_000_000) continue;
      for (const c of t.columns) {
        if (t.samples[c.name] || c.pk || !SAMPLE_COL_RE.test(c.name) || !/char|text/i.test(c.type)) continue;
        try {
          const vals = await q(`SELECT \`${c.name}\` v FROM \`${t.name}\` WHERE \`${c.name}\` IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 9`);
          if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((r) => r.v);
        } catch {}
      }
    }
    return { dialect: 'mysql', database: db, tables };
  } finally {
    await conn.end().catch(() => {});
  }
}
