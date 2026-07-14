#!/bin/bash
# ============================================================
# Cloudflare 资源创建脚本 - D1 数据库 + KV 命名空间
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo ""
echo "=========================================="
echo "  Cloudflare 资源创建"
echo "=========================================="
echo ""

# --- 创建 D1 数据库 ---
echo -e "${CYAN}[1/4]${NC} 创建 D1 数据库..."

D1_EXISTS=$(npx wrangler d1 list 2>/dev/null | grep -c "dns-db" || true)

if [ "$D1_EXISTS" -gt 0 ]; then
    echo -e "  ${YELLOW}⚠${NC}  D1 数据库 'dns-db' 已存在，跳过创建"
    # 从现有数据库中提取 ID
    D1_ID=$(npx wrangler d1 list 2>/dev/null | grep -A3 "dns-db" | grep "database_id" | sed 's/.*"\([^"]*\)".*/\1/')
else
    D1_OUTPUT=$(npx wrangler d1 create dns-db 2>&1)
    D1_ID=$(echo "$D1_OUTPUT" | grep "database_id" | sed 's/.*"\([^"]*\)".*/\1/')

    if [ -z "$D1_ID" ]; then
        echo -e "  ${RED}✗${NC} D1 数据库创建失败"
        echo "$D1_OUTPUT"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} D1 数据库创建成功"
fi
echo -e "  Database ID: ${YELLOW}${D1_ID}${NC}"

# --- 创建 KV 命名空间 ---
echo ""
echo -e "${CYAN}[2/4]${NC} 创建 KV 命名空间..."

KV_EXISTS=$(npx wrangler kv:namespace list 2>/dev/null | grep -c '"KV"' || true)

if [ "$KV_EXISTS" -gt 0 ]; then
    echo -e "  ${YELLOW}⚠${NC}  KV 命名空间 'KV' 已存在，跳过创建"
    KV_ID=$(npx wrangler kv:namespace list 2>/dev/null | grep -B1 '"KV"' | grep 'id' | sed 's/.*"\([^"]*\)".*/\1/')
else
    KV_OUTPUT=$(npx wrangler kv:namespace create KV 2>&1)
    KV_ID=$(echo "$KV_OUTPUT" | grep '"id"' | sed 's/.*"\([^"]*\)".*/\1/')

    if [ -z "$KV_ID" ]; then
        echo -e "  ${RED}✗${NC} KV 命名空间创建失败"
        echo "$KV_OUTPUT"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} KV 命名空间创建成功"
fi
echo -e "  KV ID: ${YELLOW}${KV_ID}${NC}"

# --- 更新 wrangler.toml ---
echo ""
echo -e "${CYAN}[3/4]${NC} 更新 wrangler.toml 配置..."

if [ ! -f "wrangler.toml" ]; then
    echo -e "  ${RED}✗${NC} 找不到 wrangler.toml"
    exit 1
fi

# 备份原文件
cp wrangler.toml wrangler.toml.bak

# 替换 KV ID
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/KV_ID_PLACEHOLDER/${KV_ID}/g" wrangler.toml
    sed -i '' "s/KV_PREVIEW_ID_PLACEHOLDER/${KV_ID}/g" wrangler.toml
    sed -i '' "s/D1_ID_PLACEHOLDER/${D1_ID}/g" wrangler.toml
else
    # Linux
    sed -i "s/KV_ID_PLACEHOLDER/${KV_ID}/g" wrangler.toml
    sed -i "s/KV_PREVIEW_ID_PLACEHOLDER/${KV_ID}/g" wrangler.toml
    sed -i "s/D1_ID_PLACEHOLDER/${D1_ID}/g" wrangler.toml
fi

echo -e "  ${GREEN}✓${NC} wrangler.toml 已更新"
echo -e "  ${YELLOW}ℹ${NC}  原文件备份为 wrangler.toml.bak"

# --- 配置 JWT 密钥 ---
echo ""
echo -e "${CYAN}[4/4]${NC} 配置 JWT 密钥..."

# 检查是否已有 .env 文件
JWT_SECRET=""
if [ -f ".env" ]; then
    JWT_SECRET=$(grep JWT_SECRET .env 2>/dev/null | cut -d= -f2 || true)
fi

if [ -z "$JWT_SECRET" ]; then
    # 生成 64 位随机密钥
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo "JWT_SECRET=${JWT_SECRET}" > .env
    echo -e "  ${GREEN}✓${NC} JWT 密钥已生成并保存到 .env"
else
    echo -e "  ${YELLOW}⚠${NC}  JWT 密钥已存在，跳过生成"
fi

# 设置 Cloudflare Secret
echo -e "  ${CYAN}→${NC} 正在将 JWT_SECRET 上传到 Cloudflare..."
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET 2>&1 | tail -1

echo ""
echo "=========================================="
echo -e "  ${GREEN}资源创建完成！${NC}"
echo "=========================================="
echo ""
echo "  已创建/配置:"
echo "    D1 数据库: dns-db (${D1_ID})"
echo "    KV 命名空间: KV (${KV_ID})"
echo "    JWT 密钥: 已保存到 .env"
echo "    wrangler.toml: 已更新"
echo ""
exit 0