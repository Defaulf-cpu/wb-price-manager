'use strict';

const fs = require('fs');
const path = require('path');
const {
  SETTINGS_FILE, COSTS_FILE, TASKS_FILE, SECRETS_FILE, PRICEWATCH_FILE, STOCKS_FILE, STOCK_HISTORY_FILE,
  PRICEDRAFTS_FILE, PROPOSALS_FILE, RECALC_HISTORY_FILE, PROMOJOURNAL_FILE,
  REPRICER_FILE, COMPETITORS_FILE, ITEMCONFIGS_FILE, PRICES_HISTORY_FILE,
  REPRICER_RUNS_FILE, FACTCOSTS_FILE, PROMOEXITS_FILE, PROMONOMS_FILE
} = require('./config');

/** Настройки по умолчанию (все значения пользователь может изменить в разделе «Настройки»). */
const DEFAULT_SETTINGS = {
  priceWatchAutoFetch: false, // витрина: включение на свой риск
  priceWatchTtlMinutes: 60,
  /**
   * Остатки по складам WB: порог оборачиваемости для бейджа «заканчивается».
   * Если запаса хватает меньше этого числа дней (при текущих продажах) —
   * товар помечается в репрайсере и в карточке.
   */
  stocksLowDays: 14,
  demoMode: true,
  autoUpdateEnabled: true,
  backupSchedule: 'off', // off | daily | weekly
  backupRetention: 10,
  telegramNotifications: {
    chatId: '',
    events: {
      proposalReady: false,
      sendSuccess: false,
      sendError: false,
      quarantine: false,
      rateLimit: false,
      promoStarted: false,
      promoEnded: false,
      competitorPrice: false,
      lowStock: false
    },
    quietHours: { enabled: false, start: '22:00', end: '08:00' }
  },
  sandbox: false,
  model: 'marketplace', // marketplace | fbw
  currency: 'RUB',
  commissionDefault: 20,
  logisticsBaseRub: 50,
  logisticsPerLiterRub: 15,
  literThreshold: 5,
  logisticsLargeRub: 145,
  acceptRub: 0,
  storageRubPerUnit: 3,
  packagingRub: 12,
  taxMode: 'usn6', // налог и НДС настраиваются отдельно для кабинета
  taxRate: 6,
  taxVatRate: 0,
  taxInsuranceEnabled: false,
  taxAnnualRevenue: null,
  ipFixedContribution: 57390, // 2026: можно изменить для льготы / неполного года
  ipExtraContributionCap: 321818,
  ipDeductContributions: true,
  ipHasEmployees: false,
  acquiringPct: 0,
  adPctDefault: 8,
  sppDefault: 15,
  targetMarginPct: 20,
  minMarginPctAlert: 10,
  quarantineGuard: true,
  maxPriceChangePct: 50,
  requireConfirmAbove: 20,
  /**
   * Курсы валют для себестоимости (задание D): сколько ₽ стоит 1 единица валюты.
   * Себестоимость можно вести в валюте закупки (CNY, USD, TRY…) — репрайсер
   * пересчитает её в рубли по этому курсу. Курс правится на вкладке «Параметры»
   * репрайсера, там же, где задаётся себестоимость, чтобы не ходить по разделам.
   */
  costRates: { CNY: 12.5, USD: 92, EUR: 100, TRY: 2.7, KZT: 0.18, BYN: 28, UZS: 0.0072, AED: 25, PLN: 23 },
  /** Название магазина/кабинета — показывается в шапке репрайсера и попадает в выгрузки. */
  shopName: '',
  /**
   * Фактические расходы из отчёта о реализации WB (finance-api).
   * Логистика и комиссия у WB плавающие, поэтому берём среднее за окно дней.
   * Приоритет: ручное значение по товару → факт из отчёта → справочник категории → общие настройки.
   */
  useFactCosts: true,
  factWindowDays: 7,
  factCostsPeriod: 'daily',   // daily | weekly — периодичность отчётов WB
  factAutoRefreshHours: 12,   // 0 = не обновлять автоматически
  factsLoadedAt: null,
  /**
   * Отчёт о реализации WB формируется с задержкой (дневной — на следующий день,
   * недельный — в понедельник). Если за выбранные дни отчёта нет, приложение ищет
   * последний доступный за factLookbackDays дней и честно показывает, что взято.
   */
  factLookbackDays: 60,
  factAutoWiden: true,
  factMaxPages: 10,           // страниц детализации (по одной в минуту — лимит WB)
  /**
   * Статистика: WB даёт категории «Статистика» ОДИН запрос в минуту.
   * Продажи и заказы — это два запроса, поэтому заказы по умолчанию догружаются
   * в фоне отдельным вызовом, а не блокируют «Обновить данные из WB».
   */
  statsLoadOrders: true,
  statsMaxPages: 3,           // страниц по ~80 000 строк (каждая = минута ожидания)
  /**
   * Прямая ссылка на акцию в кабинете продавца: {id} подставляется из календаря WB.
   * Страница открывается сразу на нужной акции — остаётся нажать «Перейти к товарам
   * для акции» → «Сформировать» → «Скачать», а файл загрузить в приложение.
   * Шаблон настраиваемый: если WB поменяет адрес, достаточно поправить эту строку
   * в «Настройки → 3.3 Акции» без обновления приложения.
   */
  promoCabinetUrl: 'https://seller.wildberries.ru/dp-promo-calendar?action={id}',
  /** Окно аналитики эффекта акций: N дней до входа и первые N дней участия. */
  promoAnalyticsDays: 7,
  /**
   * Состав акции через API WB запрашивать НЕ нужно: метод /calendar/promotions/nomenclatures
   * помечен «Not applicable for auto promotions» и на практике отвечает HTTP 422 почти на всё.
   * Источник состава — файл, который продавец скачивает в кабинете («Перейти к товарам для
   * акции» → «Сформировать» → «Скачать») и загружает в приложение.
   *
   * false (по умолчанию) — к WB за составом не ходим вообще;
   * true — пробуем API (только для обычных акций), файл всё равно приоритетнее.
   */
  promosFetchNomenclatures: false,
  /** Дополнять состав по факту скидки товара (скидка ≥ требуемой = товар в условиях акции). */
  promosInferFromDiscount: true,
  /** Справочник комиссий по категориям — значения ориентировочные, редактируются пользователем. */
  categoryDefaults: {
    'Женская одежда': { commissionPct: 22.5, adPct: 8, taxMode: 'inherit', packagingRub: 15 },
    'Мужская одежда': { commissionPct: 22.5, adPct: 8, taxMode: 'inherit', packagingRub: 15 },
    'Детская одежда': { commissionPct: 21, adPct: 7, taxMode: 'inherit', packagingRub: 12 },
    'Обувь': { commissionPct: 19.5, adPct: 9, taxMode: 'inherit', packagingRub: 18 },
    'Аксессуары': { commissionPct: 20, adPct: 8, taxMode: 'inherit', packagingRub: 10 },
    'Косметика': { commissionPct: 17, adPct: 12, taxMode: 'inherit', packagingRub: 14 },
    'Товары для дома': { commissionPct: 21, adPct: 10, taxMode: 'inherit', packagingRub: 25 },
    'Электроника': { commissionPct: 12, adPct: 6, taxMode: 'inherit', packagingRub: 30 },
    'Игрушки': { commissionPct: 18, adPct: 9, taxMode: 'inherit', packagingRub: 16 },
    'Спорт': { commissionPct: 19, adPct: 8, taxMode: 'inherit', packagingRub: 20 }
  },
  lastSync: null
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const writeOptions = { encoding: 'utf8' };
  if (options && Number.isInteger(options.mode)) writeOptions.mode = options.mode;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), writeOptions);
  fs.renameSync(tmp, file);
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Глубокое слияние с приоритетом источника (массивы заменяются целиком). */
function deepMerge(base, src) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isObject(src)) return out;
  for (const k of Object.keys(src)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    const sv = src[k];
    if (isObject(sv) && isObject(out[k])) out[k] = deepMerge(out[k], sv);
    else out[k] = sv;
  }
  return out;
}

/**
 * Файловое хранилище настроек, себестоимостей и истории задач.
 * @param {string} dir каталог для данных (в Electron — app.getPath('userData'))
 * @param {object} [secretBox] { encrypt(string)->string, decrypt(string)->string }
 */
function createStore(dir, secretBox) {
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, SETTINGS_FILE);
  const priceWatchPath = path.join(dir, PRICEWATCH_FILE);
  const stocksPath = path.join(dir, STOCKS_FILE);
  const stockHistoryPath = path.join(dir, STOCK_HISTORY_FILE);
  const costsPath = path.join(dir, COSTS_FILE);
  const tasksPath = path.join(dir, TASKS_FILE);
  const secretsPath = path.join(dir, SECRETS_FILE);
  const repricerPath = path.join(dir, REPRICER_FILE);
  const competitorsPath = path.join(dir, COMPETITORS_FILE);
  const itemConfigsPath = path.join(dir, ITEMCONFIGS_FILE);
  const historyPath = path.join(dir, PRICES_HISTORY_FILE);
  const runsPath = path.join(dir, REPRICER_RUNS_FILE);
  const factCostsPath = path.join(dir, FACTCOSTS_FILE);
  const promoExitsPath = path.join(dir, PROMOEXITS_FILE);
  const promoNomsPath = path.join(dir, PROMONOMS_FILE);
  const priceDraftsPath = path.join(dir, PRICEDRAFTS_FILE);
  const proposalsPath = path.join(dir, PROPOSALS_FILE);
  const recalcHistoryPath = path.join(dir, RECALC_HISTORY_FILE);
  const promoJournalPath = path.join(dir, PROMOJOURNAL_FILE);

  const safeStorageOk = () => !!(api.secretBox && api.secretBox.available);

  const api = {
    dir,
    paths: { settingsPath, costsPath, tasksPath, secretsPath },
    secretBox: secretBox || null,
    _secretsError: '',

    loadSettings() {
      return deepMerge(DEFAULT_SETTINGS, readJson(settingsPath, {}));
    },

    saveSettings(patch) {
      const next = deepMerge(api.loadSettings(), patch || {});
      writeJson(settingsPath, next);
      return next;
    },

    resetSettings() {
      writeJson(settingsPath, DEFAULT_SETTINGS);
      return Object.assign({}, DEFAULT_SETTINGS);
    },

    loadCosts() {
      const data = readJson(costsPath, { items: {}, updatedAt: null });
      if (!isObject(data.items)) data.items = {};
      return data;
    },

    saveCosts(items) {
      const data = { items: items || {}, updatedAt: new Date().toISOString() };
      writeJson(costsPath, data);
      return data;
    },

    loadTasks() {
      const data = readJson(tasksPath, []);
      return Array.isArray(data) ? data : [];
    },

    saveTasks(list) {
      writeJson(tasksPath, Array.isArray(list) ? list.slice(0, 300) : []);
    },

    saveSecrets(secrets) {
      const payload = JSON.stringify(secrets || {});
      let stored;
      if (api.secretBox && api.secretBox.available) {
        stored = { v: 1, method: 'safeStorage', data: api.secretBox.encrypt(payload) };
      } else {
        stored = { v: 1, method: 'base64', data: Buffer.from(payload, 'utf8').toString('base64') };
      }
      writeJson(secretsPath, stored, { mode: 0o600 });
      try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* Windows: игнорируем */ }
      api._secretsError = '';
      return { method: stored.method };
    },

    loadSecrets() {
      const stored = readJson(secretsPath, null);
      if (!stored || !stored.data) { api._secretsError = ''; return {}; }
      const enc = safeStorageOk();
      // Файл мог быть записан в одном режиме, а читаться в другом (сменился пользователь ОС,
      // safeStorage стал недоступен, приложение перенесли). Раньше любая ошибка тихо
      // превращалась в «ключей нет» — пользователь видел пустые поля и 401 по всем разделам.
      const tries = stored.method === 'safeStorage' && enc
        ? [['safeStorage', () => api.secretBox.decrypt(stored.data)], ['base64', () => Buffer.from(stored.data, 'base64').toString('utf8')]]
        : [['base64', () => Buffer.from(stored.data, 'base64').toString('utf8')], ['safeStorage', enc ? () => api.secretBox.decrypt(stored.data) : null]];
      let lastErr = null;
      for (const [name, fn] of tries) {
        if (typeof fn !== 'function') continue;
        try {
          const parsed = JSON.parse(fn());
          if (isObject(parsed)) { api._secretsError = ''; return parsed; }
        } catch (e) { lastErr = e; }
      }
      api._secretsError = stored.method === 'safeStorage' && !enc
        ? 'Ключи сохранены с шифрованием ОС, но сейчас оно недоступно (сменился пользователь Windows или профиль) — вставьте ключи заново.'
        : 'Не удалось прочитать сохранённые ключи (' + (lastErr && lastErr.message ? lastErr.message : 'ошибка расшифровки') + ') — вставьте ключи заново.';
      return {};
    },

    /** Текст последней ошибки чтения ключей (пусто, если всё прочиталось). */
    secretsError() {
      return api._secretsError || '';
    },

    secretsMethod() {
      const stored = readJson(secretsPath, null);
      if (!stored) return null;
      return stored.method === 'safeStorage' ? 'Шифрование ОС (Electron safeStorage)' : 'Base64 (без шифрования ОС)';
    },

    // ─────────── Репрайсер ───────────

    loadRepricer() {
      return readJson(repricerPath, {});
    },

    saveRepricer(patch, options) {
      const cur = api.loadRepricer();
      const next = deepMerge(cur, patch || {});
      for (const key of (options && options.replaceKeys) || []) if (!['__proto__', 'constructor', 'prototype'].includes(key) && Object.prototype.hasOwnProperty.call(patch || {}, key)) next[key] = patch[key];
      writeJson(repricerPath, next);
      return next;
    },

    // nmID -> хронологический список наблюдений; не более 50 на товар.
    loadPriceWatch() {
      const d = readJson(priceWatchPath, { items: {} });
      return isObject(d) && isObject(d.items) ? d.items : {};
    },

    savePriceWatch(items) {
      const cleaned = {};
      for (const [key, rows] of Object.entries(isObject(items) ? items : {})) {
        if (/^[1-9]\d*$/.test(key) && Array.isArray(rows)) cleaned[key] = rows.slice(-50);
      }
      writeJson(priceWatchPath, { items: cleaned, updatedAt: new Date().toISOString() });
      return cleaned;
    },

    appendPriceWatch(entries) {
      const items = api.loadPriceWatch();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const key = String(entry && entry.nmID || '');
        if (!/^[1-9]\d*$/.test(key)) continue;
        const { nmID, ...row } = entry;
        items[key] = (Array.isArray(items[key]) ? items[key] : []).concat([row]).slice(-50);
      }
      return api.savePriceWatch(items);
    },

    // ───────────────────────── Остатки по складам WB ─────────────────────────

    /**
     * Кэш остатков по складам WB: nmID → {
     *   total,                                  — суммарный остаток по всем складам и размерам
     *   byWarehouse: { name: qty },             — разбивка по складам
     *   byRegion: { region: qty },              — разбивка по регионам
     *   sizeRows,                               — сколько строк отчёта легло в сумму
     *   at                                      — когда загружено
     * }
     * Плоский объект (не массив наблюдений): остатки — текущее состояние,
     * его достаточно переписать целиком после каждой загрузки.
     */
    loadStocks() {
      const d = readJson(stocksPath, { items: {}, meta: {} });
      return { items: isObject(d.items) ? d.items : {}, meta: isObject(d.meta) ? d.meta : {} };
    },

    saveStocks(items, meta) {
      const clean = {};
      for (const [key, row] of Object.entries(isObject(items) ? items : {})) {
        if (!/^[1-9]\d*$/.test(key) || !isObject(row)) continue;
        clean[key] = {
          total: Number(row.total) || 0,
          byWarehouse: isObject(row.byWarehouse) ? row.byWarehouse : {},
          byRegion: isObject(row.byRegion) ? row.byRegion : {},
          sizeRows: Number(row.sizeRows) || 0,
          at: row.at || new Date().toISOString()
        };
      }
      writeJson(stocksPath, {
        items: clean,
        meta: Object.assign({}, api.loadStocks().meta, isObject(meta) ? meta : {}, { updatedAt: new Date().toISOString() })
      });
      return { items: clean, meta: api.loadStocks().meta };
    },

    /**
     * История полных снимков остатков для аналитики акций.
     * Храним по одному дню объединение наблюдавшихся нулевых остатков: если хотя бы
     * один полный снимок за день показал товар без запаса, этот факт не теряется,
     * даже если следующий снимок того же дня уже положительный.
     */
    loadStockHistory() {
      const d = readJson(stockHistoryPath, { days: {} });
      return { days: isObject(d.days) ? d.days : {}, updatedAt: d.updatedAt || null };
    },

    appendStockSnapshot(snapshot) {
      const s = isObject(snapshot) ? snapshot : {};
      if (s.complete === false) return api.loadStockHistory();
      const at = s.at || new Date().toISOString();
      const date = s.date ? String(s.date).slice(0, 10) : new Date(Date.parse(at) + 3 * 3600000).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return api.loadStockHistory();
      const history = api.loadStockHistory();
      const days = history.days;
      const prior = days[date] || {};
      const zeros = new Set((Array.isArray(prior.zeroNms) ? prior.zeroNms : []).map(String));
      (Array.isArray(s.zeroNms) ? s.zeroNms : []).forEach((nm) => {
        const key = String(nm);
        if (/^[1-9]\d*$/.test(key)) zeros.add(key);
      });
      days[date] = {
        at,
        source: s.source || prior.source || '',
        complete: true,
        observations: (Number(prior.observations) || 0) + 1,
        zeroNms: Array.from(zeros).slice(0, 150000),
        observedNms: [...new Set([...(prior.observedNms || prior.zeroNms || []), ...(s.observedNms || s.zeroNms || [])].map(String))]
          .filter((nm) => /^[1-9]\d*$/.test(nm)).slice(0, 150000)
      };
      const cutoff = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
      Object.keys(days).forEach((d) => { if (d < cutoff) delete days[d]; });
      writeJson(stockHistoryPath, { days, updatedAt: new Date().toISOString() });
      return api.loadStockHistory();
    },

    loadCompetitors() {
      const d = readJson(competitorsPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    saveCompetitors(items) {
      writeJson(competitorsPath, { items: items || {}, updatedAt: new Date().toISOString() });
      return items || {};
    },

    loadItemConfigs() {
      const d = readJson(itemConfigsPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    saveItemConfigs(items) {
      writeJson(itemConfigsPath, { items: items || {}, updatedAt: new Date().toISOString() });
      return items || {};
    },

    /** История цен: nmID → [{at, basePrice, discount, sellerPrice, source}] */
    loadPriceHistory() {
      const d = readJson(historyPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    appendPriceHistory(entries) {
      const items = api.loadPriceHistory();
      const now = new Date().toISOString();
      for (const e of entries || []) {
        const k = String(e.nmID);
        const list = Array.isArray(items[k]) ? items[k] : [];
        list.push({
          at: e.at || now,
          basePrice: e.basePrice,
          discount: e.discount,
          sellerPrice: e.sellerPrice,
          ...(e.sizePrices && typeof e.sizePrices === 'object' ? { sizePrices: Object.fromEntries(Object.entries(e.sizePrices)
            .filter(([sid, price]) => /^[1-9]\d*$/.test(sid) && Number.isSafeInteger(Number(sid)) && Number.isFinite(Number(price)) && Number(price) > 0)
            .map(([sid, price]) => [sid, Number(price)])) } : {}),
          source: e.source || 'manual'
        });
        items[k] = list.slice(-120);
      }
      // не раздуваем файл: максимум 3000 артикулов
      const keys = Object.keys(items);
      if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete items[k]);
      writeJson(historyPath, { items });
      return items;
    },

    /** Цена на начало текущих суток — для суточного лимита изменения. */
    dayStartPrices() {
      const items = api.loadPriceHistory();
      const today = new Date().toISOString().slice(0, 10);
      const out = {};
      for (const [k, list] of Object.entries(items)) {
        if (!Array.isArray(list) || !list.length) continue;
        const todays = list.filter((p) => String(p.at || '').slice(0, 10) === today);
        const src = todays.length ? todays[0] : list[list.length - 1];
        out[k] = Number(src.sellerPrice) || undefined;
      }
      return out;
    },

    loadRuns() {
      const d = readJson(runsPath, []);
      return Array.isArray(d) ? d : [];
    },

    saveRuns(list) {
      writeJson(runsPath, Array.isArray(list) ? list.slice(0, 200) : []);
    },

    // ─────────── Фактические расходы из отчёта о реализации WB ───────────

    /**
     * @returns {{items: object, meta: object}} items: nmID → {
     *   logisticsAvg, commissionPctAvg, storageAvg, acceptanceAvg, acquiringAvg,
     *   returnLogisticsAvg, salesQty, returnsQty, revenue, windowDays, updatedAt }
     */
    loadFactCosts() {
      const d = readJson(factCostsPath, { items: {}, meta: {} });
      return { items: isObject(d.items) ? d.items : {}, meta: isObject(d.meta) ? d.meta : {} };
    },

    saveFactCosts(items, meta) {
      const data = {
        items: isObject(items) ? items : {},
        meta: Object.assign({}, api.loadFactCosts().meta, isObject(meta) ? meta : {}, { updatedAt: new Date().toISOString() })
      };
      writeJson(factCostsPath, data);
      return data;
    },

    clearFactCosts() {
      writeJson(factCostsPath, { items: {}, meta: { clearedAt: new Date().toISOString() } });
      return { items: {}, meta: {} };
    },

    // ─────────── Выход из акций (ожидает возврата цены) ───────────

    /**
     * nmID → { promoId, promoName, raisedTo, restoreBase, restoreDiscount, at, status }
     * WB не даёт выйти из акции через API, поэтому выход делается повышением цены
     * выше плановой; после фактического выхода цену нужно вернуть — список ведётся здесь.
     */
    loadPromoExits() {
      const d = readJson(promoExitsPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    savePromoExits(items) {
      writeJson(promoExitsPath, { items: isObject(items) ? items : {}, updatedAt: new Date().toISOString() });
      return items;
    },

    // ─────────── Списки товаров акций, загруженные пользователем вручную ───────────

    /**
     * promoId → { fileName, at, count, items: [{ nmID, vendorCode, title, planPrice, planDiscount, inAction }] }
     *
     * Зачем: календарь акций WB отдаёт по API состав акции не всегда и не для всех типов акций
     * (автоакции через API не управляются), а список товаров для акции продавец может выгрузить
     * из кабинета файлом. Загруженный файл становится источником правды по составу акции —
     * репрайсер видит эти товары и работает с ними наравне с полученными по API.
     */
    loadPromoNoms() {
      const d = readJson(promoNomsPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    savePromoNoms(items) {
      writeJson(promoNomsPath, { items: isObject(items) ? items : {}, updatedAt: new Date().toISOString() });
      return items;
    },

    // ─────────── Черновики цен («сохранить без отправки в WB») ───────────

    /**
     * Введённые руками цены, которые ещё НЕ отправлены в WB.
     *
     * Без этого черновика ручной ввод жил только в памяти интерфейса и исчезал
     * при перезапуске или обновлении данных из кабинета — пользователь видел,
     * как введённые цифры «сбрасываются по нулям».
     *
     * @returns {object} nmID → { basePrice, discount, note, savedAt }
     */
    loadPriceDrafts() {
      const d = readJson(priceDraftsPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    savePriceDrafts(items) {
      const clean = {};
      for (const [k, v] of Object.entries(isObject(items) ? items : {})) {
        if (!v) continue;
        const basePrice = Number(v.basePrice) || 0;
        const discount = Number(v.discount) || 0;
        clean[String(k)] = {
          basePrice,
          discount,
          // цена со скидкой считается сразу: по ней черновик сравнивают с ценой в WB
          sellerPrice: Number(v.sellerPrice) || Math.round(basePrice * (1 - discount / 100) * 100) / 100,
          note: String(v.note || ''),
          savedAt: v.savedAt || new Date().toISOString()
        };
      }
      writeJson(priceDraftsPath, { items: clean, updatedAt: new Date().toISOString() });
      return clean;
    },

    clearPriceDrafts() {
      writeJson(priceDraftsPath, { items: {}, updatedAt: new Date().toISOString() });
      return {};
    },

    // ─────────── Предложения репрайсера (двухфазный автоцикл) ───────────

    /**
     * Фаза 1 автоцикла только СЧИТАЕТ и кладёт предложение сюда: фактические цены
     * не меняются, пока не наступит фаза 2 (отправка) или пользователь не нажмёт
     * «Отправить сейчас». Так пересчёт не затирает то, что уже установлено.
     *
     * @returns {{at: string|null, sendAt: string|null, phase: string, summary: object, items: Array}}
     */
    loadProposals() {
      const d = readJson(proposalsPath, null);
      if (!isObject(d)) return { at: null, sendAt: null, phase: 'idle', summary: {}, items: [], blocked: [], blockedTotal: 0 };
      return {
        at: d.at || null,
        sendAt: d.sendAt || null,
        sentAt: d.sentAt || null,
        staleCount: Number(d.staleCount) || 0,
        phase: d.phase || 'idle',
        summary: isObject(d.summary) ? d.summary : {},
        items: Array.isArray(d.items) ? d.items : [],
        blocked: Array.isArray(d.blocked) ? d.blocked : [],
        blockedTotal: Number(d.blockedTotal) || 0,
        note: d.note || ''
      };
    },

    saveProposals(data) {
      const d = isObject(data) ? data : {};
      writeJson(proposalsPath, {
        at: d.at || new Date().toISOString(),
        sendAt: d.sendAt || null,
        sentAt: d.sentAt || null,
        staleCount: Number(d.staleCount) || 0,
        phase: d.phase || 'proposed',
        summary: isObject(d.summary) ? d.summary : {},
        items: Array.isArray(d.items) ? d.items.slice(0, 20000) : [],
        // товары, которые репрайсер не предложил к отправке из-за незаполненных данных
        blocked: Array.isArray(d.blocked) ? d.blocked.slice(0, 500) : [],
        blockedTotal: Number(d.blockedTotal) || 0,
        note: d.note || ''
      });
      return api.loadProposals();
    },

    clearProposals() {
      writeJson(proposalsPath, { at: null, sendAt: null, phase: 'idle', summary: {}, items: [], blocked: [], blockedTotal: 0 });
      return api.loadProposals();
    },

    // ─────────── История пересчёта по конкретному артикулу ───────────

    /**
     * nmID → [{at, phase, basePrice, discount, sellerPrice, strategy, reason, sent}]
     * Фаза 'propose' — что предложил репрайсер, 'send' — что реально ушло в WB.
     */
    loadRecalcHistory() {
      const d = readJson(recalcHistoryPath, { items: {} });
      return isObject(d.items) ? d.items : {};
    },

    appendRecalcHistory(entries) {
      const items = api.loadRecalcHistory();
      const now = new Date().toISOString();
      for (const e of entries || []) {
        const k = String(e.nmID);
        if (!k || k === 'undefined') continue;
        const list = Array.isArray(items[k]) ? items[k] : [];
        list.push({
          at: e.at || now,
          phase: e.phase || 'propose',
          basePrice: Number(e.basePrice) || 0,
          discount: Number(e.discount) || 0,
          sellerPrice: Number(e.sellerPrice) || 0,
          prevSellerPrice: Number(e.prevSellerPrice) || 0,
          strategy: e.strategy || '',
          reason: e.reason || '',
          sent: !!e.sent
        });
        items[k] = list.slice(-60);
      }
      const keys = Object.keys(items);
      if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete items[k]);
      writeJson(recalcHistoryPath, { items });
      return items;
    },

    // ─────────── Журнал участия в акциях ───────────

    /**
     * Хронология действий с акциями: вход, выход, возврат цены после автоакции.
     *
     * Зачем отдельным файлом: очередь возврата (`promoexits.json`) хранит только
     * НЕЗАКРЫТЫЕ позиции — как только цена возвращена, запись исчезает, и журнал
     * «Журнал изменения участия в акциях» оставался пустым. Здесь история остаётся.
     *
     * @returns {Array<{at, nmID, vendorCode, title, action, promoId, promoName,
     *   priceBefore, priceAfter, reason, source, ok, error}>}
     */
    loadPromoJournal() {
      const d = readJson(promoJournalPath, { events: [] });
      return Array.isArray(d.events) ? d.events : [];
    },

    appendPromoJournal(entries) {
      const list = api.loadPromoJournal();
      const now = new Date().toISOString();
      for (const e of entries || []) {
        if (!e || !(Number(e.nmID) > 0)) continue;
        list.unshift({
          at: e.at || now,
          nmID: Number(e.nmID),
          vendorCode: e.vendorCode || '',
          title: e.title || '',
          action: e.action || 'exit',          // join | exit | restore | skip
          promoId: e.promoId ? Number(e.promoId) : null,
          promoName: e.promoName || '',
          promoStartAt: e.promoStartAt || '',
          promoEndAt: e.promoEndAt || '',
          forecast: e.forecast && typeof e.forecast === 'object' ? {
            profitMonthNow: e.forecast.profitMonthNow === null || e.forecast.profitMonthNow === undefined || e.forecast.profitMonthNow === ''
              ? null : (Number.isFinite(Number(e.forecast.profitMonthNow)) ? Number(e.forecast.profitMonthNow) : null),
            profitMonthWithPromo: e.forecast.profitMonthWithPromo === null || e.forecast.profitMonthWithPromo === undefined || e.forecast.profitMonthWithPromo === ''
              ? null : (Number.isFinite(Number(e.forecast.profitMonthWithPromo)) ? Number(e.forecast.profitMonthWithPromo) : null),
            salesUpliftPct: e.forecast.salesUpliftPct === null || e.forecast.salesUpliftPct === undefined || e.forecast.salesUpliftPct === ''
              ? null : (Number.isFinite(Number(e.forecast.salesUpliftPct)) ? Number(e.forecast.salesUpliftPct) : null),
            breakEvenUpliftPct: e.forecast.breakEvenUpliftPct === null || e.forecast.breakEvenUpliftPct === undefined || e.forecast.breakEvenUpliftPct === ''
              ? null : (Number.isFinite(Number(e.forecast.breakEvenUpliftPct)) ? Number(e.forecast.breakEvenUpliftPct) : null)
          } : null,
          priceBefore: Number(e.priceBefore) || 0,
          priceAfter: Number(e.priceAfter) || 0,
          reason: e.reason || '',
          source: e.source || 'repricer',
          ok: e.ok !== false,
          error: e.error || ''
        });
      }
      // журнал — не безразмерный: держим последние 5000 событий
      writeJson(promoJournalPath, { events: list.slice(0, 5000), updatedAt: now });
      return list.slice(0, 5000);
    },

    clearPromoJournal() {
      writeJson(promoJournalPath, { events: [], updatedAt: new Date().toISOString() });
      return [];
    }
  };

  return api;
}

module.exports = { createStore, DEFAULT_SETTINGS, deepMerge, readJson, writeJson };
