'use strict';

/**
 * Резервное копирование и восстановление всех данных приложения одним файлом.
 *
 * Формат файла — `.wbpm.json` (один JSON). Состоит из:
 *   - манифеста: формат, версия формата, дата, версия приложения, список наборов
 *     с их размером (число записей и байты);
 *   - `datasets` — содержимое каждого JSON-файла данных из `.data`;
 *   - `keys` — ключи WB, только если при экспорте включён флажок «включить ключи».
 *     Зашифрованы паролем пользователя (scrypt + AES-256-GCM, как в tools/web-auth.js).
 *     сам пароль в файл НЕ записывается.
 *
 * Все данные приложения — это JSON-файлы в `.data` (имена в electron/config.js).
 * Секреты (`secrets.enc`) хранятся отдельно и по умолчанию НЕ выгружаются.
 *
 * Запись всегда атомарная: временный файл + rename (как в store.js), чтобы при
 * восстановлении приложение не осталось в полузаписанном состоянии.
 *
 * Никаких новых зависимостей: scrypt и zlib — из стандартной библиотеки Node.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SETTINGS_FILE, PRICEWATCH_FILE, COSTS_FILE, STOCKS_FILE, TASKS_FILE,
  FACTCOSTS_FILE, PROMOEXITS_FILE, PRICEDRAFTS_FILE, PROPOSALS_FILE,
  RECALC_HISTORY_FILE, PROMOJOURNAL_FILE, REPRICER_FILE, COMPETITORS_FILE,
  ITEMCONFIGS_FILE, PRICES_HISTORY_FILE, REPRICER_RUNS_FILE, PROMONOMS_FILE,
  SECRETS_FILE, BACKUPS_DIR
} = require('./config');

/** Версия формата резервной копии. Изменение номера = несовместимость. */
const FORMAT_VERSION = 1;
const FORMAT_NAME = 'wbpm-backup';
const BACKUP_EXT = '.wbpm.json';

/**
 * Регистр наборов данных. `file` — имя файла в `.data`, `kind` — форма слияния
 * при импорте:
 *   - object   : плоский/глубокий объект (настройки, конфиг репрайсера);
 *   - items    : { items: {...} } — слияние по ключу, существующие записи сохраняются;
 *   - array    : массив (история задач, прогонов);
 *   - events   : { events: [...] } — журнал слиянием массива;
 *   - proposal : единый объект предложения репрайсера.
 */
const DATASETS = [
  { name: 'settings', file: SETTINGS_FILE, kind: 'object' },
  { name: 'costs', file: COSTS_FILE, kind: 'items' },
  { name: 'pricewatch', file: PRICEWATCH_FILE, kind: 'items' },
  { name: 'stocks', file: STOCKS_FILE, kind: 'items' },
  { name: 'tasks', file: TASKS_FILE, kind: 'array' },
  { name: 'factcosts', file: FACTCOSTS_FILE, kind: 'items' },
  { name: 'promoexits', file: PROMOEXITS_FILE, kind: 'items' },
  { name: 'pricedrafts', file: PRICEDRAFTS_FILE, kind: 'items' },
  { name: 'proposals', file: PROPOSALS_FILE, kind: 'proposal' },
  { name: 'recalchistory', file: RECALC_HISTORY_FILE, kind: 'items' },
  { name: 'promojournal', file: PROMOJOURNAL_FILE, kind: 'events' },
  { name: 'repricer', file: REPRICER_FILE, kind: 'object' },
  { name: 'competitors', file: COMPETITORS_FILE, kind: 'items' },
  { name: 'itemconfigs', file: ITEMCONFIGS_FILE, kind: 'items' },
  { name: 'pricehistory', file: PRICES_HISTORY_FILE, kind: 'items' },
  { name: 'repricerruns', file: REPRICER_RUNS_FILE, kind: 'array' },
  { name: 'promonoms', file: PROMONOMS_FILE, kind: 'items' }
];

// ───────────────────────────────────── шифрование ключей ─────────────────────────────────────

/**
 * Derive key из пароля через scrypt (те же параметры, что в tools/web-auth.js).
 * 32 байта = ключ AES-256.
 */
function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Зашифровать текст паролем. Возвращает объект с salt/iv/tag/data (hex + base64). */
function encryptText(plain, password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    method: 'scrypt+aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: data.toString('base64')
  };
}

/**
 * Расшифровать объект, зашифрованный encryptText. Неверный пароль бросает
 * ошибку с понятным сообщением (проверка тега GCM).
 */
function decryptText(enc, password) {
  if (!enc || !enc.encrypted) throw new Error('Зашифрованный блок отсутствует или неверен');
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch (e) {
    throw new Error('Неверный пароль или повреждённые ключи: ' + (e.message || 'ошибка расшифровки'));
  }
}

// ───────────────────────────────────── атомарная запись ─────────────────────────────────────

/** Атомарная запись текста в файл: временный файл + rename (как в store.js). */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** Читать JSON с атомарной гарантией; пустой/отсутствующий файл → fallback. */
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// ───────────────────────────────────── подсчёт записей ─────────────────────────────────────

function countEntries(kind, data) {
  if (data === null || data === undefined) return 0;
  if (kind === 'items') {
    const items = data && data.items;
    return items && typeof items === 'object' ? Object.keys(items).length : 0;
  }
  if (kind === 'array') return Array.isArray(data) ? data.length : 0;
  if (kind === 'events') {
    const ev = data && data.events;
    return Array.isArray(ev) ? ev.length : 0;
  }
  if (kind === 'proposal') return (data && Array.isArray(data.items)) ? data.items.length : 0;
  return 1; // object
}

/** Небольшое глубокое слияние: src добавляет в base новые ключи, но не переписывает существующие. */
function mergePreserving(base, src) {
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? Object.assign({}, base) : {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergePreserving(out[k], sv);
    } else if (!(k in out)) {
      out[k] = sv;
    }
  }
  return out;
}

/** Слияние двух массивов: существующие сохраняются, добавляются новые (без дубликатов по JSON). */
function mergeArrays(baseArr, srcArr) {
  const out = Array.isArray(baseArr) ? baseArr.slice() : [];
  const seen = new Set(out.map((x) => JSON.stringify(x)));
  for (const item of (Array.isArray(srcArr) ? srcArr : [])) {
    const k = JSON.stringify(item);
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

/**
 * Слияние одного набора данных при импорте в режиме merge.
 * Существующие записи НЕ перезаписываются (это требование «не затирать существующие
 * записи»), добавляются только новые.
 */
function mergeDataset(kind, existing, incoming) {
  if (kind === 'items') {
    const cur = (existing && existing.items && typeof existing.items === 'object') ? existing.items : {};
    const add = (incoming && incoming.items && typeof incoming.items === 'object') ? incoming.items : {};
    const merged = Object.assign({}, cur);
    for (const k of Object.keys(add)) if (!(k in merged)) merged[k] = add[k];
    const out = Object.assign({}, incoming);
    out.items = merged;
    if (existing && 'updatedAt' in existing && !(existing.updatedAt === undefined)) out.updatedAt = existing.updatedAt;
    return out;
  }
  if (kind === 'array') return mergeArrays(existing, incoming);
  if (kind === 'events') {
    const cur = (existing && Array.isArray(existing.events)) ? existing.events : [];
    const add = (incoming && Array.isArray(incoming.events)) ? incoming.events : [];
    return { events: mergeArrays(cur, add), updatedAt: (existing && existing.updatedAt) || undefined };
  }
  if (kind === 'proposal') {
    // Существующее предложение сохраняется, недостающие поля заполняются из импортируемого.
    return mergePreserving(existing || {}, incoming || {});
  }
  // object
  return mergePreserving(existing || {}, incoming || {});
}

// ───────────────────────────────────── основной модуль ─────────────────────────────────────

/**
 * Создать объект резервной копии (не записывать файл).
 *
 * @param {object} store   хранилище (нужен dir и saveSecrets для ключей)
 * @param {object} opts    { includeKeys, password, appVersion }
 * @returns {object} объект резервной копии с манифестом
 */
function buildBackup(store, opts) {
  const o = opts || {};
  const dir = store.dir;
  const datasets = {};
  const manifest = [];

  for (const ds of DATASETS) {
    const file = path.join(dir, ds.file);
    let raw = null;
    let exists = false;
    try {
      if (fs.existsSync(file)) {
        raw = fs.readFileSync(file, 'utf8');
        exists = true;
      }
    } catch (e) {
      raw = null;
    }
    let data;
    if (raw !== null && raw.trim()) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    } else {
      data = null;
    }
    datasets[ds.name] = data;
    const entries = data !== null ? countEntries(ds.kind, data) : 0;
    const bytes = raw !== null ? raw.length : 0;
    manifest.push({
      name: ds.name,
      file: ds.file,
      present: exists,
      entries,
      bytes
    });
  }

  // Ключи WB — только по явному запросу и только с паролем.
  let keys = null;
  if (o.includeKeys) {
    if (!o.password) throw new Error('Для включения ключей в экспорт нужен пароль');
    const secrets = store.loadSecrets() || {};
    const json = JSON.stringify(secrets);
    keys = encryptText(json, o.password);
    keys.count = Object.keys(secrets).length;
  }

  return {
    format: FORMAT_NAME,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: o.appVersion || '',
    manifest,
    datasets,
    keys
  };
}

/** Проверить совместимость формата и вернуть объект копии или бросить понятную ошибку. */
function parseBackup(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Файл резервной копии повреждён: не JSON-объект');
  if (obj.format !== FORMAT_NAME) throw new Error('Неподдерживаемый формат резервной копии: «' + String(obj.format) + '»');
  if (Number(obj.formatVersion) !== FORMAT_VERSION) {
    throw new Error('Резервная копия создана более новой версией формата (' + obj.formatVersion +
      '), которую это приложение не понимает. Обновите приложение.');
  }
  if (!obj.datasets || typeof obj.datasets !== 'object') throw new Error('Файл резервной копии повреждён: отсутствует блок данных');
  return obj;
}

/** Прочитать файл резервной копии и провалидировать формат. */
function readBackupFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('Не удалось прочитать файл резервной копии: ' + (e.message || e));
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('Файл резервной копии повреждён: не корректный JSON (' + (e.message || 'ошибка парсинга') + ')');
  }
  return parseBackup(obj);
}

/** Записать объект резервной копии в файл атомарно. */
function writeBackupFile(file, backup) {
  atomicWrite(file, JSON.stringify(backup, null, 2));
}

/**
 * Композиция импортируемой копии: что будет добавлено, что перезаписано.
 * Не пишет ничего — только анализ.
 */
function previewBackup(store, backup, mode) {
  const dir = store.dir;
  const datasets = [];
  let totalExisting = 0;
  let totalIncoming = 0;
  let totalAdded = 0;
  let totalOverwritten = 0;

  for (const ds of DATASETS) {
    const incoming = backup.datasets && backup.datasets[ds.name];
    const curFile = path.join(dir, ds.file);
    const existing = readJsonSafe(curFile, null);

    const existingCount = existing !== null ? countEntries(ds.kind, existing) : 0;
    const incomingCount = incoming !== null ? countEntries(ds.kind, incoming) : 0;

    let added = 0;
    let overwritten = 0;
    if (incoming !== null && existing !== null && mode === 'replace') {
      overwritten = existingCount;
    } else if (incoming !== null) {
      // merge: считаем, сколько новых записей добавится.
      added = newKeyCount(ds.kind, existing, incoming);
    } else if (incoming !== null && existing === null) {
      added = incomingCount;
    }

    datasets.push({
      name: ds.name,
      file: ds.file,
      present: incoming !== null,
      existingCount,
      incomingCount,
      added,
      overwritten,
      action: incoming === null ? 'skip' : (mode === 'replace' ? 'replace' : 'merge')
    });
    totalExisting += existingCount;
    totalIncoming += incomingCount;
    totalAdded += added;
    totalOverwritten += overwritten;
  }

  const keysInfo = backup.keys
    ? { included: true, encrypted: true, count: backup.keys.count || 0, needPassword: true }
    : { included: false, needPassword: false };

  return {
    mode: mode || 'merge',
    datasets,
    keys: keysInfo,
    summary: {
      datasets: datasets.filter((d) => d.present).length,
      totalExisting,
      totalIncoming,
      totalAdded,
      totalOverwritten
    }
  };
}

/** Сколько новых ключей/записей добавится при merge. */
function newKeyCount(kind, existing, incoming) {
  if (kind === 'items') {
    const cur = (existing && existing.items) || {};
    const add = (incoming && incoming.items) || {};
    return Object.keys(add).filter((k) => !(k in cur)).length;
  }
  if (kind === 'array') {
    const cur = Array.isArray(existing) ? existing : [];
    const add = Array.isArray(incoming) ? incoming : [];
    const seen = new Set(cur.map((x) => JSON.stringify(x)));
    return add.filter((x) => !seen.has(JSON.stringify(x))).length;
  }
  if (kind === 'events') {
    const cur = (existing && Array.isArray(existing.events)) ? existing.events : [];
    const add = (incoming && Array.isArray(incoming.events)) ? incoming.events : [];
    const seen = new Set(cur.map((x) => JSON.stringify(x)));
    return add.filter((x) => !seen.has(JSON.stringify(x))).length;
  }
  if (kind === 'proposal' || kind === 'object') return 0;
  return 0;
}

/**
 * Применить резервную копию.
 *
 * Порядок:
 *   1. Создать резервную копию текущему состоянию (авто-резервирование перед импортом);
 *   2. Подобрать ключ (если копия содержит ключи — расшифровать паролем);
 *   3. Для каждого набора записать атомарно (временный файл + rename).
 *
 * @param {object} store
 * @param {object} backup    распарсированная копия
 * @param {object} opts      { mode: 'merge'|'replace', password, appVersion }
 */
function applyBackup(store, backup, opts) {
  const o = opts || {};
  const mode = o.mode === 'replace' ? 'replace' : 'merge';
  const dir = store.dir;

  // 1. Резервная копия текущего состояния до импорта (запасной вариант возврата).
  const preBackup = buildBackup(store, { appVersion: o.appVersion });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace(/\..+$/, '');
  const preFile = path.join(dir, BACKUPS_DIR, 'pre-import_' + stamp + BACKUP_EXT);
  writeBackupFile(preFile, preBackup);

  // 2. Ключи.
  let appliedKeys = false;
  let keysError = '';
  if (backup.keys && backup.keys.encrypted) {
    try {
      if (!o.password) throw new Error('Для восстановления ключей введите пароль');
      const json = decryptText(backup.keys, o.password);
      const secrets = JSON.parse(json);
      store.saveSecrets(secrets);
      appliedKeys = true;
    } catch (e) {
      keysError = e.message || String(e);
      // Ключи не восстановились — данные всё равно импортируем, но честно предупреждаем.
    }
  }

  // 3. Наборы данных.
  const applied = [];
  for (const ds of DATASETS) {
    const incoming = backup.datasets && backup.datasets[ds.name];
    if (incoming === null || incoming === undefined) { applied.push({ name: ds.name, skipped: true }); continue; }
    const target = path.join(dir, ds.file);
    let data;
    if (mode === 'replace') {
      data = incoming;
    } else {
      const existing = readJsonSafe(target, null);
      data = mergeDataset(ds.kind, existing, incoming);
    }
    atomicWrite(target, JSON.stringify(data, null, 2));
    applied.push({ name: ds.name, entries: countEntries(ds.kind, data), mode });
  }

  return {
    mode,
    preBackupFile: preFile,
    keysApplied: appliedKeys,
    keysError,
    applied,
    restoredAt: new Date().toISOString()
  };
}

// ───────────────────────────────────── авто-резервирование ─────────────────────────────────────

/** Каталог авто-резервных копий: `.data/backups`. */
function backupsDir(store) {
  return path.join(store.dir, BACKUPS_DIR);
}

/** Создать авто-резервную копию в `.data/backups/` и вернуть её описание. */
let autoBackupSeq = 0;
function createAutoBackup(store, opts) {
  const backup = buildBackup(store, opts || {});
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace(/\..+$/, '');
  autoBackupSeq = (autoBackupSeq + 1) % 100000;
  const file = path.join(backupsDir(store), 'auto_' + stamp + '_' + String(autoBackupSeq).padStart(3, '0') + BACKUP_EXT);
  writeBackupFile(file, backup);
  return {
    file,
    name: path.basename(file),
    createdAt: backup.createdAt,
    size: fs.statSync(file).size,
    manifest: backup.manifest,
    hasKeys: !!backup.keys
  };
}

/**
 * Список авто-резервных копий в `.data/backups/` (с манифестом).
 */
function listBackups(store) {
  const dir = backupsDir(store);
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(BACKUP_EXT)) continue;
      const file = path.join(dir, name);
      try {
        const backup = readBackupFile(file);
        out.push({
          name,
          file,
          createdAt: backup.createdAt,
          appVersion: backup.appVersion,
          size: fs.statSync(file).size,
          hasKeys: !!backup.keys,
          datasets: (backup.manifest || []).filter((m) => m.present).map((m) => m.name)
        });
      } catch (e) {
        // Повреждённый файл — показываем, но не падаем.
        out.push({ name, file, createdAt: null, size: fs.statSync(file).size, error: e.message });
      }
    }
  } catch (e) {
    return out;
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/** Удалить старые авто-резервные копии, оставив последние `keep`. */
function rotateBackups(store, keep) {
  const list = listBackups(store);
  const n = Math.max(0, Math.floor(Number(keep) || 0));
  const toRemove = list.slice(n);
  const removed = [];
  for (const b of toRemove) {
    try { fs.unlinkSync(b.file); removed.push(b.name); } catch (e) { /* игнорируем */ }
  }
  return { keep: n, total: list.length, removed: removed.length, removedNames: removed };
}

/**
 * Проверить, нужно ли создать авто-резервную копию согласно настройкам.
 * @param {object} settings  настройки (backupAutoEnabled, backupAutoFreq, backupLastAt)
 */
function isAutoBackupDue(settings) {
  if (!settings || settings.backupAutoEnabled !== true) return false;
  const freq = settings.backupAutoFreq === 'weekly' ? 'weekly' : 'daily';
  const last = settings.backupLastAt ? new Date(settings.backupLastAt).getTime() : 0;
  const now = Date.now();
  const interval = freq === 'weekly' ? 7 * 86400000 : 86400000;
  return last <= 0 || (now - last) >= interval;
}

module.exports = {
  FORMAT_VERSION,
  FORMAT_NAME,
  BACKUP_EXT,
  DATASETS,
  buildBackup,
  parseBackup,
  readBackupFile,
  writeBackupFile,
  previewBackup,
  applyBackup,
  createAutoBackup,
  listBackups,
  rotateBackups,
  isAutoBackupDue,
  encryptText,
  decryptText,
  atomicWrite
};
