#!/bin/bash
# ============================================================
# 数据库初始化脚本 - 创建表结构 + 导入种子数据
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
echo "  数据库初始化"
echo "=========================================="
echo ""

# --- 检查迁移文件 ---
if [ ! -f "migrations/0001_initial.sql" ]; then
    echo -e "${RED}✗${NC} 找不到 migrations/0001_initial.sql"
    exit 1
fi

if [ ! -f "migrations/0002_seed.sql" ]; then
    echo -e "${RED}✗${NC} 找不到 migrations/0002_seed.sql"
    exit 1
fi

# --- 执行 Schema 创建 ---
echo -e "${CYAN}[1/2]${NC} 创建数据库表结构..."
echo -e "  ${YELLOW}→${NC} 执行 migrations/0001_initial.sql..."

SCHEMA_OUTPUT=$(npx wrangler d1 execute dns-db --remote --file=./migrations/0001_initial.sql 2>&1)
SCHEMA_EXIT=$?

if [ $SCHEMA_EXIT -ne 0 ]; then
    echo -e "  ${RED}✗${NC} 表结构创建失败"
    echo "$SCHEMA_OUTPUT" | tail -20
    exit 1
fi

# 统计执行了多少条命令
CMD_COUNT=$(echo "$SCHEMA_OUTPUT" | grep -c "success" || true)
echo -e "  ${GREEN}✓${NC} 表结构创建成功 (${CMD_COUNT} 条 SQL 已执行)"

# --- 执行种子数据 ---
echo ""
echo -e "${CYAN}[2/2]${NC} 导入种子数据..."
echo -e "  ${YELLOW}→${NC} 执行 migrations/0002_seed.sql..."

SEED_OUTPUT=$(npx wrangler d1 execute dns-db --remote --file=./migrations/0002_seed.sql 2>&1)
SEED_EXIT=$?

if [ $SEED_EXIT -ne 0 ]; then
    echo -e "  ${RED}✗${NC} 种子数据导入失败"
    echo "$SEED_OUTPUT" | tail -20
    exit 1
fi

CMD_COUNT2=$(echo "$SEED_OUTPUT" | grep -c "success" || true)
echo -e "  ${GREEN}✓${NC} 种子数据导入成功 (${CMD_COUNT2} 条 SQL 已执行)"

echo ""
echo "=========================================="
echo -e "  ${GREEN}数据库初始化完成！${NC}"
echo "=========================================="
echo ""
echo "  已创建:"
echo "    - 所有数据库表 (40+ 张)"
echo "    - 默认管理员: admin@qq.com / admin123"
echo "    - 系统设置 (27 项)"
echo "    - 侧边栏菜单 (40 项)"
echo "    - 邮件模板 (4 个)"
echo ""
exit 0