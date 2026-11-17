'use strict';

/**
 * Прогон многопрофильности: несколько кабинетов WB в одном приложении.
 *
 * Проверяет критерии приёмки:
 *   1. Миграция существующего `.data` в профиль по умолчанию («Основной») без потерь.
 *   2. Два профиля не видят данные друг друга.
 *   3. Лимиты WB считаются на кабинет: два профиля могут запросить «Статистку»
 *      одновременно, каждый со своей паузой (лимитеры независимы).
 *   4. Переключление профиля не сбрасывает кэши чужого профиля.
 *   5. Экспорт/импорт профиля через формат задания J (.wbpm.json).
 *   6. Сводный P&L по всем профилям с указанием кабинета.
 *
 * Запуск: node tools/checks/profiles-flow.js
 */

process.env.WB_RATE_LIMIT_SCALE = process.env.WB_RATE_LIMIT_SCALE || '0.02';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { createProfileHub } = require('../../electron/profiles');
const { DATASETS, FORMAT } = require('../../electron/backup');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK   ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── заглушка сети ─────────────────────────

const calls = [];
let routes = {};
function res(status, body, headers) {
  const h = headers || {};
  const text = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => {
    const key = String(k).toLowerCase();
    for (const hk of Object.keys(h)) if (hk.toLowerCase() === key) return String(h[hk]);
    return null;
  } }, text: async () => text };
}
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body, at: Date.now() });
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  for (const key of keys) if (u.includes(key)) return routes[key](u, init, calls.length - 1);
  throw new Error('Нет заглушки для запроса: ' + u);
};
const callsTo = (sub) => calls.filter((c) => c.url.includes(sub));

const NM = [1111111, 2222222];
function goodsBody() {
  return { data: { total: NM.length, goods: NM.map((nmID, i) => ({
    nmID, vendorCode: 'ART-' + (i + 1), brand: 'Тест', subjectName: 'Товары для дома',
    price: 1000 + i * 500, discount: 10 + i * 5,
    sizes: [{ sizeID: 1, techSizeName: 'ONE SIZE', price: 1000 + i * 500, discount: 10 + i * 5, skus: ['bar' + nmID] }]
  })) } };
}
function salesRows(n) {
  const out = [];
  const count = n || 4;
  for (let i = 0; i < count; i++) out.push({
    nmId: NM[i % NM.length], date: new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 19),
    lastChangeDate: '2026-11-10T0' + i + ':00:00Z', price: 900 + i * 10, ppvz_for_pay: String(700 + i * 10),
    spp: 15, isReturn: i === count - 1, warehouseName: 'Коледино', srid: 'srid-' + i
  });
  return out;
}
function baseRoutes() {
  return {
    '/api/v2/list/goods/filter': () => res(200, goodsBody()),
    '/api/v1/calendar/promotions': () => res(200, { data: { promotions: [] } }),
    '/content/v2/get/cards/list': () => res(200, { cards: [], cursor: { total: 0, nmID: 0, updatedAt: '' } }),
    '/api/analytics/v1/stocks-report/wb-warehouses': () => res(200, { data: { rows: [], total: 0 } })
  };
}

// ───────────────────────── утилиты ─────────────────────────

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-profiles-' + label + '-'));
}
function seedLegacyData(dir, tag) {
  // симуляция старого каталога .data: файлы данных прямо в корне
  for (const item of DATASETS) {
    let value = item.shape === 'array'
      ? [{ id: item.key + '-' + tag, taskId: item.key + '-' + tag, at: '2026-01-01T00:00:00.000Z', value: tag }]
      : { items: { '1001': { dataset: item.key, value: tag } }, meta: { dataset: item.key, value: tag }, custom: tag };
    if (item.key === 'settings') {
      value.shopName = tag;
      value.nested = { shared: tag, incoming: true };
    }
    fs.writeFileSync(path.join(dir, item.file), JSON.stringify(value, null, 2), 'utf8');
  }
  // секреты в старом каталоге
  const store = createStore(dir, null);
  store.saveSecrets({ single: 'legacy-secret-' + tag });
}
function fakeSecretBox() {
  return { available: true, encrypt: (t) => Buffer.from(String(t), 'utf8').toString('base64'), decrypt: (b) => Buffer.from(String(b), 'base64').toString('utf8') };
}
function makeHub(dir, opts) {
  const events = [];
  const hub = createProfileHub(Object.assign({
    dataDir: dir, secretBox: fakeSecretBox(), appVersion: 'test',
    broadcast: (channel, payload) => events.push({ channel, payload }),
    createService: createService
  }, opts || {}));
  return { hub, events };
}

// ───────────────────────── проверки ─────────────────────────

/** 1. Миграция существующего .data в профиль по умолчанию без потерь. */
function tMigration() {
  const dir = tempDir('migrate');
  try {
    seedLegacyData(dir, 'legacy');
    const { hub } = makeHub(dir);

    const registryPath = path.join(dir, 'profiles.json');
    check('миграция: создан регистр профилей profiles.json', fs.existsSync(registryPath));
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    check('миграция: профиль по умолчанию «Основной» создан', reg.profiles.length === 1 && reg.profiles[0].id === 'default' && reg.profiles[0].name === 'Основной', JSON.stringify(reg.profiles));
    check('миграция: активный профиль — default', reg.activeId === 'default');

    const defaultDir = path.join(dir, 'profiles', 'default');
    const legacyFiles = DATASETS.map((d) => d.file);
    check('миграция: файлы данных перенесены в profiles/default/', legacyFiles.every((f) => fs.existsSync(path.join(defaultDir, f))), 'проверено ' + legacyFiles.length + ' файлов');
    check('миграция: старые файлы удалены из корня', legacyFiles.every((f) => !fs.existsSync(path.join(dir, f))));

    // данные читаются без потерь через хранилище профиля
    const store = hub.getActiveStore();
    const settings = store.loadSettings();
    check('миграция: настройки читаются (shopName сохранён)', settings.nested && settings.nested.shared === 'legacy', JSON.stringify(settings.nested));
    const costs = store.loadCosts();
    check('миграция: себестоимость читается', costs.items && costs.items['1001'] && costs.items['1001'].value === 'legacy', JSON.stringify(costs.items));
    const secrets = store.loadSecrets();
    check('миграция: секреты читаются', secrets.single === 'legacy-secret-legacy', secrets.single);

    // повторный запуск не мигрирует заново
    const { hub: hub2 } = makeHub(dir);
    check('миграция: повторный запуск не мигрирует заново', fs.existsSync(registryPath) && hub2.listProfiles().length === 1);
    check('миграция: данные не дублируются', store.loadCosts().items['1001'].value === 'legacy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 2. Два профиля не видят данные друг друга + секреты отдельно. */
async function tDataIsolation() {
  const dir = tempDir('isolation');
  try {
    const { hub } = makeHub(dir);
    // создаём второй профиль
    const created = await hub.handlers['profiles:create']({ name: 'Магазин-2' });
    check('изоляция: создан второй профиль', created.ok && created.profile.name === 'Магазин-2', JSON.stringify(created));

    // активный — default. Записываем данные в default
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    const defStore = hub.getActiveStore();
    defStore.saveCosts({ '1001': { costPriceRub: 500 } });
    defStore.saveSecrets({ single: 'key-default-1234567890' });

    // переключаемся на второй профиль — его данные пусты
    await hub.handlers['profiles:switch']({ profileId: created.profile.id });
    const otherStore = hub.getActiveStore();
    const otherCosts = otherStore.loadCosts();
    check('изоляция: второй профиль не видит себестоимость default', Object.keys(otherCosts.items || {}).length === 0, JSON.stringify(otherCosts.items));
    check('изоляция: второй профиль не видит ключи default', Object.keys(otherStore.loadSecrets()).length === 0, JSON.stringify(otherStore.loadSecrets()));

    // записываем свои данные во второй профиль
    otherStore.saveCosts({ '2002': { costPriceRub: 900 } });
    otherStore.saveSecrets({ single: 'key-other-9876543210' });

    // возвращаемся на default — его данные целы
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    const defCosts2 = hub.getActiveStore().loadCosts();
    check('изоляция: после переключения данные default сохранены', defCosts2.items['1001'] && defCosts2.items['1001'].costPriceRub === 500, JSON.stringify(defCosts2.items));
    const defSecrets2 = hub.getActiveStore().loadSecrets();
    check('изоляция: после переключения ключи default сохранены', defSecrets2.single === 'key-default-1234567890');

    // секреты каждого профиля — отдельный файл
    const defSecretsFile = path.join(dir, 'profiles', 'default', 'secrets.enc');
    const otherSecretsFile = path.join(dir, 'profiles', created.profile.id, 'secrets.enc');
    check('изоляция: секреты каждого профиля в отдельном файле', fs.existsSync(defSecretsFile) && fs.existsSync(otherSecretsFile) && defSecretsFile !== otherSecretsFile);

    // список профилей отражает активный
    const list = await hub.handlers['profiles:list']();
    const def = list.profiles.find((p) => p.id === 'default');
    const oth = list.profiles.find((p) => p.id === created.profile.id);
    check('изоляция: список профилей отражает активный', def.active === true && oth.active === false, JSON.stringify(list.profiles.map((p) => p.id + ':' + p.active)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 3. Лимиты WB считаются на кабинет — лимитеры независимы. */
async function tLimitsSeparate() {
  const dir = tempDir('limits');
  try {
    const { hub } = makeHub(dir);
    const p2 = await hub.handlers['profiles:create']({ name: 'Кабинет-2' });

    // ключи real, демо выключен
    for (const id of ['default', p2.profile.id]) {
      await hub.handlers['profiles:switch']({ profileId: id });
      hub.getActiveStore().saveSecrets({ single: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.fake-test-key' });
      hub.getActiveStore().saveSettings({ demoMode: false });
    }

    routes = Object.assign(baseRoutes(), {
      '/api/v1/supplier/sales': () => res(200, salesRows(3)),
      '/api/v1/supplier/orders': () => res(200, [])
    });

    // активный — default. Запрос статистики ставит лимитer в ожидание.
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    const clientA = hub.getActive().service.getClient();
    await clientA.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {});
    check('лимиты: первый запрос статистики в профиле А выполнен', callsTo('/supplier/sales').length === 1);

    // немедленный повтор в А — должен уйти в ожидание (лимит занят)
    let errA = null;
    try { await clientA.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {}); }
    catch (e) { errA = e; }
    check('лимиты: повтор в профиле А отложен (своя пауза)', !!errA && errA.code === 'RATE_WAIT', errA ? errA.code : 'нет ошибки');

    // переключаемся на профиль Б — его лимитер свеж, запрос проходит
    await hub.handlers['profiles:switch']({ profileId: p2.profile.id });
    const clientB = hub.getActive().service.getClient();
    let errB = null;
    const callsBefore = callsTo('/supplier/sales').length;
    try { await clientB.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {}); }
    catch (e) { errB = e; }
    check('лимиты: запрос статистики в профиле Б выполнен (лимитеры независимы)', !errB && callsTo('/supplier/sales').length === callsBefore + 1, errB ? errB.code : 'ok');
    check('лимиты: профиль Б не увидел паузу профиля А', !errB);

    // обнуляем лимитер Б и повторяем в Б — теперь Б ждёт свою паузу
    freeLimiter(clientB, 'statistics');
    await clientB.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {});
    let errB2 = null;
    try { await clientB.getStatRows('/api/v1/supplier/sales', '2026-11-01T00:00:00Z', {}); }
    catch (e) { errB2 = e; }
    check('лимиты: профиль Б имеет свою паузу после своего запроса', !!errB2 && errB2.code === 'RATE_WAIT', errB2 ? errB2.code : 'нет ошибки');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freeLimiter(client, category) {
  const l = client.limiters[category];
  if (!l) return;
  l.cooldownUntil = 0; l.last = 0; l.stamps = [];
}

/** 4. Переключение профиля не сбрасывает кэши чужого профиля. */
async function tCacheIsolation() {
  const dir = tempDir('cache');
  try {
    const { hub } = makeHub(dir);
    const p2 = await hub.handlers['profiles:create']({ name: 'Кабинет-2' });
    routes = baseRoutes();

    // ключ для загрузки товаров
    for (const id of ['default', p2.profile.id]) {
      await hub.handlers['profiles:switch']({ profileId: id });
      hub.getActiveStore().saveSecrets({ single: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.fake-test-key' });
      hub.getActiveStore().saveSettings({ demoMode: false });
    }

    // профиль А грузит товары — в кэше
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    const gA = await hub.handlers['wb:goods']({});
    check('кэш: профиль А загрузил товары', (gA.items || []).length === NM.length, 'товаров: ' + (gA.items || []).length);

    // переключаемся на Б — его кэш пуст (свой), не содержит кэш А
    await hub.handlers['profiles:switch']({ profileId: p2.profile.id });
    check('кэш: профиль Б начинает с пустого кэша (не видит кэш А)', hub.getActive().service.cache.goods === null, 'goods=' + hub.getActive().service.cache.goods);

    // Б грузит свои товары
    const gB2 = await hub.handlers['wb:goods']({ force: true });
    check('кэш: профиль Б загрузил свои товары', (gB2.items || []).length === NM.length);

    // возвращаемся на А — его кэш не сбросился
    const gA2 = await hub.handlers['wb:goods']({});
    check('кэш: возвращение к А не сбросило его кэш', (gA2.items || []).length === NM.length, 'товаров: ' + (gA2.items || []).length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 5. Экспорт/импорт профиля через формат J. */
async function tExportImport() {
  const dir = tempDir('export');
  try {
    const { hub } = makeHub(dir);
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    const defStore = hub.getActiveStore();
    defStore.saveCosts({ '1001': { costPriceRub: 500 } });
    defStore.saveSecrets({ single: 'export-secret-1234567890' });

    // экспорт активного профиля
    const exported = await hub.handlers['profiles:export']({});
    check('экспорт: возвращается файл формата J', exported.fileName.endsWith('.wbpm.json'), exported.fileName);
    const doc = JSON.parse(exported.content);
    check('экспорт: формат wb-price-manager-backup', doc.format === FORMAT, doc.format);
    check('экспорт: содержит наборы данных (costs)', !!doc.data.costs, JSON.stringify(Object.keys(doc.data)));

    // создаём новый профиль и импортируем в него
    const p2 = await hub.handlers['profiles:create']({ name: 'Импортер' });
    const preview = await hub.handlers['profiles:import']({ profileId: p2.profile.id, action: 'preview', content: exported.content });
    check('импорт: предпросмотр допустим', preview && Array.isArray(preview.datasets), JSON.stringify(preview && preview.totals));

    const applied = await hub.handlers['profiles:import']({
      profileId: p2.profile.id, action: 'apply', content: exported.content, overwriteExisting: true, overwriteConfirmed: true
    });
    check('импорт: применён без ошибок', applied.ok && applied.applied, JSON.stringify(applied));

    // данные перешли во второй профиль
    await hub.handlers['profiles:switch']({ profileId: p2.profile.id });
    const impCosts = hub.getActiveStore().loadCosts();
    check('импорт: себестоимость перенесена во второй профиль', impCosts.items['1001'] && impCosts.items['1001'].costPriceRub === 500, JSON.stringify(impCosts.items));

    // экспорт/импорт с ключами
    const withKeys = await hub.handlers['profiles:export']({ profileId: 'default', includeKeys: true, password: 'secret-pass-123' });
    check('экспорт: с ключами — блок зашифрованных секретов', JSON.parse(withKeys.content).encryptedSecrets !== undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 6. Сводный P&L по всем профилям с указанием кабинета. */
async function tPlSummary() {
  const dir = tempDir('pl');
  try {
    const { hub } = makeHub(dir);
    const p2 = await hub.handlers['profiles:create']({ name: 'Магазин-2' });

    function reportRows(nmId) {
      return [{
        rrdId: 1, reportId: 900001, nmId, vendorCode: 'ART-1', title: 'Товар', officeName: 'Коледино',
        docTypeName: 'Продажа', quantity: 1, rrDate: '2026-11-01', retailPrice: '1000', retailPriceWithDisc: '900',
        retailAmount: '900', commissionPercent: 20, commission: '180', ppvzSalesCommission: '180', ppvzForPay: '711',
        deliveryService: '60', storageFee: '5', paidAcceptance: '0', acquiringFee: '9', deduction: '0', penalty: '0', spp: 15
      }];
    }
    routes = Object.assign(baseRoutes(), {
      '/api/finance/v1/sales-reports/detailed': () => res(200, reportRows(1001)),
      '/api/finance/v1/sales-reports/list': () => res(200, { reports: [] })
    });

    for (const [id, nm] of [['default', 1001], [p2.profile.id, 2002]]) {
      await hub.handlers['profiles:switch']({ profileId: id });
      hub.getActiveStore().saveSecrets({ single: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.fake-test-key' });
      hub.getActiveStore().saveSettings({ demoMode: false });
      await hub.handlers['facts:load']({ days: 7 });
    }

    const summary = await hub.handlers['profiles:pl-summary']();
    check('P&L: сводка по всем профилям', summary.ok && summary.profiles.length === 2, JSON.stringify(summary.profiles.map((p) => p.profileName)));
    check('P&L: каждый профиль с указанием кабинета', summary.profiles.every((p) => p.profileName && p.profileId), JSON.stringify(summary.profiles.map((p) => p.profileName)));
    check('P&L: оба профиля с данными', summary.count === 2, 'count=' + summary.count);
    check('P&L: итог выручки равен сумме по профилям', summary.totals.revenue > 0, 'revenue=' + summary.totals.revenue);
    const sumRevenue = summary.profiles.reduce((s, p) => s + (p.totals ? p.totals.revenue : 0), 0);
    check('P&L: итог — сумма выручки профилей', Math.abs(summary.totals.revenue - sumRevenue) < 0.01, summary.totals.revenue + ' vs ' + sumRevenue);
    check('P&L: итоговая прибыль считана', summary.totals.profit > 0, 'profit=' + summary.totals.profit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 7. Web-сервер: профиль фиксирован при запуске, переключение запрещено. */
async function tWebServerFixed() {
  const dir = tempDir('web');
  try {
    const { hub } = makeHub(dir, { profileId: 'shop-a', switchable: false });
    check('веб: профиль фиксирован при запуске', hub.activeId() === 'shop-a', hub.activeId());
    let err = null;
    try { await hub.handlers['profiles:switch']({ profileId: 'default' }); }
    catch (e) { err = e; }
    check('веб: переключение профиля запрещено', !!err && /недоступно/.test(err.message), err ? err.message : 'нет ошибки');
    const data = await hub.handlers['profiles:list']();
    check('веб: список профилей с отметкой switchable', data.switchable === false, 'switchable=' + data.switchable);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async function main() {
  console.log('Прогон многопрофильности (несколько кабинетов WB в одном приложении)\n');
  try {
    tMigration();
    await tDataIsolation();
    await tLimitsSeparate();
    await tCacheIsolation();
    await tExportImport();
    await tPlSummary();
    tWebServerFixed();
    // даём асинковой проверке веб-профиля отработать
    await sleep(50);
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
  process.exit(fail ? 1 : 0);
})();
