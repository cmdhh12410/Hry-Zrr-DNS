#!/bin/bash
# ============================================================
# 部署验证脚本 - 验证 Worker 部署是否成功
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

# 从 wrangler.toml 获取 Worker 名称
WORKER_NAME=$(grep "^name" wrangler.toml 2>/dev/null | sed 's/name\s*=\s*"\(.*\)"/\1/' | tr -d ' ')

if [ -z "$WORKER_NAME" ]; then
    WORKER_NAME="dns-distribution-system"
fi

echo ""
echo "=========================================="
echo "  部署验证"
echo "=========================================="
echo ""

# 获取 Worker URL - 优先使用参数，否则尝试从部署输出获取
WORKER_URL="${1:-}"

if [ -z "$WORKER_URL" ]; then
    echo -e "${CYAN}→${NC} 正在获取 Worker URL..."
    # 尝试从 wrangler 获取
    DEPLOY_INFO=$(npx wrangler deployments list 2>/dev/null | head -10 || true)
    # 默认 URL 格式
    WORKER_URL="https://${WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID:-your-subdomain}.workers.dev"
    
    # 尝试从最近的部署输出中提取
    if [ -f ".wrangler/deploy/index.js" ] || [ -f ".wrangler/state/deploy.json" ]; then
        echo -e "  ${YELLOW}⚠${NC}  无法自动获取 Worker URL"
    fi
fi

echo -e "  Worker URL: ${YELLOW}${WORKER_URL}${NC}"
echo ""

# --- 1. 健康检查 ---
echo -e "${CYAN}[1/3]${NC} 健康检查..."

MAX_RETRIES=5
RETRY_DELAY=3
HEALTH_OK=false

for i in $(seq 1 $MAX_RETRIES); do
    HEALTH_RESP=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/health" 2>/dev/null || echo "000")
    
    if [ "$HEALTH_RESP" = "200" ]; then
        echo -e "  ${GREEN}✓${NC} /health 返回 200"
        HEALTH_OK=true
        break
    else
        echo -e "  ${YELLOW}→${NC} 重试 ${i}/${MAX_RETRIES}... (状态码: ${HEALTH_RESP})"
        sleep $RETRY_DELAY
    fi
done

if [ "$HEALTH_OK" = false ]; then
    echo -e "  ${RED}✗${NC} 健康检查失败，请稍后手动验证"
    echo "     curl ${WORKER_URL}/health"
    # 不退出，继续验证其他端点
fi

# --- 2. 登录测试 ---
echo ""
echo -e "${CYAN}[2/3]${NC} 管理员登录测试..."

LOGIN_RESP=$(curl -s -X POST "${WORKER_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"account":"admin@qq.com","password":"admin123"}' 2>/dev/null || echo '{"code":500}')

LOGIN_CODE=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',0))" 2>/dev/null || echo "0")

if [ "$LOGIN_CODE" = "200" ]; then
    echo -e "  ${GREEN}✓${NC} 管理员登录成功"
    TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" 2>/dev/null || echo "")
else
    echo -e "  ${RED}✗${NC} 管理员登录失败"
    echo "    响应: $(echo $LOGIN_RESP | head -c 200)"
fi

# --- 3. API 端点测试 ---
echo ""
echo -e "${CYAN}[3/3]${NC} API 端点测试..."

if [ -n "$TOKEN" ]; then
    STATS_RESP=$(curl -s "${WORKER_URL}/api/admin/stats" \
        -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo '{"code":500}')
    STATS_CODE=$(echo "$STATS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',0))" 2>/dev/null || echo "0")
    
    if [ "$STATS_CODE" = "200" ]; then
        echo -e "  ${GREEN}✓${NC} /api/admin/stats 正常"
        USERS=$(echo "$STATS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['total_users'])" 2>/dev/null || echo "?")
        echo -e "    用户数: ${USERS}"
    else
        echo -e "  ${YELLOW}⚠${NC}  /api/admin/stats 异常"
    fi
else
    echo -e "  ${YELLOW}⚠${NC}  跳过 API 测试（无 Token）"
fi

echo ""
echo "=========================================="
echo -e "  ${GREEN}验证完成！${NC}"
echo "=========================================="
echo ""
echo "  Worker URL: ${WORKER_URL}"
echo "  管理后台: ${WORKER_URL}/admin"
echo "  管理员: admin@qq.com / admin123"
echo ""
exit 0