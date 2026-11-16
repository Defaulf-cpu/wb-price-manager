'use strict';

/**
 * Прогон загрузки остатков по складам WB.
 *
 * Что проверяем (это то, что просил пользователь):
 *  1. Пагинация отчёта stocks-report/wb-warehouses собирает все страницы.
 *  2. Лимит категории «Аналитика» (1 запрос в 20 с) соблюдается — по журналу
 *     запросов и времени между ними.
 *  3. 429 — раздел уходит в фоновую догрузку, загруженные остатки не теряются.
 *  4. Метод GET /api/v1/supplier/stocks НЕ вызывается ни разу (он отключён WB).
 *  5. Пустой ответ WB не затирает прежние остатки.
 *  6. Агрегация по nmID верна: сумма по складам + разбивка по складам и регионам.
 *  7. Бейдж «заканчивается» появляется при запасе меньше stocksLowDays.
 *  8. keys:check честно сообщает об отсутствующей категории «Аналитика».
 *  9. Контекст репрайсера берёт остаток из WB, когда остатки загружены.
 *
 * Запуск: node tools/checks/stocks-flow.js
 */

// Масштаб лимитов WB для теста: «1 запрос в 20 с» превращается в 1 с, чтобы
// проверить соблюдение интервала по журналу запросов без реальных 20 секунд.
// Следует ставить ДО require('../../electron/config'), который читает переменную
// при загрузке модуля.
process.env.WB_RATE_LIMIT_SCALE = '0.05';

const fs = require('fs');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { WBClient } = require('../../electron/wb-client');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK   ' + name + (detail ? ' — ' + detail : '')); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

// ───────────────────────── заглушка сети ─────────────────────────

const calls = [];

function res(status, body, headers) {
  const h = headers || {};
  const text = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        for (const hk of Object.keys(h)) if (hk.toLowerCase() === key) return String(h[hk]);
        return null;
      }
    },
    text: async () => text
  };
}

// фикстуры остатков: 3 строки на 2 товара, по складам и регионам
const PAGE1 = {
  data: {
    rows: [
      { nmID: 101, sizeID: 501, stock: 10, warehouseId: 1, warehouseName: 'Коледино', region: 'Москва и МО' },
      { nmID: 102, sizeID: 502, stock: 5, warehouseId: 1, warehouseName: 'Коледино', region: 'Москва и МО' }
    ],
    total: 3
  }
};
const PAGE2 = {
  data: {
    rows: [
      { nmID: 101, sizeID: 501, stock: 20, warehouseId: 2, warehouseName: 'Электросталь', region: 'Московская область' }
    ]
  }
};

let analyticsStatus = 200;
let analyticsEmpty = false;

global.fetch = async (url, init) => {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  calls.push({ url: u, method, time: Date.now(), body: init && init.body });

  if (u.indexOf('/api/analytics/v1/stocks-report/wb-warehouses') >= 0) {
    if (analyticsStatus === 429) {
      return res(429, { error: true, errorText: 'rate limited' }, { 'x-ratelimit-retry': '3' });
    }
    if (analyticsStatus === 403) {
      return res(403, { error: true, errorText: 'no access to analytics' });
    }
    if (analyticsEmpty) {
      return res(200, { data: { rows: [], total: 0 } });
    }
    let body = { data: { rows: [], total: 0 } };
    try {
      const parsed = JSON.parse(init && init.body ? init.body : '{}');
      const offset = Number(parsed.offset) || 0;
      if (offset === 0) body = PAGE1;
      else if (offset === 2) body = PAGE2;
    } catch (e) { /* не тело отчёта — пусто */ }
    return res(200, body);
  }
  if (u.indexOf('/api/v2/list/goods/filter') >= 0) {
    return res(200, { data: { goods: [{ nmID: 101, vendorCode: 'AR-001', price: 1000, discount: 20, subjectName: 'Категория', brand: 'Бренд' }], total: 1 } });
  }
  if (u.indexOf('/api/v1/calendar/promotions') >= 0) return res(200, { data: { promotions: [] } });
  if (u.indexOf('/content/v2/get/cards/list') >= 0) return res(200, { cards: [] });
  if (u.indexOf('/api/v1/supplier/sales') >= 0 || u.indexOf('/api/v1/supplier/orders') >= 0) return res(200, []);
  if (u.indexOf('/api/v3/warehouses') >= 0) {
    return res(200, { data: [{ id: 1, name: 'Коледино', region: 'Москва и МО' }] });
  }
  return res(200, {});
};

const analyticsCalls = () => calls.filter((c) => c.url.indexOf('/stocks-report/wb-warehouses') >= 0);

// ───────────────────────── прогон ─────────────────────────

async function run() {
  const dir = path.join(__dirname, '..', '..', '.data-test-stocks');
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(dir);

  // чистая проверка агрегации — без сети, на нормализованных строках
  const agg = WBClient.aggregateStocks([
    { nmID: 101, stock: 10, warehouseName: 'Коледино', region: 'Москва и МО' },
    { nmID: 102, stock: 5, warehouseName: 'Коледино', region: 'Москва и МО' },
    { nmID: 101, stock: 20, warehouseName: 'Электросталь', region: 'Московская область' }
  ]);
  check('Агрегация по nmID: сумма по складам', agg[101] && agg[101].total === 30 && agg[102] && agg[102].total === 5,
    '101: ' + (agg[101] && agg[101].total) + ', 102: ' + (agg[102] && agg[102].total));
  check('Разбивка по складам', agg[101] && agg[101].byWarehouse['Коледино'] === 10 && agg[101].byWarehouse['Электросталь'] === 20);
  check('Разбивка по регионам', agg[101] && agg[101].byRegion['Москва и МО'] === 10 && agg[101].byRegion['Московская область'] === 20);
  check('Товар без остатка не попадает в агрегацию', WBClient.aggregateStocks([{ nmID: 200, stock: 0 }])[200] === undefined);

  check('stocksLowDays по умолчанию 14', store.loadSettings().stocksLowDays === 14);

  // «боевой» ключ и демо выключен — чтобы шли реальные запросы через заглушку
  store.saveSecrets({ single: 'test-key-0123456789abcdef0123456789' });
  store.saveSettings({ demoMode: false });
  const svc = createService(store, () => {});

  // 1. загрузка остатков: пагинация, агрегация, сохранение
  const r = await svc.handlers['stocks:load']({ force: true, maxWaitMs: 10000, pageWaitMs: 10000 });
  check('stocks:load: собирает все страницы', r.ok && r.items === 2 && r.meta && r.meta.pages === 3,
    'товаров ' + r.items + ', страниц ' + (r.meta && r.meta.pages));
  const saved = store.loadStocks();
  check('Агрегация сохранена в stocks.json', saved.items['101'] && saved.items['101'].total === 30 && saved.items['102'].total === 5);
  check('stocks:state отдаёт состояние', (await svc.handlers['stocks:state']()).items === 2);

  // 2. лимит 1 запрос/20 с — по журналу запросов и времени
  const times = analyticsCalls().map((c) => c.time);
  check('Лимит 1 запрос/20 с соблюдён (масштаб 0.05 → 1 с)',
    times.length === 3 && times[1] - times[0] >= 1000 && times[2] - times[1] >= 1000,
    'интервалы: ' + (times[1] - times[0]) + ' / ' + (times[2] - times[1]) + ' мс');

  // 3. отключённый метод не вызывается
  check('supplier/stocks не вызывается ни разу', !calls.some((c) => c.url.indexOf('/api/v1/supplier/stocks') >= 0));

  // 4. 429 — раздел уходит в фон, данные не теряются
  analyticsStatus = 429;
  const r429 = await svc.handlers['stocks:load']({ force: true, maxWaitMs: 10000 }).catch((e) => e);
  check('429: stocks:load бросает RATE_LIMIT', r429 && r429.code === 'RATE_LIMIT', r429 && r429.message);
  const refresh = await svc.handlers['data:refresh-all']({ facts: false }).catch((e) => e);
  check('429: раздел «Остатки» уходит в фон (deferred)',
    refresh && refresh.ok && (refresh.deferred || []).some((d) => d.name === 'stocks'),
    JSON.stringify((refresh && refresh.deferred || []).map((d) => d.name)));
  const secStocks = (refresh && refresh.sections || []).find((s) => s.name === 'stocks');
  check('429: в отчёте обновления значок deferred, а не ошибка', !!secStocks && secStocks.deferred === true);
  const st429 = await svc.handlers['stocks:state']();
  check('429: загруженные остатки не теряются', st429.items === 2 && st429.meta && st429.meta.empty === false);
  analyticsStatus = 200;

  // 5. пустой ответ не затирает прежние остатки
  analyticsEmpty = true;
  const rEmpty = await svc.handlers['stocks:load']({ force: true, maxWaitMs: 10000 });
  analyticsEmpty = false;
  check('Пустой ответ: данные остаются, ставится empty', rEmpty.ok && rEmpty.items === 2 && rEmpty.meta && rEmpty.meta.empty === true,
    'items ' + rEmpty.items + ', empty ' + (rEmpty.meta && rEmpty.meta.empty));
  check('Пустой ответ: файл с остатками не очищен', store.loadStocks().items['101'].total === 30);

  // 6. бейдж «заканчивается» — чистая функция из renderer/util.js
  global.window = {};
  require('../../src/renderer/js/util.js');
  const U = global.window.U;
  check('Бейдж «заканчивается» при запасе меньше порога', U.stockWarn(30, 5, 14) === true);
  check('Бейджа нет при запасе выше порога', U.stockWarn(300, 30, 14) === false);
  check('Бейджа нет при нулевом остатке', U.stockWarn(0, 5, 14) === false);
  check('Бейджа нет без данных о продажах', U.stockWarn(30, 999, 14) === false);
  check('Бейджа нет при отсутствии порога', U.stockWarn(30, 5, 0) === false);

  // 7. контекст репрайсера берёт остаток из WB
  const calc = await svc.handlers['repricer:calc']({});
  const row = (calc.results || []).find((x) => Number(x.nmID) === 101);
  check('Репрайсер берёт stock из WB, когда остатки загружены', !!row && Number(row.context.stock) === 30,
    'stock ' + (row && row.context.stock));

  // 8. keys:check честно сообщает об отсутствующей категории «Аналитика»
  store.saveSecrets({ single: 'another-key-abcdef0123456789abcdef0123456' });
  analyticsStatus = 403;
  const kc = await svc.handlers['keys:check']();
  const an = (kc.results || []).find((x) => x.category === 'analytics');
  check('keys:check: категория «Аналитика» честно обозначена как нет доступа',
    !!an && an.ok === false && /Аналитика/.test(an.hint || an.error || ''),
    an ? (an.hint || an.error) : 'результата нет');
  const others = (kc.results || []).filter((x) => x.category !== 'analytics');
  check('keys:check: остальные разделы проверены и работают', others.length > 0 && others.every((x) => x.ok === true));
  analyticsStatus = 200;

  fs.rmSync(dir, { recursive: true, force: true });
}

run().catch((e) => {
  fail++;
  console.error('FAIL непредвиденное исключение:', e.stack);
}).finally(() => {
  console.log('\nВсего проверок: ' + (pass + fail) + ', успешно: ' + pass + ', ошибок: ' + fail);
  if (failures.length) {
    console.log('Ошибки:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('ИТОГ: ' + (fail ? 'ОШИБКА' : 'УСПЕХ'));
  process.exit(fail ? 1 : 0);
});
