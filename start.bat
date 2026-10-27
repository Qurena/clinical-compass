@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Klinicheskiy kompas (server)
if not defined PORT set PORT=3000
if not defined DB_PATH set DB_PATH=%~dp0data\compass.db
if not defined LOGIN_LIMIT set LOGIN_LIMIT=200
if not exist data mkdir data
where node >nul 2>nul || (echo Node.js 22+ not found. Install from https://nodejs.org & pause & exit /b 1)
echo Open: http://localhost:%PORT%
echo LAN:  http://%COMPUTERNAME%:%PORT%  (or the IP from ipconfig)
:loop
node --disable-warning=ExperimentalWarning server.js
echo Server stopped, restarting in 3 s (Ctrl+C to quit)...
timeout /t 3 >nul
goto loop
