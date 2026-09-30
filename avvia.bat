@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Radio Udine RP - Server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERRORE] Node.js non e' installato.
  echo  Scaricalo da https://nodejs.org ^(versione LTS^), installalo e riapri questo file.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo  Prima accensione: installo i componenti necessari...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo  [ERRORE] Installazione non riuscita. Controlla la connessione internet.
    pause
    exit /b 1
  )
)

start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
echo.
echo  Il server si e' spento.
pause
