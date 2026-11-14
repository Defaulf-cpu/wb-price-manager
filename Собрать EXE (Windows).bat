@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  Сборка установщика WB Price Manager для Windows
echo  ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Нужен Node.js LTS: https://nodejs.org/ru/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Устанавливаю зависимости...
  call npm install
  if errorlevel 1 ( echo  [ОШИБКА] npm install не удался & pause & exit /b 1 )
)

echo.
echo  Собираю установщик ^(NSIS^) и портативную версию...
echo.
call npx electron-builder --win --x64
if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Сборка не удалась. Текст ошибки выше.
  pause
  exit /b 1
)

echo.
echo  Готово! Файлы в папке release:
echo    - WBPriceManager-Setup-1.0.0.exe   ^(установщик^)
echo    - WBPriceManager-Portable-1.0.0.exe ^(без установки^)
echo.
explorer "%~dp0release"
pause
endlocal
