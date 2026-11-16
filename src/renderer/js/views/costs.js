'use strict';

/** Себестоимость и расходы: ручное заполнение, CSV-импорт/экспорт, шаблоны по категориям. */
window.Views = window.Views || {};

Views.costs = {
  title: 'Себестоимость',
  subtitle: 'Ваши данные: закупка, упаковка, реклама — заполняются один раз',

  render(container) {
    const st = S.state;
    this.container = container;
    this.q = this.q || '';
    this.onlyMissing = this.onlyMissing === undefined ? true : this.onlyMissing;

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
          <button class="btn btn-sm" id="c-import">Импорт CSV</button>
          <button class="btn btn-sm" id="c-template">Скачать шаблон CSV</button>
          <button class="btn btn-sm btn-ghost" id="c-export">Экспорт текущих</button>
        </div>
      </div>
      <div id="c-grid"></div>
      <div class="bulkbar" id="c-bulk"></div>
    `;

    const catSel = container.querySelector('#c-cat');
    S.categories().forEach((c) => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (this.cat === c) o.selected = true;
      catSel.appendChild(o);
    });

    container.querySelector('#c-q').oninput = U.debounce((e) => { this.q = e.target.value; this.refresh(); }, 220);
    catSel.onchange = (e) => { this.cat = e.target.value; this.refresh(); };
    container.querySelector('#c-missing').onchange = (e) => { this.onlyMissing = e.target.checked; this.refresh(); };
    container.querySelector('#c-import').onclick = () => this.importCsv();
    container.querySelector('#c-template').onclick = () => this.downloadTemplate();
    container.querySelector('#c-export').onclick = () => this.exportCsv();

    this.refresh();
  },

  list() {
    let rows = S.getRows();
    if (this.cat) rows = rows.filter((r) => r.category === this.cat);    const q = (this.q || '').toLowerCase();
    if (q) rows = rows.filter((r) => String(r.nmID).includes(q) || String(r.vendorCode).toLowerCase().includes(q) || String(r.title).toLowerCase().includes(q));
    if (this.onlyMissing) rows = rows.filter((r) => !r.costPrice || r.cogsSource !== 'user');
    return rows;
  },

  refresh() {
    const st = S.state;
    this.container = document.getElementById('view');
    const host = this.container && this.container.querySelector('#c-grid');
    if (!host) return;
    host.innerHTML = '';
    const rows = this.list();
    const costs = st.costs;

    const input = (r, field, value, step) => {
      const i = document.createElement('input');
      i.type = 'number';
      i.className = 'num cellinput';
      i.step = step || 'any';
      i.value = value === undefined || value === null || value === '' ? '' : value;
      i.placeholder = '—';
      i.onclick = (e) => e.stopPropagation();
      i.onchange = async () => {
        const key = String(r.nmID);
        const patch = {};
        patch[key] = Object.assign({}, costs[key] || {}, { [field]: i.value === '' ? null : U.num(i.value) });
        await S.saveCosts(patch);
        S.invalidate();
        App.toast('Сохранено: ' + r.vendorCode, 'ok', 1500);
        if (this.onlyMissing) this.refresh();
      };
      return i;
    };

    const val = (r, f) => {
      const c = costs[String(r.nmID)] || {};
      return c[f] !== undefined ? c[f] : '';
    };

    const grid = UI.table({
      columns: [
        { title: 'Товар', render: (r) => `<div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">${r.nmID} · ${U.esc(r.vendorCode)} · ${U.esc(r.category)}</span></div>` },
        { title: 'Цена WB', num: true, render: (r) => U.money(r.sellerPrice) },
        { title: 'Себестоимость ₽', num: true, render: (r) => input(r, 'costPriceRub', val(r, 'costPriceRub')) },
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
            const hint = f && f.sppPctWatch !== undefined && f.sppPctWatch !== null
              ? 'витрина ' + U.pct(U.num(f.sppPctWatch), 1)
              : (f && Number(f.sppPctAvg) > 0 ? 'продажи ' + U.pct(Number(f.sppPctAvg), 1) : '');
            return input(r, 'sppPct', val(r, 'sppPct'), '1') +
              (hint ? '<div class="tiny muted">' + hint + ((srcSpp === 'watch' || srcSpp === 'fact') ? ' · учтён' : '') + '</div>' : '');
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
    host.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); this.openItemEditor(Number(b.dataset.open)); };
    });

    // массовое заполнение
    const bulk = this.container.querySelector('#c-bulk');
    bulk.innerHTML = `
      <div class="fld"><span>Заполнить для ${rows.length} товаров</span>
        <select id="cb-field" style="width:220px">
          <option value="costPriceRub">Себестоимость, ₽</option>
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
        if (mode === 'add') value = U.num(cur[field], field === 'costPriceRub' ? r.costPrice : 0) + v;
        patch[key] = Object.assign({}, cur, { [field]: Math.round(value * 100) / 100 });
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
    const c = st.costs[String(nmID)] || {};
    const body = U.el('div');
    const fld = (key, label, hint, step) => `
      <label class="field">${label}
        <input type="number" step="${step || 'any'}" class="num" id="ce-${key}" value="${c[key] === undefined || c[key] === null ? '' : c[key]}" placeholder="${hint || ''}" />
      </label>`;
    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">${UI.badge('нм-код ' + nmID)} ${UI.badge(r.vendorCode)} ${UI.badge(r.category)}</div>
      <div class="grid g2" style="gap:10px">
        ${fld('costPriceRub', 'Себестоимость (закупка), ₽', 'например 620')}
        ${fld('packagingRub', 'Упаковка, ₽', 'например 15')}
        ${fld('commissionPct', 'Комиссия WB, %', 'пусто = из настроек', '0.5')}
        ${fld('logisticsRub', 'Логистика, ₽/шт', 'пусто = по объёму')}
        ${fld('storageRub', 'Хранение, ₽/шт', 'пусто = из настроек')}
        ${fld('acceptRub', 'Приёмка, ₽/шт', 'пусто = из настроек')}
        ${fld('adPct', 'Реклама, % от цены', 'пусто = из настроек', '0.5')}
        ${fld('adRub', 'Реклама, ₽/шт (фикс)', 'например 40')}
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
        sppPct: body.querySelector('#ce-sppPct').value === '' ? undefined : U.num(body.querySelector('#ce-sppPct').value),
        taxRatePct: body.querySelector('#ce-taxRatePct').value === '' ? undefined : U.num(body.querySelector('#ce-taxRatePct').value)
      };
      Object.keys(ov).forEach((k) => { if (ov[k] === undefined || ov[k] === '') delete ov[k]; });
      const merged = Object.assign({}, st.overrides[String(nmID)] || {}, ov);
      const a = EC.analyze(st.settings, r.item, merged);
      body.querySelector('#ce-out').innerHTML = `
        <div class="card" style="background:var(--bg-3)">
          <div class="calc-lines">
            <div class="calc-line"><span class="k">Цена для WB</span><span>${U.money(a.current.revenue)}</span></div>
            <div class="calc-line"><span class="k">Комиссия + логистика + хранение</span><span>${U.money(a.current.commission + a.current.logistics + a.current.storage)}</span></div>
            <div class="calc-line"><span class="k">Реклама и налог</span><span>${U.money(a.current.ad + a.current.tax)}</span></div>
            <div class="calc-line"><span class="k">Себестоимость и упаковка</span><span>${U.money(a.current.cogs + a.current.packaging)}</span></div>
            <div class="calc-line total"><span class="k">Прибыль / маржа</span><span class="${U.profitClass(a.current.profit)}">${U.money(a.current.profit)} · ${U.pct(a.current.marginPct)}</span></div>
            <div class="calc-line"><span class="k">Цена под цель ${U.pct(a.params.targetMarginPct, 0)}</span><span>${a.current.minPriceForMargin === null ? '—' : U.money(a.current.minPriceForMargin)}</span></div>
          </div>
        </div>`;
    };

    body.querySelectorAll('input').forEach((i) => { i.oninput = recalc; });
    recalc();

    UI.modal({
      title: `Себестоимость — ${r.title}`,
      content: body,
      size: 'md',
      buttons: [
        { label: 'Отмена', class: 'btn-ghost' },
        {
          label: 'Сохранить', class: 'btn-primary', onClick: async () => {
            const patch = {};
            patch[String(nmID)] = {
              costPriceRub: body.querySelector('#ce-costPriceRub').value === '' ? null : U.num(body.querySelector('#ce-costPriceRub').value),
              packagingRub: body.querySelector('#ce-packagingRub').value === '' ? null : U.num(body.querySelector('#ce-packagingRub').value),
              commissionPct: body.querySelector('#ce-commissionPct').value === '' ? null : U.num(body.querySelector('#ce-commissionPct').value),
              logisticsRub: body.querySelector('#ce-logisticsRub').value === '' ? null : U.num(body.querySelector('#ce-logisticsRub').value),
              storageRub: body.querySelector('#ce-storageRub').value === '' ? null : U.num(body.querySelector('#ce-storageRub').value),
              acceptRub: body.querySelector('#ce-acceptRub').value === '' ? null : U.num(body.querySelector('#ce-acceptRub').value),
              adPct: body.querySelector('#ce-adPct').value === '' ? null : U.num(body.querySelector('#ce-adPct').value),
              adRub: body.querySelector('#ce-adRub').value === '' ? null : U.num(body.querySelector('#ce-adRub').value),
              sppPct: body.querySelector('#ce-sppPct').value === '' ? null : U.num(body.querySelector('#ce-sppPct').value),
              taxRatePct: body.querySelector('#ce-taxRatePct').value === '' ? null : U.num(body.querySelector('#ce-taxRatePct').value),
              note: body.querySelector('#ce-note').value
            };
            await S.saveCosts(patch);
            S.invalidate();
            App.toast('Значения сохранены', 'ok');
            if (Views.costs.container) Views.costs.refresh();
          }
        }
      ]
    });
  },

  downloadTemplate() {
    const rows = S.getRows().slice(0, 500).map((r) => ({
      'нм-код': r.nmID,
      'Артикул': r.vendorCode,
      'Название': r.title,
      'Себестоимость': '',
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

  async importCsv() {
    const text = await API.importCsv();
    if (!text) { App.toast('Файл не выбран', 'warn'); return; }
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
