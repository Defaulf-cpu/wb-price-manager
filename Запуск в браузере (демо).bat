@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  WB Price Manager - интерфейс в браузере (демо-режим)
echo  ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Не установлен Node.js: https://nodejs.org/ru/download
  pause
  exit /b 1
)

echo  Откроется http://localhost:4173
echo  Чтобы остановить - закройте это окно.
echo.
start "" http://localhost:4173
node tools\serve.js --demo
endlocal
