'use strict';

/**
 * Профиль кабинета WB: отдельные store, WBClient, лимитеры, кэши, очереди,
 * планировщики, резервные копии и Telegram. Смена выбранного кабинета меняет
 * только маршрутизацию новых вызовов; уже начатая операция остаётся у владельца.
 * В фиксированном веб-режиме остальные профили даже не создают сервисов.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PROFILES_DIR, PROFILES_FILE, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME,
  BACKUPS_DIR, SECRETS_FILE
} = require('./config');
const { createStore } = require('./store');
const { DATASETS, FORMAT, FORMAT_VERSION, createBackupManager, recoverTransactions } = require('./backup');

const PROFILES_FORMAT_VERSION = 1;
const MIGRATION_FILE = '.profiles-migration.json';

function profileError(message, code) {
  return Object.assign(new Error(message), { code: code || 'PROFILE_ERROR' });
}

/** В том числе исключаем зарезервированные имена каталогов Windows. */
function sanitizeProfileId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id) ? id : '';
}
function sanitizeProfileName(value) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120); }
function uid() { return 'p-' + crypto.randomBytes(6).toString('hex'); }

function createProfileHub(options) {
  const o = options || {};
  if (!o.dataDir || typeof o.createService !== 'function') throw new Error('profiles: нужны dataDir и createService');
  const dataDir = path.resolve(o.dataDir);
  const profilesRoot = path.join(dataDir, PROFILES_DIR);
  const registryPath = path.join(dataDir, PROFILES_FILE);
  const migrationPath = path.join(dataDir, MIGRATION_FILE);
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const broadcast = typeof o.broadcast === 'function' ? o.broadcast : () => {};
  const appVersion = String(o.appVersion || 'unknown');
  const requestedId = o.profileId ? sanitizeProfileId(o.profileId) : '';
  if (o.profileId && !requestedId) throw profileError('Недопустимый идентификатор профиля в параметрах запуска.', 'PROFILE_ID');
  const switchable = o.switchable !== false && !requestedId;
  const byId = new Map();
  let started = false;
  let closed = false;

  function checkedId(value) {
    const id = sanitizeProfileId(value);
    if (!id || id !== value) throw profileError('Недопустимый идентификатор профиля.', 'PROFILE_ID');
    return id;
  }
  function directory(dir) {
    if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())) {
      throw profileError('Каталог профилей не должен быть файлом или символической ссылкой.', 'PROFILE_PATH');
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  function profileDir(id) { return path.join(profilesRoot, checkedId(id)); }
  function atomicJson(file, value) {
    const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
  }
  function validateRegistry(reg) {
    if (!reg || reg.version !== PROFILES_FORMAT_VERSION || !Array.isArray(reg.profiles) || !reg.profiles.length) {
      throw profileError('Регистр profiles.json имеет неизвестный формат. Восстановите его из копии; данные не изменены.', 'PROFILES_REGISTRY');
    }
    const ids = new Set();
    for (const p of reg.profiles) {
      if (!p || typeof p.id !== 'string' || checkedId(p.id) !== p.id || ids.has(p.id) || typeof p.name !== 'string' || !sanitizeProfileName(p.name)) {
        throw profileError('В profiles.json некорректные или повторяющиеся профили. Данные не изменены.', 'PROFILES_REGISTRY');
      }
      ids.add(p.id);
    }
    if (!ids.has(reg.activeId)) throw profileError('Активный профиль из profiles.json не найден. Данные не изменены.', 'PROFILES_REGISTRY');
    return reg;
  }
  function readRegistry() {
    if (!fs.existsSync(registryPath)) return null;
    let reg;
    try { reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
    catch (_) { throw profileError('Не удалось прочитать profiles.json. Повторная миграция не выполнялась; восстановите регистр из копии.', 'PROFILES_REGISTRY'); }
    return validateRegistry(reg);
  }
  function writeRegistry(reg) { validateRegistry(reg); atomicJson(registryPath, reg); }
  function defaultRegistry() {
    return { version: PROFILES_FORMAT_VERSION, activeId: DEFAULT_PROFILE_ID,
      profiles: [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, createdAt: now().toISOString() }] };
  }
  function dataFileNames() { return [...new Set(DATASETS.map((item) => item.file).concat([SECRETS_FILE]))]; }

  /**
   * Возобновляемый перенос на том же диске. Сначала откат незавершённого импорта J
   * в старом корне, затем журнал перемещений. Регистр публикуется только ПОСЛЕ
   * переноса всех файлов, secrets и backups. При сбое/перезапуске уже перенесённые
   * записи не перезаписываются; конфликт никогда не трактуется как пустой кабинет.
   * web-sessions.json намеренно остаётся глобальным файлом в старом корне.
   */
  function migrate() {
    directory(dataDir);
    const existing = readRegistry();
    if (existing) {
      try { fs.rmSync(migrationPath, { force: true }); } catch (_) {}
      return existing;
    }
    directory(profilesRoot);
    let journal;
    if (fs.existsSync(migrationPath)) {
      try { journal = JSON.parse(fs.readFileSync(migrationPath, 'utf8')); }
      catch (_) { throw profileError('Повреждён журнал переноса профилей. Файлы сохранены, требуется восстановление журнала.', 'PROFILE_MIGRATION'); }
      const allowed = new Set(dataFileNames().concat([BACKUPS_DIR]));
      if (!journal || journal.version !== 1 || !Array.isArray(journal.files) ||
          journal.files.some((f) => !allowed.has(f)) || new Set(journal.files).size !== journal.files.length) {
        throw profileError('Некорректный журнал переноса профилей. Данные не изменены.', 'PROFILE_MIGRATION');
      }
    } else {
      // Сиротские каталоги не присоединяем автоматически: это мог быть утраченный
      // регистр с боевыми данными нескольких магазинов.
      if (fs.readdirSync(profilesRoot).length) throw profileError('Найдены каталоги профилей без profiles.json. Восстановите регистр; повторный перенос не выполнялся.', 'PROFILES_REGISTRY_MISSING');
      recoverTransactions(dataDir);
      journal = { version: 1, files: dataFileNames().concat([BACKUPS_DIR]).filter((f) => fs.existsSync(path.join(dataDir, f))) };
      atomicJson(migrationPath, journal);
    }
    const target = directory(profileDir(DEFAULT_PROFILE_ID));
    for (const file of journal.files) {
      const from = path.join(dataDir, file), to = path.join(target, file);
      const source = fs.existsSync(from), dest = fs.existsSync(to);
      if (source && dest) throw profileError('Конфликт переноса «' + file + '»: обе копии сохранены. Нельзя выбирать одну молча.', 'PROFILE_MIGRATION_CONFLICT');
      if (!source && !dest) throw profileError('Не найден файл переноса «' + file + '». Миграция приостановлена.', 'PROFILE_MIGRATION');
      if (source) {
        if (fs.lstatSync(from).isSymbolicLink()) throw profileError('Нельзя переносить символическую ссылку вместо данных.', 'PROFILE_PATH');
        fs.renameSync(from, to); // ошибка, в том числе backups, не проглатывается
      }
    }
    const reg = defaultRegistry();
    writeRegistry(reg);
    fs.rmSync(migrationPath, { force: true });
    return reg;
  }

  const registry = migrate();
  directory(profilesRoot);
  let activeId = requestedId || registry.activeId;
  const fixedProfileId = switchable ? '' : activeId;
  const handlers = Object.create(null);

  function allowedId(value) {
    const id = value === undefined || value === null || value === '' ? activeId : checkedId(value);
    if (!switchable && id !== fixedProfileId) throw profileError('Доступ к другому профилю в этом режиме недоступен.', 'PROFILE_FORBIDDEN');
    return id;
  }
  function getProfile(id) { return byId.get(allowedId(id)) || null; }
  function getActive() { return byId.get(activeId) || null; }
  function getActiveStore() { const p = getActive(); return p ? p.store : null; }
  function requireProfile(id) {
    if (closed) throw profileError('Менеджер профилей остановлен.', 'PROFILE_CLOSED');
    const p = getProfile(id);
    if (!p) throw profileError('Профиль не найден.', 'PROFILE_NOT_FOUND');
    return p;
  }
  function busy(p) {
    return p.calls > 0 || !!(p.service.isBusy && p.service.isBusy()) || !!(p.telegramNotifier && p.telegramNotifier.isBusy && p.telegramNotifier.isBusy());
  }
  function startProfile(p) {
    p.backupManager.startScheduler();
    if (typeof p.service.applyScheduler === 'function') p.service.applyScheduler();
  }
  function stopProfile(p) {
    if (p.service.dispose) p.service.dispose();
    else if (p.service.stopScheduler) p.service.stopScheduler();
    p.backupManager.stopScheduler();
    if (p.telegramNotifier) p.telegramNotifier.stop();
  }

  function instantiate(meta) {
    directory(profilesRoot);
    const p = { ...meta, dir: directory(profileDir(meta.id)), calls: 0 };
    p.store = createStore(p.dir, o.secretBox || null);
    p.backupManager = createBackupManager({ store: p.store, dir: p.dir, appVersion, now });
    p.telegramNotifier = o.createTelegramNotifier
      ? o.createTelegramNotifier({ store: p.store, fetch: o.fetch, now, batchDelayMs: o.notifyBatchDelayMs }) : null;
    try {
      p.service = o.createService(p.store, (channel, payload) => {
        // Неактивный кабинет продолжает свои фоновые операции, но не меняет UI
        // другого кабинета. Метка также защищает от запоздавшей доставки IPC/SSE.
        if (!closed && byId.get(p.id) === p && p.id === activeId) {
          broadcast(channel, Object.assign({}, payload, { profileId: p.id, profileName: p.name }));
        }
      }, o.electron || null, { backupManager: p.backupManager, telegramNotifier: p.telegramNotifier, profileId: p.id, profileName: () => p.name });
      if (!p.service || !p.service.handlers) throw new Error('Нет обработчиков сервиса профиля.');
      return p;
    } catch (error) {
      p.backupManager.stopScheduler();
      if (p.telegramNotifier) p.telegramNotifier.stop();
      throw error; // нельзя показывать успешный пустой профиль вместо ошибки чтения
    }
  }

  async function callProfile(p, channel, args) {
    if (!p || closed || byId.get(p.id) !== p) throw profileError('Профиль недоступен.', 'PROFILE_CLOSED');
    const fn = p.service.handlers[channel];
    if (typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(p.service.handlers, channel)) throw profileError('Неизвестный канал: ' + channel, 'UNKNOWN_CHANNEL');
    const payload = args && args[0];
    const restoring = channel === 'backup:restore' || (channel === 'backup:import' && payload && payload.action === 'apply');
    if (restoring && busy(p)) throw profileError('В кабинете выполняется операция. Дождитесь её окончания перед импортом.', 'PROFILE_BUSY');
    p.calls++;
    try { return await fn(...(args || [])); }
    finally { p.calls--; }
  }
  function installRoutes(p) {
    for (const channel of Object.keys(p.service.handlers)) {
      if (Object.prototype.hasOwnProperty.call(handlers, channel)) continue;
      // Здесь замыкается ТОЛЬКО имя канала, а не функция первого профиля.
      // Даже Object.entries(handlers) в Electron оставляет маршрутизацию динамической.
      handlers[channel] = (...args) => callProfile(requireProfile(activeId), channel, args);
    }
  }
  function addProfile(meta) {
    const p = instantiate(meta);
    byId.set(p.id, p);
    installRoutes(p);
    if (started) startProfile(p);
    return p;
  }

  if (requestedId && !registry.profiles.some((p) => p.id === requestedId)) {
    if (fs.existsSync(profileDir(requestedId))) throw profileError('Найден каталог профиля без записи в регистре. Восстановите регистр перед запуском.', 'PROFILES_REGISTRY_MISSING');
    const meta = { id: requestedId, name: requestedId, createdAt: now().toISOString() };
    const next = { ...registry, profiles: registry.profiles.concat([meta]) };
    writeRegistry(next);
    registry.profiles = next.profiles;
  }

  function listProfiles() {
    return Array.from(byId.values()).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt,
      active: p.id === activeId, switchable,
      hasData: dataFileNames().some((file) => fs.existsSync(path.join(p.dir, file))),
      secretsMethod: p.store.secretsMethod ? p.store.secretsMethod() : null }));
  }
  function createProfile(nameInput) {
    if (closed) throw profileError('Менеджер профилей остановлен.', 'PROFILE_CLOSED');
    if (!switchable) throw profileError('Создание профилей в этом режиме недоступно.', 'PROFILE_FORBIDDEN');
    const name = sanitizeProfileName(nameInput);
    if (!name) throw profileError('Имя профиля не может быть пустым.', 'PROFILE_NAME');
    let id = uid();
    while (registry.profiles.some((p) => p.id === id) || fs.existsSync(profileDir(id))) id = uid();
    const meta = { id, name, createdAt: now().toISOString() };
    const p = instantiate(meta);
    const next = { ...registry, profiles: registry.profiles.concat([meta]) };
    try { writeRegistry(next); }
    catch (error) { stopProfile(p); throw error; }
    registry.profiles = next.profiles;
    byId.set(id, p); installRoutes(p);
    if (started) startProfile(p);
    return p;
  }
  function renameProfile(id, nameInput) {
    const p = requireProfile(id);
    const name = sanitizeProfileName(nameInput);
    if (!name) throw profileError('Имя профиля не может быть пустым.', 'PROFILE_NAME');
    const next = { ...registry, profiles: registry.profiles.map((x) => x.id === p.id ? { ...x, name } : x) };
    writeRegistry(next);
    registry.profiles = next.profiles;
    p.name = name;
    return p;
  }
  function removeProfile(id) {
    if (!switchable) throw profileError('Удаление профилей в этом режиме недоступно.', 'PROFILE_FORBIDDEN');
    const p = requireProfile(id);
    if (p.id === DEFAULT_PROFILE_ID) throw profileError('Профиль по умолчанию удалять нельзя.');
    if (p.id === activeId) throw profileError('Нельзя удалить активный профиль: сначала переключитесь на другой.');
    if (busy(p)) throw profileError('В кабинете выполняется операция. Дождитесь её окончания перед удалением.', 'PROFILE_BUSY');
    const next = { ...registry, profiles: registry.profiles.filter((x) => x.id !== p.id) };
    const trash = path.join(dataDir, '.removed-profile-' + p.id + '-' + crypto.randomBytes(5).toString('hex'));
    // Синхронный участок: таймеры не вклинятся между rename, записью и stop.
    // Если запись регистра не удалась, данные возвращаются на прежний путь.
    fs.renameSync(p.dir, trash);
    try { writeRegistry(next); }
    catch (error) { fs.renameSync(trash, p.dir); throw error; }
    stopProfile(p);
    byId.delete(p.id);
    registry.profiles = next.profiles;
    fs.rmSync(trash, { recursive: true, force: true });
  }
  async function exportProfile(payload) {
    const q = payload || {}, p = requireProfile(q.profileId);
    const result = await callProfile(p, 'backup:export', [{ includeKeys: q.includeKeys === true, password: q.password || '' }]);
    return { ...result, profileId: p.id, profileName: p.name, format: FORMAT, formatVersion: FORMAT_VERSION };
  }
  async function importProfile(payload) {
    const q = payload || {}, p = requireProfile(q.profileId);
    // Только содержимое, никогда переданный браузером путь. Используем сервис J:
    // он сбрасывает клиент/кэши/догрузки и переустанавливает расписание после apply.
    const result = await callProfile(p, 'backup:import', [{ content: q.content, action: q.action,
      mode: q.mode, overwriteExisting: q.overwriteExisting === true,
      overwriteConfirmed: q.overwriteConfirmed === true, applyKeys: q.applyKeys === true, password: q.password || '' }]);
    return { ...result, profileId: p.id, profileName: p.name };
  }

  /** Только локальные снимки. Несопоставимые периоды/демо не складываются молча. */
  async function plSummary() {
    const rows = [];
    for (const p of byId.values()) {
      let entry;
      try { entry = await callProfile(p, 'reports:pl', [{ cachedOnly: true }]); }
      catch (error) { entry = { ok: false, empty: true, message: error.message }; }
      rows.push({ ...entry, profileId: p.id, profileName: p.name });
    }
    const valid = rows.filter((r) => r.ok && r.totals);
    const periods = new Set(valid.map((r) => (r.meta && r.meta.dateFrom || '') + '/' + (r.meta && r.meta.dateTo || '') + '/' + (r.meta && r.meta.period || 'daily')));
    const periodsDiffer = periods.size > 1;
    const mixedModes = new Set(valid.map((r) => !!r.demo)).size > 1;
    const canAggregate = valid.length > 0 && !periodsDiffer && !mixedModes;
    let totals = null;
    if (canAggregate) {
      totals = {};
      for (const k of ['salesQty', 'returnsQty', 'revenue', 'commission', 'logistics', 'storage', 'acceptance', 'acquiring', 'penalties', 'forPay', 'wbAfterLogistics', 'cogs', 'packaging', 'ad', 'tax', 'profit', 'forPayFromWb']) {
        totals[k] = Math.round(valid.reduce((sum, r) => sum + (Number(r.totals[k]) || 0), 0) * 100) / 100;
      }
      totals.marginPct = totals.revenue ? Math.round(totals.profit / totals.revenue * 10000) / 100 : 0;
      totals.commissionPct = totals.revenue ? Math.round(totals.commission / totals.revenue * 10000) / 100 : 0;
    }
    return { ok: true, profiles: rows, totals, count: valid.length, empty: !valid.length,
      canAggregate, periodsDiffer, mixedModes, fixedProfile: !switchable,
      period: valid[0] ? { dateFrom: (valid[0].meta || {}).dateFrom, dateTo: (valid[0].meta || {}).dateTo } : null };
  }

  Object.assign(handlers, {
    'profiles:list': async () => ({ activeId, switchable, profiles: listProfiles() }),
    'profiles:switch': async (q) => {
      if (!switchable) throw profileError('Переключение профилей в этом режиме недоступно.', 'PROFILE_FORBIDDEN');
      const p = requireProfile(q && q.profileId);
      const next = { ...registry, activeId: p.id };
      writeRegistry(next); registry.activeId = p.id; activeId = p.id;
      return { ok: true, activeId };
    },
    'profiles:create': async (q) => { const p = createProfile(q && q.name); return { ok: true, profile: { id: p.id, name: p.name, createdAt: p.createdAt } }; },
    'profiles:rename': async (q) => { const p = renameProfile(q && q.profileId, q && q.name); return { ok: true, profile: { id: p.id, name: p.name } }; },
    'profiles:remove': async (q) => { if (!q || !q.profileId) throw profileError('Не указан профиль.'); removeProfile(q.profileId); return { ok: true }; },
    'profiles:export': exportProfile,
    'profiles:import': importProfile,
    'profiles:pl-summary': plSummary,
    'app:state': async () => {
      const p = requireProfile(activeId);
      const base = await callProfile(p, 'app:state', []);
      return { ...base, activeProfileId: p.id, activeProfileName: p.name, switchable,
        profiles: listProfiles().map((x) => ({ ...x, active: x.id === p.id })) };
    },
    // Контекст renderer: запоздавшее действие старой карточки не должно случайно
    // записать данные в новый кабинет. Нельзя обойти фиксацию или вложить profiles:*.
    'profiles:invoke': async (q) => {
      if (!q || checkedId(q.profileId) !== activeId) throw profileError('Кабинет изменился. Повторите действие в текущем профиле.', 'PROFILE_CHANGED');
      if (typeof q.channel !== 'string' || q.channel.startsWith('profiles:') || !Array.isArray(q.args)) throw profileError('Некорректный профильный вызов.', 'UNKNOWN_CHANNEL');
      if (q.channel === 'app:state') return handlers['app:state']();
      return callProfile(requireProfile(activeId), q.channel, q.args);
    }
  });

  try {
    for (const meta of registry.profiles) if (switchable || meta.id === activeId) addProfile(meta);
  } catch (error) {
    for (const p of byId.values()) stopProfile(p);
    throw error;
  }

  function startAllSchedulers() {
    if (closed) return;
    started = true;
    for (const p of byId.values()) startProfile(p);
  }
  function stopAllSchedulers() {
    closed = true; started = false;
    for (const p of byId.values()) stopProfile(p);
  }
  function applyScheduler() { const p = requireProfile(activeId); return p.service.applyScheduler ? p.service.applyScheduler() : { enabled: false }; }

  return { handlers, dataDir, profilesRoot, registryPath, activeId: () => activeId,
    listProfiles, getProfile, getActive, getActiveStore, createProfile, renameProfile,
    removeProfile, exportProfile, importProfile, plSummary, applyScheduler,
    startAllSchedulers, stopAllSchedulers,
    _byId: byId, _registry: registry, _switchable: () => switchable, _fixedProfileId: () => fixedProfileId };
}

module.exports = { createProfileHub, sanitizeProfileId, sanitizeProfileName, PROFILES_FORMAT_VERSION, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME };
