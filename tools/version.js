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
  ['src/renderer/js/views/repricer.js', 'data-t="prices">Товары</button>', 'вкладка «Товары» (прежнее название «Цены и стратегии»)'],
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
  // ── задания F (размеры), J (копии), K (Telegram) и исправления приёмки ──
  ["electron/wb-client.js", "applySizePrices", "отдельный метод записи цен размеров"],
  ["electron/preload.js", "wb:apply-size-prices", "канал размерных цен в preload"],
  ["electron/service.js", "currentSizePrices", "защита от чужих правок любого размера"],
  ["electron/service.js", "SIZE_EQUALIZE_CONFIRM", "защита автоотправки от выравнивания размеров"],
  ["electron/service.js", "skippedUnchanged", "неизменённые размеры не отправляются"],
  ["src/renderer/js/views/repricer.js", "pm-sizemode", "общий режим размерных цен в параметрах"],
  ["src/renderer/js/views/repricer.js", "sizeMode(nmID)", "наследование и индивидуальный режим размеров"],
  ["tools/checks/repricer-flow.js", "tSizePriceSafety", "регрессии сохранности размерных цен"],
  ["tools/uitest.js", "окно результатов не считает ошибки успешной загрузкой", "честная сводка ошибок размерной отправки"],
  ["electron/backup.js", "createBackupManager", "менеджер резервных копий"],
  ["electron/backup.js", "aes-256-gcm", "шифрование ключей WB в переносимой копии"],
  ["electron/service.js", "backup:restore", "восстановление внутренней резервной копии"],
  ["electron/main.js", "createProfileHub", "резервные копии подключены через профильный хаб Electron"],
  ["electron/notifications.js", "createTelegramNotifier", "менеджер Telegram-уведомлений"],
  ["electron/notifications.js", "sanitizeError", "маскирование Telegram-токена в ошибках"],
  ["electron/notifications.js", "quietState", "тихие часы уведомлений"],
  ["electron/service.js", "notify:test", "честная проверка уведомлений"],
  ["electron/main.js", "createTelegramNotifier", "Telegram подключён в Electron"],
  ["tools/web-server.js", "telegramNotifier", "резервные копии и Telegram в защищённой веб-версии"],
  ["src/renderer/js/views/settings.js", "backup-export", "раздел резервных копий в настройках"],
  ["src/renderer/js/views/settings.js", "tg-test", "раздел Telegram в настройках"],
  ["package.json", "backup-flow.js", "прогон резервных копий в npm test"],
  ["package.json", "notify-flow.js", "прогон уведомлений в npm test"],
  ["docs/API.md", "26. Резервные копии", "контракты резервных копий и уведомлений"],

  // ── самостоятельное J (восстановленный PR #9) и N (безопасные туннели) ──
  ["tools/web-server.js", "const mode = opts.mode || 'tunnel'", "tunnel — режим веб-доступа по умолчанию"],
  ["tools/web-server.js", "mode === 'tunnel' ? '127.0.0.1'", "в режиме tunnel нельзя открыть внешний bind"],
  ["tools/web-server.js", "Режим internet требует HTTPS", "internet без TLS заблокирован"],
  ["tools/web-server.js", "function startTunnel", "автозапуск установленного провайдера туннеля"],
  ["docs/WEB.md", "Рекомендуемый сценарий: HTTPS-туннель", "инструкция безопасного доступа через туннель"],
  ["Веб-версия (доступ из сети).bat", "set MODE=tunnel", "Windows launcher по умолчанию выбирает туннель"],
  ["tools/checks/web-server-flow.js", "URL туннеля распознаётся", "проверка раздельных порций URL туннеля"],
  ["electron/main.js", "ui:save-backup", "системный диалог сохранения копии"],
  ["electron/preload.js", "ui:open-backup", "системный диалог выбора копии в белом списке"],
  ["src/renderer/js/api.js", "async function saveBackup", "общий хелпер сохранения JSON-копии"],
  ["src/renderer/js/views/settings.js", "backup-confirm-replace", "отдельное подтверждение полной замены"],
  ["electron/backup.js", "convertLegacyDocument", "совместимость с ранним форматом самостоятельного J"],
  ["tools/checks/fixtures/backup-j-v1.json", "\"format\": \"wbpm-backup\"", "фикстура раннего экспорта J с вымышленными ключами"],
  ["tools/checks/backup-integration-flow.js", "main регистрирует диалог сохранения", "проверки настоящих файловых IPC-обработчиков"],
  ["package.json", "backup-integration-flow.js", "расширенная приёмка J в npm test"],
  ["tools/uitest.js", "замена показывает отдельное подтверждение", "проверки UI слияния и замены данных"],
  ["docs/API.md", "Самостоятельное задание J: объединение", "контракт ручного объединения самостоятельного J"],
  ["docs/TASKS-for-agents.md", "A–N закрыты", "исправленные статусы J и N для следующих агентов"],

  // ── L: профили, безопасная миграция и изоляция IPC/веба/renderer ──
  ['electron/profiles.js', 'MIGRATION_FILE', 'возобновляемая миграция профилей'],
  ['electron/profiles.js', 'recoverTransactions(dataDir)', 'откат J до переноса в профиль'],
  ['electron/profiles.js', 'const handlers = Object.create(null)', 'маршрутизатор без унаследованных каналов'],
  ['electron/profiles.js', 'handlers[channel] = (...args)', 'динамический выбор профиля при вызове IPC'],
  ['electron/profiles.js', 'PROFILE_FORBIDDEN', 'запрет доступа к чужому профилю в вебе'],
  ['electron/profiles.js', "'profiles:invoke'", 'контекст кабинета для действий renderer'],
  ['electron/service.js', 'resetAfterRestore', 'профильный импорт инвалидирует сервис назначения'],
  ['electron/service.js', 'function stopScheduler()', 'жизненный цикл репрайсера и догрузок'],
  ['src/renderer/js/api.js', 'beginProfileChange', 'защита переключения во время операции'],
  ['src/renderer/js/api.js', 'acceptsEvent', 'фильтрация поздних событий чужого кабинета'],
  ['src/renderer/js/state.js', 'resetProfile', 'раздельное состояние профилей в UI'],
  ['src/renderer/js/views/pl-summary.js', "Views['pl-summary']", 'вкладка локального сводного P&L'],
  ['tools/checks/profiles-safety.js', 'реальный IPC читает B', 'регрессия маршрутизации зарегистрированного IPC'],
  ['tools/checks/profiles-flow.js', 'await tWebServerFixed()', 'профильный прогон ждёт все асинхронные проверки'],
  ['package.json', 'test:profiles', 'приёмка L включена в тесты'],
  ['docs/API.md', '27. Профили кабинетов WB', 'контракт профилей кабинетов'],

  // ── M и замечания к рабочему месту ──
  ['electron/promo-analytics.js', 'pairPromoEpisodes', 'аналитика акций по эпизодам'],
  ['electron/service.js', 'priceStateUpdates', 'наблюдение участия по реальной цене'],
  ['electron/store.js', 'observedNms', 'остаток неизвестного товара не подменяется нулём'],
  ['electron/economics.js', "id: 'nds22'", 'актуальный НДС 22% отдельным режимом'],
  ['electron/economics.js', 'function resolveTax', 'взносы ИП и НДС считаются раздельно'],
  ['electron/main.js', 'data: { fileName', 'исправлен контракт нативного выбора XLSX'],
  ['src/renderer/js/grid-layout.js', 'function attach', 'изменение размеров таблицы'],
  ['src/renderer/js/grid-layout.js', 'grid-row-resize', 'изменение высоты строки'],
  ['src/renderer/js/grid-layout.js', 'wb.grid.v1.', 'вид таблицы сохраняется по кабинету'],
  ['src/renderer/js/app.js', "prices: 'price-tools'", 'старые разделы перенесены внутрь РП'],
  ['src/renderer/js/app.js', 'getTheme: () => theme', 'сохраняемая светлая и тёмная тема'],
  ['src/renderer/js/views/promos.js', 'Предпросмотр условий акции', 'импорт файла с предпросмотром и Сохранить'],
  ['electron/promo-import.js', 'bestPromoTable', 'выбор листа товаров после инструкции'],
  ['electron/xlsx-lite.js', 'percentStyles', 'правильное чтение процентов Excel'],
  ['tools/checks/web-server-flow.js', 'JS после обновления перепроверяется', 'защита от устаревшего веб-интерфейса'],
  ['docs/API.md', '28. Рабочее место после M', 'контракты нового рабочего места'],
  ['electron/promo-import.js', "return 'categoryName'", 'предмет WB не подменяет название'],
  ['electron/promo-import.js', "return 'stockSeller'", 'склад продавца читается отдельно от WB'],
  ['electron/promo-import.js', 'conflictingStatuses', 'неоднозначное участие файла не подтверждается'],
  ['electron/service.js', 'const liveDiscount =', 'текущая скидка WB важнее старого снимка'],
  ['src/renderer/js/views/promos.js', 'Плановая цена — точный порог', 'импорт по реальным заголовкам PDF'],
  ['src/renderer/index.html', 'promo-schema-m2', 'обновлённая ревизия интерфейса импорта'],
  ['docs/API.md', '28.8 Сверка структуры по PDF владельца', 'контракт фактической структуры WB'],

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
  'build/icon.png', 'build/icon.svg',
  'electron/backup.js', 'electron/notifications.js', 'electron/profiles.js',
  'electron/promo-analytics.js', 'electron/promo-import.js', 'electron/promo-observation.js',
  'src/renderer/js/grid-layout.js', 'src/renderer/js/tax-ui.js',
  'tools/checks/promo-analytics-flow.js', 'tools/checks/workspace-upgrade-flow.js', 'tools/checks/workspace-ui-safety.js',
  'tools/checks/fixtures/promo-wb-export-synthetic.xlsx', 'tools/checks/fixtures/promo-wb-export-cp1251.csv', 'docs/ACCEPTANCE-M-WORKSPACE.md',
  'tools/checks/promo-export-schema-flow.js',
  'tools/checks/fixtures/promo-wb-export-pdf-schema-synthetic.json', 'tools/checks/fixtures/promo-wb-export-pdf-schema-synthetic.xlsx',
  'docs/ACCEPTANCE-PROMO-EXPORT.md',
  'src/renderer/js/views/pl-summary.js',
  'tools/checks/profiles-flow.js', 'tools/checks/profiles-safety.js', 'docs/ACCEPTANCE-L.md',
  'tools/checks/backup-flow.js', 'tools/checks/notify-flow.js',
  'tools/checks/backup-integration-flow.js', 'tools/checks/fixtures/backup-j-v1.json',
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
