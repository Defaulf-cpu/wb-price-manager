'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SETTINGS_FILE, COSTS_FILE, TASKS_FILE, REPRICER_FILE, COMPETITORS_FILE,
  ITEMCONFIGS_FILE, PRICES_HISTORY_FILE, REPRICER_RUNS_FILE, FACTCOSTS_FILE,
  PROMOEXITS_FILE, PROMONOMS_FILE, PRICEWATCH_FILE, STOCKS_FILE, STOCK_HISTORY_FILE,
  PRICEDRAFTS_FILE, PROPOSALS_FILE, RECALC_HISTORY_FILE, PROMOJOURNAL_FILE,
  SECRETS_FILE
} = require('./config');

const FORMAT = 'wb-price-manager-backup';
const LEGACY_FORMAT = 'wbpm-backup';
const FORMAT_VERSION = 1;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const RETENTION_MIN = 1;
const RETENTION_MAX = 100;
const DATASETS = Object.freeze([
  { key: 'settings', file: SETTINGS_FILE, title: 'Настройки', shape: 'object' },
  { key: 'costs', file: COSTS_FILE, title: 'Себестоимости и расходы', shape: 'object' },
  { key: 'tasks', file: TASKS_FILE, title: 'История отправок цен', shape: 'array' },
  { key: 'repricer', file: REPRICER_FILE, title: 'Общие настройки репрайсера', shape: 'object' },
  { key: 'competitors', file: COMPETITORS_FILE, title: 'Конкуренты', shape: 'object' },
  { key: 'itemConfigs', file: ITEMCONFIGS_FILE, title: 'Настройки товаров', shape: 'object' },
  { key: 'priceHistory', file: PRICES_HISTORY_FILE, title: 'История цен', shape: 'object' },
  { key: 'repricerRuns', file: REPRICER_RUNS_FILE, title: 'История пересчётов', shape: 'array' },
  { key: 'factCosts', file: FACTCOSTS_FILE, title: 'Фактические расходы', shape: 'object' },
  { key: 'promoExits', file: PROMOEXITS_FILE, title: 'Очередь возврата цены после акций', shape: 'object' },
  { key: 'promoNoms', file: PROMONOMS_FILE, title: 'Списки товаров акций', shape: 'object' },
  { key: 'priceWatch', file: PRICEWATCH_FILE, title: 'Наблюдения цен витрины', shape: 'object' },
  { key: 'stocks', file: STOCKS_FILE, title: 'Остатки по складам', shape: 'object' },
  { key: 'stockHistory', file: STOCK_HISTORY_FILE, title: 'История нулевых остатков', shape: 'object' },
  { key: 'priceDrafts', file: PRICEDRAFTS_FILE, title: 'Черновики цен', shape: 'object' },
  { key: 'proposals', file: PROPOSALS_FILE, title: 'Предложение репрайсера', shape: 'object' },
  { key: 'recalcHistory', file: RECALC_HISTORY_FILE, title: 'История пересчёта по товарам', shape: 'object' },
  { key: 'promoJournal', file: PROMOJOURNAL_FILE, title: 'Журнал участия в акциях', shape: 'object' }
]);
const DATASET_BY_KEY = new Map(DATASETS.map((item) => [item.key, item]));
const WB_SECRET_KEYS = Object.freeze(['single', 'universal', 'all', 'prices', 'statistics', 'content', 'finance', 'advert', 'analytics', 'marketplace', 'master']);
const SAFE_TARGETS = new Set(DATASETS.map((item) => item.file).concat([SECRETS_FILE]));
const SECRET_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class BackupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BackupError';
    this.code = code || 'BACKUP_ERROR';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneSafe(value, depth) {
  const level = Number(depth) || 0;
  if (level > 100) throw new BackupError('В резервной копии слишком глубокая структура JSON.', 'BAD_FILE');
  if (Array.isArray(value)) return value.map((item) => cloneSafe(item, level + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) throw new BackupError('В резервной копии обнаружено запрещённое имя поля.', 'BAD_FILE');
      out[key] = cloneSafe(item, level + 1);
    }
    return out;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new BackupError('В резервной копии есть значение, которое нельзя сохранить в JSON.', 'BAD_FILE');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isPlainObject(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function countLeaves(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countLeaves(item), 0) || 1;
  if (isPlainObject(value)) {
    const vals = Object.values(value);
    return vals.reduce((sum, item) => sum + countLeaves(item), 0) || 1;
  }
  return 1;
}

function recordCount(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) {
    if (isPlainObject(value.items)) return Object.keys(value.items).length;
    if (Array.isArray(value.events)) return value.events.length;
    return Object.keys(value).length;
  }
  return 1;
}

function arrayIdentity(value) {
  if (!isPlainObject(value)) return canonical(value);
  if (value.taskId !== undefined) return 'taskId:' + String(value.taskId);
  if (value.id !== undefined) return 'id:' + String(value.id);
  if (value.nmID !== undefined && value.at && value.phase) return 'nm-phase:' + value.nmID + ':' + value.at + ':' + value.phase;
  if (value.nmID !== undefined && value.at && value.action) return 'nm-action:' + value.nmID + ':' + value.at + ':' + value.action + ':' + String(value.promoId || '');
  if (value.nmID !== undefined && value.at && value.source) return 'nm-source:' + value.nmID + ':' + value.at + ':' + value.source;
  return canonical(value);
}

function mergeTree(current, incoming, overwrite, counts) {
  if (current === undefined) {
    counts.added += countLeaves(incoming);
    return cloneSafe(incoming);
  }
  if (incoming === undefined) return cloneSafe(current);
  if (canonical(current) === canonical(incoming)) {
    counts.unchanged += 1;
    return cloneSafe(current);
  }
  if (Array.isArray(current) && Array.isArray(incoming)) {
    const out = current.map((item) => cloneSafe(item));
    const indices = new Map(out.map((item, index) => [arrayIdentity(item), index]));
    for (const item of incoming) {
      const key = arrayIdentity(item);
      if (!indices.has(key)) {
        indices.set(key, out.length);
        out.push(cloneSafe(item));
        counts.added += countLeaves(item);
        continue;
      }
      const index = indices.get(key);
      if (canonical(out[index]) === canonical(item)) {
        counts.unchanged += 1;
      } else {
        counts.conflicts += 1;
        if (overwrite) {
          out[index] = cloneSafe(item);
          counts.overwritten += 1;
        }
      }
    }
    return out;
  }
  if (isPlainObject(current) && isPlainObject(incoming)) {
    const out = cloneSafe(current);
    for (const [key, value] of Object.entries(incoming)) {
      if (SECRET_KEYS.has(key)) throw new BackupError('В резервной копии обнаружено запрещённое имя поля.', 'BAD_FILE');
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        out[key] = cloneSafe(value);
        counts.added += countLeaves(value);
      } else {
        out[key] = mergeTree(current[key], value, overwrite, counts);
      }
    }
    return out;
  }
  counts.conflicts += 1;
  if (overwrite) {
    counts.overwritten += 1;
    return cloneSafe(incoming);
  }
  return cloneSafe(current);
}

function deriveBackupKey(password, salt) {
  const pass = String(password === undefined || password === null ? '' : password);
  if (pass.length < 8) throw new BackupError('Пароль для выгрузки ключей должен содержать не менее 8 символов.', 'PASSWORD_REQUIRED');
  return crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encryptSecrets(secrets, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveBackupKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(secrets || {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: 16384, r: 8, p: 1 },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptSecrets(envelope, password) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.kdf) || !isPlainObject(envelope.cipher) || typeof envelope.ciphertext !== 'string') {
    throw new BackupError('Блок зашифрованных ключей повреждён.', 'BAD_FILE');
  }
  if (envelope.kdf.name !== 'scrypt' || Number(envelope.kdf.N) !== 16384 || Number(envelope.kdf.r) !== 8 || Number(envelope.kdf.p) !== 1 || envelope.cipher.name !== 'aes-256-gcm') {
    throw new BackupError('Способ шифрования ключей в этом файле не поддерживается.', 'INCOMPATIBLE_FORMAT');
  }
  if (String(password === undefined || password === null ? '' : password).length < 8) {
    throw new BackupError('Введите пароль, которым были зашифрованы ключи.', 'PASSWORD_REQUIRED');
  }
  try {
    const salt = Buffer.from(envelope.kdf.salt, 'base64');
    const iv = Buffer.from(envelope.cipher.iv, 'base64');
    const tag = Buffer.from(envelope.cipher.tag, 'base64');
    const encrypted = Buffer.from(envelope.ciphertext, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || encrypted.length > MAX_BACKUP_BYTES) {
      throw new Error('invalid encrypted payload');
    }
    const key = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain);
    if (!isPlainObject(parsed)) throw new Error('invalid secrets object');
    return cloneSafe(parsed);
  } catch (_) {
    throw new BackupError('Не удалось расшифровать ключи: проверьте пароль и целостность файла.', 'BAD_PASSWORD');
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

function recoverTransactions(dataDir) {
  const root = path.join(dataDir, '.wbpm-transactions');
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^tx-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    const txDir = path.join(root, entry.name);
    const journalPath = path.join(txDir, 'journal.json');
    let journal = null;
    try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (_) {}
    if (journal && journal.state !== 'committed' && Array.isArray(journal.targets)) {
      for (const target of journal.targets.slice().reverse()) {
        if (!target || !SAFE_TARGETS.has(target.file)) throw new BackupError('Найден некорректный журнал восстановления данных.', 'RECOVERY_FAILED');
        const dest = path.join(dataDir, target.file);
        if (target.hadBefore) {
          const oldPath = path.join(txDir, 'old', target.file);
          if (!fs.existsSync(oldPath)) throw new BackupError('Не найдена исходная копия файла ' + target.file + ' для отката импорта.', 'RECOVERY_FAILED');
          atomicWrite(dest, fs.readFileSync(oldPath));
        } else {
          try { fs.rmSync(dest, { force: true }); } catch (_) {}
        }
      }
    }
    fs.rmSync(txDir, { recursive: true, force: true });
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

function createBackupManager(options) {
  const o = options || {};
  const store = o.store;
  if (!store || !store.dir) throw new Error('backup: store с каталогом данных обязателен');
  const dataDir = path.resolve(o.dir || store.dir);
  const backupsDir = path.join(dataDir, 'backups');
  const appVersion = String(o.appVersion || 'unknown');
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  let timer = null;
  let lastError = '';
  let lastAttemptAt = 0;
  let busy = false;

  fs.mkdirSync(dataDir, { recursive: true });
  recoverTransactions(dataDir);

  function readDataset(item) {
    const filePath = path.join(dataDir, item.file);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(text);
      validateDatasetValue(item, parsed);
      return cloneSafe(parsed);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError('Не удалось прочитать «' + item.title + '» (' + item.file + '). Проверьте файл данных перед созданием резервной копии.', 'SOURCE_DATA_INVALID');
    }
  }

  function validateDatasetValue(item, value) {
    const valid = item.shape === 'array' ? Array.isArray(value) : isPlainObject(value);
    if (!valid) throw new BackupError('Неверная структура набора «' + item.title + '» (' + item.file + ').', 'BAD_FILE');
    cloneSafe(value);
  }

  function makeDocument(kind, includeKeys, password) {
    const data = {};
    const datasets = [];
    for (const item of DATASETS) {
      const value = readDataset(item);
      if (value === undefined) continue;
      const serialized = JSON.stringify(value, null, 2);
      data[item.key] = value;
      datasets.push({
        key: item.key,
        file: item.file,
        title: item.title,
        sizeBytes: Buffer.byteLength(serialized, 'utf8'),
        sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
        records: recordCount(value)
      });
    }
    const document = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      backupType: kind || 'manual',
      createdAt: now().toISOString(),
      appVersion,
      manifest: { datasets },
      data
    };
    if (includeKeys) {
      if (store.secretsError && store.secretsError()) {
        throw new BackupError('Сохранённые ключи не читаются и не могут быть включены в резервную копию. Исправьте состояние ключей и повторите.', 'SECRETS_UNAVAILABLE');
      }
      const currentSecrets = store.loadSecrets();
      const wbSecrets = {};
      for (const key of WB_SECRET_KEYS) if (currentSecrets[key]) wbSecrets[key] = currentSecrets[key];
      document.encryptedSecrets = encryptSecrets(wbSecrets, password);
      document.manifest.encryptedSecrets = {
        algorithm: 'scrypt + AES-256-GCM',
        sizeBytes: Buffer.byteLength(JSON.stringify(document.encryptedSecrets), 'utf8')
      };
    }
    const content = JSON.stringify(document, null, 2);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_BACKUP_BYTES) throw new BackupError('Резервная копия превышает допустимый размер 100 МБ.', 'BACKUP_TOO_LARGE');
    return { document, content, bytes };
  }

  function makeFileName(kind) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const prefix = kind === 'automatic' ? 'auto' : (kind === 'pre-import' ? 'before-import' : 'wbpm-backup');
    return prefix + '-' + stamp + '-' + crypto.randomBytes(3).toString('hex') + '.wbpm.json';
  }

  function writeBackup(kind) {
    const built = makeDocument(kind, false, '');
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const fileName = makeFileName(kind);
    atomicWrite(path.join(backupsDir, fileName), built.content);
    try { fs.chmodSync(path.join(backupsDir, fileName), 0o600); } catch (_) {}
    return { fileName, createdAt: built.document.createdAt, sizeBytes: built.bytes };
  }

  function exportBackup(payload) {
    const p = payload || {};
    const includeKeys = p.includeKeys === true;
    const built = makeDocument('manual', includeKeys, p.password);
    const stamp = built.document.createdAt.replace(/[:.]/g, '-');
    return {
      fileName: 'wbpm-backup-' + stamp + '.wbpm.json',
      content: built.content,
      sizeBytes: built.bytes,
      manifest: built.document.manifest
    };
  }

  /** Совместимость с файлами самостоятельного задания J (PR #9). */
  function convertLegacyDocument(input) {
    const old = cloneSafe(input);
    if (Number(old.formatVersion) !== FORMAT_VERSION) throw new BackupError('Версия раннего формата резервной копии несовместима с приложением.', 'INCOMPATIBLE_FORMAT');
    if (!isPlainObject(old.datasets) || !Array.isArray(old.manifest)) throw new BackupError('В ранней копии отсутствуют наборы данных или оглавление.', 'BAD_FILE');
    const known = new Map(DATASETS.map((item) => [item.key.toLowerCase(), item]));
    const entries = new Map();
    for (const entry of old.manifest) {
      const item = isPlainObject(entry) && known.get(entry.name);
      if (!item || entry.file !== item.file || entries.has(entry.name)) throw new BackupError('Некорректное оглавление ранней резервной копии.', 'BAD_FILE');
      entries.set(entry.name, entry);
    }
    const data = {}, datasets = [];
    for (const [name, raw] of Object.entries(old.datasets)) {
      const item = known.get(name);
      if (!item || !entries.has(name)) throw new BackupError('Ранняя копия содержит неизвестный набор данных «' + name + '».', 'INCOMPATIBLE_FORMAT');
      if (raw === null) continue; // исходный J явно перечислял отсутствующие файлы
      validateDatasetValue(item, raw);
      const value = cloneSafe(raw);
      if (item.key === 'settings' && value.backupSchedule === undefined && value.backupAutoEnabled !== undefined) {
        value.backupSchedule = value.backupAutoEnabled === true ? (value.backupAutoFreq === 'weekly' ? 'weekly' : 'daily') : 'off';
        if (value.backupRetention === undefined && value.backupAutoKeep !== undefined) value.backupRetention = clampRetention(value.backupAutoKeep);
      }
      const serialized = JSON.stringify(value, null, 2);
      data[item.key] = value;
      datasets.push({ key: item.key, file: item.file, title: item.title, records: recordCount(value),
        sizeBytes: Buffer.byteLength(serialized, 'utf8'), sha256: crypto.createHash('sha256').update(serialized).digest('hex') });
    }
    const document = { format: FORMAT, formatVersion: FORMAT_VERSION, sourceFormat: LEGACY_FORMAT,
      createdAt: old.createdAt, appVersion: old.appVersion || 'не указана', backupType: 'manual',
      manifest: { datasets }, data };
    if (old.keys !== undefined && old.keys !== null) {
      const keys = old.keys;
      if (!isPlainObject(keys) || keys.encrypted !== true || keys.method !== 'scrypt+aes-256-gcm' ||
        !/^[a-f0-9]{32}$/i.test(keys.salt || '') || !/^[a-f0-9]{24}$/i.test(keys.iv || '') ||
        !/^[a-f0-9]{32}$/i.test(keys.tag || '') || typeof keys.data !== 'string') {
        throw new BackupError('Зашифрованные ключи ранней копии повреждены или используют неизвестный формат.', 'BAD_FILE');
      }
      document.encryptedSecrets = {
        kdf: { name: 'scrypt', salt: Buffer.from(keys.salt, 'hex').toString('base64'), N: 16384, r: 8, p: 1 },
        cipher: { name: 'aes-256-gcm', iv: Buffer.from(keys.iv, 'hex').toString('base64'), tag: Buffer.from(keys.tag, 'hex').toString('base64') },
        ciphertext: keys.data
      };
    }
    return document;
  }

  function parseDocument(input) {
    let text;
    if (typeof input === 'string') text = input;
    else if (Buffer.isBuffer(input)) text = input.toString('utf8');
    else if (isPlainObject(input)) text = JSON.stringify(input);
    else throw new BackupError('Не передано содержимое файла резервной копии.', 'BAD_FILE');
    if (Buffer.byteLength(text, 'utf8') > MAX_BACKUP_BYTES) throw new BackupError('Файл резервной копии больше 100 МБ.', 'BACKUP_TOO_LARGE');
    let document;
    try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (_) { throw new BackupError('Файл повреждён: это не корректный JSON.', 'BAD_FILE'); }
    if (isPlainObject(document) && document.format === LEGACY_FORMAT) document = convertLegacyDocument(document);
    if (!isPlainObject(document) || document.format !== FORMAT) throw new BackupError('Это не файл резервной копии WB Price Manager формата .wbpm.json.', 'BAD_FILE');
    if (Number(document.formatVersion) !== FORMAT_VERSION) {
      throw new BackupError('Версия формата резервной копии ' + String(document.formatVersion || 'не указана') + ' несовместима с этой версией приложения (поддерживается формат ' + FORMAT_VERSION + ').', 'INCOMPATIBLE_FORMAT');
    }
    if (!isPlainObject(document.data) || !isPlainObject(document.manifest) || !Array.isArray(document.manifest.datasets)) {
      throw new BackupError('Файл повреждён: отсутствует оглавление или наборы данных.', 'BAD_FILE');
    }
    const seen = new Set();
    for (const entry of document.manifest.datasets) {
      if (!isPlainObject(entry) || typeof entry.key !== 'string' || seen.has(entry.key)) throw new BackupError('Файл повреждён: некорректное оглавление наборов данных.', 'BAD_FILE');
      seen.add(entry.key);
      const item = DATASET_BY_KEY.get(entry.key);
      if (!item) throw new BackupError('Файл содержит неизвестный набор данных «' + entry.key + '».', 'INCOMPATIBLE_FORMAT');
      if (entry.file !== item.file || !Object.prototype.hasOwnProperty.call(document.data, item.key)) throw new BackupError('Файл повреждён: оглавление не совпадает с набором «' + item.title + '».', 'BAD_FILE');
      const value = document.data[item.key];
      validateDatasetValue(item, value);
      const serialized = JSON.stringify(value, null, 2);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (Number(entry.sizeBytes) !== bytes || (entry.sha256 && String(entry.sha256) !== crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'))) {
        throw new BackupError('Набор «' + item.title + '» повреждён: размер или контрольная сумма не совпадают.', 'BAD_FILE');
      }
    }
    for (const key of Object.keys(document.data)) {
      if (!seen.has(key)) throw new BackupError('Файл повреждён: набор данных «' + key + '» отсутствует в оглавлении.', 'BAD_FILE');
    }
    if (document.encryptedSecrets !== undefined && !isPlainObject(document.encryptedSecrets)) throw new BackupError('Блок зашифрованных ключей повреждён.', 'BAD_FILE');
    return cloneSafe(document);
  }

  function previewDocument(document, overwriteExisting, mode) {
    const replace = mode === 'replace';
    const rows = [];
    let totals = { added: 0, overwritten: 0, conflicts: 0, unchanged: 0, removed: 0 };
    const keys = replace ? DATASETS.map((item) => item.key) : Object.keys(document.data);
    for (const key of keys) {
      const item = DATASET_BY_KEY.get(key);
      const incoming = document.data[key];
      const current = readDataset(item);
      if (replace && incoming === undefined) {
        const removed = current === undefined ? 0 : countLeaves(current);
        totals.removed += removed;
        rows.push({ key, file: item.file, title: item.title, action: current === undefined ? 'без изменений' : 'будет очищено', added: 0, overwritten: 0, preservedConflicts: 0, removed });
        continue;
      }
      const counts = { added: 0, overwritten: 0, conflicts: 0, unchanged: 0 };
      if (replace) {
        if (current === undefined) counts.added = countLeaves(incoming);
        else if (canonical(current) !== canonical(incoming)) { counts.conflicts = 1; counts.overwritten = countLeaves(incoming); }
        else counts.unchanged = 1;
      } else {
        mergeTree(current, incoming, !!overwriteExisting, counts);
      }
      totals.added += counts.added;
      totals.overwritten += counts.overwritten;
      totals.conflicts += counts.conflicts;
      totals.unchanged += counts.unchanged;
      rows.push({
        key,
        file: item.file,
        title: item.title,
        action: counts.overwritten ? 'будет обновлено' : (counts.added ? 'будет добавлено/объединено' : (counts.conflicts ? 'совпадения останутся без изменений' : 'без изменений')),
        added: counts.added,
        overwritten: counts.overwritten,
        preservedConflicts: overwriteExisting || replace ? 0 : counts.conflicts,
        removed: 0
      });
    }
    return {
      formatVersion: FORMAT_VERSION,
      sourceFormat: document.sourceFormat || FORMAT,
      warnings: document.sourceFormat === LEGACY_FORMAT
        ? ['Импортируется ранний формат задания J без исходных контрольных сумм. Проверьте состав и предпросмотр перед применением.'] : [],
      createdAt: document.createdAt || null,
      appVersion: document.appVersion || 'не указана',
      backupType: document.backupType || 'manual',
      mode: replace ? 'replace' : 'merge',
      overwriteExisting: !!overwriteExisting,
      datasets: rows,
      totals,
      keys: {
        included: !!document.encryptedSecrets,
        encrypted: !!document.encryptedSecrets,
        applyRequiresPassword: !!document.encryptedSecrets,
        applied: false
      }
    };
  }

  function makeTransaction(operations, newSecrets) {
    const txRoot = path.join(dataDir, '.wbpm-transactions');
    const txDir = path.join(txRoot, 'tx-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex'));
    const oldDir = path.join(txDir, 'old');
    const stageDir = path.join(txDir, 'stage');
    fs.mkdirSync(oldDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const targets = [];
    try {
      for (const operation of operations) {
        if (!SAFE_TARGETS.has(operation.file)) throw new BackupError('Попытка изменить неизвестный файл данных.', 'BAD_FILE');
        const targetPath = path.join(dataDir, operation.file);
        const hadBefore = fs.existsSync(targetPath);
        if (hadBefore) fs.copyFileSync(targetPath, path.join(oldDir, operation.file));
        if (operation.action === 'write') fs.writeFileSync(path.join(stageDir, operation.file), operation.content, { mode: 0o600 });
        targets.push({ file: operation.file, hadBefore, action: operation.action });
      }
      if (newSecrets !== null) {
        const hadBefore = fs.existsSync(path.join(dataDir, SECRETS_FILE));
        if (hadBefore) fs.copyFileSync(path.join(dataDir, SECRETS_FILE), path.join(oldDir, SECRETS_FILE));
        targets.push({ file: SECRETS_FILE, hadBefore, action: 'secrets' });
      }
      const journalPath = path.join(txDir, 'journal.json');
      atomicWrite(journalPath, JSON.stringify({ version: 1, state: 'applying', targets }, null, 2));
      try {
        for (const target of targets) {
          const dest = path.join(dataDir, target.file);
          if (target.action === 'write') atomicWrite(dest, fs.readFileSync(path.join(stageDir, target.file)));
          else if (target.action === 'delete') fs.rmSync(dest, { force: true });
          else if (target.action === 'secrets') store.saveSecrets(newSecrets);
        }
        atomicWrite(journalPath, JSON.stringify({ version: 1, state: 'committed', targets }, null, 2));
        fs.rmSync(txDir, { recursive: true, force: true });
      } catch (error) {
        try {
          for (const target of targets.slice().reverse()) {
            const dest = path.join(dataDir, target.file);
            if (target.hadBefore) atomicWrite(dest, fs.readFileSync(path.join(oldDir, target.file)));
            else fs.rmSync(dest, { force: true });
          }
          fs.rmSync(txDir, { recursive: true, force: true });
        } catch (rollbackError) {
          throw new BackupError('Импорт прерван, а автоматический откат не завершился. Не закрывайте приложение: повторное восстановление будет выполнено при следующем запуске. Причина: ' + (rollbackError.message || rollbackError), 'ROLLBACK_FAILED');
        }
        throw error;
      }
    } catch (error) {
      if (!fs.existsSync(path.join(txDir, 'journal.json'))) {
        try { fs.rmSync(txDir, { recursive: true, force: true }); } catch (_) {}
      }
      if (error instanceof BackupError) throw error;
      throw new BackupError('Не удалось атомарно записать данные импорта: ' + (error.message || error), 'IMPORT_WRITE_FAILED');
    }
  }

  function applyDocument(document, options) {
    const p = options || {};
    const mode = p.mode === 'replace' ? 'replace' : 'merge';
    const overwriteExisting = p.overwriteExisting === true;
    if ((mode === 'replace' || overwriteExisting) && p.overwriteConfirmed !== true) {
      throw new BackupError('Подтвердите перезапись существующих данных после просмотра состава резервной копии.', 'CONFIRMATION_REQUIRED');
    }
    let importedSecrets = null;
    if (p.applyKeys === true) {
      if (!document.encryptedSecrets) throw new BackupError('В этой резервной копии нет зашифрованных ключей.', 'NO_KEYS');
      importedSecrets = decryptSecrets(document.encryptedSecrets, p.password);
      const existingSecrets = store.loadSecrets();
      const nextSecrets = Object.assign({}, existingSecrets);
      for (const [key, value] of Object.entries(importedSecrets)) {
        if (!WB_SECRET_KEYS.includes(key) || typeof value !== 'string' || !value) continue;
        if (overwriteExisting || !Object.prototype.hasOwnProperty.call(nextSecrets, key)) nextSecrets[key] = value;
      }
      importedSecrets = nextSecrets;
    }

    const preview = previewDocument(document, overwriteExisting, mode);
    const operations = [];
    if (mode === 'replace') {
      for (const item of DATASETS) {
        const hasIncoming = Object.prototype.hasOwnProperty.call(document.data, item.key);
        const current = readDataset(item);
        if (!hasIncoming) {
          if (current !== undefined) operations.push({ file: item.file, action: 'delete' });
          continue;
        }
        const value = document.data[item.key];
        if (current === undefined || canonical(current) !== canonical(value)) {
          operations.push({ file: item.file, action: 'write', content: JSON.stringify(value, null, 2) });
        }
      }
    } else {
      for (const item of DATASETS) {
        if (!Object.prototype.hasOwnProperty.call(document.data, item.key)) continue;
        const current = readDataset(item);
        const merged = mergeTree(current, document.data[item.key], overwriteExisting, { added: 0, overwritten: 0, conflicts: 0, unchanged: 0 });
        if (current === undefined || canonical(current) !== canonical(merged)) {
          operations.push({ file: item.file, action: 'write', content: JSON.stringify(merged, null, 2) });
        }
      }
    }

    // Резервируем текущее состояние до первой записи. Секреты в автоматической копии
    // намеренно не включаются: при неудаче транзакция восстанавливает secrets.enc побайтно.
    const safetyCopy = writeBackup('pre-import');
    try {
      makeTransaction(operations, importedSecrets);
    } catch (error) {
      throw error;
    }
    preview.keys.applied = importedSecrets !== null;
    return { ok: true, applied: true, safetyBackup: safetyCopy.fileName, preview };
  }

  function importBackup(payload) {
    const p = payload || {};
    const document = parseDocument(p.content);
    if (p.action === 'apply') return applyDocument(document, p);
    if (p.action && p.action !== 'preview') throw new BackupError('Неизвестное действие импорта.', 'BAD_ACTION');
    return previewDocument(document, p.overwriteExisting === true, p.mode === 'replace' ? 'replace' : 'merge');
  }

  function safeBackupName(value) {
    const fileName = String(value || '');
    if (path.basename(fileName) !== fileName || !/^[A-Za-z0-9._-]{1,180}\.wbpm\.json$/.test(fileName)) {
      throw new BackupError('Укажите резервную копию из списка приложения.', 'BAD_BACKUP_NAME');
    }
    return path.join(backupsDir, fileName);
  }

  function backupMetadata(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const document = parseDocument(content);
      return {
        fileName: path.basename(filePath),
        createdAt: document.createdAt || '',
        appVersion: document.appVersion || 'не указана',
        backupType: document.backupType || 'manual',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        datasets: document.manifest.datasets.map((entry) => ({ key: entry.key, title: DATASET_BY_KEY.get(entry.key).title, records: Number(entry.records) || 0 })),
        containsKeys: !!document.encryptedSecrets,
        corrupt: false
      };
    } catch (error) {
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (_) {}
      return { fileName: path.basename(filePath), sizeBytes: stat ? stat.size : 0, backupType: 'unknown', datasets: [], containsKeys: false, corrupt: true, error: error.message || String(error) };
    }
  }

  function listBackups() {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const backups = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.wbpm.json'))
      .map((entry) => backupMetadata(path.join(backupsDir, entry.name)))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.fileName.localeCompare(a.fileName));
    const settings = store.loadSettings();
    return {
      backups,
      schedule: ['daily', 'weekly'].includes(settings.backupSchedule) ? settings.backupSchedule : 'off',
      retention: clampRetention(settings.backupRetention),
      lastError,
      maxBytes: MAX_BACKUP_BYTES
    };
  }

  function clampRetention(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 10;
    return Math.max(RETENTION_MIN, Math.min(RETENTION_MAX, n));
  }

  function rotateAutomatic() {
    const automatic = listBackups().backups.filter((item) => item.backupType === 'automatic' && !item.corrupt);
    const keep = clampRetention(store.loadSettings().backupRetention);
    for (const item of automatic.slice(keep)) {
      try { fs.rmSync(safeBackupName(item.fileName), { force: true }); } catch (_) {}
    }
  }

  function createAutomaticBackup() {
    const saved = writeBackup('automatic');
    rotateAutomatic();
    lastError = '';
    return saved;
  }

  function maybeRunScheduled() {
    if (busy) return null;
    const settings = store.loadSettings();
    const schedule = settings.backupSchedule;
    if (schedule !== 'daily' && schedule !== 'weekly') return null;
    const current = now().getTime();
    if (current - lastAttemptAt < 60 * 60 * 1000 && lastAttemptAt) return null;
    const latest = listBackups().backups.find((item) => item.backupType === 'automatic' && !item.corrupt);
    const interval = schedule === 'weekly' ? 7 * 86400000 : 86400000;
    const last = latest ? Date.parse(latest.createdAt) : 0;
    if (last && current - last < interval) return null;
    busy = true;
    lastAttemptAt = current;
    try { return createAutomaticBackup(); }
    catch (error) { lastError = error.message || String(error); return null; }
    finally { busy = false; }
  }

  function startScheduler() {
    if (timer) return;
    maybeRunScheduled();
    timer = setInterval(() => { maybeRunScheduled(); }, 60 * 1000);
    if (timer.unref) timer.unref();
  }

  function stopScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function restoreBackup(payload) {
    const p = payload || {};
    if (p.confirmed !== true) throw new BackupError('Подтвердите восстановление: данные приложения будут заменены содержимым выбранной копии.', 'CONFIRMATION_REQUIRED');
    const filePath = safeBackupName(p.fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new BackupError('Резервная копия не найдена. Обновите список и попробуйте снова.', 'BACKUP_NOT_FOUND');
    const document = parseDocument(fs.readFileSync(filePath, 'utf8'));
    if (document.encryptedSecrets) throw new BackupError('Внутренняя копия содержит зашифрованные ключи; восстановление ключей выполняется только через «Загрузить» с паролем.', 'KEYS_REQUIRE_PASSWORD');
    const result = applyDocument(document, { mode: 'replace', overwriteExisting: true, overwriteConfirmed: true, applyKeys: false });
    return Object.assign(result, { restoredFile: path.basename(filePath) });
  }

  return {
    exportBackup,
    importBackup,
    listBackups,
    restoreBackup,
    startScheduler,
    stopScheduler,
    maybeRunScheduled,
    createAutomaticBackup,
    recover: () => recoverTransactions(dataDir),
    dataDir,
    backupsDir,
    datasets: DATASETS.map((item) => ({ key: item.key, file: item.file, title: item.title })),
    constants: { FORMAT, FORMAT_VERSION, MAX_BACKUP_BYTES }
  };
}

module.exports = {
  createBackupManager,
  recoverTransactions,
  DATASETS,
  FORMAT,
  FORMAT_VERSION,
  MAX_BACKUP_BYTES,
  BackupError
};
