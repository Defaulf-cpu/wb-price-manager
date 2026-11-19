@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  WB Price Manager - запуск
echo  =========================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Не установлен Node.js.
  echo  Скачайте LTS-версию: https://nodejs.org/ru/download
  echo  После установки перезапустите этот файл.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo  Первый запуск: устанавливаю зависимости ^(это займёт 2-5 минут^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ОШИБКА] Не удалось установить зависимости. Проверьте интернет и повторите.
    pause
    exit /b 1
  )
)

echo  Запускаю приложение...
echo  Окно откроется автоматически. Это окно можно закрыть.
echo.
rem %%~dp0 раскрывается в путь с завершающим обратным слешем, и "\" перед кавычкой
rem ломает разбор аргументов. Точка в конце (%%~dp0.) убирает висячий слеш.
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
exit /b 0
