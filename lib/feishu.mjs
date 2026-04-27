import * as lark from '@larksuiteoapi/node-sdk';

let client = null;
let wsClient = null;
let _config = null;

export function init({ appId, appSecret, brand }) {
  _config = { appId, appSecret };
  const domain = brand === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
  client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain,
  });
  return client;
}

export function getClient() {
  if (!client) throw new Error('Feishu client not initialized. Call init() first.');
  return client;
}

export function startEventLoop({ onMessage, onCardAction }) {
  if (!client) throw new Error('Feishu client not initialized. Call init() first.');

  const dispatcher = new lark.EventDispatcher({});
  const seen = new Set();

  if (onMessage) {
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const msg = data.message;
        const sender = data.sender;
        if (!msg || !sender) return;

        // dedup: Feishu may redeliver the same event on reconnect
        const msgId = msg.message_id;
        if (seen.has(msgId)) return;
        seen.add(msgId);
        setTimeout(() => seen.delete(msgId), 60_000);

        const content = extractTextContent(msg);
        const senderId = sender.sender_id?.open_id || '';
        const chatId = msg.chat_id;
        const chatType = msg.chat_type; // 'p2p' or 'group'

        await onMessage({ content, senderId, chatId, messageId: msgId, chatType });
      },
    });
  }

  if (onCardAction) {
    dispatcher.register({
      'card.action.trigger': async (data) => {
        return await onCardAction(data);
      },
    });
  }

  wsClient = new lark.WSClient({
    appId: _config.appId,
    appSecret: _config.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
  });

  wsClient.start({ eventDispatcher: dispatcher });

  return wsClient;
}

export function stopEventLoop() {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
}

export async function replyText({ messageId, text }) {
  const c = getClient();
  return c.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    },
  });
}

export async function replyCard({ messageId, card }) {
  const c = getClient();
  return c.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
      msg_type: 'interactive',
    },
  });
}

export async function patchMessage({ messageId, card }) {
  const c = getClient();
  return c.im.message.patch({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
      msg_type: 'interactive',
    },
  });
}

function extractTextContent(msg) {
  const type = msg.message_type;
  if (type === 'text') {
    try {
      const parsed = JSON.parse(msg.content);
      return parsed.text || '';
    } catch {
      return msg.content || '';
    }
  }
  if (type === 'post') {
    return '[富文本消息]';
  }
  if (type === 'image') {
    return '[图片]';
  }
  if (type === 'file') {
    return '[文件]';
  }
  if (type === 'audio') {
    return '[语音]';
  }
  if (type === 'media') {
    return '[视频]';
  }
  if (type === 'sticker') {
    return '[表情]';
  }
  return msg.content || `[${type}]`;
}
