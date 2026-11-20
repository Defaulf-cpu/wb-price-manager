'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const WorkspaceConfig = require('./workspace-config');
const PriceSafety = require('./price-safety');
const { DEMO_KEY, TOKEN_SCOPES, RATE_FALLBACK_MS } = require('./config');
const { WBClient, WBError } = require('./wb-client');
const { createDemoApi } = require('./demo');
const RP = require('./repricer-engine');
const StatMath = require('./workspace-analytics');
const Boost = require('./boost-ladder');
const { createPriceWatcher } = require('./price-watcher');
const EC = require('./economics');
const PromoAnalytics = require('./promo-analytics');
const PromoImport = require('./promo-import');
const { observePromoPrice } = require('./promo-observation');
const { readTable } = require('./xlsx-lite');
const { buildXlsx } = require('./xlsx-write');
const { createBackupManager } = require('./backup');

const CACHE_TTL_MS = 120000;
const WB_SECRET_NAMES = Object.freeze(['single', 'universal', 'all', 'prices', 'statistics', 'content', 'finance', 'advert', 'analytics', 'marketplace', 'master']);

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  if (s.length <= 12) return s.slice(0, 3) + '•'.repeat(Math.max(3, s.length - 3));
  return s.slice(0, 6) + '•'.repeat(10) + s.slice(-4);
}

/** Дата в формате ГГГГ-ММ-ДД из любого представления (строка, Date, ISO с временем). */
function iso10(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Округление до копеек для записей журнала (значения могут прийти undefined). */
function U2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function daysAgoIso(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Слой бизнес-логики. Используется и Electron-процессом, и dev-сервером в браузере.
 *
 * @param {object} store   хранилище (настройки, себестоимости, секреты)
 * @param {function} emit   отправка событий в UI: emit(channel, payload)
 */
function createService(store, emit, electron, integrations) {
  const sendEvent = typeof emit === 'function' ? emit : () => {};
  const hooks = integrations || {};
  const backupManager = hooks.backupManager || (store.dir ? createBackupManager({
    store, appVersion: (electron && electron.appVersion) || require('../package.json').version
  }) : null);
  const telegram = hooks.telegramNotifier || null;
  let disposed = false;
  let activeHandlers = 0;
  let backgroundJobs = 0;
  const notify = (channel, payload) => {
    if (disposed) return;
    try { sendEvent(channel, payload); } catch (_) { /* интерфейсный слушатель не должен прерывать бизнес-операцию */ }
    try { if (telegram && typeof telegram.handleServiceEvent === 'function') telegram.handleServiceEvent(channel, payload); } catch (_) {}
  };
  const priceWatcher = createPriceWatcher({
    store,
    electron,
    log: (entry) => notify('log', entry),
    onCompetitorPriceChange: (entry) => notify('app-event', Object.assign({ type: 'competitorPrice' }, entry))
  });

  let officialSpp = {}, officialSppContext = '', boostOrders = null, boostOrdersPending = null;
  const priceJobContext = new AsyncLocalStorage();
  let priceJobRunning = null;
  let demoApi = null;
  let client = null;
  let clientSignature = '';
  let catalogEpoch = 0, catalogSnapshot = null, catalogPending = null, catalogRequest = 0;
  const cache = { goods: null, goodsAt: 0, stats: null, statsAt: 0, statsErrors: [], statsMeta: null, cards: null, cardsAt: 0, stocks: null, stocksAt: 0, stocksMeta: null };
  const sched = { timer: null, nextRunAt: null, lastRun: null, running: false };
  let promoLifecycleReady = false;
  let promoLifecycle = new Map();
  let lowStockNotified = new Set();

  async function priceJob(work) {
    const owner = priceJobContext.getStore();
    if (owner && owner === priceJobRunning) return work(owner);
    if (priceJobRunning) throw new WBError('Другая отправка уже выполняется. Дождитесь её результата.', { code: 'PRICE_BUSY' });
    const job = { context: businessContext() }; priceJobRunning = job;
    try { return await priceJobContext.run(job, () => work(job)); }
    finally { if (priceJobRunning === job) priceJobRunning = null; }
  }

  function assertPriceContext(context) {
    if (disposed || context !== businessContext()) throw new WBError('Кабинет, ключ или режим изменился. Отправка остановлена, выполните новый расчёт.', { code: 'PRICE_CONTEXT_CHANGED' });
  }

  function getSettings() {
    const settings = store.loadSettings();
    if (!settings.shopName && typeof hooks.profileName === 'function') return { ...settings, shopName: hooks.profileName() };
    return settings;
  }

  function isDemo() {
    const s = getSettings();
    if (s.demoMode) return true;
    const secrets = store.loadSecrets();
    return !WB_SECRET_NAMES.some((name) => secrets[name] && secrets[name] !== DEMO_KEY);
  }

  function getDemo() {
    if (!demoApi) demoApi = createDemoApi();
    return demoApi;
  }

  function getClient(force) {
    const s = getSettings();
    const secrets = store.loadSecrets();
    const wbSecretNames = WB_SECRET_NAMES.filter((name) => secrets[name]);
    const sig = crypto.createHash('sha256').update(JSON.stringify({ s: !!s.sandbox, k: wbSecretNames.sort().map((name) => [name, String(secrets[name])]) })).digest('hex');
    if (!force && client && sig === clientSignature) return client;
    clientSignature = sig;
    client = new WBClient({
      keys: secrets,
      sandbox: !!s.sandbox,
      onLog: (entry) => notify('log', entry)
    });
    return client;
  }

  function invalidateGoodsCache() {
    cache.goods = null; cache.goodsAt = 0;
    catalogSnapshot = null; catalogRequest++; catalogPending = null;
  }

  /** Контекст никогда не содержит открытого ключа в ответах/журнале. */
  function catalogContext() {
    const settings = getSettings(), secrets = store.loadSecrets();
    return crypto.createHash('sha256').update(JSON.stringify({
      profile: hooks.profileId || store.dir || 'single', epoch: catalogEpoch,
      demo: isDemo(), sandbox: !!settings.sandbox,
      keys: WB_SECRET_NAMES.map((name) => [name, String(secrets[name] || '')])
    })).digest('hex');
  }

  /** Стабильный после перезапуска, но разный для ключа/профиля/demo/sandbox. */
  function businessContext() {
    const settings = getSettings(), secrets = store.loadSecrets();
    return crypto.createHash('sha256').update(JSON.stringify({ profile: hooks.profileId || store.dir || 'single', demo: isDemo(), sandbox: !!settings.sandbox, keys: WB_SECRET_NAMES.map((name) => [name, String(secrets[name] || '')]) })).digest('hex');
  }

  function assertCatalogContext(context) {
    if (disposed || context !== catalogContext()) throw new WBError(
      'Кабинет, ключ или режим данных изменился во время проверки. Откройте предпросмотр заново; прежние условия не изменены.',
      { code: 'PROMO_CABINET_CHANGED' });
  }

  function assertCatalogCurrent(catalog) {
    assertCatalogContext(catalog.context);
    if (catalog.request !== catalogRequest) throw new WBError(
      'Каталог обновляется или изменился во время проверки. Дождитесь обновления и повторите предпросмотр; прежние условия не изменены.',
      { code: 'PROMO_CATALOG_CHANGED' });
  }

  /** Только чтение WB; не пишет состав, настройки, историю или задачи отправки. */
  async function loadGoodsCatalog(options) {
    const o = options || {}, context = catalogContext(), now = Date.now();
    if (!o.force && catalogSnapshot && catalogSnapshot.context === context && now - catalogSnapshot.at < CACHE_TTL_MS &&
        (!o.requireComplete || catalogSnapshot.complete)) return catalogSnapshot;
    if (!o.force && catalogPending && catalogPending.context === context &&
        (!o.requireComplete || catalogPending.full)) return catalogPending.promise;
    if (o.force) catalogSnapshot = null; // не возвращаем прошлую проверку после неудачного явного обновления
    const request = ++catalogRequest, demo = isDemo(), api = demo ? getDemo() : getClient();
    const maxItems = o.maxItems || 100000;
    const promise = (async () => {
      const result = await api.getGoods({ maxItems });
      assertCatalogContext(context);
      if (!result || !Array.isArray(result.items)) throw new WBError('Не удалось получить каталог текущего кабинета.', { code: 'BAD_CATALOG' });
      const ids = new Set();
      for (const item of result.items) {
        const nm = Number(item && item.nmID);
        if (!Number.isSafeInteger(nm) || nm <= 0 || ids.has(nm)) throw new WBError('Каталог содержит некорректные или повторяющиеся nmID. Проверка остановлена.', { code: 'BAD_CATALOG' });
        ids.add(nm);
      }
      const snapshot = { ...result, context, request, at: Date.now(), ids,
        complete: result.complete === true && result.truncated !== true && result.scope === 'full' && result.source === (demo ? 'demo' : 'wb') &&
          (!result.totalKnown || Number(result.total) === result.items.length) };
      // Более поздний force-запрос не затирается запоздавшим старым ответом.
      assertCatalogCurrent(snapshot);
      catalogSnapshot = snapshot;
      return snapshot;
    })();
    catalogPending = { context, full: maxItems >= 100000, promise };
    try { return await promise; }
    finally { if (catalogPending && catalogPending.promise === promise) catalogPending = null; }
  }

  async function ownershipCatalog() {
    let catalog;
    try { catalog = await loadGoodsCatalog({ requireComplete: true }); }
    catch (error) {
      if (['PROMO_CABINET_CHANGED', 'PROMO_CATALOG_CHANGED'].includes(error.code)) throw error;
      throw new WBError('Не удалось проверить принадлежность товаров текущему кабинету: каталог WB недоступен. ' +
        (error.message || '') + ' Повторите после обновления каталога. Прежние условия не изменены.', { code: 'PROMO_CATALOG_UNAVAILABLE' });
    }
    assertCatalogCurrent(catalog);
    if (!catalog.complete) throw new WBError('Принадлежность товаров не проверена: каталог текущего кабинета загружен не полностью (' +
      catalog.items.length + ' товаров; ' + (catalog.completionReason || 'нет подтверждения полноты') + '). Обновите каталог и повторите импорт. Прежние условия не изменены.',
      { code: 'PROMO_CATALOG_INCOMPLETE' });
    return catalog;
  }

  function matchPromoOwnership(items, catalog) {
    const matched = [], excluded = [];
    for (const item of items || []) {
      if (catalog.ids.has(Number(item.nmID))) matched.push(item);
      else excluded.push({ ...item, reasonCode: 'NOT_IN_CABINET', reason: 'nmID отсутствует в полном каталоге текущего кабинета' });
    }
    return { matched, excluded };
  }

  function costsMap() {
    return (store.loadCosts() || {}).items || {};
  }

  /** Валюты, для которых можно задать курс себестоимости (список для интерфейса). */
  const COST_CURRENCIES = ['RUB', 'CNY', 'USD', 'EUR', 'TRY', 'KZT', 'BYN', 'UZS', 'AED', 'PLN'];
  const isCostCurrency = (currency) => /^[A-Z]{3}$/.test(String(currency || '').trim().toUpperCase());

  /**
   * Курс валюты себестоимости (задание D): сколько ₽ стоит 1 единица валюты.
   * Курсы живут в настройках (`settings.costRates`) и правятся на вкладке «Параметры»
   * репрайсера — рядом с себестоимостью, чтобы не проваливаться в другой раздел.
   * @returns {number} курс; 1 для ₽; 0 — если курс для валюты не задан
   */
  function costRateOf(currency) {
    const cur = String(currency || '').trim().toUpperCase();
    if (!cur || cur === 'RUB') return 1;
    const rates = getSettings().costRates || {};
    const r = Number(rates[cur]);
    return Number.isFinite(r) && r > 0 ? r : 0;
  }

  /**
   * costEntered — введённая сумма в валюте закупки; costPriceRub — только
   * пересчитанная рублёвая сумма. Старые записи без costEntered мигрируют
   * в памяти/при следующем сохранении: их costPriceRub один раз считается
   * введённым значением, а не уже пересчитанными рублями.
   */
  function normalizeCostRecord(existing, patchInput) {
    const patch = WorkspaceConfig.costPatch(patchInput || {});
    const out = { ...patch };
    const old = existing || {};
    if (out.currency !== undefined && out.currency !== null && String(out.currency).trim()) {
      out.currency = String(out.currency).trim().toUpperCase();
      if (!isCostCurrency(out.currency)) throw new WBError('Неизвестная валюта закупки «' + out.currency + '».', { code: 'BAD_CURRENCY' });
    }
    const currency = String(out.currency || old.currency || 'RUB').trim().toUpperCase() || 'RUB';
    const has = (key) => Object.prototype.hasOwnProperty.call(out, key);
    let entered;
    if (has('costEntered')) entered = out.costEntered;
    else if (has('costPriceRub')) {
      entered = out.costPriceRub;
      // Защита от «кривого»/старого клиента: если прислали уже пересчитанные
      // рубли с той же валютой, это не новое введённое значение.
      if (currency !== 'RUB' && entered !== null && entered !== undefined && entered !== '') {
        const rate = costRateOf(currency);
        const oldCurrency = String(old.currency || 'RUB').trim().toUpperCase() || 'RUB';
        const oldEntered = old.costEntered !== undefined && old.costEntered !== null && old.costEntered !== '' ? old.costEntered : (oldCurrency === currency ? old.costPriceRub : undefined);
        const oldRub = oldEntered !== undefined && oldEntered !== null && oldEntered !== '' && rate > 0 ? Math.round(Number(oldEntered) * rate * 100) / 100 : null;
        if (oldRub !== null && Math.abs(Number(entered) - oldRub) < 0.005) entered = oldEntered;
      }
    } else if (has('currency')) {
      entered = old.costEntered !== undefined && old.costEntered !== null && old.costEntered !== '' ? old.costEntered : old.costPriceRub;
    }
    if (entered !== undefined) {
      if (entered === '') entered = null;
      if (entered !== null && (!Number.isFinite(Number(entered)) || Number(entered) < 0)) throw new WBError('Себестоимость должна быть неотрицательным числом в валюте закупки.', { code: 'BAD_COST' });
      out.costEntered = entered === null ? null : Number(entered);
      if (entered === null) out.costPriceRub = null;
      else {
        const rate = currency === 'RUB' ? 1 : costRateOf(currency);
        out.costPriceRub = rate > 0 ? Math.round(Number(entered) * rate * 100) / 100 : 0;
      }
      out.costVersion = 2;
    }
    return out;
  }

  function overridesFor(goods) {
    const costs = costsMap();
    const out = {};
    for (const g of goods) {
      const key = String(g.nmID);
      const c = costs[key] || {};
      out[key] = {
        costPriceRub: c.costPriceRub,
        costEntered: c.costEntered,
        stock: c.stock,
        salesPerDay: c.salesPerDay,
        // валюта, в которой введена себестоимость (задание D): ₽ — по умолчанию
        currency: c.currency ? String(c.currency).trim().toUpperCase() : undefined,
        commissionPct: c.commissionPct,
        logisticsRub: c.logisticsRub,
        acceptRub: c.acceptRub,
        storageRub: c.storageRub,
        packagingRub: c.packagingRub,
        adPct: c.adPct,
        adRub: c.adRub, otherPct: c.otherPct, otherRub: c.otherRub,
        taxMode: c.taxMode,
        taxRatePct: c.taxRatePct,
        acquiringPct: c.acquiringPct,
        sppPct: c.sppPct,
        volumeLiters: c.volumeLiters,
        basePrice: c.basePrice,
        discountPct: c.discountPct,
        model: c.model,
        note: c.note,
        updatedAt: c.updatedAt,
        source: (c.costEntered !== undefined && c.costEntered !== null && c.costEntered !== '') || (c.costPriceRub !== undefined && c.costPriceRub !== null && c.costPriceRub !== '') ? 'user' : 'none'
      };
      /**
       * Себестоимость в валюте закупки пересчитываем в рубли: в расчёты и в WB
       * всегда уходит рублёвое значение, а исходная валюта, курс и введённое
       * число остаются рядом — их показывает колонка «Себестоимость».
       * Если курс валюты не задан, себестоимость обнуляется и строка получает
       * явную ошибку вместо тихого расчёта по курсу 1:1.
       */
      const o = out[key];
      const cur = o.currency;
      const entered = o.costEntered !== undefined && o.costEntered !== null && o.costEntered !== '' ? o.costEntered : o.costPriceRub;
      o.costEntered = entered;
      if (cur && cur !== 'RUB') {
        const rate = costRateOf(cur);
        o.costCurrency = cur;
        o.costRate = rate;
        if (entered !== undefined && entered !== null && entered !== '') {
          if (rate > 0) o.costPriceRub = Math.round(Number(entered) * rate * 100) / 100;
          else {
            o.costPriceRub = 0;
            o.costError = 'не задан курс ' + cur + ' — укажите его на вкладке «Параметры»';
          }
        }
      } else if (entered !== undefined) {
        o.costPriceRub = entered;
      }
    }
    return out;
  }

  function mergeDemoOverrides(items, overrides) {
    const demo = getDemo();
    for (const g of items) {
      const key = String(g.nmID);
      const o = overrides[key] = overrides[key] || {};
      const d = demo.demoOverrides(g.nmID);
      for (const [k, v] of Object.entries(d)) {
        if (o[k] === undefined || o[k] === null || o[k] === '') o[k] = v;
      }
      o.source = o.source === 'user' ? 'user' : 'demo';
    }
    return overrides;
  }

  // ─────────── Фактические расходы из отчёта о реализации WB ───────────

  /**
   * Фактические данные по товару: расходы из финансового отчёта WB + средний СПП
   * из статистики продаж.
   *
   * Зачем смешивать: в каждой строке статистики WB (`/api/v1/supplier/sales`) есть поле
   * `spp` — реальная скидка постоянного покупателя по конкретной продаже. Агрегат
   * `avgSppPct` уже считается, но раньше использовался только в прогнозе акций,
   * а экономика брала СПП из общей настройки. Теперь реальный СПП доходит до расчёта
   * цены покупателю, стратегии «Удержание РРЦ» и отстройки от конкурента.
   *
   * Для товара без строк финансового отчёта создаётся запись только с СПП — расходы
   * при этом остаются нулевыми и в расчёт не попадают.
   */
  function factsMap() {
    const items = Object.assign({}, (store.loadFactCosts() || {}).items || {});
    const stats = cache.stats || [];
    for (const st of stats) {
      const nm = String(st.nmID);
      const spp = Number(st.avgSppPct || 0);
      if (!(spp > 0) && !(st.sppSamples > 0 && spp === 0)) continue;
      const rec = items[nm] || (items[nm] = { nmID: st.nmID, salesQty: 0 });
      rec.sppPctAvg = spp;
      // сколько продаж легло в среднее — видно в интерфейсе как достоверность цифры
      rec.sppSalesQty = Number(st.salesQty || 0);
    }
    restoreOfficialSpp();
    for (const [nm, sample] of Object.entries(officialSpp)) {
      const rec = items[nm] || (items[nm] = { nmID: Number(nm), salesQty: 0 });
      rec.sppPctOfficial = sample.pct; rec.sppOfficialAt = sample.at; rec.sppOfficialReceivedAt = sample.receivedAt || ''; rec.sppOfficialSource = sample.source;
    }
    // Наблюдение витрины WB (модуль price-watcher): медиана СПП за 7 дней.
    // Товар может не иметь продаж в окне статистики, но наблюдение у него есть —
    // поэтому не пропускаем такие записи, а создаём их.
    const since = Date.now() - 7 * 86400000;
    const watch = store.loadPriceWatch() || {};
    for (const nm of Object.keys(watch)) {
      // считаем только записи с реально известным СПП: null (например, наблюдение без цены
      // покупателю) числом не является, хотя Number(null) и дал бы ноль
      const rows = (watch[nm] || []).filter((r) => {
        const v = r && r.sppPct;
        if (v === null || v === undefined || v === '') return false;
        const n = Number(v), t = Date.parse(r && r.at);
        return Number.isFinite(n) && Number.isFinite(t) && t >= since && n >= 0 && n <= 100;
      });
      if (!rows.length) continue;
      const spp = priceWatcher.sppForEconomics(nm);
      if (spp === null || spp === undefined) continue;
      const rec = items[nm] || (items[nm] = { nmID: Number(nm), salesQty: 0 });
      rec.sppPctWatch = spp;
      // сколько замеров легло в медиану и когда был последний — видно как достоверность цифры
      rec.sppWatchSamples = rows.length;
      rec.sppWatchAt = rows[rows.length - 1].at;
    }
    return items;
  }

  /**
   * Агрегирует строки финансового отчёта WB → средние расходы на одну продажу по нм-коду.
   * Логистика и комиссия у WB плавающие (склад, коэффициент, доначисления), поэтому
   * берём среднее за окно и учитываем стоимость возвратов: возврат тоже стоит логистики.
   */
  function aggregateFactCosts(rows, windowDays) {
    const agg = {};
    const byDay = {};
    const byItemDay = {};
    const n2 = (v) => { const x = Number(String(v === undefined || v === null ? '' : v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
    const addItemDay = (r, nm, date) => {
      if (!date) return;
      const day = byItemDay[date] || (byItemDay[date] = {});
      const d = day[String(nm)] || (day[String(nm)] = { nmID: nm, date,
        salesQty: 0, returnsQty: 0, revenueTotal: 0, commissionTotal: 0,
        logisticsTotal: 0, storageTotal: 0, acceptanceTotal: 0, acquiringTotal: 0,
        penaltyTotal: 0, deductionTotal: 0, forPayTotal: 0, forPayKnown: true,
        sppWeightedTotal: 0, sppCount: 0 });
      const qty = Math.abs(n2(r.quantity)) || 1;
      const returned = !!r.isReturn;
      const sale = !r.isLogistics && !returned && r.isSale !== false;
      d.logisticsTotal += returned ? (n2(r.returnLogistics) || n2(r.logistics)) : n2(r.logistics);
      d.storageTotal += n2(r.storage); d.acceptanceTotal += n2(r.acceptance);
      d.penaltyTotal += n2(r.penalty); d.deductionTotal += n2(r.deduction);
      if (!sale && !returned) return; // хранение/логистика не становятся продажей 1 шт.
      if (returned) d.returnsQty += qty; else d.salesQty += qty;
      const revenue = n2(r.retailAmount) || n2(r.retailPriceWithDisc) * qty || n2(r.retailPrice) * qty;
      const commission = n2(r.commission) || revenue * n2(r.commissionPercent) / 100;
      d.revenueTotal += returned ? -Math.abs(revenue) : revenue;
      d.commissionTotal += returned ? -Math.abs(commission) : commission;
      d.acquiringTotal += returned ? -Math.abs(n2(r.acquiring)) : n2(r.acquiring);
      d.forPayTotal += returned ? -Math.abs(n2(r.forPay)) : n2(r.forPay);
      if (r.forPayKnown === false || !Object.prototype.hasOwnProperty.call(r, 'forPay')) d.forPayKnown = false;
      const knownSpp = r.sppKnown === undefined ? r.spp !== undefined && r.spp !== null && r.spp !== '' : r.sppKnown;
      if (!returned && knownSpp) { d.sppWeightedTotal += n2(r.spp) * qty; d.sppCount += qty; }
    };

    for (const r of rows || []) {
      const nm = Number(r.nmId || r.nmID || 0);
      if (!nm) continue;
      const a = agg[nm] || (agg[nm] = {
        nmID: nm, salesQty: 0, returnsQty: 0, logisticsQty: 0,
        logisticsTotal: 0, returnLogisticsTotal: 0, commissionTotal: 0, revenueTotal: 0, forPayKnown: true,
        storageTotal: 0, acceptanceTotal: 0, acquiringTotal: 0, penaltyTotal: 0, deductionTotal: 0,
        forPayTotal: 0, firstDate: '', lastDate: ''
      });
      const d = String(r.date || '');
      if (d) {
        if (!a.firstDate || d < a.firstDate) a.firstDate = d;
        if (d > a.lastDate) a.lastDate = d;
      }
      const qty = n2(r.quantity) || 1;
      const logistics = n2(r.logistics);
      addItemDay(r, nm, d);

      if (r.isReturn) {
        const returnLogistics = n2(r.returnLogistics) || logistics;
        a.returnsQty += qty;
        a.returnLogisticsTotal += returnLogistics;
        const rev = n2(r.retailAmount) || n2(r.retailPriceWithDisc) * qty || n2(r.retailPrice) * qty;
        const commission = n2(r.commission) || rev * n2(r.commissionPercent) / 100;
        a.revenueTotal -= Math.abs(rev);
        a.commissionTotal -= Math.abs(commission);
        a.acquiringTotal -= Math.abs(n2(r.acquiring));
        a.forPayTotal -= Math.abs(n2(r.forPay));
        if (r.forPayKnown === false || !Object.prototype.hasOwnProperty.call(r, 'forPay')) a.forPayKnown = false;
        if (d) {
          const day = byDay[d] || (byDay[d] = {
            date: d, salesQty: 0, returnsQty: 0, revenueTotal: 0, commissionTotal: 0,
            logisticsTotal: 0, storageTotal: 0, acquiringTotal: 0, forPayTotal: 0
          });
          day.returnsQty += qty;
          day.logisticsTotal += returnLogistics;
          day.revenueTotal -= Math.abs(rev);
          day.commissionTotal -= Math.abs(commission);
          day.acquiringTotal -= Math.abs(n2(r.acquiring));
          day.forPayTotal -= Math.abs(n2(r.forPay));
        }
        continue;
      }
      if (r.isLogistics) {           // отдельные строки «Логистика» без привязки к продаже
        a.logisticsTotal += logistics;
        a.logisticsQty += qty;
        continue;
      }
      a.salesQty += qty;
      const revenue = n2(r.retailAmount) || n2(r.retailPriceWithDisc) * qty || n2(r.retailPrice) * qty;
      a.revenueTotal += revenue;
      a.logisticsTotal += logistics;
      a.storageTotal += n2(r.storage);
      a.acceptanceTotal += n2(r.acceptance);
      a.acquiringTotal += n2(r.acquiring);
      a.penaltyTotal += n2(r.penalty);
      a.deductionTotal += n2(r.deduction);
      a.forPayTotal += n2(r.forPay);
      if (r.forPayKnown === false || !Object.prototype.hasOwnProperty.call(r, 'forPay')) a.forPayKnown = false;
      const commission = n2(r.commission) || (revenue * n2(r.commissionPercent) / 100);
      a.commissionTotal += commission;
      // разбивка по дням — для динамики в отчёте P&L
      if (d) {
        const day = byDay[d] || (byDay[d] = {
          date: d, salesQty: 0, returnsQty: 0, revenueTotal: 0, commissionTotal: 0,
          logisticsTotal: 0, storageTotal: 0, acquiringTotal: 0, forPayTotal: 0
        });
        day.salesQty += qty;
        day.revenueTotal += revenue;
        day.commissionTotal += commission;
        day.logisticsTotal += logistics;
        day.storageTotal += n2(r.storage);
        day.acquiringTotal += n2(r.acquiring);
        day.forPayTotal += n2(r.forPay);
      }
    }

    const r2 = (v) => Math.round(v * 100) / 100;
    const out = {};
    for (const a of Object.values(agg)) {
      if (!(a.salesQty > 0)) continue;
      out[String(a.nmID)] = {
        nmID: a.nmID,
        salesQty: a.salesQty,
        returnsQty: a.returnsQty,
        // средняя логистика на одну продажу — с учётом стоимости возвратов
        logisticsAvg: r2((a.logisticsTotal + a.returnLogisticsTotal) / a.salesQty),
        logisticsSaleAvg: r2(a.logisticsTotal / a.salesQty),
        returnLogisticsAvg: a.returnsQty > 0 ? r2(a.returnLogisticsTotal / a.returnsQty) : 0,
        commissionPctAvg: a.revenueTotal > 0 ? r2((a.commissionTotal / a.revenueTotal) * 100) : 0,
        commissionAvg: r2(a.commissionTotal / a.salesQty),
        storageAvg: r2(a.storageTotal / a.salesQty),
        acceptanceAvg: r2(a.acceptanceTotal / a.salesQty),
        acquiringPctAvg: a.revenueTotal > 0 ? r2((a.acquiringTotal / a.revenueTotal) * 100) : 0,
        returnSharePct: (a.salesQty + a.returnsQty) > 0 ? r2((a.returnsQty / (a.salesQty + a.returnsQty)) * 100) : 0,
        revenueAvg: r2(a.revenueTotal / a.salesQty),
        // суммы за окно — из них собирается отчёт P&L (средние для этого не годятся)
        revenueTotal: r2(a.revenueTotal),
        commissionTotal: r2(a.commissionTotal),
        logisticsTotal: r2(a.logisticsTotal + a.returnLogisticsTotal),
        storageTotal: r2(a.storageTotal),
        acceptanceTotal: r2(a.acceptanceTotal),
        acquiringTotal: r2(a.acquiringTotal),
        penaltyTotal: r2(a.penaltyTotal),
        deductionTotal: r2(a.deductionTotal),
        forPayTotal: r2(a.forPayTotal),
        forPayKnown: a.forPayKnown !== false,
        windowDays: Number(windowDays) || 0,
        firstDate: a.firstDate,
        lastDate: a.lastDate,
        updatedAt: new Date().toISOString()
      };
    }
    // Разбивку по дням и товарам храним отдельно: она нужна аналитике акций,
    // но не должна попадать в карту товаров, которую считают другие отчёты.
    return { items: out, byDay, byItemDay };
  }

  // Чтение выгрузки вынесено в promo-import.js; штрихкоды не угадываются как nmID.

  // ─────────── Индекс акций: кто участвует, кто подходит, плановые цены ───────────

  let promoRevision = 0;
  const promoCache = { at: 0, index: null, promos: [], noApi: {}, hardErrors: [] };
  const PROMO_TTL_MS = 15 * 60000;

  /**
   * WB отдаёт состав акции (`/calendar/promotions/nomenclatures`) ТОЛЬКО для обычных акций:
   * в документации метод помечен «Not applicable for auto promotions», а на практике отвечает
   * HTTP 422 «Unprocessable entity». Раньше состав спрашивали у каждой акции дважды
   * (участники и кандидаты) и на каждую ошибку слали предупреждение в интерфейс — у пользователя
   * тосты сыпались непрерывно, а лимит календаря (10 запросов за 6 с) расходовался впустую.
   * Теперь:
   *  - у автоакций состав не запрашивается вообще;
   *  - ответ 422 считается «состав недоступен», а не ошибкой, и запоминается в кэше,
   *    чтобы повторный вход в раздел не долбил WB теми же запросами;
   *  - в интерфейс уходит ОДНО сводное сообщение, а не по одному на акцию.
   */
  /** Слияние, при котором пустые значения источника не затирают уже известные данные. */
  function mergeNonEmpty(base, extra) {
    const out = Object.assign({}, base || {});
    for (const [k, v] of Object.entries(extra || {})) {
      if (v === '' || v === null || v === undefined) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Автоакция: WB сам добавляет в неё товары и НЕ отдаёт состав через API
   * (документация: «Not applicable for auto promotions», на практике — HTTP 422).
   * Смотрим и `type`, и `joinType`, и исходный ответ WB — поле может прийти пустым.
   */
  function isAutoPromo(p) {
    if (!p) return false;
    const raw = p.raw || {};
    const t = String(p.type || raw.type || '').toLowerCase();
    const j = String(p.joinType || raw.joinType || '');
    return t === 'auto' || t === 'autoaction' || /авто/i.test(j) || /\bauto\b/i.test(j);
  }

  /** Нужен ли вывод состава по факту скидки товара (настройка, по умолчанию включено). */
  function st_promosInferEnabled() {
    try { return getSettings().promosInferFromDiscount !== false; } catch (e) { return true; }
  }

  function isNoCompositionError(e) {
    return Number(e && e.status) === 422 || /Unprocessable/i.test(String((e && e.message) || ''));
  }

  function trackPromoLifecycle(promos) {
    const now = Date.now();
    const next = new Map();
    for (const promo of Array.isArray(promos) ? promos : []) {
      if (!promo || promo.id === undefined || promo.id === null) continue;
      const start = Date.parse(promo.startDateTime || promo.startAt || '');
      const end = Date.parse(promo.endDateTime || promo.endAt || '');
      const status = Number.isFinite(end) && end <= now ? 'ended'
        : (Number.isFinite(start) && start <= now ? 'active' : 'upcoming');
      const id = String(promo.id);
      const previous = promoLifecycle.get(id);
      if (promoLifecycleReady && !isDemo() && previous && previous.status !== status) {
        if (previous.status === 'upcoming' && status === 'active') {
          notify('app-event', { type: 'promoStarted', id, name: promo.name || promo.promoName || '', startDateTime: promo.startDateTime, endDateTime: promo.endDateTime });
        } else if (previous.status === 'active' && status === 'ended') {
          notify('app-event', { type: 'promoEnded', id, name: promo.name || promo.promoName || '', endDateTime: promo.endDateTime });
        }
      }
      next.set(id, { status, name: String(promo.name || promo.promoName || '') });
    }
    const demoMode = isDemo();
    if (promoLifecycleReady && !demoMode) {
      // Акция могла исчезнуть из выдачи WB лишь после окончания: это тоже считаем завершением.
      for (const [id, previous] of promoLifecycle) {
        if (previous.status === 'active' && !next.has(id)) notify('app-event', { type: 'promoEnded', id, name: previous.name || '' });
      }
    }
    promoLifecycle = next;
    // Демо-календарь не становится базой сравнения для реального кабинета.
    promoLifecycleReady = !demoMode;
  }

  /** Единый состав для списка/таблицы акций и окна товаров; метрики не берут весь каталог. */
  function promoComposition(promo, idx, file) {
    const st = getSettings(), required = Number(promo.requiredDiscountPct || promo.participationPercentage || 0);
    const entries = new Map();
    const add = (nmID, data, source) => {
      const nm = Number(nmID);
      if (Number.isSafeInteger(nm) && nm > 0 && !entries.has(nm)) entries.set(nm, { nmID: nm, data, source });
    };
    if (file) (idx && idx.manualItems || []).forEach((row) => add(row.nmID, row, 'file'));
    else {
      if (st.promosFetchNomenclatures === true && !isAutoPromo(promo)) {
        (idx && idx.apiItems || []).forEach((row) => add(row.nmID, row, 'api'));
      }
      if (st.promosInferFromDiscount !== false && required > 0) {
        ((cache.goods && cache.goods.items) || []).forEach((g) => {
          if (g.inPromo || Number(g.discount || 0) + 0.0001 >= required || Number(g.plannedPrice) > 0 || Number(g.plannedDiscount) > 0) add(g.nmID, {}, 'inferred');
        });
      }
    }
    const apiUsed = !file && st.promosFetchNomenclatures === true && !isAutoPromo(promo) && !!(idx && idx.apiUsed);
    const values = Array.from(entries.values()), inferredCount = values.filter((entry) => entry.source === 'inferred').length;
    const apiCount = values.filter((entry) => entry.source === 'api').length;
    return { entries: values, inferredCount, apiCount, apiPartial: apiCount > 0 && !apiUsed,
      source: file ? 'file' : apiCount || apiUsed ? 'api' : inferredCount ? 'inferred' : 'none', apiUsed,
      apiError: !file && st.promosFetchNomenclatures === true ? idx && (idx.apiError || idx.noApi) || '' : '' };
  }

  async function promoIndex(force) {
    const revision = promoRevision, context = catalogContext();
    if (!force && promoCache.context === context && promoCache.index && promoCache.catalogRequest === catalogRequest &&
        Date.now() - promoCache.at < PROMO_TTL_MS && Date.now() < (promoCache.ownershipExpiresAt || Infinity)) return promoCache;
    const promoResponse = await handlers['wb:promos']({ days: 60 }).catch(() => null);
    assertCatalogContext(context);
    const promos = Array.isArray(promoResponse) ? promoResponse : [];
    // Сетевая ошибка не означает, что все акции закончились; обновляем базу только после валидного ответа.
    if (Array.isArray(promoResponse)) trackPromoLifecycle(promos);
    const uploadedNoms = store.loadPromoNoms();
    let catalog = null, ownershipError = '';
    if (Object.keys(uploadedNoms).length) {
      try { catalog = await ownershipCatalog(); }
      catch (error) { ownershipError = error.message; }
      assertCatalogContext(context);
    }
    /**
     * Состав акции выводится в том числе по факту скидки товара, поэтому список товаров
     * нужен всегда. Подгружаем его один раз, если кэш пуст (раздел «Акции» могли открыть
     * сразу после запуска). Это категория «Цены и скидки» — 10 запросов за 6 секунд,
     * в отличие от «Статистики» с её одним запросом в минуту.
     */
    if (!ownershipError && (st_promosInferEnabled() || Object.keys(uploadedNoms).length) && (!cache.goods || cache.goods.context !== context || !cache.goods.items.length || catalog && cache.goods.catalogAt !== new Date(catalog.at).toISOString())) {
      await handlers['wb:goods']({}).catch(() => null);
    }
    // явный «Обновить акции» сбрасывает память о недоступных акциях, обычный вход — нет
    const observedEvents = [], priceStateUpdates = [];
    const noApi = force ? {} : Object.assign({}, promoCache.noApi || {});
    const hardErrors = [];
    const index = {};
    for (const p of promos) {
      let inAction = [];
      let candidates = [];
      let noApiReason = '', apiFailed = false, apiError = '';
      /**
       * Пропускаем запрос состава только в БОЕВОМ режиме: настоящий WB на автоакцию
       * отвечает 422, и запрос всё равно бесполезен. Демо-набор состав отдаёт —
       * на нём отрабатывают авто-вход и авто-выход из акций.
       */
      /**
       * По умолчанию к WB за составом акции не ходим ВОВСЕ: метод помечен
       * «Not applicable for auto promotions» и отвечает 422 почти на любой акции,
       * а настоящий состав продавец скачивает файлом в кабинете.
       * Запросы включаются только настройкой promosFetchNomenclatures.
       */
      const wantApi = isDemo() || getSettings().promosFetchNomenclatures === true;
      if (!wantApi) {
        noApiReason = 'Состав берётся из файла кабинета WB — к API за ним не обращаемся';
      } else if (!isDemo() && isAutoPromo(p)) {
        noApiReason = 'Автоакция: WB не отдаёт состав через API — только файлом из кабинета';
      } else if (noApi[p.id]) {
        noApiReason = noApi[p.id];
      } else {
        try {
          inAction = await handlers['wb:promo-nomenclatures']({ promotionID: p.id, inAction: true });
        } catch (e) {
          if (isNoCompositionError(e)) noApiReason = 'WB не отдаёт состав этой акции (HTTP 422) — загрузите файлом из кабинета';
          else { apiFailed = true; apiError = e.message || String(e); hardErrors.push((p.name || p.id) + ': ' + apiError); }
        }
        if (!noApiReason) {
          try {
            candidates = await handlers['wb:promo-nomenclatures']({ promotionID: p.id, inAction: false });
          } catch (e) {
            if (isNoCompositionError(e)) noApiReason = 'WB не отдаёт состав этой акции (HTTP 422) — загрузите файлом из кабинета';
            else { apiFailed = true; apiError = e.message || String(e); hardErrors.push((p.name || p.id) + ': ' + apiError); }
          }
        }
      }
      if (noApiReason) noApi[p.id] = noApiReason;
      const manual = uploadedNoms[String(p.id)];
      // В том числе старые файлы проверяются заново. Метка прежнего импорта —
      // история, а не разрешение использовать nmID после смены ключа/кабинета.
      const ownershipMatch = manual && catalog ? matchPromoOwnership(manual.items, catalog) : { matched: [], excluded: [] };
      const manualItems = ownershipMatch.matched, manualIds = new Set(manualItems.map((x) => Number(x.nmID)));
      if (manual) {
        inAction = inAction.filter((x) => manualIds.has(Number(x.nmID)));
        candidates = candidates.filter((x) => manualIds.has(Number(x.nmID)));
      }
      const plan = new Map();
      const eligible = new Set();
      const isIn = new Set();
      inAction.forEach((x) => { isIn.add(Number(x.nmID)); eligible.add(Number(x.nmID)); plan.set(Number(x.nmID), Number(x.plannedPrice || x.planPrice || 0)); });
      candidates.forEach((x) => { eligible.add(Number(x.nmID)); plan.set(Number(x.nmID), Number(x.plannedPrice || x.planPrice || 0)); });

      // Список товаров, загруженный пользователем вручную из файла кабинета WB.
      // API отдаёт состав не для всех акций (автоакции не управляются вообще), поэтому
      // файл дополняет индекс: товары становятся известны репрайсеру вместе с плановой ценой.
      const observations = new Map();
      const managedIds = manual && manual.selectedOnly === true ? new Set((manual.selectedIds || []).map(Number).filter((nm) => manualIds.has(nm))) : null;
      if (manual && catalog) {
        const live = new Map(catalog.items.map((g) => [Number(g.nmID), g]));
        const confirmedByApi = new Set(inAction.map((x) => Number(x.nmID)));
        manualItems.forEach((x) => {
          const nm = Number(x.nmID); if (!(nm > 0)) return;
          eligible.add(nm);
          const target = Number(x.planPrice) || 0;
          if (target > 0) plan.set(nm, target); // условия из свежей выгрузки важнее старого кэша
          const observation = observePromoPrice(live.get(nm), target, p);
          observations.set(nm, observation);
          if (observation.known && observation.datesKnown && !observation.partial) {
            const previous = manual.priceStates && manual.priceStates[String(nm)];
            if (!previous || previous.status !== observation.status || previous.inAction !== observation.inAction) {
              priceStateUpdates.push({ id: String(p.id), nm, importedAt: manual.at, state: { inAction: observation.inAction, status: observation.status, at: observation.observedAt } });
              if (observation.inAction && (!previous || !previous.inAction) || !observation.inAction && previous && previous.inAction) {
                observedEvents.push({ nmID: nm, promoId: p.id, promoName: p.name, action: observation.inAction ? 'join' : 'exit',
                  at: observation.observedAt, ok: true, source: 'price-observation', promoStartAt: p.startDateTime, promoEndAt: p.endDateTime,
                  priceAfter: observation.maxPrice, reason: observation.inAction ? 'Наблюдение: все цены WB не выше порога акции; не подтверждение состава API.' : 'Наблюдение: цена выше порога или акция завершилась.' });
              }
            }
          }
          if (observation.known && observation.datesKnown) {
            if (observation.inAction) isIn.add(nm);
            else if (isDemo() || !confirmedByApi.has(nm)) isIn.delete(nm);
          } else if (x.inActionKnown !== false && x.inAction) isIn.add(nm);
        });
      }

      /**
       * Если файла по акции нет, состав всё равно можно оценить по самим товарам:
       * WB не сообщает, в какой именно акции товар, но факт скидки и плановая цена
       * из /api/v2/list/goods/filter есть. Товар со скидкой ≥ требуемой удовлетворяет
       * условиям акции — это и есть «участвует» с точки зрения WB.
       */
      let inferred = 0;
      const required = Number(p.requiredDiscountPct || p.participationPercentage || 0);
      if (!manual && getSettings().promosInferFromDiscount !== false && required > 0) {
        const goods = ((cache.goods && cache.goods.items) || []);
        goods.forEach((g) => {
          const nm = Number(g.nmID);
          if (!(nm > 0)) return;
          const disc = Number(g.discount) || 0;
          const planPrice = Number(g.plannedPrice) || 0;
          const planDisc = Number(g.plannedDiscount) || 0;
          // плановая цена/скидка из кабинета относятся к акции, в которой товар числится
          const matchesPlan = planPrice > 0 || planDisc > 0;
          if (disc + 0.0001 >= required || (matchesPlan && g.inPromo)) {
            eligible.add(nm);
            if (g.inPromo || disc + 0.0001 >= required) isIn.add(nm);
            if (planPrice > 0 && !plan.get(nm)) plan.set(nm, planPrice);
            inferred++;
          }
        });
      }

      index[p.id] = {
        inAction: isIn, eligible, plan,
        manualCount: manualItems.length, manualItems,
        storedCount: manual ? (manual.items || []).length : 0,
        ownership: manual ? { status: catalog ? 'verified' : 'blocked', error: ownershipError,
          catalogAt: catalog ? new Date(catalog.at).toISOString() : '',
          matchedCount: manualItems.length, excludedCount: catalog ? ownershipMatch.excluded.length : null,
          excludedItems: ownershipMatch.excluded.map((x) => ({ nmID: x.nmID, vendorCode: x.vendorCode, reason: x.reason })) } : null,
        manualFile: manual ? (manual.fileName || '') : '',
        manualAt: manual ? (manual.at || '') : '',
        inferred,
        source: manual ? 'file' : (inAction.length || candidates.length ? 'api' : inferred ? 'inferred' : 'none'),
        apiItems: candidates.concat(inAction.map((x) => ({ ...x, inAction: true }))),
        apiUsed: wantApi && !noApiReason && !apiFailed, apiError,
        apiConfirmed: new Set(inAction.map((x) => Number(x.nmID))),
        fileSnapshotCount: manualItems.filter((x) => x.inActionKnown !== false && x.inAction).length,
        noApi: noApiReason || '',
        auto: isAutoPromo(p), observations, managedIds
      };
    }
    // Импортированные акции, которых нет в календаре WB, не выбрасываем:
    // показываем их отдельным локальным блоком. Участие и цены WB при этом
    // не подтверждены, поэтому inAction не выставляем и ценой не управляем.
    const localPromos = [];
    for (const [pid, rec] of Object.entries(uploadedNoms || {})) {
      if (index[pid]) continue;
      const matched = catalog ? matchPromoOwnership(rec.items || [], catalog).matched : [];
      const eligible = new Set(matched.map((x) => Number(x.nmID)).filter((x) => x > 0));
      const plan = new Map();
      matched.forEach((x) => { const price = Number(x.planPrice || x.plannedPrice || 0); if (price > 0) plan.set(Number(x.nmID), price); });
      index[pid] = {
        inAction: new Set(), eligible, plan,
        manualCount: matched.length, manualItems: matched,
        storedCount: (rec.items || []).length,
        ownership: { status: catalog ? 'verified' : 'blocked', error: ownershipError,
          catalogAt: catalog ? new Date(catalog.at).toISOString() : '',
          matchedCount: matched.length, excludedCount: catalog ? (rec.items || []).length - matched.length : null,
          excludedItems: [] },
        manualFile: rec.fileName || '', manualAt: rec.at || '',
        inferred: 0, source: 'local-file', localUnconfirmed: true, calendarKnown: false,
        apiItems: [], apiUsed: false, apiError: '', apiConfirmed: new Set(), fileSnapshotCount: 0,
        noApi: 'Акции нет в календаре WB — локальный импорт, участие и цены WB не подтверждены', auto: false,
        observations: new Map(), managedIds: rec.selectedOnly === true ? new Set((rec.selectedIds || []).map(Number).filter((nm) => eligible.has(nm))) : null
      };
      localPromos.push({ id: Number(pid), name: 'Локальная акция ' + pid + ' (нет в календаре WB)', type: 'local',
        startDateTime: '', endDateTime: '', requiredDiscountPct: 0, localUnconfirmed: true, calendarKnown: false });
    }
    assertCatalogContext(context);
    if (catalog) assertCatalogCurrent(catalog);
    if (revision !== promoRevision) return promoIndex(false);
    if (priceStateUpdates.length) {
      const latest = store.loadPromoNoms();
      for (const update of priceStateUpdates) {
        const record = latest[update.id];
        if (record && record.at === update.importedAt) {
          record.priceStates = record.priceStates || {}; record.priceStates[String(update.nm)] = update.state;
        }
      }
      store.savePromoNoms(latest);
      if (observedEvents.length) store.appendPromoJournal(observedEvents);
    }
    promoCache.at = Date.now(); promoCache.context = context; promoCache.catalogRequest = catalogRequest;
    promoCache.ownershipExpiresAt = Object.keys(uploadedNoms).length ? (catalog ? catalog.at : promoCache.at) + CACHE_TTL_MS : Infinity;
    promoCache.index = index;
    promoCache.promos = promos.concat(localPromos);
    promoCache.noApi = noApi;
    promoCache.hardErrors = hardErrors;
    promoCache.noApiCount = Object.keys(noApi).length;
    // одно сводное предупреждение вместо потока тостов по каждой акции
    if (hardErrors.length) {
      notify('warn', {
        where: 'promo',
        message: 'Состав ' + hardErrors.length + ' из ' + promos.length + ' акций прочитать не удалось: ' +
          hardErrors.slice(0, 2).join('; ') + (hardErrors.length > 2 ? '; …' : '')
      });
    }
    return promoCache;
  }

  /**
   * Удержание цены для товара, который выводят из акции.
   * Пока идёт автоакция, снижать цену нельзя: WB тут же вернёт товар обратно.
   */
  function promoHoldFor(key, exitsPend, pi) {
    const rec = exitsPend && exitsPend[key];
    if (!rec) return null;
    const ids = rec.promoIds || [];
    const blocking = [];
    (ids || []).forEach((pid) => {
      const pr = pi && pi.promos ? (pi.promos || []).find((x) => String(x.id) === String(pid)) : null;
      if (!pr) return;
      if (String(pr.type || '').toLowerCase() !== 'auto') return;
      const end = new Date(pr.endDateTime || 0).getTime();
      if (Number.isFinite(end) && end > Date.now()) blocking.push(pr.name || String(pid));
    });
    const cfg = repricerCfg();
    const hold = cfg.promo.restoreAfterAutoPromoEnds !== false && blocking.length;
    // порог самой «мягкой» из идущих автоакций: скидка должна оставаться ниже него,
    // иначе WB подхватит товар обратно (одной цены недостаточно — после округления
    // скидки товар может снова начать соответствовать условиям акции)
    const required = blocking.map((name) => {
      const pr = (pi.promos || []).find((x) => (x.name || String(x.id)) === name);
      return Number(pr && (pr.requiredDiscountPct || pr.participationPercentage)) || 0;
    }).filter((x) => x > 0);
    return {
      promoIds: ids,
      promoNames: rec.promoNames || [],
      minPrice: hold ? Number(rec.raisedTo) || 0 : 0,
      maxDiscountPct: hold && required.length ? Math.min.apply(null, required) : 0,
      blockedByAutoPromo: !!hold,
      reason: hold ? `Автоакция ${blocking.join(', ')} ещё идёт — скидка держится ниже её порога, иначе WB вернёт товар в акцию.` : ''
    };
  }

  /** Акции, относящиеся к товару: участие, доступность, плановая цена, сколько дней до старта. */
  function promosForItem(item, pi) {
    const out = [];
    if (!pi || !pi.index) return out;
    const nm = Number(item.nmID);
    const now = Date.now();
    // один проход по загруженным файлам состава: nmID → Set(акций), где товар точно числится
    const fileNmsByPromo = {};
    const uploaded = store.loadPromoNoms() || {};
    for (const [pid, rec] of Object.entries(uploaded)) {
      fileNmsByPromo[pid] = new Set(((rec && rec.items) || []).map((x) => Number(x.nmID)));
    }
    for (const p of pi.promos || []) {
      const idx = pi.index[p.id];
      if (!idx) continue;
      if (idx.managedIds && !idx.managedIds.has(nm)) continue;
      const isIn = idx.inAction.has(nm);
      const isEligible = idx.eligible.has(nm);
      if (!isIn && !isEligible) continue;
      // откуда известно участие: из файла кабинета или выведено по факту скидки
      const fileNms = fileNmsByPromo[String(p.id)];
      const source = (fileNms && fileNms.has(nm)) ? 'file'
        : (idx.source === 'inferred' ? 'inferred' : (idx.source || 'none'));
      const start = new Date(p.startDateTime || 0).getTime();
      out.push({
        id: p.id,
        name: p.name,
        type: p.type, startDateTime: p.startDateTime, endDateTime: p.endDateTime,
        requiredDiscountPct: Number(p.requiredDiscountPct || p.participationPercentage || 0),
        planPrice: idx.plan.get(nm) || 0,
        absolutePlan: !!(uploaded[String(p.id)] && uploaded[String(p.id)].absolutePrices && source === 'file'),
        inAction: isIn,
        eligible: isEligible,
        started: Number.isFinite(start) ? start <= now : true,
        daysToStart: Number.isFinite(start) && start > now ? Math.round((start - now) / 86400000) : 0,
        source,
        auto: isAutoPromo(p),
        localUnconfirmed: !!(p.localUnconfirmed || idx.localUnconfirmed),
        calendarKnown: !(p.localUnconfirmed || idx.localUnconfirmed),
        noApi: idx.noApi || ''
      });
    }
    return out;
  }

  // ─────────────────────────── Обработчики ───────────────────────────

  const handlers = {
    'backup:export': async (payload) => {
      if (!backupManager) throw new WBError('Модуль резервного копирования недоступен.', { code: 'BACKUP_UNAVAILABLE' });
      return backupManager.exportBackup(payload || {});
    },
    'backup:import': async (payload) => {
      if (!backupManager) throw new WBError('Модуль резервного копирования недоступен.', { code: 'BACKUP_UNAVAILABLE' });
      const result = backupManager.importBackup(payload || {});
      if (result && result.applied) resetAfterRestore();
      return result;
    },
    'backup:list': async () => {
      if (!backupManager) throw new WBError('Модуль резервного копирования недоступен.', { code: 'BACKUP_UNAVAILABLE' });
      return backupManager.listBackups();
    },
    'backup:restore': async (payload) => {
      if (!backupManager) throw new WBError('Модуль резервного копирования недоступен.', { code: 'BACKUP_UNAVAILABLE' });
      const result = backupManager.restoreBackup(payload || {});
      if (result && result.applied) resetAfterRestore();
      return result;
    },
    'notify:get': async () => {
      if (!telegram) throw new WBError('Модуль уведомлений Telegram недоступен.', { code: 'NOTIFY_UNAVAILABLE' });
      return telegram.getState();
    },
    'notify:save': async (payload) => {
      if (!telegram) throw new WBError('Модуль уведомлений Telegram недоступен.', { code: 'NOTIFY_UNAVAILABLE' });
      return telegram.saveConfiguration(payload || {});
    },
    'notify:test': async () => {
      if (!telegram) throw new WBError('Модуль уведомлений Telegram недоступен.', { code: 'NOTIFY_UNAVAILABLE' });
      return telegram.test();
    },
    'pricewatch:get': async () => ({ ok: true, items: store.loadPriceWatch(), autoFetch: getSettings().priceWatchAutoFetch === true, ttlMinutes: getSettings().priceWatchTtlMinutes }),
    'pricewatch:record': async (payload) => priceWatcher.recordManual(payload),
    'pricewatch:fetch': async (payload) => {
      const p = payload || {};
      // force — осознанный разовый запрос, также обходит TTL, но не блокировку и интервал.
      if (getSettings().priceWatchAutoFetch !== true && p.force !== true)
        return { ok: false, code: 'AUTO_DISABLED', message: 'Автозапросы выключены. Для разового запроса укажите force: true.' };
      /**
       * В демо-режиме к витрине не ходим вовсе: демо-артикулы на WB не существуют, а первый же
       * отказ (403/429/капча) поднимает липкий флаг blocked, который до перезапуска приложения
       * заблокировал бы уже настоящие запросы. Ручной ввод при этом работает — наблюдение
       * можно записать глазами с витрины.
       */
      if (isDemo()) return { ok: false, code: 'DEMO', message: 'Демо-режим: запросы к витрине WB не выполняются. Впишите цены вручную или включите боевой режим.' };
      return priceWatcher.runBatch(p);
    },
    'pricewatch:history': async (payload) => ({ ok: true, items: priceWatcher.history(payload && payload.nmID), sppPct: priceWatcher.sppForEconomics(payload && payload.nmID) }),
    'pricewatch:open': async (payload) => priceWatcher.openInBrowser(payload && payload.url),

    /**
     * Полное обновление данных из кабинета WB — то, что нужно нажать сразу после ввода ключей.
     * Тянет товары с ценами, календарь акций, статистику продаж, карточки (габариты)
     * и — если задан срок — фактические расходы из финансового отчёта.
     * Каждый раздел грузится независимо: ошибка одного не мешает остальным.
     */
    'data:refresh-all': async (payload) => {
      const o = payload || {};
      const withFacts = o.facts !== false;
      const startedAt = Date.now();
      // статистику не сбрасываем: её раздел перезагрузит сам, а при лимите WB (429)
      // уже загруженные продажи должны остаться на месте
      invalidateAllCaches({ keepExpensive: true });
      const out = { ok: true, demo: isDemo(), sections: [], errors: [], deferred: [] };
      /**
       * Шаг обновления.
       * Если раздел упёрся в лимит WB (RATE_LIMIT / RATE_WAIT) или данных за период
       * просто ещё нет (DEFER) — это НЕ ошибка пользователя: раздел помечается
       * отложенным и догружается в фоне, когда лимит сбросится.
       */
      const step = async (name, title, fn) => {
        const t0 = Date.now();
        try {
          const r = await fn();
          out.sections.push({ name, title, ok: true, ms: Date.now() - t0, detail: r });
          notify('info', { where: 'data:refresh', message: `${title}: ${typeof r === 'string' ? r : 'готово'}` });
        } catch (e) {
          const code = e.code || '';
          const deferable = code === 'RATE_LIMIT' || code === 'RATE_WAIT' || code === 'DEFER';
          const known = !!DEFERRED_TASKS[name];
          if (deferable && known && o.autoRetry !== false) {
            const retryAt = Number(e.retryAt) || Date.now() + RATE_FALLBACK_MS;
            scheduleDeferred(name, retryAt, { title, days: e.days, reason: e.message });
            out.deferred.push({ name, title, retryAt, message: e.message, code });
            out.sections.push({ name, title, ok: false, deferred: true, retryAt, ms: Date.now() - t0, error: e.message });
            notify('info', { where: 'data:refresh', message: `${title}: ${e.message}` });
          } else {
            out.errors.push({ name, title, message: e.message, code, status: e.status || 0, hint: sectionHint(name, e) });
            out.sections.push({ name, title, ok: false, ms: Date.now() - t0, error: e.message });
            notify('warn', { where: 'data:refresh', message: `${title}: ${e.message}` });
          }
        }
      };

      await step('goods', 'Товары и цены', async () => {
        const g = await handlers['wb:goods']({ force: true });
        return (g.items || []).length + ' товаров';
      });
      await step('promos', 'Календарь акций', async () => {
        promoCache.index = null; promoCache.at = 0;
        const pr = await handlers['wb:promos']({ force: true });
        const list = Array.isArray(pr) ? pr : ((pr && pr.promotions) || []);
        const running = list.filter((x) => new Date(x.startDateTime || 0).getTime() <= Date.now() && new Date(x.endDateTime || 0).getTime() > Date.now()).length;
        return list.length + ' акций (' + running + ' идёт сейчас)';
      });
      await step('stats', 'Статистика продаж', async () => {
        // ОДИН запрос вместо двух: WB отдаёт «Статистику» не чаще раза в минуту,
        // поэтому сначала грузим продажи, а заказы ставим в фоновую догрузку.
        const st = await loadStats(30, true, { withOrders: false });
        const rows = st.rows || [];
        const errs = st.errors || [];
        // WB отказал (обычно 429 — лимит 1 запрос в минуту). Показывать «✓ N товаров»
        // на прошлогодних данных нельзя, поэтому раздел уходит в фоновую догрузку,
        // а в сообщении видно, что уже загруженные строки остались на месте.
        if (errs.length && (!rows.length || st.stale)) {
          const e0 = errs[0];
          const staleText = st.stale ? ' Ранее загруженные данные (' + rows.length + ' товаров с продажами) остались на месте.' : '';
          const err = new Error((e0.message || 'Статистика продаж не загрузилась') + staleText);
          err.code = e0.code; err.status = e0.status; err.hint = e0.hint; err.retryAt = e0.retryAt;
          throw err;
        }
        if (!errs.length && !isDemo() && getSettings().statsLoadOrders !== false) {
          let freeAt = Date.now() + RATE_FALLBACK_MS;
          try { freeAt = Math.max(freeAt, getClient().nextFreeAt('statistics')); } catch (e) { /* не критично */ }
          scheduleDeferred('stats-orders', freeAt, {
            days: 30,
            title: DEFERRED_TITLES['stats-orders'],
            reason: 'Заказы догружаются отдельным запросом: WB даёт категории «Статистика» один запрос в минуту.'
          });
        }
        const warn = errs.length ? ' (частично: не загрузилось ' + errs.map((x) => x.source === 'orders' ? 'заказы' : 'продажи').join(', ') + ')' : '';
        const pending = (!errs.length && !isDemo() && getSettings().statsLoadOrders !== false) ? ', заказы догрузятся в фоне' : '';
        const truncated = st.meta && st.meta.truncated ? ' (WB отдал не все страницы — увеличьте лимит страниц в настройках)' : '';
        return rows.length + ' товаров с продажами' + warn + pending + truncated;
      });
      await step('cards', 'Карточки и габариты', async () => {
        const c = await handlers['wb:cards']({ force: true });
        const rows = Array.isArray(c) ? c : ((c && c.cards) || []);
        return rows.length + ' карточек';
      });
      await step('stocks', 'Остатки по складам WB', async () => {
        // Категория «Аналитика» — 1 запрос в 20 с; при занятом лимите (429)
        // раздел уходит в фоновую догрузку, как статистика. Пустой отчёт
        // не затирает уже загруженные остатки (см. loadStocksIntoCache).
        const r = await loadStocksIntoCache({});
        let detail = r.items + ' товаров с остатками';
        if (r.meta && r.meta.fallback) detail += ' (запасной путь: отчёт заданием)';
        if (r.meta && r.meta.empty) detail += ' (WB вернул пусто — сохранены прежние остатки)';
        return detail;
      });
      if (withFacts) {
        await step('facts', 'Фактические расходы (отчёт о реализации)', async () => {
          const f = await loadFactCosts({ days: Number(o.factDays) || undefined });
          if (!f || !f.ok) {
            const err = new Error((f && f.message) || (f && f.error) || 'отчёт не загружен');
            err.code = (f && f.code) || '';
            err.retryAt = (f && f.retryAt) || 0;
            err.days = Number(o.factDays) || undefined;
            throw err;
          }
          return f.items + ' товаров, ' + f.rowsProcessed + ' строк за ' + f.dateFrom + ' → ' + f.dateTo +
            (f.widened ? ' (взят последний доступный отчёт WB)' : '');
        });
      }

      out.ms = Date.now() - startedAt;
      out.ok = out.errors.length === 0;
      out.pending = out.deferred.length;
      out.coverage = coverageOf();
      store.saveSettings({
        lastDataRefreshAt: new Date().toISOString(),
        lastDataRefreshOk: out.ok,
        lastDataRefreshPending: out.pending
      });
      return out;
    },

    /**
     * Состояние фоновой догрузки: какие разделы отложены из-за лимита WB,
     * что уже догрузилось, что не удалось. Интерфейс показывает это в панели
     * «Обновление данных» и обновляет по событию `deferred`.
     */
    'data:deferred': async () => ({
      ok: true,
      demo: isDemo(),
      items: deferredList(),
      at: new Date().toISOString()
    }),

    /**
     * Догрузить один раздел сейчас — вручную (кнопка «Повторить сейчас»).
     * Ждём сброса лимита WB столько, сколько нужно, поэтому вызов может занять минуту.
     */
    'data:refresh-section': async (payload) => {
      const name = String((payload && payload.name) || '');
      if (!DEFERRED_TASKS[name]) {
        throw new WBError('Неизвестный раздел: ' + (name || '—') + '. Доступны: ' + Object.keys(DEFERRED_TASKS).join(', ') + '.', { code: 'BAD_SECTION' });
      }
      const rec = deferred[name];
      if (rec && rec.state === 'running') {
        return { ok: false, running: true, name, message: 'Раздел уже догружается — подождите минуту.' };
      }
      const started = Date.now();
      const title = DEFERRED_TITLES[name] || name;
      try {
        const detail = await DEFERRED_TASKS[name]({
          name,
          title,
          days: Number((payload && payload.days) || (rec && rec.days) || 30)
        });
        if (deferred[name]) {
          deferred[name].state = 'done';
          deferred[name].detail = detail || '';
          deferred[name].error = '';
          deferred[name].at = Date.now();
        }
        notify('deferred', { type: 'done', name, title, detail, at: new Date().toISOString() });
        return { ok: true, name, title, detail, ms: Date.now() - started };
      } catch (e) {
        if (deferred[name]) {
          deferred[name].state = 'failed';
          deferred[name].error = (e && e.message) || String(e);
          deferred[name].at = Date.now();
        }
        notify('deferred', { type: 'failed', name, title, error: (e && e.message) || String(e) });
        throw e;
      }
    },

    /**
     * Догрузить ЗАКАЗЫ к статистике продаж отдельным запросом.
     * WB даёт категории «Статистика» один запрос в минуту, поэтому заказы
     * не грузятся вместе с продажами внутри «Обновить данные из WB».
     */
    'stats:orders': async (payload) => {
      const days = Number((payload && payload.days) || 30);
      const r = await loadOrdersIntoStats(days, !!(payload && payload.force));
      return Object.assign({ ok: true, demo: isDemo(), days }, r);
    },

    /**
     * Что сейчас известно о статистике продаж: сколько строк, когда загружена, какие ошибки.
     * Намеренно НЕ ходит в WB: лимит категории «Статистика» — 1 запрос в минуту,
     * и тратить его на справочный запрос нельзя.
     */
    'stats:state': async () => ({
      ok: true,
      demo: isDemo(),
      count: (cache.stats || []).length,
      meta: cache.statsMeta || null,
      errors: cache.statsErrors || [],
      loadedAt: cache.statsAt ? new Date(cache.statsAt).toISOString() : null,
      deferred: deferredList().filter((x) => x.name === 'stats' || x.name === 'stats-orders')
    }),

    /**
     * Загружать остатки по складам WB.
     *
     * Основной путь — stocks-report/wb-warehouses (категория «Аналитика»),
     * запасной — отчёт заданием warehouse_remains (категория «Маркетплейс»).
     * Пустой ответ не затирает прежние остатки: они остаются в кэше, а в
     * meta ставится empty:true и время попытки.
     */
    'stocks:load': async (payload) => {
      const o = payload || {};
      if (o.force !== true && cache.stocks && Date.now() - cache.stocksAt < CACHE_TTL_MS) {
        return {
          ok: true, fromCache: true, demo: isDemo(),
          items: Object.keys(cache.stocks).length, meta: cache.stocksMeta,
          loadedAt: cache.stocksAt ? new Date(cache.stocksAt).toISOString() : null
        };
      }
      const r = await loadStocksIntoCache({
        force: true,
        patient: !!o.patient,
        maxPages: Number(o.maxPages) || undefined,
        maxWaitMs: o.maxWaitMs,
        pageWaitMs: o.pageWaitMs
      });
      return Object.assign({ fromCache: false }, r);
    },

    /**
     * Что известно об остатках по складам WB: сколько товаров, когда загружено,
     * откуда (основной метод или отчёт заданием), были ли пустые ответы.
     * Намеренно НЕ ходит в WB: лимит категории «Аналитика» — 1 запрос в 20 с,
     * тратить его на справочный запрос нельзя.
     */
    'stocks:state': async () => ({
      ok: true,
      demo: isDemo(),
      items: Object.keys(stocksMap()).length,
      meta: cache.stocksMeta || null,
      loadedAt: cache.stocksAt ? new Date(cache.stocksAt).toISOString() : null,
      deferred: deferredList().filter((x) => x.name === 'stocks')
    }),

    /** Список складов продавца (FBS): GET /api/v3/warehouses, категория «Маркетплейс». */
    'warehouses:list': async () => {
      if (isDemo()) return { ok: true, demo: true, items: await getDemo().getWarehouses() };
      const items = await getClient().getWarehouses();
      return { ok: true, demo: false, items };
    },

    /** Диагностика лимитов WB: сколько ждать до следующего запроса по каждой категории. */
    'wb:rate-state': async () => {
      if (isDemo()) {
        return { ok: true, demo: true, message: 'В демо-режиме запросы к WB не отправляются — лимиты не расходуются.' };
      }
      const c = getClient();
      return {
        ok: true,
        demo: false,
        categories: c.rateState(),
        requests: c.stats.requests,
        errors: c.stats.errors,
        lastError: c.stats.lastError,
        deferred: deferredList()
      };
    },

    'app:state': async () => {
      const s = getSettings();
      const secrets = store.loadSecrets();
      const demo = isDemo();
      return {
        demo, dataContext: businessContext(),
        settings: s,
        keys: {
          single: maskKey(secrets.single || secrets.universal || secrets.all),
          prices: maskKey(secrets.prices),
          statistics: maskKey(secrets.statistics),
          content: maskKey(secrets.content),
          finance: maskKey(secrets.finance),
          advert: maskKey(secrets.advert),
          analytics: maskKey(secrets.analytics),
          marketplace: maskKey(secrets.marketplace),
          master: maskKey(secrets.master)
        },
        keysSet: WB_SECRET_NAMES.filter((k) => secrets[k]).length,
        secretsError: store.secretsError ? store.secretsError() : '',
        coverage: coverageOf(),
        lastDataRefreshAt: s.lastDataRefreshAt || null,
        // разделы, которые догружаются в фоне из-за лимита WB (1 запрос в минуту)
        deferred: deferredList(),
        statsMeta: cache.statsMeta || null,
        statsCount: (cache.stats || []).length,
        rateState: demo ? null : safeRateState(),
        secretsMethod: store.secretsMethod(),
        scopes: TOKEN_SCOPES,
        cache: {
          goodsAt: cache.goodsAt || null,
          goodsCount: cache.goods ? cache.goods.items.length : 0,
          statsAt: cache.statsAt || null,
          cardsAt: cache.cardsAt || null,
          stocksAt: cache.stocksAt || null,
          stocksCount: Object.keys(stocksMap()).length,
          stocksMeta: cache.stocksMeta || null
        },
        costsCount: Object.keys(costsMap()).length,
        appDir: store.dir
      };
    },

    'settings:get': async () => getSettings(),

    'settings:save': async (patch) => {
      const before = getSettings(), input = patch || {};
      const taxKeys = ['taxMode', 'taxRate', 'taxVatRate', 'taxInsuranceEnabled', 'taxAnnualRevenue', 'ipFixedContribution', 'ipExtraContributionCap', 'ipHasEmployees', 'ipDeductContributions'];
      const taxChanged = taxKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key) && JSON.stringify(before[key]) !== JSON.stringify(input[key]));
      if (taxChanged && (activeHandlers > 1 || backgroundJobs || sched.running)) throw new WBError('Дождитесь окончания текущей операции кабинета перед изменением налогов.', { code: 'PROFILE_BUSY' });
      const saved = store.saveSettings(input);
      if (['demoMode', 'sandbox'].some((key) => Object.prototype.hasOwnProperty.call(input, key) && !!before[key] !== !!input[key])) { client = null; invalidateAllCaches(); }
      if (['promosInferFromDiscount', 'promosFetchNomenclatures'].some((key) => Object.prototype.hasOwnProperty.call(input, key) && before[key] !== input[key])) {
        promoRevision++; promoCache.index = null; promoCache.at = 0; promoCache.noApi = {};
      }
      if (taxChanged) {
        const proposal = store.loadProposals();
        if (proposal && proposal.phase === 'proposed') store.saveProposals({ ...proposal, phase: 'stale', staleReason: 'Изменились налоги кабинета — пересчитайте цены перед отправкой.' });
        invalidateGoodsCache();
      }
      return saved;
    },

    'settings:reset': async () => { const result = store.resetSettings(); client = null; invalidateAllCaches(); return result; },

    'keys:set': async (payload) => {
      const secrets = store.loadSecrets();
      const p = payload || {};
      // single/universal/all — один ключ на все разделы (WB выдаёт JWT с выбранными категориями)
      const names = WB_SECRET_NAMES;
      // Пустое поле означает «не трогать сохранённый ключ», а НЕ «удалить».
      // Раньше пустая строка удаляла ключ: интерфейс отправлял все пять полей,
      // а после перерисовки они пустые (сохранённый ключ виден только в подсказке) —
      // второе нажатие «Сохранить» стирало все ключи.
      // Удаление — только явное: clearAll или clear:[...] (кнопка «Удалить ключи»).
      const secretsBefore = Object.assign({}, secrets);
      const saved = [];
      const kept = [];
      const ignored = [];
      const explicitClear = Array.isArray(p.clear) ? p.clear.map((x) => String(x)) : [];
      for (const k of names) {
        const raw = p[k];
        if (typeof raw !== 'string') continue;
        const v = raw.trim();
        if (!v) { if (secrets[k]) kept.push(k); continue; }
        // замаскированное значение из интерфейса (eyJhbG••••••••••cdef) сохранять нельзя —
        // это не ключ, а его отображение; иначе ключ портился и WB отвечал 401
        if (/[•*]/.test(v) || v.length < 20) { ignored.push(k); continue; }
        secrets[k] = v;
        saved.push(k);
      }
      if (p.clearAll === true) { for (const k of names) delete secrets[k]; }
      for (const k of explicitClear) { if (names.indexOf(k) >= 0) delete secrets[k]; }
      // Настоящий ключ означает, что демо-режим больше не нужен: переключаемся на данные
      // кабинета автоматически. Вернуться в демо можно галочкой в настройках или keys:set({demoMode:true}).
      const realKey = ['single', 'universal', 'all', 'prices', 'statistics', 'content', 'finance', 'advert', 'master']
        .some((k) => secrets[k] && secrets[k] !== DEMO_KEY);
      const s0 = getSettings();
      let demoMode = s0.demoMode;
      let demoSwitched = false;
      if (p.demoMode !== undefined) {
        demoMode = !!p.demoMode;
      } else if (realKey && s0.demoMode) {
        demoMode = false;
        demoSwitched = true;
      }
      const demoChanged = demoMode !== s0.demoMode;
      if (demoChanged || p.demoMode !== undefined) store.saveSettings({ demoMode });
      const cleared = p.clearAll === true ? names.filter((k) => secretsBefore[k]) : explicitClear.filter((k) => secretsBefore[k]);
      const res = store.saveSecrets(secrets);
      // Кэши и метку «данные обновлены» сбрасываем ТОЛЬКО если что-то действительно изменилось.
      // Раньше это делалось безусловно, поэтому повторное нажатие «Сохранить» (поля пустые —
      // сохранённый ключ виден только в подсказке) опустошало интерфейс: товары, акции и статистика
      // пропадали, а «обновлено …» обнулялось, хотя ключи остались на месте.
      const keysChanged = names.some((name) => secrets[name] !== secretsBefore[name]);
      if (keysChanged || demoChanged) {
        client = null;
        invalidateAllCaches();
        store.saveSettings({ lastDataRefreshAt: null, lastDataRefreshOk: null });
      }
      return {
        ok: true, method: res.method, demo: isDemo(), coverage: coverageOf(),
        demoSwitched, realKey, saved, kept, ignored,
        cleared, keysChanged,
        secretsError: store.secretsError ? store.secretsError() : '',
        message: demoSwitched
          ? 'Ключ сохранён — демо-режим выключен, работаем с данными вашего кабинета WB.'
          : (realKey
            ? (demoMode
              ? 'Ключ сохранён, но демо-режим оставлен включённым вручную — показываем сгенерированные данные. Снимите галку «Демо-режим», чтобы работать со своим кабинетом.'
              : 'Ключ сохранён — работаем с данными вашего кабинета WB.')
            : 'Ключи не заданы — остаёмся в демо-режиме.')
      };
    },

    'keys:clear': async () => {
      const secrets = store.loadSecrets();
      for (const key of WB_SECRET_NAMES) delete secrets[key];
      store.saveSecrets(secrets);
      client = null; invalidateAllCaches();
      return { ok: true };
    },

    'keys:check': async () => {
      const secrets = store.loadSecrets();
      const anyKey = WB_SECRET_NAMES.some((key) => secrets[key]);
      const secretsError = store.secretsError ? store.secretsError() : '';
      if (isDemo()) {
        const results = await getDemo().ping();
        return {
          demo: true, checked: false, anyKey, results, secretsError,
          message: anyKey
            ? 'Демо-режим включён, хотя ключ сохранён: реальных запросов к WB не было. Снимите галку «Демо-режим», чтобы проверить настоящие права.'
            : 'Ключи не заданы — проверять нечего, запросов к WB не было. Вставьте ключ в поле «Один ключ на все разделы» и сохраните.'
        };
      }
      const results = await getClient().checkAccess();
      const okCount = results.filter((r) => r.ok === true).length;
      const badCount = results.filter((r) => r.ok === false).length;
      // ok === null — раздел не проверен вовсе: WB держит лимит (1 запрос в минуту)
      // или ключ не задан. Говорить в этом случае «доступ есть по всем разделам» нельзя.
      const skipped = results.filter((r) => r.ok === null);
      return {
        demo: false, checked: badCount > 0 || okCount > 0, anyKey, results, secretsError,
        skipped: skipped.length,
        message: badCount === 0
          ? (skipped.length
            ? 'Доступ есть по проверенным разделам (' + okCount + ' из ' + results.length + '). Не проверено: ' +
              skipped.map((r) => r.title).join(', ') + ' — ' + (skipped[0].hint || 'WB ещё не сбросил лимит запросов, повторите через минуту.')
            : 'Доступ есть по всем разделам (' + okCount + ' из ' + results.length + ').')
          : 'Проверено разделов: ' + results.length + '. Работает: ' + okCount + ', не работает: ' + badCount +
            (skipped.length ? ', не проверено: ' + skipped.length : '') + '.' +
            (secretsError ? ' Внимание: ' + secretsError : '')
      };
    },

    /** Товары с ценами + пользовательские/демо-значения себестоимости + статистика. */
    'wb:goods': async (opts) => {
      const force = !!(opts && opts.force);
      const s = getSettings(), context = catalogContext();
      if (!force && cache.goods && cache.goods.context === context && cache.goods.request === catalogRequest &&
          (!catalogSnapshot || catalogSnapshot.at === cache.goodsAt) && Date.now() - cache.goodsAt < CACHE_TTL_MS) {
        const items = cache.goods.items;
        const overrides = overridesFor(items);
        if (isDemo()) mergeDemoOverrides(items, overrides);
        return {
          items,
          total: cache.goods.total, loadedCount: items.length, totalKnown: cache.goods.totalKnown,
          complete: cache.goods.complete, truncated: !cache.goods.complete, catalogAt: cache.goods.catalogAt,
          overrides,
          stats: cache.stats || [],
          statsMeta: cache.statsMeta || null,
          facts: factsMap(),
          source: cache.goods.source,
          fromCache: true,
          cachedAt: new Date(cache.goodsAt).toISOString(),
          demo: isDemo(), dataContext: businessContext(),
          settings: s
        };
      }

      const result = await loadGoodsCatalog({ force, maxItems: opts && opts.maxItems });
      assertCatalogCurrent(result);
      const items = result.items;
      cache.goods = { items, source: result.source, context, request: result.request, total: result.total, totalKnown: result.totalKnown,
        complete: result.complete, catalogAt: new Date(result.at).toISOString() };
      cache.goodsAt = result.at;
      promoCache.index = null; promoCache.at = 0;

      // подтягиваем карточки (габариты/названия) и статистику — по возможности
      try {
        const cards = isDemo() ? await getDemo().getCards() : await getClient().getCards({ maxCards: 2000 });
        assertCatalogCurrent(result);
        cache.cards = cards;
        cache.cardsAt = Date.now();
        const byNm = new Map(cards.map((c) => [Number(c.nmID), c]));
        for (const g of items) {
          const c = byNm.get(Number(g.nmID));
          if (c) {
            if (!g.title && c.title) g.title = c.title;
            if (c.volumeLiters && !g.volumeLiters) g.volumeLiters = c.volumeLiters;
            if (c.subjectName && !g.categoryName) g.categoryName = c.subjectName;
            if (c.brand && !g.brand) g.brand = c.brand;
          }
        }
      } catch (e) {
        notify('warn', { where: 'content', message: e.message });
      }

      assertCatalogCurrent(result);

      // Статистику здесь больше НЕ грузим.
      // Раньше загрузка товаров сама делала два запроса к «Статистике» (продажи и заказы),
      // а следом раздел «Статистика продаж» делал ещё два — при лимите WB 1 запрос в минуту
      // это гарантированный HTTP 429. Теперь статистика грузится своим разделом,
      // а здесь берётся то, что уже есть в кэше; если её нет — ставим фоновую догрузку.
      if (isDemo()) {
        try {
          cache.stats = await getDemo().getSalesAggregated();
          cache.statsAt = Date.now();
          cache.statsMeta = { days: 30, demo: true, withOrders: true, ordersPending: false };
        } catch (e) {
          notify('warn', { where: 'statistics', message: e.message });
        }
      } else if (!cache.stats || !cache.stats.length) {
        scheduleDeferred('stats', Date.now() + 1200, {
          days: 30,
          title: DEFERRED_TITLES.stats,
          reason: 'Статистика продаж ещё не загружена — догружаем отдельно, чтобы не превышать лимит WB (1 запрос в минуту).'
        });
      }

      assertCatalogCurrent(result);
      const overrides = overridesFor(items);
      if (isDemo()) mergeDemoOverrides(items, overrides);
      store.saveSettings({ lastSync: new Date().toISOString() });

      return {
        items,
        total: result.total, loadedCount: items.length, totalKnown: result.totalKnown,
        complete: result.complete, truncated: !result.complete, catalogAt: cache.goods.catalogAt,
        overrides,
        stats: cache.stats || [],
        statsMeta: cache.statsMeta || null,
        facts: factsMap(),
        source: cache.goods.source,
        fromCache: false,
        demo: isDemo(), dataContext: businessContext(),
        settings: getSettings()
      };
    },

    'wb:sizes': async (nmID) => (isDemo() ? getDemo().getSizes(nmID) : getClient().getSizes(nmID)),

    /** Массовая установка цен и скидок. */
    'wb:apply-prices': async (payload) => applyPricesWithSafety(payload),

    'wb:apply-size-prices': async (payload) => applySizePrices(payload),

    'wb:upload-states': async () => {
      if (isDemo()) return getDemo().uploadStates();
      return getClient().uploadStates(store.loadTasks().flatMap((task) => task.uploadIDs || []));
    },

    'tasks:history': async () => store.loadTasks(),

    // ───────────────────────── Акции ─────────────────────────

    'wb:promos': async (opts) => {
      const days = Number((opts && opts.days) || 60);
      const start = daysAgoIso(Math.min(30, days));
      const end = daysAgoIso(-days);
      if (isDemo()) {
        const list = await getDemo().getPromotions();
        const details = await getDemo().getPromotionDetails(list.map((p) => p.id));
        const byId = new Map(details.map((d) => [Number(d.id), d]));
        return list.map((p) => mergeNonEmpty(p, byId.get(Number(p.id))));
      }
      const c = getClient();
      const list = await c.getPromotions({ startDateTime: start, endDateTime: end, allPromo: false });
      if (!list.length) return [];
      const details = await c.getPromotionDetails(list.map((p) => p.id));
      const byId = new Map(details.map((d) => [Number(d.id), d]));
      // Пустое поле из «деталей» не должно затирать значение из списка акций: иначе
      // type='auto' превращался в '' и приложение начинало спрашивать состав автоакции,
      // получая в ответ HTTP 422 по каждой такой акции.
      return list.map((p) => mergeNonEmpty(p, byId.get(Number(p.id))));
    },

    'wb:promo-nomenclatures': async (payload) => {
      const promotionID = Number(payload && payload.promotionID);
      const inAction = !!(payload && payload.inAction);
      if (isDemo()) return getDemo().getPromotionNomenclatures(promotionID, { inAction });
      const list = await getClient().getPromotionNomenclatures(promotionID, { inAction, maxItems: 5000 });
      // обогатим названиями/категориями из кэша товаров
      const byNm = new Map(((cache.goods && cache.goods.items) || []).map((g) => [Number(g.nmID), g]));
      return list.map((n) => {
        const g = byNm.get(Number(n.nmID));
        return g ? Object.assign({ title: g.title, categoryName: g.categoryName, volumeLiters: g.volumeLiters }, n) : n;
      });
    },

    /**
     * Состав акции БЕЗ обращений к WB.
     *
     * Почему не API: метод /calendar/promotions/nomenclatures помечен в документации WB
     * «Not applicable for auto promotions» и отвечает HTTP 422 почти на любой акции —
     * ни кандидатов, ни участников он фактически не отдаёт. Настоящий состав продавец
     * скачивает файлом в кабинете и загружает в приложение.
     *
     * Порядок источников:
     *   1. загруженный файл (promonoms.json) — точный состав с плановой ценой;
     *   2. сами товары из кабинета: скидка ≥ требуемой = товар удовлетворяет условиям акции
     *      (WB не сообщает, в какой именно акции товар, только факт скидки);
     *   3. API — только если явно включён promosFetchNomenclatures.
     */
    'promos:items': async (payload) => {
      const promotionID = Number(payload && payload.promotionID);
      if (!(promotionID > 0)) throw new WBError('Не указана акция.', { code: 'NO_PROMO' });
      const st = getSettings();
      const pi = await promoIndex(!!(payload && payload.force));
      const promo = ((pi && pi.promos) || []).find((x) => Number(x.id) === promotionID) || null;
      if (!promo) throw new WBError('Акция ' + promotionID + ' не найдена в календаре WB. Обновите список акций.', { code: 'NO_PROMO' });

      const idx = (pi && pi.index && pi.index[promotionID]) || null;
      const required = Number(promo.requiredDiscountPct || promo.participationPercentage || 0);
      const file = (store.loadPromoNoms() || {})[String(promotionID)] || null;
      const goods = ((cache.goods && cache.goods.items) || []);
      const byNm = new Map(goods.map((g) => [Number(g.nmID), g]));

      const items = [];
      const seen = new Set();

      const push = (nmID, data, source) => {
        const nm = Number(nmID);
        if (!(nm > 0) || seen.has(nm)) return;
        seen.add(nm);
        const g = byNm.get(nm) || {};
        const price = Number(g.price || data.price || 0);
        // Текущая скидка из файла — снимок на дату выгрузки, не замена свежей цене WB.
        const liveDiscount = g.discount !== undefined && g.discount !== null && g.discount !== '' && Number.isFinite(Number(g.discount)) && Number(g.discount) >= 0 && Number(g.discount) <= 100;
        const discount = Number(liveDiscount ? g.discount : (data.discount ?? 0));
        const planPrice = Number(data.planPrice || data.plannedPrice || 0) || (Number(g.plannedPrice) || 0);
        const planDiscount = Number(data.planDiscount || data.plannedDiscount || 0) || (Number(g.plannedDiscount) || 0);
        items.push({
          nmID: nm,
          vendorCode: data.vendorCode || g.vendorCode || '',
          brand: data.brand || g.brand || '',
          title: data.title || g.title || '',
          categoryName: data.categoryName || g.categoryName || '',
          price,
          discount,
          planPrice,
          planDiscount,
          plannedPrice: planPrice,
          plannedDiscount: planDiscount,
          // «в акции» — из файла, из флага кабинета или по факту скидки
          inAction: idx ? idx.inAction.has(nm) : !!data.inAction,
          observation: idx && idx.observations ? idx.observations.get(nm) || null : null,
          managed: !file || file.selectedOnly !== true || (file.selectedIds || []).map(Number).includes(nm),
          stock: data.stock !== undefined ? Number(data.stock) : undefined,
          stockWb: data.stockWb, stockSeller: data.stockSeller,
          fileStatus: data.fileStatus || '', currency: data.currency || '',
          priceSource: Number(g.price) > 0 ? 'wb' : source,
          discountSource: liveDiscount ? 'wb' : data.discount !== undefined ? source : 'unknown',
          volumeLiters: g.volumeLiters,
          requiredDiscountPct: required,
          source
        });
      };

      const composition = promoComposition(promo, idx, file);
      composition.entries.forEach((entry) => push(entry.nmID, entry.data, entry.source));
      const { source, apiUsed, apiError } = composition;
      const inActionCount = items.filter((x) => x.inAction).length;
      return {
        ok: true,
        demo: isDemo(),
        promotionID,
        promoName: promo.name || String(promotionID),
        promoType: promo.type || '',
        auto: isAutoPromo(promo),
        requiredDiscountPct: required,
        startDateTime: promo.startDateTime || '',
        endDateTime: promo.endDateTime || '',
        participationPercentage: Number(promo.participationPercentage || 0),
        source, inferredCount: composition.inferredCount, apiCount: composition.apiCount, apiPartial: composition.apiPartial,
        items,
        total: items.length,
        inActionCount,
        candidatesCount: items.length - inActionCount,
        selectedOnly: !!(file && file.selectedOnly),
        selectedIds: file && file.selectedOnly ? (file.selectedIds || []).map(Number).filter((nm) => seen.has(nm)) : [],
        ownership: idx && idx.ownership || null,
        fileInfo: file ? { fileName: file.fileName || '', at: file.at || '', count: items.length, storedCount: (file.items || []).length } : null,
        inferred: idx ? (idx.inferred || 0) : 0,
        apiUsed,
        apiError,
        // подсказка интерфейсу: что сделать, если состава нет
        hint: items.length ? '' : (required > 0
          ? 'Состав пуст: скачайте файл акции в кабинете WB («Перейти к товарам для акции» → «Сформировать» → «Скачать») и загрузите его сюда.'
          : 'У акции не указана требуемая скидка — состав можно взять только из файла кабинета WB.')
      };
    },

    'wb:promo-join': async (payload) => {
      const safety = await mutationSnapshot();
      for (const value of (payload && payload.nomenclatures) || []) {
        const good = safety.byNm.get(Number(value.nmID));
        const check = checkCandidate(safety, value.nmID, value.price === undefined ? good && good.price : value.price, value.discount === undefined ? good && good.discount : value.discount);
        if (!check.ok) throw new WBError('Вход в акцию заблокирован для ' + value.nmID + ': ' + check.issues.map((i) => i.message).join('; '), { code: 'ITEM_CRITICAL' });
      }
      mutationPreflight(safety, (payload && payload.nomenclatures) || []);
      const p = payload || {};
      const promotionID = Number(p.promotionID);
      const nomenclatures = p.nomenclatures || [];
      if (!nomenclatures.length) throw new WBError('Выберите товары для входа в акцию.', { code: 'EMPTY' });
      const res = isDemo()
        ? await getDemo().joinPromotion(promotionID, nomenclatures)
        : await getClient().joinPromotion(promotionID, nomenclatures, { beforeSend: () => mutationPreflight(safety, nomenclatures) });
      assertPriceContext(safety.context);
      if (p._journal !== false) {
        const goodsByNm = new Map((((cache.goods && cache.goods.items) || [])).map((g) => [String(g.nmID), g]));
        const resultByNm = new Map(((res && res.results) || []).map((r) => [String(r.nmID), r]));
        store.appendPromoJournal(nomenclatures.map((entry) => {
          const item = entry && typeof entry === 'object' ? entry : { nmID: entry };
          const nmID = Number(item.nmID);
          const result = resultByNm.get(String(nmID));
          const good = goodsByNm.get(String(nmID)) || {};
          const price = Number(item.price) || 0;
          const discount = Number(item.discount) || 0;
          return {
            nmID,
            vendorCode: good.vendorCode || '',
            title: good.title || '',
            action: 'join',
            promoId: promotionID,
            promoName: p.promoName || String(promotionID),
            promoStartAt: p.promoStartAt || '',
            promoEndAt: p.promoEndAt || '',
            priceBefore: Number(good.price) * (1 - Number(good.discount || 0) / 100),
            priceAfter: price > 0 ? price * (1 - discount / 100) : 0,
            reason: 'Ручной вход в акцию',
            source: 'promo-calendar',
            ok: result ? result.ok !== false : true,
            error: result && result.error ? result.error : ''
          };
        }));
      }
      invalidateGoodsCache();
      return res;
    },

    // ─────────── Ручная загрузка состава акции из файла WB ───────────

    /**
     * Импорт списка товаров акции из файла (XLSX из календаря WB «Настроить список товаров» или CSV).
     *
     * Зачем: по API состав акции отдаётся не всегда и не для всех типов акций
     * (автоакции через API не управляются вообще), а файл из кабинета продавец выгрузить может.
     * Загруженный список становится источником правды по составу акции: репрайсер видит эти
     * товары как кандидатов/участников и полноценно с ними работает — считает вход, выход и цены.
     */
    'promos:import-noms': async (payload) => {
      const p = payload || {};
      const id = Number(p.promotionID || p.promoId), promoId = String(id);
      const context = catalogContext();
      if (!Number.isSafeInteger(id) || id <= 0) throw new WBError('Не указана акция, в которую загружается список товаров.', { code: 'NO_PROMO' });
      if (p.base64 && String(p.base64).length > 70 * 1024 * 1024) throw new WBError('Файл акции превышает 50 МБ.', { code: 'FILE_TOO_LARGE' });
      if (!p.base64 && !p.rows) throw new WBError('Не передан файл со списком товаров.', { code: 'NO_FILE' });

      let table;
      try {
        table = p.rows ? { rows: p.rows, sheet: 'inline' } : readTable(Buffer.from(String(p.base64), 'base64'), p.fileName || '');
      } catch (e) {
        throw new WBError('Не удалось прочитать файл: ' + e.message, { code: 'BAD_FILE' });
      }
      const rows = (table.rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''));
      if (!rows.length) throw new WBError('Файл пустой — в нём нет строк с товарами.', { code: 'EMPTY_FILE' });

      const parsed = PromoImport.bestPromoTable(p.rows ? { rows, sheet: 'inline' } : table);
      if (!parsed.items.length) {
        throw new WBError(
          'Не удалось найти в файле артикулы WB (nmID). Проверьте, что это файл списка товаров акции: ' +
          'нужна колонка «Артикул WB» / «nmID» с числовыми значениями. ' +
          'Распознанные заголовки: ' + (parsed.headers.join(', ') || '—'),
          { code: 'NO_NMID' }
        );
      }

      if (p.ownershipContext && p.ownershipContext !== context) assertCatalogContext(p.ownershipContext);
      const catalog = await ownershipCatalog();
      assertCatalogContext(context);
      const { matched, excluded } = matchPromoOwnership(parsed.items, catalog);
      const ownership = { status: 'verified', cabinetName: getSettings().shopName || 'Текущий кабинет',
        demo: isDemo(), catalogCount: catalog.items.length, catalogAt: new Date(catalog.at).toISOString(),
        matchedCount: matched.length, excludedCount: excluded.length, fileCount: parsed.items.length };
      const ownershipDigest = crypto.createHash('sha256').update(JSON.stringify(matched.map((row) => row.nmID))).digest('hex');
      if (p.action !== 'preview' && p.ownershipDigest && p.ownershipDigest !== ownershipDigest) throw new WBError('Принадлежность товаров изменилась после предпросмотра. Проверьте файл заново; прежние условия не изменены.', { code: 'PROMO_OWNERSHIP_CHANGED' });
      const rejectionReason = matched.length ? '' : 'Файл отклонён: ни один nmID не найден в каталоге текущего кабинета. Выберите выгрузку этого кабинета.';
      const response = { ok: true, promotionID: promoId, count: matched.length, fileCount: parsed.items.length,
        matchedCount: matched.length, excludedCount: excluded.length, matched, excluded, ownership, ownershipContext: context, ownershipDigest,
        headers: parsed.headers, skipped: parsed.skipped, items: matched, sample: matched.slice(0, 100),
        sheet: parsed.sheet, headerRow: parsed.headerRow, warnings: parsed.warnings, fileName: p.fileName || '',
        canApply: matched.length > 0, rejectionReason };
      if (p.action === 'preview') return { ...response, preview: true };
      if (!matched.length) throw new WBError(rejectionReason + ' Прежние условия не изменены.', { code: 'FOREIGN_PROMO_FILE' });
      // Повторная серверная проверка обязательна и для apply без preview. Список
      // «своих» от браузера не принимается; заново разбирается исходный файл.
      assertCatalogContext(context);
      const all = store.loadPromoNoms(), prior = all[promoId] || {};
      const importedIds = new Set(matched.map((row) => row.nmID));
      all[promoId] = {
        fileName: p.fileName || 'загружено из интерфейса', at: new Date().toISOString(),
        count: matched.length, skipped: parsed.skipped, headers: parsed.headers,
        items: matched, sheet: parsed.sheet, warnings: parsed.warnings, absolutePrices: true,
        ownership, selectedOnly: prior.selectedOnly === true,
        selectedIds: (prior.selectedIds || []).filter((nm) => importedIds.has(Number(nm)))
      };
      store.savePromoNoms(all);
      promoRevision++; promoCache.index = null; promoCache.at = 0;
      const message = 'Сохранено своих товаров: ' + matched.length + (excluded.length ? ', исключено чужих nmID: ' + excluded.length : '');
      notify('info', { where: 'promo-import', message });
      return { ...response, sentToWb: false, fileName: all[promoId].fileName, message };

    },

    /**
     * Диагностика индекса акций: сколько товаров известно по каждой акции и откуда.
     * Нужно, чтобы было видно, что загруженный вручную файл действительно долетел
     * до репрайсера (в демо API и так отдаёт весь каталог, и на глаз прирост не заметить).
     */
    /**
     * Индекс акций. По умолчанию берётся из кэша (15 минут): принудительная перестройка
     * означает запросы состава по каждой акции, а календарь WB ограничен 10 запросами
     * за 6 секунд. force нужен только явной кнопке «Обновить акции».
     */
    'promos:index': async (payload) => {
      let pi;
      try { pi = await promoIndex(!!(payload && payload.force)); } catch (e) {
        return { ok: false, error: e.message };
      }
      const uploaded = store.loadPromoNoms();
      const out = (pi.promos || []).map((p) => {
        const idx = pi.index[p.id] || { inAction: new Set(), eligible: new Set(), plan: new Map(), manualCount: 0 };
        const rec = uploaded[String(p.id)];
        const composition = promoComposition(p, idx, rec);
        const observations = Array.from((idx.observations || new Map()).values());
        const compositionKnown = (composition.source !== 'none' || composition.apiUsed) && !(idx.ownership && idx.ownership.status === 'blocked');
        const selectedCount = idx.managedIds ? composition.entries.filter((entry) => idx.managedIds.has(entry.nmID)).length : composition.entries.length;
        const live = new Map((((cache.goods && cache.goods.items) || [])).map((g) => [Number(g.nmID), g]));
        const withPlanPrice = composition.entries.filter((entry) => Number(entry.data.planPrice || entry.data.plannedPrice || (live.get(entry.nmID) || {}).plannedPrice) > 0).length;
        const priceControl = { matching: 0, above: 0, partial: 0, unknown: 0, ready: 0, ended: 0 };
        observations.forEach((o) => {
          const key = o.status === 'by-price' ? 'matching' : o.status === 'above-price' ? 'above' :
            o.status === 'partial-sizes' ? 'partial' : ['ready', 'not-started'].includes(o.status) ? 'ready' : o.status === 'ended' ? 'ended' : 'unknown';
          priceControl[key]++;
        });
        return {
          promoId: p.id, promoName: p.name, type: p.type,
          startDateTime: p.startDateTime || '', endDateTime: p.endDateTime || '',
          source: composition.source, compositionKnown: idx.localUnconfirmed ? false : compositionKnown, localUnconfirmed: !!idx.localUnconfirmed, calendarKnown: !idx.localUnconfirmed, inferredCount: composition.inferredCount, apiCount: composition.apiCount, apiPartial: composition.apiPartial,
          compositionCount: compositionKnown ? composition.entries.length : null,
          selectedCount: compositionKnown ? selectedCount : null,
          apiConfirmedCount: idx.apiConfirmed ? idx.apiConfirmed.size : 0,
          fileSnapshotCount: idx.fileSnapshotCount || 0, priceControl,
          ownership: idx.ownership || null, storedCount: idx.storedCount || 0,
          auto: !!idx.auto,
          noApi: idx.noApi || '',
          requiredDiscountPct: Number(p.requiredDiscountPct || p.participationPercentage || 0),
          inAction: idx.inAction ? idx.inAction.size : 0,
          eligible: idx.eligible ? idx.eligible.size : 0,
          withPlanPrice: compositionKnown ? withPlanPrice : null,
          manualCount: idx.manualCount || 0,
          manualFile: rec ? rec.fileName : '',
          manualAt: rec ? rec.at : ''
        };
      });
      return {
        ok: true,
        promos: out,
        uploadedTotal: Object.keys(uploaded).length,
        at: pi.at,
        // сколько акций WB не отдаёт по API (автоакции и закрытые акции) — интерфейс
        // показывает это одной плашкой вместо потока ошибок 422
        noApiCount: pi.noApiCount || 0,
        noApi: Object.keys(pi.noApi || {}).map((id) => ({ promoId: Number(id), reason: pi.noApi[id] })),
        hardErrors: pi.hardErrors || []
      };
    },

    'promos:noms': async (payload) => {
      const p = payload || {};
      const all = store.loadPromoNoms();
      if (p.promotionID !== undefined && p.promotionID !== null) {
        const rec = all[String(p.promotionID)] || null;
        return { promotionID: String(p.promotionID), loaded: !!rec, record: rec };
      }
      const out = {};
      for (const [k, v] of Object.entries(all)) out[k] = { fileName: v.fileName, at: v.at, count: v.count };
      return { all: out, count: Object.keys(all).length };
    },

    'promos:save-selection': async (payload) => {
      const p = payload || {}, id = Number(p.promotionID);
      if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(p.nmIDs)) throw new WBError('Не переданы акция и выбранные товары.', { code: 'BAD_PROMO_SELECTION' });
      const context = catalogContext(), catalog = await ownershipCatalog();
      const composition = await handlers['promos:items']({ promotionID: id });
      assertCatalogContext(context);
      const known = new Set(composition.items.map((row) => Number(row.nmID)));
      const ids = [...new Set(p.nmIDs.map(Number))];
      if (ids.some((nm) => !Number.isSafeInteger(nm) || !catalog.ids.has(nm) || !known.has(nm))) throw new WBError('В выбранных товарах есть позиции вне текущего кабинета или состава акции.', { code: 'BAD_PROMO_SELECTION' });
      const all = store.loadPromoNoms(), old = all[String(id)] || {};
      const { matched, excluded } = matchPromoOwnership(old.items || composition.items.map((row) => ({ ...row, inActionKnown: false })), catalog);
      if (!matched.length && (old.items || []).length) throw new WBError('Сохранённый файл не содержит товаров текущего кабинета. Загрузите правильную выгрузку; прежние условия не изменены.', { code: 'FOREIGN_PROMO_FILE' });
      all[String(id)] = { ...old, fileName: old.fileName || 'Условия, сохранённые в приложении',
        at: old.at || new Date().toISOString(), count: matched.length, items: matched,
        ownership: { status: 'verified', catalogAt: new Date(catalog.at).toISOString(), catalogCount: catalog.items.length,
          matchedCount: matched.length, excludedCount: excluded.length, demo: isDemo() },
        selectedOnly: true, selectedIds: ids, selectionSavedAt: new Date().toISOString() };
      store.savePromoNoms(all); promoRevision++; promoCache.index = null; promoCache.at = 0;
      return { ok: true, saved: ids.length, promotionID: id, sentToWb: false };
    },

    'promos:clear-noms': async (payload) => {
      const p = payload || {};
      const all = store.loadPromoNoms();
      if (p.promotionID !== undefined && p.promotionID !== null) {
        delete all[String(p.promotionID)];
      } else {
        for (const k of Object.keys(all)) delete all[k];
      }
      store.savePromoNoms(all); promoRevision++;
      promoCache.index = null; promoCache.at = 0;
      return { ok: true, left: Object.keys(all).length };
    },

    // ───────────────────────── Данные для экономики ─────────────────────────

    'wb:stats': async (opts) => {
      const r = await loadStats((opts && opts.days) || 30, !!(opts && opts.force));
      return r.rows;
    },

    'wb:cards': async (opts) => {
      if (isDemo()) return getDemo().getCards();
      if (!(opts && opts.force) && cache.cards && Date.now() - cache.cardsAt < CACHE_TTL_MS) return cache.cards;
      const res = await getClient().getCards({ maxCards: 2000 });
      cache.cards = res;
      cache.cardsAt = Date.now();
      return res;
    },

    // ───────────────────────── Себестоимость и расходы ─────────────────────────

    'costs:get': async () => ({ items: costsMap(), demo: isDemo() }),

    /**
     * Пересчитать overrides (себестоимость и расходы) из сохранённых значений — БЕЗ похода в WB.
     *
     * Зачем: таблица «Цены и скидки» строится из overrides, а они перечитывались только
     * вместе с товарами. Из-за этого себестоимость, введённая в разделе «Себестоимость»,
     * не появлялась в «Ценах» до полного обновления данных из кабинета.
     */
    'costs:overrides': async () => {
      const costs = costsMap();
      const cached = (cache.goods && cache.goods.items) || null;
      const items = cached || Object.keys(costs).map((k) => ({ nmID: Number(k) }));
      const overrides = overridesFor(items);
      if (isDemo()) { try { mergeDemoOverrides(items, overrides); } catch (e) { /* демо-данные не обязательны */ } }
      return { overrides, demo: isDemo(), fromCache: !!cached, count: Object.keys(overrides).length };
    },

    'costs:save': async (payload) => {
      const items = Object.assign({}, costsMap());
      const patch = (payload && payload.items) || {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) { delete items[k]; continue; }
        items[k] = Object.assign({}, items[k], normalizeCostRecord(items[k], v), { updatedAt: new Date().toISOString() });
      }
      store.saveCosts(items);
      return { ok: true, count: Object.keys(items).length };
    },

    'costs:import': async (payload) => {
      /**
       * Импорт себестоимости принимает либо готовые строки (их нормализует вьюха после
       * разбора CSV), либо сам файл в base64. Второй путь нужен для XLSX: это ZIP с XML,
       * в браузерном окне его не разобрать, а в главном процессе уже есть свой читатель
       * `xlsx-lite` (тот же, что разбирает список товаров акции).
       */
      let rows = (payload && payload.rows) || [];
      if ((!rows || !rows.length) && payload && payload.base64) {
        let table;
        try {
          table = readTable(Buffer.from(String(payload.base64), 'base64'), payload.fileName || '');
        } catch (e) {
          throw new WBError('Не удалось прочитать файл: ' + e.message, { code: 'BAD_FILE' });
        }
        rows = costsRowsFromTable(table);
        if (!rows.length) throw new WBError('В файле нет строк с себестоимостью.', { code: 'EMPTY_FILE' });
      }
      const items = Object.assign({}, costsMap());
      let updated = 0;
      for (const r of rows) {
        const nm = String(r.nmID || r['нм-код'] || r['НМ-код'] || r['Артикул WB'] || r.nmId || '').trim();
        if (!nm || !/^\d+$/.test(nm)) continue;
        const cur = items[nm] || {};
        const next = Object.assign({}, cur);
        const setIf = (field, val) => {
          if (val === undefined || val === null || val === '') return;
          const n = Number(String(val).replace(',', '.'));
          if (Number.isFinite(n)) next[field] = n;
        };
        const rawCost = r.costEntered !== undefined ? r.costEntered : (r.costPriceRub !== undefined ? r.costPriceRub : r['Себестоимость']);
        if (rawCost !== undefined && rawCost !== null && rawCost !== '') { const n = Number(String(rawCost).replace(',', '.')); if (Number.isFinite(n)) next.costEntered = n; }
        const rawCurrency = r.currency !== undefined ? r.currency : r['Валюта'];
        if (rawCurrency !== undefined && rawCurrency !== null && String(rawCurrency).trim()) {
          const currency = String(rawCurrency).trim().toUpperCase();
          if (!isCostCurrency(currency)) throw new WBError('Некорректный код валюты закупки «' + currency + '» у товара ' + nm + ': нужен трёхбуквенный код.', { code: 'BAD_CURRENCY' });
          next.currency = currency;
        }
        setIf('commissionPct', r.commissionPct !== undefined ? r.commissionPct : r['Комиссия %']);
        setIf('logisticsRub', r.logisticsRub !== undefined ? r.logisticsRub : r['Логистика ₽']);
        setIf('storageRub', r.storageRub !== undefined ? r.storageRub : r['Хранение ₽']);
        setIf('packagingRub', r.packagingRub !== undefined ? r.packagingRub : r['Упаковка ₽']);
        setIf('adPct', r.adPct !== undefined ? r.adPct : r['Реклама %']);
        setIf('adRub', r.adRub !== undefined ? r.adRub : r['Реклама ₽']);
        setIf('otherPct', r.otherPct !== undefined ? r.otherPct : r['Прочие расходы %']);
        setIf('otherRub', r.otherRub !== undefined ? r.otherRub : r['Прочие расходы ₽']);
        WorkspaceConfig.costPatch(next);
        setIf('acceptRub', r.acceptRub !== undefined ? r.acceptRub : r['Приёмка ₽']);
        setIf('sppPct', r.sppPct !== undefined ? r.sppPct : r['СПП %']);
        setIf('volumeLiters', r.volumeLiters !== undefined ? r.volumeLiters : r['Объём л']);
        if (r.taxMode || r['Налог']) next.taxMode = String(r.taxMode || r['Налог']);
        if (r.note || r['Комментарий']) next.note = String(r.note || r['Комментарий']);
        const normalizedImport = normalizeCostRecord(cur, next);
        normalizedImport.updatedAt = new Date().toISOString();
        items[nm] = normalizedImport;
        updated++;
      }
      store.saveCosts(items);
      return { ok: true, updated, count: Object.keys(items).length };
    },

    'costs:clear': async (payload) => {
      const items = costsMap();
      const ids = (payload && payload.nmIDs) || [];
      if (ids.length) ids.forEach((id) => delete items[String(id)]);
      else Object.keys(items).forEach((k) => delete items[k]);
      store.saveCosts(items);
      return { ok: true, count: Object.keys(items).length };
    },

    'cache:clear': async () => {
      invalidateGoodsCache();
      cache.stats = null; cache.statsAt = 0;
      cache.cards = null; cache.cardsAt = 0;
      return { ok: true };
    },

    // ───────────────────────── Репрайсер ─────────────────────────

    'repricer:state': async () => {
      const cfg = repricerCfg();
      return {
        config: cfg,
        defaults: cfg.defaults,
        presets: cfg.presets,
        strategies: [...RP.STRATEGIES, ...(cfg.customStrategies || []).map((d) => ({ id: d.id, name: d.name, hint: 'Своя стратегия: ' + ((d.rules || []).length) + ' правил(а), первое сработавшее побеждает.', custom: true }))],
        customStrategies: cfg.customStrategies || [],
        customFields: RP.CUSTOM_FIELDS,
        strategyAlgorithms: RP.STRATEGY_ALGORITHMS,
        itemConfigs: publicItemConfigs(),
        competitors: await competitorsMap(),
        competitorCount: Object.keys(await competitorsMap()).length,
        scheduler: {
          enabled: !!cfg.enabled,
          running: sched.running,
          nextRunAt: sched.nextRunAt ? sched.nextRunAt.toISOString() : null,
          lastRunAt: sched.lastRun ? sched.lastRun.at : null
        },
        runs: store.loadRuns().slice(0, 60),
        demo: isDemo()
      };
    },

    'repricer:save': async (patch) => {
      const cur = repricerCfg();
      // принимаем и «плоский» патч ({limits: …}), и обёрнутый ({config: {limits: …}})
      const p = patch && patch.config && typeof patch.config === 'object' ? patch.config : (patch || {});
      WorkspaceConfig.assertTree(p);
      if (['analyticsArchive', 'officialSpp'].some((k) => Object.prototype.hasOwnProperty.call(p, k))) throw new WBError('Историю/источники статистики нельзя изменять через настройки репрайсера.', { code: 'BAD_CONFIG' });
      if (p.strategyTemplates) Object.values(p.strategyTemplates).forEach(WorkspaceConfig.template);
      const next = RP.mergeConfig(cur, p);

      // суточный лимит не может быть меньше лимита за одно обновление
      const perUpdate = Number(next.limits.maxChangePerUpdatePct) || 0;
      const perDay = Number(next.limits.maxChangePerDayPct) || 0;
      if (perDay > 0 && perUpdate > 0 && perDay < perUpdate) next.limits.maxChangePerDayPct = perUpdate;

      store.saveRepricer(next);
      const schedState = applyScheduler();
      return { ok: true, config: repricerCfg(), scheduler: schedState };
    },

    /**
     * Курсы валют себестоимости (задание D). Отдельный канал не нужен для сохранения —
     * курсы правятся через `settings:save {costRates: {CNY: 13}}`, а этот канал отдаёт
     * текущие курсы и список валют, чтобы интерфейс не хардкодил справочник.
     */
    'costs:rates': async () => {
      const s = getSettings();
      const currencies = [...new Set([...COST_CURRENCIES, ...Object.keys(s.costRates || {}).map((code) => String(code).trim().toUpperCase()).filter(isCostCurrency)])];
      return { rates: s.costRates || {}, currencies, currency: s.currency || 'RUB' };
    },

    'repricer:item-configs:get': async () => publicItemConfigs(),

    'repricer:item-configs:save': async (payload) => {
      const items = { ...store.loadItemConfigs() }, patches = payload && payload.items || {};
      WorkspaceConfig.assertTree(patches, 300000, 12);
      for (const [nm, value] of Object.entries(patches)) {
        if (!/^[1-9]\d*$/.test(nm) || !Number.isSafeInteger(Number(nm))) throw new WBError('Некорректный nmID настройки товара.', { code: 'BAD_NMID' });
        if (value === null) { delete items[nm]; continue; }
        if (!WorkspaceConfig.plain(value)) throw new WBError('Некорректные настройки товара.', { code: 'BAD_CONFIG' });
        const clean = { ...value }, restart = clean.restartBoost === true;
        delete clean.boostRuntime; delete clean.safetyLock; delete clean.restartBoost;
        if (clean.strategy && !RP.STRATEGIES.some((s) => s.id === clean.strategy) && !(repricerCfg().customStrategies || []).some((s) => s.id === clean.strategy)) throw new WBError('Неизвестная стратегия.', { code: 'BAD_CONFIG' });
        for (const key of ['targetMarginPct', 'minMarginPct', 'planSensitivityPct', 'targetTurnoverDays', 'competitorOffsetPct', 'elasticityPct']) {
          if (clean[key] !== undefined && clean[key] !== null && clean[key] !== '') WorkspaceConfig.template({ [key]: clean[key] });
        }
        // Пороги коридора в рублях и максимальная Маржа: неотрицательные конечные числа.
        for (const key of ['minPrice', 'maxPrice', 'minMarginRub', 'maxMarginRub', 'targetMarginRub']) {
          if (clean[key] !== undefined && clean[key] !== null && clean[key] !== '' && (!Number.isFinite(Number(clean[key])) || Number(clean[key]) < 0 || Number(clean[key]) > 1000000000)) throw new WBError('Порог «' + key + '» должен быть неотрицательным числом.', { code: 'BAD_CONFIG' });
        }
        if (clean.maxMarginPct !== undefined && clean.maxMarginPct !== null && clean.maxMarginPct !== '' && (!Number.isFinite(Number(clean.maxMarginPct)) || Number(clean.maxMarginPct) < 0 || Number(clean.maxMarginPct) > 99)) throw new WBError('Максимальная Маржа должна быть от 0 до 99%.', { code: 'BAD_CONFIG' });
        if (Number(clean.minMarginRub) > 0 && Number(clean.maxMarginRub) > 0 && Number(clean.maxMarginRub) < Number(clean.minMarginRub)) throw new WBError('Максимальная Маржа, ₽ не может быть ниже минимальной.', { code: 'BAD_CONFIG' });
        if (Object.prototype.hasOwnProperty.call(clean, 'boost') && clean.boost !== null) {
          const validated = Boost.validate(clean.boost), old = items[nm] && items[nm].boost;
          let same = false;
          try { same = !restart && old && !old.requiresRestart && Boost.signature(Boost.validate(old)) === Boost.signature(validated); } catch (_) {}
          clean.boost = { ...validated, runId: same && old.runId || crypto.randomUUID(), startedAt: same && old.startedAt || new Date().toISOString() };
        }
        const next = { ...(items[nm] || {}) };
        for (const [key, v] of Object.entries(clean)) {
          if (v === null || v === '' || v === undefined) delete next[key];
          else if (WorkspaceConfig.plain(v) && WorkspaceConfig.plain(next[key]) && key !== 'boost') next[key] = { ...next[key], ...v };
          else next[key] = v;
        }
        if (restart || clean.boost && (!items[nm] || !items[nm].boost || clean.boost.runId !== items[nm].boost.runId)) delete next.boostRuntime;
        next.updatedAt = new Date().toISOString(); items[nm] = next;
      }
      store.saveItemConfigs(items);
      return { ok: true, count: Object.keys(items).length };
    },

    'strategies:template': async (payload) => {
      const id = String(payload && payload.strategy || '');
      if (!RP.STRATEGIES.some((s) => s.id === id)) throw new WBError('Неизвестный шаблон стратегии.', { code: 'BAD_CONFIG' });
      const values = WorkspaceConfig.template(payload.values), templates = { ...repricerCfg().strategyTemplates };
      if (values === null) delete templates[id]; else templates[id] = values;
      store.saveRepricer({ strategyTemplates: templates }, { replaceKeys: ['strategyTemplates'] });
      return { ok: true, templates };
    },

    /**
     * Свои стратегии (конструктор в формате INDEEPA). Каждая правка кладёт предыдущую
     * версию в revisions (до 10) — откат делается повторным сохранением выбранной версии.
     * Удаление: payload { id, strategy: null }. В WB ничего не отправляется.
     */
    'strategies:custom-save': async (payload) => {
      const list = (repricerCfg().customStrategies || []).slice();
      const id = String((payload && payload.id) || (payload && payload.strategy && payload.strategy.id) || '');
      const at = new Date().toISOString();
      if (!payload || payload.strategy === null) {
        const next = list.filter((d) => d.id !== id);
        if (next.length === list.length) throw new WBError('Своя стратегия не найдена.', { code: 'BAD_CONFIG' });
        store.saveRepricer({ customStrategies: next }, { replaceKeys: ['customStrategies'] });
        return { ok: true, customStrategies: next };
      }
      WorkspaceConfig.assertTree(payload.strategy, 20000, 12);
      const def = JSON.parse(JSON.stringify(payload.strategy));
      const problem = RP.validateCustomStrategy(def);
      if (problem) throw new WBError(problem, { code: 'BAD_STRATEGY' });
      def.name = String(def.name).trim().slice(0, 120);
      def.enabled = def.enabled !== false;
      def.ignoreMaximums = !!def.ignoreMaximums;
      def.rules = def.rules.map((rule) => ({ ...rule, name: String(rule.name).trim().slice(0, 160), enabled: rule.enabled !== false, schedule: null }));
      if (id) {
        const idx = list.findIndex((d) => d.id === id);
        if (idx < 0) throw new WBError('Своя стратегия не найдена.', { code: 'BAD_CONFIG' });
        const prev = list[idx];
        const revisions = [{ savedAt: prev.updatedAt || at, name: prev.name, enabled: prev.enabled, ignoreMaximums: !!prev.ignoreMaximums, rules: prev.rules }, ...(prev.revisions || [])].slice(0, 10);
        list[idx] = { ...def, id, createdAt: prev.createdAt || at, updatedAt: at, revisions };
      } else {
        def.id = 'custom-' + crypto.randomUUID().slice(0, 8);
        def.createdAt = at; def.updatedAt = at; def.revisions = [];
        list.push(def);
      }
      store.saveRepricer({ customStrategies: list }, { replaceKeys: ['customStrategies'] });
      return { ok: true, customStrategies: list, id: def.id };
    },

    'repricer:competitors:get': async () => competitorsMap(),

    'repricer:competitors:save': async (payload) => {
      const items = Object.assign({}, store.loadCompetitors());
      const patch = (payload && payload.items) || {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || (Array.isArray(v) && !v.length)) { delete items[k]; continue; }
        items[k] = v;
      }
      store.saveCompetitors(items);
      return { ok: true, count: Object.keys(items).length };
    },

    'repricer:competitors:import': async (payload) => {
      const rows = (payload && payload.rows) || [];
      const items = Object.assign({}, store.loadCompetitors());
      let added = 0;
      for (const r of rows) {
        const nm = String(r.nmID || r['нм-код'] || r['НМ-код'] || r['Артикул WB'] || r.nmId || '').trim();
        if (!nm || !/^\d+$/.test(nm)) continue;
        const list = Array.isArray(items[nm]) ? items[nm].slice() : [];
        list.push({
          id: `${nm}-c${list.length + 1}-${Date.now() % 10000}`,
          name: String(r.name || 'Конкурент'),
          price: Number(r.price) || 0,
          stock: r.stock === undefined || r.stock === '' ? 1 : Number(r.stock),
          enabled: r.enabled === undefined ? true : !!r.enabled,
          updatedAt: new Date().toISOString()
        });
        items[nm] = list;
        added++;
      }
      store.saveCompetitors(items);
      return { ok: true, added, items: Object.keys(items).length };
    },

    'repricer:competitors:drift': async () => {
      if (!isDemo()) return { ok: false, message: 'Доступно только в демо-режиме: имитация изменения цен конкурентов.' };
      return Object.assign({ ok: true }, await getDemo().driftCompetitors());
    },

    /**
     * Собрать XLSX на сервере и отдать base64 — для выгрузки «Excel (до 150к строк)»,
     * как в репрайсере INDEEPA. Пишем собственным модулем без зависимостей
     * (electron/xlsx-write.js), поэтому работает и в Electron, и в браузере.
     */
    'xlsx:build': async (payload) => {
      const p = payload || {};
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const headers = Array.isArray(p.headers) ? p.headers : null;
      const MAX = 150000;
      if (rows.length > MAX) {
        throw new WBError('Слишком много строк для Excel: ' + rows.length + '. Максимум ' + MAX +
          ' — выгрузите CSV (он без ограничения) или сузьте фильтр.', { code: 'TOO_MANY_ROWS' });
      }
      const buf = buildXlsx(rows, { headers: headers || undefined, sheetName: p.sheetName || 'Данные' });
      return {
        ok: true,
        base64: buf.toString('base64'),
        size: buf.length,
        rows: rows.length,
        columns: headers ? headers.length : ((rows[0] || []).length),
        fileName: String(p.fileName || 'export.xlsx')
      };
    },

    'repricer:calc': async (opts) => calcRepricer(opts || {}),

    'repricer:boost-options': async (payload) => {
      const rows = await buildContexts({ promos: true, noBoostOrders: true });
      const row = rows.find((r) => String(r.ctx.nmID) === String(payload && payload.nmID));
      if (!row) throw new WBError('Товар не найден в текущем кабинете.', { code: 'UNKNOWN_ITEM' });
      return { ok: true, nmID: row.ctx.nmID, day: StatMath.dayKey(), config: row.itemCfg.boost || null,
        promos: (row.ctx.promos || []).filter((p) => Number(p.planPrice) > 0 && (p.absolutePlan || p.source === 'api')).map((p) => ({ ...p, economy: row.ctx.econAt(Number(p.planPrice)) })).sort((a, b) => b.planPrice - a.planPrice) };
    },
    'analytics:load': async () => {
      if (isDemo()) { await ensureDemoAnalytics(); return { ok: true, demo: true, note: 'ABC: сгенерированная демо-история, не данные реального кабинета.' }; }
      const context = catalogContext(), from = StatMath.dayKey(Date.now() - 90 * StatMath.DAY);
      const res = await getClient().getStatRows('/api/v1/supplier/sales', from + 'T00:00:00', { flag: 0, maxPages: Number(getSettings().statsMaxPages || 3), maxWaitMs: 200000 });
      assertCatalogContext(context);
      captureStats({ sales: res.rows || [], from, salesComplete: !res.truncated && !res.error });
      return { ok: !res.truncated && !res.error, rows: (res.rows || []).length, truncated: !!res.truncated, note: 'Доступные 90 дней; 6 месяцев только при накопленной полной истории. Прибыль ABC — оценка по текущей себестоимости.' };
    },
    'spp:refresh': async () => {
      if (isDemo()) return { ok: true, demo: true, count: 0, note: 'Демо: показываем демонстрационную СПП, официальных запросов не было.' };
      const result = await loadOrdersIntoStats(30, true);
      return { ...result, ok: result.ok !== false, count: Object.keys(officialSpp).length, note: 'СПП последних известных заказов WB, не гарантированная цена витрины сейчас.' };
    },
    'repricer:health': async () => {
      const data = await calcRepricer({ full: true, previewOnly: true, noBoostOrders: true });
      const issues = data.results.flatMap((r) => (r.issues || []).map((i) => ({ ...i, nmID: r.nmID, vendorCode: r.vendorCode, title: r.title })));
      return { ok: true, issues, critical: issues.filter((i) => i.level === 'critical').length, warning: issues.filter((i) => i.level === 'warning').length, blockedItems: data.results.filter((r) => r.autoBlocked).length };
    },

    // ─────────── Предложение репрайсера: фаза «показать» и фаза «отправить» ───────────

    /**
     * Что репрайсер ХОЧЕТ поставить (фаза 1). Фактические цены при этом не меняются:
     * предложение хранится отдельно, а в интерфейс отдаётся вместе с временем отправки.
     */
    'repricer:proposal': async () => {
      const prop = store.loadProposals();
      const cfg = repricerCfg();
      return Object.assign({ ok: true, demo: isDemo(), twoPhase: cfg.schedule.twoPhase !== false }, prop);
    },

    /** Фаза 2: отправить сохранённое предложение (с проверкой, что цены в WB не уехали). */
    'repricer:proposal-send': async (payload) => sendProposal((payload && payload.source) || 'repricer-manual', payload && payload.nmIDs),

    /** Отказаться от предложения, ничего не отправляя. */
    'repricer:proposal-discard': async () => {
      const cleared = store.clearProposals();
      notify('repricer', { type: 'proposal-discarded' });
      return Object.assign({ ok: true }, cleared);
    },

    /**
     * Всё для карточки товара (двойной клик по строке): экономика, конкуренты,
     * комиссии, акции и история пересчёта — одним запросом,
     * чтобы окно открывалось сразу и не дёргало WB по каждому блоку.
     */
    'items:card': async (payload) => {
      const nmID = Number(payload && payload.nmID);
      if (!(nmID > 0)) throw new WBError('Не указан артикул товара (nmID).', { code: 'BAD_NMID' });
      const g = await handlers['wb:goods']({});
      const item = ((g && g.items) || []).find((x) => Number(x.nmID) === nmID) || null;
      const overrides = ((g && g.overrides) || {})[String(nmID)] || {};
      const stats = ((g && g.stats) || []).find((x) => Number(x.nmID) === nmID) || null;
      const facts = ((g && g.facts) || {})[String(nmID)] || null;
      const cards = cache.cards || [];
      const card = cards.find((c) => Number(c.nmID) === nmID) || null;
      const pi = await promoIndex().catch(() => null);
      const proposal = (store.loadProposals().items || []).find((x) => Number(x.nmID) === nmID) || null;
      const recalc = (store.loadRecalcHistory()[String(nmID)] || []).slice(-40).reverse();
      const priceHist = (store.loadPriceHistory()[String(nmID)] || []).slice(-40).reverse();
      const competitors = (await competitorsMap())[String(nmID)] || [];
      const itemConfig = (store.loadItemConfigs() || {})[String(nmID)] || null;
      const enteredCosts = (store.loadCosts().items || {})[String(nmID)] || {};
      const promos = item ? promosForItem(item, pi) : [];
      // остатки по складам WB: сумма + разбивка по складам и регионам (из кэша)
      const stocks = stocksMap()[String(nmID)] || null;
      const wbStock = !!stocks;
      const manualStock = enteredCosts.stock !== undefined && enteredCosts.stock !== null && enteredCosts.stock !== '';
      const stockValue = wbStock ? Number(stocks.total || 0) : Number(overrides.stock || 0);
      return {
        ok: !!item,
        demo: isDemo(),
        nmID,
        item,
        overrides,
        stats,
        facts,
        card,
        stocks,
        stock: stockValue,
        stockSource: wbStock ? 'wb' : (manualStock ? 'manual' : (isDemo() ? 'demo' : 'unknown')),
        promos,
        promosNoApi: pi ? Object.keys(pi.noApi || {}).length : 0,
        competitors,
        itemConfig, enteredCosts,
        proposal,
        recalcHistory: recalc,
        priceHistory: priceHist,
        statsMeta: cache.statsMeta || null,
        settings: getSettings(),
        // конфиг репрайсера нужен карточке, чтобы приводить цену конкурента к нашей
        // системе координат («с СПП» и «с кошельком») так же, как это делает движок
        repricerConfig: repricerCfg()
      };
    },

    'repricer:send': async (payload) => {
      const p = payload || {};
      // точные цены из интерфейса (уже показанные пользователю) — пересчёт не нужен
      if (Array.isArray(p.items) && p.items.length) {
        return sendPrices(p.items.map((x) => ({
          nmID: x.nmID,
          needSend: true,
          proposed: {
            basePrice: Number(x.price),
            discount: Number(x.discount),
            sellerPrice: Number(x.price) * (1 - Number(x.discount) / 100)
          }
        })), p.source || 'repricer-manual');
      }
      const res = await calcRepricer({ mode: 'manual-send', full: true });
      const only = p.nmIDs && p.nmIDs.length
        ? res.results.filter((r) => p.nmIDs.includes(Number(r.nmID)))
        : res.results;
      return sendPrices(only, p.source || 'repricer-manual');
    },

    'repricer:runs': async () => store.loadRuns().slice(0, 100),

    /**
     * Журналы для вкладок «Журнал изменения цен» и «Журнал участия в акциях»
     * (как в репрайсере INDEEPA). Отдаёт плоский список событий, уже отсортированный
     * по времени, чтобы интерфейс не склеивал три разных хранилища на клиенте.
     *
     * kind: 'price' — цена ушла в WB; 'propose' — репрайсер предложил цену;
     *       'promo-exit' — очередь возврата цены после выхода из автоакции.
     */
    'repricer:journal': async (payload) => {
      const p = payload || {};
      const limit = Math.min(150000, Math.max(1, Number(p.limit) || 500));
      const q = String(p.q || '').trim().toLowerCase();
      const from = p.dateFrom ? iso10(p.dateFrom) : '';
      const to = p.dateTo ? iso10(p.dateTo) : '';
      const kinds = Array.isArray(p.kinds) && p.kinds.length ? p.kinds.map(String) : null;

      const goods = ((cache.goods && cache.goods.items) || []);
      const byNm = new Map(goods.map((g) => [String(g.nmID), g]));
      const titleOf = (nm) => {
        const g = byNm.get(String(nm));
        return g ? (g.title || (g.brand + ' ' + g.vendorCode)) : '';
      };
      const vendorOf = (nm) => {
        const g = byNm.get(String(nm));
        return g ? (g.vendorCode || '') : '';
      };

      const events = [];

      // 1) история цен: что реально ушло в WB
      const priceHist = store.loadPriceHistory() || {};
      for (const [nm, list] of Object.entries(priceHist)) {
        (Array.isArray(list) ? list : []).forEach((h) => {
          events.push({
            kind: 'price', at: h.at, nmID: Number(nm),
            vendorCode: vendorOf(nm), title: titleOf(nm),
            basePrice: Number(h.basePrice) || 0, discount: Number(h.discount) || 0,
            sellerPrice: Number(h.sellerPrice) || 0,
            source: h.source || '', strategy: h.source || ''
          });
        });
      }

      // 2) история пересчёта: что предложил репрайсер и что отправил
      const recalc = store.loadRecalcHistory() || {};
      for (const [nm, list] of Object.entries(recalc)) {
        (Array.isArray(list) ? list : []).forEach((h) => {
          events.push({
            kind: h.phase === 'send' ? 'price' : h.phase === 'submitted' ? 'submitted' : 'propose',
            at: h.at, nmID: Number(nm),
            vendorCode: vendorOf(nm), title: titleOf(nm),
            basePrice: Number(h.basePrice) || 0, discount: Number(h.discount) || 0,
            sellerPrice: Number(h.sellerPrice) || 0,
            prevSellerPrice: Number(h.prevSellerPrice) || 0,
            strategy: h.strategy || '', reason: h.reason || '',
            sent: !!h.sent, phase: h.phase || ''
          });
        });
      }

      // 3) журнал участия в акциях: входы, выходы, возвраты цены (постоянная история)
      (store.loadPromoJournal() || []).forEach((e) => {
        events.push({
          kind: e.action === 'join' ? 'promo-join' : (e.action === 'restore' ? 'promo-restore' : 'promo-exit'),
          at: e.at, nmID: Number(e.nmID),
          vendorCode: e.vendorCode || vendorOf(e.nmID), title: e.title || titleOf(e.nmID),
          promoId: e.promoId, promoNames: e.promoName ? String(e.promoName).split(',').map((x) => x.trim()).filter(Boolean) : [],
          promoStartAt: e.promoStartAt || '', promoEndAt: e.promoEndAt || '',
          forecast: e.forecast || null,
          sellerPrice: U2(e.priceAfter), prevSellerPrice: U2(e.priceBefore),
          basePrice: 0, discount: 0,
          status: e.ok ? 'done' : 'failed',
          reason: e.reason || '', source: e.source || '',
          ok: e.ok !== false, error: e.error || '',
          action: e.action
        });
      });

      // 4) очередь возврата цены после выхода из автоакции (незакрытые позиции)
      try {
        const exits = await handlers['repricer:promo-exits']();
        (Array.isArray(exits) ? exits : []).forEach((x) => {
          events.push({
            kind: 'promo-exit', at: x.at, nmID: Number(x.nmID),
            vendorCode: x.vendorCode || vendorOf(x.nmID), title: x.title || titleOf(x.nmID),
            sellerPrice: Number(x.restoreSellerPrice) || 0,
            basePrice: Number(x.raisedBase) || 0, discount: Number(x.raisedDiscount) || 0,
            status: x.status || '', promoNames: x.promoNames || [],
            blockedByAutoPromo: !!x.blockedByAutoPromo,
            reason: (x.promoNames || []).join(', ')
          });
        });
      } catch (e) { /* очередь не обязательна */ }

      // дубли: одна и та же отправка попадает и в историю цен, и в историю пересчёта
      const seen = new Set();
      const uniq = events.filter((e) => {
        const key = [e.kind, e.nmID, e.at, e.sellerPrice].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let out = uniq;
      if (kinds) out = out.filter((e) => kinds.includes(e.kind));
      if (from) out = out.filter((e) => iso10(e.at) >= from);
      if (to) out = out.filter((e) => iso10(e.at) <= to);
      if (q) out = out.filter((e) => String(e.nmID).includes(q) ||
        String(e.vendorCode || '').toLowerCase().includes(q) ||
        String(e.title || '').toLowerCase().includes(q) ||
        String(e.strategy || '').toLowerCase().includes(q));
      out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

      const total = out.length;
      return {
        ok: true, demo: isDemo(), total,
        events: out.slice(0, limit),
        truncated: total > limit ? total - limit : 0,
        byKind: {
          price: out.filter((e) => e.kind === 'price').length,
          propose: out.filter((e) => e.kind === 'propose').length,
          'promo-join': out.filter((e) => e.kind === 'promo-join').length,
          'promo-exit': out.filter((e) => e.kind === 'promo-exit').length,
          'promo-restore': out.filter((e) => e.kind === 'promo-restore').length
        },
        runs: store.loadRuns().slice(0, 60)
      };
    },

    'repricer:history': async (nmID) => {
      const all = store.loadPriceHistory();
      return nmID ? (all[String(nmID)] || []) : all;
    },

    'repricer:scheduler': async (payload) => {
      const p = payload || {};
      store.saveRepricer({ enabled: !!p.enabled });
      const st = applyScheduler();
      notify('repricer', { type: p.enabled ? 'scheduler-on' : 'scheduler-off', nextRunAt: st.nextRunAt });
      return { ok: true, scheduler: Object.assign(st, { config: repricerCfg() }) };
    },

    // ───────────────── Акции: план, вход, выход, возврат цены ─────────────────

    'repricer:promo-plan': async (opts) => {
      const res = await calcRepricer(Object.assign({ full: true }, opts || {}));
      const rows = res.results || [];
      const byPromo = {};
      const items = [];
      for (const r of rows) {
        if (r.error || !(r.promoActions || []).length) continue;
        for (const a of r.promoActions) {
          const k = String(a.promoId);
          const b = byPromo[k] || (byPromo[k] = {
            promoId: a.promoId, promoName: a.promoName, promoType: a.promoType,
            requiredDiscountPct: a.requiredDiscountPct, started: a.started, daysToStart: a.daysToStart,
            join: 0, exit: 0, stay: 0, recommend: 0, skip: 0, warn: 0, later: 0
          });
          if (b[a.action] !== undefined) b[a.action]++;
        }
        const ch = r.promoChosen;
        if (ch || (r.promoActions || []).some((a) => a.action === 'recommend' || a.action === 'warn')) {
          items.push({
            nmID: r.nmID, vendorCode: r.vendorCode, title: r.title,
            current: r.current, proposed: r.proposed, delta: r.delta,
            // chosen — для интерфейса, promoChosen — чтобы результат можно было
            // передать обратно в repricer:promo-apply без пересчёта
            chosen: ch || null, promoChosen: ch || null, actions: r.promoActions,
            needSend: r.needSend, warnings: r.warnings
          });
        }
      }
      return {
        summary: res.summary,
        byPromo: Object.values(byPromo),
        items,
        exits: store.loadPromoExits(),
        at: res.at,
        demo: res.demo
      };
    },

    /** Аналитика только по локальным кэшам — этот обработчик не делает запросов к WB. */
    'repricer:promo-analytics': async (opts) => {
      const p = opts || {};
      const settings = getSettings();
      const days = PromoAnalytics.clampWindowDays(p.days, settings.promoAnalyticsDays || PromoAnalytics.DEFAULT_WINDOW_DAYS);
      const factData = store.loadFactCosts() || { items: {}, meta: {} };
      const factMeta = factData.meta || {};
      const journal = store.loadPromoJournal() || [];
      const nmIDs = new Set(journal.map((e) => String(e && e.nmID || '')).filter((x) => /^[1-9]\d*$/.test(x)));
      const goods = ((cache.goods && cache.goods.items) || []).slice();
      const known = new Set(goods.map((g) => String(g.nmID)));
      nmIDs.forEach((nm) => { if (!known.has(nm)) goods.push({ nmID: Number(nm) }); });
      const overrides = overridesFor(goods);
      if (isDemo()) mergeDemoOverrides(goods, overrides);
      const result = PromoAnalytics.promoAnalytics({
        days,
        now: p.now,
        journal,
        byItemDay: factMeta.byItemDay || {},
        coveredDates: factMeta.coveredDates || [],
        reportMeta: factMeta,
        legacyFactData: Object.keys(factData.items || {}).length > 0 || Object.keys(factMeta.byDay || {}).length > 0,
        incompleteFinanceData: factMeta.reportTruncated === true,
        goods,
        overrides,
        settings,
        stockHistory: store.loadStockHistory()
      });
      return Object.assign({ demo: isDemo() }, result);
    },

    'repricer:promo-apply': async (payload) => {
      const fresh = await calcRepricer({ full: true, promos: true });
      const requested = payload && Array.isArray(payload.results) ? new Map(payload.results.map((r) => [String(r.nmID), (r.promoChosen || r.chosen || {}).type])) : null;
      const rows = requested ? fresh.results.filter((r) => requested.has(String(r.nmID)) && (!requested.get(String(r.nmID)) || requested.get(String(r.nmID)) === (r.promoChosen || {}).type)) : fresh.results;
      return applyPromoActions(rows, payload || {});
    },

    /**
     * Точечный выход из акции: поднять цену выше плановой (API WB исключить товар не даёт)
     * и поставить товар в очередь возврата прежней цены.
     */
    'repricer:promo-exit': async (payload) => {
      const list = payload && payload.items || [];
      if (!list.length) return { ok: true, exited: 0, message: 'Нет товаров для выхода' };
      const context = businessContext();
      await handlers['wb:goods']({ force: true });
      const rows = await buildContexts({ promos: true, noBoostOrders: true }), byNm = new Map(rows.map((r) => [Number(r.ctx.nmID), r]));
      assertPriceContext(context);
      const results = [], records = {}, now = new Date().toISOString();
      for (const l of list) {
        const row = byNm.get(Number(l.nmID)); if (!row) continue;
        const promo = row.ctx.promos.find((p) => String(p.id) === String(l.promoId));
        if (!promo) throw new WBError('Акция/товар не найдены в проверенном составе текущего кабинета.', { code: 'NO_PROMO' });
        const { ctx, cfg, itemCfg } = row, threshold = Number(promo.planPrice), absolute = promo.absolutePlan || promo.source === 'api';
        if (!(threshold > 0)) throw new WBError('Нет проверенного порога акции. Обновите состав.', { code: 'PROMO_NO_THRESHOLD' });
        const safe = RP.computeItem(ctx, cfg, itemCfg), wanted = Math.max(threshold * 1.02 + 1, Number(safe.corridor.min), Number(l.raiseTo) || 0);
        const pair = absolute ? RP.toBaseAndDiscount(wanted, { basePrice: ctx.basePrice, discount: ctx.discount }, cfg, itemCfg) : RP.exitPairForPromo(ctx.basePrice, Number(promo.requiredDiscountPct), wanted, { canChangeBasePrice: cfg.priceEdit.canChangeBasePrice, canCancelDiscount: cfg.priceEdit.canCancelDiscount, curSeller: ctx.sellerPrice, stepLimitPct: 0 });
        const price = U2(pair.basePrice * (1 - pair.discount / 100));
        if (absolute ? price <= threshold + .005 : !(Number(promo.requiredDiscountPct) > Number(pair.discount))) throw new WBError('При заданных ограничениях безопасный выход не достигнут.', { code: 'PROMO_EXIT_THRESHOLD' });
        const restorePair = { basePrice: ctx.basePrice, discount: ctx.discount, sellerPrice: ctx.sellerPrice, mode: 'restore-promo-exit' };
        results.push({ nmID: ctx.nmID, vendorCode: ctx.vendorCode, title: ctx.title, needSend: true, current: { basePrice: ctx.basePrice, discount: ctx.discount, sellerPrice: ctx.sellerPrice }, proposed: { basePrice: pair.basePrice, discount: pair.discount, sellerPrice: price }, sizePriceMode: ctx.sizePriceMode });
        records[ctx.nmID] = { nmID: ctx.nmID, vendorCode: ctx.vendorCode, title: ctx.title, promoIds: [promo.id], promoNames: [promo.name], raisedTo: price, raisedBase: pair.basePrice, raisedDiscount: pair.discount, restoreSellerPrice: ctx.sellerPrice, restorePair, at: now, status: 'waiting-exit' };
      }
      const sent = await sendPrices(results, 'promo-exit'), accepted = new Set((sent.confirmedIDs || []).map(String)), pending = store.loadPromoExits();
      for (const nm of accepted) pending[nm] = records[nm];
      if (accepted.size) { store.savePromoExits(pending); store.appendPromoJournal([...accepted].map((nm) => ({ at: now, nmID: Number(nm), vendorCode: records[nm].vendorCode, title: records[nm].title, action: 'exit', promoId: records[nm].promoIds[0], promoName: records[nm].promoNames[0], priceBefore: records[nm].restoreSellerPrice, priceAfter: records[nm].raisedTo, reason: 'Отправлена и подтверждена WB цена для выхода; членство акции ещё проверяется отдельно.', source: 'promo-calendar-exit', ok: true }))); }
      return { ...sent, ok: true, exited: accepted.size, pendingWb: (sent.sent || 0) - accepted.size, demo: isDemo() };
    },

    'repricer:promo-restore': async (payload) => restorePromoExits(null, payload || {}),

    'repricer:promo-exits': async () => {
      const pend = store.loadPromoExits();
      const pi = await promoIndex().catch(() => null);
      const names = (pidList) => (pidList || []).map((pid) => {
        const pr = pi && pi.promos ? (pi.promos || []).find((x) => String(x.id) === String(pid)) : null;
        return pr ? pr.name : String(pid);
      });
      return Object.entries(pend).map(([nmID, rec]) => {
        const ids = rec.promoIds || [];
        const stillInPromo = pi ? ids.some((pid) => pi.index[pid] && pi.index[pid].inAction.has(Number(nmID))) : null;
        // автоакция снова подхватит товар, как только цена вернётся ниже плановой,
        // поэтому цену держим повышенной до конца такой акции
        const blocking = pi ? ids.filter((pid) => {
          const pr = (pi.promos || []).find((x) => String(x.id) === String(pid));
          if (!pr || String(pr.type || '').toLowerCase() !== 'auto') return false;
          const end = new Date(pr.endDateTime || 0).getTime();
          return Number.isFinite(end) && end > Date.now();
        }) : [];
        return {
          nmID: Number(nmID),
          vendorCode: rec.vendorCode || '',
          title: rec.title || '',
          promoIds: ids,
          promoNames: rec.promoNames && rec.promoNames.length ? rec.promoNames : names(ids),
          raisedTo: rec.raisedTo,
          raisedBase: rec.raisedBase,
          raisedDiscount: rec.raisedDiscount,
          restoreSellerPrice: rec.restoreSellerPrice,
          restorePair: rec.restorePair || null,
          at: rec.at,
          status: stillInPromo ? 'waiting-exit' : (blocking.length ? 'waiting-promo-end' : 'ready'),
          stillInPromo,
          blockedByAutoPromo: blocking.length > 0,
          blockedPromoIds: blocking,
          blockedPromoNames: names(blocking)
        };
      });
    },

    // ───────────────── Фактические расходы из отчёта о реализации WB ─────────────────

    'facts:load': async (opts) => loadFactCosts(opts || {}),

    'facts:get': async () => {
      const d = store.loadFactCosts();
      const meta = Object.assign({}, d.meta || {});
      // Долгая ежедневная история используется главным процессом и не должна
      // сериализоваться целиком в renderer при каждом обновлении состояния.
      delete meta.byItemDay;
      delete meta.coveredDates;
      delete meta.coverageRanges;
      meta.analyticsDailyDates = Array.isArray((d.meta || {}).coveredDates) ? d.meta.coveredDates.length : 0;
      return { count: Object.keys(d.items || {}).length, items: d.items || {}, meta };
    },

    'facts:clear': async () => {
      store.clearFactCosts();
      invalidateGoodsCache();
      return { ok: true };
    },

    /**
     * Отчёт P&L (прибыли и убытки) по загруженному финансовому отчёту WB.
     *
     * Считается из СУММ отчёта о реализации (не из средних): выручка, комиссия, логистика,
     * хранение, приёмка, эквайринг, штрафы и сумма к перечислению — это факт от WB.
     * Себестоимость, упаковка, реклама и налог — ваши данные (WB их не знает),
     * поэтому прибыль = к перечислению − себестоимость − упаковка − реклама − налог.
     */
    /**
     * P&L за период.
     *
     * Период можно выбрать произвольно (dateFrom/dateTo или days): тогда отчёт WB
     * дочитывается под этот диапазон. Без параметров берётся уже загруженный снимок —
     * это быстро и не расходует лимит WB (1 запрос в минуту на категорию «Финансы»).
     */
    'reports:pl': async (opts) => {
      const s = getSettings();
      const o = opts || {};
      const wantPeriod = o.cachedOnly !== true && !!(o.dateFrom || o.dateTo || o.days);

      let d = store.loadFactCosts();
      let loaded = null;
      let periodNote = '';

      if (wantPeriod) {
        // период запрошен явно: читаем отчёт WB под него (демо — тоже поддержан)
        try {
          loaded = await loadFactCosts({
            dateFrom: o.dateFrom, dateTo: o.dateTo, days: o.days,
            period: o.period, patient: !!o.patient, save: false
          });
        } catch (e) {
          return { ok: false, empty: true, error: true, message: 'Не удалось загрузить отчёт WB за период: ' + (e.message || e), meta: (d && d.meta) || {} };
        }
        if (loaded && loaded.ok === false) {
          return {
            ok: false, empty: true, code: loaded.code, message: loaded.message,
            meta: Object.assign({}, (d && d.meta) || {}, {
              requestedFrom: loaded.dateFrom, requestedTo: loaded.dateTo, requestedDays: loaded.days
            }),
            retryAt: loaded.retryAt || null,
            keptPrevious: !!loaded.keptPrevious,
            prevItems: loaded.prevItems || 0
          };
        }
        if (loaded && loaded.factItems && Object.keys(loaded.factItems).length) {
          d = { items: loaded.factItems, meta: loaded.factMeta || {} };
          periodNote = 'Отчёт WB дочитан под выбранный период ' +
            ((loaded.factMeta && loaded.factMeta.dateFrom) || '') + ' → ' +
            ((loaded.factMeta && loaded.factMeta.dateTo) || '') + '.';
        }
      }

      const facts = d.items || {};
      const meta = d.meta || {};
      const nmIDs = Object.keys(facts);
      if (!nmIDs.length) {
        return {
          ok: false, empty: true,
          message: 'Финансовый отчёт WB не загружен — считать P&L не из чего. Загрузите его в разделе «Настройки» → «Фактические расходы» или кнопкой «Обновить данные из WB».',
          meta
        };
      }

      // Сводка нескольких кабинетов не расходует лимиты WB. Если товары ещё не
      // загружены, расчёт по финансовым суммам и локальным расходам всё равно доступен.
      let goods = (cache.goods && cache.goods.items) || [];
      if (o.cachedOnly !== true) {
        try {
          const g = await handlers['wb:goods']({});
          goods = g.items || [];
        } catch (e) { goods = []; }
      }
      const byNm = new Map(goods.map((x) => [String(x.nmID), x]));
      const overrides = overridesFor(goods.length ? goods : nmIDs.map((k) => ({ nmID: Number(k) })));
      if (isDemo() && goods.length) { try { mergeDemoOverrides(goods, overrides); } catch (e) { /* не критично */ } }

      const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
      const T = {
        salesQty: 0, returnsQty: 0, revenue: 0, commission: 0, logistics: 0, storage: 0,
        acceptance: 0, acquiring: 0, penalties: 0, forPay: 0, wbAfterLogistics: 0,
        cogs: 0, returnedCogs: 0, cogsWithReturnWriteoff: 0, packaging: 0, ad: 0, other: 0, tax: 0, profit: 0, profitWithReturnCogs: 0, forPayFromWb: 0
      };
      const byCat = {};
      const byDay = {};
      const items = [];
      const missingCost = [];

      for (const key of nmIDs) {
        const f = facts[key];
        if (!f) continue;
        const item = byNm.get(key) || { nmID: Number(key), vendorCode: '', categoryName: '', title: '' };
        const ov = overrides[key] || {};
        const p = EC.resolveParams(s, item, ov, f);

        const qty = Number(f.salesQty) || 0;
        const ret = Number(f.returnsQty) || 0;
        const revenue = Number(f.revenueTotal) || 0;
        const commission = Number(f.commissionTotal) || 0;
        const logistics = Number(f.logisticsTotal) || 0;
        const storage = Number(f.storageTotal) || 0;
        const acceptance = Number(f.acceptanceTotal) || 0;
        const acquiring = Number(f.acquiringTotal) || 0;
        const penalties = (Number(f.penaltyTotal) || 0) + (Number(f.deductionTotal) || 0);
        // ВАЖНО: «к перечислению» (ppvz_for_pay) у WB = выручка − комиссия − эквайринг.
        // Логистику, хранение, приёмку и штрафы WB выставляет ОТДЕЛЬНЫМИ строками отчёта,
        // поэтому в forPay их нет и вычитать их нужно следующим шагом.
        // Раньше я вычитал их только в сверке — прибыль оказывалась завышенной
        // ровно на сумму логистики и хранения.
        const hasForPay = f.forPayKnown === true;
        const forPay = hasForPay ? Number(f.forPayTotal) : (revenue - commission - acquiring);

        const unitCost = Number(p.costPriceRub) || 0;
        const returnedCogs = ret * unitCost;
        const cogsWithReturnWriteoff = qty * unitCost;
        // Основная прибыль не списывает себестоимость возвращённой единицы
        // (товар вернулся на склад); рядом отдаём справочный вариант со списанием.
        const cogs = (qty - ret) * unitCost;
        const packaging = qty * (Number(p.packagingRub) || 0);
        const ad = revenue * (Number(p.adPct) || 0) / 100 + qty * (Number(p.adRub) || 0);
        const other = revenue * (Number(p.otherPct) || 0) / 100 + qty * (Number(p.otherRub) || 0);
        const tax = revenue * (Number(p.taxRatePct) || 0) / 100;
        // после «к перечислению» отдельно снимаем логистику, хранение, приёмку и штрафы
        const wbAfterLogistics = forPay - logistics - storage - acceptance - penalties;
        const profit = wbAfterLogistics - cogs - packaging - ad - other - tax;
        const profitWithReturnCogs = wbAfterLogistics - cogsWithReturnWriteoff - packaging - ad - other - tax;

        if (!(Number(p.costPriceRub) > 0)) missingCost.push({ nmID: item.nmID, vendorCode: item.vendorCode || '', title: item.title || '' });

        T.salesQty += qty; T.returnsQty += ret;
        T.revenue += revenue; T.commission += commission; T.logistics += logistics;
        T.storage += storage; T.acceptance += acceptance; T.acquiring += acquiring;
        T.penalties += penalties; T.forPay += forPay; T.wbAfterLogistics += wbAfterLogistics;
        T.cogs += cogs; T.returnedCogs += returnedCogs; T.cogsWithReturnWriteoff += cogsWithReturnWriteoff; T.packaging += packaging; T.ad += ad; T.other += other; T.tax += tax; T.profit += profit; T.profitWithReturnCogs += profitWithReturnCogs;
        if (hasForPay) T.forPayFromWb++;

        const cat = item.categoryName || 'Без категории';
        const c = byCat[cat] || (byCat[cat] = { category: cat, salesQty: 0, revenue: 0, commission: 0, logistics: 0, forPay: 0, wbAfterLogistics: 0, cogs: 0, returnedCogs: 0, cogsWithReturnWriteoff: 0, ad: 0, other: 0, tax: 0, profit: 0, profitWithReturnCogs: 0, items: 0 });
        c.salesQty += qty; c.revenue += revenue; c.commission += commission; c.logistics += logistics;
        c.forPay += forPay; c.wbAfterLogistics += wbAfterLogistics;
        c.cogs += cogs; c.returnedCogs += returnedCogs; c.cogsWithReturnWriteoff += cogsWithReturnWriteoff; c.ad += ad; c.other += other; c.tax += tax; c.profit += profit; c.profitWithReturnCogs += profitWithReturnCogs; c.items++;

        items.push({
          nmID: item.nmID, vendorCode: item.vendorCode || '', title: item.title || '', category: cat,
          salesQty: qty, returnsQty: ret, returnSharePct: Number(f.returnSharePct) || 0,
          revenue: r2(revenue), commission: r2(commission), logistics: r2(logistics),
          storage: r2(storage), acquiring: r2(acquiring), forPay: r2(forPay),
          wbAfterLogistics: r2(wbAfterLogistics),
          cogs: r2(cogs), returnedCogs: r2(returnedCogs), cogsWithReturnWriteoff: r2(cogsWithReturnWriteoff), packaging: r2(packaging), ad: r2(ad), other: r2(other), tax: r2(tax),
          profit: r2(profit), profitWithReturnCogs: r2(profitWithReturnCogs), marginWithReturnCogsPct: revenue > 0 ? r2(profitWithReturnCogs / revenue * 100) : 0,
          marginPct: revenue > 0 ? r2(profit / revenue * 100) : 0,
          commissionPct: Number(f.commissionPctAvg) || 0,
          logisticsAvg: Number(f.logisticsAvg) || 0,
          hasCost: Number(p.costPriceRub) > 0
        });
      }

      // динамика по дням — из разбивки, сохранённой вместе с отчётом
      for (const row of Object.values(meta.byDay || {})) {
        byDay[row.date] = {
          date: row.date, salesQty: row.salesQty || 0, returnsQty: row.returnsQty || 0,
          revenue: r2(row.revenueTotal), commission: r2(row.commissionTotal),
          logistics: r2(row.logisticsTotal), forPay: r2(row.forPayTotal)
        };
      }

      const days = Object.keys(byDay).sort();
      items.sort((a, b) => b.profit - a.profit);
      const cats = Object.values(byCat).map((c) => Object.assign(c, {
        revenue: r2(c.revenue), commission: r2(c.commission), logistics: r2(c.logistics),
        forPay: r2(c.forPay), wbAfterLogistics: r2(c.wbAfterLogistics),
        cogs: r2(c.cogs), returnedCogs: r2(c.returnedCogs), cogsWithReturnWriteoff: r2(c.cogsWithReturnWriteoff), ad: r2(c.ad), other: r2(c.other), tax: r2(c.tax), profit: r2(c.profit), profitWithReturnCogs: r2(c.profitWithReturnCogs),
        marginPct: c.revenue > 0 ? r2(c.profit / c.revenue * 100) : 0
      })).sort((a, b) => b.profit - a.profit);

      const round = (o) => Object.keys(o).forEach((k) => { if (typeof o[k] === 'number') o[k] = r2(o[k]); });
      round(T);
      T.marginPct = T.revenue > 0 ? r2(T.profit / T.revenue * 100) : 0;
      T.marginWithReturnCogsPct = T.revenue > 0 ? r2(T.profitWithReturnCogs / T.revenue * 100) : 0;
      T.avgProfitPerUnitWithReturnCogs = T.salesQty > 0 ? r2(T.profitWithReturnCogs / T.salesQty) : 0;
      T.commissionPct = T.revenue > 0 ? r2(T.commission / T.revenue * 100) : 0;
      T.logisticsPct = T.revenue > 0 ? r2(T.logistics / T.revenue * 100) : 0;
      T.avgCheck = T.salesQty > 0 ? r2(T.revenue / T.salesQty) : 0;
      T.avgProfitPerUnit = T.salesQty > 0 ? r2(T.profit / T.salesQty) : 0;
      T.returnSharePct = (T.salesQty + T.returnsQty) > 0 ? r2(T.returnsQty / (T.salesQty + T.returnsQty) * 100) : 0;

      return {
        ok: true, demo: isDemo(),
        meta: {
          dateFrom: meta.dateFrom || '', dateTo: meta.dateTo || '', days: meta.days || 0,
          period: meta.period || 'daily', source: meta.source || '', rowsProcessed: meta.rowsProcessed || 0,
          updatedAt: meta.updatedAt || '', items: nmIDs.length,
          // период, который запросил продавец, и чем он закрыт (может отличаться:
          // WB формирует отчёты с задержкой, поэтому берётся последний доступный)
          requestedFrom: o.dateFrom ? iso10(o.dateFrom) : (meta.requestedFrom || ''),
          requestedTo: o.dateTo ? iso10(o.dateTo) : (meta.requestedTo || ''),
          requestedDays: o.days ? Number(o.days) : (meta.requestedDays || meta.days || 0),
          widened: !!meta.widened,
          reportsUsed: meta.reportsUsed || null,
          customPeriod: wantPeriod,
          note: periodNote
        },
        totals: T,
        byCategory: cats,
        byDay: days.map((dt) => byDay[dt]),
        items,
        top: items.slice(0, 20),
        bottom: items.slice(-20).reverse(),
        missingCost: missingCost.slice(0, 50),
        missingCostCount: missingCost.length,
        taxMode: EC.taxModeLabel ? EC.taxModeLabel(s.taxMode) : s.taxMode
      };
    },

    'facts:reports': async (opts) => {
      const s = getSettings();
      const days = Number((opts && opts.days) || s.factWindowDays || 7);
      const dateTo = new Date().toISOString().slice(0, 10);
      const dateFrom = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      if (isDemo()) return getDemo().getSalesReportsList({ dateFrom, dateTo, period: s.factCostsPeriod || 'daily' });
      return getClient().getSalesReportsList({ dateFrom, dateTo, period: s.factCostsPeriod || 'daily' });
    }
  };

  // ───────────────────────── Репрайсер ─────────────────────────

  /** Какие разделы WB покрыты заданными ключами (для подсказок в интерфейсе). */
  function coverageOf() {
    const secrets = store.loadSecrets();
    const hasAny = Object.keys(secrets).some((k) => secrets[k] && secrets[k] !== DEMO_KEY);
    const universal = !!(secrets.single || secrets.universal || secrets.all);
    if (isDemo() && !hasAny) {
      return { demo: true, prices: true, calendar: true, statistics: true, content: true, finance: true, advert: true, universal: false };
    }
    try {
      const c = getClient().keyCoverage();
      c.demo = isDemo();
      c.universal = universal || !!c.universal;
      return c;
    } catch (e) {
      return { demo: isDemo(), universal, error: e.message };
    }
  }

  /** Какая категория ключа WB нужна разделу — показываем в отчёте об обновлении. */
  const SECTION_HINTS = {
    goods: 'нужна категория «Цены и скидки» (кабинет WB → Настройки → Доступ к API)',
    promos: 'нужна категория «Цены и скидки» — календарь акций',
    stats: 'нужна категория «Статистика»',
    cards: 'нужна категория «Контент» — карточки и размеры',
    facts: 'нужна категория «Финансы» — отчёты о реализации',
    stocks: 'нужна категория «Аналитика» — остатки на складах WB (запасной путь — «Маркетплейс»)'
  };
  function sectionHint(name, e) {
    if (e && e.hint) return e.hint;
    const cat = SECTION_HINTS[name];
    if (!cat) return '';
    // если в тексте ошибки уже названа нужная категория — не дублируем
    if (/категор|«Финансы»|«Статистика»|«Контент»|«Цены и скидки»/i.test(String((e && e.message) || ''))) return '';
    if (e && (e.status === 401 || e.status === 403)) {
      return 'Нет доступа к разделу: ' + cat + '. Проверьте, что токен скопирован целиком и не отозван.';
    }
    return 'Для этого раздела ' + cat + '.';
  }

  /**
   * Статистика продаж + честно собранные ошибки.
   *
   * getSalesAggregated() не бросает исключение (продажи и заказы грузятся независимо),
   * поэтому ошибки возвращаем отдельным списком — иначе ключ без категории «Статистика»
   * выглядел бы как успешная загрузка нуля товаров.
   *
   * ВАЖНО про лимит WB: категория «Статистика» — 1 запрос в минуту. Продажи и заказы
   * это ДВА запроса, то есть две минуты. Поэтому:
   *  - в «Обновить данные из WB» грузим только продажи (withOrders=false), а заказы
   *    догружаются в фоне отдельным вызовом loadOrdersIntoStats();
   *  - opts.patient=true (фоновая догрузка) — разрешено ждать минуту вместо ошибки;
   *  - при ошибке уже загруженная статистика НЕ стирается (раньше cache.stats
   *    перезаписывался пустым массивом, и товары теряли продажи до удачной загрузки).
   *
   * @param {number} days
   * @param {boolean} force
   * @param {{patient?:boolean, withOrders?:boolean, maxPages?:number}} opts
   */
  async function loadStats(days, force, opts) {
    const o = opts || {};
    const d = Number(days) || 30;
    const s = getSettings();
    if (isDemo()) {
      return { rows: await getDemo().getSalesAggregated(), errors: [], demo: true, withOrders: true, meta: { days: d, demo: true } };
    }
    if (!force && cache.stats && Date.now() - cache.statsAt < CACHE_TTL_MS) {
      return { rows: cache.stats, errors: cache.statsErrors || [], demo: false, fromCache: true, meta: cache.statsMeta || null };
    }
    const errors = [];
    const withOrders = o.withOrders === undefined ? !!o.patient : !!o.withOrders;
    let meta = { salesPages: 0, ordersPages: 0, truncated: false };
    const from = StatMath.dayKey(Date.now() - d * StatMath.DAY) + 'T00:00:00', context = catalogContext();
    const rows = await getClient().getSalesAggregated(from, {
      withOrders,
      maxPages: Number(o.maxPages || s.statsMaxPages || 3),
      maxWaitMs: o.patient ? 200000 : undefined,
      windowFrom: from.slice(0, 10),
      onRows: (detail) => { assertCatalogContext(context); captureStats(detail); },
      onMeta: (m) => { meta = m || meta; },
      onError: (e, source) => errors.push({
        source,
        message: (e && e.message) || String(e),
        code: (e && e.code) || '',
        status: (e && e.status) || 0,
        hint: (e && e.hint) || '',
        retryAt: Number(e && e.retryAt) || null
      })
    });

    assertCatalogContext(context);
    const ordersFailed = errors.some((x) => x.source === 'orders');
    if (!rows.length && errors.length) {
      const prev = cache.stats || [];
      // Статистику НЕ стираем: 429 — это «WB просит подождать», а не «данных нет».
      // Признак устаревания кладём в meta, чтобы разделы подписали цифры честно.
      const staleAt = cache.statsAt ? new Date(cache.statsAt).toISOString() : null;
      cache.statsMeta = Object.assign({}, cache.statsMeta || {}, {
        stale: prev.length > 0,
        staleAt,
        lastError: errors[0] ? errors[0].message : '',
        retryAt: (errors.map((x) => x.retryAt).filter(Boolean).sort((a, b) => a - b)[0]) || null
      });
      cache.statsErrors = errors;
      return {
        rows: prev,
        errors,
        demo: false,
        stale: prev.length > 0,
        staleAt,
        retryAt: cache.statsMeta.retryAt,
        meta: cache.statsMeta
      };
    }
    cache.stats = rows;
    cache.statsAt = Date.now();
    cache.statsErrors = errors;
    cache.statsMeta = {
      days: d,
      withOrders: withOrders && !ordersFailed,
      ordersPending: withOrders === false || ordersFailed,
      salesPages: meta.salesPages || 0,
      ordersPages: meta.ordersPages || 0,
      truncated: !!meta.truncated,
      stale: false,
      staleAt: null,
      lastError: errors.length ? errors.map((x) => x.message).join('; ') : '',
      loadedAt: new Date().toISOString()
    };
    return { rows, errors, demo: false, meta: cache.statsMeta, retryAt: null };
  }

  /**
   * Догрузить ЗАКАЗЫ к уже загруженной статистике продаж отдельным запросом.
   * Так мы не тратим вторую минуту лимита «Статистика» внутри «Обновить данные из WB»,
   * но поле «Заказы, шт» в карточке товара всё равно заполняется.
   */
  async function loadOrdersIntoStats(days, force) {
    if (isDemo()) return { ok: true, demo: true, added: 0, orders: 0, pages: 0 };
    if (!force && cache.statsMeta && cache.statsMeta.withOrders) {
      return { ok: true, skipped: true, added: 0, orders: 0, pages: 0, reason: 'заказы уже загружены' };
    }
    const d = Number(days) || (cache.statsMeta && cache.statsMeta.days) || 30;
    const s = getSettings();
    const from = StatMath.dayKey(Date.now() - d * StatMath.DAY) + 'T00:00:00', context = catalogContext();
    const winFrom = from.slice(0, 10);
    const res = await getClient().getStatRows('/api/v1/supplier/orders', from, {
      flag: 0,
      maxPages: Number(s.statsMaxPages || 3),
      maxWaitMs: 200000
    });
    assertCatalogContext(context);
    captureStats({ orders: res.rows || [], ordersComplete: !res.truncated && !res.error });
    if (res.truncated || res.error) throw new WBError('Заказы получены не полностью. Предыдущие итоги сохранены; повторите загрузку позже.', { code: 'ORDERS_INCOMPLETE' });
    const rows = StatMath.dedupe(res.rows || [], 'orders').filter((r) => {
      const dt = String(r.date || '').slice(0, 10);
      return !dt || dt >= winFrom;
    });
    const base = (cache.stats || []).map((r) => ({ ...r }));
    const byNm = new Map(base.map((x) => [String(x.nmID), x]));
    // Повторная загрузка заменяет окно заказов, а не складывает его второй раз.
    base.forEach((row) => { row.ordersQty = 0; row.ordersSum = 0; });
    let added = 0;
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    for (const r of rows) {
      if (StatMath.canceled(r)) continue;
      const nm = Number(r.nmId || r.nmID || 0);
      if (!nm) continue;
      let a = byNm.get(String(nm));
      if (!a) {
        a = {
          nmID: nm, salesQty: 0, salesSum: 0, salesForPay: 0, avgPrice: 0, avgForPay: 0,
          avgSppPct: 0, ordersQty: 0, ordersSum: 0, returnsQty: 0, days: {}, warehouses: {}
        };
        byNm.set(String(nm), a);
        base.push(a);
        added++;
      }
      a.ordersQty = Number(a.ordersQty || 0) + 1;
      a.ordersSum = r2(Number(a.ordersSum || 0) + (StatMath.sellerPrice(r) || 0));
    }
    cache.stats = base;
    cache.statsAt = Date.now();
    cache.statsMeta = Object.assign({}, cache.statsMeta, {
      withOrders: !res.truncated && !res.error,
      ordersPending: !!res.truncated || !!res.error,
      ordersPages: res.pages || 0,
      ordersAt: new Date().toISOString()
    });
    return { ok: true, added, orders: rows.length, pages: res.pages || 0, total: base.length };
  }

  // ───────────────────────── Отложенная догрузка разделов ─────────────────────────

  /**
   * WB отдаёт «Статистику» и «Финансы» не чаще раза в минуту. Ждать минуту внутри
   * «Обновить данные из WB» — значит заблокировать интерфейс, а показать ошибку
   * «HTTP 429» и ничего не сделать — значит оставить пользователя без данных
   * (именно так и было: сообщение обещало автоматический повтор, которого не существовало).
   *
   * Поэтому раздел, упёршийся в лимит, помечается как отложенный и догружается в фоне:
   * задача стартует в момент, когда лимит WB сбросится, а интерфейс получает событие
   * `deferred` (scheduled → running → done/failed) и обновляет панель и данные.
   */
  const DEFERRED_TITLES = {
    goods: 'Товары и цены',
    promos: 'Календарь акций',
    cards: 'Карточки и габариты',
    stats: 'Статистика продаж',
    'stats-orders': 'Заказы (статистика)',
    facts: 'Фактические расходы (отчёт о реализации)',
    stocks: 'Остатки по складам WB'
  };
  const deferred = {};

  const DEFERRED_TASKS = {
    goods: async () => {
      const g = await handlers['wb:goods']({ force: true });
      return (g.items || []).length + ' товаров';
    },
    promos: async () => {
      promoCache.index = null; promoCache.at = 0;
      const pr = await handlers['wb:promos']({ force: true });
      const list = Array.isArray(pr) ? pr : ((pr && pr.promotions) || []);
      return list.length + ' акций';
    },
    cards: async () => {
      const c = await handlers['wb:cards']({ force: true });
      const rows = Array.isArray(c) ? c : ((c && c.cards) || []);
      return rows.length + ' карточек';
    },
    stats: async (rec) => {
      const st = await loadStats(rec.days || 30, true, { patient: true, withOrders: true });
      const errs = st.errors || [];
      if (errs.length && !(st.rows || []).length) {
        const err = new Error(errs[0].message || 'Статистика продаж не загрузилась');
        err.code = errs[0].code; err.status = errs[0].status; err.retryAt = errs[0].retryAt;
        throw err;
      }
      let detail = (st.rows || []).length + ' товаров с продажами';
      if (errs.length) detail += ' (заказы не загрузились: ' + errs[0].message + ')';
      return detail;
    },
    'stats-orders': async (rec) => {
      const r = await loadOrdersIntoStats(rec.days || 30, false);
      if (r && r.skipped) return r.reason;
      return 'заказы дозагружены: ' + (r.orders || 0) + ' строк, товаров с заказами +' + (r.added || 0);
    },
    facts: async (rec) => {
      const f = await loadFactCosts({ days: rec.days, patient: true });
      if (!f || !f.ok) {
        const err = new Error((f && f.message) || 'отчёт о реализации не загружен');
        err.code = (f && f.code) || 'FACTS';
        throw err;
      }
      return f.items + ' товаров, ' + f.rowsProcessed + ' строк за ' + f.dateFrom + ' → ' + f.dateTo +
        (f.widened ? ' (взят последний доступный отчёт WB)' : '');
    },
    stocks: async () => {
      const r = await loadStocksIntoCache({ patient: true });
      let detail = r.items + ' товаров с остатками';
      if (r.meta && r.meta.fallback) detail += ' (использован запасной путь: отчёт заданием)';
      if (r.meta && r.meta.empty) detail += ' (WB вернул пусто — сохранены прежние остатки)';
      return detail;
    }
  };

  function armDeferred(name) {
    const rec = deferred[name];
    if (disposed || !rec || rec.state !== 'scheduled') return;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    const delay = Math.max(300, rec.retryAt - Date.now());
    rec.timer = setTimeout(() => { rec.timer = null; runDeferred(name); }, delay);
    // таймер не должен удерживать процесс: догрузка нужна только живому приложению
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  }

  function scheduleDeferred(name, retryAt, opts) {
    const o = opts || {};
    const existing = deferred[name];
    if (existing && (existing.state === 'scheduled' || existing.state === 'running')) return existing;
    const rec = {
      name,
      title: o.title || DEFERRED_TITLES[name] || name,
      state: 'scheduled',
      scheduledAt: Date.now(),
      retryAt: Math.max(Date.now() + 500, Number(retryAt) || (Date.now() + RATE_FALLBACK_MS)),
      days: o.days,
      reason: o.reason || '',
      runs: 0,
      detail: '',
      error: '',
      at: null,
      timer: null
    };
    deferred[name] = rec;
    armDeferred(name);
    notify('deferred', {
      type: 'scheduled', name: rec.name, title: rec.title,
      retryAt: new Date(rec.retryAt).toISOString(), reason: rec.reason
    });
    return rec;
  }

  async function runDeferred(name) {
    const rec = deferred[name];
    if (disposed || !rec || rec.state === 'running') return rec;
    const task = DEFERRED_TASKS[name];
    if (!task) return rec;
    rec.state = 'running';
    rec.runs++;
    notify('deferred', { type: 'running', name, title: rec.title });
    try {
      const detail = await task(rec);
      rec.state = 'done';
      rec.detail = detail || '';
      rec.error = '';
      rec.at = Date.now();
      notify('deferred', { type: 'done', name, title: rec.title, detail: rec.detail, at: new Date(rec.at).toISOString() });
    } catch (e) {
      const code = (e && e.code) || '';
      const retryAt = Number(e && e.retryAt) || 0;
      const limited = code === 'RATE_LIMIT' || code === 'RATE_WAIT';
      if (!disposed && limited && retryAt && rec.runs < 4) {
        rec.state = 'scheduled';
        rec.retryAt = retryAt;
        rec.error = (e && e.message) || '';
        armDeferred(name);
        notify('deferred', {
          type: 'rescheduled', name, title: rec.title,
          retryAt: new Date(retryAt).toISOString(), message: rec.error
        });
      } else {
        rec.state = 'failed';
        rec.error = (e && e.message) || String(e);
        rec.at = Date.now();
        notify('deferred', { type: 'failed', name, title: rec.title, error: rec.error });
      }
    }
    return rec;
  }

  /** Состояние лимитов WB без падения, если клиент ещё не создан. */
  function safeRateState() {
    try { return getClient().rateState(); } catch (e) { return null; }
  }

  function deferredList() {
    return Object.keys(deferred).map((k) => {
      const r = deferred[k];
      return {
        name: r.name, title: r.title, state: r.state, runs: r.runs,
        retryAt: r.retryAt ? new Date(r.retryAt).toISOString() : null,
        scheduledAt: r.scheduledAt ? new Date(r.scheduledAt).toISOString() : null,
        at: r.at ? new Date(r.at).toISOString() : null,
        detail: r.detail, error: r.error, reason: r.reason
      };
    });
  }

  /**
   * Сбросить кэши загруженных данных.
   *
   * keepExpensive=true оставляет статистику продаж: у WB лимит 1 запрос в минуту на
   * категорию «Статистика», и полный сброс приводил к тому, что после HTTP 429 уже
   * загруженные продажи исчезали, а экономика теряла оборачиваемость.
   * Полный сброс нужен только при смене ключей/кабинета.
   */
  function invalidateAllCaches(opts) {
    const keep = !!(opts && opts.keepExpensive);
    if (!keep) { officialSpp = {}; officialSppContext = ''; boostOrders = null; boostOrdersPending = null; sched.lastRun = null; catalogEpoch++; promoLifecycleReady = false; promoLifecycle = new Map(); promoCache.noApi = {}; }
    promoRevision++;
    invalidateGoodsCache();
    if (!keep) {
      cache.stats = null; cache.statsAt = 0; cache.statsErrors = []; cache.statsMeta = null;
      // Остатки — «сохранённые» данные, как статистика: при обновлении данных
      // (keepExpensive) их не сбрасываем, чтобы 429/ошибка не стирала загруженные
      // остатки. Полный сброс нужен только при смене ключей/кабинета.
      cache.stocks = null; cache.stocksAt = 0; cache.stocksMeta = null;
    }
    cache.cards = null; cache.cardsAt = 0;
    cache.promos = null; cache.promosAt = 0;
    cache.tasks = null; cache.tasksAt = 0;
    promoCache.index = null; promoCache.at = 0;
  }

  function repricerCfg() {
    const { analyticsArchive, officialSpp: spp, ...config } = store.loadRepricer();
    return RP.mergeConfig(config);
  }

  /** Конкуренты: пользовательские данные приоритетнее, в демо недостающее дополняется демо-набором. */
  async function competitorsMap() {
    const user = store.loadCompetitors();
    if (!isDemo()) return user;
    const demo = await getDemo().getCompetitors();
    const out = Object.assign({}, demo);
    for (const [k, v] of Object.entries(user)) out[k] = v;
    return out;
  }

  /**
   * Загрузка остатков по складам WB в кэш приложения и в файл .data/stocks.json.
   *
   * Основной метод — POST /api/analytics/v1/stocks-report/wb-warehouses (категория
   * «Аналитика», 1 запрос в 20 с). Если ключа без категории «Аналитика» —
   * запасной путь: отчёт заданием warehouse_remains (категория «Маркетплейс»).
   *
   * ВАЖНО: пустой ответ НЕ затирает прежние остатки. Если WB вернул 0 строк
   * (или ошибку) — оставляем уже загруженный кэш, а в мета записываем, что
   * последний запрос вернул пусто, и время этой попытки.
   *
   * @param {{force?:boolean, patient?:boolean, maxPages?:number, maxWaitMs?:number}} opts
   */
  async function loadStocksIntoCache(opts) {
    const o = opts || {};
    if (isDemo()) {
      const res = await getDemo().getStocksReport();
      applyStocksResult(res, { source: 'demo', meta: { demo: true } });
      return { ok: true, demo: true, items: Object.keys(cache.stocks || {}).length, meta: cache.stocksMeta };
    }
    const c = getClient();
    const pageOpts = {
      maxPages: Number(o.maxPages) || 250,
      maxWaitMs: o.maxWaitMs,
      pageWaitMs: o.pageWaitMs
    };
    let res;
    let usedFallback = false;
    try {
      res = await c.getStocksReport(Object.assign({}, pageOpts, {
        maxWaitMs: o.patient ? undefined : pageOpts.maxWaitMs
      }));
    } catch (e) {
      // Основной метод недоступен для ключа (403/404/405/422) — пробуем отчёт заданием.
      // Лимит (429) и сетевые ошибки НЕ заменяются запасным путём: это временное
      // состояние, и ломать его «в лоб» только продлит блокировку — пусть раздел
      // уйдёт в фоновую догрузку, как и статистика.
      const status = Number(e && e.status) || 0;
      const code = (e && e.code) || '';
      const fallbackable = status === 403 || status === 404 || status === 405 || status === 422 || code === '403' || code === '404' || code === '405' || code === '422' || code === 'API_ERROR';
      if (!fallbackable) throw e;
      usedFallback = true;
      notify('info', { where: 'stocks', message: 'Основной метод остатков недоступен для ключа — пробуем отчёт заданием: ' + e.message });
      res = await c.getStocksByTask({ maxAttempts: 20, pollMs: 3000 });
    }
    applyStocksResult(res, { source: res.source, meta: { fallback: usedFallback } });
    return {
      ok: true,
      demo: false,
      items: Object.keys(cache.stocks || {}).length,
      meta: cache.stocksMeta
    };
  }

  /**
   * Сохранение результата загрузки остатков: в кэш памяти и в файл.
   * Пустой ответ (0 строк) не перезаписывает уже загруженные остатки.
   */
  function notifyLowStock(aggregated) {
    if (isDemo()) { lowStockNotified = new Set(); return; }
    const thresholdDays = Math.max(1, Number(getSettings().stocksLowDays) || 14);
    const sales = new Map((Array.isArray(cache.stats) ? cache.stats : []).map((row) => [String(row.nmID), Number(row.salesQty) || 0]));
    const current = new Set();
    for (const [nmID, row] of Object.entries(aggregated || {})) {
      const salesPerDay = (sales.get(String(nmID)) || 0) / 30;
      if (!(salesPerDay > 0)) continue;
      const stock = Math.max(0, Number(row && row.total) || 0);
      const daysLeft = stock / salesPerDay;
      if (daysLeft >= thresholdDays) continue;
      current.add(String(nmID));
      if (!isDemo() && !lowStockNotified.has(String(nmID))) {
        notify('app-event', { type: 'lowStock', nmID, stock, daysLeft: Math.round(daysLeft * 10) / 10, thresholdDays });
      }
    }
    lowStockNotified = current;
  }

  function applyStocksResult(res, extra) {
    const aggregated = (res && res.aggregated) || {};
    const rows = (res && res.rows) || [];
    const at = new Date().toISOString();
    if (!rows.length && cache.stocks) {
      // Пустой отчёт — оставляем прежние остатки и честно помечаем, что WB вернул пусто.
      cache.stocksMeta = Object.assign({}, cache.stocksMeta || {}, {
        source: (extra && extra.source) || (cache.stocksMeta && cache.stocksMeta.source) || '',
        empty: true,
        emptyAt: at,
        rows: 0,
        items: Object.keys(cache.stocks).length,
        at,
        updatedAt: at
      });
      return;
    }
    cache.stocks = aggregated;
    cache.stocksAt = Date.now();
    const meta = {
      source: (extra && extra.source) || (res && res.source) || '',
      fallback: !!(extra && extra.meta && extra.meta.fallback),
      demo: !!(extra && extra.meta && extra.meta.demo),
      empty: false,
      rows: rows.length,
      pages: Number(res && res.pages) || 1,
      items: Object.keys(aggregated).length,
      complete: res && res.complete !== undefined ? !!res.complete
        : (Number(res && res.total) > 0 ? rows.length >= Number(res.total) : false),
      at,
      updatedAt: at
    };
    cache.stocksMeta = meta;
    store.saveStocks(aggregated, meta);
    if (rows.length && meta.complete) {
      // Отсутствие строки склада не доказывает stockout товара (например, FBS).
      // Для аналитики берём только явно присутствующие в полном снимке товары.
      const observedNms = Object.keys(aggregated);
      const zeroNms = observedNms.filter((nm) => Number(aggregated[nm] && aggregated[nm].total) === 0);
      store.appendStockSnapshot({ at, source: meta.source, complete: true, zeroNms, observedNms });
    }
    notifyLowStock(aggregated);
  }

  /** Остатки по складам WB: кэш из памяти (он же — файл stocks.json). */
  function stocksMap() {
    return cache.stocks || (store.loadStocks() || {}).items || {};
  }

  /** Собирает контекст товара для движка репрайсера. */
  async function buildContexts(opts) {
    const context = catalogContext();
    const g = await handlers['wb:goods']({});
    const cfg = repricerCfg();
    const comps = await competitorsMap();
    const itemConfigs = store.loadItemConfigs();
    const dayStart = store.dayStartPrices();
    const facts = factsMap();
    // товары, выведенные из акции: цену держим повышенной, пока автоакция не закончится
    const exitsPend = store.loadPromoExits();
    const statsRows = (g.stats && g.stats.length ? g.stats : cache.stats) || [];
    const statsByNm = {};
    statsRows.forEach((s) => { statsByNm[String(s.nmID)] = s; });
    // индекс акций нужен не всегда (это несколько запросов к WB) — грузим по запросу
    const pi = (opts && opts.promos === false) ? null : await promoIndex(!!(opts && opts.promosForce)).catch(() => null);
    const promoIndexNow = pi;
    if (!(opts && opts.noBoostOrders) && (cfg.defaults.strategy === 'boost' || Object.values(itemConfigs).some((ic) => ic.strategy === 'boost'))) await ensureBoostOrders();
    assertCatalogContext(context);
    const now = Date.now();
    const d = new Date(now);
    const monthDays = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const dayOfMonth = Math.min(d.getDate(), monthDays);
    const settings = getSettings();
    // баркоды — из кэша карточек (контент-API), если он уже загружен
    const barcodeByNm = {};
    (Array.isArray(cache.cards) ? cache.cards : []).forEach((c) => {
      if (c && c.nmID) barcodeByNm[String(c.nmID)] = String(c.barcode || '');
    });

    return (g.items || []).map((item) => {
      const key = String(item.nmID);
      const rawOv = g.overrides[key] || {};
      const fact = facts[key];
      // факт из отчёта WB перекрывает демо-значения, но не ручные настройки пользователя
      const ov = EC.preferFacts(rawOv, fact, settings);
      const stats = statsByNm[key] || {};
      const ic = itemConfigs[key] || {};
      const merged = RP.itemConfig(cfg.defaults, ic, cfg.strategyTemplates);
      /**
       * Первый расчёт товара с заданными порогами: пока продавец не задал
       * минимальный порог (ценой, маржой % или маржой ₽ в настройках товара),
       * сажать цену не на что. Как только порог задан и товара ещё ни разу
       * не считали, движок поставит цену на этот порог; отметку о выполненной
       * посадке (floorSeededAt в настройках товара) ставит calcRepricer.
       */
      const userFloorSet = Number(ic.minPrice) > 0 || Number(ic.minMarginRub) > 0 ||
        (ic.minMarginPct !== undefined && ic.minMarginPct !== null && ic.minMarginPct !== '' && Number(ic.minMarginPct) > 0);
      const firstCalcSeed = userFloorSet && !ic.floorSeededAt;

      const seller = Number(item.price) * (1 - Number(item.discount) / 100);
      const statsKnown = Object.prototype.hasOwnProperty.call(statsByNm, key);
      const perDay = stats.salesQty ? stats.salesQty / 30 : Number(ov.salesPerDay || 0);
      // Остаток: из загруженных остатков WB (по складам) — приоритетнее ручного
      // ввода; если остатки не загружены — ручной ввод/демо, с пометкой источника.
      const wbStock = stocksMap()[key];
      const manualStock = (() => { const c = (costsMap()[key] || {}); return c.stock !== undefined && c.stock !== null && c.stock !== ''; })();
      const stock = wbStock ? Number(wbStock.total || 0) : Number(ov.stock || 0);
      const stockSource = wbStock ? 'wb' : (manualStock ? 'manual' : (isDemo() ? 'demo' : 'unknown'));
      const promosForCtx = pi ? promosForItem(item, pi) : [];
      const activePromo = promosForCtx.find((x) => x.inAction && Number(x.planPrice) > 0) || promosForCtx.find((x) => x.inAction);
      const statsMissing = !statsKnown && !(Number(ov.salesPerDay) > 0);
      const salesMonthQty = perDay > 0 ? perDay * dayOfMonth : 0;

      const p = EC.resolveParams(settings, item, ov, fact);

      return {
        ctx: {
          nmID: item.nmID,
          vendorCode: item.vendorCode,
          title: item.title,
          basePrice: Number(item.price),
          // цена подставлена из sizes[] (товар с поразмерными ценами) — интерфейс это покажет
          priceFromSizes: !!item.priceFromSizes,
          sizePriceMin: Number(item.sizePriceMin) || 0,
          sizePriceMax: Number(item.sizePriceMax) || 0,
          // режим цен по размерам (none/sync/manual) — из настроек товара/общих
          sizePriceMode: normalizeSizePriceMode(merged.sizePriceMode, cfg.sizePriceMode),
          discount: Number(item.discount),
          sellerPrice: seller,
          buyerPrice: seller * (1 - Number(p.sppPct || 0) / 100),
          sppPct: Number(p.sppPct || 0),
          forPayAvg: Number(stats.avgForPay || 0),
          stock,
          stockSource,
          salesPerDay: perDay,
          salesMonthQty,
          sales30: Number(stats.salesQty || 0),
          orders30: Number(stats.ordersQty || 0),
          returns30: Number(stats.returnsQty || 0),
          turnoverDays: perDay > 0 ? stock / perDay : (stock > 0 ? 999 : 0),
          statsKnown,
          statsMissing,
          inPromo: !!activePromo,
          promoPrice: activePromo && Number(activePromo.planPrice) > 0 ? Number(activePromo.planPrice) : undefined,
          promoDiscountPct: Number(item.plannedDiscount || 0),
          competitors: comps[key] || [],
          promos: promosForCtx,
          promoHold: promoHoldFor(key, exitsPend, promoIndexNow),
          rrp: merged.rrp,
          // ── данные для блоков таблицы репрайсера (задание D) ──
          // баркод берём только из уже загруженных карточек: отдельный запрос к WB
          // ради одной колонки ломал бы лимиты контент-API
          barcode: barcodeByNm[key] || '',
          categoryName: item.categoryName || '',
          volumeLiters: item.volumeLiters,
          sizesCount: item.sizesCount || 0,
          brand: item.brand || '',
          plannedPrice: Number(item.plannedPrice) > 0 ? Number(item.plannedPrice) : undefined,
          costCurrency: ov.costCurrency || String(ov.currency || item.currency || 'RUB'),
          costRate: Number(ov.costRate || 1),
          costEntered: ov.costEntered !== undefined ? ov.costEntered : p.costPriceRub,
          costError: ov.costError || null,
          // «Отправка в WB» и метка товара — из настроек товара (колонки таблицы)
          allowSend: merged.allowSend !== false,
          tag: merged.tag ? String(merged.tag) : '',
          // первый расчёт с заданными порогами — движок поставит цену на минимальный порог
          firstCalcSeed,
          floorSeededAt: ic.floorSeededAt || null,
          // фактическая средняя СПП по продажам — это и есть «прогнозная СПП» для акций
          sppFactAvg: Number(stats.avgSppPct || 0),
          factCosts: fact || null,
          priceDayStart: dayStart[key] || seller,
          econAt: (price) => EC.calcUnit(price, p),
          params: p,
          factCosts: fact || null,
          factWindowDays: Number((fact && fact.windowDays) || 0),
          priceObservedAt: g.catalogAt || (g.cachedAt || new Date(cache.goodsAt).toISOString()),
          now,
          monthDays
        },
        cfg,
        itemCfg: merged
      };
    });
  }

  function restoreOfficialSpp() {
    const context = businessContext();
    if (officialSppContext === context) return;
    const saved = store.loadRepricer().officialSpp;
    officialSpp = saved && saved.context === context ? { ...saved.items } : {};
    officialSppContext = context;
  }

  function captureStats(detail) {
    restoreOfficialSpp();
    const context = businessContext();
    if (detail.sales) {
      officialSpp = StatMath.latestSpp(detail.sales, 'sales', officialSpp);
      const old = store.loadRepricer().analyticsArchive;
      const next = StatMath.archiveSales(old && old.context === context ? old : null, detail.sales, detail.from, Date.now(), detail.salesComplete);
      store.saveRepricer({ analyticsArchive: { ...next, context } }, { replaceKeys: ['analyticsArchive'] });
    }
    if (detail.orders) officialSpp = StatMath.latestSpp(detail.orders, 'orders', officialSpp);
    store.saveRepricer({ officialSpp: { context, items: officialSpp } }, { replaceKeys: ['officialSpp'] });
  }

  async function ensureDemoAnalytics() {
    const context = businessContext(), old = store.loadRepricer().analyticsArchive;
    if (old && old.context === context && old.demo && old.through === StatMath.dayKey(Date.now() - StatMath.DAY)) return;
    const goods = await getDemo().getGoods({ maxItems: 100000 });
    const days = {};
    for (let i = 180; i >= 1; i--) {
      const date = StatMath.dayKey(Date.now() - i * StatMath.DAY), products = {};
      for (const [j, good] of (goods.items || []).entries()) {
        const qty = Math.max(0, (j * 17 + i * 7) % 23 - 5);
        if (qty) products[good.nmID] = { qty, revenue: U2(qty * Number(good.price) * (1 - Number(good.discount) / 100)) };
      }
      days[date] = { covered: true, products, updatedAt: new Date().toISOString() };
    }
    store.saveRepricer({ analyticsArchive: { version: 1, context, demo: true, through: StatMath.dayKey(Date.now() - StatMath.DAY), days } }, { replaceKeys: ['analyticsArchive'] });
  }

  async function ensureBoostOrders(force) {
    const context = catalogContext(), business = businessContext(), day = StatMath.dayKey();
    if (boostOrders && boostOrders.context === business && boostOrders.day === day && Date.now() - boostOrders.at < 60000) return boostOrders;
    if (boostOrdersPending && boostOrdersPending.context === business && boostOrdersPending.day === day) return boostOrdersPending.task;
    const at = Date.now();
    const task = (async () => {
      try {
        const res = isDemo() ? { rows: [], demo: true } : await getClient().getStatRows('/api/v1/supplier/orders', day + 'T00:00:00', { flag: 0, maxPages: Number(getSettings().statsMaxPages || 3), maxWaitMs: 0 });
        assertCatalogContext(context); captureStats({ orders: res.rows || [] });
        boostOrders = { rows: StatMath.dedupe(res.rows || [], 'orders'), context: business, day, at, complete: !res.truncated && !res.error, error: res.error ? res.error.message : '' };
      } catch (e) {
        assertCatalogContext(context);
        boostOrders = { rows: [], context: business, day, at, complete: false, error: 'Заказы WB не обновились: ' + e.message };
      }
      return boostOrders;
    })();
    boostOrdersPending = { context: business, day, task };
    try { return await task; } finally { if (boostOrdersPending && boostOrdersPending.task === task) boostOrdersPending = null; }
  }

  function publicItemConfigs() {
    return Object.fromEntries(Object.entries(store.loadItemConfigs()).map(([nm, value]) => {
      const { boostRuntime, ...config } = value;
      if (boostRuntime) config.boostProgress = { day: boostRuntime.day, counts: boostRuntime.counts, completed: boostRuntime.completed, activeSince: boostRuntime.activeSince };
      return [nm, config];
    }));
  }

  function inputSnapshot() {
    const settings = { ...getSettings() };
    for (const key of ['lastSync', 'lastDataRefreshAt', 'lastDataRefreshOk', 'factsLoadedAt']) delete settings[key];
    return { context: businessContext(), settings, configs: store.loadItemConfigs(), costs: costsMap(), cfg: repricerCfg(), facts: factsMap(), promoRevision };
  }
  function inputFingerprint(nmID, snapshot) {
    const data = snapshot || inputSnapshot(), nm = String(nmID), ic = { ...(data.configs[nm] || {}) };
    for (const key of ['boostRuntime', 'updatedAt', 'allowSend', 'tag', 'safetyLock', 'floorSeededAt']) delete ic[key];
    const cost = { ...(data.costs[nm] || {}) }; delete cost.updatedAt;
    return Boost.signature({ context: data.context, settings: data.settings, ic, costs: cost, cfg: data.cfg, facts: data.facts[nm] || null, promoRevision: data.promoRevision, boostDay: (ic.strategy || data.cfg.defaults.strategy) === 'boost' ? StatMath.dayKey() : undefined });
  }

  async function calcRepricer(opts) {
    if (priceJobRunning && priceJobContext.getStore() !== priceJobRunning) throw new WBError('Выполняется отправка WB. Дождитесь результата перед новым пересчётом.', { code: 'PRICE_BUSY' });
    if (sched.running) throw new WBError('Пересчёт уже выполняется — дождитесь окончания.', { code: 'BUSY' });
    sched.running = true;
    const startedAt = Date.now(), context = catalogContext();
    opts = opts || {};
    try {
      if (isDemo()) await ensureDemoAnalytics();
      const rows = await buildContexts(opts);
      assertCatalogContext(context);
      const goodsByNm = new Map(((cache.goods && cache.goods.items) || []).map((g) => [Number(g.nmID), g]));
      const runtimeUpdates = {}, fingerprints = inputSnapshot();
      const results = rows.map((r) => {
        try {
          let boostPlan;
          if (r.itemCfg.strategy === 'boost') {
            boostPlan = Boost.plan(r.ctx, r.itemCfg.boost, r.itemCfg.boostRuntime, boostOrders, businessContext());
            r.ctx.boostPlan = boostPlan;
          }
          const result = RP.computeItem(r.ctx, r.cfg, r.itemCfg, EC);
          const good = goodsByNm.get(Number(r.ctx.nmID));
          const mode = result.context.sizePriceMode;
          if (boostPlan) {
            result.boost = Boost.checkResult(result, boostPlan, good);
            if (!opts.previewOnly && boostPlan.runtime) runtimeUpdates[String(r.ctx.nmID)] = boostPlan.runtime;
          }
          // Правка только размера тоже является предложением, даже если минимальная
          // цена товара и скидка не изменились. Без этого цены размеров не отправлялись.
          const manual = r.itemCfg.sizePrices || {};
          result.sizeChanges = good && good.editableSizePrice && mode !== 'none'
            ? (good.sizes || []).filter((size) => {
              const price = mode === 'sync' ? result.proposed.basePrice : manual[String(size.sizeID)];
              return Number.isFinite(Number(price)) && Number(price) > 0 &&
                Math.round(Number(price)) !== Math.round(Number(size.price));
            }).length : 0;
          if (result.allowSend !== false && result.sizeChanges > 0) result.needSend = true;
          if (good && good.editableSizePrice && mode === 'sync') result.sizeChanges = (good.sizes || []).filter((size) => Math.round(Number(size.price)) !== Math.round(Number(result.proposed.basePrice))).length;
          if (result.allowSend !== false && result.sizeChanges > 0) result.needSend = true;
          result.inputFingerprint = inputFingerprint(result.nmID, fingerprints);
          result.issues = StatMath.issuesFor(result);
          if (!RP.STRATEGIES.some((s) => s.id === result.strategy) && !(cfg.customStrategies || []).some((s) => s.id === result.strategy)) result.issues.push({ code: 'STRATEGY_INVALID', message: 'Неизвестная стратегия товара', level: 'critical' });
          result.autoBlocked = result.issues.some((i) => i.level === 'critical');
          result.manualAllowSend = result.allowSend;
          if (result.autoBlocked) { result.allowSend = false; result.needSend = false; }
          return result;
        } catch (e) { const out = { nmID: r.ctx.nmID, vendorCode: r.ctx.vendorCode, error: e.message, autoBlocked: true }; out.issues = StatMath.issuesFor(out); return out; }
      });
      assertCatalogContext(context);
      if (!opts.previewOnly) {
        const configs = store.loadItemConfigs(), business = businessContext(); let changed = false;
        for (const result of results) {
          const nm = String(result.nmID), previous = configs[nm] || {}, lock = previous.safetyLock;
          const critical = (result.issues || []).filter((i) => i.level === 'critical');
          let next = previous;
          if (runtimeUpdates[nm]) { next = { ...next, boostRuntime: runtimeUpdates[nm] }; changed = true; }
          // Первый расчёт посадил цену на минимальный порог — запоминаем, чтобы
          // дальше товар вели стратегии внутри коридора, а не посадка на порог.
          // Заблокированная строка посадку не «расходует»: после исправления
          // данных первый полноценный расчёт всё равно начнётся с порога.
          if (result.firstCalcSeeded && !result.autoBlocked && !previous.floorSeededAt) {
            next = { ...next, floorSeededAt: new Date().toISOString() }; changed = true;
          }
          if (critical.length || lock) {
            const state = { active: critical.length > 0, context: business, issues: critical };
            if (!lock || Boost.signature({ active: lock.active, context: lock.context, issues: lock.issues }) !== Boost.signature(state)) { next = { ...next, safetyLock: { ...state, checkedAt: new Date().toISOString() } }; changed = true; }
          }
          if (next !== previous) configs[nm] = next;
        }
        if (changed) store.saveItemConfigs(configs);
      }
      const archive = store.loadRepricer().analyticsArchive;
      const byNm = new Map(rows.map((r) => [String(r.ctx.nmID), r.ctx]));
      const abc = StatMath.abc(archive && archive.context === businessContext() ? archive : null, results.map((r) => String(r.nmID)), (nm, revenue, qty) => {
        const ctx = byNm.get(nm), zero = ctx.econAt(0);
        return ctx.costError || !(ctx.params.costPriceRub > 2) ? null : revenue * (1 - zero.pctCosts / 100) - qty * zero.fixedCosts;
      });
      results.forEach((r) => { r.abc = abc[String(r.nmID)]; });
      const summary = RP.summarize(results);
      if (opts.previewOnly) return { results, summary, demo: isDemo(), at: new Date().toISOString() };
      const run = {
        id: startedAt,
        at: new Date(startedAt).toISOString(),
        mode: (opts && opts.mode) || 'manual',
        autoSend: !!(opts && opts.autoSend),
        demo: isDemo(),
        summary,
        results
      };
      const runs = store.loadRuns();
      runs.unshift({ id: run.id, at: run.at, mode: run.mode, autoSend: run.autoSend, demo: run.demo, summary });
      store.saveRuns(runs);
      sched.lastRun = run;

      /**
       * Двухфазный цикл: пересчёт НИКОГДА не затирает установленные цены.
       *
       * Фаза 1 («расчёт») сохраняет предложение отдельно и показывает его в интерфейсе;
       * фаза 2 («отправка») уходит в WB только по расписанию или по кнопке, и только если
       * цены в кабинете не изменились с момента расчёта. Так пользователь всегда видит,
       * что именно хочет поставить репрайсер, до того как это попадёт на маркетплейс.
       */
      const cfg = repricerCfg();
      const twoPhase = cfg.schedule && cfg.schedule.twoPhase !== false;
      if (twoPhase) {
        saveProposal(results, summary, run.at, cfg);
        notify('repricer', { type: 'proposal', at: run.at, summary, sendAt: proposalSendAt(run.at, cfg) });
        if (run.autoSend) {
          // автоотправка включена, но не мгновенно: ждём фазу 2 по расписанию
          notify('repricer', { type: 'scheduled-send', sendAt: proposalSendAt(run.at, cfg) });
        }
      } else if (run.autoSend) {
        await sendPrices(results, 'repricer-auto');
      } else {
        notify('repricer', { type: 'calculated', at: run.at, summary });
      }

      return {
        summary,
        results: (opts && opts.full) ? results : results.slice(0, 1000),
        truncated: results.length > 1000 ? results.length - 1000 : 0,
        at: run.at,
        tookMs: Date.now() - startedAt,
        demo: isDemo()
      };
    } finally {
      sched.running = false;
    }
  }

  /** Когда наступит фаза отправки для предложения, рассчитанного в at. */
  function proposalSendAt(at, cfg) {
    const minutes = Math.max(1, Number((cfg && cfg.schedule && cfg.schedule.sendDelayMinutes) || 40));
    return new Date(new Date(at).getTime() + minutes * 60000).toISOString();
  }

  /**
   * Сохранить предложение репрайсера (фаза 1). Фактические цены не меняются.
   * В предложение попадают только строки, которые действительно надо отправить.
   */
  /**
   * Товары, которые нельзя предлагать к отправке: без себестоимости репрайсер считает
   * прибыль «от балды», а без базовой цены не из чего строить пару «цена + скидка».
   * В репрайсере INDEEPA такие строки помечаются «ОШИБКА: себестоимость должна быть
   * более 2 рублей, не заданы пороги минимальной и базовой цены» и не отправляются.
   *
   * @returns {string[]} причины (пустой массив = строка готова)
   */
  function proposalBlockers(r) {
    const out = [];
    // движок отдаёт не значение себестоимости, а её источник: 'none' = не задана нигде
    const src = (r.current && r.current.costSources) || {};
    if (src.costPriceRub === 'none') out.push('не задана себестоимость');
    else if (r.current && r.current.costPriceRub !== undefined && !(Number(r.current.costPriceRub) > 2)) out.push('себестоимость должна быть больше 2 ₽');
    /**
     * Базовой цены в ответе WB может не быть: продавец её ещё не задал либо товар
     * с поразмерными ценами (тогда цена подставляется из sizes[] — см. normalizeGood).
     * Ручных цен в приложении больше нет: цена рождается только расчётом
     * репрайсера по порогам товара, поэтому без базовой цены WB строку
     * предлагать не из чего.
     */
    if (!(Number(r.current && r.current.basePrice) > 0)) {
      out.push('базовая цена в WB не задана — обновите данные из кабинета');
    }
    if (!(Number(r.corridor && r.corridor.min) > 0)) out.push('не задан порог минимальной цены');
    // себестоимость введена в валюте, курс которой не задан: считать цену нельзя
    const costErr = (r.cost && r.cost.error) || r.costError;
    if (costErr) out.push(String(costErr));
    return out;
  }

  function saveProposal(results, summary, at, cfg) {
    const ready = [];
    const blocked = [];
    /**
     * В предложение попадает только расчёт репрайсера: цена из порогов товара
     * (минимум/максимум) и стратегии. Ручных цен, которые могли бы подменить
     * расчёт, в приложении больше нет — поэтому и в истории отправки всегда
     * видна именно цена репрайсера.
     */
    // настройки товара: режим цен по размерам и ручные цены размеров — для отправки
    const itemConfigsNow = store.loadItemConfigs() || {};
    (results || []).forEach((r) => {
      if (!r) return;
      if (r.error) { blocked.push({ nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '', reasons: [r.error], autoBlocked: true }); return; }
      /**
       * «Отправка в WB» выключена для товара (колонка в таблице репрайсера).
       * Цена при этом рассчитана и видна — строка попадает в список blocked
       * с понятной причиной, чтобы продавец видел, почему товар не ушёл.
       */
      if (r.autoBlocked) { blocked.push({ nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '', reasons: (r.issues || []).filter((i) => i.level === 'critical').map((i) => i.message), autoBlocked: true }); return; }
      if (r.allowSend === false) {
        blocked.push({
          nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
          reasons: ['отправка в WB отключена для товара'],
          sellerPrice: r.proposed && r.proposed.sellerPrice,
          notSending: true
        });
        return;
      }
      const blockers = proposalBlockers(r);
      if (blockers.length) {
        blocked.push({ nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
          reasons: blockers, sellerPrice: r.proposed && r.proposed.sellerPrice });
        return;
      }
      if (!r.needSend || !r.proposed) return;
      const why = proposalBlockers(r);
      if (why.length) {
        blocked.push({
          nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
          reasons: why, sellerPrice: r.proposed.sellerPrice
        });
        return;
      }
      ready.push(r);
    });
    const items = ready
      .map((r) => ({
        nmID: r.nmID,
        vendorCode: r.vendorCode || '',
        title: r.title || '',
        inputFingerprint: r.inputFingerprint, boost: r.boost || null,
        strategy: r.strategy || '',
        strategyTitle: r.strategyTitle || '',
        // что стоит сейчас — по этим цифрам потом проверяем, не изменилось ли что-то в WB
        currentBasePrice: r.current ? r.current.basePrice : 0,
        currentDiscount: r.current ? r.current.discount : 0,
        currentSellerPrice: r.current ? r.current.sellerPrice : 0,
        // только расчёт репрайсера по порогам и стратегии — ручных цен нет
        basePrice: r.proposed.basePrice,
        discount: r.proposed ? r.proposed.discount : 0,
        sellerPrice: r.proposed ? r.proposed.sellerPrice : 0,
        rpSellerPrice: r.proposed ? r.proposed.sellerPrice : 0,
        profitNow: r.current ? r.current.profit : 0,
        profitNext: r.proposed ? r.proposed.profit : 0,
        marginNow: r.current ? r.current.marginPct : 0,
        marginNext: r.proposed ? r.proposed.marginPct : 0,
        deltaPct: r.delta ? r.delta.pct : 0,
        deltaProfitMonth: r.delta ? r.delta.profitMonth : 0,
        quarantine: !!r.quarantine,
        warnings: r.warnings || [],
        limitedBy: r.limitedBy || '',
        // флаг и метка дублируются в предложение: отправка проверяет их ещё раз,
        // даже если предложение сохранено давно, а флаг выключили позже
        allowSend: r.allowSend !== false,
        tag: r.tag || '',
        // цены по размерам: режим и ручные правки (manual). Список размеров читается
        // из кэша товаров при отправке, не дублируется в предложении.
        sizePriceMode: normalizeSizePriceMode((r.context || {}).sizePriceMode),
        sizePrices: (itemConfigsNow[String(r.nmID)] || {}).sizePrices || {},
        // Сверяем все размеры, а не только минимальную цену: иначе чужая правка
        // более дорогого размера оставалась бы незамеченной при отправке.
        currentSizePrices: Object.fromEntries(((((cache.goods && cache.goods.items) || [])
          .find((g) => Number(g.nmID) === Number(r.nmID)) || {}).sizes || [])
          .map((size) => [String(size.sizeID), Number(size.price)])),
        costCurrency: (r.cost && r.cost.currency) || 'RUB',
        costRub: (r.cost && r.cost.rub) || 0
      }));
    const saved = store.saveProposals({
      at,
      phase: items.length ? 'proposed' : (blocked.length ? 'blocked' : 'empty'),
      sendAt: items.length ? proposalSendAt(at, cfg) : null,
      summary: Object.assign({}, summary || {}, { blocked: blocked.length }),
      items,
      blocked: blocked.slice(0, 500),
      blockedTotal: blocked.length,
      note: items.length
        ? (blocked.length ? 'Не вошли в предложение ' + blocked.length + ' товаров с незаполненными данными (себестоимость, пороги цен).' : '')
        : (blocked.length
          ? 'Пересчёт ничего не предложил к отправке, но у ' + blocked.length + ' товаров не заполнены данные — заполните себестоимость и пороги цен.'
          : 'Пересчёт не предложил изменений — отправлять нечего.')
    });
    // история пересчёта по каждому артикулу: что предложил РП и почему
    if (items.length) {
      store.appendRecalcHistory(items.map((x) => ({
        nmID: x.nmID, phase: 'propose', at,
        basePrice: x.basePrice, discount: x.discount, sellerPrice: x.sellerPrice,
        prevSellerPrice: x.currentSellerPrice,
        strategy: x.strategyTitle || x.strategy,
        reason: (x.warnings && x.warnings[0]) || x.limitedBy || '',
        sent: false
      })));
    }
    return saved;
  }

  /**
   * Проверить предложение перед отправкой: цены в кабинете могли измениться руками
   * или другой программой. Отправлять «вслепую» нельзя — иначе затрём чужие правки.
   */
  async function validateProposal(prop) {
    const items = (prop && prop.items) || [];
    if (!items.length) return { ok: false, reason: 'Предложение пустое — сначала пересчитайте цены.', stale: [], items: [] };
    let goods = [];
    try {
      // именно force: сравнивать предложение надо с тем, что в кабинете СЕЙЧАС,
      // а не с кэшем двухминутной давности
      const g = await handlers['wb:goods']({ force: true });
      goods = (g && g.items) || [];
    } catch (e) {
      return { ok: false, reason: 'Не удалось перечитать цены из WB: ' + (e.message || e), stale: [], items };
    }
    const byNm = new Map(goods.map((x) => [Number(x.nmID), x]));
    const stale = [];
    const fresh = [], fingerprints = inputSnapshot();
    for (const it of items) {
      if (it.inputFingerprint && it.inputFingerprint !== inputFingerprint(it.nmID, fingerprints)) { stale.push({ ...it, reason: 'Изменились настройки/расходы/режим или день лесенки — пересчитайте цены' }); continue; }
      const cur = byNm.get(Number(it.nmID));
      if (!cur) { stale.push(Object.assign({}, it, { reason: 'товар не найден в кабинете' })); continue; }
      const sizeSnapshot = it.currentSizePrices;
      if (sizeSnapshot && Object.keys(sizeSnapshot).length) {
        const currentSizes = new Map((cur.sizes || []).map((size) => [String(size.sizeID), Number(size.price)]));
        if (currentSizes.size !== Object.keys(sizeSnapshot).length || Object.entries(sizeSnapshot)
          .some(([sid, price]) => !currentSizes.has(sid) || Math.abs(currentSizes.get(sid) - Number(price)) > 0.5)) {
          stale.push(Object.assign({}, it, { reason: 'цены или состав размеров в WB изменились — нужен пересчёт' }));
          continue;
        }
      }
      const curSeller = Math.round(Number(cur.price) * (1 - Number(cur.discount) / 100) * 100) / 100;
      const wasSeller = Math.round(Number(it.currentSellerPrice) * 100) / 100;
      if (Math.abs(curSeller - wasSeller) > 0.51) {
        stale.push(Object.assign({}, it, { reason: 'цена в WB изменилась: ' + wasSeller + ' → ' + curSeller + ' ₽', actualSellerPrice: curSeller }));
      } else {
        fresh.push(it);
      }
    }
    if (!fresh.length) {
      return { ok: false, reason: 'Цены в WB изменились по всем позициям предложения — нужен новый пересчёт.', stale, items: [] };
    }
    return { ok: true, stale, items: fresh, reason: stale.length ? 'Часть позиций устарела (' + stale.length + ') — отправлены только актуальные.' : '' };
  }

  /** Фаза 2: отправить сохранённое предложение в WB. */
  async function sendProposal(source, nmIDs) { return priceJob(() => sendProposalImpl(source, nmIDs)); }

  async function sendProposalImpl(source, nmIDs) {
    const saved = store.loadProposals();
    if (saved.phase !== 'proposed') throw new WBError('Предложение уже отправлено, отменено или устарело — выполните новый пересчёт.', { code: 'PROPOSAL_STALE' });
    const ids = Array.isArray(nmIDs) ? new Set(nmIDs.map(String)) : null;
    const ready = saved.items.filter((x) => !x.sendState || x.sendState === 'ready');
    const prop = { ...saved, items: ids ? ready.filter((x) => ids.has(String(x.nmID))) : ready };
    if (!prop.items.length) {
      throw new WBError('Нет сохранённого предложения: сначала нажмите «Пересчитать цены».', { code: 'NO_PROPOSAL' });
    }
    /**
     * Товары с выключенным флагом «Отправка в WB» в кабинет не уходят.
     * Обычно их нет в предложении (фильтр стоит уже при сохранении), но предложение
     * могло быть сохранено до того, как флаг выключили, — проверяем здесь.
     */
    const itemCfgNow = store.loadItemConfigs() || {};
    const isDisabled = (x) => x.allowSend === false || (itemCfgNow[String(x.nmID)] || {}).allowSend === false;
    const disabled = prop.items.filter(isDisabled);
    prop.items = prop.items.filter((x) => !isDisabled(x));
    const sentList = prop.items;
    if (!prop.items.length) {
      throw new WBError('Отправка в WB выключена для всех товаров предложения: включите флаг в колонке «Отправка».', { code: 'SEND_DISABLED' });
    }
    const v = await validateProposal(prop);
    if (!v.ok) {
      const staleIDs = new Set((v.stale || []).map((x) => Number(x.nmID)));
      const items = saved.items.map((x) => staleIDs.has(Number(x.nmID)) ? { ...x, sendState: 'stale' } : x);
      store.saveProposals({ ...saved, items, phase: items.some((x) => !x.sendState || x.sendState === 'ready') ? 'proposed' : 'stale', sendAt: null, staleCount: staleIDs.size, note: v.reason });
      notify('repricer', { type: 'proposal-stale', reason: v.reason, stale: (v.stale || []).length });
      throw new WBError(v.reason, { code: 'PROPOSAL_STALE' });
    }
    const results = v.items.map((x) => ({
      nmID: x.nmID, needSend: true,
      current: { basePrice: x.currentBasePrice, discount: x.currentDiscount, sellerPrice: x.currentSellerPrice },
      proposed: { basePrice: x.basePrice, discount: x.discount, sellerPrice: x.sellerPrice },
      inputFingerprint: x.inputFingerprint, boost: x.boost,
      sizePriceMode: x.sizePriceMode,
      sizePrices: x.sizePrices
    }));
    const res = await sendPrices(results, source || 'repricer-proposal');
    const submitted = new Set((res.sentIDs || []).map(Number)), confirmed = new Set((res.confirmedIDs || []).map(Number));
    const failed = new Set((res.details || []).filter((d) => d.nmID && (d.errorText || d.error || [4, 5, 6].includes(Number(d.status)))).map((d) => Number(d.nmID)));
    const attempted = new Set(sentList.concat(disabled).map((x) => Number(x.nmID))), staleIDs = new Set((v.stale || []).map((x) => Number(x.nmID)));
    const sentAt = new Date().toISOString();
    const items = saved.items.map((x) => {
      if (!attempted.has(Number(x.nmID))) return x;
      const nm = Number(x.nmID), state = confirmed.has(nm) ? 'confirmed' : submitted.has(nm) ? failed.has(nm) ? 'rejected' : 'pending' : staleIDs.has(nm) ? 'stale' : disabled.some((d) => Number(d.nmID) === nm) ? 'disabled' : 'blocked';
      return { ...x, sendState: state, submittedAt: submitted.has(nm) ? sentAt : null };
    });
    const untouched = items.some((x) => !x.sendState || x.sendState === 'ready');
    const phase = untouched ? 'proposed' : items.every((x) => x.sendState === 'confirmed') ? 'sent' : items.some((x) => x.sendState === 'pending') ? 'pending' : 'partial';
    store.saveProposals({ ...saved, items, phase, sentAt, sendAt: null, staleCount: v.stale.length,
      note: 'Передано WB: ' + submitted.size + ', применение подтверждено: ' + confirmed.size + '. Неподтверждённые, отклонённые и пропущенные позиции сохранены со статусами. Автоповтора нет; проверьте WB, обновите данные и пересчитайте.' +
        (v.stale.length ? ' Устарело: ' + v.stale.length + '.' : '') + (disabled.length ? ' Отправка выключена: ' + disabled.length + '.' : '') });
    notify('repricer', { type: 'proposal-sent', count: res.sent || 0, confirmed: confirmed.size, stale: (v.stale || []).length });
    return Object.assign({ ok: true, stale: v.stale, staleReason: v.reason, skippedDisabled: disabled.length }, res);
  }

  /** Привести режим цен по размерам к допустимому значению (none/sync/manual). */
  function normalizeSizePriceMode(mode, fallback) {
    if (['none', 'sync', 'manual'].includes(mode)) return mode;
    return ['none', 'sync', 'manual'].includes(fallback) ? fallback : 'none';
  }

  function confirmedRows(items, details, sizeMode, goods) {
    const byNm = new Map((goods || []).map((g) => [Number(g.nmID), g]));
    return (items || []).filter((item) => {
      const rows = (details || []).filter((d) => Number(d.nmID) === Number(item.nmID) && (!sizeMode || Number(d.sizeID) === Number(item.sizeID)));
      if (!rows.length || rows.some((d) => Number(d.status) !== 3 || d.applied === false || d.pending || d.historyComplete === false || d.error || d.errorText)) return false;
      const taskIDs = new Set(rows.filter((d) => d.taskId != null).map((d) => String(d.taskId)));
      if ((details || []).some((d) => taskIDs.has(String(d.taskId)) && d.pending)) return false;
      // historyGoods содержит размеры. Одна успешная строка НЕ подтверждает весь
      // товар, если WB ещё не вернул остальные размеры из снимка каталога.
      const official = rows.some((d) => d.rawGoodStatus !== undefined);
      if (official && rows.some((d) => d.historyComplete !== true)) return false;
      if (!sizeMode) {
        const expected = (byNm.get(Number(item.nmID))?.sizes || []).map((s) => Number(s.sizeID)).filter((id) => Number.isSafeInteger(id) && id > 0);
        if (expected.length && (official || rows.every((d) => d.sizeID !== undefined))) {
          const found = new Set(rows.map((d) => Number(d.sizeID)));
          if (found.size !== expected.length || expected.some((id) => !found.has(id))) return false;
        }
      }
      return true;
    });
  }
  function uploadSummary(items, details, sizeMode, goods) {
    const confirmedItems = confirmedRows(items, details, sizeMode, goods);
    const confirmed = new Set(confirmedItems);
    const failed = (items || []).filter((item) => !confirmed.has(item) && (details || []).some((d) =>
      Number(d.nmID) === Number(item.nmID) && (!sizeMode || Number(d.sizeID) === Number(item.sizeID)) &&
      (d.errorText || d.error && !d.pending || [4, 5, 6].includes(Number(d.status)))));
    return { confirmedItems, ok: confirmedItems.length, failed: failed.length, pending: Math.max(0, (items || []).length - confirmedItems.length - failed.length) };
  }
  function activeSafetyLock(config) {
    const lock = config && config.safetyLock;
    return lock && lock.context === businessContext() ? lock : null;
  }
  async function mutationSnapshot(trustedGoods) {
    const context = businessContext();
    const goods = trustedGoods || (await handlers['wb:goods']({ force: true })).items || [];
    const rows = await buildContexts({ promos: false, noBoostOrders: true });
    assertPriceContext(context);
    return { context, goods, byNm: new Map(goods.map((g) => [Number(g.nmID), g])), rows: new Map(rows.map((r) => [Number(r.ctx.nmID), r])), inputs: inputSnapshot() };
  }
  function checkCandidate(snapshot, nmID, basePrice, discount, grants) {
    const good = snapshot.byNm.get(Number(nmID)), row = snapshot.rows.get(Number(nmID));
    if (!row || !good) return { ok: false, issues: [{ message: 'Товар не найден в текущем кабинете.' }] };
    const grant = grants && grants.get(Number(nmID));
    if (grant && (grant.context !== snapshot.context || grant.day !== StatMath.dayKey() || grant.at && Date.now() - grant.at > 180000)) return { ok: false, issues: [{ message: 'Подтверждение лесенки устарело. Пересчитайте цены.' }] };
    return PriceSafety.evaluate(row, { basePrice, discount }, { good, boost: grant && grant.plan, lock: activeSafetyLock(snapshot.inputs.configs[String(nmID)]) });
  }
  function mutationPreflight(snapshot, rows, grants) {
    assertPriceContext(snapshot.context);
    const current = inputSnapshot();
    for (const row of rows) {
      if (inputFingerprint(row.nmID, current) !== inputFingerprint(row.nmID, snapshot.inputs) || (current.configs[String(row.nmID)] || {}).allowSend === false || (activeSafetyLock(current.configs[String(row.nmID)]) || {}).active) throw new WBError('Данные товара ' + row.nmID + ' изменились в ожидании WB. Отправка остановлена; нужен пересчёт.', { code: 'PRICE_INPUT_CHANGED' });
      const grant = grants && grants.get(Number(row.nmID));
      if (grant && (grant.context !== businessContext() || grant.day !== StatMath.dayKey() || grant.at && Date.now() - grant.at > 180000)) throw new WBError('Снимок заказов лесенки устарел или начался новый день. Пересчитайте цены.', { code: 'BOOST_STALE' });
    }
  }
  async function applyPricesWithSafety(payload, internal) {
    return priceJob(async () => {
      const input = payload && payload.items;
      if (!Array.isArray(input) || !input.length) throw new WBError('Выберите товары для изменения цены.', { code: 'EMPTY' });
      const snapshot = await mutationSnapshot(internal && internal.goods), grants = internal && internal.boostGrants;
      const valid = new Map(), warnings = [], blocked = [];
      for (const it of input) {
        const nmID = Number(it && it.nmID), good = snapshot.byNm.get(nmID);
        if (!it || !Number.isSafeInteger(nmID) || nmID <= 0 || !good || it.price === undefined && it.discount === undefined) { blocked.push({ nmID, reason: 'Некорректный или чужой товар / не указана цена.' }); continue; }
        const bases = it.price === undefined && (good.sizes || []).length ? good.sizes.map((s) => Number(s.price)) : [it.price === undefined ? Number(good.price) : it.price];
        const discount = it.discount === undefined ? Number(good.discount) : it.discount;
        let failure, failureType = 'critical';
        for (const base of bases) { const check = checkCandidate(snapshot, nmID, base, discount, grants); if (!check.ok) { failure = check.issues.map((i) => i.message).join('; '); failureType = check.issues.some((i) => i.code === 'QUARANTINE') ? 'quarantine' : 'critical'; break; } }
        if (failure) { blocked.push({ nmID, reason: failure, type: failureType }); continue; }
        const row = { nmID };
        if (it.price !== undefined) row.price = Math.round(Number(it.price));
        if (it.discount !== undefined) row.discount = Math.round(Number(it.discount));
        valid.set(nmID, row);
      }
      for (const b of blocked) warnings.push({ nmID: b.nmID, type: b.type || 'critical', message: b.reason });
      const quarantined = warnings.filter((w) => w.type === 'quarantine');
      if (quarantined.length) notify('app-event', { type: 'quarantine', count: quarantined.length, warnings: quarantined });
      const items = [...valid.values()];
      if (!items.length) return { demo: isDemo(), uploaded: 0, batches: [], details: [], warnings, blocked, sentItems: [] };
      mutationPreflight(snapshot, items, grants);
      let result;
      try {
        result = await (isDemo() ? getDemo() : getClient()).applyPrices(items, { beforeSend: (chunk) => mutationPreflight(snapshot, chunk, grants) });
        assertPriceContext(snapshot.context);
      } catch (error) {
        notify('app-event', { type: 'sendError', failed: items.length, message: error.message, source: payload.source || 'prices' });
        throw error;
      } finally { invalidateGoodsCache(); }
      const submitted = result.partialError ? (result.batches || []).flatMap((b) => b.items || []) : items;
      if (result.partialError) warnings.push({ type: 'partial-upload', message: 'Передача остановлена после ' + submitted.length + ' строк: ' + result.partialError.message });
      const details = result.details || [], summary = uploadSummary(submitted, details, false, snapshot.goods);
      const tasks = store.loadTasks();
      tasks.unshift({ taskId: Date.now(), uploadIDs: (result.batches || []).map((b) => b.response?.data?.id ?? b.response?.data?.uploadID ?? b.response?.data?.taskId).filter((id) => id != null), createdAt: new Date().toISOString(), total: submitted.length, ok: summary.ok, failed: summary.failed, pending: summary.pending, details, warnings, demo: isDemo() });
      store.saveTasks(tasks);
      if (summary.failed) notify('app-event', { type: 'sendError', failed: summary.failed, message: details.find((d) => d.errorText)?.errorText || 'WB отклонил часть цен.', source: payload.source || 'prices' });
      if (summary.pending) notify('warn', { where: 'prices', message: 'WB ещё не подтвердил применение цен: ' + summary.pending + ' товаров. Передача не равна установке; автоматического повтора нет.' });
      if (summary.ok) notify('app-event', { type: 'sendSuccess', count: summary.ok, source: payload.source || 'prices' });
      return { ...result, demo: isDemo(), warnings, blocked, sentItems: submitted, confirmedItems: summary.confirmedItems };
    });
  }

  /** Размеры валидируются только по данным сервера, а не по payload.goods из браузера. */
  async function applySizePrices(payload, trustedGoods, internal) {
    return priceJob(() => applySizePricesImpl(payload, trustedGoods, internal));
  }
  async function applySizePricesImpl(payload, trustedGoods, internal) {
    const input = payload && payload.items;
    if (!Array.isArray(input) || !input.length) throw new WBError('Нет размеров для изменения цены.', { code: 'EMPTY' });
    const snapshot = await mutationSnapshot(trustedGoods), goods = snapshot.goods, grants = internal && internal.boostGrants;
    const byNm = new Map(goods.map((g) => [Number(g.nmID), g]));
    const warnings = [];
    const valid = new Map();
    let skippedUnchanged = 0;
    const blockQuarantine = repricerCfg().limits.blockQuarantine !== false;
    for (const it of input) {
      if (!it || typeof it !== 'object') continue;
      const nmID = Number(it.nmID), sizeID = Number(it.sizeID);
      const good = byNm.get(nmID);
      const size = good && (good.sizes || []).find((s) => Number(s.sizeID) === sizeID);
      let type = '', message = '';
      const price = Math.round(Number(it.price));
      if (!good) { type = 'unknown-item'; message = 'Товар не найден в загруженном кабинете.'; }
      else if (!size || !Number.isSafeInteger(sizeID) || sizeID <= 0) { type = 'unknown-size'; message = 'Размер не принадлежит товару.'; }
      else if (!good.editableSizePrice) { type = 'not-size-editable'; message = 'WB не разрешает разные цены размеров у этого товара.'; }
      else if ((typeof it.price !== 'number' && typeof it.price !== 'string') || String(it.price).trim() === '' ||
        !Number.isSafeInteger(price) || price < 1) { type = 'bad-price'; message = 'Цена размера должна быть конечным числом не меньше 1 ₽.'; }
      if (type) { warnings.push({ nmID, sizeID, type, message: message + ' Размер ' + sizeID + ' не отправлен.' }); continue; }
      const discounts = new Set([Number(good.discount) || 0, internal && internal.targets && internal.targets.get(nmID)].filter((n) => n !== undefined));
      let unsafe = '', quarantineRisk = false;
      for (const discount of discounts) { const check = checkCandidate(snapshot, nmID, price, discount, grants); if (!check.ok) { unsafe = check.issues.map((i) => i.message).join('; '); quarantineRisk = check.issues.some((i) => i.code === 'QUARANTINE'); break; } }
      if (unsafe) { warnings.push({ nmID, sizeID, type: quarantineRisk ? 'quarantine' : 'critical', message: unsafe }); continue; }
      if (price === Math.round(Number(size.price))) { skippedUnchanged++; continue; }
      const discount = Number(good.discount) || 0;
      const oldSeller = Number(size.price) * (1 - discount / 100);
      const newSeller = price * (1 - discount / 100);
      if (oldSeller > 0 && newSeller < oldSeller / 3) {
        warnings.push({ nmID, sizeID, type: 'quarantine',
          message: 'Цена размера ' + sizeID + ' снизится более чем в 3 раза (' + Math.round(oldSeller) + ' → ' + Math.round(newSeller) + ' ₽).' +
            (blockQuarantine ? ' Отправка заблокирована защитой приложения.' : ' Проверьте цену: защита приложения отключена.') });
        if (blockQuarantine) continue;
      }
      valid.set(nmID + ':' + sizeID, { nmID, sizeID, price });
    }
    const items = Array.from(valid.values());
    const quarantined = warnings.filter((w) => w.type === 'quarantine');
    if (quarantined.length) notify('app-event', { type: 'quarantine', count: quarantined.length, warnings: quarantined });
    if (!items.length) return { demo: isDemo(), uploaded: 0, batches: [], details: [], warnings, skippedUnchanged, sentItems: [] };
    let res;
    try {
      mutationPreflight(snapshot, items, grants);
      res = await (isDemo() ? getDemo() : getClient()).applySizePrices(items, { beforeSend: (chunk) => mutationPreflight(snapshot, chunk, grants) });
      assertPriceContext(snapshot.context);
    } catch (error) {
      if (!isDemo()) notify('app-event', { type: 'sendError', failed: items.length, message: error.message || String(error), source: payload.source || 'size-prices' });
      throw error;
    } finally {
      // Даже при сетевой ошибке часть пачек могла быть принята WB.
      invalidateGoodsCache();
    }
    const submitted = res.partialError ? (res.batches || []).flatMap((b) => b.items || []) : items;
    if (res.partialError) warnings.push({ type: 'partial-upload', message: 'Передача размеров остановлена: ' + res.partialError.message });
    const details = res.details || [];
    const summary = uploadSummary(submitted, details, true, goods);
    if (!isDemo()) {
      const tasks = store.loadTasks();
      tasks.unshift({ taskId: Date.now(), uploadIDs: (res.batches || []).map((b) => b.response?.data?.id ?? b.response?.data?.uploadID ?? b.response?.data?.taskId).filter((id) => id != null), createdAt: new Date().toISOString(), kind: 'size-prices',
        total: submitted.length, ok: summary.ok, failed: summary.failed, pending: summary.pending, details, warnings });
      store.saveTasks(tasks);
      if (summary.failed) notify('app-event', { type: 'sendError', failed: summary.failed, message: details.find((d) => d.errorText)?.errorText || 'WB отклонил часть размеров.', source: payload.source || 'size-prices' });
      if (summary.pending) notify('warn', { where: 'prices', message: 'WB ещё не подтвердил цены размеров: ' + summary.pending + '. Проверьте результат перед новым расчётом.' });
      if (summary.ok) notify('app-event', { type: 'sendSuccess', count: summary.ok, source: payload.source || 'size-prices' });
    }
    return Object.assign({}, res, { demo: isDemo(), warnings, skippedUnchanged, sentItems: submitted, confirmedItems: summary.confirmedItems });
  }

  async function sendPrices(results, source) { return priceJob(() => sendPricesImpl(results, source)); }

  async function sendPricesImpl(results, source) {
    const toSend = (results || []).filter((r) => r.needSend && !r.error && !r.autoBlocked && r.proposed);
    if (!toSend.length) return { sent: 0, sentIDs: [], skipped: (results || []).length };
    const context = businessContext(), goodsSnap = ((await handlers['wb:goods']({})).items || []);
    const goodsByNm = new Map(goodsSnap.map((g) => [Number(g.nmID), g]));
    const itemConfigsNow = store.loadItemConfigs() || {}, cfg = repricerCfg(), inputs = inputSnapshot();
    const hasBoost = toSend.some((r) => (itemConfigsNow[String(r.nmID)] || {}).strategy === 'boost' || cfg.defaults.strategy === 'boost');
    if (hasBoost) await ensureBoostOrders();
    const contexts = await buildContexts({ noBoostOrders: true, promos: hasBoost });
    assertPriceContext(context);
    const rowsByNm = new Map(contexts.map((r) => [Number(r.ctx.nmID), r]));
    const boostGrants = new Map(), items = [], sizeRows = [], allWarnings = [], eligible = [];
    for (const r of toSend) {
      const good = goodsByNm.get(Number(r.nmID)), row = rowsByNm.get(Number(r.nmID));
      if (!good || !row) { allWarnings.push({ nmID: r.nmID, type: 'unknown-item', message: 'Товар не найден в текущем кабинете.' }); continue; }
      const ic = itemConfigsNow[String(r.nmID)] || {};
      if (ic.allowSend === false || r.allowSend === false) continue;
      if (r.inputFingerprint && r.inputFingerprint !== inputFingerprint(r.nmID, inputs)) { allWarnings.push({ nmID: r.nmID, type: 'stale', message: 'Изменились настройки/расходы/источники. Пересчитайте цены.' }); continue; }
      let plan;
      if (row.itemCfg.strategy === 'boost') {
        plan = Boost.plan(row.ctx, row.itemCfg.boost, row.itemCfg.boostRuntime, boostOrders, context);
        if (plan.blocked || !r.boost || plan.day !== r.boost.day || plan.status !== r.boost.status || plan.promoId !== r.boost.promoId || Math.abs(Number(plan.target) - Number(r.boost.target)) > .005) { allWarnings.push({ nmID: r.nmID, type: 'boost-stale', message: plan.blocked ? plan.reason : 'Заказы/ступень лесенки изменились. Нужен новый пересчёт.' }); continue; }
        boostGrants.set(Number(r.nmID), { plan, at: boostOrders && boostOrders.at, day: StatMath.dayKey(), context });
      }
      const check = PriceSafety.evaluate(row, r.proposed, { good, boost: plan, lock: activeSafetyLock(ic) });
      if (!check.ok) { allWarnings.push({ nmID: r.nmID, type: 'critical', message: check.issues.map((i) => i.message).join('; ') }); continue; }
      eligible.push(r);
      const mode = normalizeSizePriceMode(r.sizePriceMode || (r.context || {}).sizePriceMode || ic.sizePriceMode,
        (cfg.defaults || {}).sizePriceMode || cfg.sizePriceMode);
      const targetPrice = Math.round(Number(r.proposed.basePrice));
      const targetDiscount = Math.round(Number(r.proposed.discount));
      const sizes = good.sizes || [];
      if (good.editableSizePrice && mode !== 'none') {
        // WB задаёт скидку только на товар. Без price эта операция сохраняет
        // текущие базовые цены размеров, в том числе не затронутых ручной правкой.
        if (targetDiscount !== Math.round(Number(good.discount))) items.push({ nmID: r.nmID, discount: targetDiscount });
        if (mode === 'sync') {
          sizes.forEach((size) => sizeRows.push({ nmID: r.nmID, sizeID: size.sizeID, price: targetPrice }));
        } else {
          const manual = r.sizePrices || ic.sizePrices || {};
          Object.entries(manual).forEach(([sizeID, price]) => sizeRows.push({ nmID: r.nmID, sizeID: Number(sizeID), price }));
        }
      } else {
        const differentSizes = new Set(sizes.map((size) => Math.round(Number(size.price))).filter((price) => price > 0)).size > 1;
        const changesBase = targetPrice !== Math.round(Number(good.price));
        if (differentSizes && changesBase) {
          allWarnings.push({ nmID: r.nmID, type: 'size-equalize', message: 'У товара ' + r.nmID + ' разные цены размеров — отправка общей базовой цены сделает их одинаковыми.' });
          if (source === 'repricer-auto') { allWarnings.push({ nmID: r.nmID, type: 'size-equalize-blocked', message: 'Автоотправка этого товара пропущена: разные цены размеров. Выберите sync/manual или подтвердите общую цену вручную в репрайсере.' }); continue; }
        }
        // Изменение только скидки не должно случайно выровнять разные цены.
        items.push(changesBase ? { nmID: r.nmID, price: targetPrice, discount: targetDiscount }
          : { nmID: r.nmID, discount: targetDiscount });
      }
    }
    const targets = new Map(eligible.map((r) => [Number(r.nmID), Math.round(Number(r.proposed.discount))]));
    const rejected = new Set();
    for (const candidate of sizeRows) {
      const row = rowsByNm.get(Number(candidate.nmID)), good = goodsByNm.get(Number(candidate.nmID)), grant = boostGrants.get(Number(candidate.nmID));
      for (const discount of new Set([Number(good.discount), targets.get(Number(candidate.nmID))])) {
        const test = PriceSafety.evaluate(row, { basePrice: candidate.price, discount }, { good, boost: grant && grant.plan , lock: activeSafetyLock(itemConfigsNow[String(candidate.nmID)]) });
        if (!test.ok) { rejected.add(Number(candidate.nmID)); allWarnings.push({ nmID: candidate.nmID, type: 'size-critical', message: 'Размер ' + candidate.sizeID + ': ' + test.issues.map((i) => i.message).join('; ') }); }
      }
    }
    const validItems = items.filter((i) => !rejected.has(Number(i.nmID))), validSizes = sizeRows.filter((i) => !rejected.has(Number(i.nmID)));
    const empty = () => ({ uploaded: 0, batches: [], details: [], warnings: [], sentItems: [], demo: isDemo() });
    const res = validItems.length ? await applyPricesWithSafety({ items: validItems, source: source || 'repricer' }, { goods: goodsSnap, boostGrants }) : empty();
    const commonOK = new Set((res.confirmedItems || []).map((i) => Number(i.nmID)));
    const blockedProducts = new Set((res.blocked || []).map((i) => Number(i.nmID)));
    validItems.forEach((i) => { if (!commonOK.has(Number(i.nmID))) blockedProducts.add(Number(i.nmID)); });
    const readySizes = validSizes.filter((i) => !blockedProducts.has(Number(i.nmID)));
    if (readySizes.length < validSizes.length) allWarnings.push({ type: 'discount-pending', message: 'Цены размеров не отправлены до подтверждения общей скидки WB. Проверьте результат и пересчитайте товар.' });
    let sizeRes = empty();
    try { if (readySizes.length) sizeRes = await applySizePrices({ items: readySizes, source: source || 'repricer' }, goodsSnap, { boostGrants, targets }); }
    catch (error) {
      if (!(res.sentItems || []).length) throw error;
      sizeRes.partialError = { message: error.message, code: error.code || 'SIZE_UPLOAD_INTERRUPTED' };
      allWarnings.push({ type: 'size-partial', message: 'Общая цена/скидка передана, но размеры не подтверждены: ' + error.message });
    }
    allWarnings.push(...(res.warnings || []), ...(sizeRes.warnings || []));
    const details = (res.details || []).concat(sizeRes.details || []);
    const commonConfirmed = new Set((res.confirmedItems || []).map((r) => Number(r.nmID))), sizeConfirmed = new Set((sizeRes.confirmedItems || []).map((r) => Number(r.nmID) + '#' + Number(r.sizeID)));
    const sentIDs = new Set((res.sentItems || []).map((item) => Number(item.nmID)));
    // size-метод может отфильтровать неизменённые/чужие/небезопасные размеры.
    (sizeRes.sentItems || []).forEach((row) => sentIDs.add(Number(row.nmID)));
    const confirmedIDs = [...sentIDs].filter((nm) => validItems.filter((r) => Number(r.nmID) === nm).every(() => commonConfirmed.has(nm)) && validSizes.filter((r) => Number(r.nmID) === nm).every((r) => {
      const installed = (goodsByNm.get(nm).sizes || []).find((s) => Number(s.sizeID) === Number(r.sizeID));
      return installed && Math.round(Number(installed.price)) === Math.round(Number(r.price)) || sizeConfirmed.has(nm + '#' + Number(r.sizeID));
    }));
    const sentResults = toSend.filter((r) => sentIDs.has(Number(r.nmID)));
    const confirmedResults = sentResults.filter((r) => confirmedIDs.includes(Number(r.nmID)));

    store.appendPriceHistory(confirmedResults.map((r) => ({
      nmID: r.nmID,
      // Полный подтверждённый снимок размеров, включая неизменённые при manual.
      sizePrices: Object.fromEntries((goodsByNm.get(Number(r.nmID))?.sizes || []).map((size) => {
        const common = (res.confirmedItems || []).find((row) => Number(row.nmID) === Number(r.nmID));
        const target = validSizes.find((row) => Number(row.nmID) === Number(r.nmID) && Number(row.sizeID) === Number(size.sizeID));
        return [String(size.sizeID), target ? Number(target.price) : common && common.price !== undefined ? Number(common.price) : Number(size.price)];
      })),
      basePrice: r.proposed.basePrice,
      discount: r.proposed.discount,
      sellerPrice: r.proposed.sellerPrice,
      source: source || 'repricer'
    })));

    // история пересчёта по артикулу: что реально ушло в WB (фаза 'send')
    store.appendRecalcHistory(sentResults.map((r) => ({
      nmID: r.nmID,
      phase: confirmedIDs.includes(Number(r.nmID)) ? 'send' : 'submitted',
      basePrice: r.proposed.basePrice,
      discount: r.proposed.discount,
      sellerPrice: r.proposed.sellerPrice,
      prevSellerPrice: r.current ? r.current.sellerPrice : 0,
      strategy: r.strategyTitle || r.strategy || (source || 'repricer'),
      reason: source || 'repricer',
      sent: confirmedIDs.includes(Number(r.nmID))
    })));

    const runs = store.loadRuns();
    runs.unshift({
      id: Date.now(),
      at: new Date().toISOString(),
      mode: source || 'repricer',
      sent: sentIDs.size,
      sizeSent: sizeRes.uploaded || 0,
      ok: details.filter((x) => x.status === 3).length,
      failed: details.filter((x) => x.error || x.errorText || (x.status && x.status !== 3)).length,
      demo: isDemo(),
      summary: RP.summarize(results)
    });
    store.saveRuns(runs);
    notify('repricer', { type: 'sent', count: sentIDs.size, at: new Date().toISOString() });
    return Object.assign({}, res, { sent: sentIDs.size, sentIDs: [...sentIDs], confirmedIDs, confirmed: confirmedIDs.length, toSendCount: toSend.length,
      uploaded: Number(res.uploaded || 0) + Number(sizeRes.uploaded || 0),
      sizeSent: sizeRes.uploaded || 0, details, batches: (res.batches || []).concat(sizeRes.batches || []),
      warnings: allWarnings });
  }

  /**
   * Загружает отчёт о реализации WB и считает средние расходы на одну продажу.
   * Отчёт формируется с задержкой (обычно раз в сутки), поэтому данные «свежие, но вчерашние» —
   * для плавающей логистики это нормально: берём среднее за окно дней.
   */
  async function loadFactCosts(opts) {
    const s = getSettings();
    const o = opts || {};
    /**
     * Период можно задать явно (dateFrom/dateTo) — это нужно отчётам, где продавец
     * выбирает произвольный диапазон, а не только «последние N дней».
     * Если даты не заданы, окно считается от сегодня назад на days дней, как раньше.
     */
    const iso = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
    const explicitFrom = o.dateFrom ? iso(o.dateFrom) : '';
    const explicitTo = o.dateTo ? iso(o.dateTo) : '';
    const days = explicitFrom && explicitTo
      ? Math.max(1, Math.round((new Date(explicitTo) - new Date(explicitFrom)) / 86400000) + 1)
      : Math.max(1, Number(o.days || s.factWindowDays || 7));
    const period = o.period || s.factCostsPeriod || 'daily';
    const dateTo = explicitTo || new Date().toISOString().slice(0, 10);
    const dateFrom = explicitFrom || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const maxWaitMs = o.patient ? 300000 : undefined;
    const lookback = Math.max(days, Number(s.factLookbackDays || 60));
    // отсчёт назад — от конца запрошенного периода, иначе для старого периода
    // «поиск последнего отчёта» уходил бы в сегодняшние даты и ничего не находил
    const lbAnchor = explicitTo ? new Date(explicitTo).getTime() : Date.now();
    const lbFrom = new Date(lbAnchor - lookback * 86400000).toISOString().slice(0, 10);

    const previous = store.loadFactCosts() || {};
    const prevItems = Object.keys(previous.items || {}).length;

    /** Пустой ответ WB не должен стирать уже сохранённые расходы. */
    const emptyResult = (msg, code, extra) => Object.assign({
      ok: false,
      empty: true,
      code: code || 'NO_ROWS',
      message: msg,
      keptPrevious: prevItems > 0,
      prevItems,
      prevMeta: previous.meta || null,
      days, period, dateFrom, dateTo,
      items: prevItems,
      rowsProcessed: 0
    }, extra || {});

    let res = null;
    let range = { dateFrom, dateTo };
    let usedPeriod = period;
    let reports = null;
    let reportsUsed = null;
    let widened = false;

    if (isDemo()) {
      res = await getDemo().getSalesReportDetailed({ dateFrom, dateTo, period });
    } else {
      const client = getClient();
      if (o.patient) {
        // Фоновый режим: сначала спрашиваем WB, какие отчёты о реализации вообще
        // сформированы (POST /api/finance/v1/sales-reports/list), и только потом
        // просим детализацию. Без этого «0 строк» невозможно отличить от «отчёта
        // за этот период ещё не существует».
        try {
          reports = await client.getSalesReportsList({
            dateFrom: lbFrom, dateTo, period, limit: 100, offset: 0, maxWaitMs
          });
        } catch (e) {
          if (e && (e.status === 401 || e.status === 403)) throw e;   // нет прав — сообщаем честно
          notify('warn', { where: 'finance', message: 'Список отчётов WB недоступен: ' + (e.message || e) });
        }
        if (reports && !reports.length && s.factAutoWiden !== false) {
          // дневных отчётов нет — пробуем недельные (WB формирует их по понедельникам)
          const alt = period === 'daily' ? 'weekly' : 'daily';
          try {
            const altReports = await client.getSalesReportsList({
              dateFrom: lbFrom, dateTo, period: alt, limit: 100, offset: 0, maxWaitMs: 300000
            });
            if (altReports.length) { reports = altReports; usedPeriod = alt; }
          } catch (e) { /* второй период не обязателен */ }
        }
        if (reports && reports.length) {
          const inWindow = reports.filter((r) => String(r.dateTo || '') >= dateFrom && String(r.dateFrom || '') <= dateTo);
          const sorted = reports.slice().sort((a, b) => String(b.dateTo || '').localeCompare(String(a.dateTo || '')));
          const chosen = inWindow.length ? inWindow : sorted.slice(0, Math.max(1, Math.ceil(days / 7) + 1));
          widened = !inWindow.length;
          reportsUsed = chosen;
          range = {
            dateFrom: chosen.reduce((m, r) => (String(r.dateFrom || m) < m ? String(r.dateFrom) : m), String(chosen[0].dateFrom || dateFrom)),
            dateTo: chosen.reduce((m, r) => (String(r.dateTo || m) > m ? String(r.dateTo) : m), String(chosen[0].dateTo || dateTo))
          };
        }
      }
      res = await client.getSalesReportDetailed({
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        period: usedPeriod,
        maxPages: Number(s.factMaxPages || 10),
        maxWaitMs,
        pageWaitMs: 300000,
        onProgress: (p) => notify('log', { where: 'finance', pages: p.pages, rows: p.rows })
      });
    }

    const rows = (res && res.rows) || [];
    if (!rows.length) {
      const periodRu = usedPeriod === 'weekly' ? 'недельный' : 'дневной';
      const foundText = reports === null
        ? ''
        : (reports.length
          ? ' Список отчётов WB за ' + lbFrom + ' → ' + dateTo + ': ' + reports.length + ' шт.'
          : ' Ни одного отчёта за ' + lbFrom + ' → ' + dateTo + ' WB не сформировал.');
      const msg = 'За ' + dateFrom + ' → ' + dateTo + ' (' + periodRu + ' отчёт) WB не отдал ни одной строки.' + foundText +
        ' Отчёты о реализации формируются с задержкой: дневной — на следующий день, недельный — в понедельник за прошлую неделю.' +
        (prevItems
          ? ' Сохранённые ранее расходы (' + prevItems + ' товаров) не тронуты.'
          : ' Проверьте: были ли продажи в этом периоде, подписано ли в кабинете WB соглашение о финансах и есть ли у токена категория «Финансы».');
      if (!o.patient && s.factAutoWiden !== false) {
        // В быстром режиме не тратим вторую минуту лимита «Финансы»: поиск последнего
        // доступного отчёта уйдёт в фон и сам пришлёт результат.
        return emptyResult(msg, 'DEFER', {
          widenNeeded: true,
          retryAt: Date.now() + RATE_FALLBACK_MS,
          reportsFound: reports ? reports.length : null
        });
      }
      return emptyResult(msg, 'NO_ROWS', { reportsFound: reports ? reports.length : null, range });
    }

    // если взяли отчёт за другой период — считаем средние по его фактической длине
    const spanDays = Math.max(1, Math.round((new Date(range.dateTo + 'T00:00:00Z') - new Date(range.dateFrom + 'T00:00:00Z')) / 86400000) + 1);
    const effDays = widened ? spanDays : days;

    const agg = aggregateFactCosts(rows, effDays);
    const items = agg.items;
    const byDay = agg.byDay || {};
    const byItemDay = agg.byItemDay || {};
    const meta = {
      days: effDays,
      requestedDays: days,
      period: usedPeriod,
      requestedPeriod: period,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      requestedFrom: dateFrom,
      requestedTo: dateTo,
      widened,
      reportsFound: reports ? reports.length : null,
      reportsUsed: reportsUsed ? reportsUsed.map((r) => ({ reportId: r.reportId, dateFrom: r.dateFrom, dateTo: r.dateTo, period: r.period })) : null,
      rowsProcessed: rows.length,
      source: res.source || 'finance-api',
      pages: res.pages || 1,
      items: Object.keys(items).length,
      reportTruncated: !!(res && res.truncated),
      loadedAt: new Date().toISOString(),
      byDay
    };
    /**
     * save=false — «только посмотреть»: используется отчётами, когда продавец выбрал
     * произвольный период. Основной снимок расходов (и экономика всех разделов) при этом
     * НЕ перезаписывается, иначе просмотр старого месяца сбросил бы актуальные данные.
     */
    if (o.save === false) {
      // ВАЖНО: отдельное имя factItems — в meta уже есть поле items (число товаров),
      // и Object.assign перезаписал бы им саму карту расходов.
      return { ok: true, factItems: items, factMeta: meta, saveSkipped: true };
    }

    // Сохраняем дневные факты по товару отдельно от последнего агрегата расходов.
    // Повторная загрузка диапазона заменяет эти даты (а не суммирует их повторно),
    // чтобы пересборка/коррекция отчёта WB не удваивала продажи.
    const oldFactMeta = (previous && previous.meta) || {};
    const freshRanges = reportsUsed && reportsUsed.length
      ? reportsUsed.map((r) => ({ dateFrom: iso10(r.dateFrom), dateTo: iso10(r.dateTo), period: r.period || usedPeriod }))
      : [{ dateFrom: iso10(range.dateFrom), dateTo: iso10(range.dateTo), period: usedPeriod }];
    const cutoffDate = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    const replacementDates = new Set();
    const coverageToday = new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10); // вчера по Москве
    // Достигнут лимит страниц Finance: полученные строки пригодны для текущего
    // ответа, но нельзя считать отсутствующие даты подтверждённым нулём или заменять
    // ими историю последнего полного отчёта.
    if (!meta.reportTruncated) {
      freshRanges.forEach((r) => {
        if (!r.dateFrom || !r.dateTo || r.dateTo < r.dateFrom) return;
        const from = r.dateFrom < cutoffDate ? cutoffDate : r.dateFrom;
        const to = r.dateTo > coverageToday ? coverageToday : r.dateTo;
        let guard = 0;
        for (let d = from; d <= to && guard++ < 731; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
          replacementDates.add(d);
        }
      });
    }
    const byItemDayHistory = Object.assign({}, oldFactMeta.byItemDay || {});
    replacementDates.forEach((d) => { delete byItemDayHistory[d]; });
    Object.keys(byItemDay).forEach((d) => {
      if (d >= cutoffDate && replacementDates.has(d)) byItemDayHistory[d] = byItemDay[d];
    });
    const coveredDateSet = new Set((Array.isArray(oldFactMeta.coveredDates) ? oldFactMeta.coveredDates : [])
      .map(iso10).filter((d) => d && d >= cutoffDate));
    replacementDates.forEach((d) => coveredDateSet.add(d));
    meta.byItemDay = byItemDayHistory;
    meta.coveredDates = Array.from(coveredDateSet).sort();
    meta.coverageRanges = (Array.isArray(oldFactMeta.coverageRanges) ? oldFactMeta.coverageRanges : [])
      .concat(freshRanges.map((r) => Object.assign({}, r, { loadedAt: meta.loadedAt, complete: !meta.reportTruncated })))
      .filter((r) => iso10(r.dateTo) >= cutoffDate).slice(-500);

    store.saveFactCosts(items, meta);
    store.saveSettings({ factsLoadedAt: meta.loadedAt, factWindowDays: days, factCostsPeriod: usedPeriod });
    invalidateGoodsCache();   // экономика пересчитается с фактическими расходами
    const publicMeta = Object.assign({}, meta);
    delete publicMeta.byItemDay;
    delete publicMeta.coveredDates;
    delete publicMeta.coverageRanges;
    publicMeta.analyticsDailyDates = meta.coveredDates.length;
    notify('facts', Object.assign({ type: 'loaded' }, publicMeta));
    return Object.assign({ ok: true }, publicMeta);
  }

  /**
   * Применяет решения по акциям из результатов пересчёта.
   *
   * ВХОД: отправляем цену (если она меняется) и добавляем товар в акцию через
   *       POST /api/v1/calendar/promotions/upload.
   * ВЫХОД: API WB исключить товар из акции не позволяет — поднимаем цену выше плановой,
   *       WB выводит товар сам, а мы запоминаем цену для возврата.
   */
  async function applyPromoActions(results, opts) {
    const o = opts || {};
    const cfg = repricerCfg();
    const pi = await promoIndex().catch(() => null);

    let rows = results;
    if (!rows) {
      const res = await calcRepricer({ full: true, promos: true });
      rows = res.results || [];
    }

    // поле решения называется promoChosen в расчёте и chosen в плане акций — принимаем оба
    const chosenOf = (r) => r.promoChosen || r.chosen || null;
    rows = rows.filter((r) => !r.error && !r.autoBlocked && r.allowSend !== false && r.strategy !== 'boost');
    let exits = rows.filter((r) => !r.error && chosenOf(r) && chosenOf(r).type === 'exit');
    const joins = rows.filter((r) => !r.error && chosenOf(r) && chosenOf(r).type === 'join');
    const invalidAbsoluteExit = exits.find((row) => Number(chosenOf(row).absolutePlanThreshold) > 0 &&
      Math.round(Number(row.proposed && row.proposed.basePrice) || 0) * (1 - Math.floor(Number(row.proposed && row.proposed.discount) || 0) / 100) <= Number(chosenOf(row).absolutePlanThreshold) + .005);
    if (invalidAbsoluteExit) throw new WBError('После округления или ограничений цена товара ' + invalidAbsoluteExit.nmID + ' не выше фиксированного порога акции. Выход не отправлен; пересчитайте цены.', { code: 'PROMO_EXIT_THRESHOLD' });
    const out = { exited: 0, joined: 0, joinFailed: [], exitFailed: [], restored: 0, demo: isDemo() };

    // ── выход из акции: снижаем скидку ниже порога ──
    // Цену отправляем только там, где она действительно меняется. Но в очередь возврата
    // ставим все товары с решением «выйти»: даже если скидка уже ниже порога, цену надо
    // вернуть после окончания акции — иначе товар так и останется с повышенной ценой.
    const exitsToSend = exits.filter((r) => r.needSend);
    if (exits.length) {
      let res = { task: null };
      if (exitsToSend.length) {
        const items = exitsToSend.map((r) => ({
          nmID: r.nmID,
          price: Math.round(r.proposed.basePrice),
          discount: Math.floor(r.proposed.discount)
        }));
        try {
          res = await sendPrices(exitsToSend, 'repricer-promo-exit');
        } catch (e) {
          out.exitFailed.push({ message: e.message });
          notify('warn', { where: 'promo-exit', message: e.message });
        }
      }
      const confirmed = new Set((res.confirmedIDs || []).map(Number));
      exits = exits.filter((r) => !r.needSend || confirmed.has(Number(r.nmID)));
      out.exited = exits.length;
      out.exitSent = Number(res.sent) || 0;
      out.exitPending = Math.max(0, out.exitSent - confirmed.size);
      out.exitNoChange = exits.filter((r) => !r.needSend).length;
      out.exitResult = { taskId: res.task && res.task.taskId, statusText: res.task && res.task.statusText };
      if (!out.exitFailed.length) {
        const pend = store.loadPromoExits();
        exits.forEach((r) => {
          pend[String(r.nmID)] = {
            nmID: r.nmID,
            vendorCode: r.vendorCode || '',
            title: r.title || '',
            promoIds: chosenOf(r).promoIds,
            promoNames: chosenOf(r).promoNames,
            raisedTo: r.proposed.sellerPrice,
            raisedBase: r.proposed.basePrice,
            raisedDiscount: r.proposed.discount,
            restoreSellerPrice: chosenOf(r).restoreSellerPrice,
            restorePair: chosenOf(r).restorePair || null,
            at: new Date().toISOString(),
            status: 'waiting'
          };
        });
        store.savePromoExits(pend);
        if (exitsToSend.length) {
          store.appendPriceHistory(exits.filter((r) => r.needSend).map((r) => ({
            nmID: r.nmID, basePrice: r.proposed.basePrice, discount: r.proposed.discount,
            sellerPrice: r.proposed.sellerPrice, source: 'promo-exit'
          })));
        }
        /**
         * Журнал участия в акциях: очередь возврата (promoexits.json) хранит только
         * НЕЗАКРЫТЫЕ позиции, поэтому без отдельного журнала вкладка «Журнал изменения
         * участия в акциях» пустела сразу после возврата цены.
         */
        store.appendPromoJournal([].concat(...exits.map((r) => {
          const ch = chosenOf(r) || {};
          const sent = exitsToSend.indexOf(r) >= 0;
          const promoIds = (ch.promoIds && ch.promoIds.length) ? ch.promoIds : [null];
          return promoIds.map((promoId, i) => ({
            nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
            action: 'exit',
            promoId,
            promoName: (ch.promoNames || [])[i] || (ch.promoNames || [])[0] || (promoId ? String(promoId) : ''),
            priceBefore: U2(r.current && r.current.sellerPrice),
            priceAfter: U2(r.proposed && r.proposed.sellerPrice),
            reason: ch.reason || '',
            source: sent ? 'repricer-promo-exit' : 'repricer-promo-exit-nochange',
            ok: !out.exitFailed.length,
            error: (out.exitFailed[0] || {}).message || ''
          }));
        })));
      }
    }

    // ── вход в акцию ──
    if (joins.length) {
      const byPromo = {};
      joins.forEach((r) => (chosenOf(r).promoIds || []).forEach((pid) => {
        (byPromo[pid] = byPromo[pid] || []).push(r);
      }));

      const priceReady = new Set(joins.filter((r) => !r.needSend).map((r) => Number(r.nmID)));
      // 1) цена должна удовлетворять условиям акции
      const priceItems = joins.filter((r) => r.needSend).map((r) => ({
        nmID: r.nmID, price: Math.round(r.proposed.basePrice), discount: Math.round(r.proposed.discount)
      }));
      if (priceItems.length) {
        try {
          const sent = await sendPrices(joins.filter((r) => r.needSend), 'repricer-promo-join');
          (sent.confirmedIDs || []).forEach((nm) => priceReady.add(Number(nm)));
          store.appendPriceHistory(joins.filter((r) => r.needSend && priceReady.has(Number(r.nmID))).map((r) => ({
            nmID: r.nmID, basePrice: r.proposed.basePrice, discount: r.proposed.discount,
            sellerPrice: r.proposed.sellerPrice, source: 'promo-join'
          })));
        } catch (e) {
          out.joinFailed.push({ step: 'price', message: e.message });
          notify('warn', { where: 'promo-join', message: e.message });
        }
      }

      // 2) добавляем товары в акцию
      for (const [pid, candidates] of Object.entries(byPromo)) {
        const list = candidates.filter((r) => priceReady.has(Number(r.nmID)));
        if (!list.length) continue;
        const promoMeta = ((pi && pi.promos) || []).find((x) => String(x.id) === String(pid)) || null;
        try {
          await handlers['wb:promo-join']({
            promotionID: Number(pid),
            _journal: false, // журнал записывается здесь вместе с прогнозом движка
            nomenclatures: list.map((r) => ({
              nmID: r.nmID,
              price: Math.round(r.proposed.basePrice),
              discount: Math.round(r.proposed.discount)
            }))
          });
          out.joined += list.length;
          store.appendPromoJournal(list.map((r) => {
            const ch = chosenOf(r) || {};
            return {
              nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
              action: 'join', promoId: Number(pid),
              promoName: (promoMeta && promoMeta.name) || String(pid),
              promoStartAt: (promoMeta && promoMeta.startDateTime) || '',
              promoEndAt: (promoMeta && promoMeta.endDateTime) || '',
              forecast: {
                profitMonthNow: r.delta && r.delta.profitMonthNow,
                profitMonthWithPromo: r.delta && r.delta.profitMonthWithPromo,
                salesUpliftPct: r.delta && r.delta.salesUpliftPct,
                breakEvenUpliftPct: r.delta && r.delta.breakEvenUpliftPct
              },
              priceBefore: U2(r.current && r.current.sellerPrice),
              priceAfter: U2(r.proposed && r.proposed.sellerPrice),
              reason: ch.reason || '',
              source: 'repricer-promo-join',
              ok: true
            };
          }));
        } catch (e) {
          out.joinFailed.push({ promoId: Number(pid), message: e.message });
          notify('warn', { where: 'promo-join', message: e.message });
          store.appendPromoJournal(list.map((r) => ({
            nmID: r.nmID, vendorCode: r.vendorCode || '', title: r.title || '',
            action: 'join', promoId: Number(pid), promoName: String(pid),
            priceBefore: U2(r.current && r.current.sellerPrice),
            priceAfter: U2(r.proposed && r.proposed.sellerPrice),
            reason: 'Вход в акцию не выполнен',
            source: 'repricer-promo-join',
            ok: false, error: e.message || String(e)
          })));
        }
      }
    }

    // ── возврат цен после фактического выхода из акции ──
    if (cfg.promo.restorePriceAfterExit !== false) {
      try {
        // состав акций только что изменился — проверяем по свежим данным
        promoCache.at = 0;
        const r = await restorePromoExits(await promoIndex(true).catch(() => null));
        out.restored = r.restored;
        out.restoreBlocked = r.blocked || 0;
      } catch (e) {
        notify('warn', { where: 'promo-restore', message: e.message });
      }
    }

    if (out.exited || out.joined || out.restored) {
      const runs = store.loadRuns();
      runs.unshift({
        id: Date.now(), at: new Date().toISOString(), mode: 'promo',
        sent: out.exited + out.joined, joined: out.joined, exited: out.exited, restored: out.restored,
        demo: isDemo(), summary: { total: rows.length, toSend: out.exited + out.joined }
      });
      store.saveRuns(runs);
      notify('repricer', { type: 'promo-applied', joined: out.joined, exited: out.exited, restored: out.restored });
    }
    promoCache.at = 0;   // состав акций изменился — индекс нужно пересобрать
    return out;
  }

  /**
   * Возвращает рабочую цену товарам, которые вышли из акции после повышения.
   * Проверяем фактический состав акции: пока товар числится участником — ждём.
   */
  async function restorePromoExits(pi, opts) {
    // force — вернуть цену, даже если автоакция ещё идёт (решение пользователя)
    const force = !!(opts && opts.force);
    const pend = store.loadPromoExits();
    const keys = Object.keys(pend);
    if (!keys.length) return { restored: 0, pending: 0 };
    const index = pi || await promoIndex(true).catch(() => null);
    if (!index || !index.index) return { restored: 0, pending: keys.length, reason: 'нет данных календаря акций' };

    const cfg = repricerCfg();
    const holdForAutoPromo = cfg.promo.restoreAfterAutoPromoEnds !== false;
    const toRestore = [];
    let blocked = 0;
    let changed = false;
    for (const k of keys) {
      const rec = pend[k];
      const stillIn = (rec.promoIds || []).some((pid) => index.index[pid] && index.index[pid].inAction.has(Number(k)));
      if (stillIn) {
        if (rec.status !== 'waiting-exit') { rec.status = 'waiting-exit'; changed = true; }
        continue;
      }
      // Автоакция подхватит товар обратно, как только цена станет ниже плановой.
      // Поэтому цену не возвращаем, пока такая акция не закончится.
      const blocking = (holdForAutoPromo && !force) ? (rec.promoIds || []).filter((pid) => {
        const pr = (index.promos || []).find((x) => String(x.id) === String(pid));
        if (!pr || String(pr.type || '').toLowerCase() !== 'auto') return false;
        const end = new Date(pr.endDateTime || 0).getTime();
        return Number.isFinite(end) && end > Date.now();
      }) : [];
      if (blocking.length) {
        blocked++;
        if (rec.status !== 'waiting-promo-end') { rec.status = 'waiting-promo-end'; changed = true; }
        continue;
      }
      if (rec.status !== 'ready') { rec.status = 'ready'; changed = true; }
      toRestore.push(k);
    }
    if (changed) store.savePromoExits(pend);
    if (!toRestore.length) return { restored: 0, pending: keys.length, blocked };

    const items = [];
    for (const k of toRestore) {
      const rec = pend[k];
      const pair = rec.restorePair;
      if (!pair || !(Number(pair.basePrice) > 0)) continue;
      items.push({ nmID: Number(k), price: Math.round(pair.basePrice), discount: Math.round(pair.discount) });
    }
    if (!items.length) return { restored: 0, pending: keys.length };

    const res = await handlers['wb:apply-prices']({ items, source: 'repricer-promo-restore' });
    const confirmed = new Set((res.confirmedItems || []).map((r) => Number(r.nmID))), restoredItems = items.filter((r) => confirmed.has(Number(r.nmID)));
    // до удаления из очереди берём данные для журнала: после возврата запись исчезнет
    const journalRows = restoredItems.map((i) => {
      const rec = pend[String(i.nmID)] || {};
      return {
        nmID: i.nmID, vendorCode: rec.vendorCode || '', title: rec.title || '',
        action: 'restore',
        promoId: (rec.promoIds || [])[0] || null,
        promoName: (rec.promoNames || []).join(', '),
        priceBefore: U2(rec.raisedTo),
        priceAfter: U2(Math.round(i.price * (1 - i.discount / 100) * 100) / 100),
        reason: 'Автоакция закончилась — цена возвращена к прежней',
        source: 'repricer-promo-restore',
        ok: true
      };
    });
    restoredItems.forEach((row) => delete pend[String(row.nmID)]);
    store.savePromoExits(pend);
    store.appendPriceHistory(restoredItems.map((i) => ({
      nmID: i.nmID, basePrice: i.price, discount: i.discount,
      sellerPrice: Math.round(i.price * (1 - i.discount / 100) * 100) / 100, source: 'promo-restore'
    })));
    store.appendPromoJournal(journalRows);
    notify('repricer', { type: 'promo-restored', count: restoredItems.length });
    return { restored: restoredItems.length, pending: Object.keys(pend).length, task: res.task && res.task.statusText };
  }

  function nextRunDate(cfg) {
    const s = cfg.schedule || {};
    const now = new Date();
    if (s.mode === 'interval') return new Date(now.getTime() + Math.max(5, Number(s.intervalMinutes) || 60) * 60000);
    if (s.mode === 'daily') {
      const d = new Date(now);
      d.setHours(Number(s.hourOfDay) || 9, 0, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
    return new Date(now.getTime() + 60 * 60000); // hourly
  }

  /** Остановить все будущие фоновые работы, включая отложенные разделы WB. */
  function stopScheduler() {
    if (sched.timer) clearInterval(sched.timer);
    sched.timer = null;
    sched.nextRunAt = null;
    for (const rec of Object.values(deferred)) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      if (rec.state === 'scheduled') rec.state = 'canceled';
    }
  }

  function isBusy() {
    return activeHandlers > 0 || backgroundJobs > 0 || sched.running || !!priceJobRunning ||
      Object.values(deferred).some((rec) => rec.state === 'running');
  }

  function dispose() { disposed = true; catalogEpoch++; catalogSnapshot = null; stopScheduler(); }

  function resetAfterRestore() {
    const configs = store.loadItemConfigs(); let changed = false;
    for (const value of Object.values(configs)) if (value.boost) { delete value.boostRuntime; value.boost = { ...value.boost, requiresRestart: true }; changed = true; }
    if (changed) store.saveItemConfigs(configs);
    stopScheduler();
    for (const key of Object.keys(deferred)) delete deferred[key];
    client = null; clientSignature = ''; demoApi = null;
    promoLifecycleReady = false; promoLifecycle = new Map(); lowStockNotified = new Set();
    invalidateAllCaches();
    applyScheduler();
  }

  function applyScheduler() {
    if (disposed) return { enabled: false };
    const cfg = repricerCfg();
    if (sched.timer) { clearInterval(sched.timer); sched.timer = null; }
    if (!cfg.enabled) { sched.nextRunAt = null; return { enabled: false }; }

    sched.nextRunAt = nextRunDate(cfg);
    sched.timer = setInterval(async () => {
      if (disposed || backgroundJobs) return;
      backgroundJobs++;
      try {
        const c = repricerCfg();
        if (!c.enabled) return;
        const now = Date.now();

        /**
         * Фаза 2 — отправка. Предложение, сохранённое фазой 1, уходит в WB только когда
         * пришло его время (по умолчанию через 40 минут после расчёта) и включена автоотправка.
         * Перед отправкой цены перечитываются: если в кабинете что-то изменилось, предложение
         * помечается устаревшим и НЕ отправляется — старые данные не затираются.
         */
        const prop = store.loadProposals();
        if (c.schedule.autoSend && prop.phase === 'proposed' && prop.sendAt && new Date(prop.sendAt).getTime() <= now && !sched.running) {
          try {
            await sendProposal('repricer-auto');
          } catch (e) {
            notify('warn', { where: 'repricer', message: 'Автоотправка не выполнена: ' + (e.message || e) });
          }
        }

        // Фаза 1 — расчёт по расписанию
        if (sched.nextRunAt && Date.now() >= sched.nextRunAt.getTime()) {
          try {
            const res = await calcRepricer({ mode: 'auto', autoSend: !!c.schedule.autoSend });
            const wantJoin = !!c.promo.autoJoin;
            const wantExit = !!c.promo.autoExitAutoPromos || !!c.promo.autoExitManualPromos;
            if (c.schedule.autoSend && c.schedule.twoPhase === false && (wantJoin || wantExit)) {
              const rows = (res.results || []).filter((r) => r.promoChosen &&
                (r.promoChosen.type === 'exit' ? wantExit : wantJoin));
              if (rows.length) await applyPromoActions(rows, {});
            } else if (c.schedule.autoSend && c.schedule.twoPhase === false && c.promo.restorePriceAfterExit !== false) {
              await restorePromoExits();
            }
          } catch (e) {
            notify('warn', { where: 'repricer', message: e.message });
          }
          sched.nextRunAt = nextRunDate(c);
          notify('repricer', { type: 'scheduled', nextRunAt: sched.nextRunAt.toISOString() });
        }
      } finally { backgroundJobs--; }
    }, 20000);
    if (sched.timer.unref) sched.timer.unref();
    return { enabled: true, nextRunAt: sched.nextRunAt.toISOString() };
  }

  const priceChannels = new Set(['wb:apply-prices', 'wb:apply-size-prices', 'wb:promo-join', 'repricer:send', 'repricer:proposal-send', 'repricer:promo-apply', 'repricer:promo-exit', 'repricer:promo-restore']);
  const inputChannels = new Set(['keys:set', 'keys:clear', 'settings:save', 'settings:reset', 'costs:save', 'costs:import', 'costs:clear', 'repricer:save', 'repricer:item-configs:save', 'strategies:template', 'strategies:custom-save', 'data:refresh-all', 'backup:import', 'backup:restore', 'repricer:calc', 'repricer:competitors:save', 'promos:import-noms', 'promos:noms:save', 'promos:clear-noms']);
  // Счётчик включает и вложенные асинхронные вызовы обработчиков: удаление или
  // импорт не могут обогнать запрос WB, который ещё запишет результат в этот профиль.
  for (const [channel, fn] of Object.entries(handlers)) {
    handlers[channel] = async (...args) => {
      if (disposed) throw new WBError('Сервис кабинета остановлен.', { code: 'PROFILE_CLOSED' });
      if (priceJobRunning && priceJobContext.getStore() !== priceJobRunning && inputChannels.has(channel)) throw new WBError('Дождитесь окончания отправки WB. Локальные правки сохранены в очереди интерфейса.', { code: 'PRICE_BUSY' });
      activeHandlers++;
      try { return await (priceChannels.has(channel) ? priceJob(() => fn(...args)) : fn(...args)); }
      finally { activeHandlers--; }
    };
  }

  return {
    handlers, isDemo, getSettings, getClient, getDemo, cache,
    calcRepricer, sendPrices, applyScheduler, stopScheduler, dispose, isBusy,
    sched, repricerCfg, priceWatcher
  };
}


/**
 * Таблица из `readTable` (массив массивов, первая строка — заголовки) → строки-объекты
 * для `costs:import`. Заголовки оставляем как есть: обработчик ниже уже умеет читать
 * и английские поля, и русские подписи из шаблона.
 */
function costsRowsFromTable(table) {
  const raw = (table && table.rows) || [];
  const rows = raw.filter((r) => Array.isArray(r) && r.some((c) => String(c === undefined || c === null ? '' : c).trim() !== ''));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => String(h === undefined || h === null ? '' : h).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    header.forEach((h, k) => {
      if (h) obj[h] = rows[i][k];
    });
    if (Object.keys(obj).length) out.push(obj);
  }
  return out;
}

module.exports = { createService, maskKey, daysAgoIso };
