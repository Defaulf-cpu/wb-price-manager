'use strict';

/**
 * Отпечаток версии проекта.
 *
 * Зачем: проект передаётся между песочницей разработки, вашим ПК и GitHub, и на глаз
 * непонятно, какая копия новее. Скрипт печатает короткий набор признаков — по нему
 * за 10 секунд видно, та ли версия лежит в репозитории.
 *
 * Запуск:  node tools/version.js
 *
 * Как пользоваться: запустите на своём клоне и сравните вывод с эталоном ниже
 * (эталон — версия в песочнице разработки на момент последней передачи).
 * Если какого-то признака нет — копия старая, нужно обновить.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; }
};

/**
 * Признаки последней версии. Каждый — файл + строка, которая есть только в новой версии.
 * Если хотя бы один не найден, копия старее.
 */
const MARKERS = [
  ['tools/checks/repo-check.js', 'Целостность копии проекта', 'проверка целостности копии'],
  ['tools/checks/repo-check.js', 'bat-файлы запуска на месте', 'проверка .bat-файлов'],
  ['Опубликовать на GitHub (Windows).bat', 'Personal Access Token', 'скрипт публикации на GitHub'],
  ['docs/GITHUB.md', 'wb-price-manager.bundle', 'инструкция по публикации и бандлу'],
  ['docs/TASKS-for-agents.md', 'promos:items', 'промты для агентов (состав акций из файла)'],
  ['docs/TASKS-for-agents.md', 'price-watcher', 'промт агента B (наблюдатель цен витрины)'],
  ['electron/store.js', 'dp-promo-calendar?action={id}', 'прямая ссылка на акцию'],
  ['electron/store.js', 'promosInferFromDiscount', 'вывод состава акции по скидке'],
  ['electron/store.js', 'PROMOJOURNAL_FILE', 'журнал участия в акциях'],
  ['electron/service.js', "'promos:items'", 'состав акции без обращений к WB'],
  ['electron/service.js', "'items:card'", 'карточка товара одним запросом'],
  ['electron/service.js', "'repricer:proposal'", 'двухфазный цикл репрайсера'],
  ['electron/service.js', "'repricer:journal'", 'журналы цен и акций'],
  ['electron/service.js', "'xlsx:build'", 'экспорт Excel до 150к строк'],
  ['electron/service.js', "'prices:draft-save'", 'сохранение цены без отправки в WB'],
  ['electron/service.js', 'sppPctAvg', 'реальный СПП из статистики продаж WB'],
  ['electron/service.js', 'manual: !!r.manualDraft', 'ручная цена важнее расчёта репрайсера'],
  ['electron/economics.js', 'factSppPct', 'СПП из факта продаж в экономике'],
  ['electron/xlsx-write.js', 'buildXlsx', 'собственный писатель XLSX'],
  ['electron/wb-client.js', 'Not applicable for auto promotions', 'понятная обработка HTTP 422'],
  ['src/renderer/js/views/itemcard.js', 'Экономика и цена', 'объединённая вкладка карточки товара'],
  ['src/renderer/js/views/itemcard.js', 'ic-spp-calc', 'калькулятор СПП по витрине'],
  ['src/renderer/js/views/repricer.js', "'Цена на МП'", 'колонка цены маркетплейса'],
  ['src/renderer/js/views/repricer.js', "'Моя цена'", 'колонка сохранённой цены'],
  ['src/renderer/js/views/repricer.js', 'rp-seg', 'сегментированный фильтр'],
  ['src/renderer/js/views/repricer.js', 'rp-density', 'плотность строк'],
  ['src/renderer/js/views/repricer.js', 'rb-apply-params', 'массовые параметры выбранных строк'],
  ['src/renderer/js/views/repricer.js', 'j-export-xlsx', 'экспорт журналов в Excel'],
  ['src/renderer/js/views/repricer.js', 'COLUMNS:', 'переключатель видимости колонок'],
  ['src/renderer/js/views/repricer.js', 'stageEdit', 'пакетное редактирование (Отменить/Сохранить)'],
  ['src/renderer/js/views/prices.js', 'на МП ', 'цена маркетплейса рядом со своей ценой'],
  ['src/renderer/js/state.js', 'withDraft', 'сохранённая цена применяется во всех разделах'],
  ['src/renderer/js/state.js', 'loadDrafts', 'черновики в общем состоянии'],
  ['src/renderer/js/api.js', 'listenChannel', 'события по SSE в браузере'],
  ['src/renderer/js/ui.js', 'function tabs', 'хелпер вкладок'],
  ['tools/serve.js', 'text/event-stream', 'SSE-поток в dev-сервере'],
  ['package.json', 'repricer-flow.js', 'прогон репрайсера в npm test'],
  ['package.json', 'max-old-space-size', 'лимит кучи для jsdom-прогона'],
  ['electron/price-watcher.js', 'createPriceWatcher', 'наблюдатель цен витрины WB'],
  ['electron/price-watcher.js', 'BLOCKED', 'честная пометка о блокировке витрины'],
  ['electron/service.js', "'pricewatch:fetch'", 'каналы наблюдателя цен'],
  ['electron/service.js', 'sppPctWatch', 'медиана СПП с витрины в фактах товара'],
  ['electron/economics.js', 'watchSppPct', 'приоритет «витрина WB» для СПП'],
  ['electron/store.js', 'PRICEWATCH_FILE', 'файл наблюдений pricewatch.json'],
  ['electron/main.js', 'openPriceWatchHidden', 'изолированное окно для витрины'],
  ['electron/preload.js', "'pricewatch:history'", 'каналы наблюдателя в списке preload'],
  ['src/renderer/js/views/itemcard.js', 'Цены на площадке', 'вкладка цен на площадке'],
  ['src/renderer/js/views/itemcard.js', 'ic-spp-watch', 'кнопка «Подтянуть с витрины»'],
  ['src/renderer/js/views/settings.js', 's-pw-auto', 'раздел настроек наблюдателя цен'],
  ['src/renderer/js/views/costs.js', 'sppPctWatch', 'подсказка источника СПП в себестоимости'],
  ['docs/PRICE-WATCH.md', 'pricewatch:fetch', 'описание устройства наблюдателя'],
  ['docs/API.md', 'pricewatch:fetch', 'контракты наблюдателя в справочнике API'],
  ['tools/checks/repricer-flow.js', 'sppPctWatch', 'проверки приоритета СПП с витрины'],
  ['tools/uitest.js', 'pw-m-shelf', 'UI-проверки вкладки «Цены на площадке»'],
  ['package.json', 'price-watch-flow.js', 'прогон наблюдателя в npm test'],
  ['tools/web-server.js', 'createWebServer', 'веб-версия с авторизацией'],
  ['tools/web-server.js', 'frame-ancestors', 'CSP и защита от кликджекинга'],
  ['tools/web-server.js', 'allowFraming', 'опция встраивания в iframe'],
  ['tools/web-auth.js', 'scryptSync', 'пароль хранится хешем scrypt'],
  ['tools/web-auth.js', 'SameSite', 'cookie сессии с SameSite'],
  ['src/renderer/js/api.js', 'X-CSRF-Token', 'CSRF-заголовок в браузерных запросах'],
  ['src/renderer/js/api.js', 'function logout', 'выход из веб-сессии'],
  ['src/renderer/js/app.js', "mk('Выйти'", 'кнопка «Выйти» в веб-версии'],
  ['package.json', 'web-server-flow.js', 'прогон веб-сервера в npm test'],
  ['docs/WEB.md', 'cloudflared', 'инструкция по туннелю и HTTPS'],
  ['src/renderer/js/views/repricer.js', 'data-t="prices">Товары</div>', 'вкладка «Товары» (прежнее название «Цены и стратегии»)'],
  ['src/renderer/js/views/repricer.js', 'PAGE_SIZE: 100', 'страница товаров по 100 строк'],
  ['src/renderer/js/views/repricer.js', 'rowConfig(', 'правки переживают перерисовку и смену страницы'],
  ['electron/service.js', 'себестоимость должна быть больше 2', 'серверная блокировка себестоимости ≤ 2 ₽'],
  ['electron/service.js', 'Math.min(150000', 'журналы: лимит поднят до 150 000 событий'],
  ['electron/service.js', 'payload.nmIDs', 'частичная отправка сохранённого предложения'],
  ['electron/store.js', 'sentAt', 'время отправки данного предложения'],
  ['electron/store.js', 'staleCount', 'число устаревших позиций'],
  ['electron/xlsx-write.js', 'sharedStrings.xml', 'XLSX: строки через sharedStrings'],
  ['electron/repricer-engine.js', 'costPriceRub: num(', 'себестоимость в результате расчёта'],
  ['docs/API.md', '21.10 Доводка строки товара', 'описание доводки страницы репрайсера'],
  ['tools/uitest.js', 'productionRepricerPageSize', 'штатный размер страницы проверяется отдельно'],
  ['package.json', '--expose-gc', 'UI-прогон с управляемой сборкой мусора'],
  ['README.md', 'по 100 строк', 'README: страница товаров по 100 строк'],
  ['docs/TASKS-for-agents.md', 'ЗАКРЫТО — промт оставлен как спецификация', 'задание C закрыто'],
  ['electron/wb-client.js', 'priceFromSizes', 'базовая цена из sizes[] у товаров с поразмерными ценами'],
  ['electron/service.js', 'базовая цена в WB не задана', 'честная подпись и исключение для сохранённой цены'],
  ['electron/repricer-engine.js', 'priceFromSizes: !!ctx.priceFromSizes', 'признак поразмерной цены в контексте расчёта'],
  ['src/renderer/js/views/repricer.js', 'sizePriceNote', 'бейдж «цена по размерам» в репрайсере'],
  ['tools/checks/repricer-flow.js', 'tSizePricedGoods', 'прогон поразмерных цен'],
  ['docs/API.md', 'sizePriceMin', 'описание нормализации цены из размеров'],
  ['README.md', 'поразмерные цены', 'инструкция про товары с ценами по размерам'],
  ['docs/TASKS-for-agents.md', 'ЗАДАНИЕ D. Единая страница репрайсера', 'промт задания D (блоки колонок INDEEPA)'],
  ['docs/TASKS-for-agents.md', 'ЗАДАНИЕ G. Остатки по складам WB', 'промт задания G (остатки, отключённый метод WB)'],
  ['docs/TASKS-for-agents.md', 'ЗАДАНИЕ N. Веб-версия: туннель по умолчанию', 'промт задания N (туннель и HTTPS)'],
  ['docs/TASKS-for-agents.md', 'Порядок работ: кто, что и за кем', 'план работ по агентам'],
  ['docs/TASKS-for-agents.md', 'zadanie-X.patch', 'требование присылать unified diff'],
  ['docs/API.md', 'Берётся минимальная цена размера', 'нормализация цены из размеров в справочнике API'],
  // ── задания D (единая страница), G (остатки), H (unit-тесты движка) ──
  ['src/renderer/js/views/repricer.js', 'GROUP_ORDER', 'блоки колонок в таблице «Товары»'],
  ['src/renderer/js/views/repricer.js', 'wb.repricer.columns', 'выбор колонок и блоков сохраняется'],
  ['src/renderer/js/views/repricer.js', 'rp-allowsend', 'флаг «Отправка в WB» прямо в строке'],
  ['src/renderer/js/views/repricer.js', 'exportSpec()', 'выгрузка «Блок · Колонка»'],
  ['src/renderer/js/ui.js', 'colspan', 'двухрядная шапка с названиями блоков'],
  ['src/renderer/js/util.js', 'numFormats', 'кеш форматтеров чисел (память в UI-прогоне)'],
  ['electron/service.js', 'costs:rates', 'канал курсов валют'],
  ['electron/store.js', 'costRates', 'курсы валют в настройках'],
  ['electron/repricer-engine.js', 'breakEvenPrice', 'сводка экономики: цена безубыточности'],
  ['docs/API.md', '21.11 Задание D', 'описание единой страницы репрайсера'],
  ['tools/checks/stocks-flow.js', 'stocks:load', 'прогон остатков по складам'],
  ['electron/wb-client.js', 'getStocksReport', 'остатки через отчёт аналитики WB'],
  ['electron/store.js', 'stocksLowDays', 'порог «заканчивается» в настройках'],
  ['src/renderer/js/util.js', 'stockWarn', 'бейдж «заканчивается»'],
  ['package.json', 'stocks-flow.js', 'прогон остатков в npm test'],
  ['tools/checks/engine-unit.js', 'XFAIL', 'ожидаемые расхождения помечены отдельно от ошибок'],
  ['electron/repricer-engine.js', 'valueStatus', 'классификация выгодности вынесена в движок'],
  ['package.json', 'engine-unit.js', 'unit-тесты движка в npm test'],
  ['docs/API.md', 'Проверки расчётов', 'описание проверок расчётов'],
  // ── исправления по итогам задания H ──
  ['electron/economics.js', 'catDef.logisticsBaseRub', 'тарифы логистики по категориям'],
  ['electron/repricer-engine.js', 'denom > 0 && realSeller < 1', 'минимум 1 ₽ при переводе цены в пару'],
  ['src/renderer/js/views/settings.js', 'catLogCell', 'редактирование тарифов логистики по категории'],
  ['docs/API.md', 'Расхождения, которые вскрыли тесты, устранены', 'устранение расхождений, найденных заданием H'],
  ['tools/uitest.js', 'тарифы логистики категории сохранились', 'правки категорий доезжают до хранилища'],
  // ── задания E (одно рабочее место) и I (сборка .exe, автообновление) ──
  ['src/renderer/js/rules.js', 'window.RULES', 'общий модуль массовых правил'],
  ['src/renderer/index.html', 'js/rules.js', 'модуль правил зарегистрирован в index.html'],
  ['src/renderer/js/views/repricer.js', 'Массовые правила', 'вложенные вкладки репрайсера'],
  ['electron/service.js', 'costsRowsFromTable', 'импорт себестоимости из файла (CSV и XLSX)'],
  ['docs/API.md', '21.12 Задание E', 'описание единого рабочего места'],
  ['package.json', 'max-old-space-size=1600', 'UI-прогон с увеличенной кучей'],
  ['electron/updater.js', 'createUpdateManager', 'менеджер автообновления'],
  ['electron/main.js', 'ui:update-check', 'каналы автообновления'],
  ['src/renderer/js/views/settings.js', 'ui:update-state', 'раздел «Обновления» в настройках'],
  ['docs/BUILD.md', 'latest.yml', 'инструкция по сборке и публикации'],
  ['tools/checks/updater-flow.js', 'отключённая настройка не загружает updater', 'прогон автообновления'],
  ['package.json', 'electron-updater', 'зависимость автообновления'],
];

/** Полный список файлов, которые должны быть в репозитории. */
const REQUIRED_FILES = [
  '.gitignore', 'README.md', 'package.json', 'package-lock.json',
  'docs/API.md', 'docs/GITHUB.md', 'docs/TASKS-for-agents.md',
  'docs/PRICE-WATCH.md',
  'electron/config.js', 'electron/demo.js', 'electron/economics.js', 'electron/main.js',
  'electron/preload.js', 'electron/price-watcher.js', 'electron/repricer-engine.js', 'electron/service.js',
  'electron/store.js', 'electron/wb-client.js', 'electron/xlsx-lite.js', 'electron/xlsx-write.js',
  'src/renderer/index.html', 'src/renderer/styles.css',
  'src/renderer/js/api.js', 'src/renderer/js/app.js', 'src/renderer/js/state.js',
  'src/renderer/js/ui.js', 'src/renderer/js/util.js',
  'src/renderer/js/views/costs.js', 'src/renderer/js/views/dashboard.js',
  'src/renderer/js/views/economics.js', 'src/renderer/js/views/itemcard.js',
  'src/renderer/js/views/prices.js', 'src/renderer/js/views/promos.js',
  'src/renderer/js/views/reports.js', 'src/renderer/js/views/repricer.js',
  'src/renderer/js/views/settings.js',
  'tools/serve.js', 'tools/uitest.js', 'tools/version.js',
  'docs/WEB.md', 'tools/web-auth.js', 'tools/web-server.js',
  'tools/checks/web-server-flow.js',
  'tools/checks/demo-flow.js', 'tools/checks/pl-flow.js', 'tools/checks/promo-import.js',
  'tools/checks/promo-import2.js', 'tools/checks/promo-index.js',
  'tools/checks/price-watch-flow.js',
  'tools/checks/fixtures/price-watch-normal.json',
  'tools/checks/fixtures/price-watch-changed.json',
  'tools/checks/rate-limit-flow.js', 'tools/checks/repo-check.js',
  'tools/checks/repricer-flow.js',
  'tools/checks/engine-unit.js', 'tools/checks/stocks-flow.js',
  'tools/checks/updater-flow.js', 'src/renderer/js/rules.js',
  'electron/updater.js', 'docs/BUILD.md', 'build/icon.ico',
  'Запуск (Windows).bat', 'Запуск в браузере (демо).bat',
  'Собрать EXE (Windows).bat', 'Опубликовать на GitHub (Windows).bat',
  'Веб-версия (доступ из сети).bat'
];

let ok = 0;
let bad = 0;
const missing = [];

console.log('=== Отпечаток версии WB Price Manager ===\n');

console.log('Файлы:');
REQUIRED_FILES.forEach((f) => {
  const exists = fs.existsSync(path.join(ROOT, f));
  if (exists) ok++;
  else { bad++; missing.push('файл: ' + f); }
});
console.log('  на месте ' + ok + ' из ' + REQUIRED_FILES.length +
  (bad ? ', НЕ ХВАТАЕТ ' + bad : '') + '\n');

console.log('Признаки последней версии:');
let markersOk = 0;
MARKERS.forEach(([file, needle, title]) => {
  const text = read(file);
  const found = text !== null && text.includes(needle);
  if (found) { markersOk++; console.log('  +  ' + title); }
  else {
    bad++;
    missing.push('признак: ' + title + ' (' + file + ')');
    console.log('  −  ' + title + '   ← НЕТ в ' + file);
  }
});
console.log('\nПризнаков найдено: ' + markersOk + ' из ' + MARKERS.length);

// контрольная сумма ключевых файлов — быстрый способ сверить две копии целиком
const hash = crypto.createHash('sha256');
REQUIRED_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)))
  .sort()
  .forEach((f) => {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(ROOT, f)));
  });
console.log('Контрольная сумма файлов (sha256, первые 16 знаков): ' + hash.digest('hex').slice(0, 16));

if (missing.length) {
  console.log('\nЧего не хватает:');
  missing.forEach((m) => console.log('  ✗ ' + m));
  console.log('\nКопия СТАРЕЕ эталонной. Обновите её: скопируйте проект заново целиком');
  console.log('или клонируйте из репозитория, затем npm install && npm test.');
} else {
  console.log('\nИТОГ: копия совпадает с эталонной версией.');
}
process.exit(missing.length ? 1 : 0);
