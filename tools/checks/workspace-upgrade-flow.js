'use strict';

/** Приёмка правок рабочего места и M. Только вымышленные выгрузки и подменная сеть. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const EC = require('../../electron/economics');
const M = require('../../electron/promo-analytics');
const Import = require('../../electron/promo-import');
const { observePromoPrice } = require('../../electron/promo-observation');
const { readTable, parseSharedStrings, parseSheet } = require('../../electron/xlsx-lite');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { createProfileHub } = require('../../electron/profiles');
const { MAX_BACKUP_BYTES } = require('../../electron/backup');
const ROOT = path.join(__dirname, '..', '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const roots = [], hubs = [], services = [];
let pass = 0, fail = 0;
function check(name, condition, detail) { if (condition) { pass++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); } }
const near = (a, b) => Math.abs(a - b) < .011;
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workspace-')); roots.push(dir); return dir; };
const reject = async (name, fn) => { let error; try { await fn(); } catch (e) { error = e; } check(name, !!error, error && error.message); };
const baseItem = { nmID: 100000101, price: 1220, discount: 0 };
const period = { startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2026-12-31T23:59:59Z' };

(async () => {
  const vat = EC.analyze({ taxMode: 'nds22', taxRate: 6 }, baseItem, { costPriceRub: 200 });
  check('НДС 22% выделяется из цены 1220 как 220, а не 268.40', vat.current.tax === 220 && near(vat.params.taxRatePct, 22 / 122 * 100));
  check('Старое поле 6% не подменяет выбранный НДС 22%', vat.params.taxDetails.vatNominal === 22 && vat.params.taxDetails.incomeEffective === 0);
  check('Разбивка показывает НДС отдельно', vat.current.taxParts.vat === 220 && vat.current.taxParts.income === 0);
  check('УСН 6% и отдельный НДС 22% считаются на разных базах', EC.analyze({ taxMode: 'usn6', taxRate: 6, taxVatRate: 22 }, baseItem, {}).current.tax === 280);
  const below = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 300000, ipFixedContribution: 0 }, 'usn6_ip');
  check('ИП: до 300 тыс. дополнительного взноса нет', below.extraAnnual === 0 && below.effectiveRate === 6);
  const ip = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 1000000, ipFixedContribution: 0 }, 'usn6_ip');
  check('ИП: 1% берётся только с превышения, не всей выручки', ip.extraAnnual === 7000);
  check('ИП: вычет взноса не позволяет задвоить расход как плоские 7%', ip.deductibleAnnual === 7000 && near(ip.effectiveRate, 6));
  const withoutDeduction = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 1000000, ipFixedContribution: 0, ipDeductContributions: false }, 'usn6_ip');
  check('ИП: без вычета 1% превышения даёт 6.7%, не 7%', near(withoutDeduction.effectiveRate, 6.7));
  const fixed = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 1000000 }, 'usn6_ip');
  check('Фиксированные взносы и уменьшение УСН учтены отдельно', fixed.fixedAnnual === 57390 && fixed.deductibleAnnual === 60000 && near(fixed.effectiveRate, 6.439));
  const staff = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 1000000, ipHasEmployees: true }, 'usn6_ip');
  check('ИП с работниками: уменьшение не больше половины УСН', staff.deductibleAnnual === 30000 && near(staff.effectiveRate, 9.439));
  const capped = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6, taxAnnualRevenue: 100000000, ipFixedContribution: 0 }, 'usn6_ip');
  check('Предел дополнительного взноса 2026 соблюдается', capped.extraAnnual === 321818);
  const missing = EC.resolveTax({ taxMode: 'usn6_ip', taxRate: 6 }, 'usn6_ip');
  check('Неизвестный годовой доход не подменяется плоскими 7%', missing.effectiveRate === 6 && missing.warnings.some((w) => /годовой доход/.test(w)));
  check('Без налога не наследуются взносы прежнего режима', EC.resolveTax({ taxMode: 'none', taxRate: 6, taxInsuranceEnabled: true, taxAnnualRevenue: 1000000 }, 'none').effectiveRate === 0);
  const RP = require('../../electron/repricer-engine');
  const exitCfg = RP.mergeConfig({ promo: { autoExitManualPromos: true }, limits: { maxChangePerUpdatePct: 19 } });
  const exitContext = { basePrice: 2000, discount: 5, sellerPrice: 1900, sppPct: 0, promos: [{ id: 3148, planPrice: 1950, absolutePlan: true, inAction: true, requiredDiscountPct: 10 }], econAt: (price) => ({ profit: -100, marginPct: -5, revenue: price }) };
  const absoluteExit = RP.planPromos(exitContext, exitCfg, { minPrice: 300 }, { strategyPrice: 1900 });
  check('Выход по файлу не объявляется завершённым только по скидке ниже процента календаря', absoluteExit.chosen && !absoluteExit.chosen.noChangeNeeded && absoluteExit.chosen.price > 1950 && absoluteExit.chosen.absolutePlanThreshold === 1950);
  const cappedExit = RP.planPromos({ ...exitContext, sellerPrice: 500 }, exitCfg, { minPrice: 300 }, { strategyPrice: 500 });
  check('Выход по файлу не обходит лимит шага для скачка в несколько раз', !cappedExit.chosen && cappedExit.actions.some((a) => a.action === 'warn'));
  const forbidden = RP.planPromos({ ...exitContext, discount: 1, sellerPrice: 1980, promos: [{ ...exitContext.promos[0], planPrice: 1999 }] }, RP.mergeConfig({ promo: { autoExitManualPromos: true }, priceEdit: { canChangeBasePrice: 'forbid', canCancelDiscount: false } }), {}, { strategyPrice: 1980 });
  check('Недостижимый порог при запрете базы не выдаётся за выход', !forbidden.chosen && forbidden.actions.some((a) => a.action === 'warn'));

  const floor = EC.calcPriceForMarginPct(vat.params, 20);
  check('Новая налоговая нагрузка согласована с обратным подбором цены', floor !== null && EC.calcUnit(floor, vat.params).marginPct >= 19.99);

  const xlsx = fixture('promo-wb-export-synthetic.xlsx');
  const parsed = Import.bestPromoTable(readTable(xlsx, 'wb.xlsx'));
  check('XLSX WB-подобного формата читается после листа с инструкцией', parsed.sheet === 'sheet2' && parsed.items.length === 3);
  check('Процент Excel 0.5 с форматом 0% читается как 50%, а не 0.5%', parsed.items[0].planDiscount === 50);
  check('Преамбула перед заголовками не теряет товары', parsed.items[0].nmID === 100000101 && parsed.headers.includes('Артикул WB'));
  check('Цены с пробелами, запятой и валютой распознаны', parsed.items[0].planPrice === 1000.5 && parsed.items[0].price === 2000);
  check('Не участвует не трактуется как участвует', parsed.items[0].inAction === false && parsed.items[1].inAction === true && parsed.items[1].inActionKnown);
  check('Повторы размеров не дублируют nmID и используют меньший порог', parsed.items[2].planPrice === 1400 && parsed.duplicates === 1 && parsed.warnings.length > 0);
  const csv = Import.bestPromoTable(readTable(fixture('promo-wb-export-cp1251.csv'), 'wb.csv'));
  check('CSV Windows-1251 с преамбулой и десятичной запятой читается', csv.items.length === 1 && csv.items[0].planPrice === 1000.5);
  check('TSV с заголовком поддерживается', Import.bestPromoTable(readTable(Buffer.from('Артикул WB\tЦена акции\n100000101\t999'), 'wb.txt')).items[0].planPrice === 999);
  check('Штрихкод без заголовка nmID не выдаётся за артикул WB', Import.parsePromoNoms([['Штрихкод', 'Цена'], ['4600123456789', '1000']]).items.length === 0);
  check('Пустой sharedString не сдвигает индексы остальных строк', parseSharedStrings('<sst><si/><si><t>Артикул WB</t></si></sst>')[1] === 'Артикул WB');
  check('XML namespace и сохранённые значения формул поддерживаются', parseSheet('<x:worksheet><x:row r="1"><x:c r="A1"><x:f>1+1</x:f><x:v>2</x:v></x:c></x:row></x:worksheet>', [])[0][0] === '2');
  await reject('Повреждённый ZIP не принимается за успешный пустой файл', () => readTable(Buffer.from('not-a-zip'), 'wb.xlsx'));

  const byPrice = observePromoPrice({ price: 2000, discount: 50 }, 1000, period, '2026-06-01');
  check('При цене ровно порога товар соответствует условию акции', byPrice.inAction && byPrice.status === 'by-price');
  check('При цене ниже порога соответствие сохраняется', observePromoPrice({ price: 2000, discount: 55 }, 1000, period, '2026-06-01').inAction);
  check('Выше порога товар не помечается участником', !observePromoPrice({ price: 2000, discount: 49 }, 1000, period, '2026-06-01').inAction);
  check('СПП покупателя не подменяет цену продавца для участия', !observePromoPrice({ price: 2000, discount: 0, sppPct: 80 }, 1000, period, '2026-06-01').inAction);
  check('Будущая акция отмечается готовностью, но не участием', observePromoPrice({ price: 2000, discount: 50 }, 1000, period, '2025-12-01').status === 'ready');
  check('Завершённая акция не помечается действующей', !observePromoPrice({ price: 1000 }, 1000, period, '2027-01-01').inAction);
  check('Неизвестный порог не подтверждает участие', observePromoPrice({ price: 1000 }, 0, period, '2026-06-01').known === false);
  const sizes = observePromoPrice({ discount: 0, sizes: [{ price: 900 }, { price: 1200 }] }, 1000, period, '2026-06-01');
  check('Один дешёвый размер не выдаёт весь товар за участника', sizes.partial && !sizes.inAction);

  const hub = createProfileHub({ dataDir: temp(), createService: (store, emit, electron, hooks) => {
    const service = createService(store, emit, electron, hooks);
    // Синтетическая выгрузка принадлежит синтетическому кабинету, не демо-WB по умолчанию.
    service.getDemo().getGoods = async () => ({ items: parsed.items.map((row) => ({ nmID: row.nmID, price: row.price || 2000, discount: 0 })),
      source: 'demo', complete: true, scope: 'full', total: parsed.items.length, totalKnown: true });
    return service;
  } }); hubs.push(hub);
  const store = hub.getActiveStore();
  const preview = await hub.handlers['promos:import-noms']({ promotionID: 3148, fileName: 'wb.xlsx', base64: xlsx.toString('base64'), action: 'preview' });
  check('Предпросмотр файла не записывает состав акции', preview.preview && !store.loadPromoNoms()['3148']);
  await hub.handlers['promos:import-noms']({ promotionID: 3148, fileName: 'wb.xlsx', base64: xlsx.toString('base64'), action: 'apply' });
  check('Сохранение пишет весь состав, не только видимые первые строки', store.loadPromoNoms()['3148'].items.length === 3);
  const stable = JSON.stringify(store.loadPromoNoms());
  await reject('Ошибка следующего файла не стирает сохранённый состав', () => hub.handlers['promos:import-noms']({ promotionID: 3148, rows: [['Штрихкод'], ['4600123456789']], action: 'apply' }));
  check('После ошибки прежние условия сохранены', JSON.stringify(store.loadPromoNoms()) === stable);
  store.saveProposals({ phase: 'proposed', items: [{ nmID: 100000101, basePrice: 1000 }] });
  await hub.handlers['settings:save']({ taxMode: 'nds22' });
  check('Смена налогов делает старое предложение неотправляемым без пересчёта', store.loadProposals().phase === 'stale');
  const bid = (await hub.handlers['profiles:create']({ name: 'Другой кабинет' })).profile.id;
  await hub.handlers['profiles:switch']({ profileId: bid });
  check('Налоги и условия файла не переходят в другой профиль', hub.getActiveStore().loadSettings().taxMode === 'usn6' && !hub.getActiveStore().loadPromoNoms()['3148']);
  await hub.handlers['profiles:switch']({ profileId: 'default' });
  await nativeFileBridge(hub, xlsx);
  await reject('Авто-выход не отправляет цену, которая после округления не выше порога файла', () => hub.handlers['repricer:promo-apply']({ results: [{ nmID: 100000101, promoChosen: { type: 'exit', absolutePlanThreshold: 1200 }, proposed: { basePrice: 1000, discount: 0 }, needSend: true }] }));
  await analyticsCases();
  await dailyFinanceCases();
  await require('./workspace-ui-safety')({ check, ROOT, fixture, temp, hubs });
})().catch((error) => { fail++; console.error('FAIL исключение:', error.stack || error); }).finally(() => {
  for (const hub of hubs) hub.stopAllSchedulers();
  for (const service of services) service.dispose();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nИТОГО рабочее место/M: ' + pass + ' пройдено, ' + fail + ' ошибок');
  process.exitCode = fail ? 1 : 0;
});

async function nativeFileBridge(hub, xlsx) {
  const handlers = new Map(), source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  let canceled = false;
  const filename = path.join(temp(), 'wb-original.xlsx'); fs.writeFileSync(filename, xlsx);
  const context = { service: hub, fs, path, crypto, Buffer, MAX_BACKUP_BYTES, win: null,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async () => canceled ? { canceled: true } : { filePaths: [filename] } }, shell: { showItemInFolder() {} } };
  vm.runInNewContext(source.slice(source.indexOf('function registerIpc()'), source.indexOf('\napp.setName')) + '\nregisterIpc();', context);
  const response = await handlers.get('ui:import-file')(null, {});
  check('Настоящий IPC ui:import-file отдаёт данные в общем {ok,data}', response.ok && response.data.base64 === xlsx.toString('base64') && response.data.fileName === 'wb-original.xlsx');
  const downloads = [], scope = { window: { wbApp: { invoke: (channel, ...args) => handlers.get(channel)(null, ...args) } }, document: { cookie: '' }, U: { download: (...args) => downloads.push(args) } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/api.js'), 'utf8'), scope);
  const picked = await scope.window.API.importFile({ extensions: ['xlsx'] });
  check('Реальный Electron-мост доставляет выбранный XLSX в интерфейс', picked && picked.base64 === xlsx.toString('base64') && picked.size === xlsx.length);
  canceled = true;
  check('Отмена выбора файла возвращает null и освобождает операцию', await scope.window.API.importFile({}) === null && scope.window.API.pending() === 0);
  scope.window.wbApp.invoke = async () => ({ ok: true, fileName: 'old.xlsx', base64: xlsx.toString('base64'), size: xlsx.length });
  check('Новый интерфейс умеет и старый плоский ответ file IPC', (await scope.window.API.importFile({})).fileName === 'old.xlsx');
  scope.window.wbApp.invoke = async () => ({ ok: false, error: { message: 'Тестовая ошибка файла' } });
  await reject('Ошибка чтения файла показывается, а не маскируется отменой', () => scope.window.API.importFile({}));
}

async function analyticsCases() {
  const journal = [{ nmID: 11, promoId: 22, promoName: 'Акция', action: 'join', ok: true, at: '2026-11-02T12:00:00Z' }];
  const input = { days: 1, now: '2026-11-05', journal,
    coveredDates: ['2026-11-01', '2026-11-02'], byItemDay: { '2026-11-01': { 11: { salesQty: 1, revenueTotal: 100, forPayTotal: 90 } }, '2026-11-02': { 11: { salesQty: 2, revenueTotal: 200, forPayTotal: 180 } } },
    overrides: { 11: { costPriceRub: 20, taxRatePct: 0 } }, settings: { taxRate: 0, taxMode: 'none' } };
  const result = M.promoAnalytics(input);
  check('M: полный закрытый период с фактом доступен', result.items[0].windowsComplete && result.items[0].eligibleForConclusion);
  check('M: отсутствие прогноза не превращается в групповой нулевой прогноз', result.promos[0].forecastProfitMonthDuring === null && result.promos[0].forecastProfitGainMonth === null);
  const today = M.promoAnalytics({ ...input, now: '2026-11-02T12:00:00Z' });
  check('M: текущий незакрытый день не даёт итогового вывода', !today.items[0].effectEvaluable);
  const future = M.promoAnalytics({ ...input, journal: [{ ...journal[0], promoStartAt: '2026-11-10T00:00:00Z' }] });
  check('M: отправка до начала акции не считается фактом участия до старта', future.items[0].during.from === '2026-11-10' && !future.items[0].effectEvaluable);
  const overlap = M.promoAnalytics({ ...input, journal: journal.concat([{ ...journal[0], promoId: 23 }]) });
  check('M: одни продажи в двух пересекающихся акциях не удваивают общий эффект', overlap.items.every((row) => row.overlap && !row.eligibleForConclusion) && overlap.summary.eligibleCount === 0 && overlap.summary.revenueDuring === null);
  const negative = M.promoAnalytics({ ...input, byItemDay: { ...input.byItemDay, '2026-11-02': { 11: { salesQty: 0, returnsQty: 1, revenueTotal: -100, forPayTotal: -90 } } } });
  check('M: отрицательная выплата WB не заменяется другой формулой', negative.items[0].during.metrics.forPay === -90);
  const zero = M.promoAnalytics({ ...input, byItemDay: { ...input.byItemDay, '2026-11-02': { 11: { salesQty: 1, revenueTotal: 100, forPayTotal: 0 } } } });
  check('M: известная нулевая выплата WB остаётся нулём', zero.items[0].during.metrics.forPay === 0);
  const unknownStock = M.promoAnalytics({ ...input, stockHistory: { days: { '2026-11-02': { complete: true, zeroNms: ['99'], observedNms: ['99'] } } } });
  check('M: снимок чужого товара не подтверждает остатки этого SKU', unknownStock.items[0].stockStatus === 'unknown');
  const partial = M.promoAnalytics({ ...input, coveredDates: ['2026-11-01'] });
  check('M: непокрытые даты не выдаются за нулевые продажи', partial.items[0].during.metrics === null && !partial.items[0].effectEvaluable);
  const moscow = M.pairPromoEpisodes([{ ...journal[0], at: '2026-11-02T22:30:00Z' }]);
  check('M: вход поздним UTC-вечером относится к следующему дню Москвы', moscow[0].joinedDay === '2026-11-03');
  check('M: несуществующая календарная дата не создаёт эпизод', M.pairPromoEpisodes([{ ...journal[0], at: '2026-02-30' }]).length === 0);
  const noCursor = new (require('../../electron/wb-client').WBClient)(); noCursor.request = async () => [{ nmId: 11 }];
  check('M: пропавший курсор страницы не выдаёт Finance за полный', (await noCursor.getSalesReportDetailed({ dateFrom: '2026-11-01', dateTo: '2026-11-02' })).truncated);
}

async function dailyFinanceCases() {
  const dir = temp(), store = createStore(dir, null);
  store.saveSettings({ demoMode: false, taxMode: 'none', taxRate: 0, adPctDefault: 0, packagingRub: 0 });
  store.saveSecrets({ single: 'fake-finance-for-test' }); store.saveCosts({ 11: { costPriceRub: 200, adPct: 0, packagingRub: 0, taxRatePct: 0 } });
  const service = createService(store, () => {}); services.push(service);
  const before = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10), during = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const sale = { nmId: 11, isSale: true, quantity: 1, retailAmount: 1000, forPay: 900, forPayKnown: true, commission: 100, logistics: 50 };
  service.getClient().getSalesReportDetailed = async () => ({ source: 'fixture', truncated: false, pages: 2, rows: [
    { ...sale, date: before }, { ...sale, date: during }, { ...sale, date: during, isSale: false, isReturn: true, returnLogistics: 20 },
    { nmId: 11, date: during, isSale: false, quantity: 0, storage: 25 }
  ] });
  const savedFetch = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('Неожиданный внешний запрос'); };
  try { await service.handlers['facts:load']({ dateFrom: before, dateTo: during, days: 2 }); }
  finally { global.fetch = savedFetch; }
  const daily = store.loadFactCosts().meta.byItemDay[during]['11'];
  check('M: отдельная строка хранения не становится продажей одной штуки', daily.salesQty === 1 && daily.storageTotal === 25);
  check('M: возврат уменьшает дневную выручку и выплату, а не только добавляет логистику', daily.returnsQty === 1 && daily.revenueTotal === 0 && daily.forPayTotal === 0 && daily.logisticsTotal === 70);
  store.appendPromoJournal([{ nmID: 11, promoId: 3148, action: 'join', at: during + 'T12:00:00Z', ok: true }]);
  const analytics = await service.handlers['repricer:promo-analytics']({ days: 1 });
  check('M: прибыль окна учитывает возврат себестоимости и отдельные расходы', analytics.items[0].during.metrics.profit === -95);
  check('M: аналитика и подменная загрузка не ходили в сеть', calls === 0);
}
