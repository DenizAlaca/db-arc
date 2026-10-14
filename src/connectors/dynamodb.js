import { SAMPLE_COL_RE } from './common.js';

const ENTITY_RE = /^(type|entity|entityType|entity_type|__typename|_type|_et)$/i;
const TYPE_NAMES = { S: 'string', N: 'number', B: 'binary', BOOL: 'boolean', NULL: 'null', M: 'map', L: 'list', SS: 'string-set', NS: 'number-set', BS: 'binary-set' };

export function parseDynamoUrl(url) {
  const m = String(url).match(/^dynamodb(\+https?)?:\/\/(.*)$/i);
  const u = new URL(`http://${m ? m[2] : url}`);
  const host = u.hostname;
  const region = u.searchParams.get('region') || (/^[a-z]{2}(-[a-z]+)+-\d$/.test(host) ? host : process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1');
  const isRegion = host === region && !u.port;
  if (!host || isRegion) return { region };
  const proto = m?.[1] ? m[1].slice(1) : (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/.test(host) || u.port ? 'http' : 'https');
  return { region, endpoint: `${proto}://${u.host}`, local: /^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal|dynamodb-local)/.test(host) };
}

export async function introspect({ url, config, samples = true }) {
  const sdk = await import('@aws-sdk/client-dynamodb').catch(() => { throw new Error('DynamoDB için "@aws-sdk/client-dynamodb" paketi gerekli: npm i @aws-sdk/client-dynamodb'); });
  const { DynamoDBClient, ListTablesCommand, DescribeTableCommand, ScanCommand } = sdk;
  const cfg = config ?? parseDynamoUrl(url);
  const client = new DynamoDBClient({
    region: cfg.region, endpoint: cfg.endpoint, maxAttempts: 2,
    credentials: cfg.local ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'dummy', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'dummy' } : undefined,
  });
  try {
    const names = []; let start;
    do {
      const r = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }));
      names.push(...(r.TableNames ?? [])); start = r.LastEvaluatedTableName;
    } while (start);
    const tables = [];
    for (const name of names) {
      const d = (await client.send(new DescribeTableCommand({ TableName: name }))).Table;
      const attrTypes = new Map((d.AttributeDefinitions ?? []).map((a) => [a.AttributeName, TYPE_NAMES[a.AttributeType] ?? a.AttributeType]));
      const keyOrder = (ks) => [...(ks ?? [])].sort((a, b) => (a.KeyType === 'HASH' ? -1 : 1) - (b.KeyType === 'HASH' ? -1 : 1)).map((k) => k.AttributeName);
      const pk = keyOrder(d.KeySchema);
      const idx = [...(d.GlobalSecondaryIndexes ?? []).map((g) => ['GSI', g]), ...(d.LocalSecondaryIndexes ?? []).map((g) => ['LSI', g])]
        .map(([k, g]) => `${k} ${g.IndexName}(${keyOrder(g.KeySchema).join(', ')})`);
      let items = [];
      try { items = (await client.send(new ScanCommand({ TableName: name, Limit: 25 }))).Items ?? []; } catch {}
      const fields = new Map();
      for (const it of items) {
        for (const [k, v] of Object.entries(it)) {
          const f = fields.get(k) ?? { types: new Set(), count: 0, values: new Set() };
          const ty = Object.keys(v)[0]; f.types.add(TYPE_NAMES[ty] ?? ty); f.count++;
          if (ty === 'S' && v.S.length < 40 && f.values.size < 10) f.values.add(v.S);
          fields.set(k, f);
        }
      }
      const colNames = [...new Set([...pk, ...attrTypes.keys(), ...fields.keys()])];
      const singleTable = pk.length === 2 && colNames.some((c) => ENTITY_RE.test(c));
      const t = {
        name, kind: 'table', columns: [], pk, fks: [], rows: d.ItemCount ?? null, samples: {},
        comment: [idx.length ? idx.join('; ') : null, singleTable ? 'single-table design' : null].filter(Boolean).join(' | ') || undefined,
      };
      for (const c of colNames) {
        const f = fields.get(c);
        const type = attrTypes.get(c) ?? (f ? [...f.types].join('|') : 'any');
        t.columns.push({ name: c, type, nullable: !pk.includes(c) && (!f || f.count < items.length), pk: pk.includes(c) });
        if (samples && f && !pk.includes(c) && (SAMPLE_COL_RE.test(c) || (singleTable && ENTITY_RE.test(c))) && f.values.size && f.values.size < 9) t.samples[c] = [...f.values];
      }
      tables.push(t);
    }
    return { dialect: 'dynamodb', database: cfg.endpoint ? `${cfg.endpoint} (${cfg.region})` : cfg.region, tables };
  } finally {
    client.destroy();
  }
}
