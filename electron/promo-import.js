'use strict';

/** Распознавание выгрузок WB без догадки «длинное число = артикул»: штрихкод не nmID. */
const normalize = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const numeric = (value) => {
  let text = String(value ?? '').trim().replace(/[\s\u00a0\u202f₽%]/g, '').replace(/руб\.?|rub/gi, '');
  if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else text = text.replace(',', '.');
  const n = Number(text); return text && Number.isFinite(n) ? n : 0;
};
function field(header) {
  const h = normalize(header), flat = h.replace(/ /g, '');
  if (/^(nmid|нмкод|нмid|нмид|артикулwb|артикулвб|кодноменклатуры|номенклатура|idтовара|кодтовара|номертовара)$/.test(flat) || /артикул (?:wb|вб|wildberries)/.test(h)) return 'nmID';
  if (/артикул (продавца|поставщика)|vendor.?code|са артикул/.test(h)) return 'vendorCode';
  if (/^(название|название товара|наименование|наименование товара|title|предмет|товар)$/.test(h)) return 'title';
  if (/участ|^in ?action$|^в акции$|добавлен/.test(h) && !/цен|скид/.test(h)) return 'inAction';
  if (/цен/.test(h) && /акци|участи|планов|рекомендуем|максимальн/.test(h) || /^(planprice|planned price)$/.test(h)) return 'planPrice';
  if (/скид/.test(h) && /акци|участи|планов|требуем/.test(h) || /^(plandiscount|participation percentage)$/.test(h)) return 'planDiscount';
  if (/цен/.test(h) && /до скид|без скид|базов|розничн/.test(h) || h === 'price') return 'price';
  if (/^(остаток|остатки|остаток шт|stock)$/.test(h)) return 'stock';
  if (/^(плановая цена|цена акции|цена со скидкой|акционная цена|цена участия)$/.test(h)) return 'planPrice';
  if (/^(скидка|скидка процент|discount)$/.test(h)) return 'planDiscount';
  return '';
}
function parsePromoNoms(rows) {
  rows = (Array.isArray(rows) ? rows : []).filter(Array.isArray);
  let headerRow = -1, headers = [], map = {}, score = -1, skipNext = false;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const source = rows[i];
    const mapped = {}; source.forEach((h, col) => { const key = field(h); if (key && mapped[key] === undefined) mapped[key] = col; });
    if (mapped.nmID === undefined) continue;
    const points = Object.keys(mapped).length;
    if (points > score) { score = points; headerRow = i; headers = source.map(String); map = mapped; }
  }
  if (headerRow >= 0) {
    const next = rows[headerRow + 1] || [];
    if (next.some((x) => /акци|участи|планов/i.test(String(x))) && !numeric(next[map.nmID])) {
      headers = headers.map((h, i) => (h + ' ' + String(next[i] || '')).trim());
      headers.forEach((h, col) => { const key = field(h); if (key && key !== 'nmID') map[key] = col; });
      skipNext = true;
    }
  } else if (rows.length && rows.every((row) => row.filter((v) => String(v ?? '').trim()).length === 1 && Number.isSafeInteger(numeric(row[0])) && numeric(row[0]) > 0)) {
    map.nmID = 0; // только однозначный одноколоночный список без заголовка
  } else {
    return { items: [], headers: (rows[0] || []).map(String), skipped: rows.length, headerRow: null, warnings: ['Не найдена подписанная колонка «Артикул WB / nmID». Штрихкоды и цены не принимаются за nmID.'] };
  }
  const dataRows = rows.slice(headerRow + 1 + (skipNext ? 1 : 0));
  const unique = new Map(); let skipped = 0, duplicates = 0, conflictingPrices = 0;
  for (const row of dataRows) {
    if (!row.some((v) => String(v ?? '').trim())) continue;
    const nmID = numeric(row[map.nmID]);
    if (!Number.isSafeInteger(nmID) || nmID <= 0) { skipped++; continue; }
    const value = (key) => map[key] === undefined ? '' : row[map[key]];
    const status = normalize(value('inAction'));
    const inAction = !/не участ|не в акци|исключ|^нет$|^false$|^0$/.test(status) && /участву|^в акции$|^да$|^true$|^1$|добавлен/.test(status);
    const item = { nmID, vendorCode: String(value('vendorCode') || '').trim(), title: String(value('title') || '').trim(),
      price: Math.max(0, numeric(value('price'))), planPrice: Math.max(0, numeric(value('planPrice'))),
      planDiscount: Math.min(100, Math.max(0, numeric(value('planDiscount')))), stock: Math.max(0, numeric(value('stock'))),
      inAction, inActionKnown: map.inAction !== undefined, source: 'file' };
    if (!unique.has(nmID)) { unique.set(nmID, item); continue; }
    duplicates++;
    const before = unique.get(nmID);
    if (before.planPrice > 0 && item.planPrice > 0 && before.planPrice !== item.planPrice) conflictingPrices++;
    before.planPrice = before.planPrice && item.planPrice ? Math.min(before.planPrice, item.planPrice) : before.planPrice || item.planPrice;
    before.planDiscount = Math.max(before.planDiscount, item.planDiscount);
    before.inAction = before.inAction && item.inAction; // разные размеры не становятся целиком участниками по одной строке
    before.vendorCode = before.vendorCode || item.vendorCode; before.title = before.title || item.title;
  }
  const items = [...unique.values()], warnings = [];
  if (duplicates) warnings.push('Повторяющиеся размеры/строки объединены по nmID: ' + duplicates + '.');
  if (conflictingPrices) warnings.push('Разные акционные цены размеров: выбран меньший безопасный порог. Проверьте размерные цены отдельно.');
  if (items.some((i) => !i.planPrice)) warnings.push('У части товаров не распознана акционная цена: без порога участие по цене не подтверждается.');
  return { items, headers, skipped, duplicates, conflictingPrices, warnings, headerRow: headerRow < 0 ? null : headerRow + 1 };
}
function bestPromoTable(table) {
  const tables = table.sheets && table.sheets.length ? table.sheets : [table];
  let best = null;
  for (const sheet of tables) {
    const parsed = parsePromoNoms(sheet.rows);
    if (!best || parsed.items.length > best.items.length) best = { ...parsed, sheet: sheet.sheet };
  }
  return best || { items: [], headers: [], skipped: 0, warnings: [] };
}
module.exports = { parsePromoNoms, bestPromoTable, numeric, normalize };
