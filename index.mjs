import { readFile, access } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { load as parseYaml } from 'js-yaml';
import { init, startEventLoop, replyText } from './lib/feishu.mjs';
import { run } from './lib/claude.mjs';
import * as session from './lib/session.mjs';

const CONFIG_FILE = new URL('./config.yaml', import.meta.url).pathname;

// in-memory auth state — resets on restart
const authorizedUsers = new Set();

// one-time startup auth code — printed to terminal, consumed on first successful /auth
const MAX_AUTH_ATTEMPTS = 5;
let authCode = null;
let authAttempts = 0;

function generateAuthCode() {
  authCode = String(randomInt(100_000, 1_000_000));
  authAttempts = 0;
  const line = '═'.repeat(44);
  console.log(`\n${line}`);
  console.log(`  授权码: ${authCode}`);
  console.log(`  在飞书对机器人发送: /auth ${authCode}`);
  console.log(`${line}\n`);
}

async function handleAuthMessage({ content, senderId, messageId }) {
  const match = content?.trim().match(/^\/auth\s+(\S+)/);
  if (!match) {
    await replyText({ messageId, text: '未授权。请发送 /auth <code>，code 在机器人启动时打印在终端。' });
    return;
  }
  if (!authCode) {
    await replyText({ messageId, text: '授权码已失效，请重启机器人以生成新码。' });
    return;
  }
  if (match[1] !== authCode) {
    authAttempts++;
    if (authAttempts >= MAX_AUTH_ATTEMPTS) {
      authCode = null;
      console.error('[auth] max attempts reached, code invalidated');
      await replyText({ messageId, text: '授权码错误次数过多，码已失效。请重启机器人。' });
    } else {
      await replyText({ messageId, text: `授权码错误（${authAttempts}/${MAX_AUTH_ATTEMPTS}）` });
    }
    return;
  }
  authorizedUsers.add(senderId);
  authCode = null;
  session.setAuthorizedUser(senderId).catch(err => console.error('persist auth:', err.message));
  console.log(`[auth] ${senderId} authorized`);
  await replyText({ messageId, text: '授权成功，可以开始对话了。' });
}

// per-session lock: serialize Claude Code calls on the same session
const sessionLocks = new Map();
function withSessionLock(key, fn) {
  const prev = sessionLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(key, next);
  return next;
}

async function loadConfig() {
  try {
    await access(CONFIG_FILE);
  } catch {
    console.error('config.yaml not found. Copy config.example.yaml to config.yaml and fill in your values.');
    process.exit(1);
  }
  const raw = await readFile(CONFIG_FILE, 'utf-8');
  return parseYaml(raw);
}

function isSlashCommand(content) {
  return /^\/\w+/.test(content?.trim());
}

async function handleSlashCommand({ content, messageId }) {
  const parts = content.trim().split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/sessions': {
      const sessions = await session.list();
      const lines = sessions.map(s =>
        `${s.active ? '>' : ' '} ${s.alias}  ${s.id.slice(0, 8)}  ${s.work_dir}`
      );
      await replyText({ messageId, text: lines.length ? lines.join('\n') : '(no sessions)' });
      return true;
    }

    case '/clear': {
      const prev = await session.getActive();
      const workDir = prev?.work_dir || process.cwd();
      const s = await session.create({ alias: arg || undefined, workDir });
      await replyText({ messageId, text: `new session: ${s.alias} (${s.id.slice(0, 8)})` });
      return true;
    }

    case '/switch': {
      if (!arg) {
        await replyText({ messageId, text: 'usage: /switch <alias or session-id>' });
        return true;
      }
      const sessions = await session.list();
      const match = sessions.find(s => s.id === arg || s.alias === arg || s.id.startsWith(arg));
      if (!match) {
        await replyText({ messageId, text: `session "${arg}" not found. use /sessions to list.` });
        return true;
      }
      await session.setActive(match.id);
      await replyText({ messageId, text: `switched to: ${match.alias} (${match.id.slice(0, 8)})` });
      return true;
    }

    case '/status': {
      const s = await session.getActive();
      if (!s) {
        await replyText({ messageId, text: 'no active session' });
        return true;
      }
      await replyText({
        messageId,
        text: [
          `${s.alias}`,
          `session: ${s.session_id ? s.session_id.slice(0, 8) : '(new)'}`,
          `work_dir: ${s.work_dir}`,
          `model: ${s.model || 'default'}`,
          `created: ${s.created_at || '-'}`,
          `updated: ${s.updated_at || '-'}`,
        ].join('\n'),
      });
      return true;
    }

    case '/model': {
      if (!arg) {
        await replyText({ messageId, text: 'usage: /model <model-id>' });
        return true;
      }
      const s = await session.getActive();
      if (!s) {
        await replyText({ messageId, text: 'no active session' });
        return true;
      }
      await session.setModel(s.id, arg);
      await replyText({ messageId, text: `model set to: ${arg}` });
      return true;
    }
  }

  return false; // not handled, pass through to Claude
}

async function main() {
  console.log('loading config...');
  const config = await loadConfig();
  const { feishu, bot } = config;

  console.log('initializing feishu client...');
  init({ appId: feishu.app_id, appSecret: feishu.app_secret, brand: feishu.brand || 'feishu' });

  // load persisted authorizations
  const saved = await session.getAuthorizedUsers();
  saved.forEach(id => authorizedUsers.add(id));
  if (saved.length) console.log(`authorized: ${saved.length} user(s)`);

  console.log('starting event loop...');
  startEventLoop({
    onMessage: async ({ content, senderId, chatId, messageId }) => {
      try {
        console.log(`[${senderId}] ${content?.slice(0, 80)}`);

        // authorization gate
        if (!authorizedUsers.has(senderId)) {
          await handleAuthMessage({ content, senderId, messageId });
          return;
        }

        // authorized — handle slash commands
        if (isSlashCommand(content)) {
          const handled = await handleSlashCommand({ content, messageId });
          if (handled) return;
        }

        // authorized — Claude Code (serialized per session)
        let s = await session.getActive();
        if (!s) {
          await replyText({ messageId, text: 'no active session. use /clear to create one.' });
          return;
        }

        const result = await withSessionLock(s.id, async () => {
          const r = await run({
            prompt: content,
            sessionId: s.session_id,
            workDir: s.work_dir,
            model: s.model,
            maxTurns: bot.max_turns || 10,
            timeoutSeconds: bot.timeout_seconds || 300,
          });
          if (r.sessionId && !s.session_id) {
            await session.setSessionId(s.id, r.sessionId);
          }
          return r;
        });

        const responseText = result.text || '(no output)';
        const maxLen = 15000;

        if (responseText.length > maxLen) {
          for (let i = 0; i < responseText.length; i += maxLen) {
            await replyText({ messageId, text: responseText.slice(i, i + maxLen) });
          }
        } else {
          await replyText({ messageId, text: responseText });
        }

        await session.touch(s.id);
        console.log(`done. $${result.cost.toFixed(4)} ${result.duration}ms`);
      } catch (err) {
        console.error('onMessage error:', err.message);
        await replyText({ messageId, text: `error: ${err.message}` }).catch(() => {});
      }
    },
  });

  generateAuthCode();
  console.log('ready');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
