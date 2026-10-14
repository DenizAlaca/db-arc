export async function introspect({ credentials, projectId, samples = true }) {
  const admin = await import('firebase-admin').catch(() => { throw new Error('Firebase için "firebase-admin" paketi gerekli: npm i firebase-admin'); });
  const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app');
  const { getFirestore, DocumentReference, Timestamp, GeoPoint } = await import('firebase-admin/firestore');
  void admin;
  const app = getApps().find((a) => a.name === 'dbscope') ?? initializeApp({ credential: credentials ? cert(credentials) : applicationDefault(), projectId }, 'dbscope');
  const db = getFirestore(app);
  const tables = [];
  const typeOf = (v) => v === null ? 'null' : v instanceof DocumentReference ? 'ref' : v instanceof Timestamp ? 'timestamp' : v instanceof GeoPoint ? 'geopoint' : Array.isArray(v) ? 'array' : typeof v;

  async function scan(collRef, name, parent, depth) {
    const snap = await collRef.limit(40).get();
    const fields = new Map(); const refs = new Map();
    for (const doc of snap.docs) {
      for (const [k, v] of Object.entries(doc.data())) {
        const f = fields.get(k) ?? { types: new Set(), count: 0, values: new Set() };
        const ty = typeOf(v); f.types.add(ty); f.count++;
        if (ty === 'ref') refs.set(k, v.parent.id);
        if (typeof v === 'string' && v.length < 40 && f.values.size < 10) f.values.add(v);
        fields.set(k, f);
      }
    }
    let rows = snap.size;
    try { rows = (await collRef.count().get()).data().count; } catch {}
    const t = { name, kind: 'collection', columns: [{ name: '__id', type: 'docId', nullable: false, pk: true }], pk: ['__id'], fks: [], rows, samples: {} };
    for (const [k, f] of fields) {
      t.columns.push({ name: k, type: [...f.types].join('|'), nullable: f.count < snap.size, pk: false });
      if (samples && /(status|state|type|kind|role)$/i.test(k) && f.values.size && f.values.size < 9) t.samples[k] = [...f.values];
    }
    for (const [col, target] of refs) t.fks.push({ columns: [col], refTable: target, refColumns: ['__id'] });
    if (parent) { t.columns.push({ name: '__parent', type: 'docId', nullable: false, pk: false }); t.fks.push({ columns: ['__parent'], refTable: parent, refColumns: ['__id'] }); }
    tables.push(t);
    if (depth < 1) {
      const subNames = new Set();
      for (const doc of snap.docs.slice(0, 5)) for (const sc of await doc.ref.listCollections()) subNames.add(sc.id);
      for (const sub of subNames) {
        const first = snap.docs.find(Boolean);
        if (first) await scan(first.ref.collection(sub), `${name}/${sub}`, name, depth + 1);
      }
    }
  }
  for (const c of await db.listCollections()) await scan(c, c.id, null, 0);
  return { dialect: 'firestore', database: projectId ?? app.options.projectId ?? 'firestore', tables };
}
