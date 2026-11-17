'use strict';

/**
 * Подменные данные для аналитики эффекта акций.
 * Проверяет окна N дней, обнаружение и исключение stockout из итогов,
 * явный процент расхождения прогноза/факта и отсутствие подмены неизвестных
 * финансовых данных нулями. Сетевых запросов к WB тест не делает.
 *
 * Запуск: node tools/checks/promo-analytics-flow.js
 */
const fs = require('fs');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { WBClient } = require('../../electron/wb-client');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, '.data-test-promo-analytics');
const DAY_MS = 86400000;
let pass = 0;
let fail = 0;
const failures = [];
let networkCalls = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('OK   ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function dayOffset(offset) {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}
function at(day, hour) {
  return day + 'T' + (hour || '12:00:00') + '.000Z';
}
function factRow(nmID, day, qty, spp) {
  return {
    nmID,
    salesQty: qty,
    returnsQty: 0,
    revenueTotal: qty * 1000,
    commissionTotal: qty * 100,
    logisticsTotal: qty * 100,
    storageTotal: qty * 5,
    acceptanceTotal: 0,
    acquiringTotal: qty * 10,
    penaltyTotal: 0,
    deductionTotal: 0,
    forPayTotal: qty * 890,
    sppWeightedTotal: qty * spp,
    sppCount: qty
  };
}

async function run() {
  fs.rmSync(DIR, { recursive: true, force: true });
  const store = createStore(DIR, null);
  store.saveSettings({
    demoMode: false,
    promoAnalyticsDays: 3,
    taxMode: 'none',
    taxRate: 0,
    adPctDefault: 0,
    packagingRub: 0
  });
  store.saveSecrets({ single: 'fake-test-token-for-local-analytics-only' });
  store.saveCosts({
    '101': { costPriceRub: 500, packagingRub: 0, adPct: 0, adRub: 0, taxMode: 'none', taxRatePct: 0 },
    '202': { costPriceRub: 500, packagingRub: 0, adPct: 0, adRub: 0, taxMode: 'none', taxRatePct: 0 }
  });

  const joinDay = dayOffset(-4);
  const beforeDays = [dayOffset(-7), dayOffset(-6), dayOffset(-5)];
  const duringDays = [dayOffset(-4), dayOffset(-3), dayOffset(-2)];
  const coveredDates = beforeDays.concat(duringDays);
  const byItemDay = {};
  beforeDays.forEach((d) => {
    byItemDay[d] = {
      '101': factRow(101, d, 1, 10),
      '202': factRow(202, d, 1, 12)
    };
  });
  duringDays.forEach((d) => {
    byItemDay[d] = {
      '101': factRow(101, d, 2, 20),
      '202': factRow(202, d, 1, 18)
    };
  });

  store.saveFactCosts({
    '101': { nmID: 101, salesQty: 9 },
    '202': { nmID: 202, salesQty: 6 }
  }, {
    dateFrom: beforeDays[0], dateTo: duringDays[2], loadedAt: new Date().toISOString(),
    source: 'fixture', byItemDay, coveredDates,
    byDay: {}
  });

  store.appendPromoJournal([
    {
      at: at(joinDay), nmID: 101, vendorCode: 'SKU-101', title: 'Тестовый товар 101',
      action: 'join', promoId: 77, promoName: 'Весенняя акция', ok: true,
      forecast: { profitMonthNow: 9000, profitMonthWithPromo: 13500, salesUpliftPct: 50, breakEvenUpliftPct: 25 }
    },
    {
      at: at(duringDays[2], '18:00:00'), nmID: 101, action: 'exit', promoId: 77,
      promoName: 'Весенняя акция', ok: true
    },
    {
      at: at(joinDay), nmID: 202, vendorCode: 'SKU-202', title: 'Товар со stockout',
      action: 'join', promoId: 77, promoName: 'Весенняя акция', ok: true,
      forecast: { profitMonthNow: 7000, profitMonthWithPromo: 8000, salesUpliftPct: 20, breakEvenUpliftPct: 10 }
    },
    {
      at: at(duringDays[2], '18:00:00'), nmID: 202, action: 'exit', promoId: 77,
      promoName: 'Весенняя акция', ok: true
    }
  ]);
  // Неуспешный вход не должен стать аналитическим эпизодом.
  store.appendPromoJournal([{
    at: at(joinDay), nmID: 303, action: 'join', promoId: 77, promoName: 'Весенняя акция', ok: false
  }]);
  store.appendStockSnapshot({
    at: at(duringDays[1]), complete: true, source: 'fixture', zeroNms: ['202']
  });

  global.fetch = async () => {
    networkCalls++;
    throw new Error('WB fetch must not be called by promo analytics');
  };
  const service = createService(store, () => {});
  const result = await service.handlers['repricer:promo-analytics']({ days: 3, now: new Date().toISOString() });
  const normal = (result.items || []).find((x) => x.nmID === 101);
  const stockout = (result.items || []).find((x) => x.nmID === 202);
  const promo = (result.promos || []).find((x) => x.promoId === 77);

  check('До входа используется ровно N=3 календарных дня', !!normal &&
    normal.before.from === beforeDays[0] && normal.before.to === beforeDays[2] && normal.before.days === 3,
    normal ? normal.before.from + ' → ' + normal.before.to : 'товар не найден');
  check('Окно участия начинается в день входа и длится N=3 дня', !!normal &&
    normal.during.from === joinDay && normal.during.to === duringDays[2] && normal.during.days === 3,
    normal ? normal.during.from + ' → ' + normal.during.to : 'товар не найден');
  check('Фактические единицы, выручка, прибыль и СПП посчитаны по дням', !!normal &&
    normal.before.metrics.salesQty === 3 && normal.during.metrics.salesQty === 6 &&
    normal.during.metrics.revenue === 6000 && normal.during.metrics.profit === 1710 &&
    normal.before.metrics.sppPct === 10 && normal.during.metrics.sppPct === 20,
    normal ? JSON.stringify({ units: normal.during.metrics.salesQty, revenue: normal.during.metrics.revenue, profit: normal.during.metrics.profit, spp: normal.during.metrics.sppPct }) : 'нет данных');
  check('Прогноз прироста продаж сравнивается с фактом, расхождение вычислено явно', !!normal &&
    normal.forecast.salesUpliftPct === 50 && normal.comparison.actualSalesUpliftPct === 100 &&
    normal.comparison.salesDeviationPct === 100,
    normal ? 'прогноз 50%, факт ' + normal.comparison.actualSalesUpliftPct + '%, расхождение ' + normal.comparison.salesDeviationPct + '%' : 'нет данных');
  check('Прибыль акции сравнивается с прогнозом через месячный эквивалент', !!normal &&
    normal.comparison.actualProfitMonthDuring === 17100 && normal.comparison.profitForecastDeviationPct === 26.67,
    normal ? 'факт ' + normal.comparison.actualProfitMonthDuring + ' ₽/мес, расхождение ' + normal.comparison.profitForecastDeviationPct + '%' : 'нет данных');
  check('Эффект оценивается по фактическому приросту прибыли, порог безубыточности доступен', !!normal &&
    normal.effect === 'positive' && normal.comparison.breakEvenMet === true);
  check('Нулевой остаток во время акции помечен как обрезанный stockout', !!stockout &&
    stockout.stockout && stockout.effect === 'truncated' && stockout.stockoutDate === duringDays[1]);
  check('Товар со stockout исключён из общих выводов', !!stockout && !stockout.eligibleForConclusion &&
    promo && promo.effectEvaluatedCount === 1 && promo.stockoutCount === 1,
    promo ? 'оценено ' + promo.effectEvaluatedCount + ', исключено stockout ' + promo.stockoutCount : 'акция не найдена');
  check('Неуспешный вход исключён из эпизодов', (result.items || []).every((x) => x.nmID !== 303));
  check('Аналитика не делает запросов к WB по товарам', networkCalls === 0, 'fetch вызовов: ' + networkCalls);

  const cappedClient = new WBClient();
  cappedClient.request = async () => [{ rrdId: 10 }];
  const cappedReport = await cappedClient.getSalesReportDetailed({
    dateFrom: joinDay, dateTo: dayOffset(-1), maxPages: 1
  });
  check('Достижение лимита страниц Finance явно помечает отчёт неполным', cappedReport.truncated === true && cappedReport.pages === 1);
  const finishedClient = new WBClient();
  let financePage = 0;
  finishedClient.request = async () => (++financePage === 1 ? [{ rrdId: 10 }] : []);
  const finishedReport = await finishedClient.getSalesReportDetailed({
    dateFrom: joinDay, dateTo: dayOffset(-1), maxPages: 2
  });
  check('Пустая последняя страница подтверждает полноту Finance-отчёта', finishedReport.truncated === false && finishedReport.pages === 2);

  const storedFacts = store.loadFactCosts();
  const partialDay = beforeDays[1];
  const partialCoverage = Object.assign({}, storedFacts.meta, {
    coveredDates: storedFacts.meta.coveredDates.filter((d) => d !== partialDay)
  });
  store.saveFactCosts(storedFacts.items, partialCoverage);
  const partialResult = await service.handlers['repricer:promo-analytics']({ days: 3, now: new Date().toISOString() });
  const partialItem = (partialResult.items || []).find((x) => x.nmID === 101);
  check('Неполное окно показывает покрытие и исключается из выводов', !!partialItem &&
    partialItem.before.status === 'partial' && partialItem.before.coveredDays === 2 &&
    partialItem.effect === 'pending' && !partialItem.eligibleForConclusion);

  const noCostDir = path.join(DIR, 'no-cost');
  const noCostStore = createStore(noCostDir, null);
  noCostStore.saveSettings({ demoMode: false, promoAnalyticsDays: 3, taxMode: 'none', taxRate: 0 });
  noCostStore.saveSecrets({ single: 'fake-test-token-for-local-analytics-only' });
  noCostStore.saveFactCosts(storedFacts.items, storedFacts.meta);
  noCostStore.appendPromoJournal([{
    at: at(joinDay), nmID: 101, action: 'join', promoId: 90, promoName: 'Без себестоимости', ok: true
  }]);
  const noCostService = createService(noCostStore, () => {});
  const noCostResult = await noCostService.handlers['repricer:promo-analytics']({ days: 3, now: new Date().toISOString() });
  const noCostItem = (noCostResult.items || [])[0];
  check('Без себестоимости прибыль не подменяется нулевой себестоимостью', !!noCostItem &&
    noCostItem.costKnown === false && noCostItem.during.metrics.profit === null &&
    noCostItem.effect === 'pending' && !noCostItem.eligibleForConclusion &&
    noCostItem.comparison.actualSalesUpliftPct === 100 && noCostResult.summary.pendingCount === 1);

  // Пустой Finance cache — это отсутствие факта, а не продажа с нулём.
  const noReportDir = path.join(DIR, 'no-report');
  const noReportStore = createStore(noReportDir, null);
  noReportStore.saveSettings({ demoMode: false, promoAnalyticsDays: 3 });
  noReportStore.saveSecrets({ single: 'fake-test-token-for-local-analytics-only' });
  noReportStore.appendPromoJournal([{
    at: at(joinDay), nmID: 404, action: 'join', promoId: 88, promoName: 'Отчёта нет', ok: true
  }]);
  const noReportService = createService(noReportStore, () => {});
  const noReport = await noReportService.handlers['repricer:promo-analytics']({ days: 3, now: new Date().toISOString() });
  const missing = (noReport.items || [])[0];
  check('Без финансового отчёта интерфейс получает «данных ещё нет»', noReport.dataStatus === 'no-report' && /Данных ещё нет/.test(noReport.message || ''));
  check('Отсутствие отчёта не превращается в нулевые факты', !!missing &&
    missing.before.metrics === null && missing.during.metrics === null && missing.effect === 'pending' &&
    noReport.summary.salesBefore === null && noReport.summary.revenueDuring === null);

  const incompleteDir = path.join(DIR, 'incomplete-report');
  const incompleteStore = createStore(incompleteDir, null);
  incompleteStore.saveSettings({ demoMode: false, promoAnalyticsDays: 3 });
  incompleteStore.saveSecrets({ single: 'fake-test-token-for-local-analytics-only' });
  incompleteStore.saveFactCosts({ '405': { nmID: 405, salesQty: 1 } }, { reportTruncated: true });
  incompleteStore.appendPromoJournal([{
    at: at(joinDay), nmID: 405, action: 'join', promoId: 89, promoName: 'Неполный отчёт', ok: true
  }]);
  const incompleteService = createService(incompleteStore, () => {});
  const incomplete = await incompleteService.handlers['repricer:promo-analytics']({ days: 3, now: new Date().toISOString() });
  const incompleteItem = (incomplete.items || [])[0];
  check('Неполная загрузка Finance явно объясняется и не даёт нулевые факты',
    incomplete.dataStatus === 'incomplete-report' && /не полностью/.test(incomplete.message || '') &&
    incompleteItem && incompleteItem.before.metrics === null && incompleteItem.during.metrics === null);

  console.log('\nИТОГО: ' + pass + ' прошло, ' + fail + ' провалено');
  if (fail) {
    failures.forEach((x) => console.log('  - ' + x));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
