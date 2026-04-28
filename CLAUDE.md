# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**claude-feishu-bot** — A bridge that connects Feishu (飞书) messaging to a local Claude Code CLI instance. Single-user, runs locally via WebSocket long connection (no public IP needed).

Flow: `Feishu user message → WSClient event → auth check → spawn claude CLI → parse stream-json → reply via Feishu API`

Auth: one-time 6-digit code printed on startup (`generateAuthCode`). User sends `/auth <code>` in Feishu; on success, their `open_id` is added to `authorized_users` in `sessions.json`. Code is consumed on first success and invalidated after 5 failed attempts (requires restart to regenerate).

## Commands

- `npm start` — start the bot (requires `config.yaml`)
- `node e2e-test.mjs` — run E2E tests (requires bot running + `lark-cli` authenticated)
- `node --check <file>` — syntax check a single file

## Architecture

```
index.mjs          — main entry, event routing, slash commands, auth card
lib/feishu.mjs     — Feishu SDK wrapper (WSClient, replyText, replyCard, patchMessage)
lib/claude.mjs     — spawns `claude` CLI as subprocess, parses stream-json output
lib/session.mjs    — JSON-file session store (sessions.json) with promise-chain locking
```

## Gotchas

- **`--output-format stream-json` requires `--verbose`**: Claude CLI ignores `--output-format stream-json` unless `--verbose` is also passed. Without it, stdout is empty.
- **session_id is Claude-generated**: Never invent session IDs. Claude Code generates UUIDs and returns them in the `result` event's `session_id` field. Use `--session-id` for new sessions, `--resume` for existing ones.
- **Message dedup**: Feishu may redeliver events on WebSocket reconnect. The `im.message.receive_v1` handler uses `message_id`-based dedup with 60s TTL.
- **Session lock**: `withSessionLock` in index.mjs serializes Claude Code calls per session. `withLock` in session.mjs serializes file reads/writes. Both are promise-chain locks.
- **Auth persistence is fire-and-forget**: `session.setAuthorizedUser()` in `handleAuthMessage` is not awaited — the in-memory `authorizedUsers` Set is the authoritative runtime check; the file write only matters across restarts.
- **Auth code uses `randomInt` from `node:crypto`**: not `Math.random()`. Printed only to terminal (never logged to file), consumed on first success, invalidated after 5 failed attempts.
- **config.yaml has secrets**: `app_id` and `app_secret` are in config.yaml (gitignored). Never commit.
- **`sessions.json` is gitignored**: Contains `authorized_users` (open_ids) and Claude session IDs.

## Conventions

- ES Modules throughout (`.mjs` extension, `import/export`)
- Node.js built-in imports use `node:` prefix (`node:fs/promises`, `node:child_process`)
- Functional pattern: flat module-level exports, no classes
- Chinese user-facing text (card UI, error messages)
- Error handling: try/catch → `console.error` + user-facing reply; fatal errors → `process.exit(1)`
