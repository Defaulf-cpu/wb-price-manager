@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0."

echo.
echo  WB Price Manager - веб-версия (доступ через HTTPS-туннель)
echo  ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Не установлен Node.js: https://nodejs.org/ru/download
  pause
  exit /b 1
)

echo  Режим доступа:
echo    1 - только этот компьютер       (local)
echo    2 - доверенная локальная сеть   (lan)
echo    3 - интернет через HTTPS-туннель (tunnel) [по умолчанию]
echo.
set MODE=tunnel
set CHOICE=3
set /p CHOICE="  Выберите режим [1/2/3] и нажмите Enter: "
if "%CHOICE%"=="1" set MODE=local
if "%CHOICE%"=="2" set MODE=lan
if "%CHOICE%"=="3" set MODE=tunnel

set PORT=8080
set /p PORT="  Порт [8080]: "

set TUNNEL_ARG=--no-tunnel-autostart
if /i "%MODE%"=="tunnel" call :askTunnel

echo.
echo  Логин: admin
if "%WB_WEB_PASS%"=="" (
  echo  Пароль не задан - сервер создаст случайный и напечатает его ОДИН раз.
  echo  Сохраните его сразу: повторно посмотреть пароль нельзя.
  echo  Задать свой пароль: set WB_WEB_PASS=ваш-длинный-пароль ^(до запуска^)
) else (
  echo  Пароль: берётся из переменной WB_WEB_PASS
)
echo.
echo  Данные и ключи Wildberries остаются на этом компьютере (каталог .data).
echo  В браузере хранится только сессия входа на 12 часов.
echo  Остановить сервер - закрыть это окно или нажать Ctrl+C.
echo.

if /i "%MODE%"=="local" start "" "http://127.0.0.1:%PORT%"
if /i "%MODE%"=="lan" (
  echo  LAN-адрес для телефона появится в выводе сервера.
  echo  HTTP в LAN не шифрует трафик; используйте только доверенную сеть.
  echo  Подробности: docs\WEB.md
  echo.
)
if /i "%MODE%"=="tunnel" (
  echo  Сервер будет слушать только 127.0.0.1; порт роутера наружу не пробрасывается.
  echo  Cloudflare: cloudflared tunnel --url http://127.0.0.1:%PORT%
  echo  Tailscale:  tailscale serve --bg http://127.0.0.1:%PORT%
  echo  Установите cloudflared или Tailscale для доступа из интернета.
  echo  Если туннель не запустится автоматически, сервер напечатает инструкции установки.
  echo  Подробности: docs\WEB.md
  echo.
)
node tools\web-server.js --mode %MODE% --port %PORT% %TUNNEL_ARG%
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" echo [ОШИБКА] Сервер завершился с кодом %EXIT_CODE%.
endlocal & exit /b %EXIT_CODE%

:askTunnel
set AUTO_TUNNEL=Y
set /p AUTO_TUNNEL="  Автоматически запускать найденный туннель cloudflared/Tailscale? [Y/n]: "
if /i not "%AUTO_TUNNEL%"=="N" set TUNNEL_ARG=--start-tunnel
exit /b
