'use strict';

/**
 * Прогон новой логики цен и репрайсера.
 *
 * Что проверяем (это то, что просил пользователь):
 *  1. «Цены и скидки» сохраняют введённые цифры БЕЗ отправки в WB и не сбрасывают их
 *     ни при обновлении данных, ни после перезапуска приложения.
 *  2. Автопересчёт работает в две фазы: сначала репрайсер ПОКАЗЫВАЕТ, какие цены хочет
 *     поставить (фактические цены не меняются), и только потом отправляет их в WB.
 *  3. Отправка не затирает чужие правки: если цена в кабинете изменилась с момента
 *     расчёта, предложение помечается устаревшим и в WB не уходит.
 *  4. По каждому артикулу видна история: что предложил репрайсер и что реально отправлено.
 *  5. Карточка товара одним запросом отдаёт экономику, конкурентов, комиссии, акции и историю.
 *  6. Акции: WB отвечает HTTP 422 на состав автоакций — приложение не долбит WB такими
 *     запросами и не сыпет одинаковыми ошибками, а объясняет, что состав берётся файлом.
 *
 * Запуск: node tools/checks/repricer-flow.js
 */

const fs = require('fs');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');

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

// ───────────────────────── заглушка сети (для стенда с «боевым» ключом) ─────────────────────────

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
  calls.push({ url: u, method: (init && init.method) || 'GET', at: Date.now() });
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  for (const key of keys) if (u.includes(key)) return routes[key](u, init);
  throw new Error('Нет заглушки для запроса: ' + u);
};

const callsTo = (substr) => calls.filter((c) => c.url.includes(substr));

// ───────────────────────── стенды ─────────────────────────

const ROOT = path.join(__dirname, '..', '..');
let standSeq = 0;

function makeStand(opts) {
  standSeq++;
  const o = opts || {};
  const dir = path.join(ROOT, '.data-test-repricer', 'stand' + standSeq);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createStore(dir, null);
  if (o.live) {
    store.saveSecrets({ single: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.fake-test-key' });
    store.saveSettings({ demoMode: false });
  } else {
    store.saveSettings({ demoMode: true, firstRun: false });
  }
  const events = [];
  const service = createService(store, (channel, payload) => events.push({ channel, payload }));
  return { store, service, events, dir };
}

// ───────────────────────── 1. Черновик цен ─────────────────────────

async function tDrafts() {
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });
  const goods = await st.service.handlers['wb:goods']({});
  const first = (goods.items || [])[0];
  const second = (goods.items || [])[1];
  check('черновик: товары загружены', !!first && !!second);

  const draft = {};
  draft[String(first.nmID)] = { basePrice: 1234, discount: 17, note: 'моя цена' };
  draft[String(second.nmID)] = { basePrice: 999, discount: 5 };
  const saved = await st.service.handlers['prices:draft-save']({ items: draft });
  check('черновик: сохранён без отправки в WB', saved.ok === true && saved.count === 2, 'count=' + saved.count);

  const loaded = await st.service.handlers['prices:draft-load']();
  const d1 = loaded.items[String(first.nmID)];
  check('черновик: значения читаются обратно', !!d1 && d1.basePrice === 1234 && d1.discount === 17, JSON.stringify(d1));
  check('черновик: посчитана цена со скидкой', !!d1 && Math.abs(d1.sellerPrice - 1024.22) < 0.01, d1 && String(d1.sellerPrice));

  // обновление данных из кабинета не должно стирать введённые вручную цифры
  await st.service.handlers['data:refresh-all']({ facts: false });
  const after = await st.service.handlers['prices:draft-load']();
  check('черновик: пережил «Обновить данные из WB»',
    !!after.items[String(first.nmID)] && after.items[String(first.nmID)].basePrice === 1234);

  // «перезапуск приложения»: новый сервис на том же каталоге данных
  const store2 = createStore(st.dir, null);
  const service2 = createService(store2, () => {});
  const afterRestart = await service2.handlers['prices:draft-load']();
  check('черновик: пережил перезапуск приложения',
    !!afterRestart.items[String(first.nmID)] && afterRestart.items[String(first.nmID)].discount === 17);

  const cleared = await service2.handlers['prices:draft-clear']({});
  check('черновик: очищается по кнопке', cleared.ok === true && cleared.count === 0);

  // черновик не уходит в WB сам по себе
  check('черновик: в WB ничего не отправлено', (await service2.handlers['tasks:history']()).length === 0 ||
    !JSON.stringify(await service2.handlers['tasks:history']()).includes('1234'));
}

// ───────────────────────── 2. Двухфазный автопересчёт ─────────────────────────

async function tTwoPhase() {
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });

  const before = await st.service.handlers['wb:goods']({});
  const pricesBefore = (before.items || []).slice(0, 5).map((x) => Number(x.price)).join(',');

  // фаза 1: пересчёт
  const cfg = await st.service.handlers['repricer:state']();
  check('двухфазный цикл: по умолчанию включён', cfg.config.schedule.twoPhase === true);
  check('двухфазный цикл: интервал пересчёта 40 минут', Number(cfg.config.schedule.intervalMinutes) === 40,
    String(cfg.config.schedule.intervalMinutes));
  check('двухфазный цикл: отправка отложена на 40 минут', Number(cfg.config.schedule.sendDelayMinutes) === 40,
    String(cfg.config.schedule.sendDelayMinutes));

  const calc = await st.service.handlers['repricer:calc']({ full: true });
  check('фаза 1: пересчёт выполнен', !!(calc && calc.results && calc.results.length), 'товаров ' + (calc.results || []).length);

  const prop = await st.service.handlers['repricer:proposal']();
  check('фаза 1: предложение сохранено', prop.phase === 'proposed' || prop.phase === 'empty', 'phase=' + prop.phase);
  check('фаза 1: в предложении есть цены, которые хочет поставить РП',
    Array.isArray(prop.items) && (!prop.items.length || (prop.items[0].sellerPrice > 0 && prop.items[0].currentSellerPrice > 0)),
    prop.items && prop.items.length ? JSON.stringify({ now: prop.items[0].currentSellerPrice, want: prop.items[0].sellerPrice }) : 'пусто');
  check('фаза 1: указано время отправки', !!prop.sendAt && new Date(prop.sendAt).getTime() > Date.now(), String(prop.sendAt));
  check('фаза 1: отправка не раньше чем через 30 минут',
    !!prop.sendAt && (new Date(prop.sendAt).getTime() - new Date(prop.at).getTime()) >= 30 * 60000,
    prop.sendAt && prop.at ? String(Math.round((new Date(prop.sendAt) - new Date(prop.at)) / 60000)) + ' мин' : '');

  // главное: фактические цены НЕ изменились
  const afterCalc = await st.service.handlers['wb:goods']({});
  const pricesAfter = (afterCalc.items || []).slice(0, 5).map((x) => Number(x.price)).join(',');
  check('фаза 1: установленные цены не затёрты', pricesBefore === pricesAfter, pricesBefore + ' → ' + pricesAfter);
  check('фаза 1: в WB ничего не отправлено', (await st.service.handlers['tasks:history']()).length === 0,
    'задач: ' + (await st.service.handlers['tasks:history']()).length);

  // история пересчёта по артикулу
  if (prop.items && prop.items.length) {
    const nm = prop.items[0].nmID;
    const card = await st.service.handlers['items:card']({ nmID: nm });
    check('история: по артикулу видно предложение репрайсера',
      (card.recalcHistory || []).some((h) => h.phase === 'propose'), 'записей ' + (card.recalcHistory || []).length);
    check('карточка: предложение по этому товару отдано', !!card.proposal && Number(card.proposal.nmID) === Number(nm));

    // фаза 2: отправка
    const sent = await st.service.handlers['repricer:proposal-send']({});
    check('фаза 2: предложение отправлено', sent && (sent.sent > 0 || sent.ok === true), 'sent=' + (sent && sent.sent));
    const sentProp = await st.service.handlers['repricer:proposal']();
    check('фаза 2: предложение помечено отправленным', sentProp.phase === 'sent', 'phase=' + sentProp.phase);
    const card2 = await st.service.handlers['items:card']({ nmID: nm });
    check('история: по артикулу видно отправку в WB',
      (card2.recalcHistory || []).some((h) => h.phase === 'send' && h.sent === true));
    check('история: видна цена «до» и «после»',
      (card2.recalcHistory || []).some((h) => h.prevSellerPrice > 0 && h.sellerPrice > 0));
  } else {
    check('фаза 2: предложение пустое — отправлять нечего', prop.phase === 'empty', String(prop.note));
  }
}

// ─────── 2b. Товары без себестоимости не попадают в предложение (как в INDEEPA) ───────

/**
 * Проверяем на «боевом» стенде с подменным WB: в демо-режиме себестоимость подставляется
 * автоматически (mergeDemoOverrides), поэтому ветка «данных нет» там недостижима.
 */
async function tBlockedItems() {
  calls.length = 0;
  const st = makeStand({ live: true });
  routes = {
    '/api/v2/list/goods/filter': () => res(200, {
      data: {
        total: 2,
        goods: [
          { nmID: 1111111, vendorCode: 'ART-1', brand: 'Тест', subjectName: 'Товары для дома',
            price: 1000, discount: 10, sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 1000, discount: 10, skus: ['b1'] }] },
          { nmID: 2222222, vendorCode: 'ART-2', brand: 'Тест', subjectName: 'Товары для дома',
            price: 2000, discount: 20, sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 2000, discount: 20, skus: ['b2'] }] }
        ]
      }
    }),
    '/api/v1/calendar/promotions/nomenclatures': () => res(200, { data: { nomenclatures: [] } }),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } })
  };

  // себестоимость задана только одному товару из двух
  await st.service.handlers['costs:save']({ items: { 2222222: { costPriceRub: 400 } } });
  await st.service.handlers['repricer:calc']({ full: true });
  const prop = await st.service.handlers['repricer:proposal']();

  const blockedList = prop.blocked || [];
  const noCogs = blockedList.find((x) => Number(x.nmID) === 1111111);
  check('валидация: товар без себестоимости помечен заблокированным', !!noCogs,
    'в blocked: ' + JSON.stringify(blockedList.map((x) => x.nmID)));
  check('валидация: заблокированный товар не попал в предложение',
    !(prop.items || []).some((x) => Number(x.nmID) === 1111111),
    'в items: ' + JSON.stringify((prop.items || []).map((x) => x.nmID)));
  check('валидация: причина названа по-русски',
    !!noCogs && (noCogs.reasons || []).some((r) => /себестоимость|базовая цена|порог/.test(r)),
    noCogs ? (noCogs.reasons || []).join('; ') : 'записи нет');
  check('валидация: счётчик заблокированных есть в сводке',
    Number((prop.summary || {}).blocked || 0) === Number(prop.blockedTotal || 0) && prop.blockedTotal >= 1,
    'summary.blocked=' + (prop.summary || {}).blocked + ', blockedTotal=' + prop.blockedTotal);
  check('валидация: в подписи предложения сказано про незаполненные данные',
    /не заполнены|Не вошли в предложение/i.test(prop.note || ''), String(prop.note).slice(0, 80));

  // заполнили себестоимость — товар снова можно предлагать
  await st.service.handlers['costs:save']({ items: { 1111111: { costPriceRub: 300 } } });
  await st.service.handlers['repricer:calc']({ full: true });
  const prop2 = await st.service.handlers['repricer:proposal']();
  check('валидация: после заполнения себестоимости блокировка снята',
    !(prop2.blocked || []).some((x) => Number(x.nmID) === 1111111),
    'blocked=' + (prop2.blocked || []).length + ', всего позиций ' + (prop2.items || []).length);
}

// ─────── 2c. Товар с поразмерными ценами: WB не отдаёт price на уровне товара ───────

/**
 * Реальный формат ответа WB для товаров с `editableSizePrice: true` (а также для любого
 * товара с включённой опцией «Разные цены для размеров»): поля `price` на уровне товара
 * НЕТ, цены лежат только в `sizes[]`. Раньше нормализация давала `price: 0`, и репрайсер
 * писал «не задана базовая цена», хотя в кабинете и в «Цены и скидки» цена есть.
 */
async function tSizePricedGoods() {
  calls.length = 0;
  const st = makeStand({ live: true });
  routes = {
    '/api/v2/list/goods/filter': () => res(200, {
      data: {
        total: 3,
        goods: [
          // поразмерные цены: price отсутствует вовсе, часть размеров без цены
          { nmID: 3333333, vendorCode: 'ART-SIZE', brand: 'Тест', subjectName: 'Одежда',
            discount: 20, clubDiscount: 0, editableSizePrice: true, currencyIsoCode4217: 'RUB',
            sizes: [
              { sizeID: 11, techSizeName: '42', price: 900, discountedPrice: 720 },
              { sizeID: 12, techSizeName: '44', price: 800, discountedPrice: 640 },
              { sizeID: 13, techSizeName: '46', price: 0, discountedPrice: 0 }
            ] },
          // цены нет ни на товаре, ни в размерах — здесь блокировка честная
          { nmID: 4444444, vendorCode: 'ART-NOPRICE', brand: 'Тест', subjectName: 'Одежда',
            discount: 0, editableSizePrice: false, sizes: [{ sizeID: 21, techSizeName: 'ONE SIZE', price: 0 }] },
          // обычный товар: price на месте — подстановка из размеров сработать не должна
          { nmID: 5555555, vendorCode: 'ART-NORMAL', brand: 'Тест', subjectName: 'Одежда',
            price: 1200, discount: 10, discountedPrice: 1080, editableSizePrice: false,
            sizes: [{ sizeID: 31, techSizeName: 'ONE SIZE', price: 1200, discountedPrice: 1080 }] }
        ]
      }
    }),
    '/api/v1/calendar/promotions/nomenclatures': () => res(200, { data: { nomenclatures: [] } }),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } })
  };

  const g = await st.service.handlers['wb:goods']({ force: true });
  const byId = {};
  (g.items || []).forEach((it) => { byId[String(it.nmID)] = it; });
  const sized = byId['3333333'] || {};
  const noprice = byId['4444444'] || {};
  const normal = byId['5555555'] || {};

  check('поразмерные цены: базовая цена взята из sizes[] (минимальная из живых)',
    Number(sized.price) === 800, 'price=' + sized.price);
  check('поразмерные цены: признак источника и вилка цен дошли до товара',
    sized.priceFromSizes === true && Number(sized.sizePriceMin) === 800 && Number(sized.sizePriceMax) === 900,
    JSON.stringify({ from: sized.priceFromSizes, min: sized.sizePriceMin, max: sized.sizePriceMax }));
  check('поразмерные цены: цена со скидкой посчитана, а не осталась нулём',
    Number(sized.discountedPrice) === 640, 'discountedPrice=' + sized.discountedPrice);
  check('обычный товар: цена из WB, подстановка из размеров не сработала',
    Number(normal.price) === 1200 && !normal.priceFromSizes, 'price=' + normal.price);
  check('товар без цены вовсе: price остался нулём — ничего не выдумываем',
    Number(noprice.price) === 0 && !noprice.priceFromSizes, 'price=' + noprice.price);

  // себестоимость задаём всем, чтобы в блокировках осталась только тема базовой цены
  await st.service.handlers['costs:save']({ items: {
    3333333: { costPriceRub: 300 }, 4444444: { costPriceRub: 300 }, 5555555: { costPriceRub: 300 }
  } });
  await st.service.handlers['repricer:item-configs:save']({ items: {
    3333333: { minPrice: 500 }, 4444444: { minPrice: 500 }, 5555555: { minPrice: 500 }
  } });
  const calc = await st.service.handlers['repricer:calc']({ full: true });
  const row = {};
  (calc.results || []).forEach((r) => { row[String(r.nmID)] = r; });

  check('репрайсер: у товара с поразмерными ценами базовая цена видна в расчёте',
    Number(((row['3333333'] || {}).current || {}).basePrice) === 800,
    'basePrice=' + ((row['3333333'] || {}).current || {}).basePrice);
  check('репрайсер: в контекст строки попал признак «цена по размерам» с вилкой',
    !!((row['3333333'] || {}).context || {}).priceFromSizes &&
    Number(((row['3333333'] || {}).context || {}).sizePriceMax) === 900,
    JSON.stringify((row['3333333'] || {}).context || {}).slice(0, 140));

  const prop = await st.service.handlers['repricer:proposal']();
  const reasonsOf = (nm, p) => (((p || prop).blocked || []).find((x) => Number(x.nmID) === nm) || {}).reasons || [];
  check('репрайсер: товар с поразмерными ценами больше НЕ блокируется',
    !reasonsOf(3333333).some((t) => /базовая цена/i.test(t)) &&
    (prop.items || []).some((x) => Number(x.nmID) === 3333333),
    'причины: ' + JSON.stringify(reasonsOf(3333333)));
  check('репрайсер: товар без цены заблокирован честной подписью с подсказкой',
    reasonsOf(4444444).some((t) => /базовая цена в WB не задана/.test(t) && /кабинет|свою цену/.test(t)),
    'причины: ' + JSON.stringify(reasonsOf(4444444)));

  // цену сохранили вручную в «Цены и скидки» — значит базовая задана, блокировать не за что
  await st.service.handlers['prices:draft-save']({ items: { 4444444: { basePrice: 1500, discount: 15 } } });
  await st.service.handlers['repricer:calc']({ full: true });
  const prop2 = await st.service.handlers['repricer:proposal']();
  check('репрайсер: сохранённая вручную цена снимает блокировку по базовой цене',
    !reasonsOf(4444444, prop2).some((t) => /базовая цена/i.test(t)),
    'причины: ' + JSON.stringify(reasonsOf(4444444, prop2)));
  check('репрайсер: товар с ручной ценой ушёл в предложение с ценой пользователя',
    (prop2.items || []).some((x) => Number(x.nmID) === 4444444 && Number(x.basePrice) === 1500),
    'в items: ' + JSON.stringify((prop2.items || []).map((x) => [x.nmID, x.basePrice])));
}

// ───────────────────────── Цены по размерам: отправка, режимы, валидация ─────────────────────────

/**
 * Запись цен по размерам: роутинг в upload/task/size, режимы none/sync/manual,
 * предупреждение «разные цены → одинаковые», валидация (чужой размер, карантин) и 429-ретраи.
 */
async function tSizePrices() {
  calls.length = 0;
  const sizePosts = [];
  let sizeAttempt = 0;
  const st = makeStand({ live: true });
  routes = {
    '/api/v2/list/goods/filter': () => res(200, {
      data: {
        total: 2,
        goods: [
          // режим sync: размеры с разными ценами, все получат цену товара (800)
          { nmID: 1001, vendorCode: 'ART-SYNC', brand: 'Тест', subjectName: 'Одежда',
            discount: 0, editableSizePrice: true, currencyIsoCode4217: 'RUB',
            sizes: [
              { sizeID: 11, techSizeName: '42', price: 900, discountedPrice: 900 },
              { sizeID: 12, techSizeName: '44', price: 800, discountedPrice: 800 }
            ] },
          // режим none: разные цены по размерам — предупреждение «станет одинаковой»
          { nmID: 2002, vendorCode: 'ART-NONE', brand: 'Тест', subjectName: 'Одежда',
            discount: 0, editableSizePrice: true, currencyIsoCode4217: 'RUB',
            sizes: [
              { sizeID: 21, techSizeName: '42', price: 1000, discountedPrice: 1000 },
              { sizeID: 22, techSizeName: '44', price: 900, discountedPrice: 900 }
            ] }
        ]
      }
    }),
    '/api/v1/calendar/promotions/nomenclatures': () => res(200, { data: { nomenclatures: [] } }),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } }),
    '/api/v2/upload/task/size': (u, init) => {
      sizeAttempt++;
      sizePosts.push({ body: init && init.body, attempt: sizeAttempt });
      // первый запрос — 429 с быстрым разрешителем, чтобы сработал ретраи-429
      if (sizeAttempt === 1) return res(429, { errorText: 'limit' }, { 'x-ratelimit-retry': '1' });
      return res(200, { data: { taskId: 9001 } });
    },
    '/api/v2/upload/task': () => res(200, { data: { taskId: 9000 } }),
    '/api/v2/history/goods/task': () => res(200, { data: { goods: [] } })
  };

  await st.service.handlers['wb:goods']({ force: true });
  await st.service.handlers['costs:save']({ items: { 1001: { costPriceRub: 300 }, 2002: { costPriceRub: 300 } } });
  await st.service.handlers['repricer:item-configs:save']({ items: {
    1001: { minPrice: 500, sizePriceMode: 'sync' },
    2002: { minPrice: 500, sizePriceMode: 'none' }
  } });
  // своя цена в «Цены и скидки» — гарантирует попадание в предложение (репрайсер
  // сам поверх расчёта не меняет цену, поэтому без черновика needSend=false)
  await st.service.handlers['prices:draft-save']({ items: {
    1001: { basePrice: 850, discount: 0 },
    2002: { basePrice: 950, discount: 0 }
  } });

  await st.service.handlers['repricer:calc']({ full: true });
  const prop = await st.service.handlers['repricer:proposal']();
  check('цены по размерам: оба товара вошли в предложение',
    (prop.items || []).length === 2,
    'items=' + JSON.stringify((prop.items || []).map((x) => [x.nmID, x.basePrice])));
  check('цены по размерам: предложение несёт режим цен по размерам',
    (prop.items || []).every((x) => x.sizePriceMode === 'sync' || x.sizePriceMode === 'none'),
    JSON.stringify((prop.items || []).map((x) => [x.nmID, x.sizePriceMode])));

  const sent = await st.service.handlers['repricer:proposal-send']({ source: 'test-size', nmIDs: [1001, 2002] });
  check('цены по размерам: отправка ушла в upload/task/size (а не только в upload/task)',
    callsTo('/api/v2/upload/task/size').length >= 1, 'size-запросов: ' + callsTo('/api/v2/upload/task/size').length);
  const itemPosts = callsTo('/api/v2/upload/task').length - callsTo('/api/v2/upload/task/size').length;
  check('цены по размерам: цена товара тоже отправлена (upload/task)', itemPosts >= 1, 'POST upload/task: ' + itemPosts);

  // sync: все размеры товара 1001 (900 и 800) получат цену товара (черновик — 850)
  const sizeBody = sizePosts.length ? JSON.parse(sizePosts[sizePosts.length - 1].body).data : [];
  check('режим sync: размер 1001#11 отправлен с ценой товара (850)',
    sizeBody.some((x) => Number(x.nmID) === 1001 && Number(x.sizeID) === 11 && Number(x.price) === 850),
    JSON.stringify(sizeBody));
  check('режим sync: размер 1001#12 тоже отправлен с ценой товара (850)',
    sizeBody.some((x) => Number(x.nmID) === 1001 && Number(x.sizeID) === 12 && Number(x.price) === 850),
    JSON.stringify(sizeBody));
  check('режим none: размеры товара 2002 не отправлены',
    !sizeBody.some((x) => Number(x.nmID) === 2002), 'sizeBody: ' + JSON.stringify(sizeBody));
  check('режим none: предупреждение «цена всех размеров станет одинаковой»',
    (sent.warnings || []).some((w) => w.type === 'size-equalize' && Number(w.nmID) === 2002),
    JSON.stringify((sent.warnings || []).filter((w) => w.type === 'size-equalize')));
  check('429: отправка по размерам не падает (ретраи с ожиданием)',
    sent.ok === true && sizePosts.length >= 2, 'попыток к size: ' + sizePosts.length);

  // ── валидация: чужой размер, карантин, ручная отправка ──
  await st.service.handlers['wb:goods']({ force: true });
  const vr = await st.service.handlers['wb:apply-size-prices']({ items: [
    { nmID: 1001, sizeID: 99, price: 500, discount: 0 },   // чужой размер
    { nmID: 1001, sizeID: 12, price: 100, discount: 0 },   // карантин (800 → 100 < 800/3)
    { nmID: 1001, sizeID: 11, price: 750, discount: 0 }    // ок
  ] });
  check('валидация: чужой sizeID отклонён (не отправлен)',
    (vr.warnings || []).some((w) => w.type === 'unknown-size' && Number(w.sizeID) === 99),
    JSON.stringify((vr.warnings || []).filter((w) => w.type === 'unknown-size')));
  check('валидация: карантин цены по размеру срабатывает',
    (vr.warnings || []).some((w) => w.type === 'quarantine' && Number(w.sizeID) === 12),
    JSON.stringify((vr.warnings || []).filter((w) => w.type === 'quarantine')));
  // чужой размер не отправлен, корректные — отправлены
  const vBody = sizePosts.length ? JSON.parse(sizePosts[sizePosts.length - 1].body).data : [];
  check('валидация: чужой размер не отправлен, корректные — отправлены',
    !vBody.some((x) => Number(x.sizeID) === 99) && vBody.some((x) => Number(x.sizeID) === 11),
    JSON.stringify(vBody));
}

/** Регрессии приёмки F: ручная правка не должна выравнивать остальные размеры. */
async function tSizePriceSafety() {
  const st = makeStand({ live: true });
  const goods = [{
    nmID: 7007, vendorCode: 'SIZE-SAFE', brand: 'Тест', subjectName: 'Одежда',
    discount: 10, editableSizePrice: true, currencyIsoCode4217: 'RUB',
    sizes: [
      { sizeID: 701, techSizeName: 'S', price: 900, discountedPrice: 810 },
      { sizeID: 702, techSizeName: 'M', price: 1000, discountedPrice: 900 },
      { sizeID: 703, techSizeName: 'L', price: 1100, discountedPrice: 990 }
    ]
  }, {
    nmID: 8008, price: 900, discount: 0, editableSizePrice: false,
    sizes: [{ sizeID: 801, price: 900 }]
  }];
  const commonPosts = [], sizePosts = [];
  let history = [], rejectSize = false, sizeError = false, taskId = 15000;
  const recalcDiscounts = (good) => good.sizes.forEach((size) => { size.discountedPrice = size.price * (1 - good.discount / 100); });
  routes = {
    '/api/v2/list/goods/filter': () => res(200, { data: { total: goods.length, goods } }),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0 } }),
    '/api/v2/upload/task/size': (url, init) => {
      const body = JSON.parse(init.body).data;
      sizePosts.push(body);
      if (rejectSize) return res(400, { errorText: 'Ошибка поразмерной отправки' });
      history = body.map((row) => {
        const good = goods.find((g) => g.nmID === row.nmID);
        const size = good && good.sizes.find((s) => s.sizeID === row.sizeID);
        if (!sizeError && size) { size.price = row.price; recalcDiscounts(good); }
        return Object.assign({}, row, { status: sizeError ? 3 : 2, errorText: sizeError ? 'WB отклонил размер' : '' });
      });
      return res(200, { data: { taskId: ++taskId } });
    },
    '/api/v2/upload/task': (url, init) => {
      const body = JSON.parse(init.body).data;
      commonPosts.push(body);
      history = body.flatMap((row) => {
        const good = goods.find((g) => g.nmID === row.nmID);
        if (good) {
          if (row.price !== undefined) good.sizes.forEach((size) => { size.price = row.price; });
          if (row.discount !== undefined) good.discount = row.discount;
          recalcDiscounts(good);
          // Официальная история общего обновления возвращает строки размеров.
          return good.sizes.map((size) => ({ ...row, sizeID: size.sizeID, price: size.price, status: 2, errorText: '' }));
        }
        return [{ ...row, status: 2, errorText: '' }];
      });
      return res(200, { data: { taskId: ++taskId } });
    },
    '/api/v2/history/goods/task': () => res(200, { data: { historyGoods: history } })
  };
  await st.service.handlers['wb:goods']({ force: true });
  await st.service.handlers['costs:save']({ items: { 7007: { costPriceRub: 200 }, 8008: { costPriceRub: 200 } } });
  await st.service.handlers['repricer:item-configs:save']({ items: {
    7007: { minPrice: 500, sizePriceMode: 'manual', sizePrices: { 702: 1050, 703: 1100 } }
  } });
  await st.service.handlers['prices:draft-save']({ items: { 7007: { basePrice: 900, discount: 10 } } });
  const calc = await st.service.handlers['repricer:calc']({ full: true });
  const row = calc.results.find((r) => r.nmID === 7007);
  check('F: правка только размера помечает строку к отправке', row && row.needSend && row.sizeChanges === 1);
  const proposal = await st.service.handlers['repricer:proposal']();
  check('F: правка только размера попадает в предложение при неизменной общей цене',
    proposal.items.some((p) => p.nmID === 7007 && p.basePrice === 900 && p.currentBasePrice === 900));
  const sent = await st.service.handlers['repricer:proposal-send']({ nmIDs: [7007] });
  check('F: manual не отправляет общую базовую цену товара', commonPosts.length === 0);
  check('F: manual отправляет только изменившийся размер', sizePosts.length === 1 && sizePosts[0].length === 1 && sizePosts[0][0].sizeID === 702);
  check('F: тело size-запроса строго nmID/sizeID/price, без discount',
    Object.keys(sizePosts[0][0]).sort().join(',') === 'nmID,price,sizeID');
  check('F: ручная правка сохраняет остальные размеры и общую скидку',
    goods[0].sizes.map((s) => s.price).join(',') === '900,1050,1100' && goods[0].discount === 10);
  check('F: итог включает реальные sizeSent и детали с sizeID',
    sent.sent === 1 && sent.sizeSent === 1 && sent.details.length === 1 && sent.details[0].sizeID === 702);

  const n = sizePosts.length;
  const unchanged = await st.service.handlers['wb:apply-size-prices']({ items: [{ nmID: 7007, sizeID: 702, price: 1050 }] });
  check('F: unchanged-размеры не вызывают WB и дают нулевую загрузку', unchanged.uploaded === 0 && unchanged.skippedUnchanged === 1 && sizePosts.length === n);
  const bad = await st.service.handlers['wb:apply-size-prices']({ items: [
    { nmID: 7007, sizeID: 999, price: 950 }, { nmID: 7007, sizeID: 701, price: Infinity },
    { nmID: 7007, sizeID: 702, price: 0.2 }, { nmID: 8008, sizeID: 801, price: 950 }
  ] });
  check('F: чужой размер, бесконечная/округлённая в ноль цена и запрет WB отфильтрованы',
    bad.uploaded === 0 && bad.warnings.length === 4 && sizePosts.length === n);
  const restarted = createService(st.store, () => {});
  const forged = await restarted.handlers['wb:apply-size-prices']({
    items: [{ nmID: 9999, sizeID: 999, price: 1000 }],
    goods: [{ nmID: 9999, editableSizePrice: true, sizes: [{ sizeID: 999, price: 900 }] }]
  });
  check('F: payload.goods не позволяет подделать принадлежность размера',
    forged.uploaded === 0 && forged.warnings[0].type === 'unknown-item' && sizePosts.length === n);
  const quarantine = await st.service.handlers['wb:apply-size-prices']({ items: [{ nmID: 7007, sizeID: 701, price: 100 }] });
  check('F: защита приложения блокирует снижение цены размера более чем втрое',
    quarantine.uploaded === 0 && quarantine.warnings.some((w) => w.type === 'quarantine') && sizePosts.length === n);

  const beforePrices = goods[0].sizes.map((s) => s.price).join(',');
  await st.service.handlers['repricer:send']({ items: [{ nmID: 7007, price: 900, discount: 20 }] });
  const discountBody = commonPosts[commonPosts.length - 1][0];
  check('F: общая скидка отправляется без общей цены и не выравнивает размеры',
    discountBody.discount === 20 && !Object.hasOwn(discountBody, 'price') && goods[0].sizes.map((s) => s.price).join(',') === beforePrices);

  // Ошибки size-этапа видны и в ответе, и в истории, и интеграции Telegram.
  sizeError = true;
  await st.service.handlers['repricer:item-configs:save']({ items: { 7007: { sizePrices: { 702: 1060 } } } });
  const failed = await st.service.handlers['repricer:send']({ items: [{ nmID: 7007, price: 900, discount: 20 }] });
  check('F: ошибка размера не теряется при объединении результатов отправки',
    failed.sizeSent === 1 && failed.details.some((d) => d.sizeID === 702 && d.status === 6 && /WB отклонил/.test(d.errorText)));
  check('F/K: ошибка размера попадает в историю и событие sendError',
    st.store.loadTasks().some((t) => t.kind === 'size-prices' && t.failed === 1) &&
    st.events.some((e) => e.channel === 'app-event' && e.payload.type === 'sendError' && /WB отклонил/.test(e.payload.message)));
  sizeError = false;
  rejectSize = true;
  let networkFailed = false;
  try { await st.service.handlers['wb:apply-size-prices']({ items: [{ nmID: 7007, sizeID: 702, price: 1060 }] }); }
  catch (e) { networkFailed = e.status === 400; }
  check('F/K: сетевая ошибка size-этапа не маскируется успехом', networkFailed &&
    st.events.some((e) => e.channel === 'app-event' && e.payload.type === 'sendError' && /HTTP 400/.test(e.payload.message)));
  rejectSize = false;

  await st.service.handlers['repricer:save']({ sizePriceMode: 'sync' });
  await st.service.handlers['repricer:item-configs:save']({ items: { 7007: { sizePriceMode: null, sizePrices: null } } });
  const globalMode = await st.service.handlers['repricer:calc']({ full: true });
  const globalRow = globalMode.results.find((r) => r.nmID === 7007);
  check('F: общий режим sync доходит до движка и учитывает отличающиеся размеры',
    globalRow && globalRow.context.sizePriceMode === 'sync' && globalRow.sizeChanges > 0 &&
    globalRow.sizeChanges === goods[0].sizes.filter((size) => Math.round(size.price) !== Math.round(globalRow.proposed.basePrice)).length,
    JSON.stringify(globalRow && { mode: globalRow.context.sizePriceMode, sizeChanges: globalRow.sizeChanges, target: globalRow.proposed.basePrice }));
  await st.service.handlers['repricer:item-configs:save']({ items: { 7007: { sizePriceMode: 'none' } } });
  const ownNone = await st.service.handlers['repricer:calc']({ full: true });
  check('F: индивидуальный none важнее общего sync', ownNone.results.some((r) => r.nmID === 7007 && r.context.sizePriceMode === 'none'));

  await st.service.handlers['repricer:item-configs:save']({ items: { 7007: { sizePriceMode: 'manual', sizePrices: { 702: 1060 } } } });
  await st.service.handlers['repricer:calc']({ full: true });
  const beforeStale = sizePosts.length + commonPosts.length;
  goods[0].sizes[1].price = 1065; // минимум (900) остался прежним
  let stale = false;
  try { await st.service.handlers['repricer:proposal-send']({ nmIDs: [7007] }); }
  catch (e) { stale = e.code === 'PROPOSAL_STALE'; }
  check('F: чужая правка неминимального размера делает предложение устаревшим',
    stale && sizePosts.length + commonPosts.length === beforeStale);

  await st.service.handlers['repricer:item-configs:save']({ items: { 7007: { sizePriceMode: 'none' } } });
  await st.service.handlers['prices:draft-save']({ items: { 7007: { basePrice: 950, discount: 20 } } });
  await st.service.handlers['repricer:calc']({ full: true });
  const beforeAuto = sizePosts.length + commonPosts.length;
  const skippedAuto = await st.service.handlers['repricer:proposal-send']({ source: 'repricer-auto', nmIDs: [7007] });
  const autoBlocked = skippedAuto.sent === 0 && (skippedAuto.warnings || []).some((w) => w.nmID === 7007 && w.type === 'size-equalize-blocked');
  check('F: автоотправка не выравнивает разные размеры в режиме none без ручного подтверждения',
    autoBlocked && sizePosts.length + commonPosts.length === beforeAuto);
}

// ───────────────────────── 3. Устаревшее предложение не затирает чужие правки ─────────────────────────

async function tStaleProposal() {
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });
  const calc = await st.service.handlers['repricer:calc']({ full: true });
  const prop = await st.service.handlers['repricer:proposal']();
  if (!prop.items.length) {
    check('устаревшее предложение: пересчёт дал изменения', false, 'предложение пустое — сценарий не проверить');
    return;
  }
  // имитируем: пока предложение лежало, цену в кабинете изменили (руками или другой программой)
  const items = prop.items.map((x, i) => (i === 0 ? Object.assign({}, x, { currentSellerPrice: Number(x.currentSellerPrice) + 500 }) : x));
  st.store.saveProposals(Object.assign({}, prop, { items }));

  let err = null;
  let out = null;
  try { out = await st.service.handlers['repricer:proposal-send']({}); } catch (e) { err = e; }
  const changedOne = items.length === 1;
  if (changedOne) {
    check('устаревшее предложение: отправка отклонена', !!err && err.code === 'PROPOSAL_STALE', err ? err.code + ': ' + err.message : 'отправлено ' + JSON.stringify(out));
  } else {
    check('устаревшее предложение: устаревшая позиция пропущена',
      !!(out && Array.isArray(out.stale) && out.stale.length === 1), out ? 'stale=' + JSON.stringify((out.stale || []).map((x) => x.nmID)) : 'нет ответа');
    check('устаревшее предложение: причина понятна',
      !!(out && out.stale && /цена в WB изменилась/.test(out.stale[0].reason || '')), out && out.stale && out.stale[0].reason);
  }
  const after = await st.service.handlers['repricer:proposal']();
  check('устаревшее предложение: состояние видно в интерфейсе',
    after.phase === 'stale' || after.phase === 'sent' || after.phase === 'partial' && after.items.some((x) => x.sendState === 'stale'), 'phase=' + after.phase);
  void calc;
}

// ───────────────────────── 4. Карточка товара одним запросом ─────────────────────────

async function tItemCard() {
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });
  const goods = await st.service.handlers['wb:goods']({});
  const nm = (goods.items || [])[0].nmID;

  // конкуренты и ручная комиссия — чтобы карточка показывала не только расчёт
  await st.service.handlers['repricer:competitors:save']({ items: { [String(nm)]: [{ id: 'c1', name: 'Конкурент А', price: 900, stock: 5, enabled: true }] } });
  await st.service.handlers['repricer:item-configs:save']({ items: { [String(nm)]: { strategy: 'margin', commissionPct: 21 } } });
  await st.service.handlers['prices:draft-save']({ items: { [String(nm)]: { basePrice: 1500, discount: 10 } } });

  const card = await st.service.handlers['items:card']({ nmID: nm });
  check('карточка: товар найден', card.ok === true && Number(card.item.nmID) === Number(nm));
  check('карточка: есть экономика (расходы и источник)', !!card.overrides || !!card.item);
  check('карточка: есть конкуренты', (card.competitors || []).length === 1, JSON.stringify(card.competitors));
  check('карточка: есть ручные настройки товара', !!card.itemConfig && card.itemConfig.commissionPct === 21, JSON.stringify(card.itemConfig));
  check('карточка: есть черновик цены', !!card.drafts && card.drafts.basePrice === 1500);
  check('карточка: есть акции товара', Array.isArray(card.promos), 'акций: ' + (card.promos || []).length);
  check('карточка: есть статистика продаж', card.stats === null || typeof card.stats === 'object');
  check('карточка: есть история цен', Array.isArray(card.priceHistory));
  check('карточка: есть история пересчёта', Array.isArray(card.recalcHistory));
  check('карточка: отдаются настройки для расчёта', !!card.settings && !!card.settings.commissionDefault);

  let bad = null;
  try { await st.service.handlers['items:card']({}); } catch (e) { bad = e; }
  check('карточка: без артикула — понятная ошибка', !!bad && bad.code === 'BAD_NMID', bad ? bad.message : 'ошибки нет');
}

// ───────────────────────── 5. Акции: 422 на автоакциях ─────────────────────────

async function tPromo422() {
  calls.length = 0;
  const st = makeStand({ live: true });
  const AUTO_ID = 91001;
  const REG_ID = 91002;

  routes = {
    '/api/v2/list/goods/filter': () => res(200, {
      data: {
        total: 2,
        goods: [
          { // скидка 10% — ниже порога обычной акции (15%), в состав попасть не должен
            nmID: 1111111, vendorCode: 'ART-1', brand: 'Тест', subjectName: 'Товары для дома',
            price: 1000, discount: 10,
            sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 1000, discount: 10, skus: ['b1'] }]
          },
          { // скидка 20% — проходит порог обычной акции (15%)
            nmID: 2222222, vendorCode: 'ART-2', brand: 'Тест', subjectName: 'Товары для дома',
            price: 2000, discount: 20,
            sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 2000, discount: 20, skus: ['b2'] }]
          }
        ]
      }
    }),
    '/api/v1/calendar/promotions/details': () => res(200, {
      data: {
        promotions: [
          { id: AUTO_ID, name: 'Автоакция WB', participationPercentage: 20, ranging: [{ participationRate: 20 }] },
          { id: REG_ID, name: 'Обычная акция', participationPercentage: 15, ranging: [{ participationRate: 15 }] }
        ]
      }
    }),
    '/api/v1/calendar/promotions/nomenclatures': (u) => {
      // WB отвечает 422 на состав автоакции (и на закрытые акции)
      if (u.includes('promotionID=' + AUTO_ID)) return res(422, { errorText: 'Unprocessable entity' });
      return res(200, { data: { nomenclatures: [{ nmID: 1111111, price: 1000, discount: 20, planPrice: 800, inAction: true }], total: 1 } });
    },
    '/api/v1/calendar/promotions': () => res(200, {
      data: {
        promotions: [
          { id: AUTO_ID, name: 'Автоакция WB', type: 'auto', joinType: 'Автоматическое участие', startDateTime: '2026-11-01T00:00:00Z', endDateTime: '2026-12-01T00:00:00Z' },
          { id: REG_ID, name: 'Обычная акция', type: 'regular', joinType: 'Присоединиться вручную', startDateTime: '2026-11-01T00:00:00Z', endDateTime: '2026-12-01T00:00:00Z' }
        ]
      }
    }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } })
  };

  const idx = await st.service.handlers['promos:index']();
  check('акции: индекс собран', idx.ok === true && (idx.promos || []).length === 2, 'акций ' + (idx.promos || []).length);

  // ГЛАВНОЕ: к WB за составом акции не ходим вообще — метод отвечает 422 почти всегда,
  // а настоящий состав продавец скачивает файлом в кабинете.
  check('акции: состав через API не запрашивается (по умолчанию)',
    callsTo('/promotions/nomenclatures').length === 0,
    'запросов: ' + callsTo('/promotions/nomenclatures').length);
  check('акции: календарь акций при этом загружен', callsTo('/calendar/promotions').length > 0,
    'запросов календаря: ' + callsTo('/calendar/promotions').length);

  const autoCalls = callsTo('/promotions/nomenclatures').filter((c) => c.url.includes('promotionID=' + AUTO_ID));
  check('акции: состав автоакции через API не запрашивается', autoCalls.length === 0, 'запросов: ' + autoCalls.length);

  const auto = (idx.promos || []).find((p) => Number(p.promoId) === AUTO_ID);
  const reg = (idx.promos || []).find((p) => Number(p.promoId) === REG_ID);
  check('акции: автоакция помечена', !!auto && auto.auto === true, auto && JSON.stringify({ auto: auto.auto, noApi: auto.noApi }));
  check('акции: обе акции помечены «состав из файла»',
    !!auto && /файл/i.test(auto.noApi || '') && !!reg && /файл/i.test(reg.noApi || ''),
    JSON.stringify({ auto: auto && auto.noApi, reg: reg && reg.noApi }));
  check('акции: состав выведен по факту скидки (товар со скидкой 20% при пороге 15%)',
    !!reg && reg.inAction === 1 && reg.eligible === 1,
    reg ? JSON.stringify({ inAction: reg.inAction, eligible: reg.eligible }) : 'нет');
  const autoItems = await st.service.handlers['promos:items']({ promotionID: AUTO_ID });
  check('акции: товар со скидкой ниже порога в состав не попал',
    (autoItems.items || []).every((x) => Number(x.nmID) !== 1111111) &&
      (autoItems.items || []).some((x) => Number(x.nmID) === 2222222),
    'в автоакции (порог 20%): ' + JSON.stringify((autoItems.items || []).map((x) => x.nmID)));

  // окно акции: состав из данных приложения, без обращения к WB
  calls.length = 0;
  const pi = await st.service.handlers['promos:items']({ promotionID: REG_ID });
  check('окно акции: состав отдан без запросов к WB', callsTo('/promotions/nomenclatures').length === 0,
    'запросов: ' + callsTo('/promotions/nomenclatures').length);
  check('окно акции: источник состава подписан', pi.source === 'inferred' || pi.source === 'file', 'source=' + pi.source);
  check('окно акции: есть товары и требуемая скидка',
    (pi.items || []).length === 1 && pi.requiredDiscountPct === 15 && Number(pi.items[0].nmID) === 2222222,
    'товаров ' + (pi.items || []).length + ', скидка ' + pi.requiredDiscountPct +
      ', нм ' + ((pi.items[0] || {}).nmID || '—'));
  check('окно акции: подсказка про файл, если состава нет',
    typeof pi.hint === 'string', JSON.stringify(pi.hint).slice(0, 60));

  const warns = st.events.filter((e) => e.channel === 'warn' && /promo/.test(JSON.stringify(e.payload)));
  check('акции: нет потока одинаковых предупреждений', warns.length <= 1, 'предупреждений: ' + warns.length);
  check('акции: 422 не считается жёсткой ошибкой', (idx.hardErrors || []).length === 0, JSON.stringify(idx.hardErrors));
  // в файловом режиме к API за составом не ходим ни по одной акции — поэтому обе помечены
  check('акции: сколько акций без состава из API — видно одним числом', idx.noApiCount === 2, 'noApiCount=' + idx.noApiCount);

  // повторный вход в раздел не должен заново долбить WB
  calls.length = 0;
  await st.service.handlers['repricer:promo-plan']({});
  const nomCalls = callsTo('/promotions/nomenclatures');
  check('акции: повторный расчёт не запрашивает состав заново (кэш)', nomCalls.length === 0, 'запросов: ' + nomCalls.length);

  // если продавец сам включит запросы к API — автоакции всё равно пропускаем, а 422 терпим
  st.store.saveSettings({ promosFetchNomenclatures: true });
  calls.length = 0;
  st.events.length = 0;
  const idxApi = await st.service.handlers['promos:index']({ force: true });
  check('акции: с включённым API состав автоакции всё равно не запрашивается',
    callsTo('/promotions/nomenclatures').filter((c) => c.url.includes('promotionID=' + AUTO_ID)).length === 0,
    'запросов: ' + callsTo('/promotions/nomenclatures').filter((c) => c.url.includes('promotionID=' + AUTO_ID)).length);
  check('акции: с включённым API обычная акция прочитана',
    callsTo('/promotions/nomenclatures').filter((c) => c.url.includes('promotionID=' + REG_ID)).length > 0,
    'запросов: ' + callsTo('/promotions/nomenclatures').length);
  check('акции: с включённым API поток ошибок не появляется',
    st.events.filter((e) => e.channel === 'warn').length <= 1,
    'предупреждений: ' + st.events.filter((e) => e.channel === 'warn').length);
  st.store.saveSettings({ promosFetchNomenclatures: false });
  void idxApi;

  // теперь обычная акция тоже отвечает 422 (закрытая акция) — ошибки не сыплются.
  // Индекс акций кэшируется на 15 минут, поэтому перечитать его можно только явным force —
  // это же бережёт лимит календаря WB (10 запросов за 6 секунд) при каждом входе в раздел.
  calls.length = 0;
  routes['/api/v1/calendar/promotions/nomenclatures'] = () => res(422, { errorText: 'Unprocessable entity' });
  st.events.length = 0;
  const idxCached = await st.service.handlers['promos:index']({});
  check('акции: без force индекс берётся из кэша и не идёт в WB',
    callsTo('/promotions/nomenclatures').length === 0 && callsTo('/calendar/promotions').length === 0,
    'запросов состава ' + callsTo('/promotions/nomenclatures').length +
      ', календаря ' + callsTo('/calendar/promotions').length);
  // теперь обычная акция тоже отвечает 422 (так WB отвечает почти всегда) — при включённом API
  st.store.saveSettings({ promosFetchNomenclatures: true });
  calls.length = 0;
  st.events.length = 0;
  const idx2 = await st.service.handlers['promos:index']({ force: true });
  const warns2 = st.events.filter((e) => e.channel === 'warn');
  check('акции: 422 на обычной акции — тоже не поток ошибок', warns2.length === 0,
    'предупреждений: ' + warns2.length + (warns2[0] ? ': ' + warns2[0].payload.message : ''));
  check('акции: обе акции помечены как «состав только файлом»', idx2.noApiCount === 2, 'noApiCount=' + idx2.noApiCount);
  check('акции: 422 не считается жёсткой ошибкой', (idx2.hardErrors || []).length === 0, JSON.stringify(idx2.hardErrors));
  check('акции: запросов к WB минимум (по одному на акцию, а не шквал)',
    callsTo('/promotions/nomenclatures').length <= 2, 'запросов: ' + callsTo('/promotions/nomenclatures').length);
}

// ───────────────────────── 6. Экспорт Excel ─────────────────────────

async function tXlsx() {
  const st = makeStand();
  const { readTable } = require('../../electron/xlsx-lite');
  const headers = ['нм-код', 'Артикул', 'Цена', 'Скидка %', 'Прибыль', 'Примечание'];
  const rows = [
    [1111111, 'ART-1', 1329.24, 24, -15.5, ''],
    [2222222, 'ART-2', 2000, 20, 300.1, 'текст с <xml> & "кавычками"']
  ];

  const res = await st.service.handlers['xlsx:build']({ rows, headers, sheetName: 'Репрайсер' });
  check('excel: файл собран', res.ok === true && res.size > 500, 'байт ' + res.size);
  check('excel: в ответе base64 и число строк', typeof res.base64 === 'string' && res.rows === 2, 'строк ' + res.rows);

  const buf = Buffer.from(res.base64, 'base64');
  check('excel: сигнатура ZIP на месте', buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50,
    '0x' + buf.readUInt32LE(0).toString(16));

  const back = readTable(buf, 'test.xlsx');
  check('excel: наш читатель разбирает файл обратно', (back.rows || []).length === 3,
    'строк ' + (back.rows || []).length);
  check('excel: заголовки на месте',
    String((back.rows[0] || [])[0]) === 'нм-код' && String((back.rows[0] || [])[5]) === 'Примечание',
    JSON.stringify(back.rows[0]));
  check('excel: числа читаются как числа',
    Number((back.rows[1] || [])[2]) === 1329.24 && Number((back.rows[1] || [])[4]) === -15.5,
    JSON.stringify(back.rows[1]));
  check('excel: спецсимволы экранированы корректно',
    String((back.rows[2] || [])[5]) === 'текст с <xml> & "кавычками"', String((back.rows[2] || [])[5]));
  check('excel: пустая ячейка остаётся пустой', String((back.rows[1] || [])[5] || '') === '');

  // ограничение как в INDEEPA: до 150 000 строк
  let err = null;
  try {
    await st.service.handlers['xlsx:build']({ rows: new Array(150001).fill([1, 'x']), headers });
  } catch (e) { err = e; }
  check('excel: больше 150 000 строк отклоняется с понятной ошибкой',
    !!err && err.code === 'TOO_MANY_ROWS' && /CSV/.test(err.message), err ? err.message : 'ошибки нет');

  // много строк: файл должен собраться и прочитатьcя
  const big = [];
  for (let i = 0; i < 2000; i++) big.push([1000000 + i, 'ART-' + i, 500 + i, 10, 25.5, '']);
  const bigRes = await st.service.handlers['xlsx:build']({ rows: big, headers, sheetName: 'Много' });
  const bigBack = readTable(Buffer.from(bigRes.base64, 'base64'), 'big.xlsx');
  check('excel: 2000 строк выгружаются и читаются', (bigBack.rows || []).length === 2001,
    'строк ' + (bigBack.rows || []).length + ', размер ' + bigRes.size + ' байт');
}

// ─────────── 7. Отстройка от конкурента: процентом или рублями (как в INDEEPA) ───────────

function tCompetitorOffset() {
  const RP = require('../../electron/repricer-engine');
  const ctx = {
    competitors: [{ id: 'c1', name: 'Конкурент А', price: 1000, stock: 5, enabled: true }],
    sppPct: 20, walletPct: 10
  };

  const plain = RP.bestCompetitorPrice(ctx, { competitorMode: 'plain', competitorOffsetMode: 'pct', competitorOffsetPct: 0 });
  check('отстройка: цена конкурента как есть', plain.price === 1000, String(plain.price));

  const minusPct = RP.bestCompetitorPrice(ctx, { competitorMode: 'plain', competitorOffsetMode: 'pct', competitorOffsetPct: -5 });
  check('отстройка: −5% от цены конкурента', minusPct.price === 950, String(minusPct.price));

  const minusRub = RP.bestCompetitorPrice(ctx, { competitorMode: 'plain', competitorOffsetMode: 'rub', competitorOffsetRub: -50 });
  check('отстройка: −50 ₽ от цены конкурента', minusRub.price === 950, String(minusRub.price));

  const plusRub = RP.bestCompetitorPrice(ctx, { competitorMode: 'plain', competitorOffsetMode: 'rub', competitorOffsetRub: 120 });
  check('отстройка: +120 ₽ работает и вверх', plusRub.price === 1120, String(plusRub.price));

  // с учётом СПП: цена на полке 1000 ₽ при СПП 20% → наша цена должна быть 1250 ₽
  const withSpp = RP.bestCompetitorPrice(ctx, { competitorMode: 'withSpp', competitorOffsetMode: 'pct', competitorOffsetPct: 0 });
  check('отстройка: тип цены «с учётом СПП»', withSpp.price === 1250, String(withSpp.price));

  // СПП + кошелёк: 1000 / ((1-0.2) × (1-0.1)) = 1388.89
  const withWallet = RP.bestCompetitorPrice(ctx, { competitorMode: 'withWallet', competitorOffsetMode: 'pct', competitorOffsetPct: 0 });
  check('отстройка: тип цены «СПП + кошелёк»', Math.abs(withWallet.price - 1388.89) < 0.01, String(withWallet.price));

  // отступ в рублях применяется ПОСЛЕ приведения к типу цены
  const sppRub = RP.bestCompetitorPrice(ctx, { competitorMode: 'withSpp', competitorOffsetMode: 'rub', competitorOffsetRub: -100 });
  check('отстройка: ₽ применяется после пересчёта по СПП', sppRub.price === 1150, String(sppRub.price));

  // защита от отрицательной цены
  const neg = RP.bestCompetitorPrice(ctx, { competitorMode: 'plain', competitorOffsetMode: 'rub', competitorOffsetRub: -5000 });
  check('отстройка: цена не уходит в минус', neg.price === 0, String(neg.price));

  // конкуренцию выигрывает минимальная цена, если SKU не указан
  const ctx2 = { competitors: [
    { id: 'c1', name: 'Дорогой', price: 1500, stock: 3, enabled: true },
    { id: 'c2', name: 'Дешёвый', price: 900, stock: 3, enabled: true },
    { id: 'c3', name: 'Выключен', price: 100, stock: 3, enabled: false }
  ], sppPct: 0, walletPct: 0 };
  const best = RP.bestCompetitorPrice(ctx2, { competitorMode: 'plain' });
  check('отстройка: без указания SKU берётся минимальная цена из включённых',
    best.price === 900 && best.source.name === 'Дешёвый', best.price + ' / ' + best.source.name);
  const picked = RP.bestCompetitorPrice(ctx2, { competitorMode: 'plain', competitorId: 'c1' });
  check('отстройка: «учитывать SKU» следит за конкретным конкурентом',
    picked.price === 1500 && picked.source.name === 'Дорогой', picked.price + ' / ' + picked.source.name);
}

// ─────── 8. Реальный СПП из статистики продаж WB доходит до экономики ───────

async function tSppFromStats() {
  const EC = require('../../electron/economics');
  const settings = {
    commissionDefault: 20, sppDefault: 5, logisticsBaseRub: 50, logisticsPerLiterRub: 15,
    literThreshold: 5, taxMode: 'usn6', taxRatePct: 6, categoryDefaults: {}, useFactCosts: true
  };
  const item = { nmID: 1, price: 1000, discount: 10, categoryName: 'Тест', volumeLiters: 1 };

  const base = EC.resolveParams(settings, item, {}, null);
  check('СПП: без данных статистики берётся настройка кабинета',
    base.sppPct === 5 && base.costSources.sppPct === 'settings', base.sppPct + ' / ' + base.costSources.sppPct);

  const withFact = EC.resolveParams(settings, item, {}, { sppPctAvg: 17.4 });
  check('СПП: средний СПП из статистики WB важнее общей настройки',
    withFact.sppPct === 17.4 && withFact.costSources.sppPct === 'fact',
    withFact.sppPct + ' / ' + withFact.costSources.sppPct);

  const manual = EC.resolveParams(settings, item, { sppPct: 22 }, { sppPctAvg: 17.4 });
  check('СПП: ручной ввод важнее факта из статистики',
    manual.sppPct === 22 && manual.costSources.sppPct === 'manual', manual.sppPct + ' / ' + manual.costSources.sppPct);

  const off = EC.resolveParams(Object.assign({}, settings, { useFactCosts: false }), item, {}, { sppPctAvg: 17.4 });
  check('СПП: не зависит от переключателя «расходы из отчёта WB»', off.sppPct === 17.4, String(off.sppPct));

  const unit = EC.calcUnit(900, EC.resolveParams(settings, item, {}, { sppPctAvg: 20 }));
  check('СПП: цена покупателю считается с реальным СПП',
    Math.abs(unit.buyerPrice - 720) < 0.01, String(unit.buyerPrice));

  // ── наблюдение витрины WB (модуль price-watcher): самый свежий источник СПП ──
  const watch = EC.resolveParams(settings, item, {}, { sppPctAvg: 17.4, sppPctWatch: 21 });
  check('СПП: наблюдение витрины важнее среднего по статистике продаж',
    watch.sppPct === 21 && watch.costSources.sppPct === 'watch',
    watch.sppPct + ' / ' + watch.costSources.sppPct);

  const watchManual = EC.resolveParams(settings, item, { sppPct: 22 }, { sppPctAvg: 17.4, sppPctWatch: 21 });
  check('СПП: ручной ввод важнее наблюдения витрины',
    watchManual.sppPct === 22 && watchManual.costSources.sppPct === 'manual',
    watchManual.sppPct + ' / ' + watchManual.costSources.sppPct);

  const watchZero = EC.resolveParams(settings, item, {}, { sppPctAvg: 17.4, sppPctWatch: 0 });
  check('СПП: ноль на витрине — осмысленное значение, а не «нет данных»',
    watchZero.sppPct === 0 && watchZero.costSources.sppPct === 'watch',
    watchZero.sppPct + ' / ' + watchZero.costSources.sppPct);

  const watchUnit = EC.calcUnit(1000, EC.resolveParams(settings, item, {}, { sppPctWatch: 15 }));
  check('СПП: цена покупателю по наблюдению витрины',
    Math.abs(watchUnit.buyerPrice - 850) < 0.01, String(watchUnit.buyerPrice));

  const watchOff = EC.resolveParams(Object.assign({}, settings, { useFactCosts: false }), item, {}, { sppPctWatch: 21 });
  check('СПП: наблюдение витрины не зависит от переключателя «расходы из отчёта WB»',
    watchOff.sppPct === 21, String(watchOff.sppPct));

  const watchMeta = EC.resolveParams(settings, item, {}, { sppPctWatch: 21, sppWatchSamples: 4, sppWatchAt: '2026-01-02T03:04:05.000Z' });
  check('СПП: в параметрах видно, сколько замеров легло в медиану',
    watchMeta.sppPctWatch === 21 && watchMeta.sppWatchSamples === 4 && !!watchMeta.sppWatchAt,
    'замеров ' + watchMeta.sppWatchSamples + ', последний ' + watchMeta.sppWatchAt);

  const noWatch = EC.resolveParams(settings, item, {}, { sppPctAvg: 17.4, sppPctWatch: null });
  check('СПП: пустое наблюдение не подменяет статистику',
    noWatch.sppPct === 17.4 && noWatch.costSources.sppPct === 'fact',
    noWatch.sppPct + ' / ' + noWatch.costSources.sppPct);

  // на демо-данных: СПП из статистики должен доехать до карточки товара
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });
  const goods = await st.service.handlers['wb:goods']({});
  const nm = (goods.items || [])[0].nmID;
  const facts = (goods.facts || {})[String(nm)] || {};
  check('СПП: демо-статистика отдаёт средний СПП по товару', Number(facts.sppPctAvg) > 0,
    'sppPctAvg=' + facts.sppPctAvg + ', продаж в основе ' + facts.sppSalesQty);
  const card = await st.service.handlers['items:card']({ nmID: nm });
  check('СПП: карточка товара видит фактический СПП', Number((card.facts || {}).sppPctAvg) > 0,
    'sppPctAvg=' + (card.facts || {}).sppPctAvg);

  // ── наблюдатель цен: запись вручную доходит до экономики товара ──
  const rec = await st.service.handlers['pricewatch:record']({ nmID: nm, shelfPrice: 1000, sppPrice: 800, source: 'manual' });
  check('наблюдатель: ручная запись считает СПП', rec.ok === true && rec.sppPct === 20, JSON.stringify(rec));
  const goods2 = await st.service.handlers['wb:goods']({});
  const facts2 = (goods2.facts || {})[String(nm)] || {};
  check('наблюдатель: медиана витрины попала в факты товара',
    Number(facts2.sppPctWatch) === 20 && Number(facts2.sppWatchSamples) === 1,
    'sppPctWatch=' + facts2.sppPctWatch + ', замеров ' + facts2.sppWatchSamples);

  // запись без цены покупателю не даёт СПП — и замером считаться не должна
  await st.service.handlers['pricewatch:record']({ nmID: nm, shelfPrice: 900 });
  const facts3 = ((await st.service.handlers['wb:goods']({}).then((g) => g.facts)) || {})[String(nm)] || {};
  check('наблюдатель: запись без СПП не увеличивает число замеров',
    Number(facts3.sppPctWatch) === 20 && Number(facts3.sppWatchSamples) === 1,
    'замеров ' + facts3.sppWatchSamples);

  // наблюдение старше 7 дней в расчёт не берётся
  st.store.appendPriceWatch([{ nmID: nm + 1, at: new Date(Date.now() - 9 * 86400000).toISOString(), shelfPrice: 1000, sppPrice: 700, sppPct: 30 }]);
  const facts4 = ((await st.service.handlers['wb:goods']({}).then((g) => g.facts)) || {})[String(nm + 1)] || {};
  check('наблюдатель: наблюдение старше 7 дней в экономику не попадает',
    facts4.sppPctWatch === undefined, JSON.stringify(facts4));

  // в демо-режиме к витрине не ходим: честный отказ вместо блокировки
  const demoFetch = await st.service.handlers['pricewatch:fetch']({ nmIDs: [nm], force: true });
  check('наблюдатель: в демо-режиме запрос к витрине не выполняется',
    demoFetch.ok === false && demoFetch.code === 'DEMO', JSON.stringify(demoFetch).slice(0, 80));
  const noForce = await st.service.handlers['pricewatch:fetch']({ nmIDs: [nm] });
  check('наблюдатель: без force и без разрешения сеть не запускается',
    noForce.ok === false && noForce.code === 'AUTO_DISABLED', JSON.stringify(noForce).slice(0, 80));
  const hist = await st.service.handlers['pricewatch:history']({ nmID: nm });
  check('наблюдатель: история и медиана доступны из интерфейса',
    hist.ok === true && hist.items.length >= 2 && hist.sppPct === 20,
    'записей ' + hist.items.length + ', медиана ' + hist.sppPct);
}

// ─────── 9. Журнал участия в акциях переживает возврат цены ───────

async function tPromoJournal() {
  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });

  // до действий с акциями журнал пуст
  const empty = await st.service.handlers['repricer:journal']({ kinds: ['promo-join', 'promo-exit', 'promo-restore'] });
  check('журнал акций: изначально пуст', empty.ok === true && empty.total === 0, 'событий ' + empty.total);

  // выводим товар из акции (демо-набор: автоакция «Скидки недели» идёт сейчас)
  const plan = await st.service.handlers['repricer:promo-plan']({});
  const exits = (plan.items || []).filter((it) => it.chosen && it.chosen.type === 'exit');
  check('журнал акций: в демо есть кандидаты на выход', exits.length > 0, 'кандидатов ' + exits.length);
  if (!exits.length) return;

  const one = exits.find((it) => it.needSend) || exits[0];
  const fresh = (await st.service.handlers['repricer:calc']({ full: true })).results
    .find((r) => String(r.nmID) === String(one.nmID));
  await st.service.handlers['repricer:promo-apply']({ results: [fresh || one] });

  const afterExit = await st.service.handlers['repricer:journal']({ kinds: ['promo-join', 'promo-exit', 'promo-restore'] });
  check('журнал акций: выход записан', (afterExit.byKind || {})['promo-exit'] >= 1,
    JSON.stringify(afterExit.byKind));
  const ev = (afterExit.events || []).find((e) => e.kind === 'promo-exit');
  check('журнал акций: в событии есть товар, акции и цены до/после',
    !!ev && Number(ev.nmID) > 0 && (ev.promoNames || []).length > 0 &&
      Number(ev.prevSellerPrice) > 0 && Number(ev.sellerPrice) > 0,
    ev ? JSON.stringify({ nm: ev.nmID, promos: ev.promoNames, was: ev.prevSellerPrice, now: ev.sellerPrice }) : 'нет события');
  check('журнал акций: причина решения сохранена', !!ev && String(ev.reason || '').length > 10,
    ev ? String(ev.reason).slice(0, 60) : '—');

  // возврат цены: очередь очистится, а журнал обязан остаться
  await st.service.handlers['repricer:promo-restore']({ force: true });
  const queue = await st.service.handlers['repricer:promo-exits']();
  const afterRestore = await st.service.handlers['repricer:journal']({ kinds: ['promo-join', 'promo-exit', 'promo-restore'] });
  check('журнал акций: очередь возврата после возврата пуста', (queue || []).length === 0,
    'в очереди ' + (queue || []).length);
  check('журнал акций: история выхода СОХРАНИЛАСЬ после возврата',
    (afterRestore.byKind || {})['promo-exit'] >= 1, JSON.stringify(afterRestore.byKind));
  check('журнал акций: событие возврата цены записано',
    (afterRestore.byKind || {})['promo-restore'] >= 1, JSON.stringify(afterRestore.byKind));
  const rest = (afterRestore.events || []).find((e) => e.kind === 'promo-restore');
  check('журнал акций: у возврата видны цена «до» и «после»',
    !!rest && Number(rest.prevSellerPrice) > 0 && Number(rest.sellerPrice) > 0,
    rest ? (rest.prevSellerPrice + ' → ' + rest.sellerPrice) : 'нет события');

  // фильтр по товару
  const byItem = await st.service.handlers['repricer:journal']({
    kinds: ['promo-join', 'promo-exit', 'promo-restore'], q: String(one.nmID)
  });
  check('журнал акций: фильтр по нм-коду работает', byItem.total >= 1 &&
    (byItem.events || []).every((e) => String(e.nmID) === String(one.nmID)),
    'найдено ' + byItem.total);
}

// ───────────────────────── запуск ─────────────────────────


// ───────────────────────── 12. Задание D: всё на одном экране ─────────────────────────

/**
 * Задание D: таблица репрайсера собрана из блоков («Артикул», «Инфо о товаре»,
 * «Текущая цена», «Новая цена», «Мин цена (в акции)», «Цена (вне акции)»,
 * «Себестоимость и экономика», «Конкуренты»), и всё это правится в одной строке —
 * без перехода в другие разделы. Проверяем данные, которые рисуют эти блоки:
 *  • себестоимость можно вести в валюте закупки (курс — из настроек);
 *  • без курса валюта не считается молча по 1:1 — строка получает явную ошибку;
 *  • флаг «Отправка в WB» выключает товар: цена считается, но в кабинет не уходит;
 *  • метка товара живёт в настройках товара и видна в расчёте;
 *  • баркод берётся из карточки контент-API (поле skus).
 */
async function tSingleScreen() {
  const { WBClient } = require('../../electron/wb-client');

  // ── баркод из карточки товара ──
  const card = WBClient.normalizeCard({ nmID: 7, skus: ['1234567890', '0987654321'], vendorCode: 'AB-1' });
  check('D: баркод берётся из поля skus карточки', card.barcode === '1234567890' && card.skus.length === 2,
    card.barcode + ' / ' + card.skus.length);
  const noSkus = WBClient.normalizeCard({ nmID: 8 });
  check('D: без баркода поле пустое, а не выдуманное', noSkus.barcode === '' && noSkus.skus.length === 0);

  const st = makeStand();
  await st.service.handlers['data:refresh-all']({ facts: false });
  const goods = await st.service.handlers['wb:goods']({});
  const first = (goods.items || [])[0];
  const nm = String(first.nmID);
  check('D: стенд с демо-товарами поднят', !!first, 'nmID=' + nm);

  const row = (calc) => (calc.results || []).find((x) => String(x.nmID) === nm);

  // ── блоки результата: данные для колонок одного экрана ──
  let calc = await st.service.handlers['repricer:calc']({ full: true });
  let r = row(calc);
  check('D: расчёт отдаёт блок «Себестоимость»', !!r.cost && typeof r.cost.rub === 'number' && !!r.cost.currency,
    r.cost && (r.cost.currency + ' ' + r.cost.rub));
  check('D: в блоке есть слагаемые расходов на единицу',
    !!r.cost.next && r.cost.next.totalCosts > 0 && typeof r.cost.next.commission === 'number',
    r.cost.next && ('всего ' + r.cost.next.totalCosts));
  check('D: считается цена безубыточности', !!r.cost.next && r.cost.next.breakEvenPrice > 0,
    r.cost.next && String(r.cost.next.breakEvenPrice));
  check('D: блок СПП/кошелька совпадает с ценой покупателю',
    !!r.wallet && Math.abs(r.wallet.nextBuyer - r.proposed.buyerPrice) < 0.01,
    r.wallet && (r.wallet.nextBuyer + ' / ' + r.proposed.buyerPrice));
  check('D: блок порогов говорит, чем задан пол',
    !!r.floor && (r.floor.by === 'margin' || r.floor.by === 'corridor') && r.floor.min > 0,
    r.floor && (r.floor.by + ' ' + r.floor.min));
  check('D: блок акций отдаёт порог скидки и решение',
    !!r.promo && typeof r.promo.discountFloor === 'number' && 'chosen' in r.promo);
  check('D: флаг отправки по умолчанию включён, метка пустая',
    r.allowSend === true && r.tag === '' && typeof r.barcode === 'string');

  // ── курсы валют и название магазина: настройки приложения ──
  const set0 = await st.service.handlers['settings:get']();
  check('D: в настройках есть курсы валют и название магазина',
    !!set0.costRates && typeof set0.costRates === 'object' && 'shopName' in set0,
    'валют с курсом: ' + Object.keys(set0.costRates || {}).length);
  const rates = await st.service.handlers['costs:rates']();
  check('D: costs:rates отдаёт список валют с ₽ первым',
    Array.isArray(rates.currencies) && rates.currencies[0] === 'RUB' && rates.currencies.includes('CNY'));

  await st.service.handlers['settings:save']({ costRates: { CNY: 12 }, shopName: 'Тестовый магазин' });
  const set1 = await st.service.handlers['settings:get']();
  check('D: курс и название магазина сохраняются',
    set1.costRates.CNY === 12 && set1.shopName === 'Тестовый магазин', set1.shopName);

  // ── себестоимость в валюте закупки ──
  await st.service.handlers['costs:save']({ items: { [nm]: { costPriceRub: 25, currency: 'CNY' } } });
  const ov = await st.service.handlers['costs:overrides']();
  check('D: переопределения пересчитывают валюту в рубли',
    ov.overrides[nm].costPriceRub === 300 && ov.overrides[nm].costRate === 12 && ov.overrides[nm].costEntered === 25,
    ov.overrides[nm].costPriceRub + ' ₽ из 25 CNY');
  const savedCosts = await st.service.handlers['costs:get']();
  check('D: сохранённое значение разделяет введённую валюту и рубли',
    savedCosts.items[nm].costEntered === 25 && savedCosts.items[nm].costPriceRub === 300 && savedCosts.items[nm].currency === 'CNY' && savedCosts.items[nm].costVersion === 2);

  calc = await st.service.handlers['repricer:calc']({ full: true });
  r = row(calc);
  check('D: в расчёте себестоимость — в рублях, с валютой и курсом',
    r.cost.rub === 300 && r.cost.currency === 'CNY' && r.cost.rate === 12 && r.cost.entered === 25,
    r.cost.rub + ' ₽');
  check('D: прибыль считается от рублёвой себестоимости',
    !!r.cost.next && r.cost.next.cogs === 300, r.cost.next && String(r.cost.next.cogs));

  // ── курс не задан: явная ошибка вместо тихого расчёта 1:1 ──
  await st.service.handlers['settings:save']({ costRates: { PLN: 0 } });
  await st.service.handlers['costs:save']({ items: { [nm]: { costPriceRub: 25, currency: 'PLN' } } });
  calc = await st.service.handlers['repricer:calc']({ full: true });
  r = row(calc);
  check('D: без курса валюта даёт явную ошибку',
    !!r.cost.error && /не задан курс PLN/.test(r.cost.error) && r.cost.rub === 0, String(r.cost.error));
  check('D: ошибка видна в предупреждениях строки',
    (r.warnings || []).some((w) => /не задан курс PLN/.test(w)));
  let prop = await st.service.handlers['repricer:proposal']();
  let blocked = (prop.blocked || []).find((b) => String(b.nmID) === nm);
  check('D: строка без курса не попадает в предложение',
    !!blocked && blocked.reasons.some((x) => /не задан курс PLN/.test(x)),
    blocked && blocked.reasons.join('; '));

  // курс задали — ошибка ушла, строка снова в предложении
  await st.service.handlers['settings:save']({ costRates: { CNY: 12, PLN: 40 } });
  calc = await st.service.handlers['repricer:calc']({ full: true });
  r = row(calc);
  check('D: после указания курса ошибка снимается', !r.cost.error && r.cost.rub === 1000, r.cost.rub + ' ₽');
  prop = await st.service.handlers['repricer:proposal']();
  check('D: после указания курса строка снова в предложении',
    !(prop.blocked || []).some((b) => String(b.nmID) === nm) &&
      (prop.items || []).some((x) => String(x.nmID) === nm));

  // ── флаг «Отправка в WB» и метка товара ──
  await st.service.handlers['costs:save']({ items: { [nm]: { costPriceRub: 250, currency: 'RUB' } } });
  await st.service.handlers['repricer:item-configs:save']({ items: { [nm]: { allowSend: false, tag: 'распродажа' } } });
  calc = await st.service.handlers['repricer:calc']({ full: true });
  r = row(calc);
  check('D: метка и флаг товара видны в расчёте',
    r.allowSend === false && r.tag === 'распродажа', r.tag);
  check('D: с выключенной отправкой строка не помечена «к отправке»', r.needSend === false);
  check('D: предупреждение объясняет, почему товар не уйдёт',
    (r.warnings || []).some((w) => /Отправка в WB отключена/.test(w)));
  prop = await st.service.handlers['repricer:proposal']();
  blocked = (prop.blocked || []).find((b) => String(b.nmID) === nm);
  check('D: товар с выключенной отправкой помечен в предложении',
    !!blocked && blocked.notSending === true && /отправка в WB отключена/.test(blocked.reasons.join(' ')),
    blocked && blocked.reasons.join('; '));

  // товар с выключенной отправкой вообще не попадает в список на отправку
  const before = (prop.items || []).length;
  check('D: выключенного товара нет в предложении на отправку',
    before > 0 && !(prop.items || []).some((x) => String(x.nmID) === nm), 'позиций: ' + before);
  const partial = await st.service.handlers['repricer:proposal-send']({ source: 'test-d' });
  check('D: остальные товары отправляются как обычно',
    partial.ok === true && partial.sent > 0, 'sent=' + partial.sent);

  // ── флаг выключили ПОСЛЕ расчёта: отправка обязана это учесть ──
  const st2 = makeStand();
  await st2.service.handlers['data:refresh-all']({ facts: false });
  await st2.service.handlers['repricer:calc']({ full: true });
  const prop2 = await st2.service.handlers['repricer:proposal']();
  const total2 = (prop2.items || []).length;
  check('D: предложение собрано до выключения флага', total2 > 1, 'позиций: ' + total2);
  const oneNm = String((prop2.items || [])[0].nmID);
  await st2.service.handlers['repricer:item-configs:save']({ items: { [oneNm]: { allowSend: false } } });
  const skipped = await st2.service.handlers['repricer:proposal-send']({ source: 'test-d' });
  check('D: выключенный после расчёта товар в WB не уходит',
    skipped.ok === true && skipped.skippedDisabled === 1 && skipped.sent === total2 - 1,
    'sent=' + skipped.sent + ', пропущено=' + skipped.skippedDisabled);

  // ── все товары с выключенной отправкой: отправка останавливается с понятной причиной ──
  const st3 = makeStand();
  await st3.service.handlers['data:refresh-all']({ facts: false });
  await st3.service.handlers['repricer:calc']({ full: true });
  const prop3 = await st3.service.handlers['repricer:proposal']();
  const allOff = {};
  (prop3.items || []).forEach((x) => { allOff[String(x.nmID)] = { allowSend: false }; });
  await st3.service.handlers['repricer:item-configs:save']({ items: allOff });
  let err = null;
  try { await st3.service.handlers['repricer:proposal-send']({ source: 'test-d' }); }
  catch (e) { err = e; }
  check('D: при выключенной отправке у всех товаров отправка не проходит',
    !!err && err.code === 'SEND_DISABLED', err && (err.code + ': ' + err.message));
  check('D: причина объясняет, что делать',
    !!err && /колонк|Отправка/i.test(err.message || ''), err && err.message);

  // ── флаг включили обратно: товар снова уходит в WB ──
  const backNm = String((prop3.items || [])[0].nmID);
  await st3.service.handlers['repricer:item-configs:save']({ items: { [backNm]: null } });
  const back = await st3.service.handlers['repricer:proposal-send']({ source: 'test-d' });
  check('D: после включения флага отправка снова работает',
    back.ok === true && back.sent === 1 && back.skippedDisabled === (prop3.items || []).length - 1,
    'sent=' + back.sent);
}

(async () => {
  console.log('=== Черновики цен («сохранить без отправки») ===');
  await tDrafts();
  console.log('\n=== Двухфазный автопересчёт репрайсера ===');
  await tTwoPhase();
  console.log('\n=== Валидация строк (товары без данных не отправляются) ===');
  await tBlockedItems();
  console.log('\n=== Поразмерные цены (WB не отдаёт price товара) ===');
  await tSizePricedGoods();
  console.log('\n=== Цены по размерам: отправка, режимы, валидация ===');
  await tSizePrices();
  console.log('\n=== Приёмка F: сохранность цен по размерам ===');
  await tSizePriceSafety();
  console.log('\n=== Устаревшее предложение ===');
  await tStaleProposal();
  console.log('\n=== Карточка товара ===');
  await tItemCard();
  console.log('\n=== Акции и HTTP 422 ===');
  await tPromo422();
  console.log('\n=== Экспорт Excel ===');
  await tXlsx();
  console.log('\n=== СПП из статистики продаж WB ===');
  await tSppFromStats();
  console.log('\n=== Журнал участия в акциях ===');
  await tPromoJournal();
  console.log('\n=== Отстройка от конкурента (%/₽) ===');
  tCompetitorOffset();
  console.log('\n=== Задание D: всё на одном экране (блоки, валюта, отправка) ===');
  await tSingleScreen();

  fs.rmSync(path.join(ROOT, '.data-test-repricer'), { recursive: true, force: true });

  console.log('\nВсего проверок: ' + (pass + fail) + ', пройдено: ' + pass + ', провалено: ' + fail);
  if (failures.length) {
    console.log('\nПровалено:');
    failures.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log('\nИТОГ: ' + (fail ? 'ЕСТЬ ПРОБЛЕМЫ' : 'ВСЁ ЗЕЛЁНОЕ'));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('СБОЙ ПРОГОНА:', e && e.stack ? e.stack : e);
  process.exit(1);
});
