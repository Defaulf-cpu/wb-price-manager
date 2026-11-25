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

rem Проверка целостности копии: ловит неполную копию и файлы, оставшиеся
rem от старой версии при распаковке поверх старой папки. Без неё приложение
rem могло молча не запускаться.
call node tools\checks\repo-check.js
if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Копия проекта неполная или содержит устаревшие файлы.
  echo  Что именно не так - см. список выше. Данные кабинета хранятся вне папки
  echo  проекта ^(в %APPDATA%^), поэтому удаление устаревших файлов безопасно.
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

rem Бинарь Electron должен реально запускаться: битый или недокачанный
rem node_modules раньше приводил к молчаливому закрытию этого окна.
"node_modules\electron\dist\electron.exe" --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Electron не запускается - похоже, папка node_modules повреждена.
  echo  Удалите папку node_modules в каталоге проекта и запустите этот файл снова:
  echo  зависимости переустановятся автоматически.
  echo.
  pause
  exit /b 1
)

echo  Запускаю приложение...
echo  Окно откроется автоматически. Это окно можно закрыть.
echo.
rem %%~dp0 раскрывается в путь с завершающим обратным слешем, и "\" перед кавычкой
rem ломает разбор аргументов. Точка в конце (%%~dp0.) убирает висячий слеш.
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
exit /b 0
