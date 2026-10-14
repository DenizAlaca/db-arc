import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { getModel, runAnalysis, importSchema, contextForPrompt } from './engine.js';
import { formatTable, LEGEND } from './format.js';
import { findPath } from './match.js';
import { annotateTable, learn, loadKnowledge, saveKnowledge } from './knowledge.js';
import { logEvent } from './store.js';
import { startServer } from './server.js';
import { detectAll } from './detect.js';
import { identTerms, promptTerms } from './text.js';

const log = (...a) => console.error('[dbscope]', ...a);

const TOOLS = [
  { name: 'get_overview', description: 'Project purpose, modules, table names.', inputSchema: { type: 'object', properties: {} } },
  { name: 'relevant_tables', description: 'Tables/columns/relations relevant to a task (compact).', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'describe_tables', description: 'Full definition of tables: all columns, types, FKs, observed values, referencing tables.', inputSchema: { type: 'object', properties: { tables: { type: 'array', items: { type: 'string' } }, keysOnly: { type: 'boolean' } }, required: ['tables'] } },
  { name: 'search_schema', description: 'Search table/column names (TR/EN).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'find_path', description: 'Join path (FK chain) between two tables.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'annotate_table', description: 'Save a table\'s meaning and aliases users call it (improves matching).', inputSchema: { type: 'object', properties: { table: { type: 'string' }, description: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } } }, required: ['table'] } },
  { name: 'save_project_summary', description: 'Save what the project does (2-5 sentences); optional modules {id|name: {name, description}}.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, modules: { type: 'object' } }, required: ['summary'] } },
  { name: 'confirm_tables', description: 'After a DB task, record which tables were actually used (learning).', inputSchema: { type: 'object', properties: { task: { type: 'string' }, tables: { type: 'array', items: { type: 'string' } } }, required: ['task', 'tables'] } },
  { name: 'refresh_schema', description: 'Re-analyze the DB (after migrations). Optional db connection.', inputSchema: { type: 'object', properties: { db: { type: 'string' } } } },
  { name: 'submit_schema', description: 'Import a schema for datastores dbscope cannot reach: { dialect, database, tables:[{ name, columns:[{name,type,pk?}]|["col"], fks?:[{columns,refTable,refColumns}] }] }.', inputSchema: { type: 'object', properties: { schema: { type: 'object' } }, required: ['schema'] } },
  { name: 'dashboard_url', description: 'Local dashboard URL.', inputSchema: { type: 'object', properties: {} } },
];

function requireModel(projectDir) {
  const m = getModel(projectDir);
  if (!m) throw new Error('Henüz analiz yok. refresh_schema çağırın (gerekirse db parametresiyle) veya submit_schema ile şemayı verin.');
  return m;
}

function resolveTables(model, names) {
  const out = []; const missing = [];
  for (const n of names) {
    const t = model.tables.find((x) => x.name === n) ?? model.tables.find((x) => x.name.toLowerCase() === String(n).toLowerCase())
      ?? model.tables.find((x) => identTerms(x.name).join('_') === identTerms(n).join('_'));
    t ? out.push(t) : missing.push(n);
  }
  return { out, missing };
}

async function callTool(projectDir, name, args, ctx) {
  switch (name) {
    case 'get_overview': {
      const m = requireModel(projectDir);
      const lines = [
        `${m.dialect}:${m.database} — ${m.stats.tables} tables, ${m.stats.relations} relations (${m.stats.inferredRelations} inferred), ~${m.fullSchemaTokens} tokens if fully listed.`,
        `Purpose: ${m.purpose.summary.replace(/\*\*/g, '')}${m.purpose.auto ? ' (auto-inferred; refine with save_project_summary)' : ''}`,
        `Domains: ${m.purpose.domains.map((d) => `${d.name} ${Math.round(d.confidence * 100)}%`).join(', ')}`,
        'Modules:',
        ...m.modules.map((mod) => `- ${mod.id} ${mod.label ?? mod.name}${mod.description ? ` (${mod.description})` : ''}: ${mod.tables.join(', ')}`),
        `Dashboard: ${ctx.url ?? 'not running'}`,
      ];
      return lines.join('\n');
    }
    case 'relevant_tables': {
      const r = contextForPrompt(projectDir, args.task, { source: 'mcp' });
      return r.text || 'No table matched this task. Try search_schema with specific words, or get_overview.';
    }
    case 'describe_tables': {
      const m = requireModel(projectDir);
      const { out, missing } = resolveTables(m, args.tables ?? []);
      logEvent(projectDir, { type: 'tool', tool: name, tables: out.map((t) => t.name) });
      return [LEGEND, ...out.map((t) => formatTable(t, args.keysOnly ? 'keys' : 'full')),
        ...out.filter((t) => t.referencedBy?.length).map((t) => `${t.name} is referenced by: ${[...new Set(t.referencedBy.map((r) => `${r.table}.${r.column}`))].slice(0, 25).join(', ')}`),
        missing.length ? `Not found: ${missing.join(', ')}` : ''].filter(Boolean).join('\n');
    }
    case 'search_schema': {
      const m = requireModel(projectDir);
      const terms = promptTerms(args.query);
      const hits = [];
      for (const t of m.tables) {
        const tn = identTerms(t.name);
        const nameHit = tn.some((w) => terms.has(w));
        const cols = t.columns.filter((c) => identTerms(c.name).some((w) => terms.has(w))).map((c) => c.name);
        const aliasHit = (t.aliases ?? []).some((a) => identTerms(a).some((w) => terms.has(w)));
        if (nameHit || cols.length || aliasHit) hits.push({ t, score: (nameHit ? 5 : 0) + (aliasHit ? 4 : 0) + cols.length, cols });
      }
      hits.sort((a, b) => b.score - a.score);
      logEvent(projectDir, { type: 'tool', tool: name, query: args.query, tables: hits.slice(0, 20).map((h) => h.t.name) });
      return hits.length ? hits.slice(0, 30).map((h) => `${h.t.name}${h.cols.length ? ': ' + h.cols.join(', ') : ''}`).join('\n') : 'No matches.';
    }
    case 'find_path': {
      const m = requireModel(projectDir);
      const { out } = resolveTables(m, [args.from, args.to]);
      if (out.length < 2) return 'Table not found.';
      const p = findPath(m, out[0].name, out[1].name);
      logEvent(projectDir, { type: 'tool', tool: name, tables: [out[0].name, out[1].name] });
      return p ? p.join('\n') : `No FK path between ${out[0].name} and ${out[1].name}.`;
    }
    case 'annotate_table': {
      const m = requireModel(projectDir);
      const { out } = resolveTables(m, [args.table]);
      if (!out.length) return `Table not found: ${args.table}`;
      annotateTable(projectDir, out[0].name, args);
      logEvent(projectDir, { type: 'annotate', table: out[0].name, by: 'claude' });
      return `Saved for ${out[0].name}.`;
    }
    case 'save_project_summary': {
      const m = requireModel(projectDir);
      const k = loadKnowledge(projectDir);
      k.projectSummary = args.summary;
      for (const [key, v] of Object.entries(args.modules ?? {})) {
        const mod = m.modules.find((x) => x.id === key || x.name === key || x.label === key);
        if (mod) k.modules[mod.id] = { ...k.modules[mod.id], ...v };
      }
      saveKnowledge(projectDir, k);
      logEvent(projectDir, { type: 'summary', by: 'claude' });
      return 'Project summary saved.';
    }
    case 'confirm_tables': {
      const m = requireModel(projectDir);
      const { out } = resolveTables(m, args.tables ?? []);
      learn(projectDir, args.task, out.map((t) => t.name));
      logEvent(projectDir, { type: 'learn', prompt: String(args.task).slice(0, 300), tables: out.map((t) => t.name), by: 'claude' });
      return `Learned ${out.length} table(s) for this kind of task.`;
    }
    case 'refresh_schema': {
      const m = await runAnalysis(projectDir, { db: args.db });
      return `Analyzed ${m.stats.tables} tables, ${m.stats.relations} relations. ${m.purpose.summary.replace(/\*\*/g, '')}`;
    }
    case 'submit_schema': {
      const m = importSchema(projectDir, args.schema, 'submitted by Claude');
      return `Imported ${m.stats.tables} tables, ${m.stats.relations} relations (${m.stats.inferredRelations} inferred). Dashboard: ${ctx.url ?? '-'}`;
    }
    case 'dashboard_url': return ctx.url ?? 'Dashboard not running. Start with: dbscope serve';
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function runMcp(projectDir = process.env.DBSCOPE_PROJECT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
  projectDir = resolve(projectDir);
  const ctx = { url: null };
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  let hasSomething = !!getModel(projectDir) || detectAll(projectDir).length > 0;
  if (!hasSomething) { try { hasSomething = (await import('./connectors/code.js')).hasModels(projectDir); } catch {} }
  if (process.env.DBSCOPE_NO_UI !== '1' && hasSomething) {
    startServer(projectDir, { port: +(process.env.DBSCOPE_PORT ?? 4777), log }).then((s) => { ctx.url = s.url; }).catch((e) => log('dashboard failed:', e.message));
  }
  if (!getModel(projectDir) && hasSomething) {
    runAnalysis(projectDir).then((m) => log(`analyzed ${m.stats.tables} tables`)).catch((e) => log('auto-analysis skipped:', e.message));
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params } = msg;
    if (id === undefined) return;
    try {
      let result;
      if (method === 'initialize') {
        result = {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'dbscope', version: '0.1.0' },
          instructions: 'Schema of this project\'s DB. Relevant tables arrive with prompts as a [dbscope] block; use these tools instead of reading migrations/models. Call annotate_table when you learn a table\'s meaning, confirm_tables after DB tasks.',
        };
      } else if (method === 'tools/list') result = { tools: TOOLS };
      else if (method === 'tools/call') {
        try {
          const text = await callTool(projectDir, params.name, params.arguments ?? {}, ctx);
          result = { content: [{ type: 'text', text }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
      } else if (method === 'ping') result = {};
      else if (method === 'resources/list') result = { resources: [] };
      else if (method === 'prompts/list') result = { prompts: [] };
      else return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  });
  rl.on('close', () => process.exit(0));
}
