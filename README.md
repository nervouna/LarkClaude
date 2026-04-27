# Claude Feishu Bot

飞书机器人连接本地 Claude Code。单用户，飞书发消息 → Claude Code 本地执行 → 回复结果。

## 前置条件

- Node.js 22+
- Claude Code CLI 已安装并登录
- 飞书企业自建应用（已配置事件订阅）

## 飞书开放平台配置

1. 创建企业自建应用
2. 开通权限：`im:message:receive_as_bot`、`im:message:send_as_bot`
3. 事件订阅 → 选择「使用长连接接收事件」→ 添加 `im.message.receive_v1`
4. 回调订阅 → 选择「使用长连接接收回调」→ 添加 `card.action.trigger`
5. 发布应用并审批

## 配置

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入 app_id 和 app_secret
```

E2E 测试需要在 `test.chat_id` 填入测试群聊的 chat_id。

## 启动

```bash
npm install
npm start
```

看到 `ready` 即启动成功。

## 授权

首次给机器人发消息会收到一张授权卡片，点击「确认授权」即可。授权状态持久化在 `sessions.json` 中，重启不丢失。

## 使用

在飞书给机器人发消息即可对话。支持以下 slash commands：

| 命令 | 说明 |
|------|------|
| `/sessions` | 列出所有会话 |
| `/clear [别名]` | 新建会话 |
| `/switch <别名>` | 切换活跃会话 |
| `/status` | 查看当前会话状态 |
| `/model <id>` | 设置当前会话的模型 |

## License

[WTFPL](LICENSE)
