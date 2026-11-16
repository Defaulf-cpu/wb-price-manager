'use strict';

/**
 * Прогон БОЕВОГО поведения приложения при ограничениях WB API.
 *
 * Зачем отдельный прогон: демо-режим не ходит в сеть, поэтому лимиты WB в нём
 * не воспроизвести. Здесь глобальный fetch подменён заглушкой, которая отвечает
 * ровно так, как отвечает WB:
 *   - «Статистика» и «Финансы» — HTTP 429 с заголовком X-Ratelimit-Retry;
 *   - /api/v1/supplier/sales — страницы с курсором lastChangeDate (flag=0);
 *   - /api/finance/v1/sales-reports/detailed — 204 без строк, если отчёта за период нет.
 *
 * Проверяется то, что сломалось у пользователя:
 *   1. «Статистика продаж: HTTP 429» — раздел не должен падать в ошибку и не должен
 *      слать в WB шквал повторов; он откладывается и догружается в фоне сам.
 *   2. Уже загруженная статистика не стирается, когда WB ответил 429.
 *   3. «Фактические расходы: 0 товаров, 0 строк» — приложение обязано объяснить,
 *      что отчёта за период ещё нет, и найти последний доступный, а не показать «✓ 0».
 *   4. «Проверить доступ» при занятом лимите не врёт про «нет доступа».
 *
 * Лимиты WB уменьшены переменную окружения (60 с → 1,2 с), иначе прогон шёл бы минуты.
 * На боевое поведение это не влияет: без переменной масштаб равен 1.
 *
 * Запуск: node tools/checks/rate-limit-flow.js
 */

process.env.WB_RATE_LIMIT_SCALE = process.env.WB_RATE_LIMIT_SCALE || '0.02';

const fs = require('fs');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { WBClient } = require('../../electron/wb-client');
const { RATE_LIMITS, RATE_SCALE } = require('../../electron/config');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── заглушка сети ─────────────────────────

const calls = [];
let routes = {};

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

global.fetch = async (url, init) => {
  const u = String(url);
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = String(init && init.body); }
  calls.push({ url: u, method: (init && init.method) || 'GET', body, at: Date.now() });
  // сначала самые длинные (специфичные) маршруты: /promotions/nomenclatures прежде /promotions
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (u.includes(key)) return routes[key](u, init, calls.length - 1);
  }
  throw new Error('Нет заглушки для запроса: ' + u);
};

const callsTo = (substr) => calls.filter((c) => c.url.includes(substr));
const queryOf = (call) => {
  const i = call.url.indexOf('?');
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(call.url.slice(i + 1)));
};

// ───────────────────────── данные-заглушки ─────────────────────────

const NM = [1111111, 2222222];

function goodsBody() {
  return {
    data: {
      total: NM.length,
      goods: NM.map((nmID, i) => ({
        nmID,
        vendorCode: 'ART-' + (i + 1),
        brand: 'Тест',
        subjectName: 'Товары для дома',
        price: 1000 + i * 500,
        discount: 10 + i * 5,
        sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 1000 + i * 500, discount: 10 + i * 5, skus: ['bar' + nmID] }]
      }))
    }
  };
}

function salesRows(n) {
  const out = [];
  const count = n || 4;
  for (let i = 0; i < count; i++) {
    out.push({
      nmId: NM[i % NM.length],
      date: new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 19),
      lastChangeDate: '2026-11-10T0' + i + ':00:00Z',
      price: 900 + i * 10,
      ppvz_for_pay: String(700 + i * 10),
      spp: 15,
      isReturn: i === count - 1,
      warehouseName: 'Коледино',
      srid: 'srid-' + i
    });
  }
  return out;
}

function orderRows(n) {
  const out = [];
  const count = n === undefined ? 3 : n;
  for (let i = 0; i < count; i++) {
    out.push({
      nmId: NM[i % NM.length],
      date: new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 19),
      lastChangeDate: '2026-11-11T0' + i + ':00:00Z',
      price: 950 + i * 10,
      srid: 'osrid-' + i
    });
  }
  return out;
}

function reportRows(from) {
  const day = (from || new Date(Date.now() - 3 * 86400000).toISOString()).slice(0, 10);
  const rows = [];
  let rrdId = 5000;
  for (let i = 0; i < 6; i++) {
    const nm = NM[i % NM.length];
    rows.push({
      rrdId: rrdId++,
      reportId: 900001,
      nmId: nm,
      vendorCode: 'ART-' + ((i % NM.length) + 1),
      title: 'Тестовый товар',
      officeName: 'Коледино',
      docTypeName: i === 5 ? 'Возврат' : 'Продажа',
      quantity: 1,
      rrDate: day,
      retailPrice: '1000',
      retailPriceWithDisc: '900',
      retailAmount: '900',
      commissionPercent: 20,
      commission: '180',
      ppvzSalesCommission: '180',
      ppvzForPay: '711',
      deliveryService: '60',
      storageFee: '5',
      paidAcceptance: '0',
      acquiringFee: '9',
      deduction: '0',
      penalty: '0',
      spp: 15
    });
  }
  return rows;
}

/** Маршруты, при которых все разделы, кроме статистики и финансов, отвечают нормально. */
function baseRoutes() {
  return {
    '/api/v2/list/goods/filter': () => res(200, goodsBody()),
    '/api/v1/calendar/promotions/nomenclatures': () => res(200, { data: { nomenclatures: [] } }),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } }),
    // остатки по складам: пустой отчёт — раздел не считает это ошибкой
    '/api/analytics/v1/stocks-report/wb-warehouses': () => res(200, { data: { rows: [], total: 0 } })
  };
}

// ───────────────────────── стенд ─────────────────────────

const ROOT = path.join(__dirname, '..', '..');
let standSeq = 0;

function makeStand() {
  standSeq++;
  const dir = path.join(ROOT, '.data-test-rate', 'stand' + standSeq);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(dir, null);
  store.saveSecrets({ single: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.fake-test-key' });
  store.saveSettings({ demoMode: false, statsLoadOrders: true, factWindowDays: 7, factCostsPeriod: 'daily' });
  const events = [];
  const service = createService(store, (channel, payload) => events.push({ channel, payload }));
  return { store, service, events, dir };
}

/** Сбросить ожидание лимита, чтобы не спать минуту в тесте. */
function freeLimiter(service, category) {
  const l = service.getClient().limiters[category];
  if (!l) return;
  l.cooldownUntil = 0;
  l.last = 0;
  l.stamps = [];
}

// ───────────────────────── проверки ─────────────────────────

/** 1. HTTP 429 на статистике: один запрос, раздел отложен, обновление не «с ошибкой». */
async function t429IsDeferred() {
  calls.length = 0;
  const st = makeStand();
  routes = Object.assign(baseRoutes(), {
    '/api/v1/supplier/sales': () => res(429, null, { 'x-ratelimit-retry': '62' }),
    '/api/v1/supplier/orders': () => res(429, null, { 'x-ratelimit-retry': '62' })
  });

  const out = await st.service.handlers['data:refresh-all']({ facts: false });
  const sec = (out.sections || []).find((x) => x.name === 'stats');

  check('429: раздел «Статистика продаж» помечен отложенным, а не упавшим', !!sec && sec.deferred === true, sec ? JSON.stringify({ ok: sec.ok, deferred: sec.deferred }) : 'раздел не найден');
  check('429: обновление не считается выполненным с ошибкой', (out.errors || []).length === 0, JSON.stringify(out.errors));
  check('429: в итоге сказано про фоновую догрузку', out.pending === 1, 'pending=' + out.pending);
  check('429: к WB ушёл ровно ОДИН запрос продаж — шквала повторов нет', callsTo('/supplier/sales').length === 1, 'запросов: ' + callsTo('/supplier/sales').length);
  check('429: заказы при занятом лимите вообще не запрашивались', callsTo('/supplier/orders').length === 0, 'запросов: ' + callsTo('/supplier/orders').length);
  check('429: приложение знает, когда повторить', !!sec && !!sec.retryAt && new Date(sec.retryAt).getTime() > Date.now(), sec && sec.retryAt);
  check('429: текст объясняет лимит и срок', !!sec && /429/.test(sec.error || '') && /через \d+ с/.test(sec.error || ''), sec && sec.error);

  const d = await st.service.handlers['data:deferred']({});
  const rec = (d.items || []).find((x) => x.name === 'stats');
  check('429: создана задача фоновой догрузки', !!rec && rec.state === 'scheduled', rec ? rec.state : 'нет задачи');
  const okSections = (out.sections || []).filter((x) => x.ok).map((x) => x.name);
  check('429: остальные разделы загрузились', okSections.length === (out.sections || []).length - 1 && okSections.includes('goods') && okSections.includes('cards'), JSON.stringify(okSections));
}

/** 2. Фоновая догрузка действительно доходит до WB и возвращает данные в интерфейс. */
async function tBackgroundRetryWorks() {
  calls.length = 0;
  const st = makeStand();
  let salesCalls = 0;
  routes = Object.assign(baseRoutes(), {
    '/api/v1/supplier/sales': () => {
      salesCalls++;
      // первый ответ — 429 с коротким сроком: так WB отвечает, когда лимит вот-вот сбросится
      return salesCalls === 1 ? res(429, null, { 'x-ratelimit-retry': '1' }) : res(200, salesRows(4));
    },
    '/api/v1/supplier/orders': () => res(200, orderRows(3))
  });

  const out = await st.service.handlers['data:refresh-all']({ facts: false });
  check('фон: раздел отложен после 429', out.pending === 1, 'pending=' + out.pending);

  await sleep(6000);   // масштаб лимитов 0.02: минута WB проходит за ~1,2 с

  const d = await st.service.handlers['data:deferred']({});
  const rec = (d.items || []).find((x) => x.name === 'stats');
  check('фон: статистика догрузилась сама, без повторного нажатия', !!rec && rec.state === 'done', rec ? rec.state + ' ' + (rec.error || '') + ' ' + (rec.detail || '') : 'нет задачи');

  const s = await st.service.handlers['stats:state']({});
  check('фон: строки статистики появились', s.count > 0, 'count=' + s.count);
  check('фон: продажи запрошены с flag=0 (диапазон, а не один день)', callsTo('/supplier/sales').every((c) => queryOf(c).flag === '0'), JSON.stringify(callsTo('/supplier/sales').map((c) => queryOf(c).flag)));
  check('фон: заказы догружены отдельным запросом', callsTo('/supplier/orders').length >= 1 && s.meta && s.meta.withOrders === true, JSON.stringify(s.meta));
  check('фон: интерфейс получил событие о догрузке', st.events.some((e) => e.channel === 'deferred' && e.payload && e.payload.type === 'done' && e.payload.name === 'stats'));
  check('фон: в товарах видна загруженная статистика', (await st.service.handlers['wb:goods']({})).stats.length > 0);
}

/** 3. Статистика грузится постранично по lastChangeDate, а не одним днём. */
async function tStatisticsPagination() {
  calls.length = 0;
  const client = new WBClient({ keys: { single: 'test-key' } });

  // шесть продаж по шести разным дням — как в настоящем ответе WB
  const all = [];
  for (let i = 0; i < 6; i++) {
    all.push({
      nmId: NM[i % NM.length],
      date: '2026-11-0' + (i + 1) + 'T10:00:00',
      lastChangeDate: '2026-11-0' + (i + 1) + 'T10:00:00Z',
      price: 100 * (i + 1),
      ppvz_for_pay: String(80 * (i + 1)),
      isReturn: false,
      warehouseName: 'Коледино'
    });
  }
  let page = 0;
  routes = {
    '/api/v1/supplier/sales': (u) => {
      const q = queryOf({ url: u });
      // flag=1 — WB отдаёт строки ТОЛЬКО за дату, равную dateFrom (именно так
      // приложение раньше теряло месяц статистики, запрашивая «30 дней назад»)
      if (q.flag === '1') return res(200, all.filter((r) => String(r.date).slice(0, 10) === String(q.dateFrom).slice(0, 10)));
      page++;
      if (page === 1) return res(200, all.slice(0, 3));
      if (page === 2) return res(200, all.slice(3));
      return res(200, []);
    }
  };

  const r = await client.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', { rowCap: 3, maxPages: 4 });
  const froms = callsTo('/supplier/sales').map((c) => queryOf(c).dateFrom);

  check('пагинация: строки собраны со всех страниц', r.rows.length === 6, 'строк: ' + r.rows.length);
  check('пагинация: курсор движется по lastChangeDate', froms[1] === '2026-11-03T10:00:00Z' && froms[2] === '2026-11-06T10:00:00Z', JSON.stringify(froms));
  check('пагинация: пустой ответ останавливает загрузку', r.pages === 3, 'страниц: ' + r.pages);
  check('пагинация: флаг 0 — WB отдаёт период, а не один день', callsTo('/supplier/sales').every((c) => queryOf(c).flag === '0'));

  const oneDay = await client.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', { flag: 1, maxPages: 2, maxWaitMs: 20000 });
  check('flag=1: WB отдаёт только одну дату — поэтому в бою нужен flag=0', oneDay.rows.length === 1, 'строк с flag=1: ' + oneDay.rows.length + ', с flag=0: ' + r.rows.length);

  // загрузка не должна терять уже полученные строки, если оборвалась на второй странице
  calls.length = 0;
  page = 0;
  const client2 = new WBClient({ keys: { single: 'test-key' } });
  routes = {
    '/api/v1/supplier/sales': () => {
      page++;
      if (page === 1) return res(200, all.slice(0, 3));
      return res(429, null, { 'x-ratelimit-retry': '62' });
    }
  };
  const partial = await client2.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', { rowCap: 3, maxPages: 4, pageWaitMs: 200000 });
  check('обрыв страницы: полученные строки сохранены', partial.rows.length === 3, 'строк: ' + partial.rows.length);
  check('обрыв страницы: помечено, что данные неполные', partial.truncated === true && !!partial.error, partial.error && partial.error.code);
}

/** 4. Второй запрос подряд не уходит в сеть: честная отсрочка вместо 429. */
async function tNoRequestWhenLimited() {
  calls.length = 0;
  const client = new WBClient({ keys: { single: 'test-key' } });
  routes = { '/api/v1/supplier/sales': () => res(200, salesRows(2)) };

  await client.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {});
  const before = callsTo('/supplier/sales').length;
  let err = null;
  try {
    await client.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {});
  } catch (e) { err = e; }

  check('лимит: повторный запрос не отправлен в WB', callsTo('/supplier/sales').length === before, 'было ' + before + ', стало ' + callsTo('/supplier/sales').length);
  check('лимит: вместо запроса — отсрочка с понятным сроком', !!err && err.code === 'RATE_WAIT' && Number(err.retryAt) > Date.now(), err ? err.code + ': ' + err.message : 'ошибки нет');
  check('лимит: состояние категории видно для диагностики', client.rateState().statistics.waitMs > 0, JSON.stringify(client.rateState().statistics.limit));
}

/** 5. 429 не стирает уже загруженную статистику. */
async function tStatsAreNotWiped() {
  calls.length = 0;
  const st = makeStand();
  routes = Object.assign(baseRoutes(), {
    '/api/v1/supplier/sales': () => res(200, salesRows(4)),
    '/api/v1/supplier/orders': () => res(200, orderRows(2))
  });

  await st.service.handlers['data:refresh-all']({ facts: false });
  const first = await st.service.handlers['stats:state']({});
  check('кэш: статистика загружена', first.count > 0, 'count=' + first.count);

  // WB начинает отвечать 429 на всё
  routes['/api/v1/supplier/sales'] = () => res(429, null, { 'x-ratelimit-retry': '62' });
  routes['/api/v1/supplier/orders'] = () => res(429, null, { 'x-ratelimit-retry': '62' });
  freeLimiter(st.service, 'statistics');

  const rows = await st.service.handlers['wb:stats']({ days: 30, force: true });
  check('кэш: после 429 статистика НЕ обнулилась', Array.isArray(rows) && rows.length === first.count, 'было ' + first.count + ', стало ' + (rows || []).length);

  freeLimiter(st.service, 'statistics');
  const out2 = await st.service.handlers['data:refresh-all']({ facts: false });
  const sec = (out2.sections || []).find((x) => x.name === 'stats');
  check('кэш: повторное обновление при 429 оставляет раздел отложенным', !!sec && sec.deferred === true, sec && sec.error);
  check('кэш: в сообщении видно, что старые данные остались', !!sec && /остались на месте/.test(sec.error || ''), sec && sec.error);
  const g = await st.service.handlers['wb:goods']({});
  check('кэш: товары по-прежнему отдаются со статистикой', (g.stats || []).length === first.count, 'stats=' + (g.stats || []).length);
}

/** 6. Пустой финансовый отчёт: объяснение, поиск последнего отчёта, старые данные целы. */
async function tFactsEmptyWindow() {
  calls.length = 0;
  const st = makeStand();
  const oldFrom = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const oldTo = new Date(Date.now() - 34 * 86400000).toISOString().slice(0, 10);

  // сначала отчёт за свежий период есть
  routes = Object.assign(baseRoutes(), {
    '/api/v1/supplier/sales': () => res(200, salesRows(2)),
    '/api/v1/supplier/orders': () => res(200, []),
    '/api/finance/v1/sales-reports/detailed': (u, init) => res(200, reportRows()),
    '/api/finance/v1/sales-reports/list': () => res(200, { reports: [] })
  });
  await st.service.handlers['facts:load']({ days: 7 });
  const ok1 = await st.service.handlers['facts:get']({});
  check('факт: отчёт загружен', Object.keys(ok1.items || {}).length > 0, 'товаров: ' + Object.keys(ok1.items || {}).length);

  // теперь за выбранные 7 дней WB не отдаёт ни строки (отчёт ещё не сформирован)
  routes['/api/finance/v1/sales-reports/detailed'] = (u, init) => {
    const body = (init && init.body) ? JSON.parse(init.body) : {};
    if (String(body.dateFrom) === oldFrom) return res(200, reportRows(oldFrom));
    return res(204, null);
  };
  routes['/api/finance/v1/sales-reports/list'] = () => res(200, {
    reports: [{ reportId: 900001, dateFrom: oldFrom, dateTo: oldTo, period: 'weekly', createDate: oldTo }]
  });
  freeLimiter(st.service, 'finance');

  const out = await st.service.handlers['data:refresh-all']({ facts: true });
  const sec = (out.sections || []).find((x) => x.name === 'facts');
  check('факт: пустой период не показан как «✓ 0 строк»', !!sec && sec.deferred === true, sec ? JSON.stringify({ ok: sec.ok, deferred: sec.deferred, detail: sec.detail }) : 'раздел не найден');
  check('факт: сообщение объясняет, что отчёты формируются с задержкой', !!sec && /ни одной строки/.test(sec.error || '') && /с задержкой/.test(sec.error || ''), sec && sec.error);
  check('факт: обновление не помечено ошибкой пользователя', (out.errors || []).length === 0, JSON.stringify(out.errors));

  const kept = await st.service.handlers['facts:get']({});
  check('факт: сохранённые ранее расходы не стёрты', Object.keys(kept.items || {}).length > 0, 'товаров: ' + Object.keys(kept.items || {}).length);

  await sleep(7000);   // фоновый поиск: список отчётов + детализация (по минуте WB каждая)

  const rec = ((await st.service.handlers['data:deferred']({})).items || []).find((x) => x.name === 'facts');
  check('факт: фон нашёл и загрузил последний доступный отчёт', !!rec && rec.state === 'done', rec ? rec.state + ' ' + (rec.error || rec.detail || '') : 'нет задачи');

  const got = await st.service.handlers['facts:get']({});
  const meta = got.meta || {};
  check('факт: видно, что взят отчёт за другой период', meta.widened === true && meta.dateFrom === oldFrom, JSON.stringify({ widened: meta.widened, dateFrom: meta.dateFrom, requestedFrom: meta.requestedFrom }));
  check('факт: использованные отчёты перечислены', Array.isArray(meta.reportsUsed) && meta.reportsUsed.length === 1 && meta.reportsUsed[0].reportId === 900001, JSON.stringify(meta.reportsUsed));
  check('факт: строки загружены', (meta.rowsProcessed || 0) > 0, 'строк: ' + meta.rowsProcessed);
  check('факт: интерфейс получил событие о догрузке', st.events.some((e) => e.channel === 'deferred' && e.payload && e.payload.type === 'done' && e.payload.name === 'facts'));
}

/** 7. Проверка доступа при занятом лимите — честная, без «нет доступа». */
async function tAccessCheckIsHonest() {
  calls.length = 0;
  const st = makeStand();
  routes = Object.assign(baseRoutes(), {
    '/api/v1/supplier/sales': () => res(200, salesRows(2)),
    '/api/v1/supplier/orders': () => res(200, orderRows(1)),
    '/api/finance/v1/sales-reports/list': () => res(200, { reports: [] })
  });

  // занимаем минутный лимит «Статистики» обычным запросом
  await st.service.getClient().getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {});

  const acc = await st.service.handlers['keys:check']({});
  const stat = (acc.results || []).find((x) => x.category === 'statistics');
  check('доступ: раздел не проверен — а не «нет доступа»', !!stat && stat.ok === null && stat.checked === false, stat ? JSON.stringify({ ok: stat.ok, checked: stat.checked, code: stat.code }) : 'нет результата');
  check('доступ: подсказка объясняет лимит WB и когда повторить', !!stat && /минут/i.test(stat.hint || '') && /Повторите/.test(stat.hint || ''), stat && stat.hint);
  check('доступ: сообщение не утверждает, что всё проверено', !/по всем разделам/.test(acc.message || ''), acc.message);
  const prices = (acc.results || []).find((x) => x.category === 'prices');
  check('доступ: остальные категории проверены как обычно', !!prices && prices.ok === true, prices && prices.detail);
}

/** 8. Настройки лимитов соответствуют документации WB. */
function tLimitsMatchDocs() {
  check('лимиты: «Статистика» — 1 запрос в минуту (как в документации WB)', RATE_LIMITS.statistics.perWindow === 1 && RATE_LIMITS.statistics.windowMs === Math.round(60000 * RATE_SCALE), JSON.stringify(RATE_LIMITS.statistics));
  check('лимиты: «Финансы» — 1 запрос в минуту', RATE_LIMITS.finance.perWindow === 1 && RATE_LIMITS.finance.windowMs === Math.round(60000 * RATE_SCALE), JSON.stringify(RATE_LIMITS.finance));
  check('лимиты: «Цены и скидки» — 10 запросов за 6 секунд', RATE_LIMITS.prices.perWindow === 10 && RATE_LIMITS.prices.windowMs === Math.round(6000 * RATE_SCALE));
  check('лимиты: ожидание в интерфейсе ограничено — раздел уходит в фон, а не висит', RATE_LIMITS.statistics.maxWaitMs < RATE_LIMITS.statistics.windowMs);
}

(async function main() {
  console.log('Прогон лимитов WB API (масштаб лимитов ' + RATE_SCALE + ': минута WB = ' + Math.round(60000 * RATE_SCALE) + ' мс)\n');
  try {
    tLimitsMatchDocs();
    await t429IsDeferred();
    await tStatisticsPagination();
    await tNoRequestWhenLimited();
    await tStatsAreNotWiped();
    await tAccessCheckIsHonest();
    await tBackgroundRetryWorks();
    await tFactsEmptyWindow();
  } catch (e) {
    fail++;
    failures.push('ПРОГОН УПАЛ: ' + (e && e.stack || e));
    console.log('FAIL прогон упал: ' + (e && e.stack || e));
  }

  console.log('\nВсего проверок: ' + (pass + fail) + ', пройдено: ' + pass + ', провалено: ' + fail);
  if (fail) {
    console.log('\nПровалы:');
    failures.forEach((f) => console.log('  · ' + f));
    console.log('\nИТОГ: ЕСТЬ ПРОВАЛЫ');
  } else {
    console.log('\nИТОГ: ВСЁ ЗЕЛЁНОЕ');
  }

  try { fs.rmSync(path.join(ROOT, '.data-test-rate'), { recursive: true, force: true }); } catch (e) { /* не критично */ }
  process.exit(fail ? 1 : 0);
})();
