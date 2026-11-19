'use strict';

/** Акции: общий список и синхронная рабочая область «Гант / Таблица акций». */
window.Views = window.Views || {};

Views.promos = {
  title: 'Акции WB',
  subtitle: 'Календарь, проверенный состав и условия для репрайсера — без отправки цен',

  render(container) { this.mount(container); },

  /** Один экран для раздела «Акции» и одноимённой вкладки репрайсера. */
  async mount(container) {
    this.container = container;
    const ticket = this.mountTicket = (this.mountTicket || 0) + 1, epoch = API.generation();
    container.innerHTML = `<div class="card">${UI.loading('Загружаем календарь акций WB…')}</div>`;
    try {
      if (!S.state.promos.length) await S.loadPromos();
      if (ticket !== this.mountTicket || epoch !== API.generation() || this.container !== container) return;
      this.boardState().status = 'all'; this.boardState().sort = 'current';
      this.boardState().selectedId = ''; this._centerToday = true;
      this.renderList();
    } catch (error) {
      if (ticket !== this.mountTicket || epoch !== API.generation()) return;
      container.innerHTML = `<div class="card"><div class="alert danger">${U.esc(error.message)}</div>
        <p class="hint">Для календаря нужен доступ «Цены и скидки» WB.</p><button class="btn" id="p-retry">Повторить</button></div>`;
      container.querySelector('#p-retry').onclick = () => this.mount(container);
    }
  },

  boardState() {
    const profile = API.activeProfileId() || 'single';
    if (this._boardProfile !== profile) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('wb.promos.board.' + profile) || '{}') || {}; } catch (_) {}
      this._boardProfile = profile;
      this._boardState = { mode: saved.mode === 'table' ? 'table' : 'gantt', zoom: saved.zoom === 'week' ? 'week' : 'day',
        selectedId: String(saved.selectedId || ''), q: '', status: 'all', sort: 'start', dir: 'asc' };
    }
    return this._boardState;
  },

  rememberBoard() {
    const state = this.boardState();
    try { localStorage.setItem('wb.promos.board.' + this._boardProfile, JSON.stringify({ mode: state.mode, zoom: state.zoom, selectedId: state.selectedId })); } catch (_) {}
  },

  periodStatus(p, now = Date.now()) {
    const start = Date.parse(p.startDateTime), end = Date.parse(p.endDateTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { id: 'unknown', text: 'Даты не указаны', kind: 'warn' };
    if (now < start) return { id: 'upcoming', text: 'Через ' + Math.ceil((start - now) / 86400000) + ' дн.', kind: 'info' };
    if (now > end) return { id: 'ended', text: 'Завершена', kind: '' };
    return { id: 'running', text: 'Идёт сейчас', kind: 'ok' };
  },

  /** Даты/ось в московском календарном дне; не сдвигаются с TZ компьютера. */
  promoDate(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms + 10800000).toISOString().slice(0, 10).split('-').reverse().join('.') : '—';
  },

  sourceHtml(p) {
    const rec = this.boardIndex && this.boardIndex.get(String(p.id));
    if (rec && rec.localUnconfirmed) return UI.badge('локальный файл: нет в календаре WB', 'warn');
    if (!rec) return `<span class="muted tiny">${this.boardError ? 'Состав не проверен' : 'Проверяем состав…'}</span>`;
    if (rec.ownership && rec.ownership.status === 'blocked') return UI.badge('Файл: проверка недоступна', 'warn');
    if (rec.source === 'file') return UI.badge('состав из файла: ' + U.fmt(rec.compositionCount), 'ok');
    if (rec.source === 'api') return UI.badge((rec.apiPartial ? 'Часть состава WB API: ' : rec.inferredCount ? 'WB API + оценка по скидке: ' : 'состав из WB API: ') + U.fmt(rec.compositionCount), rec.apiPartial ? 'warn' : 'info');
    if (rec.source === 'inferred') return UI.badge('по скидке товара: ' + U.fmt(rec.compositionCount), 'info');
    return UI.badge('состав не загружен', 'warn');
  },

  filteredPromos() {
    const state = this.boardState(), q = state.q.trim().toLowerCase();
    const calendarIds = new Set((S.state.promos || []).map((p) => String(p.id)));
    const local = (this.localPromos || []).filter((rec) => !calendarIds.has(String(rec.promoId))).map((rec) => ({ id: rec.promoId, name: rec.promoName, type: 'local', startDateTime: rec.startDateTime, endDateTime: rec.endDateTime, localUnconfirmed: true }));
    const list = (S.state.promos || []).concat(local).filter((p) => (!q || [p.id, p.name].join(' ').toLowerCase().includes(q)) &&
      (state.status === 'all' || this.periodStatus(p).id === state.status));
    const value = (p) => state.sort === 'name' ? String(p.name || '') : state.sort === 'end' ? Date.parse(p.endDateTime) || Infinity : Date.parse(p.startDateTime) || Infinity;
    return list.slice().sort((a, b) => {
      if (state.sort === 'current') {
        const rank = { running: 0, upcoming: 1, ended: 2, unknown: 3 };
        const diff = rank[this.periodStatus(a).id] - rank[this.periodStatus(b).id];
        if (diff) return diff;
      }
      const av = value(a), bv = value(b);
      return (typeof av === 'string' ? av.localeCompare(bv, 'ru') : av === bv ? 0 : av > bv ? 1 : -1) * (state.dir === 'desc' ? -1 : 1) || Number(a.id) - Number(b.id);
    });
  },

  renderList(options) {
    const container = this.container;
    if (!container) return;
    const ticket = this.boardTicket = (this.boardTicket || 0) + 1, epoch = API.generation(), state = this.boardState();
    this.boardIndex = null; this.boardError = '';
    container.innerHTML = `
      <div class="promo-toolbar row wrap">
        <div class="grow"><b>Календарь акций</b><div class="hint">Общий список слева · справа периоды или таблица самих акций. Товары открываются из выбранной строки.</div></div>
        <button class="btn btn-sm" id="p-refresh">Обновить акции</button>
      </div>
      <div class="promo-filters row wrap">
        <input id="promo-board-q" type="search" placeholder="Найти акцию по названию или ID" aria-label="Поиск акций" value="${U.esc(state.q)}" />
        <select id="promo-board-status" aria-label="Период акций"><option value="all">Все периоды</option><option value="running">Идут сейчас</option><option value="upcoming">Предстоящие</option><option value="ended">Завершённые</option><option value="unknown">Без дат</option></select>
        <span id="promo-board-count" class="hint grow"></span>
        <div class="tabs promo-mode-tabs" role="tablist" aria-label="Вид календаря акций">
          <button class="tab" role="tab" data-promo-mode="gantt">Гант</button><button class="tab" role="tab" data-promo-mode="table">Таблица акций</button>
        </div>
      </div>
      <div id="promo-board-error" aria-live="polite"></div>
      <div id="promo-board" class="promo-workspace">
        <aside class="promo-list-panel" aria-label="Общий список акций"><div class="promo-panel-title">Все акции <span class="hint" id="promo-list-count"></span></div><div id="promo-list" class="promo-list"></div></aside>
        <section class="promo-right-panel" aria-label="Рабочая область акций"><div id="promo-selected"></div><div id="promo-board-main"></div></section>
      </div>
      <p class="hint promo-board-footnote">Импорт и «Сохранить» задают условия репрайсеру локально — без отправки цен в WB. Источник и счётчики относятся к составу конкретной акции, не ко всему каталогу. Соответствие цены порогу не подтверждает участие от WB.</p>`;
    container.querySelector('#promo-board-status').value = state.status;
    container.querySelector('#promo-board-q').oninput = (event) => { state.q = event.target.value; this.drawBoard(); };
    container.querySelector('#promo-board-status').onchange = (event) => { state.status = event.target.value; this.drawBoard(); };
    container.querySelectorAll('[data-promo-mode]').forEach((button) => { button.onclick = () => {
      state.mode = button.dataset.promoMode; this.rememberBoard(); this.drawBoard();
    }; });
    container.querySelector('#p-refresh').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await S.loadPromos(); window.__promoDecisions = null;
        if (epoch !== API.generation() || this.container !== container || ticket !== this.boardTicket) return;
        this.renderList({ force: true }); App.toast('Календарь обновлён', 'ok');
      } catch (error) { App.toast(error.message, 'err'); }
      finally { button.disabled = false; }
    };
    this.drawBoard();
    (async () => {
      try {
        const result = await API.invoke('promos:index', { force: !!(options && options.force) });
        if (epoch !== API.generation() || ticket !== this.boardTicket || this.container !== container || !container.isConnected) return;
        if (!result || !result.ok) throw new Error(result && result.error || 'Не удалось проверить состав акций');
        this.boardIndex = new Map((result.promos || []).map((rec) => [String(rec.promoId), rec]));
        this.localPromos = (result.promos || []).filter((rec) => rec.localUnconfirmed);
        this.boardError = (result.hardErrors || []).join('; ');
      } catch (error) {
        if (epoch !== API.generation() || ticket !== this.boardTicket || this.container !== container) return;
        this.boardError = error.message; this.boardIndex = new Map();
      }
      if (container.isConnected) this.drawBoard();
    })();
  },

  selectPromo(id) {
    this.boardState().selectedId = String(id); this.rememberBoard(); this.drawBoard();
  },

  drawBoard() {
    const container = this.container;
    if (!container || !container.querySelector('#promo-list')) return;
    const state = this.boardState(), list = this.filteredPromos();
    if (!list.some((p) => String(p.id) === state.selectedId)) state.selectedId = list.length ? String((list.find((p) => this.periodStatus(p).id === 'running') || list[0]).id) : '';
    const selected = list.find((p) => String(p.id) === state.selectedId);
    const listHost = container.querySelector('#promo-list'), listScroll = listHost.scrollTop;
    listHost.innerHTML = list.length ? list.map((p) => {
      const status = this.periodStatus(p), active = String(p.id) === state.selectedId;
      return `<button type="button" class="promo-list-row ${active ? 'active' : ''}" data-promo-select="${p.id}" aria-pressed="${active}">
        <span class="spread"><span class="tiny muted">ID ${p.id} · ${String(p.type).toLowerCase() === 'auto' ? 'Автоакция' : 'Акция'}</span>${UI.badge(status.text, status.kind)}</span>
        <b>${U.esc(p.name || String(p.id))}</b><span class="tiny muted">${this.promoDate(p.startDateTime)} — ${this.promoDate(p.endDateTime)}</span>
        <span class="promo-source">${this.sourceHtml(p)}</span></button>`;
    }).join('') : '<div class="promo-empty muted">Акций по фильтру нет. Измените поиск или период.</div>';
    listHost.scrollTop = listScroll;
    listHost.querySelectorAll('[data-promo-select]').forEach((button) => {
      button.onclick = () => this.selectPromo(button.dataset.promoSelect);
      button.ondblclick = () => { const p = list.find((row) => String(row.id) === button.dataset.promoSelect); if (p) this.openPromo(p); };
    });
    container.querySelector('#promo-board-count').textContent = 'Показано ' + list.length + ' из ' + ((S.state.promos || []).length + (this.localPromos || []).length);
    container.querySelector('#promo-list-count').textContent = '(' + list.length + ')';
    container.querySelector('#promo-board-error').innerHTML = this.boardError ? '<div class="alert warn">Состав не обновлён: ' + U.esc(this.boardError) + '. Сохранённые файлы не изменены.</div>' : '';
    container.querySelectorAll('[data-promo-mode]').forEach((button) => {
      const active = button.dataset.promoMode === state.mode;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
    });
    this.drawSelectedPromo(selected);
    const main = container.querySelector('#promo-board-main');
    const oldScroll = main.querySelector('.promo-calendar-scroll, .tablewrap'), scrollLeft = oldScroll ? oldScroll.scrollLeft : 0, scrollTop = oldScroll ? oldScroll.scrollTop : 0;
    main.innerHTML = '';
    if (!list.length) { main.innerHTML = '<div class="promo-empty muted">Нет акций для отображения.</div>'; return; }
    if (state.mode === 'table') this.drawPromotionsTable(main, list);
    else this.drawGantt(main, list);
    const scroller = main.querySelector('.promo-calendar-scroll, .tablewrap');
    if (scroller) {
      scroller.scrollLeft = this._centerToday && state.mode === 'gantt' ? Math.max(0, (this._todayX || 0) - 60) : scrollLeft;
      scroller.scrollTop = scrollTop;
      if (state.mode === 'gantt') this._centerToday = false;
    }
    main.querySelectorAll('[data-open]').forEach((button) => { button.onclick = (event) => {
      event.stopPropagation(); const p = list.find((row) => String(row.id) === button.dataset.open);
      if (p) { state.selectedId = String(p.id); this.rememberBoard(); this.openPromo(p); }
    }; });
  },

  drawSelectedPromo(p) {
    const host = this.container.querySelector('#promo-selected');
    if (!p) { host.innerHTML = ''; return; }
    const rec = this.boardIndex && this.boardIndex.get(String(p.id)), known = rec && rec.compositionKnown, status = this.periodStatus(p);
    const count = (value) => value === undefined || value === null ? '—' : U.fmt(value);
    host.innerHTML = `<div class="promo-selected-header">
      <div class="spread"><h2>${U.esc(p.name || String(p.id))}</h2>${UI.badge(status.text, status.kind)}</div>
      <div class="row wrap tiny muted">ID ${p.id} · ${this.promoDate(p.startDateTime)} — ${this.promoDate(p.endDateTime)} · ${String(p.type).toLowerCase() === 'auto' ? 'Автоакция' : 'Обычная акция'} ${this.sourceHtml(p)}</div>
      <div class="promo-composition-stats">
        <span>В составе <b data-promo-count>${count(known ? rec.compositionCount : null)}</b></span>
        <span>Для репрайсера <b>${count(known ? rec.selectedCount : null)}</b></span>
        <span>С плановой ценой <b>${count(known ? rec.withPlanPrice : null)}</b></span>
        <span title="Наблюдение всех цен размеров в период акции; не подтверждение состава от WB">Цена ≤ порога <b>${count(known && rec.source === 'file' ? rec.priceControl.matching : null)}</b></span>
      </div>
      ${rec && rec.localUnconfirmed ? '<div class="alert warn"><b>Локальная акция вне календаря WB.</b> Импорт сохранён отдельным блоком: участие товаров и цены WB не подтверждены, репрайсер не управляет ценой по этой акции.</div>' : ''}
      ${rec && rec.manualFile ? `<div class="hint">Файл: ${U.esc(rec.manualFile)} · ${U.date(rec.manualAt, true)}${rec.ownership && rec.ownership.catalogAt ? ' · каталог проверен ' + U.date(rec.ownership.catalogAt, true) : ''}</div>` : ''}
      ${rec && rec.ownership && rec.ownership.status === 'blocked' ? '<div class="alert warn">' + U.esc(rec.ownership.error) + '</div>' : ''}
      ${rec && rec.ownership && rec.ownership.excludedCount ? '<div class="alert warn">Из сохранённого ранее файла исключено чужих nmID: ' + rec.ownership.excludedCount + '. Они не используются репрайсером. Загрузите актуальный файл этого кабинета.</div>' : ''}
      ${rec && rec.source === 'inferred' ? '<p class="hint">Это оценка по скидке, не подтверждённый состав WB. Для точных условий загрузите файл акции.</p>' : ''}
      <div class="row wrap promo-selected-actions"><button class="btn btn-sm btn-primary" data-open="${p.id}">Открыть товары</button><button class="btn btn-sm" data-upload="${p.id}">Загрузить товары из файла</button><button class="btn btn-sm btn-promo-link" data-link="${p.id}">Перейти к акции ↗</button></div>
    </div>`;
    host.querySelector('[data-open]').onclick = () => this.openPromo(p);
    host.querySelector('[data-upload]').onclick = () => this.importNoms(p, () => this.renderList());
    host.querySelector('[data-link]').onclick = () => {
      API.openExternal(U.promoCabinetUrl({ id: p.id, name: p.name }, S.state.settings));
      App.toast('Открыли акцию в WB: «Перейти к товарам для акции» → «Сформировать» → «Скачать», затем загрузите файл сюда.', 'ok', 10000);
    };
  },

  drawPromotionsTable(host, list) {
    const state = this.boardState(), num = (p, field) => {
      const rec = this.boardIndex && this.boardIndex.get(String(p.id));
      return rec && rec.compositionKnown ? U.fmt(rec[field]) : '—';
    };
    const table = UI.table({ columns: [
      { title: 'Акция', key: 'name', render: (p) => `<b>${U.esc(p.name)}</b><div class="tiny muted">ID ${p.id} · ${String(p.type).toLowerCase() === 'auto' ? 'автоакция' : 'обычная'}</div>` },
      { title: 'Период', render: (p) => { const status = this.periodStatus(p); return UI.badge(status.text, status.kind); } },
      { title: 'Начало', key: 'start', render: (p) => this.promoDate(p.startDateTime) },
      { title: 'Окончание', key: 'end', render: (p) => this.promoDate(p.endDateTime) },
      { title: 'Товаров в составе', num: true, render: (p) => num(p, 'compositionCount') },
      { title: 'Для репрайсера', num: true, render: (p) => num(p, 'selectedCount') },
      { title: 'С плановой ценой', num: true, render: (p) => num(p, 'withPlanPrice') },
      { title: 'Источник состава', render: (p) => this.sourceHtml(p) },
      { title: 'Состав', render: (p) => `<button class="btn btn-xs" data-open="${p.id}">Товары →</button>` }
    ], rows: list, rowClass: (p) => 'promo-table-row' + (String(p.id) === state.selectedId ? ' selected' : ''),
      onRowClick: (p) => this.selectPromo(p.id), onRowDblClick: (p) => this.openPromo(p),
      sort: { key: state.sort, dir: state.dir, onSort: (key) => { state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc'; state.sort = key; this.drawBoard(); } },
      empty: 'В календаре нет акций' });
    table.el.classList.add('promo-promotions-table'); host.appendChild(table.el);
    table.el.querySelectorAll('tbody tr').forEach((row, i) => {
      row.dataset.promoId = list[i].id; row.tabIndex = 0;
      row.onkeydown = (event) => { if (event.key === 'Enter' && event.target === row) this.openPromo(list[i]); };
    });
  },

  drawGantt(host, list) {
    const state = this.boardState(), day = 86400000;
    const dayNumber = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? Math.floor((ms + 10800000) / day) : null; };
    const dated = list.filter((p) => this.periodStatus(p).id !== 'unknown');
    const today = Math.floor((Date.now() + 10800000) / day);
    const start = Math.min(today - 2, ...dated.map((p) => dayNumber(p.startDateTime) - 2));
    const end = Math.max(today + 28, ...dated.map((p) => dayNumber(p.endDateTime) + 2));
    const days = Math.max(1, end - start + 1), px = Math.min(state.zoom === 'week' ? 7 : 24, 12000 / days), width = Math.ceil(days * px);
    const step = Math.max(state.zoom === 'week' ? 7 : 1, Math.ceil(55 / px));
    const label = (d) => new Date(d * day).toISOString().slice(5, 10).split('-').reverse().join('.');
    const ticks = [];
    for (let i = 0; i < days; i += step) ticks.push(`<span class="promo-axis-tick" style="left:${i * px}px;width:${Math.min(step, days - i) * px}px">${label(start + i)}</span>`);
    const todayX = (today - start) * px; this._todayX = todayX;
    const marker = today >= start && today <= end ? `<span class="promo-today-line" style="left:${todayX}px" title="Сегодня, ${label(today)} МСК"></span>` : '';
    host.innerHTML = `<div class="promo-gantt-toolbar spread"><span class="hint">${label(start)} — ${label(end)} · даты МСК</span><div class="row"><label class="tiny">Масштаб <select id="promo-gantt-zoom"><option value="day">Дни</option><option value="week">Недели</option></select></label><button class="btn btn-xs" id="promo-gantt-today">Сегодня</button></div></div>
      <div class="promo-calendar-scroll" tabindex="0" aria-label="Гант акций — горизонтальная прокрутка дат"><div class="promo-gantt" style="width:${width + 260}px;--promo-timeline-width:${width}px;--promo-day-width:${px * step}px">
        <div class="promo-gantt-head"><div class="promo-gantt-name">Акция</div><div class="promo-time-axis">${ticks.join('')}${marker}</div><div class="promo-gantt-action">Состав</div></div>
        ${list.map((p) => {
          const status = this.periodStatus(p), valid = status.id !== 'unknown', x = valid ? (dayNumber(p.startDateTime) - start) * px : 0;
          const barWidth = valid ? Math.max(3, (dayNumber(p.endDateTime) - dayNumber(p.startDateTime) + 1) * px) : 0;
          return `<div class="promo-gantt-row ${String(p.id) === state.selectedId ? 'selected' : ''}" data-promo-id="${p.id}">
            <button class="promo-gantt-name" data-promo-select="${p.id}" title="${U.esc(p.name)}"><b>${U.esc(p.name)}</b><span class="tiny muted">ID ${p.id}</span></button>
            <div class="promo-gantt-track">${marker}${valid ? `<button class="promo-gantt-bar ${status.id}" data-promo-select="${p.id}" style="left:${x}px;width:${barWidth}px" title="${U.esc(p.name)}: ${this.promoDate(p.startDateTime)} — ${this.promoDate(p.endDateTime)}"><span>${this.promoDate(p.startDateTime).slice(0, 5)} — ${this.promoDate(p.endDateTime).slice(0, 5)}</span></button>` : '<span class="tiny muted">Нет корректного периода WB</span>'}</div>
            <div class="promo-gantt-action"><button class="btn btn-xs btn-ghost" data-open="${p.id}">Товары →</button></div></div>`;
        }).join('')}
      </div></div><div class="promo-gantt-legend tiny muted"><span class="promo-dot running"></span> Идёт сейчас <span class="promo-dot upcoming"></span> Предстоит <span class="promo-dot ended"></span> Завершена · Красная линия — сегодня</div>`;
    host.querySelector('#promo-gantt-zoom').value = state.zoom;
    host.querySelector('#promo-gantt-zoom').onchange = (event) => { state.zoom = event.target.value; this.rememberBoard(); this.drawBoard(); };
    host.querySelector('#promo-gantt-today').onclick = () => {
      const scroll = host.querySelector('.promo-calendar-scroll'); scroll.scrollLeft = Math.max(0, todayX - 50);
    };
    host.querySelectorAll('[data-promo-select]').forEach((button) => { button.onclick = () => this.selectPromo(button.dataset.promoSelect); });
  },

  /** XLSX/CSV проверяются по nmID полного каталога текущего кабинета до любой записи. */
  async importNoms(p, after) {
    const epoch = API.generation();
    let file;
    try { file = await API.importFile({ title: 'Товары акции «' + p.name + '»', extensions: ['xlsx', 'csv', 'txt'], filterName: 'Выгрузка WB (XLSX / CSV)' }); }
    catch (error) { App.toast(error.message, 'err'); return; }
    if (!file || epoch !== API.generation()) return;
    const wait = UI.modal({ title: 'Проверка выгрузки WB', size: 'sm', dismissable: false,
      content: UI.loading('Читаем файл и сверяем nmID с полным каталогом текущего кабинета…') });
    const payload = { promotionID: p.id, fileName: file.fileName, base64: file.base64 };
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Файл больше 50 МБ. Выгрузите меньшую таблицу.');
      const result = await API.invoke('promos:import-noms', { ...payload, action: 'preview' });
      wait.close();
      if (epoch !== API.generation()) return;
      const matched = result.matched || result.items || [], excluded = result.excluded || [];
      const ownership = result.ownership || {}, canApply = result.canApply !== false && matched.length > 0;
      const state = { kind: matched.length ? 'matched' : 'excluded', page: 0, q: '' }, pageSize = 100;
      const modal = UI.modal({ title: 'Предпросмотр условий акции', size: 'lg',
        content: `<div class="alert ${!canApply ? 'danger' : excluded.length ? 'warn' : 'info'}" id="promo-ownership-summary">
          Прочитано <b>${U.fmt(result.fileCount === undefined ? result.count : result.fileCount)}</b> товаров. В текущем кабинете: <b>${U.fmt(matched.length)}</b>. Исключено чужих nmID: <b>${U.fmt(excluded.length)}</b>.
          <br>${canApply ? 'Сохранятся только подтверждённые товары этого кабинета.' : U.esc(result.rejectionReason || 'Файл отклонён: нет товаров текущего кабинета.')} Пока ничего не сохранено и не отправлено в WB.</div>
          <p class="hint">${ownership.demo ? 'ДЕМО: сверка с демонстрационным каталогом, не с реальным WB.' : 'Кабинет: ' + U.esc(ownership.cabinetName || 'текущий') + '.'}
            Полный каталог: ${U.fmt(ownership.catalogCount)} товаров${ownership.catalogAt ? ', проверен ' + U.date(ownership.catalogAt, true) : ''}.</p>
          <p class="hint">Файл: ${U.esc(file.fileName)} · лист ${U.esc(result.sheet || 'таблица')} · заголовок ${result.headerRow || 'без заголовка'} · пропущено строк ${U.fmt(result.skipped)}.</p>
          ${(result.warnings || []).map((text) => '<div class="alert warn">' + U.esc(text) + '</div>').join('')}
          <details class="hint"><summary>Распознанные колонки файла</summary>${U.esc((result.headers || []).join(' | '))}</details>
          <div class="tabs promo-preview-tabs" role="tablist" aria-label="Результат проверки принадлежности">
            <button class="tab" role="tab" data-preview-kind="matched">Свои — сохранить (${matched.length})</button><button class="tab" role="tab" data-preview-kind="excluded">Исключены (${excluded.length})</button>
          </div>
          <div class="row wrap"><input type="search" id="promo-preview-q" placeholder="Найти nmID, артикул или название" aria-label="Поиск в предпросмотре" /><span class="hint grow" id="promo-preview-count"></span><button class="btn btn-xs" id="promo-preview-prev">←</button><button class="btn btn-xs" id="promo-preview-next">→</button></div>
          <div id="promo-preview-grid" class="tablewrap promo-preview-grid"></div>
          <p class="hint">Все значения файла — снимок на дату выгрузки. Плановая цена — точный порог; текущая и загружаемая скидки не смешиваются. Будут сохранены все свои товары, не только видимая страница; чужие не попадут в состав. Дальнейшее соответствие условиям отслеживается по фактическим ценам WB, а не по ручному черновику.</p><p id="promo-import-error" class="neg" aria-live="polite"></p>`,
        buttons: [{ label: 'Отмена', class: 'btn-ghost' }, { label: 'Сохранить', class: 'btn-primary', keepOpen: true, onClick: async (dialog) => {
          if (!canApply) return;
          const button = dialog.foot.querySelector('.btn-primary'); button.disabled = true;
          try {
            if (epoch !== API.generation()) throw new Error('Кабинет изменился. Откройте предпросмотр заново.');
            const applied = await API.invoke('promos:import-noms', { ...payload, action: 'apply', ownershipContext: result.ownershipContext, ownershipDigest: result.ownershipDigest });
            dialog.close(); if (this.promoModal) this.promoModal.close();
            window.__promoDecisions = null;
            if (after) after();
            App.toast('Сохранено своих товаров: ' + applied.count + (applied.excludedCount ? '. Исключено: ' + applied.excludedCount : '') + '. Цены в WB не отправлялись.', 'ok', 8000);
            await this.openPromo(p);
          } catch (error) { dialog.body.querySelector('#promo-import-error').textContent = error.message; button.disabled = false; }
        } }] });
      modal.foot.querySelector('.btn-primary').disabled = !canApply;
      const draw = () => {
        let list = state.kind === 'matched' ? matched : excluded;
        const q = state.q.toLowerCase().trim();
        if (q) list = list.filter((row) => [row.nmID, row.vendorCode, row.title].join(' ').toLowerCase().includes(q));
        const pages = Math.max(1, Math.ceil(list.length / pageSize)); state.page = Math.max(0, Math.min(state.page, pages - 1));
        const sample = list.slice(state.page * pageSize, (state.page + 1) * pageSize), isOwn = state.kind === 'matched';
        modal.body.querySelectorAll('[data-preview-kind]').forEach((button) => { const active = button.dataset.previewKind === state.kind; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
        modal.body.querySelector('#promo-preview-count').textContent = list.length ? (state.page * pageSize + 1) + '–' + (state.page * pageSize + sample.length) + ' из ' + list.length : 'Нет строк';
        modal.body.querySelector('#promo-preview-prev').disabled = state.page === 0;
        modal.body.querySelector('#promo-preview-next').disabled = state.page + 1 >= pages;
        modal.body.querySelector('#promo-preview-grid').innerHTML = `<table class="grid-table" data-preview-list="${state.kind}" style="min-width:${isOwn ? 1250 : 650}px"><thead><tr><th>Артикул WB</th><th>Артикул продавца</th><th>Наименование / предмет</th>${isOwn ? '<th>Плановая цена для акции, ₽</th><th>Розничная цена до скидки, ₽</th><th>Текущая скидка, %</th><th>Загружаемая скидка, %</th><th>Остаток WB</th><th>Склад продавца</th><th>Статус из файла</th>' : '<th>Причина исключения</th>'}</tr></thead><tbody>
          ${sample.map((row) => `<tr><td>${row.nmID}</td><td>${U.esc(row.vendorCode)}</td><td>${U.esc(row.title)}<div class="tiny muted">${U.esc([row.categoryName, row.brand].filter(Boolean).join(' · '))}</div></td>${isOwn ? `<td>${row.planPrice ? U.money(row.planPrice, 2) : 'порог не распознан'}</td><td>${row.price ? U.money(row.price, 2) : '—'}</td><td>${row.discount === undefined ? '—' : U.pct(row.discount, 0)}</td><td>${U.pct(row.planDiscount, 0)}</td><td>${row.stockWb === undefined ? '—' : U.fmt(row.stockWb)}</td><td>${row.stockSeller === undefined ? '—' : U.fmt(row.stockSeller)}</td><td>${U.esc(row.fileStatus || (row.inActionKnown ? row.inAction ? 'участвует на дату файла' : 'не участвует на дату файла' : 'не указан'))}</td>` : `<td class="neg">${U.esc(row.reason || 'nmID не найден в полном каталоге текущего кабинета')}</td>`}</tr>`).join('') || `<tr><td colspan="${isOwn ? 10 : 4}" class="muted center">Нет товаров в этом списке</td></tr>`}
          </tbody></table>`;
      };
      modal.body.querySelectorAll('[data-preview-kind]').forEach((button) => { button.onclick = () => { state.kind = button.dataset.previewKind; state.page = 0; draw(); }; });
      modal.body.querySelector('#promo-preview-q').oninput = (event) => { state.q = event.target.value; state.page = 0; draw(); };
      modal.body.querySelector('#promo-preview-prev').onclick = () => { state.page--; draw(); };
      modal.body.querySelector('#promo-preview-next').onclick = () => { state.page++; draw(); };
      draw();
    } catch (error) {
      wait.close();
      if (epoch !== API.generation()) return;
      UI.modal({ title: 'Файл акции не прочитан', size: 'md', content: '<div class="alert danger">' + U.esc(error.message) + '</div><p class="hint">Для импорта выберите исходную выгрузку WB в XLSX/CSV с колонкой «Артикул WB / nmID». Лист с инструкцией допускается. PDF и скриншоты пригодны для проверки заголовков, но не для импорта точных артикулов. При недоступном или неполном каталоге приложение не может подтвердить кабинет; сохранённые условия остаются нетронутыми.</p>', buttons: [{ label: 'Закрыть', class: 'btn-primary' }] });
    }
  },

  async openPromo(p) {
    const ticket = this.openTicket = (this.openTicket || 0) + 1, epoch = API.generation();
    if (this.promoModal) this.promoModal.close();
    this.promoRows = { candidates: [], inside: [] };
    const st = S.state;
    const req = U.num(p.requiredDiscountPct || p.participationPercentage);
    const body = U.el('div');
    body.innerHTML = UI.loading('Загружаем товары акции…');

    const m = UI.modal({
      title: `${p.name} — условия для репрайсера`,
      content: body,
      buttons: [
        { label: 'Перейти к акции в кабинете WB ↗', class: 'btn-ghost', keepOpen: true, onClick: () => {
            API.openExternal(U.promoCabinetUrl({ id: p.id, name: p.name }, st.settings));
            App.toast('Открыли кабинет WB: акция «' + (p.name || p.id) + '», ID ' + p.id, 'ok', 9000);
          } },
        { label: 'Загрузить товары из файла', class: 'btn-ghost', keepOpen: true, onClick: () => this.importNoms(p, () => { m.close(); this.renderList(); }) },
        { id: 'promo-detail-export', label: 'Экспорт CSV', class: 'btn-ghost', keepOpen: true, onClick: () => this.exportPromo(p) },
        { label: 'Закрыть' },
        { id: 'promo-detail-save', label: 'Сохранить', class: 'btn-primary', keepOpen: true, onClick: () => this.saveSelection(p) }
      ]
    });

    this.promoModal = m;
    const saveButton = m.foot.querySelector('[data-id="promo-detail-save"]'), exportButton = m.foot.querySelector('[data-id="promo-detail-export"]');
    saveButton.disabled = true; exportButton.disabled = true; // старый выбор/состав не сохраняется, пока открыт новый загрузчик
    const current = () => ticket === this.openTicket && epoch === API.generation() && this.promoModal === m && m.root.isConnected;

    // решения репрайсера по акциям — считаем один раз и держим в памяти
    if (!window.__promoDecisions) {
      try {
        const plan = await API.invoke('repricer:promo-plan', {});
        if (!current()) return;
        window.__promoDecisions = {};
        (plan.items || []).forEach((it) => { window.__promoDecisions[String(it.nmID)] = it; });
      } catch (e) { if (!current()) return; window.__promoDecisions = {}; }
    }
    const decisionOf = (nmID) => {
      const d = (window.__promoDecisions || {})[String(nmID)];
      if (!d) return null;
      return (d.actions || []).find((a) => String(a.promoId) === String(p.id)) || null;
    };

    /**
     * Состав акции берём из данных приложения, а НЕ из WB API.
     *
     * Метод /calendar/promotions/nomenclatures помечен у WB «Not applicable for auto promotions»
     * и отвечает HTTP 422 почти на любой акции — ни кандидатов, ни участников он не отдаёт.
     * Настоящий состав продавец скачивает файлом в кабинете и загружает сюда, а недостающее
     * приложение добирает по факту скидки товара (WB сообщает только факт скидки, не название акции).
     */
    let promoData = null;
    try {
      promoData = await API.invoke('promos:items', { promotionID: p.id });
    } catch (e) {
      promoData = { items: [], hint: e.message, source: 'none', fileInfo: null };
    }
    if (!current()) return;
    const allNoms = promoData.items || [];
    const nomenclatures = allNoms.filter((x) => !x.inAction);
    const inAction = allNoms.filter((x) => x.inAction);
    const rowsMap = new Map(S.getRows().map((r) => [Number(r.nmID), r]));

    const buildRow = (n) => {
      const r = rowsMap.get(Number(n.nmID));
      const item = r ? Object.assign({}, r.item, { price: n.price, discount: n.discount }) : { nmID: n.nmID, vendorCode: n.vendorCode, brand: n.brand, price: n.price, discount: n.discount, categoryName: n.categoryName || '', volumeLiters: n.volumeLiters };
      const ov = st.overrides[String(n.nmID)] || {};
      const curDisc = U.num(n.discount);
      // Порог каждого товара из файла важнее общего процента календаря. Загружаемая
      // скидка — снимок для старой базы: после её изменения процент считаем заново.
      const planDisc = n.planPrice > 0 && item.price > 0 ? Math.max(0, 100 * (1 - n.planPrice / item.price)) : U.num(n.planDiscount) || req;
      const targetDisc = Math.min(99, Math.max(planDisc, curDisc));
      const a = EC.analyze(st.settings, item, ov, { discountPct: targetDisc });
      const profit = a.next ? a.next.profit : a.current.profit;
      const margin = a.next ? a.next.marginPct : a.current.marginPct;
      const seller = a.next ? a.next.revenue : a.current.revenue;
      return {
        nmID: Number(n.nmID),
        vendorCode: n.vendorCode || (r && r.vendorCode) || '',
        title: n.title || (r && r.title) || (n.brand + ' ' + n.vendorCode),
        category: n.categoryName || (r && r.category) || '',
        basePrice: U.num(n.price || (r && r.basePrice)),
        curDiscount: curDisc,
        targetDiscount: targetDisc,
        requiredDiscount: planDisc, gap: Math.max(0, planDisc - curDisc),
        eligible: curDisc + 0.0001 >= planDisc,
        sellerPrice: seller,
        profit: a.current.profit,
        promoProfit: profit,
        promoMargin: margin,
        delta: profit - a.current.profit,
        stock: n.stock !== undefined ? U.num(n.stock) : n.source === 'file' ? null : r && r.stock !== undefined ? U.num(r.stock) : null,
        stockWb: n.stockWb, stockSeller: n.stockSeller, stockFromFile: n.source === 'file' && [n.stock, n.stockWb, n.stockSeller].some((v) => v !== undefined),
        fileStatus: n.fileStatus || '', priceSource: n.priceSource, discountSource: n.discountSource,
        sales30: r ? r.sales30 : 0,
        // цифры из файла кабинета WB: плановая цена и плановая скидка акции
        planPrice: U.num(n.planPrice || n.plannedPrice),
        planDiscount: U.num(n.planDiscount || n.plannedDiscount),
        source: n.source || promoData.source || 'none',
        observation: n.observation || null, managed: n.managed !== false,
        verdict: profit < 0 ? 'loss' : (margin < U.num(st.settings.targetMarginPct) ? 'below' : 'ok'),
        decision: decisionOf(n.nmID)
      };
    };

    const candidates = nomenclatures.map(buildRow);
    const inside = inAction.map(buildRow);
    st.promoSelection = new Set(promoData.selectedOnly ? (promoData.selectedIds || []).map(Number) : allNoms.map((row) => Number(row.nmID)));

    const losses = candidates.filter((c) => c.verdict === 'loss');
    const below = candidates.filter((c) => c.verdict === 'below');
    const okCount = candidates.filter((c) => c.verdict === 'ok');

    this.promoRows = { candidates, inside };
    saveButton.disabled = !allNoms.length || !!(promoData.ownership && promoData.ownership.status === 'blocked');
    exportButton.disabled = !allNoms.length;

    const srcLabel = {
      file: 'состав из файла кабинета WB' + (promoData.fileInfo ? ' («' + (promoData.fileInfo.fileName || '') + '», ' + U.fmt(promoData.fileInfo.count) + ' строк)' : ''),
      api: promoData.apiPartial ? 'частичный состав WB API — обновите список' : promoData.inferredCount ? 'WB API + оценка по скидке (' + promoData.inferredCount + ')' : 'состав из WB API',
      inferred: 'состав определён по факту скидки товара — WB не сообщает, в какой именно акции товар',
      none: 'состав не загружен'
    }[promoData.source] || 'состав не загружен';

    body.innerHTML = `
      ${promoData.items && promoData.items.length ? '' : `
        <div class="alert warn">
          <b>Состав этой акции пуст.</b> ${U.esc(promoData.hint || '')}
          <div class="hint" style="margin-top:6px">Кнопка «Перейти к акции в кабинете WB» откроет календарь акций:
            ссылка откроет сразу эту акцию (ID ${U.esc(String(p.id))}) → «Перейти к товарам для акции» →
            «Сформировать» → «Скачать». Затем нажмите «Загрузить товары из файла».</div>
        </div>`}
      <div class="row wrap" style="gap:8px;margin-bottom:10px">
        ${UI.badge(srcLabel, promoData.source === 'file' ? 'ok' : (promoData.source === 'none' ? 'warn' : 'info'))}
        ${promoData.auto ? UI.badge('автоакция — через API не управляется', 'danger') : ''}
        ${promoData.apiError ? UI.badge('API: ' + promoData.apiError, 'warn') : ''}
        <span class="hint">${promoData.apiUsed ? 'Запрос состава WB включён в настройках. Оценка по скидке не подтверждает участие.' : 'К WB за составом не обращаемся: используются файл и каталог этого кабинета.'}</span>
      </div>
      ${promoData.ownership && promoData.ownership.status === 'blocked' ? '<div class="alert danger">' + U.esc(promoData.ownership.error) + '</div>' : ''}
      ${promoData.ownership && promoData.ownership.excludedCount ? '<div class="alert warn">В старом файле исключено nmID другого кабинета: ' + promoData.ownership.excludedCount + '. Эти товары не показываются и не используются репрайсером. При сохранении останутся только проверенные свои товары.</div>' : ''}
      <div class="alert info">«Сохранить» задаёт товары для управления репрайсером — без отправки цен. Участие по цене означает, что все известные размеры стоят не выше порога из файла во время акции; это не подтверждение состава от WB. Отправка — только в репрайсере или по явно включённому расписанию.</div>
      <div class="grid g5" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Требуемая скидка</span><span class="value">${U.pct(req, 0)}</span><span class="hint">${U.esc(p.joinType || p.type || '')}</span></div>
        <div class="card stat"><span class="label">Кандидатов</span><span class="value">${candidates.length}</span><span class="hint">уже в акции: ${inside.length}</span></div>
        <div class="card stat"><span class="label">Вход безопасен</span><span class="value pos">${okCount.length}</span></div>
        <div class="card stat"><span class="label">Ниже целевой маржи</span><span class="value ${below.length ? 'warnc' : 'pos'}">${below.length}</span></div>
        <div class="card stat"><span class="label">Убыток при входе</span><span class="value ${losses.length ? 'neg' : 'pos'}">${losses.length}</span></div>
      </div>
      <div class="tabs" id="promo-tabs">
        <div class="tab active" data-tab="all">Все товары (${allNoms.length})</div>
        <div class="tab" data-tab="candidates">Кандидаты на вход (${candidates.length})</div>
        <div class="tab" data-tab="safe">Только прибыльные (${okCount.length + below.length})</div>
        <div class="tab" data-tab="risky">Убыточные (${losses.length})</div>
        <div class="tab" data-tab="inside">По цене / в файле (${inside.length})</div>
      </div>
      <div class="row wrap" style="margin-bottom:8px">
        <input id="promo-q" placeholder="Поиск по артикулу или названию" style="width:280px" />
        <div class="grow"></div>
        <button class="btn btn-sm" id="sel-safe">Выбрать прибыльные</button>
        <button class="btn btn-sm btn-ghost" id="sel-none">Снять выделение</button>
        <span id="promo-selinfo" class="muted small"></span>
      </div>
      <div id="promo-grid"></div><div class="spread promo-detail-pager"><span class="hint" id="promo-page-info"></span><div class="row"><button class="btn btn-xs" id="promo-page-prev">← Назад</button><button class="btn btn-xs" id="promo-page-next">Вперёд →</button></div></div>
    `;

    let tab = 'all', page = 0;
    const order = new Map(allNoms.map((row, i) => [row.nmID, i]));
    const allRows = candidates.concat(inside).sort((a, b) => order.get(a.nmID) - order.get(b.nmID));
    const draw = () => {
      const q = (body.querySelector('#promo-q').value || '').toLowerCase();
      let list = tab === 'all' ? allRows : tab === 'inside' ? inside
        : tab === 'risky' ? losses
        : tab === 'safe' ? candidates.filter((c) => c.verdict !== 'loss')
        : candidates;
      if (q) list = list.filter((c) => String(c.nmID).includes(q) || String(c.vendorCode).toLowerCase().includes(q) || String(c.title).toLowerCase().includes(q));

      const pageSize = 100, pages = Math.max(1, Math.ceil(list.length / pageSize));
      page = Math.max(0, Math.min(page, pages - 1));
      const from = page * pageSize, pageRows = list.slice(from, from + pageSize);
      body.querySelector('#promo-page-info').textContent = list.length ? (from + 1) + '–' + (from + pageRows.length) + ' из ' + list.length + ' товаров · страница ' + (page + 1) + ' из ' + pages : 'Нет товаров';
      body.querySelector('#promo-page-prev').disabled = page === 0;
      body.querySelector('#promo-page-next').disabled = page + 1 >= pages;
      const gridHost = body.querySelector('#promo-grid');
      gridHost.innerHTML = '';
      const grid = UI.table({
        columns: [
          { title: 'Товар', render: (c) => `<div class="rowtitle"><b class="trunc">${U.esc(c.title)}</b><span class="tiny muted">${c.nmID} · ${U.esc(c.vendorCode)} · ${U.esc(c.category)}</span></div>` },
          { title: 'Базовая цена', num: true, render: (c) => U.money(c.basePrice) + (c.priceSource === 'file' ? '<div class="tiny muted">на дату файла</div>' : '') },
          { title: 'Скидка сейчас', num: true, render: (c) => U.pct(c.curDiscount, 0) + (c.discountSource === 'file' ? '<div class="tiny muted">на дату файла</div>' : '') },
          { title: 'Скидка для порога', num: true, render: (c) => `<b>${U.pct(c.requiredDiscount, 2)}</b>${c.gap > 0 ? ` <span class="warnc tiny">(+${U.pct(c.gap, 2)})</span>` : ' <span class="pos tiny">✓</span>'}` },
          { title: 'Плановая цена WB', num: true, render: (c) => c.planPrice
              ? `<b>${U.money(c.planPrice)}</b><div class="tiny muted">в файле: загружаемая скидка ${U.pct(c.planDiscount, 0)}</div>`
              : '<span class="muted tiny">нет в файле</span>' },
          { title: 'Источник', render: (c) => ({
                file: UI.badge('из файла', 'ok'),
                inferred: UI.badge('по скидке', 'info'),
                api: UI.badge('из WB API', ''),
                none: UI.badge('не загружен', 'warn')
              }[c.source] || UI.badge(String(c.source || '—'))) },
          { title: 'Цена в акции', num: true, render: (c) => U.money(c.sellerPrice) },
          { title: 'Прибыль сейчас', num: true, render: (c) => `<span class="${U.profitClass(c.profit)}">${U.money(c.profit)}</span>` },
          { title: 'Прибыль в акции', num: true, render: (c) => `<b class="${U.profitClass(c.promoProfit)}">${U.money(c.promoProfit)}</b>` },
          { title: 'Маржа в акции', num: true, render: (c) => `<span class="${U.profitClass(c.promoMargin)}">${U.pct(c.promoMargin)}</span>` },
          { title: 'Δ прибыли', num: true, render: (c) => `<span class="${U.profitClass(c.delta)}">${U.signed(c.delta)} ₽</span>` },
          { title: 'Остаток', num: true, render: (c) => (c.stock === null ? '—' : U.fmt(c.stock)) + (c.stockFromFile ? `<div class="tiny muted">снимок из файла<br>WB: ${c.stockWb === undefined ? '—' : U.fmt(c.stockWb)} · продавец: ${c.stockSeller === undefined ? '—' : U.fmt(c.stockSeller)}</div>` : '') },
          { title: 'Продажи 30д', num: true, render: (c) => U.fmt(c.sales30) },
          { title: 'Вердикт', render: (c) => c.verdict === 'loss' ? UI.badge('убыток', 'danger') : (c.verdict === 'below' ? UI.badge('ниже цели', 'warn') : UI.badge('можно входить', 'ok')) },
          { title: 'Решение репрайсера', render: (c) => {
              const a = c.decision;
              if (!a) return '<span class="muted tiny">—</span>';
              const map = { join: ['Войти', 'ok'], exit: ['Выйти', 'danger'], stay: ['Оставить', ''], recommend: ['Выгодно войти', 'info'], skip: ['Не входим', ''], warn: ['Убыточно', 'warn'], later: ['Позже', ''] };
              const m = map[a.action] || [a.action, ''];
              return `<div title="${U.esc(a.reason)}">${UI.badge(m[0], m[1])}<div class="tiny muted">${a.raiseTo ? 'поднять до ' + U.money(a.raiseTo) : (a.joinPrice ? 'цена ' + U.money(a.joinPrice) : '')}</div></div>`;
            } },
          { title: 'Статус на дату файла', render: (c) => c.fileStatus ? U.esc(c.fileStatus) : '<span class="muted">не указан</span>' },
          { title: 'Наблюдение цены', render: (c) => {
              const names = { 'by-price': 'Все размеры ≤ порога', 'above-price': 'Выше акционной цены',
                'partial-sizes': 'Только часть размеров', ready: 'Готов к началу акции', 'not-started': 'Акция не началась',
                ended: 'Акция завершена', 'unknown-price': 'Нет цены / порога', 'unknown-period': 'Неизвестен период' };
              return c.observation ? UI.badge(names[c.observation.status] || 'Нет наблюдения', c.observation.inAction ? 'ok' : 'info') : '<span class="muted">Только данные файла</span>';
            } }
        ],
        rows: pageRows,
        select: {
          get: (c) => st.promoSelection.has(c.nmID),
          set: (c, v) => { if (v) st.promoSelection.add(c.nmID); else st.promoSelection.delete(c.nmID); },
          toggleAll: (l, v) => l.forEach((c) => { if (v) st.promoSelection.add(c.nmID); else st.promoSelection.delete(c.nmID); })
        },
        onSelect: () => {
          body.querySelector('#promo-selinfo').textContent = st.promoSelection.size ? `Выбрано: ${st.promoSelection.size}` : '';
        },
        empty: 'Список пуст',
        footer: (c) => {
          if (c.title === 'Товар') return `<b>${list.length}</b> товаров`;
          if (c.title === 'Δ прибыли') return `<span class="${U.profitClass(U.sum(list, (x) => x.delta))}">${U.signed(Math.round(U.sum(list, (x) => x.delta)))} ₽</span>`;
          return '';
        }
      });
      gridHost.appendChild(grid.el);
      body.querySelector('#promo-selinfo').textContent = st.promoSelection.size ? 'Выбрано: ' + st.promoSelection.size : '';
    };

    body.querySelectorAll('#promo-tabs .tab').forEach((t) => {
      t.onclick = () => {
        body.querySelectorAll('#promo-tabs .tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        tab = t.dataset.tab; page = 0;
        draw();
      };
    });
    body.querySelector('#promo-q').oninput = U.debounce(() => { page = 0; draw(); }, 200);
    body.querySelector('#promo-page-prev').onclick = () => { page--; draw(); };
    body.querySelector('#promo-page-next').onclick = () => { page++; draw(); };
    body.querySelector('#sel-safe').onclick = () => {
      st.promoSelection = new Set(candidates.filter((c) => c.verdict !== 'loss').map((c) => c.nmID));
      draw();
      body.querySelector('#promo-selinfo').textContent = `Выбрано: ${st.promoSelection.size}`;
    };
    body.querySelector('#sel-none').onclick = () => {
      st.promoSelection.clear();
      draw();
      body.querySelector('#promo-selinfo').textContent = '';
    };

    draw();
    this.promoModal = m;
  },

  async saveSelection(p) {
    try {
      const result = await API.invoke('promos:save-selection', { promotionID: p.id, nmIDs: Array.from(S.state.promoSelection || []) });
      window.__promoDecisions = null;
      App.toast('Сохранено для репрайсера: ' + result.saved + ' товаров. В WB ничего не отправлялось.', 'ok', 7000);
      if (this.promoModal) this.promoModal.close();
      if (this.container && this.container.isConnected) this.renderList();
    } catch (error) { App.toast(error.message, 'err', 7000); }
  },

  async joinSelected(p) { return this.saveSelection(p); },

  exportPromo(p) {
    const rows = [].concat(this.promoRows.candidates || [], this.promoRows.inside || []).map((c) => ({
      'Акция': p.name,
      'нм-код': c.nmID,
      'Артикул поставщика': c.vendorCode,
      'Название': c.title,
      'Категория': c.category,
      'Базовая цена': c.basePrice,
      'Текущая скидка %': c.curDiscount,
      'Требуемая скидка %': c.targetDiscount,
      'Цена в акции': Math.round(c.sellerPrice),
      'Прибыль сейчас': c.profit,
      'Прибыль в акции': c.promoProfit,
      'Маржа в акции %': c.promoMargin,
      'Изменение прибыли': c.delta,
      'Остаток': c.stock,
      'Продажи 30д': c.sales30,
      'Вердикт': c.verdict === 'loss' ? 'убыток' : (c.verdict === 'below' ? 'ниже цели' : 'можно входить')
    }));
    API.exportCsv(`promo-${p.id}-${new Date().toISOString().slice(0, 10)}.csv`, U.toCsv(rows));
    App.toast(`Экспортировано строк: ${rows.length}`, 'ok');
  }
};
