'use strict';

/* Утилиты формата и вспомогательные функции интерфейса. */
window.U = (function () {

  function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (def === undefined ? 0 : def);
  }

  /**
   * Форматтеры чисел кешируются по числу знаков.
   *
   * `toLocaleString` создаёт объект `Intl.NumberFormat` на КАЖДЫЙ вызов, а в таблице
   * репрайсера таких вызовов десятки тысяч на одну отрисовку: деньги, проценты и штуки
   * есть почти в каждой ячейке, а колонок в таблице тридцать. Без кеша прокрутка
   * широкой таблицы тормозит, а память расходуется на одинаковые форматтеры.
   */
  const numFormats = new Map();

  function numOf(digits) {
    let f = numFormats.get(digits);
    if (!f) {
      f = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      numFormats.set(digits, f);
    }
    return f;
  }

  function fmt(n, digits) {
    const d = digits === undefined ? 0 : digits;
    const v = num(n);
    return numOf(d).format(v);
  }

  function money(n, digits) {
    return fmt(n, digits === undefined ? 0 : digits) + ' ₽';
  }

  function signed(n, digits) {
    const v = num(n, 0);
    const d = digits === undefined ? 0 : digits;
    return (v > 0 ? '+' : '') + fmt(v, d);
  }

  function pct(n, digits) {
    const d = digits === undefined ? 1 : digits;
    return fmt(num(n), d) + '%';
  }

  function compact(n) {
    const v = Math.abs(num(n));
    if (v >= 1e9) return fmt(num(n) / 1e9, 2) + ' млрд';
    if (v >= 1e6) return fmt(num(n) / 1e6, 2) + ' млн';
    if (v >= 1e4) return fmt(num(n) / 1e3, 1) + ' тыс';
    return fmt(num(n));
  }

  function date(v, withTime) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = (x) => String(x).padStart(2, '0');
    const base = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
  }

  /** Время суток HH:MM:SS — для «раздел дозагрузится в 12:34:56». */
  function time(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function daysBetween(a, b) {
    return Math.round((new Date(b) - new Date(a)) / 86400000);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(html) {
    const s = String(html === undefined || html === null ? '' : html).trim();
    const t = document.createElement('template');
    t.innerHTML = /^<\s*\w/.test(s) ? s : '<' + (s || 'div') + '></' + (s || 'div') + '>';
    return t.content.firstElementChild;
  }

  function cls() {
    return Array.prototype.filter.call(arguments, Boolean).join(' ');
  }

  function profitClass(v) {
    const n = num(v);
    return n > 0 ? 'pos' : (n < 0 ? 'neg' : 'muted');
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const epoch = window.API && API.generation ? API.generation() : 0;
      clearTimeout(t);
      t = setTimeout(() => {
        // Отложенный ввод в старой таблице не меняет состояние другого кабинета.
        if (!window.API || !API.generation || epoch === API.generation()) fn.apply(null, args);
      }, ms || 250);
    };
  }

  function toCsv(rows, columns) {
    const cols = columns && columns.length ? columns : Object.keys(rows[0] || {});
    const head = cols.map((c) => csvCell(typeof c === 'string' ? c : c.title)).join(';');
    const body = rows.map((r) => cols.map((c) => {
      const key = typeof c === 'string' ? c : c.key;
      let v = r[key];
      if (typeof c === 'object' && c.format) v = c.format(r);
      return csvCell(v);
    }).join(';')).join('\n');
    return head + '\n' + body;
  }

  function csvCell(v) {
    if (v === undefined || v === null) return '';
    let s = String(v);
    if (typeof v === 'number') s = String(Math.round(v * 100) / 100).replace('.', ',');
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function parseCsv(text) {
    const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ';' || ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (!clean.length) return [];
    const head = clean[0].map((h) => String(h).trim());
    return clean.slice(1).map((r) => {
      const o = {};
      head.forEach((h, i) => { o[h] = r[i] !== undefined ? String(r[i]).trim() : ''; });
      return o;
    });
  }

  function download(filename, content, mime) {
    const blob = new Blob(['\uFEFF' + content], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  /**
   * Скачать бинарный файл из base64 (XLSX). Обычный `download()` не подходит:
   * он добавляет BOM и работает с текстом, а здесь — байты архива.
   */
  function downloadBase64(filename, base64, mime) {
    const bin = atob(String(base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  function sum(arr, fn) {
    return arr.reduce((s, x) => s + num(fn ? fn(x) : x), 0);
  }

  function groupBy(arr, fn) {
    const out = new Map();
    for (const x of arr) {
      const k = fn(x);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(x);
    }
    return out;
  }

  function sortBy(arr, fn, dir) {
    const d = dir === 'desc' ? -1 : 1;
    return arr.slice().sort((a, b) => {
      const va = fn(a); const vb = fn(b);
      if (va === vb) return 0;
      if (va === undefined || va === null || va === '') return 1;
      if (vb === undefined || vb === null || vb === '') return -1;
      return va > vb ? d : -d;
    });
  }

  /**
   * Точная ссылка WB по ID. Старый шаблон/главная страница игнорируются.
   * Редиректы после открытия (например, авторизация) контролируются сайтом WB.
   */
  function promoCabinetUrl(promo, settings) {
    const p = promo || {}, id = Number(p.id ?? p.promoId ?? p.promotionID);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('У акции нет корректного ID: обновите календарь WB.');
    // Сохранённый раньше адрес главной/общего календаря не должен ломать deep link.
    // Прямая ссылка WB задаётся контрактом, а не ненадёжным p.url из календаря.
    return 'https://seller.wildberries.ru/dp-promo-calendar?action=' + id;
  }

  /**
   * «Заканчивается»: запаса хватит меньше lowDays дней при текущих продажах.
   * Чистая функция — без DOM, чтобы логика бейджа тестировалась в node.
   *
   * @param {number} stock       остаток (шт)
   * @param {number} turnoverDays оборачиваемость (дн; 999 = без продаж)
   * @param {number} lowDays     порог из настроек (stocksLowDays)
   * @returns {boolean} true, если нужен бейдж «заканчивается»
   */
  function stockWarn(stock, turnoverDays, lowDays) {
    const s = Number(stock) || 0;
    const t = Number(turnoverDays) || 0;
    const n = Number(lowDays);
    if (!(s > 0) || !Number.isFinite(n) || !(n > 0)) return false;
    if (!(t > 0) || t >= 999) return false; // без продаж оборачиваемость не считается
    return t < n;
  }

  return {
    num, fmt, money, signed, pct, compact, date, time, daysBetween, esc, el, cls,
    profitClass, debounce, toCsv, parseCsv, download, downloadBase64, sum, groupBy, sortBy, promoCabinetUrl, stockWarn
  };
})();
