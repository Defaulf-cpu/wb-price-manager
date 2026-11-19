'use strict';
/* Свои стратегии (формат INDEEPA): правила сверху вниз, первое сработавшее побеждает. */
const assert = require('assert/strict');
const RP = require('../../electron/repricer-engine');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('OK   custom-strategy: ' + name); }
function basicEcon(price) { return { revenue: price, profit: price - 400, marginPct: price > 0 ? ((price - 400) / price) * 100 : 0 }; }
function ctx(patch) {
  return Object.assign({
    nmID: 101, vendorCode: 'CS-101', title: 'Custom strategy item', basePrice: 2000, discount: 25,
    sellerPrice: 1500, buyerPrice: 1290, stock: 25, salesPerDay: 12, salesMonthQty: 100, turnoverDays: 2,
    inPromo: false, promoPrice: null, competitors: [{ id: 'c1', name: 'C', price: 1400, stock: 5, enabled: true }],
    forPayAvg: 1500, sppPct: 14, params: { costPriceRub: 700 }, econAt: basicEcon,
    now: Date.UTC(2026, 0, 15, 12), priceFromSizes: false
  }, patch || {});
}
function cfg(def) {
  return RP.mergeConfig({
    enabled: true, marginMode: 'discounted', priceEdit: { walletPct: 0 },
    limits: { maxChangePerUpdatePct: 0, maxChangePerDayPct: 0, blockQuarantine: true },
    defaults: { strategy: 'hold', targetMarginPct: 20, minMarginPct: 0, allowNegativeMargin: true, oosProtection: false, beautifulPrice: { enabled: false } },
    customStrategies: def ? [def] : []
  });
}
const el = (left, op, right, rightType) => ({ leftExpressionType: 10, leftExpression: left, compareOperator: op, rightExpressionType: rightType ? 10 : 0, rightExpression: String(right), rightExpression2: null });
const rule = (name, elements, alias, changeType, valueType, amount) => ({
  name, enabled: true, schedule: null,
  conditions: [{ isOr: false, elements, children: [] }],
  priceCalcConfig: { useConfig: true, priceCalcExpression: null, priceCalcExpressionConfig: { inputFieldAlias: alias, changeType, valueType, changeAmount: amount } }
});
// Лесенка в стиле INDEEPA «конкурент + дневной план»: пороги сверху вниз.
const ladder = {
  id: 'custom-ladder', name: 'Конкурент + план (тест)', enabled: true, ignoreMaximums: false,
  rules: [
    rule('Продажи выше 10/день — конкурент +10%', [el('SumStock', 70, 3), el('SalesPerDay', 70, 10), el('CompetitorPrice', 70, 9)], 'CompetitorPrice', 10, 10, 10),
    rule('Продажи выше 5/день — как у конкурента', [el('SumStock', 70, 3), el('SalesPerDay', 70, 5), el('CompetitorPrice', 70, 9)], 'CompetitorPrice', 30, 0, 0),
    rule('Мало продаж — конкурент −5%', [el('SumStock', 70, 3), el('CompetitorPrice', 70, 9)], 'CompetitorPrice', 20, 10, 5)
  ]
};

check('валидация принимает корректную стратегию и отвергает мусор', () => {
  assert.equal(RP.validateCustomStrategy(ladder), '');
  assert.match(RP.validateCustomStrategy({ name: 'x', rules: [] }), /правило/);
  assert.match(RP.validateCustomStrategy({ name: 'x', rules: [rule('r', [], 'NoSuchField', 30, 0, 0)] }), /неизвестный исходный показатель/);
  assert.match(RP.validateCustomStrategy({ name: 'x', rules: [rule('r', [], 'SellerPrice', 30, 0, -5)] }), /неотрицательным/);
});

check('первое сработавшее правило побеждает (верхний порог перехватывает нижние)', () => {
  const hit = RP.evaluateCustomStrategy(ladder, { SumStock: 25, SalesPerDay: 12, CompetitorPrice: 1400 });
  assert.equal(hit.ruleName, 'Продажи выше 10/день — конкурент +10%');
  assert.equal(hit.price, 1540);
  const mid = RP.evaluateCustomStrategy(ladder, { SumStock: 25, SalesPerDay: 7, CompetitorPrice: 1400 });
  assert.equal(mid.price, 1400);
});

check('нет конкурента — правила с валидатором CompetitorPrice > 9 не срабатывают', () => {
  assert.equal(RP.evaluateCustomStrategy(ladder, { SumStock: 25, SalesPerDay: 12, CompetitorPrice: 0 }), null);
  assert.equal(RP.evaluateCustomStrategy(ladder, { SumStock: 0, SalesPerDay: 12, CompetitorPrice: 1400 }), null);
});

check('computeItem применяет свою стратегию и пишет правило в примечания', () => {
  const res = RP.computeItem(ctx(), cfg(ladder), { strategy: 'custom-ladder', basePriceTarget: 2000 });
  assert.equal(res.strategy, 'custom-ladder');
  assert.equal(res.strategyTitle, 'Конкурент + план (тест)');
  assert.ok(Math.abs(res.proposed.sellerPrice - 1540) < 1, String(res.proposed.sellerPrice)); // пара база+скидка округляется до целой базы
  assert.ok(res.notes.some((n) => /правило «Продажи выше 10\/день/.test(n)), res.notes.join(' | '));
});

check('коридор по-прежнему ограничивает свою стратегию снизу и сверху', () => {
  const res = RP.computeItem(ctx({ competitors: [{ id: 'c', price: 5000, stock: 5, enabled: true }] }), cfg(ladder), { strategy: 'custom-ladder', basePriceTarget: 2000 });
  assert.ok(Math.abs(res.proposed.sellerPrice - 2000) < 1, String(res.proposed.sellerPrice)); // потолок коридора, а не 5500
  const low = RP.computeItem(ctx(), cfg(ladder), { strategy: 'custom-ladder', basePriceTarget: 2000, minPrice: 1600 });
  assert.ok(Math.abs(low.proposed.sellerPrice - 1600) < 1, String(low.proposed.sellerPrice)); // пол minPrice выше цены правила 1540
});

check('выключенная стратегия и отсутствие совпадений цену не меняют', () => {
  const off = RP.computeItem(ctx(), cfg({ ...ladder, enabled: false }), { strategy: 'custom-ladder', basePriceTarget: 2000 });
  assert.equal(off.proposed.sellerPrice, 1500);
  const none = RP.computeItem(ctx({ competitors: [] }), cfg(ladder), { strategy: 'custom-ladder', basePriceTarget: 2000 });
  assert.equal(none.proposed.sellerPrice, 1500);
  assert.ok(none.notes.some((n) => /ни одно правило не сработало/.test(n)));
});

check('порог «минимальная Маржа, ₽» поднимает пол коридора', () => {
  // basicEcon: profit = price − 400. Прибыль 1200 ₽ достигается при цене 1600 ₽.
  const res = RP.computeItem(ctx(), cfg(null), { strategy: 'hold', basePriceTarget: 2000, minMarginRub: 1200, allowNegativeMargin: false });
  assert.equal(res.corridor.minByProfit, 1600);
  assert.equal(res.corridor.min, 1600);
});

check('максимальная Маржа (% и ₽) не даёт цене уйти в космос', () => {
  const byPct = RP.computeItem(ctx(), cfg(null), { strategy: 'margin', targetMarginPct: 20, basePriceTarget: 2000, maxMarginPct: 30, allowNegativeMargin: false });
  // маржа 30% при profit=price−400: price = 400/(1−0.30) ≈ 571 — но пол по умолчанию ниже; потолок должен ограничить сверху
  assert.ok(byPct.corridor.maxByMargin > 0 && byPct.proposed.sellerPrice <= byPct.corridor.maxByMargin + 1, JSON.stringify(byPct.corridor));
  const byRub = RP.computeItem(ctx(), cfg(null), { strategy: 'hold', basePriceTarget: 2000, maxMarginRub: 900 });
  assert.equal(byRub.corridor.maxByProfit, 1300); // profit 900 при цене 1300
});

check('конфликт порогов: минимальный побеждает и пишется предупреждение', () => {
  const res = RP.computeItem(ctx(), cfg(null), { strategy: 'hold', basePriceTarget: 2000, minPrice: 1800, maxMarginRub: 100 });
  assert.equal(res.corridor.min, 1800);
  assert.ok(res.warnings.some((w) => /Пороги конфликтуют/.test(w)), res.warnings.join(' | '));
});

check('блок «Цена (вне акции)»: целевая Маржа в ₽ задаёт обычную цену', () => {
  // profit = price − 400; прибыль 1200 ₽ достигается при цене 1600 ₽.
  const res = RP.computeItem(ctx(), cfg(null), { strategy: 'margin', targetMarginPct: 0, targetMarginRub: 1200, basePriceTarget: 2000 });
  assert.ok(Math.abs(res.proposed.sellerPrice - 1600) < 1, String(res.proposed.sellerPrice));
});

console.log('\nИТОГО custom-strategy: ' + passed + ' пройдено, 0 ошибок');
