@echo off
chcp 65001 >nul
echo === 대화 워커 설치 ===
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
echo (종료 코드 %ERRORLEVEL%) 창을 닫아도 됩니다.
pause
