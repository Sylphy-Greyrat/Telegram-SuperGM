# Telegram-SuperGM
## TG 双向机器人超级群组 Cloudflare Worker 版

一个部署在 **Cloudflare Workers** 上的 Telegram 机器人中间层，实现“**私聊 ↔ 超级群话题**”的隔离转发，适合客服、中介、工单等场景。

```text
用户私聊  ──▶ Bot / Worker ──▶ 用户专属话题（Supergroup Topic）
    ▲                               │
    └─────────────◀─────────────────┘
           话题回复回流到用户私聊
```

## ✨ 项目亮点

- 🛡️ **数字验证**：新用户先在 Telegram 私聊中回答一道简单算术题，降低机器人骚扰和滥用风险。
- 💬 **独立话题沟通**：每个用户都在独立的 Telegram 话题（Forum）中对话，历史清晰、管理不串线。
- 🔄 **话题自动改名**：用户修改昵称或 `@username` 后，话题标题会在其下一条私聊消息时自动同步更新，管理员无需手动辨认。
- ⚫️ **随时拉黑用户**：若不想再接收某个用户的消息，直接在群内关闭对应话题，即可拦截 TA 的所有后续消息。（市面上的bot几乎都没有一键屏蔽用户消息的功能）
- 🖼️ **多媒体支持**：支持图片、视频、文件等消息类型的转发；文本消息支持 Telegram Markdown 格式。
- ⚡ **无需自建服务器**：基于 Cloudflare Worker，按量计费，省心托管，轻松应对大量消息。（实际上随便咋用都不会超过免费额度~）

---

## 项目结构

- `woker.js`：Cloudflare Worker 入口，处理 Telegram Webhook、读写 KV、调用 Bot API。
- `test/woker.test.mjs`：冒烟测试（mock KV + mock Telegram，断言读写次数与业务流程），`node test/woker.test.mjs` 直接跑。
- `wrangler.example.toml`：部署配置示例，复制为 `wrangler.toml` 后替换占位符。
- `deploy.sh`：一键部署脚本（检查环境 → 引导配置 → `wrangler deploy`）。
- `README.md`：项目说明文档（当前文件）。

### 相关频道 / 群

- 新站长仓库：<https://t.me/zhanzhangck>
- 站长群：<https://t.me/vpsbbq>

---

## KV 设置说明

本项目使用 Cloudflare KV 记录“用户 ↔ 话题”映射关系。

你只需要：

1. 在 Cloudflare Dashboard 创建一个 KV 命名空间（名称随意，例如 `tg-topic-map`）。
2. 在 Worker 的 **Settings → KV Namespace Bindings** 中绑定该命名空间，绑定名（Variable name）填：`TOPIC_MAP`。

所有实际的 key/value（例如：
- `user:<uid>` → `{ thread_id, title, closed }`
- `thread:<tid>` → `<uid>`（反向索引，话题消息 O(1) 反查用户）
- `verified:<uid>` / `challenge:<uid>` 等验证状态
）都会由程序自动写入，无需手动创建。

> KV 读写已做优化：稳态私聊每条消息仅 1 次 KV 读；非客服话题（如 General 闲聊）通过 1 小时 TTL 的哨兵缓存避免重复全量扫描，日常使用很难触及免费额度。

---

## 环境变量（Settings → Variables）

在 Worker 的 **Settings → Variables** 中添加以下变量：

| 变量名              | 必须 | 说明 / 示例                                                                 |
|---------------------|------|------------------------------------------------------------------------------|
| `BOT_TOKEN`         | 是   | Telegram Bot Token。例如：`123456789:xxxx`（建议用 Secret，见下方 wrangler 部署） |
| `BOT_ID`            | 是   | 机器人自身 user id，就是 Bot Token 冒号前面的数字，例如 `123456789`        |
| `SUPERGROUP_ID`     | 是   | 目标超级群 chat id，形如 `-100xxxxxxxxxx`                                  |
| `VERIFY_FLAG`       | 否   | `"1"` 开启答题验证（默认行为见代码），其他值关闭                            |
| `API_BASE`          | 否   | 默认 `https://api.telegram.org`                                             |

> 敏感变量（`BOT_TOKEN`、`WEBHOOK_SECRET`）建议用 `wrangler secret put` 配置，不要明文写进 `wrangler.toml`。

> 获取 `SUPERGROUP_ID` 小技巧：
> - 在 Telegram 桌面端右键群内任意消息，复制消息链接；
> - 链接里会有一段 `-100xxxxxxxxxx` 或 `xxxxxxxxxx`；
> - 若只看到纯数字 `xxxxxxxxxx`，在前面加上 `-100`，就是完整的 `SUPERGROUP_ID`（私密频道/群组同理）。

---

## 部署指南（Dashboard）

### 1. Telegram 侧

1. 在 **@BotFather** 创建机器人，记录 `BOT_TOKEN`。
2. 使用 `/setprivacy` 关闭隐私模式（选择 `Disable`），保证能收到群内消息。
3. 将 bot 拉入目标超级群：
   - 群内启用话题（Topics）功能；
   - 给 bot 授权“发消息、管理话题”等权限。
4. 通过复制消息链接或其它方式获取该群的 `chat_id`，配置为 `SUPERGROUP_ID`（格式为 `-100xxxxxxxxxx`）。

### 2. Cloudflare 侧

**方式 A：Dashboard（不含相册聚合）**

1. 创建 KV 命名空间，并在 Worker 中绑定为 `TOPIC_MAP`（见上文 KV 设置）。
2. 新建 Worker（Modules 模式），将 `woker.js` 代码粘贴进去。
3. 在 Settings → Variables 中配置上文列出的环境变量。
4. 如需自定义域名，为 Worker 添加路由，例如 `https://tgbot.xxxx.com/*`。

> 注意：相册聚合依赖 Durable Objects，Dashboard 在线编辑器无法配置该绑定，需用方式 B（wrangler）部署。

**方式 B：wrangler（推荐，功能完整）**

```bash
npm install -g wrangler
wrangler login
cp wrangler.example.toml wrangler.toml   # 按注释替换 KV id / 群 id / bot id
wrangler secret put BOT_TOKEN            # @BotFather 可查
openssl rand -hex 32                     # 生成随机串，复制输出
wrangler secret put WEBHOOK_SECRET       # 粘贴上面的串
./deploy.sh                              # 或直接 wrangler deploy
```

### 3. 启用 Webhook（非常关键）

Telegram 通过 Webhook 推送消息到你的 Worker：

- 首次部署、换域名、换路径时，一定要重新 `setWebhook`；
- 仅修改代码、域名不变时可以不用重新设置；
- 若配置了 `WEBHOOK_SECRET`，需附带 `secret_token` 参数（wrangler 部署方式已配置），Worker 会校验请求头防止伪造 update。

示例：使用默认 `*.workers.dev` 域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxx.workers.dev&secret_token=<WEBHOOK_SECRET>"
```

示例：使用自定义域名：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tgbot.xxxx.com&secret_token=<WEBHOOK_SECRET>"
```

执行后可通过 `getWebhookInfo` 确认 `url` 是否已是最新地址。

### 4. 功能验证

1. 自己先私聊 bot，会先收到一道算术题；直接回复答案数字，答对后再继续。
2. 再发一条普通消息：
   - 超级群应自动创建一个以你昵称/`@username` 命名的话题；
   - 私聊消息会带引用转发到该话题中。
3. 在该话题中回复：
   - bot 会把消息复制回你的私聊，不带“转发自”标记。
4. 在话题菜单中关闭话题后，再次发消息应只收到“话题已关闭”的提示，不再推送到群；重新开启话题后又会恢复转发。
5. 一次发送多张图片（相册）：
   - bot 应将整组相册聚合为一条媒体消息推送（wrangler 部署方式下生效，最多 10 张，2 秒超时自动发送）。
6. 修改自己的 Telegram 昵称或 `@username` 后，再给 bot 发一条消息：
   - 超级群中该用户的话题标题应自动更新为新名字。

---

## 调试与日志

建议使用 `wrangler` 实时查看 Worker 日志：

```bash
npm install -g wrangler
wrangler login
wrangler tail <Worker名>   # 例如 wrangler tail tgbot
```

如果需要查看完整的 Telegram `update`，可以在 `fetch` 或处理函数中临时加上：

```js
console.log(JSON.stringify(update, null, 2));
```

再通过 `wrangler tail` 观察输出。

---

## 常见问题（FAQ）

1. `getWebhookInfo` 报 `Wrong response from the webhook: 404 Not Found`？  
   - 多数是 Webhook URL 写错，或 Worker 仍然是默认模板 `return fetch(request)`；
   - 请确认 URL 与实际 Worker 域名/路径一致，并已替换为本项目的 `woker.js`。

2. `wrangler tail` 看不到任何日志？  
   - 本地先手动打一个 POST：
     ```bash
     curl -X POST "https://tgbot.xxx.workers.dev" -H "content-type: application/json" -d "{}"
     ```
   - 若仍看不到调用，说明请求未命中 Worker：检查域名是否正确、是否成功 Deploy、Workers 路由是否配置。

3. 关闭话题后仍有消息推送进来？  
   - 确认 bot 账户在群里能看到 `forum_topic_closed` / `forum_topic_reopened` 事件（`wrangler tail` 中应有对应字段）；
   - 如果是直接删除话题（而不是关闭），Worker 会认为线程不存在并为该用户创建新的话题，这是当前的默认行为。

4. 相册还是散着一条条发？  
   - 相册聚合依赖 Durable Objects 绑定，Dashboard 粘贴代码方式无法配置；
   - 请改用 wrangler 部署（见部署指南方式 B），确认部署输出中包含 `MEDIA_GROUPS` 绑定。

5. 修改代码后如何验证？  
   - 跑冒烟测试：`node test/woker.test.mjs`（9 个场景，覆盖 KV 读写次数、完整答题流程与改名同步），通过后再 `wrangler deploy`。

---

## 更新记录

- **2025-11-25**：修复用户端一次发送多媒体（相册消息）时会卡住、需等待后续消息才能一并推送的问题，新增 `ctx.waitUntil` 异步 flush，确保 2 秒超时即可自动发送;

- **2026-08-26**：验证改为 Telegram 内直接回答随机算术题，不再依赖网页或 Cloudflare Turnstile；题目记录保存 15 分钟，答对后才允许转发消息。

- **2026-09-08**：KV 读写优化——稳态私聊每条消息从 2 次 KV 读降为 1 次；非客服话题增加哨兵缓存，避免每条闲聊消息触发全量扫描（免费额度炸点）；补齐旧数据的 `thread:` 反向索引；`VERFITY_FLAG` 更正为 `VERIFY_FLAG`（兼容旧拼写）；相册聚合改用 Durable Objects 实现，新增 webhook secret 校验与 429 自动重试；新增 wrangler 部署配置与冒烟测试。同日新增话题标题自动跟随用户改名（昵称/`@username` 变化时同步，改名失败不阻断转发）。


---

## 安全提示

- **不要泄露 Bot Token**。若不慎泄露，请立即在 @BotFather 中执行 `/revoke` 并更新 Worker 的 `BOT_TOKEN`。
- KV 中仅存“用户 id ↔ 话题 id / 状态”等元数据，不存聊天内容；聊天记录由 Telegram 自身保存。
