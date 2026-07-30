# Bring up Bedrock locally on Windows: backend :8000, frontend :4200.
#
# Run from the repo's financial_forecasting directory:
#     .\scripts\dev-up.ps1              real DB, real Bedrock data
#     .\scripts\dev-up.ps1 -Fixtures    + populated Job Scan tab
#
# -Fixtures serves the Job Scan queue from services/jobs_scan/fixtures.py so the
# tab renders before the migration creates its tables. Every other tab still
# reads the real database. Promotion is disabled in that mode rather than
# pretending to write.
#
# Deliberately written for Windows PowerShell 5.1: no here-strings and no
# nested subexpressions in strings, both of which 5.1 parses badly in a file
# with LF line endings. Keep it that way.
#
# Nothing here bypasses a security control. gcloud auth is interactive on
# purpose: the secret is fetched with YOUR @pursuit.org identity, and no
# credential is written anywhere except the local .env this creates.

[CmdletBinding()]
param(
    [switch]$Fixtures,
    [switch]$SkipInstall,
    [string]$Project = "pursuit-ops",
    [string]$Secret  = "jobs-dev-database-url"
)

$ErrorActionPreference = "Stop"

# .NET file APIs below resolve relative paths against the process working
# directory, not PowerShell's location, so anchor them explicitly.
$root0 = (Get-Location).Path

function Step($m) { Write-Host ""; Write-Host ("=== " + $m) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ("  [ok] " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host ("  [x] " + $m) -ForegroundColor Red; exit 1 }

# --- 0. Location ------------------------------------------------------------
if (-not (Test-Path "main.py") -or -not (Test-Path "frontend-v2")) {
    Write-Host "Run this from the financial_forecasting directory:" -ForegroundColor Red
    Write-Host "    cd ~\bedrock\financial_forecasting"
    Write-Host "    .\scripts\dev-up.ps1 -Fixtures"
    exit 1
}

# --- 1. Prerequisites -------------------------------------------------------
Step "Checking prerequisites"

# On Windows the launcher is 'python'. 'python3' hits a Microsoft Store shim
# that prints an install message and exits without running anything.
$py = $null
foreach ($cand in @("python", "py")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) {
        $v = (& $cand --version 2>&1 | Out-String).Trim()
        if ($v -match "Python 3\.(\d+)") {
            if ([int]$Matches[1] -ge 10) {
                $py = $cand
                Ok ($cand + " -> " + $v)
                break
            }
            Warn ($cand + " is " + $v + "; need 3.10 or newer")
        }
    }
}
if (-not $py) {
    Fail "No usable Python 3.10+. Install from python.org, tick 'Add python.exe to PATH', then reopen PowerShell."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js not found. Install the LTS build from nodejs.org, then reopen PowerShell."
}
Ok ("node -> " + (& node --version))

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Fail "gcloud not found. Install from https://cloud.google.com/sdk/docs/install then reopen PowerShell."
}
Ok "gcloud present"

# --- 2. Google Cloud auth ---------------------------------------------------
Step "Google Cloud authentication"

$active = (& gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null | Select-Object -First 1)
if (-not $active) {
    Warn "Not signed in. A browser window will open - use your @pursuit.org account."
    & gcloud auth login
    $active = (& gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null | Select-Object -First 1)
}
if (-not $active) { Fail "gcloud sign-in did not complete." }
$active = ([string]$active).Trim()
Ok ("signed in as " + $active)
if ($active -notlike "*@pursuit.org") {
    Warn ($active + " is not a @pursuit.org account; the secret fetch will probably be denied.")
}

& gcloud config set project $Project 2>$null | Out-Null
Ok ("project set to " + $Project)

# --- 3. Secret -> .env ------------------------------------------------------
Step "Building .env"

Write-Host ("  fetching secret " + $Secret + " ...")
$dbUrl = (& gcloud secrets versions access latest --secret=$Secret --project=$Project 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $dbUrl -or $dbUrl -match "ERROR:") {
    Write-Host ""
    Write-Host ("  [x] Could not read secret '" + $Secret + "'") -ForegroundColor Red
    Write-Host ("      " + $dbUrl)
    Write-Host "      Ask Jac (jac@pursuit.org) for Secret Manager access, or whether"
    Write-Host "      the secret was rotated to a new name. Everything above succeeded."
    exit 1
}
Ok ("DATABASE_URL retrieved (" + $dbUrl.Length + " chars, not printed)")

# Local-only throwaways. The JWT secret only has to match between this backend
# and the cookie minted below.
$jwtSecret   = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
$internalKey = [System.Guid]::NewGuid().ToString("N")

if (Test-Path ".env") {
    Copy-Item ".env" ".env.backup" -Force
    Warn "existing .env backed up to .env.backup"
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("DATABASE_URL=" + $dbUrl)
[void]$lines.Add("JWT_SECRET_KEY=" + $jwtSecret)
[void]$lines.Add("FRONTEND_URL=http://localhost:4200")
[void]$lines.Add("BEDROCK_INTERNAL_API_KEY=" + $internalKey)
if ($Fixtures) { [void]$lines.Add("JOBS_SCAN_FIXTURES=1") }
# 5.1's -Encoding utf8 writes a BOM, which would corrupt the first key and make
# DATABASE_URL unreadable to the app. Write UTF-8 without one, explicitly.
$noBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $root0 ".env"), [string[]]$lines, $noBom)

if ($Fixtures) { Ok ".env written (fixture mode ON)" } else { Ok ".env written" }

# --- 4. Dependencies -------------------------------------------------------
if ($SkipInstall) {
    Warn "skipping installs (-SkipInstall)"
} else {
    Step "Installing dependencies - first run takes a few minutes"

    & $py -m pip install --quiet --disable-pip-version-check -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed. Scroll up for the reason." }
    Ok "python packages"

    Push-Location frontend-v2
    & npm install --no-audit --no-fund
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -ne 0) { Fail "npm install failed. Scroll up for the reason." }
    Ok "npm packages"
}

# --- 5. Login cookie -------------------------------------------------------
Step "Minting a local login token"

$tokenPy = Join-Path $env:TEMP "bedrock_token.py"
$pyLines = New-Object System.Collections.ArrayList
[void]$pyLines.Add("import os, sys")
[void]$pyLines.Add("sys.path.insert(0, os.getcwd())")
[void]$pyLines.Add("os.environ['JWT_SECRET_KEY'] = '" + $jwtSecret + "'")
[void]$pyLines.Add("try:")
[void]$pyLines.Add("    import auth")
[void]$pyLines.Add("    print(auth.create_access_token({'email': '" + $active + "', 'role': 'admin'}))")
[void]$pyLines.Add("except Exception as exc:")
[void]$pyLines.Add("    print('TOKEN_ERROR: %s' % exc)")
$noBom2 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($tokenPy, [string[]]$pyLines, $noBom2)

$token = (& $py $tokenPy 2>&1 | Select-Object -Last 1)
$token = ([string]$token).Trim()
Remove-Item $tokenPy -Force -ErrorAction SilentlyContinue

if ($token -like "TOKEN_ERROR*" -or -not $token) {
    Warn ("could not mint a token automatically: " + $token)
    $token = $null
} else {
    Ok ("token minted for " + $active)
}

# --- 6. Start servers ------------------------------------------------------
Step "Starting servers"

$root = (Get-Location).Path
$feDir = Join-Path $root "frontend-v2"

Start-Process powershell -ArgumentList @("-NoExit", "-Command",
    ("Set-Location '" + $root + "'; Write-Host 'BACKEND :8000' -ForegroundColor Cyan; & " + $py + " main.py"))
Ok "backend starting in its own window (:8000)"

Start-Sleep -Seconds 6

Start-Process powershell -ArgumentList @("-NoExit", "-Command",
    ("Set-Location '" + $feDir + "'; Write-Host 'FRONTEND :4200' -ForegroundColor Cyan; npm run dev"))
Ok "frontend starting in its own window (:4200)"

Write-Host ""
Write-Host "  waiting for the frontend to answer ..." -NoNewline
$up = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try {
        Invoke-WebRequest "http://localhost:4200" -UseBasicParsing -TimeoutSec 3 | Out-Null
        $up = $true
        break
    } catch {
        Write-Host "." -NoNewline
    }
}
Write-Host ""
if ($up) { Ok "frontend is up" } else { Warn "frontend has not answered yet - check its window" }

# --- 7. Open the browser ---------------------------------------------------
Step "Opening the Job Scan tab"
Start-Process "http://localhost:4200/jobs?view=scan"

Write-Host ""
Write-Host "  Running." -ForegroundColor Green
Write-Host "    backend    http://localhost:8000/docs"
Write-Host "    frontend   http://localhost:4200/jobs?view=scan"
Write-Host ""
Write-Host "  Two PowerShell windows are serving those. Close them to stop."
Write-Host "  This points at the REAL production database - reading is free," -ForegroundColor Yellow
Write-Host "  but think before clicking anything that saves." -ForegroundColor Yellow

if ($token) {
    Write-Host ""
    Write-Host "  If Bedrock shows a login screen: press F12 on localhost:4200," -ForegroundColor Yellow
    Write-Host "  paste this into the Console, and reload." -ForegroundColor Yellow
    Write-Host ""
    Write-Host ('      document.cookie = "access_token=' + $token + '; path=/; SameSite=Lax";')
    Write-Host ""
}

if ($Fixtures) {
    Write-Host ""
    Write-Host "  Fixture mode is ON: the Job Scan queue is 15 real postings served" -ForegroundColor Yellow
    Write-Host "  from memory, because bedrock.scraped_job_posting does not exist yet." -ForegroundColor Yellow
    Write-Host "  The Pathfinder and Opportunity buttons return a clear 'preview mode'" -ForegroundColor Yellow
    Write-Host "  error by design. Every other tab shows real data." -ForegroundColor Yellow
}
