'use strict';

/** Контракт финансового отчёта: продажа + возврат одной единицы неттится в P&L и byDay. */
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { WBClient } = require('../../electron/wb-client');

let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log('OK   finance-contract: ' + name); } catch (e) { fail++; console.error('FAIL finance-contract: ' + name + ' — ' + e.stack); } }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-finance-contract-'));
  const originalRequest = WBClient.prototype.request;
  try {
    const store = createStore(dir);
    store.saveSecrets({ prices: 'x', statistics: 'x', finance: 'x', content: 'x' });
    store.saveSettings({ demoMode: false, taxMode: 'none', taxRate: 0, taxVatRate: 22, adPctDefault: 0, packagingRub: 0 });
    const svc = createService(store, () => {});
    await svc.handlers['costs:save']({ items: { '1': { costPriceRub: 500, currency: 'RUB', packagingRub: 0, adPct: 0 } } });

    const today = new Date().toISOString().slice(0, 10);
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let page = 0;
    WBClient.prototype.request = async (_s, _m, url) => {
      if (url === '/api/finance/v1/sales-reports/detailed') {
        return page++ === 0 ? [
          { rrdId: 1, nmId: 1, docTypeName: 'Продажа', rrDate: today, quantity: 1, retailAmount: 1600, ppvzSalesCommission: 300, ppvzForPay: 1300, deliveryRub: 100 },
          { rrdId: 2, nmId: 1, docTypeName: 'Возврат', rrDate: today, quantity: 1, retailAmount: 1600, ppvzSalesCommission: 300, ppvzForPay: 1300, returnCost: 50 }
        ] : [];
      }
      return [];
    };
    await svc.handlers['facts:load']({ dateFrom: yday, dateTo: today, save: true });
    const pl = await svc.handlers['reports:pl']({ cachedOnly: true });
    const item = (pl.items || []).find((x) => Number(x.nmID) === 1) || {};

    await check('P&L неттит выручку, комиссию и ForPay возврата', async () => {
      assert.equal(Number(item.revenue), 0); assert.equal(Number(item.commission), 0); assert.equal(Number(item.forPay), 0);
      assert.equal(Number(item.logistics), 150);
    });
    await check('дневная динамика совпадает с P&L', async () => {
      const day = (pl.byDay || []).find((x) => x.date === today) || {};
      assert.equal(Number(day.revenue), 0); assert.equal(Number(day.forPay), 0); assert.equal(Number(day.returnsQty), 1);
    });
    await check('обе прибыли по возвращённой себестоимости показаны', async () => {
      assert.equal(Number(item.returnedCogs), 500);
      assert.equal(Number(item.profit), -150);
      assert.equal(Number(item.profitWithReturnCogs), -650);
    });
    await check('известный нулевой ForPay не заменяется фолбэком', async () => {
      assert.equal(Number(pl.totals.forPay), 0); assert.equal(Number(pl.totals.revenue), 0);
    });
  } finally {
    WBClient.prototype.request = originalRequest;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nИТОГО finance-contract: ${pass} пройдено, ${fail} ошибок`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
