param(
  [string]$OutFile = "dist-bin\codearts-switch.exe",
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$GatewayDir = Join-Path $Root "gateway"
$SwitchDistDir = Join-Path $GatewayDir "internal\server\switch_dist"
$ResolvedOut = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $Root $OutFile }

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $Hint"
  }
}

Write-Host "=== CodeArts Switch: Single-File Go Gateway Build (No Rust Needed) ===" -ForegroundColor Cyan
Require-Command "node" "Install Node.js 20+ from https://nodejs.org/"
Require-Command "npm" "Install Node.js 20+ from https://nodejs.org/"
Require-Command "go" "Install Go 1.24+ from https://go.dev/dl/"

Write-Host ""
Write-Host "[1/2] Building React UI and embedding into gateway/internal/server/switch_dist/ ..." -ForegroundColor Cyan
Push-Location $Root
try {
  if (-not $SkipNpmInstall -and -not (Test-Path (Join-Path $Root "node_modules"))) {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $SwitchDistDir | Out-Null
Get-ChildItem -Path $SwitchDistDir -Force | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $Root "dist\*") $SwitchDistDir
Remove-Item -Recurse -Force (Join-Path $SwitchDistDir "assets\aistudio") -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[2/2] Building standalone Go binary -> $ResolvedOut ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResolvedOut) | Out-Null
Push-Location $GatewayDir
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "windows"
  $env:GOARCH = "amd64"
  go build -trimpath -ldflags="-s -w -X main.version=1.0.0" -o $ResolvedOut .
  if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$SizeMB = [Math]::Round((Get-Item $ResolvedOut).Length / 1MB, 2)
Write-Host ""
Write-Host "Build succeeded ($SizeMB MB): $ResolvedOut" -ForegroundColor Green
Write-Host "Run the exe and open http://127.0.0.1:10087/ in your browser." -ForegroundColor White
