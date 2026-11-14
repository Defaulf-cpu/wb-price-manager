'use strict';

/**
 * Минимальный писатель XLSX без внешних зависимостей.
 *
 * Зачем свой: в репрайсере INDEEPA экспорт «Excel (до 150к строк)» — рабочий инструмент,
 * а тянуть библиотеку ради выгрузки не хочется: приложение должно ставиться одним
 * `npm install` и работать офлайн. Читатель у нас уже свой (`xlsx-lite.js`), поэтому
 * пишем в том же духе.
 *
 * XLSX — это ZIP-архив с XML внутри. Собираем его руками:
 *   - сжатие deflate (встроенный zlib),
 *   - CRC32 считаем сами (табличный метод),
 *   - строки пишем как inlineStr, поэтому sharedStrings.xml не нужен;
 *   - числа — обычным типом `n`, чтобы в Excel с ними можно было работать как с числами.
 *
 * Ограничение Excel: 1 048 576 строк на лист. При превышении режем по листам.
 */

const zlib = require('zlib');

/** Таблица CRC32 (полином 0xEDB88320) — считается один раз при загрузке модуля. */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Экранирование текста для XML. */
function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // управляющие символы ломают XML и сам Excel
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Индекс колонки (0-based) → буквы Excel: 0 → A, 25 → Z, 26 → AA. */
function colName(i) {
  let n = Number(i) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - rem - 1) / 26);
  }
  return out;
}

/**
 * Одна ячейка. Числа пишем как числа (иначе Excel не даст считать по ним),
 * всё остальное — как встроенную строку.
 */
function cellXml(colIdx, rowIdx, value) {
  const ref = colName(colIdx) + (rowIdx + 1);
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  const looksNumeric = (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value !== 'number' && String(value).trim() !== '' && Number.isFinite(n) && /^-?\d*([.,]\d+)?$/.test(String(value).trim()));
  if (looksNumeric) {
    const num = typeof value === 'number' ? value : n;
    return `<c r="${ref}"><v>${Number.isFinite(num) ? num : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** XML листа: строки пишем порциями, чтобы не собирать гигантскую строку в памяти. */
function sheetXml(rows) {
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>'];
  for (let r = 0; r < rows.length; r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    parts.push(`<row r="${r + 1}">`);
    for (let c = 0; c < row.length; c++) parts.push(cellXml(c, r, row[c]));
    parts.push('</row>');
  }
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

/**
 * Собрать XLSX в Buffer.
 *
 * @param {Array<Array<*>>} rows строки таблицы (первая — заголовки, если заданы headers)
 * @param {object} [opts] { headers?: string[], sheetName?: string, maxRowsPerSheet?: number }
 * @returns {Buffer}
 */
function buildXlsx(rows, opts) {
  const o = opts || {};
  const data = Array.isArray(rows) ? rows : [];
  const all = o.headers && o.headers.length ? [o.headers].concat(data) : data;
  const perSheet = Math.max(1, Math.min(1048576, Number(o.maxRowsPerSheet) || 1000000));

  // режем на листы, если строк больше предела Excel
  const sheets = [];
  for (let i = 0; i < Math.max(1, all.length); i += perSheet) {
    sheets.push(all.slice(i, i + perSheet));
  }
  if (!sheets.length) sheets.push([[]]);

  const sheetName = String(o.sheetName || 'Данные').slice(0, 31).replace(/[\\\/?*\[\]:]/g, '_') || 'Данные';
  const files = [];

  files.push(['[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>']);

  files.push(['_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>']);

  files.push(['xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((_, i) => `<sheet name="${esc(i === 0 ? sheetName : sheetName + ' ' + (i + 1))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>']);

  files.push(['xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>']);

  // минимальный styles.xml: без него часть версий Excel ругается на файл
  files.push(['xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '</styleSheet>']);

  sheets.forEach((sheetRows, i) => {
    files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheetRows)]);
  });

  return zipFiles(files);
}

/**
 * Собрать ZIP-архив (deflate) из пар [имя, содержимое].
 * Пишем руками: local header + данные, затем central directory и EOCD.
 */
function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  // DOS-время/дата: Excel не смотрит на них, но формат требует валидные значения
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  files.forEach(([name, content]) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    // если сжатие не помогло — кладём как есть (метод 0)
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0, 8);
    cent.writeUInt16LE(method, 10);
    cent.writeUInt16LE(dosTime, 12);
    cent.writeUInt16LE(dosDate, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(data.length, 20);
    cent.writeUInt32LE(raw.length, 24);
    cent.writeUInt16LE(nameBuf.length, 28);
    cent.writeUInt16LE(0, 30);
    cent.writeUInt16LE(0, 32);             // comment length
    cent.writeUInt16LE(0, 34);             // disk number
    cent.writeUInt16LE(0, 36);             // internal attrs
    cent.writeUInt32LE(0, 38);             // external attrs
    cent.writeUInt32LE(offset, 42);
    central.push(cent, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { buildXlsx, zipFiles, crc32, colName, esc };
