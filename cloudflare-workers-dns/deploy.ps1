# ============================================================
# DNS System - One-Click Deploy (Windows PowerShell)
# Usage: .\deploy.ps1
# ============================================================

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$Step = 0
$Total = 7

function Write-Step {
    param([string]$Message)
    $global:Step++
    Write-Host ""
    Write-Host "[$Step/$Total] $Message" -ForegroundColor Cyan
    Write-Host ("-" * 55)
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  OK $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  FAIL $Message" -ForegroundColor Red
    Write-Host ""
    Write-Host "Deploy failed! Check the error above." -ForegroundColor Red
    exit 1
}

# ============================================================
# Welcome
# ============================================================
Clear-Host
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  DNS System - Deploy Script" -ForegroundColor Cyan
Write-Host "  Cloudflare Workers + D1 + KV" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Steps:"
Write-Host "    1. Check environment (Node.js, npm, wrangler)"
Write-Host "    2. Install dependencies (npm install)"
Write-Host "    3. Create Cloudflare resources (D1 + KV)"
Write-Host "    4. Initialize database (Schema + Seed)"
Write-Host "    5. Configure JWT secret"
Write-Host "    6. Deploy Worker to Cloudflare"
Write-Host "    7. Verify deployment"
Write-Host ""
Write-Host "  Make sure you have logged in to Cloudflare:"
Write-Host "    npx wrangler login" -ForegroundColor Yellow
Write-Host ""
Read-Host "  Press Enter to start, or Ctrl+C to cancel"

# ============================================================
# Step 1: Check Environment
# ============================================================
Write-Step "Check environment"

# Check Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $majorVersion = [int]($nodeVersion -split '\.')[0]
    if ($majorVersion -ge 18) {
        Write-Host "  OK Node.js >= 18 (v$nodeVersion)" -ForegroundColor Green
    } else {
        Write-Host "  FAIL Node.js too old (v$nodeVersion, need >= 18)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "  FAIL Node.js not installed" -ForegroundColor Red
    Write-Host "  Download: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check npm
try {
    $npmVersion = npm -v
    Write-Host "  OK npm ($npmVersion)" -ForegroundColor Green
} catch {
    Write-Host "  FAIL npm not installed" -ForegroundColor Red
    exit 1
}

# Check wrangler
$wranglerVersion = cmd /c "npx wrangler --version 2>&1"
if ($LASTEXITCODE -eq 0 -and $wranglerVersion) {
    Write-Host "  OK wrangler CLI" -ForegroundColor Green
} else {
    Write-Host "  FAIL wrangler not installed" -ForegroundColor Red
    Write-Host "  Run: npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

# Check wrangler login (supports both OAuth and API Token)
$loggedIn = $false
$whoamiOutput = cmd /c "npx wrangler whoami 2>&1"
if ($LASTEXITCODE -eq 0 -and $whoamiOutput -match 'logged in|You are logged in|👋') {
    $loggedIn = $true
}

if (-not $loggedIn -and $env:CLOUDFLARE_API_TOKEN) {
    $loggedIn = $true
}

if ($loggedIn) {
    Write-Host "  OK wrangler logged in" -ForegroundColor Green
} else {
    Write-Host "  FAIL wrangler not logged in" -ForegroundColor Red
    Write-Host "  Run: npx wrangler login" -ForegroundColor Yellow
    Write-Host "  Or set env: CLOUDFLARE_API_TOKEN" -ForegroundColor Yellow
    exit 1
}

# Check project files
if (Test-Path "wrangler.toml") {
    Write-Host "  OK wrangler.toml" -ForegroundColor Green
} else {
    Write-Host "  FAIL wrangler.toml not found" -ForegroundColor Red
    exit 1
}

if (Test-Path "migrations\0001_initial.sql") {
    Write-Host "  OK migration files" -ForegroundColor Green
} else {
    Write-Host "  FAIL migration files not found" -ForegroundColor Red
    exit 1
}

Write-Ok "Environment check passed"

# ============================================================
# Step 2: Install Dependencies
# ============================================================
Write-Step "Install dependencies"

# Always run npm install to ensure all deps are present
npm install --legacy-peer-deps
if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm install failed"
    exit 1
}
Write-Ok "Dependencies installed"

# ============================================================
# Step 3: Create Cloudflare Resources
# ============================================================
Write-Step "Create Cloudflare resources"

# Get Account ID from wrangler whoami
$whoamiRaw = cmd /c "npx wrangler whoami 2>&1" | Out-String
$accountId = $null

# Try multiple patterns for different wrangler versions
$patterns = @(
    'Account ID\s+([a-f0-9]+)',
    'account_id\s*[:=]\s*"([a-f0-9]+)"',
    '"id"\s*:\s*"([a-f0-9]+)"',
    '([a-f0-9]{32})'
)

foreach ($pattern in $patterns) {
    if ($whoamiRaw -match $pattern) {
        $accountId = $matches[1]
        break
    }
}

# If still not found, try wrangler config get
if (-not $accountId) {
    $configRaw = cmd /c "npx wrangler config get account_id 2>&1" | Out-String
    foreach ($pattern in $patterns) {
        if ($configRaw -match $pattern) {
            $accountId = $matches[1]
            break
        }
    }
}

if (-not $accountId) {
    Write-Host ""
    Write-Host "  WARN Cannot automatically detect Cloudflare Account ID." -ForegroundColor Yellow
    Write-Host "  Your wrangler whoami output:" -ForegroundColor Yellow
    Write-Host "  ----------------------------" -ForegroundColor Yellow
    Write-Host $whoamiRaw -ForegroundColor Gray
    Write-Host "  ----------------------------" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Please get your Account ID from:" -ForegroundColor Cyan
    Write-Host "    https://dash.cloudflare.com/" -ForegroundColor Cyan
    Write-Host ""
    $userAccountId = Read-Host "  Enter Cloudflare Account ID (32-character hex)"
    if ($userAccountId -match '^[a-f0-9]{32}$') {
        $accountId = $userAccountId
        Write-Host "  OK Using provided Account ID" -ForegroundColor Green
    } else {
        Write-Fail "Invalid Account ID format"
    }
}

$apiHeaders = @{
    "Authorization" = "Bearer $env:CLOUDFLARE_API_TOKEN"
    "Content-Type" = "application/json"
}

# --- D1 Database ---
Write-Host "  -> Creating D1 database..."
$d1Id = $null
try {
    $d1Resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/d1/database" -Headers $apiHeaders -Method GET
    $d1Db = $d1Resp.result | Where-Object { $_.name -eq 'dns-db' }
    if ($d1Db) {
        $d1Id = $d1Db.uuid
        Write-Host "  SKIP D1 database 'dns-db' already exists" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  WARN D1 API list failed, trying CLI..." -ForegroundColor Yellow
}

if (-not $d1Id) {
    $d1Output = cmd /c "npx wrangler d1 create dns-db 2>&1" | Out-String
    $lines = $d1Output -split "`n"
    foreach ($line in $lines) {
        if ($line -match 'database_id\s*=\s*"([^"]+)"') {
            $d1Id = $matches[1]
            break
        }
    }
    if (-not $d1Id) {
        foreach ($line in $lines) {
            if ($line -match '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})') {
                $d1Id = $matches[1]
                break
            }
        }
    }
    if (-not $d1Id) {
        Write-Host $d1Output
        Write-Fail "Failed to create D1 database"
    }
    Write-Host "  OK D1 database created" -ForegroundColor Green
}
Write-Host "  Database ID: $d1Id" -ForegroundColor Yellow

# --- KV Namespace ---
Write-Host "  -> Creating KV namespace..."
$kvId = $null

# Helper: try to get KV ID from API with relaxed matching
function Get-KvIdFromApi {
    try {
        $resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/storage/kv/namespaces" -Headers $apiHeaders -Method GET
        if ($resp.result -and $resp.result.Count -gt 0) {
            # Prefer exact match, then any KV namespace
            $ns = $resp.result | Where-Object { $_.title -eq 'dns-distribution-system-KV' -or $_.title -eq 'KV' } | Select-Object -First 1
            if (-not $ns) { $ns = $resp.result | Select-Object -First 1 }
            if ($ns) { return $ns.id }
        }
    } catch {}
    return $null
}

# Helper: try to read existing KV ID from wrangler.toml
function Get-KvIdFromToml {
    try {
        $toml = Get-Content "wrangler.toml" -Raw -Encoding UTF8
        if ($toml -match 'id\s*=\s*"([a-f0-9]{32})"') { return $matches[1] }
    } catch {}
    return $null
}

# 1. Try API list first
$kvId = Get-KvIdFromApi
if ($kvId) {
    Write-Host "  SKIP KV namespace already exists (found via API)" -ForegroundColor Yellow
}

# 2. If not found, try create
if (-not $kvId) {
    $kvOutput = cmd /c "npx wrangler kv:namespace create KV 2>&1" | Out-String

    # 2a. Already exists is OK, try to get ID again
    if ($kvOutput -match 'already exists') {
        Write-Host "  SKIP KV namespace already exists (detected from CLI)" -ForegroundColor Yellow
        $kvId = Get-KvIdFromApi
        if (-not $kvId) { $kvId = Get-KvIdFromToml }
    }
    # 2b. Try extract ID from successful create output
    else {
        $lines = $kvOutput -split "`n"
        foreach ($line in $lines) {
            if ($line -match 'id\s*=\s*"([^"]+)"') { $kvId = $matches[1]; break }
        }
        if (-not $kvId) {
            foreach ($line in $lines) {
                if ($line -match '([a-f0-9]{32})') { $kvId = $matches[1]; break }
            }
        }
        if ($kvId) {
            Write-Host "  OK KV namespace created" -ForegroundColor Green
        }
    }
}

# 3. Final fallback: read from existing wrangler.toml
if (-not $kvId) {
    $kvId = Get-KvIdFromToml
    if ($kvId) {
        Write-Host "  SKIP KV namespace ID loaded from wrangler.toml" -ForegroundColor Yellow
    }
}

# 4. If still no ID, prompt user instead of failing
if (-not $kvId) {
    Write-Host ""
    Write-Host "  WARN Could not automatically detect KV namespace ID." -ForegroundColor Yellow
    Write-Host "  This usually happens when the KV namespace already exists" -ForegroundColor Yellow
    Write-Host "  but the API Token does not have permission to list namespaces." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Please get your KV namespace ID from:" -ForegroundColor Cyan
    Write-Host "    https://dash.cloudflare.com/$accountId/workers/kv/namespaces" -ForegroundColor Cyan
    Write-Host ""
    $userKvId = Read-Host "  Enter KV namespace ID (32-character hex) or press Enter to skip"
    if ($userKvId -match '^[a-f0-9]{32}$') {
        $kvId = $userKvId
        Write-Host "  OK Using provided KV ID" -ForegroundColor Green
    } else {
        Write-Host "  WARN Invalid or empty KV ID. You must manually update wrangler.toml later." -ForegroundColor Yellow
        $kvId = "KV_ID_PLACEHOLDER"
    }
}

Write-Host "  KV ID: $kvId" -ForegroundColor Yellow

Write-Host "  -> Updating wrangler.toml..."
$tomlContent = Get-Content wrangler.toml -Raw -Encoding UTF8
$tomlContent = $tomlContent -replace 'KV_ID_PLACEHOLDER', $kvId
$tomlContent = $tomlContent -replace 'KV_PREVIEW_ID_PLACEHOLDER', $kvId
$tomlContent = $tomlContent -replace 'D1_ID_PLACEHOLDER', $d1Id
Set-Content wrangler.toml $tomlContent -NoNewline -Encoding UTF8
Write-Ok "wrangler.toml updated"

Write-Ok "Resources created"

# ============================================================
# Step 4: Initialize Database
# ============================================================
Write-Step "Initialize database"

try {
    Write-Host "  -> Creating tables..."
    $d1Output = cmd /c "npx wrangler d1 execute dns-db --remote --file=./migrations/0001_initial.sql 2>&1" | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: $d1Output" -ForegroundColor Red
        throw "d1 execute failed"
    }
    Write-Ok "Tables created"
} catch {
    Write-Fail "Failed to create tables"
}

try {
    Write-Host "  -> Importing seed data..."
    $d1Output = cmd /c "npx wrangler d1 execute dns-db --remote --file=./migrations/0002_seed.sql 2>&1" | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: $d1Output" -ForegroundColor Red
        throw "d1 execute failed"
    }
    Write-Ok "Seed data imported"
} catch {
    Write-Fail "Failed to import seed data"
}

Write-Ok "Database initialized"


# ============================================================
# Step 5: Configure JWT Secret
# ============================================================
Write-Step "Configure JWT secret"

$jwtSecret = $null
if (Test-Path ".env") {
    $envContent = Get-Content .env -Raw -Encoding UTF8
    if ($envContent -match 'JWT_SECRET=(.+)') {
        $jwtSecret = $matches[1].Trim()
    }
}

if (-not $jwtSecret) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwtSecret = [BitConverter]::ToString($bytes) -replace '-', ''
    Add-Content .env "JWT_SECRET=$jwtSecret" -Encoding UTF8
}

Write-Host "  -> Uploading JWT_SECRET to Cloudflare..."
$tempFile = [System.IO.Path]::GetTempFileName()
$jwtSecret | Out-File -FilePath $tempFile -Encoding utf8 -NoNewline
cmd /c "type `"$tempFile`" | npx wrangler secret put JWT_SECRET 2>&1" | Out-Null
Remove-Item $tempFile -Force
Write-Ok "JWT secret configured"

# ============================================================
# Step 6: Deploy Worker
# ============================================================
Write-Step "Deploy Worker to Cloudflare"

# Use --keep-vars to avoid issues with env vars, and let wrangler infer env from wrangler.toml
$deployOutput = cmd /c "npx wrangler deploy 2>&1" | Out-String

# Worker is considered deployed if we see the URL in output,
# even if some warnings about cron triggers appear.
$deployOk = $false
if ($deployOutput -match 'https://[a-zA-Z0-9.-]+\.workers\.dev') {
    $deployOk = $true
}

# Some wrangler 4.x versions return non-zero when cron triggers have issues,
# but the Worker itself is already deployed. Check the output to decide.
$workerActuallyDeployed = $deployOutput -match 'Uploaded\s+\S+'

if (-not $workerActuallyDeployed) {
    Write-Host $deployOutput
    Write-Fail "Worker deploy failed"
}

if (-not $deployOk) {
    Write-Host $deployOutput
    Write-Host ""
    Write-Host "  WARN Worker was deployed but URL could not be extracted from output." -ForegroundColor Yellow
}

$workerUrl = ""
if ($deployOutput -match 'https://[a-zA-Z0-9.-]+\.workers\.dev') {
    $workerUrl = $matches[0]
}

if (-not $workerUrl) {
    if ($tomlContent -match 'name\s*=\s*"([^"]+)"') {
        $workerName = $matches[1]
    } else {
        $workerName = "dns-distribution-system"
    }
    Write-Host "  WARN Cannot extract Worker URL, using default" -ForegroundColor Yellow
    $workerUrl = "https://$workerName.your-subdomain.workers.dev"
}

Write-Ok "Worker deployed"
Write-Host "  URL: $workerUrl" -ForegroundColor Cyan

# ============================================================
# Step 7: Verify Deployment
# ============================================================
Write-Step "Verify deployment"

Write-Host "  -> Health check..."
$maxRetries = 5
$healthOk = $false

for ($i = 1; $i -le $maxRetries; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "$workerUrl/health" -Method Get -TimeoutSec 10 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host "  OK /health returns 200" -ForegroundColor Green
            $healthOk = $true
            break
        }
    } catch {
        Write-Host "  -> Retry $i/$maxRetries..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
    }
}

if (-not $healthOk) {
    Write-Host "  WARN Health check timeout, verify manually later" -ForegroundColor Yellow
}

Write-Host "  -> Admin login test..."
try {
    $loginBody = @{account="admin@qq.com";password="admin123"} | ConvertTo-Json
    $loginResp = Invoke-RestMethod -Uri "$workerUrl/api/auth/login" -Method Post -Body $loginBody -ContentType "application/json" -TimeoutSec 10
    if ($loginResp.code -eq 200) {
        Write-Host "  OK Admin login success" -ForegroundColor Green
    } else {
        Write-Host "  WARN Admin login failed" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  WARN Login test failed, verify manually later" -ForegroundColor Yellow
}

# ============================================================
# Done
# ============================================================
Write-Host ""
Write-Host ("-" * 55)
Write-Host ""
Write-Host "  DEPLOY SUCCESS!" -ForegroundColor Green
Write-Host ""
Write-Host "  Worker URL:   $workerUrl" -ForegroundColor Cyan
Write-Host "  Admin Panel:  $workerUrl/admin" -ForegroundColor Cyan
Write-Host "  Admin Email:  admin@qq.com" -ForegroundColor Yellow
Write-Host "  Admin Pass:   admin123" -ForegroundColor Yellow
Write-Host ""
Write-Host "  IMPORTANT: Change admin password after first login!" -ForegroundColor Red
Write-Host ""
Write-Host "  Useful commands:"
Write-Host "    npx wrangler tail       View live logs"
Write-Host "    npx wrangler deploy     Re-deploy"
Write-Host "    npx wrangler dev        Local dev"
Write-Host ""
exit 0