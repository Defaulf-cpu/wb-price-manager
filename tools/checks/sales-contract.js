'use strict';

/** Контракт сырого ответа WB: только поля официальной спецификации, без «удобных» price/ppvz_for_pay/isReturn. */
const assert = require('assert/strict');
const { WBClient } = require('../../electron/wb-client');

let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log('OK   sales-contract: ' + name); } catch (e) { fail++; console.error('FAIL sales-contract: ' + name + ' — ' + e.stack); } }

(async () => {
  await check('продажа/возврат и отменённый заказ из сырого WB JSON', async () => {
    const c = new WBClient({ keys: { statistics: 'x' } });
    c.request = async (_s, _m, url) => (url === '/api/v1/supplier/sales'
      ? [{ saleID: 'S1', date: '2026-11-10T10:00:00', nmId: 1, priceWithDisc: 800, forPay: 700, spp: 20 },
         { saleID: 'R2', date: '2026-11-11T10:00:00', nmId: 1, priceWithDisc: 0, forPay: 0, spp: 0 }]
      : url === '/api/v1/supplier/orders'
        ? [{ nmId: 1, totalPrice: 1000, isCancel: false }, { nmId: 1, totalPrice: 1000, isCancel: true }]
        : []);
    const agg = (await c.getSalesAggregated('2026-10-01T00:00:00', { withOrders: true, maxPages: 1 })).find((x) => Number(x.nmID) === 1) || {};
    assert.equal(agg.salesQty, 1); assert.equal(agg.returnsQty, 1);
    assert.equal(agg.salesSum, 800); assert.equal(agg.salesForPay, 700); assert.equal(agg.ordersQty, 1);
  });
  await check('наблюдаемый нулевой остаток не равен отсутствию данных', async () => {
    const agg = WBClient.aggregateStocks([{ nmID: 2, stock: 0 }])[2];
    assert.ok(agg); assert.equal(agg.total, 0); assert.equal(agg.observed, true); assert.equal(agg.sizeRows, 0);
  });
  console.log(`\nИТОГО sales-contract: ${pass} пройдено, ${fail} ошибок`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
