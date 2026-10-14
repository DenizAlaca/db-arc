import { stripComments, kv, unq, strList, snake, plural, singular, mkTable, addCol, addFk, finalize, falsy } from './util.js';

export default {
  id: 'ecto',
  want: (rel, ext) => ext === '.ex' || ext === '.exs',
  detect: /\bschema\s+"\w+"\s+do\b/,
  keep: /\bschema\s+"/,
  parse(files) {
    const mods = [];
    for (const f of files) {
      const src = stripComments(f.src, { slash: false, block: false, hash: true });
      for (const m of src.matchAll(/defmodule\s+([\w.]+)\s+do\b/g)) {
        const next = src.indexOf('defmodule ', m.index + 10);
        const seg = src.slice(m.index, next < 0 ? src.length : next);
        const sm = /^([ \t]*)schema\s+"(\w+)"\s+do\b/m.exec(seg);
        if (!sm) continue;
        const lines = seg.slice(sm.index + sm[0].length).split('\n').slice(1);
        const end = lines.findIndex((l) => new RegExp(`^${sm[1]}end\\b`).test(l));
        mods.push({ mod: m[1], short: m[1].split('.').pop(), table: sm[2], pre: seg.slice(0, sm.index), body: lines.slice(0, end < 0 ? lines.length : end), file: f });
      }
    }
    const tableOf = (mod) => { const s = mod.replace(/^__MODULE__$/, ''); return mods.find((x) => x.mod === s || x.short === s.split('.').pop())?.table ?? plural(snake(s.split('.').pop())); };
    const tables = [], used = new Set();
    for (const md of mods) {
      const t = mkTable(md.table);
      const pkAttr = /@primary_key\s+(false|\{[^}]*\})/.exec(md.pre)?.[1];
      const fkType = /@foreign_key_type\s+:?(\w+)/.exec(md.pre)?.[1] ?? 'id';
      if (pkAttr === undefined) addCol(t, 'id', 'id', false, true);
      else if (pkAttr !== 'false') { const p = /\{\s*:(\w+)\s*,\s*:?([\w.]+)/.exec(pkAttr); if (p) addCol(t, p[1], p[2], false, true); }
      const stmts = [];
      for (const l of md.body) { if (/^\s*(field|belongs_to|has_many|has_one|many_to_many|timestamps|embeds_one|embeds_many)\b/.test(l)) stmts.push(l.trim()); else if (stmts.length && /^\s+[\w\[\]:,"'\s]/.test(l) && l.trim() && !/^\s*end\b/.test(l)) stmts[stmts.length - 1] += ' ' + l.trim(); }
      for (const s of stmts) {
        let m;
        if ((m = /^field\s*\(?\s*:(\w+)\s*(?:,\s*([\s\S]*?))?\)?\s*$/.exec(s))) {
          const { pos, named } = kv(m[2] ?? '');
          const type = pos[0] ? pos[0].trim().replace(/^:/, '') : 'string';
          addCol(t, named.source ? unq(named.source) : m[1], type, true, named.primary_key === 'true');
          if (/Ecto\.Enum/.test(type) && named.values) t.samples[m[1]] = /^\[/.test(named.values.trim()) ? strList(named.values.replace(/:\s*\d+/g, '')).filter((x) => x) : [];
          continue;
        }
        if ((m = /^belongs_to\s*\(?\s*:(\w+)\s*,\s*([\w.]+)\s*(?:,\s*([\s\S]*?))?\)?\s*$/.exec(s))) {
          const { named } = kv(m[3] ?? '');
          const col = named.foreign_key ? unq(named.foreign_key) : `${m[1]}_id`;
          if (!falsy(named.define_field)) addCol(t, col, named.type ? unq(named.type) : fkType, true, named.primary_key === 'true');
          addFk(t, col, tableOf(m[2]), [named.references ? unq(named.references) : 'id']);
          continue;
        }
        if ((m = /^many_to_many\s*\(?\s*:(\w+)\s*,\s*([\w.]+)\s*,\s*([\s\S]*?)\)?\s*$/.exec(s))) {
          const { named } = kv(m[3]);
          const jt = named.join_through;
          if (!jt || !/^"/.test(jt.trim())) continue;
          const j = mkTable(unq(jt));
          const keys = [...String(named.join_keys ?? '').matchAll(/(\w+):/g)].map((x) => x[1]);
          const a = keys[0] ?? `${snake(md.short)}_id`, b = keys[1] ?? `${singular(m[1])}_id`;
          addCol(j, a, 'id', false, true); addCol(j, b, 'id', false, true);
          addFk(j, a, md.table); addFk(j, b, tableOf(m[2]));
          if (!tables.some((x) => x.name === j.name) && !mods.some((x) => x.table === j.name)) tables.push(j);
          continue;
        }
        if ((m = /^timestamps\b\s*\(?([\s\S]*?)\)?$/.exec(s))) {
          const { named } = kv(m[1]);
          const type = named.type ? unq(named.type) : 'naive_datetime';
          addCol(t, named.inserted_at ? unq(named.inserted_at) : 'inserted_at', type, false);
          addCol(t, named.updated_at ? unq(named.updated_at) : 'updated_at', type, false);
          continue;
        }
        if ((m = /^embeds_(one|many)\s*\(?\s*:(\w+)/.exec(s))) addCol(t, m[2], m[1] === 'one' ? 'map' : '{:array, :map}', true);
      }
      tables.push(t);
      used.add(md.file.path);
    }
    return { tables: tables.map(finalize), used };
  },
};
