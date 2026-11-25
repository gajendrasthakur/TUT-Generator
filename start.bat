@echo off
rem Starts the SAP PI/PO TUT Generator on http://127.0.0.1:3000 and opens the browser.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install --no-audit --no-fund
)
start "" "http://127.0.0.1:3000"
node src\server.js
pause
