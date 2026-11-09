# 门禁校验：文档 frontmatter + 上游状态 + 任务 DAG + 写范围冲突
# 用法: pwsh tools/check-gates.ps1 -Root . [-Strict]
param(
    [string]$Root = '.',
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
$script:fail = 0
$script:warn = 0

function Write-Fail([string]$m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:fail++ }
function Write-Warn([string]$m) { Write-Host "WARN  $m" -ForegroundColor Yellow; $script:warn++ }
function Write-Ok([string]$m) { Write-Host "ok    $m" -ForegroundColor DarkGray }

function Get-FrontMatter {
    param([string]$Path)
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $m = [regex]::Match($text, '(?s)^\uFEFF?---\r?\n(.*?)\r?\n---')
    if (-not $m.Success) { return $null }
    $h = @{}
    foreach ($line in ($m.Groups[1].Value -split "`r?`n")) {
        if ($line -match '^\s*#' -or $line.Trim() -eq '') { continue }
        if ($line -match '^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$') {
            $h[$matches[1]] = $matches[2].Trim()
        }
    }
    return $h
}

function Get-IdList([string]$v) {
    if ([string]::IsNullOrWhiteSpace($v)) { return @() }
    $v = $v.Trim()
    if ($v -eq '[]' -or $v -eq '~' -or $v -eq 'null') { return @() }
    $v = $v.Trim('[', ']')
    return @($v -split ',' | ForEach-Object { $_.Trim().Trim("'").Trim('"') } | Where-Object { $_ })
}

$docsDir = Join-Path $Root 'docs'
if (-not (Test-Path -LiteralPath $docsDir)) {
    Write-Fail "找不到 docs 目录: $docsDir"
    exit 1
}

$validStatus = @('draft', 'review', 'approved', 'superseded')
$docs = Get-ChildItem -LiteralPath $docsDir -Recurse -File -Filter *.md |
    Where-Object { $_.Name -notmatch 'TEMPLATE' -and $_.Name -ne 'README.md' -and $_.FullName -notmatch '\\00-inbox\\' }

$index = @{}
$fronts = @{}

foreach ($f in $docs) {
    $front = Get-FrontMatter -Path $f.FullName
    if ($null -eq $front) {
        Write-Fail "$($f.Name): 缺少 frontmatter（首行必须是 ---）"
        continue
    }
    foreach ($k in @('id', 'title', 'status', 'owner', 'upstream')) {
        if (-not $front.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($front[$k])) {
            Write-Fail "$($f.Name): frontmatter 缺少 $k"
        }
    }
    if ($front.ContainsKey('status') -and $validStatus -notcontains $front['status']) {
        Write-Fail "$($f.Name): status='$($front['status'])' 非法，只能是 $($validStatus -join '/')"
    }
    $fronts[$f.FullName] = $front
    if ($front.ContainsKey('id') -and $front['id']) {
        if ($index.ContainsKey($front['id'])) {
            Write-Fail "id 重复: $($front['id'])（$($f.Name) 与 $($index[$front['id']].Name)）"
        }
        else {
            $index[$front['id']] = $f
        }
    }
}

# 上游检查
foreach ($path in $fronts.Keys) {
    $front = $fronts[$path]
    if (-not $front.ContainsKey('id')) { continue }
    $id = $front['id']
    $status = $front['status']
    foreach ($up in (Get-IdList $front['upstream'])) {
        if (-not $index.ContainsKey($up)) {
            Write-Fail "${id}: 上游 $up 不存在"
            continue
        }
        $upStatus = $fronts[$index[$up].FullName]['status']
        if ($status -eq 'approved' -and $upStatus -ne 'approved') {
            Write-Fail "${id}: 已 approved，但上游 $up 仍是 $upStatus"
        }
        elseif ($status -ne 'approved' -and $upStatus -ne 'approved' -and $status -ne 'superseded') {
            Write-Warn "${id}: 上游 $up 尚未 approved（$upStatus），此文档不可放行"
        }
    }
}

# 任务 DAG 检查
$taskFiles = Get-ChildItem -LiteralPath $docsDir -Recurse -File -Filter 'TASKS-*.json' |
    Where-Object { $_.Name -notmatch 'TEMPLATE' }
foreach ($tf in $taskFiles) {
    try {
        $doc = Get-Content -LiteralPath $tf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        Write-Fail "$($tf.Name): JSON 解析失败 - $($_.Exception.Message)"
        continue
    }
    $tasks = @($doc.tasks)
    if ($tasks.Count -eq 0) { Write-Fail "$($tf.Name): tasks 为空"; continue }

    $ids = @{}
    foreach ($t in $tasks) {
        foreach ($k in @('id', 'role', 'title', 'dependsOn', 'writeScopes', 'acceptance')) {
            if ($null -eq $t.$k) { Write-Fail "$($tf.Name): 任务 $($t.id) 缺少字段 $k" }
        }
        if ($ids.ContainsKey($t.id)) { Write-Fail "$($tf.Name): 任务 id 重复 $($t.id)" }
        $ids[$t.id] = $t
    }

    foreach ($t in $tasks) {
        foreach ($d in @($t.dependsOn)) {
            if ($d -and -not $ids.ContainsKey($d)) {
                Write-Fail "$($tf.Name): $($t.id) 依赖了不存在的任务 $d"
            }
        }
    }

    # 环检测（Kahn）
    $indeg = @{}
    $adj = @{}
    foreach ($t in $tasks) { $indeg[$t.id] = 0; $adj[$t.id] = @() }
    foreach ($t in $tasks) {
        foreach ($d in @($t.dependsOn)) {
            if ($ids.ContainsKey($d)) { $adj[$d] += $t.id; $indeg[$t.id]++ }
        }
    }
    $queue = [System.Collections.Generic.Queue[string]]::new()
    foreach ($k in $indeg.Keys) { if ($indeg[$k] -eq 0) { $queue.Enqueue($k) } }
    $seen = 0
    while ($queue.Count -gt 0) {
        $n = $queue.Dequeue(); $seen++
        foreach ($m in $adj[$n]) { $indeg[$m]--; if ($indeg[$m] -eq 0) { $queue.Enqueue($m) } }
    }
    $cyclic = $false
    if ($seen -ne $tasks.Count) { Write-Fail "$($tf.Name): 依赖图存在环"; $cyclic = $true }

    # 写范围冲突（仅提示）
    $scopes = @()
    foreach ($t in $tasks) {
        foreach ($s in @($t.writeScopes)) {
            if ($s) { $scopes += [pscustomobject]@{ Id = $t.id; Path = ($s -replace '/\*+$', '').ToLower() } }
        }
    }
    for ($i = 0; $i -lt $scopes.Count; $i++) {
        for ($j = $i + 1; $j -lt $scopes.Count; $j++) {
            $a = $scopes[$i]; $b = $scopes[$j]
            if ($a.Id -eq $b.Id) { continue }
            if ($a.Path -eq $b.Path -or $a.Path.StartsWith($b.Path + '/') -or $b.Path.StartsWith($a.Path + '/')) {
                Write-Warn "$($tf.Name): $($a.Id) 与 $($b.Id) 写范围重叠（$($a.Path) / $($b.Path)）"
            }
        }
    }
    if (-not $cyclic) { Write-Ok "$($tf.Name): $($tasks.Count) 个任务，DAG 合法" }
}

Write-Host ''
Write-Host "结果: $($index.Count) 个文档, $($taskFiles.Count) 个任务清单, FAIL=$script:fail, WARN=$script:warn"
if ($script:fail -gt 0) { exit 1 }
if ($Strict -and $script:warn -gt 0) { exit 1 }
exit 0
