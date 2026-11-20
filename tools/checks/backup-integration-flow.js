'use strict';

/**
 * Приёмка самостоятельного задания J после ручного объединения с резервными копиями K.
 * Сценарии исходного агента перенесены на единый контракт; дополнительно проверяются
 * ранний формат PR #9, защита Telegram-токена и нативные диалоги без запуска Electron.
 * Старый backup-flow.js с транзакционным откатом остаётся отдельным прогоном.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const { createBackupManager, DATASETS, FORMAT, MAX_BACKUP_BYTES } = require('../../electron/backup');
const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const roots = [];

function check(name, fn) {
  try { assert.ok(typeof fn === 'function' ? fn() : fn); pass++; console.log('OK   J: ' + name); }
  catch (error) { fail++; console.log('FAIL J: ' + name + ' — ' + error.message); }
}
function equal(name, actual, expected) {
  check(name, () => { assert.deepStrictEqual(actual, expected); return true; });
}
function rejected(name, fn, code) {
  check(name, () => { try { fn(); } catch (error) { return !code || error.code === code; } return false; });
}
function stand(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-j-acceptance-')); roots.push(dir);
  const store = createStore(dir, null);
  if (seed) {
    store.saveSettings({ shopName: 'Магазин J', targetMarginPct: 25, demoMode: true });
    store.saveCosts({ 1001: { costPriceRub: 500 }, 1002: { costPriceRub: 700 } });
    store.savePriceWatch({ 1001: [{ price: 999, at: '2026-01-01' }] });
    store.saveStocks({ 1001: { total: 10, byWarehouse: {}, byRegion: {}, sizeRows: 1 } }, {});
    store.appendStockSnapshot({ at: '2026-01-01T12:00:00Z', complete: true, zeroNms: ['1002'], observedNms: ['1001', '1002'] });
    store.saveTasks([{ taskId: 'j-task', total: 2, ok: 2, source: 'manual', createdAt: '2026-01-01' }]);
    store.saveFactCosts({ 1001: { logisticsAvg: 50 } }, { dateFrom: '2026-01-01' });
    store.savePromoExits({ 1001: { promoId: 5, raisedTo: 1200 } });
    store.saveProposals({ at: '2026-01-01', phase: 'proposed', items: [{ nmID: 1001, sellerPrice: 900 }] });
    store.saveRepricer({ schedule: { enabled: true }, sizePriceMode: 'manual' });
    store.saveCompetitors({ 1001: [{ sku: '999', price: 850 }] });
    store.saveItemConfigs({ 1001: { minPrice: 600, sizePrices: { 101: 1000 } } });
    store.appendPriceHistory([{ nmID: 1001, at: '2026-01-01', basePrice: 1000, discount: 10, sellerPrice: 900, source: 'manual' }]);
    store.saveRuns([{ id: 'j-run', at: '2026-01-01', total: 1 }]);
    store.savePromoNoms({ 5: { fileName: 'promo.xlsx', items: [{ nmID: 1001 }] } });
    store.appendRecalcHistory([{ nmID: 1001, phase: 'propose', basePrice: 1000, discount: 10, sellerPrice: 900 }]);
    store.appendPromoJournal([{ nmID: 1001, action: 'join', promoId: 5, priceBefore: 990, priceAfter: 900 }]);
  }
  return { dir, store, manager: createBackupManager({ store, appVersion: '1.2.3' }) };
}
function jsonFile(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function main() {
  const source = stand(true);
  source.store.saveSecrets({ single: 'fictional-wb-key-J', telegramBotToken: 'fictional-Telegram-secret-J' });
  const exported = source.manager.exportBackup();
  const doc = JSON.parse(exported.content);
  equal('название формата', doc.format, FORMAT);
  equal('версия формата', doc.formatVersion, 1);
  check('дата — корректный ISO-момент', Number.isFinite(Date.parse(doc.createdAt)));
  equal('версия приложения', doc.appVersion, '1.2.3');
  check('экспорт имеет расширение .wbpm.json', exported.fileName.endsWith('.wbpm.json'));
  equal('размер считается в байтах UTF-8', exported.sizeBytes, Buffer.byteLength(exported.content, 'utf8'));
  equal('в оглавлении все наборы данных', doc.manifest.datasets.length, DATASETS.length);
  check('секретов нет по умолчанию', !doc.encryptedSecrets && !exported.content.includes('fictional-wb-key-J') && !exported.content.includes('fictional-Telegram-secret-J'));
  check('JSON без BOM', exported.content.charCodeAt(0) !== 0xFEFF);
  for (const item of DATASETS) {
    const entry = doc.manifest.datasets.find((m) => m.key === item.key);
    check('манифест: ' + item.key, entry && entry.file === item.file && entry.records > 0 && entry.sizeBytes > 0);
    equal('контрольная сумма: ' + item.key, entry && entry.sha256,
      crypto.createHash('sha256').update(JSON.stringify(doc.data[item.key], null, 2)).digest('hex'));
  }

  const target = stand();
  const preview = target.manager.importBackup({ content: exported.content });
  equal('предпросмотр по умолчанию — merge', preview.mode, 'merge');
  check('предпросмотр не создаёт файлы данных', DATASETS.every((item) => !fs.existsSync(path.join(target.dir, item.file))));
  const restored = target.manager.importBackup({ action: 'apply', mode: 'replace', overwriteConfirmed: true, content: exported.content });
  check('round-trip применён и создана страховочная копия', restored.applied && fs.existsSync(path.join(target.manager.backupsDir, restored.safetyBackup)));
  for (const item of DATASETS) equal('round-trip: ' + item.key, jsonFile(target.dir, item.file), jsonFile(source.dir, item.file));
  equal('ключи не появились после обычного импорта', target.store.loadSecrets(), {});
  check('после импорта нет временных файлов и незавершённых транзакций',
    !fs.readdirSync(target.dir).some((name) => name.includes('.tmp-')) &&
    (!fs.existsSync(path.join(target.dir, '.wbpm-transactions')) || fs.readdirSync(path.join(target.dir, '.wbpm-transactions')).length === 0));

  const encrypted = source.manager.exportBackup({ includeKeys: true, password: 'test-password-J' });
  const encryptedDoc = JSON.parse(encrypted.content);
  check('ключи зашифрованы AES-256-GCM', encryptedDoc.encryptedSecrets.cipher.name === 'aes-256-gcm');
  check('KDF — scrypt с фиксированными параметрами', encryptedDoc.encryptedSecrets.kdf.name === 'scrypt' && encryptedDoc.encryptedSecrets.kdf.N === 16384);
  check('ни пароль, ни ключи не видны в экспорте', !encrypted.content.includes('test-password-J') && !encrypted.content.includes('fictional-wb-key-J') && !encrypted.content.includes('fictional-Telegram-secret-J'));
  rejected('ключи нельзя экспортировать без пароля', () => source.manager.exportBackup({ includeKeys: true }), 'PASSWORD_REQUIRED');
  rejected('ключи нельзя экспортировать с коротким паролем', () => source.manager.exportBackup({ includeKeys: true, password: 'short' }), 'PASSWORD_REQUIRED');
  const secretTarget = stand();
  secretTarget.store.saveSecrets({ telegramBotToken: 'keep-local-Telegram-J' });
  rejected('неверный пароль запрещает весь импорт до записи', () => secretTarget.manager.importBackup({ action: 'apply', content: encrypted.content, applyKeys: true, password: 'wrong-password-J' }), 'BAD_PASSWORD');
  check('неверный пароль не записал настройки', !fs.existsSync(path.join(secretTarget.dir, 'settings.json')));
  secretTarget.manager.importBackup({ action: 'apply', content: encrypted.content, applyKeys: true, password: 'test-password-J' });
  equal('ключ WB восстановлен', secretTarget.store.loadSecrets().single, 'fictional-wb-key-J');
  equal('Telegram-токен назначения сохранён', secretTarget.store.loadSecrets().telegramBotToken, 'keep-local-Telegram-J');
  const noKeysTarget = stand();
  noKeysTarget.manager.importBackup({ action: 'apply', content: encrypted.content });
  check('импорт без явного applyKeys не меняет секреты и не требует пароль', !noKeysTarget.store.loadSecrets().single && noKeysTarget.store.loadSettings().shopName === 'Магазин J');

  const merge = stand();
  merge.store.saveSettings({ shopName: 'Локальный магазин', targetMarginPct: 15 });
  merge.store.saveCosts({ 1001: { costPriceRub: 999 }, 2001: { costPriceRub: 123 } });
  merge.store.saveTasks([{ taskId: 'local-task', total: 1 }, { taskId: 'j-task', total: 77 }]);
  merge.store.saveItemConfigs({ 3001: { minPrice: 500 } });
  const mergePreview = merge.manager.importBackup({ content: exported.content });
  check('предпросмотр сообщает о сохранённых конфликтах', mergePreview.totals.conflicts > 0);
  merge.manager.importBackup({ action: 'apply', content: exported.content });
  equal('локальные настройки не затёрты', merge.store.loadSettings().shopName, 'Локальный магазин');
  equal('локальная себестоимость не затёрта', merge.store.loadCosts().items['1001'].costPriceRub, 999);
  equal('добавлена новая себестоимость', merge.store.loadCosts().items['1002'].costPriceRub, 700);
  check('локальная себестоимость другого товара не удалена', !!merge.store.loadCosts().items['2001']);
  check('настройки товаров объединены без удаления локальных', !!merge.store.loadItemConfigs()['1001'] && !!merge.store.loadItemConfigs()['3001']);
  equal('задача с тем же taskId не дублируется и не перезаписывается', merge.store.loadTasks().filter((t) => t.taskId === 'j-task').map((t) => t.total), [77]);
  rejected('replace требует подтверждение', () => merge.manager.importBackup({ action: 'apply', content: exported.content, mode: 'replace' }), 'CONFIRMATION_REQUIRED');
  rejected('перезапись конфликтов требует подтверждение', () => merge.manager.importBackup({ action: 'apply', content: exported.content, overwriteExisting: true }), 'CONFIRMATION_REQUIRED');

  const beforeBad = fs.readFileSync(path.join(merge.dir, 'costs.json'), 'utf8');
  rejected('повреждённый JSON отклонён', () => merge.manager.importBackup({ content: '{ не JSON' }), 'BAD_FILE');
  rejected('неизвестный формат отклонён', () => merge.manager.importBackup({ content: JSON.stringify({ format: 'other', formatVersion: 1 }) }), 'BAD_FILE');
  const future = clone(doc); future.formatVersion = 99;
  rejected('новая версия формата отклонена', () => merge.manager.importBackup({ content: future }), 'INCOMPATIBLE_FORMAT');
  const tampered = clone(doc); tampered.data.settings.shopName = 'подмена';
  rejected('подмена данных не проходит checksum', () => merge.manager.importBackup({ content: tampered }), 'BAD_FILE');
  const unsafe = clone(doc); unsafe.data.settings = JSON.parse('{"__proto__":{"injected":true}}');
  rejected('опасные JSON-ключи отклонены до применения', () => merge.manager.importBackup({ content: unsafe }), 'BAD_FILE');
  rejected('подмена имени файла в backup:restore отклонена', () => merge.manager.restoreBackup({ confirmed: true, fileName: '../settings.json' }), 'BAD_BACKUP_NAME');
  rejected('восстановление из списка требует подтверждение', () => merge.manager.restoreBackup({ fileName: restored.safetyBackup }), 'CONFIRMATION_REQUIRED');
  equal('после всех ошибок данные не повреждены', fs.readFileSync(path.join(merge.dir, 'costs.json'), 'utf8'), beforeBad);

  // Этот файл произведён именно исходным экспортёром PR #9; все ключи вымышленные.
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-j-v1.json'), 'utf8'));
  const oldTarget = stand();
  const oldPreview = oldTarget.manager.importBackup({ content: legacy });
  equal('ранний формат J распознаётся', oldPreview.sourceFormat, 'wbpm-backup');
  check('отсутствие старых checksum показано предупреждением', oldPreview.warnings.length === 1 && /контрольных сумм/.test(oldPreview.warnings[0]));
  check('предпросмотр раннего формата видит шифрованные ключи', oldPreview.keys.included && oldPreview.keys.encrypted);
  rejected('неверный пароль раннего формата не запускает импорт', () => oldTarget.manager.importBackup({ action: 'apply', content: legacy, applyKeys: true, password: 'wrong-password-J' }), 'BAD_PASSWORD');
  oldTarget.store.saveSecrets({ telegramBotToken: 'local-Telegram-must-survive' });
  oldTarget.manager.importBackup({ action: 'apply', content: legacy, applyKeys: true, password: 'fixture-password-J' });
  equal('ранний settings перенесён', oldTarget.store.loadSettings().shopName, 'Магазин из задания J');
  equal('ранний costs перенесён', oldTarget.store.loadCosts().items['1001'].costPriceRub, 500);
  check('ручные цены из раннего формата не переносятся', oldTarget.store.loadPriceDrafts === undefined && !fs.existsSync(path.join(oldTarget.dir, 'pricedrafts.json')));
  equal('старое расписание переведено в единый формат', oldTarget.store.loadSettings().backupSchedule, 'weekly');
  equal('старое хранение N переведено в единый формат', oldTarget.store.loadSettings().backupRetention, 3);
  equal('WB-ключ раннего формата расшифрован', oldTarget.store.loadSecrets().single, 'fictional-wb-key-from-J');
  equal('даже из раннего файла чужой Telegram-токен не импортируется', oldTarget.store.loadSecrets().telegramBotToken, 'local-Telegram-must-survive');
  const badLegacy = clone(legacy); badLegacy.manifest[0].file = '../settings.json';
  rejected('ранний формат не позволяет подменять пути', () => oldTarget.manager.importBackup({ content: badLegacy }), 'BAD_FILE');
  const badLegacyVersion = clone(legacy); badLegacyVersion.formatVersion = 99;
  rejected('неизвестная версия раннего формата отклоняется', () => oldTarget.manager.importBackup({ content: badLegacyVersion }), 'INCOMPATIBLE_FORMAT');

  const automatic = stand();
  automatic.store.saveSettings({ backupSchedule: 'daily', backupRetention: 2 });
  let time = Date.UTC(2026, 0, 1);
  const auto = createBackupManager({ store: automatic.store, now: () => new Date(time) });
  check('первое ежедневное копирование выполняется', !!auto.maybeRunScheduled());
  equal('повторная проверка сразу не создаёт копию', auto.maybeRunScheduled(), null);
  time += 86400000; auto.maybeRunScheduled();
  time += 86400000; auto.maybeRunScheduled();
  const autoList = auto.listBackups();
  equal('ротация сохраняет последние N автокопий', autoList.backups.length, 2);
  check('список отсортирован по дате', autoList.backups[0].createdAt >= autoList.backups[1].createdAt);
  check('автокопии без секретов', autoList.backups.every((item) => !item.containsKeys && !item.corrupt));
  automatic.store.saveSettings({ backupSchedule: 'weekly' }); time += 86400000;
  equal('еженедельное расписание не запускается через день', auto.maybeRunScheduled(), null);
  time += 7 * 86400000;
  check('еженедельное расписание запускается через неделю', !!auto.maybeRunScheduled());
  automatic.store.saveSettings({ backupSchedule: 'off' }); time += 8 * 86400000;
  equal('выключенное расписание не создаёт копию', auto.maybeRunScheduled(), null);

  const svcTarget = stand();
  const service = createService(svcTarget.store, () => {});
  for (const channel of ['backup:export', 'backup:import', 'backup:list', 'backup:restore']) {
    check('единый сервис содержит ' + channel, typeof service.handlers[channel] === 'function');
  }
  const svcExport = await service.handlers['backup:export']({});
  check('экспорт доступен без ручной передачи интеграции в сервис', typeof svcExport.content === 'string');
  const svcPreview = await service.handlers['backup:import']({ content: exported.content });
  check('канал импорта по умолчанию только просматривает состав', svcPreview.datasets.length === DATASETS.length && !fs.existsSync(path.join(svcTarget.dir, 'costs.json')));
  service.cache.goods = { items: [{ nmID: 123 }] };
  await service.handlers['backup:import']({ action: 'apply', content: exported.content });
  equal('применение импорта сбрасывает кэш товаров', service.cache.goods, null);
  const svcList = await service.handlers['backup:list']();
  check('канал списка возвращает страховочную копию', svcList.backups.some((b) => b.backupType === 'pre-import'));
  let rejectedPath = false;
  try { await service.handlers['backup:import']({ file: path.join(source.dir, 'settings.json') }); } catch (error) { rejectedPath = error.code === 'BAD_FILE'; }
  check('через веб-канал нельзя читать произвольный путь на сервере', rejectedPath);

  const many = stand(); const costs = {};
  for (let i = 0; i < 500; i++) costs[String(1000 + i)] = { costPriceRub: 100 + i };
  many.store.saveCosts(costs);
  const large = many.manager.exportBackup();
  equal('500 позиций попадают в манифест', large.manifest.datasets.find((m) => m.key === 'costs').records, 500);
  const manyTarget = stand(); manyTarget.manager.importBackup({ action: 'apply', content: large.content });
  equal('500 позиций переживают импорт', Object.keys(manyTarget.store.loadCosts().items).length, 500);

  // Диалоги Electron тестируются на реальных обработчиках main.js, но с подменой dialog.
  const handlers = new Map();
  const nativeDir = stand().dir;
  let saveResult = { canceled: true }, openResult = { canceled: true };
  const mainSource = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const nativeScope = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, service: { handlers: {} },
    dialog: { showSaveDialog: async () => saveResult, showOpenDialog: async () => openResult },
    fs, path, crypto, Buffer, MAX_BACKUP_BYTES, win: null, shell: { showItemInFolder: () => {} }
  };
  vm.runInNewContext(mainSource.slice(mainSource.indexOf('function assertTrustedSender'), mainSource.indexOf('function createWindow')) + '\n' + mainSource.slice(mainSource.indexOf('function registerIpc()'), mainSource.indexOf('\napp.setName')) + '\nregisterIpc();', nativeScope);
  check('main регистрирует диалог сохранения', handlers.has('ui:save-backup'));
  check('main регистрирует диалог открытия', handlers.has('ui:open-backup'));
  const canceledSave = await handlers.get('ui:save-backup')(null, { content: exported.content });
  check('отмена сохранения — успешный ответ с canceled', canceledSave.ok && canceledSave.data.canceled);
  const nativeFile = path.join(nativeDir, 'native.wbpm.json'); saveResult = { canceled: false, filePath: nativeFile };
  const saved = await handlers.get('ui:save-backup')(null, { defaultPath: 'native.wbpm.json', content: exported.content });
  check('нативное сохранение возвращает путь в data', saved.ok && saved.data.filePath === nativeFile);
  check('нативный JSON сохранён без BOM', fs.readFileSync(nativeFile, 'utf8').charCodeAt(0) !== 0xFEFF);
  equal('нативное сохранение не меняет содержимое', JSON.parse(fs.readFileSync(nativeFile, 'utf8')), doc);
  const invalidSave = await handlers.get('ui:save-backup')(null, { content: '{broken' });
  check('битый JSON не перезаписывает файл', !invalidSave.ok && invalidSave.error.code === 'BACKUP_FILE_SAVE' && JSON.parse(fs.readFileSync(nativeFile, 'utf8')).format === FORMAT);
  const canceledOpen = await handlers.get('ui:open-backup')();
  check('отмена открытия — успешный ответ с canceled', canceledOpen.ok && canceledOpen.data.canceled);
  openResult = { canceled: false, filePaths: [nativeFile] };
  const opened = await handlers.get('ui:open-backup')();
  check('нативное открытие возвращает текст, имя и путь в data', opened.ok && opened.data.fileName === 'native.wbpm.json' && opened.data.filePath === nativeFile && opened.data.content === exported.content);
  const tooBig = path.join(nativeDir, 'large.wbpm.json');
  fs.closeSync(fs.openSync(tooBig, 'w')); fs.truncateSync(tooBig, MAX_BACKUP_BYTES + 1);
  openResult = { canceled: false, filePaths: [tooBig] };
  const oversized = await handlers.get('ui:open-backup')();
  check('слишком большой файл отклонён до чтения', !oversized.ok && oversized.error.code === 'BACKUP_FILE_OPEN');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  check('preload разрешает оба файловых канала', preload.includes("'ui:save-backup'") && preload.includes("'ui:open-backup'"));
  vm.runInNewContext(mainSource.slice(mainSource.indexOf('function registeredChannels()'), mainSource.indexOf('\nfunction createWindow()')) + '\nthis.channels = registeredChannels();', nativeScope);
  check('динамический список main содержит оба файловых канала', nativeScope.channels.includes('ui:save-backup') && nativeScope.channels.includes('ui:open-backup'));

  // Возврат из API.saveBackup/openBackup должен совпадать с общим {ok,data}-транспортом.
  const apiSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'api.js'), 'utf8');
  const downloads = []; let bridgeResult = { ok: true, data: { canceled: true } };
  const transport = { window: { wbApp: { invoke: async () => bridgeResult } }, document: { cookie: '' }, U: { download: (...args) => downloads.push(args) } };
  vm.runInNewContext(apiSource, transport);
  equal('API отмена сохранения не включает браузерное скачивание', await transport.window.API.saveBackup('a.wbpm.json', exported.content), null);
  equal('при отмене нативного сохранения скачиваний нет', downloads.length, 0);
  bridgeResult = { ok: true, data: { filePath: nativeFile } };
  equal('API возвращает нативный путь', await transport.window.API.saveBackup('a.wbpm.json', exported.content), nativeFile);
  bridgeResult = { ok: true, data: { canceled: true } };
  equal('API возвращает null при отмене открытия', await transport.window.API.openBackup(), null);
  bridgeResult = { ok: true, data: { content: exported.content, fileName: 'native.wbpm.json' } };
  equal('API возвращает открытое содержимое', (await transport.window.API.openBackup()).content, exported.content);
  bridgeResult = { ok: false, error: { code: 'BACKUP_FILE_SAVE', message: 'Запись запрещена' } };
  let safeFailure = false;
  try { await transport.window.API.saveBackup('a.wbpm.json', exported.content); } catch (error) { safeFailure = error.code === 'BACKUP_FILE_SAVE'; }
  check('ошибка нативного сохранения не заменяется тихим скачиванием', safeFailure && downloads.length === 0);

  const blobs = [], links = [];
  const browser = { Blob, setTimeout: (fn) => fn(),
    window: { URL: { createObjectURL: (blob) => { blobs.push(blob); return 'blob:test'; }, revokeObjectURL: () => {} } },
    document: { cookie: '', body: { appendChild: () => {} }, createElement: () => ({ click() { links.push(this.download); }, remove() {} }) }
  };
  vm.runInNewContext(apiSource, browser);
  equal('в браузере имя резервной копии сохраняется', await browser.window.API.saveBackup('browser.wbpm.json', exported.content), 'browser.wbpm.json');
  equal('в браузере скачивание получает JSON MIME', blobs[0].type, 'application/json;charset=utf-8');
  equal('браузерный JSON не получает BOM от CSV-утилиты', await blobs[0].text(), exported.content);
  equal('браузер скачивает ровно выбранное имя', links, ['browser.wbpm.json']);
}

main().catch((error) => { fail++; console.error('FAIL J: исключение прогона —', error.stack || error); }).finally(() => {
  for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  console.log(`\nИТОГО J: ${pass} пройдено, ${fail} ошибок`);
  process.exitCode = fail ? 1 : 0;
});
