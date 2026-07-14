# ============================================================
# 一键部署脚本 - DNS 分发系统 (Windows PowerShell)
# 用法: .\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$Step = 0
$Total = 7

# 颜色函数
function Write-Step {
    param([string]$Message)
    $global:Step++
    Write-Host ""
    Write-Host "[$Step/$Total] $Message" -ForegroundColor Cyan
    Write-Host ("-" * 55)
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  ✓ $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  ✗ $Message" -ForegroundColor Red
    Write-Host ""
    Write-Host "部署失败！请检查以上错误信息。" -ForegroundColor Red
    exit 1
}

# ============================================================
# 欢迎信息
# ============================================================
Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║                                              ║" -ForegroundColor Cyan
Write-Host "  ║      六趣DNS - 一键部署脚本                  ║" -ForegroundColor Cyan
Write-Host "  ║      Cloudflare Workers + D1 + KV            ║" -ForegroundColor Cyan
Write-Host "  ║                                              ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  本脚本将自动完成以下步骤:"
Write-Host ""
Write-Host "    1. 环境检查 (Node.js, npm, wrangler)"
Write-Host "    2. 安装项目依赖 (npm install)"
Write-Host "    3. 创建 Cloudflare 资源 (D1 + KV)"
Write-Host "    4. 初始化数据库 (表结构 + 种子数据)"
Write-Host "    5. 配置 JWT 密钥"
Write-Host "    6. 部署 Worker 到 Cloudflare"
Write-Host "    7. 验证部署结果"
Write-Host ""
Write-Host "  请确保你已安装并登录 Cloudflare:"
Write-Host "    npx wrangler login" -ForegroundColor Yellow
Write-Host ""
Read-Host "  按 Enter 开始部署，或 Ctrl+C 取消"

# ============================================================
# Step 1: 环境检查
# ============================================================
Write-Step "环境检查"

# 检查 Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $majorVersion = [int]($nodeVersion -split '\.')[0]
    if ($majorVersion -ge 18) {
        Write-Host "  ✓ Node.js >= 18 (当前: v$nodeVersion)" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Node.js 版本过低 (当前: v$nodeVersion, 需要 >= 18)" -ForegroundColor Red
        Write-Host "  → 请安装 Node.js 18+: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host "  ✗ Node.js 未安装" -ForegroundColor Red
    Write-Host "  → 请安装 Node.js 18+: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# 检查 npm
try {
    $npmVersion = npm -v
    Write-Host "  ✓ npm (当前: $npmVersion)" -ForegroundColor Green
} catch {
    Write-Host "  ✗ npm 未安装" -ForegroundColor Red
    exit 1
}

# 检查 wrangler
try {
    $wranglerCheck = npx wrangler --version 2>&1
    Write-Host "  ✓ wrangler CLI" -ForegroundColor Green
} catch {
    Write-Host "  ✗ wrangler CLI 未安装" -ForegroundColor Red
    Write-Host "  → 请运行: npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

# 检查 wrangler 登录
try {
    $whoami = npx wrangler whoami 2>&1
    Write-Host "  ✓ wrangler 已登录" -ForegroundColor Green
} catch {
    Write-Host "  ✗ wrangler 未登录" -ForegroundColor Red
    Write-Host "  → 请运行: npx wrangler login" -ForegroundColor Yellow
    exit 1
}

# 检查项目文件
if (Test-Path "wrangler.toml") {
    Write-Host "  ✓ wrangler.toml 存在" -ForegroundColor Green
} else {
    Write-Host "  ✗ wrangler.toml 不存在" -ForegroundColor Red
    exit 1
}

if (Test-Path "migrations/0001_initial.sql") {
    Write-Host "  ✓ 数据库迁移文件" -ForegroundColor Green
} else {
    Write-Host "  ✗ 数据库迁移文件不存在" -ForegroundColor Red
    exit 1
}

Write-Ok "环境检查通过"

# ============================================================
# Step 2: 安装依赖
# ============================================================
Write-Step "安装项目依赖"

if (-not (Test-Path "node_modules")) {
    npm install
    Write-Ok "依赖安装完成"
} else {
    Write-Ok "依赖已存在，跳过安装"
}

# ============================================================
# Step 3: 创建 Cloudflare 资源
# ============================================================
Write-Step "创建 Cloudflare 资源"

Write-Host "  → 创建 D1 数据库..."

try {
    $d1Exists = npx wrangler d1 list 2>&1 | Select-String "dns-db"
} catch {
    $d1Exists = $null
}

if ($d1Exists) {
    Write-Host "  ⚠ D1 数据库 'dns-db' 已存在，跳过创建" -ForegroundColor Yellow
    $d1List = npx wrangler d1 list 2>&1
    $d1Id = ($d1List | Select-String 'database_id' | Out-String) -replace '.*"([^"]+)".*', '$1'
} else {
    $d1Output = npx wrangler d1 create dns-db 2>&1
    $d1Id = ($d1Output | Out-String) -replace '(?s).*database_id.*?"([^"]+)".*', '$1'
    Write-Host "  ✓ D1 数据库创建成功" -ForegroundColor Green
}

Write-Host "  Database ID: $d1Id" -ForegroundColor Yellow

Write-Host "  → 创建 KV 命名空间..."

try {
    $kvExists = npx wrangler kv:namespace list 2>&1 | Select-String '"KV"'
} catch {
    $kvExists = $null
}

if ($kvExists) {
    Write-Host "  ⚠ KV 命名空间 'KV' 已存在，跳过创建" -ForegroundColor Yellow
    $kvList = npx wrangler kv:namespace list 2>&1
    $kvId = ($kvList | Select-String 'id' | Out-String) -replace '.*"([^"]+)".*', '$1'
} else {
    $kvOutput = npx wrangler kv:namespace create KV 2>&1
    $kvId = ($kvOutput | Out-String) -replace '(?s).*"id".*?"([^"]+)".*', '$1'
    Write-Host "  ✓ KV 命名空间创建成功" -ForegroundColor Green
}

Write-Host "  KV ID: $kvId" -ForegroundColor Yellow

# 更新 wrangler.toml
Write-Host "  → 更新 wrangler.toml..."
$tomlContent = Get-Content wrangler.toml -Raw
$tomlContent = $tomlContent -replace 'KV_ID_PLACEHOLDER', $kvId
$tomlContent = $tomlContent -replace 'KV_PREVIEW_ID_PLACEHOLDER', $kvId
$tomlContent = $tomlContent -replace 'D1_ID_PLACEHOLDER', $d1Id
Set-Content wrangler.toml $tomlContent -NoNewline
Write-Ok "wrangler.toml 已更新"

Write-Ok "资源创建完成"

# ============================================================
# Step 4: 初始化数据库
# ============================================================
Write-Step "初始化数据库"

Write-Host "  → 创建表结构..."
npx wrangler d1 execute dns-db --remote --file=./migrations/0001_initial.sql
Write-Ok "表结构创建完成"

Write-Host "  → 导入种子数据..."
npx wrangler d1 execute dns-db --remote --file=./migrations/0002_seed.sql
Write-Ok "种子数据导入完成"

Write-Ok "数据库初始化完成"

# ============================================================
# Step 5: 配置 JWT 密钥
# ============================================================
Write-Step "配置 JWT 密钥"

$jwtSecret = $null
if (Test-Path ".env") {
    $envContent = Get-Content .env -Raw
    if ($envContent -match 'JWT_SECRET=(.+)') {
        $jwtSecret = $matches[1].Trim()
    }
}

if (-not $jwtSecret) {
    $jwtSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
    Add-Content .env "JWT_SECRET=$jwtSecret"
}

Write-Host "  → 上传 JWT_SECRET 到 Cloudflare..."
$jwtSecret | npx wrangler secret put JWT_SECRET 2>&1 | Out-Null
Write-Ok "JWT 密钥已配置"

# ============================================================
# Step 6: 部署 Worker
# ============================================================
Write-Step "部署 Worker 到 Cloudflare"

$deployOutput = npx wrangler deploy 2>&1
$deployOutputStr = $deployOutput | Out-String

if ($LASTEXITCODE -ne 0) {
    Write-Host $deployOutputStr
    Write-Fail "Worker 部署失败"
}

# 提取 Worker URL
$workerUrl = ""
if ($deployOutputStr -match 'https://[a-zA-Z0-9.-]+\.workers\.dev') {
    $workerUrl = $matches[0]
}

if (-not $workerUrl) {
    $workerName = (Get-Content wrangler.toml -Raw) -replace '(?s).*name\s*=\s*"([^"]+)".*', '$1'
    Write-Host "  ⚠ 无法自动提取 Worker URL，使用默认格式" -ForegroundColor Yellow
    $workerUrl = "https://$workerName.your-subdomain.workers.dev"
}

Write-Ok "Worker 部署成功"
Write-Host "  URL: $workerUrl" -ForegroundColor Cyan

# ============================================================
# Step 7: 验证部署
# ============================================================
Write-Step "验证部署"

Write-Host "  → 健康检查..."
$maxRetries = 5
$healthOk = $false

for ($i = 1; $i -le $maxRetries; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "$workerUrl/health" -Method Get -TimeoutSec 10 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host "  ✓ /health 返回 200" -ForegroundColor Green
            $healthOk = $true
            break
        }
    } catch {
        Write-Host "  → 重试 $i/$maxRetries..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
    }
}

if (-not $healthOk) {
    Write-Host "  ⚠ 健康检查超时，请稍后手动验证" -ForegroundColor Yellow
}

Write-Host "  → 管理员登录测试..."
try {
    $loginBody = @{account="admin@qq.com";password="admin123"} | ConvertTo-Json
    $loginResp = Invoke-RestMethod -Uri "$workerUrl/api/auth/login" -Method Post -Body $loginBody -ContentType "application/json" -TimeoutSec 10
    if ($loginResp.code -eq 200) {
        Write-Host "  ✓ 管理员登录成功" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ 管理员登录异常" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ⚠ 登录测试失败，请稍后手动验证" -ForegroundColor Yellow
}

# ============================================================
# 完成
# ============================================================
Write-Host ""
Write-Host ("-" * 55)
Write-Host ""
Write-Host "  🎉 部署成功！" -ForegroundColor Green
Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────┐"
Write-Host "  │  Worker URL:  $workerUrl" -ForegroundColor Cyan
Write-Host "  │  管理后台:    $workerUrl/admin" -ForegroundColor Cyan
Write-Host "  │  管理员账号:  admin@qq.com" -ForegroundColor Yellow
Write-Host "  │  管理员密码:  admin123" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────┘"
Write-Host ""
Write-Host "  ⚠ 重要：首次登录后请立即修改管理员密码！" -ForegroundColor Red
Write-Host ""
Write-Host "  常用命令:"
Write-Host "    npx wrangler tail      查看实时日志"
Write-Host "    npx wrangler deploy    重新部署"
Write-Host "    npx wrangler dev       本地开发"
Write-Host ""
exit 0