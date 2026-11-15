<#
  노트북 워커 설치: Node 확인 → 패키지 설치·빌드 → PATH → config.json → 작업 스케줄러 등록·시작.
  관리자 권한 불필요. 제거: .\install.ps1 -Uninstall
#>
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$TaskName = 'claude-talk-worker'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "실패: $m" -ForegroundColor Red; exit 1 }

# 작업을 멈추고(wscript 재시작 루프 포함) logs\worker.pid 의 node 를 끈다
function StopWorker {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $pidFile = Join-Path $here 'logs\worker.pid'
  if (Test-Path $pidFile) {
    $old = Get-Process -Id ([int](Get-Content $pidFile -Raw)) -ErrorAction SilentlyContinue
    if ($old -and $old.ProcessName -eq 'node') { Stop-Process -Id $old.Id -Force; "워커 종료: $($old.Id)" }
  }
}

if ($Uninstall) {
  Step '제거'
  StopWorker
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "작업 스케줄러에서 '$TaskName' 삭제"
  } else { '등록된 작업 없음' }
  '제거 완료. 폴더(설정·로그 포함)는 남아 있으니 필요 없으면 직접 지우세요.'
  exit 0
}

# 마지막 요약표에 쓸 값
$sumClaude = '없음'; $sumClaudeLogin = '확인 안 됨'; $sumCodex = '확인 안 됨'

# 1. Node
Step 'Node 확인'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 가 없습니다. https://nodejs.org 에서 22 이상을 설치한 뒤 다시 실행하세요.' }
$nv = (& node --version).Trim()
$major = [int]($nv.TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node $nv 는 너무 낮습니다. 22 이상이 필요합니다." }
"Node $nv"

# 2. 패키지 설치·빌드 (빌드에 개발 도구가 필요해 전체 설치 후 개발 도구만 정리)
Step '패키지 설치·빌드'
if (Test-Path (Join-Path $here 'package-lock.json')) { & npm ci --no-audit --no-fund } else { & npm install --no-audit --no-fund }
if ($LASTEXITCODE -ne 0) { Fail 'npm 설치 오류' }
& npm run build
if ($LASTEXITCODE -ne 0) { Fail '빌드 오류' }
& npm prune --omit=dev --no-audit --no-fund | Out-Null

# 3. PATH 에 %USERPROFILE%\.local\bin
Step 'PATH 확인'
$localBin = Join-Path $env:USERPROFILE '.local\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $localBin) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $localBin).TrimStart(';'), 'User')
  $env:Path = "$env:Path;$localBin"
  "사용자 PATH 에 추가: $localBin"
} else { 'PATH 에 이미 있음' }

$claude = Join-Path $localBin 'claude.exe'
if (Test-Path $claude) {
  $sumClaude = ((& $claude --version) -join ' ').Trim()
  "claude: $sumClaude"
  # 옛 버전은 auth 명령이 없어 'auth status' 를 질문으로 실행한다. 도움말에 있을 때만 확인.
  if ((& $claude --help) -match '^\s+auth\b') {
    $st = (& $claude auth status) -join "`n"
    if ($st -match '"loggedIn":\s*true') { $sumClaudeLogin = '로그인됨'; '로그인 확인됨' } else { $sumClaudeLogin = '로그인 필요'; Write-Host 'Claude 로그인이 필요합니다. 명령창에서 claude 를 실행해 로그인하세요.' -ForegroundColor Yellow }
  } else { '이 버전은 로그인 확인 명령이 없어 건너뜀' }
} else {
  Write-Host "claude.exe 가 없습니다($claude). Claude Code 네이티브 설치 후 다시 실행하세요." -ForegroundColor Yellow
}

# 3-2. Codex (동봉 codex.exe). 로그인 확인만 하고, 실패해도 설치는 계속한다.
Step 'Codex 로그인 확인'
function CodexStatus($exe) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return ((& $exe login status 2>&1) | ForEach-Object { "$_" }) -join "`n" } catch { return '' } finally { $ErrorActionPreference = $prev }
}
try {
  $vendor = Join-Path $here 'node_modules\@openai\codex-win32-x64\vendor'
  $codex = Get-ChildItem $vendor -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if (-not $codex) {
    $sumCodex = 'codex.exe 없음'
    Write-Host 'Codex(codex.exe) 를 찾지 못했습니다. GPT 엔진 없이 계속합니다.' -ForegroundColor Yellow
  } else {
    "codex: $((& $codex --version) -join ' ')"
    $st = CodexStatus $codex
    if ($st -match 'Logged in using') {
      $sumCodex = '로그인됨'
      "Codex 로그인 확인됨 ($($st.Trim()))"
    } else {
      Write-Host 'Codex(ChatGPT) 로그인이 필요합니다. 브라우저가 열리면 ChatGPT 계정으로 로그인하세요.' -ForegroundColor Yellow
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { & $codex login } catch { Write-Host "codex login 실행 오류: $_" -ForegroundColor Yellow } finally { $ErrorActionPreference = $prev }
      $st = CodexStatus $codex
      if ($st -match 'Logged in using') { $sumCodex = '로그인됨'; "Codex 로그인 확인됨 ($($st.Trim()))" }
      else {
        $sumCodex = '로그인 필요'
        Write-Host 'Codex 로그인이 아직 안 되어 있습니다. GPT 엔진은 로그인 전까지 쓸 수 없습니다(나중에 설치를 다시 실행하면 됩니다).' -ForegroundColor Yellow }
    }
  }
} catch {
  Write-Host "Codex 확인 중 오류(무시하고 계속): $_" -ForegroundColor Yellow
}

# 4. config.json
Step '설정 파일'
$cfgPath = Join-Path $here 'config.json'
if (-not (Test-Path $cfgPath)) {
  Copy-Item (Join-Path $here 'config.example.json') $cfgPath
  '예시에서 config.json 을 만들었습니다.'
}
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = $false
if (-not $cfg.worker_id) { $cfg.worker_id = $env:COMPUTERNAME; $changed = $true }
if (-not $cfg.token) {
  $t = Read-Host '서버 토큰을 붙여넣으세요 (Enter 만 누르면 나중에 config.json 에 직접 입력)'
  if ($t) { $cfg.token = $t.Trim(); $changed = $true }
}
if ($changed) {
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
}
if (-not $cfg.token) { Write-Host 'token 이 비어 있습니다. config.json 에 입력한 뒤 작업을 다시 시작하세요.' -ForegroundColor Yellow }
"worker_id: $($cfg.worker_id)"

# 5. 작업 스케줄러 (로그온 시, 창 없이, 실패 시 1분 뒤 재시작 3회, 배터리 허용)
Step '작업 스케줄러 등록'
$vbs = Join-Path $here 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '대화 워커: NAS 와 연결해 질문을 이 PC 에서 실행' -Force | Out-Null

# 6. 시작
Step '시작'
# 이전에 떠 있던 워커 정리 (작업 종료만으로는 자식 node 가 남을 수 있음)
StopWorker
Remove-Item (Join-Path $here 'logs\restart-stop.txt') -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName

# 7. 요약
$endpoint = if ($cfg.endpoint) { $cfg.endpoint } else { 'http://100.103.235.96:8800' }
$roots = if ($cfg.watch_roots) { ($cfg.watch_roots -join '; ') } else { '기본값 (바탕 화면\claude 등 4곳)' }
$ver = if (Test-Path (Join-Path $here 'VERSION')) { (Get-Content (Join-Path $here 'VERSION') -Raw).Trim() } else { '?' }
Step '요약'
[pscustomobject][ordered]@{
  '워커 버전'    = $ver
  'Claude'       = "$sumClaude ($sumClaudeLogin)"
  'Codex'        = $sumCodex
  '서버 주소'    = $endpoint
  'worker_id'    = $cfg.worker_id
  '감시 폴더'    = $roots
  '로그'         = (Join-Path $here 'logs\worker.log')
} | Format-List
