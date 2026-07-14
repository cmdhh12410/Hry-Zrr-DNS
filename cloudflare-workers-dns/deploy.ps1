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
try {
    $null = npx wrangler --version 2>&1
    Write-Host "  OK wrangler CLI" -ForegroundColor Green
} catch {
    Write-Host "  FAIL wrangler not installed" -ForegroundColor Red
    Write-Host "  Run: npm install -g wrangler" -ForegroundColor Yellow
    exit 1
}

# Check wrangler login (supports both OAuth and API Token)
$loggedIn = $false
try {
    $null = npx wrangler whoami 2>&1
    $loggedIn = $true
} catch { }

if (-not $loggedIn) {
    if ($env:CLOUDFLARE_API_TOKEN) {
        $loggedIn = $true
    }
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

if (-not (Test-Path "node_modules")) {
    npm install
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "Dependencies already exist, skip"
}

# ============================================================
# Step 3: Create Cloudflare Resources
# ============================================================
Write-Step "Create Cloudflare resources"

Write-Host "  -> Creating D1 database..."
$d1Exists = $false
try {
    $d1List = npx wrangler d1 list 2>&1 | Out-String
    if ($d1List -match "dns-db") {
        $d1Exists = $true
    }
} catch { }

if ($d1Exists) {
    Write-Host "  SKIP D1 database 'dns-db' already exists" -ForegroundColor Yellow
    $d1Json = npx wrangler d1 list --json 2>&1 | Where-Object { $_ -match '^\s*[\[{]' -or $_ -match '^\s*"}?\s*$' -or $_ -match '^\s*"' } | Out-String
    try {
        $d1Data = $d1Json | ConvertFrom-Json
        $d1Db = $d1Data | Where-Object { $_.name -eq 'dns-db' }
        if ($d1Db -and $d1Db.uuid) {
            $d1Id = $d1Db.uuid
        } elseif ($d1Db -and $d1Db.database_id) {
            $d1Id = $d1Db.database_id
        } else {
            Write-Fail "D1 database 'dns-db' not found in JSON output"
        }
    } catch {
        $d1Raw = npx wrangler d1 list 2>&1 | Out-String
        $lines = $d1Raw -split "`n"
        foreach ($line in $lines) {
            if ($line -match 'dns-db' -and $line -match '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})') {
                $d1Id = $matches[1]
                break
            }
        }
        if (-not $d1Id) {
            Write-Host $d1Raw
            Write-Fail "Cannot extract D1 database_id. Output shown above."
        }
    }
} else {
    $d1Output = npx wrangler d1 create dns-db 2>&1 | Out-String
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

Write-Host "  -> Creating KV namespace..."
$kvExists = $false
$kvId = $null
try {
    $kvRawJson = npx wrangler kv:namespace list 2>&1
    $kvJson = ($kvRawJson | Where-Object { $_ -match '^\s*\[' -or $_ -match '^\s*\{' -or $_ -match '^\s*"' -or $_ -match '^\s*\]' -or $_ -match '^\s*\}' -or $_ -match '^\s*,' } | Out-String).Trim()
    try {
        $kvData = $kvJson | ConvertFrom-Json
        $kvNs = $kvData | Where-Object { $_.title -eq 'KV' -or $_.name -eq 'KV' -or $_.title -like '*-KV' -or $_.title -like '*dns-distribution*' }
        if ($kvNs) {
            $kvExists = $true
            $kvId = $kvNs[0].id
            if (-not $kvId) { $kvId = $kvNs.id }
        }
    } catch {
        $kvList = $kvRawJson | Out-String
        if ($kvList -match '"KV"' -or $kvList -match '-KV"') {
            $kvExists = $true
        }
    }
} catch { }

if ($kvExists -and $kvId) {
    Write-Host "  SKIP KV namespace already exists" -ForegroundColor Yellow
} elseif ($kvExists) {
    Write-Host "  SKIP KV namespace already exists, extracting ID..." -ForegroundColor Yellow
    try {
        $kvRawJson = npx wrangler kv:namespace list 2>&1
        $kvJson = ($kvRawJson | Where-Object { $_ -match '^\s*\[' -or $_ -match '^\s*\{' -or $_ -match '^\s*"' -or $_ -match '^\s*\]' -or $_ -match '^\s*\}' -or $_ -match '^\s*,' } | Out-String).Trim()
        $kvData = $kvJson | ConvertFrom-Json
        $kvNs = $kvData | Where-Object { $_.title -eq 'KV' -or $_.name -eq 'KV' -or $_.title -like '*-KV' -or $_.title -like '*dns-distribution*' }
        if ($kvNs -and $kvNs[0].id) {
            $kvId = $kvNs[0].id
        } elseif ($kvNs -and $kvNs.id) {
            $kvId = $kvNs.id
        } else {
            Write-Fail "KV namespace found but cannot extract ID"
        }
    } catch {
        $kvRaw = npx wrangler kv:namespace list 2>&1 | Out-String
        $lines = $kvRaw -split "`n"
        foreach ($line in $lines) {
            if ($line -match 'KV' -and $line -match '"([a-f0-9]{32,})"') {
                $kvId = $matches[1]
                break
            }
        }
        if (-not $kvId) {
            Write-Host $kvRaw
            Write-Fail "Cannot extract KV id. Output shown above."
        }
    }
} else {
    $kvOutput = npx wrangler kv:namespace create KV 2>&1 | Out-String
    $lines = $kvOutput -split "`n"
    foreach ($line in $lines) {
        if ($line -match 'id\s*=\s*"([^"]+)"') {
            $kvId = $matches[1]
            break
        }
    }
    if (-not $kvId) {
        foreach ($line in $lines) {
            if ($line -match '"([a-f0-9]{32,})"') {
                $kvId = $matches[1]
                break
            }
        }
    }
    if (-not $kvId) {
        Write-Host $kvOutput
        Write-Fail "Failed to create KV namespace"
    }
    Write-Host "  OK KV namespace created" -ForegroundColor Green
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
    npx wrangler d1 execute dns-db --remote --file=./migrations/0001_initial.sql 2>&1 | Out-Null
    Write-Ok "Tables created"
} catch {
    Write-Fail "Failed to create tables"
}

try {
    Write-Host "  -> Importing seed data..."
    npx wrangler d1 execute dns-db --remote --file=./migrations/0002_seed.sql 2>&1 | Out-Null
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
$jwtSecret | npx wrangler secret put JWT_SECRET 2>&1 | Out-Null
Write-Ok "JWT secret configured"

# ============================================================
# Step 6: Deploy Worker
# ============================================================
Write-Step "Deploy Worker to Cloudflare"

$deployOutput = npx wrangler deploy 2>&1 | Out-String

if ($LASTEXITCODE -ne 0) {
    Write-Host $deployOutput
    Write-Fail "Worker deploy failed"
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