const TYPE_RULES = [
  [/^(n?var)?char|^character|^n?text|^string|^citext|^clob|^str$/, 'str'],
  [/^(big)?serial|^bigint|^int8|^long/, 'bigint'],
  [/^(tiny|small|medium)?int|^integer|^int[24]?$/, 'int'],
  [/^timestamp|^datetime|^smalldatetime|^date-time/, 'ts'],
  [/^date$/, 'date'],
  [/^time/, 'time'],
  [/^bool|^bit$/, 'bool'],
  [/^(numeric|decimal|money|smallmoney)/, 'dec'],
  [/^(real|float|double|number)/, 'num'],
  [/^(uuid|uniqueidentifier|guid)/, 'uuid'],
  [/^jsonb?/, 'json'],
  [/^enum/, 'enum'],
  [/^(bytea|blob|binary|varbinary|bytes|image)/, 'bin'],
];

export function shortType(t) {
  const s = String(t ?? '').trim().toLowerCase();
  if (!s) return '';
  for (const [re, out] of TYPE_RULES) if (re.test(s)) return out;
  return s.replace(/\s+/g, '').replace(/\(.*\)/, '');
}

const fmtRows = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const vals = (v) => '{' + v.slice(0, 8).map((x) => String(x).slice(0, 24)).join(',') + '}';

function pickColumns(t, refBy, { maxCols, focus }) {
  if (!maxCols || t.columns.length <= maxCols) return { cols: t.columns, hidden: 0 };
  const keep = new Set();
  for (const c of t.columns) if (c.pk || refBy.has(c.name) || t.samples?.[c.name]) keep.add(c.name);
  if (focus?.size) for (const c of t.columns) if (c.name.toLowerCase().split(/(?=[A-Z])|_/).some((w) => focus.has(w.toLowerCase()))) keep.add(c.name);
  for (const c of t.columns) { if (keep.size >= maxCols) break; keep.add(c.name); }
  const cols = t.columns.filter((c) => keep.has(c.name));
  return { cols, hidden: t.columns.length - cols.length };
}

export function formatTable(t, mode = 'full', opts = {}) {
  const refBy = new Map((t.refs ?? []).map((r) => [r.column, r]));
  const head = `${t.name}${t.role && t.role !== 'entity' ? `[${t.role}]` : ''}${t.rows ? ` ~${fmtRows(t.rows)}` : ''}`;
  if (mode === 'name') return head;
  const { cols, hidden: pruned } = mode === 'full' ? pickColumns(t, refBy, opts) : { cols: t.columns, hidden: 0 };
  const parts = [];
  let hidden = pruned;
  for (const c of cols) {
    const r = refBy.get(c.name);
    if (mode === 'keys' && !c.pk && !r) { hidden++; continue; }
    let s = c.name;
    if (c.pk) s += ' pk';
    if (r) s += `→${r.table}${r.refColumn && !/^id$/i.test(r.refColumn) ? '.' + r.refColumn : ''}${r.inferred ? '?' : ''}`;
    else if (!c.pk) { const ty = shortType(c.type); if (ty) s += ' ' + ty; }
    if (opts.nullability && c.nullable === false && !c.pk && !r) s += '!';
    if (t.samples?.[c.name]) s += vals(t.samples[c.name]);
    parts.push(s);
  }
  if (hidden) parts.push(`+${hidden} cols`);
  const desc = t.description ? ` — ${t.description}` : '';
  return `${head}: ${parts.join(', ')}${desc}`;
}

export const LEGEND = 'Format: Table[role] ~rows: col type; pk; col→Table = FK (? inferred); {..} observed values; +N cols = omitted (describe_tables).';
