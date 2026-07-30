<#
.SYNOPSIS
    Bring up Bedrock locally on Windows: backend on :8000, frontend on :4200.

.DESCRIPTION
    Checks prerequisites, authenticates gcloud, pulls DATABASE_URL from Secret
    Manager, writes .env, mints a local login cookie, starts both servers in
    their own windows, and opens the Job Scan tab.

    Run from the repo's financial_forecasting directory:

        .\scripts\dev-up.ps1                 # real DB, real Bedrock data
        .\scripts\dev-up.ps1 -Fixtures       # + populated Job Scan tab

    -Fixtures serves the Job Scan queue from services/jobs_scan/fixtures.py so
    the tab renders before the migration creates its tables. Everything else in
    the app still reads the real database. Promotion is disabled in that mode
    rather than pretending to write.

.NOTES
    Nothing here bypasses a security control. gcloud auth is interactive on
    purpose: the secret is fetched with YOUR @pursuit.org identity, and no
    credential is written anywhere except the local .env this creates.
#>

[CmdletBinding()]
param(
    [switch]$Fixtures,
    [string]$Project = "pursuit-ops",
    [string]$Secret  = "jobs-dev-database-url",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`n  [x] $msg" -ForegroundColor Red; exit 1 }

# --- 0. Location ------------------------------------------------------------
if (-not (Test-Path "main.py") -or -not (Test-Path "frontend-v2")) {
    Die @"
Run this from the financial_forecasting directory.

    git clone https://github.com/Pursuit-Assets/bedrock
    cd bedrock\financial_forecasting
    .\scripts\dev-up.ps1
"@
}

# --- 1. Prerequisites -------------------------------------------------------
Step "Checking prerequisites"

# On Windows the launcher is `python`; `python3` hits a Microsoft Store shim
# that prints an install message and exits without running anything.
$py = $null
foreach ($cand in @("python", "py")) {
    $exe = Get-Command $cand -ErrorAction SilentlyContinue
    if ($exe) {
        $v = & $cand --version 2>&1
        if ($v -match "Python 3\.(\d+)") {
            if ([int]$Matches[1] -ge 10) { $py = $cand; Ok "$cand -> $v"; break }
            else { Warn "$cand is $v; need 3.10+" }
        }
    }
}
if (-not $py) {
    Die "No usable Python 3.10+. Install from python.org (tick 'Add to PATH'), then reopen PowerShell."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js not found. Install the LTS build from nodejs.org, then reopen PowerShell."
}
Ok "node -> $(node --version)"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Die "gcloud not found. Install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install, then reopen PowerShell."
}
Ok "gcloud present"

# --- 2. Google Cloud auth ---------------------------------------------------
Step "Google Cloud authentication"

$active = (& gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null | Select-Object -First 1)
if (-not $active) {
    Warn "Not signed in — a browser window will open. Use your @pursuit.org account."
    & gcloud auth login
    $active = (& gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null | Select-Object -First 1)
}
if (-not $active) { Die "gcloud sign-in did not complete." }
Ok "signed in as $active"
if ($active -notlike "*@pursuit.org") {
    Warn "$active is not a @pursuit.org account; the secret fetch will likely be denied."
}

& gcloud config set project $Project 2>$null | Out-Null
Ok "project set to $Project"

# --- 3. Secret -> .env ------------------------------------------------------
Step "Building .env"

Write-Host "  fetching $Secret ..."
$dbUrl = (& gcloud secrets versions access latest --secret=$Secret --project=$Project 2>&1)
if ($LASTEXITCODE -ne 0 -or -not $dbUrl -or $dbUrl -match "ERROR:") {
    Die @"
Could not read secret '$Secret'.

  $dbUrl

Ask Jac (jac@pursuit.org) for Secret Manager access, or whether the secret was
rotated to a new name. Everything else above succeeded.
"@
}
$dbUrl = $dbUrl.Trim()
Ok "DATABASE_URL retrieved ($($dbUrl.Length) chars, not shown)"

# Local-only throwaways. The JWT secret just has to match between the backend
# and the cookie minted below.
$jwtSecret = -join ((1..32) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })
$internalKey = -join ((1..24) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })

if (Test-Path ".env") {
    Copy-Item ".env" ".env.backup" -Force
    Warn "existing .env backed up to .env.backup"
}

$envLines = @(
    "DATABASE_URL=$dbUrl",
    "JWT_SECRET_KEY=$jwtSecret",
    "FRONTEND_URL=http://localhost:4200",
    "BEDROCK_INTERNAL_API_KEY=$internalKey"
)
if ($Fixtures) { $envLines += "JOBS_SCAN_FIXTURES=1" }
Set-Content -Path ".env" -Value ($envLines -join "`n") -Encoding utf8 -NoNewline
Ok ".env written$(if ($Fixtures) { ' (fixture mode ON)' })"

# --- 4. Dependencies -------------------------------------------------------
if (-not $SkipInstall) {
    Step "Installing dependencies (first run is the slow one)"
    & $py -m pip install --quiet --disable-pip-version-check -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Die "pip install failed. Scroll up for the reason." }
    Ok "python packages"

    Push-Location frontend-v2
    & npm install --no-audit --no-fund
    $npmOk = ($LASTEXITCODE -eq 0)
    Pop-Location
    if (-not $npmOk) { Die "npm install failed." }
    Ok "npm packages"
} else {
    Warn "skipping installs (-SkipInstall)"
}

# --- 5. Login cookie -------------------------------------------------------
Step "Minting a local login token"

$tokenScript = @"
import os, sys
sys.path.insert(0, os.getcwd())
os.environ.setdefault('JWT_SECRET_KEY', '$jwtSecret')
try:
    import auth
    print(auth.create_access_token({'email': '$active', 'role': 'admin'}))
except Exception as exc:
    print('TOKEN_ERROR: %s' % exc)
"@
$token = (& $py -c $tokenScript 2>&1 | Select-Object -Last 1)

if ($token -like "TOKEN_ERROR*") {
    Warn "could not mint a token automatically: $token"
    Warn "the app will load but redirect to login; ask me for the manual step."
    $token = $null
} else {
    Ok "token minted for $active"
}

# --- 6. Start servers ------------------------------------------------------
Step "Starting servers"

$root = (Get-Location).Path
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$root'; Write-Host 'BACKEND :8000' -ForegroundColor Cyan; & $py main.py"
)
Ok "backend starting in its own window (:8000)"

Start-Sleep -Seconds 6

Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$root\frontend-v2'; Write-Host 'FRONTEND :4200' -ForegroundColor Cyan; npm run dev"
)
Ok "frontend starting in its own window (:4200)"

Write-Host "`n  waiting for the frontend to answer ..." -NoNewline
$up = $false
foreach ($i in 1..40) {
    Start-Sleep -Seconds 2
    try {
        Invoke-WebRequest "http://localhost:4200" -UseBasicParsing -TimeoutSec 3 | Out-Null
        $up = $true; break
    } catch { Write-Host "." -NoNewline }
}
Write-Host ""
if ($up) { Ok "frontend is up" } else { Warn "frontend did not answer yet — check its window" }

# --- 7. Open the browser ---------------------------------------------------
Step "Opening the Job Scan tab"

if ($token) {
    # Open the app first, then set the cookie from that origin. A cookie written
    # from a file:// page would not apply to localhost.
    Start-Process "http://localhost:4200/jobs?view=scan"
    Write-Host @"

  If Bedrock shows a login screen, open devtools (F12) on
  http://localhost:4200, paste this into the Console, and reload:

      document.cookie = "access_token=$token; path=/; SameSite=Lax";

"@ -ForegroundColor Yellow
} else {
    Start-Process "http://localhost:4200/jobs?view=scan"
}

Write-Host @"

  Running.
    backend    http://localhost:8000/docs
    frontend   http://localhost:4200/jobs?view=scan

  Two PowerShell windows are now serving those. Close them to stop.
  This is the real production database — writes are real. Read freely;
  think before you click anything that saves.
"@ -ForegroundColor Green

if ($Fixtures) {
    Write-Host @"
  Fixture mode is ON: the Job Scan queue is 15 real postings served from
  memory, because bedrock.scraped_job_posting does not exist yet. Promotion
  buttons will return a clear 'preview mode' error by design. Every other tab
  shows real data.
"@ -ForegroundColor Yellow
}
