export async function introspect({ url, samples = true }) {
  const { MongoClient } = await import('mongodb').catch(() => { throw new Error('MongoDB için "mongodb" paketi gerekli: npm i mongodb'); });
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db();
    const colls = await db.listCollections({}, { nameOnly: true }).toArray();
    const tables = [];
    for (const { name } of colls) {
      if (name.startsWith('system.')) continue;
      const c = db.collection(name);
      const docs = await c.aggregate([{ $sample: { size: 50 } }]).toArray();
      const fields = new Map();
      const walk = (obj, prefix, depth) => {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          const type = v === null ? 'null' : Array.isArray(v) ? 'array' : v?._bsontype ?? (v instanceof Date ? 'date' : typeof v);
          const f = fields.get(key) ?? { types: new Set(), count: 0, values: new Set() };
          f.types.add(type); f.count++;
          if (typeof v === 'string' && v.length < 40 && f.values.size < 10) f.values.add(v);
          fields.set(key, f);
          if (type === 'object' && depth < 1) walk(v, key, depth + 1);
        }
      };
      docs.forEach((d) => walk(d, '', 0));
      const t = { name, kind: 'collection', columns: [], pk: ['_id'], fks: [], rows: await c.estimatedDocumentCount(), samples: {} };
      for (const [k, f] of fields) {
        t.columns.push({ name: k, type: [...f.types].join('|'), nullable: f.count < docs.length, pk: k === '_id' });
        if (samples && /(status|state|type|kind|role)$/i.test(k) && f.values.size && f.values.size < 9) t.samples[k] = [...f.values];
      }
      tables.push(t);
    }
    return { dialect: 'mongodb', database: db.databaseName, tables };
  } finally {
    await client.close();
  }
}
