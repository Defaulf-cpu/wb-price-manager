'use strict';

/** Валидация новых локальных настроек; никаких скриптов, секретов или исполняемых правил. */
const A = require('./workspace-analytics');
const Boost = require('./boost-ladder');
const TEMPLATE_FIELDS = Object.freeze({
  targetMarginPct: [-100, 99, 25], minMarginPct: [-100, 99, 0], planSensitivityPct: [0, 30, 8],
  targetTurnoverDays: [1, 365, 7], competitorOffsetPct: [-90, 500, 0], elasticityPct: [0, 100, 12]
});
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const plain = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) return false; const proto = Object.getPrototypeOf(v); return proto === null || Object.getPrototypeOf(proto) === null && Object.prototype.hasOwnProperty.call(proto, 'constructor') && typeof proto.constructor === 'function' && proto.constructor.name === 'Object'; };
function assertTree(value, maxNodes = 500000, maxDepth = 25) {
  let nodes = 0;
  function visit(v, depth) {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error('Настройки превышают допустимый размер или вложенность.');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string' && v.length <= 20000) return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, depth + 1)); return; }
    if (!plain(v)) throw new Error('Некорректная структура локальных настроек.');
    for (const [k, x] of Object.entries(v)) { if (FORBIDDEN.has(k) || k.length > 200) throw new Error('Запрещённое имя поля в настройках.'); visit(x, depth + 1); }
  }
  visit(value, 0); return value;
}
function template(values) {
  if (values === null) return null;
  if (!plain(values)) throw new Error('Некорректные параметры шаблона стратегии.');
  assertTree(values, 100);
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (!TEMPLATE_FIELDS[k]) throw new Error('Недопустимый параметр шаблона: ' + k);
    const [min, max] = TEMPLATE_FIELDS[k];
    if (!A.finite(v) || Number(v) < min || Number(v) > max) throw new Error('Параметр «' + k + '» должен быть от ' + min + ' до ' + max + '.');
    out[k] = Number(v);
  }
  if (out.minMarginPct !== undefined && out.targetMarginPct !== undefined && out.minMarginPct > out.targetMarginPct) throw new Error('Минимальная маржа не должна быть выше целевой.');
  return out;
}
function costPatch(input) {
  if (!plain(input)) throw new Error('Некорректные расходы товара.');
  assertTree(input, 1000, 6);
  const out = { ...input };
  for (const key of ['otherPct', 'otherRub']) if (Object.prototype.hasOwnProperty.call(input, key)) {
    const v = input[key];
    if (v === null || v === '') { out[key] = null; continue; }
    const max = key === 'otherPct' ? 99 : 1000000000;
    if (!A.finite(v) || Number(v) < 0 || Number(v) > max) throw new Error('Прочие расходы: укажите число от 0 до ' + max + (key === 'otherPct' ? ' %.' : ' ₽.'));
    out[key] = Number(v);
  }
  return out;
}
/** Проверка формы архива при импорте. Файл с незнакомой историей не становится «покрытым» автоматически. */
function validateDataset(key, data) {
  if (key === 'repricer') {
    if (data.strategyTemplates !== undefined) {
      if (!plain(data.strategyTemplates) || Object.keys(data.strategyTemplates).length > 20) throw new Error('Слишком много шаблонов стратегий.');
      Object.values(data.strategyTemplates).forEach(template);
    }
    const archive = data.analyticsArchive;
    if (archive !== undefined && archive !== null) {
      if (!plain(archive) || archive.version !== 1 || !/^[a-f0-9]{64}$/.test(archive.context || '') || !plain(archive.days) || Object.keys(archive.days).length > A.MAX_ARCHIVE_DAYS + 1) throw new Error('Некорректный архив ABC.');
      let count = 0;
      for (const [day, record] of Object.entries(archive.days)) {
        if (!A.validDay(day) || !plain(record) || record.covered !== true || !plain(record.products)) throw new Error('Некорректное покрытие дней ABC.');
        for (const [nm, v] of Object.entries(record.products)) {
          if (++count > A.MAX_ARCHIVE_ENTRIES || !/^[1-9]\d*$/.test(nm) || !plain(v) || !Number.isSafeInteger(v.qty) || Math.abs(v.qty) > 100000000 || !A.finite(v.revenue) || Math.abs(v.revenue) > 1e14) throw new Error('Некорректные дневные агрегаты ABC.');
        }
      }
    }
    const spp = data.officialSpp;
    if (spp !== undefined && spp !== null) {
      if (!plain(spp) || !/^[a-f0-9]{64}$/.test(spp.context || '') || !plain(spp.items) || Object.keys(spp.items).length > 150000) throw new Error('Некорректный снимок СПП из ЛК.');
      for (const [nm, v] of Object.entries(spp.items)) if (!/^[1-9]\d*$/.test(nm) || !plain(v) || !A.finite(v.pct) || v.pct < 0 || v.pct > 100 || !Number.isFinite(A.timestamp(v.at)) || !['sales', 'orders'].includes(v.source)) throw new Error('Некорректный источник/значение СПП.');
    }
  }
  if (key === 'costs') for (const v of Object.values(data.items || data || {})) if (plain(v)) costPatch(v);
  if (key === 'itemConfigs') for (const v of Object.values(data.items || {})) {
    if (!plain(v)) throw new Error('Некорректные настройки товара.');
    if (v.boost !== undefined && v.boost !== null) Boost.validate(v.boost);
    const runtime = v.boostRuntime;
    if (runtime !== undefined && runtime !== null) {
      if (!plain(runtime) || runtime.version !== 2 || !A.validDay(runtime.day) || !plain(runtime.seen) || Object.keys(runtime.seen).length > Boost.MAX_LEDGER) throw new Error('Некорректный счётчик лесенки.');
      for (const [id, entry] of Object.entries(runtime.seen)) if (!/^[a-f0-9]{32}$/.test(id) || !plain(entry) || !/^[1-9]\d*$/.test(entry.promoId || '') || typeof entry.canceled !== 'boolean') throw new Error('Счётчик лесенки содержит недопустимые записи.');
    }
  }
}
module.exports = { TEMPLATE_FIELDS, plain, assertTree, template, costPatch, validateDataset };
