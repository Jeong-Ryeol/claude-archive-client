<#
  PC → NAS 세션 로그 업로더.
  ~/.claude/projects 와 Cowork 세션 폴더의 세션 JSONL, 그리고 Codex(GPT) 세션(~/.codex/sessions) 중
  바뀐 것만 NAS ingest API 로 올린다.
  상태(마지막 업로드 크기·mtime)는 %LOCALAPPDATA%\claude-archive\state.json 에 저장.

  설정: 같은 폴더의 config.json
    { "endpoint": "http://192.168.50.133:8800", "token": "…INGEST_TOKEN…" }
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg    = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$stateDir  = Join-Path $env:LOCALAPPDATA 'claude-archive'
$statePath = Join-Path $stateDir 'state.json'
New-Item -ItemType Directory -Force $stateDir | Out-Null
$state = @{}
if (Test-Path $statePath) {
  (Get-Content $statePath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
}

$roots = @(
  @{ source = 'code';   root = Join-Path $env:USERPROFILE '.claude\projects' },
  @{ source = 'cowork'; root = Join-Path $env:APPDATA 'Claude\local-agent-mode-sessions' },
  # Codex(GPT): rollout-<시각>-<uuid>.jsonl. 오래된 것은 .jsonl.zst 로 압축돼 있다 (서버가 푼다)
  @{ source = 'codex';  root = Join-Path $env:USERPROFILE '.codex\sessions'; codex = $true }
)
# Codex 는 처음에 만 개 넘게 밀려 있을 수 있다 → 한 번에 이만큼만, 최근 것부터 (나머지는 다음 실행에)
$maxCodexPerRun = 2000
function Save-State { $state | ConvertTo-Json -Compress | Set-Content $statePath -Encoding UTF8 }
$uuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$sent = 0; $failed = 0
$reasons = New-Object System.Collections.Generic.List[string]

# 1) 올릴 것 모으기 (모든 출처)
$pending = New-Object System.Collections.Generic.List[object]
foreach ($r in $roots) {
  if (-not (Test-Path $r.root)) { continue }
  if ($r.codex) {
    $files = Get-ChildItem $r.root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^rollout-.+\.jsonl(\.zst)?$' } | Sort-Object LastWriteTimeUtc -Descending
  } else {
    $files = Get-ChildItem $r.root -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -match $uuidRe -and $_.DirectoryName -notmatch 'subagent' }
  }
  $n = 0
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($r.root.Length).TrimStart('\') -replace '\\', '/'
    $key = "$($r.source)/$rel"
    $sig = "$($f.Length):$([int64]($f.LastWriteTimeUtc - [datetime]'1970-01-01').TotalSeconds)"
    if ($state[$key] -eq $sig) { continue }
    if ($r.codex -and $n -ge $maxCodexPerRun) { break }
    $n++
    $pending.Add([pscustomobject]@{ f = $f; source = $r.source; rel = $rel; key = $key; sig = $sig; bad = [bool]$state["!fail:$key"] })
  }
}

# 2) 지난번에 실패한 파일은 맨 뒤로 (같은 파일이 매번 앞에서 시간을 다 써서 뒤 출처가 굶지 않게)
$ordered = @($pending | Where-Object { -not $_.bad }) + @($pending | Where-Object { $_.bad })

foreach ($p in $ordered) {
  $uri = "$($cfg.endpoint.TrimEnd('/'))/ingest/$($p.source)/$($p.rel)"
  # 큰 파일(수백 MB 세션)은 60초로는 모자란다 → 크기에 비례 (200KB/초 기준, 최소 2분)
  $timeout = [Math]::Max(120, [int]($p.f.Length / 200KB))
  try {
    Invoke-RestMethod -Method Post -Uri $uri -InFile $p.f.FullName -ContentType 'application/octet-stream' `
      -Headers @{ 'X-Ingest-Token' = $cfg.token } -TimeoutSec $timeout | Out-Null
    $state[$p.key] = $p.sig; $state.Remove("!fail:$($p.key)"); $sent++
    if (($sent % 200) -eq 0) { Save-State }   # 오래 걸리는 첫 실행이 중간에 끊겨도 처음부터 다시 하지 않게
  } catch {
    $failed++
    $state["!fail:$($p.key)"] = 1
    if ($reasons.Count -lt 5) { $reasons.Add("  fail: $($p.key) ($([int]($p.f.Length / 1MB))MB) - $($_.Exception.Message)") }
    Write-Warning "upload failed: $($p.rel) — $($_.Exception.Message)"
  }
}

Save-State
$log = Join-Path $stateDir 'push.log'
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') sent=$sent failed=$failed" | Add-Content $log
if ($reasons.Count) { $reasons | Add-Content $log }   # 왜 실패했는지 (앞 5건)
