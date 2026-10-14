import { stripComments, kv, unq, strList, truthy, falsy, plural, singular, snake, mkTable, addCol, addFk, finalize, inner } from './util.js';

const refTarget = (name, opts) => {
  const fk = opts.foreign_key;
  const m = /to_table:\s*:?["']?(\w+)/.exec(fk ?? '');
  return m ? m[1] : plural(name);
};

function parseSchema(src, map) {
  const lines = src.split('\n');
  let t = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = /^create_table\s*\(?\s*["':]([\w.]+)["']?\s*,?(.*?)\s*do\s*\|\w+\|/.exec(line))) {
      const opts = kv(m[2].replace(/\)\s*$/, '')).named;
      t = mkTable(m[1].split('.').pop());
      map.set(t.name, t);
      if (!falsy(opts.id)) {
        const pkName = opts.primary_key && !opts.primary_key.startsWith('[') ? unq(opts.primary_key) : 'id';
        if (opts.primary_key?.startsWith('[')) t.pk.push(...strList(opts.primary_key));
        else addCol(t, pkName, opts.id ? unq(opts.id) : 'bigint', false, true);
      } else if (opts.primary_key) t.pk.push(...strList(opts.primary_key));
      continue;
    }
    if (t && /^end\b/.test(line)) { t = null; continue; }
    if (t && (m = /^t\.(\w+)\s*\(?\s*(.*)$/.exec(line))) {
      const [, type, rest] = m;
      if (/^(index|check_constraint|exclusion_constraint|unique_constraint)$/.test(type)) continue;
      const { pos, named } = kv(rest.replace(/\)\s*$/, ''));
      if (type === 'timestamps') { addCol(t, 'created_at', 'datetime', falsy(named.null) ? false : !named.null); addCol(t, 'updated_at', 'datetime', falsy(named.null) ? false : !named.null); continue; }
      const names = pos.filter((p) => /^["':]/.test(p)).map(unq);
      for (const n of names) {
        if (type === 'references' || type === 'belongs_to') {
          const col = `${n}_id`;
          addCol(t, col, named.type ? unq(named.type) : 'bigint', !falsy(named.null));
          if (truthy(named.polymorphic)) addCol(t, `${n}_type`, 'string', !falsy(named.null));
          else if (named.foreign_key && !falsy(named.foreign_key)) addFk(t, col, refTarget(n, named));
          continue;
        }
        const c = addCol(t, n, named.limit ? `${type}(${named.limit})` : type, !falsy(named.null));
        if (named.array && truthy(named.array)) c.type += '[]';
      }
      continue;
    }
    if ((m = /^add_foreign_key\s*\(?\s*["':](\w+)["']?\s*,\s*["':](\w+)["']?(.*)$/.exec(line))) {
      const opts = kv(m[3].replace(/^\s*,/, '').replace(/\)\s*$/, '')).named;
      const from = map.get(m[1]);
      if (from) addFk(from, opts.column ? unq(opts.column) : `${singular(m[2])}_id`, m[2], [opts.primary_key ? unq(opts.primary_key) : 'id']);
    }
  }
}

function applyModelEnums(src, map) {
  for (const cm of src.matchAll(/class\s+(\w+(?:::\w+)*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/g)) {
    const after = src.slice(cm.index);
    const tn = /self\.table_name\s*=\s*["'](\w+)["']/.exec(after)?.[1] ?? plural(snake(cm[1].split('::').pop()));
    const t = map.get(tn);
    if (!t) continue;
    for (const em of after.matchAll(/^\s*enum\s*\(?\s*:?(\w+):?\s*,?\s*(?:\{|\[|%i\[|%w\[)/gm)) {
      const start = after.indexOf(em[0], em.index) + em[0].length - 1;
      const body = after[start] === '[' || after[start] === '{' ? inner(after, start) : '';
      const vals = after[start] === '{' ? [...body.matchAll(/["':]?(\w+)["']?\s*(?::|=>)/g)].map((x) => x[1]) : (/%[iw]\[/.test(em[0]) ? after.slice(start + 1, after.indexOf(']', start)).trim().split(/\s+/) : strList(body));
      if (vals.length) t.samples[em[1]] = vals;
    }
  }
}

export default {
  id: 'rails',
  want: (rel, ext) => ext === '.rb' && (/(^|\/)db\/schema\.rb$/.test(rel) || /(^|\/)app\/models\//.test(rel)),
  detect: /create_table\s*\(?\s*["':]/,
  keep: /create_table|ActiveRecord|ApplicationRecord/,
  parse(files) {
    const map = new Map(), used = new Set();
    for (const f of files.filter((f) => /schema\.rb$/.test(f.rel))) { parseSchema(stripComments(f.src, { slash: false, hash: true }), map); used.add(f.path); }
    if (!map.size) return { tables: [], used };
    for (const f of files.filter((f) => !/schema\.rb$/.test(f.rel))) applyModelEnums(stripComments(f.src, { slash: false, hash: true }), map);
    return { tables: [...map.values()].map(finalize), used };
  },
};
