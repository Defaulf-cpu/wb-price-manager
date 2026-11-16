'use strict';

/**
 * Репрайсер: автоматический пересчёт цен по стратегиям.
 * Архитектура расчёта — три слоя (как в INDEEPA):
 *   1) универсальная стратегия, 2) верхнеуровневые ДЦО (берётся максимальная цена), 3) красивая цена.
 * Затем ценовой коридор, лимит шага за обновление и за сутки, защита от карантина цен WB.
 */
window.Views = window.Views || {};

let RPV = null;

Views.repricer = {
  title: 'Репрайсер',
  subtitle: 'Автоматический пересчёт цен по стратегиям, порогам и расписанию',

  tab: 'prices',
  results: [],
  summary: null,
  rstate: null,
  itemFilter: { q: '', strategy: '', tag: '', onlyChanges: false, tile: '', seg: 'all' },
  /** Плотность строк таблицы: 'normal' | 'compact' (хранится в localStorage). */
  density: 'compact',

  render(container) {
    this.container = container;
    container.innerHTML = `
      <div class="tabs" id="rp-tabs">
        <div class="tab" data-t="prices">Товары</div>
        <div class="tab" data-t="promos">Акции</div>
        <div class="tab" data-t="strategies">Параметры товаров (массово)</div>
        <div class="tab" data-t="competitors">Конкуренты</div>
        <div class="tab" data-t="params">Параметры репрайсера</div>
        <div class="tab" data-t="journal-prices">Журнал изменения цен</div>
        <div class="tab" data-t="journal-promos">Журнал участия в акциях</div>
        <div class="tab" data-t="runs">История запусков</div>
      </div>
      <div id="rp-host">${UI.loading('Загружаем настройки репрайсера…')}</div>
    `;
    container.querySelectorAll('#rp-tabs .tab').forEach((t) => {
      t.onclick = () => { this.tab = t.dataset.t; this.paintTabs(); this.draw(); };
    });
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
    // себестоимость по артикулам: без неё нельзя сказать, выгоден товар или нет
    // (в INDEEPA это «Без индекса»), и такие строки не должны уходить в WB
    this.cogsByNm = {};
    try {
      S.getRows().forEach((r) => { this.cogsByNm[String(r.nmID)] = U.num(r.costPrice); });
    } catch (e) { this.cogsByNm = this.cogsByNm || {}; }
    return this.rstate;
  },

  async draw() {
    const host = this.container.querySelector('#rp-host');
    host.innerHTML = UI.loading();
    try {
      await this.loadState();
      if (this.tab === 'prices') this.tabPrices(host);
      else if (this.tab === 'promos') this.tabPromos(host);
      else if (this.tab === 'strategies') this.tabStrategies(host);
      else if (this.tab === 'competitors') this.tabCompetitors(host);
      else if (this.tab === 'params') this.tabParams(host);
      else if (this.tab === 'journal-prices') this.tabJournal(host, 'prices');
      else if (this.tab === 'journal-promos') this.tabJournal(host, 'promos');
      else this.tabRuns(host);
    } catch (e) {
      host.innerHTML = `<div class="card"><div class="alert danger">${U.esc(e.message)}</div></div>`;
    }
  },

  // ══════════════════════ ВКЛАДКА: НОВЫЕ ЦЕНЫ ══════════════════════

  async tabPrices(host) {
    const rs = this.rstate;
    const cfg = rs.config;
    const sched = rs.scheduler;

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="spread wrap">
          <div class="row wrap">
            <label class="checkline"><input type="checkbox" id="rp-enabled" ${cfg.enabled ? 'checked' : ''} />
              <b>Автообновление цен включено</b></label>
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
            <button class="btn btn-ok" id="rp-send" disabled>Отправить предложение в WB (фаза 2)</button>
          </div>
        </div>
        <div class="alert info" style="margin-top:12px">
          Репрайсер считает цену в три слоя: <b>стратегия</b> (конкуренты / маржа / план-факт / оборачиваемость / РРЦ / AI),
          затем <b>верхнеуровневые ДЦО</b> (защита от out-of-stock, повышение акционной цены — если сработало несколько, берётся максимальная цена),
          затем <b>красивая цена</b>. Итог загоняется в коридор «минимальная ↔ базовая» и ограничивается шагом
          <b>${U.pct(cfg.limits.maxChangePerUpdatePct, 0)}</b> за одно обновление${cfg.limits.maxChangePerDayPct ? ' и <b>' + U.pct(cfg.limits.maxChangePerDayPct, 0) + '</b> за сутки' : ''}.
        </div>
      </div>
      <div id="rp-proposal"></div>
      <div id="rp-tiles" class="row wrap" style="gap:6px;margin-bottom:12px"></div>
      <div id="rp-summary"></div>
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap">
          <input id="rp-q" placeholder="Поиск: артикул, нм-код, название" style="width:280px" value="${U.esc(this.itemFilter.q)}" />
          <select id="rp-strategy" style="width:230px"><option value="">Все стратегии</option></select>
          <select id="rp-tag" style="width:180px" title="Внутренний тег товара"><option value="">Все теги</option></select>
          <div class="grow"></div>
          <select id="rp-density" style="width:150px" title="Плотность строк: сколько товаров влезает на экран">
            <option value="normal" ${this.density === 'normal' ? 'selected' : ''}>Обычные строки</option>
            <option value="compact" ${this.density === 'compact' ? 'selected' : ''}>Плотные строки</option>
          </select>
          <button class="btn btn-sm btn-ghost" id="rp-cols" title="Выбрать, какие колонки показывать">Колонки</button>
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
             ['loss', 'Только убыточные'], ['warn', 'С предупреждениями']]
            .map(([id, label]) => `<button class="seg-btn ${this.itemFilter.seg === id ? 'active' : ''}" data-seg="${id}">${label}</button>`).join('')}
        </div>
        <span class="hint" id="rp-seg-count"></span>
      </div>
      <div id="rp-grid">${this.results.length ? '' : '<div class="card muted">Нажмите «Пересчитать цены», чтобы репрайсер предложил новые цены по вашим стратегиям.</div>'}</div>
      <div class="bulkbar" id="rp-bulk" style="display:none"></div>
    `;

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
        const res = await API.invoke('repricer:calc', { full: true });
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
     * Теги продавец задаёт сам прямо в строке (колонка «Внутренний тег»).
     * Список собираем из уже сохранённых настроек товаров — отдельного справочника нет.
     */
    const tagSel = $('#rp-tag');
    if (tagSel) {
      const tags = Array.from(new Set(Object.keys(this.rstate.itemConfigs || {})
        .map((nm) => String((this.rstate.itemConfigs[nm] || {}).tag || '').trim())
        .filter(Boolean))).sort();
      if (this.itemFilter.tag && !tags.includes(this.itemFilter.tag)) tags.push(this.itemFilter.tag);
      tags.forEach((t) => {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        if (t === this.itemFilter.tag) o.selected = true;
        tagSel.appendChild(o);
      });
      tagSel.onchange = (e) => { this.itemFilter.tag = e.target.value; this.page = 0; this.renderResults(); };
    }

    /**
     * Экспорт уважает выбор колонок: в файл попадают только видимые колонки,
     * а блоки становятся отдельным рядом (в Excel — первой строкой).
     */
    $('#rp-export-xlsx').onclick = async (e) => {
      const btn = e.target;
      const list = this.filteredResults();
      if (!list.length) { App.toast('Сначала выполните пересчёт — выгружать нечего', 'warn'); return; }
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Собираем файл…';
      try {
        const table = this.buildExportTable(list);
        const res = await API.invoke('xlsx:build', {
          rows: [table.blockRow, table.headRow].concat(table.dataRows),
          sheetName: 'Репрайсер',
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
      if (!this.results.length) return App.toast('Сначала выполните пересчёт', 'warn');
      const csv = U.toCsv(this.buildCsvRows(this.filteredResults()));
      API.exportCsv(`repricer-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, csv);
      App.toast('Расчёт выгружен в CSV (' + U.fmt(this.visibleColumns().length) + ' колонок)', 'ok');
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
        const res = await API.invoke('repricer:calc', { full: true });
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

    const lifecycle = `<div class="hint rp-lifecycle">Фаза 1: сохранено предложений <b>${U.fmt(items.length)}</b> · расчёт ${U.date(prop.at, true)} · Фаза 2: отправка ${U.date(prop.sentAt, true)} · устарело <b>${U.fmt(prop.staleCount || 0)}</b></div>`;
    const blocked = prop.blocked || [];
    const blockedHtml = blocked.length ? `
      <div class="alert danger" style="margin-top:10px">
        <b>Не вошли в предложение: ${U.fmt(prop.blockedTotal || blocked.length)} товаров с незаполненными данными.</b>
        <div class="hint" style="margin-top:4px">Репрайсер не предлагает их к отправке, пока не заполнены себестоимость
          и пороги цен — иначе цена ушла бы в WB «на глаз». Примеры:
          ${blocked.slice(0, 4).map((b) => '<span class="mono">' + U.esc(String(b.vendorCode || b.nmID)) + '</span> (' +
            U.esc((b.reasons || []).join(', ')) + ')').join('; ')}</div>
        <div class="hint" style="margin-top:4px">Заполнить можно прямо в таблице (колонки «Стратегия» и «Пол / потолок»),
          в карточке товара (двойной клик → «Комиссии и параметры») или массово во вкладке «Параметры товаров».</div>
      </div>` : '';

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
          ${lifecycle}${blockedHtml}
        </div>`;
      if (sendBtn) sendBtn.disabled = true;
      return;
    }

    const manualCount = items.filter((x) => x.manual).length;
    const rpCount = items.length - manualCount;
    const sendAt = prop.sendAt ? new Date(prop.sendAt) : null;
    const minutesLeft = sendAt ? Math.max(0, Math.round((sendAt - Date.now()) / 60000)) : null;
    const phaseLabel = prop.phase === 'sent' ? 'отправлено в WB'
      : (prop.phase === 'stale' ? 'устарело — нужен новый пересчёт' : 'ждёт отправки');
    const kind = prop.phase === 'sent' ? 'ok' : (prop.phase === 'stale' ? 'danger' : 'warn');

    host.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap" style="gap:12px">
          <div style="flex:1;min-width:280px">
            <b>К отправке ${U.fmt(items.length)} цен</b> ${UI.badge(phaseLabel, kind)}
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
        ${prop.phase === 'stale' && prop.note ? `<div class="alert warn" style="margin-top:10px">${U.esc(prop.note)}</div>` : ''}
        ${lifecycle}${blockedHtml}
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
            App.toast('Отправлено цен: ' + (res.sent || 0) +
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
   * Блоки колонок таблицы товаров. Верхний ряд двухуровневой шапки — это названия
   * блоков (colSpan по числу видимых колонок), нижний — сами колонки. Порядок блоков
   * и колонок слева направо зафиксирован здесь: рендер таблицы берёт колонки ТОЛЬКО
   * из COLUMNS, поэтому порядок шапки и строк всегда совпадает.
   */
  BLOCKS: [
    { id: 'art', title: 'Артикул', hint: 'Что это за товар и как с ним работать' },
    { id: 'info', title: 'Инфо о товаре', hint: 'Постоянные данные товара и себестоимость' },
    { id: 'now', title: 'Текущая цена', hint: 'Что стоит в кабинете Wildberries сейчас' },
    { id: 'next', title: 'Новая цена', hint: 'Что предлагает репрайсер' },
    { id: 'min', title: 'Мин цена (в акции)', hint: 'Порог минимальной цены и его экономика' },
    { id: 'base', title: 'Цена (вне акции)', hint: 'Базовая цена и её экономика' }
  ],

  /**
   * Колонки таблицы товаров.
   *
   * Поля описания:
   *   block     — id блока (верхний ряд шапки);
   *   required  — обязательное поле: пустое значение подсвечивается, а причина
   *               попадает в rowErrors (и в proposalBlockers на сервере);
   *   always    — колонку нельзя выключить в пикере (Товар, цены, изменение, «почему»);
   *   num       — числовая колонка (выравнивание вправо);
   *   pinned    — закреплена слева при горизонтальной прокрутке;
   *   empty(r)  — «значения нет» для подсветки обязательной колонки;
   *   export(r) — что писать в CSV/Excel (число или строка, без HTML);
   *   render(r) — HTML ячейки.
   *
   * Выдумывать данные запрещено: если WB значение не отдаёт, ячейка показывает «—»
   * с подсказкой, почему его нет. Редактируемые поля помечены классом rp-* и
   * складываются в очередь stageEdit → commitEdits (одна запись + один пересчёт).
   */
  COLUMNS: [
    // ── Блок «Артикул» ─────────────────────────────────────────────────────
    { id: 'item', block: 'art', title: 'Товар', always: true, required: true, pinned: true, cls: 'rp-product', width: '250px',
      export: (r) => r.title || String(r.nmID),
      render: (r) => {
        const item = RPV.itemsByNm.get(String(r.nmID)) || {};
        const raw = item.photo || item.photoUrl || (item.photos && item.photos[0]);
        const photo = typeof raw === 'string' ? raw : raw && (raw.small || raw.big);
        return `<div class="row">${photo && /^https:\/\//i.test(photo) ? `<img class="rp-photo" src="${U.esc(photo)}" loading="lazy" alt="" />` : '<span class="rp-photo muted" aria-label="Нет фото">▧</span>'}
          <div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">SKU ${U.esc(r.nmID)} · ${U.esc(r.vendorCode || '')}</span><span class="tiny muted">${U.esc(item.brand || 'Бренд не указан')}</span></div></div>`;
      } },
    { id: 'photo', block: 'art', title: 'Фото', num: true,
      export: (r) => { const it = RPV.itemsByNm.get(String(r.nmID)) || {}; return it.photo || ''; },
      render: (r) => {
        const item = RPV.itemsByNm.get(String(r.nmID)) || {};
        const raw = item.photo || item.photoUrl || (item.photos && item.photos[0]);
        const photo = typeof raw === 'string' ? raw : raw && (raw.small || raw.big);
        return photo && /^https:\/\//i.test(photo)
          ? `<img class="rp-photo" src="${U.esc(photo)}" loading="lazy" alt="" title="Фото из карточки WB" />`
          : `<span class="rp-photo muted" title="WB не вернул фото карточки">▧</span>`;
      } },
    { id: 'allowSend', block: 'art', title: 'Разрешить отправку цен', required: true,
      export: (r) => (RPV.rowConfig(r.nmID).allowSend === false ? 'нет' : 'да'),
      render: (r) => {
        const on = RPV.rowConfig(r.nmID).allowSend !== false;
        return `<label class="checkline" title="Выключено — строка не попадает в предложение и не отправляется в WB">
            <input type="checkbox" class="rp-allow-send" data-nm="${r.nmID}" ${on ? 'checked' : ''} /> ${on ? 'разрешено' : UI.badge('отправка запрещена', 'danger')}
          </label>`;
      } },
    { id: 'strategy', block: 'art', title: 'Стратегия',
      export: (r) => r.strategyTitle || r.strategy || '',
      render: (r) => {
        const cfg = RPV.rowConfig(r.nmID);
        const cur = cfg.strategy || '';
        return `<select class="rp-strategy" data-nm="${r.nmID}" style="width:170px" title="Стратегия расчёта цены для этого товара">
            <option value="">как в общих настройках</option>
            ${(RPV.rstate.strategies || []).map((s) => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
          </select>
          <div class="tiny muted" style="margin-top:2px">сейчас: ${U.esc(r.strategyTitle || r.strategy || '—')}</div>
          ${RPV.rowErrors(r).length ? `<div class="rp-validation neg tiny">ОШИБКА: ${U.esc(RPV.rowErrors(r).join('; '))}</div>` : ''}`;
      } },
    { id: 'tag', block: 'art', title: 'Внутренний тег',
      export: (r) => RPV.rowConfig(r.nmID).tag || '',
      render: (r) => `<input class="rp-tag" data-nm="${r.nmID}" type="text" maxlength="40" style="width:120px"
          placeholder="без тега" value="${U.esc(RPV.rowConfig(r.nmID).tag || '')}"
          title="Свой тег для фильтра: например «хиты» или «распродажа». В WB не отправляется." />` },
    { id: 'nmID', block: 'art', title: 'Артикул МП', num: true,
      export: (r) => r.nmID,
      render: (r) => `<span class="mono">${U.esc(r.nmID)}</span>` },
    { id: 'vendorCode', block: 'art', title: 'ID (артикул продавца)',
      export: (r) => r.vendorCode || '',
      render: (r) => r.vendorCode ? `<span class="mono">${U.esc(r.vendorCode)}</span>` : RPV.dash('WB не вернул артикул продавца') },
    { id: 'rule', block: 'art', title: 'Правило',
      export: (r) => RPV.ruleSummary(r),
      render: (r) => {
        const text = RPV.ruleSummary(r);
        return `<div class="tiny rp-cell-note" title="${U.esc(text)}">${U.esc(text)}</div>`;
      } },
    { id: 'warnings', block: 'art', title: 'Уведомления',
      export: (r) => (r.warnings || []).join('; '),
      render: (r) => {
        const list = r.warnings || [];
        if (!list.length) return '<span class="muted tiny">—</span>';
        return `<span title="${U.esc(list.join('\n'))}" aria-label="Предупреждения репрайсера">⚠ ${UI.badge(list.length + ' пред.', 'warn')}</span>`;
      } },
    { id: 'status', block: 'art', title: 'Статус строки',
      export: (r) => r.limitedBy || (r.needSend ? 'к отправке' : 'без изменений'),
      render: (r) => {
        const b = [];
        if (r.quarantine) b.push(UI.badge('карантин', 'danger'));
        if (r.limitedBy === 'step') b.push(UI.badge('лимит шага', 'warn'));
        if (r.limitedBy === 'day') b.push(UI.badge('суточный лимит', 'warn'));
        if (r.limitedBy === 'below-min') b.push(UI.badge('поднят до порога', 'info'));
        if (RPV.rowConfig(r.nmID).allowSend === false) b.push(UI.badge('отправка запрещена', 'danger'));
        if (!b.length) b.push(r.needSend ? UI.badge('к отправке', 'ok') : UI.badge('без изменений'));
        return b.join(' ');
      } },
    { id: 'why', block: 'art', title: '', always: true,
      export: () => '',
      render: (r) => `<button class="btn btn-xs btn-ghost" data-why="${r.nmID}" data-dirty-nm="${r.nmID}" title="Почему репрайсер предложил такую цену">почему</button>` },

    // ── Блок «Инфо о товаре» ───────────────────────────────────────────────
    { id: 'shop', block: 'info', title: 'Кабинет',
      export: () => (RPV.rstate && RPV.rstate.shopName) || (S.state.settings && S.state.settings.shopName) || 'Основной',
      render: () => U.esc((RPV.rstate && RPV.rstate.shopName) || (S.state.settings && S.state.settings.shopName) || 'Основной') },
    { id: 'brand', block: 'info', title: 'Бренд',
      export: (r) => (RPV.itemsByNm.get(String(r.nmID)) || {}).brand || '',
      render: (r) => {
        const brand = (RPV.itemsByNm.get(String(r.nmID)) || {}).brand;
        return brand ? U.esc(brand) : RPV.dash('WB не вернул бренд карточки');
      } },
    { id: 'sizes', block: 'info', title: 'Размер',
      export: (r) => {
        const it = RPV.itemsByNm.get(String(r.nmID)) || {};
        return (it.sizes || []).map((s) => s.techSizeName || s.techSize).filter(Boolean).join(', ') || '';
      },
      render: (r) => {
        const it = RPV.itemsByNm.get(String(r.nmID)) || {};
        const list = (it.sizes || []).map((s) => String(s.techSizeName || s.techSize || '').trim()).filter(Boolean);
        const note = RPV.sizePriceNote(r);
        if (!list.length) return `${RPV.dash('WB не вернул размеры товара')}${note}`;
        const text = list.join(', ');
        return `<div class="tiny" title="${U.esc(text)}">${U.fmt(list.length)} шт${list.length <= 2 ? ': ' + U.esc(text) : ''}</div>
          <div class="tiny muted trunc" title="${U.esc(text)}">${U.esc(text)}</div>${note}`;
      } },
    { id: 'sku', block: 'info', title: 'SKU',
      export: (r) => {
        const it = RPV.itemsByNm.get(String(r.nmID)) || {};
        const skus = (it.sizes || []).reduce((acc, s) => acc.concat(s.skus || []), []);
        return skus.join(', ') || it.sku || '';
      },
      render: (r) => {
        const it = RPV.itemsByNm.get(String(r.nmID)) || {};
        const skus = (it.sizes || []).reduce((acc, s) => acc.concat(s.skus || []), []).map(String).filter(Boolean);
        if (!skus.length && it.sku) skus.push(String(it.sku));
        if (!skus.length) return RPV.dash('WB не вернул SKU: баркодов нет ни в контент-API, ни в статистике');
        const text = skus.join(', ');
        return `<span class="tiny mono" title="${U.esc(text)}">${U.esc(skus.length > 3 ? skus.slice(0, 3).join(', ') + ' …' : text)}</span>`;
      } },
    { id: 'roi', block: 'info', title: 'ROI, %', num: true,
      export: (r) => { const v = RPV.roiOf(r); return v === null ? '' : v; },
      render: (r) => {
        const v = RPV.roiOf(r);
        if (v === null) return RPV.dash('ROI не считается: нужен остаток > 0 и себестоимость > 0');
        return `<span class="${v < 0 ? 'neg' : 'pos'}" title="Прибыль за месяц ÷ стоимость остатка по себестоимости">${U.pct(v, 0)}</span>`;
      } },
    { id: 'returnPct', block: 'info', title: '% возврата', num: true,
      export: (r) => { const v = RPV.returnPctOf(r); return v === null ? '' : v; },
      render: (r) => {
        const v = RPV.returnPctOf(r);
        if (v === null) return RPV.dash('Возвратов нет или продаж за 30 дней не было — процент не считается');
        return `<span class="${v >= 15 ? 'warnc' : 'muted'}">${U.pct(v, 1)}</span>`;
      } },
    { id: 'vendorSupplier', block: 'info', title: 'Артикул поставщика',
      export: (r) => r.vendorCode || '',
      render: (r) => r.vendorCode ? `<span class="mono tiny">${U.esc(r.vendorCode)}</span>` : RPV.dash('WB не вернул артикул поставщика') },
    { id: 'costNow', block: 'info', title: 'Себестоимость ₽', required: true, num: true,
      empty: (r) => !(U.num(r.current && r.current.costPriceRub) > 0),
      export: (r) => U.num(r.current && r.current.costPriceRub),
      render: (r) => {
        const cfgCost = RPV.rowCost(r.nmID).costPriceRub;
        const eff = U.num(r.current && r.current.costPriceRub);
        const src = ((r.current && r.current.costSources) || {}).costPriceRub || 'none';
        const srcText = { manual: 'из costs.json', user: 'введено вручную', fact: 'факт из отчёта WB', none: 'не задана', settings: 'из настроек' }[src] || src;
        const err = r.context && r.context.costCurrencyError;
        const val = (RPV.pendingEdits.get(String(r.nmID)) || {}).cost;
        const shown = val && val.costPriceRub !== undefined ? val.costPriceRub : (cfgCost !== undefined && cfgCost !== null && cfgCost !== '' ? cfgCost : (eff > 0 ? eff : ''));
        return `<input type="number" class="num rp-cost rp-cell-input" data-nm="${r.nmID}" min="0" step="0.01" value="${shown}"
            title="Себестоимость, по которой считается маржа. Источник: ${U.esc(srcText)}" />
          <div class="tiny ${err ? 'neg' : 'muted'}" title="${U.esc(err || srcText)}">${U.esc(err || srcText)}</div>`;
      } },
    { id: 'stock', block: 'info', title: 'Остаток шт', required: true, num: true,
      empty: (r) => r.context && r.context.stock === undefined,
      export: (r) => U.num(r.context && r.context.stock),
      render: (r) => {
        const ov = RPV.rowCost(r.nmID);
        const val = ov.stock !== undefined && ov.stock !== null && ov.stock !== '' ? ov.stock : U.num(r.context && r.context.stock);
        return `<input type="number" class="num rp-stock rp-cell-input" data-nm="${r.nmID}" min="0" step="1" value="${val}"
            title="Остаток, по которому считается оборачиваемость и ROI. Настоящие остатки из WB появятся отдельным заданием." />
          <div class="tiny muted">${U.num(r.context && r.context.turnoverDays) >= 999 ? 'оборачиваемость ∞' : 'оборач. ' + Math.round(U.num(r.context && r.context.turnoverDays)) + ' дн'}</div>`;
      } },
    { id: 'costManual', block: 'info', title: 'Себестоимость (настройка)', required: true, num: true,
      empty: (r) => !(U.num(RPV.rowCost(r.nmID).costPriceRub) > 0) && !(U.num(r.current && r.current.costPriceRub) > 0),
      export: (r) => { const c = RPV.rowCost(r.nmID); return c.costPriceRub === undefined ? '' : U.num(c.costPriceRub); },
      render: (r) => {
        const c = RPV.rowCost(r.nmID);
        const cur = String(c.currency || 'RUB').toUpperCase();
        if (c.costPriceRub === undefined || c.costPriceRub === null || c.costPriceRub === '') {
          return `${RPV.dash('В costs.json своя себестоимость не задана — расчёт берёт факт из отчёта WB или общие настройки')}<div class="tiny muted">${cur}</div>`;
        }
        return `<b>${U.num(c.costPriceRub)}</b> ${cur !== 'RUB' ? UI.badge(cur, 'info') : ''}
          <div class="tiny muted">задано вручную</div>`;
      } },
    { id: 'currency', block: 'info', title: 'Валюта себестоимости', required: true,
      export: (r) => String(RPV.rowCost(r.nmID).currency || 'RUB').toUpperCase(),
      render: (r) => {
        const cur = String(RPV.rowCost(r.nmID).currency || 'RUB').toUpperCase();
        const rates = (RPV.rstate && RPV.rstate.costRates) || (S.state.settings && S.state.settings.costRates) || {};
        const rate = cur === 'RUB' ? 1 : U.num(rates[cur]);
        const hint = cur === 'RUB' ? 'рубли' : (rate > 0 ? 'курс ' + rate + ' ₽' : 'курс не задан — строка блокируется');
        return `<select class="rp-currency" data-nm="${r.nmID}" style="width:74px" title="Валюта, в которой задана себестоимость (курс — в настройках, вручную)">
            ${['RUB', 'USD', 'EUR', 'CNY'].map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
          <div class="tiny ${cur !== 'RUB' && !(rate > 0) ? 'neg' : 'muted'}">${U.esc(hint)}</div>`;
      } },
    { id: 'plan', block: 'info', title: 'План продаж', num: true,
      export: (r) => { const pl = (r.context && r.context.plan) || null; return pl ? U.num(pl.planQty) : ''; },
      render: (r) => RPV.planCellHtml(r) },

    // ── Блок «Текущая цена» ────────────────────────────────────────────────
    { id: 'value', block: 'now', title: 'Выгодность',
      export: (r) => (RPV.valueStatus(r) || {}).label || '',
      render: (r) => {
        const v = RPV.valueStatus(r);
        return `${UI.badge(v.label, v.kind)}<div class="tiny muted trunc" title="${U.esc(v.hint)}">${U.esc(v.hint)}</div>`;
      } },
    { id: 'indexNow', block: 'now', title: 'Индекс цены', required: true, num: true,
      export: (r) => { const v = RPV.priceIndex(r, U.num(r.current && r.current.sellerPrice)); return v === null ? '' : v; },
      render: (r) => RPV.indexCellHtml(r, U.num(r.current && r.current.sellerPrice), 'наша цена покупателю ÷ цена лучшего конкурента') },
    { id: 'inPromo', block: 'now', title: 'Участие в акции',
      export: (r) => ((r.context && r.context.inPromo) ? 'в акции' : 'не в акции'),
      render: (r) => ((r.context && r.context.inPromo) ? UI.badge('В акции', 'ok') : UI.badge('Не в акции')) },
    { id: 'priceNow', block: 'now', title: 'Текущая цена ₽', always: true, required: true, num: true,
      empty: (r) => !(U.num(r.current && r.current.sellerPrice) > 0),
      export: (r) => U.num(r.current && r.current.sellerPrice),
      render: (r) => `${U.money(r.current && r.current.sellerPrice)}<div class="tiny muted">скидка ${U.pct(U.num(r.current && r.current.discount), 0)} · база ${U.money(r.current && r.current.basePrice)}</div>${RPV.sizePriceNote(r)}` },
    { id: 'promos', block: 'now', title: 'Акции',
      export: (r) => (r.promoActions || []).map((a) => (a.promoName || a.promoId) + ' (' + a.action + ')').join('; '),
      render: (r) => RPV.promoCellHtml(r) },
    { id: 'buyerNow', block: 'now', title: 'Текущая цена с СПП ₽', required: true, num: true,
      empty: (r) => !(RPV.sellerWithSpp(r, U.num(r.current && r.current.sellerPrice)) > 0),
      export: (r) => RPV.round2(RPV.sellerWithSpp(r, U.num(r.current && r.current.sellerPrice))),
      render: (r) => {
        const v = RPV.sellerWithSpp(r, U.num(r.current && r.current.sellerPrice));
        return v > 0 ? `${U.money(v)}<div class="tiny muted">СПП ${U.pct(RPV.sppValue(r), 1)}</div>` : '<span class="muted tiny">—</span>';
      } },
    { id: 'sppPct', block: 'now', title: '% СПП', required: true, num: true,
      empty: (r) => !(RPV.sppValue(r) > 0),
      export: (r) => RPV.sppValue(r),
      render: (r) => {
        const v = RPV.sppValue(r);
        const src = (((r.context || {}).params || {}).costSources || {}).sppPct;
        const srcText = { manual: 'вручную по товару', watch: 'витрина WB', fact: 'факт из статистики', settings: 'справочник настроек', category: 'категория', none: 'не задан' }[src] || '—';
        return `${U.pct(v, 1)}<div class="tiny muted" title="Источник СПП: ${U.esc(srcText)}">${U.esc(srcText)}</div>`;
      } },
    { id: 'walletNow', block: 'now', title: 'Цена с WB-кошельком ₽', num: true,
      export: (r) => RPV.round2(RPV.withWallet(r, U.num(r.current && r.current.sellerPrice))),
      render: (r) => {
        const v = RPV.withWallet(r, U.num(r.current && r.current.sellerPrice));
        return v > 0
          ? `${U.money(v)}<div class="tiny muted">с СПП и кошельком</div>`
          : RPV.dash('Не считается: нет цены или не задан % WB-кошелька');
      } },
    { id: 'walletPct', block: 'now', title: '% WB-кошелька', num: true,
      export: (r) => RPV.walletPctOf(r),
      render: (r) => `${U.pct(RPV.walletPctOf(r), 0)}<div class="tiny muted">параметр репрайсера</div>` },
    { id: 'marginNow', block: 'now', title: 'Текущая марж. %', required: true, num: true,
      empty: (r) => !(U.num(r.current && r.current.costPriceRub) > 0),
      export: (r) => U.num(r.current && r.current.marginPct),
      render: (r) => `<span class="${U.profitClass(U.num(r.current && r.current.marginPct))}">${U.pct(U.num(r.current && r.current.marginPct), 1)}</span>` },
    { id: 'profitNow', block: 'now', title: 'Текущая марж. ₽', num: true,
      export: (r) => U.num(r.current && r.current.profit),
      render: (r) => `<span class="${U.profitClass(U.num(r.current && r.current.profit))}">${U.money(U.num(r.current && r.current.profit))}</span>` },
    { id: 'myPrice', block: 'now', title: 'Моя цена', num: true,
      export: () => '',
      render: (r) => RPV.myPriceCellHtml(r) },
    { id: 'competitor', block: 'now', title: 'Конкурент', num: true,
      export: (r) => U.num(r.context && r.context.competitorPrice),
      render: (r) => RPV.competitorCellHtml(r) },
    { id: 'offset', block: 'now', title: 'Отстройка от конкурента',
      export: (r) => { const c = RPV.rowConfig(r.nmID); return c.competitorOffsetMode === 'rub' ? U.num(c.competitorOffsetRub) : U.num(c.competitorOffsetPct); },
      render: (r) => RPV.offsetCellHtml(r) },

    // ── Блок «Новая цена» ──────────────────────────────────────────────────
    { id: 'indexNext', block: 'next', title: 'Индекс новой цены', required: true, num: true,
      export: (r) => { const v = RPV.priceIndex(r, U.num(r.proposed && r.proposed.sellerPrice)); return v === null ? '' : v; },
      render: (r) => RPV.indexCellHtml(r, U.num(r.proposed && r.proposed.sellerPrice), 'новая цена покупателю ÷ цена лучшего конкурента') },
    { id: 'priceNext', block: 'next', title: 'Новая цена ₽', always: true, num: true,
      export: (r) => U.num(r.proposed && r.proposed.sellerPrice),
      render: (r) => {
        const d = (S.state.priceDrafts || {})[String(r.nmID)];
        if (!d) return `<b>${U.money(r.proposed && r.proposed.sellerPrice)}</b><div class="tiny muted">скидка ${U.pct(U.num(r.proposed && r.proposed.discount), 0)} · база ${U.money(r.proposed && r.proposed.basePrice)}</div>`;
        const mine = U.num(d.sellerPrice) || Math.round(U.num(d.basePrice) * (1 - U.num(d.discount) / 100) * 100) / 100;
        return `<b class="warnc">${U.money(mine)}</b> ${UI.badge('моя цена', 'info')}
          <div class="tiny muted">скидка ${U.pct(U.num(d.discount), 0)} · база ${U.money(d.basePrice)}</div>
          <div class="tiny muted">репрайсер предлагал ${U.money(r.proposed && r.proposed.sellerPrice)} — не отправится</div>`;
      } },
    { id: 'buyerNext', block: 'next', title: 'Новая цена с СПП ₽', num: true,
      export: (r) => RPV.round2(RPV.sellerWithSpp(r, U.num(r.proposed && r.proposed.sellerPrice))),
      render: (r) => {
        const v = RPV.sellerWithSpp(r, U.num(r.proposed && r.proposed.sellerPrice));
        return v > 0 ? `<b>${U.money(v)}</b><div class="tiny muted">СПП ${U.pct(RPV.sppValue(r), 1)}</div>` : RPV.dash('Нет предложенной цены');
      } },
    { id: 'walletNext', block: 'next', title: 'Новая цена с WB-кошельком ₽', num: true,
      export: (r) => RPV.round2(RPV.withWallet(r, U.num(r.proposed && r.proposed.sellerPrice))),
      render: (r) => {
        const v = RPV.withWallet(r, U.num(r.proposed && r.proposed.sellerPrice));
        return v > 0 ? `${U.money(v)}<div class="tiny muted">с СПП и кошельком</div>` : RPV.dash('Нет предложенной цены');
      } },
    { id: 'marginNext', block: 'next', title: 'Новая марж. %', num: true,
      export: (r) => U.num(r.proposed && r.proposed.marginPct),
      render: (r) => `<b class="${U.profitClass(U.num(r.proposed && r.proposed.marginPct))}">${U.pct(U.num(r.proposed && r.proposed.marginPct), 1)}</b>` },
    { id: 'delta', block: 'next', title: 'Изменение', always: true, required: true, num: true,
      empty: (r) => r.delta === undefined,
      export: (r) => U.num(r.delta && r.delta.abs),
      render: (r) => `<span class="${U.num(r.delta && r.delta.abs) > 0 ? 'pos' : (U.num(r.delta && r.delta.abs) < 0 ? 'neg' : 'muted')}">${U.signed(U.num(r.delta && r.delta.abs))} ₽<br>${U.signed(U.num(r.delta && r.delta.pct), 1)}%</span>` },

    // ── Блок «Мин цена (в акции)» ──────────────────────────────────────────
    { id: 'priceMode', block: 'min', title: 'Тип новой цены',
      export: (r) => RPV.priceModeText(r),
      render: (r) => {
        const text = RPV.priceModeText(r);
        return text === '—' ? RPV.dash('Расчёт ещё не выполнен') : `<span class="tiny">${U.esc(text)}</span>`;
      } },
    { id: 'commission', block: 'min', title: 'Комиссия нов. цены', required: true, num: true,
      empty: (r) => !((r.context || {}).params),
      export: (r) => U.num(r.context && r.context.params && r.context.params.commissionPct),
      render: (r) => {
        const p = (r.context || {}).params;
        if (!p) return RPV.dash('Нет параметров расчёта');
        const e = RPV.econAt(r, U.num(r.proposed && r.proposed.sellerPrice));
        return `<input type="number" class="num rp-commission rp-cell-input" data-nm="${r.nmID}" min="0" max="90" step="0.5"
            value="${U.num(p.commissionPct)}" title="Комиссия WB по товару. Правится здесь и в «Себестоимости»." />
          <div class="tiny muted">${e ? U.money(e.commission) : '—'} ₽ с новой цены</div>`;
      } },
    { id: 'logistics', block: 'min', title: 'Доставка нов. цены', num: true,
      export: (r) => U.num(r.context && r.context.params && r.context.params.logisticsRub),
      render: (r) => {
        const p = (r.context || {}).params;
        if (!p) return RPV.dash('Нет параметров расчёта');
        const src = (((p.costSources || {}).logisticsRub) || '');
        return `<input type="number" class="num rp-logistics rp-cell-input" data-nm="${r.nmID}" min="0" step="1"
            value="${U.num(p.logisticsRub)}" title="Логистика WB на единицу. ${src === 'fact' ? 'Взята как факт из отчёта WB.' : 'Заданная вручную или формулой по объёму.'}" />
          <div class="tiny muted">${src === 'fact' ? 'факт из отчёта WB' : (src === 'formula' ? 'по объёму товара' : 'задано вручную')}</div>`;
      } },
    { id: 'expenses', block: 'min', title: 'Расходы нов. цены + эквайринг', required: true, num: true,
      empty: (r) => !RPV.econAt(r, U.num(r.proposed && r.proposed.sellerPrice)),
      export: (r) => { const e = RPV.econAt(r, U.num(r.proposed && r.proposed.sellerPrice)); return e ? RPV.round2(e.acquiring + e.storage + e.packaging + e.accept + e.ad + e.tax) : ''; },
      render: (r) => {
        const e = RPV.econAt(r, U.num(r.proposed && r.proposed.sellerPrice));
        if (!e) return RPV.dash('Нужны параметры расходов и цена');
        const sum = e.acquiring + e.storage + e.packaging + e.accept + e.ad + e.tax;
        return `${U.money(sum)}
          <div class="tiny muted" title="эквайринг ${U.money(e.acquiring)}, хранение ${U.money(e.storage)}, упаковка ${U.money(e.packaging)}, приёмка ${U.money(e.accept)}, реклама ${U.money(e.ad)}, налог ${U.money(e.tax)}">
            хран. + упак. + приёмка + экв. + рекл. + налог</div>`;
      } },
    { id: 'profitNext', block: 'min', title: 'Новая марж. ₽', num: true,
      export: (r) => U.num(r.proposed && r.proposed.profit),
      render: (r) => `<b class="${U.profitClass(U.num(r.proposed && r.proposed.profit))}">${U.money(U.num(r.proposed && r.proposed.profit))}</b>` },
    { id: 'indexMin', block: 'min', title: 'Прогнозный индекс мин. цены', num: true,
      export: (r) => { const v = RPV.priceIndex(r, U.num(r.corridor && r.corridor.min)); return v === null ? '' : v; },
      render: (r) => RPV.indexCellHtml(r, U.num(r.corridor && r.corridor.min), 'индекс, если поставить расчётную минимальную цену') },
    { id: 'corridorMin', block: 'min', title: 'Расчётная мин. цена ₽', required: true, num: true,
      empty: (r) => !(U.num(r.corridor && r.corridor.min) > 0),
      export: (r) => U.num(r.corridor && r.corridor.min),
      render: (r) => {
        const min = U.num(r.corridor && r.corridor.min);
        return min > 0
          ? `${U.money(min)}<div class="tiny muted">${U.num(r.corridor && r.corridor.minByMargin) > 0 ? 'по марже ' + U.money(r.corridor.minByMargin) : 'минимальный порог'}</div>`
          : RPV.dash('Движок не рассчитал минимальную цену — задайте мин. цену или себестоимость');
      } },
    { id: 'corridorMinSpp', block: 'min', title: 'Расчётная мин. цена с СПП ₽', num: true,
      export: (r) => RPV.round2(RPV.sellerWithSpp(r, U.num(r.corridor && r.corridor.min))),
      render: (r) => {
        const v = RPV.sellerWithSpp(r, U.num(r.corridor && r.corridor.min));
        return v > 0 ? U.money(v) : RPV.dash('Нет расчётной минимальной цены');
      } },
    { id: 'corridorMinWallet', block: 'min', title: 'Расчётная мин. цена с WB-кошельком ₽', num: true,
      export: (r) => RPV.round2(RPV.withWallet(r, U.num(r.corridor && r.corridor.min))),
      render: (r) => {
        const v = RPV.withWallet(r, U.num(r.corridor && r.corridor.min));
        return v > 0 ? U.money(v) : RPV.dash('Нет расчётной минимальной цены или не задан % кошелька');
      } },
    { id: 'minPrice', block: 'min', title: 'Мин. цена', required: true, num: true,
      empty: (r) => !(U.num(RPV.rowConfig(r.nmID).minPrice) > 0) && !(U.num(r.corridor && r.corridor.min) > 0),
      export: (r) => U.num(RPV.rowConfig(r.nmID).minPrice),
      render: (r) => {
        const cfg = RPV.rowConfig(r.nmID);
        return `<input type="number" step="10" class="num rp-minprice rp-cell-input" data-nm="${r.nmID}" value="${cfg.minPrice || ''}"
            placeholder="${U.num(r.corridor && r.corridor.min)}" title="Минимальная цена: ниже неё репрайсер не опустится" />`;
      } },
    { id: 'minMarginPct', block: 'min', title: 'Мин. марж. %', required: true, num: true,
      empty: (r) => { const e = RPV.econAt(r, RPV.minPriceOf(r)); return !e; },
      export: (r) => { const e = RPV.econAt(r, RPV.minPriceOf(r)); return e ? e.marginPct : ''; },
      render: (r) => {
        const e = RPV.econAt(r, RPV.minPriceOf(r));
        return e ? `<span class="${U.profitClass(e.marginPct)}">${U.pct(e.marginPct, 1)}</span>` : RPV.dash('Нет минимальной цены или параметров расходов');
      } },
    { id: 'minMarginRub', block: 'min', title: 'Мин. марж. ₽', required: true, num: true,
      empty: (r) => { const e = RPV.econAt(r, RPV.minPriceOf(r)); return !e; },
      export: (r) => { const e = RPV.econAt(r, RPV.minPriceOf(r)); return e ? e.profit : ''; },
      render: (r) => {
        const e = RPV.econAt(r, RPV.minPriceOf(r));
        return e ? `<span class="${U.profitClass(e.profit)}">${U.money(e.profit)}</span>` : RPV.dash('Нет минимальной цены или параметров расходов');
      } },
    { id: 'calcMinMarginPct', block: 'min', title: 'Марж. расчётной мин. цены %', num: true,
      export: (r) => { const e = RPV.econAt(r, U.num(r.corridor && r.corridor.min)); return e ? e.marginPct : ''; },
      render: (r) => {
        const e = RPV.econAt(r, U.num(r.corridor && r.corridor.min));
        return e ? `<span class="muted">${U.pct(e.marginPct, 1)}</span>` : RPV.dash('Нет расчётной минимальной цены');
      } },
    { id: 'calcMinMarginRub', block: 'min', title: 'Марж. расчётной мин. цены ₽', num: true,
      export: (r) => { const e = RPV.econAt(r, U.num(r.corridor && r.corridor.min)); return e ? e.profit : ''; },
      render: (r) => {
        const e = RPV.econAt(r, U.num(r.corridor && r.corridor.min));
        return e ? `<span class="muted">${U.money(e.profit)}</span>` : RPV.dash('Нет расчётной минимальной цены');
      } },

    // ── Блок «Цена (вне акции)» ────────────────────────────────────────────
    { id: 'indexBase', block: 'base', title: 'Прогнозный индекс базовой цены', num: true,
      export: (r) => { const v = RPV.priceIndex(r, U.num(r.corridor && r.corridor.max)); return v === null ? '' : v; },
      render: (r) => RPV.indexCellHtml(r, U.num(r.corridor && r.corridor.max), 'индекс, если поставить базовую цену') },
    { id: 'baseTarget', block: 'base', title: 'Расчётная базовая цена ₽', required: true, num: true,
      empty: (r) => !(U.num(r.corridor && r.corridor.max) > 0),
      export: (r) => U.num(r.corridor && r.corridor.max),
      render: (r) => {
        const cfg = RPV.rowConfig(r.nmID);
        return `<input type="number" step="10" min="0" class="num rp-baseprice rp-cell-input" data-nm="${r.nmID}"
            value="${cfg.basePriceTarget || ''}" placeholder="${U.num(r.corridor && r.corridor.max)}"
            title="Верхний порог стратегии: базовая цена, выше которой репрайсер не поднимает" />
          <div class="tiny muted">порог ${U.money(U.num(r.corridor && r.corridor.max))}</div>`;
      } },
    { id: 'baseTargetSpp', block: 'base', title: 'Расчётная базовая цена с СПП ₽', num: true,
      export: (r) => RPV.round2(RPV.sellerWithSpp(r, U.num(r.corridor && r.corridor.max))),
      render: (r) => { const v = RPV.sellerWithSpp(r, U.num(r.corridor && r.corridor.max)); return v > 0 ? U.money(v) : RPV.dash('Нет базовой цены'); } },
    { id: 'baseTargetWallet', block: 'base', title: 'Расчётная базовая цена с WB-кошельком ₽', num: true,
      export: (r) => RPV.round2(RPV.withWallet(r, U.num(r.corridor && r.corridor.max))),
      render: (r) => { const v = RPV.withWallet(r, U.num(r.corridor && r.corridor.max)); return v > 0 ? U.money(v) : RPV.dash('Нет базовой цены или не задан % кошелька'); } },
    { id: 'basePrice', block: 'base', title: 'Базовая цена', required: true, num: true,
      empty: (r) => !(U.num(r.current && r.current.basePrice) > 0) && !U.num(((S.state.priceDrafts || {})[String(r.nmID)] || {}).basePrice),
      export: (r) => U.num(r.current && r.current.basePrice),
      render: (r) => `${U.money(U.num(r.current && r.current.basePrice))}${RPV.sizePriceNote(r)}` },
    { id: 'baseMarginPct', block: 'base', title: 'Базовая марж. %', required: true, num: true,
      empty: (r) => { const e = RPV.econAt(r, U.num(r.current && r.current.basePrice)); return !e; },
      export: (r) => { const e = RPV.econAt(r, U.num(r.current && r.current.basePrice)); return e ? e.marginPct : ''; },
      render: (r) => {
        const e = RPV.econAt(r, U.num(r.current && r.current.basePrice));
        return e ? `<span class="${U.profitClass(e.marginPct)}">${U.pct(e.marginPct, 1)}</span>` : RPV.dash('Нужна базовая цена и параметры расходов');
      } },
    { id: 'baseMarginRub', block: 'base', title: 'Базовая марж. ₽', required: true, num: true,
      empty: (r) => { const e = RPV.econAt(r, U.num(r.current && r.current.basePrice)); return !e; },
      export: (r) => { const e = RPV.econAt(r, U.num(r.current && r.current.basePrice)); return e ? e.profit : ''; },
      render: (r) => {
        const e = RPV.econAt(r, U.num(r.current && r.current.basePrice));
        return e ? `<span class="${U.profitClass(e.profit)}">${U.money(e.profit)}</span>` : RPV.dash('Нужна базовая цена и параметры расходов');
      } }
  ],

  /**
   * Набор колонок по умолчанию: всё, что нужно для решения, кроме тяжёлых
   * служебных блоков (конкуренты, отстройка, прогнозные индексы по кошельку).
   */
  DEFAULT_COLUMNS: ['item', 'allowSend', 'strategy', 'tag', 'nmID', 'vendorCode', 'rule', 'warnings', 'status', 'why',
    'brand', 'costNow', 'stock', 'costManual', 'currency', 'plan',
    'value', 'indexNow', 'priceNow', 'promos', 'buyerNow', 'sppPct', 'marginNow', 'myPrice', 'competitor', 'offset',
    'indexNext', 'priceNext', 'buyerNext', 'delta',
    'priceMode', 'commission', 'expenses', 'corridorMin', 'minPrice', 'minMarginPct', 'minMarginRub',
    'baseTarget', 'basePrice', 'baseMarginPct', 'baseMarginRub'],
  /**
   * Компактный набор — по одной ключевой колонке из каждого блока плюс обязательные:
   * видно, что за товар, сколько стоит сейчас и будет, где порог минимальной цены
   * и какая базовая цена. Помещается на небольшом экране без горизонтальной прокрутки.
   */
  COMPACT_COLUMNS: ['item', 'costNow', 'priceNow', 'priceNext', 'delta', 'minPrice', 'basePrice', 'why'],
  COLS_KEY: 'wb.repricer.columns',

  /** Какие колонки показывать: из localStorage, иначе набор по умолчанию. */
  visibleCols() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(RPV.COLS_KEY);
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list) && list.length) return new Set(list.map(String));
    } catch (e) { /* повреждённое значение — берём набор по умолчанию */ }
    return new Set(RPV.DEFAULT_COLUMNS);
  },

  saveVisibleCols(set) {
    try {
      if (window.localStorage) window.localStorage.setItem(RPV.COLS_KEY, JSON.stringify(Array.from(set)));
    } catch (e) { /* приватный режим браузера — не критично */ }
  },

  /** Видимые колонки в порядке справочника COLUMNS (обязательные — всегда). */
  visibleColumns() {
    const vis = RPV.visibleCols();
    return RPV.COLUMNS.filter((c) => c.always || vis.has(c.id));
  },

  /**
   * Блоки для верхнего ряда шапки: только те, у которых есть видимые колонки,
   * с colSpan по числу этих колонок. Пустых блоков в шапке быть не должно.
   */
  groupsForRender(cols) {
    const out = [];
    for (const b of RPV.BLOCKS) {
      const span = cols.filter((c) => c.block === b.id).length;
      if (span > 0) out.push({ title: b.title, span, hint: b.hint || '' });
    }
    return out;
  },

  /** Для совместимости: оставить только видимые колонки из произвольного списка. */
  filterCols(cols) {
    const vis = RPV.visibleCols();
    return cols.filter((c) => c.always || vis.has(c.id));
  },

  /** Окно выбора колонок: блок целиком или отдельная колонка внутри блока. */
  openColumnsPicker() {
    const vis = RPV.visibleCols();
    const body = U.el('div');
    const blockHtml = RPV.BLOCKS.map((b) => {
      const cols = RPV.COLUMNS.filter((c) => c.block === b.id);
      const optional = cols.filter((c) => !c.always);
      const allOn = optional.length > 0 && optional.every((c) => vis.has(c.id));
      return `<div class="card" style="padding:10px;margin-bottom:8px" data-block-card="${b.id}">
        <label class="checkline" style="margin:0 0 6px"><input type="checkbox" data-block="${b.id}" ${allOn ? 'checked' : ''} />
          <b>${U.esc(b.title)}</b> <span class="tiny muted">${U.esc(b.hint || '')}</span></label>
        <div class="grid g2" style="gap:4px 10px">
          ${cols.map((c) => `<label class="checkline" style="margin:0">
              <input type="checkbox" data-col="${c.id}" data-block-of="${b.id}" ${c.always ? 'checked disabled' : (vis.has(c.id) ? 'checked' : '')} />
              ${U.esc(c.title || 'Действия')}${c.always ? ' <span class="tiny muted">всегда</span>' : ''}${c.required ? ' <span class="tiny neg">*</span>' : ''}
            </label>`).join('')}
        </div></div>`;
    }).join('');
    body.innerHTML = `
      <div class="alert info">Колонки сгруппированы в блоки — как в Excel. Можно выключить
        весь блок или отдельную колонку внутри него. Звёздочкой отмечены обязательные поля:
        пустое значение подсвечивается, а строка не попадает в предложение.
        Товар, текущая и новая цена, изменение и «почему» показаны всегда.</div>
      <div style="max-height:52vh;overflow:auto;margin-top:10px">${blockHtml}</div>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button class="btn btn-sm" id="cp-compact">Компактный набор (по колонке из блока)</button>
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
              const col = RPV.COLUMNS.find((c) => c.id === id);
              if ((col && col.always) || cb.checked) next.add(id);
            });
            RPV.saveVisibleCols(next);
            RPV.renderResults();
            App.toast('Показывается колонок: ' + next.size + ' из ' + RPV.COLUMNS.length, 'ok', 4000);
          } }
      ]
    });
    // переключатель блока включает/выключает все его необязательные колонки
    body.querySelectorAll('[data-block]').forEach((cb) => {
      cb.onchange = () => {
        body.querySelectorAll('[data-col][data-block-of="' + cb.getAttribute('data-block') + '"]').forEach((col) => {
          const def = RPV.COLUMNS.find((c) => c.id === col.getAttribute('data-col'));
          if (!def || def.always) return;
          col.checked = cb.checked;
        });
      };
    });
    body.querySelector('#cp-compact').onclick = () => {
      body.querySelectorAll('[data-col]').forEach((cb) => {
        const col = RPV.COLUMNS.find((c) => c.id === cb.getAttribute('data-col'));
        if (col && col.always) return;
        cb.checked = RPV.COMPACT_COLUMNS.includes(cb.getAttribute('data-col'));
      });
    };
    body.querySelector('#cp-full').onclick = () => {
      body.querySelectorAll('[data-col]').forEach((cb) => { cb.checked = true; });
      body.querySelectorAll('[data-block]').forEach((cb) => { cb.checked = true; });
    };
    body.querySelector('#cp-default').onclick = () => {
      body.querySelectorAll('[data-col]').forEach((cb) => {
        const col = RPV.COLUMNS.find((c) => c.id === cb.getAttribute('data-col'));
        if (col && col.always) return;
        cb.checked = RPV.DEFAULT_COLUMNS.includes(cb.getAttribute('data-col'));
      });
      body.querySelectorAll('[data-block]').forEach((cb) => { cb.checked = false; });
    };
  },

  // ── Вспомогательные вычисления для новых колонок ─────────────────────────
  /** Стоимость товара из costs.json вместе с несохранёнными правками очереди. */
  rowCost(nmID) {
    const nm = String(nmID);
    const stored = (S.state.costs || {})[nm] || {};
    const pending = (RPV.pendingEdits.get(nm) || {}).cost || {};
    return Object.assign({}, stored, pending);
  },
  round2(v) { return Math.round(U.num(v) * 100) / 100; },
  walletPctOf() { return U.num(((RPV.rstate || {}).config || {}).priceEdit && RPV.rstate.config.priceEdit.walletPct); },
  /** СПП товара: из параметров расчёта, иначе из карточки/настроек. */
  sppValue(r) {
    const p = (r.context && r.context.params) || null;
    if (p && p.sppPct !== undefined) return U.num(p.sppPct);
    return U.num(RPV.sppOf(r));
  },
  /** Цена, которую платит покупатель с учётом СПП (без WB-кошелька). */
  sellerWithSpp(r, price) { return U.num(price) > 0 ? RPV.round2(U.num(price) * (1 - RPV.sppValue(r) / 100)) : 0; },
  /** Цена с учётом WB-кошелька: то, что покупатель платит кошельком. */
  /**
   * «Цена с WB-кошельком» — это цена, которую нужно поставить, чтобы покупатель,
   * платящий кошельком WB, заплатил столько же: price ÷ (1 − СПП/100) ÷ (1 − кошелёк/100).
   * Так же приводится цена конкурента в колонке «Конкурент» (как карта Ozon в референсе).
   */
  withWallet(r, price) {
    const wallet = Math.min(99, RPV.walletPctOf(r));
    const spp = Math.min(99, RPV.sppValue(r));
    const p = U.num(price);
    if (!(p > 0)) return 0;
    return RPV.round2(p / ((1 - spp / 100) * (1 - wallet / 100)));
  },
  /** Маржа/прибыль при произвольной цене — тем же EC.calcUnit, без своих формул. */
  econAt(r, price) {
    const p = (r.context && r.context.params) || null;
    if (!p || !(U.num(price) > 0) || typeof EC === 'undefined') return null;
    try { return EC.calcUnit(U.num(price), p); } catch (e) { return null; }
  },
  /** Индекс цены: наша цена покупателю (с СПП) ÷ цена лучшего конкурента, %. */
  priceIndex(r, sellerPrice) {
    const comp = U.num(r.context && r.context.competitorPrice);
    const price = U.num(sellerPrice);
    if (!(comp > 0) || !(price > 0)) return null;
    return RPV.round2((RPV.sellerWithSpp(r, price) / comp) * 100);
  },
  indexCellHtml(r, sellerPrice, hint) {
    const idx = RPV.priceIndex(r, sellerPrice);
    if (idx === null) {
      const v = RPV.valueStatus(r);
      return `<span class="muted tiny" title="${U.esc('Индекс не считается: ' + (U.num(r.context && r.context.competitorPrice) > 0 ? 'нет цены' : 'конкурентов нет'))}">Без индекса</span>
        <div class="tiny muted">${UI.badge(v.label, v.kind)}</div>`;
    }
    const v = RPV.valueStatus(r);
    return `<b class="${idx < 100 ? 'pos' : 'warnc'}" title="${U.esc(hint)}">${U.pct(idx, 1)}</b>
      <div class="tiny muted">${UI.badge(v.label, v.kind)}</div>`;
  },
  /** Минимальная цена строки: своя настройка, иначе расчётный порог движка. */
  minPriceOf(r) {
    const own = U.num(RPV.rowConfig(r.nmID).minPrice);
    return own > 0 ? own : U.num(r.corridor && r.corridor.min);
  },
  /** ROI: прибыль за месяц ÷ стоимость остатка по себестоимости. */
  roiOf(r) {
    const cost = U.num(r.current && r.current.costPriceRub);
    const stock = U.num(r.context && r.context.stock);
    if (!(cost > 0) || !(stock > 0)) return null;
    const perMonth = U.num(r.context && r.context.salesMonthQty) ||
      U.num(r.context && r.context.salesPerDay) * 30;
    const profitMonth = U.num(r.current && r.current.profit) * perMonth;
    return RPV.round2((profitMonth / (stock * cost)) * 100);
  },
  /** % возврата: возвраты ÷ продажи за 30 дней. */
  returnPctOf(r) {
    const sales = U.num(r.context && r.context.sales30);
    const returns = U.num(r.context && r.context.returns30);
    if (!(sales > 0)) return null;
    return RPV.round2((returns / sales) * 100);
  },
  /** Тип новой цены по-русски. */
  priceModeText(r) {
    const mode = (r.proposed && r.proposed.priceMode) || '';
    if (!mode) return '—';
    if (mode === 'promo-exit') return 'возврат из акции';
    if (mode === 'promo-join' || mode === 'promo-discount-floor' || mode === 'promo-hold') return 'цена акции';
    if (mode === 'keep') return 'без изменений';
    return 'обычная';
  },
  /** Человекочитаемая сводка действующего правила товара. */
  ruleSummary(r) {
    const cfg = RPV.rowConfig(r.nmID);
    const defs = (RPV.rstate || {}).defaults || {};
    const parts = [];
    if (r.strategyTitle || r.strategy) parts.push(r.strategyTitle || r.strategy);
    const mode = cfg.competitorOffsetMode === 'rub' ? 'rub' : 'pct';
    const off = mode === 'rub' ? U.num(cfg.competitorOffsetRub) : U.num(cfg.competitorOffsetPct);
    if (off) parts.push('конкурент ' + (off > 0 ? '+' : '−') + Math.abs(off) + (mode === 'rub' ? ' ₽' : '%'));
    const target = cfg.targetMarginPct !== undefined && cfg.targetMarginPct !== '' ? cfg.targetMarginPct : defs.targetMarginPct;
    if (target !== undefined && target !== null && target !== '') parts.push('маржа ' + U.pct(U.num(target), 0));
    const min = U.num(cfg.minPrice);
    const max = U.num(cfg.basePriceTarget);
    if (min > 0 || max > 0) parts.push('коридор ' + (min > 0 ? Math.round(min) : '—') + '–' + (max > 0 ? Math.round(max) : '—'));
    return parts.length ? parts.join(' · ') : 'как в общих настройках';
  },
  /** Пустая ячейка с причиной — вместо выдуманных данных. */
  dash(reason) { return `<span class="muted" title="${U.esc(reason || '')}">—</span>`; },

  /**
   * Значение колонки для CSV/Excel: без HTML и без форматирования денег,
   * чтобы в таблице остались числа, а не строки с пробелами и «₽».
   */
  exportCell(r, col) {
    try {
      const v = col && col.export ? col.export.call(this, r) : '';
      return v === undefined || v === null ? '' : v;
    } catch (e) { return ''; }
  },

  /**
   * Таблица для Excel: первый ряд — названия блоков (только в первой колонке блока,
   * остальные пустые), второй — названия колонок, дальше значения видимых колонок.
   * Отдельный метод, а не код внутри обработчика: его же проверяет uitest.
   */
  buildExportTable(list) {
    const cols = this.visibleColumns();
    const blockRow = cols.map((c, i) => {
      const first = i === 0 || cols[i - 1].block !== c.block;
      if (!first) return '';
      const b = this.BLOCKS.find((x) => x.id === c.block);
      return b ? b.title : '';
    });
    const headRow = cols.map((c) => c.title || 'Действия');
    const dataRows = (list || []).map((r) => cols.map((c) => this.exportCell(r, c)));
    return { cols, blockRow, headRow, dataRows };
  },

  /** Строки CSV: заголовок каждой колонки — «Блок / Колонка». */
  buildCsvRows(list) {
    const cols = this.visibleColumns();
    return (list || []).map((r) => {
      const row = {};
      cols.forEach((c) => {
        const b = this.BLOCKS.find((x) => x.id === c.block);
        const key = (b ? b.title + ' / ' : '') + (c.title || 'Действия');
        row[key] = this.exportCell(r, c);
      });
      row['Артикул / Ошибки данных'] = this.rowErrors(r).join('; ');
      row['Артикул / Пояснение'] = (r.notes || []).join(' | ');
      return row;
    });
  },

  /**
   * Статус выгодности товара — как в репрайсере INDEEPA: сразу видно, что продавать выгодно,
   * а что тянет в минус. Считается по марже относительно целевой и минимальной.
   * «Без индекса» — нет данных для оценки (не задана себестоимость).
   */
  valueStatus(r) {
    const cfg = this.rowConfig(r.nmID);
    const defs = this.rstate.defaults || {};
    const target = U.num(cfg.targetMarginPct !== undefined ? cfg.targetMarginPct : defs.targetMarginPct);
    const minMargin = U.num(cfg.minMarginPct !== undefined ? cfg.minMarginPct : defs.minMarginPct);
    const next = r.proposed || {};
    const margin = U.num(next.marginPct !== undefined ? next.marginPct : (r.current || {}).marginPct);
    // себестоимость берём ту, по которой реально считает движок (с учётом валюты),
    // а cogsByNm — только запасной вариант для старых ответов без поля.
    const cur = r.current || {};
    // поле приходит из расчёта; если движок его не прислал (старый кэш) — берём cogsByNm.
    const hasCost = cur.costPriceRub !== undefined && cur.costPriceRub !== null;
    const eff = hasCost ? U.num(cur.costPriceRub) : U.num((this.cogsByNm || {})[String(r.nmID)]);
    if (!(eff > 0)) return { id: 'noindex', label: 'Без индекса', kind: '', hint: 'Себестоимость не задана — оценить выгодность нельзя' };
    if (U.num(next.profit) < 0 || margin < minMargin) return { id: 'bad', label: 'Невыгодный', kind: 'danger', hint: 'Прибыль отрицательная или маржа ниже минимальной (' + U.pct(minMargin) + ')' };
    if (target > 0 && margin >= target) return { id: 'super', label: 'Супер-выгодный', kind: 'ok', hint: 'Маржа ' + U.pct(margin) + ' ≥ целевой ' + U.pct(target) };
    return { id: 'good', label: 'Выгодный', kind: 'info', hint: 'Маржа ' + U.pct(margin) + ' между минимальной и целевой' };
  },

  /**
   * Ошибки валидации строки. Как в INDEEPA: товар с незаполненными данными показывается
   * с красной подписью и НЕ предлагается к отправке — иначе репрайсер считал бы цену
   * «от балды» и отправлял её в WB.
   */
  rowErrors(r) {
    const out = r.error ? [String(r.error)] : [];
    const cfg = this.rowConfig(r.nmID);
    const cur = r.current || {};
    // поле приходит из расчёта; если движок его не прислал (старый кэш) — берём cogsByNm.
    const hasCost = cur.costPriceRub !== undefined && cur.costPriceRub !== null;
    const eff = hasCost ? U.num(cur.costPriceRub) : U.num((this.cogsByNm || {})[String(r.nmID)]);
    if (!(eff > 0)) out.push('не задана себестоимость');
    else if (eff <= 2) out.push('себестоимость должна быть больше 2 ₽');
    // валюта себестоимости без курса — блокирующая ошибка: иначе цена в WB ушла бы «из воздуха»
    if (cur.costCurrencyError) out.push(cur.costCurrencyError);
    const floor = U.num(cfg.minPrice) || U.num(r.corridor && r.corridor.min);
    if (!(floor > 0)) out.push('не задан порог минимальной цены');
    const base = U.num(r.current && r.current.basePrice);
    // цена, сохранённая вручную в «Цены и скидки», задаст базовую при отправке —
    // поэтому ругаться «не задана базовая цена» при живом черновике нельзя (как на сервере)
    const draftBase = U.num(((S.state.priceDrafts || {})[String(r.nmID)] || {}).basePrice);
    if (!(base > 0) && !(draftBase > 0)) out.push('базовая цена в WB не задана — обновите данные из кабинета или сохраните свою цену');
    // запрет отправки не ошибка данных, но причина, по которой цена не уйдёт
    if (cfg.allowSend === false) out.push('отправка цен запрещена настройкой товара');
    return out;
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
    const title = `WB не отдаёт цену товара целиком: цены заданы по размерам. В расчёт взята минимальная цена размера${spread}. Отправка изменит цену всех размеров — поразмерная отправка делается отдельным режимом.`;
    return `<div class="tiny"><span class="rp-sizeprice" title="${U.esc(title)}">${UI.badge('цена по размерам', 'warn')}</span></div>`;
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
      return input + '<div class="muted tiny">⚪ План не заполнен, % выполнения не рассчитан</div>';
    }
    const ratio = U.num(pl.ratio) * 100;
    const cls = ratio >= 100 ? 'pos' : (ratio >= 60 ? 'warnc' : 'neg');
    return `${input}<br><b class="${cls}">${U.pct(ratio, 0)}</b>
      <div class="tiny muted">факт ${U.fmt(pl.fact || 0)} из ${U.fmt(pl.planQty)} шт</div>`;
  },

  /** Размер страницы таблицы цен: тысячи строк с десятками полей ввода вешают браузер. */
  PAGE_SIZE: 200,
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
    if (!edits.length) { App.toast('Нет несохранённых изменений', 'warn'); return; }
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
      const res = await API.invoke('repricer:calc', { full: true });
      this.results = res.results || [];
      this.summary = res.summary;
      await this.loadState();
      if (this.tab === 'strategies') this.renderStrategies();
      else { this.drawSummary(); this.renderResults(); this.drawTiles(); }
      await this.drawProposal();
    } catch (e) {
      App.toast(e.message, 'err', 9000);
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
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
      const res = await API.invoke('repricer:calc', { full: true });
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
              const res = await API.invoke('repricer:calc', { full: true });
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
    if (!bad.length) return '';
    const sample = bad.slice(0, 5).map((r) =>
      '<span class="mono tiny">' + U.esc(String(r.vendorCode || r.nmID)) + '</span>').join(', ');
    return `<div class="alert danger" style="margin-bottom:12px">
      <b>У ${U.fmt(bad.length)} товаров не заполнены данные — репрайсер не предложит их к отправке.</b>
      <div class="hint" style="margin-top:4px">Типичные причины: не задана себестоимость, нет порога минимальной цены,
        нет базовой цены. Заполните в строке (колонки «Стратегия» и «Пол / потолок») или массово во вкладке
        «Параметры товаров». Примеры: ${sample}${bad.length > 5 ? ' и ещё ' + U.fmt(bad.length - 5) : ''}.</div>
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
    // внутренний тег — личный фильтр продавца (например, «акция», «склад Казань»)
    if (f.tag) list = list.filter((r) => String(this.rowConfig(r.nmID).tag || '') === String(f.tag));
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
    const q = (f.q || '').toLowerCase();
    if (q) list = list.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode || '').toLowerCase().includes(q) || String(r.title || '').toLowerCase().includes(q));
    return list;
  },

  renderResults() {
    const host = this.container.querySelector('#rp-grid');
    if (!host) return;
    const list = this.filteredResults().map((r) => r.error ? Object.assign({
      title: r.title || r.vendorCode || String(r.nmID), current: {}, proposed: {},
      corridor: {}, context: {}, delta: {}, warnings: []
    }, r) : r);
    this.itemsByNm = new Map((S.state.items || []).map((it) => [String(it.nmID), it]));
    const pageRows = this.pageOf(list);
    const st = S.state;
    this.selection = this.selection || new Set();
    host.innerHTML = '';

    /**
     * Колонки строятся ТОЛЬКО из справочника COLUMNS и в его порядке, поэтому
     * шапка (включая блоки), строки и экспорт всегда совпадают. groups — верхний
     * ряд двухуровневой шапки: название блока растянуто на его видимые колонки.
     */
    const visible = this.visibleColumns();
    const gridCols = visible.map((def) => ({
      id: def.id,
      title: def.title,
      num: !!def.num,
      pinned: !!def.pinned,
      required: !!def.required,
      cls: def.cls,
      width: def.width,
      cellClass: (r) => {
        const classes = [];
        if (def.required && def.empty && def.empty(r)) classes.push('required-empty');
        // визуальный разделитель блоков на границе колонок
        const idx = visible.indexOf(def);
        if (idx > 0 && visible[idx - 1].block !== def.block) classes.push('rp-block-sep');
        return classes.join(' ');
      },
      render: (r) => def.render(r)
    }));

    const grid = UI.table({
      columns: gridCols,
      groups: this.groupsForRender(visible),
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
        if (c.id === 'item') return `<b>${list.length}</b> строк`;
        if (c.id === 'delta') return `<span class="${U.profitClass(U.sum(list, (r) => r.delta.profitMonth))}">${U.signed(Math.round(U.sum(list, (r) => r.delta.profitMonth)))} ₽/мес</span>`;
        return '';
      }
    });
    if (this.density === 'compact') grid.el.querySelector('table').classList.add('dense');
    host.appendChild(grid.el);

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
        errors: 'с незаполненными данными', loss: 'убыточные', warn: 'с предупреждениями'
      };
      segCount.textContent = U.fmt(list.length) + ' ' + (labels[this.itemFilter.seg] || 'товаров') +
        (this.density === 'compact' ? ' · плотный режим' : '');
    }

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
    host.querySelectorAll('.rp-strategy, .rp-minprice, .rp-baseprice, .rp-plan, .rp-off-mode, .rp-off-val, .rp-off-type, .rp-off-sku, .rp-use-sku, .rp-off-logic, .rp-allow-send, .rp-tag').forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        const nm = inp.getAttribute('data-nm');
        const patch = {};
        if (inp.classList.contains('rp-strategy')) patch.strategy = inp.value || null;
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
        }
        else if (inp.classList.contains('rp-allow-send')) patch.allowSend = !!inp.checked;
        else if (inp.classList.contains('rp-tag')) patch.tag = String(inp.value || '').trim().slice(0, 40) || null;
        else if (inp.classList.contains('rp-off-sku')) patch.competitorId = inp.value || null;
        else if (inp.classList.contains('rp-use-sku') || inp.classList.contains('rp-off-logic')) {
          const sku = host.querySelector('.rp-off-sku[data-nm="' + nm + '"]');
          patch.competitorId = (inp.classList.contains('rp-use-sku') ? inp.checked : inp.value === 'sku') && sku ? (sku.value || (sku.options[1] && sku.options[1].value)) : null;
        }
        this.stageEdit(nm, 'config', patch);
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
     * Правки вне очереди stageEdit не пишутся: себестоимость, остаток и валюта уходят
     * в costs.json, комиссия и доставка — в параметры товара. Один пересчёт на пачку.
     */
    host.querySelectorAll('.rp-cost, .rp-stock, .rp-currency, .rp-commission, .rp-logistics').forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        const nm = inp.dataset.nm;
        if (inp.classList.contains('rp-cost')) this.stageEdit(nm, 'cost', { costPriceRub: Math.max(0, U.num(inp.value)) });
        else if (inp.classList.contains('rp-stock')) this.stageEdit(nm, 'cost', { stock: Math.max(0, Math.round(U.num(inp.value))) });
        else if (inp.classList.contains('rp-currency')) this.stageEdit(nm, 'cost', { currency: String(inp.value || 'RUB').toUpperCase() });
        else if (inp.classList.contains('rp-commission')) this.stageEdit(nm, 'config', { commissionPct: Math.max(0, Math.min(90, U.num(inp.value))) });
        else if (inp.classList.contains('rp-logistics')) this.stageEdit(nm, 'config', { logisticsRub: Math.max(0, U.num(inp.value)) });
      };
    });

    // добавить конкурента прямо из строки — без перехода в другой раздел
    host.querySelectorAll('.rp-comp-add').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.quickAddCompetitor(Number(b.dataset.nm)); };
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
      if (!strategy && !(minPrice > 0)) {
        App.toast('Выберите стратегию или укажите минимальную цену', 'warn');
        return;
      }
      btn.disabled = true;
      const patch = {};
      if (strategy) patch.strategy = strategy;
      if (minPrice > 0) patch.minPrice = minPrice;
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
        const res = await API.invoke('repricer:calc', { full: true });
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
            ['Остаток', U.fmt(r.context.stock) + ' шт'],
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
    const list = (proposal.phase === 'proposed' ? proposal.items || [] : []).filter((p) => {
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

    UI.confirmDialog(
      `Отправить ${list.length} цен в Wildberries`,
      `<div class="alert ${loss.length ? 'danger' : (warn.length ? 'warn' : 'info')}">
         Будет отправлено цен: <b>${list.length}</b>
         (${list.filter((r) => r.delta.abs > 0).length} вверх, ${list.filter((r) => r.delta.abs < 0).length} вниз).<br>
         ${warn.length ? `Предупреждений: <b>${warn.length}</b>.<br>` : ''}
         ${loss.length ? `<b class="neg">${loss.length}</b> товаров с отрицательной прибылью после изменения.<br>` : ''}
         Прогноз изменения прибыли: <b class="${U.profitClass(U.sum(list, (r) => r.delta.profitMonth))}">${U.signed(Math.round(U.sum(list, (r) => r.delta.profitMonth)))} ₽/мес</b>.
       </div>
       <p class="hint" style="margin-top:10px">
         Лимит изменения за одно обновление: <b>${U.pct(rs.config.limits.maxChangePerUpdatePct, 0)}</b>
         ${rs.config.limits.maxChangePerDayPct ? ', за сутки: <b>' + U.pct(rs.config.limits.maxChangePerDayPct, 0) + '</b>' : ''}.
         ${rs.demo ? '<br><b>Демо-режим:</b> цены изменятся только в приложении.' : 'Отправка идёт через POST /api/v2/upload/task.'}
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

  async tabPromos(host) {
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
          <b>Как работает выход из акции.</b> API Wildberries <b>не позволяет</b> исключить товар из акции —
          ни из обычной, ни из автоакции (в кабинете это делается Excel-файлом исключений).
          Важно: плановая цена акции считается от <b>базовой</b> цены (база × (1 − требуемая скидка)), поэтому
          простое повышение цены не помогает — плановая цена растёт вместе с ней.
          Рабочий способ один: <b>сделать скидку строго ниже порога акции</b>. Тогда цена со скидкой оказывается
          выше плановой, товар перестаёт соответствовать условиям, и WB выводит его сам.
          Базовую цену приложение подбирает так, чтобы цена для покупателя не упала ниже расчётной.
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
            ${fld('minMarginPct', 'Минимальная маржа, %', c.minMarginPct, '', '0.5')}
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

    UI.modal({
      title: `Настройки артикула — ${r.title}`,
      content: body, size: '',
      buttons: [
        { label: 'Сбросить к общим', class: 'btn-ghost', keepOpen: true, onClick: async () => {
            const patch = {}; patch[String(nmID)] = null;
            await API.invoke('repricer:item-configs:save', { items: patch });
            App.toast('Индивидуальные настройки удалены', 'ok');
            this.rstate = await API.invoke('repricer:state');
            this.draw();
          } },
        { label: 'Отмена' },
        { label: 'Сохранить', class: 'btn-primary', onClick: async () => {
            const patch = {}; patch[String(nmID)] = collect();
            await API.invoke('repricer:item-configs:save', { items: patch });
            this.rstate = await API.invoke('repricer:state');
            App.toast('Настройки артикула сохранены', 'ok');
            if (this.tab === 'strategies') this.renderStrategies();
          } }
      ]
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
          { title: '', render: (r) => `<button class="btn btn-xs btn-ghost" data-cp="${r.nmID}">изменить</button>` }
        ],
        rows: list.slice(0, 500),
        tall: true,
        empty: 'Нет товаров с конкурентами. Нажмите «Шаблон CSV», заполните и загрузите через «Импорт CSV».'
      });
      gh.appendChild(grid.el);
      gh.querySelectorAll('[data-cp]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); this.openCompetitors(Number(b.dataset.cp)); };
      });
    };

    host.querySelector('#cp-q').oninput = U.debounce(drawGrid, 220);
    host.querySelector('#cp-only').onchange = drawGrid;
    drawGrid();
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

    UI.modal({
      title: `Конкуренты — ${r ? r.title : nmID}`,
      content: body, size: 'md',
      buttons: [
        { label: 'Отмена' },
        { label: 'Сохранить', class: 'btn-primary', onClick: async () => {
            const patch = {}; patch[String(nmID)] = comps;
            await API.invoke('repricer:competitors:save', { items: patch });
            this.rstate = await API.invoke('repricer:state');
            App.toast('Конкуренты сохранены', 'ok');
            this.draw();
          } }
      ]
    });
  },

  // ══════════════════════ ВКЛАДКА: ПАРАМЕТРЫ ══════════════════════

  async tabParams(host) {
    const rs = this.rstate;
    const c = rs.config;
    const d = c.defaults;

    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;

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
              <label class="field">Расписание пересчёта
                <select id="pm-mode">
                  ${opt('hourly', c.schedule.mode, 'Ежечасно (рекомендуется)')}
                  ${opt('interval', c.schedule.mode, 'Каждые N минут')}
                  ${opt('daily', c.schedule.mode, 'Раз в сутки в выбранный час')}
                </select>
              </label>
              <label class="field">Интервал пересчёта, минут<input type="number" class="num" id="pm-interval" value="${c.schedule.intervalMinutes}" min="5" max="1440" /></label>
              <label class="field">Час пересчёта (для «раз в сутки»)<input type="number" class="num" id="pm-hour" value="${c.schedule.hourOfDay}" min="0" max="23" /></label>
              <label class="field">Скидка WB-кошелька, %<input type="number" class="num" id="pm-wallet" value="${c.priceEdit.walletPct}" step="0.5" /></label>
              <label class="field">Через сколько отправлять предложение, мин<input type="number" class="num" id="pm-senddelay" value="${U.num(c.schedule.sendDelayMinutes, 40)}" min="1" max="1440" /></label>
            </div>

            <div class="alert info" style="margin-top:12px">
              <b>Двухфазный автоцикл.</b> Фаза 1 (каждые ${U.num(c.schedule.intervalMinutes, 40)} мин) — репрайсер пересчитывает цены
              и <b>показывает</b>, что хочет поставить: установленные цены при этом не меняются.
              Фаза 2 (через ${U.num(c.schedule.sendDelayMinutes, 40)} мин после расчёта) — предложение уходит в WB,
              и только если включена автоотправка. Перед отправкой цены перечитываются из кабинета: позиции,
              которые изменились без приложения, пропускаются — чужие правки не затираются.
            </div>

            <label class="checkline" style="margin-top:12px"><input type="checkbox" id="pm-twophase" ${c.schedule.twoPhase !== false ? 'checked' : ''} />
              <b>Двухфазный цикл: сначала показать предложение, потом отправить</b></label>
            <label class="checkline" style="margin-top:8px"><input type="checkbox" id="pm-autosend" ${c.schedule.autoSend ? 'checked' : ''} />
              <b>Автоматически отправлять предложение в WB</b> (без подтверждения, по расписанию фазы 2)</label>
            <p class="hint" style="margin-top:6px">Рекомендуем сначала держать автоотправку выключенной: репрайсер будет считать цены
              и показывать предложение, а отправлять вы будете вручную из вкладки «Товары».
              Если двухфазный цикл выключить, автоотправка уйдёт в WB сразу после пересчёта — как раньше.</p>
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

    host.querySelector('#pm-save').onclick = async () => {
      const patch = {
        marginMode: host.querySelector('#pm-marginmode').value,
        schedule: {
          mode: host.querySelector('#pm-mode').value,
          intervalMinutes: U.num(host.querySelector('#pm-interval').value, 60),
          hourOfDay: U.num(host.querySelector('#pm-hour').value, 9),
          autoSend: host.querySelector('#pm-autosend').checked,
          twoPhase: host.querySelector('#pm-twophase').checked,
          sendDelayMinutes: U.num(host.querySelector('#pm-senddelay').value, 40),
          sendIntervalMinutes: 0
        },
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
      const res = await API.invoke('repricer:save', patch);
      if (res.config.limits.maxChangePerDayPct !== patch.limits.maxChangePerDayPct) {
        App.toast('Суточный лимит увеличен до лимита за обновление (' + res.config.limits.maxChangePerDayPct + '%)', 'warn', 5000);
      } else App.toast('Параметры репрайсера сохранены', 'ok');
      this.rstate = await API.invoke('repricer:state');
      this.draw();
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
          kinds: mode === 'prices' ? ['price', 'propose'] : ['promo-join', 'promo-exit', 'promo-restore'],
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
        if (e.kind === 'price') return UI.badge('отправлено', 'ok');
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
            </tr>`).join('')}</tbody></table>` : '<div class="muted small" style="padding:8px">Пересчётов ещё не было — нажмите «Пересчитать цены» на вкладке «Новые цены».</div>'}
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

/** Псевдоним для стрелочных функций COLUMNS: внутри объекта this недоступен. */
RPV = Views.repricer;
