'use strict';

/** Независимые числовые фикстуры и автомат лесенки. Никаких реальных ключей/сетевых отправок. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EC = require('../../electron/economics');
const A = require('../../electron/workspace-analytics');
const B = require('../../electron/boost-ladder');
const { WBClient } = require('../../electron/wb-client');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
let passed = 0, failed = 0;
const roots = [], services = [];
function test(name, fn) { try { fn(); passed++; console.log('OK   v4: ' + name); } catch (e) { failed++; console.error('FAIL v4: ' + name + ' — ' + e.stack); } }
async function asyncTest(name, fn) { try { await fn(); passed++; console.log('OK   v4: ' + name); } catch (e) { failed++; console.error('FAIL v4: ' + name + ' — ' + e.stack); } }
const near = (a, b, eps = .011) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
// Предохранитель всего файла: никто не должен выйти к WB/Telegram, даже по ошибке.
global.fetch = async (url) => { throw new Error('Запрещена сеть теста: ' + String(url)); };
const now = Date.parse('2026-06-15T09:00:00Z');
const day = A.dayKey(now);
const sales = (id, price, date = new Date(now - A.DAY).toISOString(), more = {}) => ({ nmId: 11, saleID: id, date, priceWithDisc: price, spp: 15, ...more });

async function main() {
  const item = { nmID: 11, price: 1000, discount: 20 };
  const settings = { taxMode: 'usn6', taxRate: 6, commissionDefault: 12.5, acquiringPct: 1.7, adPctDefault: 2, packagingRub: 8, storageRubPerUnit: 3, acceptRub: 2, sppDefault: 25 };
  const override = { costPriceRub: 200, logisticsRub: 65, adRub: 5, otherPct: 3, otherRub: 7 };
  test('прочие расходы складываются ровно один раз, база — цена продавца до СПП', () => {
    const e = EC.analyze(settings, item, override);
    near(e.current.other, 800 * .03 + 7);
    near(e.current.profit, 800 - (800 * (.125 + .017 + .06 + .02 + .03) + 8 + 3 + 2 + 200 + 65 + 5 + 7));
    near(e.current.totalCosts + e.current.profit, 800);
    near(EC.analyze(settings, item, { ...override, sppPct: 0 }).current.other, e.current.other);
  });
  const params = EC.analyze(settings, item, override).params;
  for (let i = 0; i < 16; i++) test('обратные формулы согласованы с прямым расчётом, набор ' + (i + 1), () => {
    const p = { ...params, costPriceRub: 120 + i * 13.7, otherPct: i * .8, otherRub: i * 2.3 }, target = 5 + i;
    const fixed = 65 + 2 + 3 + 8 + p.costPriceRub + 5 + p.otherRub;
    const rate = (12.5 + 1.7 + 6 + 2 + p.otherPct) / 100;
    const price = EC.calcPriceForMarginPct(p, target);
    near(price, fixed / (1 - rate - target / 100), .02);
    near(EC.calcUnit(price, p).marginPct, target, .02);
    near(EC.calcPriceForProfitRub(p, 50), (fixed + 50) / (1 - rate), .02);
    near(EC.calcBreakEvenPrice(p), fixed / (1 - rate), .02);
  });
  test('неосуществимая маржа не превращается в отрицательную цену', () => {
    assert.equal(EC.calcPriceForMarginPct({ ...params, otherPct: 80 }, 30), null);
  });
  test('СПП 0, официальный источник и ручное переопределение не теряются', () => {
    const facts = { sppPctOfficial: 0, sppOfficialAt: '2026-06-15T08:00:00Z', sppPctWatch: 25, sppWatchAt: '2026-06-14T08:00:00Z' };
    assert.equal(EC.analyze(settings, item, override, undefined, facts).params.sppPct, 0);
    assert.equal(EC.analyze(settings, item, { ...override, sppPct: 12 }, undefined, facts).params.sppPct, 12);
    assert.equal(EC.analyze(settings, item, override, undefined, { ...facts, sppWatchAt: '2026-06-15T08:30:00Z' }).params.sppPct, 25);
  });
  test('официальная цена: только priceWithDisc либо totalPrice со скидкой продавца', () => {
    assert.equal(A.sellerPrice({ priceWithDisc: 800, finishedPrice: 1, forPay: 1 }), 800);
    assert.equal(A.sellerPrice({ priceWithDisc: 0, totalPrice: 1000, discountPercent: 20 }), 800);
    for (const row of [{ price: 123 }, { finishedPrice: 123 }, { forPay: 123 }, { totalPrice: 1000 }, { totalPrice: 1000, discountPercent: 100 }]) assert.equal(A.sellerPrice(row), null);
  });
  test('даты без зоны — МСК, календарные ошибки не принимаются', () => {
    assert.equal(A.timestamp('2026-06-15T00:00:00'), Date.parse('2026-06-14T21:00:00Z'));
    assert.equal(A.dayKey(Date.parse('2026-06-14T21:00:00Z')), day);
    assert.equal(A.validDay('2026-02-30'), false); assert.equal(A.validDay('2026-02-28'), true);
  });
  test('последнее наблюдение СПП исключает отмены, возвраты, будущие и незаполненные цены', () => {
    const valid = sales('S1', 800, '2026-06-15T08:00:00Z', { spp: 0 });
    const rows = [valid, sales('S2', 0), sales('R3', 900), sales('S4', 900, undefined, { isCancel: true }), sales('S5', 800, '2026-06-16T10:00:00Z')];
    const got = A.latestSpp(rows, 'sales', {}, now)['11'];
    assert.equal(got.pct, 0); assert.equal(got.source, 'sales'); assert.equal(got.receivedAt, new Date(now).toISOString());
    assert.ok(!JSON.stringify(got).includes('saleID'));
  });
  test('повтор страницы выбирает последнюю отмену, не удваивает заказ', () => {
    const first = { nmId: 11, srid: 'one', date: '2026-06-15T08:00:00Z', lastChangeDate: '2026-06-15T08:01:00Z' };
    const got = A.dedupe([first, { ...first, isCancel: true, lastChangeDate: '2026-06-15T08:02:00Z' }, first], 'orders');
    assert.equal(got.length, 1); assert.equal(got[0].isCancel, true);
  });
  test('архив заменяет закрытые дни и не выдумывает текущий день или границу хранения', () => {
    const from = A.dayKey(now - 90 * A.DAY), row = sales('S1', 800);
    const arc = A.archiveSales(null, [row, row, sales('R2', 100)], from, now, true);
    assert.equal(Object.keys(arc.days).length, 89); assert.ok(!arc.days[day]);
    assert.deepEqual(arc.days[A.dayKey(now - A.DAY)].products['11'], { qty: 0, revenue: 700 });
    const again = A.archiveSales(arc, [], A.dayKey(now - A.DAY), now, true);
    assert.deepEqual(again.days[A.dayKey(now - A.DAY)].products, {});
  });
  test('неполная/повреждённая выгрузка не обнуляет ранее покрытую историю', () => {
    const from = A.dayKey(now - 30 * A.DAY), arc = A.archiveSales(null, [sales('S1', 800)], from, now, true);
    for (const [rows, complete] of [[[], false], [[{ nmId: 11, date: 'wrong' }], true], [[sales('', 800)], true]]) {
      const got = A.archiveSales(arc, rows, from, now, complete);
      assert.deepEqual(got.days, arc.days); assert.equal(got.lastComplete, false);
    }
    const midday = A.archiveSales(null, [], from + 'T12:00:00', now, true);
    assert.equal(Object.keys(midday.days).length, 29);
  });
  test('ABC 30/90/180 требует каждый день, равные вклады не разрезает, неизвестная прибыль — ?', () => {
    const days = {};
    for (let i = 1; i <= 180; i++) days[A.dayKey(now - i * A.DAY)] = { covered: true, products: { 11: { qty: 8, revenue: 800 }, 12: { qty: 1, revenue: 100 }, 13: { qty: 1, revenue: 100 } } };
    let result = A.abc({ days }, [11, 12, 13], (nm, rev) => nm === '11' ? null : rev * .2, now);
    for (const period of [30, 90, 180]) { assert.equal(result['11'][period].code, 'A?A'); assert.equal(result['12'][period].code, result['13'][period].code); }
    delete days[A.dayKey(now - 100 * A.DAY)]; result = A.abc({ days }, [11], () => 1, now);
    assert.equal(result['11'][90].known, true); assert.equal(result['11'][180].known, false); assert.equal(result['11'][180].missingDays, 1);
  });
  test('ABC не обещает 90/180 дней на основе единственного 89-дневного запроса', () => {
    const arc = A.archiveSales(null, [], A.dayKey(now - 90 * A.DAY), now, true), result = A.abc(arc, [11], () => 0, now)['11'];
    assert.equal(result[30].known, true); assert.equal(result[90].known, false); assert.equal(result[180].known, false);
  });

  const promos = [{ id: 2, name: 'Дорогая', planPrice: 200, absolutePlan: true, startDateTime: day, endDateTime: '2026-06-20' }, { id: 1, name: 'Дешёвая', planPrice: 100, absolutePlan: true, startDateTime: day, endDateTime: '2026-06-20' }];
  const config = { startDate: day, durationDays: 2, startedAt: new Date(now).toISOString(), runId: 'test-run', steps: [{ promoId: '2', quota: 1, minMarginPct: 0 }, { promoId: '1', quota: 2, minMarginPct: 0 }] };
  const context = { nmID: 11, sellerPrice: 250, promos, priceObservedAt: now, econAt: (price) => ({ profit: price * .2, marginPct: 20 }) };
  const snap = (at = now, rows = []) => ({ at, rows, complete: true, day: A.dayKey(at), context: 'cabinet' });
  const order = (srid, at, price, more = {}) => ({ nmId: 11, srid, date: new Date(at).toISOString(), priceWithDisc: price, ...more });
  let plan;
  test('лесенка исполняется по возрастанию порогов; до подтверждённой цены заказы не считает', () => {
    plan = B.plan(context, config, null, snap(now, [order('before', now - 1, 100)]), 'cabinet', now);
    assert.equal(plan.target, 100); assert.equal(plan.count, 0); assert.equal(plan.counting, false);
  });
  test('свежая установленная цена активирует счётчик; дубль заказа учитывается один раз', () => {
    const t = now + 1000; plan = B.plan({ ...context, sellerPrice: 100, priceObservedAt: t }, config, plan.runtime, snap(t, [order('before', now - 1, 100), order('new-1', t, 100), order('new-1', t, 100)]), 'cabinet', t);
    assert.equal(plan.count, 1); assert.equal(plan.counting, true); assert.equal(plan.target, 100);
    assert.ok(!JSON.stringify(plan.runtime).includes('new-1'));
  });
  test('квота переводит к следующей более высокой цене, не считает заказы до её установки', () => {
    const t = now + 2000; plan = B.plan({ ...context, sellerPrice: 100, priceObservedAt: t }, config, plan.runtime, snap(t, [order('new-1', now + 1000, 100), order('new-2', t, 100), order('too-early', t, 200)]), 'cabinet', t);
    assert.equal(plan.target, 200); assert.equal(plan.count, 0); assert.equal(plan.counting, false); assert.deepEqual(plan.runtime.completed, ['1']);
  });
  test('поздняя отмена уменьшает счётчик без возврата на дешёвую ступень', () => {
    const t = now + 3000; plan = B.plan({ ...context, sellerPrice: 200, priceObservedAt: t }, config, plan.runtime, snap(t, [order('new-1', now + 1000, 100, { isCancel: true })]), 'cabinet', t);
    assert.equal(plan.target, 200); assert.equal(plan.runtime.counts['1'], 1); assert.deepEqual(plan.runtime.completed, ['1']);
  });
  test('после последней квоты — безопасный выход выше порога', () => {
    const t = now + 4000; plan = B.plan({ ...context, sellerPrice: 200, priceObservedAt: t }, config, plan.runtime, snap(t, [order('last', t, 200)]), 'cabinet', t);
    assert.equal(plan.status, 'day-complete'); assert.ok(plan.target > 200); assert.equal(plan.exit, true);
  });
  test('00:00 МСК сбрасывает дневной счётчик, срок работы прекращает новые циклы', () => {
    const tomorrow = A.timestamp('2026-06-16'), ctx = { ...context, priceObservedAt: tomorrow };
    const reset = B.plan(ctx, config, plan.runtime, snap(tomorrow), 'cabinet', tomorrow);
    assert.equal(reset.target, 100); assert.deepEqual(reset.runtime.counts, {});
    const expired = B.plan(ctx, config, plan.runtime, null, 'cabinet', A.timestamp('2026-06-17'));
    assert.equal(expired.status, 'expired'); assert.ok(expired.target > 200);
  });
  for (const [name, snapshot] of [['отсутствующий', null], ['неполный', { ...snap(), complete: false }], ['устаревший', snap(now - 180001)], ['чужой кабинет', { ...snap(), context: 'another' }], ['неверный день', { ...snap(), day: '2026-06-14' }]]) test('лесенка блокирует ' + name + ' снимок', () => assert.equal(B.plan(context, config, null, snapshot, 'cabinet', now).blocked, true));
  test('нет порога/даты, одинаковые пороги или изменившиеся доказательства блокируют лесенку', () => {
    for (const list of [[], promos.map((p) => ({ ...p, absolutePlan: false })), promos.map((p) => ({ ...p, planPrice: 100 })), promos.map((p) => ({ ...p, endDateTime: '' }))]) assert.equal(B.plan({ ...context, promos: list }, config, null, snap(), 'cabinet', now).blocked, true);
    assert.equal(B.plan({ ...context, promos: promos.map((p) => ({ ...p, planPrice: p.planPrice + 1 })) }, config, plan.runtime, snap(now + 5000), 'cabinet', now + 5000).blocked, true);
  });
  test('перезапуск после импорта и опасная маржа требуют решения пользователя', () => {
    assert.equal(B.plan(context, { ...config, requiresRestart: true }, null, snap(), 'cabinet', now).blocked, true);
    assert.equal(B.plan({ ...context, econAt: () => ({ marginPct: -1 }) }, config, null, snap(), 'cabinet', now).blocked, true);
    for (const bad of [{ ...config, durationDays: 0 }, { ...config, startDate: '2026-02-30' }, { ...config, steps: [config.steps[0], config.steps[0]] }, { ...config, steps: [{ ...config.steps[0], quota: 0 }] }]) assert.throws(() => B.validate(bad));
  });
  test('округлённый выход и размерный режим повторно проверяются перед отправкой', () => {
    const result = { current: { sellerPrice: 200 }, proposed: { basePrice: 200, discount: 0, marginPct: 20 }, corridor: { min: 1 }, context: { sizePriceMode: 'none' } };
    assert.equal(B.checkResult(result, { status: 'day-complete', exit: true, threshold: 200 }).blocked, true);
    assert.equal(B.checkResult(result, { status: 'step', threshold: 200, minMarginPct: 0 }, { editableSizePrice: true, sizes: [{ sizeID: 1 }] }).blocked, true);
  });

  await clientCases();
  await serviceCases();
}
async function clientCases() {
  const client = new WBClient({ single: 'synthetic-no-network-key' });
  await asyncTest('официальные historyGoods: GoodStatus=2 успех, 3 ошибка, обязательные uploadID/limit/offset', async () => {
    const calls = [];
    client.request = async (category, method, url, opts) => { calls.push({ category, method, url, opts }); const offset = opts.query.offset; return { data: { historyGoods: offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ nmID: i + 1, status: i === 1 ? 3 : 2, errorText: '' })) : [{ nmID: 1001, status: 1 }] } }; };
    const details = await client._collectUploadDetails([{ response: { data: { id: 99 } } }]);
    assert.equal(details.length, 1001); assert.equal(details[0].applied, true); assert.equal(details[1].applied, false); assert.equal(details[1].status, 6); assert.equal(details[1000].status, 1);
    assert.deepEqual(calls.map((c) => c.opts.query), [{ uploadID: 99, limit: 1000, offset: 0 }, { uploadID: 99, limit: 1000, offset: 1000 }]);
  });
  await asyncTest('ошибка следующей страницы не подтверждает первую; соседняя upload-задача сохраняет успех', async () => {
    client.request = async (_c, _m, _u, { query }) => {
      if (query.uploadID === 22) return { data: { uploadID: 22, historyGoods: [{ nmID: 5000, sizeID: 8, status: 2 }] } };
      if (query.offset) throw new Error('сбой второй страницы');
      return { data: { historyGoods: Array.from({ length: 1000 }, (_, i) => ({ nmID: i + 1, sizeID: 1, status: 2 })) } };
    };
    const result = await client._collectUploadDetails([{ response: { data: { id: 21 } } }, { response: { data: { id: 22 } } }]);
    assert.equal(result.filter((r) => r.taskId === 21 && r.historyComplete).length, 0);
    assert.equal(result.find((r) => r.taskId === 21 && r.pending).historyComplete, false);
    assert.equal(result.find((r) => r.taskId === 22).historyComplete, true);
  });
  for (const [name, data] of [
    ['незнакомая структура', { goods: [{ nmID: 1, status: 2 }] }],
    ['нет nmID', { historyGoods: [{ sizeID: 1, status: 2 }] }],
    ['повтор размера', { historyGoods: [{ nmID: 1, sizeID: 2, status: 2 }, { nmID: 1, sizeID: 2, status: 2 }] }],
    ['чужой uploadID', { uploadID: 999, historyGoods: [{ nmID: 1, status: 2 }] }]
  ]) await asyncTest('история: ' + name + ' не превращается в подтверждение всей задачи', async () => {
    client.request = async () => ({ data });
    const result = await client._collectUploadDetails([{ response: { data: { id: 55 } } }]);
    assert.ok(result.some((r) => r.pending)); assert.ok(result.every((r) => r.historyComplete === false));
  });
  await asyncTest('ответ без uploadID остаётся pending и не запрашивает выдуманный ID', async () => {
    client.request = async () => { throw new Error('запроса быть не должно'); };
    const result = await client._collectUploadDetails([{ response: { data: {} } }]);
    assert.equal(result.length, 1); assert.equal(result[0].pending, true); assert.equal(result[0].taskId, undefined);
  });
  await asyncTest('ошибка второй пачки сохраняет факт первой, не объявляет отправленными все 1001 строк', async () => {
    let n = 0; client.request = async () => { if (++n === 2) throw new Error('синтетическая ошибка'); return { data: { id: 123 } }; };
    const res = await client.applyPrices(Array.from({ length: 1001 }, (_, i) => ({ nmID: i + 1, price: 100, discount: 0 })), { waitDetails: false });
    assert.equal(res.uploaded, 1000); assert.equal(res.batches.length, 1); assert.match(res.partialError.message, /синтетическая/);
  });
  await asyncTest('статус проверяется только по известному uploadID', async () => {
    let query; client.request = async (_c, _m, _u, opts) => { query = opts.query; return { data: { uploadID: 123, status: 3, overAllGoodsNumber: 10 } }; };
    const res = await client.uploadStates([123, 123]); assert.deepEqual(query, { uploadID: 123 }); assert.equal(res.length, 1); assert.equal(res[0].goodsCount, 10);
  });
}
async function stand(sizeMode = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v4-')); roots.push(dir);
  const store = createStore(dir); store.saveSettings({ demoMode: true, firstRun: false });
  const service = createService(store, () => {}); services.push(service);
  const goods = (await service.getDemo().getGoods()).items.slice(0, 3).map((g, i) => ({ ...g, editableSizePrice: sizeMode && i === 0, sizes: sizeMode && i === 0 ? [{ sizeID: 1001, price: g.price }, { sizeID: 1002, price: g.price }] : [] }));
  service.getDemo().getGoods = async () => ({ items: JSON.parse(JSON.stringify(goods)), source: 'demo', complete: true, scope: 'full', total: goods.length, totalKnown: true });
  await service.handlers['wb:goods']({ force: true });
  await service.handlers['costs:save']({ items: Object.fromEntries(goods.map((g) => [String(g.nmID), { costPriceRub: 100, otherPct: 2, otherRub: 3, currency: 'RUB' }])) });
  await service.handlers['repricer:item-configs:save']({ items: Object.fromEntries(goods.map((g, i) => [String(g.nmID), { minPrice: 200, sizePriceMode: sizeMode && i === 0 ? 'sync' : 'none' }])) });
  return { store, service, goods };
}
async function serviceCases() {
  await asyncTest('частичные/pending ответы сохраняют все позиции предложения, фактическая история — только confirmed', async () => {
    const { service, store, goods } = await stand();
    await service.handlers['repricer:item-configs:save']({ items: Object.fromEntries(goods.map((g) => [String(g.nmID), { minPrice: Math.round(g.price * 0.85) }])) });
    await service.handlers['repricer:calc']({ full: true }); const prop = await service.handlers['repricer:proposal'](); assert.equal(prop.items.length, 3);
    service.getDemo().applyPrices = async (items) => ({ uploaded: items.length, batches: [], details: items.map((r, i) => ({ nmID: r.nmID, status: [3, 6, 1][i], errorText: i === 1 ? 'синтетический отказ' : '' })) });
    const result = await service.handlers['repricer:proposal-send'](); assert.equal(result.sent, 3); assert.equal(result.confirmed, 1);
    const after = store.loadProposals(); assert.equal(after.items.length, 3); assert.deepEqual(after.items.map((x) => x.sendState).sort(), ['confirmed', 'pending', 'rejected']); assert.equal(after.phase, 'pending'); assert.equal(after.sendAt, null);
    assert.equal(Object.values(store.loadPriceHistory()).flat().length, 1);
    assert.equal(Object.values(store.loadRecalcHistory()).flat().filter((r) => r.phase === 'submitted' && !r.sent).length, 2);
    await assert.rejects(() => service.handlers['repricer:proposal-send'](), /уже отправлено|устарело/);
    assert.equal(store.loadPriceDrafts, undefined); // ручных черновиков цен в хранилище больше нет
  });
  await asyncTest('отметка первого расчёта не сбрасывается сохранением настроек товара', async () => {
    const { service, store, goods } = await stand(), nm = String(goods[0].nmID);
    await service.handlers['repricer:calc']({ full: true });
    const seededAt = (store.loadItemConfigs()[nm] || {}).floorSeededAt; assert.ok(seededAt, 'первый расчёт должен посадить цену на порог');
    await service.handlers['repricer:item-configs:save']({ items: { [nm]: { minPrice: 300 } } });
    assert.equal((store.loadItemConfigs()[nm] || {}).floorSeededAt, seededAt);
    const calc2 = await service.handlers['repricer:calc']({ full: true });
    assert.equal(calc2.results.find((r) => String(r.nmID) === nm).firstCalcSeeded, false);
  });
  await asyncTest('неподтверждённая общая скидка не запускает отправку цен размеров и не считается полным успехом', async () => {
    const { service, goods } = await stand(true), good = goods[0]; let sizeCalls = 0;
    service.getDemo().applyPrices = async (items) => ({ uploaded: items.length, details: items.map((r) => ({ ...r, status: 1 })) });
    service.getDemo().applySizePrices = async () => { sizeCalls++; throw new Error('не должно вызываться'); };
    const result = await service.handlers['repricer:send']({ items: [{ nmID: good.nmID, price: Math.round(good.price * 1.02), discount: good.discount + 1 }] });
    assert.equal(sizeCalls, 0); assert.equal(result.confirmed, 0); assert.equal(result.sent, 1); assert.ok(result.warnings.some((w) => w.type === 'discount-pending'));
  });
  await asyncTest('auto: разные размеры пропускаются только у своего товара, сосед отправляется и подтверждается', async () => {
    const { service, goods, store } = await stand(true), first = goods[0], second = goods[1]; let posts = [];
    first.sizes[1].price += 100;
    await service.handlers['wb:goods']({ force: true });
    await service.handlers['repricer:item-configs:save']({ items: { [first.nmID]: { sizePriceMode: 'none' } } });
    await service.handlers['repricer:item-configs:save']({ items: Object.fromEntries([first, second].map((g) => [String(g.nmID), { minPrice: Math.round(g.price * 0.85) }])) });
    // без авто-действий по акциям: цена порога достигается изменением базовой цены товара
    await service.handlers['repricer:save']({ promo: { autoJoin: false, autoExitAutoPromos: false, autoExitManualPromos: false } });
    await service.handlers['repricer:calc']({ full: true });
    service.getDemo().applyPrices = async (items) => { posts.push(...items); return { uploaded: items.length, details: items.map((r) => ({ nmID: r.nmID, status: 3 })) }; };
    service.getDemo().applySizePrices = async () => { throw new Error('size API не должен вызываться в none'); };
    const result = await service.handlers['repricer:proposal-send']({ source: 'repricer-auto', nmIDs: [first.nmID, second.nmID] });
    assert.deepEqual(posts.map((r) => r.nmID), [second.nmID]); assert.deepEqual(result.confirmedIDs, [second.nmID]);
    assert.ok(result.warnings.some((w) => Number(w.nmID) === first.nmID && w.type === 'size-equalize-blocked'), JSON.stringify({ warnings: result.warnings, proposal: store.loadProposals().items.filter((r) => [first.nmID, second.nmID].includes(r.nmID)) }));
    assert.equal(store.loadProposals().items.find((r) => r.nmID === first.nmID).sendState, 'blocked');
    assert.equal(store.loadPriceHistory()[first.nmID], undefined);
  });
  for (const incomplete of ['missing-size', 'partial-page']) await asyncTest('общая цена: ' + incomplete + ' не запускает size-этап и не создаёт ложную историю', async () => {
    const { service, goods, store } = await stand(true), good = goods[0]; let sizeCalls = 0;
    service.getDemo().applyPrices = async (items) => ({ uploaded: items.length, details: good.sizes.slice(0, incomplete === 'missing-size' ? 1 : 2).map((size) => ({ nmID: good.nmID, sizeID: size.sizeID, taskId: 100, status: 3, rawGoodStatus: 2, historyComplete: incomplete !== 'partial-page' })) });
    service.getDemo().applySizePrices = async () => { sizeCalls++; throw new Error('не вызывать'); };
    const result = await service.handlers['repricer:send']({ items: [{ nmID: good.nmID, price: Math.round(good.price * 1.02), discount: good.discount + 1 }] });
    assert.equal(sizeCalls, 0); assert.equal(result.confirmed, 0); assert.equal(store.loadPriceHistory()[good.nmID], undefined);
    const task = store.loadTasks()[0]; assert.equal(task.ok, 0); assert.equal(task.failed, 0); assert.equal(task.pending, 1);
  });
  await asyncTest('полная история common+size подтверждает продукт; все цены размеров сохраняются после перезапуска store', async () => {
    const { service, goods, store } = await stand(true), good = goods[0], target = Math.round(good.price * 1.02); let calls = 0;
    service.getDemo().applyPrices = async (items) => ({ uploaded: items.length, details: good.sizes.map((size) => ({ nmID: good.nmID, sizeID: size.sizeID, taskId: 101, status: 3, rawGoodStatus: 2, historyComplete: true })) });
    service.getDemo().applySizePrices = async (items) => { calls++; return { uploaded: items.length, details: items.map((row) => ({ ...row, taskId: 102, status: 3, rawGoodStatus: 2, historyComplete: true })) }; };
    const result = await service.handlers['repricer:send']({ items: [{ nmID: good.nmID, price: target, discount: good.discount + 1 }] });
    assert.equal(calls, 1); assert.deepEqual(result.confirmedIDs, [good.nmID]);
    const saved = createStore(store.dir).loadPriceHistory()[good.nmID].at(-1);
    assert.deepEqual(saved.sizePrices, { 1001: target, 1002: target }); assert.equal(saved.discount, good.discount + 1);
  });
  await asyncTest('успешная общая скидка и ошибка размера сохраняют принятый common, но не объявляют весь товар установленным', async () => {
    const { service, goods, store } = await stand(true), good = goods[0];
    service.getDemo().applyPrices = async (items) => ({ uploaded: items.length, batches: [{ response: { data: { id: 111 } }, items }], details: good.sizes.map((size) => ({ nmID: good.nmID, sizeID: size.sizeID, taskId: 111, status: 3, rawGoodStatus: 2, historyComplete: true })) });
    service.getDemo().applySizePrices = async (items) => ({ uploaded: items.length, batches: [{ response: { data: { id: 112 } }, items }], details: items.map((row, i) => ({ ...row, status: i ? 6 : 3, errorText: i ? 'отказ размера' : '' })) });
    const result = await service.handlers['repricer:send']({ items: [{ nmID: good.nmID, price: Math.round(good.price * 1.02), discount: good.discount + 1 }] });
    assert.equal(result.sent, 1); assert.equal(result.confirmed, 0); assert.equal(result.batches.length, 2);
    assert.ok(store.loadTasks().some((r) => r.uploadIDs.includes(111) && r.ok === 1)); assert.equal(store.loadPriceHistory()[good.nmID], undefined);
  });
  await asyncTest('foreign currency: исходные 40 CNY проходят карточку/расчёт/сохранение без повторной конвертации', async () => {
    const { service, goods, store } = await stand(), nm = goods[0].nmID;
    await service.handlers['settings:save']({ costRates: { CNY: 13 } });
    await service.handlers['costs:save']({ items: { [nm]: { costPriceRub: 40, currency: 'CNY', otherPct: 3, otherRub: 7 } } });
    const card = await service.handlers['items:card']({ nmID: nm });
    assert.equal(card.enteredCosts.costEntered, 40); assert.equal(card.enteredCosts.costPriceRub, 520); assert.equal(card.enteredCosts.currency, 'CNY'); assert.equal(card.overrides.costPriceRub, 520); assert.equal(card.overrides.costEntered, 40);
    const row = (await service.handlers['repricer:calc']({ full: true })).results.find((r) => r.nmID === nm);
    near(row.current.costPriceRub, 520); assert.equal(row.cost.entered, 40); assert.equal(row.cost.currency, 'CNY');
    await service.handlers['costs:save']({ items: { [nm]: { otherRub: 8 } } });
    const again = await service.handlers['items:card']({ nmID: nm }); assert.equal(again.enteredCosts.costEntered, 40); assert.equal(again.enteredCosts.costPriceRub, 520); near(again.overrides.costPriceRub, 520);
    assert.equal(createStore(store.dir).loadCosts().items[nm].costEntered, 40); assert.equal(createStore(store.dir).loadCosts().items[nm].costPriceRub, 520);
  });
  await asyncTest('импорт/экспорт raw currency и прочих расходов не теряет CNY и не меняет масштаб себестоимости', async () => {
    const { service, goods, store } = await stand(), nm = goods[0].nmID;
    await service.handlers['settings:save']({ costRates: { CNY: 13 } });
    await service.handlers['costs:import']({ rows: [{ nmID: nm, costPriceRub: '40', currency: 'CNY', otherPct: '3,5', otherRub: '7' }] });
    let c = (await service.handlers['items:card']({ nmID: nm })); assert.equal(c.enteredCosts.currency, 'CNY'); assert.equal(c.enteredCosts.costEntered, 40); near(c.overrides.costPriceRub, 520); near(c.overrides.otherPct, 3.5);
    const rows = [{ nmID: nm, ...store.loadCosts().items[nm] }];
    await service.handlers['costs:import']({ rows }); c = await service.handlers['items:card']({ nmID: nm }); near(c.overrides.costPriceRub, 520);
    await assert.rejects(() => service.handlers['costs:import']({ rows: [{ nmID: nm, currency: 'FAKE', costPriceRub: 100 }] }), /код валюты|Неизвестная валюта/);
    assert.equal(store.loadCosts().items[nm].costEntered, 40); assert.equal(store.loadCosts().items[nm].costPriceRub, 520);
  });
  await asyncTest('шаблоны/параметры не включают планировщик и не включают автоотправку', async () => {
    const { service, store } = await stand();
    await service.handlers['strategies:template']({ strategy: 'margin', values: { targetMarginPct: 33 } });
    const state = await service.handlers['repricer:state'](); assert.equal(state.config.enabled, false); assert.equal(state.config.schedule.autoSend, false);
    assert.equal(state.config.strategyTemplates.margin.targetMarginPct, 33);
    await service.handlers['strategies:template']({ strategy: 'margin', values: null }); assert.equal(store.loadRepricer().strategyTemplates.margin, undefined);
  });
  await asyncTest('критическая ошибка одного товара не блокирует безопасного соседа', async () => {
    const { service, goods } = await stand();
    await service.handlers['costs:save']({ items: { [String(goods[0].nmID)]: { costPriceRub: 2 } } });
    const calc = await service.handlers['repricer:calc']({ full: true }); assert.equal(calc.results.find((r) => r.nmID === goods[0].nmID).autoBlocked, true); assert.equal(calc.results.find((r) => r.nmID === goods[1].nmID).autoBlocked, false);
    const res = await service.handlers['wb:apply-prices']({ items: goods.slice(0, 2).map((g) => ({ nmID: g.nmID, price: Math.round(g.price * 1.01), discount: g.discount })) });
    assert.deepEqual(res.sentItems.map((r) => r.nmID), [goods[1].nmID]);
  });
}
main().catch((e) => { failed++; console.error('FAIL v4: исключение — ' + e.stack); }).finally(() => {
  services.forEach((s) => s.dispose()); roots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  console.log(`\nИТОГО v4 backend: ${passed} пройдено, ${failed} ошибок`); process.exitCode = failed ? 1 : 0;
});
