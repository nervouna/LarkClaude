---
name: e2e
description: Run E2E tests for claude-feishu-bot. Restarts the bot with log file, runs the test suite, reports results.
---

Run the E2E test suite for the Feishu bot.

Steps:
1. Kill any running bot process: `pkill -f "node index.mjs"`
2. Start the bot with log output: `npm start > /tmp/claude-feishu-bot-e2e.log 2>&1 &`
3. Wait 3 seconds for the bot to connect
4. Verify the bot is ready: check `/tmp/claude-feishu-bot-e2e.log` contains "ws client ready"
5. Run tests: `node e2e-test.mjs`
6. Report results — all tests must pass. If any fail, check the bot log for errors: `tail -20 /tmp/claude-feishu-bot-e2e.log`
7. Leave the bot running after tests complete

If the user passes `--clean` to the skill (e.g., `/e2e --clean`), clear `authorized_users` in `sessions.json` before starting the bot.
