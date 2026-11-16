@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0."

echo.
echo  WB Price Manager - веб-версия (доступ из браузера)
echo  ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Не установлен Node.js: https://nodejs.org/ru/download
  pause
  exit /b 1
)

echo  Режим доступа:
echo    1 - только этот компьютер   ^(http://127.0.0.1:8080^)
echo    2 - локальная сеть          ^(телефон и планшет в той же Wi-Fi^)  [по умолчанию]
echo    3 - интернет через туннель  ^(Cloudflare Tunnel или Tailscale^)
echo.
set MODE=lan
set CHOICE=2
set /p CHOICE="  Выберите режим [1/2/3] и нажмите Enter: "
if "%CHOICE%"=="1" set MODE=local
if "%CHOICE%"=="3" set MODE=local

set PORT=8080
set /p PORT="  Порт [8080]: "

echo.
echo  Логин: admin
if "%WB_WEB_PASS%"=="" (
  echo  Пароль не задан - сервер создаст случайный и напечатает его ОДИН раз.
  echo  Сохраните его сразу: повторно посмотреть пароль нельзя.
  echo  Задать свой пароль:  set WB_WEB_PASS=ваш-длинный-пароль   ^(до запуска^)
) else (
  echo  Пароль: берётся из переменной WB_WEB_PASS
)
echo.
echo  Данные и ключи Wildberries остаются на этом компьютере ^(каталог .data^).
echo  В браузере хранится только сессия входа на 12 часов.
echo  Остановить сервер - закрыть это окно или нажать Ctrl+C.
echo.
if "%CHOICE%"=="1" start "" http://127.0.0.1:%PORT%
if "%CHOICE%"=="3" (
  echo  Для доступа из интернета запустите туннель в отдельном окне:
  echo    cloudflared tunnel --url http://localhost:%PORT%
  echo    tailscale serve --bg %PORT%
  echo  Сервер при этом слушает только 127.0.0.1 - порт наружу не пробрасывается.
  echo  Подробности и HTTPS: docs\WEB.md
  echo.
)
if "%CHOICE%"=="2" (
  echo  Адрес для телефона будет напечатан ниже в строке "Адреса интерфейсов LAN".
  echo  Если страница не открывается - разрешите порт %PORT% в брандмауэре Windows.
  echo  Подробности и HTTPS: docs\WEB.md
  echo.
)
node tools\web-server.js --mode %MODE% --port %PORT%
endlocal
