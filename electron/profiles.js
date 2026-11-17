'use strict';

/**
 * Управление несколькими кабинетами WB в одном приложении.
 *
 * Профиль = { id, name, createdAt } + свои данные и ключи в каталоге
 * `<dataDir>/profiles/<id>/`. Каждый профиль получает собственный `createStore`,
 * собственный `WBClient` (и, соответственно, собственные лимиты WB по категориям)
 * и собственный модуль резервного копирования. Все кэши, планировщик репрайсера,
 * очереди догрузки и журнал действий живут внутри сервиса профиля — поэтому
 * переключение профиля не сбрасывает кэши другого профиля, а два профиля не
 * видят данные и лимиты друг друга.
 *
 * Существующий каталог данных (`.data` без `profiles.json`) при первом запуске
 * переносится в профиль по умолчанию («Основной») без потери данных: все файлы
 * данных и каталог резервных копий перемещаются в `profiles/default/`.
 *
 * Экспорт/импорт профиля использует формат задания J (`wb-price-manager-backup`,
 * v1) — тот же, что и у резервных копий, потому что профиль и есть набор данных
 * приложения для одного кабинета.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PROFILES_DIR, PROFILES_FILE, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME,
  BACKUPS_DIR, SECRETS_FILE, WB_SECRET_NAMES
} = require('./config');
const { createStore } = require('./store');
const { createBackupManager, DATASETS, FORMAT, FORMAT_VERSION } = require('./backup');
const { BackupError } = require('./backup');

const PROFILES_FORMAT_VERSION = 1;

/** Идентификатор профиля: буквы, цифры, дефис, подчёркивание; длина 1..64. */
function sanitizeProfileId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return '';
  return id;
}

/** Очистка имени профиля для отображения. */
function sanitizeProfileName(value) {
  return String(value || '').trim().slice(0, 120);
}

function uid() {
  return 'p-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Создать «прокси-хранилище», который перенаправляет все вызовы на хранилище
 * активного профиля. Используется для глобального модуля уведомлений Telegram:
 * конфигурация бота читается из активного профиля, поэтому при переключении
 * профиля уведомления работают по выбранному кабинету без пересоздания модуля.
 */
function makeActiveStoreProxy(getActiveStore) {
  return new Proxy({}, {
    get(_target, prop) {
      const store = getActiveStore();
      if (!store) return undefined;
      const value = store[prop];
      return typeof value === 'function' ? value.bind(store) : value;
    }
  });
}

function createProfileHub(options) {
  const o = options || {};
  const dataDir = path.resolve(o.dataDir);
  const secretBox = o.secretBox || null;
  const appVersion = String(o.appVersion || 'unknown');
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const broadcast = typeof o.broadcast === 'function' ? o.broadcast : () => {};
  const electron = o.electron || null;
  const createServiceFn = o.createService;
  if (typeof createServiceFn !== 'function') throw new Error('profiles: createService обязателен');
  const createTelegramNotifierFn = o.createTelegramNotifier || null;
  // может быть задано, чтобы зафиксировать профиль (веб-сервер) и/или запретить переключение
  const fixedProfileId = o.profileId ? sanitizeProfileId(o.profileId) : '';
  const switchable = o.switchable !== false && !fixedProfileId;

  const profilesRoot = path.join(dataDir, PROFILES_DIR);
  const registryPath = path.join(dataDir, PROFILES_FILE);

  // ───────────────────────── registry ─────────────────────────

  function defaultRegistry() {
    return {
      version: PROFILES_FORMAT_VERSION,
      activeId: DEFAULT_PROFILE_ID,
      profiles: [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, createdAt: now().toISOString() }]
    };
  }

  function readRegistry() {
    try {
      if (!fs.existsSync(registryPath)) return null;
      const raw = fs.readFileSync(registryPath, 'utf8');
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.profiles)) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeRegistry(reg) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = registryPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    fs.renameSync(tmp, registryPath);
  }

  /** Файлы данных, которые перемещаем при миграции (наборы данных + секреты). */
  function dataFileNames() {
    const names = DATASETS.map((item) => item.file);
    if (SECRETS_FILE && !names.includes(SECRETS_FILE)) names.push(SECRETS_FILE);
    return names;
  }

  /**
   * Миграция существующего каталога данных в профиль по удобству.
   *
   * Выполняется один раз: когда `profiles.json` ещё нет, но в каталоге есть
   * файлы данных приложения (или каталог резервных копий). Переносим их в
   * `profiles/default/` и создаём регистр профилей. Если каталог пуст — просто
   * создаём регистр с профилем по умолчанию (первый запуск с нуля).
   */
  function migrate() {
    const existing = readRegistry();
    if (existing) return existing;

    const hasDataFiles = dataFileNames().some((f) => fs.existsSync(path.join(dataDir, f)));
    const hasBackups = fs.existsSync(path.join(dataDir, BACKUPS_DIR));
    if (!hasDataFiles && !hasBackups) {
      const reg = defaultRegistry();
      writeRegistry(reg);
      return reg;
    }

    // создаём каталог профиля по умолчанию и переносим данные
    const targetDir = path.join(profilesRoot, DEFAULT_PROFILE_ID);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of dataFileNames()) {
      const from = path.join(dataDir, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(targetDir, name));
    }
    if (hasBackups) {
      const fromBackups = path.join(dataDir, BACKUPS_DIR);
      const toBackups = path.join(targetDir, BACKUPS_DIR);
      try { fs.renameSync(fromBackups, toBackups); } catch (_) { /* если занято — оставляем */ }
    }
    const reg = defaultRegistry();
    writeRegistry(reg);
    return reg;
  }

  const registry = migrate();

  // активный профиль: фиксированный (веб-сервер) или из регистра
  let activeId = fixedProfileId || (registry.activeId && registry.profiles.some((p) => p.id === registry.activeId)
    ? registry.activeId : DEFAULT_PROFILE_ID);

  // ───────────────────────── служебные ─────────────────────────

  const byId = new Map(); // id → профиль (с хранилищем и сервисом)

  function profileDir(id) {
    return path.join(profilesRoot, id);
  }

  function ensureProfileDir(id) {
    fs.mkdirSync(profileDir(id), { recursive: true });
    return profileDir(id);
  }

  /**
   * Создать сервис для одного профиля: хранилище + модуль резерва + уведомления + createService.
   * Все обращённые объекты (кэш, клиент, лимиты, планировщик) живут внутри сервиса,
   * поэтому профили не пересекаются. Telegram-уведомления и резервные копии тоже
   * принадлежат профилю: разные кабинеты могут иметь разные токены бота и
   * разные копии данных.
   */
  function instantiate(profile) {
    const dir = ensureProfileDir(profile.id);
    const store = createStore(dir, secretBox);
    const backupManager = createBackupManager({ store, dir, appVersion, now });
    const telegramNotifier = createTelegramNotifierFn
      ? createTelegramNotifierFn({ store, fetch: o.fetch, now, batchDelayMs: o.notifyBatchDelayMs })
      : null;
    const service = createServiceFn(store, broadcast, electron, { backupManager, telegramNotifier });
    return { ...profile, dir, store, backupManager, telegramNotifier, service };
  }

  // мгновенно создаём сервисы для всех профилей из регистра
  for (const meta of registry.profiles) {
    if (!byId.has(meta.id)) {
      try { byId.set(meta.id, instantiate(meta)); }
      catch (e) {
        // если сервис не получилось создать (например, нет createService в тесте),
        // оставляем мета без сервиса — список профилей всё равно работает
        byId.set(meta.id, { ...meta, dir: profileDir(meta.id), store: createStore(profileDir(meta.id), secretBox), backupManager: null, service: null, error: e && e.message });
      }
    }
  }

  /**
   * Создать профиль с заданным id (для фиксированного профиля веб-сервера:
   * `--profile`). Если профиль уже есть — возвращает его.
   */
  function ensureProfile(id, name) {
    if (byId.has(id)) return byId.get(id);
    const meta = { id, name: sanitizeProfileName(name) || id, createdAt: now().toISOString() };
    registry.profiles.push(meta);
    writeRegistry(registry);
    const profile = instantiate(meta);
    byId.set(id, profile);
    return profile;
  }

  // фиксированный профиль (веб-сервер): если не существует — создаём
  if (fixedProfileId && !byId.has(fixedProfileId)) {
    ensureProfile(fixedProfileId, fixedProfileId);
  }

  function getProfile(id) {
    return byId.get(id) || null;
  }

  function getActive() {
    return byId.get(activeId) || byId.get(DEFAULT_PROFILE_ID) || null;
  }

  function getActiveStore() {
    const p = getActive();
    return p ? p.store : null;
  }

  function setActive(id) {
    if (!byId.has(id)) throw new Error('Профиль не найден: ' + id);
    activeId = id;
    registry.activeId = id;
    writeRegistry(registry);
  }

  /** Список профилей для интерфейса. */
  function listProfiles() {
    return Array.from(byId.values()).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      active: p.id === activeId,
      switchable,
      hasData: hasProfileData(p.id),
      secretsMethod: p.store && p.store.secretsMethod ? p.store.secretsMethod() : null
    }));
  }

  function hasProfileData(id) {
    const dir = profileDir(id);
    if (!fs.existsSync(dir)) return false;
    return dataFileNames().some((f) => fs.existsSync(path.join(dir, f)));
  }

  /** Создать новый профиль. */
  function createProfile(nameInput) {
    const name = sanitizeProfileName(nameInput) || 'Профиль';
    let id = uid();
    // избегаем коллизий с существующими id
    while (byId.has(id)) id = uid();
    const meta = { id, name, createdAt: now().toISOString() };
    registry.profiles.push(meta);
    writeRegistry(registry);
    const profile = instantiate(meta);
    byId.set(id, profile);
    return profile;
  }

  /** Переименовать профиль. */
  function renameProfile(id, nameInput) {
    const p = byId.get(id);
    if (!p) throw new Error('Профиль не найден: ' + id);
    const name = sanitizeProfileName(nameInput);
    if (!name) throw new Error('Имя профиля не может быть пустым');
    p.name = name;
    for (const meta of registry.profiles) if (meta.id === id) meta.name = name;
    writeRegistry(registry);
    return p;
  }

  /** Удалить профиль (не активный и не по умолчанию). */
  function removeProfile(id) {
    if (id === DEFAULT_PROFILE_ID) throw new Error('Профиль по умолчанию удалять нельзя');
    if (id === activeId) throw new Error('Нельзя удалить активный профиль: сначала переключитесь на другой');
    const p = byId.get(id);
    if (!p) throw new Error('Профиль не найден: ' + id);
    byId.delete(id);
    registry.profiles = registry.profiles.filter((x) => x.id !== id);
    writeRegistry(registry);
    try { fs.rmSync(profileDir(id), { recursive: true, force: true }); } catch (_) { /* не критично */ }
  }

  // ───────────────────────── экспорт/импорт (формат J) ─────────────────────────

  /**
   * Экспорт профиля в формат J (`wb-price-manager-backup`).
   * @param {{profileId?: string, includeKeys?: boolean, password?: string}} payload
   */
  function exportProfile(payload) {
    const p = payload || {};
    const id = p.profileId ? sanitizeProfileId(p.profileId) : activeId;
    const profile = byId.get(id);
    if (!profile) throw new Error('Профиль не найден: ' + id);
    if (!profile.backupManager) throw new Error('Модуль резервного копирования недоступен для профиля.');
    const result = profile.backupManager.exportBackup({ includeKeys: p.includeKeys === true, password: p.password || '' });
    return Object.assign({}, result, { profileId: id, profileName: profile.name, format: FORMAT, formatVersion: FORMAT_VERSION });
  }

  /**
   * Импорт профиля из формата J.
   * @param {{profileId: string, content: string, action?: string, overwriteExisting?: boolean,
   *          mode?: string, applyKeys?: boolean, password?: string, overwriteConfirmed?: boolean}} payload
   */
  function importProfile(payload) {
    const p = payload || {};
    const id = p.profileId ? sanitizeProfileId(p.profileId) : activeId;
    const profile = byId.get(id);
    if (!profile) throw new Error('Профиль не найден: ' + id);
    if (!profile.backupManager) throw new Error('Модуль резервного копирования недоступен для профиля.');
    const result = profile.backupManager.importBackup({
      content: p.content,
      action: p.action,
      overwriteExisting: p.overwriteExisting === true,
      mode: p.mode === 'replace' ? 'replace' : 'merge',
      applyKeys: p.applyKeys === true,
      password: p.password || '',
      overwriteConfirmed: p.overwriteConfirmed === true
    });
    return Object.assign({}, result, { profileId: id, profileName: profile.name });
  }

  /**
   * Сводный P&L по всем профилям.
   *
   * Для каждого профиля вызываем его обработчик `reports:pl` (P&L по его данным)
   * и складываем итоговые показатели. Возвращает разбивку по профилям с
   * указанием, из какого кабинета взяты данные, и общий итог.
   */
  async function plSummary() {
    const rows = [];
    const totals = {
      salesQty: 0, returnsQty: 0, revenue: 0, commission: 0, logistics: 0, storage: 0,
      acceptance: 0, acquiring: 0, penalties: 0, forPay: 0, wbAfterLogistics: 0,
      cogs: 0, packaging: 0, ad: 0, tax: 0, profit: 0, forPayFromWb: 0
    };
    const round = (v) => Math.round((Number(v) || 0) * 100) / 100;

    for (const profile of byId.values()) {
      let entry;
      if (!profile.service || !profile.service.handlers || typeof profile.service.handlers['reports:pl'] !== 'function') {
        entry = { ok: false, empty: true, profileId: profile.id, profileName: profile.name, message: 'Сервис профиля недоступен.' };
      } else {
        try {
          const res = await profile.service.handlers['reports:pl']({});
          entry = Object.assign({}, res, { profileId: profile.id, profileName: profile.name });
        } catch (e) {
          entry = { ok: false, empty: true, profileId: profile.id, profileName: profile.name, message: (e && e.message) || String(e) };
        }
      }
      if (entry.ok && entry.totals) {
        const t = entry.totals;
        for (const k of Object.keys(totals)) totals[k] += Number(t[k]) || 0;
        entry.totals = Object.assign({}, t);
      }
      entry.hasData = !!(entry.ok && entry.totals && Number(entry.totals.revenue) > 0) || !!(entry.meta && entry.meta.items);
      rows.push(entry);
    }

    for (const k of Object.keys(totals)) totals[k] = round(totals[k]);
    totals.marginPct = totals.revenue > 0 ? round(totals.profit / totals.revenue * 100) : 0;
    totals.commissionPct = totals.revenue > 0 ? round(totals.commission / totals.revenue * 100) : 0;

    return {
      ok: true,
      profiles: rows,
      totals,
      count: rows.filter((r) => r.ok && r.totals).length,
      empty: rows.every((r) => !r.ok || !r.totals || Number(r.totals.revenue) <= 0)
    };
  }

  // ───────────────────────── маршрутизатор обработчиков ─────────────────────────

  /** Собственные обработчики профилей (не принадлежат одному профилю). */
  const ownHandlers = {
    'profiles:list': async () => {
      return { activeId, switchable, profiles: listProfiles() };
    },

    'profiles:switch': async (payload) => {
      if (!switchable) throw new Error('Переключение профилей в этом режиме недоступно.');
      const id = payload && payload.profileId ? sanitizeProfileId(payload.profileId) : '';
      if (!id) throw new Error('Не указан профиль для переключения.');
      if (!byId.has(id)) throw new Error('Профиль не найден: ' + id);
      setActive(id);
      return { ok: true, activeId };
    },

    'profiles:create': async (payload) => {
      if (!switchable) throw new Error('Создание профилей в этом режиме недоступно.');
      const profile = createProfile(payload && payload.name);
      return { ok: true, profile: { id: profile.id, name: profile.name, createdAt: profile.createdAt } };
    },

    'profiles:rename': async (payload) => {
      const p = renameProfile((payload && payload.profileId) || activeId, payload && payload.name);
      return { ok: true, profile: { id: p.id, name: p.name } };
    },

    'profiles:remove': async (payload) => {
      if (!switchable) throw new Error('Удаление профилей в этом режиме недоступно.');
      removeProfile(payload && payload.profileId);
      return { ok: true };
    },

    'profiles:export': async (payload) => exportProfile(payload || {}),

    'profiles:import': async (payload) => importProfile(payload || {}),

    'profiles:pl-summary': async () => plSummary(),

    // усиленный app:state — добавляет информацию о профилях
    'app:state': async () => {
      const active = getActive();
      const base = active && active.service && active.service.handlers
        ? await active.service.handlers['app:state']()
        : { demo: true, settings: {}, keys: {} };
      return Object.assign(base, {
        activeProfileId: activeId,
        activeProfileName: active ? active.name : '',
        switchable,
        profiles: listProfiles()
      });
    }
  };

  /**
   * Маршрутизатор: собственные каналы `profiles:*` идут от хаба, все остальные —
   * к активному профилю. `ownKeys` отдаёт объединение, чтобы `Object.entries`
   * (IPC-регистрация и веб-сервер) видел все каналы.
   */
  const handlers = new Proxy(ownHandlers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const active = getActive();
      if (active && active.service && active.service.handlers) {
        const fn = active.service.handlers[prop];
        if (typeof fn === 'function') return fn;
      }
      return undefined;
    },
    ownKeys() {
      const keys = new Set(Object.keys(ownHandlers));
      const active = getActive();
      if (active && active.service && active.service.handlers) {
        for (const k of Object.keys(active.service.handlers)) keys.add(k);
      }
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) {
        return { value: target[prop], writable: true, configurable: true, enumerable: true };
      }
      const active = getActive();
      if (active && active.service && active.service.handlers && prop in active.service.handlers) {
        return { value: active.service.handlers[prop], writable: true, configurable: true, enumerable: true };
      }
      return undefined;
    }
  });

  // запускаем планировщик у активного профиля (репрайсер по расписанию)
  function applyScheduler() {
    const active = getActive();
    if (active && active.service && typeof active.service.applyScheduler === 'function') {
      return active.service.applyScheduler();
    }
    return { enabled: false };
  }

  function stopAllSchedulers() {
    for (const p of byId.values()) {
      if (p.service && typeof p.service.stopScheduler === 'function') {
        try { p.service.stopScheduler(); } catch (_) { /* не критично */ }
      }
      if (p.backupManager && typeof p.backupManager.stopScheduler === 'function') {
        try { p.backupManager.stopScheduler(); } catch (_) { /* не критично */ }
      }
      if (p.telegramNotifier && typeof p.telegramNotifier.stop === 'function') {
        try { p.telegramNotifier.stop(); } catch (_) { /* не критично */ }
      }
    }
  }

  function startAllSchedulers() {
    for (const p of byId.values()) {
      if (p.backupManager && typeof p.backupManager.startScheduler === 'function') {
        try { p.backupManager.startScheduler(); } catch (_) { /* не критично */ }
      }
      // планировщик репрайсера — по каждому профилю, чтобы автопересчёт цен
      // шёл во всех кабинетах, а не только в активном
      if (p.service && typeof p.service.applyScheduler === 'function') {
        try { p.service.applyScheduler(); } catch (_) { /* не критично */ }
      }
    }
  }

  return {
    handlers,
    dataDir,
    profilesRoot,
    registryPath,
    activeId: () => activeId,
    listProfiles,
    getProfile,
    getActive,
    getActiveStore,
    createProfile,
    renameProfile,
    removeProfile,
    exportProfile,
    importProfile,
    plSummary,
    applyScheduler,
    stopAllSchedulers,
    startAllSchedulers,
    // служебное: для тестов и диагностики
    _byId: byId,
    _registry: registry,
    _switchable: () => switchable,
    _fixedProfileId: () => fixedProfileId
  };
}

module.exports = {
  createProfileHub,
  sanitizeProfileId,
  sanitizeProfileName,
  makeActiveStoreProxy,
  PROFILES_FORMAT_VERSION,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME
};
