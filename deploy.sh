#!/usr/bin/env bash
# 一键部署脚本：检查环境 → 引导填配置 → 部署 → 重设 webhook
# 用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "===== 1/4 检查环境 ====="
command -v node >/dev/null || { echo "缺少 Node.js，请先: brew install node"; exit 1; }
command -v wrangler >/dev/null || { echo "安装 wrangler..."; npm install -g wrangler; }
command -v openssl >/dev/null || { echo "缺少 openssl"; exit 1; }

echo "===== 2/4 登录 Cloudflare ====="
wrangler whoami >/dev/null 2>&1 || wrangler login

echo "===== 3/4 检查配置 ====="
if grep -q "xxxxxxxxxx\|<现有\|123456789" wrangler.toml; then
  echo "❌ wrangler.toml 里还有占位符未替换（name / KV id / SUPERGROUP_ID / BOT_ID）"
  echo "   请先编辑 wrangler.toml 填入真实值后重新运行本脚本"
  exit 1
fi
echo "配置检查通过"

echo "===== 4/4 部署 ====="
read -rp "是否已通过 wrangler secret put 配置过 BOT_TOKEN 和 WEBHOOK_SECRET？(y/n) " ok
if [[ "$ok" != "y" ]]; then
  echo "请先执行:"
  echo "  wrangler secret put BOT_TOKEN"
  echo "  wrangler secret put WEBHOOK_SECRET"
  exit 1
fi
wrangler deploy

echo ""
echo "===== 部署完成 ====="
echo "接下来手动执行（替换 <TOKEN> 和 <SECRET> 为实际值）:"
echo "  curl \"https://api.telegram.org/bot<TOKEN>/setWebhook\" \\"
echo "    -d \"url=<WORKER_URL>\" -d \"secret_token=<SECRET>\""
