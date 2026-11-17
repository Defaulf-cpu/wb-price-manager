'use strict';

/**
 * Минимальный читатель XLSX без внешних зависимостей.
 *
 * Зачем свой: список товаров для акции WB отдаёт файлом XLSX («Настроить список товаров»
 * в календаре акций), а тянуть тяжёлую библиотеку ради одного импорта не хочется —
 * приложение должно ставиться одним `npm install` и работать офлайн.
 *
 * XLSX — это ZIP-архив с XML внутри, поэтому достаточно:
 *   1) найти центральную директорию ZIP и нужные записи,
 *   2) распаковать их (deflate) встроенным zlib,
 *   3) разобрать sharedStrings.xml и worksheet XML.
 *
 * Формулы не исполняются: читаются только сохранённые значения. Макросы не запускаются.
 */

const zlib = require('zlib');

/** Найти подпись в буфере, идя с конца (для End of Central Directory). */
function findFromEnd(buf, sig) {
  for (let i = buf.length - 4; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

/**
 * Прочитать записи ZIP-архива.
 * @returns {Map<string, Buffer>} имя файла → распакованное содержимое
 */
function readZip(buf, wanted) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;

  const eocd = findFromEnd(buf, EOCD);
  if (eocd < 0) throw new Error('Это не XLSX-файл: не найдена структура ZIP-архива.');

  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);   // смещение центральной директории
  const out = new Map();
  let inflated = 0;
  if (total > 10000) throw new Error('В XLSX слишком много частей.');

  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL) throw new Error('Повреждена таблица частей XLSX.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;

    if (wanted && wanted.indexOf(name) < 0 && !wanted.some((w) => name.indexOf(w) === 0)) continue;

    // данные лежат за локальным заголовком, у которого свои поля длины имени
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) throw new Error('Повреждена часть XLSX.');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error('Часть XLSX выходит за размер файла.');
    if (method !== 0 && method !== 8) throw new Error('Неизвестное сжатие XLSX.');
    const raw = buf.slice(dataStart, dataStart + compSize);

    try {
      const part = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 100 * 1024 * 1024 }) : Buffer.from(raw);
      inflated += part.length;
      if (inflated > 200 * 1024 * 1024) throw new Error('Распакованный XLSX превышает 200 МБ.');
      out.set(name, part);
    } catch (e) {
      throw new Error('Не удалось распаковать "' + name + '" внутри XLSX: ' + e.message);
    }
  }
  if (!out.size) throw new Error('В XLSX не найдено нужных частей (ожидается лист и sharedStrings).');
  return out;
}

/** Декодировать XML-сущности. */
function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Буквенный индекс колонки (A, B, … AA) → число 0-based. */
function colToIndex(ref) {
  const letters = String(ref || '').replace(/[0-9]/g, '').toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n > 0 ? n - 1 : 0;
}

/** Собрать общие строки: <si> может содержать несколько <t> (форматированный текст). */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const inner = m[1] || '';
    let text = '';
    const tre = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let t;
    while ((t = tre.exec(inner))) text += unesc(t[1]);
    if (!/<t\b/.test(inner)) {
      // пустая ячейка вида <si/> или <si><t/></si>
      const self = /<t\b[^>]*\/>/.test(inner) ? '' : unesc(inner.replace(/<[^>]+>/g, ''));
      text = self;
    }
    out.push(text);
  }
  return out;
}

/** Разобрать XML листа в массив строк (массивы значений по колонкам). */
function parseSheet(xml, shared, percentStyles) {
  const rows = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] || '';
      const body = cm[3] || '';
      const refM = attrs.match(/r="([A-Z]+[0-9]+)"/i);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      if (idx >= 16384) throw new Error('Недопустимый номер колонки XLSX.');
      const typeM = attrs.match(/t="([^"]+)"/);
      const type = typeM ? typeM[1] : 'n';

      let value = '';
      if (type === 'inlineStr') {
        const isM = body.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/);
        if (isM) {
          let text = '';
          const tre = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
          let t;
          while ((t = tre.exec(isM[1]))) text += unesc(t[1]);
          value = text;
        }
      } else {
        const vM = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        const raw = vM ? unesc(vM[1]) : '';
        if (type === 's') value = shared[Number(raw)] !== undefined ? shared[Number(raw)] : '';
        else if (type === 'str') value = raw;
        else if (type === 'b') value = raw === '1' ? 'true' : 'false';
        else value = raw;
      }
      const style = attrs.match(/\bs="(\d+)"/);
      if (type === 'n' && style && percentStyles && percentStyles.has(Number(style[1])) && value !== '' && Number.isFinite(Number(value))) value = String(Number(value) * 100);
      cells[idx] = value;
    }
    // строка может быть пустой — её всё равно добавляем, чтобы не съехали индексы
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/**
 * Прочитать первый лист XLSX.
 * @param {Buffer} buf содержимое файла
 * @returns {{rows: string[][], sheet: string}}
 */
function readXlsx(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // сигнатура ZIP
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Файл не похож на XLSX (ожидается файл Excel, сохранённый как .xlsx).');
  }
  const parts = readZip(buf, ['xl/sharedStrings.xml', 'xl/worksheets/', 'xl/workbook.xml', 'xl/styles.xml']);

  const sharedXml = parts.get('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedXml ? sharedXml.toString('utf8') : '');
  const stylesXml = parts.get('xl/styles.xml')?.toString('utf8') || '';
  const percentFormats = new Set([9, 10]);
  for (const match of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) if (match[2].includes('%')) percentFormats.add(Number(match[1]));
  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const percentStyles = new Set();
  if (cellXfs) [...cellXfs[1].matchAll(/<xf\b([^>]*)(?:\/>|>)/g)].forEach((match, i) => { const format = match[1].match(/numFmtId="(\d+)"/); if (format && percentFormats.has(Number(format[1]))) percentStyles.add(i); });


  // первый лист: берём sheet1.xml, если его нет — любой worksheet
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!parts.has(sheetName)) {
    const any = Array.from(parts.keys()).find((k) => k.indexOf('xl/worksheets/') === 0 && /\.xml$/.test(k));
    if (!any) throw new Error('В XLSX не найден лист с данными.');
    sheetName = any;
  }
  // Файл WB может начинаться с листа «Инструкция». Отдаём все листы;
  // импорт акций выберет тот, где действительно распознаются артикулы и условия.
  const sheets = Array.from(parts.keys()).filter((key) => /^xl\/worksheets\/[^/]+\.xml$/.test(key)).map((key) => ({
    rows: parseSheet(parts.get(key).toString('utf8'), shared, percentStyles), sheet: key.replace('xl/worksheets/', '').replace('.xml', '')
  }));
  const first = sheets.find((sheet) => sheet.sheet === sheetName.replace('xl/worksheets/', '').replace('.xml', '')) || sheets[0];
  return { rows: first.rows, sheet: first.sheet, sheets };
}

/**
 * Разделить CSV на строки с учётом кавычек, разделителя и десятичной запятой.
 * @param {string} text
 * @returns {string[][]}
 */
function readCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/).slice(0, 40);
  const candidates = [';', '\t', ','];
  const scores = candidates.map((delimiter) => lines.reduce((best, line) => {
    const count = line.split(delimiter).length - 1;
    const header = /артикул|nm.?id|нм.код|код товара/i.test(line);
    return Math.max(best, count * (header ? 100 : (/[а-яa-z]/i.test(line) ? 2 : 1)));
  }, 0));
  const delim = candidates[scores.indexOf(Math.max(...scores))];
  const out = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === delim) { row.push(cur); cur = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => String(c).trim() !== '')) out.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some((c) => String(c).trim() !== '')) out.push(row);
  return out;
}

/**
 * Универсальный вход: XLSX или CSV → массив строк.
 * @param {Buffer|string} data буфер (xlsx) или текст (csv)
 * @param {string} fileName имя файла — по расширению определяем формат
 */
function readTable(data, fileName) {
  const name = String(fileName || '').toLowerCase();
  if (/\.pdf$/.test(name) || (Buffer.isBuffer(data) ? data.subarray(0, 5).toString('ascii') : String(data).slice(0, 5)) === '%PDF-') {
    throw new Error('PDF подходит для проверки заголовков, но не для импорта: страницы и округлённые nmID не сохраняют точные данные. Загрузите исходный XLSX из кабинета WB или CSV с полными артикулами.');
  }
  if (/\.xls$/.test(name)) throw new Error('Старый формат .xls не поддерживается: скачайте XLSX или сохраните выгрузку как .xlsx / CSV.');
  const isXlsx = /\.xlsx$/.test(name) || (Buffer.isBuffer(data) && data.length > 4 && data.readUInt32LE(0) === 0x04034b50);
  if (isXlsx) return readXlsx(Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64'));
  let text;
  if (!Buffer.isBuffer(data)) text = String(data);
  else if (data[0] === 0xff && data[1] === 0xfe) text = data.toString('utf16le');
  else if (data[0] === 0xfe && data[1] === 0xff) text = new TextDecoder('utf-16be').decode(data);
  else {
    text = data.toString('utf8');
    if (text.includes('\ufffd')) text = new TextDecoder('windows-1251').decode(data);
  }
  return { rows: readCsv(text), sheet: 'csv' };
}

module.exports = { readXlsx, readCsv, readTable, parseSharedStrings, parseSheet, colToIndex };
