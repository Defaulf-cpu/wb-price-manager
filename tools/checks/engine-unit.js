'use strict';

/**
 * Unit-проверки чистых модулей EC и RP.
 * Не загружают service/store, DOM, jsdom и не выполняют сетевые запросы.
 * Запуск: node tools/checks/engine-unit.js
 */

// Фиксируем календарь тестов: planProgress использует локальные компоненты Date.
process.env.TZ = 'UTC';

const EC = require('../../electron/economics');
const RP = require('../../electron/repricer-engine');

const TOL = 0.01; // ₽ и процентные пункты
let pass = 0;
let fail = 0;
let expectedFail = 0;
const failures = [];

function printable(value) {
  try {
    return JSON.stringify(value, (key, item) => typeof item === 'function' ? '[Function]' : item);
  } catch (e) {
    return String(value);
  }
}

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('OK   ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function readActual(actual) {
  try {
    return { value: typeof actual === 'function' ? actual() : actual };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

function numberCase(name, input, expected, actual, tolerance) {
  const got = readActual(actual);
  const limit = tolerance === undefined ? TOL : tolerance;
  const value = got.value;
  const ok = !got.error && typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= limit;
  const detail = 'вход=' + printable(input) + '; ожидание=' + expected + '; факт=' + (got.error ? 'ошибка: ' + got.error : printable(value)) + '; допуск=' + limit;
  check(name, ok, detail);
}

function valueCase(name, input, expected, actual) {
  const got = readActual(actual);
  const value = got.value;
  const ok = !got.error && Object.is(value, expected);
  const detail = 'вход=' + printable(input) + '; ожидание=' + printable(expected) + '; факт=' + (got.error ? 'ошибка: ' + got.error : printable(value));
  check(name, ok, detail);
}

/** Несовпадение отображается как XFAIL, не маскируется и не портит зелёный exit code. */
function expectedFailNumber(name, input, expected, actual, reason, tolerance) {
  const got = readActual(actual);
  const limit = tolerance === undefined ? TOL : tolerance;
  const value = got.value;
  const matches = !got.error && typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= limit;
  const detail = 'вход=' + printable(input) + '; ожидание=' + expected + '; факт=' + (got.error ? 'ошибка: ' + got.error : printable(value)) +
    '; допуск=' + limit + '; причина: ' + reason;
  if (matches) {
    pass++;
    console.log('OK   ' + name + ' (ожидаемое расхождение устранено)');
  } else {
    expectedFail++;
    console.log('XFAIL ' + name + ' — ' + detail);
  }
}

function econParams(patch) {
  return Object.assign({
    commissionPct: 20,
    acquiringPct: 2,
    taxRatePct: 6,
    adPct: 5,
    adRub: 10,
    logisticsRub: 50,
    logisticsBaseRub: 50,
    logisticsPerLiterRub: 15,
    literThreshold: 5,
    logisticsLargeRub: 145,
    acceptRub: 10,
    storageRub: 3,
    packagingRub: 4,
    costPriceRub: 100,
    sppPct: 20,
    targetMarginPct: 20
  }, patch || {});
}

function basicEcon(price) {
  return {
    revenue: price,
    profit: price - 400,
    marginPct: price > 0 ? ((price - 400) / price) * 100 : 0
  };
}

function engineConfig(patch) {
  const base = {
    enabled: true,
    marginMode: 'discounted',
    priceEdit: { canChangeBasePrice: 'allow', canCancelDiscount: true, walletPct: 0 },
    limits: { maxChangePerUpdatePct: 0, maxChangePerDayPct: 0, ignoreStepIfBelowMin: true, blockQuarantine: true },
    defaults: {
      strategy: 'hold', targetMarginPct: 20, minMarginPct: 0, allowNegativeMargin: true,
      oosProtection: false, targetTurnoverDays: 7, promoUpliftPct: 0,
      liquidationTurnoverDays: 60, liquidationDiscountPct: 0,
      beautifulPrice: { enabled: false, ending: 9, mode: 'nearest' }, sppMode: 0
    }
  };
  const src = patch || {};
  const merged = Object.assign({}, base, src);
  merged.priceEdit = Object.assign({}, base.priceEdit, src.priceEdit || {});
  merged.limits = Object.assign({}, base.limits, src.limits || {});
  merged.defaults = Object.assign({}, base.defaults, src.defaults || {});
  if (src.defaults && src.defaults.beautifulPrice) {
    merged.defaults.beautifulPrice = Object.assign({}, base.defaults.beautifulPrice, src.defaults.beautifulPrice);
  }
  return RP.mergeConfig(merged);
}

function engineContext(patch) {
  return Object.assign({
    nmID: 101,
    vendorCode: 'UNIT-101',
    title: 'Unit test item',
    basePrice: 1000,
    discount: 0,
    sellerPrice: 1000,
    buyerPrice: 1000,
    minPrice: 0,
    basePriceTarget: 1000,
    stock: 0,
    salesPerDay: 0,
    salesMonthQty: 0,
    turnoverDays: 7,
    inPromo: false,
    promoPrice: null,
    promoDiscountPct: 0,
    competitors: [],
    forPayAvg: 1000,
    sppPct: 0,
    sppFactAvg: 0,
    walletPct: 0,
    params: { costPriceRub: 100, costSources: { costPriceRub: 'manual' } },
    econAt: basicEcon,
    now: Date.UTC(2024, 1, 15, 12, 0, 0),
    priceFromSizes: false,
    sizePriceMin: 0,
    sizePriceMax: 0
  }, patch || {});
}

console.log('=== UMD и общие границы ===');
check('EC доступен как CommonJS и global EC', global.EC === EC && typeof EC.calcUnit === 'function');
check('RP доступен как CommonJS и global RP', global.RP === RP && typeof RP.computeItem === 'function');

console.log('\n=== Экономика: логистика и тарифы ===');
const logisticsCases = [
  { name: 'логистика: объём не задан — базовый тариф', p: { logisticsRub: 0, volumeLiters: undefined, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 50 },
  { name: 'логистика: нулевой объём — базовый тариф', p: { logisticsRub: 0, volumeLiters: 0, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 50 },
  { name: 'логистика: отрицательный объём — базовый тариф', p: { logisticsRub: 0, volumeLiters: -2, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 50 },
  { name: 'логистика: 1 л — только базовый тариф', p: { logisticsRub: 0, volumeLiters: 1, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 50 },
  { name: 'логистика: 2 л — база плюс один литр', p: { logisticsRub: 0, volumeLiters: 2, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 65 },
  { name: 'логистика: ровно порог 5 л остаётся по формуле', p: { logisticsRub: 0, volumeLiters: 5, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 110 },
  { name: 'логистика: выше порога применяется крупный тариф', p: { logisticsRub: 0, volumeLiters: 5.01, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 145 },
  { name: 'логистика: положительный фикс перекрывает объёмную формулу', p: { logisticsRub: 77, volumeLiters: 10, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 77 },
  { name: 'логистика: пользовательские тарифы и порог', p: { logisticsRub: 0, volumeLiters: 3, logisticsBaseRub: 40, logisticsPerLiterRub: 7.5, literThreshold: 4, logisticsLargeRub: 99 }, expected: 55 },
  { name: 'логистика: пользовательский крупный тариф', p: { logisticsRub: 0, volumeLiters: 4.1, logisticsBaseRub: 40, logisticsPerLiterRub: 7.5, literThreshold: 4, logisticsLargeRub: 99 }, expected: 99 },
  { name: 'логистика: отрицательный фикс не перекрывает расчёт по объёму', p: { logisticsRub: -5, volumeLiters: 2, logisticsBaseRub: 50, logisticsPerLiterRub: 15, literThreshold: 5, logisticsLargeRub: 145 }, expected: 65 }
];
logisticsCases.forEach((c) => numberCase(c.name, c.p, c.expected, () => EC.calcLogistics(c.p)));

const catLogisticsSettings = {
  logisticsBaseRub: 50,
  logisticsPerLiterRub: 10,
  literThreshold: 5,
  logisticsLargeRub: 150,
  categoryDefaults: {
    Обувь: { logisticsBaseRub: 70, logisticsPerLiterRub: 20, literThreshold: 3, logisticsLargeRub: 240 }
  }
};
const catVolumeParams = EC.resolveParams(catLogisticsSettings, { categoryName: 'Обувь', volumeLiters: 2 }, {}, {});
const catLargeParams = EC.resolveParams(catLogisticsSettings, { categoryName: 'Обувь', volumeLiters: 4 }, {}, {});
numberCase(
  'логистика: категория должна применять собственные базу и тариф за литр',
  { categoryName: 'Обувь', volumeLiters: 2, categoryTariff: { base: 70, perLiter: 20 }, globalTariff: { base: 50, perLiter: 10 } },
  90, () => EC.calcLogistics(catVolumeParams));
numberCase(
  'логистика: категория должна применять собственный порог и крупный тариф',
  { categoryName: 'Обувь', volumeLiters: 4, categoryTariff: { threshold: 3, large: 240 }, globalTariff: { threshold: 5, large: 150 } },
  240, () => EC.calcLogistics(catLargeParams));

console.log('\n=== Экономика: разрешение параметров и источники ===');
const categorySettings = {
  commissionDefault: 23,
  adPctDefault: 4,
  packagingRub: 7,
  taxMode: 'usn6',
  categoryDefaults: { Обувь: { commissionPct: 19.5, adPct: 9, packagingRub: 18, taxMode: 'none' } }
};
const categoryParams = EC.resolveParams(categorySettings, { categoryName: 'Обувь' }, {}, {});
numberCase('категория: комиссия берётся из справочника', { categoryName: 'Обувь', settings: categorySettings }, 19.5, () => categoryParams.commissionPct);
numberCase('категория: реклама берётся из справочника', { categoryName: 'Обувь', settings: categorySettings }, 9, () => categoryParams.adPct);
numberCase('категория: упаковка берётся из справочника', { categoryName: 'Обувь', settings: categorySettings }, 18, () => categoryParams.packagingRub);
numberCase('категория: taxMode переопределяется справочником', { categoryName: 'Обувь', settings: categorySettings }, 0, () => categoryParams.taxRatePct);
numberCase('ручная комиссия выше категории и глобальной настройки', { override: 12, category: 19.5, global: 23 }, 12,
  () => EC.resolveParams(categorySettings, { categoryName: 'Обувь' }, { commissionPct: 12 }, {}).commissionPct);
numberCase('ручная упаковка выше категории', { override: 2, category: 18 }, 2,
  () => EC.resolveParams(categorySettings, { categoryName: 'Обувь' }, { packagingRub: 2 }, {}).packagingRub);

const expenseFacts = {
  salesQty: 4,
  commissionPctAvg: 14,
  logisticsAvg: 33,
  storageAvg: 7,
  acceptanceAvg: 8,
  acquiringPctAvg: 3
};
const factSettings = Object.assign({}, categorySettings, { useFactCosts: true });
const factParams = EC.resolveParams(factSettings, { categoryName: 'Обувь', volumeLiters: 2 }, {}, expenseFacts);
numberCase('факт продаж: комиссия выше категории', { salesQty: 4, commissionPctAvg: 14 }, 14, () => factParams.commissionPct);
numberCase('факт отчёта: логистика за продажу', { salesQty: 4, logisticsAvg: 33 }, 33, () => factParams.logisticsRub);
numberCase('факт отчёта: хранение', { salesQty: 4, storageAvg: 7 }, 7, () => factParams.storageRub);
numberCase('факт отчёта: приёмка', { salesQty: 4, acceptanceAvg: 8 }, 8, () => factParams.acceptRub);
numberCase('факт отчёта: эквайринг', { salesQty: 4, acquiringPctAvg: 3 }, 3, () => factParams.acquiringPct);
const manualFactParams = EC.resolveParams(factSettings, { categoryName: 'Обувь' }, {
  commissionPct: 11, logisticsRub: 44, storageRub: 5, acceptRub: 6, acquiringPct: 1
}, expenseFacts);
numberCase('ручная комиссия выше факта', { manual: 11, fact: 14 }, 11, () => manualFactParams.commissionPct);
numberCase('ручная логистика выше факта', { manual: 44, fact: 33 }, 44, () => manualFactParams.logisticsRub);
numberCase('ручное хранение выше факта', { manual: 5, fact: 7 }, 5, () => manualFactParams.storageRub);
numberCase('ручная приёмка выше факта', { manual: 6, fact: 8 }, 6, () => manualFactParams.acceptRub);
numberCase('ручной эквайринг выше факта', { manual: 1, fact: 3 }, 1, () => manualFactParams.acquiringPct);
const zeroFactParams = EC.resolveParams(factSettings, { categoryName: 'Обувь' }, {}, Object.assign({}, expenseFacts, { commissionPctAvg: 0, logisticsAvg: 0 }));
numberCase('нулевой факт комиссии пропускается в пользу категории', { fact: 0, category: 19.5 }, 19.5, () => zeroFactParams.commissionPct);
numberCase('нулевой факт логистики остаётся не заданным', { fact: 0, noManualLogistics: true }, 0, () => zeroFactParams.logisticsRub);
const factOffParams = EC.resolveParams(Object.assign({}, factSettings, { useFactCosts: false }), { categoryName: 'Обувь' }, {}, expenseFacts);
numberCase('useFactCosts=false выключает факт комиссии', { setting: false, factCommission: 14 }, 19.5, () => factOffParams.commissionPct);
numberCase('useFactCosts=false выключает факт логистики', { setting: false, factLogistics: 33 }, 0, () => factOffParams.logisticsRub);
valueCase('useFactCosts=false отмечает фактические расходы отсутствующими', { setting: false }, null, () => factOffParams.factCosts);

console.log('\n=== Экономика: комиссия, расходы, налог, прибыль ===');
const fullParams = econParams();
const fullUnit = EC.calcUnit(1000, fullParams);
const fullUnitCases = [
  ['комиссия по проценту', 'commission', 200],
  ['эквайринг по проценту', 'acquiring', 20],
  ['логистика в сумме WB', 'logistics', 50],
  ['приёмка', 'accept', 10],
  ['хранение', 'storage', 3],
  ['упаковка', 'packaging', 4],
  ['себестоимость', 'cogs', 100],
  ['реклама (процент плюс рубли)', 'ad', 60],
  ['рекламная процентная часть', 'adPctSum', 50],
  ['налог', 'tax', 60],
  ['итого удержания WB', 'wbTotal', 283],
  ['все расходы', 'totalCosts', 507],
  ['фиксированная часть затрат', 'fixedCosts', 177],
  ['сумма ставок процентных расходов', 'pctCosts', 33],
  ['прибыль до налога', 'profitBeforeTax', 553],
  ['прибыль после налога', 'profit', 493],
  ['маржинальность от выручки, %', 'marginPct', 49.3],
  ['наценка на себестоимость, %', 'markupPct', 493],
  ['цена покупателю после СПП', 'buyerPrice', 800],
  ['цена безубыточности', 'breakEvenPrice', 264.18],
  ['цена для целевой маржи из параметров', 'minPriceForMargin', 376.6]
];
fullUnitCases.forEach(([name, field, expected]) => numberCase(name, { sellerPrice: 1000, params: fullParams, field }, expected, () => fullUnit[field]));
numberCase('цена безубыточности через отдельную функцию', { fixed: 177, pctCosts: 33 }, 264.18, () => EC.calcBreakEvenPrice(fullParams));
numberCase('цена под целевую маржу 20%', { fixed: 177, pctCosts: 33, targetMarginPct: 20 }, 376.6, () => EC.calcPriceForMarginPct(fullParams, 20));
numberCase('цена под целевую прибыль 100 ₽', { fixed: 177, pctCosts: 33, targetProfitRub: 100 }, 413.43, () => EC.calcPriceForProfitRub(fullParams, 100));
valueCase('безубыточность недостижима при ставках 100%', { commissionPct: 100 }, null,
  () => EC.calcBreakEvenPrice(econParams({ commissionPct: 100 })));
valueCase('целевая маржа недостижима при ставках выше 100%', { commissionPct: 101 }, null,
  () => EC.calcPriceForMarginPct(econParams({ commissionPct: 101 }), 0));
valueCase('целевая прибыль недостижима при ставках 100%', { commissionPct: 100 }, null,
  () => EC.calcPriceForProfitRub(econParams({ commissionPct: 100 }), 50));

console.log('\n=== Экономика: налоговые режимы ===');
const taxCases = [
  { mode: 'usn6', rate: 6 },
  { mode: 'usn15', rate: 15 },
  { mode: 'nds20', rate: 20 },
  { mode: 'selfemployed', rate: 4 },
  { mode: 'none', rate: 0 }
];
taxCases.forEach((c) => {
  const p = EC.resolveParams({ taxMode: c.mode }, {}, {}, {});
  numberCase('налоговый режим ' + c.mode + ': ставка', { taxMode: c.mode }, c.rate, () => p.taxRatePct);
  numberCase('налоговый режим ' + c.mode + ': налог с 1000 ₽', { taxMode: c.mode, revenue: 1000 }, c.rate * 10,
    () => EC.calcUnit(1000, Object.assign(econParams(), { taxRatePct: p.taxRatePct })).tax);
});
valueCase('название режима налога локализовано', { id: 'usn6' }, 'УСН «Доходы» 6%', () => EC.taxModeLabel('usn6'));
valueCase('неизвестный режим возвращает свой id', { id: 'custom' }, 'custom', () => EC.taxModeLabel('custom'));

console.log('\n=== Экономика: СПП, цена, маржа и границы ===');
const spp20 = EC.calcUnit(1000, econParams({ sppPct: 20 }));
const spp0 = EC.calcUnit(1000, econParams({ sppPct: 0 }));
numberCase('СПП 20% снижает только цену покупателя', { revenue: 1000, sppPct: 20 }, 800, () => spp20.buyerPrice);
numberCase('СПП не вычитается из выручки продавца', { sppPct: 20 }, 1000, () => spp20.revenue);
numberCase('СПП не снижает прибыль продавца', { sppPct: 20 }, spp0.profit, () => spp20.profit);
const sppItem = EC.analyze({}, { nmID: 7, price: 1000, discount: 0, sppPct: 20 }, { costPriceRub: 100 }, {});
numberCase('цена без скидки продавца — цена продажи равна базе', { basePrice: 1000, discountPct: 0 }, 1000, () => sppItem.current.revenue);
numberCase('analyze сохраняет СПП в параметрах товара', { sppPct: 20 }, 20, () => sppItem.params.sppPct);
numberCase('обратный расчёт базы при скидке 20%', { discountPct: 20, sellerPrice: 800 }, 1000, () => EC.basePriceFor(20, 800));
valueCase('обратный расчёт невозможен при скидке 100%', { discountPct: 100, sellerPrice: 800 }, null, () => EC.basePriceFor(100, 800));
const fullDiscount = EC.analyze({}, { nmID: 8, price: 1000, discount: 100 }, { costPriceRub: 2 }, {});
numberCase('скидка 100% даёт нулевую выручку', { basePrice: 1000, discountPct: 100 }, 0, () => fullDiscount.current.revenue);
numberCase('скидка 100% не делит цену базы на ноль', { discountPct: 100 }, 0, () => fullDiscount.current.marginPct);
valueCase('при скидке 100% минимальная база для маржи не определена', { discountPct: 100 }, null, () => fullDiscount.minBaseForMargin);
valueCase('при скидке 100% база безубыточности не определена', { discountPct: 100 }, null, () => fullDiscount.minBaseBreakEven);
const zeroParams = econParams({
  commissionPct: 0, acquiringPct: 0, taxRatePct: 0, adPct: 0, adRub: 0, logisticsRub: 0,
  logisticsBaseRub: 0, logisticsPerLiterRub: 0, logisticsLargeRub: 0,
  acceptRub: 0, storageRub: 0, packagingRub: 0, costPriceRub: 0, sppPct: 0
});
const zeroUnit = EC.calcUnit(0, zeroParams);
numberCase('нулевая цена — выручка 0', { price: 0 }, 0, () => zeroUnit.revenue);
numberCase('нулевая цена — прибыль 0 при нулевых расходах', { price: 0, costs: 0 }, 0, () => zeroUnit.profit);
numberCase('нулевая цена — маржа не NaN', { price: 0 }, 0, () => zeroUnit.marginPct);
numberCase('нулевая себестоимость не подменяется другим значением', { costPriceRub: 0 }, 0, () => EC.calcUnit(10, zeroParams).cogs);
const cost2 = EC.calcUnit(10, econParams({
  commissionPct: 0, acquiringPct: 0, taxRatePct: 0, adPct: 0, adRub: 0, logisticsRub: 0,
  logisticsBaseRub: 0, logisticsPerLiterRub: 0, logisticsLargeRub: 0, acceptRub: 0, storageRub: 0,
  packagingRub: 0, costPriceRub: 2, sppPct: 0
}));
numberCase('себестоимость ровно 2 ₽ учитывается как расход', { sellerPrice: 10, costPriceRub: 2 }, 2, () => cost2.cogs);
numberCase('при себестоимости ровно 2 ₽ прибыль равна 8 ₽', { sellerPrice: 10, costPriceRub: 2 }, 8, () => cost2.profit);
numberCase('при себестоимости ровно 2 ₽ наценка равна 400%', { sellerPrice: 10, costPriceRub: 2 }, 400, () => cost2.markupPct);
const quarSettings = { quarantineGuard: true };
const qExact = EC.analyze(quarSettings, { price: 900, discount: 0 }, { costPriceRub: 10 }, { basePrice: 300, discountPct: 0 });
const qLower = EC.analyze(quarSettings, { price: 900, discount: 0 }, { costPriceRub: 10 }, { basePrice: 299, discountPct: 0 });
valueCase('экономика: ровно треть цены не включает карантин', { current: 900, next: 300 }, false, () => qExact.quarantineRisk);
valueCase('экономика: падение ниже трети включает карантин', { current: 900, next: 299 }, true, () => qLower.quarantineRisk);

console.log('\n=== Экономика: приоритет источников СПП по §22 ===');
const sppSettings = { sppDefault: 9, useFactCosts: true };
const sppFacts = { sppPctAvg: 17, sppPctWatch: 21, sppWatchSamples: 4, sppWatchAt: '2026-01-02T03:04:05.000Z' };
const sppSources = [
  { name: 'ручной ввод', item: { sppPct: 13 }, overrides: { sppPct: 25 }, facts: sppFacts, expected: 25, source: 'manual' },
  { name: 'наблюдение витрины выше факта', item: { sppPct: 13 }, overrides: {}, facts: sppFacts, expected: 21, source: 'watch' },
  { name: 'статистика продаж выше item.sppPct', item: { sppPct: 13 }, overrides: {}, facts: { sppPctAvg: 17 }, expected: 17, source: 'fact' },
  { name: 'значение карточки товара выше общей настройки', item: { sppPct: 13 }, overrides: {}, facts: {}, expected: 13, source: 'category' },
  { name: 'общая настройка — последний источник', item: {}, overrides: {}, facts: {}, expected: 9, source: 'settings' },
  { name: 'ноль на витрине является значением, не отсутствием данных', item: { sppPct: 13 }, overrides: {}, facts: { sppPctAvg: 17, sppPctWatch: 0 }, expected: 0, source: 'watch' },
  { name: 'некорректный watch СПП пропускается', item: {}, overrides: {}, facts: { sppPctAvg: 17, sppPctWatch: 101 }, expected: 17, source: 'fact' }
];
sppSources.forEach((c) => {
  const p = EC.resolveParams(sppSettings, c.item, c.overrides, c.facts);
  numberCase('СПП: ' + c.name, { item: c.item, overrides: c.overrides, facts: c.facts }, c.expected, () => p.sppPct);
  valueCase('СПП source: ' + c.name, { expectedSource: c.source }, c.source, () => p.costSources.sppPct);
});
const sppStatWithoutExpenseSwitch = EC.resolveParams({ sppDefault: 9, useFactCosts: false }, {}, {}, { sppPctAvg: 17, salesQty: 0 });
numberCase('СПП из статистики не зависит от useFactCosts и salesQty', { useFactCosts: false, salesQty: 0, sppPctAvg: 17 }, 17, () => sppStatWithoutExpenseSwitch.sppPct);
valueCase('СПП из статистики сохраняет источник fact', { useFactCosts: false }, 'fact', () => sppStatWithoutExpenseSwitch.costSources.sppPct);
valueCase('наблюдение сохраняет число замеров и дату', { samples: 4, at: '2026-01-02T03:04:05.000Z' }, true,
  () => sppSources && (() => { const p = EC.resolveParams(sppSettings, {}, {}, sppFacts); return p.sppWatchSamples === 4 && p.sppWatchAt === sppFacts.sppWatchAt && p.sppPctWatch === 21; })());

console.log('\n=== Экономика: факты выше демо, ниже ручных настроек ===');
const demoOverrides = { source: 'demo', commissionPct: 20, logisticsRub: 50, storageRub: 3, acceptRub: 4, acquiringPct: 2, costPriceRub: 100 };
const factOverrideResult = EC.preferFacts(demoOverrides, expenseFacts, { useFactCosts: true });
valueCase('preferFacts возвращает отдельный объект', { source: demoOverrides.source }, false, () => factOverrideResult === demoOverrides);
valueCase('preferFacts удаляет демо-комиссию, если есть факт', { commissionPctAvg: 14 }, false, () => Object.prototype.hasOwnProperty.call(factOverrideResult, 'commissionPct'));
valueCase('preferFacts удаляет демо-логистику, если есть факт', { logisticsAvg: 33 }, false, () => Object.prototype.hasOwnProperty.call(factOverrideResult, 'logisticsRub'));
valueCase('preferFacts сохраняет себестоимость и не затронутые поля', { costPriceRub: 100 }, 100, () => factOverrideResult.costPriceRub);
valueCase('ручные overrides source=user не переписываются', { source: 'user' }, true,
  () => EC.preferFacts(Object.assign({}, demoOverrides, { source: 'user' }), expenseFacts, { useFactCosts: true }).commissionPct === 20);
valueCase('при выключенном useFactCosts preferFacts возвращает исходный объект', { useFactCosts: false }, true,
  () => EC.preferFacts(demoOverrides, expenseFacts, { useFactCosts: false }) === demoOverrides);
valueCase('без продаж preferFacts возвращает исходный объект', { salesQty: 0 }, true,
  () => EC.preferFacts(demoOverrides, Object.assign({}, expenseFacts, { salesQty: 0 }), { useFactCosts: true }) === demoOverrides);

console.log('\n=== Экономика: массовые правила цен ===');
const ruleSettings = {
  commissionDefault: 0, logisticsBaseRub: 0, logisticsPerLiterRub: 0, literThreshold: 5, logisticsLargeRub: 0,
  acceptRub: 0, storageRubPerUnit: 0, packagingRub: 0, adPctDefault: 0, acquiringPct: 0,
  taxRate: 0, taxMode: 'none', targetMarginPct: 20, minMarginPctAlert: 0, useFactCosts: false,
  quarantineGuard: false
};
const ruleItem = { nmID: 1, price: 1000, discount: 0, volumeLiters: 0 };
const ruleOverrides = {
  costPriceRub: 100, commissionPct: 0, acquiringPct: 0, taxRatePct: 0, adPct: 0, adRub: 0,
  logisticsRub: 0, acceptRub: 0, storageRub: 0, packagingRub: 0
};
const applyRuleCases = [
  { name: 'applyRule set-price', rule: { type: 'set-price', value: 800 }, field: 'sellerPrice', expected: 800 },
  { name: 'applyRule set-discount', rule: { type: 'set-discount', value: 20 }, field: 'sellerPrice', expected: 800 },
  { name: 'applyRule delta-discount', rule: { type: 'delta-discount', value: 5 }, field: 'sellerPrice', expected: 950 },
  { name: 'applyRule delta-price', rule: { type: 'delta-price', value: -100 }, field: 'sellerPrice', expected: 900 },
  { name: 'applyRule delta-pct', rule: { type: 'delta-pct', value: -10 }, field: 'sellerPrice', expected: 900 },
  { name: 'applyRule set-base', rule: { type: 'set-base', value: 1200 }, field: 'basePrice', expected: 1200 },
  { name: 'applyRule set-target-margin', rule: { type: 'set-target-margin', value: 20 }, field: 'sellerPrice', expected: 125 },
  { name: 'applyRule set-profit', rule: { type: 'set-profit', value: 100 }, field: 'sellerPrice', expected: 200 },
  { name: 'applyRule minPrice clamp', rule: { type: 'set-price', value: 500, minPrice: 600 }, field: 'sellerPrice', expected: 600 },
  { name: 'applyRule maxPrice clamp', rule: { type: 'set-price', value: 950, maxPrice: 900 }, field: 'sellerPrice', expected: 900 },
  { name: 'applyRule скидка ограничивается 95%', rule: { type: 'set-discount', value: 100 }, field: 'discountPct', expected: 95 }
];
applyRuleCases.forEach((c) => {
  const result = EC.applyRule(ruleSettings, ruleItem, ruleOverrides, c.rule);
  numberCase(c.name, { rule: c.rule, field: c.field }, c.expected, () => result[c.field]);
});
valueCase('applyRule неизвестный тип возвращает null', { type: 'unknown' }, null,
  () => EC.applyRule(ruleSettings, ruleItem, ruleOverrides, { type: 'unknown', value: 1 }));

console.log('\n=== Репрайсер: округление и красивая цена ===');
const beautifulCases = [
  { name: 'округление …9, nearest (tie — вниз)', price: 1234, cfg: { ending: 9, mode: 'nearest' }, expected: 1229 },
  { name: 'округление …9, down', price: 1234, cfg: { ending: 9, mode: 'down' }, expected: 1229 },
  { name: 'округление …9, up', price: 1234, cfg: { ending: 9, mode: 'up' }, expected: 1239 },
  { name: 'округление …9, maxdown', price: 1234, cfg: { ending: 9, mode: 'maxdown' }, expected: 1219 },
  { name: 'округление …9, maxup', price: 1234, cfg: { ending: 9, mode: 'maxup' }, expected: 1259 },
  { name: 'округление …90 ниже 1000 ₽', price: 345, cfg: { ending: 90, mode: 'nearest' }, expected: 340 },
  { name: 'округление …90 от 1000 ₽', price: 1234, cfg: { ending: 90, mode: 'nearest' }, expected: 1190 },
  { name: 'округление …99 от 1000 ₽', price: 1234, cfg: { ending: 99, mode: 'nearest' }, expected: 1199 },
  { name: 'цены ниже 100 ₽ округляются по сетке 10 ₽', price: 95, cfg: { ending: 9, mode: 'nearest' }, expected: 99 },
  { name: 'нулевая цена не округляется', price: 0, cfg: { ending: 9 }, expected: 0 },
  { name: 'отрицательная цена не округляется', price: -2, cfg: { ending: 9 }, expected: -2 },
  { name: 'нулевой запас шага запрещает округление', price: 1234, cfg: { ending: 9 }, limit: 0, expected: 1234 },
  { name: 'запас шага 5 ₽ допускает ближайшую красивую цену', price: 1234, cfg: { ending: 9 }, limit: 5, expected: 1229 }
];
beautifulCases.forEach((c) => numberCase(c.name, { price: c.price, cfg: c.cfg, stepLimitRub: c.limit }, c.expected,
  () => RP.beautifulPrice(c.price, c.cfg, c.limit)));
numberCase(
  'красивая цена не должна выходить за остаток лимита шага',
  { price: 1234, ending: 9, stepLimitRub: 4, expectedNoMove: 1234 },
  1234, () => RP.beautifulPrice(1234, { ending: 9, mode: 'nearest' }, 4));

console.log('\n=== Репрайсер: режимы маржи и цена по целевой марже ===');
const marginCtx = {
  econAt: (price) => ({ profit: 200, revenue: price }),
  marginMode: 'discounted', sppPct: 20, walletPct: 10, forPayRatio: 0.8
};
numberCase('маржа discounted: база — цена продавца', { price: 1000, profit: 200 }, 20, () => RP.marginOf(marginCtx, 1000).marginPct);
numberCase('маржа forpay: база — ForPay 80%', { price: 1000, forPayRatio: 0.8 }, 25,
  () => RP.marginOf(Object.assign({}, marginCtx, { marginMode: 'forpay' }), 1000).marginPct);
numberCase('маржа wallet: база — цена после СПП и кошелька', { price: 1000, sppPct: 20, walletPct: 10 }, 27.78,
  () => RP.marginOf(Object.assign({}, marginCtx, { marginMode: 'wallet' }), 1000).marginPct);
numberCase('маржа forpay использует callback ForPay', { price: 1000, forPayAtPrice: 'price * 0.5' }, 40,
  () => RP.marginOf(Object.assign({}, marginCtx, { marginMode: 'forpay', forPayAtPrice: (price) => price * 0.5 }), 1000).marginPct);
numberCase('маржа при нулевой цене равна 0', { price: 0 }, 0, () => RP.marginOf(marginCtx, 0).marginPct);
const linearMargin = { marginMode: 'discounted', econAt: (price) => ({ profit: price - 100 }) };
numberCase('priceForMargin discounted: 20% достигается при 125 ₽', { targetPct: 20, min: 1, max: 1000 }, 125,
  () => RP.priceForMargin(linearMargin, 20, 1, 1000));
numberCase('priceForMargin forpay: поправка на ForPay 80%', { targetPct: 20, forPayRatio: 0.8 }, 119.05,
  () => RP.priceForMargin(Object.assign({}, linearMargin, { marginMode: 'forpay', forPayRatio: 0.8 }), 20, 1, 1000));
numberCase('priceForMargin wallet: поправка на СПП и кошелёк', { targetPct: 20, sppPct: 20, walletPct: 10 }, 116.82,
  () => RP.priceForMargin(Object.assign({}, linearMargin, { marginMode: 'wallet', sppPct: 20, walletPct: 10 }), 20, 1, 1000));
numberCase('priceForMargin возвращает минимум, если цель уже достигнута', { targetPct: 10, min: 130 }, 130,
  () => RP.priceForMargin(linearMargin, 10, 130, 1000));
valueCase('priceForMargin возвращает null, если цель недостижима на максимуме', { targetPct: 20, max: 120 }, null,
  () => RP.priceForMargin(linearMargin, 20, 1, 120));

console.log('\n=== Репрайсер: конкурент и отстройка ===');
const competitor = { id: 'sku-1000', name: 'К1000', price: 1000, stock: 5, enabled: true };
const competitorCtx = { competitors: [competitor], sppPct: 20, walletPct: 10 };
const competitorOffsetCases = [
  { name: 'plain: отступ −5%', cfg: { competitorMode: 'plain', competitorOffsetMode: 'pct', competitorOffsetPct: -5 }, expected: 950 },
  { name: 'withSpp: отступ −5%', cfg: { competitorMode: 'withSpp', competitorOffsetMode: 'pct', competitorOffsetPct: -5 }, expected: 1187.5 },
  { name: 'withWallet: отступ −5%', cfg: { competitorMode: 'withWallet', competitorOffsetMode: 'pct', competitorOffsetPct: -5 }, expected: 1319.44 },
  { name: 'plain: отступ −50 ₽', cfg: { competitorMode: 'plain', competitorOffsetMode: 'rub', competitorOffsetRub: -50 }, expected: 950 },
  { name: 'withSpp: отступ −50 ₽ после приведения СПП', cfg: { competitorMode: 'withSpp', competitorOffsetMode: 'rub', competitorOffsetRub: -50 }, expected: 1200 },
  { name: 'withWallet: отступ −50 ₽ после приведения', cfg: { competitorMode: 'withWallet', competitorOffsetMode: 'rub', competitorOffsetRub: -50 }, expected: 1338.89 }
];
competitorOffsetCases.forEach((c) => numberCase(c.name, { competitor: competitor.price, sppPct: 20, walletPct: 10, config: c.cfg }, c.expected,
  () => RP.bestCompetitorPrice(competitorCtx, c.cfg).price));
const competitorList = [
  { id: 'high', name: 'High', price: 1200, stock: 4, enabled: true },
  { id: 'low', name: 'Low', price: 900, stock: 2, enabled: true },
  { id: 'empty', name: 'Empty', price: 100, stock: 0, enabled: true },
  { id: 'off', name: 'Off', price: 50, stock: 2, enabled: false }
];
valueCase('конкурент по умолчанию — минимум среди включённых в наличии', { expectedId: 'low' }, 'low',
  () => RP.bestCompetitorPrice({ competitors: competitorList }, { competitorMode: 'plain' }).source.id);
valueCase('competitorId выбирает указанный SKU, даже если он дороже минимума', { competitorId: 'high' }, 'high',
  () => RP.bestCompetitorPrice({ competitors: competitorList }, { competitorMode: 'plain', competitorId: 'high' }).source.id);
numberCase('цена выбранного SKU используется для расчёта', { competitorId: 'high', price: 1200 }, 1200,
  () => RP.bestCompetitorPrice({ competitors: competitorList }, { competitorMode: 'plain', competitorId: 'high' }).price);
valueCase('неизвестный competitorId откатывается к минимуму', { competitorId: 'missing' }, 'low',
  () => RP.bestCompetitorPrice({ competitors: competitorList }, { competitorMode: 'plain', competitorId: 'missing' }).source.id);
valueCase('нет активных конкурентов — null', { competitors: [] }, null, () => RP.bestCompetitorPrice({ competitors: [] }, {}));
valueCase('нет конкурентов в наличии — null', { allStockZero: true }, null,
  () => RP.bestCompetitorPrice({ competitors: [{ id: 'x', price: 100, stock: 0 }] }, {}));
numberCase('отрицательный отступ не опускает цену ниже нуля', { price: 1000, offsetRub: -5000 }, 0,
  () => RP.bestCompetitorPrice(competitorCtx, { competitorMode: 'plain', competitorOffsetMode: 'rub', competitorOffsetRub: -5000 }).price);
numberCase('СПП 100% использует защитный минимум знаменателя', { competitor: 1000, sppPct: 100 }, 100000,
  () => RP.bestCompetitorPrice({ competitors: [competitor], sppPct: 100 }, { competitorMode: 'withSpp' }).price);

console.log('\n=== Репрайсер: план продаж и 9 стратегий ===');
const progressCases = [
  { name: 'февраль 2024: план-факт по графику 50%', now: Date.UTC(2024, 1, 15, 12), plan: 290, fact: 75, day: 15, days: 29, expectedQty: 150, ratio: 0.5 },
  { name: 'апрель: день 15 из 30 — план выполнен по графику', now: Date.UTC(2025, 3, 15, 12), plan: 300, fact: 150, day: 15, days: 30, expectedQty: 150, ratio: 1 },
  { name: 'високосный день: весь план к 29 февраля', now: Date.UTC(2024, 1, 29, 12), plan: 290, fact: 145, day: 29, days: 29, expectedQty: 290, ratio: 0.5 },
  { name: 'факт вдвое выше графика', now: Date.UTC(2025, 3, 15, 12), plan: 300, fact: 300, day: 15, days: 30, expectedQty: 150, ratio: 2 }
];
progressCases.forEach((c) => {
  const p = RP.planProgress({ now: c.now, salesMonthQty: c.fact }, { planQtyMonth: c.plan });
  numberCase(c.name + ': ожидаемые продажи', { plan: c.plan, fact: c.fact, day: c.day, days: c.days }, c.expectedQty, () => p.expected);
  numberCase(c.name + ': процент выполнения к графику', { plan: c.plan, fact: c.fact }, c.ratio, () => p.ratio);
  numberCase(c.name + ': день месяца', { now: c.now }, c.day, () => p.dayOfMonth);
  numberCase(c.name + ': дней в месяце', { now: c.now }, c.days, () => p.daysInMonth);
});
valueCase('план не задан — прогресс null', { planQtyMonth: 0 }, null,
  () => RP.planProgress({ now: Date.UTC(2024, 1, 15), salesMonthQty: 10 }, { planQtyMonth: 0 }));

const strategyBase = engineContext({ econAt: (price) => ({ revenue: price, profit: price - 400, marginPct: price > 0 ? (price - 400) / price * 100 : 0 }) });
const strategyCfg = engineConfig();
const strategyCases = [
  { name: 'стратегия default: выбирает самую низкую цену внутри коридора', strategy: 'default', ctx: { promoPrice: 900 }, item: {}, expected: 900 },
  { name: 'стратегия margin: цена под целевую маржу 20%', strategy: 'margin', ctx: {}, item: { targetMarginPct: 20 }, expected: 500 },
  { name: 'стратегия competitor: следует за конкурентом plain', strategy: 'competitor', ctx: { competitors: [{ id: 'c', name: 'C', price: 900, stock: 5, enabled: true }] }, item: { competitorMode: 'plain' }, expected: 900 },
  { name: 'стратегия planfact: отстаёт от плана — минус до 25%', strategy: 'planfact', ctx: { salesMonthQty: 75 }, item: { planQtyMonth: 290, planSensitivityPct: 8 }, expected: 750 },
  { name: 'стратегия turnover: на целевой оборачиваемости +3%', strategy: 'turnover', ctx: { turnoverDays: 7 }, item: { targetTurnoverDays: 7, basePriceTarget: 1200 }, expected: 1030 },
  { name: 'стратегия rrp: учитывает СПП и WB-кошелёк', strategy: 'rrp', ctx: { sppPct: 20, rrp: 900 }, item: { rrp: 900, basePriceTarget: 1400 }, config: { priceEdit: { walletPct: 10 } }, expected: 1250 },
  { name: 'стратегия ai: максимум прибыли при нулевой эластичности', strategy: 'ai', ctx: { salesPerDay: 1 }, item: { minPrice: 200, elasticityPct: 0, basePriceTarget: 1200 }, expected: 1200 },
  { name: 'стратегия promo: использует цену акции', strategy: 'promo', ctx: { promoPrice: 800 }, item: {}, expected: 800 },
  { name: 'стратегия hold: сохраняет текущую цену', strategy: 'hold', ctx: {}, item: {}, expected: 1000 }
];
strategyCases.forEach((c) => {
  const ctx = Object.assign({}, strategyBase, c.ctx || {});
  const result = RP.computeItem(ctx, engineConfig(c.config), Object.assign({ strategy: c.strategy }, c.item || {}));
  numberCase(c.name, { strategy: c.strategy, ctx: c.ctx || {}, itemConfig: c.item || {} }, c.expected, () => result.proposed.sellerPrice);
  valueCase(c.name + ': id стратегии', { strategy: c.strategy }, c.strategy, () => result.strategy);
});
const competitorFallback = RP.computeItem(engineContext(), strategyCfg, { strategy: 'competitor' });
valueCase('competitor без конкурентов включает default', { competitors: [] }, 'default', () => competitorFallback.strategy);
numberCase('competitor fallback держит базовую цену', { competitors: [], basePriceTarget: 1000 }, 1000,
  () => competitorFallback.proposed.sellerPrice);

console.log('\n=== Репрайсер: коридор, маржа и лимиты ===');
const corridorMin = RP.computeItem(engineContext({ competitors: [{ id: 'cheap', price: 500, stock: 10, enabled: true }] }), strategyCfg,
  { strategy: 'competitor', competitorMode: 'plain', minPrice: 700 });
numberCase('коридор: минимум поднимает предложение до 700 ₽', { competitor: 500, minPrice: 700 }, 700, () => corridorMin.proposed.sellerPrice);
numberCase('коридор: min отражает заданный нижний порог', { minPrice: 700 }, 700, () => corridorMin.corridor.min);
const corridorMax = RP.computeItem(engineContext({ promoPrice: 1500 }), strategyCfg, { strategy: 'promo', basePriceTarget: 1200 });
numberCase('коридор: максимум ограничивает стратегию сверху', { promoPrice: 1500, itemConfig: { basePriceTarget: 1200 } }, 1200, () => corridorMax.proposed.sellerPrice);
numberCase('коридор: max — максимум из базы WB и basePriceTarget', { basePrice: 1000, basePriceTarget: 1200 }, 1200, () => corridorMax.corridor.max);
const marginFloor = RP.computeItem(engineContext({ salesMonthQty: 0 }), strategyCfg,
  { strategy: 'planfact', planQtyMonth: 290, minMarginPct: 50, allowNegativeMargin: false });
numberCase('минимум по марже поднимает цену planfact с 750 до 800 ₽', { minMarginPct: 50, targetStrategyPrice: 750 }, 800,
  () => marginFloor.proposed.sellerPrice);
numberCase('коридор отдаёт рассчитанный минимум по марже', { minMarginPct: 50 }, 800, () => marginFloor.corridor.minByMargin);

const stepDown = RP.computeItem(engineContext({ competitors: [{ id: 'c', price: 500, stock: 1, enabled: true }] }),
  engineConfig({ limits: { maxChangePerUpdatePct: 10 } }), { strategy: 'competitor', competitorMode: 'plain' });
numberCase('лимит шага: снижение ограничено 10%', { current: 1000, wanted: 500, stepPct: 10 }, 900, () => stepDown.proposed.sellerPrice);
valueCase('лимит шага: ограничение помечено step', { maxChangePerUpdatePct: 10 }, 'step', () => stepDown.limitedBy);
const stepUp = RP.computeItem(engineContext({ competitors: [{ id: 'c', price: 1200, stock: 1, enabled: true }] }),
  engineConfig({ limits: { maxChangePerUpdatePct: 10 } }), { strategy: 'competitor', competitorMode: 'plain', basePriceTarget: 1300 });
numberCase('лимит шага: повышение ограничено 10%', { current: 1000, wanted: 1200, stepPct: 10 }, 1100, () => stepUp.proposed.sellerPrice);
const belowMinIgnored = RP.computeItem(engineContext({ sellerPrice: 500, basePrice: 500, basePriceTarget: 1200,
  competitors: [{ id: 'c', price: 1000, stock: 1, enabled: true }] }),
engineConfig({ limits: { maxChangePerUpdatePct: 10, ignoreStepIfBelowMin: true } }),
{ strategy: 'competitor', competitorMode: 'plain', minPrice: 800, basePriceTarget: 1200 });
numberCase('цена ниже minPrice: лимит шага игнорируется и достигается целевой коридор', { current: 500, minPrice: 800, wanted: 1000 },
  1000, () => belowMinIgnored.proposed.sellerPrice);
valueCase('цена ниже минимума помечена below-min', { current: 500, minPrice: 800 }, 'below-min', () => belowMinIgnored.limitedBy);
const dayLimit = RP.computeItem(engineContext({ priceDayStart: 1000, competitors: [{ id: 'c', price: 1200, stock: 1, enabled: true }] }),
  engineConfig({ limits: { maxChangePerUpdatePct: 0, maxChangePerDayPct: 5 } }), { strategy: 'competitor', competitorMode: 'plain', basePriceTarget: 1300 });
numberCase('суточный лимит: повышение ограничено 5%', { priceDayStart: 1000, maxChangePerDayPct: 5 }, 1050,
  () => dayLimit.proposed.sellerPrice);
valueCase('суточный лимит помечен day', { maxChangePerDayPct: 5 }, 'day', () => dayLimit.limitedBy);

console.log('\n=== Репрайсер: карантин, ДЦО и СПП / кошелёк ===');
const quarantineBlocked = RP.computeItem(engineContext({ basePrice: 1200, basePriceTarget: 1200, sellerPrice: 1200, promoPrice: 399 }),
  engineConfig(), { strategy: 'promo' });
valueCase('карантин: падение более чем в 3 раза обнаружено', { current: 1200, wanted: 399 }, true, () => quarantineBlocked.quarantine);
numberCase('карантин: цена поднята выше безопасной трети', { current: 1200, wanted: 399 }, 401,
  () => quarantineBlocked.proposed.sellerPrice);
const quarantineBoundary = RP.computeItem(engineContext({ basePrice: 1200, basePriceTarget: 1200, sellerPrice: 1200, promoPrice: 400 }),
  engineConfig(), { strategy: 'promo' });
valueCase('карантин: ровно треть цены разрешена', { current: 1200, wanted: 400 }, false, () => quarantineBoundary.quarantine);
numberCase('карантин: ровно треть не меняется', { current: 1200, wanted: 400 }, 400, () => quarantineBoundary.proposed.sellerPrice);
const quarantineWarnOnly = RP.computeItem(engineContext({ basePrice: 1200, basePriceTarget: 1200, sellerPrice: 1200, promoPrice: 399 }),
  engineConfig({ limits: { blockQuarantine: false } }), { strategy: 'promo' });
numberCase('карантин без блокировки: цена не поднимается автоматически', { current: 1200, wanted: 399, blockQuarantine: false }, 399,
  () => quarantineWarnOnly.proposed.sellerPrice);

const oosDco = RP.computeItem(engineContext({ stock: 1, salesPerDay: 1, turnoverDays: 1 }),
  engineConfig({ defaults: { oosProtection: true, targetTurnoverDays: 7 } }),
  { strategy: 'hold', oosProtection: true, targetTurnoverDays: 7, oosUpliftPct: 15, basePriceTarget: 1500 });
numberCase('ДЦО out-of-stock: дефицит остатка повышает цену', { stock: 1, salesPerDay: 1, goalDays: 7, upliftPct: 15 }, 1257,
  () => oosDco.proposed.sellerPrice);
const promoUplift = RP.computeItem(engineContext({ basePrice: 700, sellerPrice: 700, promoPrice: 800, inPromo: true }),
  engineConfig(), { strategy: 'promo', promoUpliftPct: 10, basePriceTarget: 1000 });
numberCase('ДЦО: повышение акционной цены на 10%', { promoPrice: 800, upliftPct: 10 }, 880,
  () => promoUplift.proposed.sellerPrice);
const liquidation = RP.computeItem(engineContext({ turnoverDays: 90 }),
  engineConfig(), { strategy: 'hold', liquidationTurnoverDays: 60, liquidationDiscountPct: 20 });
numberCase('ДЦО: распродажа неликвида снижает цену на 20%', { turnoverDays: 90, discountPct: 20 }, 800,
  () => liquidation.proposed.sellerPrice);

const sppWallet = RP.computeItem(engineContext({ sppPct: 20, basePrice: 1000, basePriceTarget: 1200 }),
  engineConfig({ priceEdit: { walletPct: 10 } }), { strategy: 'hold' });
numberCase('СПП и кошелёк влияют на цену покупателя, но не на seller price', { sellerPrice: 1000, sppPct: 20, walletPct: 10 }, 720,
  () => sppWallet.current.buyerPrice);
numberCase('СПП и кошелёк влияют на новую цену покупателя', { sellerPrice: 1000, sppPct: 20, walletPct: 10 }, 720,
  () => sppWallet.proposed.buyerPrice);
numberCase('режим wallet пересчитывает маржу от покупательской базы', { price: 1000, sppPct: 20, walletPct: 10 }, 83.33,
  () => RP.marginOf({ econAt: () => ({ profit: 600 }), marginMode: 'wallet', sppPct: 20, walletPct: 10 }, 1000).marginPct);

console.log('\n=== Репрайсер: пары цены, округление предложения и границы ===');
const pairCases = [
  { name: 'pairForSellerPrice: 800 ₽ при базе 1000 ₽', base: 1000, target: 800, expectedBase: 1000, expectedDiscount: 20, expectedSeller: 800 },
  { name: 'pairForSellerPrice: скидка округляется до целого процента', base: 1000, target: 333.33, expectedBase: 1000, expectedDiscount: 67, expectedSeller: 330 },
  { name: 'pairForSellerPrice: цена выше базы поднимает базу', base: 1000, target: 1200, expectedBase: 1200, expectedDiscount: 0, expectedSeller: 1200 },
  { name: 'pairForSellerPrice: скидка ограничена 95%', base: 1000, target: 0, expectedBase: 1000, expectedDiscount: 95, expectedSeller: 50 }
];
pairCases.forEach((c) => {
  const pair = RP.pairForSellerPrice(c.base, c.target);
  numberCase(c.name + ' — база', { base: c.base, sellerPrice: c.target }, c.expectedBase, () => pair.basePrice);
  numberCase(c.name + ' — скидка', { base: c.base, sellerPrice: c.target }, c.expectedDiscount, () => pair.discount);
  numberCase(c.name + ' — обратная цена после скидки', { base: c.base, sellerPrice: c.target }, c.expectedSeller, () => pair.sellerPrice);
});
const pricePairs = [
  { name: 'toBaseAndDiscount allow: держит скидку и меняет базу', target: 800, cur: { basePrice: 1000, discount: 20 }, cfg: { priceEdit: { canChangeBasePrice: 'allow', canCancelDiscount: true } }, item: {}, mode: 'base-price', base: 1000, discount: 20, seller: 800 },
  { name: 'toBaseAndDiscount forbid: базу не меняет', target: 700, cur: { basePrice: 1000, discount: 20 }, cfg: { priceEdit: { canChangeBasePrice: 'forbid', canCancelDiscount: true } }, item: {}, mode: 'discount-only', base: 1000, discount: 30, seller: 700 },
  { name: 'toBaseAndDiscount forbid: сохраняет минимальную часть существующей скидки', target: 1000, cur: { basePrice: 1000, discount: 10 }, cfg: { priceEdit: { canChangeBasePrice: 'forbid', canCancelDiscount: false } }, item: {}, mode: 'discount-only', base: 1000, discount: 1, seller: 990 },
  { name: 'toBaseAndDiscount ifNoOtherWay: точный целый процент', target: 800, cur: { basePrice: 1000, discount: 20 }, cfg: { priceEdit: { canChangeBasePrice: 'ifNoOtherWay', canCancelDiscount: true } }, item: {}, mode: 'discount-rounded', base: 1000, discount: 20, seller: 800 },
  { name: 'toBaseAndDiscount ifNoOtherWay: меняет базу при неточном проценте', target: 775, cur: { basePrice: 1000, discount: 20 }, cfg: { priceEdit: { canChangeBasePrice: 'ifNoOtherWay', canCancelDiscount: true } }, item: {}, mode: 'base-price', base: 969, discount: 20, seller: 775.2 },
  { name: 'toBaseAndDiscount targetDiscountPct: заданная скидка 25%', target: 800, cur: { basePrice: 1000, discount: 0 }, cfg: { priceEdit: { canChangeBasePrice: 'allow', canCancelDiscount: true } }, item: { targetDiscountPct: 25 }, mode: 'target-discount', base: 1067, discount: 25, seller: null }
];
pricePairs.forEach((c) => {
  const pair = RP.toBaseAndDiscount(c.target, c.cur, c.cfg, c.item);
  valueCase(c.name + ' — режим', { target: c.target, cur: c.cur, itemConfig: c.item }, c.mode, () => pair.mode);
  numberCase(c.name + ' — базовая цена', { target: c.target, cur: c.cur, itemConfig: c.item }, c.base, () => pair.basePrice);
  numberCase(c.name + ' — скидка', { target: c.target, cur: c.cur, itemConfig: c.item }, c.discount, () => pair.discount);
  if (c.seller !== null) numberCase(c.name + ' — цена после скидки', { target: c.target, cur: c.cur }, c.seller, () => pair.sellerPrice);
});

console.log('\n=== Репрайсер: valueStatus, пустые настройки и цены по размерам ===');
const statusCases = [
  { name: 'себестоимость 0 — Без индекса', row: { proposed: { profit: 50, marginPct: 30 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 0, expected: 'noindex' },
  { name: 'себестоимость ровно 2 ₽ остаётся индексируемой в valueStatus', row: { proposed: { profit: 50, marginPct: 30 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 2, expected: 'super' },
  { name: 'отрицательная прибыль — Невыгодный', row: { proposed: { profit: -1, marginPct: 30 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'bad' },
  { name: 'маржа ниже минимальной — Невыгодный', row: { proposed: { profit: 1, marginPct: 9.99 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'bad' },
  { name: 'маржа на минимальном пороге — Выгодный', row: { proposed: { profit: 0, marginPct: 10 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'good' },
  { name: 'маржа ровно на целевом пороге — Супер-выгодный', row: { proposed: { profit: 1, marginPct: 20 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'super' },
  { name: 'маржа берётся из current, если proposed.marginPct отсутствует', row: { proposed: { profit: 1 }, current: { marginPct: 15 } }, item: {}, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'good' },
  { name: 'порог цели 0 отключает статус Супер-выгодный', row: { proposed: { profit: 1, marginPct: 30 } }, item: { targetMarginPct: 0 }, defaults: { targetMarginPct: 20, minMarginPct: 10 }, cogs: 100, expected: 'good' }
];
statusCases.forEach((c) => {
  const status = RP.valueStatus(c.row, c.item, c.defaults, c.cogs);
  valueCase('valueStatus: ' + c.name, { row: c.row, itemConfig: c.item, defaults: c.defaults, costPriceRub: c.cogs }, c.expected, () => status.id);
});
valueCase('valueStatus: label noindex', { costPriceRub: 0 }, 'Без индекса',
  () => RP.valueStatus({ proposed: {} }, {}, {}, 0).label);
valueCase('valueStatus: порог 2 ₽ не меняет экономическую классификацию', { costPriceRub: 2 }, 'Супер-выгодный',
  () => RP.valueStatus({ proposed: { profit: 50, marginPct: 30 } }, {}, { targetMarginPct: 20, minMarginPct: 10 }, 2).label);
valueCase('valueStatus: формат процента локализован', { margin: 30, target: 20 }, 'Маржа 30,0% ≥ целевой 20,0%',
  () => RP.valueStatus({ proposed: { profit: 1, marginPct: 30 } }, {}, { targetMarginPct: 20, minMarginPct: 10 }, 10).hint);

const emptyItemConfigResult = RP.computeItem(engineContext(), engineConfig({ defaults: { strategy: 'hold' } }), {});
valueCase('пустой itemConfig безопасно использует стратегию по умолчанию', { itemConfig: {} }, 'hold', () => emptyItemConfigResult.strategy);
numberCase('пустой itemConfig сохраняет текущую цену', { itemConfig: {}, sellerPrice: 1000 }, 1000,
  () => emptyItemConfigResult.proposed.sellerPrice);
const itemConfigMerge = RP.itemConfig({ strategy: 'hold', minPrice: 100, targetMarginPct: 20 }, { minPrice: 300 });
numberCase('itemConfig: пользовательское значение перекрывает default', { defaults: { minPrice: 100 }, user: { minPrice: 300 } }, 300,
  () => itemConfigMerge.minPrice);
valueCase('itemConfig: незаданные поля сохраняются из defaults', { defaults: { strategy: 'hold' }, user: { minPrice: 300 } }, 'hold',
  () => itemConfigMerge.strategy);
const sizePriced = RP.computeItem(engineContext({ basePrice: 600, basePriceTarget: 600, sellerPrice: 600,
  priceFromSizes: true, sizePriceMin: 600, sizePriceMax: 800 }), engineConfig(), {});
valueCase('priceFromSizes: флаг доходит до результата', { priceFromSizes: true }, true, () => sizePriced.context.priceFromSizes);
numberCase('priceFromSizes: минимальная цена размера видна', { sizePriceMin: 600, sizePriceMax: 800 }, 600,
  () => sizePriced.context.sizePriceMin);
numberCase('priceFromSizes: максимальная цена размера видна', { sizePriceMin: 600, sizePriceMax: 800 }, 800,
  () => sizePriced.context.sizePriceMax);
const noSizePrice = RP.computeItem(engineContext(), engineConfig(), {});
valueCase('обычный товар не помечен как priceFromSizes', { priceFromSizes: false }, false, () => noSizePrice.context.priceFromSizes);

const zeroPriceRp = RP.computeItem(engineContext({ basePrice: 0, basePriceTarget: 0, sellerPrice: 0 }), engineConfig(), { strategy: 'hold' });
numberCase('репрайсер: нулевая текущая цена остаётся конечной', { basePrice: 0, sellerPrice: 0 }, 0, () => zeroPriceRp.current.sellerPrice);
numberCase('репрайсер: выходная цена при нулевом коридоре ограничена минимумом 1 ₽', { basePrice: 0, sellerPrice: 0 }, 1,
  () => zeroPriceRp.proposed.sellerPrice);
const noDiscountRp = RP.computeItem(engineContext({ discount: 0 }), engineConfig(), { strategy: 'hold' });
numberCase('репрайсер: товар без скидки не меняет seller price', { discount: 0, sellerPrice: 1000 }, 1000,
  () => noDiscountRp.proposed.sellerPrice);
const fullDiscountRp = RP.computeItem(engineContext({ discount: 100, sellerPrice: 0 }), engineConfig(), { strategy: 'hold' });
numberCase('репрайсер: нулевая цель при скидке 100% должна сохранить минимум 1 ₽ после перевода в пару',
  { discount: 100, sellerPrice: 0, minOutputExpected: 1 }, 1, () => fullDiscountRp.proposed.sellerPrice);
numberCase('репрайсер: скидка ограничена 95% при переводе в пару', { discount: 100 }, 95,
  () => fullDiscountRp.proposed.discount);

console.log('\n=== Итог ===');
console.log('Всего проверок: ' + (pass + fail + expectedFail) + ', пройдено: ' + pass + ', провалено: ' + fail + ', ожидаемо несовпало: ' + expectedFail);
if (expectedFail) {
  console.log('Ожидаемые расхождения вынесены в docs/API.md → «Проверки расчётов»; решение оставлено владельцу.');
}
if (failures.length) {
  console.log('\nПровалено:');
  failures.forEach((failure) => console.log('  ✗ ' + failure));
}
console.log('\nИТОГ: ' + (fail ? 'ЕСТЬ ПРОБЛЕМЫ' : 'ВСЁ ЗЕЛЁНОЕ'));
process.exit(fail ? 1 : 0);
