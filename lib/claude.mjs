import { spawn } from 'node:child_process';

export function run({ prompt, sessionId, workDir, model, maxTurns, timeoutSeconds }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    if (model) {
      args.push('--model', model);
    }
    args.push('--max-turns', String(maxTurns || 10));

    const child = spawn('claude', args, { cwd: workDir, env: { ...process.env } });

    const lines = [];
    const stderrChunks = [];
    let text = '';
    let resultSessionId = sessionId;
    let cost = 0;
    let duration = 0;
    let toolCalls = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      // escalate to SIGKILL if process doesn't exit within 5s
      const forceKill = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
      child.on('close', () => clearTimeout(forceKill));
      settled = true;
      reject(new Error('Claude Code timed out'));
    }, (timeoutSeconds || 300) * 1000);

    child.stdout.on('data', (chunk) => {
      lines.push(chunk.toString());
      const buf = lines.join('');
      const parts = buf.split('\n');
      lines.length = 0;
      lines.push(parts.pop());

      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          switch (event.type) {
            case 'assistant': {
              const content = event.message?.content || [];
              for (const c of content) {
                if (c.type === 'text') {
                  text += c.text;
                }
              }
              break;
            }
            case 'result': {
              resultSessionId = event.session_id || resultSessionId;
              cost = event.total_cost_usd || 0;
              duration = event.duration_ms || 0;
              break;
            }
            case 'tool_use': {
              toolCalls.push(event);
              break;
            }
          }
        } catch {
          // ignore parse errors for malformed lines
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ text: text.trim(), sessionId: resultSessionId, cost, duration, toolCalls });
      } else {
        const stderr = stderrChunks.join('').trim();
        reject(new Error(`Claude Code exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}
