'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../electron/store');
const { createBackupManager, DATASETS, FORMAT } = require('../../electron/backup');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('test callback must be synchronous');
    assert.ok(result);
    pass++;
    console.log('OK   ' + name);
  } catch (error) {
    fail++;
    console.log('FAIL ' + name + ' — ' + (error && error.message || error));
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wbpm-' + label + '-'));
}
function seedData(dir, tag) {
  for (const item of DATASETS) {
    const value = item.shape === 'array'
      ? [{ id: item.key + '-' + tag, taskId: item.key + '-' + tag, at: '2026-01-01T00:00:00.000Z', value: tag }]
      : { items: { '1001': { dataset: item.key, value: tag }, '3003': { dataset: item.key, value: tag, added: true } }, meta: { dataset: item.key, value: tag }, custom: tag };
    if (item.key === 'settings') {
      value.shopName = tag;
      value.nested = { shared: tag, incoming: true };
    }
    fs.writeFileSync(path.join(dir, item.file), JSON.stringify(value, null, 2), 'utf8');
  }
}
function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}
function fakeSecretBox() {
  return { available: true, encrypt: (text) => Buffer.from(String(text), 'utf8').toString('base64'), decrypt: (b64) => Buffer.from(String(b64), 'base64').toString('utf8') };
}

function run() {
  const roots = [];
  try {
    const sourceDir = tempDir('backup-source'); roots.push(sourceDir);
    const targetDir = tempDir('backup-target'); roots.push(targetDir);
    const sourceStore = createStore(sourceDir, fakeSecretBox());
    const targetStore = createStore(targetDir, fakeSecretBox());
    seedData(sourceDir, 'from-source');
    sourceStore.saveSecrets({ single: 'wb-secret-value-1234567890', prices: 'prices-secret-value-1234567890', telegramBotToken: '123456789:telegram-secret-value-123456789012345678' });

    const sourceBackup = createBackupManager({ store: sourceStore, appVersion: '1.2.3' });
    const targetBackup = createBackupManager({ store: targetStore, appVersion: '1.2.3' });
    const exported = sourceBackup.exportBackup();
    const parsed = JSON.parse(exported.content);
    check('формат содержит версию, дату, версию приложения и оглавление', () => parsed.format === FORMAT && parsed.formatVersion === 1 && !!parsed.createdAt && parsed.appVersion === '1.2.3' && parsed.manifest.datasets.length === DATASETS.length);
    check('ключи по умолчанию исключены из выгрузки', () => !parsed.encryptedSecrets && !exported.content.includes('wb-secret-value-1234567890') && !exported.content.includes('telegram-secret-value'));

    const preview = targetBackup.importBackup({ action: 'preview', content: exported.content });
    check('предпросмотр показывает каждый набор данных до записи', () => preview.datasets.length === DATASETS.length && preview.datasets.every((row) => row.added > 0));
    const imported = targetBackup.importBackup({ action: 'apply', content: exported.content });
    check('round-trip импортирует все наборы данных', () => imported.applied && DATASETS.every((item) => JSON.stringify(readJson(targetDir, item.file)) === JSON.stringify(readJson(sourceDir, item.file))));
    check('импорт без ключей не меняет секреты и сохраняет safety backup', () => !targetStore.loadSecrets().single && fs.existsSync(path.join(targetBackup.backupsDir, imported.safetyBackup)));

    const mergeDir = tempDir('backup-merge'); roots.push(mergeDir);
    const mergeStore = createStore(mergeDir, fakeSecretBox());
    mergeStore.saveSettings({ shopName: 'Локальное название', localOnly: 'оставить', nested: { local: true, shared: 'локальное' } });
    fs.writeFileSync(path.join(mergeDir, 'costs.json'), JSON.stringify({ items: { '1001': { cost: 50, source: 'local' }, '2002': { cost: 20 } }, updatedAt: 'local' }), 'utf8');
    const mergeBackup = createBackupManager({ store: mergeStore });
    const mergePreview = mergeBackup.importBackup({ action: 'preview', content: exported.content });
    const settingsPreview = mergePreview.datasets.find((row) => row.key === 'settings');
    mergeBackup.importBackup({ action: 'apply', content: exported.content });
    const mergedSettings = readJson(mergeDir, 'settings.json');
    const mergedCosts = readJson(mergeDir, 'costs.json');
    check('слияние не затирает совпавшие значения без подтверждения', () => settingsPreview.preservedConflicts > 0 && mergedSettings.shopName === 'Локальное название' && mergedSettings.localOnly === 'оставить' && mergedSettings.nested.shared === 'локальное');
    check('слияние добавляет новые записи, не удаляя локальные', () => mergedCosts.items['1001'].source === 'local' && mergedCosts.items['1001'].dataset === 'costs' && mergedCosts.items['2002'].cost === 20 && mergedCosts.items['3003'].added === true);

    const replaceMergeDir = tempDir('backup-overwrite'); roots.push(replaceMergeDir);
    const replaceStore = createStore(replaceMergeDir, fakeSecretBox());
    replaceStore.saveSettings({ shopName: 'Локальное название' });
    const overwriteManager = createBackupManager({ store: replaceStore });
    let needsConfirmation = false;
    try { overwriteManager.importBackup({ action: 'apply', content: exported.content, overwriteExisting: true }); }
    catch (error) { needsConfirmation = error.code === 'CONFIRMATION_REQUIRED'; }
    check('перезапись конфликтов запрещена без явного подтверждения', () => needsConfirmation && readJson(replaceMergeDir, 'settings.json').shopName === 'Локальное название');
    overwriteManager.importBackup({ action: 'apply', content: exported.content, overwriteExisting: true, overwriteConfirmed: true });
    check('явно подтверждённый импорт заменяет конфликтующие значения', () => readJson(replaceMergeDir, 'settings.json').shopName === 'from-source');

    const encrypted = sourceBackup.exportBackup({ includeKeys: true, password: 'backup-pass-987' });
    check('секреты в выгрузке с ключами зашифрованы паролем', () => encrypted.content.includes('aes-256-gcm') && !encrypted.content.includes('wb-secret-value-1234567890') && !encrypted.content.includes('telegram-secret-value'));
    const keyTargetDir = tempDir('backup-keys'); roots.push(keyTargetDir);
    const keyStore = createStore(keyTargetDir, fakeSecretBox());
    keyStore.saveSecrets({ single: 'existing-wb-key', analytics: 'existing-analytics-key', telegramBotToken: 'target-telegram-token' });
    const keyBackup = createBackupManager({ store: keyStore });
    let passwordRejected = false;
    try { keyBackup.importBackup({ action: 'apply', content: encrypted.content, applyKeys: true, password: 'wrong-pass-123' }); }
    catch (error) { passwordRejected = error.code === 'BAD_PASSWORD'; }
    check('неверный пароль не запускает импорт и не меняет данные', () => passwordRejected && keyStore.loadSecrets().single === 'existing-wb-key' && !fs.existsSync(path.join(keyTargetDir, 'settings.json')));
    keyBackup.importBackup({ action: 'apply', content: encrypted.content, applyKeys: true, password: 'backup-pass-987' });
    check('верный пароль расшифровывает ключи WB, не затрагивая Telegram-токен и существующие ключи', () => keyStore.loadSecrets().single === 'existing-wb-key' && keyStore.loadSecrets().prices === 'prices-secret-value-1234567890' && keyStore.loadSecrets().telegramBotToken === 'target-telegram-token');

    const restoreDir = tempDir('backup-restore'); roots.push(restoreDir);
    const restoreStore = createStore(restoreDir, fakeSecretBox());
    seedData(restoreDir, 'before-restore');
    restoreStore.saveSecrets({ single: 'restore-directory-secret' });
    const restoreManager = createBackupManager({ store: restoreStore });
    const restoreFile = 'manual-upload.wbpm.json';
    fs.mkdirSync(restoreManager.backupsDir, { recursive: true });
    fs.writeFileSync(path.join(restoreManager.backupsDir, restoreFile), exported.content, 'utf8');
    let restoreConfirmationRequired = false;
    try { restoreManager.restoreBackup({ fileName: restoreFile }); }
    catch (error) { restoreConfirmationRequired = error.code === 'CONFIRMATION_REQUIRED'; }
    check('восстановление из списка требует явного подтверждения', () => restoreConfirmationRequired && readJson(restoreDir, 'settings.json').custom === 'before-restore');
    const restored = restoreManager.restoreBackup({ fileName: restoreFile, confirmed: true });
    check('восстановление заменяет наборы данных, сохраняет ключи и делает safety copy', () => restored.applied && restored.restoredFile === restoreFile && readJson(restoreDir, 'settings.json').custom === 'from-source' && restoreStore.loadSecrets().single === 'restore-directory-secret' && fs.existsSync(path.join(restoreManager.backupsDir, restored.safetyBackup)));

    const atomicDir = tempDir('backup-atomic'); roots.push(atomicDir);
    const atomicStore = createStore(atomicDir, fakeSecretBox());
    seedData(atomicDir, 'before-atomic-import');
    const atomicManager = createBackupManager({ store: atomicStore });
    const originals = new Map(DATASETS.map((item) => [item.file, fs.readFileSync(path.join(atomicDir, item.file), 'utf8')]));
    const realRenameSync = fs.renameSync;
    let injectedFailure = false;
    let atomicError = '';
    try {
      fs.renameSync = function (from, to) {
        if (!injectedFailure && path.resolve(to) === path.resolve(path.join(atomicDir, 'costs.json'))) {
          injectedFailure = true;
          throw new Error('test: injected second-file write failure');
        }
        return realRenameSync.call(this, from, to);
      };
      try { atomicManager.importBackup({ action: 'apply', content: exported.content, overwriteExisting: true, overwriteConfirmed: true }); }
      catch (error) { atomicError = error.code || ''; }
    } finally { fs.renameSync = realRenameSync; }
    check('ошибка посреди импорта атомарно откатывает все файлы', () => injectedFailure && atomicError === 'IMPORT_WRITE_FAILED' && DATASETS.every((item) => fs.readFileSync(path.join(atomicDir, item.file), 'utf8') === originals.get(item.file)));

    const stable = fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8');
    let corruptRejected = false;
    try { targetBackup.importBackup({ action: 'apply', content: '{broken json' }); }
    catch (error) { corruptRejected = /корректный JSON/.test(error.message); }
    check('битый JSON отклоняется до изменений и с понятной ошибкой', () => corruptRejected && fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8') === stable);
    const tampered = JSON.parse(exported.content);
    tampered.data.settings.custom = 'tampered';
    let checksumRejected = false;
    try { targetBackup.importBackup({ action: 'apply', content: JSON.stringify(tampered) }); }
    catch (error) { checksumRejected = /контрольная сумма/.test(error.message); }
    check('повреждённый набор по контрольной сумме не применяется', () => checksumRejected && fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8') === stable);
    const incompatible = JSON.parse(exported.content); incompatible.formatVersion = 99;
    let versionRejected = false;
    try { targetBackup.importBackup({ action: 'preview', content: incompatible }); }
    catch (error) { versionRejected = error.code === 'INCOMPATIBLE_FORMAT' && /несовместима/.test(error.message); }
    check('несовместимая версия формата объяснена до импорта', () => versionRejected);

    const rotationDir = tempDir('backup-rotation'); roots.push(rotationDir);
    const rotationStore = createStore(rotationDir, fakeSecretBox());
    rotationStore.saveSettings({ backupSchedule: 'daily', backupRetention: 2 });
    let time = Date.UTC(2026, 0, 1);
    const rotation = createBackupManager({ store: rotationStore, now: () => new Date(time) });
    rotation.createAutomaticBackup(); time += 86400000; rotation.createAutomaticBackup(); time += 86400000; rotation.createAutomaticBackup();
    const automatic = rotation.listBackups().backups.filter((entry) => entry.backupType === 'automatic');
    check('автобэкап ротируется и сохраняет последние N файлов', () => automatic.length === 2 && automatic.every((entry) => !entry.corrupt));
  } finally {
    for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log(`\nИТОГО: ${pass} пройдено, ${fail} ошибок`);
  if (fail) process.exitCode = 1;
}

run();
