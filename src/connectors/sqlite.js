import { SAMPLE_COL_RE, isTextish } from './common.js';

export async function introspect({ file, samples = true }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const q = (sql) => db.prepare(sql).all();
  const id = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  try {
    const tables = [];
    const names = q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__EFMigrations%' ORDER BY name");
    for (const { name, type } of names) {
      const cols = q(`PRAGMA table_info(${id(name)})`);
      const fks = q(`PRAGMA foreign_key_list(${id(name)})`);
      const byId = new Map();
      for (const f of fks) {
        if (!byId.has(f.id)) byId.set(f.id, { columns: [], refTable: f.table, refColumns: [] });
        const e = byId.get(f.id);
        e.columns.push(f.from);
        if (f.to) e.refColumns.push(f.to);
      }
      let rows = null;
      try { rows = q(`SELECT COUNT(*) AS n FROM ${id(name)}`)[0].n; } catch {}
      const t = {
        name, kind: type,
        columns: cols.map((c) => ({ name: c.name, type: c.type || 'ANY', nullable: !c.notnull, pk: c.pk > 0 })),
        pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
        fks: [...byId.values()],
        rows,
        samples: {},
      };
      if (samples && rows) {
        for (const c of t.columns) {
          if (!SAMPLE_COL_RE.test(c.name) || c.pk) continue;
          try {
            const vals = q(`SELECT ${id(c.name)} AS v, COUNT(*) AS n FROM ${id(name)} WHERE ${id(c.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 9`);
            if (vals.length && vals.length < 9 && (isTextish(c.type) || vals.length <= 8)) t.samples[c.name] = vals.map((r) => r.v);
          } catch {}
        }
      }
      tables.push(t);
    }
    return { dialect: 'sqlite', database: file.split('/').pop(), tables };
  } finally {
    db.close();
  }
}
