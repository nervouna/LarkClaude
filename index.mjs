import { readFile, access } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { init, startEventLoop, replyText, replyCard, patchMessage } from './lib/feishu.mjs';
import { run } from './lib/claude.mjs';
import * as session from './lib/session.mjs';

const CONFIG_FILE = new URL('./config.yaml', import.meta.url).pathname;

// in-memory auth state — resets on restart
const authorizedUsers = new Set();

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

function buildAuthCard(openId) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'Claude Code Bot' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '点击下方按钮授权此飞书用户访问本地 Claude Code。' } },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'lark_md', content: '确认授权' },
          type: 'primary',
          value: { action: 'authorize', open_id: openId },
          confirm: {
            title: { tag: 'plain_text', content: '确认授权？' },
            text: { tag: 'plain_text', content: '授权后该飞书用户可控制本地 Claude Code。' },
          },
        }],
      },
    ],
  };
}

function buildAuthorizedCard() {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '已授权' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: '授权成功！现在可以开始对话了。' } }],
  };
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
          const card = buildAuthCard(senderId);
          await replyCard({ messageId, card });
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

    onCardAction: async (data) => {
      console.log('card action:', JSON.stringify(data).slice(0, 300));

      const value = data?.action?.value;
      if (!value || value.action !== 'authorize') return;

      const openId = value.open_id;
      if (!openId) return;

      // sync: in-memory first
      authorizedUsers.add(openId);
      console.log(`authorized: ${openId}`);

      // async: persist in background (don't await — 3s timeout)
      session.setAuthorizedUser(openId).catch(err =>
        console.error('persist auth error:', err.message)
      );

      // update card via PATCH API (fire-and-forget)
      const msgId = data?.context?.open_message_id;
      if (msgId) {
        patchMessage({ messageId: msgId, card: buildAuthorizedCard() }).catch(err =>
          console.error('patch card error:', err.message)
        );
      }

      // return toast only — card update handled by PATCH above
      return {
        toast: { type: 'success', content: '授权成功' },
      };
    },
  });

  console.log('ready');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
