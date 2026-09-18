@echo off
chcp 65001 >nul
echo === claude-archive: register the 5-minute upload task ===
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"
echo.
echo (exit code %ERRORLEVEL%)  --  close this window when done.
pause
