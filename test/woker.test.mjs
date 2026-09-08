// KV 读写次数 + 完整答题流程冒烟测试：node test/woker.test.mjs（无需依赖，直接跑）
// mock KV + mock Telegram API，驱动 worker.fetch 走完整消息流，断言各状态的读写次数与业务行为
// 含合并自旧版 woker.test.mjs 的端到端答题用例（断言意图保持不变）

import assert from "node:assert";

const READS = Symbol("reads");
const WRITES = Symbol("writes");

function mockKV() {
  const store = new Map();
  const kv = {
    [READS]: 0,
    [WRITES]: 0,
    async get(key, opts) {
      kv[READS]++;
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (opts && opts.type === "json") return JSON.parse(raw);
      return raw;
    },
    async put(key, value, _opts) {
      kv[WRITES]++;
      store.set(key, String(value));
    },
    async delete(key) {
      kv[WRITES]++;
      store.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      kv[WRITES]++; // list 计入额度，与 KV 计费一致地放大
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
  return kv;
}

// mock Telegram：记录调用，按需返回结果
function mockTg() {
  const calls = [];
  let topicId = 100;
  const tg = {
    calls,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      let result = { ok: true, result: {} };
      if (body.chat_id === 42 && body.text && body.text.includes("=")) {
        // 拦截出题消息以捕获答案
        const m = body.text.match(/(\d+)\s*([+-])\s*(\d+)\s*=/);
        if (m) tg.capturedAnswer = Number(m[1]) + (m[2] === "-" ? -Number(m[3]) : Number(m[3]));
      }
      if (body.method_hint_create || calls.at(-1) === body) result = result;
      return {
        ok: true,
        json: async () => {
          if (body.name !== undefined) {
            // createForumTopic
            return { ok: true, result: { message_thread_id: topicId++ } };
          }
          return result;
        },
      };
    },
  };
  return tg;
}

function makeEnv(kv, tg) {
  return {
    TOPIC_MAP: kv,
    WEBHOOK_SECRET: "s3cret",
    SUPERGROUP_ID: "-100123",
    BOT_ID: "999",
    VERIFY_FLAG: "1",
    BOT_TOKEN: "T",
    API_BASE: "http://tg.local",
    MEDIA_GROUPS: {
      idFromName: (n) => n,
      get: () => ({ fetch: async () => new Response("OK") }),
    },
  };
}

// 用全局 fetch 注入 mock
function tgRequestOf(call) {
  return call.method || Object.keys(call).join(",");
}

async function main() {
  const { default: worker } = await import("../woker.js");
  const tgCalls = [];

  globalThis.fetch = async (url, init) => {
    const body = init ? JSON.parse(init.body) : null;
    const method = String(url).split("/").pop();
    const record = { method, ...body };
    tgCalls.push(record);
    let result = {};
    if (method === "createForumTopic") result = { message_thread_id: 777 };
    return { ok: true, json: async () => ({ ok: true, result }) };
  };

  const post = (update) =>
    worker.fetch(
      new Request("https://w.example/", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "s3cret" },
        body: JSON.stringify(update),
      }),
      makeEnv(kv, {}),
    );

  // ---------- 场景 1：全新用户首条消息 -> 出题 ----------
  let kv = mockKV();
  let resp = await post({ message: { chat: { id: 42, type: "private" }, from: { id: 42, first_name: "A" }, message_id: 1, text: "hello" } });
  assert.equal(resp.status, 200);
  assert.equal(kv[READS], 3, "新用户一次性成本：user: miss + challenge: miss + verified: miss = 3 读");
  assert.ok(tgCalls.some((c) => c.method === "sendMessage" && /数字验证/.test(c.text || "")), "应发出验证题");

  // ---------- 场景 2：答题中再发消息 -> 读 challenge 命中，不重建题 ----------
  kv = mockKV();
  kv.__seed = null;
  tgCalls.length = 0;
  // 手动种子 challenge（模拟场景 1 已落库）；种子写入不计入计数
  await kv.put("challenge:42", JSON.stringify({ question: "10 + 20 = ?", answer: 30 }));
  kv[READS] = 0; kv[WRITES] = 0;
  await post({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, message_id: 2, text: "hi" } });
  assert.equal(kv[READS], 2, "答题中：user: miss + challenge: hit = 2 读");
  assert.equal(kv[WRITES], 0, "答题中文字错误回复不写 KV");

  // ---------- 场景 3：答对 -> verified 桥接键写入 ----------
  kv = mockKV();
  await kv.put("challenge:42", JSON.stringify({ question: "10 + 20 = ?", answer: 30 }));
  tgCalls.length = 0;
  await post({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, message_id: 3, text: "30" } });
  assert.equal(await kv.get("verified:42"), "1", "答对后写 verified: 桥接键");
  assert.equal(await kv.get("challenge:42"), null, "答对后删 challenge:");

  // ---------- 场景 4：桥接态首条真实消息 -> 建话题 + 消费 verified ----------
  kv = mockKV();
  await kv.put("verified:42", "1");
  tgCalls.length = 0;
  await post({ message: { chat: { id: 42, type: "private" }, from: { id: 42, first_name: "A" }, message_id: 4, text: "real msg" } });
  assert.equal(kv[READS], 3, "桥接态：user: miss + challenge: miss + verified: hit = 3 读（一次性）");
  assert.equal(await kv.get("user:42") !== null, true, "落地 user: 记录");
  assert.equal(await kv.get("verified:42"), null, "消费（删除）verified: 桥接键");
  assert.equal(await kv.get("thread:777"), "42", "写入反向索引");
  assert.ok(tgCalls.some((c) => c.method === "forwardMessage"), "转发消息到话题");

  // ---------- 场景 5：稳态已验证用户 -> 1 读 ----------
  kv = mockKV();
  await kv.put("user:42", JSON.stringify({ thread_id: 777, title: "A", closed: false }));
  tgCalls.length = 0;
  kv[READS] = 0; kv[WRITES] = 0;
  await post({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, message_id: 5, text: "again" } });
  assert.equal(kv[READS], 1, "稳态热路径只 1 读（原来 2 读）");
  assert.equal(kv[WRITES], 0, "稳态不写 KV");

  // ---------- 场景 6：话题回复 -> thread: 命中 1 读 ----------
  kv = mockKV();
  await kv.put("thread:777", "42");
  await kv.put("user:42", JSON.stringify({ thread_id: 777, title: "A", closed: false }));
  kv[READS] = 0; kv[WRITES] = 0;
  tgCalls.length = 0;
  await post({ message: { chat: { id: -100123, type: "supergroup" }, from: { id: 1 }, message_thread_id: 777, message_id: 6, text: "reply" } });
  assert.equal(kv[READS], 1, "话题回复只 1 读");
  assert.ok(tgCalls.some((c) => c.method === "copyMessage"), "回复转发回用户");

  // ---------- 场景 7：非客服话题（General）-> 哨兵防重复扫描 ----------
  kv = mockKV();
  await kv.put("user:42", JSON.stringify({ thread_id: 777, title: "A", closed: false }));
  const generalMsg = { chat: { id: -100123, type: "supergroup" }, from: { id: 1 }, message_thread_id: 1, message_id: 7, text: "闲聊" };
  await post({ message: generalMsg });
  const firstReads = kv[READS], firstWrites = kv[WRITES];
  assert.ok(firstWrites >= 2, "首次 miss：扫描(list+get) + 写哨兵");
  assert.equal(await kv.get("thread:1"), "-1", "写入哨兵 -1");
  kv[READS] = 0; kv[WRITES] = 0;
  await post({ message: { ...generalMsg, message_id: 8 } });
  assert.equal(kv[READS], 1, "哨兵命中：第二次只 1 读");
  assert.equal(kv[WRITES], 0, "哨兵命中：不再扫描/写入");

  // ---------- 场景 8：关闭话题服务端事件 ----------
  kv = mockKV();
  await kv.put("thread:777", "42");
  await kv.put("user:42", JSON.stringify({ thread_id: 777, title: "A", closed: false }));
  kv[READS] = 0; kv[WRITES] = 0;
  await post({ message: { chat: { id: -100123, type: "supergroup" }, forum_topic_closed: true, message_thread_id: 777 } });
  const rec = JSON.parse(await kv.get("user:42"));
  assert.equal(rec.closed, true, "closed 标志落库");

  // ---------- 场景 9：端到端完整答题流程（合并自旧版 woker.test.mjs） ----------
  // 同一 harness 内连续驱动：/start 出题 -> 答错 -> 全角数字答对 -> 首条真实消息建话题转发
  kv = mockKV();
  tgCalls.length = 0;
  const send42 = (text, messageId) =>
    post({ message: { chat: { id: 42, type: "private" }, from: { id: 42, first_name: "测试用户" }, message_id: messageId, text } });

  await send42("/start", 1);
  const challenge = JSON.parse(await kv.get("challenge:42"));
  assert.match(challenge.question, /^\d+ [+-] \d+ = \?$/, "出题格式正确");
  assert.equal(tgCalls.at(-1).method, "sendMessage");
  assert.match(tgCalls.at(-1).text, /请直接回复答案数字/, "出题消息文案");

  await send42("答案不知道", 2);
  assert.equal(await kv.get("verified:42"), null, "答错不写 verified:");
  assert.equal(tgCalls.at(-1).method, "sendMessage");
  assert.match(tgCalls.at(-1).text, /答案不正确/, "答错提示文案");
  assert.ok(!tgCalls.some((c) => c.method === "forwardMessage"), "答题消息不转发");

  const toFullWidthDigits = (v) => String(v).replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x30 + 0xff10));
  await send42(toFullWidthDigits(challenge.answer), 3);
  assert.equal(await kv.get("verified:42"), "1", "全角数字答对后写 verified:");
  assert.equal(await kv.get("challenge:42"), null, "答对后删 challenge:");
  assert.match(tgCalls.at(-1).text, /验证成功/, "验证成功文案");
  assert.ok(!tgCalls.some((c) => c.method === "forwardMessage"), "验证成功消息不转发");

  await send42("你好", 4);
  assert.equal(tgCalls.at(-2).method, "createForumTopic", "首条真实消息创建话题");
  assert.equal(tgCalls.at(-1).method, "forwardMessage", "随后转发到话题");
  assert.equal(await kv.get("verified:42"), null, "verified: 桥接键被消费");

  console.log("✅ 全部 9 个场景通过");
}

main().catch((e) => {
  console.error("❌ 测试失败:", e.message);
  process.exit(1);
});
