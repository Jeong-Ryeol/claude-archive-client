<#
  Windows 예약 작업 등록: 로그인 후 5분마다 push-logs.ps1 실행 (창 없이).
  관리자 권한 불필요. 제거: Unregister-ScheduledTask -TaskName 'claude-archive push' -Confirm:$false
#>
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'push-logs.ps1'
if (-not (Test-Path (Join-Path $here 'config.json'))) {
  Write-Error "config.json 이 없습니다. config.example.json 을 복사해 endpoint/token 을 채우세요."; exit 1
}
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'claude-archive push' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Claude Code/Cowork 세션 로그를 NAS 아카이브로 업로드' -Force | Out-Null
Start-ScheduledTask -TaskName 'claude-archive push'
"등록 완료. 로그: $env:LOCALAPPDATA\claude-archive\push.log"
