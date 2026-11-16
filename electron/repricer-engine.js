/**
 * Движок автоматического ценообразования (репрайсер).
 * Логика построена по принципу многоуровневого ценообразования:
 *
 *   1. Универсальная стратегия (низший приоритет) — считает целевую цену по своей логике.
 *   2. Верхнеуровневые ДЦО (высший приоритет) — защита от out-of-stock, повышение акционной
 *      цены, распродажа неликвида. Если сработало несколько — берётся МАКСИМАЛЬНАЯ цена.
 *   3. Красивая цена — применяется последней, только округляет итог.
 *
 * После этого цена загоняется в ценовой коридор (минимальная ↔ базовая) и ограничивается
 * шагом изменения за одно обновление и за сутки.
 *
 * Модуль работает и в Node (автоматический пересчёт в основном процессе), и в браузере
 * как window.RP — расчёты в интерфейсе и в планировщике идентичны.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RP = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
'use strict';

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (def === undefined ? 0 : def);
}

function r2(v) { return Math.round(num(v) * 100) / 100; }

/** Настройки репрайсера по умолчанию (аналог вкладки «Параметры»). */
const DEFAULT_CONFIG = {
  enabled: false,

  /** От чего считаем маржинальность: 'discounted' | 'forpay' | 'wallet' */
  marginMode: 'discounted',

  schedule: {
    mode: 'interval',           // interval | hourly | daily
    intervalMinutes: 40,        // как часто пересчитывать (фаза 1)
    hourOfDay: 9,
    autoSend: false,            // фаза 2: отправлять предложение в WB автоматически
    sendIntervalMinutes: 0,     // (устаревшее) — заменено sendDelayMinutes
    /**
     * Двухфазный цикл: фаза 1 только СЧИТАЕТ и показывает, что хочет поставить репрайсер,
     * фаза 2 (через sendDelayMinutes) отправляет это в WB. Пересчёт никогда не затирает
     * установленные цены — предложение хранится отдельно и отправляется осознанно.
     */
    twoPhase: true,
    sendDelayMinutes: 40
  },

  priceEdit: {
    canChangeBasePrice: 'allow',   // allow | forbid | ifNoOtherWay
    canCancelDiscount: false,      // может ли установить скидку 0%
    targetDiscountStep: 0,         // шаг изменения скидки при следовании к целевой скидке, п.п./час
    walletPct: 0                   // скидка WB-кошелька, %
  },

  limits: {
    maxChangePerUpdatePct: 19,     // рекомендуется 19% — иначе СБ WB может скрыть карточку
    maxChangePerDayPct: 0,         // 0 = не ограничивать
    ignoreStepIfBelowMin: true,    // игнорировать ограничение шага, если цена ниже минимального порога
    discountStepPct: 0,            // шаг изменения скидки при следовании к целевой
    blockQuarantine: true          // не отправлять цены, которые WB заблокирует (карантин)
  },

  promo: {
    useForecastSpp: true,          // считать решение по прогнозной СПП (иначе авто-вход выключен)
    ignoreChangeLimitOnEntry: false, // игнорировать лимит шага при входе в акцию
    autoExitAutoPromos: true,      // выходить из авто-акций WB, если участие убыточно
    autoExitManualPromos: false,   // выходить из обычных акций (тоже через повышение цены)
    autoJoin: false,               // автоматически вводить товары в акции по расписанию
    restorePriceAfterExit: true,   // вернуть цену, как только товар фактически вышел из акции
    // Автоакция WB подхватывает товар обратно, как только цена становится ниже плановой.
    // Поэтому после выхода из автоакции цена остаётся повышенной до её окончания.
    restoreAfterAutoPromoEnds: true,
    exitBufferPct: 2,              // запас выше плановой цены при выходе (на случай округлений)
    joinLeadDays: 45,              // как далеко вперёд смотрим календарь акций
    // Вход в акцию снижает прибыль с единицы, но обычно увеличивает продажи.
    // Точную эластичность WB API не отдаёт, поэтому считаем окупаемость по приросту:
    // «вход окупится, если продажи вырастут хотя бы на N%».
    expectedSalesUpliftPct: 30,    // ожидаемый прирост продаж в акции, %
    minMarginInPromoPct: null      // null = использовать целевую маржу товара/кабинета
  },

  defaults: {
    strategy: 'default',
    targetMarginPct: 20,
    minMarginPct: 0,
    allowNegativeMargin: false,
    oosProtection: true,
    targetTurnoverDays: 7,
    promoUpliftPct: 0,
    liquidationTurnoverDays: 60,
    liquidationDiscountPct: 0,
    beautifulPrice: { enabled: false, ending: 9, mode: 'nearest' },
    sppMode: 0                     // 0 — без СПП, 1 — с СПП, 2 — СПП + WB-кошелёк
  },

  /**
   * Режим цен по размерам (для товаров с `editableSizePrice`):
   *   'none'   — размеры не трогаться: цена уходит ценой товара целиком;
   *   'sync'   — все размеры товара получат цену товара;
   *   'manual' — цены размеров правятся вручную (только изменённые отправляются).
   */
  sizePriceMode: 'none',

  /** Пресеты стратегий для быстрого назначения. */
  presets: [
    { id: 0, name: 'Без стратегии (только пороги)', strategy: 'default' },
    { id: 1, name: 'Маржинальность', strategy: 'margin' },
    { id: 2, name: 'Конкурентный приоритет', strategy: 'competitor' },
    { id: 3, name: 'План-факт по заказам', strategy: 'planfact' },
    { id: 4, name: 'Оборачиваемость / распродажа', strategy: 'turnover' },
    { id: 5, name: 'Удержание РРЦ', strategy: 'rrp' },
    { id: 6, name: 'Максимум прибыли (AI-подбор)', strategy: 'ai' }
  ]
};

const STRATEGIES = [
  { id: 'default', name: 'По умолчанию', hint: 'Сравнивает минимальную цену, базовую, акционную и цену конкурента; если акция и конкурент внутри коридора — берёт наименьшую, иначе ставит базовую.' },
  { id: 'margin', name: 'Маржинальность', hint: 'Держит целевую маржинальность: считает минимальную цену под цель и не опускается ниже неё, при возможности поднимает цену.' },
  { id: 'competitor', name: 'Конкурентный приоритет', hint: 'Строго следует за ценой выбранного конкурента с отступом, но не выходит за ценовой коридор. Нет конкурента в наличии — включается стратегия «По умолчанию».' },
  { id: 'planfact', name: 'План-факт', hint: 'Продаём план месяца: отстаём от графика — снижаем цену, опережаем — повышаем (в пределах коридора).' },
  { id: 'turnover', name: 'Оборачиваемость', hint: 'Затоваривание — снижаем цену к минимальной; целевая оборачиваемость достигнута — повышаем.' },
  { id: 'rrp', name: 'Удержание РРЦ', hint: 'Не даёт цене для покупателя (с учётом СПП и кошелька) опуститься ниже рекомендованной розничной цены.' },
  { id: 'ai', name: 'AI-подбор цены', hint: 'Пошаговый поиск цены с максимальной прибылью в месяц: низкоскоростным товарам стимулирует спрос, остальным оптимизирует прибыль без падения темпа.' },
  { id: 'promo', name: 'Только акции', hint: 'Цена = акционная (плановая скидка акции), но не ниже минимального порога.' },
  { id: 'hold', name: 'Держать цену', hint: 'Ничего не меняет — только следит за порогами и предупреждает.' }
];

/**
 * «Красивая цена»: округление до шаблона (…9 / …90 / …99).
 * mode: nearest | down | up | maxdown | maxup
 */
function beautifulPrice(price, cfg, stepLimitRub) {
  const ending = num(cfg && cfg.ending, 9);
  const mode = (cfg && cfg.mode) || 'nearest';
  const p = num(price);
  if (p <= 0) return p;

  // Шаг сетки: для окончаний 90/99 на ценах от 1000 ₽ — 100 ₽, иначе 10 ₽
  const digits = String(ending).length;
  let step = 10;
  if (digits >= 2) step = p >= 1000 ? 100 : 10;
  if (p < 100) step = 10;

  const tail = ending % step;
  const candidates = [];
  const base = Math.floor(p / step) * step;
  for (let k = -2; k <= 2; k++) {
    const c = base + k * step + tail;
    if (c > 0) candidates.push(c);
  }

  // запас хода: 0 — округление запрещено (иначе лимит шага будет нарушен),
  // не задан — округляем свободно
  if (stepLimitRub !== undefined && stepLimitRub !== null && num(stepLimitRub) <= 0) return p;
  const limit = (stepLimitRub === undefined || stepLimitRub === null) ? Infinity : num(stepLimitRub);
  const allowed = candidates.filter((c) => Math.abs(c - p) <= limit);
  /**
   * Если ни один кандидат не укладывается в остаток лимита шага — цену не трогаем.
   * Раньше здесь был запасной путь «округлить до ближайшего кандидата», и репрайсер
   * менял цену сильнее, чем разрешает лимит за обновление: 1234 ₽ при запасе 4 ₽
   * превращались в 1229 ₽ (5 ₽ хода).
   */
  const pool = allowed;
  if (!pool.length) return p;

  switch (mode) {
    case 'down':
    case 'maxdown': {
      const below = pool.filter((c) => c <= p);
      if (!below.length) return p;
      return mode === 'maxdown' ? Math.min.apply(null, below) : below.reduce((a, b) => (Math.abs(a - p) <= Math.abs(b - p) ? a : b));
    }
    case 'up':
    case 'maxup': {
      const above = pool.filter((c) => c >= p);
      if (!above.length) return p;
      return mode === 'maxup' ? Math.max.apply(null, above) : above.reduce((a, b) => (Math.abs(a - p) <= Math.abs(b - p) ? a : b));
    }
    default:
      return pool.reduce((a, b) => (Math.abs(a - p) <= Math.abs(b - p) ? a : b));
  }
}

/**
 * Перевод целевой цены «для WB» в пару (базовая цена, скидка %).
 * Учитывает, может ли репрайсер менять цену до скидки и может ли обнулять скидку.
 */
/**
 * Пара «базовая цена + скидка», которая выводит товар из акции.
 *
 * Плановая цена акции = базовая цена × (1 − требуемая скидка), то есть она плавает
 * вместе с базовой ценой. Поэтому простое повышение цены товар из акции НЕ выводит —
 * выводит только скидка строго ниже порога акции.
 *
 * Порядок выбора (как в настройке «может менять цену до скидки»):
 *  1) если выход достижим при текущей базовой цене и в пределах лимита шага — базу не трогаем;
 *  2) иначе снижаем базовую цену, чтобы покупательская цена не прыгала (базу НЕ завышаем);
 *  3) если менять базовую цену запрещено — выходим при текущей базе, даже с большим скачком.
 *
 * @param {number} basePrice   текущая базовая цена
 * @param {number} requiredPct требуемая скидка акции (порог участия)
 * @param {number} wanted      желаемая цена для покупателя
 * @param {object} rules       { canChangeBasePrice, canCancelDiscount, stepLimitPct, curSeller }
 */
function exitPairForPromo(basePrice, requiredPct, wanted, rules) {
  const R = rules || {};
  const mode = R.canChangeBasePrice || 'allow';
  const canZero = R.canCancelDiscount === undefined ? true : !!R.canCancelDiscount;
  const base = Math.max(1, Math.round(num(basePrice)));
  const target = Math.max(1, num(wanted));
  const req = num(requiredPct);
  const minDisc = canZero ? 0 : 1;
  const sellerAt = (b, d) => r2(b * (1 - d / 100));

  // скидка обязана быть строго ниже порога акции
  let maxDiscount = Math.min(95, Math.floor(req) - 1);
  let impossible = false;
  if (maxDiscount < minDisc) { maxDiscount = minDisc; impossible = req <= minDisc; }

  // 1) цель выше базовой цены — придётся поднять базу (или отдать базу целиком, если запрещено)
  if (target >= base) {
    if (mode === 'forbid') return { basePrice: base, discount: minDisc, sellerPrice: sellerAt(base, minDisc), maxDiscount, impossible, baseChanged: false };
    const b = Math.max(1, Math.round(target));
    return { basePrice: b, discount: minDisc, sellerPrice: sellerAt(b, minDisc), maxDiscount, impossible, baseChanged: b !== base };
  }

  // 2) скидка, которая даёт целевую цену при текущей базе
  const discForTarget = Math.floor((1 - target / base) * 100);
  const stepPct = num(R.stepLimitPct);
  const curSeller = num(R.curSeller);
  const withinStep = stepPct <= 0 || curSeller <= 0 ||
    Math.abs(sellerAt(base, Math.max(minDisc, Math.min(maxDiscount, discForTarget))) - curSeller) <= curSeller * stepPct / 100 + 0.01;

  if (discForTarget >= minDisc && discForTarget <= maxDiscount && withinStep) {
    return { basePrice: base, discount: discForTarget, sellerPrice: sellerAt(base, discForTarget), maxDiscount, impossible, baseChanged: false };
  }

  // 3) выход при текущей базе — цена может прыгнуть
  const keepBase = { basePrice: base, discount: maxDiscount, sellerPrice: sellerAt(base, maxDiscount), maxDiscount, impossible, baseChanged: false };
  const keepBaseOk = stepPct <= 0 || curSeller <= 0 || (keepBase.sellerPrice - curSeller) <= curSeller * stepPct / 100 + 0.01;
  if (keepBaseOk || mode === 'forbid') return keepBase;

  // 4) других способов нет — снижаем базовую цену, чтобы покупательская цена осталась у цели
  const b2 = Math.max(1, Math.round(target / (1 - maxDiscount / 100)));
  if (b2 < base) return { basePrice: b2, discount: maxDiscount, sellerPrice: sellerAt(b2, maxDiscount), maxDiscount, impossible, baseChanged: true };
  return keepBase;
}

/**
 * Пара «базовая цена + скидка» под целевую цену для покупателя.
 * Базовую цену сохраняем (WB следит за «ценой до скидки»), играем целым процентом скидки.
 * Базу поднимаем только тогда, когда целевая цена выше текущей базовой.
 */
function pairForSellerPrice(basePrice, sellerPrice) {
  const base = Math.max(1, Math.round(num(basePrice)));
  const seller = Math.max(0, num(sellerPrice));
  if (seller >= base) {
    const b = Math.max(1, Math.round(seller));
    return { basePrice: b, discount: 0, sellerPrice: r2(b), mode: 'base-price' };
  }
  const discount = Math.min(95, Math.max(0, Math.round((1 - seller / base) * 100)));
  return { basePrice: base, discount: r2(discount), sellerPrice: r2(base * (1 - discount / 100)), mode: 'discount-only' };
}

function toBaseAndDiscount(targetSeller, cur, cfg, itemCfg) {
  const rules = cfg.priceEdit || {};
  const mode = rules.canChangeBasePrice || 'allow';
  const canZero = !!rules.canCancelDiscount;
  const targetDisc = num(itemCfg && itemCfg.targetDiscountPct);

  let base = num(cur.basePrice);
  let seller = Math.max(1, num(targetSeller));
  let discount = 0;

  // целевая скидка: подгоняем базовую цену так, чтобы покупатель видел нужный процент
  if (targetDisc > 0) {
    discount = Math.min(95, Math.max(0, targetDisc));
    base = Math.max(seller, Math.round(seller / (1 - discount / 100)));
    return { basePrice: base, discount, mode: 'target-discount' };
  }

  if (mode === 'forbid') {
    // базовую цену менять нельзя — играем только скидкой
    discount = base > seller ? (1 - seller / base) * 100 : 0;
    discount = Math.max(canZero ? 0 : Math.min(num(cur.discount), 1), Math.min(95, discount));
    seller = base * (1 - discount / 100);
    return { basePrice: base, discount: r2(discount), sellerPrice: r2(seller), mode: 'discount-only' };
  }

  if (mode === 'ifNoOtherWay') {
    // сначала пробуем скидкой (целыми процентами), базовую меняем только если не выходит
    const dExact = base > seller ? (1 - seller / base) * 100 : 0;
    const dRounded = Math.round(dExact);
    const achievable = base * (1 - dRounded / 100);
    const diffPct = achievable > 0 ? Math.abs(achievable - seller) / achievable * 100 : 0;
    if (diffPct <= 0.6 && (dRounded > 0 || canZero)) {
      discount = Math.max(canZero ? 0 : 1, Math.min(95, dRounded));
      seller = base * (1 - discount / 100);
      return { basePrice: base, discount, sellerPrice: r2(seller), mode: 'discount-rounded' };
    }
  }

  // разрешено менять базовую цену: ставим её «в рубль» и держим текущую скидку
  discount = Math.max(canZero ? 0 : Math.min(num(cur.discount), 1), Math.min(95, num(cur.discount)));
  const denom = 1 - discount / 100;
  base = denom > 0 ? Math.max(1, Math.round(seller / denom)) : Math.max(1, Math.round(seller));
  let realSeller = base * denom;
  /**
   * WB не принимает цену меньше 1 ₽. При упоре в скидку 95 % прежняя формула ставила базу
   * «в рубль» (base = round(seller)), и цена продавца выходила 0,05 ₽ — скидка валидная,
   * а цена нет. Поднимаем базу, пока цена не станет ≥ 1 ₽.
   */
  if (denom > 0 && realSeller < 1) {
    base = Math.max(base, Math.ceil(1 / denom));
    realSeller = base * denom;
  }
  return { basePrice: base, discount, sellerPrice: r2(realSeller), mode: 'base-price' };
}

/**
 * Сводка расходов из расчёта юнит-экономики — для блока «Себестоимость» в таблице
 * репрайсера (задание D): все слагаемые одной строки, чтобы продавец видел,
 * из чего сложилась прибыль, не открывая карточку товара.
 */
function econSummary(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    cogs: num(e.cogs), commission: num(e.commission), acquiring: num(e.acquiring),
    logistics: num(e.logistics), accept: num(e.accept), storage: num(e.storage),
    packaging: num(e.packaging), tax: num(e.tax), ad: num(e.ad),
    wbTotal: num(e.wbTotal), totalCosts: num(e.totalCosts), pctCosts: num(e.pctCosts),
    fixedCosts: num(e.fixedCosts), markupPct: num(e.markupPct),
    breakEvenPrice: num(e.breakEvenPrice), minPriceForMargin: num(e.minPriceForMargin),
    profit: num(e.profit), profitBeforeTax: num(e.profitBeforeTax),
    marginPct: num(e.marginPct), revenue: num(e.revenue)
  };
}

/** Маржинальность в выбранном режиме расчёта. */
function marginOf(ctx, price) {
  const econ = ctx.econAt ? ctx.econAt(price) : null;
  const profit = econ ? econ.profit : 0;
  switch (ctx.marginMode) {
    case 'forpay': {
      const forPay = ctx.forPayAtPrice ? ctx.forPayAtPrice(price) : price * num(ctx.forPayRatio, 1);
      return { base: forPay, profit, marginPct: forPay > 0 ? (profit / forPay) * 100 : 0, econ };
    }
    case 'wallet': {
      const wallet = price * (1 - num(ctx.sppPct) / 100) * (1 - num(ctx.walletPct) / 100);
      return { base: wallet, profit, marginPct: wallet > 0 ? (profit / wallet) * 100 : 0, econ };
    }
    default:
      return { base: price, profit, marginPct: price > 0 ? (profit / price) * 100 : 0, econ };
  }
}

/** Цена, при которой маржинальность (в выбранном режиме) равна targetPct. */
function priceForMargin(ctx, targetPct, minPrice, maxPrice) {
  // бинарный поиск: прибыль монотонно растёт с ценой
  let lo = Math.max(1, num(minPrice));
  let hi = Math.max(lo + 1, num(maxPrice));
  if (marginOf(ctx, hi).marginPct < targetPct) return null;      // даже максимум не даёт цель
  if (marginOf(ctx, lo).marginPct >= targetPct) return lo;        // уже на минимуме достаточно
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (marginOf(ctx, mid).marginPct >= targetPct) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Минимальная цена конкурента (из включённых и имеющихся в наличии). */
function bestCompetitorPrice(ctx, cfg) {
  const list = (ctx.competitors || []).filter((c) => c.enabled !== false && num(c.stock, 1) > 0 && num(c.price) > 0);
  if (!list.length) return null;
  const mode = (cfg && cfg.competitorMode) || 'withSpp';
  const offsetPct = num(cfg && cfg.competitorOffsetPct);
  /**
   * Тип отстройки — как в репрайсере INDEEPA («Тип отстройки (%/Р)»):
   * процентом от цены конкурента или фиксированной суммой в рублях.
   * Знак работает в обе стороны: отрицательное значение ставит нас ниже конкурента.
   */
  const offsetMode = (cfg && cfg.competitorOffsetMode) || 'pct';   // pct | rub
  const offsetRub = num(cfg && cfg.competitorOffsetRub);
  const target = (cfg && cfg.competitorId) ? list.find((c) => String(c.id) === String(cfg.competitorId)) : null;
  const source = target || list.reduce((a, b) => (num(a.price) <= num(b.price) ? a : b));

  let price = num(source.price);
  if (mode === 'withSpp') price = price / Math.max(0.01, 1 - num(ctx.sppPct) / 100);
  else if (mode === 'withWallet') price = price / Math.max(0.01, (1 - num(ctx.sppPct) / 100) * (1 - num(ctx.walletPct) / 100));

  price = offsetMode === 'rub' ? price + offsetRub : price * (1 + offsetPct / 100);
  if (price < 0) price = 0;
  return { price: r2(price), source, offsetMode, offsetPct, offsetRub };
}

/** Прогресс выполнения месячного плана (1.0 = идём по графику). */
function planProgress(ctx, itemCfg) {
  const planQty = num(itemCfg && itemCfg.planQtyMonth);
  if (planQty <= 0) return null;
  const d = new Date(ctx.now || Date.now());
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const dayOfMonth = Math.min(d.getDate(), daysInMonth);
  const expected = planQty * (dayOfMonth / daysInMonth);
  const fact = num(ctx.salesMonthQty);
  return { planQty, fact, expected, dayOfMonth, daysInMonth, ratio: expected > 0 ? fact / expected : (fact > 0 ? 2 : 0) };
}

/** Формат процента, совпадающий с U.pct() в интерфейсе. */
function formatPct(v) {
  return num(v).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

/**
 * Чистая классификация выгодности строки. Вынесена из Views.repricer, чтобы одна и та же
 * логика статусов могла проверяться без DOM/jsdom и использоваться интерфейсом как есть.
 * Порог себестоимости <= 2 ₽ остаётся отдельной проверкой строки/предложения.
 */
function valueStatus(r, itemCfg, defaults, costPriceRub) {
  const I = itemCfg || {};
  const D = defaults || {};
  const target = num(I.targetMarginPct !== undefined ? I.targetMarginPct : D.targetMarginPct);
  const minMargin = num(I.minMarginPct !== undefined ? I.minMarginPct : D.minMarginPct);
  const next = (r && r.proposed) || {};
  const margin = num(next.marginPct !== undefined ? next.marginPct : ((r && r.current) || {}).marginPct);
  if (!(num(costPriceRub) > 0)) {
    return { id: 'noindex', label: 'Без индекса', kind: '', hint: 'Себестоимость не задана — оценить выгодность нельзя' };
  }
  if (num(next.profit) < 0 || margin < minMargin) {
    return { id: 'bad', label: 'Невыгодный', kind: 'danger', hint: 'Прибыль отрицательная или маржа ниже минимальной (' + formatPct(minMargin) + ')' };
  }
  if (target > 0 && margin >= target) {
    return { id: 'super', label: 'Супер-выгодный', kind: 'ok', hint: 'Маржа ' + formatPct(margin) + ' ≥ целевой ' + formatPct(target) };
  }
  return { id: 'good', label: 'Выгодный', kind: 'info', hint: 'Маржа ' + formatPct(margin) + ' между минимальной и целевой' };
}

/**
 * Планировщик действий по акциям Wildberries.
 *
 * ВАЖНО про выход из акции: API Wildberries **не даёт** вывести товар из акции —
 * ни из обычной, ни из автоакции (в кабинете это делается Excel-файлом исключений).
 * Единственный программный способ — поднять цену выше плановой цены акции:
 * товар перестаёт соответствовать условиям, и WB выводит его сам.
 * Поэтому действие «выйти» в приложении = изменение цены + запись в очередь возврата,
 * чтобы после фактического выхода вернуть рабочую цену.
 *
 * @param {object} ctx контекст товара (см. computeItem) + ctx.promos[] и ctx.sppFactAvg
 * @param {object} cfg конфигурация репрайсера
 * @param {object} itemCfg настройки артикула
 * @param {{strategyPrice:number}} extra цена, которую предложил основной расчёт (для возврата)
 * @returns {{actions:Array, chosen:object|null, sppForecastPct:number}}
 */
function planPromos(ctx, cfg, itemCfg, extra) {
  const C = cfg || DEFAULT_CONFIG;
  const P = C.promo || {};
  const I = itemCfg || {};
  const promos = Array.isArray(ctx.promos) ? ctx.promos : [];
  const strategyPrice = num(extra && extra.strategyPrice, num(ctx.sellerPrice));
  if (!promos.length || !ctx.econAt) return { actions: [], chosen: null, sppForecastPct: num(ctx.sppPct) };

  const curSeller = num(ctx.sellerPrice);
  const floor = Math.max(1, num(I.minPrice) > 0 ? num(I.minPrice) : 0);
  const targetMargin = num(I.targetMarginPct, C.defaults.targetMarginPct);
  const promoMinMargin = (P.minMarginInPromoPct === null || P.minMarginInPromoPct === undefined)
    ? targetMargin : num(P.minMarginInPromoPct);
  const allowNeg = I.allowNegativeMargin === undefined ? !!C.defaults.allowNegativeMargin : !!I.allowNegativeMargin;
  const bufferPct = num(P.exitBufferPct, 2);

  // Прогнозная СПП: вручную по артикулу → фактическая средняя по продажам → текущая.
  // WB API прогнозную СПП не отдаёт, поэтому «прогноз» = средняя фактическая СПП товара.
  const sppForecast = (I.sppForecastPct !== undefined && I.sppForecastPct !== null && I.sppForecastPct !== '')
    ? num(I.sppForecastPct)
    : (num(ctx.sppFactAvg) > 0 ? num(ctx.sppFactAvg) : num(ctx.sppPct));

  // акции, из которых товар выведен и цена удерживается повышенной
  const hold = ctx.promoHold;
  const holdIds = (hold && hold.promoIds ? hold.promoIds : []).map(String);

  const actions = [];
  for (const pr of promos) {
    const required = num(pr.requiredDiscountPct, num(pr.participationPercentage));
    const planPrice = num(pr.planPrice) > 0
      ? num(pr.planPrice)
      : r2(num(ctx.basePrice) * (1 - required / 100));
    const isAuto = String(pr.type || '').toLowerCase() === 'auto';
    const inAction = !!pr.inAction;
    const eligible = pr.eligible !== false;
    const started = pr.started === undefined ? true : !!pr.started;
    const daysToStart = num(pr.daysToStart, 0);

    const econ = ctx.econAt(planPrice);
    const buyerPrice = r2(planPrice * (1 - sppForecast / 100));
    const marginOk = econ.marginPct >= promoMinMargin - 1e-9;
    const profitOk = econ.profit >= 0 || allowNeg;
    const floorOk = planPrice >= floor - 0.01;

    const base = {
      promoId: pr.id,
      promoName: pr.name || ('Акция ' + pr.id),
      promoType: isAuto ? 'auto' : 'manual',
      started, daysToStart,
      requiredDiscountPct: r2(required),
      planPrice,
      buyerPriceForecast: buyerPrice,
      sppForecastPct: r2(sppForecast),
      profitAtPlan: econ.profit,
      marginAtPlan: r2(econ.marginPct),
      minMarginRequired: promoMinMargin,
      inAction, eligible, isAuto
    };

    if (inAction) {
      const exitAllowed = isAuto ? !!P.autoExitAutoPromos : !!P.autoExitManualPromos;
      if (marginOk && profitOk && floorOk) {
        actions.push(Object.assign(base, {
          action: 'stay',
          reason: `Участие выгодно: маржа ${econ.marginPct.toFixed(1)}% при пороге ${promoMinMargin}%, прибыль ${Math.round(econ.profit)} ₽.`
        }));
      } else if (!exitAllowed) {
        const why = !profitOk ? 'убыток' : (!marginOk ? `маржа ${econ.marginPct.toFixed(1)}% ниже порога ${promoMinMargin}%` : 'цена ниже минимального порога');
        actions.push(Object.assign(base, {
          action: 'warn',
          reason: `Участие невыгодно (${why}), но авто-выход для ${isAuto ? 'авто-акций' : 'обычных акций'} выключен.`
        }));
      } else {
        const why = !profitOk ? 'убыток по акционной цене'
          : (!floorOk ? `акционная цена ниже минимального порога ${Math.round(floor)} ₽`
            : `маржа ${econ.marginPct.toFixed(1)}% ниже порога ${promoMinMargin}%`);
        // ВАЖНО: плановая цена акции = базовая цена × (1 − требуемая скидка), то есть она
        // «плавает» вместе с базовой ценой. Поэтому простое «поднять цену» не работает:
        // плановая цена поднимется ровно так же, и товар останется в акции.
        // Единственный надёжный способ выйти — сделать скидку СТРОГО НИЖЕ порога акции.
        // Базовую цену при этом подбираем так, чтобы цена для покупателя не упала.
        const alreadyAbove = num(ctx.discount) < required - 1e-9;
        // Выход меняет СТРУКТУРУ цены (скидка ниже порога акции), а не её уровень:
        // цену двигаем к рабочей цене стратегии, но не больше лимита шага за обновление
        // и никогда не ниже текущей цены. До цели товар дойдёт обычными пересчётами.
        const stepPctExit = num(C.limits.maxChangePerUpdatePct);
        const capExit = stepPctExit > 0 && curSeller > 0 ? curSeller * (1 + stepPctExit / 100) : Infinity;
        const wanted = Math.max(curSeller, floor, Math.min(strategyPrice > 0 ? strategyPrice : curSeller, capExit));
        const exitPair = exitPairForPromo(num(ctx.basePrice), required, wanted, {
          canChangeBasePrice: (C.priceEdit || {}).canChangeBasePrice,
          canCancelDiscount: (C.priceEdit || {}).canCancelDiscount,
          stepLimitPct: num(C.limits.maxChangePerUpdatePct),
          curSeller
        });
        const exitDiscountPct = exitPair.maxDiscount;
        const exitBasePrice = exitPair.basePrice;
        const exitDisc = exitPair.discount;
        const raiseTo = exitPair.sellerPrice;
        actions.push(Object.assign(base, {
          action: 'exit',
          raiseTo,
          exitDiscountPct: r2(exitDisc),
          exitMaxDiscountPct: r2(exitDiscountPct),
          exitBasePrice,
          noChangeNeeded: alreadyAbove,
          restoreSellerPrice: r2(strategyPrice),
          reason: alreadyAbove
            ? `Выход из ${isAuto ? 'авто-акции' : 'акции'}: ${why}. Скидка ${r2(num(ctx.discount))}% уже ниже порога ${r2(required)}% — товар не соответствует условиям акции, менять цену не нужно, ждём вывода из акции.`
            // Итоговые цифры (скидка, база, цена) определяет самая «мягкая» из акций товара,
            // поэтому здесь — только порог этой акции и суть приёма. Подробное объяснение
            // с итоговыми числами собирается в выбранном решении (chosen.reason).
            : `Выход из ${isAuto ? 'авто-акции' : 'акции'}: ${why}. Порог участия — скидка ${r2(required)}%, `
              + `поэтому снижаем скидку ниже него (до ${r2(exitDisc)}%): товар перестанет соответствовать условиям, и WB выведёт его сам. `
              + `Исключить товар через API нельзя, а повышать цену бесполезно — плановая цена акции считается от вашей цены до скидки и растёт вместе с ней.`
        }));
      }
      continue;
    }

    // товар не в акции — решаем, входить ли
    if (holdIds.includes(String(pr.id))) {
      actions.push(Object.assign(base, {
        action: 'skip',
        reason: 'Повторный вход отключён: товар выведен из этой акции и ждёт её окончания (иначе WB вернёт его обратно).'
      }));
      continue;
    }
    if (!eligible) {
      actions.push(Object.assign(base, { action: 'skip', reason: 'Товар не входит в список доступных для этой акции.' }));
      continue;
    }
    if (!marginOk || !profitOk || !floorOk) {
      const why = !profitOk ? 'вход даёт убыток'
        : (!floorOk ? `акционная цена ${Math.round(planPrice)} ₽ ниже минимального порога ${Math.round(floor)} ₽`
          : `маржа ${econ.marginPct.toFixed(1)}% ниже порога ${promoMinMargin}%`);
      actions.push(Object.assign(base, { action: 'skip', reason: `Не входим: ${why}.` }));
      continue;
    }
    if (!P.useForecastSpp) {
      actions.push(Object.assign(base, {
        action: 'recommend',
        reason: `Вход выгоден (маржа ${econ.marginPct.toFixed(1)}%), но «прогнозная СПП для акций» выключена — автоматически не входим.`
      }));
      continue;
    }
    if (daysToStart > num(P.joinLeadDays, 45)) {
      actions.push(Object.assign(base, { action: 'later', reason: `Акция начнётся через ${Math.round(daysToStart)} дн. — решение примем ближе к старту.` }));
      continue;
    }

    // цена входа: наша расчётная, если она уже подходит, иначе плановая цена акции
    const joinPrice = strategyPrice > 0 && strategyPrice <= planPrice + 0.01
      ? r2(Math.max(strategyPrice, floor))
      : r2(Math.max(planPrice, floor));
    const joinEcon = ctx.econAt(joinPrice);
    const nowEcon = ctx.econAt(curSeller);
    const perDay = num(ctx.salesPerDay);
    const upliftPct = num(P.expectedSalesUpliftPct, 30);
    // вход окупится, если продажи вырастут хотя бы на столько-то
    const breakEvenUplift = joinEcon.profit > 0.01
      ? r2((nowEcon.profit / joinEcon.profit - 1) * 100)
      : Infinity;
    // оценка прибыли за месяц с учётом ожидаемого прироста продаж
    const profitMonthNow = nowEcon.profit * perDay * 30;
    const profitMonthJoin = joinEcon.profit * perDay * (1 + upliftPct / 100) * 30;
    actions.push(Object.assign(base, {
      action: P.autoJoin ? 'join' : 'recommend',
      joinPrice,
      joinDiscountPct: r2(num(ctx.basePrice) > 0 ? (1 - joinPrice / num(ctx.basePrice)) * 100 : 0),
      profitAtJoin: joinEcon.profit,
      marginAtJoin: r2(joinEcon.marginPct),
      profitBeforeJoin: r2(nowEcon.profit),
      breakEvenUpliftPct: Number.isFinite(breakEvenUplift) ? breakEvenUplift : null,
      expectedSalesUpliftPct: upliftPct,
      profitMonthNow: r2(profitMonthNow),
      profitMonthJoin: r2(profitMonthJoin),
      profitMonthDelta: r2(profitMonthJoin - profitMonthNow),
      joinPaysOff: Number.isFinite(breakEvenUplift) ? breakEvenUplift <= upliftPct : false,
      priceChangeNeeded: Math.abs(joinPrice - curSeller) > 0.5,
      reason: (P.autoJoin
        ? `Входим в акцию по цене ${Math.round(joinPrice)} ₽ (маржа ${joinEcon.marginPct.toFixed(1)}%, прибыль ${Math.round(joinEcon.profit)} ₽ вместо ${Math.round(nowEcon.profit)} ₽).`
        : `Вход выгоден по цене ${Math.round(joinPrice)} ₽ (маржа ${joinEcon.marginPct.toFixed(1)}%). Авто-вход выключен — это рекомендация.`)
        + (Number.isFinite(breakEvenUplift)
          ? ` Вход окупится при росте продаж от ${breakEvenUplift.toFixed(0)}%; ожидаем ${upliftPct}% → ${breakEvenUplift <= upliftPct ? 'выгодно' : 'НЕ окупается при таком росте'}.`
          : ' Прибыль в акции нулевая или отрицательная — вход не окупится ни при каком росте продаж.')
    }));
  }

  // выбираем одно действие на товар: выход (защитное) важнее входа
  const exits = actions.filter((a) => a.action === 'exit');
  const joins = actions.filter((a) => a.action === 'join');
  let chosen = null;

  if (exits.length) {
    // товар может быть в нескольких акциях сразу — скидка должна быть ниже порога
    // самой «мягкой» из них, иначе он останется в остальных
    // при нескольких акциях скидка должна быть ниже порога самой «мягкой» из них
    // самая «мягкая» акция задаёт порог: скидка должна быть ниже него, иначе товар
    // выйдет из одной акции, но останется в другой
    const requiredMin = Math.min.apply(null, exits.map((a) => num(a.requiredDiscountPct)));
    const requiredMax = Math.max.apply(null, exits.map((a) => num(a.requiredDiscountPct)));
    // та же логика, что и для одной акции: цена в пределах шага и не ниже текущей
    const stepPctChosen = num(C.limits.maxChangePerUpdatePct);
    const capChosen = stepPctChosen > 0 && curSeller > 0 ? curSeller * (1 + stepPctChosen / 100) : Infinity;
    const wanted = Math.max(curSeller, floor, Math.min(strategyPrice > 0 ? strategyPrice : curSeller, capChosen));
    const pairExit = exitPairForPromo(num(ctx.basePrice), requiredMin, wanted, {
      canChangeBasePrice: (C.priceEdit || {}).canChangeBasePrice,
      canCancelDiscount: (C.priceEdit || {}).canCancelDiscount,
      stepLimitPct: num(C.limits.maxChangePerUpdatePct),
      curSeller
    });
    const exitDiscountPct = pairExit.maxDiscount;
    const exitBasePrice = pairExit.basePrice;
    const exitDisc = pairExit.discount;
    const allAlreadyAbove = exits.every((a) => a.noChangeNeeded);
    chosen = {
      type: 'exit',
      price: allAlreadyAbove ? r2(curSeller) : r2(exitBasePrice * (1 - exitDisc / 100)),
      basePrice: allAlreadyAbove ? Math.round(num(ctx.basePrice)) : exitBasePrice,
      discount: allAlreadyAbove ? r2(num(ctx.discount)) : r2(exitDisc),
      noChangeNeeded: allAlreadyAbove,
      requiredDiscountPct: r2(requiredMax),
      // минимальная цена, при которой товар гарантированно покидает акцию
      minExitSellerPrice: r2(Math.min.apply(null, exits.map((a) => num(a.raiseTo)))),
      promoIds: exits.map((a) => a.promoId),
      promoNames: exits.map((a) => a.promoName),
      restoreSellerPrice: r2(strategyPrice),
      // одно общее объяснение по итоговым цифрам: у товара может быть несколько акций,
      // и склеенные причины отдельных акций противоречат друг другу по процентам
      reason: (function () {
        const names = exits.map((a) => a.promoName).join(', ');
        const finalPrice = allAlreadyAbove ? curSeller : exitBasePrice * (1 - exitDisc / 100);
        const why = exits.map((a) => a.promoName + ' — ' + (a.reason || '').split(':')[0]).join('; ');
        const head = allAlreadyAbove
          ? `Выход из акций (${names}): скидка уже ниже их порогов, товар не соответствует условиям — менять цену не нужно.`
          : `Выход из акций (${names}): ${exits[0] && exits[0].reason ? exits[0].reason.split('. ')[0].replace(/^Выход из [^:]*: /, '') : 'участие убыточно'}.`;
        return head
          + (allAlreadyAbove ? '' :
            ` Исключить товар через API WB нельзя, а плановая цена акции считается от вашей цены до скидки — поэтому повышать цену бесполезно: порог растёт вместе с ней.`
            + ` Снижаем скидку до ${r2(exitDisc)}% — ниже самого мягкого порога ${r2(requiredMin)}%${exits.length > 1 ? ` (пороги акций: ${exits.map((a) => r2(num(a.requiredDiscountPct)) + '%').join(', ')})` : ''},`
            + ` чтобы товар покинул ${exits.length > 1 ? 'все акции сразу' : 'акцию'}: WB выведет его автоматически.`
            + ` Цена для покупателя ${Math.round(curSeller)} → ${Math.round(finalPrice)} ₽ (${finalPrice >= curSeller ? '+' : ''}${r2((finalPrice / Math.max(1, curSeller) - 1) * 100)}%),`
            + ` цена до скидки ${Math.round(num(ctx.basePrice))} → ${Math.round(exitBasePrice)} ₽ — базу не завышаем, WB за этим следит.`)
          + ` После окончания акции цена вернётся к ${Math.round(strategyPrice)} ₽.`;
      })(),
      // Лимит шага обходим, только если без этого из акции не выйти за одно обновление:
      // иначе товар будет терять деньги в акции много обновлений подряд.
      bypassLimits: (function () {
        const stepPct = num(C.limits.maxChangePerUpdatePct);
        const target = allAlreadyAbove ? curSeller : exitBasePrice * (1 - exitDisc / 100);
        return stepPct > 0 && curSeller > 0 && (target - curSeller) > curSeller * stepPct / 100 + 0.01;
      })()
    };
  } else if (joins.length) {
    // если подходит несколько акций — входим по той, где цена ниже (больше буст),
    // но не ниже минимального порога
    const best = joins.reduce((a, b) => (num(a.joinPrice) <= num(b.joinPrice) ? a : b));
    chosen = {
      type: 'join',
      price: r2(Math.max(num(best.joinPrice), floor)),
      promoIds: joins.map((a) => a.promoId),
      promoNames: joins.map((a) => a.promoName),
      joinPrice: r2(best.joinPrice),
      breakEvenUpliftPct: best.breakEvenUpliftPct,
      expectedSalesUpliftPct: best.expectedSalesUpliftPct,
      profitMonthDelta: best.profitMonthDelta,
      joinPaysOff: best.joinPaysOff,
      reason: best.reason,
      bypassLimits: !!P.ignoreChangeLimitOnEntry
    };
  }

  // Скидка не ниже порога акции — иначе WB выведет товар, даже если мы хотим остаться.
  // Условие участия: цена со скидкой ≤ плановой ⟺ скидка ≥ требуемой.
  // Только участие, которое мы подтвердили: stay/warn (товар уже в акции) и join (входим сами).
  // Для «recommend» порог не поднимаем — иначе автоакция подхватит товар без нашего решения.
  const discountFloor = actions
    .filter((a) => a.action === 'stay' || a.action === 'join' || a.action === 'warn')
    .reduce((m, a) => Math.max(m, Math.ceil(num(a.requiredDiscountPct))), 0);

  return { actions, chosen, discountFloor, sppForecastPct: r2(sppForecast) };
}

/**
 * Расчёт новой цены для одного товара.
 *
 * @param {object} ctx контекст товара:
 *   { nmID, basePrice, discount, sellerPrice, buyerPrice, minPrice, basePriceTarget,
 *     stock, salesPerDay, salesMonthQty, turnoverDays, inPromo, promoPrice, promoDiscountPct,
 *     competitors[], forPayAvg, rrp, econAt(price) → {profit, marginPct, revenue}, sppPct }
 * @param {object} cfg глобальные настройки репрайсера (DEFAULT_CONFIG + правки пользователя)
 * @param {object} itemCfg настройки артикула (strategy, targetMarginPct, minPrice, …)
 * @param {object} ec модуль экономики (window.EC / require('./economics'))
 */
function computeItem(ctx, cfg, itemCfg, ec) {
  const C = cfg || DEFAULT_CONFIG;
  const I = itemCfg || {};
  const now = ctx.now || Date.now();

  const curBase = num(ctx.basePrice);
  const curDisc = num(ctx.discount);
  const curSeller = num(ctx.sellerPrice, curBase * (1 - curDisc / 100));
  const curBuyer = curSeller * (1 - num(ctx.sppPct) / 100) * (1 - num(C.priceEdit.walletPct) / 100);

  // ── ценовой коридор ──
  const strategy = I.strategy || C.defaults.strategy || 'default';
  const minPrice = num(I.minPrice, 0);
  const basePriceTarget = num(I.basePriceTarget, curBase);
  const targetMargin = num(I.targetMarginPct, C.defaults.targetMarginPct);
  const minMargin = num(I.minMarginPct, C.defaults.minMarginPct);
  const allowNeg = I.allowNegativeMargin === undefined ? !!C.defaults.allowNegativeMargin : !!I.allowNegativeMargin;

  // ценовой коридор: минимальная цена (пол) ↔ базовая цена (потолок).
  // Если минимальная цена не задана — пол определяется минимальной маржинальностью.
  const corridorMax = Math.max(basePriceTarget, curBase);
  const corridorMin = Math.max(1, minPrice > 0 ? minPrice : 1);

  const notes = [];
  const warnings = [];
  const layers = [];

  const marginCtx = Object.assign({}, ctx, {
    marginMode: C.marginMode,
    walletPct: num(C.priceEdit.walletPct),
    forPayRatio: curSeller > 0 ? num(ctx.forPayAvg) / curSeller : 1
  });
  marginCtx.forPayAtPrice = (price) => price * marginCtx.forPayRatio;

  const marginAt = (price) => marginOf(marginCtx, price).marginPct;
  const profitAt = (price) => marginOf(marginCtx, price).profit;

  // минимальная цена по марже (точка, где маржа = minMargin);
  // при разрешённой отрицательной марже пол определяется только минимальным порогом
  const minByMargin = (ctx.econAt && !allowNeg) ? priceForMargin(marginCtx, minMargin, 1, corridorMax * 3) : null;
  const priceFloor = Math.max(corridorMin, minByMargin || 0);

  // ── СЛОЙ 1: универсальная стратегия ──
  let target = curSeller;
  let strategyName = strategy;

  const comp = bestCompetitorPrice(marginCtx, I);
  const promoPrice = num(ctx.promoPrice, 0) > 0 ? num(ctx.promoPrice) : null;

  switch (strategy) {
    case 'hold':
      target = curSeller;
      notes.push('Стратегия «Держать цену»: цена не меняется.');
      break;

    case 'margin': {
      const p = ctx.econAt ? priceForMargin(marginCtx, targetMargin, priceFloor, corridorMax * 2) : null;
      if (p === null) {
        target = Math.min(curSeller, corridorMax);
        notes.push(`Целевая маржа ${targetMargin}% недостижима даже на базовой цене — держим максимум коридора.`);
      } else {
        target = Math.max(p, priceFloor);
        notes.push(`Цена под целевую маржу ${targetMargin}%: ${Math.round(target)} ₽.`);
      }
      break;
    }

    case 'competitor': {
      if (!comp) {
        strategyName = 'default';
        notes.push('Конкурент не найден или нет в наличии → включена стратегия «По умолчанию».');
        target = promoPrice && promoPrice >= priceFloor && promoPrice <= corridorMax ? promoPrice : basePriceTarget;
      } else {
        target = comp.price;
        notes.push(`Следование за конкурентом «${comp.source.name || comp.source.id}»: ${Math.round(comp.price)} ₽ (отступ ${
          I.competitorOffsetMode === 'rub' ? (num(I.competitorOffsetRub) >= 0 ? '+' : '−') + Math.abs(num(I.competitorOffsetRub)) + ' ₽'
            : (num(I.competitorOffsetPct) >= 0 ? '+' : '−') + Math.abs(num(I.competitorOffsetPct)) + '%'
        }).`);
        if (comp.price < priceFloor) { target = priceFloor; notes.push('Цена конкурента ниже минимального порога → применяем порог.'); }
        if (comp.price > corridorMax) { target = corridorMax; notes.push('Цена конкурента выше базовой → применяем базовую.'); }
      }
      break;
    }

    case 'planfact': {
      const pp = planProgress(marginCtx, I);
      if (!pp) { target = curSeller; notes.push('План на месяц не задан — цена не меняется.'); break; }
      const lag = pp.ratio;                       // <1 отстаём, >1 опережаем
      const sensitivity = num(I.planSensitivityPct, 8);
      let k = 1;
      if (lag < 0.97) k = 1 - Math.min(0.25, (1 - lag) * (sensitivity / 10));
      else if (lag > 1.03) k = 1 + Math.min(0.25, (lag - 1) * (sensitivity / 10));
      target = curSeller * k;
      notes.push(`План-факт: ${pp.fact} из ${pp.planQty} шт (день ${pp.dayOfMonth}/${pp.daysInMonth}, график ${Math.round(pp.ratio * 100)}%) → коэффициент ${k.toFixed(3)}.`);
      break;
    }

    case 'turnover': {
      const td = num(ctx.turnoverDays, num(ctx.stock) > 0 && num(ctx.salesPerDay) > 0 ? ctx.stock / ctx.salesPerDay : 999);
      const goal = num(I.targetTurnoverDays, C.defaults.targetTurnoverDays);
      const liq = num(I.liquidationTurnoverDays, C.defaults.liquidationTurnoverDays);
      if (td > liq) {
        target = priceFloor;
        notes.push(`Оборачиваемость ${Math.round(td)} дн > ${liq} дн → распродажа: цена к минимальному порогу.`);
      } else if (td > goal * 1.5) {
        target = curSeller * 0.97;
        notes.push(`Оборачиваемость ${Math.round(td)} дн выше цели ${goal} дн → снижаем на 3%.`);
      } else if (td <= goal) {
        target = Math.min(curSeller * 1.03, corridorMax);
        notes.push(`Оборачиваемость ${Math.round(td)} дн в норме (цель ${goal}) → повышаем на 3%.`);
      } else target = curSeller;
      break;
    }

    case 'rrp': {
      const rrp = num(ctx.rrp || I.rrp);
      if (!rrp) { target = curSeller; notes.push('РРЦ не указана — цена не меняется.'); break; }
      const sppK = (1 - num(ctx.sppPct) / 100) * (1 - num(C.priceEdit.walletPct) / 100);
      const needed = sppK > 0 ? rrp / sppK : rrp;
      if (curBuyer < rrp - 0.01) {
        target = Math.max(curSeller, needed);
        notes.push(`Цена для покупателя ${Math.round(curBuyer)} ₽ ниже РРЦ ${rrp} ₽ → поднимаем до ${Math.round(target)} ₽.`);
      } else {
        target = curSeller;
        notes.push(`РРЦ соблюдается (покупатель ${Math.round(curBuyer)} ₽ ≥ ${rrp} ₽).`);
      }
      break;
    }

    case 'ai': {
      if (!ctx.econAt) { target = curSeller; break; }
      const perDay = num(ctx.salesPerDay);
      let best = null;
      const lo = Math.max(priceFloor, 1);
      const hi = corridorMax;
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const p = lo + (hi - lo) * (i / steps);
        const profit = profitAt(p);
        // модель спроса: эластичность по цене относительно текущей
        const elast = num(I.elasticityPct, 12) / 100;
        const demandK = perDay > 0 ? Math.max(0.15, 1 + elast * ((curSeller - p) / Math.max(1, curSeller))) : 1;
        const monthly = profit * perDay * 30 * demandK;
        if (!best || monthly > best.monthly) best = { price: p, monthly, profit };
      }
      if (best) {
        target = best.price;
        notes.push(`AI-подбор: оптимум ${Math.round(best.price)} ₽ (прогноз прибыли ${Math.round(best.monthly)} ₽/мес при темпе ${perDay.toFixed(1)} шт/день).`);
      }
      break;
    }

    case 'promo': {
      target = promoPrice && promoPrice >= priceFloor ? promoPrice : basePriceTarget;
      notes.push(promoPrice ? `Стратегия «Только акции»: акционная цена ${Math.round(promoPrice)} ₽.` : 'Акции нет → базовая цена.');
      break;
    }

    default: {
      // «По умолчанию»: сравниваем минимальную, базовую, акционную и цену конкурента
      const options = [{ name: 'базовая', price: basePriceTarget }];
      if (promoPrice) options.push({ name: 'акция', price: promoPrice });
      if (comp) options.push({ name: 'конкурент', price: comp.price });
      const inside = options.filter((o) => o.price >= priceFloor - 0.01 && o.price <= corridorMax + 0.01);
      if (inside.length > 1) {
        const best = inside.reduce((a, b) => (a.price <= b.price ? a : b));
        target = best.price;
        notes.push(`Сравнение цен: ${options.map((o) => `${o.name} ${Math.round(o.price)}`).join(', ')} → выбрана наименьшая в коридоре (${best.name}).`);
      } else {
        target = basePriceTarget;
        notes.push('Акционная/конкурентная цена вне коридора → ставим базовую цену.');
      }
      strategyName = 'default';
    }
  }

  layers.push({ layer: 'Стратегия', name: strategyName, price: r2(target), note: notes[notes.length - 1] || '' });

  // ── СЛОЙ 2: верхнеуровневые ДЦО (приоритет выше, берём максимальную цену) ──
  const dco = [];

  // 2.1 Защита от out of stock
  const oosOn = I.oosProtection === undefined ? !!C.defaults.oosProtection : !!I.oosProtection;
  if (oosOn) {
    const perDay = num(ctx.salesPerDay);
    const stock = num(ctx.stock);
    const cover = perDay > 0 ? stock / perDay : (stock > 0 ? 999 : 0);
    const goal = num(I.targetTurnoverDays, C.defaults.targetTurnoverDays);
    if (stock > 0 && cover < goal) {
      // плавно поднимаем цену, чтобы растянуть остаток на goal дней
      const gap = Math.max(0, goal - cover) / Math.max(1, goal);
      const uplift = num(I.oosUpliftPct, 15) / 100;
      const price = Math.min(curSeller * (1 + gap * uplift * 2), corridorMax * 1.2);
      dco.push({ layer: 'ДЦО', name: 'Защита от out-of-stock', price: r2(price), note: `Остатка хватит на ${cover.toFixed(1)} дн при цели ${goal} дн → повышаем цену.` });
    }
  }

  // 2.2 Повышение акционной цены
  const uplift = num(I.promoUpliftPct, C.defaults.promoUpliftPct);
  if (uplift > 0 && ctx.inPromo && promoPrice) {
    const price = promoPrice * (1 + uplift / 100);
    dco.push({ layer: 'ДЦО', name: 'Повышение акционной цены', price: r2(price), note: `Акционная цена ${Math.round(promoPrice)} ₽ + ${uplift}% = ${Math.round(price)} ₽.` });
  }

  // 2.3 Распродажа неликвида (понижающее ДЦО — применяется, только если цена выше цели)
  const liqDays = num(I.liquidationTurnoverDays, C.defaults.liquidationTurnoverDays);
  const liqDisc = num(I.liquidationDiscountPct, C.defaults.liquidationDiscountPct);
  if (num(ctx.turnoverDays) > liqDays && liqDisc > 0) {
    const price = Math.max(priceFloor, curSeller * (1 - liqDisc / 100));
    dco.push({ layer: 'ДЦО', name: 'Распродажа неликвида', price: r2(price), note: `Оборачиваемость ${Math.round(ctx.turnoverDays)} дн > ${liqDays} дн → −${liqDisc}%.` });
  }

  // 2.4 Минимальная маржа как жёсткий пол (верхнеуровневое правило)
  if (minByMargin && target < minByMargin - 0.01) {
    dco.push({ layer: 'ДЦО', name: 'Минимальная маржа', price: r2(minByMargin), note: `Целевая цена ниже точки маржи ${minMargin}% (${Math.round(minByMargin)} ₽).` });
  }

  let finalPrice = target;
  if (dco.length) {
    const raising = dco.filter((d) => d.name !== 'Распродажа неликвида');
    const lowering = dco.filter((d) => d.name === 'Распродажа неликвида');
    if (raising.length) {
      const max = raising.reduce((a, b) => (a.price >= b.price ? a : b));
      if (max.price > finalPrice) { finalPrice = max.price; notes.push(`ДЦО «${max.name}» перекрыло стратегию: ${Math.round(max.price)} ₽.`); }
    }
    if (lowering.length && finalPrice > lowering[0].price && !raising.length) {
      finalPrice = lowering[0].price;
      notes.push(`ДЦО «Распродажа неликвида»: ${Math.round(finalPrice)} ₽.`);
    }
    layers.push.apply(layers, dco);
  }

  // ── коридор ──
  const beforeCorridor = finalPrice;
  finalPrice = Math.min(Math.max(finalPrice, priceFloor > 0 ? priceFloor : 1), corridorMax);
  if (Math.abs(finalPrice - beforeCorridor) > 0.5) {
    notes.push(`Цена ограничена коридором: ${Math.round(beforeCorridor)} → ${Math.round(finalPrice)} ₽ (мин ${Math.round(priceFloor)}, базовая ${Math.round(corridorMax)}).`);
  }

  // ── АКЦИИ: вход/выход — решение поверх стратегии ──
  // Выход из акции возможен только повышением цены выше плановой (API WB исключать товар не даёт),
  // поэтому такое повышение выполняется сразу, минуя лимит шага: оно не рискует карантином
  // и не скрывает карточку (риск службы безопасности WB связан с резким снижением цены).
  const promoPlan = planPromos(ctx, C, I, { strategyPrice: finalPrice });
  let promoBypass = false;
  let promoExitPair = null;
  if (promoPlan.chosen) {
    const ch = promoPlan.chosen;
    if (ch.type === 'exit') {
      // цена выхода задаётся парой «база + скидка ниже порога акции» — её нельзя
      // пересчитывать через toBaseAndDiscount, иначе скидка вернётся к прежней
      promoExitPair = { basePrice: Math.round(num(ch.basePrice)), discount: r2(num(ch.discount)) };
      finalPrice = r2(promoExitPair.basePrice * (1 - promoExitPair.discount / 100));
      promoBypass = !!ch.bypassLimits;
      layers.push({ layer: 'Акции', name: 'Выход из акции', price: finalPrice, note: ch.reason });
      notes.push(`Выход из акции (${ch.promoNames.join(', ')}): скидка ${promoExitPair.discount}% вместо порога ${r2(num(ch.requiredDiscountPct))}% → цена ${Math.round(finalPrice)} ₽ выше плановой, WB выведет товар.` +
        ` После фактического выхода${C.promo.restorePriceAfterExit === false ? ' цена НЕ возвращается (возврат выключен)' : ` цена вернётся к ${Math.round(num(ch.restoreSellerPrice))} ₽`}.`);
    } else if (ch.type === 'join') {
      finalPrice = Math.min(Math.max(num(ch.price), priceFloor > 0 ? priceFloor : 1), corridorMax);
      promoBypass = !!ch.bypassLimits;
      layers.push({ layer: 'Акции', name: 'Вход в акцию', price: r2(finalPrice), note: ch.reason });
      notes.push(`Вход в акцию (${ch.promoNames.join(', ')}): цена ${Math.round(finalPrice)} ₽.`);
      const stepPct = num(C.limits.maxChangePerUpdatePct);
      if (!promoBypass && stepPct > 0 && curSeller > 0 && Math.abs(finalPrice - curSeller) > curSeller * stepPct / 100) {
        warnings.push(`Вход в акцию не завершится за одно обновление: лимит шага ${stepPct}% не даёт сразу выйти на акционную цену. ` +
          'Включите «игнорировать лимит изменения цены при входе в акцию» в параметрах репрайсера.');
      }
    }
  }

  // ── удержание: товар выведен из автоакции и ждёт её окончания ──
  // Если скидка снова станет не ниже порога акции, WB подхватит товар обратно —
  // получится «пинг-понг». Поэтому держим скидку ниже порога, а не просто цену.
  const hold = ctx.promoHold;
  const holdActive = !!(hold && (num(hold.maxDiscountPct) > 0 || num(hold.minPrice) > 0));
  if (holdActive && num(hold.minPrice) > 0 && finalPrice < num(hold.minPrice) - 0.01) {
    finalPrice = r2(num(hold.minPrice));
    layers.push({ layer: 'Акции', name: 'Удержание после выхода', price: finalPrice, note: hold.reason || '' });
    notes.push(`Товар выведен из акции (${(hold.promoNames || []).join(', ') || 'акция'}) и ждёт окончания автоакции: ` +
      `цена не опускается ниже ${Math.round(finalPrice)} ₽, иначе WB вернёт товар в акцию.`);
  }

  // ── ограничение шага за одно обновление ──
  const maxStepPct = num(C.limits.maxChangePerUpdatePct);
  let limitedBy = null;
  const belowMin = curSeller < priceFloor - 0.01;
  const ignoreStep = belowMin && !!C.limits.ignoreStepIfBelowMin;
  // headroom — на сколько ещё можно сдвинуть цену, не нарушив ни один лимит
  let headroom = Infinity;
  if (maxStepPct > 0 && !promoBypass) {
    const maxDelta = curSeller * maxStepPct / 100;
    const exceeds = Math.abs(finalPrice - curSeller) > maxDelta;
    if (exceeds && ignoreStep) {
      // цена ниже минимального порога: лимит шага намеренно игнорируется,
      // чтобы за одно обновление выйти из убытка (рекомендованное поведение)
      limitedBy = 'below-min';
      headroom = 0;
      finalPrice = Math.max(finalPrice, priceFloor);
      notes.push(`Текущая цена ниже минимального порога → ограничение шага ${maxStepPct}% проигнорировано, цена поднята до порога ${Math.round(priceFloor)} ₽.`);
    } else if (exceeds) {
      const dir = finalPrice > curSeller ? 1 : -1;
      // округление в «безопасную» сторону, чтобы не превысить лимит шага
      finalPrice = dir > 0 ? Math.floor(curSeller + maxDelta) : Math.ceil(curSeller - maxDelta);
      limitedBy = 'step';
      headroom = 0;
      notes.push(`Ограничение шага ${maxStepPct}% за обновление: цена изменится не более чем до ${Math.round(finalPrice)} ₽.`);
      if (belowMin && finalPrice < priceFloor) warnings.push('Цена всё ещё ниже минимального порога — потребуется несколько обновлений.');
    } else {
      headroom = Math.max(0, maxDelta - Math.abs(finalPrice - curSeller));
    }
  }
  if (ignoreStep && finalPrice < priceFloor - 0.01) {
    finalPrice = priceFloor;
    limitedBy = limitedBy || 'below-min';
    notes.push('Цена поднята до минимального порога.');
  }

  // ── ограничение изменения за сутки ──
  const maxDayPct = num(C.limits.maxChangePerDayPct);
  const dayStart = num(ctx.priceDayStart, curSeller);
  if (maxDayPct > 0 && dayStart > 0 && !promoBypass) {
    const maxDelta = dayStart * maxDayPct / 100;
    if (Math.abs(finalPrice - dayStart) > maxDelta) {
      const dir = finalPrice > dayStart ? 1 : -1;
      finalPrice = dir > 0 ? Math.floor(dayStart + maxDelta) : Math.ceil(dayStart - maxDelta);
      limitedBy = limitedBy || 'day';
      headroom = 0;
      notes.push(`Суточный лимит ${maxDayPct}%: не более ${Math.round(finalPrice)} ₽ за день.`);
    } else {
      headroom = Math.min(headroom, Math.max(0, maxDelta - Math.abs(finalPrice - dayStart)));
    }
  }

  // ── карантин цен WB ──
  const quarantine = curSeller > 0 && finalPrice < curSeller / 3;
  if (quarantine) {
    if (C.limits.blockQuarantine) {
      finalPrice = Math.max(finalPrice, curSeller / 3 + 1);
      warnings.push('Карантин цен WB: падение более чем в 3 раза заблокировано, цена поднята до безопасной.');
    } else {
      warnings.push('ВНИМАНИЕ: цена упадёт более чем в 3 раза — WB отправит товар в карантин.');
    }
  }

  // ── СЛОЙ 3: красивая цена (всегда последней, только округляет итог) ──
  const bp = I.beautifulPrice || C.defaults.beautifulPrice;
  if (bp && bp.enabled) {
    const before = finalPrice;
    finalPrice = beautifulPrice(finalPrice, bp, headroom === Infinity ? null : headroom);
    finalPrice = Math.min(Math.max(finalPrice, priceFloor > 0 ? priceFloor : 1), corridorMax);
    if (Math.abs(finalPrice - before) > 0.01) {
      notes.push(`Красивая цена (…${bp.ending}, ${bp.mode}): ${Math.round(before)} → ${Math.round(finalPrice)} ₽.`);
      layers.push({ layer: 'Красивая цена', name: `Окончание …${bp.ending}`, price: r2(finalPrice), note: `округление ${Math.round(before)} → ${Math.round(finalPrice)} ₽` });
    }
  }

  finalPrice = Math.max(1, Math.round(finalPrice));

  // ── перевод в (базовая цена, скидка) ──
  let pair = promoExitPair
    ? { basePrice: promoExitPair.basePrice, discount: promoExitPair.discount, mode: 'promo-exit' }
    : toBaseAndDiscount(finalPrice, { basePrice: curBase, discount: curDisc }, C, I);

  // если товар остаётся в акции (или входит в неё), скидка обязана быть не ниже порога акции,
  // иначе WB выведет товар из акции сам — даже когда мы этого не хотим
  const discFloor = num(promoPlan.discountFloor);
  if (!promoExitPair && discFloor > 0 && num(pair.discount) < discFloor) {
    const base = Math.max(1, Math.round(Math.max(finalPrice, 1) / (1 - discFloor / 100)));
    pair = { basePrice: base, discount: discFloor, mode: 'promo-discount-floor' };
    notes.push(`Скидка ${discFloor}% — не ниже порога акции, иначе WB выведет товар из акции.`);
  }

  // для выхода из акции: какую цену вернуть, когда WB фактически выведет товар
  if (promoPlan.chosen && promoPlan.chosen.type === 'exit') {
    // возврат — зеркало выхода: базовую цену не раздуваем, подбираем скидку под рабочую цену
    const rp = pairForSellerPrice(curBase, num(promoPlan.chosen.restoreSellerPrice));
    promoPlan.chosen.restorePair = {
      basePrice: rp.basePrice,
      discount: rp.discount,
      sellerPrice: rp.sellerPrice,
      mode: 'promo-restore'
    };
  }
  // удержание после выхода из автоакции: скидка обязана остаться ниже порога акции,
  // иначе WB вернёт товар обратно. Цену при этом сохраняем, снижая базовую цену.
  if (holdActive && !promoExitPair && num(hold.maxDiscountPct) > 0 && num(pair.discount) >= num(hold.maxDiscountPct) - 1e-9) {
    const sellerNow = pair.sellerPrice !== undefined ? pair.sellerPrice : r2(pair.basePrice * (1 - pair.discount / 100));
    const refit = exitPairForPromo(num(pair.basePrice), num(hold.maxDiscountPct), sellerNow, {
      canChangeBasePrice: (C.priceEdit || {}).canChangeBasePrice,
      canCancelDiscount: (C.priceEdit || {}).canCancelDiscount,
      stepLimitPct: 0,
      curSeller: sellerNow
    });
    pair = { basePrice: refit.basePrice, discount: refit.discount, mode: 'promo-hold' };
    notes.push(`Скидка ${refit.discount}% удерживается ниже порога автоакции (${r2(num(hold.maxDiscountPct))}%), чтобы WB не вернул товар в акцию.`);
  }

  const newSeller = pair.sellerPrice !== undefined ? pair.sellerPrice : r2(pair.basePrice * (1 - pair.discount / 100));

  const changeAbs = newSeller - curSeller;
  const changePct = curSeller > 0 ? (changeAbs / curSeller) * 100 : 0;
  const needSend = Math.abs(changeAbs) >= 0.5 || Math.abs(pair.basePrice - curBase) >= 0.5 || Math.abs(pair.discount - curDisc) >= 0.05;
  /**
   * Флаг «Отправка в WB» (задание D) — выключается прямо в строке таблицы.
   * Цена при этом продолжает рассчитываться и показываться: товар остаётся
   * в таблице со всеми цифрами, но в предложение и в кабинет не уходит.
   */
  const allowSend = ctx.allowSend !== false;

  const econBefore = marginOf(marginCtx, curSeller);
  const econAfter = marginOf(marginCtx, newSeller);
  // Вход в акцию снижает прибыль с единицы, но даёт прирост продаж —
  // иначе решение выглядело бы убыточным даже тогда, когда оно выгодно.
  const promoJoin = !!(promoPlan.chosen && promoPlan.chosen.type === 'join');
  const upliftPctUsed = promoJoin ? num(promoPlan.chosen.expectedSalesUpliftPct, num((C.promo || {}).expectedSalesUpliftPct, 30)) : 0;
  const upliftFactor = 1 + upliftPctUsed / 100;
  const perDay = num(ctx.salesPerDay);
  const deltaProfitMonth = econAfter.profit * perDay * 30 * upliftFactor - econBefore.profit * perDay * 30;

  // себестоимость введена в валюте, курс которой не задан: расчёт без себестоимости
  if (ctx.costError) warnings.push(String(ctx.costError) + ' — себестоимость в расчёте не учтена.');
  if (!allowSend && needSend) warnings.push('Отправка в WB отключена для товара: цена рассчитана, но в кабинет не уйдёт.');

  if (econAfter.profit < 0 && !allowNeg) warnings.push('Новая цена даёт убыток. Проверьте минимальный порог и себестоимость.');
  else if (econAfter.marginPct < targetMargin - 0.5) warnings.push(`Маржа ${econAfter.marginPct.toFixed(1)}% ниже целевой ${targetMargin}%.`);

  return {
    nmID: ctx.nmID,
    vendorCode: ctx.vendorCode || '',
    title: ctx.title || '',
    strategy: strategyName,
    strategyTitle: (STRATEGIES.find((s) => s.id === strategyName) || {}).name || strategyName,
    current: {
      basePrice: curBase, discount: r2(curDisc), sellerPrice: r2(curSeller), buyerPrice: r2(curBuyer),
      costPriceRub: num(ctx.params && ctx.params.costPriceRub),
      profit: econBefore.profit, marginPct: r2(econBefore.marginPct),
      // прозрачность: откуда взяты расходы (факт из отчёта WB, справочник, настройки, формула)
      costSources: (ctx.params && ctx.params.costSources) || null,
      factLogistics: num(ctx.params && ctx.params.logisticsRub) || 0,
      factCommissionPct: num(ctx.params && ctx.params.commissionPct) || 0,
      factWindowDays: num(ctx.factWindowDays) || 0
    },
    proposed: {
      basePrice: pair.basePrice, discount: r2(pair.discount), sellerPrice: r2(newSeller),
      buyerPrice: r2(newSeller * (1 - num(ctx.sppPct) / 100) * (1 - num(C.priceEdit.walletPct) / 100)),
      profit: econAfter.profit, marginPct: r2(econAfter.marginPct),
      priceMode: pair.mode
    },
    delta: {
      abs: r2(changeAbs), pct: r2(changePct),
      profitPerUnit: r2(econAfter.profit - econBefore.profit), profitMonth: r2(deltaProfitMonth),
      // для входа в акцию — какой прирост продаж заложен и когда он окупается
      salesUpliftPct: promoJoin ? r2(upliftPctUsed) : 0,
      profitMonthNow: promoJoin ? r2(econBefore.profit * perDay * 30) : null,
      profitMonthWithPromo: promoJoin ? r2(econAfter.profit * perDay * 30 * upliftFactor) : null,
      breakEvenUpliftPct: promoJoin ? (promoPlan.chosen.breakEvenUpliftPct === undefined ? null : promoPlan.chosen.breakEvenUpliftPct) : null
    },
    corridor: { min: r2(priceFloor), max: r2(corridorMax), minByMargin: minByMargin === null ? null : r2(minByMargin) },
    needSend: needSend && allowSend,
    allowSend,
    tag: ctx.tag ? String(ctx.tag) : '',
    barcode: ctx.barcode ? String(ctx.barcode) : '',
    /**
     * ── Блоки таблицы репрайсера (задание D) ──
     * Всё, что нужно для решения по цене, отдаётся одной строкой: себестоимость
     * с валютой и курсом, слагаемые расходов, цена с СПП и кошельком, пороги
     * и данные акций. Интерфейс рисует из них блоки колонок.
     */
    cost: {
      currency: String(ctx.costCurrency || 'RUB'),
      rate: num(ctx.costRate, 1),
      entered: (ctx.costEntered === undefined || ctx.costEntered === null || ctx.costEntered === '') ? null : num(ctx.costEntered),
      rub: num(ctx.params && ctx.params.costPriceRub),
      error: ctx.costError || null,
      now: econSummary(econBefore.econ),
      next: econSummary(econAfter.econ)
    },
    wallet: {
      sppPct: r2(num(ctx.sppPct)),
      walletPct: r2(num(C.priceEdit.walletPct)),
      nowBuyer: r2(curBuyer),
      nextBuyer: r2(newSeller * (1 - num(ctx.sppPct) / 100) * (1 - num(C.priceEdit.walletPct) / 100))
    },
    promo: {
      inPromo: !!ctx.inPromo,
      discountFloor: r2(num(promoPlan.discountFloor)),
      plannedPrice: num(ctx.promoPrice, 0) || 0,
      plannedDiscount: r2(num(ctx.promoDiscountPct)),
      chosen: promoPlan.chosen || null,
      restorePair: (promoPlan.chosen && promoPlan.chosen.restorePair) || null,
      holdDiscountMax: num((ctx.promoHold || {}).maxDiscountPct) || 0
    },
    floor: {
      min: r2(priceFloor),
      max: r2(corridorMax),
      corridorMin: r2(corridorMin),
      minByMargin: minByMargin === null ? null : r2(minByMargin),
      // чем задан пол: порогом минимальной цены или минимальной маржинальностью
      by: (minByMargin !== null && minByMargin > corridorMin) ? 'margin' : 'corridor',
      minPriceSet: minPrice > 0 ? r2(minPrice) : null,
      basePriceTarget: r2(basePriceTarget)
    },
    limitedBy,
    quarantine,
    layers,
    notes,
    warnings,
    promoActions: promoPlan.actions,
    promoChosen: promoPlan.chosen,
    context: {
      stock: num(ctx.stock), salesPerDay: num(ctx.salesPerDay), turnoverDays: num(ctx.turnoverDays),
      sppForecastPct: promoPlan.sppForecastPct,
      inPromo: !!ctx.inPromo, promoPrice: promoPrice, competitor: comp ? comp.source : null,
      // цена подставлена из sizes[] — товар с поразмерными ценами (WB не отдаёт price целиком)
      priceFromSizes: !!ctx.priceFromSizes,
      sizePriceMin: num(ctx.sizePriceMin) || 0, sizePriceMax: num(ctx.sizePriceMax) || 0,
      // режим цен по размерам (none/sync/manual) — берётся из настроек товара/общих
      sizePriceMode: ['none', 'sync', 'manual'].indexOf(I.sizePriceMode) >= 0 ? I.sizePriceMode : 'none',
      competitorPrice: comp ? comp.price : null,
      plan: planProgress(marginCtx, I),
      marginMode: C.marginMode,
      at: new Date(now).toISOString()
    }
  };
}

/** Пакетный пересчёт по всему каталогу. */
function computeAll(items, cfg, itemCfgMap, ec) {
  const out = [];
  for (const ctx of items) {
    try {
      out.push(computeItem(ctx, cfg, (itemCfgMap || {})[String(ctx.nmID)] || {}, ec));
    } catch (e) {
      out.push({ nmID: ctx.nmID, vendorCode: ctx.vendorCode || '', error: e.message || String(e) });
    }
  }
  return out;
}

/**
 * Сводка по результатам пересчёта (для отчёта и дашборда).
 * Терпима к «голым» строкам без полного расчёта (например, список цен на отправку).
 */
function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter((r) => r && !r.error);
  const toSend = ok.filter((r) => r.needSend);
  const dAbs = (r) => num(r.delta && r.delta.abs);
  const cur = (r) => num(r.current && r.current.sellerPrice);
  const next = (r) => num(r.proposed && r.proposed.sellerPrice);
  const spd = (r) => num(r.context && r.context.salesPerDay);
  return {
    total: list.length,
    errors: list.length - ok.length,
    toSend: toSend.length,
    unchanged: ok.length - toSend.length,
    up: toSend.filter((r) => dAbs(r) > 0).length,
    down: toSend.filter((r) => dAbs(r) < 0).length,
    warnings: ok.filter((r) => r.warnings && r.warnings.length).length,
    limitedByStep: ok.filter((r) => r.limitedBy === 'step').length,
    liftedToFloor: ok.filter((r) => r.limitedBy === 'below-min').length,
    promoJoin: ok.filter((r) => r.promoChosen && r.promoChosen.type === 'join').length,
    promoExit: ok.filter((r) => r.promoChosen && r.promoChosen.type === 'exit').length,
    promoStay: ok.filter((r) => (r.promoActions || []).some((a) => a.action === 'stay')).length,
    promoRecommend: ok.filter((r) => (r.promoActions || []).some((a) => a.action === 'recommend')).length,
    promoSkip: ok.filter((r) => (r.promoActions || []).some((a) => a.action === 'skip')).length,
    promoWarn: ok.filter((r) => (r.promoActions || []).some((a) => a.action === 'warn')).length,
    quarantine: ok.filter((r) => r.quarantine).length,
    profitDeltaMonth: r2(ok.reduce((s, r) => s + num(r.delta && r.delta.profitMonth), 0)),
    // оценка эффекта от решений по акциям (прибыль с единицы падает, продажи растут)
    promoProfitDeltaMonth: r2(ok.reduce((s, r) => {
      const ch = r.promoChosen;
      return ch && ch.type === 'join' ? s + num(ch.profitMonthDelta) : s;
    }, 0)),
    revenueDeltaPct: (function () {
      const a = ok.reduce((s, r) => s + cur(r) * spd(r), 0);
      const b = ok.reduce((s, r) => s + next(r) * spd(r), 0);
      return a > 0 ? r2(((b - a) / a) * 100) : 0;
    })(),
    byStrategy: ok.reduce((acc, r) => {
      const k = r.strategyTitle || 'Без стратегии';
      acc[k] = (acc[k] || 0) + (r.needSend ? 1 : 0);
      return acc;
    }, {})
  };
}

function mergeConfig(user) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const src = user || {};
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && out[k] && typeof out[k] === 'object') {
      Object.assign(out[k], src[k]);
    } else out[k] = src[k];
  }
  return out;
}

function itemConfig(defaults, user) {
  return Object.assign({}, defaults || {}, user || {});
}

return {
  DEFAULT_CONFIG,
  STRATEGIES,
  beautifulPrice,
  planPromos,
  toBaseAndDiscount,
  pairForSellerPrice,
  exitPairForPromo,
  marginOf,
  priceForMargin,
  bestCompetitorPrice,
  planProgress,
  valueStatus,
  computeItem,
  computeAll,
  summarize,
  mergeConfig,
  itemConfig,
  num,
  r2
};

});
