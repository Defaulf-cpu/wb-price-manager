'use strict';

/** Принадлежность nmID кабинету: реальная пагинация клиента, серверные apply/preview, старые файлы и изоляция L. Сеть только подменная. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WBClient } = require('../../electron/wb-client');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { createProfileHub } = require('../../electron/profiles');
let pass = 0, fail = 0;
const roots = [], services = [], hubs = [];
const check = (name, condition, detail) => { if (condition) { pass++; console.log('OK   ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); } };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-promo-cabinet-')); roots.push(dir); return dir; };
const rejects = async (name, fn, code) => { let error; try { await fn(); } catch (e) { error = e; } check(name, !!error && (!code || error.code === code), error && error.code + ': ' + error.message); return error; };
const good = (nmID) => ({ nmID, price: 2000, discount: 0, vendorCode: 'SYN-' + nmID });
const result = (ids, patch = {}) => ({ items: ids.map(good), source: 'wb', scope: 'full', complete: true, total: ids.length, totalKnown: true, completionReason: 'empty-page', ...patch });
const own = [100000101, 100000102], foreign = 900000001;
const rows = (ids) => [['Артикул WB', 'Артикул продавца', 'Плановая цена для акции'], ...ids.map((id) => [id, 'SYN-' + id, 1500])];
const payload = (ids, action = 'preview') => ({ promotionID: 3148, fileName: 'synthetic.csv', rows: rows(ids), action });
const promo = { id: 3148, name: 'Синтетическая акция', type: 'auto', startDateTime: new Date(Date.now() - 86400000).toISOString(), endDateTime: new Date(Date.now() + 86400000).toISOString() };
function configure(service, ids = own) {
  const client = service.getClient();
  client.getGoods = async () => result(ids);
  client.getCards = async () => [];
  service.handlers['wb:promos'] = async () => [promo];
  service.handlers['wb:promo-nomenclatures'] = async () => { throw new Error('Состав через API запрещён в этом тесте'); };
  return client;
}
function stand() {
  const store = createStore(temp(), null);
  store.saveSettings({ demoMode: false, firstRun: false, promosInferFromDiscount: false, promosFetchNomenclatures: false });
  store.saveSecrets({ single: 'synthetic-first-token-AAAA' });
  const service = createService(store, () => {}); services.push(service);
  return { store, service, client: configure(service) };
}
function files(store) {
  return fs.readdirSync(store.dir).filter((name) => /\.json$/.test(name)).sort().map((name) => [name, fs.readFileSync(path.join(store.dir, name), 'utf8')]);
}
async function pagination() {
  const client = new WBClient({ keys: { single: 'not-a-real-key' } }), calls = [];
  let data = Array.from({ length: 2501 }, (_, i) => good(200000001 + i));
  client.request = async (category, method, endpoint, options) => {
    const q = options.query; calls.push({ category, method, endpoint, ...q });
    return { data: { listGoods: data.slice(q.offset, q.offset + q.limit) } };
  };
  let got = await client.getGoods();
  check('Каталог без total: загружены все 2501 товара, не только первая тысяча', got.items.length === 2501 && got.complete && got.scope === 'full');
  check('Каталог без total: пустая четвёртая страница подтверждает полноту', got.pages === 4 && got.completionReason === 'empty-page' && equal(calls.map((c) => c.offset), [0, 1000, 2000, 3000]));
  check('Пагинация WB использует GET цен и limit не более 1000', calls.every((c) => c.category === 'prices' && c.method === 'GET' && c.limit === 1000 && c.filterNmID === undefined));
  calls.length = 0;
  got = await client.getGoods({ maxItems: 2000 });
  check('Ограниченный каталог не выдаётся за полный', got.items.length === 2000 && !got.complete && got.truncated && got.completionReason === 'limit');
  data = data.slice(0, 2000); calls.length = 0;
  got = await client.getGoods({ maxItems: 2000 });
  check('Ровно maxItems: отдельная пустая страница подтверждает, что усечения нет', got.complete && got.items.length === 2000 && got.pages === 3);
  data = [good(1), good(2), good(3)]; calls.length = 0;
  got = await client.getGoods({ limit: 2 });
  check('offset увеличивается на limit, а не длину короткой последней страницы', equal(calls.map((c) => c.offset), [0, 2, 4]) && got.complete && got.items.length === 3);
  calls.length = 0;
  got = await client.getGoods({ filterNmID: 1 });
  check('Ответ с filterNmID не считается полным каталогом кабинета', !got.complete && got.scope === 'filtered');
  data = []; got = await client.getGoods();
  check('Действительно пустой кабинет имеет явное подтверждение пустого каталога', got.complete && got.items.length === 0);
  client.request = async () => ({ data: { listGoods: [good(1), good(2)] } });
  got = await client.getGoods({ limit: 2 });
  check('WB повторил страницу: цикл остановлен, полнота не выдумана', !got.complete && got.pages === 2 && got.completionReason === 'repeated-page');
  client.request = async () => ({ data: { listGoods: [good(1), good(1)], total: 2 } });
  got = await client.getGoods();
  check('Дубли nmID не маскируют потерю товаров при пагинации', !got.complete && got.items.length === 1);
  client.request = async () => ({ data: {} });
  await rejects('Некорректная схема ответа не означает пустой полный кабинет', () => client.getGoods(), 'BAD_CATALOG');
  client.request = async (_c, _m, _p, { query }) => { if (query.offset) throw Object.assign(new Error('network failed'), { code: 'TEST_NETWORK' }); return { data: { listGoods: [good(1), good(2)] } }; };
  await rejects('Ошибка второй страницы не превращается в успешный частичный каталог', () => client.getGoods({ limit: 2 }), 'TEST_NETWORK');
  client.request = async (_c, _m, _p, { query }) => ({ data: { listGoods: query.offset ? [] : [good(1)], total: 2 } });
  got = await client.getGoods();
  check('Пустая страница, противоречащая явному total, не подтверждает полный каталог', !got.complete && got.completionReason === 'inconsistent-total');
  client.request = async () => ({ data: { listGoods: [{ nmID: 'bad' }] } });
  await rejects('Некорректный nmID в каталоге останавливает проверку', () => client.getGoods(), 'BAD_CATALOG');
}
async function ownership() {
  const { service, store, client } = stand(), h = service.handlers;
  const before = files(store), cfg = JSON.stringify(store.loadRepricer());
  const preview = await h['promos:import-noms'](payload([...own, foreign]));
  check('Смешанный файл: предпросмотр содержит оба списка', preview.preview && preview.fileCount === 3 && preview.count === 2 && preview.matchedCount === 2 && preview.excludedCount === 1);
  check('Смешанный файл: исключённый nmID снабжён причиной, а не потерян', preview.excluded[0].nmID === foreign && preview.excluded[0].reasonCode === 'NOT_IN_CABINET' && /полном каталоге/.test(preview.excluded[0].reason));
  check('Предпросмотр подтверждает источник/полноту и время каталога', preview.ownership.status === 'verified' && preview.ownership.catalogCount === 2 && !!preview.ownership.catalogAt && !!preview.ownershipContext);
  check('Предпросмотр не записывает ни один JSON-набор кабинета', equal(before, files(store)));
  // Нельзя передать подложный matched вместо исходного файла.
  const applied = await h['promos:import-noms']({ ...payload([...own, foreign], 'apply'), matched: [{ nmID: foreign }], ownershipContext: preview.ownershipContext });
  check('apply заново проверяет исходный файл и сохраняет только свои nmID', applied.count === 2 && applied.excludedCount === 1 && equal(store.loadPromoNoms()['3148'].items.map((i) => i.nmID), own));
  check('Импорт сохраняет сведения об исключениях, но не чужие товары', store.loadPromoNoms()['3148'].ownership.excludedCount === 1 && store.loadPromoNoms()['3148'].count === 2);
  check('Импорт не отправляет цены и не включает автоотправку', applied.sentToWb === false && !store.loadTasks().length && JSON.stringify(store.loadRepricer()) === cfg);
  const stable = JSON.stringify(store.loadPromoNoms());
  await rejects('Изменившийся список своих требует нового подтверждения предпросмотра', () => h['promos:import-noms']({ ...payload(own, 'apply'), ownershipDigest: 'old-digest' }), 'PROMO_OWNERSHIP_CHANGED');
  check('Отказ по устаревшему подтверждению не изменяет состав', JSON.stringify(store.loadPromoNoms()) === stable);
  const wholly = await h['promos:import-noms'](payload([foreign]));
  check('Полностью чужой файл отклонён уже в предпросмотре', !wholly.canApply && wholly.count === 0 && wholly.excluded.length === 1 && /Файл отклонён/.test(wholly.rejectionReason));
  await rejects('Полностью чужой apply без preview отклоняется сервером', () => h['promos:import-noms'](payload([foreign], 'apply')), 'FOREIGN_PROMO_FILE');
  check('Отказ не стирает прежний файл/выбор/условия', JSON.stringify(store.loadPromoNoms()) === stable);
  await rejects('Импорт не принимает произвольный ключ объекта вместо ID акции', () => h['promos:import-noms']({ ...payload(own), promotionID: '__proto__' }), 'NO_PROMO');
  await h['keys:set']({ single: 'synthetic-second-token-AAAA' });
  const nextClient = configure(service);
  check('Ключи с одинаковыми последними четырьмя символами создают разный клиент', nextClient !== client);
  nextClient.getGoods = async () => result(own, { complete: false, completionReason: 'limit', total: 5001 });
  const partialBefore = JSON.stringify(store.loadPromoNoms());
  await rejects('Частичный каталог не разрешает даже смешанный файл с найденными nmID', () => h['promos:import-noms'](payload([...own, foreign])), 'PROMO_CATALOG_INCOMPLETE');
  await rejects('Нельзя обойти неполный каталог прямым apply', () => h['promos:import-noms'](payload(own, 'apply')), 'PROMO_CATALOG_INCOMPLETE');
  check('Неполный каталог оставляет прежние условия неизменными', JSON.stringify(store.loadPromoNoms()) === partialBefore);
  nextClient.getGoods = async () => { throw new Error('WB 403: нет доступа к ценам'); };
  await rejects('Недоступный каталог не подменяется прежним успешным или пустым', () => h['promos:import-noms'](payload(own, 'apply')), 'PROMO_CATALOG_UNAVAILABLE');
  nextClient.getGoods = async () => result(own, { complete: undefined });
  await rejects('Каталог без явной полноты не принимается как доказательство', () => h['promos:import-noms'](payload(own)), 'PROMO_CATALOG_INCOMPLETE');
}
async function legacy() {
  const { service, store } = stand(), h = service.handlers;
  store.savePromoNoms({ '3148': { at: '2026-01-01', fileName: 'old-mixed.csv', items: [...own, foreign].map((nmID) => ({ nmID, planPrice: 1500 })), selectedOnly: true, selectedIds: [...own, foreign] } });
  const index = await h['promos:index'](), rec = index.promos[0];
  check('Старый смешанный файл: индекс считает только свои товары, не весь каталог/файл', rec.manualCount === 2 && rec.compositionCount === 2 && rec.selectedCount === 2 && rec.storedCount === 3 && rec.ownership.excludedCount === 1);
  check('Индекс акций содержит период, источник и честные счётчики состава', rec.startDateTime === promo.startDateTime && rec.endDateTime === promo.endDateTime && rec.source === 'file' && rec.withPlanPrice === 2 && rec.priceControl.above === 2);
  const items = await h['promos:items']({ promotionID: 3148 });
  check('Старый чужой nmID не возвращается в состав/решения репрайсера', items.items.length === 2 && !items.items.some((i) => i.nmID === foreign) && items.ownership.excludedItems[0].nmID === foreign);
  const stable = JSON.stringify(store.loadPromoNoms());
  await rejects('Выбор чужого nmID из старого файла не обходит защиту импорта', () => h['promos:save-selection']({ promotionID: 3148, nmIDs: [foreign] }), 'BAD_PROMO_SELECTION');
  check('Неудачный выбор не меняет старые условия', JSON.stringify(store.loadPromoNoms()) === stable);
  const saved = await h['promos:save-selection']({ promotionID: 3148, nmIDs: [own[0]] });
  check('Сохранение своих из старого смешанного состава не переписывает чужие позиции обратно', saved.saved === 1 && saved.sentToWb === false && store.loadPromoNoms()['3148'].items.length === 2 && equal(store.loadPromoNoms()['3148'].selectedIds, [own[0]]));
  await h['keys:set']({ single: 'synthetic-unavailable-token' });
  configure(service).getGoods = async () => { throw new Error('offline'); };
  const blocked = await h['promos:index']();
  check('Старый файл при недоступном каталоге заблокирован, а не признан своим', blocked.promos[0].compositionCount === null && blocked.promos[0].eligible === 0 && blocked.promos[0].ownership.status === 'blocked');
  const old = JSON.stringify(store.loadPromoNoms());
  await rejects('Сохранение выбора без каталога запрещено независимо от старой метки проверки', () => h['promos:save-selection']({ promotionID: 3148, nmIDs: own }), 'PROMO_CATALOG_UNAVAILABLE');
  check('Блокировка чтения не удаляет файл автоматически', JSON.stringify(store.loadPromoNoms()) === old);
}
async function generation() {
  for (const action of ['preview', 'apply']) {
    const { service, store, client } = stand(), h = service.handlers;
    let release;
    client.getGoods = () => new Promise((resolve) => { release = resolve; });
    const pending = h['promos:import-noms'](payload(own, action));
    await h['keys:set']({ single: 'synthetic-new-key-during-await' });
    release(result(own));
    await rejects('Смена ключа во время ' + action + ' не позволяет использовать запоздалый каталог', () => pending, 'PROMO_CABINET_CHANGED');
    check('После гонки ' + action + ' не записан чужой/устаревший состав', !store.loadPromoNoms()['3148']);
  }
  for (const setting of ['demoMode', 'sandbox']) {
    const { service, client, store } = stand(); let release;
    client.getGoods = () => new Promise((resolve) => { release = resolve; });
    const pending = service.handlers['promos:import-noms'](payload(own, 'apply'));
    await service.handlers['settings:save']({ [setting]: true });
    await service.handlers['settings:save']({ [setting]: false }); // A → B → A не возвращает старому запросу разрешение
    release(result(own));
    await rejects('Смена ' + setting + ' туда-обратно тоже инвалидирует отложенный импорт', () => pending, 'PROMO_CABINET_CHANGED');
    check('После изменения ' + setting + ' отложенная запись отсутствует', !store.loadPromoNoms()['3148']);
  }
  const { service, client, store } = stand();
  let release; client.getGoods = () => new Promise((resolve) => { release = resolve; });
  const pending = service.handlers['promos:import-noms'](payload(own, 'apply'));
  service.dispose(); release(result(own));
  await rejects('Остановка сервиса также обрывает отложенную проверку без записи', () => pending, 'PROMO_CABINET_CHANGED');
  check('Остановленный сервис не записал импорт после await', !store.loadPromoNoms()['3148']);
}
async function fullServiceCatalog() {
  const { service, store, client } = stand(), h = service.handlers;
  const data = Array.from({ length: 6001 }, (_, i) => good(300000001 + i)), offsets = [];
  client.getGoods = WBClient.prototype.getGoods.bind(client);
  client.request = async (_category, _method, _path, { query }) => {
    offsets.push(query.offset); return { data: { listGoods: data.slice(query.offset, query.offset + query.limit) } };
  };
  const loaded = await h['wb:goods']({});
  check('Сервис не обрезает полный кабинет на старом лимите 5000 товаров', loaded.items.length === 6001 && loaded.complete && loaded.total === 6001 && loaded.totalKnown);
  const cached = await h['wb:goods']({});
  check('Кэш wb:goods сохраняет явную полноту, источник и дату каталога', cached.fromCache && cached.complete && cached.source === 'wb' && !!cached.catalogAt && cached.loadedCount === 6001);
  const preview = await h['promos:import-noms'](payload([data[6000].nmID, foreign]));
  check('nmID за пределами первой 5000 не ошибочно исключается как чужой', preview.count === 1 && preview.items[0].nmID === data[6000].nmID && preview.ownership.catalogCount === 6001 && preview.excludedCount === 1);
  check('Проверка использует полный свежий каталог без повторного обхода всех страниц', equal(offsets, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]));
  client.getGoods = async () => { throw new Error('forced refresh failed'); };
  await rejects('Неудачное явное обновление действительно сообщает ошибку', () => h['wb:goods']({ force: true }));
  await rejects('После ошибки force старый полный кэш не выдаётся за новую проверку импорта', () => h['promos:import-noms'](payload([data[6000].nmID], 'apply')), 'PROMO_CATALOG_UNAVAILABLE');
  check('Ошибка обновления/проверки не записала состав акции', !store.loadPromoNoms()['3148']);
}

async function cacheAndContext() {
  {
    const { service, client } = stand(), h = service.handlers;
    let calls = 0; client.getGoods = async () => { calls++; return result(own); };
    await h['wb:goods']({});
    const before = await h['promos:import-noms'](payload(own));
    const saved = await h['keys:set']({ single: 'synthetic-first-token-AAAA' });
    const kept = await h['keys:set']({ single: '' });
    const after = await h['promos:import-noms'](payload(own));
    check('Повторное сохранение того же ключа/пустого поля не сбрасывает клиент и каталог', !saved.keysChanged && !kept.keysChanged && service.getClient() === client && calls === 1 && !!service.cache.goods);
    check('Повторное сохранение ключа не меняет подтверждённый контекст предпросмотра', before.ownershipContext === after.ownershipContext);
  }
  {
    const { service, client, store } = stand(), h = service.handlers;
    await h['promos:import-noms'](payload(own, 'apply'));
    const verified = await h['promos:index']();
    client.getGoods = async () => { throw new Error('forced offline'); };
    await rejects('Ошибка force после успешного состава не маскируется старым каталогом', () => h['wb:goods']({ force: true }));
    const blocked = await h['promos:index']();
    check('Ошибка force немедленно блокирует и старый индекс, не только новый импорт', verified.promos[0].compositionCount === 2 && blocked.promos[0].ownership.status === 'blocked' && blocked.promos[0].compositionCount === null);
    check('После ошибки force старый файл сохранён, но не доступен для решений', store.loadPromoNoms()['3148'].items.length === 2 && blocked.promos[0].eligible === 0);
  }
  {
    const { service, client, store } = stand(), h = service.handlers;
    const originalNow = Date.now;
    let clock = originalNow(); Date.now = () => clock;
    try {
      await h['promos:import-noms'](payload(own, 'apply'));
      await h['promos:index']();
      client.getGoods = async () => result(own, { complete: false, completionReason: 'limit' });
      clock += 121000;
      const blocked = await h['promos:index']();
      check('Проверка старых файлов не живёт 15 минут после истечения 2-минутного каталога', blocked.promos[0].ownership.status === 'blocked' && blocked.promos[0].compositionCount === null);
      client.getGoods = async () => result([foreign]);
      await h['wb:goods']({ force: true });
      const changed = await h['promos:index']();
      check('Обновлённый каталог с другим составом исключает старые nmID даже при том же ключе', changed.promos[0].compositionCount === 0 && changed.promos[0].ownership.excludedCount === 2 && store.loadPromoNoms()['3148'].items.length === 2);
    } finally { Date.now = originalNow; }
  }
  {
    const { service, client, store } = stand(), h = service.handlers;
    let release, calls = 0;
    client.getGoods = () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(result([foreign]));
    const stale = h['promos:import-noms'](payload(own, 'apply'));
    await h['wb:goods']({ force: true });
    release(result(own));
    await rejects('Запоздалый каталог до нового force не разрешает устаревший apply', () => stale, 'PROMO_CATALOG_CHANGED');
    const fresh = await h['promos:import-noms'](payload(own));
    check('Запоздалый ответ не затирает более новый каталог и не пишет состав', !fresh.canApply && fresh.excludedCount === 2 && calls === 2 && !store.loadPromoNoms()['3148']);
  }
  for (const patch of [{ source: 'demo' }, { scope: 'filtered' }, { truncated: true }, { total: 100, totalKnown: true }]) {
    const { service, client } = stand(); client.getGoods = async () => result(own, patch);
    await rejects('Противоречивые признаки каталога не подтверждают кабинет: ' + JSON.stringify(patch), () => service.handlers['promos:import-noms'](payload(own)), 'PROMO_CATALOG_INCOMPLETE');
  }
  for (const channel of ['keys:clear', 'settings:reset']) {
    const { service, client, store } = stand(); let release;
    client.getGoods = () => new Promise((resolve) => { release = resolve; });
    const stale = service.handlers['promos:import-noms'](payload(own, 'apply'));
    await service.handlers[channel](); release(result(own));
    await rejects(channel + ' отменяет отложенную проверку, а не переводит реальный файл в демо', () => stale, 'PROMO_CABINET_CHANGED');
    check(channel + ' не допускает запись устаревшего файла после await', !store.loadPromoNoms()['3148']);
  }
}

async function compositionConsistency() {
  const { service, store, client } = stand(), h = service.handlers;
  const regular = { ...promo, type: 'regular', requiredDiscountPct: 10 };
  h['wb:promos'] = async () => [regular];
  client.getGoods = async () => result(own, { items: [good(own[0]), { ...good(own[1]), discount: 20 }] });
  await h['wb:goods']({});
  await h['settings:save']({ promosInferFromDiscount: true });
  let index = await h['promos:index'](), items = await h['promos:items']({ promotionID: promo.id });
  check('Оценка по скидке: список и окно считают одни и те же nmID, а не весь каталог', index.promos[0].source === 'inferred' && index.promos[0].compositionCount === 1 && items.items.length === 1 && items.items[0].nmID === own[1]);
  let apiCalls = 0;
  h['wb:promo-nomenclatures'] = async (opts) => { apiCalls++; return opts.inAction ? [] : [{ nmID: own[0], plannedPrice: 1200, plannedDiscount: 40 }]; };
  await h['settings:save']({ promosFetchNomenclatures: true });
  index = await h['promos:index'](); items = await h['promos:items']({ promotionID: promo.id });
  check('Включение API снимает прежний noApi-кэш без ручного force', apiCalls === 2 && index.promos[0].source === 'api' && items.apiUsed);
  check('WB API плюс оценка явно разделены по источникам и не удваивают nmID', index.promos[0].compositionCount === 2 && items.items.length === 2 && index.promos[0].inferredCount === 1 && index.promos[0].apiCount === 1);
  check('Плановая цена API одинаково видна в таблице акций и деталях товара', index.promos[0].withPlanPrice === 1 && items.items.find((r) => r.nmID === own[0]).planPrice === 1200);
  await h['settings:save']({ promosInferFromDiscount: false, promosFetchNomenclatures: false });
  index = await h['promos:index'](); items = await h['promos:items']({ promotionID: promo.id });
  check('Отключение источников сразу возвращает неизвестный состав, не прежние цифры', index.promos[0].compositionCount === null && index.promos[0].source === 'none' && items.items.length === 0 && apiCalls === 2);
  store.savePromoNoms({ '3148': { fileName: 'old-selection.csv', at: '2026-01-01', items: [...own, foreign].map((nmID) => ({ nmID, planPrice: 1500 })), selectedOnly: true, selectedIds: [...own, foreign] } });
  await h['promos:index']({ force: true }); items = await h['promos:items']({ promotionID: promo.id });
  check('Старый сохранённый выбор фильтруется и в ответе, не оставляя скрытый чужой checkbox', equal(items.selectedIds, own));
}

async function profiles() {
  const hub = createProfileHub({ dataDir: temp(), createService: (store, emit, electron, hooks) => {
    store.saveSettings({ demoMode: false, firstRun: false, promosFetchNomenclatures: false, promosInferFromDiscount: false });
    store.saveSecrets({ single: 'synthetic-key-profile-' + hooks.profileId });
    const service = createService(store, emit, electron, hooks);
    configure(service, hooks.profileId === 'default' ? own : [foreign]);
    return service;
  } }); hubs.push(hub);
  const preview = await hub.handlers['promos:import-noms'](payload(own));
  const bid = (await hub.handlers['profiles:create']({ name: 'Другой кабинет' })).profile.id;
  await hub.handlers['profiles:switch']({ profileId: bid });
  await rejects('Предпросмотр другого профиля не переносится на apply после переключения', () => hub.handlers['promos:import-noms']({ ...payload(own, 'apply'), ownershipContext: preview.ownershipContext }), 'PROMO_CABINET_CHANGED');
  check('После переключения не повреждены ни первый, ни второй профиль', !hub.getProfile('default').store.loadPromoNoms()['3148'] && !hub.getProfile(bid).store.loadPromoNoms()['3148']);
  await hub.handlers['promos:import-noms'](payload([...own, foreign], 'apply'));
  check('Второй кабинет сохраняет только принадлежащий ему nmID того же файла', equal(hub.getProfile(bid).store.loadPromoNoms()['3148'].items.map((i) => i.nmID), [foreign]));
  await rejects('Просроченный profiles:invoke не маршрутизирует импорт в активный кабинет', () => hub.handlers['profiles:invoke']({ profileId: 'default', channel: 'promos:import-noms', args: [payload(own, 'apply')] }), 'PROFILE_CHANGED');
  const otherBackup = await hub.handlers['backup:export']({});
  await hub.handlers['profiles:switch']({ profileId: 'default' });
  const beforeRestore = await hub.handlers['promos:import-noms'](payload(own));
  await hub.handlers['backup:import']({ action: 'apply', content: otherBackup.content, mode: 'merge' });
  configure(hub.getProfile('default').service, own);
  await rejects('Восстановление J инвалидирует предпросмотр даже при том же ключе и имени профиля', () => hub.handlers['promos:import-noms']({ ...payload(own, 'apply'), ownershipContext: beforeRestore.ownershipContext }), 'PROMO_CABINET_CHANGED');
  const restoredIndex = await hub.handlers['promos:index']();
  check('Пометка verified в перенесённом J не разрешает состав другого кабинета', restoredIndex.promos[0].compositionCount === 0 && restoredIndex.promos[0].ownership.excludedCount === 1 && restoredIndex.promos[0].eligible === 0);
  check('Перепроверка восстановленного файла не удаляет историю и не отправляет WB', hub.getProfile('default').store.loadPromoNoms()['3148'].items[0].nmID === foreign && !hub.getProfile('default').store.loadTasks().length);

}
(async () => { await pagination(); await ownership(); await legacy(); await generation(); await fullServiceCatalog(); await cacheAndContext(); await compositionConsistency(); await profiles(); })()
  .catch((e) => { fail++; console.error('FAIL исключение: ' + (e.stack || e)); })
  .finally(() => { services.forEach((s) => s.dispose()); hubs.forEach((h) => h.stopAllSchedulers()); roots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); console.log('\nИТОГО каталог/принадлежность акций: ' + pass + ' пройдено, ' + fail + ' ошибок'); process.exitCode = fail ? 1 : 0; });
