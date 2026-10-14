export async function introspect(source, opts = {}) {
  const samples = opts.samples !== false;
  switch (source.type) {
    case 'sqlite': return (await import('./sqlite.js')).introspect({ file: source.file, samples });
    case 'postgres': return (await import('./postgres.js')).introspect({ url: source.url, samples });
    case 'mysql': return (await import('./mysql.js')).introspect({ url: source.url, config: source.config, samples });
    case 'mssql': return (await import('./mssql.js')).introspect({ config: source.config, samples });
    case 'mongodb': return (await import('./mongo.js')).introspect({ url: source.url, samples });
    case 'firestore': return (await import('./firestore.js')).introspect({ credentials: source.credentials, projectId: source.projectId, samples });
    case 'redis': return (await import('./redis.js')).introspect({ url: source.url });
    case 'oracle': return (await import('./oracle.js')).introspect({ url: source.url, samples });
    case 'dynamodb': return (await import('./dynamodb.js')).introspect({ url: source.url, samples });
    case 'cassandra': return (await import('./cassandra.js')).introspect({ url: source.url, samples });
    case 'elasticsearch': return (await import('./elasticsearch.js')).introspect({ url: source.url, samples });
    case 'neo4j': return (await import('./neo4j.js')).introspect({ url: source.url, samples });
    case 'clickhouse': return (await import('./clickhouse.js')).introspect({ url: source.url, samples });
    case 'libsql': return (await import('./libsql.js')).introspect({ url: source.url, samples });
    case 'code': return (await import('./code.js')).introspect({ dir: source.dir });
    case 'prisma': return (await import('./prisma.js')).introspect({ file: source.file });
    case 'sql': return (await import('./sqlddl.js')).introspect({ files: source.files });
    default: throw new Error(`Desteklenmeyen kaynak: ${source.type}`);
  }
}
