param(
  [string]$TargetTriple = "x86_64-pc-windows-msvc",
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$GatewayDir = Join-Path $Root "gateway"
$SwitchDistDir = Join-Path $GatewayDir "internal\server\switch_dist"
$TauriDir = Join-Path $Root "src-tauri"
$BinDir = Join-Path $TauriDir "binaries"
$SidecarOut = Join-Path $BinDir "codearts-gateway-$TargetTriple.exe"

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $Hint"
  }
}

Write-Host "=== CodeArts Switch: Tauri v2 Windows Desktop Build ===" -ForegroundColor Cyan
Require-Command "node" "Install Node.js 20+ from https://nodejs.org/"
Require-Command "npm" "Install Node.js 20+ from https://nodejs.org/"
Require-Command "go" "Install Go 1.24+ from https://go.dev/dl/"
Require-Command "cargo" "Install Rust toolchain from https://rustup.rs/ and reopen terminal"

if (-not (Test-Path (Join-Path $GatewayDir "go.mod"))) {
  throw "gateway/go.mod not found. Ensure repository files are complete."
}

Write-Host ""
Write-Host "[1/4] Building React UI and embedding into gateway/internal/server/switch_dist/ ..." -ForegroundColor Cyan
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
Write-Host "[2/4] Building windowless Go gateway sidecar -> $SidecarOut ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Push-Location $GatewayDir
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "windows"
  $env:GOARCH = if ($TargetTriple -like "aarch64*") { "arm64" } else { "amd64" }
  go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=1.0.0" -o $SidecarOut .
  if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path $SidecarOut)) {
  throw "Go sidecar binary not found at $SidecarOut"
}
$SidecarSizeMB = [Math]::Round((Get-Item $SidecarOut).Length / 1MB, 2)
Write-Host "Go sidecar built successfully ($SidecarSizeMB MB)." -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] Checking Tauri desktop icon assets..." -ForegroundColor Cyan
$RequiredIcons = @("32x32.png", "128x128.png", "128x128@2x.png", "icon.ico", "icon.png")
foreach ($Icon in $RequiredIcons) {
  $IconPath = Join-Path $TauriDir "icons\$Icon"
  if (-not (Test-Path $IconPath)) {
    throw "Missing Tauri icon asset: $IconPath"
  }
}

Write-Host ""
Write-Host "[4/4] Building Windows NSIS + MSI installers via Tauri v2 CLI..." -ForegroundColor Cyan
Push-Location $Root
try {
  npx --yes @tauri-apps/cli@2 build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Build complete! Output artifacts:" -ForegroundColor Green
Write-Host "  NSIS Installer : $TauriDir\target\release\bundle\nsis\" -ForegroundColor White
Write-Host "  MSI  Installer : $TauriDir\target\release\bundle\msi\" -ForegroundColor White
Write-Host "  Standalone EXE : $TauriDir\target\release\codearts-switch.exe" -ForegroundColor White
