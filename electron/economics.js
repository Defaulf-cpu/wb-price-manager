/**
 * Модуль юнит-экономики. Работает и в Node (Electron main / dev-сервер),
 * и в браузере как window.EC — расчёты в интерфейсе и на сервере идентичны.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EC = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
'use strict';

/**
 * Юнит-экономика Wildberries.
 *
 * Модель расчёта (по умолчанию — схема «Маркетплейс»):
 *   basePrice          — цена до скидки продавца («зачёркнутая» цена в карточке)
 *   discountPct        — скидка продавца
 *   sellerPrice        — цена после скидки продавца  = basePrice * (1 - discount/100)
 *                        именно эта цена попадает в отчёт реализации как ppvz_for_pay
 *   sppPct             — скидка постоянного покупателя (СПП). Ею управляет WB,
 *                        она компенсируется площадкой и НЕ вычитается из выплаты продавцу.
 *   buyerPrice         — сколько фактически платит покупатель = sellerPrice * (1 - spp/100)
 *
 *   Выплата продавца = sellerPrice
 *                      - комиссия WB (%)
 *                      - эквайринг (%)
 *                      - налог (% от выручки)
 *                      - реклама (% от выручки)
 *                      - логистика (фикс + за объём, ₽/шт)
 *                      - приёмка (₽/шт)
 *                      - хранение (₽/шт)
 *                      - упаковка (₽/шт)
 *                      - себестоимость (₽/шт)
 *
 * Прибыль считается «на руки» — после налога.
 */

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function round(v, digits = 2) {
  const k = Math.pow(10, digits);
  return Math.round((num(v) + Number.EPSILON) * k) / k;
}

const TAX_MODES = [
  { id: 'usn6', label: 'УСН «Доходы» 6%', rate: 6 },
  { id: 'usn15', label: 'УСН «Доходы − расходы» 15%', rate: 15 },
  { id: 'nds20', label: 'ОСНО / НДС 20%', rate: 20 },
  { id: 'selfemployed', label: 'Самозанятый 4–6%', rate: 4 },
  { id: 'none', label: 'Без налога', rate: 0 }
];

function taxModeLabel(id) {
  const m = TAX_MODES.find((t) => t.id === id);
  return m ? m.label : id;
}

/**
 * Собирает эффективные параметры товара из глобальных настроек,
 * справочника категорий и персональных overrides (себестоимость и т.п.).
 *
 * Приоритет источника каждого расхода:
 *   1) ручное значение по товару (раздел «Себестоимость») — всегда побеждает;
 *   2) ФАКТ из отчёта о реализации WB (среднее за окно, по умолчанию 7 дней) —
 *      логистика, комиссия, хранение, приёмка, эквайринг;
 *   3) справочник категории → 4) общие настройки → 5) формула по объёму.
 *
 * @param {object} [facts] фактические расходы по товару из store.loadFactCosts()
 */
function resolveParams(settings, item, overrides, facts) {
  const s = settings || {};
  const o = overrides || {};
  const cat = (item && item.categoryName) || '';
  const catDef = (s.categoryDefaults && s.categoryDefaults[cat]) || {};

  const pickNum = (val, ...fallbacks) => {
    if (val !== undefined && val !== null && val !== '' && Number.isFinite(Number(val))) return Number(val);
    for (const f of fallbacks) {
      if (f !== undefined && f !== null && f !== '' && Number.isFinite(Number(f))) return Number(f);
    }
    return 0;
  };

  const taxMode = o.taxMode && o.taxMode !== 'inherit' ? o.taxMode
    : (catDef.taxMode && catDef.taxMode !== 'inherit' ? catDef.taxMode : (s.taxMode || 'usn6'));

  // ── фактические расходы из отчёта о реализации WB ──
  const f = isPlainObject(facts) ? facts : {};
  const useFacts = s.useFactCosts !== false && Number(f.salesQty || 0) > 0;
  /** факт учитываем, только если он положительный и включён в настройках */
  const fact = (v) => (useFacts && Number(v) > 0 ? Number(v) : undefined);

  const src = {};
  /**
   * Отмечает источник значения. `watchVal` — наблюдение витрины WB (модуль price-watcher);
   * он передаётся только для тех полей, где витрина вообще что-то знает (сейчас — СПП),
   * поэтому стоит последним аргументом и у остальных полей остаётся undefined.
   */
  const pickSrc = (name, manual, factVal, catVal, defVal, watchVal) => {
    if (manual !== undefined && manual !== null && manual !== '' && Number.isFinite(Number(manual))) src[name] = 'manual';
    else if (watchVal !== undefined) src[name] = 'watch';
    else if (factVal !== undefined) src[name] = 'fact';
    else if (catVal !== undefined && catVal !== null && catVal !== '' && Number.isFinite(Number(catVal))) src[name] = 'category';
    else if (defVal !== undefined && defVal !== null && defVal !== '' && Number.isFinite(Number(defVal))) src[name] = 'settings';
    else src[name] = name === 'logisticsRub' ? 'formula' : 'none';
    return src[name];
  };

  const factCommissionPct = fact(f.commissionPctAvg);
  const factLogistics = fact(f.logisticsAvg);
  const factStorage = fact(f.storageAvg);
  const factAcceptance = fact(f.acceptanceAvg);
  const factAcquiringPct = fact(f.acquiringPctAvg);
  /**
   * Средний СПП по фактическим продажам: в каждой строке статистики WB есть поле `spp`,
   * и сервис агрегирует его в `avgSppPct`. Это реальные цифры по вашему кабинету —
   * точнее, чем общая настройка `sppDefault`, и не требует смотреть витрину глазами.
   *
   * Намеренно НЕ зависит от переключателя «брать расходы из отчёта WB»: тот переключатель
   * про логистику, комиссию, хранение, приёмку и эквайринг из финансового отчёта,
   * а СПП приходит из статистики продаж — это другой источник.
   */
  const factSppPct = Number(f.sppPctAvg) > 0 ? Number(f.sppPctAvg) : undefined;

  /**
   * СПП по наблюдению витрины WB (модуль price-watcher): медиана за 7 дней.
   * Это самая свежая цифра — то, что покупатель реально видит на карточке прямо сейчас,
   * поэтому стоит выше среднего по статистике продаж (там окно длиннее и цифра запаздывает).
   * Ноль здесь — осмысленное значение (витрина показывает товар без СПП), поэтому
   * принимаем любое конечное число от 0 до 100, а «нет наблюдений» отличаем по null.
   */
  const watchSppPct = (function () {
    const v = f.sppPctWatch;
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
  })();

  return {
    categoryName: cat,
    brand: (item && item.brand) || o.brand || '',
    basePrice: pickNum(o.basePrice, item && item.price),
    discountPct: pickNum(o.discountPct, item && item.discount),
    // приоритет СПП: ручной ввод → наблюдение витрины WB → факт по продажам WB → значение в карточке → общая настройка
    sppPct: pickNum(o.sppPct, watchSppPct, factSppPct, item && item.sppPct, s.sppDefault),
    // что именно увидели на витрине (null — наблюдений нет) и сколько замеров легло в медиану
    sppPctWatch: watchSppPct === undefined ? null : watchSppPct,
    sppWatchSamples: Number(f.sppWatchSamples || 0),
    sppWatchAt: f.sppWatchAt || '',
    commissionPct: pickNum(o.commissionPct, factCommissionPct, catDef.commissionPct, s.commissionDefault),
    logisticsRub: pickNum(o.logisticsRub, factLogistics),
    acceptRub: pickNum(o.acceptRub, factAcceptance, s.acceptRub),
    storageRub: pickNum(o.storageRub, factStorage, s.storageRubPerUnit),
    packagingRub: pickNum(o.packagingRub, catDef.packagingRub, s.packagingRub),
    costPriceRub: pickNum(o.costPriceRub),
    adRub: pickNum(o.adRub),
    taxMode,
    taxRatePct: pickNum(o.taxRatePct, s.taxRate, (TAX_MODES.find((t) => t.id === taxMode) || {}).rate),
    acquiringPct: pickNum(o.acquiringPct, factAcquiringPct, s.acquiringPct),
    adPct: pickNum(o.adPct, catDef.adPct, s.adPctDefault),
    volumeLiters: pickNum(o.volumeLiters, item && item.volumeLiters),
    targetMarginPct: pickNum(o.targetMarginPct, s.targetMarginPct, 0),
    minMarginPctAlert: pickNum(s.minMarginPctAlert, 10),
    model: o.model || s.model || 'marketplace',
    /**
     * Объёмные тарифы логистики: своя сумма в товаре → тариф категории → общие настройки.
     * Категорийные тарифы раньше игнорировались, и для «Обуви» при 2 л считался глобальный
     * тариф (60 ₽ вместо 90 ₽), а порог и крупный тариф категории не применялись вовсе.
     */
    logisticsBaseRub: pickNum(o.logisticsBaseRub, catDef.logisticsBaseRub, s.logisticsBaseRub),
    logisticsPerLiterRub: pickNum(o.logisticsPerLiterRub, catDef.logisticsPerLiterRub, s.logisticsPerLiterRub),
    literThreshold: pickNum(o.literThreshold, catDef.literThreshold, s.literThreshold, 5),
    logisticsLargeRub: pickNum(o.logisticsLargeRub, catDef.logisticsLargeRub, s.logisticsLargeRub),

    // откуда взялось каждое значение — показываем в интерфейсе подписью
    factCosts: useFacts ? {
      salesQty: Number(f.salesQty || 0),
      returnsQty: Number(f.returnsQty || 0),
      windowDays: Number(f.windowDays || 0),
      updatedAt: f.updatedAt || '',
      logisticsAvg: Number(f.logisticsAvg || 0),
      commissionPctAvg: Number(f.commissionPctAvg || 0),
      storageAvg: Number(f.storageAvg || 0),
      acceptanceAvg: Number(f.acceptanceAvg || 0),
      acquiringPctAvg: Number(f.acquiringPctAvg || 0),
      returnSharePct: Number(f.returnSharePct || 0)
    } : null,
    costSources: (function () {
      pickSrc('commissionPct', o.commissionPct, factCommissionPct, catDef.commissionPct, s.commissionDefault);
      pickSrc('logisticsRub', o.logisticsRub, factLogistics, undefined, undefined);
      pickSrc('storageRub', o.storageRub, factStorage, undefined, s.storageRubPerUnit);
      pickSrc('acceptRub', o.acceptRub, factAcceptance, undefined, s.acceptRub);
      pickSrc('acquiringPct', o.acquiringPct, factAcquiringPct, undefined, s.acquiringPct);
      pickSrc('costPriceRub', o.costPriceRub, undefined, undefined, undefined);
      pickSrc('sppPct', o.sppPct, factSppPct, item && item.sppPct, s.sppDefault, watchSppPct);
      return src;
    })()
  };
}

/** Простая проверка «обычный объект». */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Факт из отчёта WB важнее демо-значений, но не важнее ручных настроек пользователя.
 * Если overrides пришли из демо-набора (source !== 'user'), убираем из них те расходы,
 * которые есть в фактических данных — тогда расчёт пойдёт по факту.
 *
 * @param {object} overrides значения по товару (из costs.json или демо-набора)
 * @param {object} facts фактические расходы из отчёта о реализации
 * @param {object} settings настройки приложения
 * @returns {object} копия overrides без перекрытых фактом полей
 */
function preferFacts(overrides, facts, settings) {
  const o = overrides || {};
  if (!facts || !(Number(facts.salesQty) > 0)) return o;
  if (settings && settings.useFactCosts === false) return o;
  if (o.source === 'user') return o;
  const out = Object.assign({}, o);
  const drop = (key, factVal) => { if (Number(factVal) > 0) delete out[key]; };
  drop('commissionPct', facts.commissionPctAvg);
  drop('logisticsRub', facts.logisticsAvg);
  drop('storageRub', facts.storageAvg);
  drop('acceptRub', facts.acceptanceAvg);
  drop('acquiringPct', facts.acquiringPctAvg);
  return out;
}

/** Логистика по объёму товара (если не задана фиксированная сумма). */
function calcLogistics(p) {
  if (p.logisticsRub > 0) return round(p.logisticsRub);
  const v = p.volumeLiters;
  if (!v || v <= 0) return round(p.logisticsBaseRub);
  if (v > p.literThreshold) return round(p.logisticsLargeRub);
  return round(p.logisticsBaseRub + Math.max(0, v - 1) * p.logisticsPerLiterRub);
}

/**
 * Полный расчёт экономики для итоговой цены (после скидки продавца).
 * @param {number} sellerPrice цена, по которой товар продаётся (до СПП)
 * @param {object} p параметры из resolveParams()
 */
function calcUnit(sellerPrice, p) {
  const revenue = Math.max(0, num(sellerPrice));

  const commission = revenue * (p.commissionPct / 100);
  const acquiring = revenue * (p.acquiringPct / 100);
  const tax = revenue * (p.taxRatePct / 100);
  const adPctSum = revenue * (p.adPct / 100);
  const ad = adPctSum + p.adRub;
  const logistics = calcLogistics(p);
  const accept = p.acceptRub;
  const storage = p.storageRub;
  const packaging = p.packagingRub;
  const cogs = p.costPriceRub;

  const wbTotal = commission + acquiring + logistics + accept + storage;
  const fixedCosts = logistics + accept + storage + packaging + cogs + p.adRub;
  const pctCosts = p.commissionPct + p.acquiringPct + p.taxRatePct + p.adPct;

  const profitGross = revenue - wbTotal - ad - packaging - cogs - tax; // = profit (налог уже внутри)
  const profitBeforeTax = revenue - wbTotal - ad - packaging - cogs;
  const profit = profitGross;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
  const markupPct = cogs > 0 ? (profit / cogs) * 100 : 0;
  const buyerPrice = revenue * (1 - p.sppPct / 100);

  return {
    revenue: round(revenue),
    buyerPrice: round(buyerPrice),
    commission: round(commission),
    acquiring: round(acquiring),
    logistics: round(logistics),
    accept: round(accept),
    storage: round(storage),
    packaging: round(packaging),
    cogs: round(cogs),
    ad: round(ad),
    adPctSum: round(adPctSum),
    tax: round(tax),
    wbTotal: round(wbTotal),
    totalCosts: round(wbTotal + ad + packaging + cogs + tax),
    fixedCosts: round(fixedCosts),
    pctCosts: round(pctCosts),
    profitBeforeTax: round(profitBeforeTax),
    profit: round(profit),
    marginPct: round(marginPct, 1),
    markupPct: round(markupPct, 1),
    // Пороговые цены
    breakEvenPrice: calcBreakEvenPrice(p),
    minPriceForMargin: calcPriceForMarginPct(p, p.targetMarginPct || 0),
    sppPct: p.sppPct
  };
}

/** Цена безубыточности (прибыль = 0). */
function calcBreakEvenPrice(p) {
  const denom = 1 - (p.commissionPct + p.acquiringPct + p.taxRatePct + p.adPct) / 100;
  if (denom <= 0) return null;
  const fixed = calcLogistics(p) + p.acceptRub + p.storageRub + p.packagingRub + p.costPriceRub + p.adRub;
  return round(fixed / denom);
}

/** Цена, при которой маржинальность (прибыль/выручка) равна targetPct. */
function calcPriceForMarginPct(p, targetPct) {
  const denom = 1 - (p.commissionPct + p.acquiringPct + p.taxRatePct + p.adPct + num(targetPct)) / 100;
  if (denom <= 0) return null;
  const fixed = calcLogistics(p) + p.acceptRub + p.storageRub + p.packagingRub + p.costPriceRub + p.adRub;
  return round(fixed / denom);
}

/** Цена, при которой прибыль на единицу равна targetRub. */
function calcPriceForProfitRub(p, targetRub) {
  const denom = 1 - (p.commissionPct + p.acquiringPct + p.taxRatePct + p.adPct) / 100;
  if (denom <= 0) return null;
  const fixed = calcLogistics(p) + p.acceptRub + p.storageRub + p.packagingRub + p.costPriceRub + p.adRub;
  return round((fixed + num(targetRub)) / denom);
}

/**
 * Расчёт для товара целиком: текущая цена + целевая цена.
 * @param {object} settings глобальные настройки
 * @param {object} item товар из API/демо-набора
 * @param {object} overrides персональные значения (себестоимость и др.)
 * @param {object} [target] { basePrice?, discountPct? } — для сравнения «до/после»
 */
function analyze(settings, item, overrides, target, facts) {
  const p = resolveParams(settings, item, overrides, facts);
  const basePrice = num(p.basePrice);
  const discountPct = num(p.discountPct);
  const sellerPrice = basePrice * (1 - discountPct / 100);
  const current = calcUnit(sellerPrice, p);

  let next = null;
  if (target && (target.basePrice !== undefined || target.discountPct !== undefined)) {
    const tBase = num(target.basePrice, basePrice);
    const tDisc = num(target.discountPct, discountPct);
    const tParams = Object.assign({}, p, { basePrice: tBase, discountPct: tDisc });
    next = calcUnit(tBase * (1 - tDisc / 100), tParams);
    next.basePrice = round(tBase);
    next.discountPct = round(tDisc, 1);
    next.deltaProfit = round(next.profit - current.profit);
    next.deltaMarginPct = round(next.marginPct - current.marginPct, 1);
    next.priceChangePct = current.revenue > 0 ? round(((next.revenue - current.revenue) / current.revenue) * 100, 1) : 0;
  }

  const params = Object.assign({}, p, {
    basePrice: round(basePrice),
    discountPct: round(discountPct, 1),
    sellerPrice: round(sellerPrice),
    targetMarginPct: num(settings && settings.targetMarginPct),
    minMarginPctAlert: num(settings && settings.minMarginPctAlert)
  });

  // Минимальная базовая цена при текущей скидке, чтобы выдержать целевую маржу
  const minSellerForMargin = calcPriceForMarginPct(p, params.targetMarginPct);
  const minBaseForMargin = discountPct < 100 ? round(minSellerForMargin === null ? null : minSellerForMargin / (1 - discountPct / 100)) : null;
  const minBaseBreakEven = discountPct < 100 ? round(current.breakEvenPrice === null ? null : current.breakEvenPrice / (1 - discountPct / 100)) : null;

  // Карантин цен WB: если новая цена со скидкой минимум в 3 раза ниже прежней — цена не применится.
  const quarantineRisk = !!(settings && settings.quarantineGuard !== false) && next
    ? next.revenue > 0 && current.revenue > 0 && next.revenue < current.revenue / 3
    : false;

  const flags = [];
  if (!p.costPriceRub) flags.push('no-cogs');
  if (current.profit < 0) flags.push('loss');
  else if (current.marginPct < params.minMarginPctAlert) flags.push('low-margin');
  if (next && next.profit < 0) flags.push('target-loss');
  if (next && next.marginPct < params.minMarginPctAlert && next.profit >= 0) flags.push('target-low-margin');
  if (quarantineRisk) flags.push('quarantine');
  if (params.targetMarginPct && next && next.marginPct < params.targetMarginPct) flags.push('below-target');

  return {
    nmID: item && item.nmID,
    vendorCode: (item && item.vendorCode) || '',
    brand: params.brand,
    categoryName: params.categoryName,
    params,
    current,
    next,
    minSellerForMargin: minSellerForMargin === null ? null : round(minSellerForMargin),
    minBaseForMargin,
    minBaseBreakEven,
    quarantineRisk,
    flags
  };
}

/**
 * Проверка участия в акции: хватает ли скидки товара для входа и не убьёт ли акция маржу.
 * @param {object} settings
 * @param {object} item
 * @param {object} overrides
 * @param {object} promo { requiredDiscountPct, plannedDiscountPct }
 */
function analyzePromo(settings, item, overrides, promo, facts) {
  const req = num(promo && promo.requiredDiscountPct);
  const p = resolveParams(settings, item, overrides, facts);
  const curDisc = num(p.discountPct);
  const promoDisc = Math.max(req, curDisc);
  const res = analyze(settings, item, overrides, { discountPct: promoDisc }, facts);
  const eligible = curDisc + 1e-9 >= req;
  return Object.assign(res, {
    requiredDiscountPct: req,
    promoDiscountPct: round(promoDisc, 1),
    discountGapPct: round(Math.max(0, req - curDisc), 1),
    eligible,
    profitableInPromo: res.next ? res.next.profit >= 0 : res.current.profit >= 0,
    meetsTargetInPromo: res.next ? res.next.marginPct >= num(settings && settings.targetMarginPct) : false
  });
}

/**
 * Обратная задача: какую базовую цену поставить, чтобы после скидки X
 * итоговая цена была не ниже targetSellerPrice.
 */
function basePriceFor(discountPct, targetSellerPrice) {
  const d = num(discountPct);
  if (d >= 100) return null;
  return round(num(targetSellerPrice) / (1 - d / 100));
}

/**
 * Массовое изменение цен: применяет правило к товару и возвращает новые значения.
 * rule: { type: 'set-price'|'set-discount'|'delta-price'|'delta-pct'|'set-target-margin'|'set-profit',
 *         value, roundTo, minPrice, maxPrice }
 */
function applyRule(settings, item, overrides, rule, facts) {
  const p = resolveParams(settings, item, overrides, facts);
  const base = num(p.basePrice);
  const disc = num(p.discountPct);
  const seller = base * (1 - disc / 100);
  const r = rule || {};
  const v = num(r.value);
  let newBase = base;
  let newDisc = disc;

  const roundTo = (x) => {
    const step = num(r.roundTo, 0);
    if (step > 0) return Math.round(x / step) * step;
    return Math.round(x);
  };

  switch (r.type) {
    case 'set-price': // установить итоговую цену (скидка пересчитывается)
      newBase = base;
      newDisc = base > 0 ? round((1 - v / base) * 100, 1) : disc;
      break;
    case 'set-discount':
      newDisc = round(v, 1);
      break;
    case 'delta-discount': // +/- процентных пунктов к скидке
      newDisc = round(disc + v, 1);
      break;
    case 'delta-price': // +/- ₽ к итоговой цене
      newDisc = base > 0 ? round((1 - (seller + v) / base) * 100, 1) : disc;
      break;
    case 'delta-pct': // +/- % к итоговой цене
      newDisc = base > 0 ? round((1 - (seller * (1 + v / 100)) / base) * 100, 1) : disc;
      break;
    case 'set-base': // установить базовую цену
      newBase = roundTo(v);
      break;
    case 'set-target-margin': { // цена под целевую маржу
      const target = calcPriceForMarginPct(p, v);
      if (target === null) return null;
      newDisc = base > 0 ? round((1 - target / base) * 100, 1) : disc;
      break;
    }
    case 'set-profit': {
      const target = calcPriceForProfitRub(p, v);
      if (target === null) return null;
      newDisc = base > 0 ? round((1 - target / base) * 100, 1) : disc;
      break;
    }
    default:
      return null;
  }

  if (r.type === 'set-base') newBase = roundTo(newBase);

  newDisc = Math.max(0, Math.min(95, newDisc));
  newBase = Math.max(1, newBase);

  let newSeller = roundTo(newBase * (1 - newDisc / 100));
  if (num(r.minPrice) > 0) newSeller = Math.max(newSeller, num(r.minPrice));
  if (num(r.maxPrice) > 0) newSeller = Math.min(newSeller, num(r.maxPrice));
  if (r.type !== 'set-base' && newBase > 0) {
    newDisc = Math.max(0, Math.min(95, round((1 - newSeller / newBase) * 100, 1)));
  }

  const analysis = analyze(settings, item, overrides, { basePrice: newBase, discountPct: newDisc }, facts);
  return {
    basePrice: round(newBase),
    discountPct: round(newDisc, 1),
    sellerPrice: round(analysis.next ? analysis.next.revenue : newSeller),
    analysis
  };
}

return {
  TAX_MODES,
  taxModeLabel,
  num,
  round,
  resolveParams,
  calcLogistics,
  calcUnit,
  calcBreakEvenPrice,
  calcPriceForMarginPct,
  calcPriceForProfitRub,
  analyze,
  analyzePromo,
  preferFacts,
  applyRule,
  basePriceFor
};

});
