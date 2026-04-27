---
name: restart-bot
description: Restart the claude-feishu-bot service. Kills stale processes, starts fresh with log output.
---

Restart the Feishu bot service.

Steps:
1. Kill all running bot processes: `pkill -f "node index.mjs"`
2. Wait 1 second for processes to exit
3. Start the bot: `npm start > /tmp/claude-feishu-bot.log 2>&1 &`
4. Wait 3 seconds for WebSocket connection
5. Verify: `tail -5 /tmp/claude-feishu-bot.log` — must show "ready" and "ws client ready"
6. Report status to the user

If the bot fails to start, check the log for errors. Common issues:
- `config.yaml not found` — user needs to copy config.example.yaml
- `appId is needed` — config values are empty
- `code: 1000040344` — invalid app credentials
