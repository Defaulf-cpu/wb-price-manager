'use strict';

/**
 * Централизованное состояние приложения + подготовленные данные для таблиц.
 */
window.S = (function () {

  function initialState() { return {
    appState: null,
    settings: null,
    items: [],           // товары из WB / демо
    overrides: {},       // nmID → себестоимость и расходы (пользовательские или демо)
    priceEdits: new Map(), // nmID → { basePrice, discount } — ручной ввод цен (переживает перерисовки)
    priceDrafts: {},       // nmID → { basePrice, discount, sellerPrice, note, savedAt } — сохранено БЕЗ отправки в WB
    stats: [],           // nmID → продажи/заказы за 30 дней
    statsByNm: {},
    facts: {},           // nmID → фактические расходы из отчёта о реализации WB
    factsMeta: null,
    cards: [],
    promos: [],
    costs: {},           // сохранённые пользовательские значения
    tasks: [],
    view: 'dashboard',
    loading: false,
    demo: true,
    selection: new Set(),
    filters: { q: '', category: '', brand: '', flag: 'all' },
    sort: { key: 'profit', dir: 'asc' },
    // По умолчанию правило ВЫКЛЮЧЕНО: массовая переценка должна быть осознанным действием.
    // Раньше здесь стояло «−5% к итоговой цене», и это значение молча пересчитывало
    // каждую строку при отправке — введённые вручную цены «не сохранялись».
    priceRule: { type: 'none', value: 0, roundTo: 0, minPrice: 0 },
    promoSelected: null,
    promoRows: [],
    promoTab: 'candidates',
    statsMeta: null,       // когда и как загружена статистика (страницы, заказы, лимиты WB)
    deferred: []           // разделы, которые дозагружаются в фоне из-за лимита WB
  }; }
  const state = initialState();

  function resetProfile() {
    const view = state.view;
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, initialState(), { view });
    invalidate();
  }

  let EC = null;

  function setEconomics(module) { EC = module; }

  async function loadAppState() {
    const info = await API.invoke('app:state');
    const changed = state.dataContext && info.dataContext && state.dataContext !== info.dataContext;
    if (changed) {
      API.invalidateProfile();
      Object.assign(state, { items: [], overrides: {}, stats: [], statsByNm: {}, facts: {}, cards: [], promos: [], costs: {}, priceDrafts: {}, priceEdits: new Map(), selection: new Set() });
      invalidateProductViews(true);
    }
    state.dataContext = info.dataContext || state.dataContext;
    state.appState = info;
    state.settings = state.appState.settings;
    state.demo = state.appState.demo;
    // когда данные в последний раз выгружались из кабинета WB и какие разделы покрыты ключами
    state.lastDataRefreshAt = state.appState.lastDataRefreshAt || null;
    state.keyCoverage = state.appState.coverage || null;
    state.statsMeta = state.appState.statsMeta || null;
    state.deferred = state.appState.deferred || [];
    state.costs = (await API.invoke('costs:get')).items || {};
    return state.appState;
  }

  function invalidateProductViews(clearEdits) {
    const rp = window.Views && Views.repricer;
    if (rp) {
      rp.results = []; rp.summary = null; rp._drawTicket = (rp._drawTicket || 0) + 1;
      if (clearEdits) { if (rp._autoSaveTimer) clearTimeout(rp._autoSaveTimer); rp.pendingEdits.clear(); rp.selection = new Set(); rp.rstate = null; }
    }
    invalidate();
  }

  async function loadGoods(force) {
    state.loading = true;
    try {
      const res = await API.invoke('wb:goods', { force: !!force });
      if (state.dataContext && res.dataContext && state.dataContext !== res.dataContext) throw new Error('Режим данных изменился — обновите кабинет.');
      if (state.appState && state.appState.demo === false && res.demo === true) {
        throw new Error('Сервис вернул демо-товары, хотя демо-режим выключен и выбран кабинет WB. Товары не показаны, чтобы не смешать кабинеты. Нажмите «Обновить данные из WB» ещё раз; если ошибка повторится, пересохраните ключи в настройках.');
      }
      invalidateProductViews(false);
      state.goodsRevision = (state.goodsRevision || 0) + 1;
      state.items = res.items || [];
      state.overrides = res.overrides || {};
      state.stats = res.stats || [];
      // WB отдаёт «Статистику» одним запросом в минуту: продажи и заказы приезжают раздельно,
      // поэтому разделы должны знать, что заказы ещё в пути (ordersPending) или что страницы обрезаны.
      if (res.statsMeta) state.statsMeta = res.statsMeta;
      state.statsByNm = {};
      state.stats.forEach((s) => { state.statsByNm[String(s.nmID)] = s; });
      state.facts = res.facts || {};
      state.settings = res.settings || state.settings;
      state.demo = res.demo;
      state.goodsLoadedAt = res.fromCache ? res.cachedAt : new Date().toISOString();
      state.goodsSource = res.source;
      /**
       * Черновики грузим вместе с товарами: сохранённая вручную цена должна применяться
       * к экономике сразу во всех разделах, а не только там, где её ввели.
       */
      await loadDrafts();
      return res;
    } finally {
      state.loading = false;
    }
  }

  async function loadPromos() {
    state.promos = await API.invoke('wb:promos', { days: 60 });
    return state.promos;
  }

  async function saveSettings(patch) {
    state.settings = await API.invoke('settings:save', patch);
    return state.settings;
  }

  /** Фактические расходы из отчёта о реализации WB (логистика, комиссия, хранение, эквайринг). */
  async function loadFacts(opts) {
    const res = await API.invoke('facts:load', opts || {});
    const got = await API.invoke('facts:get');
    state.facts = got.items || {};
    state.factsMeta = got.meta || null;
    invalidate();
    return res;
  }

  async function refreshFacts() {
    const got = await API.invoke('facts:get');
    state.facts = got.items || {};
    state.factsMeta = got.meta || null;
    return got;
  }

  /**
   * Разделы, которые WB не отдал сразу из-за лимита (1 запрос в минуту на
   * «Статистику» и «Финансы») и которые приложение догружает в фоне.
   */
  async function loadDeferred() {
    try {
      const res = await API.invoke('data:deferred');
      state.deferred = (res && res.items) || [];
    } catch (e) {
      state.deferred = [];
    }
    return state.deferred;
  }

  /** Что известно о статистике продаж: сколько строк, когда загружена, ждут ли заказы. */
  async function loadStatsState() {
    try {
      const res = await API.invoke('stats:state');
      state.statsMeta = (res && res.meta) || null;
      return res;
    } catch (e) {
      return null;
    }
  }

  /**
   * Перечитать данные после фоновой догрузки раздела.
   * В WB при этом не идём: товары/статистика/расходы берутся из кэша сервиса.
   */
  async function reloadAfterDeferred(name) {
    if (name === 'facts') await refreshFacts();
    await loadGoods(false);
    await loadStatsState();
    await loadDeferred();
    invalidate();
    return true;
  }

  /**
   * Перечитать overrides (себестоимость/расходы) с сервера без похода в WB.
   * Таблица «Цены и скидки» строится именно из overrides, а не из state.costs,
   * поэтому после сохранения себестоимости их обязательно нужно обновить —
   * иначе введённое значение не появлялось в «Ценах» до полной перезагрузки товаров.
   */
  /**
   * Черновики цен — сохранённые вручную цены, которые ещё НЕ отправлены в WB.
   * Грузятся в общее состояние, потому что применяться должны во всех разделах
   * («Цены и скидки», «Экономика», «Репрайсер», «Отчёты», карточка товара),
   * а не только там, где их ввели.
   */
  async function loadDrafts() {
    try {
      const res = await API.invoke('prices:draft-load');
      state.priceDrafts = (res && res.items) || {};
    } catch (e) {
      state.priceDrafts = state.priceDrafts || {};
    }
    invalidate();
    return state.priceDrafts;
  }

  async function reloadOverrides() {
    const res = await API.invoke('costs:overrides');
    if (res && res.overrides) state.overrides = res.overrides;
    invalidate();
    return res || {};
  }

  async function saveCosts(items) {
    const epoch = API.generation();
    await API.invoke('costs:save', { items });
    if (epoch !== API.generation()) throw new Error('Кабинет изменился во время сохранения.');
    state.costs = (await API.invoke('costs:get')).items || {};
    // себестоимость должна сразу доехать до «Цен и скидок» и до экономики
    await reloadOverrides();
  }

  /** Полный расчёт по товару (текущая цена + целевая, если задана). */
  function analyze(item, target) {
    const key = String(item.nmID);
    const ov = state.overrides[key] || {};
    return EC.analyze(state.settings, item, ov, target);
  }

  /**
   * Товар с учётом сохранённой вручную цены (черновика).
   *
   * Зачем: пользователь вводит цену в карточке товара или в «Цены и скидки», нажимает
   * «Сохранить» — и эта цена должна сразу стать ценой товара ВО ВСЕХ разделах
   * (экономика, репрайсер, отчёты), а не лежать мёртвым грузом до отправки в WB.
   * Цена маркетплейса при этом не теряется: она остаётся в `mpPrice`/`mpDiscount`,
   * чтобы интерфейс показывал «на МП сейчас» и «моя цена» раздельно.
   *
   * @returns {{item: object, draft: object|null}}
   */
  function withDraft(item) {
    const d = (state.priceDrafts || {})[String(item.nmID)];
    if (!d || !(Number(d.basePrice) > 0)) return { item, draft: null };
    return {
      item: Object.assign({}, item, {
        price: Number(d.basePrice),
        discount: Number(d.discount) || 0
      }),
      draft: d
    };
  }

  /** Строки для главной таблицы: товар + экономика + продажи. */
  function rows() {
    return state.items.map((rawItem) => {
      const key = String(rawItem.nmID);
      const eff = withDraft(rawItem);
      const item = eff.item;
      const draft = eff.draft;
      const rawOv = state.overrides[key] || {};
      const fact = state.facts[key] || null;
      // фактические расходы из отчёта WB важнее демо-значений, но не важнее ручных настроек
      const ov = EC.preferFacts(rawOv, fact, state.settings);
      const a = EC.analyze(state.settings, item, ov, undefined, fact);
      const st = state.statsByNm[key] || {};
      const stock = U.num(ov.stock, 0);
      const perDay = st.salesQty ? st.salesQty / 30 : U.num(ov.salesPerDay, 0);
      return {
        item,
        ov,
        a,
        c: a.current,
        p: a.params,
        nmID: item.nmID,
        vendorCode: item.vendorCode,
        brand: item.brand,
        category: item.categoryName,
        title: item.title || (item.brand + ' ' + item.vendorCode),
        basePrice: U.num(item.price),
        discount: U.num(item.discount),
        sellerPrice: a.current.revenue,
        buyerPrice: a.current.buyerPrice,
        // цена на маркетплейсе (из кабинета WB) — её нельзя терять, когда задана своя
        mpBasePrice: U.num(rawItem.price),
        mpDiscount: U.num(rawItem.discount),
        mpSellerPrice: Math.round(U.num(rawItem.price) * (1 - U.num(rawItem.discount) / 100) * 100) / 100,
        draft: draft || null,
        hasDraft: !!draft,
        spp: a.params.sppPct,
        commission: a.params.commissionPct,
        costPrice: a.params.costPriceRub,
        logistics: a.current.logistics,
        storage: a.current.storage,
        packaging: a.current.packaging,
        ad: a.current.ad,
        tax: a.current.tax,
        profit: a.current.profit,
        margin: a.current.marginPct,
        breakEven: a.current.breakEvenPrice,
        minPriceTarget: a.current.minPriceForMargin,
        minBaseTarget: a.minBaseForMargin,
        volume: U.num(ov.volumeLiters, item.volumeLiters),
        stock,
        sales30: U.num(st.salesQty, 0),
        perDay,
        turnoverDays: perDay > 0 ? Math.round(stock / perDay) : (stock > 0 ? 999 : 0),
        revenue30: U.num(st.salesSum, 0),
        profit30: a.current.profit * U.num(st.salesQty, 0),
        returns: U.num(st.returnsQty, 0),
        flags: a.flags,
        cogsSource: rawOv.source === 'user' ? 'user' : (rawOv.costPriceRub ? 'demo' : 'none'),
        factCosts: a.params.factCosts,
        costSources: a.params.costSources || {},
        factLogistics: fact ? fact.logisticsAvg : 0,
        factCommissionPct: fact ? fact.commissionPctAvg : 0,
        editableSizePrice: item.editableSizePrice,
        isBadTurnover: item.isBadTurnover,
        sizesCount: item.sizesCount
      };
    });
  }

  let cachedRows = null;
  let cachedStamp = -1;
  let stamp = 0;
  function invalidate() { cachedRows = null; stamp++; }

  function getRows(force) {
    if (force || !cachedRows || cachedStamp !== stamp) {
      cachedRows = rows();
      cachedStamp = stamp;
    }
    return cachedRows;
  }

  function categories() {
    const set = new Set(state.items.map((i) => i.categoryName).filter(Boolean));
    return Array.from(set).sort();
  }

  function brands() {
    const set = new Set(state.items.map((i) => i.brand).filter(Boolean));
    return Array.from(set).sort();
  }

  function filtered() {
    const f = state.filters;
    const q = (f.q || '').trim().toLowerCase();
    let list = getRows();
    if (f.category) list = list.filter((r) => r.category === f.category);
    if (f.brand) list = list.filter((r) => r.brand === f.brand);
    if (q) {
      list = list.filter((r) =>
        String(r.nmID).includes(q) ||
        String(r.vendorCode || '').toLowerCase().includes(q) ||
        String(r.title || '').toLowerCase().includes(q) ||
        String(r.brand || '').toLowerCase().includes(q));
    }
    switch (f.flag) {
      case 'loss': list = list.filter((r) => r.profit < 0); break;
      case 'low': list = list.filter((r) => r.profit >= 0 && r.margin < U.num(state.settings.minMarginPctAlert)); break;
      case 'ok': list = list.filter((r) => r.margin >= U.num(state.settings.targetMarginPct)); break;
      case 'nocogs': list = list.filter((r) => !r.costPrice); break;
      // эти флаги включаются кликом по сводной плитке: плитка работает как фильтр
      case 'revenue30': list = list.filter((r) => U.num(r.revenue30) > 0); break;
      case 'profit30': list = list.filter((r) => U.num(r.profit30) > 0); break;
      case 'profit30neg': list = list.filter((r) => U.num(r.profit30) < 0); break;
      case 'draft': list = list.filter((r) => !!(state.priceDrafts || {})[String(r.nmID)]); break;
      case 'promo': list = list.filter((r) => r.item.inPromo); break;
      case 'badturn': list = list.filter((r) => r.isBadTurnover || (r.turnoverDays > 90 && r.stock > 0)); break;
      case 'selected': list = list.filter((r) => state.selection.has(r.nmID)); break;
      default: break;
    }
    return list;
  }

  function selectedRows() {
    const set = state.selection;
    return getRows().filter((r) => set.has(r.nmID));
  }

  function totals(list) {
    const rowsList = list || getRows();
    const sales = U.sum(rowsList, (r) => r.sales30);
    const revenue = U.sum(rowsList, (r) => r.revenue30);
    const profitMonth = U.sum(rowsList, (r) => r.profit30);
    return {
      count: rowsList.length,
      revenue30: revenue,
      sales30: sales,
      profitPerUnit: U.sum(rowsList, (r) => r.profit),
      profit30: profitMonth,
      margin30: revenue > 0 ? (profitMonth / revenue) * 100 : 0,
      lossCount: rowsList.filter((r) => r.profit < 0).length,
      lowCount: rowsList.filter((r) => r.profit >= 0 && r.margin < U.num(state.settings.minMarginPctAlert)).length,
      noCogsCount: rowsList.filter((r) => !r.costPrice).length,
      stockValue: U.sum(rowsList, (r) => r.stock * r.costPrice),
      stockUnits: U.sum(rowsList, (r) => r.stock),
      avgMargin: rowsList.length ? U.sum(rowsList, (r) => r.margin) / rowsList.length : 0,
      avgDiscount: rowsList.length ? U.sum(rowsList, (r) => r.discount) / rowsList.length : 0,
      illiquidCount: rowsList.filter((r) => r.turnoverDays > 90 && r.stock > 0).length
    };
  }

  return {
    state, resetProfile, setEconomics, loadAppState, loadGoods, loadPromos, saveSettings, saveCosts,
    reloadOverrides, loadDrafts, loadFacts, refreshFacts, loadDeferred, loadStatsState,
    reloadAfterDeferred, analyze, rows, getRows, withDraft, invalidate, categories, brands,
    filtered, selectedRows, totals
  };
})();
