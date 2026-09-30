@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Radio Udine RP - Link per gli amici

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  cloudflared non e' installato ^(serve per creare il link https per gli amici^).
  echo.
  echo  Installalo UNA VOLTA SOLA: apri PowerShell e scrivi
  echo.
  echo      winget install --id Cloudflare.cloudflared
  echo.
  echo  poi chiudi e riapri questo file.
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   Tra qualche secondo qui sotto comparira' un link tipo:
echo       https://parole-a-caso.trycloudflare.com
echo   Mandalo ai tuoi amici: e' quello da aprire sul telefono.
echo.
echo   IMPORTANTE: tieni aperta ANCHE la finestra del server
echo   ^(avvia.bat^). Se chiudi questa finestra il link smette
echo   di funzionare. Ogni volta che la riapri il link cambia.
echo  ============================================================
echo.
cloudflared tunnel --url http://localhost:3000
pause
