'use strict';

/** Дополнительная приёмка L: сбои миграции, реальный IPC/HTTP, жизненный цикл и renderer. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { createProfileHub } = require('../../electron/profiles');
const { createService } = require('../../electron/service');
const { createTelegramNotifier } = require('../../electron/notifications');
const { createStore } = require('../../electron/store');
const { DATASETS, MAX_BACKUP_BYTES } = require('../../electron/backup');
const { createWebServer, parseArgs } = require('../web-server');
const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function runSafety(check) {
  const dirs = [], hubs = [];
  const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-L-safe-')); dirs.push(dir); return dir; };
  const make = (dir, options) => {
    const hub = createProfileHub({ dataDir: dir, createService, createTelegramNotifier, appVersion: 'L-test', ...options });
    hubs.push(hub); return hub;
  };
  const throws = async (label, fn, code) => {
    let error;
    try { await fn(); } catch (e) { error = e; }
    check(label, !!error && (!code || error.code === code), error ? error.code || error.message : 'нет ошибки');
  };
  const facts = (store, from = '2026-11-01', to = '2026-11-07') => {
    store.saveSettings({ demoMode: false });
    store.saveSecrets({ single: 'fake-local-WB-key-no-network' });
    store.saveCosts({ '1001': { costPriceRub: 100 } });
    store.saveFactCosts({ '1001': { salesQty: 2, revenueTotal: 1000, commissionTotal: 200, forPayTotal: 790, logisticsTotal: 50, acquiringTotal: 10 } },
      { dateFrom: from, dateTo: to, period: 'daily', rowsProcessed: 2 });
  };
  const baselineFetch = global.fetch;
  try {
    // Миграция останавливается на ошибке переноса backups и возобновляется побайтно.
    const dir = temp(), legacy = createStore(dir, null);
    legacy.saveSettings({ demoMode: true, shopName: 'До профилей' });
    legacy.saveSecrets({ single: 'fake-legacy-WB', telegramBotToken: 'fake-legacy-telegram' });
    for (const d of DATASETS) if (!fs.existsSync(path.join(dir, d.file))) fs.writeFileSync(path.join(dir, d.file), JSON.stringify(d.shape === 'array' ? [] : {}));
    fs.mkdirSync(path.join(dir, 'backups')); fs.writeFileSync(path.join(dir, 'backups', 'copy.json'), '{"исходный":"бэкап"}');
    fs.writeFileSync(path.join(dir, 'web-sessions.json'), '{"global":true}');
    const original = new Map(DATASETS.map((d) => d.file).concat(['secrets.enc']).map((file) => [file, fs.readFileSync(path.join(dir, file))]));
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (from === path.join(dir, 'backups')) throw Object.assign(new Error('Тест: каталог занят'), { code: 'EBUSY' }); return rename(from, to); };
    try { await throws('L: ошибка переноса backups не маскируется', () => make(dir), 'EBUSY'); }
    finally { fs.renameSync = rename; }
    check('L: до завершения переноса регистр не опубликован', !fs.existsSync(path.join(dir, 'profiles.json')));
    check('L: для возобновления записан журнал миграции', fs.existsSync(path.join(dir, '.profiles-migration.json')));
    const resumed = make(dir);
    check('L: миграция после сбоя сохраняет все файлы побайтно', [...original].every(([file, bytes]) => fs.readFileSync(path.join(resumed.getActive().dir, file)).equals(bytes)));
    check('L: каталог резервных копий перенесён целиком', fs.readFileSync(path.join(resumed.getActive().dir, 'backups', 'copy.json'), 'utf8') === '{"исходный":"бэкап"}' && !fs.existsSync(path.join(dir, 'backups')));
    check('L: глобальная веб-сессия не уехала в профиль', fs.readFileSync(path.join(dir, 'web-sessions.json'), 'utf8') === '{"global":true}' && !fs.existsSync(path.join(resumed.getActive().dir, 'web-sessions.json')));
    check('L: завершённый журнал миграции удалён', !fs.existsSync(path.join(dir, '.profiles-migration.json')));

    // Прерванная транзакция J откатывается до перемещения файлов в новый каталог.
    const txDir = temp();
    const tx = path.join(txDir, '.wbpm-transactions', 'tx-interrupted'); fs.mkdirSync(path.join(tx, 'old'), { recursive: true });
    const before = '{"items":{"1001":{"costPriceRub":123}}}';
    fs.writeFileSync(path.join(txDir, 'costs.json'), '{"items":{"1001":{"costPriceRub":999}}}');
    fs.writeFileSync(path.join(tx, 'old', 'costs.json'), before);
    fs.writeFileSync(path.join(tx, 'journal.json'), JSON.stringify({ state: 'applying', targets: [{ file: 'costs.json', hadBefore: true }] }));
    const recovered = make(txDir);
    check('L: незавершённый импорт J откатился до миграции', fs.readFileSync(path.join(recovered.getActive().dir, 'costs.json'), 'utf8') === before);
    check('L: старые транзакции J не потеряны при переносе', !fs.existsSync(path.join(txDir, '.wbpm-transactions')));

    const invalid = [
      '{broken', '', JSON.stringify({ version: 9, profiles: [] }),
      JSON.stringify({ version: 1, activeId: '../outside', profiles: [{ id: '../outside', name: 'Не выходить' }] }),
      JSON.stringify({ version: 1, activeId: 'default', profiles: [{ id: 'default', name: 'A' }, { id: 'default', name: 'B' }] }),
      JSON.stringify({ version: 1, activeId: 'absent', profiles: [{ id: 'default', name: 'A' }] }),
      JSON.stringify({ version: 1, activeId: 'CON', profiles: [{ id: 'CON', name: 'Зарезервировано' }] })
    ];
    for (let i = 0; i < invalid.length; i++) {
      const bad = temp(); fs.writeFileSync(path.join(bad, 'profiles.json'), invalid[i]); fs.writeFileSync(path.join(bad, 'settings.json'), '{"sentinel":true}');
      await throws('L: некорректный регистр отклонён без повторной миграции #' + (i + 1), () => make(bad));
      check('L: данные при некорректном регистре не тронуты #' + (i + 1), fs.readFileSync(path.join(bad, 'settings.json'), 'utf8') === '{"sentinel":true}' && fs.readFileSync(path.join(bad, 'profiles.json'), 'utf8') === invalid[i]);
    }
    const conflict = temp(); fs.mkdirSync(path.join(conflict, 'profiles', 'default'), { recursive: true });
    fs.writeFileSync(path.join(conflict, '.profiles-migration.json'), JSON.stringify({ version: 1, files: ['costs.json'] }));
    fs.writeFileSync(path.join(conflict, 'costs.json'), '{"local":1}'); fs.writeFileSync(path.join(conflict, 'profiles', 'default', 'costs.json'), '{"moved":2}');
    await throws('L: конфликт частичной миграции запрещает перезапись', () => make(conflict), 'PROFILE_MIGRATION_CONFLICT');
    check('L: обе конфликтующие копии сохранены', fs.readFileSync(path.join(conflict, 'costs.json'), 'utf8') === '{"local":1}' && fs.readFileSync(path.join(conflict, 'profiles', 'default', 'costs.json'), 'utf8') === '{"moved":2}');
    await throws('L: ошибочный --profile не подменяется default', () => make(temp(), { profileId: '../../outside' }), 'PROFILE_ID');

    // Ссылки, полученные при запуске main, должны выбирать кабинет при ВЫЗОВЕ.
    const events = [], emitters = new Map();
    const hub = make(temp(), { broadcast: (channel, payload) => events.push({ channel, payload }), createService: (store, emit, electron, hooks) => {
      emitters.set(path.basename(store.dir), emit); return createService(store, emit, electron, hooks);
    } });
    const savedHandlers = Object.fromEntries(Object.entries(hub.handlers));
    const ipc = new Map(), source = read('electron/main.js');
    vm.runInNewContext(source.slice(source.indexOf('function registerIpc()'), source.indexOf('\napp.setName')) + '\nregisterIpc();', {
      service: hub, ipcMain: { handle: (c, fn) => ipc.set(c, fn) }, dialog: {}, shell: {}, win: null, fs, path, crypto, Buffer, MAX_BACKUP_BYTES
    });
    hub.getActiveStore().saveCosts({ '1001': { costPriceRub: 111 } });
    const other = await hub.handlers['profiles:create']({ name: 'Кабинет Б' });
    const bid = other.profile.id;
    hub.getProfile(bid).store.saveCosts({ '1001': { costPriceRub: 222 } });
    check('L: реальный IPC сначала читает кабинет A', (await ipc.get('costs:get')(null)).data.items['1001'].costPriceRub === 111);
    await ipc.get('profiles:switch')(null, { profileId: bid });
    check('L: прежняя ссылка Object.entries читает B после переключения', (await savedHandlers['costs:get']()).items['1001'].costPriceRub === 222);
    check('L: реальный IPC читает B после переключения', (await ipc.get('costs:get')(null)).data.items['1001'].costPriceRub === 222);
    await ipc.get('costs:save')(null, { items: { '1001': { costPriceRub: 333 } } });
    check('L: IPC пишет только в активный B, A не меняется', hub.getProfile(bid).store.loadCosts().items['1001'].costPriceRub === 333 && hub.getProfile('default').store.loadCosts().items['1001'].costPriceRub === 111);
    await throws('L: контекст старой карточки не пишет в новый кабинет', () => hub.handlers['profiles:invoke']({ profileId: 'default', channel: 'costs:clear', args: [] }), 'PROFILE_CHANGED');
    check('L: профильный контекст маршрутизирует правильный кабинет', (await hub.handlers['profiles:invoke']({ profileId: bid, channel: 'costs:get', args: [] })).items['1001'].costPriceRub === 333);
    await throws('L: вложенный profiles:* через контекст запрещён', () => hub.handlers['profiles:invoke']({ profileId: bid, channel: 'profiles:invoke', args: [] }), 'UNKNOWN_CHANNEL');
    const a = hub.getProfile('default'), b = hub.getProfile(bid);
    check('L: WBClient, кэши и лимитеры принадлежат разным кабинетам', a.service.getClient() !== b.service.getClient() && a.service.cache !== b.service.cache && a.service.getClient().limiters !== b.service.getClient().limiters);
    emitters.get('default')('deferred', { type: 'done', name: 'stats' });
    check('L: фоновое событие неактивного A не рассылается в UI B', !events.some((e) => e.channel === 'deferred'));
    emitters.get(bid)('deferred', { type: 'done', name: 'stats' });
    check('L: событие активного B помечено его id и именем', events.some((e) => e.channel === 'deferred' && e.payload.profileId === bid && e.payload.profileName === 'Кабинет Б'));

    const exported = await hub.exportProfile({ profileId: 'default' });
    b.service.cache.goods = { items: [{ nmID: 1001, price: 10 }] };
    const clientBefore = b.service.getClient();
    await hub.importProfile({ profileId: bid, action: 'apply', content: exported.content, overwriteExisting: true, overwriteConfirmed: true });
    check('L: profiles:import инвалидирует кэш сервиса назначения', b.service.cache.goods === null);
    check('L: profiles:import пересоздаёт WBClient назначения', b.service.getClient() !== clientBefore);
    check('L: profiles:import не трогает данные другого кабинета', a.store.loadCosts().items['1001'].costPriceRub === 111);

    // Защитные свойства J сохраняются и при импорте через profiles:*.
    a.store.saveSecrets({ single: 'fake-WB-A', telegramBotToken: 'telegram-A-do-not-copy' });
    b.store.saveSecrets({ single: 'fake-WB-B', telegramBotToken: 'telegram-B-keep' });
    a.store.saveSettings({ shopName: 'Входящие настройки' });
    a.store.saveCosts({ '1001': { costPriceRub: 555 } });
    b.store.saveSettings({ shopName: 'Локальные настройки' });
    const encrypted = await hub.exportProfile({ profileId: 'default', includeKeys: true, password: 'Test-profile-password' });
    check('L: профильный экспорт с ключами не раскрывает Telegram', !encrypted.content.includes('telegram-A-do-not-copy') && !encrypted.content.includes('fake-WB-A'));
    const oldSettings = JSON.stringify(b.store.loadSettings()), oldCosts = JSON.stringify(b.store.loadCosts());
    await throws('L: неверный пароль профиля запрещает весь импорт', () => hub.importProfile({ profileId: bid, content: encrypted.content, action: 'apply', applyKeys: true, password: 'Wrong-password', overwriteExisting: true, overwriteConfirmed: true }));
    check('L: ошибка пароля не меняет локальные настройки и ключи', JSON.stringify(b.store.loadSettings()) === oldSettings && b.store.loadSecrets().single === 'fake-WB-B');
    let failedWrite = false;
    fs.renameSync = (from, to) => {
      if (!failedWrite && to === path.join(b.dir, 'costs.json')) { failedWrite = true; throw new Error('Тестовая ошибка записи costs'); }
      return rename(from, to);
    };
    try { await throws('L: сбой посередине профильного импорта отклоняется', () => hub.importProfile({ profileId: bid, content: encrypted.content, action: 'apply', overwriteExisting: true, overwriteConfirmed: true }), 'IMPORT_WRITE_FAILED'); }
    finally { fs.renameSync = rename; }
    check('L: профильный импорт откатил все затронутые наборы', failedWrite && JSON.stringify(b.store.loadSettings()) === oldSettings && JSON.stringify(b.store.loadCosts()) === oldCosts);
    await hub.importProfile({ profileId: bid, content: encrypted.content, action: 'apply', applyKeys: true, password: 'Test-profile-password', overwriteExisting: true, overwriteConfirmed: true });
    check('L: профильный импорт WB-ключей сохраняет собственный Telegram-токен B', b.store.loadSecrets().single === 'fake-WB-A' && b.store.loadSecrets().telegramBotToken === 'telegram-B-keep');

    facts(a.store); facts(b.store);
    let network = 0;
    global.fetch = async () => { network++; throw new Error('Сводке запрещена сеть'); };
    const summary = await hub.plSummary();
    check('L: сводный P&L действительно не ходит в сеть даже с пустым кэшем', network === 0);
    check('L: сводный P&L суммирует сопоставимые периоды', summary.canAggregate && summary.totals.revenue === 2000);
    facts(b.store, '2026-10-01', '2026-10-07');
    const mixed = await hub.plSummary();
    check('L: разные периоды не суммируются молча', mixed.periodsDiffer && !mixed.canAggregate && mixed.totals === null && mixed.profiles.length === 2);
    facts(b.store); b.store.saveSettings({ demoMode: true });
    const demoMix = await hub.plSummary();
    check('L: демо и реальные финансы не складываются', demoMix.mixedModes && !demoMix.canAggregate && demoMix.totals === null);
    global.fetch = baselineFetch;

    // Не удаляем кабинет, у которого ещё вернётся асинхронная запись.
    let release;
    b.service.handlers['costs:get'] = () => new Promise((resolve) => { release = () => resolve({ items: {} }); });
    const running = hub.handlers['costs:get']();
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    await throws('L: удаление кабинета с выполняющимся запросом запрещено', () => hub.removeProfile(bid), 'PROFILE_BUSY');
    await throws('L: импорт также ждёт окончания активной операции', () => hub.importProfile({ profileId: bid, content: exported.content, action: 'apply' }), 'PROFILE_BUSY');
    release(); await running;
    b.store.saveRepricer({ enabled: true }); b.service.applyScheduler();
    await b.service.handlers['notify:save']({ token: '123456789:abcdefghijklmnopqrstuvwxyz12345', chatId: '100', events: { proposalReady: true } });
    b.telegramNotifier.enqueue('proposalReady', { count: 1 });
    check('L: перед удалением у B есть таймер репрайсера и очередь Telegram', !!b.service.sched.timer && b.telegramNotifier.getState().queue.pending === 1);
    hub.removeProfile(bid);
    check('L: удаление останавливает репрайсер, Telegram и убирает каталог B', b.service.sched.timer === null && b.telegramNotifier.getState().queue.pending === 0 && !fs.existsSync(b.dir));
    await throws('L: старый сервис удалённого профиля больше не выполняет команды', () => b.service.handlers['settings:save']({ shopName: 'Не оживать' }), 'PROFILE_CLOSED');
    check('L: удалённый каталог не воссоздан старым обработчиком', !fs.existsSync(b.dir));
    a.store.saveRepricer({ enabled: true }); hub.startAllSchedulers();
    hub.stopAllSchedulers();
    check('L: закрытие хаба гасит реальный таймер активного сервиса', a.service.sched.timer === null);
    await throws('L: закрытый хаб не принимает новые вызовы', () => hub.handlers['costs:get'](), 'PROFILE_CLOSED');

    await deferredLifecycle();
    await httpIsolation();
    await rendererIsolation();
  } finally {
    global.fetch = baselineFetch;
    for (const h of hubs) h.stopAllSchedulers();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }

  async function deferredLifecycle() {
    const hub = make(temp()), bid = (await hub.handlers['profiles:create']({ name: 'Отложенный Б' })).profile.id;
    await hub.handlers['profiles:switch']({ profileId: bid });
    const p = hub.getActive();
    p.store.saveSettings({ demoMode: false, statsLoadOrders: false });
    p.store.saveSecrets({ single: 'fake-key-for-deferred' });
    const client = p.service.getClient();
    let calls = 0;
    client.getSalesAggregated = async (_from, opts) => {
      calls++;
      opts.onError({ message: 'Тестовый лимит', code: 'RATE_WAIT', retryAt: Date.now() + 300 }, 'sales');
      return [];
    };
    client.getStocksReport = async () => ({ rows: [], aggregated: {}, source: 'test' });
    p.service.handlers['wb:goods'] = async () => ({ items: [] });
    p.service.handlers['wb:promos'] = async () => [];
    p.service.handlers['wb:cards'] = async () => [];
    await hub.handlers['data:refresh-all']({ facts: false });
    const scheduled = await hub.handlers['data:deferred']();
    check('L: для проверки жизненного цикла создана настоящая догрузка', scheduled.items.some((r) => r.name === 'stats' && r.state === 'scheduled'));
    p.service.stopScheduler();
    const canceled = await hub.handlers['data:deferred']();
    check('L: stopScheduler отменяет и отложенные задачи WB', canceled.items.some((r) => r.name === 'stats' && r.state === 'canceled'));
    await hub.handlers['data:refresh-all']({ facts: false });
    await hub.handlers['profiles:switch']({ profileId: 'default' });
    hub.removeProfile(bid);
    await sleep(650);
    check('L: после удаления кабинета его догрузка не выполняется и не воссоздаёт файлы', calls === 2 && !fs.existsSync(p.dir));
    hub.startAllSchedulers();
    const added = (await hub.handlers['profiles:create']({ name: 'Создан после запуска' })).profile.id;
    const n = hub.getProfile(added); n.store.saveSettings({ backupSchedule: 'daily' });
    const backup = n.backupManager.maybeRunScheduled();
    check('L: у созданного после запуска кабинета собственный бэкап', !!backup && fs.existsSync(path.join(n.dir, 'backups', backup.fileName)));
  }

  async function httpIsolation() {
    const dir = temp(), seed = make(dir);
    const aid = 'default', created = await seed.handlers['profiles:create']({ name: 'Только Б' }), bid = created.profile.id;
    const ap = seed.getProfile(aid), bp = seed.getProfile(bid);
    ap.store.saveSettings({ shopName: 'СКРЫТЫЙ_КАБИНЕТ_A', backupSchedule: 'daily' });
    ap.store.saveCosts({ '1001': { costPriceRub: 99999 } });
    ap.store.saveRepricer({ enabled: true });
    facts(bp.store);
    bp.store.saveSettings({ shopName: 'Только Б' });
    seed.stopAllSchedulers();
    check('L: --profile и переменная окружения читаются при запуске', parseArgs(['--profile', bid], {}).profile === bid && parseArgs([], { WB_WEB_PROFILE: bid }).profile === bid);
    const web = createWebServer({ dataDir: dir, profile: bid, mode: 'local', port: 0, host: '127.0.0.1', tunnelAutostart: false, user: 'tester', pass: 'Test-password-2026', log: () => {}, errorLog: () => {} });
    try {
      const address = await web.listen();
      const request = (method, route, body, headers) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: address.port, method, path: route, headers: headers || {} }, (res) => {
          const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        }); req.on('error', reject); req.end(body);
      });
      const cookiePairs = (response) => (response.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
      const loginPage = await request('GET', '/login');
      const loginCsrf = loginPage.body.match(/name="csrf" value="([^"]+)"/)[1];
      const login = await request('POST', '/login', new URLSearchParams({ user: 'tester', pass: 'Test-password-2026', csrf: loginCsrf }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookiePairs(loginPage).join('; ') });
      check('L: HTTP-приёмка выполняется с настоящей авторизацией', login.status === 303);
      const cookies = cookiePairs(login), csrf = decodeURIComponent(cookies.find((c) => c.startsWith('wb_web_csrf=')).split('=')[1]);
      const invoke = async (channel, payload) => {
        const response = await request('POST', '/api/invoke', JSON.stringify({ channel, args: payload === undefined ? [] : [payload] }), { Cookie: cookies.join('; '), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
        return { ...response, json: JSON.parse(response.body) };
      };
      const state = await invoke('app:state'), list = await invoke('profiles:list');
      check('L: фиксированный веб инстанцирует только один кабинет', web.service._byId.size === 1 && web.service.getActive().id === bid);
      check('L: app:state не раскрывает имена или id остальных кабинетов', state.json.data.activeProfileId === bid && state.json.data.profiles.length === 1 && !state.body.includes('СКРЫТЫЙ_КАБИНЕТ_A') && !state.body.includes('"id":"default"'));
      check('L: profiles:list в фиксированном вебе содержит только B', list.json.data.profiles.length === 1 && list.json.data.switchable === false);
      check('L: веб не запускает автоработы и бэкапы скрытого A', !fs.existsSync(path.join(ap.dir, 'backups')));
      check('L: выбранный веб-профиль не меняет выбранный кабинет Electron', JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'))).activeId === aid);
      for (const [channel, payload] of [
        ['profiles:switch', { profileId: aid }], ['profiles:create', { name: 'Обход' }], ['profiles:remove', { profileId: aid }],
        ['profiles:rename', { profileId: aid, name: 'Обход' }], ['profiles:export', { profileId: aid }],
        ['profiles:import', { profileId: aid, action: 'preview', content: '{}' }]
      ]) {
        const response = await invoke(channel, payload);
        check('L: HTTP блокирует чужой профиль через ' + channel, response.json.ok === false && response.json.error.code === 'PROFILE_FORBIDDEN');
      }
      const pl = await invoke('profiles:pl-summary');
      check('L: P&L фиксированного веба не раскрывает чужие финансы', pl.json.data.profiles.length === 1 && pl.json.data.profiles[0].profileId === bid && pl.json.data.totals.revenue === 1000 && !pl.body.includes('СКРЫТЫЙ_КАБИНЕТ_A'));
      const scoped = await invoke('profiles:invoke', { profileId: aid, channel: 'costs:get', args: [] });
      check('L: профильный контекст не обходит HTTP-изоляцию', scoped.json.ok === false && scoped.json.error.code === 'PROFILE_CHANGED');
      const badChannel = await invoke('constructor');
      check('L: у HTTP-маршрутизатора нет унаследованных обработчиков', badChannel.status === 400 && badChannel.json.ok === false);
      const exported = await invoke('profiles:export', {});
      check('L: экспорт разрешённого B остаётся в формате J без чужих данных', exported.json.ok && JSON.parse(exported.json.data.content).format === 'wb-price-manager-backup' && !exported.json.data.content.includes('СКРЫТЫЙ_КАБИНЕТ_A'));
    } finally { await web.close(); }
    check('L: HTTP close остановил сервис выбранного кабинета', web.service.getActive().service.sched.timer === null);
  }

  async function rendererIsolation() {
    const { JSDOM, VirtualConsole } = require('jsdom');
    const errors = [], renderDir = temp(), emitters = new Map();
    const hub = make(renderDir, { createService: (store, emit, electron, hooks) => {
      emitters.set(path.basename(store.dir), emit);
      store.saveSettings({ demoMode: true, firstRun: false });
      const service = createService(store, emit, electron, hooks);
      // Маленький одинаковый nmID в обоих кабинетах специально ловит перенос правок.
      service.handlers['wb:goods'] = async () => ({ demo: true, items: [{ nmID: 1001, vendorCode: 'ONE', price: 1000, discount: 10, brand: 'Тест', categoryName: 'Тест' }], stats: [], overrides: store.loadCosts().items || {}, settings: service.getSettings() });
      service.handlers['wb:promos'] = async () => [];
      return service;
    } });
    const bid = (await hub.handlers['profiles:create']({ name: 'Кабинет Б' })).profile.id;
    hub.getProfile('default').store.saveCosts({ '1001': { costPriceRub: 100 } });
    hub.getProfile(bid).store.saveCosts({ '1001': { costPriceRub: 600 } });
    const html = read('src/renderer/index.html');
    const vc = new VirtualConsole(); vc.on('jsdomError', (error) => errors.push(error.message)); vc.on('error', (...args) => errors.push(args.join(' ')));
    let stream;
    const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', url: 'http://localhost/', virtualConsole: vc });
    const w = dom.window, doc = w.document;
    w.EventSource = class { constructor() { this.listeners = {}; stream = this; } addEventListener(c, fn) { this.listeners[c] = fn; } close() {} };
    w.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body), fn = hub.handlers[body.channel];
      try { return { json: async () => ({ ok: true, data: await fn(...body.args) }) }; }
      catch (error) { return { json: async () => ({ ok: false, error: { message: error.message, code: error.code } }) }; }
    };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    try {
      w.eval(read('electron/economics.js')); w.eval(read('electron/repricer-engine.js'));
      for (const match of html.matchAll(/<script src="\.\/(js\/[^"]+)"><\/script>/g)) w.eval(read('src/renderer/' + match[1].split('?')[0]));
      doc.dispatchEvent(new w.Event('DOMContentLoaded'));
      await sleep(80);
      check('L UI: запуск с несколькими профилями читает A', w.S.state.appState.activeProfileId === 'default' && w.S.state.costs['1001'].costPriceRub === 100);
      check('L UI: переключатель в шапке содержит оба кабинета', doc.querySelectorAll('.profile-switcher option').length === 2);
      w.S.state.priceEdits.set(1001, { basePrice: 777 });
      w.S.state.selection.add(1001); w.S.state.filters.q = 'Чужой фильтр';
      w.Views.repricer.pendingEdits.set(1001, { price: 888 }); w.Views.repricer.results = [{ nmID: 1001 }]; w.Views.repricer.rstate = { from: 'A' };
      w.Views.reports.period = { dateFrom: '2025-01-01', dateTo: '2025-02-01' };
      w.Views.promos.promoRows = { candidates: [{ nmID: 1001 }] };
      const ask = await w.App.switchProfile(bid);
      check('L UI: несохранённые правки требуют явного решения', ask === false && /несохранённые изменения/.test(doc.querySelector('#modal-root .modal').textContent) && hub.activeId() === 'default');
      doc.querySelector('#modal-root .modal-close').click();
      check('L UI: отмена переключения сохраняет правки A', w.S.state.priceEdits.get(1001).basePrice === 777 && w.Views.repricer.pendingEdits.size === 1);
      const switched = await w.App.switchProfile(bid, true);
      check('L UI: подтверждённое переключение читает B', switched && hub.activeId() === bid && w.S.state.costs['1001'].costPriceRub === 600 && w.API.activeProfileId() === bid);
      check('L UI: ручные правки, выделение и фильтры A не попали в B', !w.S.state.priceEdits.size && !w.S.state.selection.size && w.S.state.filters.q === '');
      check('L UI: кэши репрайсера, отчётов и акций сброшены', !w.Views.repricer.pendingEdits.size && !w.Views.repricer.results.length && w.Views.repricer.rstate === null && w.Views.reports.period === null && !w.Views.promos.promoRows);
      let received = 0; w.API.on('test-profile', () => received++);
      stream.listeners['svc:test-profile']({ data: JSON.stringify({ profileId: 'default' }) });
      stream.listeners['svc:test-profile']({ data: JSON.stringify({ profileId: bid }) });
      check('L UI: запоздавшее SSE-событие A отбрасывается в B', received === 1);
      await sleep(10); // закончили фоновые чтения dashboard перед изолированным запросом
      let release;
      const originalFetch = w.fetch;
      w.fetch = () => new Promise((resolve) => { release = () => resolve({ json: async () => ({ ok: true, data: { stale: true } }) }); });
      const late = w.API.invoke('costs:get').then(() => 'accepted', (error) => error.code);
      check('L UI: транспорт учитывает незавершённый запрос', w.API.pending() === 1);
      const refused = await w.App.switchProfile('default', true);
      check('L UI: переключение во время операции блокируется', refused === false && hub.activeId() === bid);
      w.API.invalidateProfile(); release();
      check('L UI: устаревший async-ответ не принимается после смены поколения', await late === 'PROFILE_CHANGED');
      w.fetch = originalFetch;
      let debounced = 0; const debounce = w.U.debounce(() => debounced++, 15); debounce(); w.API.invalidateProfile(); await sleep(25);
      check('L UI: отложенный ввод старой таблицы не меняет новый профиль', debounced === 0);
      facts(hub.getProfile(bid).store); facts(hub.getProfile('default').store);
      w.App.go('pl-summary'); await sleep(40);
      check('L UI: новая вкладка P&L открывается по реальному NAV id', doc.querySelector('#page-title').textContent === 'Сводка P&L' && !!doc.querySelector('#pl-summary-refresh') && /Кабинет Б/.test(doc.querySelector('#view').textContent));
      check('L UI: отрицательные суммы не получают двойной минус', !/[−-]\s*[−-]\s*\d/.test(doc.querySelector('#view').textContent));
      await w.App.switchProfile('default', true);
      check('L UI: возврат к A читает его себестоимость без переноса B', w.S.state.costs['1001'].costPriceRub === 100);
      check('L UI: изоляция не породила ошибок JavaScript', errors.length === 0, errors.join(' | '));
    } finally { dom.window.close(); }
  }
};
