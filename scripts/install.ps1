# Set up Ren'Py Writer on Windows.
#
# Written for somebody who has never opened a terminal. It asks for nothing,
# installs nothing system-wide, needs no administrator rights, and puts
# everything it downloads inside this folder. Deleting the folder removes it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($text) { Write-Host "  $text" }
function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ""
  Write-Host "Setup stopped: $text" -ForegroundColor Red
  Write-Host ""
  Write-Host "Nothing was installed outside this folder."
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "Ren'Py Writer setup" -ForegroundColor White
Write-Host "This takes a few minutes and needs an internet connection."

# --------------------------------------------------------------- node
# Ren'Py Writer runs on a program called Node. Rather than install it on the
# machine -- which needs administrator rights and changes settings outside this
# folder -- a copy is kept here, used only by this app.
$nodeDir = Join-Path $root '.node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'

if (Test-Path $nodeExe) {
  Step "Checking what is already here"
  Say "Found the copy from last time."
} else {
  Step "Downloading the parts Ren'Py Writer needs"
  Say "This is about 30 MB and goes into a folder called .node here."

  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  } catch {
    Fail "Could not reach nodejs.org. Check your internet connection and try again."
  }
  $release = $index | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1
  if (-not $release) { Fail "Could not work out which version to download." }

  $version = $release.version
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $name = "node-$version-win-$arch"
  $zip = Join-Path $env:TEMP "$name.zip"

  Say "Version $version"
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip -TimeoutSec 600 -UseBasicParsing
  } catch {
    Fail "The download did not finish. Check your internet connection and try again."
  }

  # Checked against the list nodejs.org publishes, so a partial or altered
  # download is caught here rather than becoming a puzzling failure later.
  Step "Checking the download is intact"
  try {
    # -UseBasicParsing: without it, Windows PowerShell tries to parse the
    # response with Internet Explorer's engine, which fails on machines where
    # IE was never set up.
    $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" `
      -TimeoutSec 60 -UseBasicParsing).Content
  } catch {
    Fail "Could not fetch the checksum list from nodejs.org."
  }
  $expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape("$name.zip") } |
    Select-Object -First 1) -split '\s+' | Select-Object -First 1
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $actual -ne $expected.ToLower()) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Fail "The download did not match its checksum, so it was deleted. Try again."
  }
  Say "Good."

  Step "Unpacking"
  $staging = Join-Path $env:TEMP "renpywriter-node-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -Path $zip -DestinationPath $staging -Force
  Move-Item -Path (Join-Path $staging $name) -Destination $nodeDir
  Remove-Item $zip, $staging -Recurse -Force -ErrorAction SilentlyContinue
}

$env:Path = "$nodeDir;$env:Path"

# --------------------------------------------------------------- app
Step "Installing Ren'Py Writer"
Say "This is the long part. A few minutes is normal."
& $npmCmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "Installing did not finish. Running setup again is safe." }

Step "Building"
& $npmCmd run build
if ($LASTEXITCODE -ne 0) { Fail "The build did not finish. Running setup again is safe." }

# --------------------------------------------------------------- launcher
Step "Making a shortcut"
$launcher = Join-Path $root "Ren'Py Writer.cmd"
@"
@echo off
rem Starts Ren'Py Writer. Made by setup; safe to delete and remake.
cd /d "%~dp0"
set "PATH=%~dp0.node;%PATH%"
start "" "%~dp0.node\npm.cmd" start
"@ | Set-Content -Path $launcher -Encoding ASCII

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Ren'Py Writer.lnk"
if (Test-Path $shortcutPath) {
  Say "There is already one on your desktop, so it was left alone."
  Say "It may point at a different copy: this one is at $root"
} else {
  try {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcher
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "Ren'Py Writer"
    $shortcut.Save()
    Say "Put one on your desktop."
  } catch {
    Say "Could not put one on your desktop, which is fine."
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "  Open Ren'Py Writer with the shortcut on your desktop, or by"
Write-Host "  double-clicking `"Ren'Py Writer.cmd`" in this folder."
Write-Host ""
Read-Host "Press Enter to close"
