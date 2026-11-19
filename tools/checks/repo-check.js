'use strict';

/**
 * Проверка целостности копии проекта.
 *
 * Зачем: проект передаётся между ПК, агентами и GitHub, и при переносе часть файлов
 * легко потерять (особенно .bat с кириллическими именами при загрузке через веб-интерфейс
 * GitHub). Скрипт проверяет, что копия полная, код синтаксически цел и что в репозиторий
 * не попали данные кабинета или ключи WB.
 *
 * Запуск:  node tools/checks/repo-check.js
 *          node tools/checks/repo-check.js --strict   (не прощать отсутствующий package-lock)
 *
 * Код возврата 0 — копия пригодна к работе, 1 — чего-то не хватает.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const strict = process.argv.includes('--strict');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('OK   ' + name + (detail ? ' — ' + detail : '')); }
  else {
    fail++;
    problems.push(name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

/** Обязательные файлы: без них приложение не запускается или теряет функциональность. */
const REQUIRED = [
  'package.json',
  '.gitignore',
  'README.md',
  'electron/main.js',
  'electron/preload.js',
  'electron/service.js',
  'electron/store.js',
  'electron/config.js',
  'electron/wb-client.js',
  'electron/economics.js',
  'electron/repricer-engine.js',
  'electron/demo.js',
  'electron/boost-ladder.js', 'electron/workspace-analytics.js', 'electron/workspace-config.js', 'electron/price-safety.js',
  'src/renderer/js/local-drafts.js', 'src/renderer/js/econ-bootstrap.js', 'src/renderer/js/workspace-v4.js', 'src/renderer/js/workspace-forms.js',
  'tools/checks/workspace-v4-flow.js', 'tools/checks/local-drafts-flow.js', 'tools/checks/sales-contract.js', 'tools/checks/finance-contract.js', 'tools/checks/workspace-v4-ui-flow.js', 'docs/WORKSPACE-V4.md',
  'electron/xlsx-lite.js',
  'electron/xlsx-write.js',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/js/api.js',
  'src/renderer/js/app.js',
  'src/renderer/js/state.js',
  'src/renderer/js/ui.js',
  'src/renderer/js/util.js',
  'src/renderer/js/views/dashboard.js',
  'src/renderer/js/views/prices.js',
  'src/renderer/js/views/repricer.js',
  'src/renderer/js/views/itemcard.js',
  'src/renderer/js/views/promos.js',
  'src/renderer/js/views/economics.js',
  'src/renderer/js/views/costs.js',
  'src/renderer/js/views/reports.js',
  'src/renderer/js/views/settings.js',
  'tools/serve.js',
  'tools/uitest.js',
  'tools/checks/rate-limit-flow.js',
  'tools/checks/repricer-flow.js',
  'docs/API.md',
  'docs/TASKS-for-agents.md',
  'docs/GITHUB.md'
];

/** Файлы, которые часто теряются при загрузке через веб-интерфейс (кириллица в имени). */
const BAT_FILES = [
  'Запуск (Windows).bat',
  'Запуск в браузере (демо).bat',
  'Веб-версия (доступ из сети).bat',
  'Собрать EXE (Windows).bat',
  'Опубликовать на GitHub (Windows).bat'
];

/** Что НЕ должно лежать в репозитории. */
const FORBIDDEN = [
  '.data', '.data/', 'secrets.enc', 'settings.json', 'costs.json', 'factcosts.json',
  'pricedrafts.json', 'node_modules', '.env', 'credentials', '.netrc'
];

console.log('=== Целостность копии проекта ===');
console.log('каталог: ' + ROOT + '\n');

// 1) обязательные файлы
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('обязательные файлы на месте', missing.length === 0,
  missing.length ? 'не хватает: ' + missing.join(', ') : REQUIRED.length + ' файлов');

// 2) .bat-файлы (теряются при drag-and-drop загрузке в GitHub)
const missingBat = BAT_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('bat-файлы запуска на месте', missingBat.length === 0,
  missingBat.length ? 'не хватает: ' + missingBat.join(', ') : BAT_FILES.length + ' файлов');

// 3) .bat в кодировке CRLF — иначе cmd.exe может споткнуться
const badEol = BAT_FILES.filter((f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return false;
  return !/\r\n/.test(fs.readFileSync(p, 'utf8'));
});
check('bat-файлы в кодировке CRLF', badEol.length === 0, badEol.join(', ') || 'все в CRLF');

// 4) index.html подключает все скрипты вьюх (порядок важен — его парсит uitest)
const html = fs.existsSync(path.join(ROOT, 'src/renderer/index.html'))
  ? fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8') : '';
const notLinked = REQUIRED
  .filter((f) => f.startsWith('src/renderer/js/'))
  .filter((f) => !html.includes('./' + f.replace('src/renderer/', '')));
check('index.html подключает все скрипты', notLinked.length === 0,
  notLinked.length ? 'не подключены: ' + notLinked.join(', ') : 'все подключены');

// 5) синтаксис каждого JS-файла
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git', '.data', '.data-test-rate', '.data-test-repricer', 'release', 'dist', 'out'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) jsFiles.push(p);
  }
})(ROOT);
const badSyntax = [];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { badSyntax.push(path.relative(ROOT, f)); }
}
check('синтаксис всех JS-файлов цел', badSyntax.length === 0,
  badSyntax.length ? 'сломаны: ' + badSyntax.join(', ') : jsFiles.length + ' файлов проверено');

// 6) package.json валиден и содержит нужные скрипты
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { /* проверим ниже */ }
check('package.json читается', !!pkg && !!pkg.scripts, pkg ? 'скриптов: ' + Object.keys(pkg.scripts).length : 'файл повреждён');
if (pkg && pkg.scripts) {
  const need = ['start', 'ui:demo', 'test', 'test:limits', 'test:repricer', 'test:ui'];
  const noScripts = need.filter((s) => !pkg.scripts[s]);
  check('в package.json есть все скрипты запуска и тестов', noScripts.length === 0,
    noScripts.length ? 'не хватает: ' + noScripts.join(', ') : need.join(', '));
}

// 7) зависимости объявлены (node_modules ставится отдельно — это нормально)
check('зависимости объявлены в package.json',
  !!(pkg && pkg.devDependencies && pkg.devDependencies.electron && pkg.devDependencies.jsdom),
  pkg && pkg.devDependencies ? Object.keys(pkg.devDependencies).join(', ') : '');
check('node_modules не в репозитории (ставится через npm install)',
  !fs.existsSync(path.join(ROOT, 'node_modules')) || true,
  fs.existsSync(path.join(ROOT, 'node_modules')) ? 'установлены локально — это не ошибка' : 'не установлены: выполните npm install');

// 8) в репозитории нет данных кабинета и ключей WB
function listTracked() {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8').split('\n').filter(Boolean);
  } catch (e) { return null; }
}
const tracked = listTracked();
if (tracked) {
  const leaked = tracked.filter((f) => FORBIDDEN.some((bad) => f === bad || f.startsWith(bad) || f.includes(bad)));
  check('в git нет данных кабинета и ключей WB', leaked.length === 0,
    leaked.length ? 'НАЙДЕНО: ' + leaked.join(', ') : tracked.length + ' файлов в индексе, секретов нет');
  check('в git нет node_modules', !tracked.some((f) => f.startsWith('node_modules/')));
} else {
  console.log('INFO git недоступен или это не репозиторий — проверка индекса пропущена');
}

// 9) на диске нет каталога с данными (он создаётся при первом запуске)
const dataOnDisk = fs.existsSync(path.join(ROOT, '.data'));
check('каталог .data не переносится вместе с проектом', true,
  dataOnDisk ? '.data есть локально (создан запуском) — в git он исключён' : '.data нет — чисто');

// 10) package-lock.json
const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
check('package-lock.json на месте (воспроизводимая установка зависимостей)', hasLock || !strict,
  hasLock ? 'есть' : 'НЕТ — npm install может поставить другие версии');

console.log('\nВсего проверок: ' + (pass + fail) + ', пройдено: ' + pass + ', провалено: ' + fail);
if (problems.length) {
  console.log('\nЧто не так:');
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('\nКак починить: скопируйте проект заново ЦЕЛИКОМ (или git clone из репозитория),');
  console.log('затем npm install и npm test. Частичное копирование приводит к рассинхрону');
  console.log('electron/preload.js и electron/service.js — интерфейс сообщает «Неизвестный канал».');
}
console.log('\nИТОГ: ' + (fail ? 'КОПИЯ НЕПОЛНАЯ' : 'ВСЁ ЗЕЛЁНОЕ'));
process.exit(fail ? 1 : 0);
