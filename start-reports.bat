@echo off
cd /d "%~dp0"
echo Starting Tally bridge...
start "" /min "%~dp0connector\tally\dist\PesoWise-Tally-Agent.exe" bridge
echo.
echo Starting Vite - keep this window open.
echo Reports: http://localhost:3000/admin/reports
echo Tally company: PesoWise Integration Test
echo.
call npm.cmd run dev
