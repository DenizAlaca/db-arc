import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { paths } from './store.js';

const read = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };

export async function runHook() {
  try {
    const data = JSON.parse((await read()) || '{}');
    if (process.env.DBSCOPE_DISABLE === '1') return;
    const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR ?? data.cwd ?? process.cwd());
    if (!existsSync(paths(projectDir).model)) return;

    if (data.hook_event_name === 'SessionStart') {
      const { resetSession, pruneSessions } = await import('./session.js');
      if (data.source === 'clear' || data.source === 'compact') resetSession(projectDir, data.session_id);
      pruneSessions(projectDir);
      return;
    }

    if (!data.prompt) return;
    const { contextForPrompt } = await import('./engine.js');
    const { text } = contextForPrompt(projectDir, data.prompt, { source: 'hook', sessionId: data.session_id });
    if (!text) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
  } catch (e) {
    process.stderr.write(`dbscope hook: ${e.message}\n`);
  }
}
