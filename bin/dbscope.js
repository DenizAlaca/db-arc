#!/usr/bin/env node
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => { if (/SQLite|ExperimentalWarning|MetadataLookup/.test(String(w) + String(rest[0]))) return; return emit.call(process, w, ...rest); };

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['db', 'port', 'dir', 'project', 'max-turns', 'model'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const cmd = flags.help || flags.h ? 'help' : pos.shift() ?? 'serve';
const { resolve } = await import('node:path');
const projectDir = () => resolve(flags.dir ?? flags.project ?? (['serve', 'analyze', 'detect', 'install', 'open'].includes(cmd) ? pos[0] : undefined) ?? process.cwd());

const HELP = `dbscope — DB schema map for Claude (any database, any language)

  dbscope [serve] [dir] [--db <conn>] [--port 4777] [--no-open]   analyze (if needed) + open dashboard
  dbscope analyze [dir] [--db <conn>] [--no-samples]               (re)analyze the database
  dbscope detect  [dir]                                            list detected DB sources
  dbscope context "<prompt>" [--dir d]                             print the context block for a prompt
  dbscope import <schema.json> [--dir d]                           import a schema (any datastore)
  dbscope install [dir] | --global                                 wire into Claude Code (MCP + hook)
  dbscope usage [--dir d]                                          real token usage from Claude Code transcripts
  dbscope bench <tasks.txt> [--dir d] [--max-turns 12]             A/B: same tasks with and without dbscope (uses your Claude plan)
  dbscope mcp | hook                                               (used by Claude Code)

  <conn>: postgres://… mysql://… mongodb://… sqlserver://user:pass@host/db redis://… firestore://<project>
          app.db  schema.prisma  schema.sql  migrations/  serviceAccount.json  "Host=..;Database=..;"`;

try {
  switch (cmd) {
    case 'mcp': { const { runMcp } = await import('../src/mcp.js'); await runMcp(flags.dir); break; }
    case 'hook': { const { runHook } = await import('../src/hook.js'); await runHook(); break; }
    case 'analyze': {
      const { runAnalysis } = await import('../src/engine.js');
      const m = await runAnalysis(projectDir(), { db: flags.db, samples: flags['no-samples'] ? false : undefined });
      console.log(`✓ ${m.stats.tables} tables · ${m.stats.columns} columns · ${m.stats.relations} relations (${m.stats.inferredRelations} inferred) · full schema ≈ ${m.fullSchemaTokens} tokens`);
      console.log(`  ${m.source}`);
      console.log(`  ${m.purpose.summary.replace(/\*\*/g, '')}`);
      break;
    }
    case 'detect': {
      const { detectAll, describeSource } = await import('../src/detect.js');
      const all = detectAll(projectDir());
      if (!all.length) console.log('No database source detected.');
      all.forEach((s, i) => console.log(`${i === 0 ? '→' : ' '} ${describeSource(s)}   [${s.via}]`));
      break;
    }
    case 'context': {
      const { contextForPrompt } = await import('../src/engine.js');
      const r = contextForPrompt(projectDir(), pos.join(' '), { source: 'cli' });
      console.log(r.text || '(no relevant tables)');
      if (r.match) console.error(`\n≈ ${r.tokens} tokens injected`);
      break;
    }
    case 'import': {
      const { readFileSync } = await import('node:fs');
      const { importSchema } = await import('../src/engine.js');
      const m = importSchema(projectDir(), JSON.parse(readFileSync(pos[0], 'utf8')), pos[0]);
      console.log(`✓ imported ${m.stats.tables} tables, ${m.stats.relations} relations`);
      break;
    }
    case 'install': {
      const { install } = await import('../src/install.js');
      for (const line of install(projectDir(), { global: !!flags.global })) console.log('✓ ' + line);
      if (!flags.global) {
        const { runAnalysis } = await import('../src/engine.js');
        try { const m = await runAnalysis(projectDir(), { db: flags.db }); console.log(`✓ analyzed ${m.stats.tables} tables (${m.source})`); }
        catch (e) { console.log(`! analysis skipped: ${e.message}`); }
      }
      console.log('Restart Claude Code in the project to load the MCP server and hook.');
      break;
    }
    case 'serve':
    case 'open': {
      const dir = projectDir();
      const { getModel, runAnalysis } = await import('../src/engine.js');
      if (flags.db || !getModel(dir)) {
        try {
          const m = await runAnalysis(dir, { db: flags.db });
          console.log(`✓ ${m.stats.tables} tables, ${m.stats.relations} relations — ${m.source}`);
        } catch (e) { console.log(`! ${e.message}\n  Dashboard will open; choose a source there.`); }
      }
      const { startServer } = await import('../src/server.js');
      const s = await startServer(dir, { port: +(flags.port ?? 4777), log: console.log });
      if (s.reused) console.log(`dashboard already running: ${s.url}`);
      if (!flags['no-open']) {
        const { spawn } = await import('node:child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(opener, [s.url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
      }
      if (s.reused) process.exit(0);
      break;
    }
    case 'usage': {
      const { sessionUsage } = await import('../src/usage.js');
      const u = sessionUsage(projectDir());
      if (!u.sessions.length) { console.log(`No Claude Code transcripts in ${u.dir}`); break; }
      for (const s of u.sessions.slice(0, 15)) console.log(`${s.dbscope ? '◆' : '·'} ${s.first?.slice(0, 16)}  prompts ${s.prompts}  turns ${s.turns}  in ${s.totalIn}  out ${s.usage.output}  read/grep ${s.explore}`);
      for (const k of ['with', 'without']) { const g = u.summary[k]; console.log(`${k.padEnd(7)} dbscope: ${g.sessions} sessions · per prompt input ${g.perPromptInput ?? '–'} · turns ${g.perPromptTurns ?? '–'} · read/grep ${g.perPromptExplore ?? '–'}`); }
      break;
    }
    case 'bench': {
      if (!pos[0]) { console.log('usage: dbscope bench <tasks.txt> [--dir d] [--max-turns 12] [--model m]'); process.exit(1); }
      const { runBench } = await import('../src/bench.js');
      const r = await runBench(projectDir(), pos[0], { maxTurns: +(flags['max-turns'] ?? 12), model: flags.model });
      const d = (a, b) => (a ? `${Math.round((1 - b / a) * 100)}%` : '–');
      console.log(`\nTOTAL without: in ${r.total.without.input} out ${r.total.without.output} $${r.total.without.cost.toFixed(3)} turns ${r.total.without.turns}`);
      console.log(`TOTAL with:    in ${r.total.with.input} out ${r.total.with.output} $${r.total.with.cost.toFixed(3)} turns ${r.total.with.turns}`);
      console.log(`saving: input ${d(r.total.without.input, r.total.with.input)} · cost ${d(r.total.without.cost, r.total.with.cost)}`);
      break;
    }
    case 'help': case '--help': case '-h': console.log(HELP); break;
    default: console.log(HELP); process.exit(1);
  }
} catch (e) {
  console.error('dbscope: ' + e.message);
  process.exit(1);
}
