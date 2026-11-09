param(
  [string]$Root = ".",
  [int]$MainLimitKB = 2048,
  [int]$SubLimitKB = 2048,
  [int]$TotalLimitKB = 20480
)

$ErrorActionPreference = "Stop"
$script:fails = @()
$script:warns = @()

function Fail([string]$m) { $script:fails += $m; Write-Host ("FAIL " + $m) -ForegroundColor Red }
function Warn([string]$m) { $script:warns += $m; Write-Host ("WARN " + $m) -ForegroundColor Yellow }
function Ok([string]$m)   { Write-Host ("ok   " + $m) -ForegroundColor Green }

$Root = (Resolve-Path -LiteralPath $Root).Path
$pcPath = Join-Path $Root "project.config.json"

if (-not (Test-Path -LiteralPath $pcPath)) {
  Fail "缺少 project.config.json（不是合法的小程序项目根）"
  Write-Host ("结果: FAIL=" + $script:fails.Count + ", WARN=" + $script:warns.Count)
  exit 1
}

try {
  $cfg = Get-Content -LiteralPath $pcPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail ("project.config.json 不是合法 JSON: " + $_.Exception.Message)
  exit 1
}

$mpRel = "./"
if ($cfg.miniprogramRoot) { $mpRel = [string]$cfg.miniprogramRoot }
if (-not [string]::IsNullOrWhiteSpace($cfg.appid) -and $cfg.appid -ne "touristappid") {
  Ok ("appid: " + $cfg.appid)
}
$mp = Join-Path $Root $mpRel
if (-not (Test-Path -LiteralPath $mp)) {
  Fail ("miniprogramRoot 指向的目录不存在: " + $mpRel)
  Write-Host ("结果: FAIL=" + $script:fails.Count + ", WARN=" + $script:warns.Count)
  exit 1
}

$appJsonPath = Join-Path $mp "app.json"
if (-not (Test-Path -LiteralPath $appJsonPath)) {
  Fail "miniprogramRoot 下缺少 app.json"
  exit 1
}
try {
  $app = Get-Content -LiteralPath $appJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail ("app.json 不是合法 JSON（小程序不允许注释）: " + $_.Exception.Message)
  exit 1
}

if (Test-Path -LiteralPath (Join-Path $mp "docs")) {
  Fail "docs/ 位于 miniprogramRoot 内，会被打进包体；请把文档移到仓库根"
}

$pages = @($app.pages)
if ($pages.Count -eq 0) { Fail "app.json 的 pages 为空" }

$seen = @{}
foreach ($p in $pages) {
  if ([string]::IsNullOrWhiteSpace($p)) { Fail "app.json 的 pages 含空路径"; continue }
  if ($seen.ContainsKey($p)) { Fail ("页面重复注册: " + $p) } else { $seen[$p] = $true }
  if ($p -cmatch '[A-Z]' -or $p -match '[\u4e00-\u9fa5]') {
    Warn ("页面路径建议全小写且不含中文: " + $p)
  }
  $base = Join-Path $mp ($p -replace '/', '\')
  $need = @(".js", ".wxml")
  $opt  = @(".json", ".wxss")
  foreach ($ext in $need) {
    if (-not (Test-Path -LiteralPath ($base + $ext))) { Fail ("页面缺文件: " + $p + $ext) }
  }
  foreach ($ext in $opt) {
    if (-not (Test-Path -LiteralPath ($base + $ext))) { Warn ("页面缺可选文件: " + $p + $ext) }
  }
}

$subRoots = @()
$subs = @()
if ($app.subPackages) { $subs = @($app.subPackages) }
if ($app.subpackages) { $subs = @($app.subpackages) }
foreach ($sp in $subs) {
  $spRoot = [string]$sp.root
  if ([string]::IsNullOrWhiteSpace($spRoot)) { Fail "分包缺少 root"; continue }
  $spRoot = $spRoot.TrimEnd('/')
  $subRoots += $spRoot
  $spDir = Join-Path $mp ($spRoot -replace '/', '\')
  if (-not (Test-Path -LiteralPath $spDir)) { Fail ("分包目录不存在: " + $spRoot) }
  foreach ($p in @($sp.pages)) {
    $full = $spRoot + "/" + $p
    $base = Join-Path $mp ($full -replace '/', '\')
    if (-not (Test-Path -LiteralPath ($base + ".js"))) { Fail ("分包页面缺 .js: " + $full) }
    if (-not (Test-Path -LiteralPath ($base + ".wxml"))) { Fail ("分包页面缺 .wxml: " + $full) }
  }
}

if ($app.tabBar) {
  foreach ($it in @($app.tabBar.list)) {
    $tp = [string]$it.pagePath
    if (-not $seen.ContainsKey($tp)) { Fail ("tabBar 页面未在 pages 中注册: " + $tp) }
    $icon = $it.iconPath
    if ($icon -and -not (Test-Path -LiteralPath (Join-Path $mp ($icon -replace '/', '\')))) {
      Warn ("tabBar 图标不存在: " + $icon)
    }
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $mp "sitemap.json"))) {
  Warn "缺少 sitemap.json（不影响运行，但影响微信搜索收录）"
}

function Get-DirSizeKB([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\node_modules\\|\\miniprogram_npm\\|\\\.git\\' } |
          Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [math]::Round($sum / 1024, 1)
}

$totalKB = Get-DirSizeKB $mp
$subKB = 0
foreach ($sr in $subRoots) { $subKB += (Get-DirSizeKB (Join-Path $mp ($sr -replace '/', '\'))) }
$mainKB = [math]::Round($totalKB - $subKB, 1)

foreach ($sr in $subRoots) {
  $kb = Get-DirSizeKB (Join-Path $mp ($sr -replace '/', '\'))
  if ($kb -gt $SubLimitKB) { Fail ("分包超限: " + $sr + " " + $kb + "KB > " + $SubLimitKB + "KB") }
}
if ($mainKB -gt $MainLimitKB) { Fail ("主包超限: " + $mainKB + "KB > " + $MainLimitKB + "KB") }
elseif ($mainKB -gt ($MainLimitKB * 0.85)) { Warn ("主包已用 " + $mainKB + "KB，接近上限 " + $MainLimitKB + "KB") }
if ($totalKB -gt $TotalLimitKB) { Fail ("整包超限: " + $totalKB + "KB > " + $TotalLimitKB + "KB") }

$bad = Get-ChildItem -LiteralPath $mp -Recurse -File -Filter *.js -ErrorAction SilentlyContinue |
       Where-Object { $_.FullName -notmatch '\\node_modules\\|\\miniprogram_npm\\' } |
       Select-String -Pattern '(?<![.\w$])eval\s*\(|new\s+Function\s*\(' -ErrorAction SilentlyContinue
if ($bad) {
  foreach ($b in $bad) {
    $rel = $b.Path.Substring($mp.Length).TrimStart('\')
    Fail ("禁用动态代码: " + $rel + ":" + $b.LineNumber)
  }
}

$danger = Get-ChildItem -LiteralPath $mp -Recurse -File -Filter *.js -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\node_modules\\|\\miniprogram_npm\\' } |
          Select-String -Pattern 'urlCheck\s*:\s*false' -ErrorAction SilentlyContinue
if ($danger) { Warn "代码中出现 urlCheck:false（不校验合法域名），提交前必须确认为本地调试专用" }

Write-Host ""
Write-Host ("结果: " + $pages.Count + " 个页面, " + $subRoots.Count + " 个分包, 主包 " + $mainKB + "KB / 合计 " + $totalKB + "KB, FAIL=" + $script:fails.Count + ", WARN=" + $script:warns.Count)
if ($script:fails.Count -gt 0) { exit 1 }
exit 0
