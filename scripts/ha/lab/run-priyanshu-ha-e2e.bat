@echo off
REM Priyanshu HA local E2E — no push, no production
cd /d "%~dp0..\..\.."
echo Repo: %CD%
where node >nul 2>&1 || (echo FAIL: Node.js required & exit /b 1)
node scripts/ha/lab/ha-e2e.mjs
exit /b %ERRORLEVEL%
