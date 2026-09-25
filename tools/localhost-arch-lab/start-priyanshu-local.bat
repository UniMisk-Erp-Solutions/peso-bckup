@echo off
REM Start full PesoWise app (priyanshu copy) + greatest gateway. Does not touch peso-bckup.
set PATH=C:\Program Files\nodejs;%PATH%
set ROOT=%~dp0
start "arch-gateway" cmd /k "cd /d "%ROOT%localhost-arch-lab" && node server.cjs"
timeout /t 2 /nobreak >nul
start "pesowise-priyanshu" cmd /k "cd /d "%ROOT%peso-bckup-priyanshu" && npm.cmd run dev"
echo Gateway: http://127.0.0.1:8787/  App: http://localhost:5174/
