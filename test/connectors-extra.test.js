import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOracleUrl } from '../src/connectors/oracle.js';
import { parseDynamoUrl } from '../src/connectors/dynamodb.js';
import { parseCassandraUrl } from '../src/connectors/cassandra.js';
import { parseElasticUrl, flattenMapping } from '../src/connectors/elasticsearch.js';
import { parseNeo4jUrl, relTableName } from '../src/connectors/neo4j.js';
import { parseClickhouseUrl, enumValues } from '../src/connectors/clickhouse.js';
import { parseLibsqlUrl } from '../src/connectors/libsql.js';

test('oracle url', () => {
  assert.deepEqual(parseOracleUrl('oracle://scott:t%40ger@db.local:1521/ORCLPDB1?schema=hr'), { user: 'scott', password: 't@ger', connectString: 'db.local:1521/ORCLPDB1', schema: 'hr' });
  assert.equal(parseOracleUrl('oracle://u:p@h/XE').connectString, 'h:1521/XE');
});

test('dynamodb url', () => {
  assert.deepEqual(parseDynamoUrl('dynamodb://eu-central-1'), { region: 'eu-central-1' });
  assert.deepEqual(parseDynamoUrl('dynamodb://localhost:8000?region=x'), { region: 'x', endpoint: 'http://localhost:8000', local: true });
});

test('cassandra url', () => {
  const c = parseCassandraUrl('cassandra://u:p@h1:9142,h2/shop?dc=dc2');
  assert.deepEqual(c.contactPoints, ['h1', 'h2']);
  assert.equal(c.port, 9142); assert.equal(c.keyspace, 'shop'); assert.equal(c.localDataCenter, 'dc2'); assert.equal(c.user, 'u');
});

test('elasticsearch url and mapping', () => {
  const e = parseElasticUrl('elasticsearch+https://el:pw@search.local:9243');
  assert.equal(e.base, 'https://search.local:9243');
  assert.equal(e.headers.authorization, `Basic ${Buffer.from('el:pw').toString('base64')}`);
  assert.equal(parseElasticUrl('elasticsearch://localhost:9200').base, 'http://localhost:9200');
  const f = flattenMapping({ status: { type: 'text', fields: { raw: { type: 'keyword' } } }, address: { properties: { city: { type: 'keyword' }, geo: { properties: { lat: { type: 'float' } } } } } });
  assert.deepEqual(f.map((x) => [x.name, x.type, x.keyword]), [
    ['status', 'text (raw:keyword)', 'status.raw'], ['address', 'object', null], ['address.city', 'keyword', 'address.city'], ['address.geo', 'object', null],
  ]);
});

test('neo4j url', () => {
  assert.deepEqual(parseNeo4jUrl('neo4j+s://neo4j:secret@abc.databases.neo4j.io:7687/movies'), { uri: 'neo4j+s://abc.databases.neo4j.io:7687', user: 'neo4j', password: 'secret', database: 'movies' });
  assert.equal(relTableName('Customer', 'PLACED', 'Order'), '(:Customer)-[:PLACED]->(:Order)');
});

test('clickhouse url and enums', () => {
  assert.deepEqual(parseClickhouseUrl('clickhouse://u:p@ch:8123/shop'), { base: 'http://ch:8123', user: 'u', password: 'p', database: 'shop' });
  assert.equal(parseClickhouseUrl('clickhouse://ch:8443').base, 'https://ch:8443');
  assert.deepEqual(enumValues("Enum8('new' = 1, 'it\\'s' = 2)"), ['new', "it's"]);
  assert.equal(enumValues('String'), null);
});

test('libsql url', () => {
  const l = parseLibsqlUrl('libsql://mydb-org.turso.io?authToken=abc');
  assert.equal(l.url, 'libsql://mydb-org.turso.io'); assert.equal(l.authToken, 'abc'); assert.equal(l.name, 'mydb-org');
});
