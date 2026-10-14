import { SAMPLE_COL_RE } from './common.js';

export function parseClickhouseUrl(url) {
  const m = String(url).match(/^(?:clickhouse|ch)(?:\+(https?))?:\/\/(.*)$/i);
  const u = new URL(`http://${m ? m[2] : String(url).replace(/^\w+:\/\//, '')}`);
  const secure = m?.[1] === 'https' || u.searchParams.get('secure') === 'true' || u.searchParams.get('ssl') === 'true' || u.port === '8443' || (/^https:/i.test(url));
  return {
    base: `${secure ? 'https' : 'http'}://${u.hostname}:${u.port || (secure ? 8443 : 8123)}`,
    user: decodeURIComponent(u.username) || 'default', password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || u.searchParams.get('database') || null,
  };
}

export const enumValues = (type) => /Enum(8|16)?\(/.test(type) ? [...type.matchAll(/'((?:[^'\\]|\\.)*)'\s*=/g)].map((x) => x[1].replace(/\\(.)/g, '$1')) : null;

export async function introspect({ url, config, samples = true }) {
  const cfg = config ?? parseClickhouseUrl(url);
  const q = async (sql, params = {}) => {
    const qs = new URLSearchParams({ default_format: 'JSON', max_execution_time: '15' });
    for (const [k, v] of Object.entries(params)) qs.set(`param_${k}`, v);
    const r = await fetch(`${cfg.base}/?${qs}`, { method: 'POST', body: sql, headers: { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).data;
  };
  const id = (n) => '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
  const db = cfg.database ?? (await q('SELECT currentDatabase() AS d').catch((e) => { throw new Error(`ClickHouse'a bağlanılamadı (${cfg.base}): ${e.message}`); }))[0].d;
  const rels = await q(`SELECT name, engine, total_rows, primary_key, sorting_key, comment FROM system.tables WHERE database = {db:String} AND NOT startsWith(name, '.inner') AND NOT is_temporary ORDER BY name`, { db });
  const cols = await q(`SELECT table, name, type, is_in_primary_key, comment FROM system.columns WHERE database = {db:String} ORDER BY table, position`, { db });
  const tables = [];
  for (const r of rels) {
    const isView = /View$/.test(r.engine);
    const cs = cols.filter((c) => c.table === r.name);
    const keyOrder = String(r.primary_key || '').split(',').map((s) => s.trim());
    const pk = cs.filter((c) => Number(c.is_in_primary_key)).map((c) => c.name).sort((a, b) => (keyOrder.indexOf(a) + 1 || 999) - (keyOrder.indexOf(b) + 1 || 999));
    const t = {
      name: r.name, kind: isView ? 'view' : 'table',
      comment: [r.comment || null, `ENGINE ${r.engine}`, r.sorting_key ? `ORDER BY (${r.sorting_key})` : null].filter(Boolean).join(' | '),
      columns: cs.map((c) => ({ name: c.name, type: c.type, nullable: /^(LowCardinality\()?Nullable\(/.test(c.type), pk: pk.includes(c.name), comment: c.comment || undefined })),
      pk, fks: [], rows: r.total_rows == null ? null : Number(r.total_rows), samples: {},
    };
    for (const c of t.columns) { const ev = enumValues(c.type); if (ev?.length) t.samples[c.name] = ev; }
    if (samples && !isView && t.rows) {
      for (const c of t.columns) {
        if (t.samples[c.name] || c.pk || !SAMPLE_COL_RE.test(c.name) || !/String/.test(c.type)) continue;
        try {
          const vals = await q(`SELECT DISTINCT v FROM (SELECT ${id(c.name)} AS v FROM ${id(db)}.${id(r.name)} WHERE v IS NOT NULL LIMIT 100000) LIMIT 9`);
          if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((x) => x.v);
        } catch {}
      }
    }
    tables.push(t);
  }
  return { dialect: 'clickhouse', database: db, tables };
}
