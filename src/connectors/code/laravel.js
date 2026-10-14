import { stripComments, splitTop, matchClose, inner, unq, isStr, strList, plural, snake, mkTable, addCol, addFk, finalize } from './util.js';

const SKIP = new Set(['index', 'unique', 'fullText', 'fulltext', 'spatialIndex', 'dropColumn', 'dropColumns', 'renameColumn', 'dropForeign', 'dropIndex', 'dropUnique', 'dropPrimary', 'dropTimestamps', 'dropSoftDeletes', 'engine', 'charset', 'collation', 'comment', 'temporary', 'rawIndex', 'dropConstrainedForeignId', 'dropForeignIdFor', 'dropMorphs']);
const PK_TYPES = new Set(['id', 'increments', 'bigIncrements', 'smallIncrements', 'mediumIncrements', 'tinyIncrements', 'integerIncrements']);

function chain(stmt) {
  const out = []; let i = 0;
  while (i < stmt.length) {
    const m = /^\s*->\s*(\w+)\s*\(/.exec(stmt.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = matchClose(stmt, open);
    out.push({ fn: m[1], args: stmt.slice(open + 1, close) });
    i = close + 1;
  }
  return out;
}

function applyBlock(t, body) {
  for (const stmt of splitTop(body, ';')) {
    const m = /^\$\w+((?:\s*->[\s\S]*)?)$/.exec(stmt.trim());
    if (!m) continue;
    const calls = chain(m[1]);
    if (!calls.length) continue;
    const [head, ...mods] = calls;
    const args = splitTop(head.args);
    const has = (fn) => mods.find((c) => c.fn === fn);
    const nullable = !!has('nullable') && !/false/.test(has('nullable').args);
    const fn = head.fn;
    if (SKIP.has(fn)) continue;
    if (fn === 'timestamps' || fn === 'timestampsTz' || fn === 'nullableTimestamps') { addCol(t, 'created_at', 'timestamp', true); addCol(t, 'updated_at', 'timestamp', true); continue; }
    if (fn === 'softDeletes' || fn === 'softDeletesTz') { addCol(t, args[0] ? unq(args[0]) : 'deleted_at', 'timestamp', true); continue; }
    if (fn === 'rememberToken') { addCol(t, 'remember_token', 'string(100)', true); continue; }
    if (/^(nullable|uuid|ulid)?[mM]orphs$/.test(fn) || /^nullable(Uuid|Ulid)?Morphs$/.test(fn)) {
      const n = unq(args[0]);
      addCol(t, `${n}_id`, /uuid/i.test(fn) ? 'uuid' : /ulid/i.test(fn) ? 'ulid' : 'unsignedBigInteger', /^nullable/.test(fn));
      addCol(t, `${n}_type`, 'string', /^nullable/.test(fn));
      continue;
    }
    if (fn === 'primary') { t.pk = isStr(args[0]) ? [unq(args[0])] : strList(args[0]); continue; }
    if (fn === 'foreign') {
      const cols = isStr(args[0]) ? [unq(args[0])] : strList(args[0]);
      const ref = has('references'), on = has('on');
      if (on) addFk(t, cols[0], unq(splitTop(on.args)[0]), ref ? strList(ref.args) : ['id']);
      continue;
    }
    if (fn === 'foreignIdFor') {
      const model = /(\w+)::class/.exec(args[0])?.[1] ?? unq(args[0]);
      const col = args[1] ? unq(args[1]) : `${snake(model)}_id`;
      addCol(t, col, 'foreignId', nullable);
      if (has('constrained')) addFk(t, col, splitTop(has('constrained').args)[0] ? unq(splitTop(has('constrained').args)[0]) : plural(snake(model)));
      continue;
    }
    if (PK_TYPES.has(fn)) { addCol(t, args[0] ? unq(args[0]) : 'id', fn, false, true); continue; }
    if (!args.length || !isStr(args[0])) continue;
    const name = unq(args[0]);
    let type = fn;
    if (/^(string|char)$/.test(fn) && args[1] && /^\d+$/.test(args[1])) type = `${fn}(${args[1]})`;
    if (/^(decimal|float|double)$/.test(fn) && args[1]) type = `${fn}(${args.slice(1).join(',')})`;
    const c = addCol(t, name, type, nullable, !!has('primary'));
    if (fn === 'enum' || fn === 'set') t.samples[name] = strList(args[1]);
    if (/^foreign(Id|Uuid|Ulid)$/.test(fn) || has('constrained') || has('references')) {
      const con = has('constrained');
      if (con) addFk(t, name, splitTop(con.args)[0] ? unq(splitTop(con.args)[0]) : plural(name.replace(/_id$/, '')), splitTop(con.args)[1] ? [unq(splitTop(con.args)[1])] : ['id']);
      else if (has('references') && has('on')) addFk(t, name, unq(splitTop(has('on').args)[0]), strList(has('references').args));
    }
    if (fn.startsWith('unsigned') || fn.startsWith('foreign')) c.type = fn;
  }
}

export default {
  id: 'laravel',
  want: (rel, ext) => ext === '.php' && /migrations?\//i.test(rel),
  detect: /Schema::create\s*\(/,
  keep: /Schema::/,
  parse(files) {
    const map = new Map(), used = new Set();
    for (const f of [...files].sort((a, b) => a.rel.split('/').pop().localeCompare(b.rel.split('/').pop()))) {
      const src = stripComments(f.src, { slash: true, hash: false });
      for (const m of src.matchAll(/Schema::(?:connection\([^)]*\)\s*->\s*)?(create|table|drop|dropIfExists|rename)\s*\(\s*(['"])([\w.]+)\2\s*(?:,\s*(['"])([\w.]+)\4)?/g)) {
        const [, op, , name, , to] = m;
        if (op === 'drop' || op === 'dropIfExists') { if (map.get(name)?.file === f.path) continue; map.delete(name); continue; }
        if (op === 'rename') { const t = map.get(name); if (t && to) { map.delete(name); t.name = to; map.set(to, t); } continue; }
        let t = map.get(name);
        if (!t) { if (op !== 'create') continue; t = mkTable(name); t.file = f.path; map.set(name, t); }
        const brace = src.indexOf('{', m.index + m[0].length);
        if (brace < 0) continue;
        applyBlock(t, inner(src, brace));
        used.add(f.path);
      }
    }
    const tables = [...map.values()].map((t) => { delete t.file; return finalize(t); });
    return { tables, used };
  },
};
