import { stripComments, splitTop, matchClose, unq, isStr, kv, truthy, mkTable, addCol, addFk, finalize } from './util.js';

const ind = (l) => l.match(/^\s*/)[0].length;

function statements(lines) {
  const nb = lines.filter((l) => l.trim());
  if (!nb.length) return [];
  const level = Math.min(...nb.map(ind));
  const out = []; let cur = null, depth = 0;
  for (const l of lines) {
    if (!l.trim()) { if (cur) cur.push(l); continue; }
    if (ind(l) === level && depth <= 0) { cur = [l]; out.push(cur); depth = 0; }
    else if (cur) cur.push(l); else continue;
    for (const c of l.replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, '')) { if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; }
  }
  return out.map((ls) => ls.join('\n').trim());
}

export function pyClasses(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)class\s+(\w+)\s*(\(|:)/.exec(lines[i]);
    if (!m) continue;
    let bases = '', hdrEnd = i;
    if (m[3] === '(') {
      const text = lines.slice(i).join('\n');
      const open = text.indexOf('(');
      const close = matchClose(text, open);
      bases = text.slice(open + 1, close);
      hdrEnd = i + text.slice(0, close).split('\n').length - 1;
    }
    let end = hdrEnd + 1;
    while (end < lines.length && (!lines[end].trim() || ind(lines[end]) > m[1].length)) end++;
    const body = lines.slice(hdrEnd + 1, end);
    out.push({ name: m[2], bases: splitTop(bases), indent: m[1].length, body, stmts: statements(body) });
  }
  return out;
}

const callOf = (expr) => {
  const m = /^([\w.]+)\s*\(/.exec(expr.trim());
  if (!m) return null;
  const s = expr.trim();
  const open = s.indexOf('(');
  return { fn: m[1], short: m[1].split('.').pop(), args: s.slice(open + 1, matchClose(s, open)), rest: s.slice(matchClose(s, open) + 1) };
};

const assignRe = /^(\w+)\s*(?::\s*([^=\n]+?))?\s*=\s*([\s\S]+)$/;
const annotRe = /^(\w+)\s*:\s*([\s\S]+)$/;

function enumOf(cls) {
  const names = [], values = [];
  for (const s of cls.stmts) {
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(s);
    if (!m || m[1].startsWith('_')) continue;
    names.push(m[1]);
    const first = splitTop(m[2].replace(/^\(([\s\S]*)\)$/, '$1'))[0] ?? '';
    values.push(isStr(first) ? unq(first) : /auto\(\)/.test(first) ? m[1].toLowerCase() : first.replace(/^[\w.]*\(\s*['"]?([^'")]*)['"]?.*$/, '$1'));
  }
  return { names, values };
}

const isEnumClass = (c) => c.bases.some((b) => /(^|\.)(Enum|StrEnum|IntEnum|TextChoices|IntegerChoices|Choices)$/.test(b) || /^(str|int)$/.test(b) && c.bases.some((x) => /Enum/.test(x)));

function choicesVals(expr, consts, enums) {
  const e = expr.trim();
  let m;
  if ((m = /^([\w.]+)\.choices$/.exec(e))) return enums.get(m[1].split('.').pop())?.values ?? null;
  if (/^\w+$/.test(e) && consts.has(e)) return choicesVals(consts.get(e), new Map(), enums);
  if (/^[\[(]/.test(e)) return splitTop(e.slice(1, matchClose(e, 0))).map((it) => /^[\[(]/.test(it) ? unq(splitTop(it.slice(1, -1))[0]) : unq(it)).filter((v) => v !== undefined);
  if (/^\{/.test(e)) return splitTop(e.slice(1, -1)).map((it) => unq(splitTop(it, ':')[0]));
  return null;
}

function collect(files) {
  const classes = [], enums = new Map(), consts = new Map();
  for (const f of files) {
    const src = stripComments(f.src, { slash: false, block: false, hash: true });
    const cls = pyClasses(src);
    for (const c of cls) { c.file = f; if (isEnumClass(c)) enums.set(c.name, enumOf(c)); }
    for (const s of statements(src.split('\n'))) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*([\s\S]+)$/.exec(s);
      if (m) consts.set(m[1], m[2]);
    }
    classes.push(...cls);
    f.clean = src;
  }
  return { classes, enums, consts };
}

function appLabel(rel) {
  const parts = rel.split('/');
  const i = parts.lastIndexOf('models');
  if (i > 0 && i < parts.length - 1) return parts[i - 1];
  if (/models\.py$/.test(rel)) return parts[parts.length - 2] ?? 'app';
  return parts[parts.length - 2] ?? 'app';
}

const metaOf = (c) => {
  const meta = {};
  const mc = c.stmts.find((s) => /^class\s+Meta\b/.test(s));
  if (!mc) return meta;
  for (const s of statements(mc.split('\n').slice(1))) { const m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(s); if (m) meta[m[1]] = m[2].trim(); }
  return meta;
};

const DJ_REL = /^(ForeignKey|OneToOneField|ManyToManyField|ParentalKey|ParentalManyToManyField)$/;

export const django = {
  id: 'django',
  want: (rel, ext) => ext === '.py' && /(^|\/)models(\.py$|\/)/.test(rel),
  detect: /models\.Model\b|from\s+django\.db\s+import\s+models/,
  keep: /django|models\.|Model\b|Choices|Enum/,
  parse(files) {
    const { classes, enums, consts } = collect(files);
    const byName = new Map(classes.map((c) => [c.name, c]));
    const djangoFile = (c) => /django/.test(c.file.src);
    const models = new Set(classes.filter((c) => djangoFile(c) && c.bases.some((b) => /^(models\.)?Model$/.test(b))).map((c) => c.name));
    for (let changed = true; changed;) {
      changed = false;
      for (const c of classes) if (!models.has(c.name) && c.bases.some((b) => models.has(b.split('.').pop()))) { models.add(c.name); changed = true; }
    }
    const info = new Map();
    for (const name of models) {
      const c = byName.get(name);
      const meta = metaOf(c);
      const app = meta.app_label ? unq(meta.app_label) : appLabel(c.file.rel);
      info.set(name, { c, meta, abstract: truthy(meta.abstract), proxy: truthy(meta.proxy), table: meta.db_table ? unq(meta.db_table) : `${app}_${name.toLowerCase()}` });
    }
    const tableOf = (target, self) => {
      const t = unq(target.trim()).replace(/^to=/, '');
      if (t === 'self') return info.get(self)?.table;
      if (/AUTH_USER_MODEL|get_user_model/.test(t)) { const u = info.get('User'); return u && !u.abstract ? u.table : 'auth_user'; }
      const n = t.split('.').pop();
      return info.get(n)?.table ?? n.toLowerCase();
    };
    const tables = [], used = new Set();
    const fieldStmts = (c, seen = new Set()) => {
      if (seen.has(c.name)) return [];
      seen.add(c.name);
      const inherited = c.bases.map((b) => b.split('.').pop()).filter((b) => info.get(b)?.abstract).flatMap((b) => fieldStmts(byName.get(b), seen));
      return [...inherited, ...c.stmts.map((s) => ({ s, c }))];
    };
    const junctions = [];
    for (const [name, inf] of info) {
      if (inf.abstract || inf.proxy) continue;
      const t = mkTable(inf.table);
      const localConsts = new Map(consts);
      for (const s of inf.c.stmts) { const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*([\s\S]+)$/.exec(s); if (m) localConsts.set(m[1], m[2]); }
      const concreteParent = inf.c.bases.map((b) => b.split('.').pop()).find((b) => info.has(b) && !info.get(b).abstract && !info.get(b).proxy);
      if (concreteParent) { const col = `${concreteParent.toLowerCase()}_ptr_id`; addCol(t, col, 'OneToOneField', false, true); addFk(t, col, info.get(concreteParent).table); }
      for (const { s } of fieldStmts(inf.c)) {
        const m = assignRe.exec(s);
        if (!m) continue;
        const call = callOf(m[3]);
        if (!call || !(/Field$/.test(call.short) || DJ_REL.test(call.short)) || /^Generic/.test(call.short)) continue;
        const { pos, named } = kv(call.args);
        const nullable = truthy(named.null);
        if (DJ_REL.test(call.short) && /Many/.test(call.short)) {
          if (named.through) continue;
          const target = named.to ?? pos[0];
          if (!target) continue;
          junctions.push({ owner: name, ownerTable: inf.table, field: m[1], target, db: named.db_table ? unq(named.db_table) : null });
          continue;
        }
        if (DJ_REL.test(call.short)) {
          const target = named.to ?? pos[0];
          const col = named.db_column ? unq(named.db_column) : `${m[1]}_id`;
          const c = addCol(t, col, call.short, nullable, truthy(named.primary_key));
          if (call.short === 'OneToOneField' && truthy(named.primary_key)) c.nullable = false;
          if (target) t.fks.push({ columns: [col], refTable: tableOf(target, name), refColumns: [named.to_field ? unq(named.to_field) : 'id'] });
          continue;
        }
        const col = named.db_column ? unq(named.db_column) : m[1];
        let type = call.short;
        if (named.max_length && /Char|Slug|Email|URL/.test(type)) type += `(${named.max_length})`;
        addCol(t, col, type, nullable, truthy(named.primary_key));
        if (named.choices) { const v = choicesVals(named.choices, localConsts, enums); if (v?.length) t.samples[col] = v; }
      }
      if (!t.pk.length) addCol(t, 'id', 'AutoField', false, true);
      t.columns.sort((a, b) => (b.pk - a.pk));
      tables.push(t);
      used.add(inf.c.file.path);
    }
    for (const j of junctions) {
      const target = unq(j.target).split('.').pop();
      const self = target === 'self' || target === j.owner;
      const from = self ? `from_${j.owner.toLowerCase()}_id` : `${j.owner.toLowerCase()}_id`;
      const to = self ? `to_${j.owner.toLowerCase()}_id` : `${(/AUTH_USER_MODEL|get_user_model/.test(target) ? 'user' : target).toLowerCase()}_id`;
      const t = mkTable(j.db ?? `${j.ownerTable}_${j.field}`);
      addCol(t, 'id', 'AutoField', false, true);
      addCol(t, from, 'ForeignKey', false); addCol(t, to, 'ForeignKey', false);
      addFk(t, from, j.ownerTable); addFk(t, to, tableOf(j.target, j.owner));
      tables.push(t);
    }
    for (const t of tables) for (const fk of t.fks) { const rt = tables.find((x) => x.name === fk.refTable); if (rt?.pk.length === 1 && fk.refColumns[0] === 'id') fk.refColumns = [rt.pk[0]]; }
    return { tables: tables.map(finalize), used };
  },
};

const SA_SKIP = /^(relationship|db\.relationship|backref|association_proxy|column_property|synonym|deferred|query_expression|Relationship|composite|declared_attr|hybrid_property|orm\.relationship)$/;
const stripMod = (s) => String(s).trim().replace(/^(?:sa|db|sqlalchemy|types|sqltypes|postgresql|mysql|sqlite|pg|dialects\.\w+|sqlmodel)\./, '');
const annInner = (a) => {
  let s = String(a ?? '').trim().replace(/^['"]|['"]$/g, '');
  const m = /^(?:\w+\.)?Mapped\[([\s\S]*)\]$/.exec(s);
  if (m) s = m[1].trim();
  let nullable = false;
  const o = /^(?:typing\.)?Optional\[([\s\S]*)\]$/.exec(s);
  if (o) { s = o[1].trim(); nullable = true; }
  if (/\|\s*None\b|\bNone\s*\|/.test(s)) { s = s.replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, '').trim(); nullable = true; }
  return { type: s.replace(/^['"]|['"]$/g, ''), nullable };
};

export const sqlalchemy = {
  id: 'sqlalchemy',
  want: (rel, ext) => ext === '.py',
  detect: /__tablename__\s*=|table\s*=\s*True|\bTable\s*\(\s*['"]\w+['"]\s*,\s*[\w.]*metadata/,
  keep: /__tablename__|table\s*=\s*True|Table\s*\(|Enum\b|Column|mapped_column|Field\s*\(/,
  parse(files) {
    const { classes, enums } = collect(files);
    const byName = new Map(classes.map((c) => [c.name, c]));
    const isSqlModel = (c) => c.bases.some((b) => /^SQLModel$/.test(b)) && c.bases.some((b) => /^table\s*=\s*True$/.test(b));
    const tableName = (c) => {
      const s = c.stmts.find((x) => /^__tablename__\s*=/.test(x));
      if (s) return isStr(s.replace(/^__tablename__\s*=\s*/, '')) ? unq(s.replace(/^__tablename__\s*=\s*/, '')) : c.name.toLowerCase();
      if (isSqlModel(c)) return c.name.toLowerCase();
      return null;
    };
    const tclasses = classes.filter((c) => tableName(c));
    const clsTable = new Map(tclasses.map((c) => [c.name, tableName(c)]));
    const tables = [], used = new Set();
    const pending = [];
    const fkTarget = (expr) => {
      const e = expr.trim();
      if (isStr(e)) { const p = unq(e).split('.'); return { table: p.length > 1 ? p[p.length - 2] : p[0], ref: p.length > 1 ? p[p.length - 1] : 'id' }; }
      const p = e.split('.');
      return { cls: p[0], ref: p[1] ?? 'id' };
    };
    const columnCall = (t, attr, call, ann) => {
      const { pos, named } = kv(call.args);
      let col = attr, type = null;
      const fks = [];
      for (const p of pos) {
        if (isStr(p)) continue;
        const pc = callOf(p);
        if (pc && /^(ForeignKey|sa\.ForeignKey|db\.ForeignKey)$/.test(pc.fn)) { fks.push(fkTarget(kv(pc.args).pos[0] ?? "'x.id'")); continue; }
        if (pc && /^(Sequence|Identity|Computed|FetchedValue|CheckConstraint)$/.test(pc.short)) continue;
        if (!type) type = p;
      }
      if (pos[0] && isStr(pos[0])) col = unq(pos[0]);
      if (named.name && isStr(named.name) && call.short !== 'Field') col = unq(named.name);
      if (named.type_) type = named.type_;
      const a = annInner(ann);
      if (!type) type = a.type || (fks.length ? 'ForeignKey' : 'unknown');
      const pk = truthy(named.primary_key);
      const isMapped = /mapped_column/.test(call.fn) || call.short === 'Field';
      const nullable = named.nullable !== undefined ? truthy(named.nullable) : (isMapped ? a.nullable : true);
      const tc = callOf(type);
      const shortType = stripMod(tc ? `${stripMod(tc.fn)}(${tc.args})` : type);
      const c = addCol(t, col, /^(Enum|SAEnum|SqlEnum|ENUM)\b/.test(shortType) ? shortType.replace(/\(.*$/s, '') : shortType, nullable && !pk, pk);
      const enumArgs = tc && /^(Enum|SAEnum|SqlEnum|ENUM)$/.test(stripMod(tc.fn)) ? kv(tc.args).pos : null;
      if (enumArgs) {
        const strs = enumArgs.filter(isStr).map(unq);
        const en = enums.get(String(enumArgs.find((x) => !isStr(x)) ?? '').split('.').pop());
        t.samples[col] = strs.length ? strs : en?.names ?? [];
        if (en && !strs.length) c.type = `Enum(${enumArgs.find((x) => !isStr(x))})`;
      } else if (enums.has(a.type)) { t.samples[col] = enums.get(a.type).names; }
      if (named.foreign_key) fks.push(fkTarget(named.foreign_key));
      for (const fk of fks) pending.push({ t, col, ...fk });
      return c;
    };
    const ownStmts = (c, seen = new Set()) => {
      if (seen.has(c.name)) return [];
      seen.add(c.name);
      const mix = c.bases.map((b) => byName.get(b.split('.').pop())).filter((b) => b && !clsTable.has(b.name));
      return [...mix.flatMap((b) => ownStmts(b, seen)), ...c.stmts];
    };
    for (const c of tclasses) {
      const t = mkTable(clsTable.get(c.name));
      const sqlModel = c.bases.some((b) => /SQLModel/.test(b)) || ownStmts(c).some((s) => /=\s*Field\s*\(/.test(s));
      for (const s of ownStmts(c)) {
        if (/^(class|def|async|@|__\w+__)/.test(s)) continue;
        const m = assignRe.exec(s);
        if (m) {
          const call = callOf(m[3]);
          if (call && SA_SKIP.test(call.short)) continue;
          if (call && /(^|\.)(Column|mapped_column)$/.test(call.fn)) { columnCall(t, m[1], call, m[2]); continue; }
          if (call && call.short === 'Field') {
            const sa = kv(call.args).named.sa_column;
            const sc = sa && callOf(sa);
            if (sc) columnCall(t, m[1], sc, m[2]); else columnCall(t, m[1], call, m[2]);
            continue;
          }
          if (sqlModel && m[2] && !/ClassVar|List\[|list\[/.test(m[2])) columnCall(t, m[1], { fn: 'Field', short: 'Field', args: '' }, m[2]);
          continue;
        }
        const a = annotRe.exec(s);
        if (!a || /ClassVar|List\[|list\[|relationship|Relationship/.test(a[2])) continue;
        const inner = annInner(a[2]).type;
        if (clsTable.has(inner) || byName.has(inner) && !enums.has(inner)) continue;
        if (/^(?:\w+\.)?Mapped\[/.test(a[2].trim())) columnCall(t, a[1], { fn: 'mapped_column', short: 'mapped_column', args: '' }, a[2]);
        else if (sqlModel) columnCall(t, a[1], { fn: 'Field', short: 'Field', args: '' }, a[2]);
      }
      tables.push(t);
      used.add(c.file.path);
    }
    for (const f of files) {
      const src = f.clean;
      for (const m of src.matchAll(/(?:^|[=\s(])(?:sa\.|db\.|sqlalchemy\.)?Table\s*\(\s*(['"])(\w+)\1\s*,/g)) {
        const open = src.indexOf('(', m.index + m[0].indexOf('Table'));
        const args = splitTop(src.slice(open + 1, matchClose(src, open)));
        const t = mkTable(m[2]);
        for (const a of args.slice(1)) {
          const call = callOf(a);
          if (call && /(^|\.)Column$/.test(call.fn)) columnCall(t, '', call, null);
          if (call && /PrimaryKeyConstraint$/.test(call.fn)) t.pk.push(...kv(call.args).pos.filter(isStr).map(unq));
        }
        if (!tables.some((x) => x.name === t.name)) { tables.push(t); used.add(f.path); }
      }
    }
    for (const p of pending) addFk(p.t, p.col, p.table ?? clsTable.get(p.cls) ?? p.cls, [p.ref]);
    return { tables: tables.map(finalize), used };
  },
};
