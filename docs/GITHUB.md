# Публикация проекта на GitHub

**Репозиторий опубликован:** <https://github.com/Defaulf-cpu/wb-price-manager>, ветка `main`.

* 13 коммитов, 59 файлов (без `node_modules/`), последний — `59e077f`
  «Веб-версия: доступ с телефона и из любой точки через туннель»;
* в `.gitignore` исключены `node_modules/`, `.data/` (ваши данные и ключи WB),
  `.data-test-*/`, `release/`, `dist/`, `out/`, `*.log`;
* **секретов в истории нет**: ключи WB лежат в `.data/secrets.enc`, который не добавлен в git.

Проверить перед отправкой:

```bash
cd wb-price-manager
git log --oneline                 # 13 коммитов
git status                        # должно быть чисто
git ls-files | grep -i "data\|secret"   # должно быть пусто
node tools/version.js             # 59 файлов, 65/65 признаков (сумма печатается в отчёте)
node tools/checks/repo-check.js   # 13/13, пять .bat с CRLF
```

То же самое со стороны GitHub (не открывая браузер):

```bash
curl -sS "https://api.github.com/repos/Defaulf-cpu/wb-price-manager/git/trees/main?recursive=1"
```

---

## Способ 0 — deploy-ключ: агент отправляет сам, токен в чат не нужен

Так уже сделано один раз: push `0bc0ea7..59e077f` из песочницы Arena.
Порядок действий, если у агента нет учётных данных GitHub:

1. Проверить доступность. `curl -sS -o /dev/null -w "%{http_code}" https://api.github.com/`
   должно дать 200; SSH — `ssh -o StrictHostKeyChecking=accept-new -p 443 -T git@ssh.github.com`.
   Ответ «Permission denied (publickey)» здесь норма: порт открыт, ключа пока нет.

2. Создать ключ и показать владельцу **только публичную** часть:

```bash
ssh-keygen -t ed25519 -C "arena-sandbox" -f ~/.ssh/id_ed25519 -N "" -q
chmod 600 ~/.ssh/id_ed25519     # без этого ssh откажется брать ключ
cat ~/.ssh/id_ed25519.pub
```

3. Владелец добавляет её как deploy-ключ:
   <https://github.com/Defaulf-cpu/wb-price-manager/settings/keys> → **Add deploy key** →
   вставить ключ → **обязательно** галочка **«Allow write access»** → Add key.

4. Проверка: `ssh -T git@github.com` → «Hi Defaulf-cpu/wb-price-manager!».

5. Отправка. SSH настраивается на порт 443, потому что 22 в песочницах часто закрыт:

```bash
cat > ~/.ssh/config <<'CFG'
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
CFG
chmod 600 ~/.ssh/config

cd wb-price-manager
git config user.name "WB Price Manager"
git config user.email "dev@wb-price-manager.local"
git fetch origin main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo "fast-forward, ничего не перетрётся"
git remote add origin git@github.com:Defaulf-cpu/wb-price-manager.git
git push origin main
git ls-remote origin            # HEAD должен совпасть с локальным
```

Три подводных камня, найденных на практике:

* **`.git/config` не переживает снимки песочницы.** `git remote add` и `git config user.name`
  нужно выполнять в том же вызове, что и `git push`, иначе push упадёт с
  «'origin' does not appear to be a git repository» — сразу после успешного добавления remote.
* **Права на `~/.ssh` сбрасываются между вызовами** → «WARNING: UNPROTECTED PRIVATE KEY FILE!».
  `chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519` — перед каждой проверкой.
* Перед push убедиться, что история не разошлась (`merge-base --is-ancestor` выше):
  тогда отправка будет быстрым fast-forward и чужие коммиты не потеряются.

Deploy-ключ даёт доступ **только к этому репозиторию** и отзывается одним кликом на той же
странице настроек. Приватная часть остаётся в песочнице и исчезает вместе с ней —
поэтому этот способ безопаснее токена в чате (Способ 1).

---

## Способ 1 — вы создаёте репозиторий, я отправляю (нужен токен)

1. На GitHub: **New repository** → имя, например, `wb-price-manager` →
   **не** ставьте галочки «Add a README», «.gitignore», «license» (репозиторий должен быть пустым).
2. Создайте токен: GitHub → Settings → Developer settings → **Personal access tokens** →
   **Tokens (classic)** → Generate new token (classic) → отметьте только **`repo`** →
   срок 7 дней достаточно.
3. Пришлите мне **адрес репозитория** и **токен**. Я выполню:

```bash
git remote add origin https://<ВАШ_ЛОГИН>:<ТОКЕН>@github.com/<ВАШ_ЛОГИН>/wb-price-manager.git
git push -u origin main
git remote set-url origin https://github.com/<ВАШ_ЛОГИН>/wb-price-manager.git   # убираю токен из конфига
```

Токен после этого **обязательно отзовите** (Settings → Developer settings → Revoke).
Я не сохраняю его: файлы `.git/config` и `.git-credentials` не попадают в снимки рабочей области.

---

## Способ 2 — вы отправляете сами (токен мне не нужен)

**Самый простой путь — двойной клик по файлу `Опубликовать на GitHub (Windows).bat`**
в папке проекта. Скрипт сам:

1. проверит, что git установлен;
2. создаст репозиторий и первый коммит, если их ещё нет;
3. **проверит, что ключи WB и данные не попадут в репозиторий** (остановится, если найдёт);
4. спросит адрес репозитория — вставьте его;
5. отправит ветку `main` и напечатает, что давать другим агентам.

Вручную — то же самое тремя командами:

```bash
cd wb-price-manager
git remote add origin https://github.com/<ВАШ_ЛОГИН>/wb-price-manager.git
git push -u origin main
```

Git спросит логин и пароль — в качестве пароля вставьте токен (не пароль от GitHub).

---

## Способ 3 — без GitHub, файлом (уже готов)

Репозиторий упакован в один файл **`wb-price-manager.bundle`** (570 КБ, лежит рядом
с папкой проекта, история до `59e077f`). Это полноценный git-репозиторий со всей историей — его можно
передать другому агенту или перенести на ваш ПК:

С появлением GitHub бандл стал запасным путём, но остаётся удобным: его можно
отдать агенту, у которого нет доступа к сети.

```bash
# распаковать в рабочую копию
git clone wb-price-manager.bundle wb-price-manager
cd wb-price-manager
npm install          # зависимости в бандл не входят (это нормально)
npm test             # 49 + 119 + 28 + 18 проверок и 488 UI-проверок
npm run ui:demo      # демо-режим в браузере: http://localhost:4173
```

Проверка целостности бандла: `git bundle verify wb-price-manager.bundle`
(должно написать «The bundle records a complete history»).

Контрольную сумму `tools/version.js` намеренно **не закрепляем в документах**: этот файл
сам входит в эталон, поэтому любая правка документации меняет сумму. Сверяйте число
признаков (65 из 65) и состав файлов (59) — этого достаточно, чтобы понять, что копия цела.

---

## Что дать другим агентам

Другим агентам — ссылку **<https://github.com/Defaulf-cpu/wb-price-manager>**
и файл **`docs/TASKS-for-agents.md`**:
в нём лежат готовые промты (задание A — веб-сервер с доступом через туннель,
задание B — наблюдатель цен витрины для СПП и конкурентов). В каждом промте уже
указаны контекст проекта, точные пути, контракты модулей, ограничения
(никаких новых зависимостей, русский интерфейс, лимиты WB API) и критерии приёмки.

Агенту достаточно клонировать репозиторий и выполнить промт; результат он вернёт
файлами или пул-реквестом — я встрою и прогоню тесты. Задания A (веб-версия) и B
(наблюдатель цен витрины) уже выполнены и вшиты — в `docs/TASKS-for-agents.md`
они помечены как закрытые, брать их в работу не нужно.

Если агент должен отправить результат сам, дайте ему deploy-ключ по Способу 0
(а не токен). Тогда его ветка придёт в репозиторий, и я смогу её разобрать:

```bash
git fetch origin && git branch -r       # что прислали агенты
git log --oneline origin/main -5
```

---

## После публикации

```bash
git pull                 # забрать изменения агентов
npm install              # если менялись зависимости
npm test                 # прогнать проверки перед запуском
```

Ваша рабочая копия на Windows: скопируйте проект **заново целиком** (или `git pull`),
затем `npm install` и запуск через `Запуск (Windows).bat`. Частичное копирование
файлов приводит к рассинхрону `electron/preload.js` и `electron/service.js` —
интерфейс тогда сообщает «Неизвестный канал».
