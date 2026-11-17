'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Menu, nativeTheme, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('./store');
const { createService } = require('./service');
const { createUpdateManager } = require('./updater');
const { createBackupManager } = require('./backup');
const { createTelegramNotifier } = require('./notifications');
const { APP_NAME } = require('./config');

let win = null;
let store = null;
let service = null;
let updateManager = null;
let backupManager = null;
let telegramNotifier = null;

const DEV = process.argv.includes('--dev');

function makeSecretBox() {
  const available = (() => {
    try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
  })();
  return {
    available,
    encrypt(text) { return safeStorage.encryptString(String(text)).toString('base64'); },
    decrypt(b64) { return safeStorage.decryptString(Buffer.from(b64, 'base64')); }
  };
}

/**
 * Список каналов, которые реально зарегистрированы в основном процессе.
 * Передаётся в preload через additionalArguments, чтобы белый список моста
 * всегда совпадал с сервисом (раньше он был отдельной копией и расходился —
 * интерфейс получал «Неизвестный канал: data:refresh-all»).
 */
function registeredChannels() {
  const ui = [
    'ui:export-csv', 'ui:import-csv', 'ui:open-external', 'ui:app-info', 'ui:theme',
    'ui:update-state', 'ui:update-check', 'ui:update-enable', 'ui:update-restart'
  ];
  const svc = service && service.handlers ? Object.keys(service.handlers) : [];
  return Array.from(new Set(svc.concat(ui)));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 950,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--wb-channels=' + registeredChannels().join(',')],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: true
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

// Изолированное окно без доступа к Node и кукам основного окна. Не обходит
// антибот-защиту; для ручного просмотра лучше ui:open-external.
async function openPriceWatchHidden(url, opts) {
  const partition = 'pricewatch-' + crypto.randomBytes(12).toString('hex');
  const hidden = new BrowserWindow({ show: false, webPreferences: {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false
  } });
  const session = hidden.webContents.session;
  const allowed = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && /^(www\.)?wildberries\.ru$/i.test(u.hostname);
    } catch (_) { return false; }
  };
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }));
  hidden.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hidden.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  hidden.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  let timer;
  try {
    await Promise.race([
      hidden.loadURL(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('тайм-аут')), Math.min(10000, Number(opts && opts.timeoutMs) || 10000)); })
    ]);
    return { ok: true, url: hidden.webContents.getURL(), title: hidden.getTitle() };
  } catch (e) {
    return { ok: false, code: 'BROWSER', message: 'Не удалось открыть страницу: ' + e.message };
  } finally {
    clearTimeout(timer);
    if (!hidden.isDestroyed()) hidden.destroy();
    session.webRequest.onBeforeRequest(null);
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc() {
  for (const [channel, fn] of Object.entries(service.handlers)) {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try {
        const data = await fn(...args);
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: { message: e.message || String(e), code: e.code || '', status: e.status || 0, category: e.category || '' } };
      }
    });
  }

  ipcMain.handle('ui:export-csv', async (_e, payload) => {
    const { defaultPath, content } = payload || {};
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Сохранить CSV',
      defaultPath: defaultPath || 'export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'Все файлы', extensions: ['*'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, '\uFEFF' + content, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  });

  ipcMain.handle('ui:import-csv', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Выберите CSV-файл',
      properties: ['openFile'],
      filters: [{ name: 'CSV / TXT', extensions: ['csv', 'txt'] }]
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    return { ok: true, content: fs.readFileSync(filePaths[0], 'utf8').replace(/^\uFEFF/, '') };
  });

  /**
   * Выбор файла с отдачей содержимого в base64 — для XLSX (список товаров акции WB).
   * ui:import-csv не подходит: он читает файл как текст и портит двоичные данные.
   */
  ipcMain.handle('ui:import-file', async (_e, opts) => {
    const o = opts || {};
    const exts = Array.isArray(o.extensions) && o.extensions.length ? o.extensions : ['xlsx', 'csv', 'txt'];
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: o.title || 'Выберите файл',
      properties: ['openFile'],
      filters: [
        { name: o.filterName || 'Таблицы (XLSX, CSV)', extensions: exts },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const buf = fs.readFileSync(filePaths[0]);
    return {
      ok: true,
      fileName: path.basename(filePaths[0]),
      size: buf.length,
      base64: buf.toString('base64')
    };
  });

  ipcMain.handle('ui:open-external', async (_e, url) => { shell.openExternal(String(url)); return { ok: true }; });

  ipcMain.handle('ui:app-info', async () => ({
    ok: true,
    data: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      appDir: store.dir,
      encryption: safeStorage.isEncryptionAvailable() ? 'Доступно (safeStorage)' : 'Недоступно — ключи хранятся в base64'
    }
  }));

  ipcMain.handle('ui:theme', async (_e, theme) => {
    nativeTheme.themeSource = theme || 'dark';
    return { ok: true };
  });

  ipcMain.handle('ui:update-state', async () => ({
    ok: true,
    data: updateManager ? updateManager.getState() : { status: 'unavailable', error: 'Менеджер обновлений не запущен.' }
  }));

  ipcMain.handle('ui:update-check', async () => ({
    ok: true,
    data: updateManager ? await updateManager.checkNow(true) : { status: 'unavailable' }
  }));

  ipcMain.handle('ui:update-enable', async (_e, value) => {
    const enabled = !!value;
    const settings = store.saveSettings({ autoUpdateEnabled: enabled });
    const update = updateManager ? await updateManager.setEnabled(enabled) : null;
    return { ok: true, data: { settings, update } };
  });

  ipcMain.handle('ui:update-restart', async () => {
    if (!updateManager || !updateManager.restartAndInstall()) {
      return { ok: false, error: { message: 'Загруженного обновления для установки нет.' } };
    }
    return { ok: true, data: { started: true } };
  });
}

app.setName(APP_NAME);

// Модули расчётов одни и те же для main-процесса и интерфейса (window.EC, window.RP)
const ECON_FILES = {
  'economics.js': 'economics.js',
  'repricer-engine.js': 'repricer-engine.js'
};
try { protocol.registerSchemesAsPrivileged([{ scheme: 'econ', privileges: { standard: true, supportFetchAPI: true } }]); } catch (e) { /* older electron */ }

function econFileFor(urlStr) {
  const name = String(urlStr || '').replace(/^econ:\/\/\/?/, '').split('?')[0].split('/').filter(Boolean).pop() || 'economics.js';
  const file = ECON_FILES[name];
  return file ? path.join(__dirname, file) : null;
}

function registerEconProtocol() {
  if (protocol.handle) {
    protocol.handle('econ', (req) => {
      const file = econFileFor(req && req.url);
      if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(fs.readFileSync(file), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' }
      });
    });
  } else {
    protocol.registerFileProtocol('econ', (req, cb) => cb({ path: econFileFor(req.url) || path.join(__dirname, 'economics.js') }));
  }
}

app.on('before-quit', () => {
  if (backupManager) backupManager.stopScheduler();
  if (telegramNotifier) telegramNotifier.stop();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerEconProtocol();
    const dir = app.getPath('userData');
    store = createStore(dir, makeSecretBox());
    backupManager = createBackupManager({ store, dir, appVersion: app.getVersion() });
    backupManager.startScheduler();
    telegramNotifier = createTelegramNotifier({ store });
    service = createService(store, (channel, payload) => send('svc:' + channel, payload), { openHidden: openPriceWatchHidden }, {
      backupManager,
      telegramNotifier
    });
    updateManager = createUpdateManager({
      app,
      platform: process.platform,
      enabled: store.loadSettings().autoUpdateEnabled !== false,
      emit: (state) => send('svc:update-status', state)
    });

    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = 'dark';
    registerIpc();
    createWindow();
    updateManager.initialize().catch((error) => console.error('[updater] не удалось запустить проверку:', error.message));

    // автопересчёт цен по расписанию (если включён в настройках репрайсера)
    try {
      const st = service.applyScheduler();
      if (st.enabled) console.log('[repricer] планировщик запущен, следующий пересчёт:', st.nextRunAt);
    } catch (e) {
      console.error('[repricer] не удалось запустить планировщик:', e.message);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
