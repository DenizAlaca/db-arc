import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dbscope.js');
const NODE = 'node';
const onPath = (() => {
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) if (dir && existsSync(join(dir, 'dbscope' + ext))) return true;
  }
  return false;
})();
const RUN = onPath ? { command: 'dbscope', args: [] } : { command: NODE, args: [BIN] };
const hookCmd = onPath ? 'dbscope hook' : `"${NODE}" "${BIN}" hook`;
const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJ = (f, d) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(d, null, 2) + '\n'); };

function addHook(settingsFile) {
  const s = readJ(settingsFile);
  s.hooks ??= {};
  let added = false;
  for (const [event, matcher] of [['UserPromptSubmit', undefined], ['SessionStart', 'startup|clear|compact']]) {
    const list = (s.hooks[event] ??= []);
    const exists = list.some((g) => g.hooks?.some((h) => String(h.command).includes('dbscope') && String(h.command).includes(' hook')));
    if (!exists) { list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }); added = true; }
  }
  writeJ(settingsFile, s);
  return added;
}

const SECTION = '## Database (dbscope)';
const CLAUDE_MD = `${SECTION}
The DB schema is pre-analyzed by dbscope. A \`[dbscope]\` block with only the relevant tables is attached to prompts.
Prefer the dbscope MCP tools (relevant_tables, describe_tables, find_path, search_schema) over reading migrations/models or querying information_schema.
When you learn what a table means call \`annotate_table\`; after DB work call \`confirm_tables\`. Dashboard: \`dbscope serve\`.
`;

function upsertSection(cur) {
  const lines = cur.split('\n');
  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start === -1) return (cur ? cur.replace(/\n*$/, '\n\n') : '') + CLAUDE_MD;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...CLAUDE_MD.trimEnd().split('\n'), ...(end < lines.length ? ['', ...lines.slice(end)] : [''])].join('\n');
}

export function install(projectDir, { global = false } = {}) {
  const out = [];
  if (global) {
    out.push(addHook(join(homedir(), '.claude', 'settings.json')) ? 'hook → ~/.claude/settings.json' : 'hook already in ~/.claude/settings.json');
    try {
      execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'dbscope', '--', RUN.command, ...RUN.args, 'mcp'], { stdio: 'pipe' });
      out.push('MCP server registered (user scope) via `claude mcp add`');
    } catch (e) {
      const msg = String(e.stderr ?? e.message);
      out.push(/already exists/i.test(msg) ? 'MCP server already registered (user scope)' : `Could not run \`claude mcp add\`. Run manually:\n  claude mcp add --scope user dbscope -- ${[RUN.command, ...RUN.args].join(' ')} mcp`);
    }
    return out;
  }
  const dir = resolve(projectDir);
  const mcpFile = join(dir, '.mcp.json');
  const mcp = readJ(mcpFile);
  mcp.mcpServers ??= {};
  mcp.mcpServers.dbscope = { command: RUN.command, args: [...RUN.args, 'mcp'] };
  writeJ(mcpFile, mcp);
  out.push('MCP server → .mcp.json');

  out.push(addHook(join(dir, '.claude', 'settings.json')) ? 'hook → .claude/settings.json' : 'hook already present');
  const local = join(dir, '.claude', 'settings.local.json');
  const ls = readJ(local);
  ls.enabledMcpjsonServers = [...new Set([...(ls.enabledMcpjsonServers ?? []), 'dbscope'])];
  writeJ(local, ls);
  out.push('dbscope enabled in .claude/settings.local.json');

  const md = join(dir, 'CLAUDE.md');
  const cur = existsSync(md) ? readFileSync(md, 'utf8') : '';
  const next = upsertSection(cur);
  writeFileSync(md, next);
  out.push('CLAUDE.md section');

  const gi = join(dir, '.gitignore');
  if (existsSync(gi) && !/^\.dbscope\/?$/m.test(readFileSync(gi, 'utf8'))) { writeFileSync(gi, readFileSync(gi, 'utf8').replace(/\n*$/, '\n') + '.dbscope/\n'); out.push('.gitignore += .dbscope/'); }
  return out;
}
