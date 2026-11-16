'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const originalLoad = Module._load;

// Делает electron-updater заведомо отсутствующим: web-режим и менеджер
// обновлений должны обрабатывать это без падения процесса.
Module._load = function (request, parent, isMain) {
  if (request === 'electron-updater') {
    const error = new Error("Cannot find module 'electron-updater' (test)");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createUpdateManager } = require('../../electron/updater');
const { DEFAULT_SETTINGS } = require('../../electron/store');
const { createWebServer } = require('../web-server');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    assert.ok(fn());
    pass++;
    console.log('OK   ' + name);
  } catch (error) {
    fail++;
    console.log('FAIL ' + name + ' — ' + (error && error.message || error));
  }
}

async function run() {
  // Импорт web-server.js не должен пытаться загрузить electron-updater.
  check('web-server модуль загружается без electron-updater', () => typeof createWebServer === 'function');
  check('автоматическая проверка включена по умолчанию', () => DEFAULT_SETTINGS.autoUpdateEnabled === true);

  const missing = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    platform: 'win32'
  });
  await missing.initialize();
  check('отсутствующая devDependency даёт статус unavailable без аварии', () => missing.getState().status === 'unavailable');

  const dev = createUpdateManager({
    app: { isPackaged: false, getVersion: () => '1.0.0' },
    platform: 'win32',
    loadUpdater: () => { throw new Error('в dev не должно загружаться'); }
  });
  await dev.initialize();
  check('npm start в dev пропускает обновление', () => dev.getState().status === 'development');

  const fake = new EventEmitter();
  fake.calls = 0;
  fake.checkForUpdates = async () => { fake.calls++; return { updateInfo: { version: '1.1.0' } }; };
  fake.quitAndInstall = (silent, forceRun) => { fake.installed = [silent, forceRun]; };
  const sent = [];
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    platform: 'win32',
    updater: fake,
    emit: (state) => sent.push(state)
  });
  await manager.initialize();
  check('упакованная NSIS-сборка проверяет обновления', () => fake.calls === 1 && manager.getState().status === 'checking');
  check('фоновая загрузка включена, автоперезапуск выключен', () => fake.autoDownload === true && fake.autoInstallOnAppQuit === false);

  fake.emit('update-available', { version: '1.1.0' });
  check('событие новой версии отображается в состоянии', () => manager.getState().status === 'available' && manager.getState().updateVersion === '1.1.0');
  fake.emit('download-progress', { percent: 47.25 });
  check('прогресс фоновой загрузки сохраняется', () => manager.getState().status === 'downloading' && manager.getState().progress === 47.25);
  fake.emit('update-downloaded', { version: '1.1.0' });
  check('загруженное обновление ждёт явного перезапуска', () => manager.getState().status === 'downloaded' && manager.restartAndInstall() && fake.installed[0] === false && fake.installed[1] === true);
  check('состояния обновления отправляются в интерфейс', () => sent.some((item) => item.status === 'downloaded'));

  const offlineUpdater = new EventEmitter();
  offlineUpdater.checkForUpdates = async () => {
    const error = new Error('getaddrinfo ENOTFOUND github.com');
    error.code = 'ENOTFOUND';
    throw error;
  };
  const offline = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    platform: 'win32',
    updater: offlineUpdater
  });
  await offline.initialize();
  check('сетевой сбой обозначается отдельно от отсутствия новой версии', () => offline.getState().status === 'offline');

  const disabled = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    platform: 'win32',
    enabled: false,
    loadUpdater: () => { throw new Error('обновления выключены'); }
  });
  await disabled.initialize();
  check('отключённая настройка не загружает updater', () => disabled.getState().status === 'disabled');

  console.log(`ИТОГО: ${pass} пройдено, ${fail} ошибок`);
  Module._load = originalLoad;
  process.exit(fail ? 1 : 0);
}

run().catch((error) => {
  Module._load = originalLoad;
  console.error(error && error.stack || error);
  process.exit(1);
});
