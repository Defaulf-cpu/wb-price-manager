'use strict';

/** Цены и скидки: список товаров, массовая переценка, предпросмотр и отправка в WB. */
window.Views = window.Views || {};

Views.prices = {
  title: 'Цены и скидки',
  subtitle: 'Массовое изменение цен, контроль карантина и минимальной маржи',

  grid: null,

  /**
   * Ручные правки цен. Храним в общем состоянии (S.state.priceEdits), а не в поле вьюхи:
   * раньше `render()` создавал новую Map, и введённые вручную цены пропадали при любом
   * переходе между разделами или перерисовке — пользователь решал, что цены не сохраняются.
   */
  get editing() {
    if (!S.state.priceEdits) S.state.priceEdits = new Map();
    return S.state.priceEdits;
  },

  render(container) {
    const st = S.state;
    this.container = container;
    if (!st.priceEdits) st.priceEdits = new Map();

    container.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap" style="gap:8px">
          <input id="f-q" placeholder="Поиск: артикул, нм-код, название, бренд" style="width:300px" value="${U.esc(st.filters.q)}" />
          <select id="f-cat" style="width:190px"><option value="">Все категории</option></select>
          <select id="f-flag" style="width:230px">
            <option value="all">Все товары</option>
            <option value="loss">Убыточные</option>
            <option value="low">Маржа ниже порога</option>
            <option value="ok">Маржа выше цели</option>
            <option value="nocogs">Без себестоимости</option>
            <option value="revenue30">С выручкой за 30 дней</option>
            <option value="profit30">Прибыльные за 30 дней</option>
            <option value="profit30neg">Убыточные за 30 дней</option>
            <option value="draft">С сохранённым черновиком цены</option>
            <option value="promo">Уже в акции</option>
            <option value="badturn">Неликвид (90+ дней)</option>
            <option value="selected">Только выбранные</option>
          </select>
          <div class="grow"></div>
          <span id="sel-info" class="muted small"></span>
          <button class="btn btn-ghost btn-sm" id="btn-export">Экспорт CSV</button>
          <button class="btn btn-sm" id="btn-save-draft" title="Сохранить введённые цены в данных приложения. В WB ничего не отправляется — отправка из раздела «Репрайсер»">Сохранить</button>
          <button class="btn btn-sm" id="btn-costs" title="Перечитать себестоимость и расходы из раздела «Себестоимость»">Обновить себестоимость</button>
          <button class="btn btn-sm" id="btn-refresh">Обновить из WB</button>
        </div>
        <div class="row wrap" style="margin-top:10px" id="totals-line"></div>
      </div>
      <div id="grid-host"></div>
      <div id="bulk-host"></div>
    `;

    // фильтры
    const catSel = container.querySelector('#f-cat');
    S.categories().forEach((c) => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (st.filters.category === c) o.selected = true;
      catSel.appendChild(o);
    });
    container.querySelector('#f-flag').value = st.filters.flag || 'all';

    container.querySelector('#f-q').oninput = U.debounce((e) => {
      st.filters.q = e.target.value;
      this.refresh();
    }, 220);
    catSel.onchange = (e) => { st.filters.category = e.target.value; this.refresh(); };
    container.querySelector('#f-flag').onchange = (e) => { st.filters.flag = e.target.value; this.refresh(); };
    container.querySelector('#btn-refresh').onclick = async (e) => {
      e.target.disabled = true;
      try { await S.loadGoods(true); S.invalidate(); App.toast('Данные обновлены', 'ok'); this.render(container); }
      catch (err) { App.toast(err.message, 'err'); }
      finally { e.target.disabled = false; }
    };
    container.querySelector('#btn-export').onclick = () => this.exportCsv();

    /**
     * «Сохранить»: введённые руками цены уходят в данные приложения (pricedrafts.json),
     * сразу применяются к экономике во всех разделах и переживают перезапуск и обновление
     * из WB. В маркетплейс они НЕ отправляются — цены уходят в WB из раздела «Репрайсер»
     * (или кнопкой отправки ниже, если нужно отправить немедленно).
     */
    container.querySelector('#btn-save-draft').onclick = async (e) => {
      const btn = e.target;
      const items = {};
      this.editing.forEach((v, nmID) => {
        const base = U.num(v && v.basePrice);
        const disc = U.num(v && v.discount);
        if (base > 0 || disc > 0) items[String(nmID)] = { basePrice: base, discount: disc, note: (v && v.note) || '' };
      });
      if (!Object.keys(items).length) {
        App.toast('Нет введённых цен: измените базовую цену или скидку в таблице, затем сохраните', 'warn', 7000);
        return;
      }
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Сохраняем…';
      try {
        const res = await API.invoke('prices:draft-save', { items });
        await this.loadDrafts();
        App.toast('Сохранено: ' + res.count + ' поз. Цена применяется во всех разделах, в WB не отправлена.', 'ok', 8000);
        this.refresh();
      } catch (err) {
        App.toast(err.message, 'err', 8000);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    // Себестоимость вводится в разделе «Себестоимость», а таблица цен строится из overrides.
    // Кнопка перечитывает их с сервера без похода в WB — значения сразу появляются здесь.
    container.querySelector('#btn-costs').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Читаем себестоимость…';
      try {
        const res = await S.reloadOverrides();
        this.refresh();
        const rows = S.getRows();
        const withCost = rows.filter((r) => r.costPrice).length;
        App.toast('Себестоимость обновлена: задана у ' + withCost + ' из ' + rows.length + ' товаров' +
          (res && res.fromCache === false ? ' (товары ещё не загружены из WB — обновлены только введённые значения)' : ''), 'ok', 6000);
      } catch (err) {
        App.toast('Не удалось обновить себестоимость: ' + err.message, 'err', 8000);
      } finally {
        btn.disabled = false;
        btn.textContent = was;
      }
    };

    // черновик цен грузим асинхронно и перерисовываем таблицу, когда он пришёл
    this.loadDrafts().then(() => this.refresh());
    this.refresh();
  },

  refresh() {
    const st = S.state;
    // Панель может быть вложена в репрайсер: не подменяем её всем #view.
    if (!this.container || !this.container.isConnected) return;
    const host = this.container && this.container.querySelector('#grid-host');
    if (!host) return;
    host.innerHTML = '';
    const rows = U.sortBy(S.filtered(), (r) => this.sortValue(r, st.sort.key), st.sort.dir);

    const columns = [
      { title: 'Товар', key: 'title', width: '300px', render: (r) => `
          <div class="rowtitle">
            <b class="trunc" title="${U.esc(r.title)}">${U.esc(r.title)}</b>
            <span class="tiny muted">${r.nmID} · ${U.esc(r.vendorCode)}${r.sizesCount > 1 ? ` · ${r.sizesCount} разм.` : ''}</span>
            ${(S.state.priceDrafts || {})[String(r.nmID)] ? UI.badge('черновик', 'info') : ''}
          </div>` },
      { title: 'Категория', key: 'category', render: (r) => `<span class="tiny">${U.esc(r.category || '—')}</span>` },
      { title: 'Базовая цена', key: 'basePrice', num: true, render: (r) => this.editCell(r, 'basePrice', this.draftValue(r, 'basePrice', U.num(r.basePrice))) },
      { title: 'Скидка %', key: 'discount', num: true, render: (r) => this.editCell(r, 'discount', this.draftValue(r, 'discount', U.num(r.discount))) },
      { title: 'ЦенаWB', key: 'sellerPrice', num: true, render: (r) => {
          const e = this.editing.get(r.nmID);
          /**
           * Если цена сохранена вручную, r.sellerPrice — уже она (черновик применяется
           * ко всем разделам). Цену маркетплейса при этом показываем рядом: иначе
           * непонятно, что реально стоит на WB и насколько мы от него отличаемся.
           */
          const onMp = r.hasDraft && Math.abs(U.num(r.mpSellerPrice) - U.num(r.sellerPrice)) > 0.5
            ? `<div class="tiny muted">на МП ${U.money(r.mpSellerPrice)}</div>`
            : '';
          if (!e) return `<b>${U.money(r.sellerPrice)}</b>${onMp}`;
          const np = EC.num(e.basePrice, r.basePrice) * (1 - EC.num(e.discount, r.discount) / 100);
          return `<b>${U.money(np)}</b> <span class="tiny muted">(сейчас ${U.money(r.sellerPrice)})</span>${onMp}`;
        } },
      { title: 'СПП %', key: 'spp', num: true, render: (r) => `<span class="muted">${U.pct(r.spp, 0)}</span>` },
      { title: 'Покупатель платит', key: 'buyerPrice', num: true, render: (r) => `<span class="muted">${U.money(r.buyerPrice)}</span>` },
      { title: 'Комиссия %', key: 'commission', num: true, render: (r) => U.pct(r.commission) },
      { title: 'Себест.', key: 'costPrice', num: true, render: (r) => r.costPrice
          ? `${U.money(r.costPrice)}${r.cogsSource === 'demo' ? ' <span class="badge badge-demo tiny">демо</span>' : ''}`
          : '<span class="badge badge-info">нет</span>' },
      { title: 'Логист.', key: 'logistics', num: true, render: (r) => U.money(r.logistics) },
      { title: 'Реклама', key: 'ad', num: true, render: (r) => U.money(r.ad) },
      { title: 'Прибыль/шт', key: 'profit', num: true, render: (r) => `<b class="${U.profitClass(r.profit)}">${U.money(r.profit)}</b>` },
      { title: 'Маржа %', key: 'margin', num: true, render: (r) => `<span class="${U.profitClass(r.margin)}">${U.pct(r.margin)}</span>` },
      { title: 'Остаток', key: 'stock', num: true, render: (r) => r.stock ? U.fmt(r.stock) : '<span class="muted">0</span>' },
      { title: 'Продажи 30д', key: 'sales30', num: true, render: (r) => U.fmt(r.sales30) },
      { title: 'Оборач.', key: 'turnoverDays', num: true, render: (r) => r.stock ? `<span class="${r.turnoverDays > 90 ? 'warnc' : 'muted'}">${r.turnoverDays >= 999 ? '∞' : r.turnoverDays + ' дн'}</span>` : '—' },
      { title: 'Прибыль 30д', key: 'profit30', num: true, render: (r) => `<span class="${U.profitClass(r.profit30)}">${U.compact(r.profit30)} ₽</span>` },
      { title: 'Статус', key: 'flags', render: (r) => UI.flagBadges(r.flags) || '<span class="badge badge-ok">в норме</span>' }
    ];

    const grid = UI.table({
      columns,
      rows,
      tall: true,
      select: {
        get: (r) => st.selection.has(r.nmID),
        set: (r, v) => { if (v) st.selection.add(r.nmID); else st.selection.delete(r.nmID); },
        toggleAll: (list, v) => list.forEach((r) => { if (v) st.selection.add(r.nmID); else st.selection.delete(r.nmID); })
      },
      sort: { key: st.sort.key, dir: st.sort.dir, onSort: (k) => {
        if (st.sort.key === k) st.sort.dir = st.sort.dir === 'asc' ? 'desc' : 'asc';
        else { st.sort.key = k; st.sort.dir = k === 'title' || k === 'category' ? 'asc' : 'desc'; }
        this.refresh();
      } },
      /**
       * Одинарный клик — быстрый расчёт по товару, двойной — полная карточка с вкладками.
       * Открытие по одинарному клику откладываем на 260 мс и отменяем, если пришёл двойной:
       * иначе два модальных окна открывались бы друг поверх друга.
       */
      onRowClick: (r) => {
        if (this._clickTimer) clearTimeout(this._clickTimer);
        this._clickTimer = setTimeout(() => { this._clickTimer = null; this.openDetails(r); }, 260);
      },
      onRowDblClick: (r) => {
        if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
        Views.itemcard.open(r.nmID);
      },
      onSelect: () => this.updateBulk(),
      empty: 'Ничего не найдено. Измените фильтр или обновите данные.',
      footer: (c) => {
        const t = S.totals(rows);
        switch (c.key) {
          case 'title': return `<b>${U.fmt(rows.length)}</b> <span class="muted tiny">товаров</span>`;
          case 'sellerPrice': return U.compact(U.sum(rows, (r) => r.sellerPrice * r.sales30)) + ' ₽';
          case 'profit': return `<span class="${U.profitClass(U.sum(rows, (r) => r.profit))}">${U.compact(U.sum(rows, (r) => r.profit))} ₽</span>`;
          case 'margin': return U.pct(t.avgMargin);
          case 'discount': return U.pct(t.avgDiscount, 0);
          case 'stock': return U.fmt(U.sum(rows, (r) => r.stock));
          case 'sales30': return U.fmt(t.sales30);
          case 'profit30': return `<span class="${U.profitClass(t.profit30)}">${U.compact(t.profit30)} ₽</span>`;
          default: return '';
        }
      }
    });
    host.appendChild(grid.el);
    this.grid = grid;

    this.drawTotals(rows);

    this.renderBulk();
  },

  /**
   * Сводные плитки — это фильтры, а не просто цифры.
   * Клик оставляет только товары с этим признаком, повторный клик снимает фильтр.
   */
  drawTotals(rows) {
    const st = S.state;
    const t = S.totals(rows);
    const host = this.container.querySelector('#totals-line');
    if (!host) return;
    const draftCount = Object.keys(st.priceDrafts || {}).length;

    const tile = (label, value, flag, kind, hint) => {
      const active = st.filters.flag === flag;
      return `<button class="tile ${kind || ''} ${active ? 'active' : ''}" data-flag="${flag}" title="${U.esc(hint || '')}">
        <span class="t-label">${U.esc(label)}</span>
        <span class="t-value">${value}</span>
        ${active ? '<span class="t-x" title="Снять фильтр">✕</span>' : ''}
      </button>`;
    };

    host.innerHTML = [
      tile('выручка 30д', U.compact(t.revenue30) + ' ₽', 'revenue30', '', 'Показать только товары с выручкой за 30 дней'),
      tile('прибыль 30д', U.compact(t.profit30) + ' ₽', 'profit30', t.profit30 >= 0 ? 'ok' : 'danger', 'Показать только прибыльные за 30 дней'),
      tile('убыточных', U.fmt(t.lossCount), 'loss', t.lossCount ? 'danger' : 'ok', 'Только убыточные товары'),
      tile('низкая маржа', U.fmt(t.lowCount), 'low', t.lowCount ? 'warn' : 'ok', 'Маржа ниже порога «низкой маржи» из настроек'),
      tile('без себестоимости', U.fmt(t.noCogsCount), 'nocogs', t.noCogsCount ? 'info' : 'ok', 'Себестоимость не указана — расчёт неточный'),
      tile('неликвид 90+', U.fmt(t.illiquidCount), 'badturn', t.illiquidCount ? 'warn' : 'ok', 'Оборачиваемость больше 90 дней при наличии остатков'),
      tile('в акциях', U.fmt(rows.filter((r) => r.item.inPromo).length), 'promo', '', 'Товары, которые уже участвуют в акциях'),
      tile('черновик цен', U.fmt(draftCount), 'draft', draftCount ? 'info' : '', 'Цены сохранены, но НЕ отправлены в WB'),
      st.demo ? UI.badge('демо-данные', 'demo') : UI.badge('данные WB API', 'live')
    ].join(' ');

    host.querySelectorAll('[data-flag]').forEach((b) => {
      b.onclick = () => {
        const f = b.getAttribute('data-flag');
        st.filters.flag = st.filters.flag === f ? 'all' : f;
        const sel = this.container.querySelector('#f-flag');
        if (sel) sel.value = st.filters.flag;
        this.refresh();
      };
    });
  },

  /** Черновики цен живут в общем состоянии — они применяются во всех разделах. */
  async loadDrafts() {
    return S.loadDrafts();
  },

  /** Значение для ячейки ввода: черновик важнее цены из WB, но ручная правка важнее черновика. */
  draftValue(r, field, fallback) {
    const ed = this.editing.get(r.nmID);
    if (ed && ed[field] !== undefined && ed[field] !== null && ed[field] !== '') return U.num(ed[field]);
    const d = (S.state.priceDrafts || {})[String(r.nmID)];
    if (d && d[field] !== undefined && d[field] !== null && d[field] !== '') return U.num(d[field]);
    return fallback;
  },

  sortValue(r, key) {
    if (key === 'title') return r.title || '';
    if (key === 'category') return r.category || '';
    if (key === 'flags') return r.flags.length ? 1 : 0;
    return U.num(r[key]);
  },

  editCell(r, field, value) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'num cellinput';
    inp.value = value;
    inp.step = field === 'discount' ? '1' : '10';
    inp.onclick = (e) => e.stopPropagation();
    inp.oninput = U.debounce(() => {
      const cur = this.editing.get(r.nmID) || { basePrice: U.num(r.basePrice), discount: U.num(r.discount) };
      cur[field] = U.num(inp.value, cur[field]);
      this.editing.set(r.nmID, cur);
      st_touch();
      this.updateBulk();
      // пересчитать ячейку итоговой цены без полной перерисовки
      const row = inp.closest('tr');
      if (row) {
        const cells = row.children;
        const base = U.num(cur.basePrice);
        const disc = Math.max(0, Math.min(95, U.num(cur.discount)));
        const seller = base * (1 - disc / 100);
        if (cells[4]) cells[4].innerHTML = `<b>${U.money(seller)}</b> <span class="tiny muted">(было ${U.money(r.sellerPrice)})</span>`;
      }
    }, 200);
    function st_touch() {}
    return inp;
  },

  /** Нижняя панель: правило массового изменения цен. */
  renderBulk() {
    const st = S.state;
    const host = this.container.querySelector('#bulk-host');
    const rule = st.priceRule;
    host.innerHTML = `
      <div class="bulkbar">
        <div class="fld"><span>Применить к</span>
          <select id="b-scope" style="width:210px">
            <option value="selected">Выбранным товарам</option>
            <option value="edited">Изменённым вручную</option>
            <option value="filtered">Всем в текущем фильтре</option>
            <option value="loss">Убыточным</option>
            <option value="low">С низкой маржой</option>
            <option value="illiquid">Неликвиду</option>
          </select>
        </div>
        <div class="fld"><span>Правило</span>
          <select id="b-type" style="width:280px">
            ${RULES.TYPES.map((t) => `<option value="${t.id}">${U.esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="fld"><span>Значение</span><input id="b-value" type="number" step="any" class="num" style="width:110px" value="${rule.value}" /></div>
        <div class="fld"><span>Округление до, ₽</span><input id="b-round" type="number" step="1" min="0" class="num" style="width:100px" value="${rule.roundTo || 0}" /></div>
        <div class="fld"><span>Не ниже, ₽</span><input id="b-min" type="number" step="1" min="0" class="num" style="width:100px" value="${rule.minPrice || 0}" /></div>
        <div class="grow"></div>
        <button class="btn" id="b-preview">Рассчитать предпросмотр</button>
        <button class="btn btn-primary" id="b-apply" disabled>Отправить цены в WB</button>
        <button class="btn btn-ghost btn-sm" id="b-reset">Сбросить правки</button>
        <span id="b-apply-reason" class="tiny warnc" style="align-self:center"></span>
      </div>
      <div id="b-scope-info" class="hint" style="margin-top:8px"></div>
    `;

    const $ = (id) => host.querySelector(id);
    $('#b-type').value = rule.type;
    $('#b-scope').onchange = () => this.updateBulk();
    $('#b-type').onchange = (e) => { rule.type = e.target.value; this.updateBulk(); };
    $('#b-value').oninput = (e) => { rule.value = U.num(e.target.value); this.updateBulk(); };
    $('#b-round').oninput = (e) => { rule.roundTo = U.num(e.target.value); };
    $('#b-min').oninput = (e) => { rule.minPrice = U.num(e.target.value); };
    $('#b-preview').onclick = () => this.preview();
    $('#b-apply').onclick = () => this.preview(true);
    $('#b-reset').onclick = () => {
      this.editing.clear();
      S.state.selection.clear();
      this.refresh();
      App.toast('Ручные правки и выделение сброшены', 'ok');
    };

    this.updateBulk();
  },

  /**
   * Товары, к которым будет применено правило. Сам разбор области применения живёт
   * в общем модуле RULES (его же использует репрайсер), здесь только чтение выбора.
   */
  scopeRows() {
    const st = S.state;
    const sel = document.querySelector('#b-scope');
    const scope = sel ? sel.value : (st.filters.flag === 'all' ? 'filtered' : st.filters.flag);
    return RULES.scopeRows(scope, { editing: this.editing });
  },

  updateBulk(opts) {
    const st = S.state;
    const info = document.querySelector('#sel-info');
    if (info) {
      const edited = this.editing ? this.editing.size : 0;
      info.textContent = [
        st.selection.size ? `Выбрано: ${st.selection.size}` : '',
        edited ? `Изменено вручную: ${edited}` : ''
      ].filter(Boolean).join(' · ');
    }

    const sel = document.querySelector('#b-scope');
    let rows = this.scopeRows();

    // Главная причина «серой кнопки»: область применения по умолчанию — «Выбранным товарам»,
    // а цену ввели вручную в таблице, не ставя галочек. Переключаем область на изменённые
    // вручную сами и говорим об этом, иначе кнопка выглядит нерабочей.
    if (!rows.length && sel && sel.value === 'selected' && this.editing && this.editing.size) {
      sel.value = 'edited';
      rows = this.scopeRows();
      if (opts && opts.announce !== false) {
        App.toast('Цена введена вручную — область применения переключена на «Изменённым вручную» (' + rows.length + ' шт.)', 'info', 6000);
      }
    }

    const si = document.querySelector('#b-scope-info');
    const btn = document.querySelector('#b-apply');
    const reason = document.querySelector('#b-apply-reason');
    const label = st.demo ? 'Применить цены' : 'Отправить цены в WB';
    if (btn) {
      btn.disabled = rows.length === 0;
      btn.textContent = rows.length ? `${label} (${rows.length})` : label;
      btn.title = rows.length
        ? 'Откроется предпросмотр: старые и новые цены, прибыль, маржа и предупреждения. В WB уходим только после подтверждения.'
        : 'Не выбрано ни одного товара: отметьте строки галочкой, измените цену вручную в таблице или выберите область применения ниже.';
    }
    if (reason) {
      reason.textContent = rows.length ? '' :
        (this.editing && this.editing.size
          ? ''
          : '← кнопка не активна: нет товаров в области применения');
    }
    if (si) {
      si.textContent = rows.length
        ? `Будет изменено ${rows.length} товар(ов). Сначала откроется предпросмотр — в WB цены уйдут только после подтверждения.`
        : 'Чтобы включить отправку: отметьте товары галочкой, измените цену прямо в таблице (область переключится сама) или выберите «Всем в текущем фильтре».';
    }
  },

  /** Предпросмотр массовой переценки. */
  preview(autoApply) {
    const st = S.state;
    if (!this.editing) this.editing = new Map();
    const rule = st.priceRule;
    const targets = this.scopeRows();
    if (!targets.length) { App.toast('Нет товаров для изменения', 'warn'); return; }

    // Правило и ручные правки объединяет общий модуль RULES: тот же код работает
    // во вкладке «Массовые правила» репрайсера, поэтому планы не могут разойтись.
    const result = RULES.buildPlan({ rows: targets, rule, edits: this.editing, settings: st.settings });
    const plan = result.plan;
    const changed = result.changed;
    const risky = result.risky;
    const quarantined = result.quarantined;
    const deltaProfit = result.deltaProfit;

    const body = U.el('div');
    body.innerHTML = `
      <div class="grid g4" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Товаров в задаче</span><span class="value">${plan.length}</span><span class="hint">изменится у ${changed.length}</span></div>
        <div class="card stat"><span class="label">Δ прибыли на единицу</span><span class="value ${U.profitClass(deltaProfit)}">${U.signed(deltaProfit)} ₽</span><span class="hint">суммарно по выборке</span></div>
        <div class="card stat"><span class="label">С предупреждениями</span><span class="value ${risky.length ? 'warnc' : 'pos'}">${risky.length}</span><span class="hint">проверьте перед отправкой</span></div>
        <div class="card stat"><span class="label">Карантин цен</span><span class="value ${quarantined.length ? 'neg' : 'pos'}">${quarantined.length}</span><span class="hint">WB не применит такую цену</span></div>
      </div>
      ${st.demo ? '<div class="alert warn" style="margin-bottom:10px"><b>Демо-режим:</b> цены изменятся только в локальных данных приложения.</div>' : ''}
      <div id="plan-table"></div>
    `;

    const tbl = UI.table({
      columns: [
        { title: 'Товар', render: (p) => `<div class="rowtitle"><b class="trunc">${U.esc(p.title)}</b><span class="tiny muted">${p.nmID} · ${U.esc(p.vendorCode)}</span></div>` },
        { title: 'Было: цена / скидка', num: true, render: (p) => `${U.money(p.oldSeller)} / ${U.pct(p.oldDisc, 0)}` },
        { title: 'Станет: цена / скидка', num: true, render: (p) => `<b>${U.money(p.newSeller)}</b> / ${U.pct(p.newDisc, 0)}` },
        { title: 'Базовая цена', num: true, render: (p) => p.newBase !== p.oldBase ? `${U.money(p.oldBase)} → <b>${U.money(p.newBase)}</b>` : U.money(p.oldBase) },
        { title: 'Изменение', num: true, render: (p) => `<span class="${p.changePct < 0 ? 'neg' : 'pos'}">${U.signed(p.changePct, 1)}%</span>` },
        { title: 'Прибыль/шт', num: true, render: (p) => `<span class="muted">${U.money(p.oldProfit)}</span> → <b class="${U.profitClass(p.newProfit)}">${U.money(p.newProfit)}</b>` },
        { title: 'Маржа', num: true, render: (p) => `<span class="muted">${U.pct(p.oldMargin)}</span> → <b class="${U.profitClass(p.newMargin)}">${U.pct(p.newMargin)}</b>` },
        { title: 'Риски', render: (p) => p.warnings.length ? p.warnings.map((w) => UI.badge(w, w.includes('карантин') || w.includes('убыток') ? 'danger' : 'warn')).join(' ') : UI.badge('ок', 'ok') }
      ],
      rows: plan.slice(0, 400),
      empty: 'Нет строк'
    });
    body.querySelector('#plan-table').appendChild(tbl.el);

    const m = UI.modal({
      title: `Предпросмотр изменения цен — ${plan.length} товаров`,
      content: body,
      buttons: [
        { label: 'Экспорт плана в CSV', class: 'btn-ghost', keepOpen: true, onClick: () => {
            const csv = U.toCsv(plan.map((p) => ({
              'нм-код': p.nmID, 'Артикул поставщика': p.vendorCode, 'Название': p.title,
              'Старая базовая цена': p.oldBase, 'Новая базовая цена': p.newBase,
              'Старая скидка %': p.oldDisc, 'Новая скидка %': p.newDisc,
              'Старая итоговая цена': Math.round(p.oldSeller), 'Новая итоговая цена': Math.round(p.newSeller),
              'Изменение %': Math.round(p.changePct * 10) / 10,
              'Прибыль до': p.oldProfit, 'Прибыль после': p.newProfit,
              'Риски': p.warnings.join('; ')
            })));
            API.exportCsv(`price-plan-${new Date().toISOString().slice(0, 10)}.csv`, csv);
            App.toast('План выгружен в CSV', 'ok');
          } },
        { label: 'Отмена', class: 'btn-ghost' },
        {
          label: st.demo ? 'Применить в демо-режиме' : `Отправить в WB (${changed.length})`,
          class: 'btn-primary',
          onClick: () => this.apply(plan.filter((p) => !p.skipped))
        }
      ]
    });
    return m;
  },

  async apply(plan) {
    const st = S.state;
    if (!plan.length) { App.toast('Нечего отправлять', 'warn'); return; }
    const items = plan.map((p) => ({ nmID: p.nmID, price: Math.round(p.newBase), discount: Math.round(p.newDisc) }));

    const btn = UI.modal({
      title: 'Отправка цен',
      size: 'sm',
      dismissable: false,
      content: `<div class="loader"><div class="spinner"></div><span>Передаём ${items.length} товаров в Wildberries API…</span></div>`
    });

    try {
      const res = await API.invoke('wb:apply-prices', { items });
      btn.close();
      this.showResult(res, items.length);
      // отправленные цены больше не «черновик»: они уже в WB
      try { await API.invoke('prices:draft-clear', { nmIDs: items.map((x) => x.nmID) }); } catch (e) { /* не критично */ }
      await this.loadDrafts();
      this.editing.clear();
      st.selection.clear();
      if (st.filters.flag === 'selected') st.filters.flag = 'all';
      await S.loadGoods(true);
      S.invalidate();
      this.refresh();
    } catch (e) {
      btn.close();
      UI.modal({
        title: 'Ошибка отправки цен', size: 'sm',
        content: `<div class="alert danger">${U.esc(e.message)}</div>
          <p class="hint" style="margin-top:10px">Проверьте, что токен категории «Цены и скидки» действителен и у него есть права на запись. При лимите 10 запросов / 6 секунд приложение автоматически замедляет отправку.</p>`,
        buttons: [{ label: 'Закрыть', class: 'btn-primary' }]
      });
    }
  },

  showResult(res, sent) {
    const details = res.details || [];
    const ok = details.filter((d) => d.status === 3 && !d.error && !d.errorText).length;
    const failed = details.filter((d) => d.error || d.errorText || (d.status && d.status !== 3));
    const uploaded = res.sent !== undefined ? Number(res.sent) : sent;
    const task = res.task || null;
    UI.modal({
      title: 'Результат загрузки цен',
      content: `
        <div class="grid g4" style="margin-bottom:12px">
          <div class="card stat"><span class="label">Отправлено</span><span class="value">${uploaded}</span></div>
          <div class="card stat"><span class="label">Без ошибок WB</span><span class="value pos">${ok}</span>${!details.length && uploaded ? '<span class="hint">Задача принята, обработка ещё не подтверждена</span>' : ''}</div>
          <div class="card stat"><span class="label">С ошибками</span><span class="value ${failed.length ? 'neg' : 'pos'}">${failed.length}</span></div>
          <div class="card stat"><span class="label">Задача</span><span class="value">${task ? task.taskId : '—'}</span><span class="hint">${task ? task.statusText || '' : ''}</span></div>
        </div>
        ${(res.warnings && res.warnings.length) ? `<div class="alert warn" style="margin-bottom:10px"><b>Предупреждения (${res.warnings.length}):</b><br>${res.warnings.slice(0, 8).map((w) => U.esc(w.message)).join('<br>')}</div>` : ''}
        ${failed.length ? `<h3>Ошибки по товарам</h3><table class="grid-table"><thead><tr><th>нм-код / размер</th><th>Артикул</th><th>Статус</th><th>Ошибка</th></tr></thead>
          <tbody>${failed.slice(0, 60).map((f) => `<tr><td>${f.nmID || ''}${f.sizeID ? ' / #' + Number(f.sizeID) : ''}</td><td>${U.esc(f.vendorCode || '')}</td><td>${U.esc(f.statusText || f.status || '')}</td><td class="trunc">${U.esc(f.errorText || f.error || '')}</td></tr>`).join('')}</tbody></table>` : ''}
        ${res.demo ? '<p class="hint">Демо-режим: изменения применены к локальным данным, в Wildberries ничего не отправлялось.</p>' : ''}
      `,
      buttons: [{ label: 'Готово', class: 'btn-primary' }]
    });
  },

  /** Карточка товара: полная экономика, размеры, история цен. */
  openDetails(r) {
    const st = S.state;
    const ov = st.overrides[String(r.nmID)] || {};
    const body = U.el('div');
    body.innerHTML = UI.loading('Считаем экономику…');

    const m = UI.modal({ title: `${r.title}`, content: body, size: 'md', buttons: [
      { label: 'Редактировать себестоимость', class: 'btn-ghost', keepOpen: true, onClick: () => { Views.costs.openItemEditor(r.nmID); } },
      { label: 'Закрыть' }
    ] });

    const a = EC.analyze(st.settings, r.item, ov);
    const c = a.current;
    const p = a.params;
    const stat = st.statsByNm[String(r.nmID)] || {};
    const maxCost = Math.max(1, c.commission, c.logistics, c.ad, c.tax, c.cogs, c.storage, c.packaging, c.acquiring);
    /**
     * WB отдаёт категорию «Статистика» одним запросом в минуту, поэтому продажи и заказы
     * приезжают раздельно. Пока заказы в фоне, ноль в строке «Заказы, шт» — это не «нет заказов»,
     * а «ещё не загружено»: подписываем прямо здесь, чтобы цифру не читали как факт.
     */
    const sm = st.statsMeta || {};
    const ordersPending = !!sm.ordersPending && !stat.ordersQty;
    const ordersCell = ordersPending
      ? `<span class="muted">ещё не загружены</span> <button class="btn btn-sm btn-ghost" id="st-orders-now">Догрузить</button>`
      : U.fmt(stat.ordersQty || 0);

    body.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">
        ${UI.badge('нм-код ' + r.nmID)} ${UI.badge(r.vendorCode)} ${UI.badge(r.category)} ${r.brand ? UI.badge(r.brand) : ''}
        ${r.isBadTurnover ? UI.badge('неликвид по данным WB', 'warn') : ''}
        ${r.editableSizePrice ? UI.badge('разные цены по размерам', 'info') : ''}
        ${ov.source === 'demo' ? UI.badge('себестоимость из демо-данных', 'demo') : ''}
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>Цена</h3>
          ${UI.kv([
            ['Базовая цена (до скидки)', U.money(r.basePrice)],
            ['Скидка продавца', U.pct(r.discount)],
            ['Цена для WB (после скидки)', '<b>' + U.money(c.revenue) + '</b>'],
            ['СПП (скидка покупателя WB)', U.pct(p.sppPct)],
            ['Платит покупатель', U.money(c.buyerPrice)],
            ['Цена безубыточности', c.breakEvenPrice !== null ? U.money(c.breakEvenPrice) : '— (проверьте проценты)'],
            ['Цена под целевую маржу ' + U.pct(p.targetMarginPct, 0), c.minPriceForMargin !== null ? U.money(c.minPriceForMargin) : '—'],
            ['Мин. базовая цена под цель', a.minBaseForMargin !== null ? U.money(a.minBaseForMargin) : '—']
          ])}
        </div>
        <div class="card">
          <h3>Структура себестоимости продажи</h3>
          <div class="bars">
            ${UI.bar('Комиссия WB ' + U.pct(p.commissionPct), c.commission, maxCost, U.money(c.commission))}
            ${UI.bar('Логистика (' + U.num(p.volumeLiters, 0).toFixed(1) + ' л)', c.logistics, maxCost, U.money(c.logistics))}
            ${UI.bar('Реклама ' + U.pct(p.adPct), c.ad, maxCost, U.money(c.ad))}
            ${UI.bar('Налог ' + U.pct(p.taxRatePct), c.tax, maxCost, U.money(c.tax))}
            ${UI.bar('Себестоимость', c.cogs, maxCost, U.money(c.cogs))}
            ${UI.bar('Упаковка', c.packaging, maxCost, U.money(c.packaging))}
            ${UI.bar('Хранение', c.storage, maxCost, U.money(c.storage))}
            ${UI.bar('Эквайринг ' + U.pct(p.acquiringPct), c.acquiring, maxCost, U.money(c.acquiring))}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <h3>Итог</h3>
        <div class="calc-lines">
          <div class="calc-line"><span class="k">Выручка (к выплате до удержаний)</span><span>${U.money(c.revenue)}</span></div>
          <div class="calc-line"><span class="k">− Удержания WB (комиссия + логистика + хранение + эквайринг)</span><span>${U.money(c.wbTotal + c.storage)}</span></div>
          <div class="calc-line"><span class="k">− Реклама</span><span>${U.money(c.ad)}</span></div>
          <div class="calc-line"><span class="k">− Себестоимость и упаковка</span><span>${U.money(c.cogs + c.packaging)}</span></div>
          <div class="calc-line"><span class="k">− Налог (${EC.taxModeLabel(p.taxMode)})</span><span>${U.money(c.tax)}</span></div>
          <div class="calc-line total"><span class="k">Прибыль с единицы</span><span class="${U.profitClass(c.profit)}">${U.money(c.profit)} · ${U.pct(c.marginPct)}</span></div>
        </div>
      </div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card">
          <h3>Продажи и остатки (30 дней)</h3>
          ${UI.kv([
            ['Продажи, шт', U.fmt(stat.salesQty || ov.salesPerDay * 30 || 0)],
            ['Заказы, шт', ordersCell],
            ['Возвраты, шт', U.fmt(stat.returnsQty || 0)],
            ['Средняя цена продажи', stat.avgPrice ? U.money(stat.avgPrice) : '—'],
            ['Средняя выплата (ppvz_for_pay)', stat.avgForPay ? U.money(stat.avgForPay) : '—'],
            ['Средний СПП по факту', stat.avgSppPct ? U.pct(stat.avgSppPct) : '—'],
            ['Остаток на складах', U.fmt(ov.stock || 0) + ' шт'],
            ['Оборачиваемость', r.turnoverDays >= 999 ? '∞ (нет продаж)' : r.turnoverDays + ' дн'],
            ['Прибыль за 30 дней', `<b class="${U.profitClass(r.profit30)}">${U.money(r.profit30)}</b>`]
          ])}
          ${sm.truncated ? '<p class="hint warnc" style="margin-top:8px">WB отдал не все страницы статистики — '
            + 'цифры за период могут быть неполными. Увеличьте «Страниц статистики» в настройках.</p>' : ''}
          ${sm.stale ? '<p class="hint warnc" style="margin-top:8px">Статистика от ' + U.esc(U.date(sm.staleAt, true))
            + ': последний запрос к WB был отклонён (лимит 1 запрос в минуту). Показаны ранее загруженные данные.</p>' : ''}
        </div>
        <div class="card">
          <h3>Размеры и цены</h3>
          <div id="sizes-host"><div class="loader"><div class="spinner"></div></div></div>
        </div>
      </div>
    `;

    // Заказы у WB — отдельный запрос (лимит «Статистики» 1/мин), поэтому догружать их
    // можно прямо из карточки товара. Привязываем ПОСЛЕ заполнения body.innerHTML,
    // иначе кнопки в разметке ещё нет.
    const ordersBtn = body.querySelector('#st-orders-now');
    if (ordersBtn) {
      ordersBtn.onclick = async () => {
        ordersBtn.disabled = true;
        ordersBtn.textContent = 'Ждём лимит WB…';
        try {
          const res = await API.invoke('stats:orders', { days: 30, force: true });
          App.toast(res && res.skipped ? 'Заказы уже загружены' : 'Заказы догружены: ' + ((res && res.orders) || 0) + ' строк', 'ok', 7000);
          await S.loadGoods(false);
          S.invalidate();
          m.close();
        } catch (e) {
          App.toast(e.message, 'err', 9000);
          ordersBtn.disabled = false;
          ordersBtn.textContent = 'Догрузить';
        }
      };
    }

    // подгружаем размеры
    (async () => {
      const host = body.querySelector('#sizes-host');
      try {
        const res = await API.invoke('wb:sizes', r.nmID);
        const g = (res && res[0]) || null;
        const sizes = (g && g.sizes) || r.item.sizes || [];
        if (!sizes.length) { host.innerHTML = '<div class="muted small">Информация о размерах недоступна</div>'; return; }
        host.innerHTML = `<table class="grid-table"><thead><tr><th>Размер</th><th class="num">Цена</th><th class="num">Со скидкой</th><th class="num">Прибыль/шт</th></tr></thead>
          <tbody>${sizes.map((s) => {
            const sc = EC.calcUnit(s.discountedPrice || (s.price * (1 - r.discount / 100)), p);
            return `<tr><td>${U.esc(s.techSizeName)}</td><td class="num">${U.money(s.price)}</td><td class="num">${U.money(s.discountedPrice)}</td>
              <td class="num ${U.profitClass(sc.profit)}">${U.money(sc.profit)}</td></tr>`;
          }).join('')}</tbody></table>`;
      } catch (e) {
        host.innerHTML = `<div class="alert danger">${U.esc(e.message)}</div>`;
      }
    })();
  },

  exportCsv() {
    const rows = S.filtered().map((r) => ({
      'нм-код': r.nmID,
      'Артикул поставщика': r.vendorCode,
      'Название': r.title,
      'Бренд': r.brand,
      'Категория': r.category,
      'Базовая цена': r.basePrice,
      'Скидка %': r.discount,
      'ЦенаWB': Math.round(r.sellerPrice),
      'СПП %': r.spp,
      'Цена покупателя': Math.round(r.buyerPrice),
      'Комиссия %': r.commission,
      'Комиссия ₽': r.c.commission,
      'Логистика ₽': r.logistics,
      'Хранение ₽': r.storage,
      'Упаковка ₽': r.packaging,
      'Реклама ₽': r.ad,
      'Налог ₽': r.tax,
      'Себестоимость ₽': r.costPrice,
      'Прибыль ₽': r.profit,
      'Маржа %': r.margin,
      'Цена безубыточности': r.breakEven,
      'Цена под цель': r.minPriceTarget,
      'Остаток шт': r.stock,
      'Продажи 30д': r.sales30,
      'Оборачиваемость дн': r.turnoverDays,
      'Прибыль 30д ₽': Math.round(r.profit30),
      'Проблемы': r.flags.join('; ')
    }));
    const csv = U.toCsv(rows);
    API.exportCsv(`wb-prices-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    App.toast(`Выгружено строк: ${rows.length}`, 'ok');
  }
};
