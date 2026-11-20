'use strict';

/**
 * Общая конфигурация приложения.
 * Используется и в Electron (main process), и в браузерном dev-сервере (tools/serve.js).
 */

const APP_NAME = 'WB Price Manager';
const SETTINGS_FILE = 'settings.json';
const PRICEWATCH_FILE = 'pricewatch.json';
const COSTS_FILE = 'costs.json';
const STOCKS_FILE = 'stocks.json';
const STOCK_HISTORY_FILE = 'stock-history.json';
const TASKS_FILE = 'tasks.json';
const SECRETS_FILE = 'secrets.enc';
const FACTCOSTS_FILE = 'factcosts.json';
const PROMOEXITS_FILE = 'promoexits.json';
/** Предложения репрайсера: фаза «показать» хранится отдельно от фактических цен. */
const PROPOSALS_FILE = 'repricer-proposals.json';
/** История пересчёта по конкретному артикулу (что предложил РП и что отправили). */
const RECALC_HISTORY_FILE = 'repricer-history.json';
/** Журнал участия в акциях: входы, выходы и возвраты цены после автоакций. */
const PROMOJOURNAL_FILE = 'promojournal.json';
const REPRICER_FILE = 'repricer.json';
const COMPETITORS_FILE = 'competitors.json';
const ITEMCONFIGS_FILE = 'itemconfigs.json';
const PRICES_HISTORY_FILE = 'price-history.json';
const REPRICER_RUNS_FILE = 'repricer-runs.json';
const PROMONOMS_FILE = 'promonoms.json';

/**
 * Профили кабинетов WB в одном приложении.
 *
 * Каждый профиль — это имя, ключи WB и свой каталог данных
 * (`.data/profiles/<id>/`). Существующий каталог `.data` при первом запуске
 * переносится в профиль по умолчанию («Основной») без потери данных.
 */
const PROFILES_DIR = 'profiles';
const PROFILES_FILE = 'profiles.json';
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = 'Основной';
const BACKUPS_DIR = 'backups';

/** Хосты Wildberries API (боевой контур и песочница). */
const WB_HOSTS = {
  prod: {
    prices: 'https://discounts-prices-api.wildberries.ru',
    calendar: 'https://dp-calendar-api.wildberries.ru',
    statistics: 'https://statistics-api.wildberries.ru',
    content: 'https://content-api.wildberries.ru',
    common: 'https://common-api.wildberries.ru',
    advert: 'https://advert-api.wildberries.ru',
    finance: 'https://finance-api.wildberries.ru',
    // Остатки по складам: «Аналитика» — отчёт остатков на складах WB
    analytics: 'https://analytics-api.wildberries.ru',
    // Склады продавца и остатки FBS: категория «Маркетплейс»
    marketplace: 'https://seller-api.wildberries.ru'
  },
  sandbox: {
    prices: 'https://discounts-prices-api-sandbox.wildberries.ru',
    calendar: 'https://dp-calendar-api-sandbox.wildberries.ru',
    statistics: 'https://statistics-api-sandbox.wildberries.ru',
    content: 'https://content-api-sandbox.wildberries.ru',
    common: 'https://common-api-sandbox.wildberries.ru',
    advert: 'https://advert-api-sandbox.wildberries.ru',
    // песочницы для финансового API WB не публикует — используем боевой хост
    finance: 'https://finance-api.wildberries.ru',
    analytics: 'https://analytics-api-sandbox.wildberries.ru',
    marketplace: 'https://seller-api-sandbox.wildberries.ru'
  }
};

/** Значение ключа, при котором приложение работает на демо-данных (без обращений к WB). */
const DEMO_KEY = 'demo';

/**
 * Лимиты WB API по категориям.
 *
 *  - «Цены и скидки», «Календарь акций», «Контент»: 10 запросов за 6 секунд на кабинет,
 *    интервал 600 мс, burst 5.
 *  - «Статистика» (/api/v1/supplier/sales и /orders): ЖЁСТКИЙ лимит 1 запрос в минуту.
 *    Раньше здесь стояло 300 запросов в минуту, поэтому обновление данных уходило
 *    в HTTP 429 уже на втором обращении (продажи + заказы + проверка доступа).
 *  - «Финансы» (finance-api, отчёты о реализации): тоже 1 запрос в минуту на кабинет.
 *
 * maxWaitMs — сколько приложение готово ПРОСТОЯТЬ в очереди перед запросом.
 * Если ждать нужно дольше, запрос не уходит вовсе: раздел помечается как
 * «отложенный» и догружается в фоне, когда лимит WB сбросится (см. service.js).
 * Для пагинации длинных отчётов вызывающий код передаёт большой maxWaitMs сам.
 */
/**
 * Масштаб лимитов — служебный переключатель ДЛЯ ТЕСТОВ.
 * WB_RATE_LIMIT_SCALE=0.02 превращает «минуту ожидания» в 1,2 с, чтобы фоновую
 * догрузку раздела после 429 можно было прогнать в тесте за секунды.
 * В обычном запуске переменная не задана, масштаб = 1 и лимиты равны документам WB.
 */
const RATE_SCALE = (() => {
  const v = Number(process.env.WB_RATE_LIMIT_SCALE || 0);
  return v > 0 && v <= 1 ? v : 1;
})();

/** Масштабировать миллисекунды лимита (не меньше 1 мс). */
const sc = (ms) => Math.max(1, Math.round(Number(ms) * RATE_SCALE));

const RATE_LIMITS = {
  prices: { perWindow: 10, windowMs: sc(6000), minIntervalMs: sc(620), burst: 5, maxWaitMs: sc(10000) },
  calendar: { perWindow: 10, windowMs: sc(6000), minIntervalMs: sc(620), burst: 5, maxWaitMs: sc(10000) },
  statistics: { perWindow: 1, windowMs: sc(60000), minIntervalMs: sc(61000), burst: 1, maxWaitMs: sc(2500) },
  content: { perWindow: 10, windowMs: sc(6000), minIntervalMs: sc(620), burst: 5, maxWaitMs: sc(10000) },
  common: { perWindow: 10, windowMs: sc(6000), minIntervalMs: sc(620), burst: 5, maxWaitMs: sc(10000) },
  advert: { perWindow: 10, windowMs: sc(6000), minIntervalMs: sc(620), burst: 5, maxWaitMs: sc(10000) },
  finance: { perWindow: 1, windowMs: sc(60000), minIntervalMs: sc(62000), burst: 1, maxWaitMs: sc(2500) },
  // Остатки на складах WB: категория «Аналитика» — 1 запрос в 20 секунд.
  // Отчёт может содержать до 250 000 строк, поэтому пагинация по offset.
  analytics: { perWindow: 1, windowMs: sc(20000), minIntervalMs: sc(20100), burst: 1, maxWaitMs: sc(2000) },
  // Склады продавца и остатки FBS: категория «Маркетплейс» — 3 запроса в 30 секунд.
  marketplace: { perWindow: 3, windowMs: sc(30000), minIntervalMs: sc(10100), burst: 3, maxWaitMs: sc(2000) }
};

/** Через сколько повторно просить раздел, если WB не прислал срок в заголовках. */
const RATE_FALLBACK_MS = sc(62000);

/** Сколько товаров в одной загрузке цен (лимит WB — 1000). */
const MAX_ITEMS_PER_PRICE_TASK = 1000;

/** Сколько размеров в одной загрузке цен по размерам (POST /api/v2/upload/task/size). */
const MAX_SIZE_ITEMS_PER_PRICE_TASK = 1000;

/** Категория токена, которую требует каждый раздел приложения. */
const TOKEN_SCOPES = {
  prices: 'Цены и скидки (бит 3)',
  calendar: 'Цены и скидки (бит 3) — раздел «Календарь акций»',
  statistics: 'Статистика (бит 5)',
  content: 'Контент (бит 1)',
  tariffs: 'Продвижение (бит 6) — раздел «Тарифы»',
  finance: 'Финансы — отчёты о реализации (фактическая логистика, комиссия, хранение, эквайринг)',
  analytics: 'Аналитика — остатки товаров на складах WB',
  marketplace: 'Маркетплейс — склады продавца и остатки FBS'
};

module.exports = {
  APP_NAME,
  SETTINGS_FILE,
  PRICEWATCH_FILE,
  COSTS_FILE,
  STOCKS_FILE,
  STOCK_HISTORY_FILE,
  TASKS_FILE,
  SECRETS_FILE,
  FACTCOSTS_FILE,
  PROMOEXITS_FILE,
  PROPOSALS_FILE,
  RECALC_HISTORY_FILE,
  PROMOJOURNAL_FILE,
  REPRICER_FILE,
  COMPETITORS_FILE,
  ITEMCONFIGS_FILE,
  PRICES_HISTORY_FILE,
  REPRICER_RUNS_FILE,
  PROMONOMS_FILE,
  PROFILES_DIR,
  PROFILES_FILE,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  BACKUPS_DIR,
  WB_HOSTS,
  DEMO_KEY,
  RATE_LIMITS,
  RATE_SCALE,
  RATE_FALLBACK_MS,
  MAX_ITEMS_PER_PRICE_TASK,
  MAX_SIZE_ITEMS_PER_PRICE_TASK,
  TOKEN_SCOPES
};
