export function skipStr(s, i) {
  const q = s[i];
  if (q === '"' && s.startsWith('"""', i)) { const e = s.indexOf('"""', i + 3); return e < 0 ? s.length : e + 2; }
  if (q === "'" && s.startsWith("'''", i)) { const e = s.indexOf("'''", i + 3); return e < 0 ? s.length : e + 2; }
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; if (s[j] === '\n' && q !== '`') break; j++; }
  return j;
}

export function stripComments(src, { slash = true, hash = false, block = slash } = {}) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === '`' || c === "'") { const j = skipStr(src, i); out += src.slice(i, j + 1); i = j + 1; continue; }
    if ((slash && c === '/' && src[i + 1] === '/') || (hash && c === '#' && src[i + 1] !== '{')) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (block && c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

export function matchClose(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = skipStr(s, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j;
  }
  return s.length;
}

export const inner = (s, i) => s.slice(i + 1, matchClose(s, i));

export function splitTop(s, sep = ',', angle = false) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { const j = skipStr(s, i); cur += s.slice(i, j + 1); i = j; continue; }
    if (c === '(' || c === '[' || c === '{' || (angle && c === '<')) depth++;
    else if (c === ')' || c === ']' || c === '}' || (angle && c === '>' && s[i - 1] !== '=' && s[i - 1] !== '-')) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export const unq = (s) => String(s ?? '').trim().replace(/^[@:]?(['"`])([\s\S]*)\1$/, '$2').replace(/^:(\w+)$/, '$1');
export const isStr = (s) => /^(['"`])[\s\S]*\1$/.test(String(s ?? '').trim());

export function kv(args) {
  const pos = [], named = {};
  for (const p of splitTop(args ?? '')) {
    const m = /^([\w$]+|'[^']*'|"[^"]*")\s*(?::(?!:)|=(?![=>]))\s*([\s\S]*)$/.exec(p);
    if (m) named[unq(m[1])] = m[2].trim(); else pos.push(p);
  }
  return { pos, named };
}

export const strList = (s) => [...String(s ?? '').matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1|:(\w+)/g)].map((m) => m[2] ?? m[3]);
export const truthy = (v) => /^(true|True|:true)$/.test(String(v ?? '').trim());
export const falsy = (v) => /^(false|False|:false)$/.test(String(v ?? '').trim());

export const snake = (n) => String(n).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
export const camel = (n) => String(n).replace(/_(\w)/g, (_, c) => c.toUpperCase());
export const lcFirst = (n) => n ? n[0].toLowerCase() + n.slice(1) : n;

export function plural(w) {
  if (/(?:^|_)(people|data|media|news|series|species|information|equipment)$/i.test(w)) return w;
  if (/person$/i.test(w)) return w.replace(/erson$/i, 'eople');
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + 'es';
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}

export function singular(w) {
  if (/people$/i.test(w)) return w.replace(/eople$/i, 'erson');
  if (/[^aeiou]ies$/i.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|x|z|ch|sh)es$/i.test(w)) return w.slice(0, -2);
  if (/[^s]s$/i.test(w)) return w.slice(0, -1);
  return w;
}

export const mkTable = (name, kind = 'table') => ({ name, kind, columns: [], pk: [], fks: [], rows: null, samples: {} });

export function addCol(t, name, type, nullable = true, pk = false) {
  let c = t.columns.find((x) => x.name === name);
  if (!c) { c = { name, type: String(type ?? 'unknown').trim(), nullable: !!nullable, pk: !!pk }; t.columns.push(c); }
  if (pk) { c.pk = true; c.nullable = false; if (!t.pk.includes(name)) t.pk.push(name); }
  return c;
}

export function addFk(t, column, refTable, refColumns = ['id']) {
  if (!refTable || t.fks.some((f) => f.columns[0] === column && f.refTable === refTable)) return;
  t.fks.push({ columns: [column], refTable, refColumns });
}

export function finalize(t) {
  t.pk = [...new Set(t.pk)];
  for (const c of t.columns) if (t.pk.includes(c.name)) { c.pk = true; c.nullable = false; }
  for (const k of Object.keys(t.samples)) if (!t.samples[k]?.length) delete t.samples[k];
  return t;
}

export function scanMembers(body) {
  const out = []; let decos = [], i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s;,]/.test(body[i])) i++;
    if (i >= n) break;
    if (body[i] === '@') {
      const m = /^@([\w.:]+)/.exec(body.slice(i, i + 200));
      if (!m) { i++; continue; }
      i += m[0].length;
      let j = i;
      while (j < n && /[ \t]/.test(body[j])) j++;
      let args = null;
      if (body[j] === '(') { const e = matchClose(body, j); args = body.slice(j + 1, e); i = e + 1; }
      decos.push({ name: m[1].split(/[.:]/).pop(), args });
      continue;
    }
    if (body[i] === '[' && /^\[\s*[A-Z]/.test(body.slice(i, i + 20))) {
      const e = matchClose(body, i);
      for (const a of splitTop(body.slice(i + 1, e))) { const m = /^([\w.]+)\s*(?:\(([\s\S]*)\))?$/.exec(a); if (m) decos.push({ name: m[1].split('.').pop(), args: m[2] ?? null }); }
      i = e + 1;
      continue;
    }
    let j = i, depth = 0, block = false;
    while (j < n) {
      const c = body[j];
      if (c === '"' || c === "'" || c === '`') { j = skipStr(body, j) + 1; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === '{' && depth === 0) {
        const e = matchClose(body, j);
        const pre = body.slice(i, j);
        if (/=\s*$|:\s*$|=>\s*$/.test(pre) && !/\)\s*(:\s*[\w<>\[\]., |]+)?\s*$/.test(pre)) { j = e + 1; continue; }
        if (/\b(get|set|init)\s*$/.test(pre) || /^\s*(?:\w+\s+)*[\w<>\[\]?,. ]+\s+\w+\s*$/.test(pre) && /\{\s*(get|set|init)\b/.test(body.slice(j, j + 40))) { out.push({ decos, decl: (pre + body.slice(j, e + 1)).trim(), prop: true }); decos = []; i = e + 1; block = true; break; }
        j = e + 1; i = j; decos = []; block = true; break;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if ((c === ';' || c === '\n') && depth <= 0) break;
      j++;
    }
    if (block) continue;
    const decl = body.slice(i, j).trim();
    if (decl) out.push({ decos, decl });
    decos = [];
    i = j + 1;
  }
  return out;
}

export const decoMap = (decos) => Object.fromEntries(decos.map((d) => [d.name, d]));
