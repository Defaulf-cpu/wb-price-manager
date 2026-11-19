'use strict';

/** Себестоимость и расходы: ручное заполнение, CSV-импорт/экспорт, шаблоны по категориям. */
window.Views = window.Views || {};

/**
 * base64 → строка UTF-8 без внешних зависимостей. TextDecoder есть и в Chromium,
 * и в Node; запасной путь — старый escape/unescape для очень старых сборок.
 */
function decodeBase64Text(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
}

Views.costs = {
  title: 'Себестоимость',
  subtitle: 'Ваши данные: закупка, упаковка, реклама — заполняются один раз',

  /** Раздел «Себестоимость» — та же панель, что открывается вкладкой репрайсера. */
  render(container) { this.mount(container); },

  /**
   * Панель себестоимости в произвольном контейнере: раздел «Себестоимость» и вложенная
   * вкладка «Себестоимость» репрайсера используют один и тот же код, поэтому данные
   * и поведение не расходятся. Запись идёт существующим каналом costs:save.
   */
  mount(container) {
    const st = S.state;
    this.container = container;
    this.q = this.q || '';
    this.onlyMissing = this.onlyMissing === undefined ? true : this.onlyMissing;
    this.stickyRowIds = new Set();

    container.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap">
          <div class="alert info grow">
            Себестоимость, упаковку и рекламу вы указываете сами — дальше экономика считается автоматически.
            Здесь удобно заполнять <b>массово</b>: импортом CSV или одним значением на всю категорию.
            <br><span class="tiny">Править параметры одного товара быстрее в репрайсере: двойной клик по строке →
            вкладка «Комиссии и параметры». Значения общие — изменив здесь, вы меняете их и там.</span>
          </div>
        </div>
        <div class="row wrap" style="margin-top:10px">
          <input id="c-q" placeholder="Поиск: артикул, нм-код, название" style="width:300px" value="${U.esc(this.q)}" />
          <select id="c-cat" style="width:200px"><option value="">Все категории</option></select>
          <label class="checkline"><input type="checkbox" id="c-missing" ${this.onlyMissing ? 'checked' : ''} /> только незаполненные</label>
          <div class="grow"></div>
          <button class="btn btn-sm" id="c-import" title="CSV или XLSX: колонки «нм-код», «Себестоимость», «Комиссия %»…">Импорт CSV / XLSX</button>
          <button class="btn btn-sm" id="c-template">Скачать шаблон CSV</button>
          <button class="btn btn-sm btn-ghost" id="c-export">Экспорт текущих</button>
        </div>
      </div>
      <div id="c-grid"></div>
      <div class="bulkbar" id="c-savebar"><span class="hint">Ввод только записывается в память и ничего не применяет. Строка после сохранения останется на экране до повторного применения фильтра — можно заполнить остальные поля.</span><div class="grow"></div><button class="btn btn-ghost" id="c-discard">Отменить изменения</button><button class="btn btn-primary" id="c-save">Сохранить</button></div>
      <div class="bulkbar" id="c-bulk"></div>
    `;

    const catSel = container.querySelector('#c-cat');
    S.categories().forEach((c) => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (this.cat === c) o.selected = true;
      catSel.appendChild(o);
    });

    container.querySelector('#c-q').oninput = U.debounce((e) => { this.q = e.target.value; this.stickyRowIds = new Set(); this.refresh(); }, 220);
    catSel.onchange = (e) => { this.cat = e.target.value; this.stickyRowIds = new Set(); this.refresh(); };
    container.querySelector('#c-missing').onchange = (e) => { this.onlyMissing = e.target.checked; this.stickyRowIds = new Set(); this.refresh(); };
    container.querySelector('#c-import').onclick = () => this.importCsv();
    container.querySelector('#c-template').onclick = () => this.downloadTemplate();
    container.querySelector('#c-export').onclick = () => this.exportCsv();

    this.refresh();
  },

  list() {
    let rows = S.getRows();
    if (this.cat) rows = rows.filter((r) => r.category === this.cat);    const q = (this.q || '').toLowerCase();
    if (q) rows = rows.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode).toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q));
    if (this.onlyMissing) {
      const sticky = this.stickyRowIds || new Set();
      rows = rows.filter((r) => !r.costPrice || r.cogsSource !== 'user' || sticky.has(String(r.nmID)));
      this.stickyRowIds = new Set(rows.map((r) => String(r.nmID)));
    } else this.stickyRowIds = new Set(rows.map((r) => String(r.nmID)));
    return rows;
  },

  async refresh() {
    const epoch = API.generation();
    if (epoch !== API.generation()) return;
    const st = S.state;
    // container задаёт вызвавший экран: раздел «Себестоимость» или вкладка репрайсера
    const root = this.container || document.getElementById('view');
    const host = root && root.querySelector('#c-grid');
    if (!host) return;
    host.innerHTML = '';
    const rows = this.list();
    const costs = st.costs;

    const input = (r, field, value, step) => {
      const i = document.createElement('input');
      i.type = 'number';
      i.className = 'num cellinput';
      i.step = 'any'; // сохранённые точные значения не обязаны попадать на условный шаг формы
      i.value = value === undefined || value === null || value === '' ? '' : value;
      i.placeholder = '—';
      i.onclick = (e) => e.stopPropagation();
      i.dataset.costField = field; i.dataset.nm = String(r.nmID); i.min = '0';
      if (/Pct$/.test(field)) i.max = '100';
      i.onchange = null; // общая очередь ниже собирает и сохраняет только затронутые поля
      return i;
    };

    const draftCosts = window.LocalDrafts ? LocalDrafts.draftItems('costs-grid', 'costs:save') : {};
    const val = (r, f) => {
      const c = costs[String(r.nmID)] || {}, draft = draftCosts[String(r.nmID)] || {};
      if (Object.prototype.hasOwnProperty.call(draft, f)) return draft[f];
      if (f === 'costEntered') return c.costEntered !== undefined ? c.costEntered : (c.costPriceRub !== undefined ? c.costPriceRub : '');
      return c[f] !== undefined ? c[f] : '';
    };

    const grid = UI.table({
      columns: [
        { title: 'Товар', render: (r) => `<div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">${r.nmID} · ${U.esc(r.vendorCode)} · ${U.esc(r.category)}</span></div>` },
        { title: 'Цена WB', num: true, render: (r) => U.money(r.sellerPrice) },
        { title: 'Себестоимость / валюта', num: true, render: (r) => {
          const box = document.createElement('div'); box.appendChild(input(r, 'costEntered', val(r, 'costEntered')));
          const currency = val(r, 'currency') || 'RUB', select = document.createElement('select');
          select.dataset.costField = 'currency'; select.dataset.nm = String(r.nmID); select.setAttribute('aria-label', 'Валюта себестоимости ' + r.nmID);
          [...new Set(['RUB', ...Object.keys(st.settings.costRates || {}), currency])].forEach((code) => { const o = document.createElement('option'); o.value = code; o.textContent = code; o.selected = code === currency; select.appendChild(o); });
          select.onclick = (e) => e.stopPropagation(); box.appendChild(select); box.appendChild(U.el('<div class="tiny muted">В расчёте ' + U.money(r.costPrice) + ' ₽</div>')); return box;
        } },
        { title: 'Упаковка ₽', num: true, render: (r) => input(r, 'packagingRub', val(r, 'packagingRub')) },
        { title: 'Комиссия %', num: true, render: (r) => input(r, 'commissionPct', val(r, 'commissionPct'), '0.5') },
        { title: 'Логистика ₽', num: true, render: (r) => input(r, 'logisticsRub', val(r, 'logisticsRub')) },
        { title: 'Факт WB за неделю', num: true, render: (r) => {
            const f = (st.facts && st.facts[String(r.nmID)]) || null;
            if (!f || !(Number(f.salesQty) > 0)) return '<span class="muted tiny">нет продаж</span>';
            const src = r.costSources || {};
            const tag = (k) => (src[k] === 'fact' ? ' <span class="tiny pos">· учтён</span>' : '');
            return `<div class="tiny"><b>${U.pct(f.commissionPctAvg, 2)}</b> комиссия${tag('commissionPct')}</div>
              <div class="tiny"><b>${U.money(f.logisticsAvg)} ₽</b> логистика${tag('logisticsRub')}</div>
              <div class="tiny muted">хранение ${U.money(f.storageAvg)} ₽ · приёмка ${U.money(f.acceptanceAvg)} ₽ · эквайринг ${U.pct(f.acquiringPctAvg, 2)}</div>
              <div class="tiny muted">продаж ${U.num(f.salesQty).toFixed(0)} · возвраты ${U.pct(f.returnSharePct, 1)} · окно ${U.num(f.windowDays).toFixed(0)} дн</div>`;
          } },
        { title: 'Хранение ₽', num: true, render: (r) => input(r, 'storageRub', val(r, 'storageRub')) },
        { title: 'Реклама %', num: true, render: (r) => input(r, 'adPct', val(r, 'adPct'), '0.5') },
        { title: 'СПП %', num: true, render: (r) => {
            // пустое поле — не «ноль», а «берём из наблюдения витрины / статистики / настройки».
            // Показываем, что именно подставилось, чтобы пустая клетка не выглядела ошибкой.
            const f = (st.facts && st.facts[String(r.nmID)]) || null;
            const srcSpp = (r.costSources || {}).sppPct;
            const has = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
            const hint = f && has(f.sppPctOfficial) ? 'ЛК: ' + U.pct(f.sppPctOfficial) + ' · ' + U.date(f.sppOfficialAt, true) + ' · не live'
              : f && has(f.sppPctWatch) ? 'наблюдение ' + U.pct(f.sppPctWatch) + ' · ' + U.date(f.sppWatchAt, true)
              : f && has(f.sppPctAvg) ? 'среднее продаж ' + U.pct(f.sppPctAvg) : 'общая настройка';
            const cell = document.createElement('div'); cell.appendChild(input(r, 'sppPct', val(r, 'sppPct'), '1'));
            cell.appendChild(U.el('<div class="tiny muted">' + U.esc(hint) + ' · источник расчёта: ' + U.esc(srcSpp || 'настройки') + '</div>'));
            return cell;
          } },
        { title: 'Объём, л', num: true, render: (r) => input(r, 'volumeLiters', val(r, 'volumeLiters') || r.volume, '0.1') },
        { title: 'Прибыль/шт', num: true, render: (r) => `<b class="${U.profitClass(r.profit)}">${U.money(r.profit)}</b>` },
        { title: 'Маржа', num: true, render: (r) => `<span class="${U.profitClass(r.margin)}">${U.pct(r.margin)}</span>` },
        { title: 'Источник', render: (r) => r.cogsSource === 'user' ? UI.badge('введено', 'ok') : (r.cogsSource === 'demo' ? UI.badge('демо', 'demo') : UI.badge('пусто', 'info')) },
        { title: '', render: (r) => `<button class="btn btn-xs btn-ghost" data-open="${r.nmID}">открыть</button>` }
      ],
      rows,
      empty: 'Все товары заполнены или ничего не найдено',
      onRowClick: (r) => this.openItemEditor(r.nmID)
    });
    host.appendChild(grid.el);
    LocalDrafts.bind(host, 'costs-grid', () => {
      const items = {};
      host.querySelectorAll('[data-cost-field]').forEach((input) => {
        const row = items[input.dataset.nm] || (items[input.dataset.nm] = {});
        row[input.dataset.costField] = input.dataset.costField === 'currency' ? input.value : input.value === '' ? null : Number(input.value);
      });
      return [{ channel: 'costs:save', payload: { items } }];
    }, '[data-cost-field]');
    host.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.openItemEditor(Number(b.dataset.open)); };
    });
    const saveBtn = root.querySelector('#c-save'), discardBtn = root.querySelector('#c-discard');
    if (saveBtn) saveBtn.onclick = async () => { saveBtn.disabled = true; try { if (await LocalDrafts.commit({ scope: host, report: true })) { App.toast('Себестоимость и расходы сохранены локально. В WB ничего не отправлено.', 'ok'); this.refresh(); } } finally { saveBtn.disabled = false; } };
    if (discardBtn) discardBtn.onclick = () => { LocalDrafts.discard('costs-grid'); this.refresh(); };

    // массовое заполнение
    const bulk = this.container.querySelector('#c-bulk');
    bulk.innerHTML = `
      <div class="fld"><span>Заполнить для ${rows.length} товаров</span>
        <select id="cb-field" style="width:220px">
          <option value="costPriceRub">Себестоимость, ₽ (валюта → RUB)</option>
          <option value="packagingRub">Упаковка, ₽</option>
          <option value="commissionPct">Комиссия, %</option>
          <option value="logisticsRub">Логистика, ₽</option>
          <option value="storageRub">Хранение, ₽</option>
          <option value="adPct">Реклама, %</option>
          <option value="sppPct">СПП, %</option>
        </select>
      </div>
      <div class="fld"><span>Значение</span><input id="cb-value" type="number" step="any" class="num" style="width:110px" /></div>
      <div class="fld"><span>Способ</span>
        <select id="cb-mode" style="width:230px">
          <option value="set">Установить значение</option>
          <option value="ratio">Как доля от цены WB</option>
          <option value="add">Прибавить к текущему</option>
        </select>
      </div>
      <div class="grow"></div>
      <button class="btn btn-primary" id="cb-apply">Применить</button>
      <button class="btn btn-ghost btn-sm" id="cb-clear">Очистить введённое</button>
    `;
    bulk.querySelector('#cb-apply').onclick = async () => {
      const field = bulk.querySelector('#cb-field').value;
      const v = U.num(bulk.querySelector('#cb-value').value);
      const mode = bulk.querySelector('#cb-mode').value;
      const patch = {};
      rows.forEach((r) => {
        const key = String(r.nmID);
        const cur = st.costs[key] || {};
        let value = v;
        if (mode === 'ratio') value = Math.round(r.sellerPrice * (v / 100) * 100) / 100;
        if (mode === 'add') value = (field === 'costPriceRub' ? U.num(r.costPrice) : U.num(cur[field])) + v;
        patch[key] = { [field]: Math.round(value * 100) / 100, ...(field === 'costPriceRub' ? { currency: 'RUB' } : {}) };
      });
      await S.saveCosts(patch);
      S.invalidate();
      App.toast(`Обновлено товаров: ${rows.length}`, 'ok');
      this.refresh();
    };
    bulk.querySelector('#cb-clear').onclick = () => {
      UI.confirmDialog('Очистить введённые значения', '<div class="alert warn">Будут удалены все вручную введённые себестоимости и расходы (демо-значения останутся).</div>', async () => {
        await API.invoke('costs:clear', {});
        st.costs = {};
        S.invalidate();
        this.refresh();
        App.toast('Введённые значения очищены', 'ok');
      }, 'Очистить');
    };
  },

  openItemEditor(nmID) {
    const st = S.state;
    const r = S.getRows().find((x) => x.nmID === nmID);
    if (!r) return;
    const savedCost = st.costs[String(nmID)] || {};
    const draftCost = window.LocalDrafts ? (LocalDrafts.draftItems('costs-grid', 'costs:save')[String(nmID)] || {}) : {};
    const c = { ...savedCost, ...draftCost };
    if (c.costEntered === undefined && draftCost.costPriceRub !== undefined) c.costEntered = draftCost.costPriceRub;
    const shownCost = c.costEntered !== undefined && c.costEntered !== null && c.costEntered !== '' ? c.costEntered : c.costPriceRub;
    const body = U.el('div');
    const fld = (key, label, hint, step) => `
      <label class="field">${label}
        <input type="number" step="${step || 'any'}" class="num" id="ce-${key}" value="${(key === 'costPriceRub' ? shownCost : c[key]) === undefined || (key === 'costPriceRub' ? shownCost : c[key]) === null ? '' : (key === 'costPriceRub' ? shownCost : c[key])}" placeholder="${hint || ''}" />
      </label>`;
    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">${UI.badge('нм-код ' + nmID)} ${UI.badge(r.vendorCode)} ${UI.badge(r.category)}</div>
      <div class="grid g2" style="gap:10px">
        ${fld('costPriceRub', 'Себестоимость (закупка) в выбранной валюте', 'например 620')}
        <label class="field">Валюта закупки<select id="ce-currency">${[...new Set(['RUB', ...Object.keys(st.settings.costRates || {}), c.currency || 'RUB'])].map((code) => `<option value="${U.esc(code)}" ${code === (c.currency || 'RUB') ? 'selected' : ''}>${U.esc(code)}</option>`).join('')}</select></label>
        ${fld('packagingRub', 'Упаковка, ₽', 'например 15')}
        ${fld('commissionPct', 'Комиссия WB, %', 'пусто = из настроек', '0.5')}
        ${fld('logisticsRub', 'Логистика, ₽/шт', 'пусто = по объёму')}
        ${fld('storageRub', 'Хранение, ₽/шт', 'пусто = из настроек')}
        ${fld('acceptRub', 'Приёмка, ₽/шт', 'пусто = из настроек')}
        ${fld('adPct', 'Реклама, % от цены', 'пусто = из настроек', '0.5')}
        ${fld('adRub', 'Реклама, ₽/шт (фикс)', 'например 40')}
        ${fld('otherPct', 'Прочие расходы, % до СПП', '0', '0.01')}
        ${fld('otherRub', 'Прочие расходы, ₽/шт', '0', '0.01')}
        ${fld('sppPct', 'СПП покупателя, %', 'пусто = из настроек')}
        ${fld('taxRatePct', 'Налог, % (если особый)', 'пусто = из настроек', '0.5')}
      </div>
      <label class="field" style="margin-top:10px">Комментарий
        <input type="text" id="ce-note" value="${U.esc(c.note || '')}" placeholder="поставщик, дата закупки и т.п." /></label>
      <div id="ce-out" style="margin-top:12px"></div>
    `;

    const recalc = () => {
      const ov = {
        costPriceRub: U.num(body.querySelector('#ce-costPriceRub').value),
        packagingRub: U.num(body.querySelector('#ce-packagingRub').value),
        commissionPct: body.querySelector('#ce-commissionPct').value === '' ? undefined : U.num(body.querySelector('#ce-commissionPct').value),
        logisticsRub: body.querySelector('#ce-logisticsRub').value === '' ? undefined : U.num(body.querySelector('#ce-logisticsRub').value),
        storageRub: body.querySelector('#ce-storageRub').value === '' ? undefined : U.num(body.querySelector('#ce-storageRub').value),
        acceptRub: body.querySelector('#ce-acceptRub').value === '' ? undefined : U.num(body.querySelector('#ce-acceptRub').value),
        adPct: body.querySelector('#ce-adPct').value === '' ? undefined : U.num(body.querySelector('#ce-adPct').value),
        adRub: U.num(body.querySelector('#ce-adRub').value),
        otherPct: U.num(body.querySelector('#ce-otherPct').value),
        otherRub: U.num(body.querySelector('#ce-otherRub').value),
        sppPct: body.querySelector('#ce-sppPct').value === '' ? undefined : U.num(body.querySelector('#ce-sppPct').value),
        taxRatePct: body.querySelector('#ce-taxRatePct').value === '' ? undefined : U.num(body.querySelector('#ce-taxRatePct').value)
      };
      Object.keys(ov).forEach((k) => { if (ov[k] === undefined || ov[k] === '') delete ov[k]; });
      const currency = body.querySelector('#ce-currency').value;
      const rate = currency === 'RUB' ? 1 : Number((st.settings.costRates || {})[currency]);
      if (!(rate > 0)) { body.querySelector('#ce-out').innerHTML = '<div class="alert warn">Не задан курс ' + U.esc(currency) + '. Укажите его в «Настройки → Параметры РП»; до этого расчёт и отправка товара заблокированы.</div>'; return; }
      ov.costPriceRub = Math.round(ov.costPriceRub * rate * 100) / 100;
      const merged = Object.assign({}, st.overrides[String(nmID)] || {}, ov);
      const a = EC.analyze(st.settings, r.item, merged, undefined, (st.facts || {})[String(nmID)]);
      body.querySelector('#ce-out').innerHTML = `
        <div class="card" style="background:var(--bg-3)">
          <div class="calc-lines">
            <div class="calc-line"><span class="k">Цена для WB</span><span>${U.money(a.current.revenue)}</span></div>
            <div class="calc-line"><span class="k">Комиссия + логистика + хранение</span><span>${U.money(a.current.commission + a.current.logistics + a.current.storage)}</span></div>
            <div class="calc-line"><span class="k">Реклама, налог и прочие расходы</span><span>${U.money(a.current.ad + a.current.tax + a.current.other)}</span></div>
            <div class="calc-line"><span class="k">Себестоимость и упаковка</span><span>${U.money(a.current.cogs + a.current.packaging)}</span></div>
            <div class="calc-line total"><span class="k">Прибыль / маржа</span><span class="${U.profitClass(a.current.profit)}">${U.money(a.current.profit)} · ${U.pct(a.current.marginPct)}</span></div>
            <div class="calc-line"><span class="k">Цена под цель ${U.pct(a.params.targetMarginPct, 0)}</span><span>${a.current.minPriceForMargin === null ? '—' : U.money(a.current.minPriceForMargin)}</span></div>
          </div>
        </div>`;
    };

    body.querySelectorAll('input, select').forEach((i) => { i.oninput = recalc; i.onchange = recalc; });
    recalc();

    const collect = () => {
      const costs = {};
      for (const input of body.querySelectorAll('input[id^="ce-"], select[id^="ce-"]')) {
        const key = input.id.slice(3);
        if (key === 'out') continue;
        costs[key === 'costPriceRub' ? 'costEntered' : key] = input.type === 'number' ? input.value === '' ? null : Number(input.value) : input.value;
      }
      return [{ channel: 'costs:save', payload: { items: { [String(nmID)]: costs } } }];
    };
    body.querySelectorAll('input[type="number"]').forEach((input) => { input.min = '0'; if (/Pct$/.test(input.id)) input.max = '100'; });
    UI.modal({
      title: `Себестоимость — ${r.title}`, content: body, size: 'md',
      beforeClose: () => LocalDrafts.captureScope(body, true),
      buttons: [{ label: 'Закрыть без сохранения', class: 'btn-ghost' }, { label: 'Сохранить', class: 'btn-primary', onClick: async (modal) => { if (await LocalDrafts.commit({ scope: body, report: true })) await modal.close(); } }]
    });
    LocalDrafts.bind(body, 'cost-editor-' + nmID, collect, 'input[id^="ce-"], select[id^="ce-"]');
  },

  downloadTemplate() {
    const rows = S.getRows().slice(0, 500).map((r) => ({
      'нм-код': r.nmID,
      'Артикул': r.vendorCode,
      'Название': r.title,
      'Себестоимость': '', 'Валюта': 'RUB', 'Прочие расходы %': '', 'Прочие расходы ₽': '',
      'Упаковка ₽': '',
      'Комиссия %': '',
      'Логистика ₽': '',
      'Хранение ₽': '',
      'Приёмка ₽': '',
      'Реклама %': '',
      'Реклама ₽': '',
      'СПП %': '',
      'Объём л': r.volume || '',
      'Комментарий': ''
    }));
    API.exportCsv('wb-costs-template.csv', U.toCsv(rows));
    App.toast('Шаблон выгружен — заполните колонки и загрузите обратно', 'ok');
  },

  /**
   * Импорт себестоимости: CSV разбираем здесь, XLSX отдаём главному процессу.
   * В браузерном окне нет zlib, поэтому ZIP с XML не раскрыть; зато в `electron/service.js`
   * уже есть свой читатель `xlsx-lite` — тот же, что разбирает список товаров акции.
   */
  async importCsv() {
    const file = await API.importFile({
      title: 'Импорт себестоимости',
      extensions: ['csv', 'xlsx', 'txt'],
      filterName: 'Таблицы (CSV, XLSX)'
    });
    if (!file || !file.base64) { App.toast('Файл не выбран', 'warn'); return; }

    if (/\.xlsx$/i.test(String(file.fileName || ''))) {
      let res;
      try {
        res = await API.invoke('costs:import', { base64: file.base64, fileName: file.fileName });
      } catch (e) {
        App.toast('Не удалось прочитать XLSX: ' + (e && e.message ? e.message : e), 'err', 6000);
        return;
      }
      S.state.costs = (await API.invoke('costs:get')).items || {};
      await S.loadGoods(true);
      S.invalidate();
      App.toast(`Импортировано значений из XLSX: ${res.updated}`, 'ok');
      this.refresh();
      return;
    }

    const text = decodeBase64Text(file.base64).replace(/^\uFEFF/, '');
    if (!text) { App.toast('Файл пустой', 'warn'); return; }
    const parsed = U.parseCsv(text);
    if (!parsed.length) { App.toast('В файле нет строк', 'warn'); return; }

    const norm = parsed.map((row) => {
      const get = (...names) => {
        for (const n of names) {
          const k = Object.keys(row).find((x) => x.toLowerCase().replace(/\s/g, '') === n.toLowerCase().replace(/\s/g, ''));
          if (k !== undefined && row[k] !== '') return row[k];
        }
        return undefined;
      };
      return {
        nmID: get('нм-код', 'nmid', 'nmId', 'Артикул WB', 'wbarticle'),
        vendorCode: get('Артикул', 'vendorcode', 'Артикул поставщика'),
        costPriceRub: get('Себестоимость', 'costpricerub', 'Закупка'),
        currency: get('Валюта', 'currency', 'Валюта закупки'),
        otherPct: get('Прочие расходы %', 'otherPct'), otherRub: get('Прочие расходы ₽', 'otherRub'),
        packagingRub: get('Упаковка ₽', 'Упаковка', 'packagingrub'),
        commissionPct: get('Комиссия %', 'Комиссия', 'commissionpct'),
        logisticsRub: get('Логистика ₽', 'Логистика', 'logisticsrub'),
        storageRub: get('Хранение ₽', 'Хранение', 'storagerub'),
        acceptRub: get('Приёмка ₽', 'Приёмка', 'acceptrub'),
        adPct: get('Реклама %', 'adpct'),
        adRub: get('Реклама ₽', 'adrub'),
        sppPct: get('СПП %', 'spppct'),
        volumeLiters: get('Объём л', 'Объём', 'volumeliters'),
        note: get('Комментарий', 'note')
      };
    }).filter((r) => r.nmID);

    if (!norm.length) {
      App.toast('Не найдена колонка «нм-код» — скачайте шаблон', 'err', 5000);
      return;
    }

    const res = await API.invoke('costs:import', { rows: norm });
    S.state.costs = (await API.invoke('costs:get')).items || {};
    await S.loadGoods(true);
    S.invalidate();
    App.toast(`Импортировано значений: ${res.updated}`, 'ok');
    this.refresh();
  },

  exportCsv() {
    const st = S.state;
    const rows = S.getRows().map((r) => Object.assign({
      'нм-код': r.nmID, 'Артикул': r.vendorCode, 'Название': r.title, 'Категория': r.category
    }, st.costs[String(r.nmID)] || {}));
    API.exportCsv(`wb-costs-${new Date().toISOString().slice(0, 10)}.csv`, U.toCsv(rows));
    App.toast('Экспорт готов', 'ok');
  }
};
