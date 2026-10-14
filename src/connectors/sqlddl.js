import { readFileSync } from 'node:fs';

const unq = (s) => s.trim().replace(/^[`"\[]|[`"\]]$/g, '').split('.').pop().replace(/^[`"\[]|[`"\]]$/g, '');

function splitTopLevel(body) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

function findBody(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start + 1, i);
  }
  return '';
}

export async function introspect({ files }) {
  const map = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8').replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w.]+)\s*\(/gi)) {
      const name = unq(m[1]);
      const t = map.get(name) ?? { name, kind: 'table', columns: [], pk: [], fks: [], rows: null, samples: {} };
      map.set(name, t);
      for (const part of splitTopLevel(findBody(src, m.index + m[0].length - 1))) {
        let mm;
        if ((mm = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(part))) { t.pk = mm[1].split(',').map(unq); continue; }
        if ((mm = /^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"\[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(part))) {
          t.fks.push({ columns: mm[1].split(',').map(unq), refTable: unq(mm[2]), refColumns: mm[3]?.split(',').map(unq) ?? [] }); continue;
        }
        if (/^(CONSTRAINT|UNIQUE|KEY|INDEX|CHECK|FULLTEXT|SPATIAL)\b/i.test(part)) continue;
        if ((mm = /^([`"\[\]\w]+)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:unsigned|varying|precision|with(?:out)?\s+time\s+zone))*)(.*)$/is.exec(part))) {
          const col = unq(mm[1]); const rest = mm[3];
          const pk = /PRIMARY\s+KEY/i.test(rest);
          t.columns.push({ name: col, type: mm[2].replace(/\s+/g, ' '), nullable: !/NOT\s+NULL/i.test(rest) && !pk, pk });
          if (pk) t.pk.push(col);
          const ref = /REFERENCES\s+([`"\[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(rest);
          if (ref) t.fks.push({ columns: [col], refTable: unq(ref[1]), refColumns: ref[2]?.split(',').map(unq) ?? [] });
          const en = /^enum\s*\((.*)\)/i.exec(mm[2]);
          if (en) t.samples[col] = en[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
        }
      }
    }
    for (const m of src.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?([`"\[\]\w.]+)[\s\S]*?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"\[\]\w.]+)\s*(?:\(([^)]+)\))?/gi)) {
      const t = map.get(unq(m[1]));
      if (t) t.fks.push({ columns: m[2].split(',').map(unq), refTable: unq(m[3]), refColumns: m[4]?.split(',').map(unq) ?? [] });
    }
  }
  for (const t of map.values()) for (const c of t.columns) if (t.pk.includes(c.name)) c.pk = true;
  return { dialect: 'sql-ddl', database: `${files.length} sql file(s)`, tables: [...map.values()] };
}
