import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { detectAll, sourceFromString } from '../src/detect.js';
import { jdbcToUrl } from '../src/frameworks.js';

const fx = (d) => fileURLToPath(new URL(`./fixtures/frameworks/${d}`, import.meta.url));
const first = (d) => detectAll(fx(d))[0];

test('django settings.py', () => {
  const s = first('dj');
  assert.equal(s.type, 'postgres');
  assert.match(s.url, /app:secret@localhost:5432\/shop$/);
});

test('rails database.yml with ERB and anchors', () => {
  assert.match(first('rails').url, /^postgres:\/\/rails:@localhost:5432\/blog_development$/);
});

test('spring application.properties (JDBC + ${VAR:default})', () => {
  const s = first('spring');
  assert.equal(s.type, 'mysql');
  assert.match(s.url, /root:pw@localhost:3306\/inventory/);
});

test('elixir ecto config', () => {
  assert.match(first('ex').url, /postgres:postgres@localhost:5432\/my_app_dev/);
});

test('docker-compose services', () => {
  const all = detectAll(fx('cmp'));
  assert.deepEqual(all.map((s) => s.type), ['postgres', 'redis']);
  assert.match(all[0].url, /shop:pw@localhost:5433\/shopdb/);
});

test('jdbc urls', () => {
  assert.equal(jdbcToUrl('jdbc:postgresql://db:5432/app?user=u&password=p'), 'postgres://u:p@db:5432/app');
  assert.equal(jdbcToUrl('jdbc:sqlserver://h:1433;databaseName=crm;user=sa;password=x'), 'sqlserver://sa:x@h:1433/crm');
  assert.equal(jdbcToUrl('jdbc:oracle:thin:@//h:1521/ORCL', 'scott', 'tiger'), 'oracle://scott:tiger@h:1521/ORCL');
  assert.equal(sourceFromString('jdbc:mysql://h:3306/shop').type, 'mysql');
});
