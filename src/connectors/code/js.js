import { stripComments, splitTop, matchClose, inner, unq, isStr, strList, truthy, falsy, snake, camel, lcFirst, plural, mkTable, addCol, addFk, finalize, scanMembers, decoMap } from './util.js';

export const JS_EXT = /^\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const wantJs = (rel, ext) => JS_EXT.test(ext) && !/\.d\.ts$|\.min\.js$|\.(test|spec)\.[jt]sx?$/.test(rel);
const clean = (f) => (f.clean ??= stripComments(f.src));

function headCall(expr) {
  const s = expr.trim();
  const m = /^(?:new\s+)?([\w$.]+)\s*(?:<[^()]*?>)?\s*\(/.exec(s);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = matchClose(s, open);
  const chain = [];
  let rest = s.slice(close + 1);
  for (;;) {
    const c = /^\s*\??\.\s*([\w$]+)\s*(?:<[^()]*?>)?\s*\(/.exec(rest);
    if (!c) break;
    const o = c[0].length - 1;
    const e = matchClose(rest, o);
    chain.push({ fn: c[1], args: rest.slice(o + 1, e) });
    rest = rest.slice(e + 1);
  }
  return { fn: m[1], short: m[1].split('.').pop(), args: s.slice(open + 1, close), chain, has: (n) => chain.find((x) => x.fn === n) };
}

export function objEntries(obj) {
  const s = obj.trim();
  if (!s.startsWith('{')) return [];
  return splitTop(s.slice(1, matchClose(s, 0))).map((p) => {
    if (p.startsWith('...')) return null;
    const m = /^(['"`]?)([\w$.-]+)\1\s*:\s*([\s\S]*)$/.exec(p);
    if (m) return [m[2], m[3].trim()];
    if (/^[\w$]+$/.test(p)) return [p, p];
    return null;
  }).filter(Boolean);
}

const objMap = (s) => Object.fromEntries(objEntries(s ?? ''));

function tsEnums(files) {
  const map = new Map();
  for (const f of files) for (const m of clean(f).matchAll(/\benum\s+(\w+)\s*\{/g)) {
    const body = inner(clean(f), m.index + m[0].length - 1);
    map.set(m[1], splitTop(body).map((p) => { const [k, v] = p.split('=').map((x) => x.trim()); return v && isStr(v) ? unq(v) : unq(k); }));
  }
  for (const f of files) for (const m of clean(f).matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\{([^{}]*)\}\s*as\s+const/g)) map.set(m[1], objEntries(`{${m[2]}}`).map(([, v]) => unq(v)));
  return map;
}

export const typeorm = {
  id: 'typeorm',
  want: wantJs,
  detect: /@Entity\s*\(|@ViewEntity\s*\(/,
  keep: /@Entity|@Column|@PrimaryColumn|@PrimaryGeneratedColumn|\benum\s+\w+|as\s+const/,
  parse(files) {
    const enums = tsEnums(files);
    const classes = new Map();
    for (const f of files) {
      const src = clean(f);
      for (const m of src.matchAll(/\bclass\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+([\w.]+)(?:<[^>{]*>)?(?:\([^)]*\))?)?(?:\s+implements\s+[^{]+)?\s*\{/g)) {
        classes.set(m[1], { name: m[1], base: m[2], entity: null, body: inner(src, m.index + m[0].length - 1), file: f });
      }
      for (const m of src.matchAll(/@(Entity|ChildEntity)\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const cm = /\bclass\s+(\w+)/.exec(src.slice(matchClose(src, open)));
        const c = cm && classes.get(cm[1]);
        if (c) c.entity = { kind: m[1], args: src.slice(open + 1, matchClose(src, open)) };
      }
    }
    const tableOf = (n) => {
      const c = classes.get(n);
      if (!c?.entity) return n ? snake(n) : n;
      const a = c.entity.args.trim();
      if (isStr(splitTop(a)[0] ?? '')) return unq(splitTop(a)[0]);
      const o = objMap(a);
      return o.name ? unq(o.name) : snake(n);
    };
    const tables = [], used = new Set(), pend = [];
    const membersOf = (c, seen = new Set()) => {
      if (!c || seen.has(c.name)) return [];
      seen.add(c.name);
      const base = classes.get(c.base);
      return [...(base && !base.entity ? membersOf(base, seen) : base?.entity && c.entity?.kind === 'ChildEntity' ? membersOf(base, seen) : []), ...scanMembers(c.body)];
    };
    for (const c of classes.values()) {
      if (!c.entity) continue;
      const t = mkTable(tableOf(c.name));
      for (const { decos, decl } of membersOf(c)) {
        const d = decoMap(decos);
        const m = /^(?:(?:public|private|protected|readonly|declare|static|override|abstract)\s+)*(\w+)\s*([?!])?\s*:\s*([^=]+?)\s*(?:=[\s\S]*)?$/.exec(decl);
        if (!m || !decos.length) continue;
        const [, prop, opt, tsTypeRaw] = m;
        const tsNull = /\|\s*null\b/.test(tsTypeRaw);
        const tsType = tsTypeRaw.replace(/\s*\|\s*(null|undefined)\b/g, '').trim();
        const colDeco = d.PrimaryGeneratedColumn ?? d.PrimaryColumn ?? d.Column ?? d.CreateDateColumn ?? d.UpdateDateColumn ?? d.DeleteDateColumn ?? d.VersionColumn ?? d.ObjectIdColumn;
        if (colDeco) {
          const parts = splitTop(colDeco.args ?? '');
          const strType = parts.find(isStr);
          const o = objMap(parts.find((p) => p.startsWith('{')));
          const name = o.name ? unq(o.name) : prop;
          const pk = !!(d.PrimaryGeneratedColumn || d.PrimaryColumn || d.ObjectIdColumn) || truthy(o.primary);
          let type = strType ? unq(strType) : o.type ? unq(o.type).replace(/^(String|Number|Boolean|Date)$/, (x) => x.toLowerCase()) : d.PrimaryGeneratedColumn ? 'int' : /DateColumn$/.test(colDeco.name) ? 'timestamp' : tsType;
          if (d.PrimaryGeneratedColumn && /^(increment|identity|rowid)$/.test(type)) type = 'int';
          if (o.length) type = `${type}(${unq(o.length)})`;
          const nullable = truthy(o.nullable) || colDeco.name === 'DeleteDateColumn';
          addCol(t, name, o.enum && !strType && !o.type ? 'enum' : type, nullable, pk);
          if (o.enum) { const vals = o.enum.trim().startsWith('[') ? strList(o.enum) : enums.get(o.enum.trim()); if (vals) t.samples[name] = vals; }
          else if (enums.has(tsType)) t.samples[name] = enums.get(tsType);
          continue;
        }
        const rel = d.ManyToOne ?? d.OneToOne;
        if (rel && (d.ManyToOne || d.JoinColumn)) {
          const target = /=>\s*(\w+)/.exec(rel.args ?? '')?.[1] ?? unq(splitTop(rel.args ?? '')[0]);
          const jparts = d.JoinColumn ? splitTop(d.JoinColumn.args ?? '') : [];
          const j = objMap(jparts[0]?.startsWith('[') ? splitTop(jparts[0].slice(1, -1))[0] : jparts[0]);
          const refCol = j.referencedColumnName ? unq(j.referencedColumnName) : null;
          const col = j.name ? unq(j.name) : `@${prop}`;
          const ro = objMap(splitTop(rel.args ?? '').find((p) => p.startsWith('{')));
          addCol(t, col, 'fk', !falsy(ro.nullable) && !truthy(d.PrimaryColumn));
          pend.push({ t, col, target, refCol });
          continue;
        }
        if (d.ManyToMany && d.JoinTable) {
          const target = /=>\s*(\w+)/.exec(d.ManyToMany.args ?? '')?.[1];
          const jt = objMap(d.JoinTable.args ?? '');
          pend.push({ junction: true, owner: t.name, prop, target, jt });
        }
      }
      tables.push(t);
      used.add(c.file.path);
    }
    for (const p of pend) {
      if (p.junction) {
        const tt = tableOf(p.target);
        const t = mkTable(p.jt.name ? unq(p.jt.name) : `${p.owner}_${p.prop}_${tt}`);
        const a = objMap(p.jt.joinColumn).name ? unq(objMap(p.jt.joinColumn).name) : camel(`${p.owner}_id`);
        const b = objMap(p.jt.inverseJoinColumn).name ? unq(objMap(p.jt.inverseJoinColumn).name) : camel(`${tt}_id`);
        const pkType = (n) => tables.find((x) => x.name === n)?.columns.find((c) => c.pk)?.type ?? 'int';
        addCol(t, a, pkType(p.owner), false, true); addCol(t, b, pkType(tt), false, true);
        addFk(t, a, p.owner); addFk(t, b, tt);
        tables.push(t);
        continue;
      }
      const rt = tables.find((x) => x.name === tableOf(p.target));
      const refCol = p.refCol ?? rt?.pk[0] ?? 'id';
      const c = p.t.columns.find((x) => x.name === p.col);
      if (c && p.col.startsWith('@')) { const name = camel(`${p.col.slice(1)}_${refCol}`); const dup = p.t.columns.find((x) => x.name === name); if (dup) p.t.columns.splice(p.t.columns.indexOf(c), 1); else c.name = name; p.col = name; }
      if (c && c.type === 'fk') c.type = rt?.columns.find((x) => x.name === refCol)?.type ?? 'int';
      addFk(p.t, p.col, tableOf(p.target), [refCol]);
    }
    return { tables: tables.map(finalize), used };
  },
};

const seqType = (v) => String(v ?? '').trim().replace(/^(?:DataTypes|Sequelize|S|DataType|Sequelize\.DataTypes)\./, '');

export const sequelize = {
  id: 'sequelize',
  want: wantJs,
  detect: /\.define\s*\(\s*['"`]\w+['"`]\s*,|\.init\s*\(\s*\{[\s\S]{0,3000}?(?:DataTypes|Sequelize)\.|createTable\s*\(\s*['"`]\w+['"`]\s*,\s*\{[\s\S]{0,500}?(?:DataTypes|Sequelize)\./,
  keep: /\.define\s*\(|\.init\s*\(|createTable\s*\(|belongsTo|hasMany|hasOne/,
  parse(files) {
    const models = new Map(), byVar = new Map(), used = new Set();
    const build = (model, attrs, opts, f, fixedTable) => {
      const o = objMap(opts);
      const underscored = truthy(o.underscored);
      const table = fixedTable ?? (o.tableName ? unq(o.tableName) : truthy(o.freezeTableName) ? (o.modelName ? unq(o.modelName) : model) : plural(o.modelName ? unq(o.modelName) : model));
      const t = mkTable(table);
      const fields = new Map();
      for (const [key, val] of objEntries(attrs)) {
        const def = val.startsWith('{') ? objMap(val) : { type: val };
        const col = def.field ? unq(def.field) : underscored ? snake(key) : key;
        fields.set(key, col);
        const type = seqType(def.type);
        const pk = truthy(def.primaryKey);
        addCol(t, col, type.replace(/\(.*$/s, (x) => /^ENUM/.test(type) ? '' : x), def.allowNull === undefined ? !pk : truthy(def.allowNull), pk);
        if (/^ENUM\b/.test(type)) t.samples[col] = strList(/^ENUM\s*\(([\s\S]*)\)/.exec(type)?.[1] ?? '');
        if (def.values) t.samples[col] = strList(def.values);
        if (def.references) { const r = objMap(def.references); if (r.model) t.fks.push({ columns: [col], refTable: isStr(r.model) ? unq(r.model) : { var: r.model.trim() }, refColumns: [r.key ? unq(r.key) : 'id'] }); }
      }
      if (!fixedTable && !t.pk.length) { t.columns.unshift({ name: 'id', type: 'INTEGER', nullable: false, pk: true }); t.pk.push('id'); }
      if (!fixedTable && !falsy(o.timestamps)) { addCol(t, underscored ? 'created_at' : 'createdAt', 'DATE', false); addCol(t, underscored ? 'updated_at' : 'updatedAt', 'DATE', false); if (truthy(o.paranoid)) addCol(t, underscored ? 'deleted_at' : 'deletedAt', 'DATE', true); }
      const m = { name: model, table: t.name, t, underscored, fields };
      models.set(model, m);
      used.add(f.path);
      return m;
    };
    for (const f of files) {
      const src = clean(f);
      for (const mm of src.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?[\w.]*\.define\s*\(/g)) {
        const open = mm.index + mm[0].length - 1;
        const args = splitTop(inner(src, open));
        if (!isStr(args[0] ?? '')) continue;
        const m = build(unq(args[0]), args[1] ?? '{}', args[2] ?? '{}', f);
        if (mm[1]) byVar.set(mm[1], m);
        byVar.set(m.name, m);
      }
      for (const mm of src.matchAll(/(\w+)\.init\s*\(\s*\{/g)) {
        const open = mm.index + mm[0].indexOf('(');
        const args = splitTop(inner(src, open));
        const o = objMap(args[1]);
        if (!/sequelize/i.test(args[1] ?? '') && !/DataTypes|Sequelize/.test(args[0] ?? '')) continue;
        const m = build(o.modelName ? unq(o.modelName) : mm[1], args[0], args[1] ?? '{}', f);
        byVar.set(mm[1], m);
      }
      for (const mm of src.matchAll(/createTable\s*\(\s*(['"`])(\w+)\1\s*,\s*\{/g)) {
        const open = mm.index + mm[0].indexOf('(');
        const args = splitTop(inner(src, open));
        if (models.has(mm[2])) continue;
        build(mm[2], args[1], '{}', f, mm[2]);
      }
    }
    const resolve = (n) => byVar.get(String(n).replace(/^(?:models|db|sequelize\.models)\./, '').trim()) ?? models.get(String(n).trim());
    const ensure = (m, col) => { if (!m.t.columns.some((c) => c.name === col)) addCol(m.t, col, 'INTEGER', true); };
    for (const f of files) {
      const src = clean(f);
      for (const am of src.matchAll(/(\w+)\.(belongsTo|hasMany|hasOne|belongsToMany)\s*\(\s*([\w.]+)\s*(?:,|\))/g)) {
        let owner = am[1];
        if (owner === 'this') owner = [...src.slice(0, am.index).matchAll(/class\s+(\w+)\s+extends/g)].pop()?.[1];
        const a = resolve(owner), b = resolve(am[3]);
        if (!a || !b) continue;
        const open = am.index + am[0].indexOf('(');
        const opts = objMap(splitTop(inner(src, open))[1]);
        const fkOpt = opts.foreignKey ? (opts.foreignKey.startsWith('{') ? unq(objMap(opts.foreignKey).name) : unq(opts.foreignKey)) : null;
        const fix = (m, key) => m.fields.get(key) ?? (m.underscored ? snake(key) : key);
        if (am[2] === 'belongsTo') { const col = fix(a, fkOpt ?? camel(`${opts.as ? unq(opts.as) : lcFirst(b.name)}_id`)); ensure(a, col); addFk(a.t, col, b.table, [b.t.pk[0] ?? 'id']); }
        else if (am[2] === 'belongsToMany') {
          if (!opts.through || !isStr(opts.through) || models.has(unq(opts.through))) continue;
          const jt = mkTable(unq(opts.through));
          const ca = fkOpt ?? camel(`${lcFirst(a.name)}_id`), cb = opts.otherKey ? unq(opts.otherKey) : camel(`${lcFirst(b.name)}_id`);
          addCol(jt, ca, 'INTEGER', false, true); addCol(jt, cb, 'INTEGER', false, true);
          addFk(jt, ca, a.table); addFk(jt, cb, b.table);
          models.set(jt.name, { name: jt.name, table: jt.name, t: jt, fields: new Map() });
        } else { const col = fix(b, fkOpt ?? camel(`${lcFirst(a.name)}_id`)); ensure(b, col); addFk(b.t, col, a.table, [a.t.pk[0] ?? 'id']); }
      }
    }
    const tables = [...new Set([...models.values()].map((m) => m.t))];
    for (const t of tables) for (const fk of t.fks) if (typeof fk.refTable === 'object') fk.refTable = resolve(fk.refTable.var)?.table ?? fk.refTable.var;
    return { tables: tables.map(finalize), used };
  },
};

const mgType = (v) => {
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) { const i = s.slice(1, matchClose(s, 0)).trim(); return `Array<${i.startsWith('{') ? mgType(objMap(i).type ?? 'Object') : mgType(i) || 'Mixed'}>`; }
  return isStr(s) ? unq(s) : s.split('.').pop();
};

export const mongoose = {
  id: 'mongoose',
  want: wantJs,
  detect: /new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(|mongoose\.model\s*\(|\bmodel\s*(?:<[^>]*>)?\s*\(\s*['"`]\w+['"`]\s*,/,
  keep: /Schema\s*(?:<[^>]*>)?\s*\(|model\s*(?:<[^>]*>)?\s*\(/,
  parse(files) {
    const schemas = new Map(), models = [], used = new Set();
    for (const f of files) {
      const src = clean(f);
      for (const m of src.matchAll(/(?:(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*)?new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const args = splitTop(inner(src, open));
        const s = { fields: args[0] ?? '{}', opts: objMap(args[1]), file: f };
        if (m[1]) schemas.set(m[1], s);
        s.inlineAt = open;
        schemas.set(`@${f.path}:${open}`, s);
      }
      for (const m of src.matchAll(/(?:mongoose\.|\b)model\s*(?:<[^>]*>)?\s*\(\s*(['"`])(\w+)\1\s*,\s*/g)) {
        const rest = src.slice(m.index + m[0].length);
        const v = /^(\w+)/.exec(rest)?.[1];
        let schema = v && schemas.get(v);
        if (!schema && /^new\s/.test(rest)) schema = [...schemas.values()].find((s) => s.file === f && s.inlineAt > m.index);
        if (!schema) continue;
        const after = splitTop(inner(src, m.index + m[0].indexOf('(')));
        models.push({ name: m[2], schema, collection: after[2] && isStr(after[2]) ? unq(after[2]) : schema.opts.collection ? unq(schema.opts.collection) : null, file: f });
      }
    }
    const collOf = (n) => { const m = models.find((x) => x.name === n); return m?.collection ?? plural(n.toLowerCase()); };
    const tables = [];
    for (const m of models) {
      const t = mkTable(collOf(m.name), 'collection');
      if (!/_id\s*:\s*false/.test(m.schema.fields.slice(0, 50)) && !objEntries(m.schema.fields).some(([k]) => k === '_id')) addCol(t, '_id', 'ObjectId', false, true);
      const walk = (obj, prefix) => {
        for (const [k, v] of objEntries(obj)) {
          const name = prefix + k;
          if (v.startsWith('{')) {
            const o = objMap(v);
            if (o.type === undefined) { walk(v, `${name}.`); continue; }
            const type = mgType(o.type);
            addCol(t, name, type, !truthy(o.required) && !/^\[\s*true/.test(o.required ?? ''), k === '_id');
            if (o.enum) { const vals = o.enum.trim().startsWith('{') ? strList(objMap(o.enum).values) : strList(o.enum); if (vals.length) t.samples[name] = vals; }
            if (o.ref) addFk(t, name, collOf(unq(o.ref)), ['_id']);
            const arrRef = o.type.trim().startsWith('[') && /ref\s*:\s*(['"`])(\w+)\1/.exec(o.type);
            if (arrRef) addFk(t, name, collOf(arrRef[2]), ['_id']);
            continue;
          }
          if (v.startsWith('[')) {
            addCol(t, name, mgType(v), true, false);
            const r = /ref\s*:\s*(['"`])(\w+)\1/.exec(v);
            if (r) addFk(t, name, collOf(r[2]), ['_id']);
            const en = /enum\s*:\s*(\[[^\]]*\])/.exec(v);
            if (en) t.samples[name] = strList(en[1]);
            continue;
          }
          addCol(t, name, mgType(v), true, k === '_id');
        }
      };
      walk(m.schema.fields, '');
      if (truthy(m.schema.opts.timestamps) || m.schema.opts.timestamps?.startsWith('{')) { addCol(t, 'createdAt', 'Date', false); addCol(t, 'updatedAt', 'Date', false); }
      tables.push(t);
      used.add(m.file.path); used.add(m.schema.file.path);
    }
    return { tables: tables.map(finalize), used };
  },
};

export const drizzle = {
  id: 'drizzle',
  want: wantJs,
  detect: /\b(pgTable|mysqlTable|sqliteTable|singlestoreTable)\s*\(/,
  keep: /Table\s*\(|Enum\s*\(/,
  parse(files) {
    const enums = new Map(), defs = [], used = new Set();
    for (const f of files) {
      const src = clean(f);
      for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:\w+\.)?(pgEnum|mysqlEnum)\s*\(\s*(['"`])(\w+)\3\s*,\s*(\[[^\]]*\])/g)) enums.set(m[1], strList(m[5]));
      for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:\w+\.)?(pgTable|mysqlTable|sqliteTable|singlestoreTable)\s*\(/g)) {
        const args = splitTop(inner(src, m.index + m[0].length - 1));
        if (!isStr(args[0] ?? '')) continue;
        defs.push({ v: m[1], name: unq(args[0]), cols: args[1] ?? '{}', extra: args[2] ?? '', file: f });
      }
    }
    const byVar = new Map(defs.map((d) => [d.v, d]));
    const keyCol = new Map();
    for (const d of defs) {
      const map = new Map();
      for (const [k, v] of objEntries(d.cols)) { const h = headCall(v); map.set(k, h && isStr(splitTop(h.args)[0] ?? '') ? unq(splitTop(h.args)[0]) : k); }
      keyCol.set(d.v, map);
    }
    const ref = (s) => { const m = /(\w+)\.(\w+)\s*$/.exec(String(s).replace(/^\s*\(\s*\)\s*(?::\s*[\w.]+\s*)?=>\s*/, '').trim()); return m ? { table: byVar.get(m[1])?.name ?? m[1], col: keyCol.get(m[1])?.get(m[2]) ?? m[2] } : null; };
    const tables = [];
    for (const d of defs) {
      const t = mkTable(d.name);
      const local = keyCol.get(d.v);
      for (const [k, v] of objEntries(d.cols)) {
        const h = headCall(v);
        if (!h) continue;
        const args = splitTop(h.args);
        const col = local.get(k);
        const o = objMap(args.find((a) => a.startsWith('{')));
        let type = enums.has(h.short) ? `enum ${h.short}` : h.short;
        if (o.length) type = `${type}(${unq(o.length)})`;
        const pk = !!h.has('primaryKey');
        addCol(t, col, type, !h.has('notNull') && !pk, pk);
        if (enums.has(h.short)) t.samples[col] = enums.get(h.short);
        if (/Enum$/.test(h.short) && args[1]?.startsWith('[')) t.samples[col] = strList(args[1]);
        if (o.enum) t.samples[col] = strList(o.enum);
        const r = h.has('references');
        if (r) { const x = ref(splitTop(r.args)[0]); if (x) addFk(t, col, x.table, [x.col]); }
      }
      for (const pm of d.extra.matchAll(/primaryKey\s*\(\s*(\{[\s\S]*?\}|[^)]*)\)/g)) {
        const body = pm[1].startsWith('{') ? objMap(pm[1]).columns ?? '' : pm[1];
        const cols = [...body.matchAll(/\w+\.(\w+)/g)].map((x) => local.get(x[1]) ?? x[1]);
        if (cols.length) t.pk = cols;
      }
      for (const fm of d.extra.matchAll(/foreignKey\s*\(\s*(\{[\s\S]*?\})\s*\)/g)) {
        const o = objMap(fm[1]);
        const cols = [...(o.columns ?? '').matchAll(/\w+\.(\w+)/g)].map((x) => local.get(x[1]) ?? x[1]);
        const fc = [...(o.foreignColumns ?? '').matchAll(/(\w+)\.(\w+)/g)];
        if (cols[0] && fc[0]) t.fks.push({ columns: cols, refTable: byVar.get(fc[0][1])?.name ?? fc[0][1], refColumns: fc.map((x) => keyCol.get(x[1])?.get(x[2]) ?? x[2]) });
      }
      tables.push(t);
      used.add(d.file.path);
    }
    return { tables: tables.map(finalize), used };
  },
};
