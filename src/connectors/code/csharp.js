import { stripComments, splitTop, inner, unq, isStr, kv, mkTable, addCol, addFk, finalize, scanMembers, decoMap } from './util.js';

const SCALAR = /^(int|uint|long|ulong|short|ushort|byte|sbyte|string|bool|decimal|double|float|char|object|DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|Guid|byte\[\]|Int16|Int32|Int64|UInt16|UInt32|UInt64|Byte|String|Boolean|Decimal|Double|Single|Char|BigInteger|JsonDocument|JsonElement|Point|Geometry|NpgsqlRange<.*>|[\w.]+\[\])$/;
const COLLECTION = /^(?:I?Collection|I?List|IEnumerable|HashSet|ISet|IReadOnlyCollection|IReadOnlyList|ObservableCollection)<\s*(\w+)\s*>$/;

export default {
  id: 'efcore',
  want: (rel, ext) => ext === '.cs' && !/\/Migrations\/|\.Designer\.cs$|ModelSnapshot\.cs$/.test(rel),
  detect: /\bDbSet\s*<\s*\w+\s*>/,
  keep: /\b(class|record|enum)\b/,
  parse(files) {
    const enums = new Map(), classes = new Map(), sets = new Map(), fluent = new Map();
    const fl = (n) => { if (!fluent.has(n)) fluent.set(n, { pk: null, fks: [] }); return fluent.get(n); };
    const readFluent = (entity, text) => {
      const f = fl(entity);
      const tt = /ToTable\s*\(\s*"([^"]+)"/.exec(text);
      if (tt) f.table = tt[1];
      const hk = /HasKey\s*\(\s*\w+\s*=>\s*(?:new\s*\{([^}]*)\}|\w+\.(\w+))/.exec(text);
      if (hk) f.pk = hk[2] ? [hk[2]] : [...hk[1].matchAll(/\w+\.(\w+)/g)].map((x) => x[1]);
      for (const m of text.matchAll(/HasOne\s*(?:<\s*(\w+)\s*>)?\s*\(\s*(?:\w+\s*=>\s*\w+\.(\w+))?\s*\)[^;]*?HasForeignKey\s*(?:<\s*\w+\s*>)?\s*\(\s*(?:\w+\s*=>\s*\w+\.(\w+)|"(\w+)")/g)) f.fks.push({ nav: m[2], type: m[1], prop: m[3] ?? m[4] });
      for (const m of text.matchAll(/Property\s*\(\s*\w+\s*=>\s*\w+\.(\w+)\s*\)[^;]*?HasColumnName\s*\(\s*"(\w+)"/g)) (f.cols ??= {})[m[1]] = m[2];
    };
    for (const f of files) {
      const src = stripComments(f.src);
      f.clean = src;
      for (const m of src.matchAll(/\benum\s+(\w+)\s*(?::\s*\w+)?\s*\{/g)) enums.set(m[1], splitTop(inner(src, m.index + m[0].length - 1)).map((p) => p.replace(/\[[^\]]*\]/g, '').split('=')[0].trim()).filter((x) => /^\w+$/.test(x)));
      for (const m of src.matchAll(/\b(?:class|record)\s+(\w+)(?:<[^>{]*>)?(?:\s*\([^)]*\))?\s*(?::\s*([^{]+?))?\s*(?:where\s+[^{]+)?\{/g)) {
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        const cut = Math.max(before.lastIndexOf(';'), before.lastIndexOf('}'), before.lastIndexOf('{'));
        const attrs = before.slice(cut + 1);
        const base = m[2]?.split(',')[0].trim().replace(/<.*$/, '');
        const body = inner(src, m.index + m[0].length - 1);
        if (!classes.has(m[1]) || body.length > classes.get(m[1]).body.length) classes.set(m[1], { name: m[1], base, attrs, body, file: f });
        const cfg = /IEntityTypeConfiguration\s*<\s*(\w+)\s*>/.exec(m[2] ?? '');
        if (cfg) readFluent(cfg[1], body);
      }
      for (const m of src.matchAll(/DbSet\s*<\s*(\w+)\s*>\??\s+(\w+)/g)) sets.set(m[1], { name: m[2], file: f });
      for (const m of src.matchAll(/\.Entity\s*<\s*(\w+)\s*>\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const argsText = inner(src, open);
        const after = argsText.trim() ? argsText : src.slice(open, src.indexOf(';', open) + 1);
        readFluent(m[1], after);
      }
    }
    const entityNames = new Set([...sets.keys()].filter((n) => classes.has(n)));
    for (const n of fluent.keys()) if (classes.has(n)) entityNames.add(n);
    const tableOf = (n) => {
      const c = classes.get(n);
      const ta = c && /\[\s*(?:\w+\.)*Table\s*\(\s*"([^"]+)"/.exec(c.attrs);
      return ta?.[1] ?? fluent.get(n)?.table ?? sets.get(n)?.name ?? n;
    };
    const membersOf = (c, seen = new Set()) => {
      if (!c || seen.has(c.name)) return [];
      seen.add(c.name);
      return [...membersOf(classes.get(c.base), seen), ...scanMembers(c.body).filter((m) => m.prop)];
    };
    const tables = [], used = new Set();
    for (const name of entityNames) {
      const c = classes.get(name);
      const t = mkTable(tableOf(name));
      const props = [];
      for (const { decos, decl } of membersOf(c)) {
        const m = /^((?:(?:public|protected|internal|private|virtual|required|override|new|static|abstract|sealed)\s+)*)([\w.<>\[\]?, ]+?)\s+(\w+)\s*\{/.exec(decl);
        if (!m || /\bstatic\b/.test(m[1]) || !/\bpublic\b/.test(m[1])) continue;
        props.push({ decos: decoMap(decos), raw: m[2].trim(), prop: m[3] });
      }
      const flu = fluent.get(name) ?? { fks: [] };
      const colName = (p) => { const col = p.decos.Column; const a = col && kv(col.args ?? '').pos.find(isStr); return a ? unq(a) : flu.cols?.[p.prop] ?? p.prop; };
      const byProp = new Map(props.map((p) => [p.prop, p]));
      for (const p of props) {
        if (p.decos.NotMapped) continue;
        const nullable = p.raw.endsWith('?');
        const type = p.raw.replace(/\?$/, '');
        const isEnum = enums.has(type.split('.').pop());
        if (!SCALAR.test(type) && !isEnum) continue;
        const col = colName(p);
        const tn = p.decos.Column && kv(p.decos.Column.args ?? '').named.TypeName;
        const pk = !!p.decos.Key || (flu.pk ? flu.pk.includes(p.prop) : !t.pk.length && !props.some((x) => x.decos.Key) && (p.prop.toLowerCase() === 'id' || p.prop.toLowerCase() === `${name.toLowerCase()}id`));
        addCol(t, col, tn ? unq(tn) : type, nullable && !p.decos.Required, pk);
        if (isEnum) t.samples[col] = enums.get(type.split('.').pop());
      }
      if (flu.pk) t.pk = flu.pk.map((x) => byProp.has(x) ? colName(byProp.get(x)) : x);
      const fkFor = (navProp, navType, fkProp) => {
        const target = navType ?? byProp.get(navProp)?.raw.replace(/\?$/, '');
        if (!target || !entityNames.has(target)) return;
        const fp = fkProp ? byProp.get(fkProp) : byProp.get(`${navProp}Id`) ?? byProp.get(`${navProp}ID`) ?? byProp.get(`${target}Id`);
        if (!fp) return;
        const rt = classes.get(target);
        addFk(t, colName(fp), tableOf(target), [rt ? (membersOf(rt).map((x) => /\s(\w+)\s*\{/.exec(x.decl)?.[1]).find((x) => x && x.toLowerCase() === 'id') ?? 'Id') : 'Id']);
      };
      for (const f of flu.fks) fkFor(f.nav, f.type, f.prop);
      for (const p of props) {
        const type = p.raw.replace(/\?$/, '');
        if (COLLECTION.test(type) || p.decos.NotMapped) continue;
        const fa = p.decos.ForeignKey && unq(kv(p.decos.ForeignKey.args ?? '').pos[0] ?? '').replace(/^nameof\((\w+)\)$/, '$1');
        if (entityNames.has(type)) fkFor(p.prop, type, fa && byProp.has(fa) ? fa : null);
        else if (fa && byProp.has(fa)) fkFor(fa, null, p.prop);
      }
      tables.push(t);
      used.add(c.file.path);
      if (sets.get(name)) used.add(sets.get(name).file.path);
    }
    return { tables: tables.map(finalize), used };
  },
};
