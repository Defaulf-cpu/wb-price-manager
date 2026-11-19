'use strict';

/** Официальная оперативная статистика WB. Отсутствие ответа никогда не означает нулевые продажи. */
const DAY = 86400000, MSK = 10800000;
const MAX_ARCHIVE_DAYS = 190, MAX_ARCHIVE_ENTRIES = 250000;
const finite = (v) => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v));
const number = (v, fallback = 0) => finite(v) ? Number(v) : fallback;
function dayKey(at = Date.now()) {
  const n = Number(at);
  return Number.isFinite(n) && Math.abs(n + MSK) <= 8640000000000000 ? new Date(n + MSK).toISOString().slice(0, 10) : '';
}
function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const s = value.trim();
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(s) ? s + '+03:00' : /^\d{4}-\d\d-\d\d$/.test(s) ? s + 'T00:00:00+03:00' : s);
}
function validDay(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && dayKey(timestamp(s)) === s; }
const canceled = (r) => !!(r && (r.isCancel === true || r.isCancel === 1 || r.isCancel === 'true' || r.isCancel === '1'));
const returned = (r) => !!(r && (r.isReturn === true || r.return === true || /^R/i.test(String(r.saleID || ''))));
/** До СПП. Ни finishedPrice (покупатель), ни forPay (перечисление), ни старое price не подменяют цену продавца. */
function sellerPrice(r) {
  if (finite(r && r.priceWithDisc) && Number(r.priceWithDisc) > 0) return Number(r.priceWithDisc);
  if (finite(r && r.totalPrice) && Number(r.totalPrice) > 0 && finite(r.discountPercent) && Number(r.discountPercent) >= 0 && Number(r.discountPercent) < 100) return Number(r.totalPrice) * (1 - Number(r.discountPercent) / 100);
  return null;
}
/** На границе страниц WB может повторить строку. Для одного id выигрывает последнее изменение (отмена тоже). */
function dedupe(rows, kind) {
  const unique = new Map(), withoutId = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { withoutId.push(r); continue; }
    const id = kind === 'sales' ? r.saleID : r.srid;
    if (typeof id !== 'string' || !id.trim()) { withoutId.push(r); continue; }
    const key = String(r.nmId || r.nmID || '') + ':' + id, old = unique.get(key);
    const at = timestamp(r.lastChangeDate || r.cancelDate || r.date), before = old && timestamp(old.lastChangeDate || old.cancelDate || old.date);
    if (!old || !Number.isFinite(before) || at >= before || !Number.isFinite(at)) unique.set(key, r);
  }
  return [...unique.values(), ...withoutId];
}
function latestSpp(rows, source, previous = {}, now = Date.now()) {
  const out = { ...previous };
  for (const r of dedupe(rows, source)) {
    if (!r) continue;
    const nm = String(r.nmId || r.nmID || ''), t = timestamp(r.date), spp = r.spp;
    // Нулевые цены WB заполняет асинхронно: такая строка ещё не доказывает СПП = 0.
    if (!/^[1-9]\d*$/.test(nm) || canceled(r) || returned(r) || !Number.isFinite(t) || t > now + 60000 || sellerPrice(r) === null || !finite(spp) || Number(spp) < 0 || Number(spp) > 100) continue;
    if (!out[nm] || t >= timestamp(out[nm].at)) out[nm] = { pct: Number(spp), at: new Date(t).toISOString(), receivedAt: new Date(now).toISOString(), source, estimated: true };
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => timestamp(b[1].at) - timestamp(a[1].at)).slice(0, 150000));
}

/** Архив дневных агрегатов, без srid и персональных полей. Полный повтор ЗАМЕНЯЕТ дни целиком. */
function archiveSales(previous, rows, from, now = Date.now(), complete = true) {
  const oldest = dayKey(now - MAX_ARCHIVE_DAYS * DAY), yesterday = dayKey(now - DAY);
  const days = Object.fromEntries(Object.entries(previous && previous.days || {}).filter(([k, v]) => validDay(k) && k >= oldest && k <= yesterday && v && v.covered === true));
  const startAt = timestamp(from), firstDay = dayKey(startAt);
  // Запрос с полудня не покрывает первую половину суток. Также не обещаем полный самый старый день на границе 90 суток хранения WB.
  const start = validDay(firstDay) ? dayKey(startAt > timestamp(firstDay) ? timestamp(firstDay) + DAY : startAt) : '';
  const safeStart = dayKey(now - 89 * DAY), begin = start && (start > safeStart ? start : safeStart);
  const buckets = {};
  let valid = complete === true && !!begin && Array.isArray(rows), invalidRows = 0;
  for (const r of dedupe(rows, 'sales')) {
    const t = timestamp(r && r.date), nm = String(r && (r.nmId || r.nmID) || '');
    if (!Number.isFinite(t) || !/^[1-9]\d*$/.test(nm)) { valid = false; invalidRows++; continue; }
    const date = dayKey(t);
    if (!begin || date < begin || date > yesterday) continue;
    const id = r.saleID, price = sellerPrice(r);
    if (typeof id !== 'string' || !id.trim() || price === null) { valid = false; invalidRows++; continue; }
    const sign = returned(r) ? -1 : 1, products = buckets[date] || (buckets[date] = {}), entry = products[nm] || (products[nm] = { qty: 0, revenue: 0 });
    entry.qty += sign; entry.revenue = Math.round((entry.revenue + sign * price) * 100) / 100;
  }
  if (valid) for (let at = timestamp(begin); dayKey(at) <= yesterday; at += DAY) {
    const date = dayKey(at);
    days[date] = { covered: true, products: buckets[date] || {}, updatedAt: new Date(now).toISOString() };
  }
  let entries = Object.values(days).reduce((n, d) => n + Object.keys(d.products || {}).length, 0), trimmed = false;
  for (const key of Object.keys(days).sort()) if (entries > MAX_ARCHIVE_ENTRIES) { entries -= Object.keys(days[key].products || {}).length; delete days[key]; trimmed = true; }
  return { version: 1, days, updatedAt: new Date(now).toISOString(), lastComplete: valid, invalidRows, trimmed, source: 'statistics-sales', provisional: true };
}

/** Границы 80/95% по вкладу ДО группы одинаковых значений: равные вклады не разрезаем. */
function classify(values) {
  const out = {}, sorted = Object.entries(values).filter(([, n]) => finite(n) && n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  Object.entries(values).forEach(([nm, n]) => { out[nm] = finite(n) ? 'C' : '?'; });
  let cumulative = 0;
  for (let i = 0; i < sorted.length;) {
    const value = sorted[i][1], letter = cumulative / total < .8 - 1e-12 ? 'A' : cumulative / total < .95 - 1e-12 ? 'B' : 'C';
    let j = i;
    while (j < sorted.length && Math.abs(sorted[j][1] - value) < 1e-9) { out[sorted[j][0]] = letter; cumulative += sorted[j][1]; j++; }
    i = j;
  }
  return out;
}
/** Три фактора: выручка / оценочная прибыль / количество, по 30/90/180 закрытым дням МСК. */
function abc(archive, nmIDs, profitForTotals, now = Date.now()) {
  const days = archive && archive.days || {}, ids = [...new Set(nmIDs.map(String))], out = Object.fromEntries(ids.map((nm) => [nm, {}]));
  for (const window of [30, 90, 180]) {
    const from = dayKey(now - window * DAY), to = dayKey(now - DAY), keys = [];
    for (let at = timestamp(from); dayKey(at) <= to; at += DAY) keys.push(dayKey(at));
    const missing = keys.filter((key) => !days[key] || days[key].covered !== true);
    if (missing.length) { Object.values(out).forEach((r) => { r[window] = { known: false, missingDays: missing.length, from, to }; }); continue; }
    const revenue = {}, qty = {}, profit = {};
    ids.forEach((nm) => { revenue[nm] = 0; qty[nm] = 0; });
    for (const key of keys) for (const [nm, value] of Object.entries(days[key].products || {})) {
      if (!Object.prototype.hasOwnProperty.call(revenue, nm)) continue;
      revenue[nm] += number(value.revenue); qty[nm] += number(value.qty);
    }
    ids.forEach((nm) => { const p = profitForTotals(nm, revenue[nm], qty[nm]); profit[nm] = finite(p) ? Math.round(p * 100) / 100 : null; });
    const a = classify(revenue), b = classify(profit), c = classify(qty);
    ids.forEach((nm) => { out[nm][window] = { known: true, code: a[nm] + b[nm] + c[nm], revenue: Math.round(revenue[nm] * 100) / 100, profit: profit[nm], qty: qty[nm], from, to, estimatedProfit: true, provisional: true }; });
  }
  return out;
}
function issuesFor(r, hasDraft = false) {
  const issues = [], add = (code, message, level = 'critical') => { if (!issues.some((i) => i.message === message)) issues.push({ code, message, level }); };
  if (r.error) { add('CALC_ERROR', String(r.error)); return issues; }
  const cur = r.current || {}, next = r.proposed || {}, cost = r.cost || {}, corridor = r.corridor || {};
  if (cost.error || r.costError) add('COST_CURRENCY', String(cost.error || r.costError));
  if (!(Number(cur.costPriceRub) > 2)) add('COST_MISSING', 'себестоимость должна быть больше 2 ₽');
  if (!(Number(cur.basePrice) > 0) && !hasDraft) add('BASE_MISSING', 'базовая цена в WB не задана — сохраните свою цену или обновите данные из кабинета');
  if (!(Number(corridor.min) > 0)) add('MIN_MISSING', 'Не задан минимальный порог цены');
  if (Number(corridor.min) > Number(corridor.max) + .01) add('CORRIDOR', 'Минимальная цена выше максимальной');
  if (Number(r.maxPrice) > 0 && finite(next.sellerPrice) && Number(next.sellerPrice) > Number(r.maxPrice) + .011) add('MAX_PRICE', 'Новая цена выше потолка карточки maxPrice ' + Math.round(Number(r.maxPrice)) + ' ₽');
  if (r.promoExitBlockedByMaxPrice) add('PROMO_EXIT_MAX_PRICE', 'Выход из акции заблокирован потолком карточки maxPrice: цена выхода выше потолка');
  if (!finite(next.basePrice) || !(Number(next.basePrice) > 0) || !finite(next.discount) || Number(next.discount) < 0 || Number(next.discount) > 95 || !finite(next.sellerPrice) || !(Number(next.sellerPrice) > 0)) add('PRICE_INVALID', 'Некорректная рассчитанная цена или скидка');
  if (finite(next.sellerPrice) && Number(next.sellerPrice) < Number(corridor.min) - .011) add('BELOW_MIN', 'Новая цена после округления ниже безопасного минимума');
  if (!finite(next.profit) || !finite(next.marginPct)) add('ECONOMICS_INVALID', 'Невозможно достоверно рассчитать прибыль и маржу');
  if (r.boost && r.boost.blocked) add('BOOST_BLOCKED', r.boost.reason || 'Лесенка приостановлена: небезопасные условия');
  if (r.boost && r.boost.warning) add('BOOST_WARNING', r.boost.warning, 'warning');
  if (r.boost && hasDraft) add('BOOST_MANUAL_PRICE', 'Для работы лесенки уберите ручной черновик цены или выберите другую стратегию');
  if (Number(next.profit) < -.005 && !r.negativeMarginAllowed) add('LOSS_GUARD', 'Новая цена даёт убыток при запрете отрицательной маржи');
  (r.warnings || []).forEach((message) => add('RP_WARNING', String(message), 'warning'));
  return issues;
}
module.exports = { DAY, MSK, MAX_ARCHIVE_DAYS, MAX_ARCHIVE_ENTRIES, finite, number, dayKey, timestamp, validDay, canceled, returned, sellerPrice, dedupe, latestSpp, archiveSales, classify, abc, issuesFor };
