import { SAMPLE_COL_RE } from './common.js';

const SYSTEM_KS = /^(system|system_auth|system_schema|system_distributed|system_traces|system_views|system_virtual_schema|dse_.*|solr_admin|OpsCenter|system_distributed_everywhere)$/;

export function parseCassandraUrl(url) {
  const m = String(url).match(/^(?:cassandra|scylla|scylladb)(\+tls)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i);
  if (!m) throw new Error(`Geçersiz Cassandra adresi: ${url}`);
  const qs = new URLSearchParams(m[6] ?? '');
  const contactPoints = m[4].split(',').map((h) => h.trim()).filter(Boolean);
  const port = Number(contactPoints[0].match(/:(\d+)$/)?.[1] || 9042);
  return {
    contactPoints: contactPoints.map((h) => h.replace(/:\d+$/, '')), port,
    user: m[2] ? decodeURIComponent(m[2]) : undefined, password: m[3] ? decodeURIComponent(m[3]) : undefined,
    keyspace: m[5] ? decodeURIComponent(m[5]) : undefined,
    localDataCenter: qs.get('dc') || qs.get('datacenter') || 'datacenter1',
    tls: Boolean(m[1]) || qs.get('ssl') === 'true',
  };
}

export async function introspect({ url, config, samples = true }) {
  const mod = await import('cassandra-driver').catch(() => { throw new Error('Cassandra için "cassandra-driver" paketi gerekli: npm i cassandra-driver'); });
  const cassandra = mod.default ?? mod;
  const cfg = config ?? parseCassandraUrl(url);
  const client = new cassandra.Client({
    contactPoints: cfg.contactPoints, protocolOptions: { port: cfg.port }, localDataCenter: cfg.localDataCenter,
    credentials: cfg.user ? { username: cfg.user, password: cfg.password ?? '' } : undefined,
    sslOptions: cfg.tls ? { rejectUnauthorized: false } : undefined,
    socketOptions: { connectTimeout: 10000, readTimeout: 15000 },
  });
  await client.connect();
  const q = async (cql, p = []) => (await client.execute(cql, p, { prepare: true })).rows;
  const id = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  try {
    const keyspaces = cfg.keyspace ? [cfg.keyspace] : (await q('SELECT keyspace_name FROM system_schema.keyspaces')).map((r) => r.keyspace_name).filter((k) => !SYSTEM_KS.test(k));
    const multi = keyspaces.length > 1;
    const tables = [];
    for (const ks of keyspaces) {
      const rels = [
        ...(await q('SELECT table_name, comment FROM system_schema.tables WHERE keyspace_name=?', [ks])).map((r) => ({ name: r.table_name, kind: 'table', comment: r.comment })),
        ...(await q('SELECT view_name, base_table_name FROM system_schema.views WHERE keyspace_name=?', [ks]).catch(() => [])).map((r) => ({ name: r.view_name, kind: 'view', comment: `materialized view of ${r.base_table_name}` })),
      ];
      const cols = await q('SELECT table_name, column_name, kind, position, type, clustering_order FROM system_schema.columns WHERE keyspace_name=?', [ks]);
      let estimates = new Map();
      try {
        for (const r of await q('SELECT table_name, partitions_count FROM system.size_estimates WHERE keyspace_name=?', [ks])) estimates.set(r.table_name, (estimates.get(r.table_name) ?? 0) + Number(r.partitions_count));
      } catch { estimates = new Map(); }
      const rank = { partition_key: 0, clustering: 1, static: 2, regular: 3 };
      for (const r of rels) {
        const cs = cols.filter((c) => c.table_name === r.name).sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.column_name.localeCompare(b.column_name));
        const pk = cs.filter((c) => c.kind === 'partition_key' || c.kind === 'clustering').map((c) => c.column_name);
        const pkCols = cs.filter((c) => c.kind === 'partition_key').map((c) => c.column_name);
        const ckCols = cs.filter((c) => c.kind === 'clustering').map((c) => `${c.column_name} ${c.clustering_order?.toUpperCase() ?? 'ASC'}`);
        const t = {
          name: multi ? `${ks}.${r.name}` : r.name, kind: r.kind,
          comment: [r.comment || null, `PRIMARY KEY ((${pkCols.join(', ')})${ckCols.length ? ', ' + ckCols.join(', ') : ''})`].filter(Boolean).join(' | '),
          columns: cs.map((c) => ({ name: c.column_name, type: c.kind === 'static' ? `${c.type} static` : c.type, nullable: !pk.includes(c.column_name), pk: pk.includes(c.column_name) })),
          pk, fks: [], rows: estimates.has(r.name) ? estimates.get(r.name) : null, samples: {},
        };
        if (samples && r.kind === 'table') {
          for (const c of t.columns) {
            if (c.pk || !SAMPLE_COL_RE.test(c.name) || !/text|varchar|ascii/.test(c.type)) continue;
            try {
              const vals = new Set();
              for (const row of await q(`SELECT ${id(c.name)} AS v FROM ${id(ks)}.${id(r.name)} LIMIT 200`)) if (row.v != null) vals.add(row.v);
              if (vals.size && vals.size < 9) t.samples[c.name] = [...vals];
            } catch {}
          }
        }
        tables.push(t);
      }
    }
    return { dialect: 'cassandra', database: cfg.keyspace ?? keyspaces.join(','), tables };
  } finally {
    await client.shutdown().catch(() => {});
  }
}
