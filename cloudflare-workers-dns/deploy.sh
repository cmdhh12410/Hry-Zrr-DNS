#!/bin/bash
# ============================================================
# 一键部署脚本 - DNS 分发系统
# 用法: chmod +x deploy.sh && ./deploy.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

STEP=0
TOTAL=7

# 打印分隔线
divider() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# 步骤开始
step_start() {
    STEP=$((STEP + 1))
    echo ""
    echo -e "${BOLD}${BLUE}[${STEP}/${TOTAL}]${NC} ${BOLD}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# 步骤成功
step_ok() {
    echo -e "  ${GREEN}✓${NC} $1"
}

# 步骤失败
step_fail() {
    echo -e "  ${RED}✗${NC} $1"
    echo ""
    echo -e "${RED}部署失败！请检查以上错误信息。${NC}"
    exit 1
}

# ============================================================
# 欢迎信息
# ============================================================
clear 2>/dev/null || true
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║      六趣DNS - 一键部署脚本                  ║"
echo "  ║      Cloudflare Workers + D1 + KV            ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo "  本脚本将自动完成以下步骤:"
echo ""
echo "    1. 环境检查 (Node.js, npm, wrangler)"
echo "    2. 安装项目依赖 (npm install)"
echo "    3. 创建 Cloudflare 资源 (D1 + KV)"
echo "    4. 初始化数据库 (表结构 + 种子数据)"
echo "    5. 配置 JWT 密钥"
echo "    6. 部署 Worker 到 Cloudflare"
echo "    7. 验证部署结果"
echo ""
echo "  请确保你已安装并登录 Cloudflare:"
echo -e "    ${YELLOW}npx wrangler login${NC}"
echo ""
read -p "  按 Enter 开始部署，或 Ctrl+C 取消... "

# ============================================================
# Step 1: 环境检查
# ============================================================
step_start "环境检查"

bash scripts/check-env.sh
if [ $? -ne 0 ]; then
    step_fail "环境检查未通过"
fi
step_ok "环境检查通过"

# ============================================================
# Step 2: 安装依赖
# ============================================================
step_start "安装项目依赖"

if [ ! -d "node_modules" ]; then
    npm install
    step_ok "依赖安装完成"
else
    step_ok "依赖已存在，跳过安装"
fi

# ============================================================
# Step 3: 创建 Cloudflare 资源
# ============================================================
step_start "创建 Cloudflare 资源"

bash scripts/setup-resources.sh
if [ $? -ne 0 ]; then
    step_fail "资源创建失败"
fi
step_ok "资源创建完成"

# ============================================================
# Step 4: 初始化数据库
# ============================================================
step_start "初始化数据库"

bash scripts/init-db.sh
if [ $? -ne 0 ]; then
    step_fail "数据库初始化失败"
fi
step_ok "数据库初始化完成"

# ============================================================
# Step 5: 配置 JWT 密钥
# ============================================================
step_start "配置 JWT 密钥"

# 从 .env 读取 JWT_SECRET
if [ -f ".env" ]; then
    JWT_SECRET=$(grep JWT_SECRET .env 2>/dev/null | cut -d= -f2 || true)
fi

if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo "JWT_SECRET=${JWT_SECRET}" >> .env
fi

# 设置 Cloudflare Secret
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET > /dev/null 2>&1
step_ok "JWT 密钥已配置"

# ============================================================
# Step 6: 部署 Worker
# ============================================================
step_start "部署 Worker 到 Cloudflare"

DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
DEPLOY_EXIT=$?

if [ $DEPLOY_EXIT -ne 0 ]; then
    echo "$DEPLOY_OUTPUT"
    step_fail "Worker 部署失败"
fi

# 提取 Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)

if [ -z "$WORKER_URL" ]; then
    WORKER_NAME=$(grep "^name" wrangler.toml | sed 's/name\s*=\s*"\(.*\)"/\1/' | tr -d ' ')
    echo -e "  ${YELLOW}⚠${NC}  无法自动提取 Worker URL，使用默认格式"
    WORKER_URL="https://${WORKER_NAME}.your-subdomain.workers.dev"
fi

step_ok "Worker 部署成功"
echo -e "  URL: ${CYAN}${WORKER_URL}${NC}"

# ============================================================
# Step 7: 验证部署
# ============================================================
step_start "验证部署"

bash scripts/verify-deploy.sh "$WORKER_URL"
if [ $? -ne 0 ]; then
    echo -e "  ${YELLOW}⚠${NC}  验证部分失败，但部署已完成"
fi

# ============================================================
# 完成
# ============================================================
divider

echo -e "${BOLD}${GREEN}  🎉 部署成功！${NC}"
echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo -e "  │  Worker URL:  ${CYAN}${WORKER_URL}${NC}"
echo -e "  │  管理后台:    ${CYAN}${WORKER_URL}/admin${NC}"
echo -e "  │  管理员账号:  ${YELLOW}admin@qq.com${NC}"
echo -e "  │  管理员密码:  ${YELLOW}admin123${NC}"
echo "  └─────────────────────────────────────────────┘"
echo ""
echo -e "  ${RED}⚠ 重要：首次登录后请立即修改管理员密码！${NC}"
echo ""
echo "  常用命令:"
echo "    npx wrangler tail      查看实时日志"
echo "    npx wrangler deploy    重新部署"
echo "    npx wrangler dev       本地开发"
echo ""
echo "  更多信息请查看 README.md"
echo ""
exit 0