'use strict';

/** Вид таблицы — только локальные предпочтения. Не изменяет товары, цены и порядок отправки WB. */
window.GridLayout = (function () {
  const PREFIX = 'wb.grid.v1.';
  const cleanIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter((s) => /^[\w-]{1,80}$/.test(s)))].slice(0, 150000);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || min));
  const profile = () => window.API && API.activeProfileId && API.activeProfileId() || 'single';
  const keyOf = (id) => PREFIX + profile() + '.' + id;
  function load(id) {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(keyOf(id)) || '{}') || {}; } catch (_) {}
    return { columnOrder: cleanIds(data.columnOrder), rowOrder: cleanIds(data.rowOrder),
      widths: data.widths && typeof data.widths === 'object' ? data.widths : {},
      heights: data.heights && typeof data.heights === 'object' ? data.heights : {},
      rowHeight: data.rowHeight > 0 ? clamp(data.rowHeight, 32, 800) : 0 };
  }
  function persist(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); }
    catch (_) { if (window.App) App.toast('Вид таблицы изменён, но не сохранён: хранилище браузера переполнено или недоступно.', 'warn'); }
  }
  function save(id, data) { persist(keyOf(id), data); }
  function orderedColumns(columns, id) {
    const order = load(id).columnOrder;
    const rank = new Map(order.map((c, i) => [c, i]));
    return columns.slice().sort((a, b) => a.colId === 'item' ? -1 : b.colId === 'item' ? 1 : (rank.get(a.colId) ?? 10000) - (rank.get(b.colId) ?? 10000));
  }
  function orderedRows(rows, id) {
    const order = load(id).rowOrder;
    if (!order.length) return rows;
    const rank = new Map(order.map((nm, i) => [nm, i]));
    return rows.slice().sort((a, b) => (rank.get(String(a.nmID)) ?? 1e9) - (rank.get(String(b.nmID)) ?? 1e9));
  }
  const DEFAULT_WIDTHS = { item: 320, strategy: 250, offset: 290, competitor: 240, info: 220, stock: 180, plan: 180,
    floor: 225, cost: 210, sizes: 260, promos: 240, status: 200, restore: 200, why: 110, barcode: 190, costDetail: 210 };
  const defaultWidth = (id) => DEFAULT_WIDTHS[id] || 165;

  function attach(options) {
    const o = options, table = o.table, columns = o.columns;
    const key = keyOf(o.id), data = load(o.id), epoch = API.generation();
    let cleanup = null, destroyed = false, draggingColumn = '', draggingRow = '';
    const current = () => !destroyed && API.generation() === epoch && key === keyOf(o.id);
    const store = () => { if (current()) persist(key, data); };
    const notify = () => { if (current() && o.onChange) o.onChange(); };
    table.classList.add('adjustable-grid');
    table.style.tableLayout = 'fixed';
    let group = table.querySelector('colgroup');
    if (group) group.remove();
    group = document.createElement('colgroup');
    const hasSelect = table.querySelector('th.rp-check') ? 1 : 0;
    if (hasSelect) { const col = document.createElement('col'); col.style.width = '42px'; group.appendChild(col); }
    const widths = columns.map((c) => clamp(data.widths[c.colId] || defaultWidth(c.colId), c.colId === 'item' ? 200 : 70, 1400));
    const cols = columns.map((c, i) => { const col = document.createElement('col'); col.dataset.colId = c.colId; col.style.width = widths[i] + 'px'; group.appendChild(col); return col; });
    table.insertBefore(group, table.firstChild);
    const updateWidth = () => { table.style.width = (widths.reduce((a, b) => a + b, 0) + hasSelect * 42) + 'px'; table.style.minWidth = '100%'; };
    updateWidth();

    function gesture(event, move, done) {
      event.preventDefault(); event.stopPropagation();
      if (!current()) return;
      if (cleanup) cleanup();
      const onMove = (e) => { if (current()) move(e); else finish(); };
      const finish = () => { if (cleanup) cleanup(); if (current() && done) done(); };
      cleanup = () => {
        document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish);
        document.body.classList.remove('grid-resizing'); cleanup = null;
      };
      document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish);
      document.body.classList.add('grid-resizing');
    }
    function setWidth(index, value) {
      widths[index] = clamp(value, columns[index].colId === 'item' ? 200 : 70, 1400);
      cols[index].style.width = widths[index] + 'px'; data.widths[columns[index].colId] = widths[index]; updateWidth();
    }
    function moveColumn(from, to) {
      if (!current() || from === to || from === 'item' || to === 'item') return;
      const order = columns.map((c) => c.colId), source = order.indexOf(from), target = order.indexOf(to);
      if (source < 0 || target < 0) return;
      order.splice(source, 1); order.splice(target, 0, from);
      data.columnOrder = cleanIds(order.concat(data.columnOrder)); store(); notify();
    }
    function moveRow(from, to, after) {
      if (!current() || from === to) return;
      const full = cleanIds(o.allRowIds || o.rows.map((r) => r.nmID));
      const rank = new Map(data.rowOrder.map((id, i) => [id, i]));
      full.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
      if (!full.includes(from) || !full.includes(to)) return;
      full.splice(full.indexOf(from), 1); full.splice(full.indexOf(to) + (after ? 1 : 0), 0, from);
      data.rowOrder = full; store(); notify();
    }

    const headers = Array.from(table.querySelectorAll('thead tr:last-child th')).filter((th) => !th.classList.contains('rp-check'));
    headers.forEach((th, i) => {
      const c = columns[i]; if (!c) return;
      th.dataset.colId = c.colId; th.classList.add('grid-column-head');
      const label = document.createElement('span'); label.className = 'grid-column-title';
      while (th.firstChild) label.appendChild(th.firstChild); th.appendChild(label);
      label.draggable = c.colId !== 'item'; label.tabIndex = 0;
      label.title = c.colId === 'item' ? 'Товар закреплён слева. Ширина меняется за правый край.' : 'Перетащите заголовок для перестановки. Alt + ← / → тоже перемещает колонку.';
      label.ondragstart = (event) => { draggingColumn = c.colId; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', c.colId); } };
      th.ondragover = (event) => { if (draggingColumn) { event.preventDefault(); th.classList.add('grid-drop-target'); } };
      th.ondragleave = () => th.classList.remove('grid-drop-target');
      th.ondrop = (event) => { event.preventDefault(); th.classList.remove('grid-drop-target'); moveColumn(draggingColumn, c.colId); draggingColumn = ''; };
      label.ondragend = () => { draggingColumn = ''; table.querySelectorAll('.grid-drop-target').forEach((el) => el.classList.remove('grid-drop-target')); };
      label.onkeydown = (event) => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const next = i + (event.key === 'ArrowLeft' ? -1 : 1);
        if (columns[next]) { event.preventDefault(); moveColumn(c.colId, columns[next].colId); }
      };
      const handle = document.createElement('span'); handle.className = 'grid-col-resize'; handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', 'Ширина: ' + (c.title || c.colId)); handle.tabIndex = 0;
      handle.title = 'Тяните для изменения ширины; двойной щелчок — по содержимому. Стрелки ← / → — по 20 px.';
      handle.addEventListener('pointerdown', (event) => { const start = event.clientX, width = widths[i]; gesture(event, (e) => setWidth(i, width + e.clientX - start), store); });
      handle.ondblclick = (event) => {
        event.stopPropagation();
        const content = [c.title || ''];
        table.querySelectorAll('tbody tr').forEach((row) => { const cell = row.children[i + hasSelect]; if (!cell) return; const select = cell.querySelector('select'); content.push(select ? select.options[select.selectedIndex]?.text || '' : cell.textContent.trim()); });
        setWidth(i, Math.min(1000, Math.max(...content.map((text) => Math.min(text.length, 130) * 7.5 + 36)))); store();
      };
      handle.onkeydown = (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setWidth(i, widths[i] + (event.key === 'ArrowLeft' ? -20 : 20)); store(); } };
      th.appendChild(handle);
    });

    table.querySelectorAll('tbody tr').forEach((tr, i) => {
      const row = o.rows[i]; if (!row) return;
      const nm = String(row.nmID); tr.dataset.rowId = nm;
      const height = data.heights[nm] || data.rowHeight;
      if (height) tr.style.height = clamp(height, 32, 800) + 'px';
      const first = tr.children[0]; if (!first) return;
      first.classList.add('grid-row-control');
      const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'grid-row-grip'; grip.textContent = '⋮⋮'; grip.draggable = true;
      grip.title = 'Перетащить строку. Alt + ↑ / ↓ — переместить; порядок только визуальный.';
      grip.setAttribute('aria-label', 'Переместить строку ' + nm);
      grip.onclick = (event) => event.stopPropagation();
      grip.ondragstart = (event) => { draggingRow = nm; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', nm); } };
      tr.ondragover = (event) => { if (draggingRow) { event.preventDefault(); tr.classList.add('grid-drop-target'); } };
      tr.ondragleave = () => tr.classList.remove('grid-drop-target');
      tr.ondrop = (event) => { event.preventDefault(); tr.classList.remove('grid-drop-target'); const from = draggingRow; draggingRow = ''; moveRow(from, nm, false); };
      grip.ondragend = () => { draggingRow = ''; table.querySelectorAll('.grid-drop-target').forEach((el) => el.classList.remove('grid-drop-target')); };
      grip.onkeydown = (event) => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const order = (o.allRowIds || o.rows.map((r) => r.nmID)).map(String), at = order.indexOf(nm), target = order[at + (event.key === 'ArrowUp' ? -1 : 1)];
        if (target) { event.preventDefault(); moveRow(nm, target, event.key === 'ArrowDown'); }
      };
      first.appendChild(grip);
      const handle = document.createElement('span'); handle.className = 'grid-row-resize'; handle.tabIndex = 0;
      handle.title = 'Тяните вниз для высоты строки; двойной щелчок — автовысота.';
      handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'horizontal'); handle.setAttribute('aria-label', 'Высота строки ' + nm);
      handle.addEventListener('pointerdown', (event) => { const start = event.clientY, height = tr.getBoundingClientRect().height || data.heights[nm] || 80;
        gesture(event, (e) => { data.heights[nm] = clamp(height + e.clientY - start, 32, 800); tr.style.height = data.heights[nm] + 'px'; }, store); });
      handle.ondblclick = (event) => { event.stopPropagation(); delete data.heights[nm]; tr.style.height = data.rowHeight ? data.rowHeight + 'px' : ''; store(); };
      handle.onkeydown = (event) => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); data.heights[nm] = clamp((Number(data.heights[nm]) || tr.getBoundingClientRect().height || 80) + (event.key === 'ArrowUp' ? -10 : 10), 32, 800); tr.style.height = data.heights[nm] + 'px'; store(); } };
      first.appendChild(handle);
    });
    table.querySelectorAll('select').forEach((select) => {
      const tooltip = () => { const title = select.options[select.selectedIndex]?.text || ''; if (title) select.title = title; };
      tooltip(); select.addEventListener('change', tooltip);
    });
    return { destroy() { destroyed = true; if (cleanup) cleanup(); }, moveColumn, moveRow, setWidth: (id, width) => { const i = columns.findIndex((c) => c.colId === id); if (i >= 0) { setWidth(i, width); store(); } }, data };
  }

  function openSettings(id, columns, onChange) {
    const data = load(id), key = keyOf(id), epoch = API.generation();
    const modal = UI.modal({ title: 'Вид таблицы — размеры и порядок', size: 'md',
      content: `<div class="alert info">Ширина — за правый край заголовка; высота — за нижнюю границу ячейки с галочкой. Заголовки и маркер ⋮⋮ перетаскиваются. Товар закреплён слева. Всё сохраняется отдельно для этого кабинета и не меняет цены.</div>
      <div class="grid g2"><label class="field">Колонка<select id="layout-column">${columns.map((c) => `<option value="${U.esc(c.colId)}">${U.esc(c.title || 'Действия')}</option>`).join('')}</select></label><label class="field">Ширина, px<input id="layout-width" type="number" min="70" max="1400" step="10"></label>
      <label class="field">Общая высота строк, px (0 — авто)<input id="layout-height" type="number" min="0" max="800" value="${data.rowHeight}"></label></div>
      <p class="hint">Длинное выбранное значение также видно при наведении на выпадающий список. Порядок строк не влияет на расчёты и отправку в WB.</p>`,
      buttons: [{ label: 'Отмена' }, { label: 'Сбросить вид', class: 'btn-ghost', onClick: () => { if (epoch !== API.generation()) return; try { localStorage.removeItem(key); } catch (_) {} onChange(); } },
        { label: 'Применить', class: 'btn-primary', onClick: () => { if (epoch !== API.generation()) return;
          const id = modal.body.querySelector('#layout-column').value; data.widths[id] = clamp(modal.body.querySelector('#layout-width').value, id === 'item' ? 200 : 70, 1400);
          const h = Number(modal.body.querySelector('#layout-height').value); data.rowHeight = h > 0 ? clamp(h, 32, 800) : 0; data.heights = {};
          persist(key, data); onChange(); } }] });
    const col = modal.body.querySelector('#layout-column'), width = modal.body.querySelector('#layout-width');
    col.onchange = () => { width.value = data.widths[col.value] || defaultWidth(col.value); }; col.onchange();
  }
  return { load, save, attach, orderedColumns, orderedRows, openSettings, defaultWidth, keyOf };
})();
