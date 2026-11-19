'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createTelegramNotifier, formatEvent, quietState } = require('../../electron/notifications');
const { createService } = require('../../electron/service');

const BOT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn123456';
const WB_KEY = 'wb-api-key-for-notification-flow-test-1234567890';
const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const roots = [];
let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  try {
    assert.ok(condition, detail || name);
    pass++;
    console.log('OK   ' + name + (detail ? ' — ' + detail : ''));
  } catch (error) {
    fail++;
    failures.push(name + ' — ' + (error && error.message || error));
    console.log('FAIL ' + name + ' — ' + (error && error.message || error));
  }
}

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => text
  };
}

function localTime(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function fakeClock(start) {
  let current = new Date(start || new Date(2026, 0, 15, 12, 0, 0));
  let nextId = 0;
  const timers = new Map();
  const delays = [];
  return {
    now: () => new Date(current.getTime()),
    set(value) { current = new Date(value); },
    advance(ms) { current = new Date(current.getTime() + Number(ms)); },
    setTimeout(fn, ms) {
      const handle = { id: ++nextId };
      const delay = Math.max(0, Number(ms) || 0);
      delays.push(delay);
      timers.set(handle, { fn, delay });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    get delays() { return delays.slice(); },
    get pendingTimers() { return timers.size; }
  };
}

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-notify-' + label + '-'));
  roots.push(dir);
  return dir;
}

function safeStorageBox() {
  return {
    available: true,
    encrypt(text) { return 'safe:' + Buffer.from(String(text), 'utf8').toString('base64'); },
    decrypt(value) {
      if (!String(value).startsWith('safe:')) throw new Error('bad test ciphertext');
      return Buffer.from(String(value).slice(5), 'base64').toString('utf8');
    }
  };
}

function makeNotifier(label, options) {
  const o = options || {};
  const dir = tempDir(label);
  const store = createStore(dir, safeStorageBox());
  store.saveSecrets({ single: WB_KEY });
  const clock = o.clock || fakeClock();
  const events = Object.assign({ proposalReady: true, sendSuccess: true, sendError: true }, o.events || {});
  const notifier = createTelegramNotifier({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    batchDelayMs: o.batchDelayMs === undefined ? 5000 : o.batchDelayMs,
    minChatIntervalMs: o.minChatIntervalMs === undefined ? 0 : o.minChatIntervalMs,
    baseRetryDelayMs: o.baseRetryDelayMs === undefined ? 5 : o.baseRetryDelayMs,
    maxAttempts: o.maxAttempts === undefined ? 3 : o.maxAttempts
  });
  notifier.saveConfiguration({
    token: BOT_TOKEN,
    chatId: '-1001234567890',
    events,
    quietHours: o.quietHours || { enabled: false, start: '22:00', end: '08:00' }
  });
  return { dir, store, clock, notifier };
}

async function run() {
  try {
    const basics = makeNotifier('secret');
    const settingsText = fs.readFileSync(basics.store.paths.settingsPath, 'utf8');
    const secretsText = fs.readFileSync(basics.store.paths.secretsPath, 'utf8');
    const publicState = basics.notifier.getState();
    check('токен хранится через secrets/safeStorage и отсутствует в settings.json', basics.store.secretsMethod() === 'Шифрование ОС (Electron safeStorage)' && !settingsText.includes(BOT_TOKEN) && !JSON.stringify(basics.store.loadSettings()).includes(BOT_TOKEN) && !secretsText.includes(BOT_TOKEN));
    check('ответ notify:get не раскрывает токен и не теряет ключ WB', publicState.tokenSaved && publicState.configured && !JSON.stringify(publicState).includes(BOT_TOKEN) && basics.store.loadSecrets().single === WB_KEY);

    const keyClearStore = createStore(tempDir('key-clear'), safeStorageBox());
    keyClearStore.saveSettings({ demoMode: false });
    keyClearStore.saveSecrets({ single: WB_KEY, telegramBotToken: BOT_TOKEN });
    const keyClearService = createService(keyClearStore, () => {});
    const keyClearResult = await keyClearService.handlers['keys:clear']();
    check('очистка ключей WB сохраняет отдельный Telegram-токен', keyClearResult.ok && keyClearStore.loadSecrets().telegramBotToken === BOT_TOKEN && !keyClearStore.loadSecrets().single && keyClearService.isDemo());

    const testCalls = [];
    global.fetch = async (url, init) => {
      testCalls.push({ url: String(url), init: init || {} });
      if (String(url).endsWith('/getMe')) return jsonResponse(200, { ok: true, result: { id: 123, username: 'wbpm_test_bot' } });
      if (String(url).endsWith('/sendMessage')) return jsonResponse(200, { ok: true, result: { message_id: 42 } });
      return jsonResponse(404, { ok: false, description: 'unexpected test endpoint' });
    };
    const testResult = await basics.notifier.test();
    check('проверка выполняет getMe и реальный sendMessage', testResult.ok && testCalls.length === 2 && testCalls[0].url.endsWith('/getMe') && testCalls[1].url.endsWith('/sendMessage') && JSON.parse(testCalls[1].init.body).chat_id === '-1001234567890');

    let failedTestCalls = 0;
    global.fetch = async (url) => {
      failedTestCalls++;
      if (String(url).endsWith('/getMe')) return jsonResponse(200, { ok: true, result: { id: 123 } });
      return jsonResponse(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
    };
    const sendFail = await basics.notifier.test();
    check('ошибка sendMessage не выдаётся за успешную проверку', !sendFail.ok && sendFail.stage === 'sendMessage' && /не отправлено/.test(sendFail.message) && failedTestCalls === 2);

    let getMeCalls = 0;
    global.fetch = async () => { getMeCalls++; return jsonResponse(401, { ok: false, description: 'Unauthorized' }); };
    const getMeFail = await basics.notifier.test();
    check('неуспешный getMe останавливает проверку до тестовой отправки', !getMeFail.ok && getMeFail.stage === 'getMe' && getMeCalls === 1);

    const proposalText = formatEvent('proposalReady', { summary: { toSend: 7, profitDeltaMonth: 12500 } });
    check('сообщение репрайсера содержит число позиций и Δ прибыли за месяц', proposalText.includes('7 позиций') && proposalText.includes('Δ прибыли за месяц +') && /12.?500/.test(proposalText));
    const rateText = formatEvent('rateLimit', { title: 'Статистика', retryAt: '2026-02-03T09:10:00.000Z', reason: 'HTTP 429' });
    check('ISO-время повтора фонового раздела читается без Invalid Date', rateText.includes('Статистика') && rateText.includes('повтор') && !rateText.includes('Invalid Date'));
    const eventCases = [
      ['sendSuccess', { count: 3 }], ['sendError', { failed: 1, message: 'ошибка WB' }],
      ['quarantine', { count: 1, warnings: [{ nmID: 123 }] }], ['rateLimit', { title: 'Аналитика' }],
      ['promoStarted', { id: 10, name: 'Весна' }], ['promoEnded', { id: 10, name: 'Весна' }],
      ['competitorPrice', { sku: 456, oldPrice: 100, newPrice: 120 }], ['lowStock', { nmID: 123, stock: 2, daysLeft: 1, thresholdDays: 14 }]
    ];
    check('все типы событий форматируются в непустое русское сообщение', eventCases.every(([type, payload]) => formatEvent(type, payload).length > 0));

    const batch = makeNotifier('batch', { events: { rateLimit: true } });
    const sentBodies = [];
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/sendMessage')) {
        sentBodies.push(JSON.parse(init.body));
        return jsonResponse(200, { ok: true, result: { message_id: sentBodies.length } });
      }
      return jsonResponse(200, { ok: true, result: { id: 1 } });
    };
    batch.notifier.handleServiceEvent('repricer', { type: 'proposal', summary: { toSend: 4, profitDeltaMonth: 3200 } });
    batch.notifier.enqueue('sendSuccess', { count: 2, source: 'ручная отправка' });
    batch.notifier.enqueue('sendError', { failed: 1, message: 'WB отклонил одну позицию' });
    batch.notifier.handleServiceEvent('deferred', { type: 'rescheduled', name: 'stats', title: 'Статистика', retryAt: '2026-02-03T09:10:00.000Z', message: 'HTTP 429' });
    await batch.notifier.flushNow();
    check('события склеиваются в одно сообщение, включая репрайсер и отложенный раздел', sentBodies.length === 1 && sentBodies[0].text.includes('4 позиции') && sentBodies[0].text.includes('Отправка цен выполнена: 2 позиции') && sentBodies[0].text.includes('Ошибка отправки цен (1 позиция): WB отклонил одну позицию') && sentBodies[0].text.includes('Лимит WB: Статистика') && sentBodies[0].text.includes('повтор') && !sentBodies[0].text.includes('Invalid Date'));

    const competitor = makeNotifier('competitor', { events: { competitorPrice: true }, batchDelayMs: 0 });
    competitor.store.saveCompetitors({ '555': [{ id: '900', sku: 900, name: 'Соперник', enabled: true, price: 100, stock: 4 }] });
    const competitorService = createService(competitor.store, () => {}, null, { telegramNotifier: competitor.notifier });
    let competitorMessage = '';
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/sendMessage')) {
        competitorMessage = JSON.parse(init.body).text;
        return jsonResponse(200, { ok: true, result: { message_id: 1 } });
      }
      return jsonResponse(200, { ok: true, result: { id: 1 } });
    };
    const competitorResult = competitorService.priceWatcher.recordManual({ nmID: 555, competitorSKU: 900, competitorPrice: 120 });
    await competitor.notifier.flushNow();
    check('изменение цены конкурента из pricewatch:* попадает в Telegram-очередь', competitorResult.ok && competitorMessage.includes('Цена конкурента 900 изменилась: 100 → 120 ₽'));

    const promoNotice = makeNotifier('promo-lifecycle', { events: { promoStarted: true, promoEnded: true }, batchDelayMs: 0 });
    promoNotice.store.saveSettings({ demoMode: false, promosInferFromDiscount: false });
    const promoService = createService(promoNotice.store, () => {}, null, { telegramNotifier: promoNotice.notifier });
    const originalDateNow = Date.now;
    const promoStart = originalDateNow() + 10000;
    const promoEnd = promoStart + 10000;
    let promoNow = originalDateNow();
    const promoRows = [{ id: 77, name: 'Весна', startDateTime: new Date(promoStart).toISOString(), endDateTime: new Date(promoEnd).toISOString() }];
    promoService.handlers['wb:promos'] = async () => promoRows;
    const promoMessages = [];
    global.fetch = async (_url, init) => {
      promoMessages.push(JSON.parse(init.body).text);
      return jsonResponse(200, { ok: true, result: { message_id: promoMessages.length } });
    };
    let noFalseEndOnNetworkError = false;
    try {
      Date.now = () => promoNow;
      await promoService.handlers['promos:index']({ force: true });
      promoNow = promoStart + 1;
      await promoService.handlers['promos:index']({ force: true });
      await promoNotice.notifier.flushNow();
      promoNow = promoEnd + 1;
      promoService.handlers['wb:promos'] = async () => { throw new Error('temporary calendar failure'); };
      await promoService.handlers['promos:index']({ force: true });
      await promoNotice.notifier.flushNow();
      noFalseEndOnNetworkError = promoMessages.length === 1;
      promoService.handlers['wb:promos'] = async () => promoRows;
      await promoService.handlers['promos:index']({ force: true });
      await promoNotice.notifier.flushNow();
    } finally { Date.now = originalDateNow; }
    check('переходы акции отправляются, а сбой календаря не имитирует окончание', noFalseEndOnNetworkError && promoMessages.length === 2 && promoMessages[0].includes('Акция началась: Весна') && promoMessages[1].includes('Акция закончилась: Весна'));

    const lowStock = makeNotifier('low-stock', { events: { lowStock: true }, batchDelayMs: 0 });
    lowStock.store.saveSettings({ demoMode: false, stocksLowDays: 14 });
    const lowStockService = createService(lowStock.store, () => {}, null, { telegramNotifier: lowStock.notifier });
    lowStockService.cache.stats = [{ nmID: 555, salesQty: 300 }];
    let stockMessage = '';
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/sendMessage')) {
        stockMessage = JSON.parse(init.body).text;
        return jsonResponse(200, { ok: true, result: { message_id: 1 } });
      }
      return jsonResponse(200, { total: 1, data: { rows: [{ nmID: 555, stock: 2, warehouseName: 'Казань' }] } });
    };
    const stockResult = await lowStockService.handlers['stocks:load']({ force: true });
    await lowStock.notifier.flushNow();
    check('низкий остаток определяется после загрузки остатков и отправляется', stockResult.ok && stockMessage.includes('Низкий остаток: nmID 555'));

    const rateClock = fakeClock(new Date(2026, 0, 15, 12, 0, 0));
    const rateLimited = makeNotifier('chat-rate', { clock: rateClock, batchDelayMs: 0, minChatIntervalMs: 3100 });
    let rateSendCount = 0;
    global.fetch = async (_url, init) => {
      if (init && init.method === 'POST') rateSendCount++;
      return jsonResponse(200, { ok: true, result: { message_id: rateSendCount } });
    };
    rateLimited.notifier.enqueue('sendSuccess', { count: 1 });
    await rateLimited.notifier.flushNow();
    rateLimited.notifier.enqueue('sendSuccess', { count: 1 });
    const held = await rateLimited.notifier.flushNow();
    const hasRateDelay = rateClock.delays.includes(3100);
    rateClock.advance(3100);
    await rateLimited.notifier.flushNow();
    check('ограничение чата держит интервал около 20 сообщений в минуту', rateSendCount === 2 && held.queue.pending === 1 && hasRateDelay);

    const retryClock = fakeClock(new Date(2026, 0, 15, 12, 0, 0));
    const retrying = makeNotifier('retries', { clock: retryClock, batchDelayMs: 99999, minChatIntervalMs: 0, baseRetryDelayMs: 5, maxAttempts: 3 });
    let retrySendCount = 0;
    global.fetch = async (url) => {
      if (String(url).endsWith('/sendMessage')) {
        retrySendCount++;
        return jsonResponse(500, { ok: false, description: 'temporary Telegram failure' });
      }
      return jsonResponse(200, { ok: true, result: { id: 1 } });
    };
    retrying.notifier.enqueue('sendSuccess', { count: 1 });
    await retrying.notifier.flushNow();
    await retrying.notifier.flushNow();
    await retrying.notifier.flushNow();
    const retryState = retrying.notifier.getState().queue;
    check('ретраи ограничены тремя попытками с экспоненциальными паузами', retrySendCount === 3 && retryState.pending === 0 && retryState.dropped === 1 && retryClock.delays.includes(5) && retryClock.delays.includes(10));

    const night = new Date(2026, 0, 15, 23, 20, 0);
    const nightClock = fakeClock(night);
    const quiet = makeNotifier('quiet-hours', {
      clock: nightClock,
      batchDelayMs: 0,
      minChatIntervalMs: 0,
      quietHours: { enabled: true, start: localTime(night), end: '08:00' }
    });
    let quietSendBodies = [];
    global.fetch = async (_url, init) => {
      quietSendBodies.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, result: { message_id: quietSendBodies.length } });
    };
    const quietNow = quiet.notifier.getState().quietNow;
    const directQuiet = quietState(night, { enabled: true, start: localTime(night), end: '08:00' }).quiet;
    quiet.notifier.enqueue('sendSuccess', { count: 1 });
    const nightState = await quiet.notifier.flushNow();
    const noNightSend = quietSendBodies.length === 0 && nightState.queue.pending === 1;
    const morning = new Date(nightClock.now());
    morning.setDate(morning.getDate() + 1);
    morning.setHours(8, 1, 0, 0);
    nightClock.set(morning);
    await quiet.notifier.flushNow();
    check('тихие часы копят очередь и утром отправляют сводку', quietNow && directQuiet && noNightSend && quietSendBodies.length === 1 && quietSendBodies[0].text.includes('Сводка уведомлений'));

    const unsafe = makeNotifier('sanitize');
    const capturedLogs = [];
    const oldConsoleLog = console.log;
    const oldConsoleError = console.error;
    console.log = (...args) => capturedLogs.push(args.join(' '));
    console.error = (...args) => capturedLogs.push(args.join(' '));
    let sanitizedTest;
    let errorState;
    try {
      global.fetch = async (url) => { throw new Error('network request failed: ' + String(url)); };
      sanitizedTest = await unsafe.notifier.test();
      unsafe.notifier.enqueue('sendSuccess', { count: 1 });
      await unsafe.notifier.flushNow();
      errorState = unsafe.notifier.getState();
    } finally { console.log = oldConsoleLog; console.error = oldConsoleError; }
    check('токен скрывается из сетевых ошибок, состояния, логов и settings.json', !sanitizedTest.ok && !sanitizedTest.message.includes(BOT_TOKEN) && !errorState.queue.lastError.includes(BOT_TOKEN) && !JSON.stringify(errorState).includes(BOT_TOKEN) && !capturedLogs.join('\n').includes(BOT_TOKEN) && !fs.readFileSync(unsafe.store.paths.settingsPath, 'utf8').includes(BOT_TOKEN));

    const serviceDir = tempDir('price-send-isolation');
    const serviceStore = createStore(serviceDir, safeStorageBox());
    serviceStore.saveSettings({ demoMode: false });
    serviceStore.saveSecrets({ single: WB_KEY });
    const emitted = [];
    let brokenTelegramCalls = 0;
    const brokenTelegram = { handleServiceEvent() { brokenTelegramCalls++; throw new Error('Telegram недоступен'); } };
    const service = createService(serviceStore, (channel, payload) => emitted.push({ channel, payload }), null, { telegramNotifier: brokenTelegram });
    serviceStore.saveCosts({ 555: { costPriceRub: 100 } }); serviceStore.saveItemConfigs({ 555: { minPrice: 300 } });
    const mockPrices = (goods, posted) => async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v2/list/goods/filter') return jsonResponse(200, { data: { listGoods: Number(u.searchParams.get('offset')) ? [] : goods, total: goods.length } });
      if (u.pathname === '/api/v2/upload/task') { posted.push(...JSON.parse(init.body).data); return jsonResponse(200, { data: { id: 777 } }); }
      if (u.pathname === '/api/v2/history/goods/task') return jsonResponse(200, { data: { uploadID: 777, historyGoods: posted.map((r) => ({ ...r, status: 2 })) } });
      if (u.pathname === '/content/v2/get/cards/list') return jsonResponse(200, { cards: [], cursor: { total: 0 } });
      if (/\/supplier\//.test(u.pathname)) return jsonResponse(200, []);
      throw new Error('Неожиданный запрос теста: ' + u.pathname);
    };
    const pricePosts = [];
    global.fetch = mockPrices([{ nmID: 555, price: 900, discount: 0 }], pricePosts);
    global.setTimeout = function (fn, ms, ...args) {
      // Сокращаем только паузу WB-проверки статусов загрузки; сетевые тайм-ауты сохраняем.
      return originalSetTimeout(fn, Number(ms) === 1500 ? 0 : ms, ...args);
    };
    let priceResult;
    try { priceResult = await service.handlers['wb:apply-prices']({ items: [{ nmID: 555, price: 920, discount: 0 }], source: 'notify-flow-test' }); }
    finally { global.setTimeout = originalSetTimeout; }
    check('ошибка интеграции Telegram не прерывает отправку цен и обработку результата WB', priceResult && priceResult.uploaded === 1 && brokenTelegramCalls >= 2 && emitted.some((event) => event.payload && event.payload.type === 'sendSuccess'));

    const quarantineNotice = makeNotifier('quarantine-event', { events: { quarantine: true, sendSuccess: true }, batchDelayMs: 5000 });
    quarantineNotice.store.saveSettings({ demoMode: false });
    const quarantineService = createService(quarantineNotice.store, () => {}, null, { telegramNotifier: quarantineNotice.notifier });
    quarantineNotice.store.saveCosts({ 556: { costPriceRub: 10 }, 557: { costPriceRub: 100 } });
    quarantineNotice.store.saveItemConfigs({ 556: { minPrice: 50 }, 557: { minPrice: 300 } });
    let quarantineMessage = ''; const quarantinePosts = [];
    const quarantineWb = mockPrices([{ nmID: 556, price: 900, discount: 0 }, { nmID: 557, price: 900, discount: 0 }], quarantinePosts);
    global.fetch = async (url, init) => {
      if (String(url).includes('api.telegram.org')) {
        quarantineMessage = JSON.parse(init.body).text;
        return jsonResponse(200, { ok: true, result: { message_id: 1 } });
      }
      return quarantineWb(url, init);
    };
    global.setTimeout = function (fn, ms, ...args) { return originalSetTimeout(fn, Number(ms) === 1500 ? 0 : ms, ...args); };
    let quarantineResult;
    try { quarantineResult = await quarantineService.handlers['wb:apply-prices']({ items: [{ nmID: 556, price: 100, discount: 0 }, { nmID: 557, price: 920, discount: 0 }] }); }
    finally { global.setTimeout = originalSetTimeout; }
    await quarantineNotice.notifier.flushNow();
    check('блокировка карантина не мешает соседу; предупреждение и подтверждённый успех доходят до Telegram', quarantineResult && quarantineResult.uploaded === 1 && quarantinePosts.length === 1 && quarantinePosts[0].nmID === 557 && quarantineMessage.includes('Карантин цены: 1 позиция') && quarantineMessage.includes('Отправка цен выполнена: 1 позиция'));
  } catch (error) {
    fail++;
    failures.push('непредвиденное исключение — ' + (error && error.stack || error));
    console.error('FAIL непредвиденное исключение:', error && error.stack || error);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log(`\nИТОГО: ${pass} пройдено, ${fail} ошибок`);
  if (failures.length) console.log(failures.join('\n'));
  if (fail) process.exitCode = 1;
}

run();
