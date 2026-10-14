import { stripComments, splitTop, matchClose, inner, unq, kv, falsy, mkTable, addCol, addFk, finalize, scanMembers, decoMap } from './util.js';

const PRIMS = /^(int|long|short|byte|boolean|double|float|char)$/;
const NOTNULL = ['NotNull', 'NonNull', 'NotBlank', 'NotEmpty', 'Nonnull'];

function enumsOf(src, map) {
  for (const m of src.matchAll(/\benum\s+(?:class\s+)?(\w+)\s*(?:\([^)]*\))?\s*(?::\s*[^{]+|implements\s+[^{]+)?\{/g)) {
    const body = inner(src, m.index + m[0].length - 1);
    const head = splitTop(body, ';')[0] ?? '';
    map.set(m[1], splitTop(head).map((p) => /^(?:@\w+(?:\([^)]*\))?\s*)*([A-Za-z_]\w*)/.exec(p)?.[1]).filter(Boolean));
  }
}

const ann = (args) => kv(args ?? '');
const annStr = (args, key) => { const { pos, named } = ann(args); const v = named[key] ?? (key === 'value' || key === 'name' ? pos[0] : undefined); return v === undefined ? undefined : unq(v); };

export default {
  id: 'jpa',
  want: (rel, ext) => ext === '.java' || ext === '.kt',
  detect: /@(?:jakarta\.persistence\.|javax\.persistence\.)?Entity\b/,
  keep: /@Entity|@MappedSuperclass|\benum\b/,
  parse(files) {
    const enums = new Map(), classes = new Map();
    for (const f of files) {
      const src = stripComments(f.src);
      const kotlin = f.rel.endsWith('.kt');
      enumsOf(src, enums);
      let prevEnd = 0;
      for (const m of src.matchAll(/\b(?:(?:data|open|abstract|final|sealed|public|private|internal)\s+)*class\s+(\w+)(?:<[^>{(]*>)?/g)) {
        const pre = src.slice(prevEnd, m.index);
        let i = m.index + m[0].length, ctor = '';
        while (/\s/.test(src[i] ?? '')) i++;
        const ctorAnn = /^(?:(?:@\w+(?:\([^)]*\))?\s*)*constructor\s*)?/.exec(src.slice(i))[0];
        i += ctorAnn.length;
        if (src[i] === '(') { const e = matchClose(src, i); ctor = src.slice(i + 1, e); i = e + 1; }
        const tail = /^\s*(?:(?:extends|:)\s*([\w.]+)(?:<[^>{]*>)?(?:\([^)]*\))?)?(?:\s*(?:implements|,)\s*[\w.<>, ()]+?)?\s*\{/.exec(src.slice(i));
        let body = '';
        if (tail) { const open = i + tail[0].length - 1; body = inner(src, open); prevEnd = open; }
        else prevEnd = i;
        const base = tail?.[1] ?? /^\s*(?:extends|:)\s*([\w.]+)/.exec(src.slice(i))?.[1];
        const lastStop = Math.max(pre.lastIndexOf(';'), pre.lastIndexOf('}\n'));
        const anns = scanMembers(`${pre.slice(lastStop + 1)} __x`).pop()?.decos ?? [];
        classes.set(m[1], { name: m[1], base: base?.split('.').pop(), anns: decoMap(anns), body, ctor, kotlin, file: f });
      }
    }
    const tableOf = (n) => {
      const c = classes.get(n);
      if (!c) return n;
      return annStr(c.anns.Table?.args, 'name') ?? annStr(c.anns.Entity?.args, 'name') ?? n;
    };
    const membersOf = (c, seen = new Set()) => {
      if (!c || seen.has(c.name)) return [];
      seen.add(c.name);
      const base = classes.get(c.base);
      const ctorMembers = c.ctor ? splitTop(c.ctor, ',', true).map((p) => scanMembers(p.replace(/\n/g, ' '))[0]).filter(Boolean) : [];
      return [...(base && (base.anns.MappedSuperclass || base.anns.Entity) ? membersOf(base, seen) : []), ...ctorMembers, ...scanMembers(c.body)];
    };
    const tables = [], used = new Set(), pend = [];
    for (const c of classes.values()) {
      if (!c.anns.Entity) continue;
      const t = mkTable(tableOf(c.name));
      for (const { decos, decl } of membersOf(c)) {
        const d = decoMap(decos);
        let name, type, nullable;
        const k = /^(?:(?:private|public|protected|internal|open|override|lateinit|final)\s+)*(?:val|var)\s+(\w+)\s*:\s*([^=]+?)\s*(?:=[\s\S]*)?$/.exec(decl);
        const j = !k && /^((?:(?:public|private|protected|final|volatile|static|transient)\s+)*)([\w.<>\[\]?, ]+?)\s+(\w+)\s*(?:=[\s\S]*)?$/.exec(decl);
        if (k) { name = k[1]; type = k[2].trim(); nullable = type.endsWith('?'); type = type.replace(/\?$/, ''); }
        else if (j) { if (/\b(static|transient)\b/.test(j[1])) continue; name = j[3]; type = j[2].trim(); nullable = !PRIMS.test(type); }
        else continue;
        if (/^(return|package|import|throw)$/.test(name) || d.Transient || d.OneToMany || d.Formula) continue;
        const pk = !!(d.Id || d.EmbeddedId);
        if (NOTNULL.some((x) => d[x])) nullable = false;
        if (d.ManyToOne || d.OneToOne) {
          const rel = d.ManyToOne ?? d.OneToOne;
          const ro = ann(rel.args).named;
          if (ro.mappedBy) continue;
          const jc = d.JoinColumn ?? (d.JoinColumns && { args: /@JoinColumn\s*\(([^)]*)\)/.exec(d.JoinColumns.args ?? '')?.[1] });
          const col = annStr(jc?.args, 'name') ?? `${name}_id`;
          const refCol = annStr(jc?.args, 'referencedColumnName') ?? 'id';
          const target = /^(?:Lazy|Optional)?<?([\w.]+)>?$/.exec(type)?.[1]?.split('.').pop() ?? type;
          addCol(t, col, 'fk', !falsy(ro.optional) && !falsy(ann(jc?.args).named.nullable) && (k ? nullable : true), pk || !!d.MapsId);
          pend.push({ t, col, target, refCol });
          continue;
        }
        if (d.ManyToMany) {
          if (ann(d.ManyToMany.args).named.mappedBy || !d.JoinTable) continue;
          const jt = d.JoinTable.args ?? '';
          const target = /<\s*([\w.]+)\s*>/.exec(type)?.[1]?.split('.').pop();
          pend.push({ junction: true, owner: t.name, ownerClass: c.name, prop: name, target, jt });
          continue;
        }
        if (d.ElementCollection || d.Embedded) continue;
        const colA = d.Column?.args;
        const col = annStr(colA, 'name') ?? name;
        if (colA && falsy(ann(colA).named.nullable)) nullable = false;
        const len = ann(colA).named.length;
        const cdef = annStr(colA, 'columnDefinition');
        const short = type.split('.').pop();
        addCol(t, col, cdef ?? (len && /^(String|CharSequence)$/.test(type) ? `${type}(${len})` : type), nullable && !pk, pk);
        if (enums.has(short)) t.samples[col] = enums.get(short);
      }
      tables.push(t);
      used.add(c.file.path);
    }
    for (const p of pend) {
      if (p.junction) {
        const jt = ann(p.jt).named;
        const tt = tableOf(p.target);
        const jtab = mkTable(jt.name ? unq(jt.name) : `${p.owner}_${tt}`);
        const a = /@?JoinColumn\s*\(([^)]*)\)/.exec(jt.joinColumns ?? '');
        const b = /@?JoinColumn\s*\(([^)]*)\)/.exec(jt.inverseJoinColumns ?? '');
        const ca = annStr(a?.[1], 'name') ?? `${p.owner}_id`, cb = annStr(b?.[1], 'name') ?? `${p.prop}_id`;
        const pkType = (n) => tables.find((x) => x.name === n)?.columns.find((c) => c.pk)?.type ?? 'Long';
        addCol(jtab, ca, pkType(p.owner), false, true); addCol(jtab, cb, pkType(tt), false, true);
        addFk(jtab, ca, p.owner, [tables.find((x) => x.name === p.owner)?.pk[0] ?? 'id']); addFk(jtab, cb, tt, [tables.find((x) => x.name === tt)?.pk[0] ?? 'id']);
        if (!tables.some((x) => x.name === jtab.name)) tables.push(jtab);
        continue;
      }
      const rt = tables.find((x) => x.name === tableOf(p.target));
      const c = p.t.columns.find((x) => x.name === p.col);
      if (c?.type === 'fk') c.type = rt?.columns.find((x) => x.name === p.refCol || x.pk)?.type ?? 'Long';
      addFk(p.t, p.col, tableOf(p.target), [p.refCol === 'id' && rt?.pk.length === 1 ? rt.pk[0] : p.refCol]);
    }
    return { tables: tables.map(finalize), used };
  },
};
