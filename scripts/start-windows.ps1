# Botni Windows'da bitta buyruq bilan ishga tushiradi:
#   npm run win
# Tekshiradi: Node versiyasi, .env, kod yangiligi, cloudflared (yo'q bo'lsa o'rnatadi),
# npm paketlari. Keyin cloudflared tunnelini fonda ochadi, Meta uchun callback
# URL'ni chiqaradi va botni ishga tushiradi. Loglar: dev.log, tunnel.log
# (ikkalasi ham .gitignore'da, commit qilinmaydi).

$ErrorActionPreference = 'Stop'
# Node chiqishidagi emoji/harflar buzilmasligi uchun (masalan "Γ¥î" o'rniga "❌")
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) {
  Write-Host ""
  Write-Host "XATO: $msg" -ForegroundColor Red
  exit 1
}
function Ok($msg) { Write-Host "[ok] $msg" -ForegroundColor Green }

# 1. Node >= 22.18 (bot .ts fayllarni to'g'ridan-to'g'ri ishga tushiradi)
try { $nodeVer = (node -v).TrimStart('v') } catch { Fail "Node.js topilmadi. nodejs.org dan 22 LTS yoki yangisini o'rnating." }
if ([version]$nodeVer -lt [version]'22.18.0') { Fail "Node $nodeVer eski. Kamida 22.18.0 kerak." }
Ok "Node $nodeVer"

# 2. .env
if (-not (Test-Path '.env')) { Fail ".env topilmadi. .env.example dan nusxa oling va to'ldiring: Copy-Item .env.example .env" }
Ok ".env bor"

# 3. Kod yangimi (eski versiyada AUDD_API_TOKEN majburiy edi)
if (Select-String -Path 'src\config\env.ts' -Pattern "AUDD_API_TOKEN: z.string\(\).min\(1\)" -Quiet) {
  Fail "Kod ESKI versiya. GitHub'dan yangi main'ni yuklab, papka ustiga yozing (.env saqlanib qoladi)."
}
Ok "Kod yangi versiya"

# 4. cloudflared
function Find-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe",
                   "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
                   "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}
$cf = Find-Cloudflared
if (-not $cf) {
  Write-Host "cloudflared topilmadi - winget orqali o'rnatilmoqda..." -ForegroundColor Yellow
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements | Out-Host
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $cf = Find-Cloudflared
  if (-not $cf) { Fail "cloudflared o'rnatilmadi. Qo'lda o'rnating: winget install --id Cloudflare.cloudflared, keyin terminalni qayta oching." }
}
Ok "cloudflared: $cf"

# 5. npm paketlari
if (-not (Test-Path 'node_modules') -or ((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item 'node_modules').LastWriteTime)) {
  Write-Host "npm install..." -ForegroundColor Yellow
  npm install | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "npm install muvaffaqiyatsiz." }
  (Get-Item 'node_modules').LastWriteTime = Get-Date
}
Ok "npm paketlari tayyor"

# 6. Tunnel (fonda)
$port = 3000
$portLine = Select-String -Path '.env' -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

Remove-Item 'tunnel.log', 'tunnel.out.log' -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$port") `
  -RedirectStandardError 'tunnel.log' -RedirectStandardOutput 'tunnel.out.log' -WindowStyle Hidden -PassThru

$url = $null
for ($i = 0; $i -lt 40 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  if ($tunnel.HasExited) { break }
  if (Test-Path 'tunnel.log') {
    $m = Select-String -Path 'tunnel.log' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) {
  if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  Get-Content 'tunnel.log' -Tail 20 -ErrorAction SilentlyContinue | Out-Host
  Fail "Tunnel URL olinmadi (yuqoridagi tunnel.log'ga qarang)."
}

$callback = "$url/webhook/instagram"
try { Set-Clipboard -Value $callback } catch {}
Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " Tunnel ochildi. Meta Developer -> Webhooks -> Callback URL:" -ForegroundColor Cyan
Write-Host "   $callback" -ForegroundColor White
Write-Host " (clipboard'ga nusxalandi; Verify token = .env dagi IG_WEBHOOK_VERIFY_TOKEN)" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# 7. Bot (oldinda). Ctrl+C bosilganda tunnel ham yopiladi.
try {
  cmd /c "npm run dev 2>&1" | Tee-Object -FilePath 'dev.log'
} finally {
  if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "Tunnel yopildi." -ForegroundColor Yellow
}
