// Cloudflare Worker 入口（Telegram 答题验证 + 相册聚合：最多 10 张，2 秒超时 flush）
// 部署前提（需用 wrangler 部署，控制台在线编辑器无法配置 Durable Objects）：
//   1. wrangler.toml 中添加 MEDIA_GROUPS Durable Object 绑定与 migration（见交付说明）
//   2. 配置 WEBHOOK_SECRET 并在 setWebhook 时携带 secret_token，来源校验才生效

const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const MEDIA_GROUP_MAX_ITEMS = 10;
const MEDIA_GROUP_FLUSH_DELAY_MS = 2000;
const TG_429_MAX_WAIT_SECONDS = 30;
const VERIFICATION_TTL_SECONDS = 900;
const VERIFICATION_HINT_THROTTLE_MS = 30000;

export default {
  async fetch(request, env) {
    try {
      // 校验 Telegram webhook secret，防止伪造 update；未配置 WEBHOOK_SECRET 时不拦截
      const secret = env.WEBHOOK_SECRET;
      if (secret && request.headers.get(WEBHOOK_SECRET_HEADER) !== secret) {
        return new Response("Forbidden", { status: 403 });
      }

      if (request.method !== "POST") return new Response("OK");

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("OK");
      }

      const msg = update.message;
      if (!msg) return new Response("OK");

      if (msg.chat && msg.chat.type === "private") {
        await handlePrivateMessage(msg, env);
        return new Response("OK");
      }

      const supergroupId = Number(env.SUPERGROUP_ID);
      if (msg.chat && Number(msg.chat.id) === supergroupId) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
          await setThreadClosedState(msg.message_thread_id, env, true);
          return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
          await setThreadClosedState(msg.message_thread_id, env, false);
          return new Response("OK");
        }
        if (msg.message_thread_id) {
          await handleTopicMessage(msg, env);
          return new Response("OK");
        }
      }

      return new Response("OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("worker-request-failed", { message });
      try {
        await env.TOPIC_MAP.put(
          "diag:last_error",
          JSON.stringify({ message, timestamp: new Date().toISOString() }),
          { expirationTtl: 3600 },
        );
      } catch {}
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

// 私聊 -> 话题
async function handlePrivateMessage(msg, env) {
  const userId = msg.chat.id;

  // user: 记录存在即已验证（记录仅在验证通过后创建），稳态热路径只 1 次 KV 读
  let rec = await env.TOPIC_MAP.get(`user:${userId}`, { type: "json" });
  if (!rec && env.VERIFY_FLAG === '1') {
    // Telegram 内答题验证。答题消息只用于验证，不会转发到客服群。
    if (!(await handleVerificationMessage(msg, env))) return;
  }

  if (msg.text && msg.text.trim().toLowerCase().startsWith("/start")) return;

  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "当前话题已被管理员关闭，如需继续对话请联系管理员或等待重新开启。",
    });
    return;
  }
  if (!rec) {
    rec = await createAndStoreTopic(msg.from, userId, env);
    // user: 落地即代表已验证，删除答对时写入的 verified: 桥接键
    await env.TOPIC_MAP.delete(`verified:${userId}`);
  } else {
    // 改名同步：昵称/@username 变化时更新话题标题；失败不阻断转发
    const latestTitle = buildTopicTitle(msg.from);
    if (latestTitle !== rec.title) {
      rec.title = latestTitle;
      const editRes = await tgCall(env, "editForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: rec.thread_id,
        name: latestTitle,
      });
      if (!editRes.ok) console.log("editForumTopic failed", { threadId: rec.thread_id, description: editRes.description });
      await env.TOPIC_MAP.put(`user:${userId}`, JSON.stringify(rec));
    }
  }

  // 相册聚合：用户 -> 话题
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: "p2t", targetChat: env.SUPERGROUP_ID, threadId: rec.thread_id });
    return;
  }

  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: rec.thread_id,
  });

  if (!res.ok && isThreadMissingError(res)) {
    // 旧话题已失效，清理反向索引后再重建，避免残留过期映射
    await env.TOPIC_MAP.delete(`thread:${rec.thread_id}`);
    const newRec = await createAndStoreTopic(msg.from, userId, env);
    await tgCall(env, "forwardMessage", {
      chat_id: env.SUPERGROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id,
      message_thread_id: newRec.thread_id,
    });
  }
}

// 话题 -> 私聊
async function handleTopicMessage(msg, env) {
  const threadId = msg.message_thread_id;
  const botId = Number(env.BOT_ID || 0);
  if (msg.from && Number(msg.from.id) === botId) return;

  const userId = await findUserByThread(threadId, env);
  if (!userId) return;

  // 相册聚合：话题 -> 用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, { direction: "t2p", targetChat: userId });
    return;
  }

  const res = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id,
  });
  if (!res.ok) {
    const res2 = await tgCall(env, "forwardMessage", {
      chat_id: userId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    console.log("forwardMessage fallback result", { ok: res2.ok, error_code: res2.error_code, description: res2.description });
  }
}

// 相册聚合转发给 Durable Object：同一 media_group_id 固定路由到同一实例
async function handleMediaGroup(msg, env, meta) {
  const groupId = msg.media_group_id;
  const item = extractMedia(msg, msg.chat.id, msg.message_id);
  if (!item) {
    // 不支持的类型（如动画贴纸）降级为立即单发
    console.log("media group item unsupported, fallback single", { groupId });
    return meta.direction === "p2t"
      ? tgCall(env, "forwardMessage", {
          chat_id: meta.targetChat,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          message_thread_id: meta.threadId,
        })
      : tgCall(env, "copyMessage", {
          chat_id: meta.targetChat,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
  }

  const stub = env.MEDIA_GROUPS.get(env.MEDIA_GROUPS.idFromName(`${meta.direction}:${groupId}`));
  const resp = await stub.fetch("https://media-group/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId, item, meta }),
  });
  if (!resp.ok) throw new Error(`media group DO add failed: ${resp.status}`);
}

// Durable Object：相册聚合器。
// KV 的 get→put 读改写无原子性，并发 webhook 会互相覆盖导致丢图/重复/乱序；
// DO 同一实例天然串行（input gates），alarm 替代“定时器 + 收到消息时全量扫描”两套 flush 机制。
export class MediaGroupAggregator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/add") return new Response("Not Found", { status: 404 });

    const { groupId, item, meta } = await request.json();
    let rec = (await this.state.storage.get("rec")) || { groupId, ...meta, items: [], seenIds: [] };

    // Telegram webhook 超时重试会重投同一消息，按 message_id 去重
    if (rec.seenIds.includes(item.message_id)) return new Response("OK");
    rec.seenIds.push(item.message_id);
    rec.items.push(item);

    if (rec.items.length >= MEDIA_GROUP_MAX_ITEMS) {
      // 先清空再发送：发送期间新到的消息会开启新批次，避免与本次发送交错重复
      await this.reset();
      await flushMediaGroup(rec, this.env);
      return new Response("OK");
    }

    // 每次追加都刷新 alarm，语义为“距最后一条 2 秒未追加即 flush”
    await this.state.storage.setAlarm(Date.now() + MEDIA_GROUP_FLUSH_DELAY_MS);
    await this.state.storage.put("rec", rec);
    return new Response("OK");
  }

  async alarm() {
    const rec = await this.state.storage.get("rec");
    if (!rec || !rec.items.length) return;
    await this.reset();
    await flushMediaGroup(rec, this.env);
  }

  async reset() {
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}

// 创建话题，同时写入 user: 与 thread: 双向映射
async function createAndStoreTopic(from, userId, env) {
  const title = buildTopicTitle(from);
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error("createForumTopic failed: " + res.description);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(`user:${userId}`, JSON.stringify(rec));
  // 反向索引 thread_id -> user：O(1) 反查，且不受 KV list 单页 1000 条限制
  await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
  return rec;
}

// 话题标题：昵称 + @username
function buildTopicTitle(from) {
  const first = from.first_name || "";
  const last = from.last_name || "";
  const nick = `${first} ${last}`.trim();
  if (from.username) {
    const at = "@" + from.username;
    return (nick ? `${nick} ${at}` : at).slice(0, 128);
  }
  return (nick || "User").slice(0, 128);
}

// Telegram API，429 限流时等待 retry_after 后重试一次
async function tgCall(env, method, body, retried = false) {
  const base = env.API_BASE || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let res;
  try {
    res = await resp.json();
  } catch {
    return { ok: false, description: "invalid json from telegram" };
  }
  if (
    !retried &&
    res && res.ok === false &&
    res.error_code === 429 &&
    res.parameters && res.parameters.retry_after
  ) {
    await delay(Math.min(res.parameters.retry_after, TG_429_MAX_WAIT_SECONDS) * 1000);
    return tgCall(env, method, body, true);
  }
  return res;
}

function isThreadMissingError(res) {
  if (!res || res.ok) return false;
  const desc = (res.description || "").toUpperCase();
  return (
    desc.includes("MESSAGE THREAD NOT FOUND") ||
    desc.includes("MESSAGE_THREAD_NOT_FOUND") ||
    desc.includes("THREAD_NOT_FOUND") ||
    desc.includes("TOPIC_NOT_FOUND") ||
    desc.includes("FORUM_TOPIC_NOT_FOUND")
  );
}

// 关闭/重开话题状态
async function setThreadClosedState(threadId, env, closed) {
  const userId = await findUserByThread(threadId, env);
  if (userId === null) return;
  const rec = await env.TOPIC_MAP.get(`user:${userId}`, { type: "json" });
  // 反向索引可能残留旧话题（重建话题后），thread_id 不匹配时跳过，避免误写
  if (!rec || Number(rec.thread_id) !== Number(threadId)) return;
  rec.closed = closed;
  await env.TOPIC_MAP.put(`user:${userId}`, JSON.stringify(rec));
}

// 答题验证状态（仅当 user: 记录不存在时被调用）
async function handleVerificationMessage(msg, env) {
  const userId = msg.chat.id;
  const challengeKey = `challenge:${userId}`;

  // challenge: 与 verified: 互斥（答对时 challenge: 被删、verified: 被写），先读 challenge:
  let challenge = await env.TOPIC_MAP.get(challengeKey, { type: "json" });
  if (!challenge) {
    // 桥接态：已答对但首条真实消息尚未落地 user: 记录
    if (await env.TOPIC_MAP.get(`verified:${userId}`)) return true;
    challenge = createChallenge();
    await env.TOPIC_MAP.put(challengeKey, JSON.stringify(challenge), {
      expirationTtl: VERIFICATION_TTL_SECONDS,
    });
    await sendChallenge(userId, challenge, env);
    return false;
  }

  // 非文本消息（相册逐张到达）不参与答题；重发题目但限流 30 秒，避免一次发 N 张刷 N 条提示
  if (typeof msg.text !== "string") {
    if (Date.now() - Number(challenge.last_hint_at || 0) > VERIFICATION_HINT_THROTTLE_MS) {
      challenge.last_hint_at = Date.now();
      await env.TOPIC_MAP.put(challengeKey, JSON.stringify(challenge), {
        expirationTtl: VERIFICATION_TTL_SECONDS,
      });
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "请回复答案数字：\n\n" + challenge.question,
      });
    }
    return false;
  }

  if (isChallengeAnswer(msg.text, challenge.answer)) {
    // 标记已验证；首条真实消息到达时消费该键并落地 user: 记录
    await env.TOPIC_MAP.put(`verified:${userId}`, "1");
    await env.TOPIC_MAP.delete(challengeKey);
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "✅ 验证成功！现在可以直接给我发送消息了。",
    });
    console.log("verified-set", { uid: userId });
    return false;
  }

  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: `❌ 答案不正确，请再试一次：\n\n${challenge.question}`,
  });
  return false;
}

function createChallenge() {
  const left = randomInt(10, 99);
  const right = randomInt(10, 99);
  const subtraction = randomInt(0, 1) === 1;
  const first = subtraction ? Math.max(left, right) : left;
  const second = subtraction ? Math.min(left, right) : right;
  const operator = subtraction ? "-" : "+";
  return {
    question: `${first} ${operator} ${second} = ?`,
    answer: subtraction ? first - second : first + second,
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isChallengeAnswer(value, expected) {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30));
  return /^-?\d+$/.test(normalized) && Number(normalized) === expected;
}

async function sendChallenge(userId, challenge, env) {
  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: [
      "👋 欢迎使用，请先完成一个简单的数字验证。",
      "请直接回复答案数字：",
      "",
      challenge.question,
      "",
      "验证有效期 15 分钟，答对后即可开始对话。",
    ].join("\n"),
  });
}

// 未命中缓存的 TTL：期间该话题的后续消息不再触发全量扫描（约 1 写/小时/非客服话题）
const THREAD_MISS_TTL_SECONDS = 3600;
const THREAD_MISS_SENTINEL = "-1";

// 按 thread_id 反查用户：优先反向索引，老数据缺失索引时扫描回填（自迁移）
async function findUserByThread(threadId, env) {
  const uid = await env.TOPIC_MAP.get(`thread:${threadId}`);
  // 哨兵 "-1" 表示已扫描过且确认无归属，跳过
  if (uid === THREAD_MISS_SENTINEL) return null;
  if (uid !== null) return Number(uid);

  // 兼容旧版本写入的 user: 记录（无反向索引）：扫描定位后回填，带 cursor 分页避免 >1000 条遗漏
  let cursor;
  do {
    const page = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
    for (const { name } of page.keys) {
      const rec = await env.TOPIC_MAP.get(name, { type: "json" });
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        const userId = Number(name.slice("user:".length));
        await env.TOPIC_MAP.put(`thread:${threadId}`, String(userId));
        return userId;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // 非客服话题（General 等）每次消息都会走到这里；写入哨兵避免重复全量扫描
  await env.TOPIC_MAP.put(`thread:${threadId}`, THREAD_MISS_SENTINEL, {
    expirationTtl: THREAD_MISS_TTL_SECONDS,
  });
  return null;
}

// 发送聚合完成的相册
async function flushMediaGroup(rec, env) {
  // message_id 在同一会话内单调递增，按其排序恢复相册原始顺序
  const items = rec.items.slice().sort((a, b) => a.message_id - b.message_id);

  if (items.length === 1) {
    const it = items[0];
    const res = rec.direction === "p2t"
      ? await tgCall(env, "forwardMessage", {
          chat_id: rec.targetChat,
          from_chat_id: it.from_chat_id,
          message_id: it.message_id,
          message_thread_id: rec.threadId,
        })
      : await tgCall(env, "copyMessage", {
          chat_id: rec.targetChat,
          from_chat_id: it.from_chat_id,
          message_id: it.message_id,
        });
    if (!res.ok) console.log("flushMediaGroup single failed", { groupId: rec.groupId, description: res.description });
    return;
  }

  if (rec.direction === "p2t") await forwardMediaGroupToTopic(items, rec, env);
  else await sendMediaGroupToUser(items, rec, env);
  console.log("flushMediaGroup batch forwarded", { groupId: rec.groupId, count: items.length, direction: rec.direction });
}

async function forwardMediaGroupToTopic(items, rec, env) {
  const fromChatId = items[0].from_chat_id;
  const sameSource = items.every((it) => it.from_chat_id === fromChatId);
  if (sameSource) {
    const res = await tgCall(env, "forwardMessages", {
      chat_id: rec.targetChat,
      from_chat_id: fromChatId,
      message_thread_id: rec.threadId,
      message_ids: items.map((it) => it.message_id),
    });
    if (res.ok) return;
    console.log("forwardMessages failed, fallback to single forwards", { error_code: res.error_code, description: res.description });
  }
  for (const it of items) {
    const res = await tgCall(env, "forwardMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
      message_thread_id: rec.threadId,
    });
    if (!res.ok) console.log("forwardMessage fallback failed", { message_id: it.message_id, description: res.description });
  }
}

async function sendMediaGroupToUser(items, rec, env) {
  const media = items.map((it, idx) => ({
    type: it.type,
    media: it.file_id,
    // 相册说明文字只挂在第一条上
    caption: idx === 0 && it.caption ? it.caption : undefined,
  }));
  const res = await tgCall(env, "sendMediaGroup", { chat_id: rec.targetChat, media });
  if (res.ok) return;

  console.log("sendMediaGroup to user failed, fallback to copy", { error_code: res.error_code, description: res.description });
  for (const it of items) {
    const copyRes = await tgCall(env, "copyMessage", {
      chat_id: rec.targetChat,
      from_chat_id: it.from_chat_id,
      message_id: it.message_id,
    });
    if (!copyRes.ok) {
      const fwRes = await tgCall(env, "forwardMessage", {
        chat_id: rec.targetChat,
        from_chat_id: it.from_chat_id,
        message_id: it.message_id,
      });
      if (!fwRes.ok) console.log("forwardMessage last-resort failed", { message_id: it.message_id, description: fwRes.description });
    }
  }
}

function extractMedia(msg, fromChatId, messageId) {
  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: best.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || "", from_chat_id: fromChatId, message_id: messageId };
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
