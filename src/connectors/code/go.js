import { stripComments, inner, strList, snake, plural, mkTable, addCol, addFk, finalize } from './util.js';

const tagOf = (tag) => {
  const g = /gorm:"([^"]*)"/.exec(tag ?? '')?.[1];
  if (g === undefined) return null;
  const o = {};
  for (const part of g.split(';').map((s) => s.trim()).filter(Boolean)) { const i = part.indexOf(':'); o[(i < 0 ? part : part.slice(0, i)).trim().toLowerCase()] = i < 0 ? true : part.slice(i + 1).trim(); }
  return o;
};

export default {
  id: 'gorm',
  want: (rel, ext) => ext === '.go' && !/_test\.go$/.test(rel),
  detect: /gorm\.Model\b|gorm:"|"gorm\.io\/gorm"|github\.com\/jinzhu\/gorm/,
  keep: /\bstruct\s*\{|TableName|AutoMigrate|\bconst\b/,
  parse(files) {
    const structs = new Map(), tableNames = new Map(), migrated = new Set(), named = new Map(), consts = new Map();
    for (const f of files) {
      const src = stripComments(f.src);
      const gormFile = /gorm/.test(src);
      for (const m of src.matchAll(/\btype\s+(\w+)\s+struct\s*\{/g)) {
        const fields = [];
        for (const line of inner(src, m.index + m[0].length - 1).split('\n')) {
          const l = line.trim();
          let x;
          if ((x = /^(\*?[\w.]+)\s*(`[^`]*`)?$/.exec(l))) fields.push({ embed: true, type: x[1].replace(/^\*/, ''), tag: x[2] });
          else if ((x = /^([\w, ]+?)\s+([*\[\]\w.]+(?:\[[^\]]*\])?)\s*(`[^`]*`)?$/.exec(l))) for (const n of x[1].split(',').map((s) => s.trim())) fields.push({ name: n, type: x[2], tag: x[3] });
        }
        structs.set(m[1], { name: m[1], fields, file: f, gormFile });
      }
      for (const m of src.matchAll(/func\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{\s*return\s+"([^"]+)"/g)) tableNames.set(m[1], m[2]);
      for (const m of src.matchAll(/AutoMigrate\s*\(([^)]*)\)/g)) for (const x of m[1].matchAll(/&\s*(?:\w+\.)?(\w+)\s*\{/g)) migrated.add(x[1]);
      for (const m of src.matchAll(/\btype\s+(\w+)\s+(string|int\d*|uint\d*)\s*$/gm)) named.set(m[1], m[2]);
      for (const m of src.matchAll(/\bconst\s*\(([\s\S]*?)\n\s*\)/g)) {
        let cur = null;
        for (const line of m[1].split('\n')) {
          const x = /^\s*\w+\s+(\w+)\s*=\s*("([^"]*)"|iota|\d+)/.exec(line);
          if (x) { cur = x[1]; (consts.get(cur) ?? consts.set(cur, []).get(cur)).push(x[3] ?? x[2]); }
          else if (cur && /^\s*\w+\s*$/.test(line) && consts.get(cur)?.[0] === 'iota') consts.get(cur).push(String(consts.get(cur).length));
        }
      }
    }
    const isBase = (s, seen = new Set()) => !!s && !seen.has(s.name) && (seen.add(s.name), s.fields.some((f) => f.embed && (f.type === 'gorm.Model' || isBase(structs.get(f.type), seen))));
    const embedded = new Set([...structs.values()].flatMap((s) => s.fields.filter((f) => f.embed).map((f) => f.type)));
    const isModel = (s) => tableNames.has(s.name) || migrated.has(s.name) || (!embedded.has(s.name) && s.gormFile && (isBase(s) || s.fields.some((f) => tagOf(f.tag))));
    const models = [...structs.values()].filter(isModel);
    const modelNames = new Set(models.map((s) => s.name));
    const tableOf = (n) => tableNames.get(n) ?? plural(snake(n));
    const flat = (s, prefix = '', seen = new Set()) => {
      if (seen.has(s.name)) return [];
      seen.add(s.name);
      return s.fields.flatMap((f) => {
        const tg = tagOf(f.tag) ?? {};
        if (f.embed && f.type === 'gorm.Model') return [{ name: 'ID', type: 'uint', tag: '`gorm:"primaryKey"`' }, { name: 'CreatedAt', type: 'time.Time' }, { name: 'UpdatedAt', type: 'time.Time' }, { name: 'DeletedAt', type: 'gorm.DeletedAt' }];
        if (f.embed || tg.embedded) { const e = structs.get(f.type.replace(/^\*/, '')); return e ? flat(e, prefix + (tg.embeddedprefix ?? ''), seen) : []; }
        return [{ ...f, prefix }];
      });
    };
    const tables = [], used = new Set(), hasMany = [], colMaps = new Map();
    for (const s of models) {
      const t = mkTable(tableOf(s.name));
      const fields = flat(s);
      const byName = new Map(fields.map((f) => [f.name, f]));
      const colOf = (f) => { const tg = tagOf(f.tag) ?? {}; return typeof tg.column === 'string' ? tg.column : (f.prefix ?? '') + snake(f.name); };
      colMaps.set(s.name, { t, col: (n) => byName.has(n) ? colOf(byName.get(n)) : null });
      for (const f of fields) {
        const tg = tagOf(f.tag) ?? {};
        if (tg['-'] === true || /^-(:|$)/.test(String(tg['-'] ?? '')) || /gorm:"-/.test(f.tag ?? '')) continue;
        const base = f.type.replace(/^\*/, '');
        if (/^\[\]/.test(base)) {
          if (tg.many2many) {
            const target = base.replace(/^\[\]\*?/, '').split('.').pop();
            const j = mkTable(tg.many2many);
            const a = `${snake(s.name)}_id`, b = `${snake(target)}_id`;
            addCol(j, a, 'uint', false, true); addCol(j, b, 'uint', false, true);
            addFk(j, a, t.name); addFk(j, b, tableOf(target));
            if (!tables.some((x) => x.name === j.name)) tables.push(j);
          }
          else { const target = base.replace(/^\[\]\*?/, '').split('.').pop(); if (modelNames.has(target)) hasMany.push({ owner: s.name, target, fk: typeof tg.foreignkey === 'string' ? tg.foreignkey : `${s.name}ID` }); }
          if (base !== '[]byte') continue;
        }
        if (modelNames.has(base.split('.').pop()) || (structs.has(base) && !named.has(base))) {
          const target = base.split('.').pop();
          const fkField = typeof tg.foreignkey === 'string' ? tg.foreignkey : `${f.name}ID`;
          const fkF = byName.get(fkField);
          if (fkF && modelNames.has(target)) addFk(t, colOf(fkF), tableOf(target), [typeof tg.references === 'string' ? snake(tg.references) : 'id']);
          continue;
        }
        const col = colOf(f);
        const pk = tg.primarykey === true || tg.primary_key === true || (f.name === 'ID' && !fields.some((x) => (tagOf(x.tag) ?? {}).primarykey));
        const nullable = f.type.startsWith('*') || /^sql\.Null|^gorm\.DeletedAt$|^null\./.test(base);
        addCol(t, col, typeof tg.type === 'string' ? tg.type : base, nullable && tg['not null'] !== true, pk);
        if (typeof tg.type === 'string' && /^enum\s*\(/i.test(tg.type)) t.samples[col] = strList(tg.type);
        else if (named.has(base) && consts.get(base)?.length) t.samples[col] = consts.get(base);
      }
      tables.push(t);
      used.add(s.file.path);
    }
    for (const h of hasMany) {
      const cm = colMaps.get(h.target);
      const col = cm?.col(h.fk);
      if (col) addFk(cm.t, col, tableOf(h.owner));
    }
    return { tables: tables.map(finalize), used };
  },
};
