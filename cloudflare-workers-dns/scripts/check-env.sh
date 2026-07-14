#!/bin/bash
# ============================================================
# 环境检查脚本 - DNS 分发系统部署前检查
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

check() {
    local name="$1"
    local result="$2"
    local hint="$3"
    if [ "$result" = "ok" ]; then
        echo -e "  ${GREEN}✓${NC} $name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $name"
        if [ -n "$hint" ]; then
            echo -e "    ${YELLOW}→ $hint${NC}"
        fi
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "=========================================="
echo "  DNS 分发系统 - 环境检查"
echo "=========================================="
echo ""

# 1. 检查 Node.js
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -ge 18 ]; then
    check "Node.js >= 18 (当前: $(node -v))" "ok"
else
    check "Node.js >= 18 (当前: ${NODE_VERSION:-未安装})" "fail" \
        "请安装 Node.js 18+: https://nodejs.org/"
fi

# 2. 检查 npm
if command -v npm &>/dev/null; then
    check "npm (当前: $(npm -v))" "ok"
else
    check "npm" "fail" "npm 随 Node.js 一起安装，请重新安装 Node.js"
fi

# 3. 检查 wrangler
if command -v wrangler &>/dev/null || npx wrangler --version &>/dev/null 2>&1; then
    WRANGLER_VER=$(npx wrangler --version 2>/dev/null | head -1)
    check "wrangler CLI (${WRANGLER_VER})" "ok"
else
    check "wrangler CLI" "fail" \
        "请运行: npm install -g wrangler"
fi

# 4. 检查 wrangler 登录状态
if npx wrangler whoami &>/dev/null 2>&1; then
    WHOAMI=$(npx wrangler whoami 2>/dev/null | head -1)
    check "wrangler 登录状态 (${WHOAMI})" "ok"
else
    check "wrangler 登录状态" "fail" \
        "请运行: npx wrangler login"
fi

# 5. 检查项目文件
if [ -f "wrangler.toml" ]; then
    check "wrangler.toml 存在" "ok"
else
    check "wrangler.toml 存在" "fail" "请确保在项目根目录执行脚本"
fi

if [ -f "migrations/0001_initial.sql" ]; then
    check "数据库迁移文件" "ok"
else
    check "数据库迁移文件" "fail" "缺少 migrations/0001_initial.sql"
fi

if [ -f "package.json" ]; then
    check "package.json" "ok"
else
    check "package.json" "fail" "缺少 package.json"
fi

echo ""
echo "=========================================="
echo "  检查结果: ${GREEN}${PASS} 通过${NC}, ${RED}${FAIL} 失败${NC}"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo -e "${RED}环境检查未通过，请修复以上问题后重试。${NC}"
    exit 1
fi

echo -e "${GREEN}环境检查全部通过！${NC}"
echo ""
exit 0