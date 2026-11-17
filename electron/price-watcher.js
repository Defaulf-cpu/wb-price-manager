'use strict';

// Неофициальная витрина: автоматизация может нарушать правила WB и привести к блокировке.
// При блокировке дальнейшие запросы в этом экземпляре отключаются, без ретраев.
const BLOCK_MESSAGE = 'Витрина WB заблокировала автоматический запрос; введите цену вручную или откройте страницу кнопкой.';
const error = (code, message) => ({ ok: false, code, message });
const idOf = (v) => {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return /^[1-9]\d{0,14}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
};
const number = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const first = (...values) => {
  for (const v of values) { const n = number(v); if (n !== null) return n; }
  return null;
};
const rub = (n) => n === null ? null : Math.round(n) / 100;
const pct = (shelf, buyer) => shelf > 0 && buyer !== null ? Math.round((1 - buyer / shelf) * 10000) / 100 : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseProduct(data, nmID) {
  const list = data && (data.data && data.data.products || data.products || data.data && data.data.items || data.items);
  if (!Array.isArray(list)) return error('PARSE_FAILED', 'Неизвестная схема ответа витрины WB.');
  const product = list.find((p) => p && typeof p === 'object' && String(p.id || p.nmID || p.nmId) === nmID) ||
    (list.length === 1 && list[0] && typeof list[0] === 'object' && !('id' in list[0]) && !('nmID' in list[0]) && !('nmId' in list[0]) ? list[0] : null);
  if (!product) return error('NOT_FOUND', 'Товар не найден на витрине WB.');
  const card = product.card || {};
  const size = Array.isArray(product.sizes) ? product.sizes[0] || {} : {};
  const p = size.price || product.price || {};
  // Все поля *U/*Uom и sizes.price заданы в копейках. Не подменяем неизвестную
  // цену с СПП ценой продавца: наличие двух разных полей нельзя предполагать.
  const base = rub(first(p.basic, product.priceU, card.priceUom, product.priceUom));
  const shelf = rub(first(p.product, product.salePriceU, card.salePriceUom, product.salePriceUom, product.priceUom));
  const buyer = rub(first(p.total, product.salePriceWithSppU, product.priceWithSppU, card.priceWithSppUom, product.priceWithSppUom));
  if (shelf === null || shelf <= 0) return error('PARSE_FAILED', 'В ответе WB не найдена достоверная цена продавца.');
  let stock = first(product.totalQuantity, product.stock, card.stock);
  if (stock === null) {
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const lists = [product.stocks, product.wh, ...sizes.map((s) => s && s.stocks)].filter(Array.isArray);
    const quantities = lists.flat().map((x) => x && first(x.qty, x.quantity, x.stock)).filter((x) => x !== null && x !== undefined);
    if (quantities.length) stock = quantities.reduce((a, b) => a + b, 0);
  }
  const discount = first(product.sale, product.discount, card.sale, card.discount);
  return { ok: true, nmID: Number(nmID), basePrice: base, shelfPrice: shelf, sppPrice: buyer,
    sppPct: pct(shelf, buyer), sellerDiscountPct: discount, stock,
    title: String(product.name || product.title || card.name || ''), brand: String(product.brand || card.brand || ''),
    at: new Date().toISOString(), source: 'site' };
}

function createPriceWatcher(options) {
  const o = options || {};
  const store = o.store;
  if (!store) throw new Error('price-watcher: store обязателен');
  const cache = new Map();
  const inFlight = new Map();
  const interval = Number.isFinite(o.minIntervalMs) && o.minIntervalMs >= 0 ? o.minIntervalMs : 3000;
  let queue = Promise.resolve();
  let lastRequestAt = 0;
  let blocked = false;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const onCompetitorPriceChange = typeof o.onCompetitorPriceChange === 'function' ? o.onCompetitorPriceChange : () => {};
  const safeLog = (entry) => { try { log(entry); } catch (_) {} };
  const ttlMs = () => {
    const s = typeof store.loadSettings === 'function' ? store.loadSettings() : {};
    const n = number(o.ttlMinutes !== undefined ? o.ttlMinutes : s.priceWatchTtlMinutes);
    return (n === null ? 60 : n) * 60000;
  };

  // В проекте старые id конкурентов могут быть случайными: SKU хранится отдельно.
  // Не меняем id/enabled, а при отсутствии записи создаём её только для явно указанного nmID.
  function updateCompetitors(sku, patch, ownID) {
    if (!sku || typeof store.loadCompetitors !== 'function') return;
    const items = store.loadCompetitors();
    let changed = false;
    const priceChanges = [];
    for (const key of Object.keys(items)) {
      if (ownID && key !== ownID) continue;
      if (!Array.isArray(items[key])) continue;
      items[key] = items[key].map((c) => {
        if (!c || String(c.sku || c.competitorSKU || c.nmID || c.id) !== sku) return c;
        changed = true;
        const oldPrice = Number(c.price);
        const newPrice = patch && patch.price !== undefined ? Number(patch.price) : oldPrice;
        if (oldPrice > 0 && newPrice > 0 && Math.abs(oldPrice - newPrice) >= 0.01) {
          priceChanges.push({ sku: Number(sku), oldPrice, newPrice, nmID: ownID ? Number(ownID) : undefined });
        }
        return Object.assign({}, c, patch, { sku: Number(sku) });
      });
    }
    if (ownID && !changed) {
      const list = Array.isArray(items[ownID]) ? items[ownID] : [];
      items[ownID] = list.concat([Object.assign({ id: sku, sku: Number(sku), name: 'Конкурент ' + sku, enabled: true, price: 0, stock: null }, patch)]);
      changed = true;
    }
    if (changed) store.saveCompetitors(items);
    for (const event of priceChanges) {
      try { onCompetitorPriceChange(event); } catch (_) { /* уведомление не влияет на запись наблюдения */ }
    }
  }

  function recordManual(input) {
    try {
      const x = input || {}, nm = idOf(x.nmID), sku = idOf(x.competitorSKU);
      if (!nm || (x.competitorSKU != null && x.competitorSKU !== '' && !sku)) return error('INVALID_ID', 'Укажите корректный nmID и SKU конкурента.');
      const fields = ['shelfPrice', 'sppPrice', 'competitorPrice', 'competitorStock'];
      for (const key of fields) if (x[key] != null && x[key] !== '' && number(x[key]) === null) return error('INVALID_VALUE', 'Некорректное значение: ' + key);
      const shelf = number(x.shelfPrice), buyer = number(x.sppPrice);
      const cp = number(x.competitorPrice), cs = number(x.competitorStock);
      if ((cp !== null || cs !== null) && !sku) return error('INVALID_ID', 'Для цены конкурента укажите его SKU.');
      if (shelf === null && buyer === null && cp === null && cs === null) return error('INVALID_VALUE', 'Укажите хотя бы одну цену или остаток.');
      const at = new Date().toISOString(), sppPct = pct(shelf, buyer);
      if (shelf !== null || buyer !== null) store.appendPriceWatch([{ nmID: nm, at, shelfPrice: shelf, sppPrice: buyer, sppPct, stock: null, source: String(x.source || 'manual'), note: String(x.note || '') }]);
      if (sku && (cp !== null || cs !== null)) {
        const patch = { updatedAt: at };
        if (cp !== null) patch.price = cp;
        if (cs !== null) patch.stock = cs;
        updateCompetitors(sku, patch, nm);
        store.appendPriceWatch([{ nmID: sku, at, shelfPrice: cp, sppPrice: null, sppPct: null, stock: cs, source: String(x.source || 'manual'), note: String(x.note || '') }]);
      }
      return { ok: true, at, sppPct };
    } catch (e) { return error('STORAGE', 'Не удалось сохранить наблюдение: ' + e.message); }
  }

  async function request(nmID) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = 'https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=' + nmID;
      const response = await (o.transport || global.fetch)(url, { signal: controller.signal, redirect: 'manual', headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru-RU,ru;q=0.9',
        'Referer': 'https://www.wildberries.ru/', 'Accept-Encoding': 'gzip'
      } });
      if (response.status === 403 || response.status === 429 || (response.status >= 300 && response.status < 400)) return error('BLOCKED', BLOCK_MESSAGE);
      if (response.status === 404) return error('NOT_FOUND', 'Товар не найден на витрине WB.');
      if (!response.ok) return error('NETWORK', 'Ошибка витрины WB: HTTP ' + response.status);
      const text = await response.text();
      if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text) || /text\/html/i.test(response.headers && response.headers.get('content-type') || '')) return error('BLOCKED', BLOCK_MESSAGE);
      let data;
      try { data = JSON.parse(text); } catch (_) { return error('PARSE_FAILED', 'Витрина WB вернула некорректный JSON.'); }
      return parseProduct(data, nmID);
    } catch (e) { return error('NETWORK', 'Ошибка сети или тайм-аут витрины WB: ' + (e.message || String(e))); }
    finally { clearTimeout(timer); }
  }

  async function fetchFromSite(input) {
    try {
      const nm = idOf(input && input.nmID);
      if (!nm) return error('INVALID_ID', 'Укажите корректный nmID.');
      const force = !!(input && input.force);
      const hit = cache.get(nm);
      if (!force && hit && Date.now() - hit.time < ttlMs()) return Object.assign({}, hit.value, { fromCache: true });
      if (inFlight.has(nm)) return await inFlight.get(nm);
      const task = queue.then(async () => {
        if (blocked) return error('BLOCKED', BLOCK_MESSAGE);
        const cached = cache.get(nm);
        if (!force && cached && Date.now() - cached.time < ttlMs()) return Object.assign({}, cached.value, { fromCache: true });
        if (lastRequestAt) await sleep(Math.max(0, lastRequestAt + interval + Math.floor(Math.random() * Math.min(500, interval / 5 + 1)) - Date.now()));
        lastRequestAt = Date.now();
        const res = await request(nm);
        if (res.code === 'BLOCKED') { blocked = true; safeLog({ where: 'pricewatch', message: res.message }); }
        if (res.ok) {
          store.appendPriceWatch([{ nmID: nm, at: res.at, shelfPrice: res.shelfPrice, sppPrice: res.sppPrice, sppPct: res.sppPct, stock: res.stock, source: 'site' }]);
          cache.set(nm, { time: Date.now(), value: res });
        }
        return res;
      });
      queue = task.catch(() => {});
      inFlight.set(nm, task);
      try { return await task; } finally { inFlight.delete(nm); }
    } catch (e) { return error('NETWORK', 'Не удалось получить данные: ' + (e.message || String(e))); }
  }

  async function fetchCompetitor(input) {
    const sku = idOf(input && input.competitorSKU);
    if (!sku) return error('INVALID_ID', 'Укажите корректный SKU конкурента.');
    const res = await fetchFromSite({ nmID: sku, force: input.force });
    if (!res.ok) return res;
    try {
      // withSpp ожидает цену покупателя. Если она неизвестна, исключаем
      // конкурента из расчёта (цена 0), а не выдаём цену продавца за цену с СПП.
      updateCompetitors(sku, { price: res.sppPrice === null ? 0 : res.sppPrice,
        stock: res.stock, updatedAt: res.at }, null);
      return { ok: true, competitorSKU: Number(sku), price: res.shelfPrice, priceWithSpp: res.sppPrice,
        stock: res.stock, title: res.title, brand: res.brand, at: res.at, fromCache: !!res.fromCache };
    } catch (e) { return error('STORAGE', 'Не удалось обновить конкурента: ' + e.message); }
  }

  function planRefresh(items) {
    const unique = [...new Set((Array.isArray(items) ? items : []).map(idOf).filter(Boolean))].slice(0, 200);
    let delay = 0;
    return unique.map((nmID, i) => {
      if (i) delay += interval + Math.floor(Math.random() * Math.min(500, interval / 5 + 1));
      return { nmID: Number(nmID), delayMs: delay };
    });
  }

  async function runBatch(input) {
    const start = Date.now(), x = input || {}, results = [], seen = new Set(), jobs = [];
    for (const [kind, ids] of [['own', x.nmIDs], ['competitor', x.competitorSKUs]]) {
      for (const id of Array.isArray(ids) ? ids : []) {
        const key = idOf(id);
        const token = kind + ':' + String(id);
        if (!seen.has(token)) { seen.add(token); jobs.push({ kind, id: key || id }); }
      }
    }
    if (jobs.length > 200) return Object.assign(error('LIMIT', 'За один проход допускается не более 200 товаров.'), { results, blocked: 0, failed: 0, tookMs: Date.now() - start });
    // Намеренно последовательно даже при concurrency > 1: один общий интервал и
    // немедленная остановка при BLOCKED важнее скорости.
    for (const job of jobs) {
      const res = job.kind === 'own' ? await fetchFromSite({ nmID: job.id, force: x.force }) : await fetchCompetitor({ competitorSKU: job.id, force: x.force });
      results.push(Object.assign({ kind: job.kind, requestedId: job.id }, res));
      if (res.code === 'BLOCKED') break;
    }
    const blockedCount = results.filter((r) => r.code === 'BLOCKED').length;
    const failed = results.filter((r) => !r.ok && r.code !== 'BLOCKED').length;
    return { ok: !blockedCount && !failed, results, blocked: blockedCount, failed, tookMs: Date.now() - start };
  }

  function history(nmID) {
    const nm = idOf(nmID);
    if (!nm) return [];
    const items = store.loadPriceWatch();
    return Array.isArray(items[nm]) ? items[nm].slice(-50) : [];
  }
  function sppForEconomics(nmID) {
    const now = Date.now();
    const values = history(nmID).filter((r) => {
      const time = Date.parse(r.at), n = number(r.sppPct);
      return Number.isFinite(time) && time <= now && time >= now - 7 * 86400000 && n !== null && n <= 100;
    }).map((r) => Number(r.sppPct)).sort((a, b) => a - b);
    const n = values.length;
    return n ? Math.round((n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2) * 100) / 100 : null;
  }
  async function openInBrowser(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^(www\.)?wildberries\.ru$/i.test(u.hostname)) return error('INVALID_URL', 'Разрешены только страницы https://www.wildberries.ru/.');
      if (!o.electron || typeof o.electron.openHidden !== 'function') return error('NO_BROWSER', 'Откройте страницу WB в обычном браузере и введите цену вручную.');
      return await o.electron.openHidden(u.href, { timeoutMs: 10000 });
    } catch (e) { return error('BROWSER', 'Не удалось открыть страницу: ' + (e.message || String(e))); }
  }
  return { recordManual, fetchFromSite, fetchCompetitor, openInBrowser, planRefresh, runBatch, history, sppForEconomics };
}

module.exports = { createPriceWatcher };
