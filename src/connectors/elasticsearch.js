import { SAMPLE_COL_RE } from './common.js';

export function parseElasticUrl(url) {
  const m = String(url).match(/^(?:elasticsearch|elastic|opensearch|es)(?:\+(https?))?:\/\/(.*)$/i);
  const raw = m ? `${m[1] || 'http'}://${m[2]}` : String(url);
  const u = new URL(raw);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const apiKey = u.searchParams.get('apiKey') || u.searchParams.get('api_key');
  if (apiKey) headers.authorization = `ApiKey ${apiKey}`;
  else if (u.username) headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
  const index = u.pathname.replace(/^\/+|\/+$/g, '') || null;
  return { base: `${u.protocol}//${u.host}`, headers, index };
}

export function flattenMapping(properties = {}) {
  const out = [];
  const typeOf = (p) => {
    const t = p.type ?? (p.properties ? 'object' : 'unknown');
    const subs = Object.entries(p.fields ?? {}).map(([k, v]) => `${k}:${v.type}`);
    return subs.length ? `${t} (${subs.join(', ')})` : t;
  };
  const kwPath = (name, p) => {
    if (p.type === 'keyword') return name;
    const sub = Object.entries(p.fields ?? {}).find(([, v]) => v.type === 'keyword');
    return sub ? `${name}.${sub[0]}` : null;
  };
  for (const [k, p] of Object.entries(properties)) {
    out.push({ name: k, type: typeOf(p), keyword: kwPath(k, p) });
    if (p.properties) for (const [k2, p2] of Object.entries(p.properties)) out.push({ name: `${k}.${k2}`, type: typeOf(p2), keyword: p.type === 'nested' ? null : kwPath(`${k}.${k2}`, p2) });
  }
  return out;
}

export async function introspect({ url, config, samples = true }) {
  const cfg = config ?? parseElasticUrl(url);
  const call = async (path, body) => {
    const r = await fetch(cfg.base + path, { method: body ? 'POST' : 'GET', headers: cfg.headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Elasticsearch ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const info = await call('/').catch((e) => { throw new Error(`Elasticsearch'e bağlanılamadı (${cfg.base}): ${e.message}`); });
  const cat = await call(`/_cat/indices${cfg.index ? '/' + encodeURIComponent(cfg.index) : ''}?format=json&h=index,docs.count,status`);
  const indices = cat.filter((i) => !i.index.startsWith('.') && i.status !== 'close').sort((a, b) => a.index.localeCompare(b.index));
  const tables = [];
  for (const i of indices) {
    const enc = encodeURIComponent(i.index);
    let props = {};
    try { const mp = await call(`/${enc}/_mapping`); props = Object.values(mp)[0]?.mappings?.properties ?? {}; } catch {}
    const fields = flattenMapping(props);
    const t = {
      name: i.index, kind: 'index',
      columns: [{ name: '_id', type: 'keyword', nullable: false, pk: true }, ...fields.map((f) => ({ name: f.name, type: f.type, nullable: true, pk: false }))],
      pk: ['_id'], fks: [], rows: i['docs.count'] == null ? null : Number(i['docs.count']), samples: {},
    };
    if (samples && t.rows) {
      const want = fields.filter((f) => f.keyword && SAMPLE_COL_RE.test(f.name.split('.').pop()));
      if (want.length) {
        const aggs = Object.fromEntries(want.map((f, n) => [`a${n}`, { terms: { field: f.keyword, size: 8 } }]));
        try {
          const r = await call(`/${enc}/_search`, { size: 0, track_total_hits: false, aggs });
          want.forEach((f, n) => {
            const a = r.aggregations?.[`a${n}`];
            if (a?.buckets?.length && !a.sum_other_doc_count) t.samples[f.name] = a.buckets.map((b) => b.key_as_string ?? b.key);
          });
        } catch {}
      }
    }
    tables.push(t);
  }
  const flavor = info.version?.distribution === 'opensearch' ? 'opensearch' : 'elasticsearch';
  return { dialect: flavor, database: `${info.cluster_name ?? flavor} @ ${cfg.base}`, tables };
}
