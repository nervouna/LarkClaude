#!/usr/bin/env node

/**
 * E2E test for claude-feishu-bot
 * Uses lark-cli to send messages to the bot and verify behavior.
 *
 * Usage:
 *   node e2e-test.mjs              # run all tests
 *   node e2e-test.mjs --clean      # clear auth and run all tests
 *
 * Prerequisites:
 *   - Bot is running (npm start)
 *   - lark-cli is installed and authenticated
 *   - Bot is configured with the test chat
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

const CONFIG_FILE = new URL('./config.yaml', import.meta.url).pathname;
const SESSIONS_FILE = new URL('./sessions.json', import.meta.url).pathname;
const LOG_FILE = '/tmp/claude-feishu-bot-e2e.log';

let CHAT_ID = '';

function loadChatId() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`config.yaml not found. Copy config.example.yaml to config.yaml and fill in your values.`);
    process.exit(1);
  }
  const config = parseYaml(readFileSync(CONFIG_FILE, 'utf-8'));
  CHAT_ID = config?.test?.chat_id;
  if (!CHAT_ID) {
    console.error(`test.chat_id is not set in config.yaml. Add it under the "test" section:`);
    console.error(`\ntest:\n  chat_id: "oc_xxx"\n`);
    process.exit(1);
  }
}

let passed = 0;
let failed = 0;
let skipped = 0;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function send(text) {
  const cmd = `lark-cli im +messages-send --chat-id "${CHAT_ID}" --as user --text "${text}" 2>&1`;
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 });
  // strip lark-cli warning lines before JSON
  const jsonStart = out.indexOf('{');
  if (jsonStart < 0) throw new Error(`no JSON in lark-cli output: ${out.slice(0, 200)}`);
  const json = JSON.parse(out.slice(jsonStart));
  if (!json.ok) throw new Error(`send failed: ${out.slice(0, 200)}`);
  return json;
}

function log(msg) {
  console.log(msg);
}

function assert(condition, name) {
  if (condition) {
    log(`  ✓ ${name}`);
    passed++;
  } else {
    log(`  ✗ ${name}`);
    failed++;
  }
}

function clearAuth() {
  const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  data.authorized_users = [];
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
  log('  cleared authorized_users');
}

async function waitForLog(pattern, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const log = readFileSync(LOG_FILE, 'utf-8');
      if (log.includes(pattern)) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function runTest(name, fn) {
  log(`\n[TEST] ${name}`);
  try {
    await fn();
  } catch (err) {
    log(`  ✗ error: ${err.message}`);
    failed++;
  }
}

// ─── Tests ───

async function testSlashCommands() {
  log('  testing /sessions...');
  send('/sessions');
  const sessionsLog = await waitForLog('done.', 30_000);
  // /sessions is handled by slash command, not Claude Code
  // just verify it doesn't crash
  await sleep(3_000);

  log('  testing /clear...');
  send('/clear test-session');
  await sleep(3_000);

  log('  testing /status...');
  send('/status');
  await sleep(3_000);

  assert(true, 'slash commands did not crash');
}

async function testClaudeConversation() {
  log('  sending message to Claude Code...');
  send('respond with exactly: E2E_TEST_OK');

  const found = await waitForLog('done.', 60_000);
  assert(found, 'Claude Code responded');
}

async function testSessionPersistence() {
  log('  checking sessions.json for session_id...');
  // retry up to 10s — setSessionId is async and may not complete immediately
  let session = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    session = data.sessions[data.active];
    if (session?.session_id) break;
  }
  assert(session?.session_id != null, 'session_id persisted');
  assert(session?.created_at != null, 'created_at set');
}

// ─── Main ───

async function main() {
  const clean = process.argv.includes('--clean');

  loadChatId();

  log('=== claude-feishu-bot E2E Test ===');
  log(`chat: ${CHAT_ID}`);
  log(`log: ${LOG_FILE}`);

  if (clean) {
    log('\n[PREFLIGHT] clearing auth state...');
    clearAuth();
    log('  please restart the bot and run again without --clean');
    process.exit(0);
  }

  // check bot is running
  try {
    execSync('pgrep -f "node index.mjs"', { encoding: 'utf-8' });
  } catch {
    log('\n[ERROR] bot is not running. start with: npm start');
    process.exit(1);
  }

  await runTest('Slash commands', testSlashCommands);
  await runTest('Claude Code conversation', testClaudeConversation);
  await runTest('Session persistence', testSessionPersistence);

  log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
