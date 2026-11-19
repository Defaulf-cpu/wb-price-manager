'use strict';

/** Чистый автомат лесенки. Цена ниже порога — лишь ценовое соответствие, не подтверждённое членство WB. */
const crypto = require('crypto');
const A = require('./workspace-analytics');
const MAX_LEDGER = 100000;
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32);
const signature = (config) => hash(canonical(config || {}));
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Настройте ступени лесенки.');
  const durationDays = Number(input.durationDays), startDate = String(input.startDate || A.dayKey());
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) throw new Error('Срок лесенки: целое число от 1 до 365 дней.');
  if (!A.validDay(startDate)) throw new Error('Некорректная дата начала лесенки.');
  const seen = new Set(), steps = [];
  for (const row of Array.isArray(input.steps) ? input.steps : []) {
    if (!row || typeof row !== 'object') throw new Error('Некорректная ступень лесенки.');
    const promoId = String(row.promoId), quota = Number(row.quota), minMarginPct = Number(row.minMarginPct);
    if (!/^[1-9]\d*$/.test(promoId) || !Number.isSafeInteger(Number(promoId)) || seen.has(promoId) || !Number.isInteger(quota) || quota < 1 || quota > 100000 || !A.finite(row.minMarginPct) || minMarginPct < -100 || minMarginPct >= 100) throw new Error('Проверьте акции, количество и минимальную маржу лесенки.');
    seen.add(promoId); steps.push({ promoId, quota, minMarginPct });
  }
  if (!steps.length || steps.length > 30) throw new Error('Выберите от 1 до 30 уникальных ступеней с положительным количеством заказов.');
  steps.sort((a, b) => Number(a.promoId) - Number(b.promoId));
  return { startDate, durationDays, resetDaily: true, steps };
}
function plan(ctx, input, previous, snapshot, context, now = Date.now()) {
  const currentPrice = Number(ctx.sellerPrice) || 0;
  const blocked = (reason, runtime) => ({ blocked: true, reason, target: currentPrice, status: 'blocked', runtime: runtime || null });
  let c;
  try { c = validate(input); } catch (e) { return blocked(e.message, previous); }
  if (input.requiresRestart) return blocked('После импорта подтвердите настройки лесенки заново: старый счётчик не применяется автоматически.');
  const runId = input.runId || signature(c), day = A.dayKey(now), start = A.timestamp(c.startDate), until = start + c.durationDays * A.DAY;
  const fingerprint = signature(c), sameRun = previous && previous.version === 2 && previous.day === day && previous.context === context && previous.fingerprint === fingerprint && previous.runId === runId;
  let runtime = sameRun ? JSON.parse(JSON.stringify(previous)) : {
    version: 2, day, context, fingerprint, runId, cursor: 0, counts: {}, seen: {}, completed: [],
    transitionAt: Math.max(A.timestamp(day), A.timestamp(input.startedAt) || start, start), activeSince: null, startPrice: currentPrice
  };
  if (sameRun && (!Number.isInteger(runtime.cursor) || runtime.cursor < 0 || runtime.cursor > c.steps.length || !A.finite(runtime.transitionAt) || runtime.activeSince !== null && (!A.finite(runtime.activeSince) || runtime.activeSince < runtime.transitionAt || runtime.activeSince > now) || !Array.isArray(runtime.completed))) return blocked('Повреждены параметры подтверждения счётчика лесенки. Проверьте заказы и перезапустите её явно.', runtime);
  const byId = new Map((ctx.promos || []).map((p) => [String(p.id), p])), all = [];
  for (const s of c.steps) {
    const p = byId.get(s.promoId);
    // Закончившуюся акцию можно распознать по сохранённым датам своего запуска, но активный порог обязан снова быть проверен.
    const ended = !p && sameRun && (runtime.evidence || []).find((e) => e.promoId === s.promoId && e.end <= now);
    if (ended) { all.push({ ...s, ...ended }); continue; }
    if (!p || !(Number(p.planPrice) > 0) || !(p.absolutePlan === true || p.source === 'api')) return blocked('Нет проверенного точного порога выбранной акции ' + s.promoId + '. Обновите файл/состав текущего кабинета.', runtime);
    const from = A.timestamp(p.startDateTime), end = A.timestamp(p.endDateTime);
    if (!Number.isFinite(from) || !Number.isFinite(end) || end <= from) return blocked('Для лесенки необходимы достоверные даты акции ' + s.promoId + '.', runtime);
    all.push({ ...s, price: Number(p.planPrice), name: String(p.name || s.promoId), from, end });
  }
  all.sort((a, b) => a.price - b.price || Number(a.promoId) - Number(b.promoId));
  if (all.some((s, i) => i && Math.abs(s.price - all[i - 1].price) < .02)) return blocked('У выбранных акций одинаковые или неразличимые по копейкам пороги. Оставьте одну ступень для каждой цены.', runtime);
  const evidence = all.map(({ promoId, price, name, from, end }) => ({ promoId, price, name, from, end })), evidenceHash = signature(evidence);
  if (sameRun && runtime.evidenceHash && runtime.evidenceHash !== evidenceHash) return blocked('Изменились проверенные цены или даты ступеней. Проверьте редактор и явно перезапустите лесенку.', runtime);
  runtime.evidence = evidence; runtime.evidenceHash = evidenceHash;
  const active = all.filter((s) => s.from <= now && now < s.end), eligible = all.filter((s) => now < s.end);
  const exitTarget = () => Math.ceil(Math.max(currentPrice, ...active.map((s) => s.price * 1.02 + 1)));
  const finish = (status, reason) => ({ status, exit: true, target: exitTarget(), threshold: active.length ? Math.max(...active.map((s) => s.price)) : 0, minMarginPct: 0, reason, runtime, day, until: new Date(until).toISOString() });
  if (now < start) return { status: 'scheduled', target: currentPrice, reason: 'Начало ' + c.startDate + ', МСК. До начала цену не меняем.', runtime, day };
  if (now >= until) return finish('expired', 'Срок лесенки истёк. Держим цену выше выбранных действующих порогов; дальнейшие дневные циклы прекращены.');
  if (!active.length) return { status: eligible.length ? 'waiting' : 'finished', target: currentPrice, reason: eligible.length ? 'Ожидаем начала выбранной акции, цену не меняем' : 'Выбранные акции завершены, лесенка закончена', runtime, day };
  if (!snapshot || snapshot.complete !== true || !A.finite(snapshot.at) || now < snapshot.at || now - snapshot.at > 180000 || snapshot.context !== context || snapshot.day !== day || !Array.isArray(snapshot.rows)) return blocked(snapshot && snapshot.error || 'Нет свежего полного снимка заказов WB за текущий день. Лесенка приостановлена.', runtime);
  if (!runtime.seen || typeof runtime.seen !== 'object' || Array.isArray(runtime.seen) || Object.keys(runtime.seen).length > MAX_LEDGER) return blocked('Счётчик лесенки повреждён или превысил безопасный объём. Требуется проверка и явный перезапуск.', runtime);
  let ledgerSize = Object.keys(runtime.seen).length;
  if (Object.entries(runtime.seen).some(([key, value]) => !/^[a-f0-9]{32}$/.test(key) || !value || typeof value !== 'object' || !c.steps.some((s) => s.promoId === value.promoId) || typeof value.canceled !== 'boolean')) return blocked('Счётчик лесенки содержит недопустимые записи. Требуется явный перезапуск.', runtime);
  const rows = A.dedupe(snapshot.rows, 'orders').filter((r) => Number(r && (r.nmId || r.nmID)) === Number(ctx.nmID));
  // Поздняя отмена корректирует видимый счётчик, но НИКОГДА не возвращает товар на дешёвую ступень.
  for (const r of rows) if (typeof r.srid === 'string') {
    const old = runtime.seen[hash(r.srid)];
    if (old && A.canceled(r)) old.canceled = true;
  }
  const updateCounts = () => { runtime.counts = {}; Object.values(runtime.seen).forEach((r) => { if (r && !r.canceled) runtime.counts[r.promoId] = (runtime.counts[r.promoId] || 0) + 1; }); };
  updateCounts();
  const completed = new Set(runtime.completed || []);
  let index = all.findIndex((s, i) => i >= runtime.cursor && s.from <= now && now < s.end && !completed.has(s.promoId));
  if (index < 0) {
    const future = all.some((s, i) => i >= runtime.cursor && s.from > now);
    return future ? finish('waiting-next', 'Доступные ступени на сегодня закончены. Держим цену выше действующих порогов до следующей ступени.') : finish('day-complete', 'Дневные квоты выполнены. Выход до 00:00 МСК, затем новый цикл в пределах заданного срока.');
  }
  if (index !== runtime.cursor) { runtime.cursor = index; runtime.transitionAt = now; runtime.activeSince = null; }
  let step = all[index], previousThreshold = index ? all[index - 1].price : 0;
  const observed = A.timestamp(ctx.priceObservedAt);
  if (runtime.activeSince === null && Number.isFinite(observed) && observed >= runtime.transitionAt && currentPrice <= step.price + .005 && currentPrice > previousThreshold + .005) {
    runtime.activeSince = Math.max(observed, runtime.transitionAt); runtime.activatedPrice = currentPrice;
  }
  if (runtime.activeSince !== null) for (const r of rows) {
    const created = A.timestamp(r.date);
    if (!Number.isFinite(created)) return blocked('В заказах WB отсутствует достоверная дата. Подсчёт приостановлен.', runtime);
    if (created < runtime.activeSince || created > now || A.dayKey(created) !== day) continue;
    if (typeof r.srid !== 'string' || !r.srid.trim()) return blocked('В заказах WB нет srid: невозможно безопасно исключить повторный подсчёт.', runtime);
    const price = A.sellerPrice(r), key = hash(r.srid);
    if (price === null && !A.canceled(r)) return blocked('WB ещё не заполнил цену продавца в заказах. Подсчёт приостановлен до обновления.', runtime);
    if (price !== null && price <= step.price + .005 && price > previousThreshold + .005 && !runtime.seen[key]) {
      if (ledgerSize >= MAX_LEDGER) return blocked('Достигнут безопасный объём дневного счётчика. Проверьте заказы и завершите день вручную.', runtime);
      runtime.seen[key] = { promoId: step.promoId, canceled: A.canceled(r) }; ledgerSize++;
    }
  }
  updateCounts();
  if ((runtime.counts[step.promoId] || 0) >= step.quota) {
    completed.add(step.promoId); runtime.completed = [...completed]; runtime.cursor = index + 1; runtime.transitionAt = now; runtime.activeSince = null;
    index = all.findIndex((s, i) => i >= runtime.cursor && s.from <= now && now < s.end);
    if (index < 0) return finish('day-complete', 'Дневные квоты выполнены. Выход до 00:00 МСК; затем новый цикл в пределах срока.');
    runtime.cursor = index; step = all[index]; previousThreshold = index ? all[index - 1].price : 0;
  }
  const economics = ctx.econAt(step.price);
  if (!economics || !A.finite(economics.marginPct) || economics.marginPct < step.minMarginPct - .005) return blocked('Маржа ступени «' + step.name + '» ' + (economics && economics.marginPct) + '% ниже заданного минимума ' + step.minMarginPct + '%.', runtime);
  return { status: 'step', target: step.price, threshold: step.price, priorThreshold: previousThreshold, minMarginPct: step.minMarginPct,
    promoId: step.promoId, promoName: step.name, count: runtime.counts[step.promoId] || 0, quota: step.quota, counting: runtime.activeSince !== null,
    marginPct: economics.marginPct, profit: economics.profit, runtime, day, until: new Date(until).toISOString(),
    reason: 'Ступень «' + step.name + '»: ' + (runtime.counts[step.promoId] || 0) + '/' + step.quota + ' заказов · порог ' + step.price + ' ₽.' + (runtime.activeSince === null ? ' Счётчик ждёт свежего подтверждения цены WB в диапазоне ступени.' : ''),
    warning: 'Заказы и применение цен WB запаздывают: ровно N заказов гарантировать нельзя. Известные отмены вычитаются, пройденные ступени не переоткрываются. Цена может подходить нескольким акциям.' };
}
function checkResult(result, plan, good) {
  const b = { ...plan }; delete b.runtime;
  const proposed = result.proposed || {}, price = Number(proposed.basePrice) * (1 - Number(proposed.discount) / 100);
  if (!b.blocked && b.status === 'step') {
    if (Number((result.corridor || {}).min) > b.threshold + .005) { b.blocked = true; b.reason = 'Минимальная безопасная цена выше порога ступени.'; }
    if (price > b.threshold + .005) b.warning = 'Приближаемся к порогу с соблюдением лимитов. Счётчик пока не активен. ' + (b.warning || '');
    if (b.priorThreshold && price <= b.priorThreshold + .005) { b.blocked = true; b.reason = 'Округление/лимиты не позволяют безопасно выйти из предыдущей ступени. Измените ограничения или цену вручную.'; }
    if (price <= b.threshold + .005 && (!A.finite(proposed.marginPct) || Number(proposed.marginPct) < b.minMarginPct - .005)) { b.blocked = true; b.reason = 'После округления маржа ниже минимума ступени.'; }
  }
  if (b.exit && (!Number.isFinite(price) || price <= Number(b.threshold) + .005)) { b.blocked = true; b.reason = 'При действующих ограничениях цена не выше порога акции. Безопасный выход не достигнут; отправка заблокирована.'; }
  if (['scheduled', 'waiting', 'finished'].includes(b.status) && Math.abs(price - Number((result.current || {}).sellerPrice)) > .01) { b.blocked = true; b.reason = 'В ожидании/после завершения лесенка не должна менять цену. Проверьте защитные ограничения.'; }
  if (good && good.editableSizePrice && (good.sizes || []).length && (result.context || {}).sizePriceMode !== 'sync') { b.blocked = true; b.reason = 'Для лесенки размерного товара нужны синхронные цены всех размеров (sync).'; }
  return b;
}
module.exports = { MAX_LEDGER, validate, signature, plan, checkResult };
