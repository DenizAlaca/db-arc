import { readFileSync } from 'node:fs';

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

export async function introspect({ file }) {
  const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
  const enums = new Map();
  for (const m of src.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) enums.set(m[1], m[2].split(/\s+/).filter((w) => /^\w+$/.test(w)));
  const models = [...src.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)];
  const mapName = new Map(models.map(([, n, body]) => [n, /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? n]));
  const tables = [];
  const fieldCols = new Map();
  for (const [, model, body] of models) {
    const t = { name: mapName.get(model), kind: 'table', columns: [], pk: [], fks: [], rows: null, samples: {} };
    const fmap = new Map(); fieldCols.set(t.name, fmap);
    for (const line of body.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('@@id')) { t.pk = /\[([^\]]+)\]/.exec(line)?.[1].split(',').map((s) => s.trim()) ?? []; continue; }
      if (line.startsWith('@@')) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, field, type, list, opt, attrs] = m;
      const rel = /@relation\(([^)]*)\)/.exec(attrs);
      if (rel || list || (!SCALARS.has(type) && !enums.has(type))) {
        const fields = /fields:\s*\[([^\]]+)\]/.exec(rel?.[1] ?? '')?.[1];
        const refs = /references:\s*\[([^\]]+)\]/.exec(rel?.[1] ?? '')?.[1];
        if (fields) t.fks.push({ columns: fields.split(',').map((s) => s.trim()), refTable: mapName.get(type) ?? type, refColumns: refs?.split(',').map((s) => s.trim()) ?? [] });
        continue;
      }
      const col = /@map\("([^"]+)"\)/.exec(attrs)?.[1] ?? field;
      fmap.set(field, col);
      const pk = /@id\b/.test(attrs);
      t.columns.push({ name: col, type: enums.has(type) ? `enum ${type}` : type, nullable: !!opt, pk });
      if (pk) t.pk.push(col);
      if (enums.has(type)) t.samples[col] = enums.get(type);
    }
    tables.push(t);
  }
  for (const t of tables) {
    const own = fieldCols.get(t.name);
    t.pk = t.pk.map((f) => own.get(f) ?? f);
    for (const fk of t.fks) {
      fk.columns = fk.columns.map((f) => own.get(f) ?? f);
      fk.refColumns = fk.refColumns.map((f) => fieldCols.get(fk.refTable)?.get(f) ?? f);
    }
  }
  return { dialect: 'prisma', database: file.split('/').slice(-2).join('/'), tables };
}
