'use strict';

/**
 * Репрайсер: автоматический пересчёт цен по стратегиям.
 * Архитектура расчёта — три слоя (как в INDEEPA):
 *   1) универсальная стратегия, 2) верхнеуровневые ДЦО (берётся максимальная цена), 3) красивая цена.
 * Затем ценовой коридор, лимит шага за обновление и за сутки, защита от карантина цен WB.
 */
window.Views = window.Views || {};

Views.repricer = {
  title: 'Репрайсер',
  subtitle: 'Автоматический пересчёт цен по стратегиям, порогам и расписанию',

  tab: 'prices',
  results: [],
  summary: null,
  rstate: null,
  itemFilter: { q: '', strategy: '', onlyChanges: false, tile: '', seg: 'all' },
  /** Плотность строк таблицы: 'normal' | 'compact' (хранится в localStorage). */
  density: 'compact',

  render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="rp-tabs-row">
        <div class="tabs" id="rp-tabs">
          <button type="button" class="tab" data-t="prices">Товары</button>
          <button type="button" class="tab" data-t="price-tools">Цены и скидки</button>
          <button type="button" class="tab" data-t="economics">Экономика</button>
          <button type="button" class="tab" data-t="rules">Массовые правила</button>
          <button type="button" class="tab" data-t="costs">Себестоимость</button>
          <button type="button" class="tab" data-t="competitors">Конкуренты</button>
          <button type="button" class="tab" data-t="journal-prices">Журнал изменения цен</button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm rp-notices-btn" id="rp-notices-toggle" aria-expanded="false" title="Показать или скрыть информационные сообщения репрайсера">🔔 Уведомления <span class="nav-count" id="rp-notices-count" style="display:none"></span></button>
      </div>
      <div id="rp-notices" class="card rp-notices" hidden>
        <div class="spread"><b>Уведомления и справка</b><button type="button" class="btn btn-ghost btn-sm" id="rp-notices-close">Скрыть</button></div>
        <div id="rp-notices-list" style="margin-top:10px"></div>
      </div>
      <div id="rp-host">${UI.loading('Загружаем настройки репрайсера…')}</div>
    `;
    container.querySelectorAll('#rp-tabs .tab').forEach((t) => {
      t.onclick = async () => { this.tab = t.dataset.t; this.paintTabs(); await this.draw(); };
    });
    try { this.noticesOpen = window.localStorage.getItem('wb.repricer.noticesOpen') === '1'; } catch (e) { this.noticesOpen = false; }
    const noticesToggle = container.querySelector('#rp-notices-toggle');
    if (noticesToggle) noticesToggle.onclick = () => this.setNoticesOpen(!this.noticesOpen);
    const noticesClose = container.querySelector('#rp-notices-close');
    if (noticesClose) noticesClose.onclick = () => this.setNoticesOpen(false);
    container.addEventListener('click', (event) => {
      if (event.target.closest && event.target.closest('[data-open-notices]')) this.setNoticesOpen(true);
    });
    this.setNoticesOpen(this.noticesOpen);
    this.renderNotices();
    if (!this._subscribed) {
      this._subscribed = true;
      API.on('repricer', (p) => {
        if (p && p.type === 'calculated') UI.toast(`Автопересчёт цен: ${p.summary.toSend} товаров к отправке`, 'ok', 5000);
        if (p && p.type === 'sent') UI.toast(`Репрайсер отправил цен: ${p.count}`, 'ok', 5000);
      });
    }
    this.paintTabs();
    this.draw();
  },

  paintTabs() {
    this.container.querySelectorAll('#rp-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.t === this.tab));
  },

  /** Информационные сообщения живут в отдельной скрытой панели, а не висят на странице. */
  setNoticeSource(key, list) {
    this._noticeSources = this._noticeSources || {};
    if (list && list.length) this._noticeSources[key] = list;
    else delete this._noticeSources[key];
    this.renderNotices();
  },

  renderNotices() {
    if (!this.container) return;
    const list = Object.values(this._noticeSources || {}).flat();
    const host = this.container.querySelector('#rp-notices-list');
    const count = this.container.querySelector('#rp-notices-count');
    const toggle = this.container.querySelector('#rp-notices-toggle');
    if (host) host.innerHTML = list.length
      ? list.map((n) => `<div class="alert ${U.esc(n.kind || 'info')} rp-notice">${n.html}</div>`).join('')
      : '<div class="hint">Сейчас уведомлений нет. Сюда попадают объяснения расчёта, фазы отправки, причины блокировок и подробности предупреждений.</div>';
    if (count) { count.textContent = list.length ? String(list.length) : ''; count.style.display = list.length ? '' : 'none'; }
    if (toggle) toggle.classList.toggle('has-alerts', list.some((n) => n.kind === 'danger' || n.kind === 'warn'));
  },

  setNoticesOpen(value) {
    this.noticesOpen = !!value;
    try { window.localStorage.setItem('wb.repricer.noticesOpen', this.noticesOpen ? '1' : '0'); } catch (e) { /* не критично */ }
    if (!this.container) return;
    const panel = this.container.querySelector('#rp-notices');
    const toggle = this.container.querySelector('#rp-notices-toggle');
    if (panel) panel.hidden = !this.noticesOpen;
    if (toggle) toggle.setAttribute('aria-expanded', String(this.noticesOpen));
  },

  async loadState() {
    // плотность строк запоминается между запусками
    if (!this._densityLoaded) {
      this._densityLoaded = true;
      try {
        const saved = window.localStorage.getItem('wb.repricer.density');
        if (saved === 'compact' || saved === 'normal') this.density = saved;
      } catch (e) { /* приватный режим браузера — остаёмся на обычной плотности */ }
    }
    this.rstate = await API.invoke('repricer:state');
    this.itemsByNm = new Map((S.state.items || []).map((item) => [String(item.nmID), item]));
    this.cardsByNm = new Map((S.state.cards || []).map((card) => [String(card.nmID), card]));
    // себестоимость по артикулам: без неё нельзя сказать, выгоден товар или нет
    // (в INDEEPA это «Без индекса»), и такие строки не должны уходить в WB
    this.cogsByNm = {};
    try {
      S.getRows().forEach((r) => { this.cogsByNm[String(r.nmID)] = U.num(r.costPrice); });
    } catch (e) { this.cogsByNm = this.cogsByNm || {}; }
    return this.rstate;
  },

  async draw() {
    const ticket = this._drawTicket = (this._drawTicket || 0) + 1, epoch = API.generation(), tab = this.tab, container = this.container;
    if (this._gridLayout) { this._gridLayout.destroy(); this._gridLayout = null; }
    const host = container && container.querySelector('#rp-host');
    if (!host) return;
    const current = () => ticket === this._drawTicket && epoch === API.generation() && this.container === container && this.tab === tab && container.querySelector('#rp-host') === host;
    /**
     * Вложенные панели (себестоимость, календарь акций) держат ссылку на свой контейнер,
     * а через неё — весь отрисованный DOM. При смене вкладки этот DOM уже откреплён,
     * но жил бы в памяти: таблица себестоимости на 200+ строк и календарь акций заметно
     * раздувают кучу. Обнуляем ссылки перед перерисовкой — mount() поставит их заново.
     */
    if (window.Views && Views.costs) Views.costs.container = null;
    if (window.Views && Views.promos) Views.promos.container = null;
    if (Views.prices) { Views.prices.container = null; Views.prices.grid = null; }
    if (Views.economics) Views.economics.container = null;
    host.innerHTML = UI.loading();
    this._noticeSources = {};
    this.renderNotices();
    try {
      await this.loadState();
      if (!current()) return;
      /**
       * Всё рабочее место — внутри репрайсера: таблица товаров, массовые правила,
       * себестоимость, конкуренты, акции, журналы, расписание и параметры. Отдельные
       * самостоятельные пункты цен/экономики/себестоимости удалены из бокового меню.
       * Вложенные панели используют прежние общие модули без потери функций.
       */
      if (this.tab === 'prices') await this.tabPrices(host);
      else if (this.tab === 'price-tools') Views.prices.render(host);
      else if (this.tab === 'economics') Views.economics.render(host);
      else if (this.tab === 'rules') await this.tabRules(host);
      else if (this.tab === 'costs') this.tabCosts(host);
      else if (this.tab === 'competitors') this.tabCompetitors(host);
      else if (this.tab === 'promos') await this.tabPromos(host, current);
      else if (this.tab === 'promo-analytics') await this.tabPromoAnalytics(host);
      else if (this.tab === 'journal-prices') this.tabJournal(host, 'prices');
      else if (this.tab === 'journal-promos') this.tabJournal(host, 'promos');
      else if (this.tab === 'schedule') await this.tabSchedule(host);
      else await this.tabParams(host);
    } catch (e) {
      if (current()) host.innerHTML = `<div class="card"><div class="alert danger">${U.esc(e.message)}</div></div>`;
    }
  },

  // ══════════════════════ ВКЛАДКА: НОВЫЕ ЦЕНЫ ══════════════════════

  async tabPrices(host) {
    const rs = this.rstate;
    const cfg = rs.config;
    const sched = rs.scheduler;
    const sett2 = S.state.settings || {};

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <div class="row wrap">
            <label class="checkline"><input type="checkbox" id="rp-enabled" ${cfg.enabled ? 'checked' : ''} />
              <b>Планировщик РП</b></label>
            <span class="hint">${sched.enabled && sched.nextRunAt ? 'Следующий пересчёт: <b>' + U.date(sched.nextRunAt, true) + '</b>' : 'Планировщик выключен'}</span>
            ${cfg.schedule.autoSend ? UI.badge('автоотправка в WB включена', 'danger') : UI.badge('автоотправка выключена — только расчёт')}
            ${rs.demo ? UI.badge('демо-режим', 'demo') : UI.badge('данные WB API', 'live')}
          </div>
          <div class="row wrap">
            <select id="rp-schedule" style="width:230px">
              <option value="hourly" ${cfg.schedule.mode === 'hourly' ? 'selected' : ''}>Ежечасно (рекомендуется)</option>
              <option value="interval" ${cfg.schedule.mode === 'interval' ? 'selected' : ''}>Каждые N минут</option>
              <option value="daily" ${cfg.schedule.mode === 'daily' ? 'selected' : ''}>Раз в сутки в выбранный час</option>
            </select>
            <input type="number" id="rp-interval" class="num" style="width:90px" min="5" max="1440" value="${cfg.schedule.intervalMinutes}" title="Интервал, минут" />
            <button class="btn btn-primary" id="rp-calc">Пересчёт (фаза 1)</button>
            <button class="btn btn-ok" id="rp-send" disabled title="Отправить цены в WB после подтверждения">Обновить цены (отправить)</button>
          </div>
        </div>
      </div>
      <div id="rp-proposal"></div>
      <div id="rp-tiles" class="row wrap" style="gap:6px;margin-bottom:12px"></div>
      <div id="rp-summary"></div>
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap">
          <input id="rp-q" placeholder="Поиск: артикул, нм-код, название" style="width:280px" value="${U.esc(this.itemFilter.q)}" />
          <select id="rp-strategy" style="width:230px"><option value="">Все стратегии</option></select>
          <div class="grow"></div>
          <select id="rp-density" style="width:150px" title="Плотность строк: сколько товаров влезает на экран">
            <option value="normal" ${this.density === 'normal' ? 'selected' : ''}>Обычные строки</option>
            <option value="compact" ${this.density === 'compact' ? 'selected' : ''}>Плотные строки</option>
          </select>
          <button class="btn btn-sm btn-ghost" id="rp-cols" title="Выбрать, какие колонки показывать">Колонки</button>
          <button class="btn btn-sm btn-ghost" id="rp-layout">Размеры и порядок</button>
          <button class="btn btn-sm btn-ghost" id="rp-import">Импорт CSV</button>
          <button class="btn btn-sm btn-ghost" id="rp-edits-reset">Отменить несохранённое</button>
          <button class="btn btn-sm" id="rp-edits-commit">Сохранить параметры</button>
          <button class="btn btn-sm btn-ghost" id="rp-export">Экспорт CSV</button>
          <button class="btn btn-sm btn-ghost" id="rp-export-xlsx" title="Выгрузка Excel — до 150 000 строк">Excel (до 150к строк)</button>
          ${rs.demo ? '<button class="btn btn-sm btn-ghost" id="rp-drift" title="Изменить цены конкурентов, чтобы посмотреть реакцию репрайсера">Сымитировать рынок</button>' : ''}
        </div>
      </div>
      <div class="row wrap" style="gap:8px;margin-bottom:10px;align-items:center">
        <div class="seg" id="rp-seg">
          ${[['all', 'Все'], ['tosend', 'Только с изменением'], ['mine', 'Своя цена'], ['errors', 'Только ошибки'],
             ['loss', 'Только убыточные'], ['warn', 'С предупреждениями'], ['nosend', 'Не отправлять']]
            .map(([id, label]) => `<button class="seg-btn ${this.itemFilter.seg === id ? 'active' : ''}" data-seg="${id}">${label}</button>`).join('')}
        </div>
        <span class="hint" id="rp-seg-count"></span>
        ${sett2.shopName ? `<b class="rp-shopname" title="Название магазина — задаётся на вкладке «Параметры»">${U.esc(sett2.shopName)}</b>` : ''}
      </div>
      <div id="rp-grid">${this.results.length ? '' : '<div class="card muted">Нажмите «Пересчитать цены», чтобы репрайсер предложил новые цены по вашим стратегиям.</div>'}</div>
      <div class="bulkbar" id="rp-bulk" style="display:none"></div>
    `;

    this.setNoticeSource('help', [{ kind: 'info', html: `Репрайсер считает цену в три слоя: <b>стратегия</b> (конкуренты / маржа / план-факт / оборачиваемость / РРЦ / AI),
          затем <b>верхнеуровневые ДЦО</b> (защита от out-of-stock, повышение акционной цены — если сработало несколько, берётся максимальная цена),
          затем <b>красивая цена</b>. Итог загоняется в коридор «минимальная ↔ базовая» и ограничивается шагом
          <b>${U.pct(cfg.limits.maxChangePerUpdatePct, 0)}</b> за одно обновление${cfg.limits.maxChangePerDayPct ? ' и <b>' + U.pct(cfg.limits.maxChangePerDayPct, 0) + '</b> за сутки' : ''}.` }]);

    const $ = (id) => host.querySelector(id);
    $('#rp-interval').style.display = cfg.schedule.mode === 'interval' ? '' : 'none';
    $('#rp-schedule').onchange = () => { $('#rp-interval').style.display = $('#rp-schedule').value === 'interval' ? '' : 'none'; };

    $('#rp-enabled').onchange = async (e) => {
      const res = await API.invoke('repricer:scheduler', { enabled: e.target.checked });
      App.toast(res.scheduler.enabled ? 'Автообновление включено' : 'Автообновление выключено', 'ok');
      this.draw();
    };

    $('#rp-calc').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Считаем…';
      try {
        await API.invoke('repricer:save', {
          schedule: {
            mode: $('#rp-schedule').value,
            intervalMinutes: U.num($('#rp-interval').value, 60)
          }
        });
        // Несохранённые правки строки (стратегия, мин. цена, себестоимость…) обязаны
        // попасть в расчёт: иначе «Пересчёт» считает по старым настройкам, а «Новая цена»
        // не меняется, хотя в строке уже выбрана другая стратегия. commitEdits сам
        // сохраняет, пересчитывает и перерисовывает таблицу.
        if (this.pendingEdits.size) {
          const saved = await this.commitEdits(null);
          if (!saved || this.pendingEdits.size) {
            App.toast('Не удалось сохранить параметры перед пересчётом — исправьте поля и попробуйте ещё раз.', 'err', 7000);
          }
          return;
        }
        const res = await this.calculate({ full: true });
        this.results = res.results || [];
        this.summary = res.summary;
        App.toast(`Пересчитано ${res.summary.total} товаров за ${(res.tookMs / 1000).toFixed(1)} с`, 'ok');
        this.drawSummary();
        this.renderResults();
        this.drawTiles();
        await this.drawProposal();
      } catch (err) {
        App.toast(err.message, 'err', 6000);
      } finally {
        e.target.disabled = false;
        e.target.textContent = 'Пересчёт (фаза 1)';
      }
    };

    $('#rp-send').onclick = () => this.sendSelected();
    $('#rp-edits-reset').onclick = () => this.discardEdits();
    $('#rp-edits-commit').onclick = (e) => this.commitEdits(e.target);
    $('#rp-import').onclick = async () => {
      try {
        const text = await API.importCsv();
        if (text) this.importParameters(text);
      } catch (e) { App.toast(e.message, 'err', 6000); }
    };

    if (rs.demo) {
      const drift = $('#rp-drift');
      if (drift) drift.onclick = async () => {
        const r = await API.invoke('repricer:competitors:drift', {});
        App.toast(`Цены конкурентов изменились у ${r.changed} позиций — нажмите «Пересчитать цены»`, 'ok', 5000);
      };
    }

    $('#rp-cols').onclick = () => this.openColumnsPicker();
    $('#rp-layout').onclick = () => GridLayout.openSettings('repricer-products', this.layoutColumns().map((c) => ({ ...c, colId: c.id })), () => this.renderResults());
    $('#rp-q').oninput = U.debounce((e) => { this.itemFilter.q = e.target.value; this.page = 0; this.renderResults(); }, 220);
    // сегментированный фильтр (как «Все / Основной» в INDEEPA): один признак за раз,
    // вместо набора чекбоксов, которые непонятно как сочетаются
    host.querySelectorAll('#rp-seg [data-seg]').forEach((b) => {
      b.onclick = () => {
        this.itemFilter.seg = b.getAttribute('data-seg');
        this.page = 0;
        host.querySelectorAll('#rp-seg [data-seg]').forEach((x) => x.classList.toggle('active', x === b));
        this.renderResults();
      };
    });

    // плотность строк — сколько товаров влезает на экран
    const dens = $('#rp-density');
    if (dens) dens.onchange = () => {
      this.density = dens.value === 'compact' ? 'compact' : 'normal';
      try { window.localStorage.setItem('wb.repricer.density', this.density); } catch (e) { /* приватный режим */ }
      this.renderResults();
    };

    const sel = $('#rp-strategy');
    (rs.strategies || []).forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    });
    sel.onchange = (e) => { this.itemFilter.strategy = e.target.value; this.page = 0; this.renderResults(); };

    /**
     * Экспорт в Excel — как в репрайсере INDEEPA («Excel (до 150к строк)»).
     * Файл собирает собственный писатель XLSX без зависимостей, поэтому выгрузка
     * работает и в Electron, и в браузере.
     */
    $('#rp-export-xlsx').onclick = async (e) => {
      const btn = e.target;
      const list = this.filteredResults();
      if (!list.length) { App.toast('Сначала выполните пересчёт — выгружать нечего', 'warn'); return; }
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Собираем файл…';
      try {
        // выгрузка повторяет блоки колонок экрана (задание D): файл читается так же, как таблица
        const ex = this.buildExport(list);
        const headers = ex.headers;
        const rows = ex.rows;
        const res = await API.invoke('xlsx:build', {
          rows, headers, sheetName: 'Репрайсер',
          fileName: 'repricer-' + new Date().toISOString().slice(0, 10) + '.xlsx'
        });
        U.downloadBase64(res.fileName || 'repricer.xlsx', res.base64);
        App.toast('Excel выгружен: ' + U.fmt(res.rows) + ' строк, ' + U.compact(res.size) + ' байт', 'ok', 7000);
      } catch (err) {
        App.toast(err.message, 'err', 9000);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    $('#rp-export').onclick = () => {
      const list = this.filteredResults();
      if (!list.length) return App.toast('Сначала выполните пересчёт', 'warn');
      // те же блоки и колонки, что и в Excel-выгрузке
      const ex = this.buildExport(list);
      const csv = U.toCsv(ex.rows.map((row) => {
        const o = {};
        ex.headers.forEach((h, i) => { o[h] = row[i]; });
        return o;
      }));
      API.exportCsv(`repricer-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, csv);
      App.toast('Расчёт выгружен в CSV: ' + U.fmt(list.length) + ' строк, ' + ex.headers.length + ' колонок', 'ok', 6000);
    };

    this.drawTiles();
    await this.drawProposal();

    /**
     * Текущие и предложенные цены должны быть видны сразу, без обязательного нажатия
     * «Пересчитать». Если расчёта в этой сессии ещё не было — считаем сами: это локальная
     * математика, в WB при этом не идём (данные берутся из кэша приложения).
     */
    if (this.results.length) { this.drawSummary(); this.renderResults(); }
    else {
      host.querySelector('#rp-grid').innerHTML =
        '<div class="card muted">Считаем текущие и предложенные цены…</div>';
      try {
        const res = await this.calculate({ full: true });
        this.results = res.results || [];
        this.summary = res.summary;
        this.drawSummary();
        this.renderResults();
        await this.drawProposal();
      } catch (e) {
        host.querySelector('#rp-grid').innerHTML =
          `<div class="card"><div class="alert warn">${U.esc(e.message)}</div>
           <p class="hint">Нажмите «Пересчитать цены», когда данные загрузятся.</p></div>`;
      }
    }
  },

  /**
   * Сводные плитки — те же, что в «Цены и скидки», и тоже кликабельные:
   * фильтр применяется к таблице репрайсера.
   */
  drawTiles() {
    const host = this.container.querySelector('#rp-tiles');
    if (!host) return;
    const rows = S.getRows();
    const t = S.totals(rows);
    const f = this.itemFilter;
    const tile = (label, value, key, kind, hint) => {
      const active = f.tile === key;
      return `<button class="tile ${kind || ''} ${active ? 'active' : ''}" data-tile="${key}" title="${U.esc(hint || '')}">
        <span class="t-label">${U.esc(label)}</span><span class="t-value">${value}</span>
        ${active ? '<span class="t-x" title="Снять фильтр">✕</span>' : ''}</button>`;
    };
    host.innerHTML = [
      tile('выручка 30д', U.compact(t.revenue30) + ' ₽', 'revenue30', '', 'Только товары с выручкой за 30 дней'),
      tile('прибыль 30д', U.compact(t.profit30) + ' ₽', 'profit30', t.profit30 >= 0 ? 'ok' : 'danger', 'Только прибыльные за 30 дней'),
      tile('убыточных', U.fmt(t.lossCount), 'loss', t.lossCount ? 'danger' : 'ok', 'Прибыль с единицы меньше нуля'),
      tile('низкая маржа', U.fmt(t.lowCount), 'low', t.lowCount ? 'warn' : 'ok', 'Маржа ниже порога из настроек'),
      tile('без себестоимости', U.fmt(t.noCogsCount), 'nocogs', t.noCogsCount ? 'info' : 'ok', 'Себестоимость не указана'),
      tile('неликвид 90+', U.fmt(t.illiquidCount), 'badturn', t.illiquidCount ? 'warn' : 'ok', 'Оборачиваемость больше 90 дней'),
      tile('к отправке', U.fmt((this.results || []).filter((r) => r.needSend).length), 'tosend', 'accent', 'Репрайсер хочет изменить цену'),
      S.state.demo ? UI.badge('демо-данные', 'demo') : UI.badge('данные WB API', 'live')
    ].join(' ');
    host.querySelectorAll('[data-tile]').forEach((b) => {
      b.onclick = () => {
        const k = b.getAttribute('data-tile');
        this.itemFilter.tile = this.itemFilter.tile === k ? '' : k;
        this.drawTiles();
        this.renderResults();
      };
    });
  },

  /**
   * Панель предложения: что репрайсер ХОЧЕТ поставить и когда это уйдёт в WB.
   *
   * Пересчёт никогда не меняет установленные цены: предложение хранится отдельно,
   * а фаза отправки наступает по расписанию (по умолчанию через 40 минут) или по кнопке.
   */
  async drawProposal() {
    const host = this.container.querySelector('#rp-proposal');
    if (!host) return;
    let prop = null;
    try { prop = await API.invoke('repricer:proposal'); } catch (e) { return; }
    this.proposal = prop;
    const items = prop.items || [];
    const cfg = (this.rstate && this.rstate.config) || {};
    const sch = cfg.schedule || {};
    const sendBtn = this.container.querySelector('#rp-send');

    const blocked = prop.blocked || [];
    const proposalNotices = [{ kind: 'info', html: `<span class="rp-lifecycle">Фаза 1: сохранено предложений <b>${U.fmt(items.length)}</b> · расчёт ${U.date(prop.at, true)} · Фаза 2: отправка ${U.date(prop.sentAt, true)} · устарело <b>${U.fmt(prop.staleCount || 0)}</b></span>` }];
    if (blocked.length) proposalNotices.push({ kind: 'danger', html: `<b>Не вошли в предложение: ${U.fmt(prop.blockedTotal || blocked.length)} товаров с незаполненными данными.</b>
        <div class="hint" style="margin-top:4px">Репрайсер не предлагает их к отправке, пока не заполнены себестоимость
          и пороги цен — иначе цена ушла бы в WB «на глаз». Примеры:
          ${blocked.slice(0, 4).map((b) => '<span class="mono">' + U.esc(String(b.vendorCode || b.nmID)) + '</span> (' +
            U.esc((b.reasons || []).join(', ')) + ')').join('; ')}</div>
        <div class="hint" style="margin-top:4px">Заполнить можно прямо в таблице (колонки «Стратегия» и «Пол / потолок»),
          в карточке товара (двойной клик → «Комиссии и параметры») или массово во вкладке «Параметры товаров».</div>` });
    if (prop.note && items.length) proposalNotices.push({ kind: 'warn', html: U.esc(prop.note) });
    this.setNoticeSource('proposal', proposalNotices);
    const blockedLine = blocked.length
      ? `<div class="hint" style="margin-top:6px">Не вошли в предложение: <b>${U.fmt(prop.blockedTotal || blocked.length)}</b> товаров — <button type="button" class="btn btn-ghost btn-sm" data-open-notices>причины в уведомлениях</button></div>` : '';

    if (!items.length) {
      host.innerHTML = `
        <div class="card" style="margin-bottom:12px">
          <div class="row wrap" style="gap:10px">
            <div class="grow">
              <b>Предложение репрайсера пустое</b>
              <div class="hint">${U.esc(prop.note || 'Пересчёт не нашёл цен, которые стоит изменить.')}</div>
            </div>
            ${prop.at ? '<span class="hint">Последний пересчёт: <b>' + U.date(prop.at, true) + '</b></span>' : ''}
          </div>
          ${blockedLine}
        </div>`;
      if (sendBtn) sendBtn.disabled = true;
      return;
    }

    const manualCount = items.filter((x) => x.manual).length;
    const rpCount = items.length - manualCount;
    const sendAt = prop.sendAt ? new Date(prop.sendAt) : null;
    const minutesLeft = sendAt ? Math.max(0, Math.round((sendAt - Date.now()) / 60000)) : null;
    const phaseLabel = ({ sent: 'применение подтверждено WB', pending: 'передано, применение ещё не подтверждено', partial: 'частичный результат — проверьте WB', stale: 'устарело — нужен новый пересчёт' })[prop.phase] || 'ждёт отправки';
    const kind = prop.phase === 'sent' ? 'ok' : (prop.phase === 'stale' ? 'danger' : 'warn');

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap" style="gap:12px">
          <div style="flex:1;min-width:280px">
            <b>Цен в предложении: ${U.fmt(items.length)}</b> ${UI.badge(phaseLabel, kind)}
            ${manualCount ? UI.badge('из них ваших сохранённых: ' + U.fmt(manualCount), 'info') : ''}
            ${rpCount ? '<span class="hint">по расчёту репрайсера: ' + U.fmt(rpCount) + '</span>' : ''}
            <div class="hint" style="margin-top:4px">
              Расчёт от <b>${U.date(prop.at, true)}</b>.
              ${sch.autoSend
                ? 'Автоотправка включена: предложение уйдёт в WB <b>' + (sendAt ? U.date(sendAt, true) : '—') + '</b>' +
                  (minutesLeft !== null ? ' (через ' + minutesLeft + ' мин)' : '') +
                  '. До этого момента установленные цены не меняются.'
                : 'Автоотправка выключена: цены в WB не меняются, пока вы не нажмёте «Отправить в WB».'}
              Перед отправкой приложение перечитает цены кабинета и пропустит позиции, которые изменились без него.
            </div>
          </div>
          <div class="row wrap" style="gap:8px">
            <button class="btn btn-ok" id="rp-prop-send">Отправить предложение в WB</button>
            <button class="btn btn-ghost" id="rp-prop-discard">Отклонить</button>
          </div>
        </div>
        ${blockedLine}
      </div>`;

    if (sendBtn) sendBtn.disabled = prop.phase !== 'proposed';
    const proposalSend = host.querySelector('#rp-prop-send');
    if (proposalSend) proposalSend.disabled = prop.phase !== 'proposed';

    host.querySelector('#rp-prop-send').onclick = async (e) => {
      if (this.pendingEdits.size) return App.toast('Сохраните или отмените несохранённые параметры перед отправкой', 'warn');
      const btn = e.target;
      UI.confirmDialog('Отправить предложение в WB',
        `<div class="alert warn">В маркетплейс уйдёт <b>${U.fmt(items.length)}</b> цен из предложения от ${U.date(prop.at, true)}.</div>
         <p class="hint">Позиции, цена которых в кабинете изменилась с момента расчёта, будут пропущены — их список покажем после отправки.</p>`,
        async () => {
          btn.disabled = true;
          btn.textContent = 'Отправляем…';
          try {
            const res = await API.invoke('repricer:proposal-send', {});
            App.toast('Передано WB: ' + (res.sent || 0) + ' · подтверждено: ' + (res.confirmed || 0) +
              ((res.stale && res.stale.length) ? ' · пропущено устаревших: ' + res.stale.length : ''), 'ok', 8000);
            await S.loadGoods(true);
            S.invalidate();
            this.results = [];
            this.draw();
          } catch (err) {
            App.toast(err.message, 'err', 9000);
            btn.disabled = false;
            btn.textContent = 'Отправить предложение в WB';
            await this.drawProposal();
          }
        }, 'Отправить в WB');
    };

    host.querySelector('#rp-prop-discard').onclick = async () => {
      await API.invoke('repricer:proposal-discard', {});
      App.toast('Предложение отклонено — цены в WB не менялись', 'ok');
      this.draw();
    };
  },

  /**
   * Колонки таблицы цен. Их стало много (как в плотной таблице INDEEPA), поэтому
   * видимость настраивается: набор хранится в localStorage и переживает перезапуск.
   * По умолчанию показаны самые нужные, плотные — скрыты.
   */
  COLUMNS: [
    // ── блок «Артикул» ──
    { id: 'item', title: 'Товар', always: true, group: 'article' },
    { id: 'vendorCode', title: 'Артикул продавца', group: 'article' },
    { id: 'barcode', title: 'Баркод', group: 'article' },
    { id: 'allowSend', title: 'Отправка в WB', group: 'article', mergedInto: 'item' },
    { id: 'tag', title: 'Метка', group: 'article', mergedInto: 'item' },
    // ── блок «Инфо о товаре» ──
    { id: 'info', title: 'Инфо о товаре', group: 'info' },
    { id: 'stock', title: 'Остаток / оборач.', group: 'info', mergedInto: 'info' },
    { id: 'plan', title: 'План продаж', group: 'info', mergedInto: 'info' },
    // ── блок «Текущая цена» ──
    { id: 'priceNow', title: 'Цена на МП', always: true, group: 'now' },
    { id: 'myPrice', title: 'Моя цена', always: true, group: 'now' },
    { id: 'buyerNow', title: 'Цена покупателю сейчас', group: 'now' },
    { id: 'value', title: 'Выгодность', group: 'now' },
    // ── блок «Новая цена» ──
    { id: 'priceNext', title: 'Новая цена', always: true, group: 'next' },
    { id: 'buyerNext', title: 'Цена покупателю станет', group: 'next' },
    { id: 'sizes', title: 'Размеры', group: 'next' },
    { id: 'delta', title: 'Изменение', always: true, group: 'next' },
    { id: 'strategy', title: 'Стратегия', group: 'next' },
    { id: 'status', title: 'Статус', group: 'next' },
    { id: 'why', title: '', always: true, group: 'next' },
    // ── блок «Мин цена (в акции)» ──
    { id: 'floor', title: 'Мин цена / базовая', group: 'minpromo' },
    { id: 'promoMin', title: 'Мин цена в акции', group: 'minpromo' },
    { id: 'promos', title: 'Акции', group: 'minpromo' },
    // ── блок «Цена (вне акции)» ──
    { id: 'restore', title: 'Цена вне акции', group: 'outpromo' },
    { id: 'corridor', title: 'Коридор', group: 'outpromo' },
    // ── блок «Себестоимость и экономика» ──
    { id: 'cost', title: 'Себестоимость', group: 'cost' },
    { id: 'costDetail', title: 'Расходы на единицу', group: 'cost' },
    { id: 'breakEven', title: 'Безубыточность', group: 'cost' },
    { id: 'profit', title: 'Прибыль/шт', group: 'cost' },
    { id: 'margin', title: 'Маржа', group: 'cost' },
    { id: 'profitMonth', title: 'Δ прибыли/мес', group: 'cost' },
    // ── блок «Конкуренты» ──
    { id: 'competitor', title: 'Конкурент', group: 'comp' },
    { id: 'offset', title: 'Отстройка от конкурента', group: 'comp' }
  ],
  /**
   * Блоки колонок — верхний ряд шапки таблицы (задание D, как в Excel-таблице
   * репрайсера INDEEPA): «Артикул», «Инфо о товаре», «Текущая цена», «Новая цена»,
   * «Мин цена (в акции)», «Цена (вне акции)», «Себестоимость и экономика», «Конкуренты».
   * Блок виден, если видна хотя бы одна его колонка.
   */
  GROUP_TITLES: {
    article: 'Товар и настройки',
    info: 'Инфо о товаре',
    now: 'Текущая цена',
    next: 'Новая цена',
    minpromo: 'Мин цена (в акции)',
    outpromo: 'Цена (вне акции)',
    cost: 'Себестоимость и экономика',
    comp: 'Конкуренты'
  },
  GROUP_ORDER: ['article', 'info', 'now', 'next', 'minpromo', 'outpromo', 'cost', 'comp'],
  /**
   * По умолчанию показываем всё, что нужно для решения по цене: блоки «Артикул»,
   * «Инфо о товаре», «Текущая цена», «Новая цена», «Мин цена (в акции)»,
   * «Цена (вне акции)», «Себестоимость» и «Конкуренты».
   * Скрыты колонки, которые дублируют соседей или утяжеляют строку: «Артикул продавца»
   * (артикул и бренд уже в колонке «Товар»), «Расходы на единицу» и «Безубыточность»
   * (состав расходов и точка безубыточности есть в кнопке «почему») и «Коридор»
   * (дублирует пороги).
   * Все они включаются в один клик в окне «Колонки» — целиком блоком или по отдельности.
   */
  DEFAULT_COLUMNS: ['item', 'info',
    'priceNow', 'myPrice', 'buyerNow', 'value', 'priceNext', 'buyerNext', 'sizes', 'delta',
    'strategy', 'status', 'why', 'floor', 'promoMin', 'promos', 'restore',
    'cost', 'profit', 'margin', 'profitMonth',
    'competitor', 'offset'],
  /**
   * Компактный набор — по одной-две ключевые колонки из каждого блока,
   * для небольшого экрана. Обязательные колонки всегда внутри.
   */
  COMPACT_COLUMNS: ['item', 'priceNow', 'myPrice', 'value', 'priceNext',
    'delta', 'strategy', 'floor', 'cost', 'profit', 'margin', 'status', 'why'],
  COLS_KEY: 'wb.repricer.columns',

  /** Старые colId остаются в справочнике как миграционные ссылки, не дублируют поля. */
  layoutColumns() { return this.COLUMNS.filter((col) => !col.mergedInto); },

  colsStorageKey() { return this.COLS_KEY + '.' + (API.activeProfileId() || 'single'); },

  /** Старые настройки колонок не удаляем: объединённые поля переводим в их блок. */
  visibleCols() {
    let list = null;
    try {
      const raw = localStorage.getItem(this.colsStorageKey()) || localStorage.getItem(this.COLS_KEY);
      list = raw ? JSON.parse(raw) : null;
    } catch (_) {}
    if (!Array.isArray(list)) list = this.DEFAULT_COLUMNS;
    const definitions = new Map(this.COLUMNS.map((col) => [col.id, col]));
    const visible = new Set();
    list.forEach((id) => { const col = definitions.get(String(id)); if (col) visible.add(col.mergedInto || col.id); });
    this.layoutColumns().filter((col) => col.always).forEach((col) => visible.add(col.id));
    return visible;
  },

  saveVisibleCols(set) {
    try { localStorage.setItem(this.colsStorageKey(), JSON.stringify(Array.from(set))); }
    catch (_) { /* приватный режим — вид работает без записи */ }
  },

  /**
   * Окно выбора колонок: список сгруппирован по блокам, у каждого блока свой
   * чекбокс «включить весь блок» (задание D — блоки как в таблице INDEEPA).
   * Обязательные колонки (товар, текущая и новая цена, изменение, «почему»)
   * выключить нельзя — без них таблица теряет смысл.
   */
  openColumnsPicker() {
    const vis = this.visibleCols();
    const body = U.el('div');
    const blocks = this.GROUP_ORDER.map((gid) => {
      const cols = this.colsOfGroup(gid);
      const on = cols.some((c) => c.always || vis.has(c.id));
      const all = cols.every((c) => c.always || vis.has(c.id));
      return `<div class="card colblock" data-block="${gid}" style="padding:8px 10px">
          <label class="checkline" style="margin:0 0 4px">
            <input type="checkbox" data-block-toggle="${gid}" ${on ? 'checked' : ''} ${all ? 'data-all="1"' : ''} />
            <b>${U.esc(this.GROUP_TITLES[gid] || gid)}</b>
            <span class="tiny muted">${cols.length} кол.</span>
          </label>
          <div class="grid g2" style="gap:4px">
            ${cols.map((c) => `<label class="checkline tiny" style="margin:0">
                <input type="checkbox" data-col="${c.id}" data-block="${gid}"
                  ${c.always ? 'checked disabled' : (vis.has(c.id) ? 'checked' : '')} />
                ${U.esc(c.title || 'Действия')}${c.always ? ' <span class="muted">всегда</span>' : ''}
              </label>`).join('')}
          </div>
        </div>`;
    }).join('');
    body.innerHTML = `
      <div class="alert info">Колонки разложены по блокам — как в таблице репрайсера INDEEPA.
        Включайте блок целиком или отдельные колонки: товар, текущая цена, новая цена,
        изменение и кнопка «почему» показаны всегда.<br>Отправка в WB и метка находятся внутри закреплённого «Товара»; остаток и план — внутри «Инфо о товаре». Отдельные широкие колонки для них больше не нужны.</div>
      <div class="colblocks">${blocks}</div>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button class="btn btn-sm" id="cp-compact">Компактный набор (${this.COMPACT_COLUMNS.length} колонок)</button>
        <button class="btn btn-sm" id="cp-full">Все колонки</button>
        <button class="btn btn-sm btn-ghost" id="cp-default">Как по умолчанию</button>
      </div>`;
    UI.modal({
      title: 'Колонки таблицы цен',
      size: 'md',
      content: body,
      buttons: [
        { label: 'Отмена', class: 'btn-ghost' },
        { label: 'Применить', class: 'btn-primary', onClick: () => {
            const next = new Set();
            body.querySelectorAll('[data-col]').forEach((cb) => {
              const id = cb.getAttribute('data-col');
              const col = this.COLUMNS.find((c) => c.id === id);
              if ((col && col.always) || cb.checked) next.add(id);
            });
            this.saveVisibleCols(next);
            this.renderResults();
            App.toast('Показывается колонок: ' + next.size + ' из ' + this.layoutColumns().length +
              ', блоков: ' + this.visibleGroupIds().length, 'ok', 5000);
          } }
      ]
    });
    const syncBlocks = () => body.querySelectorAll('[data-block-toggle]').forEach((bt) => {
      const cols = Array.from(body.querySelectorAll('[data-col][data-block="' + bt.getAttribute('data-block-toggle') + '"]'));
      bt.checked = cols.some((cb) => cb.checked); bt.indeterminate = bt.checked && !cols.every((cb) => cb.checked);
    });
    body.querySelectorAll('[data-block-toggle]').forEach((bt) => {
      bt.onchange = () => {
        body.querySelectorAll('[data-col][data-block="' + bt.getAttribute('data-block-toggle') + '"]').forEach((cb) => { if (!cb.disabled) cb.checked = bt.checked; });
        syncBlocks();
      };
    });
    body.querySelectorAll('[data-col]').forEach((cb) => { cb.onchange = syncBlocks; });
    const applySet = (ids) => {
      body.querySelectorAll('[data-col]').forEach((cb) => { cb.checked = cb.disabled || ids.includes(cb.getAttribute('data-col')); });
      // Нельзя вызывать onchange блока: его прежнее состояние затирало выбранный набор.
      syncBlocks();
    };
    body.querySelector('#cp-compact').onclick = () => applySet(this.COMPACT_COLUMNS);
    body.querySelector('#cp-full').onclick = () => applySet(this.layoutColumns().map((col) => col.id));
    body.querySelector('#cp-default').onclick = () => applySet(this.DEFAULT_COLUMNS);
    syncBlocks();
  },

  /** Оставляет только видимые колонки (обязательные — всегда). */
  filterCols(cols) {
    const vis = this.visibleCols(), definitions = new Map(this.COLUMNS.map((col) => [col.id, col]));
    // Явный colId вместо позиционного соответствия двух массивов: перенос/слияние
    // поля не может подставить цену под чужой заголовок или сломать сохранённый вид.
    this._renderColumns = GridLayout.orderedColumns(cols.filter((col) => {
      const def = definitions.get(col.colId);
      return def && !def.mergedInto && (def.always || vis.has(def.id));
    }).map((col) => ({ ...col, group: definitions.get(col.colId).group })), 'repricer-products');
    return this._renderColumns;
  },

  /** Колонки справочника, входящие в блок. */
  colsOfGroup(gid) {
    return this.layoutColumns().filter((c) => c.group === gid);
  },

  /** Видимые колонки блока (обязательные считаются видимыми всегда). */
  visibleGroupIds() {
    const vis = this.visibleCols();
    return this.GROUP_ORDER.filter((gid) => this.colsOfGroup(gid)
      .some((c) => c.always || vis.has(c.id)));
  },

  /**
   * Статус выгодности товара — как в репрайсере INDEEPA: сразу видно, что продавать выгодно,
   * а что тянет в минус. Считается по марже относительно целевой и минимальной.
   * «Без индекса» — нет данных для оценки (не задана себестоимость).
   */
  valueStatus(r) {
    const cfg = this.rowConfig(r.nmID);
    const defs = this.rstate.defaults || {};
    const cogs = U.num((this.cogsByNm || {})[String(r.nmID)]);
    return RP.valueStatus(r, cfg, defs, cogs);
  },

  /**
   * Ошибки валидации строки. Как в INDEEPA: товар с незаполненными данными показывается
   * с красной подписью и НЕ предлагается к отправке — иначе репрайсер считал бы цену
   * «от балды» и отправлял её в WB.
   */
  rowErrors(r) {
    const out = r.error ? [String(r.error)] : [];
    const cfg = this.rowConfig(r.nmID);
    const cogs = U.num((this.cogsByNm || {})[String(r.nmID)]);
    if (cogs <= 0) out.push('не задана себестоимость');
    else if (cogs <= 2) out.push('себестоимость должна быть больше 2 ₽');
    const floor = U.num(cfg.minPrice) || U.num(r.corridor && r.corridor.min);
    if (!(floor > 0)) out.push('не задан порог минимальной цены');
    const base = U.num(r.current && r.current.basePrice);
    // цена, сохранённая вручную в «Цены и скидки», задаст базовую при отправке —
    // поэтому ругаться «не задана базовая цена» при живом черновике нельзя (как на сервере)
    const draftBase = U.num(((S.state.priceDrafts || {})[String(r.nmID)] || {}).basePrice);
    if (!(base > 0) && !(draftBase > 0)) out.push('базовая цена в WB не задана — обновите данные из кабинета или сохраните свою цену');
    /**
     * Себестоимость в валюте закупки без курса: сервер не берёт такую строку в
     * предложение, поэтому клиентская проверка обязана показать ту же причину.
     */
    const costErr = (r.cost && r.cost.error) || (S.state.overrides || {})[String(r.nmID)] && (S.state.overrides || {})[String(r.nmID)].costError;
    if (costErr) out.push(String(costErr));
    return out;
  },

  /** Валюты, в которых можно вести себестоимость: ₽ + все валюты с курсом из настроек. */
  costCurrencies() {
    const rates = (S.state.settings && S.state.settings.costRates) || {};
    return Array.from(new Set(['RUB'].concat(Object.keys(rates))));
  },

  /** Курс валюты себестоимости из настроек (задание D): для ₽ всегда 1, 0 — курс не задан. */
  costRate(cur) {
    const c = String(cur || 'RUB').trim().toUpperCase();
    if (!c || c === 'RUB') return 1;
    const rates = (S.state.settings && S.state.settings.costRates) || {};
    const r = Number(rates[c]);
    return Number.isFinite(r) && r > 0 ? r : 0;
  },

  /** Подпись к цене покупателю: какие скидки (СПП и кошелёк) в ней учтены. */
  walletNote(r, which) {
    const w = r.wallet || null;
    if (!w) return '';
    const parts = [];
    if (U.num(w.sppPct) > 0) parts.push('СПП ' + U.pct(w.sppPct, 1));
    if (U.num(w.walletPct) > 0) parts.push('кошелёк ' + U.pct(w.walletPct, 1));
    if (!parts.length) return '';
    const buyer = which === 'next' ? w.nextBuyer : w.nowBuyer;
    return ` <span title="Цена покупателю ${U.money(buyer)} = цена продавца − ${parts.join(' − ')}">· ${parts.join(' + ')}</span>`;
  },

  /** Флаг отправки и метка теперь живут рядом с кодами товара, всегда слева. */
  sendControlHtml(r) {
    const cfg = this.rowConfig(r.nmID);
    const on = cfg.allowSend === undefined ? r.allowSend !== false : cfg.allowSend !== false;
    return `<label class="checkline tiny rp-sendline" title="Выключено — расчёт остаётся виден, но цена в WB не уйдёт">
      <input type="checkbox" class="rp-allowsend" data-nm="${r.nmID}" ${on ? 'checked' : ''} /><span class="${on ? 'pos' : 'neg'}">${on ? 'Отправка в WB' : 'Не отправлять'}</span></label>`;
  },

  tagControlHtml(r) {
    const cfg = this.rowConfig(r.nmID);
    const val = cfg.tag === undefined ? r.tag || '' : cfg.tag || '';
    return `<label class="rp-tag-field tiny muted">Метка <input type="text" class="cellinput rp-tag" data-nm="${r.nmID}" maxlength="24" placeholder="нет" value="${U.esc(val)}" title="Метка товара для фильтров и массовых правил" /></label>`;
  },

  productCellHtml(r) {
    const item = this.itemsByNm.get(String(r.nmID)) || {}, card = (this.cardsByNm || new Map()).get(String(r.nmID)) || {};
    const raw = item.photo || item.photoUrl || card.photo || (item.photos && item.photos[0]);
    const photo = typeof raw === 'string' ? raw : raw && (raw.small || raw.big);
    const title = card.title || r.title || item.title || r.vendorCode || String(r.nmID);
    return `<div class="rp-product-block">
      <div class="rp-product-identity">${photo && /^https:\/\//i.test(photo) ? `<img class="rp-photo" src="${U.esc(photo)}" loading="lazy" alt="" />` : '<span class="rp-photo muted" aria-label="Нет фото">▧</span>'}
        <div class="rowtitle"><button type="button" class="rp-product-title" data-item-card="${r.nmID}" title="${U.esc(title)}">${U.esc(title)}</button>
          <span class="tiny"><span class="muted">SKU / nmID</span> <b>${r.nmID}</b></span>
          <span class="tiny"><span class="muted">Арт.</span> ${U.esc(r.vendorCode || item.vendorCode || '—')}</span>
          <span class="tiny muted">${U.esc(item.brand || card.brand || 'Бренд не указан')}</span></div></div>
      <div class="rp-product-barcode tiny"><span class="muted">Баркод</span> ${this.barcodeCellHtml(r)}</div>
      <div class="rp-product-controls"><span data-field-id="allowSend">${this.sendControlHtml(r)}</span><span data-field-id="tag">${this.tagControlHtml(r)}</span></div>
    </div>`;
  },

  stockCellHtml(r) {
    const c = r.context || {};
    if (c.stock === undefined || c.stock === null) return '<span class="muted tiny">Остаток не загружен</span>';
    return `<b>${U.fmt(c.stock)} шт</b>${U.stockWarn(c.stock, c.turnoverDays, S.state.settings.stocksLowDays) ? ' ' + UI.badge('заканчивается', 'warn') : ''}<span class="tiny muted"> · ${c.turnoverDays >= 999 ? '∞' : Math.round(U.num(c.turnoverDays))} дн оборач.</span>`;
  },

  /** Баркод товара: из карточки контент-API (в демо-данных баркодов нет). */
  barcodeCellHtml(r) {
    const card = (this.cardsByNm || new Map()).get(String(r.nmID)) || {};
    const list = Array.isArray(card.skus) && card.skus.length ? card.skus : [];
    const main = String(r.barcode || card.barcode || list[0] || '');
    if (!main) return '<span class="muted tiny">нет в карточке</span>';
    return `<div class="tiny rp-wrap">${U.esc(main)}${list.length > 1 ? ' · баркодов: ' + list.length : ''}</div>`;
  },

  /** Блок «Инфо о товаре»: категория, объём, число размеров, бренд и признаки товара. */
  itemInfoCellHtml(r) {
    const item = this.itemsByNm.get(String(r.nmID)) || {};
    const card = (this.cardsByNm || new Map()).get(String(r.nmID)) || {};
    const vol = U.num(item.volumeLiters || card.volumeLiters);
    const sizes = Math.round(U.num(item.sizesCount || 0));
    const rows = [];
    if (item.categoryName || card.subjectName) rows.push(U.esc(item.categoryName || card.subjectName));
    if (vol > 0) rows.push('объём ' + vol.toFixed(2) + ' л');
    if (sizes > 0) rows.push('размеров: ' + sizes);
    const badges = [];
    if (item.editableSizePrice) badges.push(UI.badge('цены по размерам', 'info'));
    if (item.inPromo) badges.push(UI.badge('в акции', 'warn'));
    if (item.isBadTurnover) badges.push(UI.badge('плохая оборач.', 'warn'));
    return `<div class="rp-info-block"><div class="tiny rp-wrap">${rows.join(' · ') || 'Категория не указана'}${badges.length ? ' ' + badges.join(' ') : ''}</div>
      <div class="rp-info-cost" data-field-id="cost"><span class="tiny muted">Себестоимость / единицу</span>${this.costCellHtml(r)}</div>
      <div class="rp-info-stock" data-field-id="stock"><span class="tiny muted">Остаток / оборачиваемость</span><div>${this.stockCellHtml(r)}</div></div>
      <div class="rp-info-plan" data-field-id="plan"><span class="tiny muted">План продаж / месяц</span>${this.planCellHtml(r)}</div></div>`;
  },

  /**
   * Блок «Мин цена (в акции)»: порог скидки, который требует акция, и цена,
   * которая получится при этом пороге. Ниже этой цены WB сам выведет товар из акции.
   */
  promoMinCellHtml(r) {
    const p = r.promo || {};
    const actions = p.actions || r.promoActions || [];
    const floorPct = U.num(p.discountFloor);
    const base = U.num(r.current && r.current.basePrice);
    const curDisc = U.num(r.current && r.current.discount);
    if (!floorPct && !actions.length && !p.inPromo) return '<span class="muted tiny">акций нет</span>';
    const minSeller = floorPct > 0 && base > 0 ? Math.round(base * (1 - floorPct / 100) * 100) / 100 : 0;
    const chosen = p.chosen || r.promoChosen || null;
    const labels = { join: 'входим в акцию', exit: 'выходим из акции', stay: 'остаёмся в акции', warn: 'риск вывода', hold: 'удержание' };
    const out = [];
    if (floorPct > 0) out.push(`порог скидки <b>${U.pct(floorPct, 1)}</b> → мин цена ${U.money(minSeller)}`);
    else out.push('порог скидки не задан');
    if (curDisc > 0) out.push('сейчас скидка ' + U.pct(curDisc, 1));
    if (chosen && chosen.type) out.push(UI.badge(labels[chosen.type] || chosen.type, chosen.type === 'warn' ? 'warn' : 'info'));
    if (U.num(p.plannedPrice) > 0) {
      out.push('цена WB ' + U.money(p.plannedPrice) +
        (U.num(p.plannedDiscount) > 0 ? ' (−' + U.pct(p.plannedDiscount, 0) + ')' : ''));
    }
    if (actions.length) out.push('акций доступно: ' + actions.length);
    return `<div class="tiny rp-wrap">${out.join(' · ')}</div>`;
  },

  /**
   * Блок «Цена (вне акции)»: базовая цена сейчас и после расчёта, цена восстановления
   * после выхода из акции и порог удержания скидки (чтобы WB не вернул товар в автоакцию).
   */
  restoreCellHtml(r) {
    const p = r.promo || {};
    const rp = p.restorePair;
    const out = [`база ${U.money(r.current && r.current.basePrice)} → <b>${U.money(r.proposed && r.proposed.basePrice)}</b>`];
    if (rp) out.push(`после акции ${U.money(rp.sellerPrice)} (скидка ${U.pct(rp.discount, 0)})`);
    else if (!p.inPromo) out.push('товар вне акции');
    if (U.num(p.holdDiscountMax) > 0) out.push(`удержание: скидка ниже ${U.pct(p.holdDiscountMax, 0)}`);
    return `<div class="tiny rp-wrap">${out.join(' · ')}</div>`;
  },

  /**
   * Блок «Себестоимость»: значение правится прямо в строке, валюта выбирается рядом,
   * а под полем видно, сколько это в рублях по курсу из настроек. Так себестоимость
   * живёт на одном экране с ценой — проваливаться в другой раздел не нужно.
   */
  costCellHtml(r) {
    const c = r.cost || {};
    const nm = String(r.nmID);
    const pend = (this.pendingEdits.get(nm) || {}).cost || {};
    const saved = (S.state.costs || {})[nm] || {};
    const ov = (S.state.overrides || {})[nm] || {};
    const hasSaved = saved.costPriceRub !== undefined && saved.costPriceRub !== null && saved.costPriceRub !== '';
    const entered = pend.costPriceRub !== undefined ? U.num(pend.costPriceRub)
      : (hasSaved ? U.num(saved.costPriceRub)
        : (c.entered !== null && c.entered !== undefined ? U.num(c.entered) : U.num(ov.costPriceRub)));
    const cur = String(pend.currency || saved.currency || c.currency || ov.currency || ov.costCurrency || 'RUB').trim().toUpperCase();
    const rate = this.costRate(cur);
    const rub = cur === 'RUB' ? entered : (rate > 0 ? Math.round(entered * rate * 100) / 100 : 0);
    const src = ((r.current || {}).costSources || {}).costPriceRub || '';
    const srcLabel = { manual: 'вручную', fact: 'факт WB', category: 'справочник', settings: 'настройки', none: 'не задана' }[src] || '';
    return `<div class="row" style="gap:4px;align-items:center">
        <input type="number" class="num rp-cost" data-nm="${nm}" min="0" step="0.01" style="width:82px" value="${entered || ''}" placeholder="0" />
        <select class="rp-costcur" data-nm="${nm}" style="width:76px"
          title="Валюта закупки: значение пересчитается в рубли по курсу из настроек">
          ${this.costCurrencies().map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${U.esc(x)}</option>`).join('')}
        </select>
      </div>
      ${c.error ? `<div class="rp-validation neg tiny">ОШИБКА: ${U.esc(c.error)}</div>` : ''}
      <div class="tiny rp-wrap ${c.error || (cur !== 'RUB' && !(rate > 0)) ? 'neg' : 'muted'}"><span class="rp-cost-hint">${cur !== 'RUB' && !c.error
        ? (rate > 0 ? '= ' + U.money(rub) + ' по курсу ' + U.num(rate) + ' · ' : 'не задан курс ' + U.esc(cur) + ' · ')
        : ''}</span><span class="rp-cost-rub">${U.money(rub)}</span> / шт${srcLabel ? ' · ' + U.esc(srcLabel) : ''}</div>`;
  },

  /** Слагаемые расходов на единицу — из расчёта юнит-экономики по новой цене. */
  costDetailCellHtml(r) {
    const e = (r.cost && r.cost.next) || null;
    if (!e) return '<span class="muted tiny">нет расчёта</span>';
    const parts = [];
    const add = (label, v) => { if (U.num(v) > 0) parts.push(label + ' ' + U.money(v)); };
    add('себест.', e.cogs); add('комиссия', e.commission); add('логистика', e.logistics);
    add('хранение', e.storage); add('приёмка', e.accept); add('упаковка', e.packaging);
    add('эквайринг', e.acquiring); add('реклама', e.ad); add('налог', e.tax);
    return `<div class="tiny rp-wrap">${parts.join(' · ') || 'нет данных'} · <b>всего ${U.money(e.totalCosts)}</b> (${U.pct(e.pctCosts, 1)} от цены)</div>`;
  },

  /** Точка безубыточности и цена под целевую маржу — сразу виден запас по цене. */
  breakEvenCellHtml(r) {
    const e = (r.cost && r.cost.next) || null;
    if (!e) return '<span class="muted tiny">нет расчёта</span>';
    const be = U.num(e.breakEvenPrice);
    const minM = U.num(e.minPriceForMargin);
    const seller = U.num(r.proposed && r.proposed.sellerPrice);
    const zapas = be > 0 && seller > 0 ? ((seller - be) / be) * 100 : 0;
    const out = ['безубыточность <b>' + (be > 0 ? U.money(be) : '—') + '</b>'];
    if (minM > 0) out.push('под целевую маржу ' + U.money(minM));
    if (be > 0) out.push(`<span class="${zapas >= 0 ? 'pos' : 'neg'}">запас ${U.signed(Math.round(zapas * 10) / 10, 1)}%</span>`);
    return `<div class="tiny rp-wrap">${out.join(' · ')}</div>`;
  },

  /**
   * Спецификация выгрузки (Excel и CSV): те же блоки колонок, что и на экране
   * репрайсера (задание D). Каждая строка — [блок, колонка, функция значения].
   * Заголовок в файле получается вида «Новая цена · Новая скидка, %», поэтому
   * выгрузку можно читать так же, как таблицу, и фильтровать по блоку.
   */
  exportSpec() {
    const B = {
      art: 'Артикул', info: 'Инфо о товаре', now: 'Текущая цена', next: 'Новая цена',
      minp: 'Мин цена (в акции)', outp: 'Цена (вне акции)', cost: 'Себестоимость',
      comp: 'Конкуренты', svc: 'Служебное'
    };
    const item = (r) => (this.itemsByNm || new Map()).get(String(r.nmID)) || {};
    const card = (r) => (this.cardsByNm || new Map()).get(String(r.nmID)) || {};
    const cost = (r) => r.cost || {};
    const econ = (r) => (r.cost && r.cost.next) || {};
    const promo = (r) => r.promo || {};
    const plan = (r) => (r.context && r.context.plan) || null;
    const comp = (r) => (r.context && r.context.competitor) || null;
    /** Минимальная цена участия в акции: базовая цена минус порог скидки акции. */
    const promoMinPrice = (r) => {
      const base = U.num(r.current && r.current.basePrice);
      const floorPct = U.num(promo(r).discountFloor);
      return base > 0 && floorPct > 0 ? Math.round(base * (1 - floorPct / 100) * 100) / 100 : '';
    };
    const turn = (r) => (U.num(r.context && r.context.turnoverDays) >= 999
      ? '' : Math.round(U.num(r.context && r.context.turnoverDays)));

    return [
      [B.art, 'нм-код', (r) => r.nmID],
      [B.art, 'Артикул продавца', (r) => r.vendorCode || item(r).vendorCode || ''],
      [B.art, 'Название', (r) => r.title || ''],
      [B.art, 'Баркод', (r) => r.barcode || card(r).barcode || ''],
      [B.art, 'Отправка в WB', (r) => (r.allowSend === false ? 'нет' : 'да')],
      [B.art, 'Метка', (r) => String(this.rowConfig(r.nmID).tag || r.tag || '')],
      [B.info, 'Категория', (r) => item(r).categoryName || card(r).subjectName || ''],
      [B.info, 'Бренд', (r) => item(r).brand || card(r).brand || ''],
      [B.info, 'Объём, л', (r) => U.num(item(r).volumeLiters || card(r).volumeLiters) || ''],
      [B.info, 'Размеров', (r) => U.num(item(r).sizesCount) || ''],
      [B.info, 'Остаток, шт', (r) => U.num(r.context && r.context.stock)],
      [B.info, 'Оборачиваемость, дн', turn],
      [B.info, 'Продаж в день', (r) => Math.round(U.num(r.context && r.context.salesPerDay) * 100) / 100],
      [B.info, 'План продаж, шт', (r) => (plan(r) ? U.num(plan(r).planQty) : '')],
      [B.info, 'Выполнение плана, %', (r) => (plan(r) ? Math.round(U.num(plan(r).ratio) * 1000) / 10 : '')],
      [B.now, 'Базовая цена сейчас, ₽', (r) => U.num(r.current && r.current.basePrice)],
      [B.now, 'Скидка сейчас, %', (r) => U.num(r.current && r.current.discount)],
      [B.now, 'Цена продавцу сейчас, ₽', (r) => U.num(r.current && r.current.sellerPrice)],
      [B.now, 'Цена покупателю сейчас, ₽', (r) => U.num(r.current && r.current.buyerPrice)],
      [B.now, 'СПП, %', (r) => U.num((r.wallet || {}).sppPct)],
      [B.now, 'Скидка кошелька, %', (r) => U.num((r.wallet || {}).walletPct)],
      [B.now, 'Выгодность', (r) => (this.valueStatus(r) || {}).label || ''],
      [B.next, 'Новая базовая цена, ₽', (r) => U.num(r.proposed && r.proposed.basePrice)],
      [B.next, 'Новая скидка, %', (r) => U.num(r.proposed && r.proposed.discount)],
      [B.next, 'Новая цена продавцу, ₽', (r) => U.num(r.proposed && r.proposed.sellerPrice)],
      [B.next, 'Новая цена покупателю, ₽', (r) => U.num(r.proposed && r.proposed.buyerPrice)],
      [B.next, 'Изменение, ₽', (r) => U.num(r.delta && r.delta.abs)],
      [B.next, 'Изменение, %', (r) => U.num(r.delta && r.delta.pct)],
      [B.next, 'Стратегия', (r) => r.strategyTitle || r.strategy || ''],
      [B.next, 'Режим цены', (r) => (r.proposed && r.proposed.priceMode) || ''],
      [B.minp, 'Порог скидки акции, %', (r) => U.num(promo(r).discountFloor) || ''],
      [B.minp, 'Мин цена в акции, ₽', promoMinPrice],
      [B.minp, 'Минимальный порог, ₽', (r) => U.num(r.corridor && r.corridor.min)],
      [B.minp, 'Порог задан вручную, ₽', (r) => U.num((r.floor || {}).minPriceSet) || ''],
      [B.minp, 'Чем задан пол', (r) => ((r.floor || {}).by === 'margin' ? 'минимальной маржой' : 'порогом мин. цены')],
      [B.minp, 'В акции сейчас', (r) => (promo(r).inPromo ? 'да' : 'нет')],
      [B.minp, 'Решение по акции', (r) => ((promo(r).chosen || {}).type || '')],
      [B.minp, 'Цена WB в акции, ₽', (r) => U.num(promo(r).plannedPrice) || ''],
      [B.outp, 'Базовая цена станет, ₽', (r) => U.num(r.proposed && r.proposed.basePrice)],
      [B.outp, 'Цена после акции, ₽', (r) => U.num((promo(r).restorePair || {}).sellerPrice) || ''],
      [B.outp, 'Скидка после акции, %', (r) => U.num((promo(r).restorePair || {}).discount) || ''],
      [B.outp, 'Порог удержания скидки, %', (r) => U.num(promo(r).holdDiscountMax) || ''],
      [B.outp, 'Потолок коридора, ₽', (r) => U.num(r.corridor && r.corridor.max)],
      [B.cost, 'Себестоимость (в валюте)', (r) => (cost(r).entered === null || cost(r).entered === undefined ? '' : U.num(cost(r).entered))],
      [B.cost, 'Валюта себестоимости', (r) => cost(r).currency || 'RUB'],
      [B.cost, 'Курс валюты', (r) => U.num(cost(r).rate) || 1],
      [B.cost, 'Себестоимость, ₽', (r) => U.num(cost(r).rub)],
      [B.cost, 'Ошибка себестоимости', (r) => cost(r).error || ''],
      [B.cost, 'Комиссия, ₽', (r) => U.num(econ(r).commission)],
      [B.cost, 'Логистика, ₽', (r) => U.num(econ(r).logistics)],
      [B.cost, 'Хранение, ₽', (r) => U.num(econ(r).storage)],
      [B.cost, 'Приёмка, ₽', (r) => U.num(econ(r).accept)],
      [B.cost, 'Упаковка, ₽', (r) => U.num(econ(r).packaging)],
      [B.cost, 'Эквайринг, ₽', (r) => U.num(econ(r).acquiring)],
      [B.cost, 'Реклама, ₽', (r) => U.num(econ(r).ad)],
      [B.cost, 'Налог, ₽', (r) => U.num(econ(r).tax)],
      [B.cost, 'Всего расходов, ₽', (r) => U.num(econ(r).totalCosts)],
      [B.cost, 'Расходы, % от цены', (r) => U.num(econ(r).pctCosts)],
      [B.cost, 'Цена безубыточности, ₽', (r) => U.num(econ(r).breakEvenPrice) || ''],
      [B.cost, 'Цена под целевую маржу, ₽', (r) => U.num(econ(r).minPriceForMargin) || ''],
      [B.cost, 'Прибыль сейчас, ₽', (r) => U.num(r.current && r.current.profit)],
      [B.cost, 'Прибыль станет, ₽', (r) => U.num(r.proposed && r.proposed.profit)],
      [B.cost, 'Маржа сейчас, %', (r) => U.num(r.current && r.current.marginPct)],
      [B.cost, 'Маржа станет, %', (r) => U.num(r.proposed && r.proposed.marginPct)],
      [B.cost, 'Δ прибыли за месяц, ₽', (r) => Math.round(U.num(r.delta && r.delta.profitMonth))],
      [B.comp, 'Конкурент', (r) => (comp(r) ? (comp(r).name || comp(r).id || '') : '')],
      [B.comp, 'Цена конкурента, ₽', (r) => U.num(r.context && r.context.competitorPrice) || ''],
      [B.svc, 'Отправлять', (r) => (r.needSend ? 'да' : 'нет')],
      [B.svc, 'Ограничение', (r) => r.limitedBy || ''],
      [B.svc, 'Ошибки данных', (r) => this.rowErrors(r).join('; ')],
      [B.svc, 'Предупреждения', (r) => (r.warnings || []).join('; ')],
      [B.svc, 'Пояснение', (r) => (r.notes || []).join(' | ')]
    ];
  },

  /** Заголовки «Блок · Колонка» и значения по строкам — для Excel и CSV. */
  buildExport(list) {
    if (!this.itemsByNm) this.itemsByNm = new Map((S.state.items || []).map((it) => [String(it.nmID), it]));
    if (!this.cardsByNm) this.cardsByNm = new Map((S.state.cards || []).map((c) => [String(c.nmID), c]));
    const spec = this.exportSpec();
    return {
      spec,
      headers: spec.map((x) => x[0] + ' · ' + x[1]),
      rows: (list || []).map((r) => spec.map((x) => {
        let v;
        try { v = x[2](r); } catch (e) { v = ''; }
        return v === undefined || v === null ? '' : v;
      }))
    };
  },

  /**
   * Пометка «цена по размерам». У товаров с поразмерными ценами (editableSizePrice: true)
   * WB не отдаёт цену на уровне товара — только sizes[].price, поэтому базовая цена
   * подставлена из размеров (минимальная). Продавец обязан видеть, откуда взялась цифра
   * и что отправка изменит цену всех размеров сразу.
   */
  sizePriceNote(r) {
    const c = r.context || {};
    if (!c.priceFromSizes) return '';
    const min = U.num(c.sizePriceMin);
    const max = U.num(c.sizePriceMax);
    const spread = max > min ? ` (от ${U.money(min)} до ${U.money(max)})` : '';
    const title = `WB не отдаёт цену товара целиком: цены заданы по размерам. В расчёт взята минимальная цена размера${spread}. Режим отправки выбирается в колонке «Размеры»: ручной режим сохраняет незатронутые размеры; смена общей базовой цены может их выровнять.`;
    return `<div class="tiny"><span class="rp-sizeprice" title="${U.esc(title)}">${UI.badge('цена по размерам', 'warn')}</span></div>`;
  },

  /**
   * Ячейка «Размеры»: режим цен по размеров товара (none/sync/manual) и кнопка открытия
   * таблицы размеров. Размеры читаются из кэша товаров (itemsByNm), а не из контекста
   * строки — чтобы не дублировать массивы размеров в каждом результате расчёта.
   *
   * Режим:
   *  - none   — размеры не трогаются (по умолчанию): цена уходит ценой товара целиком;
   *  - sync   — все размеры получают цену товара;
   *  - manual — цены размеров правятся вручную в таблице (openSizesModal).
   */
  /** Индивидуальное значение, включая явное none, важнее общих параметров. */
  sizeMode(nmID) {
    const value = this.rowConfig(nmID).sizePriceMode;
    if (['none', 'sync', 'manual'].includes(value)) return value;
    const config = (this.rstate || {}).config || {};
    const fallback = (config.defaults || {}).sizePriceMode || config.sizePriceMode;
    return ['none', 'sync', 'manual'].includes(fallback) ? fallback : 'none';
  },

  sizesCellHtml(r) {
    const item = this.itemsByNm ? this.itemsByNm.get(String(r.nmID)) : null;
    const rawSizes = (item && Array.isArray(item.sizes)) ? item.sizes : ((r.context || {}).sizes || []);
    const sizes = rawSizes.map((s) => ({
      sizeID: Number(s.sizeID),
      techSizeName: String(s.techSizeName || ''),
      price: Number(s.price || 0),
      discountedPrice: Number(s.discountedPrice || 0)
    }));
    if (!sizes.length) return '<span class="muted tiny">нет размеров</span>';
    if (item && !item.editableSizePrice) return '<span class="muted tiny">единая цена · ' + sizes.length + ' разм.</span>';
    const cfg = this.rowConfig(r.nmID);
    const mode = this.sizeMode(r.nmID);
    const modeLabel = mode === 'sync' ? 'синхрон' : (mode === 'manual' ? 'ручная' : 'не трогать');

    // предупреждение: разные цены по размерам + режим none — отправка сделает их одинаковой
    const live = sizes.map((s) => U.num(s.price)).filter((p) => p > 0);
    const uniq = new Set(live.map((p) => Math.round(p * 100))).size;
    const warnEqual = mode === 'none' && uniq > 1;
    const min = live.length ? Math.min.apply(null, live) : 0;
    const max = live.length ? Math.max.apply(null, live) : 0;
    const spread = uniq > 1 ? ` · ${U.money(min)}–${U.money(max)}` : '';

    // Компактная ячейка: режим (текст) + кнопка открытия таблицы размеров. Select с
    // режимом и таблица размеров живут в модальном окне — так в большой таблице
    // репрайсера (до 200 строк) не накапливается тяжёлый DOM (select/option).
    return `<div class="rp-sizes">
      <div class="row" style="gap:4px;align-items:center">
        <span class="rp-size-mode-label tiny" style="width:80px" title="Режим цен по размерам">${modeLabel}</span>
        <button class="btn btn-xs btn-ghost rp-sizes-open" data-nm="${r.nmID}" title="Таблица цен по размерам">размеры</button>
        <span class="tiny muted">${sizes.length} шт${spread}</span>
      </div>
      ${warnEqual ? '<div class="tiny warnc" style="margin-top:3px">разные цены — отправка цены товара сделает их одинаковой</div>' : ''}
    </div>`;
  },

  /**
   * Таблица цен по размерам товара — модальное окно: режим (none/sync/manual) и
   * список размеров (размер, текущая цена, цена со скидки, новая цена). Правки копятся
   * в pendingEdits (stageSizeMode/stageSizePrice) и отправляются из раздела «Репрайсер»
   * — как остальные параметры строки.
   */
  openSizesModal(r) {
    const item = this.itemsByNm ? this.itemsByNm.get(String(r.nmID)) : null;
    const rawSizes = (item && Array.isArray(item.sizes)) ? item.sizes : ((r.context || {}).sizes || []);
    const sizes = rawSizes.map((s) => ({
      sizeID: Number(s.sizeID),
      techSizeName: String(s.techSizeName || ''),
      price: Number(s.price || 0),
      discountedPrice: Number(s.discountedPrice || 0)
    }));
    if (!sizes.length) { App.toast('У товара нет размеров', 'warn'); return; }
    if (item && !item.editableSizePrice) { App.toast('WB не разрешает разные цены размеров у этого товара', 'warn'); return; }
    const cfg = this.rowConfig(r.nmID);
    const mode = this.sizeMode(r.nmID);
    const manual = cfg.sizePrices || {};
    const targetPrice = U.num(r.proposed && r.proposed.basePrice);
    const selectedMode = ['none', 'sync', 'manual'].includes(cfg.sizePriceMode) ? cfg.sizePriceMode : '';
    const opt = (v, label) => `<option value="${v}" ${selectedMode === v ? 'selected' : ''}>${label}</option>`;
    const live = sizes.map((s) => U.num(s.price)).filter((p) => p > 0);
    const uniq = new Set(live.map((p) => Math.round(p * 100))).size;
    const warnEqual = mode === 'none' && uniq > 1;

    const rows = sizes.map((s) => {
      const sid = Number(s.sizeID);
      const cur = U.num(s.price);
      const disc = U.num(s.discountedPrice);
      const editable = mode === 'manual';
      let val = cur;
      if (mode === 'sync') val = targetPrice;
      else if (Object.prototype.hasOwnProperty.call(manual, String(sid))) val = U.num(manual[String(sid)]);
      const cell = editable
        ? `<input type="number" class="num rp-size-price" data-nm="${r.nmID}" data-size="${sid}" min="0" step="1" value="${U.num(val)}" style="width:84px" title="Новая цена размера" />`
        : `<span class="${mode === 'sync' ? 'pos' : 'muted'}">${U.money(val)}</span>`;
      return `<tr><td>${U.esc(s.techSizeName || 'размер')} <span class="tiny muted">#${sid}</span></td>` +
        `<td class="num">${U.money(cur)}</td>` +
        `<td class="num">${U.money(disc)}</td>` +
        `<td class="num">${cell}</td></tr>`;
    }).join('');

    const body = `
      <div class="row wrap" style="gap:8px;margin-bottom:8px">
        <label class="field" style="margin:0"><b>Режим цен по размерам</b>
          <select class="rp-size-mode" data-nm="${r.nmID}" style="width:180px">
            ${opt('', 'по общим параметрам (' + mode + ')')}
            ${opt('none', 'не трогать размеры')}${opt('sync', 'синхрон (цена товара)')}${opt('manual', 'ручная правка')}
          </select>
        </label>
      </div>
      ${warnEqual ? '<div class="alert warn" style="margin-bottom:8px">Разные цены по размерам, а режим «не трогать» — отправка цены товара сделает цену всех размеров одинаковой.</div>' : ''}
      <table class="grid-table"><thead><tr>
        <th>Размер</th><th class="num">Цена</th><th class="num">Со скидкой</th><th class="num">Новая цена</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="hint" style="margin-top:8px">
        ${mode === 'none' ? 'Размеры не трогаются: цена уходит ценой товара целиком.' : ''}
        ${mode === 'sync' ? `Все размеры получат цену товара (${U.money(targetPrice)}).` : ''}
        ${mode === 'manual' ? 'Правьте «новую цену» — отправятся только изменившиеся размеры.' : ''}
        Скидка задаётся на товар целиком, а не на отдельный размер.
        Корректные правки автоматически сохраняются локально. В WB отправляются отдельно.
      </p>`;

    let replacing = false;
    const api = UI.modal({
      title: `Цены по размерам — ${r.title || r.nmID}`,
      beforeClose: () => replacing || this.commitEdits(null, { quiet: true, noRetry: true }),
      content: body,
      size: 'md',
      buttons: [{ label: 'Закрыть', class: 'btn-primary' }]
    });
    const root = api && api.root;
    if (root) {
      root.querySelectorAll('.rp-size-mode').forEach((sel) => {
        sel.onchange = () => {
          this.stageSizeMode(sel.getAttribute('data-nm'), sel.value);
          replacing = true; api.close();
          this.openSizesModal(r); // сразу показать/скрыть поля ручных цен
        };
      });
      root.querySelectorAll('.rp-size-price').forEach((inp) => {
        inp.onclick = (e) => e.stopPropagation();
        inp.onchange = () => this.stageSizePrice(inp.getAttribute('data-nm'), inp.getAttribute('data-size'), inp.value);
      });
    }
  },

  /** Пустое значение — общие параметры; none — явный индивидуальный запрет. */
  stageSizeMode(nmID, mode) {
    const m = ['none', 'sync', 'manual'].includes(mode) ? mode : null;
    this.stageEdit(String(nmID), 'config', { sizePriceMode: m });
  },

  /**
   * Положить ручную цену размера в очередь правок. sizePrices — целый массив, поэтому
   * считаем его из хранилища + уже скопившихся правок и перезаписываем целиком.
   */
  stageSizePrice(nmID, sizeID, price) {
    const nm = String(nmID);
    const cfg = this.rowConfig(nmID);
    const base = Object.assign({}, cfg.sizePrices || {});
    const sid = String(sizeID);
    if (String(price).trim() === '') delete base[sid];
    else if (Number.isSafeInteger(Math.round(Number(price))) && Math.round(Number(price)) >= 1) {
      base[sid] = Math.round(Number(price));
    } else {
      App.toast('Цена размера должна быть конечным числом не меньше 1 ₽', 'warn');
      return false;
    }
    if (!Object.keys(base).length) this.stageEdit(nm, 'config', { sizePrices: null });
    else this.stageEdit(nm, 'config', { sizePrices: base });
  },

  /**
   * Ячейка «Акции» — как в INDEEPA: в одной строке видно, в какой акции товар,
   * какая минимальная цена и цена входа, маржа «сейчас → будет».
   * Данные берутся из promoActions (решения движка), поэтому дополнительных запросов нет.
   */
  promoCellHtml(r) {
    const acts = (r.promoActions || []).filter((a) => a && a.action && a.action !== 'later');
    if (!acts.length) {
      return r.context && r.context.inPromo
        ? UI.badge('В акции', 'ok') + '<div class="tiny muted">решений нет</div>'
        : UI.badge('Не в акции');
    }
    const label = { join: ['Войти', 'ok'], exit: ['Выйти', 'danger'], stay: ['Участвуем', ''], recommend: ['Выгодно войти', 'info'], skip: ['Не входим', ''], warn: ['Убыточно', 'warn'] };
    const main = r.promoChosen || acts[0];
    const m = label[main.action] || [main.action, ''];
    /**
     * Легенда колонки в INDEEPA: Акция · Период проведения · Мин цена · Цена входа ·
     * Маржинальность % · Маржа ₽ · Сейчас · Будет. Берём те же смыслы из полей движка:
     * planPrice — порог входа, joinPrice/raiseTo — цена входа или выхода,
     * marginAtPlan/marginAtJoin — маржа в акции, profitAtPlan — маржа в рублях.
     */
    const rows = acts.slice(0, 3).map((a) => {
      const entry = U.num(a.joinPrice) || U.num(a.raiseTo) || 0;
      const marginIn = a.marginAtJoin !== undefined ? U.num(a.marginAtJoin) : U.num(a.marginAtPlan);
      const nowMargin = U.num((r.current || {}).marginPct);
      return `<div class="tiny muted" style="margin-top:2px">${U.esc(a.promoName || a.promoId)}${a.promoType === 'auto' ? ' <span class="neg">авто</span>' : ''} ·
        ${a.started ? 'идёт' : 'через ' + U.num(a.daysToStart, 0) + ' дн'} ·
        мин ${U.num(a.planPrice) ? U.money(a.planPrice) : '—'} ·
        вход ${entry ? U.money(entry) : '—'} ·
        маржа ${U.pct(marginIn)} (${U.money(a.profitAtPlan)}) ·
        сейчас ${U.pct(nowMargin)} → будет ${U.pct(U.num((r.proposed || {}).marginPct))}</div>`;
    }).join('');
    const tip = acts.map((a) => [a.promoName || a.promoId,
      a.requiredDiscountPct ? ('скидка ≥ ' + U.pct(a.requiredDiscountPct, 0)) : '',
      a.period || (a.started ? 'идёт сейчас' : 'старт через ' + U.num(a.daysToStart, 0) + ' дн'),
      a.reason || ''].filter(Boolean).join(' — ')).join('\n');
    return `<div title="${U.esc(tip)}">${UI.badge(r.context && r.context.inPromo ? 'В акции' : 'Не в акции', r.context && r.context.inPromo ? 'ok' : '')} ${UI.badge(m[0], m[1])}${acts.length > 1 ? '<span class="tiny muted"> +' + (acts.length - 1) + '</span>' : ''}</div>${rows}`;
  },

  /**
   * Ячейка «План продаж» — план на месяц и % выполнения (в INDEEPA: «План не заполнен,
   * % выполнения не расчитан»). Данные уже посчитаны движком: r.context.plan.
   */
  planCellHtml(r) {
    const pl = (r.context && r.context.plan) || null;
    const input = `<input type="number" class="num rp-plan" data-nm="${r.nmID}" min="0" step="1" style="width:82px" title="План продаж на месяц, шт" value="${this.rowConfig(r.nmID).planQtyMonth || ''}" />`;
    if (!pl || !(U.num(pl.planQty) > 0)) {
      return '<div class="rp-plan-field">' + input + '<span class="muted tiny">План не заполнен, % выполнения не рассчитан</span></div>';
    }
    const ratio = U.num(pl.ratio) * 100;
    const cls = ratio >= 100 ? 'pos' : (ratio >= 60 ? 'warnc' : 'neg');
    return `<div class="rp-plan-field">${input}<span><b class="${cls}">${U.pct(ratio, 0)}</b>
      <span class="tiny muted"> · факт ${U.fmt(pl.fact || 0)} из ${U.fmt(pl.planQty)} шт</span></span></div>`;
  },

  /** Размер страницы таблицы цен: тысячи строк с десятками полей ввода вешают браузер. */
  /**
   * Строк на странице таблицы цен.
   *
   * Раньше было 200 — но после задания D колонок стало 25 вместо 20, и каждая
   * ячейка несёт ввод или разбор цифр. Страница в 100 строк остаётся «всё на одном
   * экране» по смыслу (расчёт и выгрузка по-прежнему идут по всем товарам), зато
   * таблица не тормозит при прокрутке на слабых машинах.
   */
  PAGE_SIZE: 100,
  page: 0,
  /** Страница таблицы «Параметры товаров» (там 10 полей ввода на строку — ещё тяжелее). */
  ST_PAGE_SIZE: 100,
  stPage: 0,
  stPageInfo: null,

  /** Строки текущей страницы таблицы параметров + счётчик «1 - N из M». */
  stPageOf(list) {
    const size = this.ST_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil((list.length || 0) / size));
    if (this.stPage >= pages) this.stPage = 0;
    const from = this.stPage * size;
    this.stPageInfo = { from: list.length ? from + 1 : 0, to: Math.min(list.length, from + size), total: list.length, pages };
    return list.slice(from, from + size);
  },

  /** Панель пагинации таблицы параметров. */
  drawStPager() {
    const host = this.container;
    if (!host) return;
    const info = this.stPageInfo || { from: 0, to: 0, total: 0, pages: 1 };
    let bar = host.querySelector('#st-pager');
    if (!bar) {
      bar = U.el('<div class="row wrap" id="st-pager" style="gap:8px;margin-top:10px;justify-content:flex-end"></div>');
      const grid = host.querySelector('#st-grid');
      if (grid && grid.parentNode) grid.parentNode.insertBefore(bar, grid.nextSibling);
      else return;
    }
    bar.innerHTML = `
      <span class="hint">${U.fmt(info.from)} - ${U.fmt(info.to)} из ${U.fmt(info.total)}${info.pages > 1 ? ' · страниц: ' + info.pages : ''}</span>
      <button class="btn btn-sm btn-ghost" id="st-prev" ${info.from <= 1 ? 'disabled' : ''}>← Назад</button>
      <button class="btn btn-sm btn-ghost" id="st-next" ${info.to >= info.total ? 'disabled' : ''}>Вперёд →</button>`;
    const prev = bar.querySelector('#st-prev');
    const next = bar.querySelector('#st-next');
    if (prev) prev.onclick = () => { this.stPage = Math.max(0, this.stPage - 1); this.renderStrategies(); };
    if (next) next.onclick = () => { this.stPage = this.stPage + 1; this.renderStrategies(); };
  },

  /** Строки текущей страницы + счётчик «1 - N из M» над таблицей. */
  pageOf(list) {
    const size = this.PAGE_SIZE;
    const pages = Math.max(1, Math.ceil((list.length || 0) / size));
    if (this.page >= pages) this.page = 0;
    const from = this.page * size;
    this.pageInfo = { from: list.length ? from + 1 : 0, to: Math.min(list.length, from + size), total: list.length, pages };
    return list.slice(from, from + size);
  },

  /** Панель пагинации под таблицей. */
  drawPager(host) {
    const info = this.pageInfo || { from: 0, to: 0, total: 0, pages: 1 };
    let bar = host.querySelector('#rp-pager');
    if (!bar) {
      bar = U.el('<div class="row wrap" id="rp-pager" style="gap:8px;margin-top:10px;justify-content:flex-end"></div>');
      const grid = host.querySelector('#rp-grid');
      if (grid && grid.parentNode) grid.parentNode.insertBefore(bar, grid.nextSibling);
      else host.appendChild(bar);
    }
    bar.innerHTML = `
      <span class="hint">${U.fmt(info.from)} - ${U.fmt(info.to)} из ${U.fmt(info.total)}${info.pages > 1 ? ' · страниц: ' + info.pages : ''}</span>
      <button class="btn btn-sm btn-ghost" id="rp-prev" ${info.from <= 1 ? 'disabled' : ''}>← Назад</button>
      <button class="btn btn-sm btn-ghost" id="rp-next" ${info.to >= info.total ? 'disabled' : ''}>Вперёд →</button>`;
    const prev = bar.querySelector('#rp-prev');
    const next = bar.querySelector('#rp-next');
    if (prev) prev.onclick = () => { this.page = Math.max(0, this.page - 1); this.renderResults(); };
    if (next) next.onclick = () => { this.page = this.page + 1; this.renderResults(); };
  },

  /**
   * «Моя цена» — сохранённая вручную цена (черновик), которая ещё не отправлена в WB.
   * Показывается рядом с ценой маркетплейса, чтобы было видно расхождение, и именно она
   * уйдёт в WB при отправке: ручная цена важнее расчёта репрайсера.
   */
  myPriceCellHtml(r) {
    const d = (S.state.priceDrafts || {})[String(r.nmID)];
    if (!d) return '<span class="muted tiny">нет — цена как на МП</span>';
    const mp = U.num(r.current && r.current.sellerPrice);
    const mine = U.num(d.sellerPrice) || Math.round(U.num(d.basePrice) * (1 - U.num(d.discount) / 100) * 100) / 100;
    const diff = mine - mp;
    const pct = mp > 0 ? (diff / mp) * 100 : 0;
    return `<b>${U.money(mine)}</b>
      <div class="tiny muted">база ${U.money(d.basePrice)} · скидка ${U.pct(U.num(d.discount), 0)}</div>
      <div class="tiny ${diff > 0 ? 'pos' : (diff < 0 ? 'neg' : 'muted')}">${U.signed(Math.round(diff))} ₽ · ${U.signed(pct, 1)}% к МП</div>
      ${UI.badge('не отправлена', 'info')}`;
  },

  /** СПП товара: личное значение → значение из карточки WB → настройки кабинета. */
  sppOf(r) {
    const ov = (S.state.overrides || {})[String(r.nmID)] || {};
    if (U.num(ov.sppPct) > 0) return U.num(ov.sppPct);
    const item = r.item || {};
    if (U.num(item.sppPct) > 0) return U.num(item.sppPct);
    return U.num((S.state.settings || {}).sppDefault);
  },

  /**
   * Ячейка конкурентов — как в INDEEPA: SKU конкурента, остаток, цена с СПП.
   * WB API цены конкурентов не отдаёт, поэтому список ведётся вручную;
   * «+» добавляет конкурента прямо из строки, без перехода в другой раздел.
   */
  competitorCellHtml(r) {
    const list = ((this.rstate.competitors || {})[String(r.nmID)] || []).filter((c) => c.enabled !== false);
    const best = r.context && r.context.competitor ? r.context.competitor : null;
    const price = U.num(r.context && r.context.competitorPrice);
    /**
     * Набор колонок как в INDEEPA: «SKU конкурента, Остаток, Цена с СПП, Цена с кошельком».
     * Цену конкурента приводим к нашей системе координат: WB показывает покупателю цену
     * с СПП, поэтому «цена с СПП» = цена конкурента / (1 − СПП/100), а «с кошельком» —
     * additionally с учётом скидки WB-кошелька. По этим цифрам и считают отстройку.
     */
    const spp = U.num(this.sppOf(r));
    const wallet = U.num(((this.rstate.config || {}).priceEdit || {}).walletPct);
    const withSpp = (v) => (spp > 0 && v > 0 ? Math.round((v / Math.max(0.01, 1 - spp / 100)) * 100) / 100 : v);
    const withWallet = (v) => (v > 0 ? Math.round((withSpp(v) / Math.max(0.01, 1 - wallet / 100)) * 100) / 100 : v);

    const head = price
      ? `<b>${U.money(price)}</b><div class="tiny muted trunc">${U.esc(best ? (best.name || best.id) : '')}</div>`
      : '<span class="muted tiny">конкурентов нет</span>';
    const rest = list.length
      ? list.slice(0, 3).map((c) => `<div class="tiny muted" style="margin-top:2px">
          ${U.esc(c.sku ? 'SKU ' + c.sku : (c.name || 'конкурент'))} · ост. ${U.fmt(U.num(c.stock, 0))}<br>
          цена ${U.money(c.price)} · с СПП ${U.money(withSpp(U.num(c.price)))} · Цена WB-кошелька (с кошельком) ${U.money(withWallet(U.num(c.price)))}
        </div>`).join('')
      : '';
    return `${head}${rest}<button class="btn btn-xs btn-ghost rp-comp-add" data-nm="${r.nmID}" style="margin-top:3px">+ конкурент</button>`;
  },

  /**
   * Отстройка от конкурента — как в INDEEPA: тип цены конкурента, тип и величина отстройки,
   * «учитывать SKU» (следить за конкретным конкурентом, а не за минимальным).
   * Значения пишутся в личные настройки товара (itemConfigs) и сразу пересчитывают цену.
   */
  offsetCellHtml(r) {
    const cfg = this.rowConfig(r.nmID);
    const mode = cfg.competitorMode || 'withSpp';
    const offMode = cfg.competitorOffsetMode === 'rub' ? 'rub' : 'pct';
    const list = ((this.rstate.competitors || {})[String(r.nmID)] || []).filter((c) => c.enabled !== false);
    const opt = (v, label) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${label}</option>`;
    return `
      <select class="rp-off-mode" data-nm="${r.nmID}" style="width:150px" title="Тип цены конкурента, от которой считаем отстройку">
        ${opt('plain', 'Классика · Цена как есть')}
        ${opt('withSpp', 'Комфорт · С учётом СПП')}
        ${opt('withWallet', 'СПП + кошелёк (карта)')}
      </select>
      <div class="row" style="gap:4px;margin-top:3px;align-items:center">
        <input type="number" step="${offMode === 'rub' ? '10' : '0.5'}" class="num rp-off-val" data-nm="${r.nmID}" style="width:74px"
          value="${offMode === 'rub' ? U.num(cfg.competitorOffsetRub) : U.num(cfg.competitorOffsetPct)}"
          title="Отстройка от цены конкурента ${offMode === 'rub' ? 'в рублях' : 'в процентах'}" />
        <select class="rp-off-type" data-nm="${r.nmID}" style="width:56px" title="Тип отстройки: процентом или рублями">
          <option value="pct" ${offMode === 'pct' ? 'selected' : ''}>%</option>
          <option value="rub" ${offMode === 'rub' ? 'selected' : ''}>₽</option>
        </select>
      </div>
      <select class="rp-off-logic" data-nm="${r.nmID}" style="width:150px" title="Логика цены конкурента">
        <option value="min" ${!cfg.competitorId ? 'selected' : ''}>Минимальная цена</option>
        <option value="sku" ${cfg.competitorId ? 'selected' : ''} ${!list.length ? 'disabled' : ''}>По выбранному SKU</option>
      </select>
      ${list.length ? `<label class="checkline tiny"><input type="checkbox" class="rp-use-sku" data-nm="${r.nmID}" ${cfg.competitorId ? 'checked' : ''} /> Учитывать SKU</label><select class="rp-off-sku" data-nm="${r.nmID}" style="width:150px;margin-top:3px" title="Учитывать конкретный SKU конкурента">
          <option value="">Минимальная цена</option>
          ${list.map((c) => `<option value="${U.esc(String(c.id))}" ${String(cfg.competitorId || '') === String(c.id) ? 'selected' : ''}>${U.esc(c.name || c.id)}</option>`).join('')}
        </select>` : '<div class="tiny muted" style="margin-top:3px">SKU не заданы</div>'}`;
  },

  /**
   * Сохранить личные параметры товара и пересчитать цены.
   * Используется всеми контролами в строке (стратегия, пол, отстройка от конкурента),
   * чтобы логика «сохранили → пересчитали → показали предложение» была в одном месте.
   */
  /**
   * Правки в таблице копятся и сохраняются пачкой — как «Отменить / Сохранить» в репрайсере
   * INDEEPA. Раньше каждое изменение ячейки писало настройки и запускало ПОЛНЫЙ пересчёт
   * по всем товарам: на 200+ позициях правка пяти строк означала пять пересчётов подряд.
   *
   * pendingEdits: nmID → { config: {…поля itemConfigs…}, cost: {…поля costs…} }
   */
  pendingEdits: new Map(),

  rowConfig(nmID) {
    return Object.assign({}, (this.rstate.itemConfigs || {})[String(nmID)] || {},
      (this.pendingEdits.get(String(nmID)) || {}).config || {});
  },

  /** Импорт только копит изменения: запись и пересчёт — по кнопке сохранения. */
  importParameters(text) {
    const rows = U.parseCsv(text);
    const known = new Set((this.results || []).map((r) => String(r.nmID)));
    let count = 0;
    rows.forEach((row) => {
      const nm = String(row['нм-код'] || row.nmID || '').trim();
      if (!known.has(nm)) return;
      const patch = {};
      const strategy = row['Стратегия'] || row.strategy;
      const entry = (this.rstate.strategies || []).find((s) => s.id === strategy || s.name === strategy);
      if (entry) patch.strategy = entry.id;
      [['Минимальная цена', 'minPrice'], ['Минимальный порог', 'minPrice'],
        ['Базовая цена', 'basePriceTarget'], ['Базовая цена (порог)', 'basePriceTarget']].forEach(([key, field]) => {
        if (row[key] !== undefined && row[key] !== '') {
          const value = Number(String(row[key]).replace(/\s/g, '').replace(',', '.'));
          if (Number.isFinite(value) && value > 0) patch[field] = value;
        }
      });
      if (Object.keys(patch).length) { this.stageEdit(nm, 'config', patch); count++; }
    });
    this.renderResults();
    App.toast(count ? `Импортировано в несохранённые правки: ${count} строк` : 'Подходящих строк не найдено', count ? 'ok' : 'warn');
    return count;
  },

  /** Положить правку в очередь (без записи и без пересчёта). */
  stageEdit(nmID, kind, patch) {
    const nm = String(nmID);
    const rec = this.pendingEdits.get(nm) || { config: {}, cost: {} };
    Object.assign(rec[kind] || (rec[kind] = {}), patch || {});
    this.pendingEdits.set(nm, rec);
    this.markDirtyRows();
    this.drawEditBar();
  },

  /** Подсветить строки с несохранёнными правками. */
  markDirtyRows() {
    const host = this.container;
    if (!host) return;
    host.querySelectorAll('#rp-grid tbody tr, #st-grid tbody tr').forEach((tr) => {
      const el = tr.querySelector('[data-dirty-nm]');
      const nm = el ? el.getAttribute('data-dirty-nm') : null;
      tr.classList.toggle('row-dirty', !!(nm && this.pendingEdits.has(String(nm))));
    });
  },

  /** Панель «Несохранённых изменений: N» с кнопками Сохранить / Отменить. */
  drawEditBar() {
    const host = this.container;
    if (!host) return;
    let bar = host.querySelector('#rp-editbar');
    const n = this.pendingEdits.size;
    if (!n) { if (bar) bar.style.display = 'none'; return; }
    if (!bar) {
      bar = U.el('<div class="bulkbar" id="rp-editbar"></div>');
      const grid = host.querySelector('#rp-grid') || host.querySelector('#st-grid');
      if (grid && grid.parentNode) grid.parentNode.insertBefore(bar, grid);
      else host.appendChild(bar);
    }
    bar.style.display = '';
    bar.innerHTML = `
      <div class="fld"><span>Несохранённых изменений</span><b style="font-size:16px">${n}</b></div>
      <span class="hint">Правки в строках копятся и применяются одним пересчётом — так быстрее на большом списке.</span>
      <div class="grow"></div>
      <button class="btn btn-ghost" id="rp-edits-cancel">Отменить</button>
      <button class="btn btn-primary" id="rp-edits-save">Сохранить</button>`;
    bar.querySelector('#rp-edits-cancel').onclick = () => this.discardEdits();
    bar.querySelector('#rp-edits-save').onclick = (e) => this.commitEdits(e.target);
  },

  /** Отменить все несохранённые правки и вернуть значения из хранилища. */
  discardEdits() {
    const n = this.pendingEdits.size;
    this.pendingEdits.clear();
    this.drawEditBar();
    if (this.tab === 'strategies') this.renderStrategies();
    else this.renderResults();
    App.toast(n ? 'Отменено изменений: ' + n : 'Нет несохранённых изменений', 'ok', 3500);
  },

  /** Сохранить пачку правок: одна запись настроек, одна запись расходов, один пересчёт. */
  async commitEdits(btn) {
    const edits = Array.from(this.pendingEdits.entries());
    if (!edits.length) { if (btn) App.toast('Нет несохранённых изменений', 'warn'); return true; }
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняем…'; }
    try {
      const cfgPatch = {};
      const costPatch = {};
      const configs = Object.assign({}, this.rstate.itemConfigs || {});
      edits.forEach(([nm, rec]) => {
        if (rec.config && Object.keys(rec.config).length) {
          const cur = Object.assign({}, configs[nm] || {}, rec.config);
          // пустые значения убираем: товар должен жить по общим настройкам, а не по null
          Object.keys(cur).forEach((k) => { if (cur[k] === null || cur[k] === '' || cur[k] === undefined) delete cur[k]; });
          if (!Object.keys(cur).length) { delete configs[nm]; cfgPatch[nm] = null; }
          else { configs[nm] = cur; cfgPatch[nm] = cur; }
        }
        if (rec.cost && Object.keys(rec.cost).length) {
          const curCosts = Object.assign({}, (S.state.costs || {})[nm] || {}, rec.cost);
          costPatch[nm] = curCosts;
        }
      });

      if (Object.keys(costPatch).length) { await S.saveCosts(costPatch); S.invalidate(); }
      if (Object.keys(cfgPatch).length) await API.invoke('repricer:item-configs:save', { items: cfgPatch });

      this.rstate.itemConfigs = configs;
      this.pendingEdits.clear();
      this.drawEditBar();

      App.toast('Сохранено товаров: ' + edits.length + ' — пересчитываем цены…', 'ok', 4000);
      const res = await this.calculate({ full: true });
      this.results = res.results || [];
      this.summary = res.summary;
      await this.loadState();
      if (this.tab === 'strategies') this.renderStrategies();
      else { this.drawSummary(); this.renderResults(); this.drawTiles(); }
      await this.drawProposal();
      return true;
    } catch (e) {
      App.toast(e.message, 'err', 9000);
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
      return false;
    }
  },

  /** Сохранить параметры одного товара сразу (вне пакетного режима). */
  async saveItemConfig(nmID, patch) {
    const nm = String(nmID);
    const configs = Object.assign({}, this.rstate.itemConfigs || {});
    const cur = Object.assign({}, configs[nm] || {}, patch || {});
    // чистим пустые значения: товар должен жить по общим настройкам, а не по null.
    // Ноль при этом осмыслен (отстройка 0% = «цена в цену с конкурентом») — его оставляем.
    Object.keys(cur).forEach((k) => {
      if (cur[k] === null || cur[k] === '' || cur[k] === undefined) delete cur[k];
    });
    const empty = !Object.keys(cur).length;
    if (empty) delete configs[nm]; else configs[nm] = cur;
    try {
      await API.invoke('repricer:item-configs:save', { items: { [nm]: empty ? null : cur } });
      this.rstate.itemConfigs = configs;
      App.toast('Параметры товара сохранены — пересчитываем…', 'ok', 3500);
      const res = await this.calculate({ full: true });
      this.results = res.results || [];
      this.summary = res.summary;
      this.drawSummary();
      this.renderResults();
      this.drawTiles();
      await this.drawProposal();
    } catch (e) {
      App.toast(e.message, 'err', 8000);
    }
  },

  /** Быстрое добавление конкурента из строки таблицы. */
  quickAddCompetitor(nmID) {
    const nm = Number(nmID);
    const body = U.el('div');
    body.innerHTML = `
      <div class="alert info">WB API цены конкурентов не отдаёт — список ведётся вручную.
        Цена конкурента участвует в стратегии «Конкурентный приоритет» и в отстройке.</div>
      <div class="grid g2" style="gap:10px;margin-top:10px">
        <label class="field">Название / продавец<input id="qc-name" placeholder="Например: ИП Иванов" /></label>
        <label class="field">SKU конкурента (нм-код WB)<input id="qc-sku" placeholder="например 148004135" /></label>
        <label class="field">Цена, ₽<input type="number" step="10" class="num" id="qc-price" /></label>
        <label class="field">Остаток, шт<input type="number" step="1" class="num" id="qc-stock" value="1" /></label>
      </div>`;
    UI.modal({
      title: 'Конкурент по товару ' + nm,
      size: 'sm',
      content: body,
      buttons: [
        { label: 'Отмена', class: 'btn-ghost' },
        { label: 'Добавить', class: 'btn-primary', onClick: async () => {
            const price = U.num(body.querySelector('#qc-price').value);
            if (!(price > 0)) { App.toast('Укажите цену конкурента', 'warn'); return false; }
            const items = Object.assign({}, this.rstate.competitors || {});
            const list = Array.isArray(items[String(nm)]) ? items[String(nm)].slice() : [];
            list.push({
              id: nm + '-c' + (list.length + 1) + '-' + (Date.now() % 10000),
              name: String(body.querySelector('#qc-name').value || '').trim() ||
                ('SKU ' + (String(body.querySelector('#qc-sku').value || '').trim() || (list.length + 1))),
              // SKU конкурента храним отдельно: по нему модуль наблюдения цен сможет
              // сам найти карточку на витрине и обновить цену с остатком
              sku: String(body.querySelector('#qc-sku').value || '').trim(),
              price,
              stock: U.num(body.querySelector('#qc-stock').value, 1),
              enabled: true,
              updatedAt: new Date().toISOString()
            });
            items[String(nm)] = list;
            try {
              await API.invoke('repricer:competitors:save', { items: { [String(nm)]: list } });
              this.rstate.competitors = items;
              App.toast('Конкурент добавлен — пересчитываем цены', 'ok', 5000);
              const res = await this.calculate({ full: true });
              this.results = res.results || [];
              this.summary = res.summary;
              this.drawSummary();
              this.renderResults();
              await this.drawProposal();
            } catch (e) { App.toast(e.message, 'err', 8000); }
          } }
      ]
    });
  },

  /** Товары, которые нельзя отправлять из-за незаполненных данных. */
  invalidResults() {
    return (this.results || []).filter((r) => !r.error && this.rowErrors(r).length);
  },

  drawSummary() {
    const host = this.container.querySelector('#rp-summary');
    const s = this.summary;
    if (!host || !s) return;
    host.innerHTML = `
      <div class="grid g5" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Пересчитано товаров</span><span class="value">${U.fmt(s.total)}</span><span class="hint">ошибок: ${s.errors}</span></div>
        <div class="card stat"><span class="label">К отправке</span><span class="value">${U.fmt(s.toSend)}</span><span class="hint">↑ ${s.up} · ↓ ${s.down}</span></div>
        <div class="card stat"><span class="label">Δ прибыли за месяц</span><span class="value ${U.profitClass(s.profitDeltaMonth)}">${U.signed(Math.round(s.profitDeltaMonth))} ₽</span><span class="hint">прогноз по текущему темпу продаж</span></div>
        <div class="card stat"><span class="label">Δ выручки</span><span class="value ${U.profitClass(s.revenueDeltaPct)}">${U.signed(s.revenueDeltaPct, 1)}%</span><span class="hint">без учёта изменения спроса</span></div>
        <div class="card stat"><span class="label">Предупреждений</span><span class="value ${s.warnings ? 'warnc' : 'pos'}">${s.warnings}</span><span class="hint">шаг ограничен у ${s.limitedByStep}${s.liftedToFloor ? ', поднято до порога ' + s.liftedToFloor : ''}</span></div>
      </div>
      ${this.validationHtml()}`;
  },

  /** Плашка с товарами, которые не готовы к отправке (как «ОШИБКА: …» в строке INDEEPA). */
  validationHtml() {
    const bad = this.invalidResults();
    if (!bad.length) { this.setNoticeSource('validation', []); return ''; }
    const sample = bad.slice(0, 5).map((r) =>
      '<span class="mono tiny">' + U.esc(String(r.vendorCode || r.nmID)) + '</span>').join(', ');
    this.setNoticeSource('validation', [{ kind: 'danger', html: `<b>У ${U.fmt(bad.length)} товаров не заполнены данные — репрайсер не предложит их к отправке.</b>
      <div class="hint" style="margin-top:4px">Типичные причины: не задана себестоимость, нет порога минимальной цены,
        нет базовой цены. Заполните в строке (колонки «Стратегия» и «Пол / потолок») или массово во вкладке
        «Параметры товаров». Примеры: ${sample}${bad.length > 5 ? ' и ещё ' + U.fmt(bad.length - 5) : ''}.</div>` }]);
    return `<div class="alert danger" style="margin-bottom:12px">
      <b>У ${U.fmt(bad.length)} товаров не заполнены данные</b> — репрайсер не предложит их к отправке.
      <button type="button" class="btn btn-ghost btn-sm" data-open-notices>Подробнее в уведомлениях</button>
    </div>`;
  },

  filteredResults() {
    const f = this.itemFilter;
    let list = this.results;
    if (f.onlyChanges) list = list.filter((r) => r.needSend);
    if (f.onlyWarn) list = list.filter((r) => (r.warnings || []).length);
    // сегментированный фильтр: один признак за раз
    const drafts = S.state.priceDrafts || {};
    if (f.seg && f.seg !== 'all') {
      const test = {
        tosend: (r) => !!r.needSend || !!drafts[String(r.nmID)],
        mine: (r) => !!drafts[String(r.nmID)],
        errors: (r) => this.rowErrors(r).length > 0,
        loss: (r) => U.num(r.proposed ? r.proposed.profit : (r.current || {}).profit) < 0,
        warn: (r) => (r.warnings || []).length > 0
      }[f.seg];
      if (test) list = list.filter(test);
    }
    if (f.strategy) list = list.filter((r) => r.strategy === f.strategy);
    // клик по сводной плитке — это фильтр (те же признаки, что и в «Цены и скидки»)
    if (f.tile) {
      const rowsById = new Map(S.getRows().map((r) => [String(r.nmID), r]));
      const drafts = S.state.priceDrafts || {};
      const test = {
        revenue30: (r) => U.num((rowsById.get(String(r.nmID)) || {}).revenue30) > 0,
        profit30: (r) => U.num((rowsById.get(String(r.nmID)) || {}).profit30) > 0,
        loss: (r) => U.num(r.current && r.current.profit) < 0,
        low: (r) => U.num(r.current && r.current.profit) >= 0 &&
          U.num(r.current && r.current.marginPct) < U.num(S.state.settings.minMarginPctAlert),
        nocogs: (r) => !U.num((rowsById.get(String(r.nmID)) || {}).costPrice),
        badturn: (r) => { const x = rowsById.get(String(r.nmID)) || {}; return x.isBadTurnover || (U.num(x.turnoverDays) > 90 && U.num(x.stock) > 0); },
        tosend: (r) => !!r.needSend,
        draft: (r) => !!drafts[String(r.nmID)]
      }[f.tile];
      if (test) list = list.filter(test);
    }
    // метка товара (колонка «Метка») — свой фильтр: по ней удобно вести группы товаров
    if (f.tag) {
      const t = String(f.tag).toLowerCase();
      list = list.filter((r) => String(this.rowConfig(r.nmID).tag || r.tag || '').toLowerCase() === t);
    }
    // «не отправлять» — отдельный признак: строки, которые остаются только для контроля
    if (f.seg === 'nosend') list = list.filter((r) => r.allowSend === false);
    const q = (f.q || '').toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const card = (this.cardsByNm || new Map()).get(String(r.nmID)) || {};
        return String(r.nmID).includes(q) ||
          String(r.vendorCode || '').toLowerCase().includes(q) ||
          String(r.title || '').toLowerCase().includes(q) ||
          String(this.rowConfig(r.nmID).tag || r.tag || '').toLowerCase().includes(q) ||
          String(r.barcode || card.barcode || '').toLowerCase().includes(q);
      });
    }
    return GridLayout.orderedRows(list, 'repricer-products');
  },

  renderResults() {
    if (this._gridLayout) { this._gridLayout.destroy(); this._gridLayout = null; }
    const host = this.container.querySelector('#rp-grid');
    if (!host) return;
    const list = this.filteredResults().map((r) => r.error ? Object.assign({
      title: r.title || r.vendorCode || String(r.nmID), current: {}, proposed: {},
      corridor: {}, context: {}, delta: {}, warnings: []
    }, r) : r);
    this.itemsByNm = new Map((S.state.items || []).map((it) => [String(it.nmID), it]));
    // карточки (контент-API) нужны для баркода и объёма товара — без отдельного запроса к WB
    this.cardsByNm = new Map((S.state.cards || []).map((c) => [String(c.nmID), c]));
    const pageRows = this.pageOf(list);
    const st = S.state;
    this.selection = this.selection || new Set();
    host.innerHTML = '';

    const grid = UI.table({
      // Колонки связываются со справочником по устойчивому colId, не по позиции.
      columns: this.filterCols([
        // ══ блок «Артикул» ══
        { colId: 'item', title: 'Товар', cls: 'rp-product', render: (r) => this.productCellHtml(r) },
        { colId: 'vendorCode', title: 'Артикул продавца', render: (r) => {
            const item = this.itemsByNm.get(String(r.nmID)) || {};
            return `<div class="tiny rp-wrap"><b>${U.esc(r.vendorCode || item.vendorCode || '—')}</b> · нм-код ${r.nmID}${item.brand ? ' · ' + U.esc(item.brand) : ''}</div>`;
          } },
        { colId: 'barcode', title: 'Баркод', render: (r) => this.barcodeCellHtml(r) },
        { colId: 'allowSend', title: 'Отправка в WB', render: (r) => this.sendControlHtml(r) },
        { colId: 'tag', title: 'Метка', render: (r) => this.tagControlHtml(r) },
        // ══ блок «Инфо о товаре» ══
        { colId: 'info', title: 'Инфо о товаре', render: (r) => this.itemInfoCellHtml(r) },
        { colId: 'stock', title: 'Остаток / оборач.', render: (r) => this.stockCellHtml(r) },
        { colId: 'plan', title: 'План продаж', num: true, render: (r) => this.planCellHtml(r) },
        // ══ блок «Текущая цена» ══
        { colId: 'priceNow', title: 'Цена на МП', render: (r) => this.currentPriceBlock(r) },
        { colId: 'myPrice', title: 'Моя цена', num: true, render: (r) => this.myPriceCellHtml(r) },
        { colId: 'buyerNow', title: 'Цена покупателю сейчас', num: true, render: (r) => r.current.buyerPrice
            ? `${U.money(r.current.buyerPrice)}<div class="tiny muted">с учётом СПП${this.walletNote(r, 'now')}</div>`
            : '<span class="muted tiny">нет данных</span>' },
        { colId: 'value', title: 'Выгодность', render: (r) => {
            const v = this.valueStatus(r);
            return `${UI.badge(v.label, v.kind)}<div class="tiny muted" title="${U.esc(v.hint)}">${U.esc(v.hint)}</div>`;
          } },
        // ══ блок «Новая цена» ══
        { colId: 'priceNext', title: 'Новая цена', render: (r) => this.nextPriceBlock(r) },
        { colId: 'buyerNext', title: 'Цена покупателю станет', num: true, render: (r) => r.proposed.buyerPrice
            ? `<b>${U.money(r.proposed.buyerPrice)}</b><div class="tiny muted">с учётом СПП${this.walletNote(r, 'next')}</div>`
            : '<span class="muted tiny">—</span>' },
        { colId: 'sizes', title: 'Размеры', render: (r) => this.sizesCellHtml(r) },
        { colId: 'delta', title: 'Изменение', num: true, render: (r) => `<span class="${r.delta.abs > 0 ? 'pos' : (r.delta.abs < 0 ? 'neg' : 'muted')}">${U.signed(r.delta.abs)} ₽<br>${U.signed(r.delta.pct, 1)}%</span>` },
        { colId: 'strategy', title: 'Стратегия', render: (r) => {
            const cfg = this.rowConfig(r.nmID);
            const cur = cfg.strategy || '';
            return `<select class="rp-strategy" data-nm="${r.nmID}" style="width:170px">
                <option value="">как в общих настройках</option>
                ${(this.rstate.strategies || []).map((s) => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
              </select>
              <div class="tiny muted" style="margin-top:2px">сейчас: ${U.esc(r.strategyTitle || r.strategy)}</div>
              ${this.rowErrors(r).length ? `<div class="rp-validation neg tiny">ОШИБКА: ${U.esc(this.rowErrors(r).join('; '))}</div>` : ''}`;
          } },
        { colId: 'status', title: 'Статус', render: (r) => {
            const b = [];
            if (r.allowSend === false) b.push(UI.badge('отправка выключена', 'danger'));
            if (r.quarantine) b.push(UI.badge('карантин', 'danger'));
            if (r.limitedBy === 'step') b.push(UI.badge('лимит шага', 'warn'));
            if (r.limitedBy === 'day') b.push(UI.badge('суточный лимит', 'warn'));
            if ((r.warnings || []).length) b.push(`<span title="${U.esc(r.warnings.join('\n'))}" aria-label="Предупреждения">⚠ ${UI.badge(r.warnings.length + ' пред.', 'warn')}</span>`);
            if (!b.length) b.push(r.needSend ? UI.badge('к отправке', 'ok') : UI.badge('без изменений'));
            if (r.limitedBy === 'below-min') b.push(UI.badge('поднят до порога', 'info'));
            return b.join(' ');
          } },
        { colId: 'why', title: '', render: (r) => `<button class="btn btn-xs btn-ghost" data-why="${r.nmID}" data-dirty-nm="${r.nmID}">почему</button>` },
        // ══ блок «Мин цена (в акции)» ══
        { colId: 'floor', title: 'Мин цена / базовая', num: true, render: (r) => {
            const cfg = this.rowConfig(r.nmID);
            return `<input type="number" step="10" class="num rp-minprice" data-nm="${r.nmID}" value="${cfg.minPrice || ''}"
                placeholder="${U.num(r.corridor.min)}" style="width:96px" title="Минимальная цена: ниже неё репрайсер не опустится" />
              <div><input type="number" step="10" min="0" class="num rp-baseprice" data-nm="${r.nmID}" value="${cfg.basePriceTarget || ''}" placeholder="${U.num(r.current.basePrice)}" style="width:96px" title="Базовая цена — верхний порог" /></div>
              <div class="tiny muted">Мин цена / Базовая цена<br>${U.money(r.corridor.min)} … ${U.money(r.corridor.max)}</div>`;
          } },
        { colId: 'promoMin', title: 'Мин цена в акции', num: true, render: (r) => this.promoMinCellHtml(r) },
        { colId: 'promos', title: 'Акции', render: (r) => this.promoCellHtml(r) },
        // ══ блок «Цена (вне акции)» ══
        { colId: 'restore', title: 'Цена вне акции', num: true, render: (r) => this.restoreCellHtml(r) },
        { colId: 'corridor', title: 'Коридор', num: true, render: (r) => `<span class="tiny muted">${U.money(r.corridor.min)} … ${U.money(r.corridor.max)}</span>` },
        // ══ блок «Себестоимость и экономика» ══
        { colId: 'cost', title: 'Себестоимость', num: true, render: (r) => this.costCellHtml(r) },
        { colId: 'costDetail', title: 'Расходы на единицу', num: true, render: (r) => this.costDetailCellHtml(r) },
        { colId: 'breakEven', title: 'Безубыточность', num: true, render: (r) => this.breakEvenCellHtml(r) },
        { colId: 'profit', title: 'Прибыль/шт', num: true, render: (r) => `<span class="muted">${U.money(r.current.profit)}</span> → <b class="${U.profitClass(r.proposed.profit)}">${U.money(r.proposed.profit)}</b>` },
        { colId: 'margin', title: 'Маржа', num: true, render: (r) => `<span class="muted">${U.pct(r.current.marginPct)}</span> → <b class="${U.profitClass(r.proposed.marginPct)}">${U.pct(r.proposed.marginPct)}</b>` },
        { colId: 'profitMonth', title: 'Δ прибыли/мес', num: true, render: (r) => `<span class="${U.profitClass(r.delta.profitMonth)}">${U.signed(Math.round(r.delta.profitMonth))} ₽</span>` },
        // ══ блок «Конкуренты» ══
        { colId: 'competitor', title: 'Конкурент', num: true, render: (r) => this.competitorCellHtml(r) },
        { colId: 'offset', title: 'Отстройка от конкурента', render: (r) => this.offsetCellHtml(r) },
        { colId: 'other', title: 'Прочие расходы', render: (r) => this.otherCostsBlock(r) },
        { colId: 'abc', title: 'ABC анализ', render: (r) => this.abcBlock(r) }
      ]),
      // верхний ряд шапки — блоки колонок (задание D)
      groupTitles: this.GROUP_TITLES,
      rows: pageRows,
      tall: true,
      select: {
        get: (r) => this.selection.has(r.nmID),
        set: (r, v) => { if (v) this.selection.add(r.nmID); else this.selection.delete(r.nmID); },
        toggleAll: (l, v) => l.forEach((r) => { if (v) this.selection.add(r.nmID); else this.selection.delete(r.nmID); })
      },
      onSelect: () => this.renderBulk(),
      empty: 'Нет строк под фильтр. Снимите «только с изменением цены» или выполните пересчёт.',
      footer: (c) => {
        if (c.title === 'Товар') return `<b>${list.length}</b> строк`;
        if (c.title === 'Δ прибыли/мес') return `<span class="${U.profitClass(U.sum(list, (r) => r.delta.profitMonth))}">${U.signed(Math.round(U.sum(list, (r) => r.delta.profitMonth)))} ₽</span>`;
        if (c.title === 'Новая цена') return '';
        return '';
      }
    });
    const tbl = grid.el.querySelector('table');
    if (this.density === 'compact') tbl.classList.add('dense');
    // первый и второй столбцы (чекбокс и товар) закреплены: таблица широкая,
    // и при горизонтальной прокрутке должно быть видно, к какому товару относится строка
    tbl.classList.add('rp-sticky-first');
    host.appendChild(grid.el);
    this._gridLayout = GridLayout.attach({ id: 'repricer-products', table: tbl, columns: this._renderColumns,
      rows: pageRows, allRowIds: list.map((r) => String(r.nmID)), onChange: () => this.renderResults() });

    this.drawPager(host);
    this.drawEditBar();
    this.markDirtyRows();
    host.querySelectorAll('.rp-use-sku').forEach((cb) => {
      const sku = host.querySelector('.rp-off-sku[data-nm="' + cb.dataset.nm + '"]');
      cb.checked = !!(sku && sku.value);
    });

    // сколько товаров под текущим сегментом фильтра.
    // Счётчик лежит РЯДОМ с таблицей (в панели фильтров), а не внутри #rp-grid,
    // поэтому ищем от контейнера раздела.
    const segCount = this.container.querySelector('#rp-seg-count');
    if (segCount) {
      const labels = {
        all: 'все товары', tosend: 'к отправке', mine: 'со своей ценой',
        errors: 'с незаполненными данными', loss: 'убыточные', warn: 'с предупреждениями',
        nosend: 'с выключенной отправкой'
      };
      segCount.textContent = U.fmt(list.length) + ' ' + (labels[this.itemFilter.seg] || 'товаров') +
        (this.density === 'compact' ? ' · плотный режим' : '');
    }

    // Закрепление и групповые заголовки управляются только GridLayout.
    host.querySelectorAll('[data-item-card]').forEach((button) => { button.onclick = (event) => { event.stopPropagation(); Views.itemcard.open(Number(button.dataset.itemCard)); }; });

    host.querySelectorAll('[data-why]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const r = this.results.find((x) => String(x.nmID) === b.dataset.why);
        if (r) this.showWhy(r);
      };
    });
    host.querySelectorAll('tbody tr').forEach((tr, i) => {
      const r = pageRows[i];
      // двойной клик — карточка товара со всеми разделами (конкуренты, комиссии, акции, история)
      if (r) tr.ondblclick = (e) => { if (!e.target.closest('input, select, button')) Views.itemcard.open(r.nmID); };
    });

    /**
     * Стратегия, минимальная цена и отстройка от конкурента правятся в строке.
     * Изменения КОПЯТСЯ и применяются одной кнопкой «Сохранить» (как «Отменить/Сохранить»
     * в INDEEPA): один пересчёт на пачку правок вместо пересчёта на каждую ячейку.
     */
    host.querySelectorAll('.rp-strategy, .rp-minprice, .rp-baseprice, .rp-plan, .rp-off-mode, .rp-off-val, .rp-off-type, .rp-off-sku, .rp-use-sku, .rp-off-logic, .rp-allowsend, .rp-tag').forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        const nm = inp.getAttribute('data-nm');
        const patch = {};
        if (inp.classList.contains('rp-strategy')) patch.strategy = inp.value || null;
        // «Отправка в WB»: false обязан дойти до настроек товара, поэтому не чистится как пустое значение
        else if (inp.classList.contains('rp-allowsend')) {
          patch.allowSend = !!inp.checked;
          const label = inp.closest('label').querySelector('span');
          if (label) { label.className = inp.checked ? 'pos' : 'neg'; label.textContent = inp.checked ? 'Отправка в WB' : 'Не отправлять'; }
        }
        else if (inp.classList.contains('rp-tag')) patch.tag = String(inp.value || '').trim() || null;
        else if (inp.classList.contains('rp-minprice')) {
          const v = U.num(inp.value);
          patch.minPrice = v > 0 ? v : null;
        } else if (inp.classList.contains('rp-plan')) {
          patch.planQtyMonth = Math.max(0, Math.round(U.num(inp.value)));
        } else if (inp.classList.contains('rp-baseprice')) {
          patch.basePriceTarget = U.num(inp.value) > 0 ? U.num(inp.value) : null;
        } else if (inp.classList.contains('rp-off-mode')) patch.competitorMode = inp.value || 'withSpp';
        else if (inp.classList.contains('rp-off-val')) {
          // одно поле на два режима: значение пишется в % или в ₽ по выбранному типу отстройки
          const typeEl = host.querySelector('.rp-off-type[data-nm="' + nm + '"]');
          const isRub = typeEl ? typeEl.value === 'rub' : false;
          patch.competitorOffsetMode = isRub ? 'rub' : 'pct';
          if (isRub) patch.competitorOffsetRub = U.num(inp.value);
          else patch.competitorOffsetPct = U.num(inp.value);
        } else if (inp.classList.contains('rp-off-type')) {
          const valEl = host.querySelector('.rp-off-val[data-nm="' + nm + '"]');
          patch.competitorOffsetMode = inp.value === 'rub' ? 'rub' : 'pct';
          // при переключении типа переносим текущее значение, чтобы оно не потерялось
          if (valEl) {
            if (patch.competitorOffsetMode === 'rub') patch.competitorOffsetRub = U.num(valEl.value);
            else patch.competitorOffsetPct = U.num(valEl.value);
          }
        } else if (inp.classList.contains('rp-off-sku')) patch.competitorId = inp.value || null;
        else if (inp.classList.contains('rp-use-sku') || inp.classList.contains('rp-off-logic')) {
          const sku = host.querySelector('.rp-off-sku[data-nm="' + nm + '"]');
          patch.competitorId = (inp.classList.contains('rp-use-sku') ? inp.checked : inp.value === 'sku') && sku ? (sku.value || (sku.options[1] && sku.options[1].value)) : null;
        }
        const previous = patch.strategy ? this.pendingEdits.get(String(nm)) : null;
        this.stageEdit(nm, 'config', patch);
        if (patch.strategy) this.openStrategyEditor(nm, patch.strategy, { previousPending: previous || null });
        if (Object.prototype.hasOwnProperty.call(patch, 'competitorId')) {
          const tr = inp.closest('tr');
          const cb = tr.querySelector('.rp-use-sku');
          const sku = tr.querySelector('.rp-off-sku');
          const logic = tr.querySelector('.rp-off-logic');
          if (cb) cb.checked = !!patch.competitorId;
          if (sku) sku.value = patch.competitorId || '';
          if (logic) logic.value = patch.competitorId ? 'sku' : 'min';
        }
      };
    });
    /**
     * Себестоимость и её валюта правятся в строке (задание D). Значение в валюте
     * закупки сервис пересчитает в рубли по курсу из настроек; курс правится
     * на вкладке «Параметры» — там же показываем подсказку, если курса нет.
     */
    host.querySelectorAll('.rp-cost, .rp-costcur').forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        const patch = {};
        if (inp.classList.contains('rp-cost')) patch.costPriceRub = inp.value === '' ? null : Math.max(0, U.num(inp.value));
        else patch.currency = String(inp.value || 'RUB').toUpperCase();
        this.stageEdit(inp.dataset.nm, 'cost', patch);
        // подпись «= N ₽ по курсу» обновляем сразу, не дожидаясь сохранения и пересчёта:
        // реагируем и на смену валюты, и на правку самого числа
        {
          const cell = inp.closest('td');
          if (!cell) return;
          const nm = String(inp.dataset.nm);
          const pend = (this.pendingEdits.get(nm) || {}).cost || {};
          const curEl = cell.querySelector('.rp-costcur');
          const cur = String((curEl && curEl.value) || 'RUB').trim().toUpperCase();
          const rate = this.costRate(cur);
          const numEl = cell.querySelector('.rp-cost');
          const entered = numEl ? U.num(numEl.value) : U.num(pend.costPriceRub);
          const rub = cur === 'RUB' ? entered : (rate > 0 ? Math.round(entered * rate * 100) / 100 : 0);
          const hint = cell.querySelector('.rp-cost-hint');
          if (hint) {
            hint.className = 'tiny rp-cost-hint ' + (cur === 'RUB' || rate > 0 ? 'muted' : 'neg');
            hint.textContent = cur === 'RUB' ? ''
              : (rate > 0 ? '= ' + U.money(rub) + ' по курсу ' + U.num(rate) : 'не задан курс ' + cur);
          }
          const rubEl = cell.querySelector('.rp-cost-rub');
          if (rubEl) rubEl.textContent = U.money(rub);
        }
      };
    });

    // добавить конкурента прямо из строки — без перехода в другой раздел
    host.querySelectorAll('.rp-comp-add').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.quickAddCompetitor(Number(b.dataset.nm)); };
    });

    // открыть панель цен по размерам товара
    host.querySelectorAll('.rp-sizes-open').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const r = this.results.find((x) => String(x.nmID) === b.getAttribute('data-nm'));
        if (r) this.openSizesModal(r);
      };
    });

    this.renderBulk();
  },

  renderBulk() {
    const bulk = this.container.querySelector('#rp-bulk');
    const sendBtn = this.container.querySelector('#rp-send');
    const valid = new Set(this.results.filter((r) => !this.rowErrors(r).length).map((r) => String(r.nmID)));
    if (sendBtn) sendBtn.disabled = !this.proposal || this.proposal.phase !== 'proposed' || !(this.proposal.items || []).some((p) => valid.has(String(p.nmID)));
    if (!bulk) return;
    const n = this.selection ? this.selection.size : 0;
    bulk.style.display = n ? '' : 'none';
    if (!n) return;
    const strategies = (this.rstate && this.rstate.strategies) || [];
    bulk.innerHTML = `
      <div class="fld"><span>Выбрано товаров</span><b style="font-size:16px">${n}</b></div>
      <div class="fld"><span>Стратегия всем выбранным</span>
        <select id="rb-strategy" style="width:190px">
          <option value="">— не менять —</option>
          ${strategies.map((x) => `<option value="${x.id}">${U.esc(x.name)}</option>`).join('')}
        </select></div>
      <div class="fld"><span>Мин. цена, ₽</span>
        <input type="number" step="10" class="num" id="rb-minprice" style="width:110px" placeholder="— не менять —" /></div>
      <div class="fld"><span>Отправка в WB</span>
        <select id="rb-allowsend" style="width:150px" title="Флаг «Отправка в WB» сразу всем выбранным товарам">
          <option value="">— не менять —</option>
          <option value="1">включить</option>
          <option value="0">выключить</option>
        </select></div>
      <div class="fld"><span>Метка</span>
        <input type="text" id="rb-tag" style="width:130px" maxlength="24" placeholder="— не менять —" /></div>
      <button class="btn btn-sm" id="rb-apply-params">Применить параметры</button>
      <button class="btn btn-ghost btn-sm" id="rb-clear-params">Сбросить личные настройки</button>
      <div class="grow"></div>
      <button class="btn btn-ghost btn-sm" id="rb-none">Снять выделение</button>
      <button class="btn btn-ok" id="rb-send">Отправить выбранные в WB</button>
    `;
    bulk.querySelector('#rb-none').onclick = () => { this.selection.clear(); this.renderResults(); };
    bulk.querySelector('#rb-send').onclick = () => this.sendSelected(true);

    /**
     * Массовое назначение параметров: стратегия и минимальная цена сразу всем выбранным
     * строкам. Правки копятся в очереди и применяются одним пересчётом — так же,
     * как правка одной строки.
     */
    bulk.querySelector('#rb-apply-params').onclick = async (e) => {
      const btn = e.target;
      const strategy = bulk.querySelector('#rb-strategy').value;
      const minRaw = bulk.querySelector('#rb-minprice').value;
      const minPrice = minRaw === '' ? null : U.num(minRaw);
      const sendRaw = bulk.querySelector('#rb-allowsend').value;
      const tagRaw = bulk.querySelector('#rb-tag').value;
      const tagSet = tagRaw !== '';
      const tag = tagSet ? String(tagRaw).trim() : null;
      if (!strategy && !(minPrice > 0) && sendRaw === '' && !tagSet) {
        App.toast('Выберите стратегию, минимальную цену, режим отправки или метку', 'warn');
        return;
      }
      btn.disabled = true;
      const patch = {};
      if (strategy) patch.strategy = strategy;
      if (minPrice > 0) patch.minPrice = minPrice;
      // false обязан дойти до настроек товара: чистка пустых значений его не убирает
      if (sendRaw !== '') patch.allowSend = sendRaw === '1';
      if (tagSet) patch.tag = tag || null;
      this.selection.forEach((nmID) => this.stageEdit(nmID, 'config', patch));
      await this.commitEdits(btn);
      this.selection.clear();
      App.toast('Параметры назначены ' + n + ' товарам', 'ok', 5000);
    };

    bulk.querySelector('#rb-clear-params').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const items = {};
      this.selection.forEach((nmID) => { items[String(nmID)] = null; });
      try {
        await API.invoke('repricer:item-configs:save', { items });
        this.rstate = await API.invoke('repricer:state');
        await this.loadState();
        this.selection.clear();
        App.toast('Личные настройки сброшены у ' + Object.keys(items).length +
          ' товаров — работают общие правила', 'ok', 6000);
        const res = await this.calculate({ full: true });
        this.results = res.results || [];
        this.summary = res.summary;
        this.drawSummary();
        this.renderResults();
        await this.drawProposal();
      } catch (err) {
        App.toast(err.message, 'err', 8000);
        btn.disabled = false;
      }
    };
  },

  /** Подробный разбор: почему репрайсер предложил именно такую цену. */
  showWhy(r) {
    const body = U.el('div');
    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">
        ${UI.badge('нм-код ' + r.nmID)} ${UI.badge(r.vendorCode)} ${UI.badge('стратегия: ' + r.strategyTitle, 'accent')}
        ${r.needSend ? UI.badge('требуется отправка', 'ok') : UI.badge('цена не меняется')}
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>Цена</h3>
          ${UI.kv([
            ['Цена до скидки', `${U.money(r.current.basePrice)} → <b>${U.money(r.proposed.basePrice)}</b>`],
            ['Скидка продавца', `${U.pct(r.current.discount)} → <b>${U.pct(r.proposed.discount)}</b>`],
            ['Цена со скидкой (для WB)', `${U.money(r.current.sellerPrice)} → <b>${U.money(r.proposed.sellerPrice)}</b>`],
            ['Цена для покупателя', `${U.money(r.current.buyerPrice)} → <b>${U.money(r.proposed.buyerPrice)}</b>`],
            ['Изменение', `<span class="${U.profitClass(r.delta.abs)}">${U.signed(r.delta.abs)} ₽ (${U.signed(r.delta.pct, 1)}%)</span>`],
            ['Ценовой коридор', `${U.money(r.corridor.min)} … ${U.money(r.corridor.max)}`],
            ['Способ установки', r.proposed.priceMode === 'discount-only' ? 'только скидкой (базовая цена зафиксирована)'
              : r.proposed.priceMode === 'discount-rounded' ? 'скидкой, целым процентом'
              : r.proposed.priceMode === 'target-discount' ? 'под целевую скидку' : 'изменением цены до скидки']
          ])}
        </div>
        <div class="card">
          <h3>Экономика</h3>
          ${UI.kv([
            ['Прибыль с единицы', `${U.money(r.current.profit)} → <b class="${U.profitClass(r.proposed.profit)}">${U.money(r.proposed.profit)}</b>`],
            ['Маржинальность', `${U.pct(r.current.marginPct)} → <b class="${U.profitClass(r.proposed.marginPct)}">${U.pct(r.proposed.marginPct)}</b>`],
            ['Прогноз Δ прибыли/мес', `<b class="${U.profitClass(r.delta.profitMonth)}">${U.signed(Math.round(r.delta.profitMonth))} ₽</b>`],
            ['Режим расчёта маржи', r.context.marginMode === 'forpay' ? 'от суммы ForPay' : (r.context.marginMode === 'wallet' ? 'от цены с кошельком' : 'от цены со скидкой')],
            ['Остаток', U.fmt(r.context.stock) + ' шт' + (U.stockWarn(r.context.stock, r.context.turnoverDays, S.state.settings.stocksLowDays) ? ' ' + UI.badge('заканчивается', 'warn') : '')],
            ['Темп продаж', U.num(r.context.salesPerDay).toFixed(1) + ' шт/день'],
            ['Оборачиваемость', r.context.turnoverDays >= 999 ? '∞' : Math.round(r.context.turnoverDays) + ' дн'],
            ['В акции', r.context.inPromo ? 'да' + (r.context.promoPrice ? ', цена ' + U.money(r.context.promoPrice) : '') : 'нет']
          ])}
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <h3>Как получилась цена (слои расчёта)</h3>
        <table class="grid-table">
          <thead><tr><th>Слой</th><th>Правило</th><th class="num">Цена</th><th>Пояснение</th></tr></thead>
          <tbody>${(r.layers || []).map((l) => `<tr>
            <td>${UI.badge(l.layer, l.layer === 'ДЦО' ? 'warn' : 'accent')}</td>
            <td><b>${U.esc(l.name)}</b></td>
            <td class="num">${U.money(l.price)}</td>
            <td class="tiny muted" style="white-space:normal">${U.esc(l.note || '')}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="divider"></div>
        <h3>Пояснения</h3>
        <ul class="hint" style="margin:0;padding-left:18px;line-height:1.8">${(r.notes || []).map((n) => `<li>${U.esc(n)}</li>`).join('') || '<li>—</li>'}</ul>
        ${(r.warnings || []).length ? `<div class="alert warn" style="margin-top:10px"><b>Предупреждения:</b><br>${r.warnings.map((w) => U.esc(w)).join('<br>')}</div>` : ''}
      </div>
    `;
    UI.modal({ title: `Почему такая цена — ${r.title}`, content: body, size: 'md', buttons: [
      { label: 'Открыть в разделе «Цены»', class: 'btn-ghost', onClick: () => { S.state.filters.q = String(r.nmID); App.go('prices'); } },
      { label: 'Закрыть', class: 'btn-primary' }
    ] });
  },

  async sendSelected(onlySelected) {
    if (this.pendingEdits.size) return App.toast('Сохраните или отмените несохранённые параметры перед отправкой', 'warn');
    const rs = this.rstate;
    const proposal = await API.invoke('repricer:proposal');
    const byNm = new Map(this.results.map((r) => [String(r.nmID), r]));
    const list = (proposal.phase === 'proposed' ? proposal.items || [] : []).filter((p) => !p.sendState || p.sendState === 'ready').filter((p) => {
      const r = byNm.get(String(p.nmID));
      return r && !this.rowErrors(r).length && (!onlySelected || this.selection.has(r.nmID));
    }).map((p) => {
      const r = byNm.get(String(p.nmID));
      return Object.assign({}, r, {
        proposed: Object.assign({}, r.proposed, { basePrice: p.basePrice, discount: p.discount,
          sellerPrice: p.sellerPrice, profit: p.profitNext, marginPct: p.marginNext }),
        delta: Object.assign({}, r.delta, { abs: p.sellerPrice - p.currentSellerPrice,
          pct: p.deltaPct, profitMonth: p.deltaProfitMonth })
      });
    });
    if (!list.length) { App.toast('Нет товаров к отправке', 'warn'); return; }

    const warn = list.filter((r) => (r.warnings || []).length);
    const loss = list.filter((r) => r.proposed.profit < 0);
    // товары с режимом «не трогать размеры», у которых разные цены по размерам:
    // отправка цены товара сделает цену всех размеров одинаковой
    const sizeEqualize = list.filter((r) => {
      const cfg = this.rowConfig(r.nmID);
      if (this.sizeMode(r.nmID) !== 'none' || Math.round(r.proposed.basePrice) === Math.round(r.current.basePrice)) return false;
      const item = this.itemsByNm ? this.itemsByNm.get(String(r.nmID)) : null;
      const sizes = (item && Array.isArray(item.sizes)) ? item.sizes : [];
      const live = sizes.map((s) => U.num(s.price)).filter((p) => p > 0);
      return new Set(live.map((p) => Math.round(p * 100))).size > 1;
    });

    UI.confirmDialog(
      `Отправить ${list.length} цен в Wildberries`,
      `<div class="alert ${loss.length ? 'danger' : (warn.length ? 'warn' : 'info')}">
         Будет отправлено цен: <b>${list.length}</b>
         (${list.filter((r) => r.delta.abs > 0).length} вверх, ${list.filter((r) => r.delta.abs < 0).length} вниз).<br>
         ${warn.length ? `Предупреждений: <b>${warn.length}</b>.<br>` : ''}
         ${sizeEqualize.length ? `<b class="warnc">${sizeEqualize.length}</b> товаров с разными ценами по размерам — отправка цены товара сделает их одинаковыми.<br>` : ''}
         ${loss.length ? `<b class="neg">${loss.length}</b> товаров с отрицательной прибылью после изменения.<br>` : ''}
         Прогноз изменения прибыли: <b class="${U.profitClass(U.sum(list, (r) => r.delta.profitMonth))}">${U.signed(Math.round(U.sum(list, (r) => r.delta.profitMonth)))} ₽/мес</b>.
       </div>
       <p class="hint" style="margin-top:10px">
         Лимит изменения за одно обновление: <b>${U.pct(rs.config.limits.maxChangePerUpdatePct, 0)}</b>
         ${rs.config.limits.maxChangePerDayPct ? ', за сутки: <b>' + U.pct(rs.config.limits.maxChangePerDayPct, 0) + '</b>' : ''}.
         ${rs.demo ? '<br><b>Демо-режим:</b> цены изменятся только в приложении.' : 'Отправка: цены товара — /upload/task, цены размеров — /upload/task/size.'}
       </p>`,
      async () => {
        const btn = UI.modal({ title: 'Отправка цен', size: 'sm', dismissable: false, content: UI.loading(`Отправляем ${list.length} цен в WB…`) });
        try {
          const res = await API.invoke('repricer:proposal-send', {
            source: 'repricer-manual', nmIDs: list.map((r) => r.nmID)
          });
          btn.close();
          if (Views.prices.showResult) Views.prices.showResult(res, list.length);
          else App.toast('Цены отправлены', 'ok');
          this.selection.clear();
          await S.loadGoods(true);
          S.invalidate();
          this.results = [];
          this.summary = null;
          this.draw();
        } catch (e) {
          btn.close();
          UI.modal({ title: 'Ошибка отправки', size: 'sm', content: `<div class="alert danger">${U.esc(e.message)}</div>`, buttons: [{ label: 'Закрыть', class: 'btn-primary' }] });
        }
      },
      `Отправить ${list.length} цен`
    );
  },

  // ══════════════════════ ВКЛАДКА: АКЦИИ ══════════════════════

  // ══════════════════════ ВКЛАДКА: МАССОВЫЕ ПРАВИЛА ══════════════════════

  /**
   * Массовые правила переценки. Сам движок живёт в общем модуле RULES (его же
   * использует раздел «Цены и скидки»), поэтому типы правил, округление,
   * минимальная цена и проверка карантина считаются одинаково.
   *
   * Отправки в WB здесь принципиально нет: план пишется в черновики цен
   * (prices:draft-save), а в маркетплейс цены уходят только из вкладки «Товары»
   * кнопкой «Обновить цены (отправить)».
   */
  async tabRules(host) {
    const st = S.state;
    if (!this.rulesRule) this.rulesRule = RULES.normalize(st.priceRule);
    const rule = this.rulesRule;

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <h2 style="margin:0">Массовые правила переценки</h2>
          <span class="row wrap" style="gap:6px">
            ${UI.badge('движок RULES — общий с «Ценами и скидками»', 'info')}
            ${UI.badge('в WB отсюда не отправляем', 'warn')}
          </span>
        </div>
        <p class="hint">Правило применяется к выбранной области, сначала показывается предпросмотр
          (старые и новые цены, прибыль, маржа, риски), и только потом цены записываются
          в черновик приложения. В Wildberries они уйдут из вкладки «Товары» после подтверждения.</p>
        <div class="row wrap" style="margin-top:10px;gap:8px;align-items:flex-end">
          <label class="field" style="width:230px">Область применения
            <select id="rr-scope">
              <option value="all">Все товары</option>
              <option value="filtered">Под текущим фильтром</option>
              <option value="selected">Выбранные в таблице</option>
              <option value="loss">Убыточные</option>
              <option value="low">С низкой маржой</option>
              <option value="illiquid">Неликвид (90+ дней)</option>
            </select>
          </label>
          <label class="field" style="width:300px">Правило
            <select id="rr-type">
              ${RULES.TYPES.map((t) => `<option value="${t.id}">${U.esc(t.label)}</option>`).join('')}
            </select>
          </label>
          <label class="field" style="width:130px">Значение
            <input id="rr-value" type="number" step="any" class="num" value="${rule.value}" title="${U.esc(RULES.valueTitle(rule.type))}" />
          </label>
          <label class="field" style="width:120px">Округление до, ₽
            <input id="rr-round" type="number" step="1" min="0" class="num" value="${rule.roundTo || 0}" />
          </label>
          <label class="field" style="width:120px">Не ниже, ₽
            <input id="rr-min" type="number" step="1" min="0" class="num" value="${rule.minPrice || 0}" />
          </label>
          <button class="btn btn-primary" id="rr-preview">Рассчитать предпросмотр</button>
          <button class="btn btn-ok" id="rr-save" disabled title="Сохранить новые цены в данных приложения — в WB ничего не уходит">Записать в черновики цен</button>
        </div>
        <div id="rr-info" class="hint" style="margin-top:8px"></div>
      </div>
      <div id="rr-preview-host"></div>
      <div class="card" style="margin-top:14px">
        <h2 style="margin:0 0 6px">Назначить параметры всем выбранным</h2>
        <p class="hint" style="margin:0">Стратегия, минимальная цена и себестоимость — то, что раньше было
          отдельной вкладкой «Параметры товаров (массово)». Правки копятся и сохраняются одной кнопкой.</p>
      </div>
      <div id="rr-strategies"></div>
    `;

    const $ = (id) => host.querySelector(id);
    $('#rr-type').value = rule.type;
    $('#rr-type').onchange = (e) => {
      rule.type = e.target.value;
      $('#rr-value').title = RULES.valueTitle(rule.type);
      this.rulesPlan = null;
      $('#rr-save').disabled = true;
    };
    $('#rr-value').oninput = (e) => { rule.value = U.num(e.target.value); };
    $('#rr-round').oninput = (e) => { rule.roundTo = U.num(e.target.value); };
    $('#rr-min').oninput = (e) => { rule.minPrice = U.num(e.target.value); };

    const info = (text) => { const el = $('#rr-info'); if (el) el.innerHTML = text; };

    $('#rr-preview').onclick = () => {
      const scope = $('#rr-scope').value;
      const rows = scope === 'all' ? S.getRows() : RULES.scopeRows(scope, { editing: null });
      const settings = Object.assign({}, st.settings, { maxPriceChangePct: st.settings.maxPriceChangePct });
      const result = RULES.buildPlan({ rows, rule, edits: null, settings });
      this.rulesPlan = result;
      const box = $('#rr-preview-host');
      box.innerHTML = `
        <div class="grid g4" style="margin-bottom:10px">
          <div class="card stat"><span class="label">Товаров в области</span><span class="value">${result.plan.length}</span></div>
          <div class="card stat"><span class="label">Изменится цен</span><span class="value">${result.changed.length}</span></div>
          <div class="card stat"><span class="label">С предупреждениями</span><span class="value ${result.risky.length ? 'warnc' : 'pos'}">${result.risky.length}</span></div>
          <div class="card stat"><span class="label">Δ прибыли на единицу</span><span class="value ${U.profitClass(result.deltaProfit)}">${U.signed(result.deltaProfit)} ₽</span></div>
        </div>
        <div id="rr-table"></div>`;
      const tbl = UI.table({
        columns: [
          { title: 'Товар', render: (p) => `<div class="rowtitle"><b class="trunc">${U.esc(p.title)}</b><span class="tiny muted">${p.nmID} · ${U.esc(p.vendorCode)}</span></div>` },
          { title: 'Было: цена / скидка', num: true, render: (p) => `${U.money(p.oldSeller)} / ${U.pct(p.oldDisc, 0)}` },
          { title: 'Станет: цена / скидка', num: true, render: (p) => `<b>${U.money(p.newSeller)}</b> / ${U.pct(p.newDisc, 0)}` },
          { title: 'Изменение', num: true, render: (p) => `<span class="${p.changePct < 0 ? 'neg' : 'pos'}">${U.signed(p.changePct, 1)}%</span>` },
          { title: 'Прибыль/шт', num: true, render: (p) => `<span class="muted">${U.money(p.oldProfit)}</span> → <b class="${U.profitClass(p.newProfit)}">${U.money(p.newProfit)}</b>` },
          { title: 'Маржа', num: true, render: (p) => `<span class="muted">${U.pct(p.oldMargin)}</span> → <b class="${U.profitClass(p.newMargin)}">${U.pct(p.newMargin)}</b>` },
          { title: 'Риски', render: (p) => p.warnings.length ? p.warnings.map((w) => UI.badge(w, /карантин|убыток/.test(w) ? 'danger' : 'warn')).join(' ') : UI.badge('ок', 'ok') }
        ],
        rows: result.plan.slice(0, 400),
        empty: 'В выбранной области нет товаров'
      });
      box.querySelector('#rr-table').appendChild(tbl.el);
      $('#rr-save').disabled = !result.changed.length;
      info(result.changed.length
        ? `Готово к записи: <b>${result.changed.length}</b> товаров. Нажмите «Записать в черновики цен» — в WB ничего не уйдёт.`
        : 'Правило ничего не меняет: выберите другой тип или значение.');
      App.toast('Предпросмотр готов: изменится ' + result.changed.length + ' товаров', 'ok', 4000);
    };

    $('#rr-save').onclick = async (e) => {
      const plan = this.rulesPlan;
      if (!plan || !plan.changed.length) { App.toast('Сначала рассчитайте предпросмотр', 'warn'); return; }
      const btn = e.target;
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Записываем…';
      try {
        const items = {};
        plan.changed.forEach((p) => {
          items[String(p.nmID)] = { basePrice: Math.round(p.newBase), discount: Math.round(p.newDisc), note: 'массовое правило' };
        });
        const res = await API.invoke('prices:draft-save', { items });
        await S.loadDrafts();
        info(`Записано в черновики: <b>${res.count}</b> товаров. В WB ничего не отправлено — отправка из вкладки «Товары».`);
        App.toast('Черновики обновлены: ' + res.count + ' поз. В WB не отправлено.', 'ok', 7000);
      } catch (err) {
        App.toast(err.message, 'err', 8000);
      } finally {
        btn.textContent = was;
        btn.disabled = false;
      }
    };

    // массовое назначение стратегии/порога — прежняя вкладка «Параметры товаров (массово)»
    await this.tabStrategies(host.querySelector('#rr-strategies'));
  },

  // ══════════════════════ ВКЛАДКА: СЕБЕСТОИМОСТЬ ══════════════════════

  /**
   * Себестоимость и расходы прямо в репрайсере: та же панель, что в разделе
   * «Себестоимость» (Views.costs.mount). Запись — costs:save, импорт — costs:import.
   */
  tabCosts(host) {
    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <b>Себестоимость и расходы</b>
        <span class="hint" style="margin-left:8px">Ввод, массовое заполнение и импорт CSV/XLSX работают так же,
        как в разделе «Себестоимость»: значения сохраняются сразу и сразу видны в таблице товаров.</span>
      </div>
      <div id="rp-costs-host"></div>
    `;
    Views.costs.mount(host.querySelector('#rp-costs-host'));
  },

  async tabPromos(host, current = () => this.tab === 'promos' && host.isConnected) {
    const rs = this.rstate;
    const cfg = rs.config;
    const P = cfg.promo || {};

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <div class="row wrap">
            <b>Решения по акциям</b>
            ${UI.badge('авто-вход: ' + (P.autoJoin ? 'включён' : 'выключен'), P.autoJoin ? 'ok' : '')}
            ${UI.badge('авто-выход из авто-акций: ' + (P.autoExitAutoPromos ? 'включён' : 'выключен'), P.autoExitAutoPromos ? 'warn' : '')}
            ${UI.badge('прогнозная СПП: ' + (P.useForecastSpp ? 'учитывается' : 'не учитывается'))}
          </div>
          <div class="row wrap">
            <button class="btn btn-primary" id="pa-calc">Рассчитать решения</button>
            <button class="btn btn-ok" id="pa-join" disabled>Войти в выгодные</button>
            <button class="btn btn-danger" id="pa-exit" disabled>Выйти из убыточных</button>
            <button class="btn btn-ghost" id="pa-restore">Вернуть цены после выхода</button>
          </div>
        </div>
        <div class="alert warn" style="margin-top:12px">
          <b>Как работает выход из акции.</b> По выгрузке WB сохраняется фиксированная цена участия.
          Цена продавца (после его скидки, до СПП) не выше этого порога — товар соответствует условию акции.
          Для выхода итоговая цена должна стать строго выше порога с заданным запасом, с соблюдением лимитов РП.
          Нельзя считать товар вышедшим только потому, что изменился процент скидки.
          Когда точной цены файла нет, процент календаря остаётся только приблизительным ориентиром;
          приложение не выдаёт такое наблюдение за подтверждение состава от WB. Импорт/«Сохранить» ничего не отправляют.
        </div>
        <div class="alert info" style="margin-top:8px">
          <b>Прогнозная СПП.</b> WB API не отдаёт прогноз СПП на период акции, поэтому приложение берёт
          <b>среднюю фактическую СПП по продажам товара за 30 дней</b> (её видно в расчёте) или значение,
          заданное вручную в настройках артикула. Решение о входе принимается по марже на акционной цене.
        </div>
      </div>
      <div id="pa-summary"></div>
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap">
          <select id="pa-filter" style="width:280px">
            <option value="all">Все решения</option>
            <option value="exit">К выходу из акции</option>
            <option value="join">К входу в акцию</option>
            <option value="recommend">Рекомендовано войти</option>
            <option value="warn">Убыточно, но авто-выход выключен</option>
            <option value="skip">Не проходит по марже</option>
            <option value="stay">Участие выгодно — оставляем</option>
          </select>
          <input id="pa-q" placeholder="Поиск: артикул, нм-код, название" style="width:280px" />
          <div class="grow"></div>
          <button class="btn btn-sm btn-ghost" id="pa-export">Экспорт CSV</button>
        </div>
      </div>
      <div id="pa-grid">${UI.loading('Нажмите «Рассчитать решения», чтобы оценить акции…')}</div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Очередь возврата цен</h2><span class="hint" id="pa-pend-count"></span></div>
        <p class="hint" style="padding:0 16px">Товары, выведенные из акции. Цена возвращается автоматически, как только WB фактически выведет товар.
        Для <b>авто-акций</b> цена остаётся повышенной до конца акции: иначе WB сразу подхватит товар обратно.</p>
        <div id="pa-pending" style="padding:0 16px 16px"><div class="muted small">Пусто — здесь появляются товары, выведенные из акций.</div></div>
      </div>
    `;

    const $ = (id) => host.querySelector(id);
    this.promoRows = this.promoRows || [];
    this.promoFilter = this.promoFilter || 'all';

    $('#pa-filter').value = this.promoFilter;
    $('#pa-filter').onchange = (e) => { this.promoFilter = e.target.value; this.renderPromoGrid(); };
    $('#pa-q').oninput = U.debounce(() => this.renderPromoGrid(), 220);

    $('#pa-calc').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Считаем…';
      try {
        const res = await API.invoke('repricer:promo-plan', {});
        this.promoPlan = res;
        this.promoRows = res.items || [];
        this.drawPromoSummary();
        this.renderPromoGrid();
        await this.renderPending();
        App.toast(`Решения по акциям: ${this.promoRows.length} товаров`, 'ok');
      } catch (err) {
        App.toast(err.message, 'err', 6000);
      } finally {
        e.target.disabled = false; e.target.textContent = 'Рассчитать решения';
      }
    };

    $('#pa-join').onclick = () => this.applyPromo('join');
    $('#pa-exit').onclick = () => this.applyPromo('exit');
    $('#pa-restore').onclick = async () => {
      const res = await API.invoke('repricer:promo-restore', {});
      App.toast(res.restored ? `Цена возвращена у ${res.restored} товаров` : `Возвратов нет, в очереди ${res.pending}`, res.restored ? 'ok' : 'warn', 5000);
      await this.renderPending();
      await S.loadGoods(true); S.invalidate();
    };

    $('#pa-export').onclick = () => {
      if (!this.promoRows.length) return App.toast('Сначала рассчитайте решения', 'warn');
      const out = [];
      this.promoRows.forEach((r) => (r.actions || []).forEach((a) => out.push({
        'нм-код': r.nmID, 'Артикул': r.vendorCode, 'Название': r.title,
        'Акция': a.promoName, 'Тип акции': a.promoType === 'auto' ? 'автоакция' : 'обычная',
        'Требуемая скидка %': a.requiredDiscountPct, 'Плановая цена': a.planPrice,
        'В акции сейчас': a.inAction ? 'да' : 'нет', 'Началась': a.started ? 'да' : 'нет',
        'Дней до старта': a.daysToStart,
        'Прогнозная СПП %': a.sppForecastPct, 'Цена для покупателя': a.buyerPriceForecast,
        'Прибыль по акционной цене': Math.round(a.profitAtPlan), 'Маржа по акционной цене %': a.marginAtPlan,
        'Порог маржи %': a.minMarginRequired,
        'Прибыль до входа': a.profitBeforeJoin !== undefined ? Math.round(a.profitBeforeJoin) : '',
        'Прибыль при входе': a.profitAtJoin !== undefined ? Math.round(a.profitAtJoin) : '',
        'Окупится при росте продаж %': a.breakEvenUpliftPct !== undefined && a.breakEvenUpliftPct !== null ? a.breakEvenUpliftPct : 'не окупится',
        'Ожидаемый прирост продаж %': a.expectedSalesUpliftPct !== undefined ? a.expectedSalesUpliftPct : '',
        'Вход выгоден': a.joinPaysOff === undefined ? '' : (a.joinPaysOff ? 'да' : 'нет'),
        'Прибыль/мес без акции': a.profitMonthNow !== undefined ? Math.round(a.profitMonthNow) : '',
        'Прибыль/мес с акцией': a.profitMonthJoin !== undefined ? Math.round(a.profitMonthJoin) : '',
        'Решение': { join: 'Войти', exit: 'Выйти', stay: 'Оставить', recommend: 'Рекомендовано войти', skip: 'Не входим', warn: 'Убыточно (авто-выход выключен)', later: 'Решим позже' }[a.action] || a.action,
        'Цена входа': a.joinPrice || '', 'Цена для выхода': a.raiseTo || '', 'Вернуть цену к': a.restoreSellerPrice || '',
        'Пояснение': a.reason
      })));
      API.exportCsv(`promo-decisions-${new Date().toISOString().slice(0, 10)}.csv`, U.toCsv(out));
      App.toast('Решения по акциям выгружены', 'ok');
    };

    if (this.promoRows.length) { this.drawPromoSummary(); this.renderPromoGrid(); }
    await this.renderPending();
    if (!current()) return;

    /**
     * Календарь акций — тот же компонент, что в разделе «Акции»
     * (Views.promos.mount): общий список, Гант/таблица акций и сохранение состава,
     * импорт состава файлом из кабинета и прямая ссылка на акцию.
     * К WB за составом не ходим: метод nomenclatures отвечает HTTP 422.
     */
    const calHead = document.createElement('div');
    calHead.className = 'card';
    calHead.style.marginTop = '14px';
    calHead.innerHTML = `<div class="spread wrap"><b>Календарь акций Wildberries</b>
      <span class="hint">состав загружается файлом из кабинета; к WB за составом не обращаемся</span></div>`;
    host.appendChild(calHead);
    const cal = document.createElement('div');
    cal.id = 'pa-calendar';
    host.appendChild(cal);
    Views.promos.mount(cal);
  },

  /** Аналитика эффекта акций из локального журнала и уже сохранённых отчётов WB. */
  async tabPromoAnalytics(host) {
    const savedDays = U.num((S.state.settings || {}).promoAnalyticsDays, 7) || 7;
    this.promoAnalyticsDays = Math.max(1, Math.min(90, Math.floor(this.promoAnalyticsDays || savedDays)));
    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <div>
            <b>Фактический эффект участия в акциях</b>
            <div class="hint" style="margin-top:4px">Сравниваем N дней до успешного входа и первые N дней участия. По умолчанию N = 7; окно можно настроить от 1 до 90 дней.</div>
          </div>
          <div class="row wrap">
            <label class="row"><span class="hint">Окно N, дней</span><input id="paa-days" type="number" min="1" max="90" step="1" value="${this.promoAnalyticsDays}" style="width:86px" /></label>
            <button class="btn btn-primary" id="paa-refresh">Пересчитать</button>
            <button class="btn btn-sm btn-ghost" id="paa-csv">Экспорт CSV</button>
            <button class="btn btn-sm btn-ghost" id="paa-xlsx">Экспорт XLSX</button>
          </div>
        </div>
        <div class="alert info" style="margin-top:10px">
          Используются только локальный журнал участия, сохранённые финансовые отчёты и снимки остатков. Эта вкладка не запрашивает «Финансы» или «Статистику» и не расходует их лимит. Без финансового отчёта показываем «—», а не нули.
        </div>
      </div>
      <div id="paa-content">${UI.loading('Считаем аналитику по сохранённым данным…')}</div>
    `;
    const $ = (selector) => host.querySelector(selector);
    $('#paa-refresh').onclick = () => this.loadPromoAnalytics(host, this.promoAnalyticsDays);
    $('#paa-days').onchange = async (e) => {
      const raw = Number(e.target.value);
      const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.floor(raw))) : 7;
      this.promoAnalyticsDays = days;
      e.target.value = String(days);
      try {
        S.state.settings = await API.invoke('settings:save', { promoAnalyticsDays: days });
      } catch (err) {
        App.toast('Не удалось сохранить окно аналитики: ' + err.message, 'warn', 6000);
      }
      await this.loadPromoAnalytics(host, days);
    };
    $('#paa-csv').onclick = () => this.exportPromoAnalytics('csv');
    $('#paa-xlsx').onclick = (e) => this.exportPromoAnalytics('xlsx', e.target);
    await this.loadPromoAnalytics(host, this.promoAnalyticsDays);
  },

  async loadPromoAnalytics(host, days) {
    const content = host.querySelector('#paa-content');
    if (!content) return;
    content.innerHTML = '<div class="alert info">Сравнение периодов не доказывает причинный эффект акции: на продажи влияют сезонность, остатки и другие акции. Участие, определённое по цене, не подтверждено составом WB. Себестоимость и налоги — по текущим настройкам.</div>' + UI.loading('Считаем по журналу и кэшированным отчётам…');
    try {
      this.promoAnalyticsData = await API.invoke('repricer:promo-analytics', { days });
      const data = this.promoAnalyticsData || {};
      const groupKeys = (data.promos || []).map((p) => p.key);
      if (!groupKeys.includes(this.promoAnalyticsSelected)) this.promoAnalyticsSelected = groupKeys[0] || null;
      this.drawPromoAnalytics(host);
    } catch (err) {
      content.innerHTML = `<div class="card"><div class="alert danger">${U.esc(err.message || String(err))}</div></div>`;
    }
  },

  drawPromoAnalytics(host) {
    const data = this.promoAnalyticsData || {};
    const content = host.querySelector('#paa-content');
    if (!content) return;
    const summary = data.summary || {};
    const money = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : U.money(Number(v), 2);
    const quantity = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : U.fmt(Number(v), 1);
    const percent = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : U.pct(Number(v), 1);
    const signedPercent = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : U.signed(Number(v), 1) + '%';
    const metricsCell = (period, field, format) => {
      const m = period && period.metrics;
      if (!m) return '—';
      const prefix = period.status === 'partial' ? '≈ ' : '';
      return prefix + format(m[field]);
    };
    const effectInfo = (item) => {
      if (item.overlap) return ['Пересекающиеся акции — вывод исключён', 'warn'];
      if (item.stockout) return ['Обрезано нулевым остатком' + (item.stockoutDate ? ' · ' + item.stockoutDate : ''), 'warn'];
      if (item.effect === 'positive') return ['Положительный эффект', 'ok'];
      if (item.effect === 'negative') return ['Эффект отрицательный', 'danger'];
      if (item.effect === 'neutral') return ['Без изменения', ''];
      if (item.costKnown === false) return ['Себестоимость не задана · прибыль не оценена', 'warn'];
      if (item.stockStatus === 'unknown') return ['Ожидает данных · остаток не проверен', 'warn'];
      return ['Данных пока недостаточно', ''];
    };
    const expensesTitle = (period) => {
      const e = period && period.metrics && period.metrics.expenses;
      if (!e) return 'Нет фактических данных';
      const labels = {
        commission: 'Комиссия WB', logistics: 'Логистика', storage: 'Хранение',
        acceptance: 'Приёмка', acquiring: 'Эквайринг', penalties: 'Штрафы',
        deductions: 'Удержания', cogs: 'Себестоимость', packaging: 'Упаковка',
        advertising: 'Реклама', tax: 'Налог'
      };
      return Object.keys(labels).map((k) => labels[k] + ': ' + money(e[k])).join('\n');
    };
    const statusText = (period) => {
      if (!period) return '';
      if (period.status === 'complete') return period.from + ' → ' + period.to + ' · ' + period.coveredDays + '/' + period.days + ' дн.';
      if (period.status === 'partial') return period.from + ' → ' + period.to + ' · покрыто ' + period.coveredDays + '/' + period.days + ' дн.';
      if (period.status === 'no-report') return period.from + ' → ' + period.to + ' · отчёта нет';
      return 'окно ещё не началось';
    };

    let notice = '';
    if (data.dataStatus === 'no-report' || data.dataStatus === 'daily-data-unavailable' || data.dataStatus === 'incomplete-report') {
      notice = `<div class="alert warn" style="margin-bottom:12px"><b>${U.esc(data.message || 'Финансовых данных для аналитики пока нет.')}</b></div>`;
    } else if (data.message) {
      notice = `<div class="alert info" style="margin-bottom:12px">${U.esc(data.message)}</div>`;
    }

    const summaryHtml = `
      <div class="row wrap" style="gap:8px;margin-bottom:12px">
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Товаров/эпизодов</span><br><b>${U.fmt(summary.itemCount || 0)}</b></div>
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Оценено</span><br><b>${U.fmt(summary.effectEvaluatedCount || 0)}</b></div>
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Положительный эффект</span><br><b class="pos">${U.fmt(summary.positiveCount || 0)}</b></div>
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Отрицательный</span><br><b class="neg">${U.fmt(summary.negativeCount || 0)}</b></div>
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Исключено: stockout</span><br><b class="warnc">${U.fmt(summary.stockoutCount || 0)}</b></div>
        <div class="card" style="padding:10px 14px"><span class="tiny muted">Ожидают данных / себестоимости</span><br><b>${U.fmt(summary.pendingCount || 0)}</b></div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="card-head"><h2>Итоги по акциям</h2><span class="hint">В агрегаты входят товары с полными окнами, заданной себестоимостью и без подтверждённого нулевого остатка.</span></div>
        ${(data.promos || []).length ? `<div class="tablewrap"><table class="grid-table"><thead><tr>
          <th>Акция / товаров</th><th>Выводы</th><th class="num">Продажи до → в акции</th><th class="num">Выручка до → в акции</th><th class="num">Прибыль до → в акции</th><th class="num">Δ прибыли факт/мес</th>
        </tr></thead><tbody>${data.promos.map((p) => {
          const selected = p.key === this.promoAnalyticsSelected;
          const title = `${p.positiveCount || 0} положит. · ${p.negativeCount || 0} отрицат. · ${p.stockoutCount || 0} stockout · ${p.pendingCount || 0} ожидают`;
          return `<tr class="${selected ? 'selected' : ''}">
            <td><button class="btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}" data-paa-promo="${U.esc(p.key)}">${U.esc(p.promoName || ('Акция ' + (p.promoId || '')))}</button><div class="tiny muted">${p.itemCount || 0} эпизодов · оценено ${p.eligibleCount || 0}</div></td>
            <td title="${U.esc(title)}">${UI.badge('+' + (p.positiveCount || 0), 'ok')} ${UI.badge('−' + (p.negativeCount || 0), 'danger')} ${UI.badge('stockout ' + (p.stockoutCount || 0), 'warn')}</td>
            <td class="num">${quantity(p.salesBefore)} → ${quantity(p.salesDuring)}</td>
            <td class="num">${money(p.revenueBefore)} → ${money(p.revenueDuring)}</td>
            <td class="num">${money(p.profitBefore)} → ${money(p.profitDuring)}</td>
            <td class="num ${Number(p.actualProfitGainMonthly) > 0 ? 'pos' : (Number(p.actualProfitGainMonthly) < 0 ? 'neg' : '')}">${!p.effectEvaluatedCount ? '—' : U.signed(Number(p.actualProfitGainMonthly), 2) + ' ₽'}</td>
          </tr>`;
        }).join('')}</tbody></table></div>` : '<div class="muted" style="padding:16px">В журнале пока нет успешных входов в акции.</div>'}
      </div>
    `;

    const selectedPromo = (data.promos || []).find((p) => p.key === this.promoAnalyticsSelected) || null;
    const detailItems = selectedPromo ? selectedPromo.items : [];
    const itemRows = detailItems.map((item) => {
      const [effectLabel, effectKind] = effectInfo(item);
      const comparison = item.comparison || {};
      const before = item.before || {};
      const during = item.during || {};
      const beforeMetrics = before.metrics || null;
      const duringMetrics = during.metrics || null;
      const expenseSummary = (period) => {
        const m = period && period.metrics;
        return m ? `<span title="${U.esc(expensesTitle(period))}">${money(m.expenses && m.expenses.total)}</span>` : '—';
      };
      const growth = `прогноз ${percent(item.forecast && item.forecast.salesUpliftPct)}<br>факт ${percent(comparison.actualSalesUpliftPct)}<br><b>расх. ${signedPercent(comparison.salesDeviationPct)}</b>`;
      const profitForecast = `прогноз ${money(comparison.forecastProfitMonthDuring)}<br>факт ${money(comparison.actualProfitMonthDuring)}<br><b>расх. ${signedPercent(comparison.profitForecastDeviationPct)}</b>`;
      const breakEven = item.forecast && item.forecast.breakEvenUpliftPct !== null
        ? `<div class="tiny muted">порог безубыточности ${percent(item.forecast.breakEvenUpliftPct)}${comparison.breakEvenMet === null ? '' : (comparison.breakEvenMet ? ' · достигнут' : ' · не достигнут')}</div>` : '';
      const fullExpenses = `<details><summary class="tiny">Состав</summary><div class="tiny" style="white-space:pre-line">До участия: ${U.esc(expensesTitle(before))}<br><br>В акции: ${U.esc(expensesTitle(during))}</div></details>`;
      const stockLabel = item.stockStatus === 'unknown' ? 'Исторических снимков нет' : (item.stockout ? 'Нулевой остаток замечен ' + item.stockoutDate : 'Нулевой остаток не замечен (' + item.stockObservedDays + ' дн. со снимком)');
      return `<tr>
        <td><b>${U.esc(item.vendorCode || String(item.nmID))}</b><div class="tiny muted">${U.esc(item.title || '')} · nmID ${item.nmID}</div><div class="tiny muted">${U.esc(item.promoName || '')} · вход ${U.esc(item.joinedDay || '')}</div></td>
        <td>${UI.badge(effectLabel, effectKind)}<div class="tiny muted">До: ${U.esc(statusText(before))}<br>В акции: ${U.esc(statusText(during))}<br>${U.esc(stockLabel)}</div></td>
        <td class="num">${metricsCell(before, 'salesQty', quantity)}<div class="tiny muted">возвраты ${metricsCell(before, 'returnsQty', quantity)}<br>выручка ${metricsCell(before, 'revenue', money)}<br>прибыль ${metricsCell(before, 'profit', money)}<br>СПП ${beforeMetrics ? percent(beforeMetrics.sppPct) : '—'}</div></td>
        <td class="num">${metricsCell(during, 'salesQty', quantity)}<div class="tiny muted">возвраты ${metricsCell(during, 'returnsQty', quantity)}<br>выручка ${metricsCell(during, 'revenue', money)}<br>прибыль ${metricsCell(during, 'profit', money)}<br>СПП ${duringMetrics ? percent(duringMetrics.sppPct) : '—'}</div></td>
        <td class="num">${expenseSummary(before)} → ${expenseSummary(during)}<div class="tiny muted">общие расходы до / в акции</div>${fullExpenses}</td>
        <td class="num ${Number(comparison.actualProfitGainMonthly) > 0 ? 'pos' : (Number(comparison.actualProfitGainMonthly) < 0 ? 'neg' : '')}">${comparison.actualProfitGainMonthly === null ? '—' : money(comparison.actualProfitGainMonthly)}<div class="tiny muted">факт Δ прибыли, ₽/мес</div></td>
        <td class="tiny">${growth}${breakEven}</td>
        <td class="tiny">${profitForecast}<div class="tiny muted">расхождение = (факт − прогноз) / |прогноз| × 100%</div></td>
      </tr>`;
    }).join('');

    const detailHtml = selectedPromo
      ? `<div class="card"><div class="card-head"><h2>Товары: ${U.esc(selectedPromo.promoName || '')}</h2><span class="hint">Значения окон — суммы факта WB. В неполных окнах стоит «≈»; они не входят в итоги.</span></div>
          <div class="tablewrap"><table class="grid-table"><thead><tr>
            <th>Товар / акция</th><th>Статус и покрытие окон</th><th class="num">N дней до входа</th><th class="num">N дней участия</th><th class="num">Расходы</th><th class="num">Изменение прибыли</th><th>Рост продаж: прогноз / факт / расх.</th><th>Прибыль акции/мес: прогноз / факт / расх.</th>
          </tr></thead><tbody>${itemRows || '<tr><td colspan="8" class="muted">Нет товаров для детализации.</td></tr>'}</tbody></table></div>
        </div>`
      : '<div class="card muted">Выберите акцию в таблице выше, чтобы раскрыть товары.</div>';
    content.innerHTML = notice + summaryHtml + detailHtml;
    content.querySelectorAll('[data-paa-promo]').forEach((button) => {
      button.onclick = () => {
        this.promoAnalyticsSelected = button.dataset.paaPromo;
        this.drawPromoAnalytics(host);
      };
    });
  },

  promoAnalyticsExportRows(data) {
    const rows = [];
    (data && data.items || []).forEach((item) => {
      const before = item.before && item.before.metrics || {};
      const during = item.during && item.during.metrics || {};
      const eb = before.expenses || {};
      const ed = during.expenses || {};
      const c = item.comparison || {};
      const f = item.forecast || {};
      rows.push({
        'Акция': item.promoName || '', 'ID акции': item.promoId || '', 'nmID': item.nmID,
        'Артикул': item.vendorCode || '', 'Название': item.title || '', 'Вход': item.joinedAt || '',
        'Окно до': (item.before && item.before.from || '') + ' → ' + (item.before && item.before.to || ''),
        'Продажи до': before.salesQty, 'Выручка до, ₽': before.revenue, 'Прибыль до, ₽': before.profit, 'СПП до, %': before.sppPct,
        'Расходы WB до, ₽': eb.wbTotal, 'Себестоимость/прочие до, ₽': eb.total === undefined ? null : eb.total - (eb.wbTotal || 0),
        'Окно акции': (item.during && item.during.from || '') + ' → ' + (item.during && item.during.to || ''),
        'Продажи в акции': during.salesQty, 'Выручка в акции, ₽': during.revenue, 'Прибыль в акции, ₽': during.profit, 'СПП в акции, %': during.sppPct,
        'Расходы WB в акции, ₽': ed.wbTotal, 'Себестоимость/прочие в акции, ₽': ed.total === undefined ? null : ed.total - (ed.wbTotal || 0),
        'Факт Δ прибыли, ₽/мес': c.actualProfitGainMonthly,
        'Прогноз прироста продаж, %': f.salesUpliftPct, 'Факт прироста продаж, %': c.actualSalesUpliftPct,
        'Расхождение продаж, %': c.salesDeviationPct, 'Порог безубыточности, %': f.breakEvenUpliftPct,
        'Прогноз прибыли в акции, ₽/мес': f.profitMonthWithPromo, 'Факт прибыли в акции, ₽/мес': c.actualProfitMonthDuring,
        'Расхождение прибыли, %': c.profitForecastDeviationPct,
        'Прогноз прибыли без акции, ₽/мес': f.profitMonthNow, 'Расхождение прироста прибыли, %': c.profitGainDeviationPct,
        'Эффект': item.stockout ? 'обрезан нулевым остатком' : item.effect,
        'Нулевой остаток': item.stockout ? 'да' : 'нет/не наблюдался',
        'Дата stockout': item.stockoutDate || '', 'Окно завершено': c.periodComplete ? 'да' : 'нет',
        'Полные окна с отчётом': item.windowsComplete ? 'да' : 'нет',
        'Себестоимость задана': item.costKnown ? 'да' : 'нет'
      });
    });
    return rows;
  },

  async exportPromoAnalytics(format, button) {
    const data = this.promoAnalyticsData;
    const objects = this.promoAnalyticsExportRows(data);
    if (!objects.length) return App.toast('В журнале нет строк аналитики для экспорта', 'warn');
    const headers = Object.keys(objects[0]);
    const rows = objects.map((x) => headers.map((h) => x[h] === undefined ? '' : x[h]));
    const fileBase = 'promo-analytics-' + new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      await API.exportCsv(fileBase + '.csv', U.toCsv(objects, headers));
      App.toast('Аналитика акций выгружена в CSV', 'ok');
      return;
    }
    const btn = button;
    if (btn) { btn.disabled = true; btn.dataset.was = btn.textContent; btn.textContent = 'Собираем…'; }
    try {
      const res = await API.invoke('xlsx:build', { rows, headers, sheetName: 'Аналитика акций', fileName: fileBase + '.xlsx' });
      U.downloadBase64(res.fileName, res.base64);
      App.toast('Аналитика акций выгружена в Excel: ' + U.fmt(rows.length) + ' товаров', 'ok', 6000);
    } catch (err) {
      App.toast(err.message, 'err', 9000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.was || 'Экспорт XLSX'; }
    }
  },

  drawPromoSummary() {
    const host = this.container.querySelector('#pa-summary');
    const plan = this.promoPlan;
    if (!host || !plan) return;
    const rows = plan.byPromo || [];
    host.innerHTML = `
      <div class="card pad0" style="margin-bottom:12px">
        <div class="card-head" style="padding:14px 16px 0"><h2>Акции календаря</h2>
          <span class="hint">решения приняты по ${plan.items.length} товарам</span></div>
        <div style="padding:10px 16px 16px">
          <table class="grid-table">
            <thead><tr><th>Акция</th><th>Тип</th><th class="num">Скидка ≥</th><th class="num">Оставить</th>
              <th class="num">Войти</th><th class="num">Рекоменд.</th><th class="num">Выйти</th><th class="num">Не входим</th><th class="num">Убыточно</th><th>Старт</th></tr></thead>
            <tbody>${rows.map((b) => `<tr>
              <td><b>${U.esc(b.promoName)}</b></td>
              <td>${UI.badge(b.promoType === 'auto' ? 'автоакция' : 'обычная', b.promoType === 'auto' ? 'danger' : '')}</td>
              <td class="num">${U.pct(b.requiredDiscountPct, 0)}</td>
              <td class="num pos">${b.stay || ''}</td>
              <td class="num">${b.join ? '<b class="pos">' + b.join + '</b>' : ''}</td>
              <td class="num">${b.recommend || ''}</td>
              <td class="num">${b.exit ? '<b class="neg">' + b.exit + '</b>' : ''}</td>
              <td class="num muted">${b.skip || ''}</td>
              <td class="num">${b.warn ? '<span class="warnc">' + b.warn + '</span>' : ''}</td>
              <td class="tiny muted">${b.started ? 'идёт' : (b.daysToStart ? 'через ' + b.daysToStart + ' дн' : '—')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="grid g4" style="margin-bottom:12px">
        <div class="card stat"><span class="label">К входу в акции</span><span class="value pos">${plan.summary.promoJoin || 0}</span><span class="hint">рекомендаций ещё ${plan.summary.promoRecommend || 0}</span></div>
        <div class="card stat"><span class="label">К выходу из акций</span><span class="value neg">${plan.summary.promoExit || 0}</span><span class="hint">снижением скидки ниже порога</span></div>
        <div class="card stat"><span class="label">Остаются в акциях</span><span class="value">${plan.summary.promoStay || 0}</span><span class="hint">участие выгодно</span></div>
        <div class="card stat"><span class="label">Убыточно, но держим</span><span class="value warnc">${plan.summary.promoWarn || 0}</span><span class="hint">авто-выход выключен</span></div>
        <div class="card stat"><span class="label">Не проходят по марже</span><span class="value">${plan.summary.promoSkip || 0}</span><span class="hint">вход отклонён</span></div>
      </div>`;
  },

  renderPromoGrid() {
    const host = this.container.querySelector('#pa-grid');
    if (!host) return;
    const f = this.promoFilter || 'all';
    const q = ((this.container.querySelector('#pa-q') || {}).value || '').toLowerCase();
    let list = this.promoRows || [];
    if (f !== 'all') list = list.filter((r) => (r.actions || []).some((a) => a.action === f));
    if (q) list = list.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode || '').toLowerCase().includes(q) || String(r.title || '').toLowerCase().includes(q));

    const label = { join: 'Войти', exit: 'Выйти', stay: 'Оставить', recommend: 'Рекомендовано', skip: 'Не входим', warn: 'Убыточно', later: 'Позже' };
    const kind = { join: 'ok', exit: 'danger', stay: '', recommend: 'info', skip: '', warn: 'warn', later: '' };

    host.innerHTML = '';
    const grid = UI.table({
      columns: [
        { title: 'Товар', cls: 'rp-product', render: (r) => {
            const item = this.itemsByNm.get(String(r.nmID)) || {};
            const raw = item.photo || item.photoUrl || (item.photos && item.photos[0]);
            const photo = typeof raw === 'string' ? raw : raw && (raw.small || raw.big);
            return `<div class="row">${photo && /^https:\/\//i.test(photo) ? `<img class="rp-photo" src="${U.esc(photo)}" loading="lazy" alt="" />` : '<span class="rp-photo muted" aria-label="Нет фото">▧</span>'}
              <div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">SKU ${r.nmID} · ${U.esc(r.vendorCode)}</span><span class="tiny muted">${U.esc(item.brand || 'Бренд не указан')}</span></div></div>`;
          } },
        { title: 'Цена сейчас', num: true, render: (r) => `${U.money(r.current.sellerPrice)}<div class="tiny muted">маржа ${U.pct(r.current.marginPct)}</div>` },
        { title: 'Решения по акциям', render: (r) => (r.actions || []).slice(0, 3).map((a) =>
            `<div class="tiny" style="margin-bottom:3px">${UI.badge(label[a.action] || a.action, kind[a.action])}
             <b>${U.esc(a.promoName)}</b> ${a.promoType === 'auto' ? '<span class="muted">(авто)</span>' : ''}
             · план ${U.money(a.planPrice)} · маржа <span class="${a.marginAtPlan >= a.minMarginRequired ? 'pos' : 'neg'}">${U.pct(a.marginAtPlan)}</span></div>`).join('')
            + ((r.actions || []).length > 3 ? `<div class="tiny muted">и ещё ${(r.actions || []).length - 3}</div>` : '') },
        { title: 'Новая цена', num: true, render: (r) => r.chosen ? `<b>${U.money(r.proposed.sellerPrice)}</b><div class="tiny muted">${U.signed(r.delta.pct, 1)}%</div>` : '<span class="muted tiny">без изменений</span>' },
        { title: 'Прибыль/шт', num: true, render: (r) => `<span class="${U.profitClass(r.proposed.profit)}">${U.money(r.proposed.profit)}</span>` },
        { title: 'Прогноз СПП', num: true, render: (r) => { const a = (r.actions || [])[0]; return a ? U.pct(a.sppForecastPct, 0) : '—'; } },
        { title: 'Окупаемость входа', num: true, render: (r) => {
            const a = (r.actions || []).find((x) => x.action === 'join' || x.action === 'recommend');
            if (!a) return '<span class="muted tiny">—</span>';
            if (a.breakEvenUpliftPct === null || a.breakEvenUpliftPct === undefined) return '<span class="neg tiny">не окупится</span>';
            return `<div class="${a.joinPaysOff ? 'pos' : 'warnc'}"><b>рост от ${U.pct(a.breakEvenUpliftPct, 0)}</b></div>
              <div class="tiny muted">ожидаем ${U.pct(a.expectedSalesUpliftPct, 0)} → ${a.joinPaysOff ? 'выгодно' : 'не хватает'}</div>`;
          } },
        { title: '', render: (r) => `<button class="btn btn-xs btn-ghost" data-pa="${r.nmID}">подробно</button>` }
      ],
      rows: list.slice(0, 500),
      tall: true,
      empty: 'Нет решений под этот фильтр. Нажмите «Рассчитать решения».'
    });
    host.appendChild(grid.el);

    host.querySelectorAll('[data-pa]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.showPromoItem(Number(b.dataset.pa)); };
    });
    host.querySelectorAll('tbody tr').forEach((tr, i) => {
      const r = list[i];
      if (r) tr.ondblclick = () => this.showPromoItem(r.nmID);
    });

    const joins = list.filter((r) => r.chosen && r.chosen.type === 'join').length;
    const exits = list.filter((r) => r.chosen && r.chosen.type === 'exit' && r.needSend).length;
    const jb = this.container.querySelector('#pa-join');
    const eb = this.container.querySelector('#pa-exit');
    if (jb) { jb.disabled = !joins; jb.textContent = joins ? `Войти в выгодные (${joins})` : 'Войти в выгодные'; }
    if (eb) { eb.disabled = !exits; eb.textContent = exits ? `Выйти из убыточных (${exits})` : 'Выйти из убыточных'; }
  },

  showPromoItem(nmID) {
    const r = (this.promoRows || []).find((x) => Number(x.nmID) === Number(nmID));
    if (!r) return;
    const label = { join: 'Войти в акцию', exit: 'Выйти из акции', stay: 'Оставить в акции', recommend: 'Рекомендуем войти', skip: 'Не входим', warn: 'Убыточно (авто-выход выключен)', later: 'Решение позже' };
    const body = U.el('div');
    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">${UI.badge('нм-код ' + r.nmID)} ${UI.badge(r.vendorCode)}
        ${r.chosen ? UI.badge('итоговое действие: ' + (r.chosen.type === 'exit' ? 'выход из акции' : 'вход в акцию'), r.chosen.type === 'exit' ? 'danger' : 'ok') : UI.badge('цена не меняется')}</div>
      <div class="grid g3" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Цена сейчас</span><span class="value">${U.money(r.current.sellerPrice)}</span><span class="hint">маржа ${U.pct(r.current.marginPct)} · прибыль ${U.money(r.current.profit)}</span></div>
        <div class="card stat"><span class="label">Предложенная цена</span><span class="value">${U.money(r.proposed.sellerPrice)}</span><span class="hint">маржа ${U.pct(r.proposed.marginPct)} · прибыль ${U.money(r.proposed.profit)}</span></div>
        <div class="card stat"><span class="label">Изменение</span><span class="value ${U.profitClass(r.delta.abs)}">${U.signed(r.delta.pct, 1)}%</span><span class="hint">${U.signed(r.delta.abs)} ₽</span></div>
      </div>
      <table class="grid-table">
        <thead><tr><th>Акция</th><th>Тип</th><th class="num">Скидка ≥</th><th class="num">Плановая цена</th>
          <th class="num">Цена покупателю (прогноз)</th><th class="num">Прибыль</th><th class="num">Маржа</th><th>Решение</th><th>Пояснение</th></tr></thead>
        <tbody>${(r.actions || []).map((a) => `<tr>
          <td><b>${U.esc(a.promoName)}</b><div class="tiny muted">${a.started ? 'идёт' : 'старт через ' + a.daysToStart + ' дн'} · ${a.inAction ? 'участвуем' : 'не участвуем'}</div></td>
          <td>${UI.badge(a.promoType === 'auto' ? 'авто' : 'обычная', a.promoType === 'auto' ? 'danger' : '')}</td>
          <td class="num">${U.pct(a.requiredDiscountPct, 0)}</td>
          <td class="num">${U.money(a.planPrice)}</td>
          <td class="num">${U.money(a.buyerPriceForecast)}<div class="tiny muted">СПП ${U.pct(a.sppForecastPct, 0)}</div></td>
          <td class="num ${U.profitClass(a.profitAtPlan)}">${U.money(a.profitAtPlan)}${a.profitAtJoin !== undefined ? `<div class="tiny muted">при входе ${U.money(a.profitAtJoin)}</div>` : ''}${a.breakEvenUpliftPct !== undefined && a.breakEvenUpliftPct !== null ? `<div class="tiny ${a.joinPaysOff ? 'pos' : 'warnc'}">окупится при росте от ${U.pct(a.breakEvenUpliftPct, 0)}</div>` : ''}</td>
          <td class="num ${a.marginAtPlan >= a.minMarginRequired ? 'pos' : 'neg'}">${U.pct(a.marginAtPlan)}<div class="tiny muted">порог ${U.pct(a.minMarginRequired, 0)}</div></td>
          <td>${UI.badge(label[a.action] || a.action, { join: 'ok', exit: 'danger', warn: 'warn', recommend: 'info' }[a.action] || '')}</td>
          <td class="tiny muted" style="white-space:normal;max-width:420px">${U.esc(a.reason)}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${r.chosen ? `<div class="alert ${r.chosen.type === 'exit' ? 'warn' : 'info'}" style="margin-top:12px"><b>Что будет сделано:</b> ${U.esc(r.chosen.reason)}</div>` : ''}
      ${r.chosen && r.chosen.type === 'join' ? `<div class="alert ${r.chosen.joinPaysOff ? 'ok' : 'warn'}" style="margin-top:8px">
         <b>Окупаемость входа.</b> Прибыль с единицы: ${U.money(r.current.profit)} → ${U.money(r.proposed.profit)}.<br>
         Вход окупится при росте продаж от <b>${r.delta.breakEvenUpliftPct === null || r.delta.breakEvenUpliftPct === undefined ? '—' : U.pct(r.delta.breakEvenUpliftPct, 0)}</b>,
         ожидаемый прирост — <b>${U.pct(r.delta.salesUpliftPct, 0)}</b> → ${r.chosen.joinPaysOff ? '<b class="pos">вход выгоден</b>' : '<b class="warnc">прироста может не хватить</b>'}.<br>
         Прибыль за месяц: ${U.money(r.delta.profitMonthNow)} → ${U.money(r.delta.profitMonthWithPromo)} (Δ ${U.signed(r.delta.profitMonth)} ₽).
       </div>` : ''}
      ${(r.warnings || []).length ? `<div class="alert warn" style="margin-top:8px">${r.warnings.map(U.esc).join('<br>')}</div>` : ''}
    `;
    UI.modal({ title: `Акции — ${r.title}`, content: body, size: 'md', buttons: [{ label: 'Закрыть', class: 'btn-primary' }] });
  },

  async applyPromo(kind) {
    const list = (this.promoRows || []).filter((r) => r.chosen && r.chosen.type === kind && (kind === 'exit' ? r.needSend : true));
    if (!list.length) return App.toast('Нет товаров для этого действия', 'warn');
    const cfg = this.rstate.config;

    const html = kind === 'exit'
      ? `<div class="alert danger">У <b>${list.length}</b> товаров будет <b>снижена скидка ниже порога акции</b> —
         только так WB выводит товар из акции (API для исключения нет, а плановая цена считается от базовой).<br>
         Цена для покупателя при этом не опускается ниже расчётной цены репрайсера.</div>
         <p class="hint">${cfg.promo.restorePriceAfterExit !== false ? 'После фактического выхода приложение вернёт рабочую цену — товары встанут в очередь возврата. Для авто-акций цена держится повышенной до конца акции.' : '<b>Возврат цены выключен</b> — скидка останется пониженной.'}</p>
         <p class="hint">Повышение цены не рискует карантином WB: карантин срабатывает только при снижении цены более чем в 3 раза.</p>`
      : `<div class="alert info">Будет выполнен вход в акцию для <b>${list.length}</b> товаров:
         приложение отправит акционную цену и добавит товары в акцию через <span class="mono">/api/v1/calendar/promotions/upload</span>.</div>
         <p class="hint">Прогноз прибыли по акционным ценам: <b class="${U.profitClass(U.sum(list, (r) => r.proposed.profit))}">${U.money(U.sum(list, (r) => r.proposed.profit))}</b> за единицу (суммарно).</p>`;

    UI.confirmDialog(kind === 'exit' ? `Выйти из акций: ${list.length} товаров` : `Войти в акции: ${list.length} товаров`, html, async () => {
      const m = UI.modal({ title: 'Выполняем', size: 'sm', dismissable: false, content: UI.loading(kind === 'exit' ? 'Повышаем цены для выхода из акций…' : 'Отправляем цены и входим в акции…') });
      try {
        const res = await API.invoke('repricer:promo-apply', { results: list });
        m.close();
        const parts = [];
        if (res.exited) parts.push(`цен повышено: ${res.exited}`);
        if (res.joined) parts.push(`введено в акции: ${res.joined}`);
        if (res.restored) parts.push(`возвращено цен: ${res.restored}`);
        if (res.joinFailed && res.joinFailed.length) parts.push(`ошибок входа: ${res.joinFailed.length}`);
        UI.modal({
          title: 'Готово', size: 'sm',
          content: `<div class="alert ${parts.length ? 'ok' : 'warn'}">${parts.length ? parts.join('<br>') : 'Изменений не потребовалось'}</div>
            ${(res.joinFailed || []).map((f) => `<div class="alert danger">${U.esc(f.message)}</div>`).join('')}
            ${kind === 'exit' ? '<p class="hint">Товары в очереди возврата цен — WB выводит их из акции не мгновенно, проверка выполняется при каждом пересчёте.</p>' : ''}`,
          buttons: [{ label: 'Закрыть', class: 'btn-primary' }]
        });
        await S.loadGoods(true); S.invalidate();
        await this.loadState();
        this.promoRows = [];
        this.promoPlan = null;
        this.draw();
      } catch (e) {
        m.close();
        UI.modal({ title: 'Ошибка', size: 'sm', content: `<div class="alert danger">${U.esc(e.message)}</div>`, buttons: [{ label: 'Закрыть', class: 'btn-primary' }] });
      }
    }, kind === 'exit' ? `Повысить цену у ${list.length} товаров` : `Войти в акции (${list.length})`);
  },

  async renderPending() {
    const host = this.container.querySelector('#pa-pending');
    if (!host) return;
    let pend = [];
    try { pend = await API.invoke('repricer:promo-exits', {}); } catch (e) { return; }
    const cnt = this.container.querySelector('#pa-pend-count');
    if (cnt) cnt.textContent = pend.length ? pend.length + ' в очереди' : 'очередь пуста';
    if (!pend.length) {
      host.innerHTML = '<div class="muted small">Пусто — здесь появляются товары, которым подняли цену для выхода из акции.</div>';
      return;
    }
    const rowsByNm = S.getRows();
    const grid = UI.table({
      columns: [
        { title: 'Товар', render: (p) => { const r = rowsByNm.find((x) => String(x.nmID) === String(p.nmID)); return `<div class="rowtitle"><b class="trunc">${U.esc(r ? r.title : '')}</b><span class="tiny muted">${p.nmID}${r ? ' · ' + U.esc(r.vendorCode) : ''}</span></div>`; } },
        { title: 'Акция', render: (p) => (p.promoNames || []).map((n) => U.esc(n)).join(', ') },
        { title: 'Цена поднята до', num: true, render: (p) => U.money(p.raisedTo) },
        { title: 'Вернуть к', num: true, render: (p) => `<b>${U.money(p.restoreSellerPrice)}</b>${p.restorePair ? `<div class="tiny muted">база ${U.money(p.restorePair.basePrice)} · скидка ${U.pct(p.restorePair.discount, 0)}</div>` : ''}` },
        { title: 'Скидка', num: true, render: (p) => p.raisedDiscount ? U.pct(p.raisedDiscount, 0) : '—' },
        { title: 'Когда', render: (p) => U.date(p.at, true) },
        { title: 'Статус', render: (p) => {
            if (p.status === 'waiting-exit' || p.stillInPromo) return `<div>${UI.badge('ещё в акции — ждём вывода', 'warn')}<div class="tiny muted">WB выводит не мгновенно</div></div>`;
            if (p.status === 'waiting-promo-end' || p.blockedByAutoPromo) return `<div>${UI.badge('держим до конца авто-акции', 'danger')}<div class="tiny muted">${U.esc((p.blockedPromoNames || []).join(', '))} — иначе WB вернёт товар</div></div>`;
            return UI.badge('вышел — цена будет возвращена', 'ok');
          } }
      ],
      rows: pend,
      empty: 'Пусто'
    });
    host.innerHTML = '';
    host.appendChild(grid.el);
  },

  // ══════════════════════ ВКЛАДКА: ТОВАРЫ И СТРАТЕГИИ ══════════════════════

  async tabStrategies(host) {
    const rs = this.rstate;
    const rows = S.getRows(true);
    const configs = rs.itemConfigs || {};
    const defs = rs.defaults;

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap">
          <input id="st-q" placeholder="Поиск: артикул, нм-код, название" style="width:280px" />
          <select id="st-cat" style="width:200px"><option value="">Все категории</option></select>
          <select id="st-strategy" style="width:230px"><option value="">Все стратегии</option>
            ${rs.strategies.map((s) => `<option value="${s.id}">${U.esc(s.name)}</option>`).join('')}</select>
          <label class="checkline"><input type="checkbox" id="st-onlyset" /> только с индивидуальными настройками</label>
          <div class="grow"></div>
          <button class="btn btn-sm btn-ghost" id="st-export">Экспорт CSV</button>
          <button class="btn btn-sm" id="st-import">Импорт CSV</button>
        </div>
        <p class="hint" style="margin:10px 0 0">Минимальная цена — пол, ниже которого репрайсер не опустится. Базовая цена — потолок коридора
          (по умолчанию берётся текущая цена до скидки с WB). Если минимальная цена не задана, она считается по минимальной марже.</p>
      </div>
      <div id="st-grid"></div>
      <div class="bulkbar" id="st-bulk"></div>
    `;

    const catSel = host.querySelector('#st-cat');
    S.categories().forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });

    this.stFilter = this.stFilter || { q: '', cat: '', strategy: '', onlySet: false };
    const apply = () => {
      this.stFilter.q = host.querySelector('#st-q').value;
      this.stFilter.cat = host.querySelector('#st-cat').value;
      this.stFilter.strategy = host.querySelector('#st-strategy').value;
      this.stFilter.onlySet = host.querySelector('#st-onlyset').checked;
      this.renderStrategies();
    };
    ['#st-q', '#st-cat', '#st-strategy'].forEach((s) => host.querySelector(s).oninput = U.debounce(apply, 220));
    ['#st-cat', '#st-strategy', '#st-onlyset'].forEach((s) => host.querySelector(s).onchange = apply);

    host.querySelector('#st-export').onclick = () => {
      const csv = U.toCsv(rows.map((r) => {
        const c = configs[String(r.nmID)] || {};
        return {
          'нм-код': r.nmID, 'Артикул': r.vendorCode, 'Название': r.title, 'Категория': r.category,
          'Стратегия': c.strategy || defs.strategy, 'Целевая маржа %': c.targetMarginPct !== undefined ? c.targetMarginPct : defs.targetMarginPct,
          'Мин. маржа %': c.minMarginPct !== undefined ? c.minMarginPct : defs.minMarginPct,
          'Минимальная цена': c.minPrice || '', 'Базовая цена (порог)': c.basePriceTarget || r.basePrice,
          'РРЦ': c.rrp || '', 'Целевая скидка %': c.targetDiscountPct || '',
          'План продаж/мес, шт': c.planQtyMonth || '', 'Целевая оборачиваемость, дн': c.targetTurnoverDays !== undefined ? c.targetTurnoverDays : defs.targetTurnoverDays,
          'Защита от out of stock': (c.oosProtection === undefined ? defs.oosProtection : c.oosProtection) ? 1 : 0,
          'Разрешить отриц. маржу': (c.allowNegativeMargin === undefined ? defs.allowNegativeMargin : c.allowNegativeMargin) ? 1 : 0,
          'Повышение акционной цены %': c.promoUpliftPct !== undefined ? c.promoUpliftPct : defs.promoUpliftPct,
          'Красивая цена': (c.beautifulPrice && c.beautifulPrice.enabled) || defs.beautifulPrice.enabled ? 1 : 0,
          'Текущая цена': r.sellerPrice, 'Себестоимость': r.costPrice, 'Прибыль/шт': r.profit, 'Маржа %': r.margin,
          'Остаток': r.stock, 'Оборачиваемость дн': r.turnoverDays
        };
      }));
      API.exportCsv(`repricer-items-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      App.toast('Список товаров с настройками выгружен', 'ok');
    };

    host.querySelector('#st-import').onclick = async () => {
      const text = await API.importCsv();
      if (!text) return;
      const parsed = U.parseCsv(text);
      const items = {};
      parsed.forEach((row) => {
        const get = (...names) => {
          for (const n of names) {
            const k = Object.keys(row).find((x) => x.toLowerCase().replace(/\s/g, '') === n.toLowerCase().replace(/\s/g, ''));
            if (k !== undefined && row[k] !== '') return row[k];
          }
          return undefined;
        };
        const nm = String(get('нм-код', 'nmid') || '').trim();
        if (!nm || !/^\d+$/.test(nm)) return;
        const c = {};
        const s = get('Стратегия', 'strategy');
        if (s) c.strategy = String(s).trim().toLowerCase();
        const n1 = get('Целевая маржа %', 'Целевая маржа', 'targetMarginPct'); if (n1 !== undefined) c.targetMarginPct = U.num(n1);
        const n2 = get('Мин. маржа %', 'Минимальная маржа %', 'minMarginPct'); if (n2 !== undefined) c.minMarginPct = U.num(n2);
        const n3 = get('Минимальная цена', 'minPrice'); if (n3 !== undefined) c.minPrice = U.num(n3);
        const n4 = get('Базовая цена (порог)', 'Базовая цена', 'basePriceTarget'); if (n4 !== undefined) c.basePriceTarget = U.num(n4);
        const n5 = get('РРЦ', 'rrp'); if (n5 !== undefined) c.rrp = U.num(n5);
        const n6 = get('План продаж/мес, шт', 'План на месяц', 'planQtyMonth'); if (n6 !== undefined) c.planQtyMonth = U.num(n6);
        const n7 = get('Целевая оборачиваемость, дн', 'targetTurnoverDays'); if (n7 !== undefined) c.targetTurnoverDays = U.num(n7);
        const n8 = get('Повышение акционной цены %', 'promoUpliftPct'); if (n8 !== undefined) c.promoUpliftPct = U.num(n8);
        const b1 = get('Защита от out of stock', 'oosProtection'); if (b1 !== undefined) c.oosProtection = String(b1) === '1';
        const b2 = get('Разрешить отриц. маржу', 'allowNegativeMargin'); if (b2 !== undefined) c.allowNegativeMargin = String(b2) === '1';
        items[nm] = c;
      });
      if (!Object.keys(items).length) return App.toast('Не найдена колонка «нм-код» или нет данных', 'err', 5000);
      await API.invoke('repricer:item-configs:save', { items });
      App.toast(`Импортировано настроек: ${Object.keys(items).length}`, 'ok');
      this.draw();
    };

    this.renderStrategies();
  },

  renderStrategies() {
    const rs = this.rstate;
    const defs = rs.defaults;
    const configs = rs.itemConfigs || {};
    const f = this.stFilter || {};
    let rows = S.getRows(true);
    if (f.cat) rows = rows.filter((r) => r.category === f.cat);
    if (f.strategy) rows = rows.filter((r) => String((configs[String(r.nmID)] || {}).strategy || defs.strategy) === f.strategy);
    if (f.onlySet) rows = rows.filter((r) => configs[String(r.nmID)]);
    const q = (f.q || '').toLowerCase();
    if (q) rows = rows.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode).toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q));

    this.stSelection = this.stSelection || new Set();
    const host = this.container.querySelector('#st-grid');
    host.innerHTML = '';
    // правки в этой вкладке тоже копятся: панель «Сохранить/Отменить» нужна и здесь
    this.drawEditBar();

    const inp = (r, field, value, step, w) => {
      const i = document.createElement('input');
      i.type = 'number'; i.step = step || 'any'; i.className = 'num cellinput';
      if (w) i.style.width = w;
      i.value = value === undefined || value === null ? '' : value;
      i.placeholder = '—';
      i.onclick = (e) => e.stopPropagation();
      // правка копится и применяется кнопкой «Сохранить» — один пересчёт на пачку
      i.onchange = () => {
        const patch = {};
        patch[field] = i.value === '' ? null : U.num(i.value);
        this.stageEdit(r.nmID, 'config', patch);
      };
      return i;
    };

    /**
     * Себестоимость и расходы товара правятся прямо в репрайсере — рядом со стратегией,
     * порогами и планом. Значения общие с разделом «Себестоимость»: сохраняется в costs.json,
     * поэтому экономика пересчитывается во всех разделах сразу.
     */
    const costInp = (r, field, step, w, title) => {
      const i = document.createElement('input');
      i.type = 'number'; i.step = step || 'any'; i.className = 'num cellinput';
      if (w) i.style.width = w;
      if (title) i.title = title;
      const cur = (S.state.costs || {})[String(r.nmID)] || {};
      const val = cur[field] !== undefined && cur[field] !== null ? cur[field] : (field === 'costPriceRub' ? r.costPrice : '');
      i.value = val === undefined || val === null || val === '' ? '' : val;
      i.placeholder = '—';
      i.onclick = (e) => e.stopPropagation();
      i.onchange = () => {
        const patch = {};
        patch[field] = i.value === '' ? null : U.num(i.value);
        this.stageEdit(r.nmID, 'cost', patch);
      };
      return i;
    };

    const sel = (r, value) => {
      const s = document.createElement('select');
      s.className = 'cellinput'; s.style.width = '170px';
      rs.strategies.forEach((x) => {
        const o = document.createElement('option');
        o.value = x.id; o.textContent = x.name;
        o.title = x.hint;
        if (String(value || defs.strategy) === x.id) o.selected = true;
        s.appendChild(o);
      });
      s.onclick = (e) => e.stopPropagation();
      s.onchange = () => { this.stageEdit(r.nmID, 'config', { strategy: s.value }); };
      return s;
    };

    const chk = (r, field, value) => {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = value === undefined ? !!defs[field] : !!value;
      c.onclick = (e) => {
        e.stopPropagation();
        this.stageEdit(r.nmID, 'config', { [field]: c.checked });
      };
      return c;
    };

    const grid = UI.table({
      columns: [
        { title: 'Товар', render: (r) => `<div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">${r.nmID} · ${U.esc(r.vendorCode)} · ${U.esc(r.category)}</span></div>` },
        { title: 'Стратегия', render: (r) => sel(r, (configs[String(r.nmID)] || {}).strategy) },
        { title: 'Цена сейчас', num: true, render: (r) => `${U.money(r.sellerPrice)}<div class="tiny muted">база ${U.money(r.basePrice)} · скидка ${U.pct(r.discount, 0)}</div>` },
        { title: 'Себестоимость', num: true, render: (r) => {
            const cell = U.el('<div></div>');
            cell.appendChild(costInp(r, 'costPriceRub', '1', '82px', 'Закупка/производство. Без неё репрайсер не предложит товар к отправке'));
            if (!U.num(r.costPrice)) {
              const warn = U.el('<div class="tiny neg" style="margin-top:2px">не задана</div>');
              cell.appendChild(warn);
            }
            return cell;
          } },
        { title: 'Упаковка', num: true, render: (r) => costInp(r, 'packagingRub', '1', '66px', 'Упаковка за единицу') },
        { title: 'Комиссия %', num: true, render: (r) => costInp(r, 'commissionPct', '0.1', '62px', 'Переопределяет факт из отчёта WB и справочник категории') },
        { title: 'Логистика ₽', num: true, render: (r) => costInp(r, 'logisticsRub', '0.01', '70px', 'Переопределяет факт из отчёта WB и формулу объёма') },
        { title: 'Мин. цена', num: true, render: (r) => inp(r, 'minPrice', (configs[String(r.nmID)] || {}).minPrice, '1', '82px') },
        { title: 'Целевая маржа %', num: true, render: (r) => inp(r, 'targetMarginPct', (configs[String(r.nmID)] || {}).targetMarginPct, '1', '66px') },
        { title: 'Мин. маржа %', num: true, render: (r) => inp(r, 'minMarginPct', (configs[String(r.nmID)] || {}).minMarginPct, '1', '66px') },
        { title: 'РРЦ', num: true, render: (r) => inp(r, 'rrp', (configs[String(r.nmID)] || {}).rrp, '1', '82px') },
        { title: 'План/мес, шт', num: true, render: (r) => inp(r, 'planQtyMonth', (configs[String(r.nmID)] || {}).planQtyMonth, '1', '70px') },
        { title: 'Оборач. цель, дн', num: true, render: (r) => inp(r, 'targetTurnoverDays', (configs[String(r.nmID)] || {}).targetTurnoverDays, '1', '62px') },
        { title: 'Защита OOS', center: true, render: (r) => chk(r, 'oosProtection', (configs[String(r.nmID)] || {}).oosProtection) },
        { title: 'Отр. маржа', center: true, render: (r) => chk(r, 'allowNegativeMargin', (configs[String(r.nmID)] || {}).allowNegativeMargin) },
        { title: 'Маржа сейчас', num: true, render: (r) => `<span class="${U.profitClass(r.margin)}">${U.pct(r.margin)}</span>` },
        { title: 'Остаток / дни', num: true, render: (r) => `${U.fmt(r.stock)}<div class="tiny muted">${r.turnoverDays >= 999 ? '∞' : Math.round(r.turnoverDays) + ' дн'}</div>` },
        { title: 'Конкурентов', num: true, render: (r) => {
            const n = ((rs.competitors || {})[String(r.nmID)] || []).filter((c) => c.enabled !== false).length;
            return n ? UI.badge(String(n), 'info') : '<span class="muted tiny">нет</span>';
          } },
        { title: '', render: (r) => `<button class="btn btn-xs btn-ghost" data-cfg="${r.nmID}" data-dirty-nm="${r.nmID}">настроить</button>` }
      ],
      rows: this.stPageOf(rows),
      tall: true,
      select: {
        get: (r) => this.stSelection.has(r.nmID),
        set: (r, v) => { if (v) this.stSelection.add(r.nmID); else this.stSelection.delete(r.nmID); },
        toggleAll: (l, v) => l.forEach((r) => { if (v) this.stSelection.add(r.nmID); else this.stSelection.delete(r.nmID); })
      },
      onSelect: () => this.renderStBulk(rows),
      empty: 'Ничего не найдено'
    });
    host.appendChild(grid.el);
    this.drawStPager();
    this.markDirtyRows();

    host.querySelectorAll('[data-cfg]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.openItemConfig(Number(b.dataset.cfg)); };
    });
    host.querySelectorAll('tbody tr').forEach((tr, i) => {
      const r = rows[i];
      if (r) tr.ondblclick = () => this.openItemConfig(r.nmID);
    });

    this.renderStBulk(rows);
  },

  renderStBulk(rows) {
    const bulk = this.container.querySelector('#st-bulk');
    if (!bulk) return;
    const ids = Array.from(this.stSelection || []);
    const rs = this.rstate;
    bulk.innerHTML = `
      <div class="fld"><span>Массово для</span><b>${ids.length ? ids.length : rows.length} тов.</b></div>
      <div class="fld"><span>Стратегия</span>
        <select id="sb-strategy" style="width:210px">${rs.strategies.map((s) => `<option value="${s.id}">${U.esc(s.name)}</option>`).join('')}</select></div>
      <div class="fld"><span>Целевая маржа %</span><input id="sb-margin" type="number" class="num" style="width:80px" value="${rs.defaults.targetMarginPct}" /></div>
      <div class="fld"><span>Мин. маржа %</span><input id="sb-minmargin" type="number" class="num" style="width:80px" value="${rs.defaults.minMarginPct}" /></div>
      <div class="fld"><span>Мин. цена</span>
        <select id="sb-minmode" style="width:250px">
          <option value="">не менять</option>
          <option value="breakeven">= цена безубыточности</option>
          <option value="margin">= цена под мин. маржу</option>
          <option value="pct">= % от текущей цены</option>
        </select></div>
      <div class="fld"><span>Значение</span><input id="sb-minval" type="number" class="num" style="width:80px" value="80" /></div>
      <div class="grow"></div>
      <button class="btn btn-primary" id="sb-apply">Применить</button>
    `;
    bulk.querySelector('#sb-apply').onclick = async () => {
      const targets = ids.length ? rows.filter((r) => this.stSelection.has(r.nmID)) : rows;
      if (!targets.length) return App.toast('Нет товаров', 'warn');
      const strategy = bulk.querySelector('#sb-strategy').value;
      const margin = U.num(bulk.querySelector('#sb-margin').value);
      const minMargin = U.num(bulk.querySelector('#sb-minmargin').value);
      const minMode = bulk.querySelector('#sb-minmode').value;
      const minVal = U.num(bulk.querySelector('#sb-minval').value);

      const patch = {};
      targets.forEach((r) => {
        const c = Object.assign({}, rs.itemConfigs[String(r.nmID)] || {}, { strategy, targetMarginPct: margin, minMarginPct: minMargin });
        if (minMode === 'breakeven' && r.breakEven) c.minPrice = Math.ceil(r.breakEven);
        else if (minMode === 'margin' && r.minPriceTarget) c.minPrice = Math.ceil(r.minPriceTarget);
        else if (minMode === 'pct') c.minPrice = Math.ceil(r.sellerPrice * minVal / 100);
        patch[String(r.nmID)] = c;
      });
      await API.invoke('repricer:item-configs:save', { items: patch });
      this.rstate = await API.invoke('repricer:state');
      App.toast(`Настройки применены к ${targets.length} товарам`, 'ok');
      this.renderStrategies();
    };
  },

  /** Полная карточка настроек артикула (аналог «Расширенных настроек»). */
  openItemConfig(nmID) {
    const rs = this.rstate;
    const defs = rs.defaults;
    const r = S.getRows().find((x) => x.nmID === nmID);
    if (!r) return;
    const c = Object.assign({}, defs, rs.itemConfigs[String(nmID)] || {});
    const comps = (rs.competitors || {})[String(nmID)] || [];

    const body = U.el('div');
    const fld = (id, label, value, hint, step) => `
      <label class="field">${label}
        <input type="number" step="${step || 'any'}" class="num" id="ic-${id}" value="${value === undefined || value === null ? '' : value}" placeholder="${hint || ''}" />
      </label>`;

    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">
        ${UI.badge('нм-код ' + nmID)} ${UI.badge(r.vendorCode)} ${UI.badge(r.category)}
        ${UI.badge('цена ' + U.money(r.sellerPrice))} ${UI.badge('маржа ' + U.pct(r.margin), r.margin < 0 ? 'danger' : 'ok')}
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>Стратегия и пороги</h3>
          <label class="field">Стратегия ценообразования
            <select id="ic-strategy">${rs.strategies.map((s) => `<option value="${s.id}" ${c.strategy === s.id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}</select>
          </label>
          <div class="alert hint" id="ic-hint" style="margin:8px 0"></div>
          <div class="grid g2" style="gap:10px">
            ${fld('minPrice', 'Минимальная цена, ₽', c.minPrice, 'пол коридора')}
            ${fld('basePriceTarget', 'Базовая цена (потолок), ₽', c.basePriceTarget || r.basePrice, 'потолок коридора')}
            ${fld('targetMarginPct', 'Целевая маржа, %', c.targetMarginPct, '', '0.5')}
            ${fld('targetMarginRub', 'Целевая маржа, ₽', c.targetMarginRub, 'прибыль с единицы вне акции', '1')}
            ${fld('minMarginPct', 'Минимальная маржа, %', c.minMarginPct, '', '0.5')}
            ${fld('minMarginRub', 'Минимальная маржа, ₽', c.minMarginRub, 'пол по прибыли', '1')}
            ${fld('maxPrice', 'Максимальная цена, ₽', c.maxPrice, 'жёсткий потолок', '1')}
            ${fld('maxMarginPct', 'Максимальная маржа, %', c.maxMarginPct, 'потолок по марже', '0.5')}
            ${fld('maxMarginRub', 'Максимальная маржа, ₽', c.maxMarginRub, 'потолок по прибыли', '1')}
            ${fld('rrp', 'РРЦ (цена для покупателя), ₽', c.rrp, 'для стратегии «Удержание РРЦ»')}
            ${fld('targetDiscountPct', 'Целевая скидка, %', c.targetDiscountPct, 'если нужно держать скидку витрины')}
          </div>
          <label class="checkline" style="margin-top:10px"><input type="checkbox" id="ic-allowNeg" ${c.allowNegativeMargin ? 'checked' : ''} /> Разрешить отрицательную маржу (но не ниже минимальной цены)</label>
        </div>
        <div class="card">
          <h3>Логика и ДЦО</h3>
          <div class="grid g2" style="gap:10px">
            ${fld('planQtyMonth', 'План продаж на месяц, шт', c.planQtyMonth, 'для «План-факт»')}
            ${fld('planSensitivityPct', 'Чувствительность план-факта, %', c.planSensitivityPct || 8, '', '1')}
            ${fld('targetTurnoverDays', 'Целевая оборачиваемость, дн', c.targetTurnoverDays, 'для защиты от out-of-stock')}
            ${fld('oosUpliftPct', 'Макс. повышение при OOS, %', c.oosUpliftPct || 15, '', '1')}
            ${fld('promoUpliftPct', 'Повышение акционной цены, %', c.promoUpliftPct, '0 = выключено')}
            ${fld('liquidationTurnoverDays', 'Неликвид при оборачиваемости >, дн', c.liquidationTurnoverDays, '', '1')}
            ${fld('liquidationDiscountPct', 'Скидка на неликвид, %', c.liquidationDiscountPct, '', '1')}
            ${fld('elasticityPct', 'Эластичность спроса для AI, %', c.elasticityPct || 12, '', '1')}
          </div>
          <label class="checkline" style="margin-top:10px"><input type="checkbox" id="ic-oos" ${c.oosProtection ? 'checked' : ''} /> Защита от out-of-stock (верхнеуровневое ДЦО)</label>
          <div class="divider"></div>
          <h3>Красивая цена</h3>
          <div class="row wrap">
            <label class="checkline"><input type="checkbox" id="ic-bp" ${(c.beautifulPrice || {}).enabled ? 'checked' : ''} /> включить</label>
            <select id="ic-bp-ending" style="width:130px">
              ${[9, 90, 99, 5, 0].map((e) => `<option value="${e}" ${(c.beautifulPrice || {}).ending === e ? 'selected' : ''}>окончание …${e}</option>`).join('')}
            </select>
            <select id="ic-bp-mode" style="width:180px">
              ${[['nearest', 'Ближайшая'], ['down', 'Слегка вниз'], ['up', 'Слегка вверх'], ['maxdown', 'Максимум вниз'], ['maxup', 'Максимум вверх']]
                .map((m) => `<option value="${m[0]}" ${(c.beautifulPrice || {}).mode === m[0] ? 'selected' : ''}>${m[1]}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <h3>Конкуренты (${comps.length})</h3>
        ${comps.length ? `<table class="grid-table"><thead><tr><th>Продавец</th><th class="num">Цена</th><th class="num">Остаток</th><th class="num">Рейтинг</th><th>Учитывать</th><th>Обновлено</th></tr></thead>
          <tbody>${comps.map((x) => `<tr><td>${U.esc(x.name)}</td><td class="num">${U.money(x.price)}</td><td class="num">${U.fmt(x.stock)}</td>
            <td class="num">${U.num(x.rating).toFixed(1)}</td><td>${x.enabled === false ? 'нет' : '<b>да</b>'}</td><td class="tiny muted">${U.date(x.updatedAt, true)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="muted small">Конкуренты не заданы — добавьте их на вкладке «Конкуренты». Стратегия «Конкурентный приоритет» без них переключится на «По умолчанию».</div>'}
      </div>
      <div class="card" style="margin-top:12px">
        <h3>Прогноз цены при текущих настройках</h3>
        <div id="ic-preview">${UI.loading('Считаем…')}</div>
      </div>
    `;

    const hintEl = body.querySelector('#ic-hint');
    const setHint = () => {
      const s = rs.strategies.find((x) => x.id === body.querySelector('#ic-strategy').value);
      hintEl.textContent = s ? s.hint : '';
    };
    body.querySelector('#ic-strategy').onchange = () => { setHint(); preview(); };
    setHint();

    const collect = () => ({
      strategy: body.querySelector('#ic-strategy').value,
      minPrice: body.querySelector('#ic-minPrice').value === '' ? null : U.num(body.querySelector('#ic-minPrice').value),
      basePriceTarget: body.querySelector('#ic-basePriceTarget').value === '' ? null : U.num(body.querySelector('#ic-basePriceTarget').value),
      targetMarginPct: U.num(body.querySelector('#ic-targetMarginPct').value),
      minMarginPct: U.num(body.querySelector('#ic-minMarginPct').value),
      minMarginRub: body.querySelector('#ic-minMarginRub').value === '' ? null : U.num(body.querySelector('#ic-minMarginRub').value),
      maxPrice: body.querySelector('#ic-maxPrice').value === '' ? null : U.num(body.querySelector('#ic-maxPrice').value),
      maxMarginPct: body.querySelector('#ic-maxMarginPct').value === '' ? null : U.num(body.querySelector('#ic-maxMarginPct').value),
      maxMarginRub: body.querySelector('#ic-maxMarginRub').value === '' ? null : U.num(body.querySelector('#ic-maxMarginRub').value),
      rrp: body.querySelector('#ic-rrp').value === '' ? null : U.num(body.querySelector('#ic-rrp').value),
      targetDiscountPct: body.querySelector('#ic-targetDiscountPct').value === '' ? null : U.num(body.querySelector('#ic-targetDiscountPct').value),
      allowNegativeMargin: body.querySelector('#ic-allowNeg').checked,
      planQtyMonth: body.querySelector('#ic-planQtyMonth').value === '' ? null : U.num(body.querySelector('#ic-planQtyMonth').value),
      planSensitivityPct: U.num(body.querySelector('#ic-planSensitivityPct').value, 8),
      targetTurnoverDays: U.num(body.querySelector('#ic-targetTurnoverDays').value, defs.targetTurnoverDays),
      oosUpliftPct: U.num(body.querySelector('#ic-oosUpliftPct').value, 15),
      promoUpliftPct: U.num(body.querySelector('#ic-promoUpliftPct').value, 0),
      liquidationTurnoverDays: U.num(body.querySelector('#ic-liquidationTurnoverDays').value, defs.liquidationTurnoverDays),
      liquidationDiscountPct: U.num(body.querySelector('#ic-liquidationDiscountPct').value, 0),
      elasticityPct: U.num(body.querySelector('#ic-elasticityPct').value, 12),
      oosProtection: body.querySelector('#ic-oos').checked,
      beautifulPrice: {
        enabled: body.querySelector('#ic-bp').checked,
        ending: U.num(body.querySelector('#ic-bp-ending').value, 9),
        mode: body.querySelector('#ic-bp-mode').value
      }
    });

    function preview() {
      const cfg = RP.mergeConfig(rs.config);
      const ic = collect();
      const ov = S.state.overrides[String(nmID)] || {};
      const p = EC.resolveParams(S.state.settings, r.item, ov);
      const ctx = {
        nmID, vendorCode: r.vendorCode, title: r.title,
        basePrice: r.basePrice, discount: r.discount, sellerPrice: r.sellerPrice,
        sppPct: p.sppPct, stock: r.stock, salesPerDay: r.perDay, salesMonthQty: r.sales30,
        turnoverDays: r.turnoverDays, inPromo: !!r.item.inPromo,
        promoPrice: r.item.plannedPrice, competitors: comps, rrp: ic.rrp,
        priceDayStart: r.sellerPrice, econAt: (price) => EC.calcUnit(price, p), now: Date.now()
      };
      const res = RP.computeItem(ctx, cfg, RP.itemConfig(cfg.defaults, ic), EC);
      const pv = body.querySelector('#ic-preview');
      pv.innerHTML = `
        <div class="grid g4" style="margin-bottom:10px">
          <div class="stat"><span class="label">Цена сейчас</span><span class="value">${U.money(res.current.sellerPrice)}</span><span class="hint">маржа ${U.pct(res.current.marginPct)}</span></div>
          <div class="stat"><span class="label">Новая цена</span><span class="value">${U.money(res.proposed.sellerPrice)}</span><span class="hint">маржа ${U.pct(res.proposed.marginPct)}</span></div>
          <div class="stat"><span class="label">Изменение</span><span class="value ${U.profitClass(res.delta.abs)}">${U.signed(res.delta.pct, 1)}%</span><span class="hint">${U.signed(res.delta.abs)} ₽</span></div>
          <div class="stat"><span class="label">Прибыль/шт</span><span class="value ${U.profitClass(res.proposed.profit)}">${U.money(res.proposed.profit)}</span><span class="hint">было ${U.money(res.current.profit)}</span></div>
        </div>
        <table class="grid-table"><thead><tr><th>Слой</th><th>Правило</th><th class="num">Цена</th><th>Пояснение</th></tr></thead>
          <tbody>${res.layers.map((l) => `<tr><td>${UI.badge(l.layer, l.layer === 'ДЦО' ? 'warn' : 'accent')}</td><td><b>${U.esc(l.name)}</b></td><td class="num">${U.money(l.price)}</td><td class="tiny muted" style="white-space:normal">${U.esc(l.note || '')}</td></tr>`).join('')}</tbody></table>
        ${res.warnings.length ? `<div class="alert warn" style="margin-top:10px">${res.warnings.map(U.esc).join('<br>')}</div>` : ''}
      `;
    }

    body.querySelectorAll('input, select').forEach((i) => { i.oninput = U.debounce(preview, 250); i.onchange = preview; });
    preview();

    let resetting = false;
    const editor = UI.modal({
      title: `Настройки артикула — ${r.title}`, content: body, size: '',
      beforeClose: async (_modal, intent) => resetting || intent === 'discard' || LocalDrafts.commit({ scope: body, report: true }),
      buttons: [
        { label: 'Сбросить к общим', class: 'btn-ghost', keepOpen: true, onClick: async () => {
          LocalDrafts.discard('item-config-' + nmID);
          await API.invoke('repricer:item-configs:save', { items: { [String(nmID)]: null } });
          this.pendingEdits.delete(String(nmID));
          this.rstate = await API.invoke('repricer:state');
          resetting = true; await editor.close();
          this.openItemConfig(nmID); App.toast('Индивидуальные настройки удалены', 'ok');
        } },
        { label: 'Сохранить', class: 'btn-primary', onClick: async (modal) => { if (await LocalDrafts.commit({ scope: body, report: true })) await modal.close(); } },
        { label: 'Закрыть без сохранения', class: 'btn-ghost', closeIntent: 'discard', onClick: () => { LocalDrafts.discard('item-config-' + nmID); } }
      ]
    });
    LocalDrafts.bind(body, 'item-config-' + nmID, () => [{ channel: 'repricer:item-configs:save', payload: { items: { [String(nmID)]: collect() } } }]);
    body.querySelector('#ic-strategy').addEventListener('change', async (event) => {
      if (event.target.value === 'boost' && await editor.close()) { this.rstate = await API.invoke('repricer:state'); this.openStrategyEditor(nmID, 'boost'); }
    });
  },

  // ══════════════════════ ВКЛАДКА: КОНКУРЕНТЫ ══════════════════════

  async tabCompetitors(host) {
    const rs = this.rstate;
    const comps = rs.competitors || {};
    const rows = S.getRows(true);
    const withComps = rows.filter((r) => (comps[String(r.nmID)] || []).length);

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="alert warn">
          Официальный API Wildberries <b>не отдаёт цены конкурентов</b> в карточке — поэтому список конкурентов ведётся в приложении:
          вручную, импортом CSV или выгрузкой из вашего сервиса аналитики (MPStats, MarketGuru и т. п.).
          Репрайсер использует минимальную цену среди включённых конкурентов, у которых товар в наличии.
        </div>
        <div class="row wrap" style="margin-top:10px">
          <input id="cp-q" placeholder="Поиск товара" style="width:280px" />
          <label class="checkline"><input type="checkbox" id="cp-only" checked /> только товары с конкурентами</label>
          <div class="grow"></div>
          <button class="btn btn-sm" id="cp-template">Шаблон CSV</button>
          <button class="btn btn-sm" id="cp-import">Импорт CSV</button>
          <button class="btn btn-sm btn-ghost" id="cp-export">Экспорт CSV</button>
          ${rs.demo ? '<button class="btn btn-sm btn-ghost" id="cp-drift">Сымитировать изменение цен</button>' : ''}
        </div>
        <div class="row wrap" style="margin-top:10px">
          ${UI.badge('товаров с конкурентами: ' + withComps.length, 'info')}
          ${UI.badge('всего записей: ' + Object.values(comps).reduce((s, l) => s + l.length, 0))}
          <span id="cp-watch-status" class="hint">Автозапросы к витрине выключены: кнопка «С витрины» делает один разовый запрос.</span>
        </div>
      </div>
      <div id="cp-grid"></div>
    `;

    if (rs.demo) {
      host.querySelector('#cp-drift').onclick = async () => {
        const r = await API.invoke('repricer:competitors:drift', {});
        App.toast(`Изменено цен конкурентов: ${r.changed}`, 'ok');
        this.draw();
      };
    }

    host.querySelector('#cp-template').onclick = () => {
      const sample = rows.slice(0, 200).map((r) => ({
        'нм-код': r.nmID, 'Артикул': r.vendorCode, 'Название конкурента': 'ООО «Пример»',
        'Цена конкурента': Math.round(r.buyerPrice * 0.95), 'Остаток у конкурента': 10, 'Учитывать': 1
      }));
      API.exportCsv('competitors-template.csv', U.toCsv(sample));
      App.toast('Шаблон выгружен', 'ok');
    };

    host.querySelector('#cp-export').onclick = () => {
      const out = [];
      for (const [nm, list] of Object.entries(comps)) {
        const r = rows.find((x) => String(x.nmID) === nm);
        list.forEach((c) => out.push({
          'нм-код': nm, 'Артикул': r ? r.vendorCode : '', 'Название': r ? r.title : '',
          'Конкурент': c.name, 'Цена': c.price, 'Остаток': c.stock, 'Рейтинг': c.rating || '',
          'Учитывать': c.enabled === false ? 0 : 1, 'Обновлено': c.updatedAt || ''
        }));
      }
      API.exportCsv(`competitors-${new Date().toISOString().slice(0, 10)}.csv`, U.toCsv(out));
      App.toast(`Выгружено записей: ${out.length}`, 'ok');
    };

    host.querySelector('#cp-import').onclick = async () => {
      const text = await API.importCsv();
      if (!text) return;
      const parsed = U.parseCsv(text);
      const rowsIn = parsed.map((row) => {
        const get = (...names) => {
          for (const n of names) {
            const k = Object.keys(row).find((x) => x.toLowerCase().replace(/\s/g, '') === n.toLowerCase().replace(/\s/g, ''));
            if (k !== undefined && row[k] !== '') return row[k];
          }
          return undefined;
        };
        return {
          nmID: get('нм-код', 'nmid'),
          name: get('Название конкурента', 'Конкурент', 'Продавец', 'name'),
          price: get('Цена конкурента', 'Цена', 'price'),
          stock: get('Остаток у конкурента', 'Остаток', 'stock'),
          enabled: get('Учитывать', 'enabled')
        };
      }).filter((r) => r.nmID && r.price);
      if (!rowsIn.length) return App.toast('Не найдены колонки «нм-код» и «Цена»', 'err', 5000);
      // группируем: замена списка конкурентов по товару
      const items = {};
      rowsIn.forEach((r) => {
        const k = String(r.nmID);
        items[k] = items[k] || [];
        items[k].push({
          id: `${k}-c${items[k].length + 1}`,
          name: String(r.name || 'Конкурент'),
          price: U.num(r.price),
          stock: r.stock === undefined ? 1 : U.num(r.stock),
          enabled: r.enabled === undefined ? true : String(r.enabled) === '1',
          updatedAt: new Date().toISOString()
        });
      });
      const res = await API.invoke('repricer:competitors:save', { items });
      App.toast(`Загружено конкурентов для ${Object.keys(items).length} товаров`, 'ok');
      this.draw();
    };

    const drawGrid = () => {
      const q = (host.querySelector('#cp-q').value || '').toLowerCase();
      const only = host.querySelector('#cp-only').checked;
      let list = rows;
      if (only) list = list.filter((r) => (comps[String(r.nmID)] || []).length);
      if (q) list = list.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode).toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q));

      const gh = host.querySelector('#cp-grid');
      gh.innerHTML = '';
      const grid = UI.table({
        columns: [
          { title: 'Товар', cls: 'rp-product', render: (r) => {
            const item = this.itemsByNm.get(String(r.nmID)) || {};
            const raw = item.photo || item.photoUrl || (item.photos && item.photos[0]);
            const photo = typeof raw === 'string' ? raw : raw && (raw.small || raw.big);
            return `<div class="row">${photo && /^https:\/\//i.test(photo) ? `<img class="rp-photo" src="${U.esc(photo)}" loading="lazy" alt="" />` : '<span class="rp-photo muted" aria-label="Нет фото">▧</span>'}
              <div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">SKU ${r.nmID} · ${U.esc(r.vendorCode)}</span><span class="tiny muted">${U.esc(item.brand || 'Бренд не указан')}</span></div></div>`;
          } },
          { title: 'Ваша цена (покупателю)', num: true, render: (r) => U.money(r.buyerPrice) },
          { title: 'Конкурентов', num: true, render: (r) => (comps[String(r.nmID)] || []).length },
          { title: 'Мин. цена конкурента', num: true, render: (r) => {
              const list2 = (comps[String(r.nmID)] || []).filter((c) => c.enabled !== false && U.num(c.stock, 1) > 0);
              if (!list2.length) return '<span class="muted tiny">нет в наличии</span>';
              const min = list2.reduce((a, b) => (U.num(a.price) <= U.num(b.price) ? a : b));
              return `<b>${U.money(min.price)}</b> <span class="tiny muted">${U.esc(min.name)}</span>`;
            } },
          { title: 'Разрыв с рынком', num: true, render: (r) => {
              const list2 = (comps[String(r.nmID)] || []).filter((c) => c.enabled !== false && U.num(c.stock, 1) > 0);
              if (!list2.length) return '—';
              const min = Math.min.apply(null, list2.map((c) => U.num(c.price)));
              const diff = min > 0 ? ((r.buyerPrice - min) / min) * 100 : 0;
              return `<span class="${diff > 0 ? 'neg' : 'pos'}">${U.signed(diff, 1)}%</span>`;
            } },
          { title: 'Прибыль/шт', num: true, render: (r) => `<span class="${U.profitClass(r.profit)}">${U.money(r.profit)}</span>` },
          { title: '', render: (r) => `<span class="row wrap" style="gap:4px"><button class="btn btn-xs btn-ghost" data-cp="${r.nmID}">изменить</button><button class="btn btn-xs btn-ghost" data-watch="${r.nmID}" title="Обновить с витрины: разовый запрос к витрине WB — цена конкурента с учётом СПП">С витрины</button></span>` }
        ],
        rows: list.slice(0, 500),
        tall: true,
        empty: 'Нет товаров с конкурентами. Нажмите «Шаблон CSV», заполните и загрузите через «Импорт CSV».'
      });
      gh.appendChild(grid.el);
      gh.querySelectorAll('[data-cp]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); this.openCompetitors(Number(b.dataset.cp)); };
      });
      gh.querySelectorAll('[data-watch]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); this.refreshCompetitorFromShowcase(Number(b.dataset.watch), host); };
      });
    };

    host.querySelector('#cp-q').oninput = U.debounce(drawGrid, 220);
    host.querySelector('#cp-only').onchange = drawGrid;
    drawGrid();
  },

  /**
   * Один разовый запрос к витрине WB по товару (канал pricewatch:fetch, force).
   * Автозапросы не включаем: настройка priceWatchAutoFetch остаётся как была.
   * Если витрина отвечает 403/HTML или включён демо-режим, честно пишем
   * «заблокировано, введите вручную» — выдуманных цен не подставляем.
   */
  async refreshCompetitorFromShowcase(nmID, host) {
    const status = host && host.querySelector('#cp-watch-status');
    const say = (text, kind) => { if (status) status.innerHTML = UI.badge(text, kind || ''); };
    say('Запрашиваем витрину WB…', 'info');
    try {
      const res = await API.invoke('pricewatch:fetch', { nmIDs: [nmID], force: true });
      const first = ((res && res.results) || [])[0] || {};
      const blocked = !!first.code && first.code !== 'OK';
      if (!res || res.ok === false || blocked) {
        const why = (res && res.message) || first.message || (res && res.blocked ? 'доступ заблокирован (403/HTML)' : 'данные не получены');
        const text = 'заблокировано, введите вручную: ' + why;
        say(text, 'warn');
        App.toast('Витрина: ' + why + '. Введите цену конкурента вручную.', 'warn', 9000);
        return;
      }
      const price = U.num(first.shelfPrice || first.price);
      if (!(price > 0)) {
        say('витрина не вернула цену — введите вручную', 'warn');
        App.toast('Витрина не вернула цену — введите цену конкурента вручную', 'warn', 7000);
        return;
      }

      const key = String(nmID);
      const list = ((this.rstate.competitors || {})[key] || []).slice();
      const existing = list.find((c) => c && c.source === 'watch');
      if (existing) {
        existing.price = price;
        existing.stock = 1;
        existing.enabled = true;
        existing.updatedAt = new Date().toISOString();
      } else {
        list.push({
          id: key + '-watch', name: 'Витрина WB', price, stock: 1,
          enabled: true, source: 'watch', updatedAt: new Date().toISOString()
        });
      }
      await API.invoke('repricer:competitors:save', { items: { [key]: list } });
      this.rstate = await API.invoke('repricer:state');
      say('витрина: ' + U.money(price) + ' — конкурент обновлён', 'ok');
      App.toast('Цена с витрины: ' + U.money(price) + ' — сохранена в конкурентах', 'ok', 6000);
      this.draw();
    } catch (e) {
      say('заблокировано, введите вручную: ' + e.message, 'warn');
      App.toast('Витрина недоступна (' + e.message + '). Введите цену конкурента вручную.', 'warn', 9000);
    }
  },

  openCompetitors(nmID) {
    const rs = this.rstate;
    const comps = ((rs.competitors || {})[String(nmID)] || []).slice();
    const r = S.getRows().find((x) => x.nmID === nmID);
    const body = U.el('div');
    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:10px">${UI.badge('нм-код ' + nmID)} ${UI.badge(r ? r.vendorCode : '')} ${UI.badge('ваша цена ' + U.money(r ? r.buyerPrice : 0))}</div>
      <div id="cp-list"></div>
      <div class="divider"></div>
      <h3>Добавить конкурента</h3>
      <div class="row wrap">
        <input id="cp-name" placeholder="Название продавца" style="width:240px" />
        <input id="cp-price" type="number" class="num" placeholder="Цена, ₽" style="width:120px" />
        <input id="cp-stock" type="number" class="num" placeholder="Остаток" style="width:110px" value="10" />
        <button class="btn btn-primary btn-sm" id="cp-add">Добавить</button>
      </div>
    `;
    const drawList = () => {
      const l = body.querySelector('#cp-list');
      if (!comps.length) { l.innerHTML = '<div class="muted small">Конкурентов нет</div>'; return; }
      l.innerHTML = `<table class="grid-table"><thead><tr><th>Продавец</th><th class="num">Цена</th><th class="num">Остаток</th><th>Учитывать</th><th></th></tr></thead>
        <tbody>${comps.map((c, i) => `<tr>
          <td><input class="cellinput" style="width:200px" data-i="${i}" data-f="name" value="${U.esc(c.name)}" /></td>
          <td class="num"><input type="number" class="num cellinput" data-i="${i}" data-f="price" value="${c.price}" /></td>
          <td class="num"><input type="number" class="num cellinput" data-i="${i}" data-f="stock" value="${c.stock === undefined ? 1 : c.stock}" /></td>
          <td class="center"><input type="checkbox" data-i="${i}" data-f="enabled" ${c.enabled === false ? '' : 'checked'} /></td>
          <td><button class="btn btn-xs btn-danger" data-del="${i}">удалить</button></td>
        </tr>`).join('')}</tbody></table>`;
      l.querySelectorAll('input').forEach((inp) => {
        inp.onchange = () => {
          const i = Number(inp.dataset.i); const f = inp.dataset.f;
          comps[i][f] = inp.type === 'checkbox' ? inp.checked : (f === 'name' ? inp.value : U.num(inp.value));
          comps[i].updatedAt = new Date().toISOString();
        };
      });
      l.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => { comps.splice(Number(b.dataset.del), 1); drawList(); };
      });
    };
    drawList();

    body.querySelector('#cp-add').onclick = () => {
      const name = body.querySelector('#cp-name').value.trim();
      const price = U.num(body.querySelector('#cp-price').value);
      if (!name || !price) return App.toast('Укажите название и цену', 'warn');
      comps.push({ id: `${nmID}-c${comps.length + 1}-${Date.now() % 100000}`, name, price, stock: U.num(body.querySelector('#cp-stock').value, 1), enabled: true, updatedAt: new Date().toISOString() });
      body.querySelector('#cp-name').value = ''; body.querySelector('#cp-price').value = '';
      drawList();
    };

    let competitorsSaved = false;
    UI.modal({
      title: `Конкуренты — ${r ? r.title : nmID}`, content: body, size: 'md',
      beforeClose: async (_modal, intent) => {
        if (competitorsSaved || intent === 'discard') return true;
        // Учитываем последнее введённое значение даже без потери фокуса и применяем его локально при закрытии.
        body.querySelectorAll('#cp-list input').forEach((input) => input.onchange && input.onchange());
        if (comps.some((c) => !(Number(c.price) > 0) || Number(c.stock) < 0)) { App.toast('Цена конкурента должна быть больше 0, остаток — неотрицательным.', 'warn'); return false; }
        LocalDrafts.stage('competitors-' + nmID, [{ channel: 'repricer:competitors:save', payload: { items: { [String(nmID)]: comps } } }]);
        if (!await LocalDrafts.commit({ id: 'competitors-' + nmID })) return false;
        competitorsSaved = true; this.rstate = await API.invoke('repricer:state');
        return true;
      },
      buttons: [{ label: 'Сохранить и закрыть', class: 'btn-primary', onClick: async (modal) => {
        body.querySelectorAll('#cp-list input').forEach((input) => input.onchange && input.onchange());
        if (comps.some((c) => !(Number(c.price) > 0) || Number(c.stock) < 0)) { App.toast('Цена конкурента должна быть больше 0, остаток — неотрицательным.', 'warn'); return false; }
        LocalDrafts.stage('competitors-' + nmID, [{ channel: 'repricer:competitors:save', payload: { items: { [String(nmID)]: comps } } }]);
        if (!await LocalDrafts.commit({ id: 'competitors-' + nmID })) return false;
        competitorsSaved = true; this.rstate = await API.invoke('repricer:state'); await modal.close();
      } }, { label: 'Закрыть без сохранения', class: 'btn-ghost', closeIntent: 'discard' }]
    });
  },

  // ══════════════════════ ВКЛАДКА: РАСПИСАНИЕ ══════════════════════

  /**
   * Расписание пересчёта и отправки: интервал, двухфазный цикл, задержка отправки,
   * автоотправка. Сохраняется существующим каналом repricer:save. Здесь же —
   * история запусков, которая раньше была отдельной вкладкой.
   */
  async tabSchedule(host) {
    const rs = this.rstate;
    const c = rs.config;
    const sched = rs.scheduler || {};
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <h2 style="margin:0">Расписание</h2>
          <span class="hint">${sched.enabled && sched.nextRunAt ? 'Следующий пересчёт: <b>' + U.date(sched.nextRunAt, true) + '</b>' : 'Планировщик выключен'}</span>
        </div>
        <p class="hint">Расписание применяется ко всем товарам. Параметры маржинальности, лимитов и коридора — на вкладке «Параметры».</p>
        <label class="checkline" style="margin-top:10px"><input type="checkbox" id="ps-enabled" ${c.enabled ? 'checked' : ''} />
          <b>Планировщик РП</b></label>
        <div class="grid g3" style="gap:10px;margin-top:10px">
          <label class="field">Как часто пересчитывать
            <select id="ps-mode">
              ${opt('hourly', c.schedule.mode, 'Ежечасно (рекомендуется)')}
              ${opt('interval', c.schedule.mode, 'Каждые N минут')}
              ${opt('daily', c.schedule.mode, 'Раз в сутки в выбранный час')}
            </select>
          </label>
          <label class="field">Интервал, минут
            <input type="number" class="num" id="ps-interval" value="${c.schedule.intervalMinutes}" min="5" max="1440" /></label>
          <label class="field">Час пересчёта (для «раз в сутки»)
            <input type="number" class="num" id="ps-hour" value="${c.schedule.hourOfDay}" min="0" max="23" /></label>
          <label class="field">Через сколько отправлять предложение, мин
            <input type="number" class="num" id="ps-senddelay" value="${U.num(c.schedule.sendDelayMinutes, 40)}" min="1" max="1440" /></label>
        </div>
        <label class="checkline" style="margin-top:12px"><input type="checkbox" id="ps-twophase" ${c.schedule.twoPhase !== false ? 'checked' : ''} />
          <b>Двухфазный цикл: сначала показать предложение, потом отправить</b></label>
        <label class="checkline" style="margin-top:8px"><input type="checkbox" id="ps-autosend" ${c.schedule.autoSend ? 'checked' : ''} />
          <b>Автоматически отправлять предложение в WB</b> (без подтверждения, по расписанию фазы 2)</label>
        <p class="hint" style="margin-top:6px">Сначала лучше держать автоотправку выключенной: репрайсер считает цены и показывает
          предложение, а цены уходят в WB вручную из вкладки «Товары». Если двухфазный цикл выключить,
          автоотправка уйдёт в WB сразу после пересчёта — как раньше.</p>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn btn-primary" id="ps-save">Сохранить расписание</button>
          <span class="hint">Сохранение — существующим каналом repricer:save.</span>
        </div>
      </div>
      <div id="ps-runs-host"></div>
    `;

    const $ = (id) => host.querySelector(id);
    $('#ps-save').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Сохраняем…';
      try {
        await API.invoke('repricer:save', {
          enabled: $('#ps-enabled').checked,
          schedule: {
            mode: $('#ps-mode').value,
            intervalMinutes: U.num($('#ps-interval').value, 60),
            hourOfDay: U.num($('#ps-hour').value, 9),
            twoPhase: $('#ps-twophase').checked,
            autoSend: $('#ps-autosend').checked,
            sendDelayMinutes: U.num($('#ps-senddelay').value, 40),
            sendIntervalMinutes: 0
          }
        });
        this.rstate = await API.invoke('repricer:state');
        App.toast('Расписание сохранено', 'ok', 4000);
        this.draw();
      } catch (err) {
        App.toast(err.message, 'err', 7000);
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    await this.tabRuns(host.querySelector('#ps-runs-host'));
  },

  // ══════════════════════ ВКЛАДКА: ПАРАМЕТРЫ ══════════════════════

  async tabParams(host) {
    const rs = this.rstate;
    const c = rs.config;
    const d = c.defaults;

    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
    // курсы валют себестоимости и название магазина живут в настройках приложения,
    // а не в параметрах репрайсера (сохраняются каналом settings:save)
    const sett = S.state.settings || {};
    const rates = sett.costRates || {};
    const KNOWN = ['CNY', 'USD', 'EUR', 'TRY', 'KZT', 'BYN', 'UZS', 'AED', 'PLN', 'GEL', 'KRW', 'VND'];
    const rateCodes = Array.from(new Set(KNOWN.concat(Object.keys(rates))));

    host.innerHTML = `
      <div class="grid g2">
        <div class="col">
          <div class="card">
            <h2>Главное</h2>
            <div class="grid g2" style="gap:10px">
              <label class="field">Режим расчёта маржинальности
                <select id="pm-marginmode">
                  ${opt('discounted', c.marginMode, 'От цены со скидкой (до СПП) — рекомендуется')}
                  ${opt('forpay', c.marginMode, 'От суммы ForPay (к перечислению)')}
                  ${opt('wallet', c.marginMode, 'От цены с СПП + WB-кошелёк')}
                </select>
              </label>
              <label class="field">Скидка WB-кошелька, %<input type="number" class="num" id="pm-wallet" value="${c.priceEdit.walletPct}" step="0.5" /></label>
              <label class="field">Цены размеров по умолчанию
                <select id="pm-sizemode">
                  ${opt('none', c.sizePriceMode, 'Не трогать (общая цена с подтверждением)')}
                  ${opt('sync', c.sizePriceMode, 'Синхрон — одна цена всем размерам')}
                  ${opt('manual', c.sizePriceMode, 'Ручные цены размеров')}
                </select>
              </label>
            </div>

            <div class="alert info" style="margin-top:12px">
              Расписание пересчёта, двухфазный цикл, задержка и автоотправка переехали на вкладку
              <b>«Расписание»</b> — там же история запусков.
            </div>
          </div>

          <div class="card">
            <h2>Цены</h2>
            <div class="grid g2" style="gap:10px">
              <label class="field">Репрайсер может менять цену до скидки
                <select id="pm-baseprice">
                  ${opt('allow', c.priceEdit.canChangeBasePrice, 'Разрешить (цена «рубль в рубль»)')}
                  ${opt('forbid', c.priceEdit.canChangeBasePrice, 'Запретить (только скидкой)')}
                  ${opt('ifNoOtherWay', c.priceEdit.canChangeBasePrice, 'Если нет другого способа')}
                </select>
              </label>
              <label class="field">Шаг изменения скидки к целевой, п.п.
                <input type="number" class="num" id="pm-discstep" value="${c.limits.discountStepPct}" min="0" max="50" step="1" />
              </label>
            </div>
            <label class="checkline" style="margin-top:10px"><input type="checkbox" id="pm-canceldisc" ${c.priceEdit.canCancelDiscount ? 'checked' : ''} />
              Репрайсер может отменять скидки (устанавливать скидку 0%)</label>
            <p class="hint" style="margin-top:6px">При запрете смены цены до скидки репрайсер управляет только процентом скидки — шаг изменения получается целым процентом.
              Это ограничение Wildberries: цена «рубль в рубль» достижима только при разрешении менять цену до скидки.</p>
          </div>

          <div class="card">
            <h2>Себестоимость и курсы валют</h2>
            <label class="field">Название магазина
              <input type="text" id="pm-shopname" maxlength="60" value="${U.esc(sett.shopName || '')}"
                placeholder="например, ИП Иванов · товары для дома" /></label>
            <p class="hint">Показывается в шапке репрайсера и попадает в выгрузку — удобно, когда кабинетов несколько.</p>
            <h3 style="margin-top:14px">Налоги и взносы этого кабинета</h3>
            <div class="grid g2" style="gap:10px">
              <label class="field">Налоговый режим<select id="pm-taxmode">${EC.TAX_MODES.map((mode) => `<option value="${mode.id}" ${sett.taxMode === mode.id ? 'selected' : ''}>${U.esc(mode.label)}</option>`).join('')}</select></label>
              <label class="field">Доходный налог / расчётная нагрузка, %<input id="pm-taxrate" type="number" min="0" max="100" step="0.01" value="${sett.taxRate}"></label>
              ${TaxUI.fields('pm', sett)}
            </div>
            <p class="hint" style="margin-top:8px">Сама себестоимость задаётся <b>прямо в таблице цен</b> (колонка «Себестоимость»,
              блок «Себестоимость и экономика»), там же выбирается валюта закупки.
              Ниже — курсы: сколько ₽ стоит 1 единица валюты. Без курса валюта считается незаданной:
              строка получает явную ошибку и в WB не отправляется.</p>
            <div class="grid g3" style="gap:10px;margin-top:8px" id="pm-rates">
              ${rateCodes.map((code) => `<label class="field">1 ${U.esc(code)} = … ₽
                  <input type="number" class="num" data-rate="${U.esc(code)}" min="0" step="0.0001"
                    value="${U.num(rates[code]) || ''}" placeholder="курс не задан" /></label>`).join('')}
            </div>
            <div class="row wrap" style="gap:8px;margin-top:10px;align-items:flex-end">
              <label class="field" style="width:170px">Своя валюта (код, 3 буквы)
                <input type="text" id="pm-rate-code" maxlength="3" placeholder="например, GEL" /></label>
              <button class="btn btn-sm" id="pm-rate-add">Добавить валюту</button>
              <span class="hint">Для ₽ курс не нужен: себестоимость в рублях берётся как есть.</span>
            </div>
          </div>
        </div>

        <div class="col">
          <div class="card">
            <h2>Ограничения (защита)</h2>
            <div class="grid g2" style="gap:10px">
              <label class="field">Макс. изменение цены за одно обновление, %
                <input type="number" class="num" id="pm-step" value="${c.limits.maxChangePerUpdatePct}" min="0" max="90" step="1" /></label>
              <label class="field">Макс. изменение цены за сутки, % (0 = без лимита)
                <input type="number" class="num" id="pm-day" value="${c.limits.maxChangePerDayPct}" min="0" max="90" step="1" /></label>
            </div>
            <div class="alert warn" style="margin-top:10px">Рекомендуемое значение — <b>19%</b>. При большем шаге карточка товара может быть
              скрыта с продажи службой безопасности Wildberries. Суточный лимит должен быть равен лимиту за обновление или больше.</div>
            <div class="col" style="margin-top:10px">
              <label class="checkline"><input type="checkbox" id="pm-ignorestep" ${c.limits.ignoreStepIfBelowMin ? 'checked' : ''} />
                Игнорировать лимит шага, если текущая цена ниже минимального порога</label>
              <label class="checkline"><input type="checkbox" id="pm-quarantine" ${c.limits.blockQuarantine ? 'checked' : ''} />
                Блокировать цены, которые WB отправит в карантин (падение более чем в 3 раза)</label>
            </div>
          </div>

          <div class="card">
            <h2>Акции</h2>
            <div class="col">
              <label class="checkline"><input type="checkbox" id="pm-promospp" ${c.promo.useForecastSpp ? 'checked' : ''} />
                Использовать прогнозную СПП для акций (автоматический вход)</label>
              <label class="checkline"><input type="checkbox" id="pm-promolimit" ${c.promo.ignoreChangeLimitOnEntry ? 'checked' : ''} />
                Игнорировать лимит изменения цены при входе в акцию</label>
              <label class="checkline"><input type="checkbox" id="pm-autoexit" ${c.promo.autoExitAutoPromos ? 'checked' : ''} />
                Автоматически выходить из авто-акций WB</label>
              <label class="checkline"><input type="checkbox" id="pm-autoexit-manual" ${c.promo.autoExitManualPromos ? 'checked' : ''} />
                Автоматически выходить из обычных (не авто) акций</label>
              <label class="checkline"><input type="checkbox" id="pm-autojoin" ${c.promo.autoJoin ? 'checked' : ''} />
                Автоматически входить в выгодные акции (иначе только рекомендации)</label>
              <label class="checkline"><input type="checkbox" id="pm-restore" ${c.promo.restorePriceAfterExit !== false ? 'checked' : ''} />
                Возвращать рабочую цену после выхода из акции</label>
              <label class="checkline"><input type="checkbox" id="pm-holdauto" ${c.promo.restoreAfterAutoPromoEnds !== false ? 'checked' : ''} />
                Держать цену повышенной до конца авто-акции (иначе WB вернёт товар обратно)</label>
              <div class="grid g3" style="gap:10px">
                <label class="field">Минимальная маржа в акции, % (пусто = целевая маржа товара)
                  <input type="number" class="num" id="pm-promomargin" value="${c.promo.minMarginInPromoPct === null || c.promo.minMarginInPromoPct === undefined ? '' : c.promo.minMarginInPromoPct}" step="0.5" /></label>
                <label class="field">Запас выше плановой цены при выходе, %
                  <input type="number" class="num" id="pm-exitbuffer" value="${U.num(c.promo.exitBufferPct, 2)}" step="0.5" min="0" max="30" /></label>
                <label class="field">Планировать вход за N дней до старта акции
                  <input type="number" class="num" id="pm-joinlead" value="${U.num(c.promo.joinLeadDays, 45)}" step="1" min="0" max="365" /></label>
              </div>
              <label class="field">Ожидаемый прирост продаж в акции, % (для оценки окупаемости входа)
                <input type="number" class="num" id="pm-uplift" value="${U.num(c.promo.expectedSalesUpliftPct, 30)}" step="5" min="0" max="500" /></label>
              <p class="hint">Вход в акцию снижает прибыль с единицы, поэтому приложение считает <b>точку окупаемости</b>:
              «вход окупится, если продажи вырастут хотя бы на N%». Если ожидаемый прирост больше — вход помечается выгодным.
              WB API не отдаёт прогноз продаж в акции, так что это ваша оценка по прошлому опыту похожих акций.</p>
              <p class="hint">Выход из акции выполняется снижением скидки ниже порога акции: плановая цена WB считается
              от базовой цены, поэтому простое повышение цены не выводит товар из акции. API исключить товар не даёт —
              ни для обычных акций, ни для авто-акций.</p>
            </div>
          </div>

          <div class="card">
            <h2>Значения по умолчанию для новых товаров</h2>
            <div class="grid g2" style="gap:10px">
              <label class="field">Стратегия
                <select id="pm-defstrategy">${rs.strategies.map((s) => opt(s.id, d.strategy, s.name)).join('')}</select></label>
              <label class="field">Целевая маржа, %<input type="number" class="num" id="pm-defmargin" value="${d.targetMarginPct}" step="0.5" /></label>
              <label class="field">Минимальная маржа, %<input type="number" class="num" id="pm-defminmargin" value="${d.minMarginPct}" step="0.5" /></label>
              <label class="field">Целевая оборачиваемость, дн<input type="number" class="num" id="pm-defturn" value="${d.targetTurnoverDays}" step="1" /></label>
              <label class="field">Повышение акционной цены, %<input type="number" class="num" id="pm-defuplift" value="${d.promoUpliftPct}" step="1" /></label>
              <label class="field">Неликвид при оборачиваемости >, дн<input type="number" class="num" id="pm-defliq" value="${d.liquidationTurnoverDays}" step="1" /></label>
            </div>
            <div class="row wrap" style="margin-top:10px">
              <label class="checkline"><input type="checkbox" id="pm-defoos" ${d.oosProtection ? 'checked' : ''} /> Защита от out-of-stock</label>
              <label class="checkline"><input type="checkbox" id="pm-defneg" ${d.allowNegativeMargin ? 'checked' : ''} /> Разрешить отрицательную маржу</label>
              <label class="checkline"><input type="checkbox" id="pm-defbp" ${d.beautifulPrice.enabled ? 'checked' : ''} /> Красивая цена</label>
              <select id="pm-defbpend" style="width:150px">${[9, 90, 99, 5, 0].map((e) => opt(e, d.beautifulPrice.ending, 'окончание …' + e)).join('')}</select>
              <select id="pm-defbpmode" style="width:170px">
                ${opt('nearest', d.beautifulPrice.mode, 'Ближайшая')}${opt('down', d.beautifulPrice.mode, 'Слегка вниз')}
                ${opt('up', d.beautifulPrice.mode, 'Слегка вверх')}${opt('maxdown', d.beautifulPrice.mode, 'Максимум вниз')}${opt('maxup', d.beautifulPrice.mode, 'Максимум вверх')}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="row wrap" style="margin-top:14px">
        <button class="btn btn-primary" id="pm-save">Сохранить параметры</button>
        <button class="btn btn-ghost" id="pm-reset">Сбросить к рекомендуемым</button>
        <span class="hint">Параметры применяются ко всем товарам, у которых нет индивидуальных настроек.</span>
      </div>
    `;

    TaxUI.bind('pm', sett, host);
    host.querySelector('#pm-save').onclick = async () => {
      const saveButton = host.querySelector('#pm-save'); saveButton.disabled = true;
      try {
      const patch = {
        marginMode: host.querySelector('#pm-marginmode').value,
        sizePriceMode: host.querySelector('#pm-sizemode').value,
        priceEdit: {
          canChangeBasePrice: host.querySelector('#pm-baseprice').value,
          canCancelDiscount: host.querySelector('#pm-canceldisc').checked,
          walletPct: U.num(host.querySelector('#pm-wallet').value),
          targetDiscountStep: U.num(host.querySelector('#pm-discstep').value)
        },
        limits: {
          maxChangePerUpdatePct: U.num(host.querySelector('#pm-step').value, 19),
          maxChangePerDayPct: U.num(host.querySelector('#pm-day').value, 0),
          ignoreStepIfBelowMin: host.querySelector('#pm-ignorestep').checked,
          discountStepPct: U.num(host.querySelector('#pm-discstep').value),
          blockQuarantine: host.querySelector('#pm-quarantine').checked
        },
        promo: {
          useForecastSpp: host.querySelector('#pm-promospp').checked,
          ignoreChangeLimitOnEntry: host.querySelector('#pm-promolimit').checked,
          autoExitAutoPromos: host.querySelector('#pm-autoexit').checked,
          autoExitManualPromos: host.querySelector('#pm-autoexit-manual').checked,
          autoJoin: host.querySelector('#pm-autojoin').checked,
          restorePriceAfterExit: host.querySelector('#pm-restore').checked,
          restoreAfterAutoPromoEnds: host.querySelector('#pm-holdauto').checked,
          exitBufferPct: U.num(host.querySelector('#pm-exitbuffer').value, 2),
          joinLeadDays: U.num(host.querySelector('#pm-joinlead').value, 45),
          expectedSalesUpliftPct: U.num(host.querySelector('#pm-uplift').value, 30),
          minMarginInPromoPct: host.querySelector('#pm-promomargin').value === '' ? null : U.num(host.querySelector('#pm-promomargin').value)
        },
        defaults: {
          strategy: host.querySelector('#pm-defstrategy').value,
          targetMarginPct: U.num(host.querySelector('#pm-defmargin').value, 20),
          minMarginPct: U.num(host.querySelector('#pm-defminmargin').value, 0),
          targetTurnoverDays: U.num(host.querySelector('#pm-defturn').value, 7),
          promoUpliftPct: U.num(host.querySelector('#pm-defuplift').value, 0),
          liquidationTurnoverDays: U.num(host.querySelector('#pm-defliq').value, 60),
          oosProtection: host.querySelector('#pm-defoos').checked,
          allowNegativeMargin: host.querySelector('#pm-defneg').checked,
          beautifulPrice: {
            enabled: host.querySelector('#pm-defbp').checked,
            ending: U.num(host.querySelector('#pm-defbpend').value, 9),
            mode: host.querySelector('#pm-defbpmode').value
          }
        }
      };
      /**
       * Курсы валют и название магазина — настройки приложения, поэтому сохраняются
       * своим каналом рядом с параметрами репрайсера: себестоимость правится в таблице
       * цен, а курс — здесь же, на одном экране (задание D).
       */
      const newRates = {};
      host.querySelectorAll('#pm-rates [data-rate]').forEach((inp) => {
        const code = String(inp.getAttribute('data-rate') || '').trim().toUpperCase();
        const v = U.num(inp.value);
        if (code && code !== 'RUB' && v > 0) newRates[code] = v;
      });
      const shopName = String(host.querySelector('#pm-shopname').value || '').trim();
      S.state.settings = await API.invoke('settings:save', { costRates: newRates, shopName, ...TaxUI.read('pm', host) });
      S.invalidate();

      const res = await API.invoke('repricer:save', patch);
      if (res.config.limits.maxChangePerDayPct !== patch.limits.maxChangePerDayPct) {
        App.toast('Суточный лимит увеличен до лимита за обновление (' + res.config.limits.maxChangePerDayPct + '%)', 'warn', 5000);
      } else App.toast('Параметры сохранены, валют с курсом: ' + Object.keys(newRates).length, 'ok', 5000);
      this.rstate = await API.invoke('repricer:state');
      this.draw();
      } catch (error) { App.toast(error.message, 'err', 8000); }
      finally { if (saveButton.isConnected) saveButton.disabled = false; }
    };

    /** Своя валюта: добавляем поле курса, значение уйдёт в настройки вместе с остальными. */
    host.querySelector('#pm-rate-add').onclick = () => {
      const codeInp = host.querySelector('#pm-rate-code');
      const code = String(codeInp.value || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) { App.toast('Код валюты — три латинские буквы, например GEL', 'warn'); return; }
      if (code === 'RUB') { App.toast('Для ₽ курс не нужен', 'warn'); return; }
      const grid = host.querySelector('#pm-rates');
      if (grid.querySelector('[data-rate="' + code + '"]')) { App.toast('Валюта ' + code + ' уже в списке', 'warn'); return; }
      const label = U.el(`<label class="field">1 ${U.esc(code)} = … ₽
          <input type="number" class="num" data-rate="${U.esc(code)}" min="0" step="0.0001" value="" placeholder="курс не задан" /></label>`);
      grid.appendChild(label);
      codeInp.value = '';
      label.querySelector('input').focus();
      App.toast('Валюта ' + code + ' добавлена — укажите курс и сохраните параметры', 'ok', 5000);
    };

    host.querySelector('#pm-reset').onclick = () => {
      UI.confirmDialog('Сбросить параметры репрайсера', '<div class="alert warn">Все параметры вернутся к рекомендуемым значениям. Индивидуальные настройки товаров сохранятся.</div>', async () => {
        await API.invoke('repricer:save', RP.DEFAULT_CONFIG);
        this.rstate = await API.invoke('repricer:state');
        App.toast('Параметры сброшены', 'ok');
        this.draw();
      }, 'Сбросить');
    };
  },

  // ══════════════════════ ВКЛАДКА: ИСТОРИЯ ЗАПУСКОВ ══════════════════════

  /**
   * Журналы — как в репрайсере INDEEPA: отдельно «Журнал изменения цен» и
   * «Журнал изменения участия в акциях». Данные берёт канал repricer:journal,
   * который склеивает историю цен, историю пересчёта (фазы propose/send) и
   * очередь возврата цены после выхода из автоакции.
   */
  async tabJournal(host, mode) {
    this.journalFilter = this.journalFilter || { q: '', from: '', to: '' };
    const f = this.journalFilter;
    const title = mode === 'prices' ? 'Журнал изменения цен' : 'Журнал изменения участия в акциях';

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap" style="gap:8px;align-items:end">
          <div class="grow">
            <h2 style="margin:0 0 4px">${title}</h2>
            <p class="hint" style="margin:0">${mode === 'prices'
              ? 'Что предложил репрайсер (фаза «предложено») и что реально ушло в WB (фаза «отправлено»). Одинаковые записи из двух хранилищ схлопываются.'
              : 'История участия в акциях: входы, выходы и возвраты цены после окончания автоакции. Незакрытые позиции (цена ещё держится повышенной) помечаются статусом «держит автоакция» или «ждёт вывода».'}</p>
          </div>
          <input id="j-q" placeholder="Поиск: артикул, нм-код, название" style="width:260px" value="${U.esc(f.q)}" />
          <label class="field" style="margin:0">с<input type="date" id="j-from" value="${U.esc(f.from)}" /></label>
          <label class="field" style="margin:0">по<input type="date" id="j-to" value="${U.esc(f.to)}" /></label>
          <button class="btn btn-sm" id="j-apply">Показать</button>
          <button class="btn btn-sm btn-ghost" id="j-export">Экспорт CSV</button>
          <button class="btn btn-sm btn-ghost" id="j-export-xlsx" title="Выгрузка журнала в Excel">Excel</button>
        </div>
      </div>
      <div id="j-body">${UI.loading('Читаем журнал…')}</div>`;

    const load = async () => {
      const body = host.querySelector('#j-body');
      body.innerHTML = UI.loading('Читаем журнал…');
      let data;
      try {
        data = await API.invoke('repricer:journal', {
          kinds: mode === 'prices' ? ['price', 'propose', 'submitted'] : ['promo-join', 'promo-exit', 'promo-restore'],
          q: f.q, dateFrom: f.from, dateTo: f.to, limit: 150000
        });
      } catch (e) {
        body.innerHTML = `<div class="alert danger">${U.esc(e.message)}</div>`;
        return;
      }
      const ev = data.events || [];
      this.journalEvents = ev;

      if (!ev.length) {
        body.innerHTML = `<div class="card muted">Записей нет${f.q || f.from || f.to ? ' под этот фильтр' : ''}.
          ${mode === 'prices'
            ? 'Журнал наполняется после пересчёта цен и отправки предложения в WB.'
            : 'Журнал наполняется, когда репрайсер выводит товар из акции и ставит цену в очередь возврата.'}</div>`;
        return;
      }

      /**
       * Бейдж события. Для акций различаем три действия: вход, выход и возврат цены
       * после окончания автоакции; неудачные попытки помечаются отдельно.
       */
      const badge = (e) => {
        if (e.ok === false) return UI.badge('ошибка', 'danger');
        if (e.kind === 'propose') return UI.badge('предложено', 'info');
        if (e.kind === 'price') return UI.badge('применение подтверждено', 'ok');
        if (e.kind === 'submitted') return UI.badge('передано, не подтверждено', 'warn');
        if (e.kind === 'promo-join') return UI.badge('вход в акцию', 'ok');
        if (e.kind === 'promo-restore') return UI.badge('цена возвращена', 'info');
        // promo-exit: событие из журнала или незакрытая позиция из очереди возврата
        if (e.action === 'exit') return UI.badge('выход из акции', 'warn');
        return UI.badge(e.blockedByAutoPromo ? 'держит автоакция'
          : (e.status === 'ready' ? 'готов к возврату' : 'ждёт вывода'), e.blockedByAutoPromo ? 'warn' : 'ok');
      };

      const grid = UI.table({
        columns: mode === 'prices' ? [
          { title: 'Когда', render: (e) => `<span class="tiny">${U.date(e.at, true)}</span>` },
          { title: 'Товар', render: (e) => `<div class="rowtitle"><b class="trunc">${U.esc(e.title || '—')}</b>
              <span class="tiny muted">${e.nmID} · ${U.esc(e.vendorCode || '')}</span></div>` },
          { title: 'Фаза', render: badge },
          { title: 'Было', num: true, render: (e) => e.prevSellerPrice ? U.money(e.prevSellerPrice) : '<span class="muted tiny">—</span>' },
          { title: 'Стало', num: true, render: (e) => `<b>${U.money(e.sellerPrice)}</b>
              <div class="tiny muted">база ${U.money(e.basePrice)} · скидка ${U.pct(e.discount, 0)}</div>` },
          { title: 'Изменение', num: true, render: (e) => {
              const was = U.num(e.prevSellerPrice);
              if (!(was > 0)) return '<span class="muted tiny">—</span>';
              const d = U.num(e.sellerPrice) - was;
              const p = was ? (d / was) * 100 : 0;
              return `<span class="${d > 0 ? 'pos' : (d < 0 ? 'neg' : 'muted')}">${U.signed(Math.round(d))} ₽ · ${U.signed(p, 1)}%</span>`;
            } },
          { title: 'Стратегия / источник', render: (e) => `<span class="tiny">${U.esc(e.strategy || e.source || '—')}</span>` },
          { title: 'Причина', render: (e) => `<span class="tiny muted">${U.esc(e.reason || '')}</span>` },
          { title: '', render: (e) => `<button class="btn btn-xs btn-ghost" data-card="${e.nmID}">карточка</button>` }
        ] : [
          { title: 'Когда', render: (e) => `<span class="tiny">${U.date(e.at, true)}</span>` },
          { title: 'Товар', render: (e) => `<div class="rowtitle"><b class="trunc">${U.esc(e.title || '—')}</b>
              <span class="tiny muted">${e.nmID} · ${U.esc(e.vendorCode || '')}</span></div>` },
          { title: 'Действие', render: badge },
          { title: 'Акции', render: (e) => (e.promoNames || []).length
              ? (e.promoNames || []).map((n) => UI.badge(U.esc(String(n)), 'accent')).join(' ')
              : '<span class="muted tiny">—</span>' },
          { title: 'Цена до', num: true, render: (e) => e.prevSellerPrice ? U.money(e.prevSellerPrice) : '<span class="muted tiny">—</span>' },
          { title: 'Цена после', num: true, render: (e) => e.sellerPrice ? `<b>${U.money(e.sellerPrice)}</b>` : '<span class="muted tiny">—</span>' },
          { title: 'Причина', render: (e) => `<span class="tiny muted" title="${U.esc(e.reason || '')}">${U.esc((e.reason || e.error || '').slice(0, 90))}${(e.reason || e.error || '').length > 90 ? '…' : ''}</span>` },
          { title: '', render: (e) => `<button class="btn btn-xs btn-ghost" data-card="${e.nmID}">карточка</button>` }
        ],
        rows: ev.slice(0, 1000),
        tall: true,
        empty: 'Записей нет',
        onRowDblClick: (e) => Views.itemcard.open(e.nmID),
        footer: (c) => (c.title === 'Когда' ? `<b>${U.fmt(data.total)}</b> записей${ev.length > 1000 || data.truncated ? ' (показаны первые 1000; экспорт — весь выбранный журнал)' : ''}` : '')
      });
      body.innerHTML = '';
      body.appendChild(grid.el);
      body.querySelectorAll('[data-card]').forEach((b) => {
        b.onclick = (e2) => { e2.stopPropagation(); Views.itemcard.open(Number(b.dataset.card)); };
      });
    };

    host.querySelector('#j-apply').onclick = () => {
      f.q = host.querySelector('#j-q').value;
      f.from = host.querySelector('#j-from').value;
      f.to = host.querySelector('#j-to').value;
      load();
    };
    host.querySelector('#j-q').oninput = U.debounce(() => host.querySelector('#j-apply').click(), 300);
    /**
     * Строки журнала для выгрузки — одни и те же для CSV и Excel, чтобы форматы
     * не разъезжались по составу колонок.
     */
    const journalHeaders = mode === 'prices'
      ? ['Когда', 'нм-код', 'Артикул', 'Название', 'Фаза', 'Было, ₽', 'Стало, ₽',
         'Базовая цена', 'Скидка %', 'Стратегия', 'Причина']
      : ['Когда', 'нм-код', 'Артикул', 'Название', 'Действие', 'Акции', 'Цена до, ₽',
         'Цена после, ₽', 'Успешно', 'Причина', 'Держит автоакция'];

    const journalRows = () => (this.journalEvents || []).map((e) => (mode === 'prices' ? [
      e.at, e.nmID, e.vendorCode || '', e.title || '',
      e.kind === 'propose' ? 'предложено' : 'отправлено',
      e.prevSellerPrice || '', e.sellerPrice, e.basePrice, e.discount,
      e.strategy || e.source || '', e.reason || ''
    ] : [
      e.at, e.nmID, e.vendorCode || '', e.title || '',
      { 'promo-join': 'вход в акцию', 'promo-exit': 'выход из акции', 'promo-restore': 'возврат цены' }[e.kind] || e.kind,
      (e.promoNames || []).join('; '),
      e.prevSellerPrice || '', e.sellerPrice || '',
      e.ok === false ? 'нет' : 'да',
      e.reason || e.error || '',
      e.blockedByAutoPromo ? 'да' : 'нет'
    ]));

    const fileName = () => 'repricer-journal-' + mode + '-' + new Date().toISOString().slice(0, 10);

    host.querySelector('#j-export').onclick = () => {
      if (!(this.journalEvents || []).length) { App.toast('Журнал пуст — выгружать нечего', 'warn'); return; }
      const objs = journalRows().map((row) => {
        const o = {};
        journalHeaders.forEach((h, i) => { o[h] = row[i]; });
        return o;
      });
      API.exportCsv(fileName() + '.csv', U.toCsv(objs));
      App.toast('Журнал выгружен в CSV', 'ok');
    };

    host.querySelector('#j-export-xlsx').onclick = async (e) => {
      const btn = e.target;
      const rows = journalRows();
      if (!rows.length) { App.toast('Журнал пуст — выгружать нечего', 'warn'); return; }
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Собираем…';
      try {
        const res = await API.invoke('xlsx:build', {
          rows, headers: journalHeaders,
          sheetName: mode === 'prices' ? 'Изменение цен' : 'Участие в акциях',
          fileName: fileName() + '.xlsx'
        });
        U.downloadBase64(res.fileName, res.base64);
        App.toast('Журнал выгружен в Excel: ' + U.fmt(res.rows) + ' строк', 'ok', 6000);
      } catch (err) {
        App.toast(err.message, 'err', 9000);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    await load();
  },

  async tabRuns(host) {
    const runs = await API.invoke('repricer:runs');
    const history = await API.invoke('repricer:history');
    const changed = Object.keys(history || {}).length;

    host.innerHTML = `
      <div class="grid g3" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Запусков пересчёта</span><span class="value">${U.fmt(runs.length)}</span></div>
        <div class="card stat"><span class="label">Отправлено цен</span><span class="value">${U.fmt(runs.reduce((s, r) => s + U.num(r.sent), 0))}</span></div>
        <div class="card stat"><span class="label">Артикулов в истории цен</span><span class="value">${U.fmt(changed)}</span></div>
      </div>
      <div class="card pad0" style="margin-bottom:14px">
        <div class="card-head" style="padding:14px 16px 0"><h2>Запуски репрайсера</h2></div>
        <div style="padding:10px 16px 16px">
          ${runs.length ? `<table class="grid-table"><thead><tr>
              <th>Когда</th><th>Режим</th><th class="num">Пересчитано</th><th class="num">К отправке</th><th class="num">↑ / ↓</th>
              <th class="num">Δ прибыли/мес</th><th class="num">Предупреждений</th><th>Автоотправка</th><th></th></tr></thead>
            <tbody>${runs.map((r, i) => `<tr>
              <td>${U.date(r.at, true)}</td>
              <td>${UI.badge(r.mode === 'auto' ? 'по расписанию' : (r.mode === 'manual-send' ? 'отправка' : 'вручную'), r.mode === 'auto' ? 'accent' : '')}</td>
              <td class="num">${U.fmt(r.summary ? r.summary.total : 0)}</td>
              <td class="num">${U.fmt(r.summary ? r.summary.toSend : (r.sent || 0))}</td>
              <td class="num">${r.summary ? '↑' + r.summary.up + ' ↓' + r.summary.down : '—'}</td>
              <td class="num ${U.profitClass(r.summary ? r.summary.profitDeltaMonth : 0)}">${r.summary ? U.signed(Math.round(r.summary.profitDeltaMonth)) + ' ₽' : '—'}</td>
              <td class="num">${r.summary ? r.summary.warnings : '—'}</td>
              <td>${r.autoSend ? UI.badge('да', 'danger') : UI.badge('нет')}</td>
              <td>${r.demo ? UI.badge('демо') : UI.badge('WB API', 'live')}</td>
            </tr>`).join('')}</tbody></table>` : '<div class="muted small" style="padding:8px">Пересчётов ещё не было — нажмите «Пересчёт» на вкладке «Товары».</div>'}
        </div>
      </div>
      <div class="card pad0">
        <div class="card-head" style="padding:14px 16px 0"><h2>История изменения цен (для суточного лимита)</h2>
          <span class="hint">последние ${changed} артикулов</span></div>
        <div style="padding:10px 16px 16px" id="hist-host"></div>
      </div>
    `;

    const hh = host.querySelector('#hist-host');
    const entries = [];
    for (const [nm, list] of Object.entries(history || {})) {
      (list || []).slice(-5).forEach((p) => entries.push(Object.assign({ nmID: nm }, p)));
    }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!entries.length) {
      hh.innerHTML = '<div class="muted small">История пуста. Она заполняется после каждой отправки цен (вручную или репрайсером) и используется для контроля суточного лимита изменения.</div>';
      return;
    }
    const rowsByNm = S.getRows();
    const grid = UI.table({
      columns: [
        { title: 'Когда', render: (e) => U.date(e.at, true) },
        { title: 'нм-код', render: (e) => e.nmID },
        { title: 'Товар', render: (e) => { const r = rowsByNm.find((x) => String(x.nmID) === String(e.nmID)); return r ? `<span class="trunc">${U.esc(r.title)}</span>` : ''; } },
        { title: 'Цена до скидки', num: true, render: (e) => U.money(e.basePrice) },
        { title: 'Скидка', num: true, render: (e) => U.pct(e.discount, 0) },
        { title: 'Цена со скидкой', num: true, render: (e) => '<b>' + U.money(e.sellerPrice) + '</b>' },
        { title: 'Источник', render: (e) => UI.badge(e.source === 'repricer' || e.source === 'repricer-auto' ? 'репрайсер' : 'вручную', e.source && String(e.source).includes('repricer') ? 'accent' : '') }
      ],
      rows: entries.slice(0, 300),
      empty: 'Пусто'
    });
    hh.appendChild(grid.el);
  }
};
