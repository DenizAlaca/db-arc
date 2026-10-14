import { SAMPLE_COL_RE } from './common.js';

export function parseNeo4jUrl(url) {
  const m = String(url).match(/^((?:neo4j|bolt)(?:\+s|\+ssc)?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i);
  if (!m) throw new Error(`Geçersiz Neo4j adresi: ${url}`);
  const qs = new URLSearchParams(m[6] ?? '');
  return {
    uri: `${m[1].toLowerCase()}://${m[4]}`,
    user: m[2] ? decodeURIComponent(m[2]) : qs.get('user') || 'neo4j', password: m[3] ? decodeURIComponent(m[3]) : qs.get('password') || '',
    database: m[5] ? decodeURIComponent(m[5]) : qs.get('database') || undefined,
  };
}

export const relTableName = (a, type, b) => `(:${a})-[:${type}]->(:${b})`;
const bq = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const cleanType = (s) => String(s).replace(/^:/, '').replace(/`/g, '');

export async function introspect({ url, config, samples = true }) {
  const mod = await import('neo4j-driver').catch(() => { throw new Error('Neo4j için "neo4j-driver" paketi gerekli: npm i neo4j-driver'); });
  const neo4j = mod.default ?? mod;
  const cfg = config ?? parseNeo4jUrl(url);
  const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), { connectionTimeout: 10000, disableLosslessIntegers: true });
  const session = driver.session({ database: cfg.database, defaultAccessMode: neo4j.session.READ });
  const q = async (cypher, params = {}, timeout = 15000) => (await session.run(cypher, params, { timeout })).records.map((r) => r.toObject());
  const jsType = (v) => v === null || v === undefined ? 'null' : Array.isArray(v) ? 'List' : typeof v === 'number' ? (Number.isInteger(v) ? 'Long' : 'Double') : typeof v === 'string' ? 'String' : typeof v === 'boolean' ? 'Boolean' : v?.constructor?.name ?? 'Map';
  try {
    const labels = (await q('CALL db.labels() YIELD label RETURN label ORDER BY label')).map((r) => r.label);
    const props = new Map(labels.map((l) => [l, new Map()]));
    let viaSchema = false;
    try {
      for (const r of await q('CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory RETURN nodeLabels, propertyName, propertyTypes, mandatory', {}, 20000)) {
        if (!r.propertyName) continue;
        for (const l of r.nodeLabels ?? []) {
          const m = props.get(l); if (!m) continue;
          const p = m.get(r.propertyName) ?? { types: new Set(), mandatory: true };
          (r.propertyTypes ?? []).forEach((t) => p.types.add(t)); p.mandatory = p.mandatory && r.mandatory;
          m.set(r.propertyName, p);
        }
      }
      viaSchema = true;
    } catch {}
    if (!viaSchema) {
      for (const l of labels) {
        const rows = await q(`MATCH (n:${bq(l)}) WITH n LIMIT 50 RETURN properties(n) AS p`);
        const m = props.get(l);
        for (const { p } of rows) for (const [k, v] of Object.entries(p)) { const e = m.get(k) ?? { types: new Set(), count: 0 }; e.types.add(jsType(v)); e.count++; m.set(k, e); }
        for (const e of m.values()) e.mandatory = e.count === rows.length;
      }
    }
    const keys = new Map();
    try {
      for (const c of await q('SHOW CONSTRAINTS YIELD entityType, labelsOrTypes, properties, type RETURN entityType, labelsOrTypes, properties, type')) {
        if (c.entityType !== 'NODE' || !/UNIQUE|KEY/.test(c.type)) continue;
        const l = c.labelsOrTypes?.[0]; const prev = keys.get(l);
        if (!prev || (/KEY/.test(c.type) && !prev.nodeKey)) keys.set(l, { cols: c.properties, nodeKey: /KEY/.test(c.type) });
      }
    } catch {}
    const tables = []; const byName = new Map();
    for (const l of labels) {
      const pk = keys.get(l)?.cols ?? ['__id'];
      const t = { name: l, kind: 'node', columns: [], pk, fks: [], rows: null, samples: {} };
      if (pk[0] === '__id') t.columns.push({ name: '__id', type: 'elementId', nullable: false, pk: true });
      for (const [k, p] of props.get(l)) t.columns.push({ name: k, type: [...p.types].join('|') || 'any', nullable: !p.mandatory && !pk.includes(k), pk: pk.includes(k) });
      try { t.rows = (await q(`MATCH (n:${bq(l)}) RETURN count(n) AS n`))[0].n; } catch {}
      if (samples && t.rows) {
        for (const c of t.columns) {
          if (c.pk || !SAMPLE_COL_RE.test(c.name) || !/String/i.test(c.type)) continue;
          try {
            const vals = await q(`MATCH (n:${bq(l)}) WHERE n.${bq(c.name)} IS NOT NULL WITH n LIMIT 5000 RETURN DISTINCT n.${bq(c.name)} AS v LIMIT 9`, {}, 5000);
            if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((r) => r.v);
          } catch {}
        }
      }
      tables.push(t); byName.set(l, t);
    }
    const triples = new Map();
    const addTriple = (a, type, b) => { if (byName.has(a) && byName.has(b)) triples.set(relTableName(a, type, b), { a, type, b }); };
    try {
      for (const r of await q('MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS a, type(r) AS t, labels(b) AS b LIMIT 200', {}, 10000)) for (const a of r.a) for (const b of r.b) addTriple(a, r.t, b);
    } catch {
      try {
        const [viz] = await q('CALL db.schema.visualization()');
        const nodeLabel = new Map((viz?.nodes ?? []).map((n) => [n.elementId ?? String(n.identity), n.labels?.[0] ?? n.properties?.name]));
        for (const r of viz?.relationships ?? []) addTriple(nodeLabel.get(r.startNodeElementId ?? String(r.start)), r.type, nodeLabel.get(r.endNodeElementId ?? String(r.end)));
      } catch {}
    }
    const relProps = new Map();
    try {
      for (const r of await q('CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory RETURN relType, propertyName, propertyTypes, mandatory', {}, 20000)) {
        if (!r.propertyName) continue;
        const type = cleanType(r.relType); const m = relProps.get(type) ?? new Map();
        m.set(r.propertyName, { type: (r.propertyTypes ?? []).join('|') || 'any', mandatory: r.mandatory }); relProps.set(type, m);
      }
    } catch {}
    for (const [name, { a, type, b }] of [...triples].sort(([x], [y]) => x.localeCompare(y))) {
      const ta = byName.get(a); const tb = byName.get(b);
      const t = {
        name, kind: 'relationship',
        columns: [{ name: '__from', type: 'node', nullable: false, pk: false }, { name: '__to', type: 'node', nullable: false, pk: false }],
        pk: [], fks: [{ columns: ['__from'], refTable: a, refColumns: ta.pk.slice(0, 1) }, { columns: ['__to'], refTable: b, refColumns: tb.pk.slice(0, 1) }],
        rows: null, samples: {},
      };
      for (const [k, p] of relProps.get(type) ?? []) t.columns.push({ name: k, type: p.type, nullable: !p.mandatory, pk: false });
      try { t.rows = (await q(`MATCH (:${bq(a)})-[r:${bq(type)}]->(:${bq(b)}) RETURN count(r) AS n`, {}, 5000))[0].n; } catch {}
      tables.push(t);
    }
    let database = cfg.database;
    if (!database) try { database = (await q('CALL db.info() YIELD name RETURN name'))[0]?.name; } catch {}
    return { dialect: 'neo4j', database: database ?? 'neo4j', tables };
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}
