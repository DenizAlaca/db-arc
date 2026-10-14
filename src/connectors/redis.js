export async function introspect({ url }) {
  const { createClient } = await import('redis').catch(() => { throw new Error('Redis için "redis" paketi gerekli: npm i redis'); });
  const client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 5000 } }); client.on('error', () => {}); await client.connect();
  try {
    const groups = new Map(); let n = 0;
    for await (const batch of client.scanIterator({ COUNT: 500 })) {
      for (const k of [].concat(batch)) {
        const pattern = k.split(':').map((seg, i) => (i > 0 && (/\d/.test(seg) && seg.length >= 3 || /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg)) ? '*' : seg)).join(':');
        const g = groups.get(pattern) ?? { count: 0, sample: k }; g.count++; groups.set(pattern, g);
        if (++n > 20000) break;
      }
      if (n > 20000) break;
    }
    const tables = [];
    for (const [pattern, g] of groups) {
      const type = await client.type(g.sample);
      let columns = [{ name: 'key', type: 'string', nullable: false, pk: true }];
      if (type === 'hash') columns = columns.concat(Object.keys(await client.hGetAll(g.sample)).map((f) => ({ name: f, type: 'string', nullable: true, pk: false })));
      else columns.push({ name: 'value', type, nullable: false, pk: false });
      tables.push({ name: pattern, kind: type, columns, pk: ['key'], fks: [], rows: g.count, samples: {} });
    }
    const names = new Set(tables.map((t) => t.name));
    for (const t of tables) {
      const parts = t.name.split(':');
      for (let i = parts.length - 1; i > 0; i--) {
        const parent = parts.slice(0, i).join(':');
        if (parent !== t.name && names.has(parent)) { t.columns.push({ name: '__parent', type: 'key', nullable: false, pk: false }); t.fks.push({ columns: ['__parent'], refTable: parent, refColumns: ['key'] }); break; }
      }
    }
    return { dialect: 'redis', database: url.replace(/\/\/.*@/, '//***@'), tables };
  } finally { await client.quit().catch(() => {}); }
}
