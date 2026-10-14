import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { introspect, hasModels } from '../src/connectors/code.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'code');
const load = (eco) => introspect({ dir: join(FX, eco) });
const tbl = (r, name) => { const t = r.tables.find((x) => x.name === name); assert.ok(t, `table ${name} missing; got ${r.tables.map((x) => x.name)}`); return t; };
const col = (t, name) => { const c = t.columns.find((x) => x.name === name); assert.ok(c, `column ${t.name}.${name} missing; got ${t.columns.map((x) => x.name)}`); return c; };
const hasFk = (t, column, refTable) => assert.ok(t.fks.some((f) => f.columns[0] === column && f.refTable === refTable), `${t.name}.${column} -> ${refTable} missing; got ${JSON.stringify(t.fks)}`);

test('rails schema.rb', async () => {
  const r = await load('rails');
  assert.equal(r.dialect, 'code:rails');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  assert.equal(col(users, 'email').nullable, false);
  hasFk(users, 'account_id', 'accounts');
  assert.deepEqual(users.samples.role, ['member', 'admin', 'owner']);
  const posts = tbl(r, 'posts');
  assert.equal(col(posts, 'id').type, 'uuid');
  hasFk(posts, 'author_id', 'users');
  assert.deepEqual(tbl(r, 'posts_tags').pk, []);
});

test('laravel migrations', async () => {
  const r = await load('laravel');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  assert.deepEqual(users.samples.status, ['active', 'suspended', 'deleted']);
  const orders = tbl(r, 'orders');
  hasFk(orders, 'user_id', 'users');
  hasFk(orders, 'approver_id', 'users');
  hasFk(orders, 'coupon_id', 'coupons');
  assert.equal(col(orders, 'approver_id').nullable, true);
  col(orders, 'note');
  col(orders, 'deleted_at');
});

test('django models', async () => {
  const r = await load('django');
  const customers = tbl(r, 'customers');
  assert.deepEqual(customers.pk, ['id']);
  col(customers, 'created_at');
  hasFk(customers, 'user_id', 'auth_user');
  const order = tbl(r, 'shop_order');
  assert.deepEqual(order.pk, ['code']);
  hasFk(order, 'customer_id', 'customers');
  hasFk(order, 'ref_code', 'shop_order');
  assert.deepEqual(order.samples.status, ['pending', 'paid', 'shipped']);
  assert.deepEqual(order.samples.kind, ['web', 'store']);
  const m2m = tbl(r, 'shop_order_tags');
  hasFk(m2m, 'order_id', 'shop_order');
  hasFk(m2m, 'tag_id', 'shop_tag');
  assert.ok(!r.tables.some((t) => /timestamped/.test(t.name)));
});

test('sqlalchemy + sqlmodel', async () => {
  const r = await load('sqlalchemy');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  assert.equal(col(users, 'email').nullable, false);
  assert.deepEqual(users.samples.role, ['admin', 'viewer']);
  const posts = tbl(r, 'posts');
  hasFk(posts, 'author_id', 'users');
  assert.equal(col(posts, 'summary').nullable, true);
  assert.deepEqual(posts.samples.post_state, ['draft', 'live']);
  assert.ok(!posts.columns.some((c) => c.name === 'author'));
  const hero = tbl(r, 'hero');
  assert.deepEqual(hero.pk, ['id']);
  hasFk(hero, 'team_id', 'team');
  const ug = tbl(r, 'user_groups');
  assert.deepEqual(ug.pk, ['user_id', 'group_id']);
  hasFk(ug, 'group_id', 'groups');
});

test('typeorm entities', async () => {
  const r = await load('typeorm');
  const customers = tbl(r, 'customers');
  assert.deepEqual(customers.pk, ['id']);
  assert.deepEqual(customers.samples.tier, ['free', 'pro', 'enterprise']);
  col(customers, 'created_at');
  assert.ok(!customers.columns.some((c) => c.name === 'orders' || c.name === 'label'));
  const orders = tbl(r, 'orders');
  hasFk(orders, 'customer_id', 'customers');
  assert.equal(col(orders, 'customer_id').nullable, false);
  assert.deepEqual(orders.samples.status, ['new', 'paid', 'cancelled']);
  hasFk(tbl(r, 'product'), 'itemSku', 'product_item');
  hasFk(tbl(r, 'order_products'), 'productId', 'product');
});

test('sequelize models', async () => {
  const r = await load('sequelize');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  col(users, 'display_name');
  assert.deepEqual(users.samples.status, ['active', 'banned']);
  const posts = tbl(r, 'posts');
  assert.deepEqual(posts.pk, ['id']);
  hasFk(posts, 'authorId', 'users');
  const comments = tbl(r, 'Comments');
  hasFk(comments, 'postId', 'posts');
  hasFk(comments, 'userId', 'users');
});

test('mongoose schemas', async () => {
  const r = await load('mongoose');
  const users = tbl(r, 'users');
  assert.equal(users.kind, 'collection');
  assert.deepEqual(users.pk, ['_id']);
  assert.deepEqual(users.samples.role, ['admin', 'editor', 'reader']);
  hasFk(users, 'org', 'organizations');
  col(users, 'address.city');
  col(users, 'createdAt');
  const orgs = tbl(r, 'organizations');
  hasFk(orgs, 'members', 'users');
});

test('drizzle tables', async () => {
  const r = await load('drizzle');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  assert.deepEqual(users.samples.role, ['admin', 'member', 'guest']);
  assert.equal(col(users, 'email').nullable, false);
  hasFk(tbl(r, 'posts'), 'author_id', 'users');
  const likes = tbl(r, 'post_likes');
  assert.deepEqual(likes.pk, ['post_id', 'user_id']);
  hasFk(likes, 'post_id', 'posts');
});

test('ef core entities', async () => {
  const r = await load('efcore');
  const customers = tbl(r, 'Customers');
  assert.deepEqual(customers.pk, ['Id']);
  assert.equal(col(customers, 'Email').nullable, true);
  assert.ok(!customers.columns.some((c) => c.name === 'Orders'));
  const orders = tbl(r, 'orders');
  hasFk(orders, 'CustomerId', 'Customers');
  assert.deepEqual(orders.samples.Status, ['Pending', 'Shipped', 'Delivered']);
  assert.equal(col(orders, 'shipped_on').nullable, true);
  assert.equal(col(orders, 'shipped_on').type, 'DateTime');
  assert.ok(!orders.columns.some((c) => c.name === 'Display'));
  const inv = tbl(r, 'billing_invoices');
  assert.deepEqual(inv.pk, ['Number']);
  hasFk(inv, 'OrderRef', 'orders');
});

test('jpa java entities', async () => {
  const r = await load('jpa');
  const orders = tbl(r, 'orders');
  assert.deepEqual(orders.pk, ['id']);
  col(orders, 'total_amount');
  assert.equal(col(orders, 'quantity').nullable, false);
  hasFk(orders, 'customer_id', 'customers');
  assert.deepEqual(orders.samples.status, ['NEW', 'PAID', 'SHIPPED']);
  assert.ok(!orders.columns.some((c) => c.name === 'cached' || c.name === 'lines'));
  tbl(r, 'Coupon');
  const jt = tbl(r, 'order_coupons');
  hasFk(jt, 'coupon_id', 'Coupon');
  assert.ok(!r.tables.some((t) => t.name === 'BaseEntity'));
});

test('jpa kotlin entities', async () => {
  const r = await load('jpa-kotlin');
  const accounts = tbl(r, 'accounts');
  assert.deepEqual(accounts.pk, ['id']);
  col(accounts, 'display_name');
  assert.deepEqual(accounts.samples.plan, ['FREE', 'PRO']);
  const members = tbl(r, 'members');
  assert.equal(col(members, 'nickname').nullable, true);
  hasFk(members, 'account_id', 'accounts');
});

test('gorm structs', async () => {
  const r = await load('gorm');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  col(users, 'deleted_at');
  assert.equal(col(users, 'email').nullable, true);
  assert.ok(!users.columns.some((c) => c.name === 'ignored'));
  hasFk(users, 'company_id', 'companies');
  assert.deepEqual(users.samples.role, ['admin', 'member']);
  hasFk(tbl(r, 'credit_cards'), 'user_id', 'users');
  const langs = tbl(r, 'langs');
  assert.deepEqual(langs.pk, ['lang_code']);
  assert.deepEqual(langs.samples.kind, ['natural', 'programming']);
  hasFk(tbl(r, 'user_languages'), 'user_id', 'users');
});

test('ecto schemas', async () => {
  const r = await load('ecto');
  const users = tbl(r, 'users');
  assert.deepEqual(users.pk, ['id']);
  assert.equal(col(users, 'id').type, 'binary_id');
  hasFk(users, 'org_id', 'orgs');
  hasFk(users, 'invited_by_id', 'users');
  assert.deepEqual(users.samples.role, ['admin', 'member']);
  col(users, 'inserted_at');
  hasFk(tbl(r, 'users_teams'), 'user_id', 'users');
});

test('mixed project returns both ecosystems', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbscope-code-'));
  try {
    cpSync(join(FX, 'django'), join(dir, 'backend'), { recursive: true });
    cpSync(join(FX, 'drizzle'), join(dir, 'web'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'schema.ts'), "export const junk = pgTable('junk', { id: serial('id') });");
    assert.equal(hasModels(dir), true);
    const r = await introspect({ dir });
    assert.match(r.dialect, /^code:/);
    assert.ok(r.dialect.includes('django') && r.dialect.includes('drizzle'));
    assert.match(r.database, /^\d+ model file\(s\)$/);
    tbl(r, 'shop_order');
    tbl(r, 'post_likes');
    assert.ok(!r.tables.some((t) => t.name === 'junk'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty project throws and hasModels is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbscope-code-'));
  try {
    writeFileSync(join(dir, 'index.js'), 'console.log(1);');
    assert.equal(hasModels(dir), false);
    await assert.rejects(introspect({ dir }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every table has the expected shape', async () => {
  const r = await introspect({ dir: FX });
  for (const t of r.tables) {
    assert.ok(['table', 'collection'].includes(t.kind));
    assert.equal(t.rows, null);
    assert.equal(typeof t.samples, 'object');
    for (const c of t.columns) assert.deepEqual(Object.keys(c).sort(), ['name', 'nullable', 'pk', 'type']);
    for (const f of t.fks) assert.ok(Array.isArray(f.columns) && typeof f.refTable === 'string' && Array.isArray(f.refColumns));
  }
});
