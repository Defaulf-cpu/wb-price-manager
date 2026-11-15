@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0."

echo.
echo  ==========================================================
echo   Публикация проекта на GitHub
echo  ==========================================================
echo.

REM ── 1. Проверка git ──
where git >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] git не найден. Установите Git for Windows:
  echo           https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

REM ── 2. Репозиторий должен уже существовать локально ──
if not exist ".git" (
  echo  Локального репозитория нет — создаю...
  git init -b main
  git add -A
  git -c user.name="WB Price Manager" -c user.email="wb-price-manager@local" commit -m "WB Price Manager: первая публикация"
)

REM ── 3. Идентичность для коммитов (нужна только на этом ПК) ──
git config user.name >nul 2>nul || git config user.name "WB Price Manager"
git config user.email >nul 2>nul || git config user.email "wb-price-manager@local"

REM ── 4. Адрес репозитория ──
echo  Создайте на GitHub ПУСТОЙ репозиторий:
echo    New repository -^> имя (например wb-price-manager)
echo    НЕ ставьте галочки README / .gitignore / license
echo.
set "REPO="
set /p REPO="  Вставьте адрес репозитория (https://github.com/ЛОГИН/wb-price-manager.git): "

if "!REPO!"=="" (
  echo  [ОШИБКА] Адрес не введён.
  pause
  exit /b 1
)

REM ── 5. Проверка, что в git не попадут данные и ключи ──
echo.
echo  Проверяю, что ключи WB и данные не попадут в репозиторий...
git ls-files | findstr /i /c:".data/" /c:"secrets" >nul 2>nul
if not errorlevel 1 (
  echo  [ОШИБКА] В индексе есть файлы данных или секретов — остановился.
  echo           Покажите этот список разработчику:
  git ls-files | findstr /i /c:".data/" /c:"secrets"
  pause
  exit /b 1
)
echo  Чисто: ни .data/, ни секретов в репозитории нет.

REM ── 6. Отправка ──
echo.
git remote remove origin >nul 2>nul
git remote add origin "!REPO!"
echo  Отправляю ветку main...
echo  Если git спросит логин и пароль: логин — ваш GitHub,
echo  а вместо пароля вставьте Personal Access Token (право repo).
echo  Токен: GitHub -^> Settings -^> Developer settings -^>
echo         Personal access tokens -^> Tokens (classic) -^> Generate new token
echo.
git push -u origin main

if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Отправить не удалось. Частые причины:
  echo    1. Репозиторий создан НЕ пустым (есть README) — тогда:
  echo         git pull origin main --allow-unrelated-histories
  echo         git push -u origin main
  echo    2. Вместо пароля введён пароль от GitHub, а не токен.
  echo    3. Нет прав на этот репозиторий.
  echo.
  pause
  exit /b 1
)

echo.
echo  ==========================================================
echo   Готово! Проект опубликован:
echo   !REPO!
echo.
echo   Что дать другим агентам:
echo     - ссылку на репозиторий;
echo     - файл docs/TASKS-for-agents.md (там готовые промты).
echo.
echo   Агенту достаточно выполнить:
echo     git clone !REPO!
echo     cd wb-price-manager
echo     npm install
echo     npm test
echo  ==========================================================
echo.
pause
