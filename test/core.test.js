import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { introspect } from '../src/connectors/index.js';
import { analyze } from '../src/analyze.js';
import { matchPrompt } from '../src/match.js';
import { sourceFromString } from '../src/detect.js';
import { stem, promptTerms } from '../src/text.js';

const fx = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

test('prisma schema → tables, FKs, enum values', async () => {
  const m = analyze(await introspect({ type: 'prisma', file: fx('schema.prisma') }), 'test');
  assert.deepEqual(m.tables.map((t) => t.name).sort(), ['Post', 'Tag', 'TagOnPost', 'users']);
  const post = m.tables.find((t) => t.name === 'Post');
  assert.deepEqual(post.refs.map((r) => [r.column, r.table]), [['author_id', 'users']]);
  assert.deepEqual(m.tables.find((t) => t.name === 'users').samples.role, ['ADMIN', 'USER']);
  assert.equal(m.tables.find((t) => t.name === 'TagOnPost').role, 'junction');
});

test('sql ddl → explicit + inferred relations', async () => {
  const m = analyze(await introspect({ type: 'sql', files: [fx('schema.sql')] }), 'test');
  const rel = (from, col) => m.relations.find((r) => r.from === from && r.fromCol === col);
  assert.equal(rel('orders', 'customer_id').to, 'customers');
  assert.equal(rel('orders', 'customer_id').inferred, false);
  assert.equal(rel('order_lines', 'order_id').inferred, false);
  assert.equal(rel('order_lines', 'product_id').to, 'products');
  assert.equal(rel('order_lines', 'product_id').inferred, true);
  assert.deepEqual(m.tables.find((t) => t.name === 'customers').samples.status, ['active', 'passive']);
});

test('turkish prompt matches english tables', async () => {
  const m = analyze(await introspect({ type: 'sql', files: [fx('schema.sql')] }), 'test');
  const r = matchPrompt(m, 'müşterilerin siparişlerini listele');
  const names = r.primary.map((p) => p.table);
  assert.ok(names.includes('customers') && names.includes('orders'), names.join(','));
  assert.equal(matchPrompt(m, 'merhaba nasılsın').primary.length, 0);
});

test('connection string detection', () => {
  assert.equal(sourceFromString('postgres://u:p@h/db').type, 'postgres');
  assert.equal(sourceFromString('mongodb+srv://u:p@c.x.net/app').type, 'mongodb');
  assert.equal(sourceFromString('sqlserver://sa:x@localhost:1433/app').config.database, 'app');
  assert.equal(sourceFromString('Host=localhost;Database=shop;Username=u;Password=p').type, 'postgres');
  assert.equal(sourceFromString('Server=.\\SQLEXPRESS;Database=shop;User Id=sa;Password=p').type, 'mssql');
  assert.equal(sourceFromString('Data Source=app.db').type, 'sqlite');
  assert.equal(sourceFromString('redis://localhost:6379').type, 'redis');
  assert.equal(sourceFromString('firestore://my-proj').projectId, 'my-proj');
});

test('stemming', () => {
  for (const [w, s] of [['orders', 'order'], ['categories', 'category'], ['warehouses', 'warehouse'], ['statuses', 'status'], ['addresses', 'address'], ['dining', 'dining']]) assert.equal(stem(w), s);
  assert.ok(promptTerms('siparişlerimi').has('order'));
});

test('user inputs (description, aliases, summary, module) reach the context', async () => {
  const { enrich } = await import('../src/knowledge.js');
  const { buildContext } = await import('../src/match.js');
  const raw = await introspect({ type: 'sql', files: [fx('schema.sql')] });
  const k = {
    projectSummary: 'Toptan satış yapan bir sipariş portalı. İkinci cümle.',
    tables: { order_lines: { description: 'Fatura kalemleri, iade süreçleri burada', aliases: ['sepet satiri'] } },
    modules: {}, glossary: {},
  };
  const m = enrich(analyze(raw, 'test'), k);
  m.modules[0].description = 'Satış süreci';
  const byAlias = matchPrompt(m, 'sepet satiri ekranı', k);
  assert.ok(byAlias.primary.some((p) => p.table === 'order_lines'));
  const byDesc = matchPrompt(m, 'iade akışını düzelt', k);
  assert.ok(byDesc.primary.some((p) => p.table === 'order_lines'), JSON.stringify(byDesc.primary));
  const ctx = buildContext(m, byAlias, { session: { id: 'x', sent: {} } });
  assert.match(ctx.text, /Toptan satış yapan bir sipariş portalı\./);
  assert.doesNotMatch(ctx.text, /İkinci cümle/);
  assert.match(ctx.text, /Fatura kalemleri, iade süreçleri burada/);
});

test('session dedup sends a table once', async () => {
  const { buildContext } = await import('../src/match.js');
  const m = analyze(await introspect({ type: 'sql', files: [fx('schema.sql')] }), 'test');
  const session = { id: 's', sent: {} };
  const a = buildContext(m, matchPrompt(m, 'siparişleri listele'), { session });
  const b = buildContext(m, matchPrompt(m, 'siparişlerin toplamı'), { session });
  assert.ok(a.newTables.length > 0);
  assert.equal(b.newTables.length, 0);
  assert.ok(b.tokens < a.tokens / 2);
});
