'use strict';

/** Распознавание выгрузок WB без догадки «длинное число = артикул»: штрихкод не nmID. */
const normalize = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
function optionalNumber(value) {
  let text = String(value ?? '').trim().replace(/[\s\u00a0\u202f₽%]/g, '').replace(/руб\.?|rub/gi, '');
  if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else text = text.replace(',', '.');
  const n = Number(text); return text && Number.isFinite(n) ? n : undefined;
}
const numeric = (value) => optionalNumber(value) ?? 0;
// У идентификатора не бывает валюты/процентов. Научная запись полного значения XLSX допустима;
// формат отображения Excel не применяется: округлённые артикулы из PDF восстановить нельзя.
function identifier(value) {
  const text = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const n = /^\+?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function field(header) {
  const h = normalize(header), flat = h.replace(/ /g, '');
  if (/^(nmid|нмкод|нмid|нмид|артикулwb|артикулвб|кодноменклатуры|номенклатура|idтовара|кодтовара|номертовара)$/.test(flat) || /артикул (?:wb|вб|wildberries)/.test(h)) return 'nmID';
  if (/артикул (продавца|поставщика)|vendor.?code|са артикул/.test(h)) return 'vendorCode';
  if (/^(название|название товара|наименование|наименование товара|title|товар)$/.test(h)) return 'title';
  if (/^(предмет|категория|категория товара|subject|subject name|category|category name)$/.test(h)) return 'categoryName';
  if (/^(бренд|brand)$/.test(h)) return 'brand';
  if (/^(валюта|currency|currency iso code 4217)$/.test(h)) return 'currency';
  if (/^(статус|статус участия|статус участия в акции|status)$/.test(h)) return 'fileStatus';
  if (/участ|^in ?action$|^в акции$|добавлен/.test(h) && !/цен|скид/.test(h)) return 'inAction';
  if ((/цен/.test(h) && /акци|участи|планов|рекомендуем|максимальн/.test(h)) || /^(planprice|planned price)$/.test(h)) return 'planPrice';
  if ((/скид/.test(h) && /акци|участи|планов|требуем|загружаем/.test(h)) || /^(plandiscount|participation percentage)$/.test(h)) return 'planDiscount';
  if ((/скид/.test(h) && /текущ|сейчас|на сайте/.test(h)) || /^(current discount|currentdiscount)$/.test(h)) return 'discount';
  if ((/цен/.test(h) && /до скид|без скид|базов|розничн/.test(h)) || h === 'price') return 'price';
  if (/остат/.test(h) && /продавц|поставщик|fbs/.test(h)) return 'stockSeller';
  if (/остат/.test(h) && /склад/.test(h) && /(?:^| )(?:wb|вб|wildberries)(?: |$)/.test(h)) return 'stockWb';
  if (/^(остаток|остатки|остаток шт|stock)$/.test(h)) return 'stock';
  if (/^(плановая цена|цена акции|цена со скидкой|акционная цена|цена участия)$/.test(h)) return 'planPrice';
  if (/^(скидка|скидка процент|discount)$/.test(h)) return 'planDiscount'; // совместимость прежних кратких файлов
  return '';
}
function mapHeaders(headers) {
  const map = {}, priorities = {};
  headers.forEach((header, col) => {
    const key = field(header); if (!key) return;
    const h = normalize(header);
    let priority = 10;
    if (key === 'planDiscount') priority = /загружаем/.test(h) ? 30 : /планов|участи|акци/.test(h) ? 20 : 1;
    if (key === 'planPrice') priority = /планов/.test(h) ? 30 : /рекомендуем|максимальн|со скидкой/.test(h) ? 1 : 20;
    if (map[key] === undefined || priority > priorities[key]) { map[key] = col; priorities[key] = priority; }
  });
  return map;
}
function participation(value) {
  const status = normalize(value);
  if (!status) return null;
  if (/не участ|не в акци|не добавлен|не включен|исключ|^нет$|^false$|^0$/.test(status)) return false;
  if (/участву|^в акции$|^да$|^true$|^1$|добавлен|включен/.test(status)) return true;
  return null;
}
function parsePromoNoms(rows) {
  rows = (Array.isArray(rows) ? rows : []).filter(Array.isArray);
  let headerRow = -1, headers = [], map = {}, score = -1, skipNext = false;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const source = rows[i], mapped = mapHeaders(source);
    if (mapped.nmID === undefined) continue;
    const points = Object.keys(mapped).length;
    if (points > score) { score = points; headerRow = i; headers = source.map(String); map = mapped; }
  }
  if (headerRow >= 0) {
    const next = rows[headerRow + 1] || [];
    if (next.some((x) => /акци|участи|планов/i.test(String(x))) && !identifier(next[map.nmID])) {
      headers = headers.map((h, i) => (h + ' ' + String(next[i] || '')).trim());
      map = { ...map, ...mapHeaders(headers) };
      skipNext = true;
    }
  } else if (rows.length && rows.every((row) => row.filter((v) => String(v ?? '').trim()).length === 1 && identifier(row[0]))) {
    map.nmID = 0; // только однозначный одноколоночный список без заголовка
  } else {
    return { items: [], headers: (rows[0] || []).map(String), skipped: rows.length, headerRow: null, warnings: ['Не найдена подписанная колонка «Артикул WB / nmID». Штрихкоды и цены не принимаются за nmID.'] };
  }
  const dataRows = rows.slice(headerRow + 1 + (skipNext ? 1 : 0));
  const unique = new Map(); let skipped = 0, duplicates = 0, conflictingPrices = 0, conflictingStatuses = 0;
  for (const row of dataRows) {
    if (!row.some((v) => String(v ?? '').trim())) continue;
    const nmID = identifier(row[map.nmID]);
    if (!nmID) { skipped++; continue; }
    const value = (key) => map[key] === undefined ? '' : row[map[key]];
    const text = (key) => String(value(key) ?? '').trim();
    const nonnegative = (key) => { const n = optionalNumber(value(key)); return n !== undefined && n >= 0 ? n : undefined; };
    const flag = participation(value('inAction')), status = participation(value('fileStatus'));
    const conflict = flag !== null && status !== null && flag !== status;
    if (conflict) conflictingStatuses++;
    const state = conflict ? null : status ?? flag;
    const stockWb = nonnegative('stockWb'), stockSeller = nonnegative('stockSeller');
    const stock = nonnegative('stock') ?? (stockWb !== undefined && stockSeller !== undefined ? stockWb + stockSeller : undefined);
    const discount = nonnegative('discount');
    const item = { nmID, vendorCode: text('vendorCode'), title: text('title'), categoryName: text('categoryName'), brand: text('brand'),
      currency: text('currency').toUpperCase(), price: Math.max(0, numeric(value('price'))), planPrice: Math.max(0, numeric(value('planPrice'))),
      planDiscount: Math.min(100, Math.max(0, numeric(value('planDiscount')))),
      ...(discount !== undefined && discount <= 100 ? { discount } : {}),
      ...(stock !== undefined ? { stock } : {}), ...(stockWb !== undefined ? { stockWb } : {}), ...(stockSeller !== undefined ? { stockSeller } : {}),
      fileStatus: text('fileStatus'), inAction: state === true, inActionKnown: state !== null, source: 'file' };
    if (!unique.has(nmID)) { unique.set(nmID, item); continue; }
    duplicates++;
    const before = unique.get(nmID);
    if (before.planPrice > 0 && item.planPrice > 0 && before.planPrice !== item.planPrice) conflictingPrices++;
    before.planPrice = before.planPrice && item.planPrice ? Math.min(before.planPrice, item.planPrice) : before.planPrice || item.planPrice;
    before.planDiscount = Math.max(before.planDiscount, item.planDiscount);
    const excluded = before.inActionKnown && !before.inAction || item.inActionKnown && !item.inAction;
    before.inActionKnown = excluded || before.inActionKnown && item.inActionKnown;
    before.inAction = !excluded && before.inAction && item.inAction; // одна строка не подтверждает все размеры
    for (const key of ['vendorCode', 'title', 'brand', 'categoryName', 'currency']) before[key] = before[key] || item[key];
    // Дубликат может быть размером или повтором выгрузки: не удваиваем складские остатки.
    for (const key of ['stock', 'stockWb', 'stockSeller']) if (before[key] !== item[key]) delete before[key];
  }
  const items = [...unique.values()], warnings = [];
  if (duplicates) warnings.push('Повторяющиеся размеры/строки объединены по nmID: ' + duplicates + '. Остатки разных строк не суммируются повторно; неоднозначный остаток не указан.');
  if (conflictingPrices) warnings.push('Разные акционные цены размеров: выбран меньший безопасный порог. Проверьте размерные цены отдельно.');
  if (conflictingStatuses) warnings.push('Флаг участия и «Статус» противоречат друг другу в ' + conflictingStatuses + ' строках: участие по файлу не подтверждено.');
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
