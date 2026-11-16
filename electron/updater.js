'use strict';

/**
 * Автообновление установочной Windows-сборки через GitHub Releases.
 * electron-updater загружается только в упакованном Electron-приложении,
 * поэтому web-сервер, тесты и npm start не зависят от наличия этой devDependency.
 */
function createUpdateManager(options) {
  const o = options || {};
  const app = o.app || { isPackaged: false, getVersion: () => '' };
  const emit = typeof o.emit === 'function' ? o.emit : () => {};
  const platform = o.platform || process.platform;
  const isPortable = typeof o.isPortable === 'boolean'
    ? o.isPortable
    : !!process.env.PORTABLE_EXECUTABLE_FILE;
  let enabled = o.enabled !== false;
  let updater = o.updater || null;
  let attached = false;

  let state = {
    status: 'idle',
    currentVersion: safeVersion(),
    updateVersion: '',
    progress: null,
    error: '',
    checkedAt: null
  };

  function safeVersion() {
    try { return typeof app.getVersion === 'function' ? String(app.getVersion() || '') : ''; }
    catch (_) { return ''; }
  }

  function snapshot() { return Object.assign({}, state); }

  function publish(patch) {
    state = Object.assign({}, state, patch || {});
    try { emit(snapshot()); } catch (_) { /* уведомление не должно мешать проверке */ }
    return snapshot();
  }

  function isNetworkError(error) {
    const code = String(error && (error.code || error.errno) || '').toUpperCase();
    const message = String(error && error.message || error || '');
    return /^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK|ERR_INTERNET_DISCONNECTED)$/.test(code) ||
      /(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network|internet|offline|fetch failed|socket hang up)/i.test(message);
  }

  function recordError(error) {
    const message = String(error && error.message || error || 'Неизвестная ошибка');
    publish({
      status: isNetworkError(error) ? 'offline' : 'error',
      error: message,
      progress: null,
      checkedAt: new Date().toISOString()
    });
  }

  function ensureUpdater() {
    if (updater) {
      attachListeners();
      return true;
    }
    try {
      if (typeof o.loadUpdater === 'function') updater = o.loadUpdater();
      else updater = require('electron-updater').autoUpdater;
      if (!updater || typeof updater.checkForUpdates !== 'function') {
        throw new Error('electron-updater не предоставил autoUpdater');
      }
      attachListeners();
      return true;
    } catch (error) {
      const message = String(error && error.message || error);
      publish({ status: 'unavailable', error: message, progress: null });
      return false;
    }
  }

  function attachListeners() {
    if (attached || !updater || typeof updater.on !== 'function') return;
    attached = true;
    updater.on('checking-for-update', () => {
      publish({ status: 'checking', error: '', progress: null });
    });
    updater.on('update-available', (info) => {
      publish({
        status: 'available',
        updateVersion: String(info && info.version || ''),
        error: '',
        progress: null,
        checkedAt: new Date().toISOString()
      });
    });
    updater.on('update-not-available', (info) => {
      publish({
        status: 'not-available',
        updateVersion: String(info && info.version || ''),
        error: '',
        progress: null,
        checkedAt: new Date().toISOString()
      });
    });
    updater.on('download-progress', (progress) => {
      const value = Number(progress && progress.percent);
      publish({
        status: 'downloading',
        progress: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null,
        error: ''
      });
    });
    updater.on('update-downloaded', (info) => {
      publish({
        status: 'downloaded',
        updateVersion: String(info && info.version || state.updateVersion || ''),
        progress: 100,
        error: '',
        checkedAt: new Date().toISOString()
      });
    });
    updater.on('error', (error) => recordError(error));
  }

  function unavailableForEnvironment() {
    if (!app.isPackaged) {
      publish({ status: 'development', error: '', progress: null });
      return true;
    }
    if (platform !== 'win32') {
      publish({ status: 'unsupported', error: '', progress: null });
      return true;
    }
    if (isPortable) {
      publish({ status: 'portable', error: '', progress: null });
      return true;
    }
    return false;
  }

  async function checkNow(force) {
    if (!enabled && force !== true) {
      publish({ status: 'disabled', error: '', progress: null });
      return snapshot();
    }
    if (unavailableForEnvironment()) return snapshot();
    if (state.status === 'downloaded') return snapshot();
    if (!ensureUpdater()) return snapshot();

    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    publish({ status: 'checking', error: '', progress: null });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      // Обычно electron-updater также отправляет событие error; запись здесь
      // гарантирует статус даже у тестового/альтернативного адаптера без событий.
      recordError(error);
    }
    return snapshot();
  }

  async function initialize() {
    if (!enabled) {
      publish({ status: 'disabled', error: '', progress: null });
      return snapshot();
    }
    return checkNow();
  }

  async function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      if (updater) updater.autoDownload = false;
      if (state.status !== 'downloaded') publish({ status: 'disabled', error: '', progress: null });
      return snapshot();
    }
    if (state.status === 'downloaded') return snapshot();
    return checkNow();
  }

  function restartAndInstall() {
    if (state.status !== 'downloaded' || !updater || typeof updater.quitAndInstall !== 'function') {
      return false;
    }
    publish({ status: 'installing' });
    updater.quitAndInstall(false, true);
    return true;
  }

  return {
    initialize,
    checkNow,
    setEnabled,
    restartAndInstall,
    getState: snapshot
  };
}

module.exports = { createUpdateManager };
