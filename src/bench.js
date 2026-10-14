import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, logEvent } from './store.js';

function runClaude(projectDir, prompt, withDbscope, { maxTurns, model }) {
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns),
    '--allowedTools', 'Read,Grep,Glob,mcp__dbscope', '--permission-mode', 'default'];
  if (model) args.push('--model', model);
  if (!withDbscope) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  const env = { ...process.env, ...(withDbscope ? {} : { DBSCOPE_DISABLE: '1' }), DBSCOPE_NO_UI: '1' };
  return new Promise((ok) => {
    const p = spawn('claude', args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        const u = j.usage ?? {};
        ok({ ok: !j.is_error, cost: j.total_cost_usd ?? null, turns: j.num_turns, ms: j.duration_ms,
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 });
      } catch { ok({ ok: false, error: (err || out).slice(0, 300) }); }
    });
  });
}

export async function runBench(projectDir, tasksFile, { maxTurns = 12, model, log = console.log } = {}) {
  const tasks = readFileSync(tasksFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const [i, task] of tasks.entries()) {
    log(`[${i + 1}/${tasks.length}] ${task.slice(0, 70)}`);
    const without = await runClaude(projectDir, task, false, { maxTurns, model });
    const withD = await runClaude(projectDir, task, true, { maxTurns, model });
    rows.push({ task, without, with: withD });
    log(`   without: ${fmt(without)}\n   with:    ${fmt(withD)}`);
  }
  const sum = (k, side) => rows.reduce((a, r) => a + (r[side][k] ?? 0), 0);
  const total = { without: { input: sum('input', 'without'), output: sum('output', 'without'), cost: sum('cost', 'without'), turns: sum('turns', 'without') },
    with: { input: sum('input', 'with'), output: sum('output', 'with'), cost: sum('cost', 'with'), turns: sum('turns', 'with') } };
  const result = { at: new Date().toISOString(), tasks: rows, total };
  const p = ensureDir(projectDir);
  writeFileSync(join(p.dir, `bench-${Date.now()}.json`), JSON.stringify(result, null, 2));
  logEvent(projectDir, { type: 'bench', total, tasks: rows.length });
  return result;
}

const fmt = (r) => (r.ok ? `in ${r.input} · out ${r.output} · turns ${r.turns} · $${(r.cost ?? 0).toFixed(4)}` : `error: ${r.error ?? 'failed'}`);
