'use strict';

/**
 * Карточка товара — открывается двойным кликом по строке в «Цены и скидки» или в «Репрайсере».
 *
 * Зачем отдельным модулем: всё про один артикул должно быть в одном окне, а не размазано
 * по разделам. Внутри — вкладки, чтобы не сваливать данные в одну простыню:
 *   Экономика · Цена и черновик · Конкуренты · Комиссии · Акции · История пересчёта.
 *
 * Данные берутся ОДНИМ запросом `items:card`, поэтому окно открывается сразу и не дёргает
 * WB по каждому блоку (лимиты категорий это дорого).
 */
window.Views = window.Views || {};

Views.itemcard = {

  /** @param {number} nmID артикул WB */
  async open(nmID) {
    const id = Number(nmID);
    if (!(id > 0)) return;

    const modal = UI.modal({
      title: 'Карточка товара',
      size: 'lg',
      dismissable: true,
      beforeClose: async () => LocalDrafts.commit({ scope: modal.body, report: true }),
      content: UI.loading('Читаем данные товара из WB и кэша приложения…'),
      buttons: [
        /**
         * Ссылка для тех, кто привык к старым разделам: карточка остаётся модальным
         * окном, но товар можно открыть в «Ценах и скидках» — таблица отфильтруется
         * по этому нм-коду.
         */
        { label: 'Открыть в разделе', class: 'btn-ghost', onClick: async () => {
            if (!await modal.close()) return false;
            S.state.filters = S.state.filters || {};
            S.state.filters.q = String(id);
            S.state.filters.flag = 'all';
            App.go('prices');
            App.toast('Товар ' + id + ' отфильтрован в «Ценах и скидках»', 'ok', 4000);
          } },
        { label: 'Закрыть' }
      ]
    });
    const body = modal.body || document.querySelector('#modal-root .modal-body');

    let data = null;
    try {
      data = await API.invoke('items:card', { nmID: id });
    } catch (e) {
      body.innerHTML = `<div class="alert danger">${U.esc(e.message)}</div>`;
      return;
    }
    if (!data || !data.ok || !data.item) {
      body.innerHTML = '<div class="alert warn">Товар не найден в загруженных данных. Нажмите «Обновить данные из WB».</div>';
      return;
    }

    this.data = data;
    this.nmID = id;
    this.modal = modal;
    this.body = body;
    this.tab = 'econ';
    this.paint();
  },

  /** Шапка (общая для всех вкладок) + вкладки + содержимое. */
  /** Экономика товара — теми же функциями и в том же порядке источников, что и во всём приложении. */
  econ() {
    const d = this.data;
    const ov = EC.preferFacts(d.overrides || {}, d.facts || null, d.settings);
    return EC.analyze(d.settings, d.item, ov, undefined, d.facts || null);
  },

  paint() {
    const d = this.data;
    const it = d.item;
    const a = this.econ();
    const cur = a.current;
    const draft = d.drafts || null;
    const prop = d.proposal || null;
    // сколько замеров витрины легло в медиану СПП — сразу видно, есть ли наблюдения
    const watchBadge = U.num((d.facts || {}).sppWatchSamples) > 0 ? U.num((d.facts || {}).sppWatchSamples) + ' замеров' : '';

    const badges = [
      UI.badge('нм-код ' + it.nmID),
      it.vendorCode ? UI.badge(it.vendorCode) : '',
      (it.categoryName || it.subjectName) ? UI.badge(it.categoryName || it.subjectName) : '',
      d.demo ? UI.badge('демо-данные', 'demo') : UI.badge('данные WB API', 'live'),
      draft ? UI.badge('черновик цены сохранён', 'info') : '',
      prop ? UI.badge('есть предложение репрайсера', 'accent') : ''
    ].filter(Boolean).join(' ');

    this.body.innerHTML = `
      <div class="row wrap" style="gap:8px;margin-bottom:6px">
        <div style="flex:1;min-width:260px">
          <b>${U.esc(it.title || 'Товар')}</b>
          <div class="tiny muted" style="margin-top:2px">${badges}</div>
        </div>
        <div class="row" style="gap:14px">
          <div><span class="tiny muted">Цена WB сейчас</span><br><b>${U.money(cur.revenue)}</b></div>
          <div><span class="tiny muted">Прибыль/шт</span><br><b class="${U.profitClass(cur.profit)}">${U.money(cur.profit)}</b></div>
          <div><span class="tiny muted">Маржа</span><br><b class="${U.profitClass(cur.marginPct)}">${U.pct(cur.marginPct)}</b></div>
        </div>
      </div>
      <div id="ic-tabs"></div>
      <div id="ic-host" style="margin-top:12px"></div>
    `;

    const tabs = UI.tabs({
      tabs: [
        { id: 'econ', label: 'Экономика и цена', badge: draft ? 'своя цена' : '' },
        { id: 'competitors', label: 'Конкуренты', badge: (d.competitors || []).length || '' },
        { id: 'watch', label: 'Цены на площадке', badge: watchBadge },
        { id: 'commissions', label: 'Комиссии и параметры' },
        { id: 'promos', label: 'Акции', badge: (d.promos || []).length || '' },
        { id: 'history', label: 'История пересчёта', badge: (d.recalcHistory || []).length || '' }
      ],
      active: this.tab,
      onChange: (id) => { this.tab = id; this.drawTab(); }
    });
    const tabsHost = this.body.querySelector('#ic-tabs');
    tabsHost.innerHTML = '';
    tabsHost.appendChild(tabs.el);
    this.drawTab();
  },

  drawTab() {
    const host = this.body.querySelector('#ic-host');
    if (!host) return;
    const fn = {
      econ: () => this.tabEcon(host),
      competitors: () => this.tabCompetitors(host),
      watch: () => this.tabWatch(host),
      commissions: () => this.tabCommissions(host),
      promos: () => this.tabPromos(host),
      history: () => this.tabHistory(host)
    }[this.tab];
    host.innerHTML = '';
    if (fn) fn();
  },

  // ───────────────────────── Экономика ─────────────────────────

  /**
   * Вкладка «Экономика и цена» — объединена намеренно.
   *
   * Раньше цена и экономика жили на разных вкладках: ввёл цену → сохранил → перешёл на
   * «Экономику» → увидел, что ничего не изменилось. Теперь расчёт пересчитывается
   * ЖИВЬЁМ на каждый ввод, и сразу видно, как цена влияет на прибыль, маржу и все статьи.
   *
   * Кнопка одна — «Сохранить»: она сохраняет цену в данных приложения (черновик) и
   * НИКУДА не отправляет. В маркетплейс цены уходят только из раздела «Репрайсер»
   * (или «Цены и скидки») — там, где видно весь список и есть предпросмотр.
   */
  tabEcon(host) {
    const d = this.data;
    const it = d.item;
    const facts = d.facts || null;
    const card = d.card || null;
    const st = d.stats || {};
    const draft = d.drafts || null;
    const prop = d.proposal || null;

    // цена на маркетплейсе — её нельзя терять, когда сохранена своя
    const mpBase = U.num(it.price);
    const mpDisc = U.num(it.discount);
    const mpSeller = Math.round(mpBase * (1 - mpDisc / 100) * 100) / 100;
    // своя цена: черновик, если он есть, иначе цена МП
    const myBase = draft ? U.num(draft.basePrice) : mpBase;
    const myDisc = draft ? U.num(draft.discount) : mpDisc;
    // оборачиваемость: остаток на складах / темп продаж (тот же расчёт, что в репрайсере)
    const perDay = U.num(st.salesQty) > 0 ? U.num(st.salesQty) / 30 : U.num((d.overrides || {}).salesPerDay || 0);
    const turnoverDaysOf = (dd) => {
      const stock = U.num(dd.stock || 0);
      if (perDay > 0) return stock / perDay;
      return stock > 0 ? 999 : 0;
    };
    // разбивка остатков по складам и регионам — как в отчёте WB
    const breakdownLine = (map, label) => {
      const entries = Object.entries(map || {}).filter(([, q]) => Number(q) > 0);
      if (!entries.length) return '';
      return '<div class="tiny" style="margin-top:4px"><b class="tiny muted">' + label + ':</b> ' +
        entries.map(([k, q]) => U.esc(k) + ' — ' + U.fmt(q) + ' шт').join(' · ') + '</div>';
    };
    const warehouseBreakdown = (s) => breakdownLine(s.byWarehouse, 'Склады') + breakdownLine(s.byRegion, 'Регионы');

    host.innerHTML = `
      <div class="grid g2" style="gap:12px">
        <div class="card">
          <h3>Цена</h3>
          <div class="alert info" style="margin-bottom:10px">
            <b>На маркетплейсе сейчас:</b> ${U.money(mpSeller)}
            <span class="tiny muted">(база ${U.money(mpBase)} · скидка ${U.pct(mpDisc, 1)})</span>
            ${draft ? '<br><b class="pos">Сохранена своя цена</b> — она применяется во всех разделах, но в WB ещё не отправлена.' : ''}
          </div>
          <div class="grid g3" style="gap:10px">
            <label class="field">Базовая цена, ₽
              <input type="number" class="num" id="ic-base" step="10" value="${myBase}" /></label>
            <label class="field">Скидка, %
              <input type="number" class="num" id="ic-disc" step="1" value="${myDisc}" /></label>
            <label class="field">Цена со скидкой
              <input type="number" class="num" id="ic-seller" readonly value="${Math.round(myBase * (1 - myDisc / 100) * 100) / 100}" /></label>
          </div>
          <label class="field" style="margin-top:10px">Пометка (для себя)
            <input id="ic-note" value="${U.esc((draft && draft.note) || '')}" placeholder="например: цена под акцию 15.11" /></label>
          <div class="row wrap" style="margin-top:12px;gap:8px">
            <button class="btn btn-primary" id="ic-save">Сохранить</button>
            ${draft ? '<button class="btn btn-ghost" id="ic-drop">Вернуть цену МП</button>' : ''}
            <span class="hint" id="ic-save-status">${draft
              ? 'Сохранено ' + U.date(draft.savedAt, true) + ' · в WB не отправлено'
              : 'Изменения не сохранены'}</span>
          </div>
          <p class="hint" style="margin-top:8px">Кнопка «Сохранить» кладёт цену в данные приложения — она сразу
            применяется в экономике, репрайсере и отчётах, переживает перезапуск и НЕ уходит в WB.
            Отправляет цены в маркетплейс кнопка в разделе <b>«Репрайсер»</b> (там виден весь список и предпросмотр).</p>
          ${prop ? `<div class="divider"></div>
            <b class="tiny">Что предлагает репрайсер</b>
            ${UI.kv([
              ['Цена репрайсера', '<b>' + U.money(prop.sellerPrice) + '</b>' + (prop.manual ? ' <span class="tiny muted">(ваша сохранённая цена)</span>' : '')],
              ['Изменение', `<span class="${U.num(prop.deltaPct) >= 0 ? 'pos' : 'neg'}">${U.signed(U.num(prop.deltaPct), 1)}%</span>`],
              ['Прибыль/шт', U.money(prop.profitNow) + ' → <b class="' + U.profitClass(prop.profitNext) + '">' + U.money(prop.profitNext) + '</b>'],
              ['Стратегия', U.esc(prop.strategyTitle || prop.strategy || '—')]
            ])}` : ''}
        </div>
        <div class="card">
          <h3>Как цена меняет экономику</h3>
          <div id="ic-live">${UI.loading('Считаем…')}</div>
        </div>
      </div>

      <div class="grid g2" style="gap:12px;margin-top:12px">
        <div class="card">
          <h3>Расчёт на единицу</h3>
          <div id="ic-unit"></div>
        </div>
        <div class="card">
          <h3>Продажи и факт WB</h3>
          ${UI.kv([
            ['Продажи, шт (30 дн)', U.fmt(st.salesQty || 0)],
            ['Заказы, шт (30 дн)', d.statsMeta && d.statsMeta.ordersPending && !st.ordersQty
              ? '<span class="muted">ещё не загружены (лимит WB 1 запрос/мин)</span>' : U.fmt(st.ordersQty || 0)],
            ['Возвраты, шт', U.fmt(st.returnsQty || 0)],
            ['Средняя цена продажи', st.avgPrice ? U.money(st.avgPrice) : '—'],
            ['Средняя выплата (ppvz_for_pay)', st.avgForPay ? U.money(st.avgForPay) : '—'],
            ['Остаток на складах', U.fmt(d.stock || 0) + ' шт' + (U.stockWarn(d.stock, turnoverDaysOf(d), (d.settings || {}).stocksLowDays) ? ' ' + UI.badge('заканчивается', 'warn') : '')],
            ['Объём, л', card && card.volumeLiters ? U.num(card.volumeLiters, 2) + ' л' : '—'],
            ['Габариты, см', card && card.dimensions
              ? U.num(card.dimensions.length) + ' × ' + U.num(card.dimensions.width) + ' × ' + U.num(card.dimensions.height)
              : '—']
          ])}
          ${(d.statsMeta && d.statsMeta.truncated) ? '<p class="hint warnc" style="margin-top:8px">WB отдал не все страницы статистики — цифры за период могут быть неполными.</p>' : ''}
          ${(d.statsMeta && d.statsMeta.stale) ? '<p class="hint warnc" style="margin-top:8px">Статистика от ' + U.esc(U.date(d.statsMeta.staleAt, true)) + ': последний запрос к WB отклонён (лимит 1 запрос в минуту).</p>' : ''}
          ${d.stocks && d.stockSource === 'wb' ? `<div class="divider"></div>
            <b class="tiny">Остатки по складам WB${d.stocks.at ? ' · ' + U.esc(U.date(d.stocks.at, true)) : ''}</b>
            ${warehouseBreakdown(d.stocks)}
            <div class="tiny muted" style="margin-top:4px">Источник: загружено из WB (отчёт остатков по складам).</div>` : ''}
          ${d.stockSource === 'manual' && !d.stocks ? '<div class="tiny muted" style="margin-top:6px">Остаток введён вручную — остатки по складам WB ещё не загружены («Настройки → 3.5 Остатки по складам»).</div>' : ''}
          <div class="divider"></div>
          <b class="tiny">Цены по размерам</b>
          <div id="ic-sizes"><div class="loader"><div class="spinner"></div></div></div>
          ${facts ? `<div class="divider"></div>
            <b class="tiny">Факт из отчёта WB за ${U.num(facts.windowDays, 0)} дн</b>
            ${UI.kv([
              ['Логистика средняя', U.money(facts.logisticsAvg)],
              ['Логистика возврата', U.money(facts.returnLogisticsAvg || 0)],
              ['Комиссия средняя', U.pct(facts.commissionPctAvg)],
              ['Хранение', U.money(facts.storageAvg || 0)],
              ['Приёмка', U.money(facts.acceptanceAvg || 0)],
              ['Эквайринг', U.pct(facts.acquiringPctAvg || 0, 2)],
              ['Доля возвратов', U.pct(facts.returnSharePct || 0, 1)]
            ])}` : '<p class="hint" style="margin-top:10px">Фактические расходы из отчёта WB не загружены — ' +
              'расчёт идёт по справочнику категории и формуле логистики. Загрузить: «Настройки → 3.1 Фактические расходы».</p>'}
        </div>
      </div>`;

    /** Расчёт при конкретной цене — тем же движком, что и во всём приложении. */
    const analyzeAt = (basePrice, discountPct) => {
      const item = Object.assign({}, it, { price: Number(basePrice) || 0, discount: Number(discountPct) || 0 });
      const ov = EC.preferFacts(d.overrides || {}, facts, d.settings);
      return EC.analyze(d.settings, item, ov, undefined, facts);
    };

    /** Живой пересчёт: было (цена МП) → станет (то, что введено). */
    const paintLive = () => {
      const b = U.num(host.querySelector('#ic-base').value);
      const dd = U.num(host.querySelector('#ic-disc').value);
      const seller = Math.round(b * (1 - dd / 100) * 100) / 100;
      host.querySelector('#ic-seller').value = seller;

      const was = analyzeAt(mpBase, mpDisc).current;
      const now = analyzeAt(b, dd).current;
      const dProfit = now.profit - was.profit;
      const dMargin = now.marginPct - was.marginPct;
      const perDay = U.num(st.salesQty) / 30;
      const dMonth = dProfit * perDay * 30;

      host.querySelector('#ic-live').innerHTML = `
        ${UI.kv([
          ['Цена', U.money(was.revenue) + ' → <b>' + U.money(now.revenue) + '</b>'],
          ['Цена покупателю (с СПП)', U.money(was.buyerPrice) + ' → <b>' + U.money(now.buyerPrice) + '</b>'],
          ['Прибыль с единицы', `<span class="${U.profitClass(was.profit)}">${U.money(was.profit)}</span> →
            <b class="${U.profitClass(now.profit)}">${U.money(now.profit)}</b>
            <span class="${U.profitClass(dProfit)} tiny">(${U.signed(Math.round(dProfit))} ₽)</span>`],
          ['Маржинальность', `<span class="${U.profitClass(was.marginPct)}">${U.pct(was.marginPct)}</span> →
            <b class="${U.profitClass(now.marginPct)}">${U.pct(now.marginPct)}</b>
            <span class="${U.profitClass(dMargin)} tiny">(${U.signed(dMargin, 1)} п.п.)</span>`],
          ['Δ прибыли за месяц', perDay > 0
            ? `<b class="${U.profitClass(dMonth)}">${U.signed(Math.round(dMonth))} ₽</b>
               <span class="tiny muted">при ${U.num(perDay * 30).toFixed(0)} продажах/мес</span>`
            : '<span class="muted tiny">нет данных о продажах — прогноз невозможен</span>'],
          ['Безубыточность', now.breakEvenPrice ? U.money(now.breakEvenPrice) : '—']
        ])}
        ${now.profit < 0 ? '<div class="alert danger" style="margin-top:10px">При этой цене товар уходит в минус.</div>' : ''}
        ${Math.abs(seller - mpSeller) > 0.5 && mpSeller > 0 && seller < mpSeller / 3
          ? '<div class="alert warn" style="margin-top:10px">Цена падает более чем в 3 раза — WB отправит товар в карантин.</div>' : ''}`;

      // полная смета обновляется вместе с живым блоком
      const p = now;
      const src = (analyzeAt(b, dd).params.costSources) || {};
      const srcBadge = (key) => {
        const map = { fact: 'факт WB', watch: 'витрина WB', manual: 'вручную', category: 'справочник', settings: 'настройки', formula: 'формула', none: '—' };
        const v = src[key] || 'none';
        const kind = (v === 'fact' || v === 'watch') ? 'ok' : (v === 'manual' ? 'info' : (v === 'none' ? 'warn' : ''));
        return UI.badge(map[v] || v, kind);
      };
      host.querySelector('#ic-unit').innerHTML = UI.kv([
        ['Комиссия WB', U.money(p.commission) + ' ' + srcBadge('commissionPct')],
        ['Логистика', U.money(p.logistics) + ' ' + srcBadge('logisticsRub')],
        ['Хранение', U.money(p.storage) + ' ' + srcBadge('storageRub')],
        ['Приёмка', U.money(p.accept || 0)],
        ['Эквайринг', U.money(p.acquiring) + ' ' + srcBadge('acquiringPct')],
        ['Себестоимость', U.money(p.cogs) + ' ' + srcBadge('costPriceRub')],
        ['Упаковка', U.money(p.packaging) + ' ' + srcBadge('packagingRub')],
        ['Реклама', U.money(p.ad)],
        ['Налог', U.money(p.tax)],
        ['Итого расходов', U.money(p.totalCosts)],
        ['Прибыль', `<b class="${U.profitClass(p.profit)}">${U.money(p.profit)}</b>`],
        ['Маржа', `<b class="${U.profitClass(p.marginPct)}">${U.pct(p.marginPct)}</b>`]
      ]) + (src.costPriceRub === 'none'
        ? '<div class="alert warn" style="margin-top:10px">Себестоимость не задана — прибыль и маржа недостоверны. Заполните во вкладке «Комиссии и параметры».</div>'
        : '');
    };

    host.querySelector('#ic-base').oninput = U.debounce(paintLive, 120);
    host.querySelector('#ic-disc').oninput = U.debounce(paintLive, 120);
    paintLive();

    // одна кнопка: сохранить цену в данных приложения, никуда не отправляя
    host.querySelector('#ic-save').onclick = async (e) => {
      const btn = e.target;
      const b = U.num(host.querySelector('#ic-base').value);
      const dd = U.num(host.querySelector('#ic-disc').value);
      if (!(b > 0)) { App.toast('Укажите базовую цену больше нуля', 'warn'); return; }
      btn.disabled = true;
      try {
        await API.invoke('prices:draft-save', {
          items: { [String(this.nmID)]: { basePrice: b, discount: dd, note: String(host.querySelector('#ic-note').value || '') } }
        });
        // цена должна сразу стать ценой товара во всех разделах
        S.invalidate();
        if (typeof S.loadDrafts === 'function') await S.loadDrafts();
        await S.loadGoods(false);
        App.toast('Цена сохранена: ' + U.money(Math.round(b * (1 - dd / 100) * 100) / 100) +
          '. Применяется во всех разделах, в WB не отправлена.', 'ok', 8000);
        this.data = await API.invoke('items:card', { nmID: this.nmID });
        this.paint();
      } catch (err) {
        App.toast(err.message, 'err', 9000);
        btn.disabled = false;
      }
    };

    const drop = host.querySelector('#ic-drop');
    if (drop) drop.onclick = async () => {
      await API.invoke('prices:draft-clear', { nmIDs: [this.nmID] });
      S.invalidate();
      if (typeof S.loadDrafts === 'function') await S.loadDrafts();
      await S.loadGoods(false);
      App.toast('Своя цена удалена — снова работаем с ценой маркетплейса', 'ok', 6000);
      this.data = await API.invoke('items:card', { nmID: this.nmID });
      this.paint();
    };

    // размеры подгружаем отдельно: это ещё один запрос к WB, а окно должно открыться сразу
    (async () => {
      const sizesHost = host.querySelector('#ic-sizes');
      if (!sizesHost) return;
      try {
        const res = await API.invoke('wb:sizes', this.nmID);
        const g = (res && res[0]) || null;
        const sizes = (g && g.sizes) || it.sizes || [];
        if (!sizes.length) { sizesHost.innerHTML = '<div class="muted tiny">Информация о размерах недоступна</div>'; return; }
        const params = analyzeAt(myBase, myDisc).params;
        sizesHost.innerHTML = `<table class="grid-table"><thead><tr><th>Размер</th><th class="num">Цена</th>
          <th class="num">Со скидкой</th><th class="num">Прибыль/шт</th></tr></thead><tbody>
          ${sizes.map((sz) => {
            const sc = EC.calcUnit(sz.discountedPrice || (sz.price * (1 - myDisc / 100)), params);
            return `<tr><td>${U.esc(sz.techSizeName || sz.techSize || '')}</td><td class="num">${U.money(sz.price)}</td>
              <td class="num">${U.money(sz.discountedPrice)}</td>
              <td class="num ${U.profitClass(sc.profit)}">${U.money(sc.profit)}</td></tr>`;
          }).join('')}</tbody></table>`;
      } catch (e) {
        sizesHost.innerHTML = `<div class="alert danger tiny">${U.esc(e.message)}</div>`;
      }
    })();
  },

  /**
   * Перечитать данные карточки одним запросом.
   * Нужно после записи наблюдения: СПП по витрине участвует в экономике,
   * а `this.data.facts` без перечитывания остался бы старым.
   */
  async reloadCard() {
    try {
      const data = await API.invoke('items:card', { nmID: this.nmID });
      if (data && data.ok && data.item) this.data = data;
    } catch (e) {
      // старая карточка лучше, чем пустая: ошибку покажет тот блок, который её вызвал
    }
  },

  // ───────────────────────── Конкуренты ─────────────────────────

  /**
   * Цена конкурента в нашей системе координат — как колонки «Цена с СПП» и
   * «Цена с кошельком» в репрайсере INDEEPA. WB показывает покупателю цену с СПП,
   * поэтому для честного сравнения цену конкурента приводят к нашей цене до СПП:
   * с СПП = цена / (1 − СПП/100), с кошельком = дополнительно / (1 − кошелёк/100).
   */
  sppPctNow() {
    // Тот же приоритет и осмысленный ноль, что в экономике/репрайсере.
    return U.num(this.econ().params.sppPct);
  },

  walletPctNow() {
    return U.num(((this.data.repricerConfig || {}).priceEdit || {}).walletPct);
  },

  sppPrice(v) {
    const spp = this.sppPctNow();
    return spp > 0 && v > 0 ? Math.round((v / Math.max(0.01, 1 - spp / 100)) * 100) / 100 : v;
  },

  walletPrice(v) {
    const w = this.walletPctNow();
    const base = this.sppPrice(v);
    return w > 0 && base > 0 ? Math.round((base / Math.max(0.01, 1 - w / 100)) * 100) / 100 : base;
  },

  tabCompetitors(host) {
    const draftList = window.LocalDrafts ? LocalDrafts.draftItems('card-competitors-' + this.nmID, 'repricer:competitors:save')[String(this.nmID)] : undefined;
    const list = (Array.isArray(draftList) ? draftList : (this.data.competitors || [])).slice();

    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Конкуренты по этому артикулу</h3>
          <span class="hint">WB API цены конкурентов не отдаёт — список ведётся вручную</span></div>
        <div style="padding:12px 16px 16px">
          <div id="ic-comp-list"></div>
          <div class="divider"></div>
          <div class="row wrap" style="gap:8px;align-items:end">
            <label class="field">Название / продавец<input id="ic-c-name" placeholder="Например: ИП Иванов" style="width:200px" /></label>
            <label class="field">SKU конкурента (нм-код WB)<input id="ic-c-sku" placeholder="например 148004135" style="width:170px" /></label>
            <label class="field">Цена, ₽<input type="number" class="num" id="ic-c-price" step="10" style="width:120px" /></label>
            <label class="field">Остаток, шт<input type="number" class="num" id="ic-c-stock" step="1" value="1" style="width:110px" /></label>
            <button class="btn btn-primary" id="ic-c-add">Добавить</button>
          </div>
          <p class="hint" style="margin-top:8px">Конкуренты участвуют в стратегии «Конкурентный приоритет»:
            репрайсер держит цену относительно лучшего предложения из этого списка.</p>
        </div>
      </div>`;

    const listHost = host.querySelector('#ic-comp-list');
    const paintList = () => {
      if (!list.length) {
        listHost.innerHTML = '<p class="muted">Конкурентов пока нет — добавьте первого ниже.</p>';
        return;
      }
      listHost.innerHTML = `<table class="grid-table"><thead><tr><th>Продавец</th><th>SKU</th><th class="num">Цена</th>
        <th class="num">С СПП / кошелёк</th><th class="num">Остаток</th><th>Учитывать</th><th class="num">Обновлён</th><th></th></tr></thead><tbody>
        ${list.map((c, i) => `<tr>
          <td><input class="ic-c-edit" data-i="${i}" data-f="name" value="${U.esc(c.name || '')}" style="width:160px" /></td>
          <td><input class="ic-c-edit mono" data-i="${i}" data-f="sku" value="${U.esc(c.sku || '')}" placeholder="нм-код" style="width:104px" /></td>
          <td class="num"><input type="number" step="0.01" min="0.01" class="num ic-c-edit" data-i="${i}" data-f="price" value="${U.num(c.price)}" style="width:92px" /></td>
          <td class="num tiny muted">${U.money(this.sppPrice(U.num(c.price)))}<div>кошелёк ${U.money(this.walletPrice(U.num(c.price)))}</div></td>
          <td class="num"><input type="number" step="1" min="0" class="num ic-c-edit" data-i="${i}" data-f="stock" value="${U.num(c.stock, 1)}" style="width:90px" /></td>
          <td><input type="checkbox" class="ic-c-edit" data-i="${i}" data-f="enabled" ${c.enabled === false ? '' : 'checked'} /></td>
          <td class="tiny muted">${c.updatedAt ? U.date(c.updatedAt, true) : '—'}</td>
          <td><button class="btn btn-xs btn-ghost ic-c-del" data-i="${i}">удалить</button></td>
        </tr>`).join('')}</tbody></table>`;

      listHost.querySelectorAll('.ic-c-edit').forEach((inp) => {
        inp.oninput = inp.onchange = () => {
          const i = Number(inp.dataset.i);
          const f = inp.dataset.f;
          list[i][f] = f === 'enabled' ? inp.checked : (['name', 'sku'].includes(f) ? String(inp.value) : U.num(inp.value));
          list[i].updatedAt = new Date().toISOString();
        };
      });
      listHost.querySelectorAll('.ic-c-del').forEach((b) => {
        b.onclick = async () => {
          list.splice(Number(b.dataset.i), 1);
          stage();
          paintList();
        };
      });
    };

    const normalized = () => list.map((c, i) => ({
        id: c.id || (this.nmID + '-c' + (i + 1)),
        name: String(c.name || 'Конкурент'),
        // SKU конкурента храним отдельно: по нему наблюдатель цен сможет сам
        // найти карточку на витрине и обновить цену с остатком
        sku: String(c.sku || ''),
        price: Number(c.price) || 0,
        stock: c.stock === undefined ? 1 : Number(c.stock),
        enabled: c.enabled !== false,
        updatedAt: c.updatedAt || new Date().toISOString()
      }));
    const stage = () => {
      const items = { [String(this.nmID)]: normalized() };
      LocalDrafts.stage('card-competitors-' + this.nmID, [{ channel: 'repricer:competitors:save', payload: { items } }]);
    };
    const save = async () => {
      stage();
      if (!await LocalDrafts.commit({ id: 'card-competitors-' + this.nmID })) return false;
      this.data.competitors = normalized();
      return true;
    };

    host.querySelector('#ic-c-add').onclick = async () => {
      const name = String(host.querySelector('#ic-c-name').value || '').trim();
      const price = U.num(host.querySelector('#ic-c-price').value);
      if (!(price > 0)) { App.toast('Укажите цену конкурента', 'warn'); return; }
      list.push({
        name: name || 'Конкурент',
        sku: String(host.querySelector('#ic-c-sku').value || '').trim(),
        price,
        stock: U.num(host.querySelector('#ic-c-stock').value, 1),
        enabled: true
      });
      host.querySelector('#ic-c-sku').value = '';
      stage();
      host.querySelector('#ic-c-name').value = '';
      host.querySelector('#ic-c-price').value = '';
      App.toast('Конкурент добавлен в черновик — нажмите «Сохранить изменения»', 'ok');
      paintList();
    };

    // сохранение правок — при уходе с вкладки
    host.querySelector('#ic-c-add').parentElement.insertAdjacentHTML('beforeend',
      '<button class="btn" id="ic-c-save">Сохранить изменения</button>');
    host.querySelector('#ic-c-save').onclick = async () => {
      if (await save()) { App.toast('Конкуренты сохранены', 'ok'); paintList(); }
    };

    paintList();
    const nmID = this.nmID;
    LocalDrafts.bind(host, 'card-competitors-' + nmID, () => [{ channel: 'repricer:competitors:save', payload: { items: { [String(nmID)]: normalized() } } }], '.ic-c-edit', () => this.nmID === nmID && this.reloadCard());
  },

  // ───────────────────────── Цены на площадке ─────────────────────────

  /**
   * Вкладка «Цены на площадке» — то, чего в кабинете WB нет.
   *
   * API продавца отдаёт только вашу цену и скидку: ни витринной цены, ни фактического СПП,
   * ни остатка на витрине там не видно. Модуль наблюдателя (electron/price-watcher.js) читает
   * карточку товара на витрине WB и складывает наблюдения в pricewatch.json; медиана СПП за
   * 7 дней оттуда попадает в экономику (источник «витрина WB») — она свежее среднего по
   * статистике продаж.
   *
   * Автозапросы к витрине по умолчанию ВЫКЛЮЧЕНЫ (настройки, раздел 3.4): витрина защищена
   * от ботов, и честнее нажать кнопку самому, чем поймать блокировку в фоне. Кнопка ниже
   * всегда делает один осознанный запрос. Если WB ответит 403/429 или страницей с капчей —
   * показываем это как есть, останавливаемся и предлагаем вписать цифры руками.
   */
  async tabWatch(host) {
    const nmID = this.nmID;
    const d = this.data;
    host.innerHTML = '<div class="card"><div style="padding:16px"><p class="muted">Читаем наблюдения по товару…</p></div></div>';

    let hist = [];
    let autoFetch = false;
    let ttl = 0;
    try {
      const h = await API.invoke('pricewatch:history', { nmID });
      const g = await API.invoke('pricewatch:get');
      hist = ((h && h.items) || []).slice().reverse();
      autoFetch = !!(g && g.autoFetch);
      ttl = U.num(g && g.ttlMinutes);
    } catch (e) {
      host.innerHTML = '<div class="alert danger">Не удалось прочитать наблюдения: ' + U.esc(e.message || String(e)) + '</div>';
      return;
    }
    // пока читали, пользователь мог переключить вкладку — в чужую не рисуем
    if (this.tab !== 'watch') return;

    const p = this.econ().params;
    const srcSpp = (p.costSources || {}).sppPct || 'none';
    const srcMap = {
      official: 'официальный заказ/продажа из ЛК WB',
      watch: 'наблюдение витрины WB',
      fact: 'среднее по продажам WB',
      manual: 'ваш ручной ввод',
      category: 'значение в карточке',
      settings: 'общая настройка',
      none: 'не задан'
    };
    const last = hist[0] || null;
    const comps = (d.competitors || []).filter((c) => String(c.sku || '').trim());
    const demo = !!d.demo;
    const f = d.facts || {};
    const srcLabel = (v) => ({ site: 'витрина WB', manual: 'вручную', auto: 'автозапрос' }[String(v || '')] || String(v || '—'));
    const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
    const sppWatch = (f.sppPctWatch === undefined || f.sppPctWatch === null) ? null : U.num(f.sppPctWatch);

    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Что видит покупатель на витрине</h3>
          <span class="hint">WB API эти цифры не отдаёт — их читает наблюдатель цен</span></div>
        <div style="padding:12px 16px 16px">
          ${demo ? `<div class="alert info" style="margin-bottom:12px">Демо-режим: запросы к витрине WB не выполняются
            (артикулы демо-товаров там не существуют, а лишний запрос рискует получить блокировку).
            Ручной ввод ниже работает — на нём удобно посмотреть, как наблюдение влияет на экономику.</div>` : ''}
          ${last ? UI.kv([
            ['Цена на полке', dash(last.shelfPrice) === '—' ? '—' : U.money(last.shelfPrice)],
            ['Цена покупателю (с СПП)', dash(last.sppPrice) === '—' ? '—' : U.money(last.sppPrice)],
            ['СПП по витрине', last.sppPct === null || last.sppPct === undefined ? '—' : U.pct(last.sppPct)],
            ['Остаток на витрине', last.stock === null || last.stock === undefined ? '—' : U.num(last.stock).toFixed(0) + ' шт'],
            ['Наблюдалось', U.date(last.at, true) + ' · ' + srcLabel(last.source)]
          ]) : '<p class="muted">Наблюдений пока нет. Нажмите «Обновить с витрины» или впишите цены вручную ниже.</p>'}
          <div class="alert info" style="margin-top:12px"><b>Официальный путь без витрины:</b> СПП можно получить из последних заказов/продаж личного кабинета WB кнопкой ниже. Это не live-цена витрины для каждого покупателя, а последнее датированное наблюдение кабинета.${f.sppPctOfficial !== null && f.sppPctOfficial !== undefined ? `<br>Сейчас в ЛК: <b>${U.pct(f.sppPctOfficial)}</b> · ${U.esc(f.sppOfficialSource === 'orders' ? 'заказ' : 'продажа')} ${U.date(f.sppOfficialAt, true)}.` : ''}</div>
          <div class="row wrap" style="gap:8px;margin-top:12px;align-items:center">
            <button class="btn btn-primary" id="pw-fetch" ${demo ? 'disabled' : ''}>Обновить с витрины</button>
            <button class="btn btn-ok" id="pw-official">СПП из ЛК WB (официальный API)</button>
            <button class="btn" id="pw-open">Открыть карточку на WB</button>
            <span class="tiny muted" id="pw-status">${demo ? 'демо-режим'
              : (autoFetch ? 'автозапросы включены, кэш ' + ttl + ' мин' : 'автозапросы выключены — кнопка делает один запрос')}</span>
          </div>
          <div id="pw-result" style="margin-top:10px"></div>
          <p class="hint" style="margin-top:10px">Витрина WB защищена от ботов. Если запрос вернёт 403/429 или страницу с капчей,
            приложение честно напишет об этом и остановится — повторные запросы только усилят блокировку.
            Тогда откройте карточку и впишите цифры руками: расчёты от этого не станут менее точными.</p>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><h3>Какой СПП идёт в расчёты</h3></div>
        <div style="padding:12px 16px 16px">
          ${UI.kv([
            ['Значение', U.pct(p.sppPct) + ' ' + UI.badge(srcMap[srcSpp] || srcSpp, srcSpp === 'none' ? 'warn' : 'ok')],
            ['Медиана по витрине (7 дней)', sppWatch === null ? 'нет наблюдений'
              : U.pct(sppWatch) + (U.num(f.sppWatchSamples) ? ' · ' + U.num(f.sppWatchSamples) + ' замеров, последний ' + (f.sppWatchAt ? U.date(f.sppWatchAt, true) : '—') : '')],
            ['Среднее по продажам WB', U.num(f.sppPctAvg) > 0 ? U.pct(f.sppPctAvg) + ' · ' + U.num(f.sppSalesQty).toFixed(0) + ' продаж' : 'нет данных']
          ])}
          <p class="hint" style="margin-top:8px">Приоритет: ваш ручной ввод → последнее датированное наблюдение ЛК/витрины → среднее продаж WB →
            значение в карточке → общая настройка. Своё значение СПП задаётся в разделе «Себестоимость».</p>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><h3>Вписать вручную</h3>
          <span class="hint">цифры с витрины, если запрос заблокирован</span></div>
        <div style="padding:12px 16px 16px">
          <div class="row wrap" style="gap:8px;align-items:end">
            <label class="field">Цена на полке, ₽<input type="number" class="num" id="pw-m-shelf" step="1" min="0" placeholder="цена до СПП" style="width:150px" /></label>
            <label class="field">Цена покупателю, ₽<input type="number" class="num" id="pw-m-buyer" step="1" min="0" placeholder="с учётом СПП" style="width:160px" /></label>
            <button class="btn" id="pw-m-save">Записать наблюдение</button>
            <span class="tiny muted" id="pw-m-spp">СПП: —</span>
          </div>
          <p class="hint" style="margin-top:8px">Наблюдение попадёт в историю и в медиану СПП, которая используется в экономике
            и в репрайсере. Остаток вручную не записывается — его видно только на витрине.</p>
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><h3>Конкуренты по SKU</h3>
          <span class="hint">${comps.length ? 'цена и остаток обновляются с витрины WB' : 'нужен SKU конкурента'}</span></div>
        <div style="padding:12px 16px 16px">
          ${comps.length ? `<table class="grid-table dense"><thead><tr><th>Продавец</th><th>SKU</th>
              <th class="num">Цена покупателю</th><th class="num">Наш эквивалент</th><th class="num">Остаток</th>
              <th>Обновлён</th><th></th></tr></thead><tbody>
              ${comps.map((c) => `<tr>
                <td>${U.esc(c.name || 'Конкурент')}</td>
                <td class="mono">${U.esc(String(c.sku))}</td>
                <td class="num">${U.num(c.price) > 0 ? U.money(c.price) : '<span class="muted">неизвестна</span>'}</td>
                <td class="num tiny muted">${U.num(c.price) > 0 ? U.money(this.sppPrice(U.num(c.price))) : '—'}</td>
                <td class="num">${c.stock === null || c.stock === undefined ? '—' : U.num(c.stock).toFixed(0)}</td>
                <td class="tiny muted">${c.updatedAt ? U.date(c.updatedAt, true) : '—'}</td>
                <td><button class="btn btn-xs pw-comp" data-sku="${U.esc(String(c.sku))}" ${demo ? 'disabled' : ''}>обновить</button></td>
              </tr>`).join('')}</tbody></table>
            <div class="row wrap" style="gap:8px;margin-top:10px;align-items:center">
              <button class="btn btn-sm" id="pw-comp-all" ${demo ? 'disabled' : ''}>Обновить всех (${comps.length})</button>
              <span class="tiny muted">Цена конкурента записывается как цена покупателю (с СПП) — именно её сравнивает
                репрайсер в режиме «с СПП». «Наш эквивалент» — какую цену до СПП пришлось бы поставить нам.</span>
            </div>`
            : `<p class="muted">Чтобы обновлять цену конкурента автоматически, укажите его SKU (нм-код WB) на вкладке
               «Конкуренты». Без SKU цену придётся вписывать руками.</p>`}
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><h3>История наблюдений</h3>
          <span class="hint">${hist.length ? 'последние ' + hist.length + ' (хранится до 50 на товар)' : 'пусто'}</span></div>
        <div style="padding:12px 16px 16px">
          ${hist.length ? `<table class="grid-table dense"><thead><tr><th>Когда</th><th class="num">Полка</th>
              <th class="num">Покупателю</th><th class="num">СПП</th><th class="num">Остаток</th>
              <th>Источник</th><th>Примечание</th></tr></thead><tbody>
              ${hist.map((r) => `<tr>
                <td class="tiny">${U.date(r.at, true)}</td>
                <td class="num">${r.shelfPrice === null || r.shelfPrice === undefined ? '—' : U.money(r.shelfPrice)}</td>
                <td class="num">${r.sppPrice === null || r.sppPrice === undefined ? '—' : U.money(r.sppPrice)}</td>
                <td class="num">${r.sppPct === null || r.sppPct === undefined ? '—' : U.pct(r.sppPct)}</td>
                <td class="num">${r.stock === null || r.stock === undefined ? '—' : U.num(r.stock).toFixed(0)}</td>
                <td class="tiny">${srcLabel(r.source)}</td>
                <td class="tiny muted">${U.esc(r.note || '')}</td>
              </tr>`).join('')}</tbody></table>`
            : '<p class="muted">Пусто — записи появятся после первого обновления с витрины или ручного ввода.</p>'}
        </div>
      </div>`;

    const result = host.querySelector('#pw-result');
    const statusEl = host.querySelector('#pw-status');

    /** Честный разбор ответа наблюдателя: что получили, почему не получили. */
    const paintResult = (r, what) => {
      if (!r) return;
      const rows = r.results || [];
      const first = rows[0] || null;
      const msg = (first && first.message) || r.message || '';
      if (r.code === 'AUTO_DISABLED') {
        result.innerHTML = '<div class="alert warn">Автозапросы к витрине выключены в настройках (раздел 3.4).</div>';
        return;
      }
      if (r.code === 'DEMO') {
        result.innerHTML = '<div class="alert info">' + U.esc(msg || 'В демо-режиме запросы к витрине не выполняются.') + '</div>';
        return;
      }
      if (r.blocked) {
        result.innerHTML = '<div class="alert warn">' + U.esc(msg || 'Витрина WB заблокировала запрос.') +
          ' <span class="tiny">Дальше не пробуем и защиту не обходим. Нажмите «СПП из ЛК WB (официальный API)» выше — подтянем последнее наблюдение из заказов/продаж кабинета, либо впишите цены вручную ниже.</span></div>';
        return;
      }
      if (r.ok === false) {
        result.innerHTML = '<div class="alert danger">' + U.esc(msg || 'Не удалось получить данные витрины.') + '</div>';
        return;
      }
      const own = rows.find((x) => x.kind === 'own' && x.ok);
      const comp = rows.filter((x) => x.kind === 'competitor' && x.ok);
      const parts = [];
      if (own) {
        parts.push('полка ' + U.money(own.shelfPrice) + ', покупателю ' + (own.sppPrice === null || own.sppPrice === undefined ? '—' : U.money(own.sppPrice)) +
          ', СПП ' + (own.sppPct === null || own.sppPct === undefined ? '—' : U.pct(own.sppPct)) +
          ', остаток ' + (own.stock === null || own.stock === undefined ? '—' : U.num(own.stock).toFixed(0) + ' шт') +
          (own.fromCache ? ' <span class="tiny muted">(из кэша)</span>' : ''));
      }
      if (comp.length) parts.push('конкурентов обновлено: ' + comp.length);
      result.innerHTML = '<div class="alert ok">' + what + ': ' + (parts.join('; ') || 'данные получены') + '</div>';
    };

    /** Один осознанный запрос к витрине: force обходит и настройку автозапросов, и кэш. */
    const runFetch = async (payload, what) => {
      const btns = Array.prototype.slice.call(host.querySelectorAll('button'));
      btns.forEach((b) => { b.disabled = true; });
      statusEl.textContent = what + '…';
      result.innerHTML = '';
      let r = null;
      try {
        r = await API.invoke('pricewatch:fetch', Object.assign({ force: true }, payload));
      } catch (e) {
        result.innerHTML = '<div class="alert danger">' + U.esc(e.message || String(e)) + '</div>';
        return;
      } finally {
        if (this.tab === 'watch' && host.contains(statusEl)) {
          statusEl.textContent = demo ? 'демо-режим' : (autoFetch ? 'автозапросы включены, кэш ' + ttl + ' мин' : 'автозапросы выключены — кнопка делает один запрос');
          btns.forEach((b) => { if (!demo || b.id === 'pw-open') b.disabled = false; });
        }
      }
      if (r && r.ok) {
        App.toast(what + ': обновлено', 'ok');
        await this.reloadCard();
        if (this.tab === 'watch') await this.tabWatch(host);
        return;
      }
      paintResult(r, what);
      const rows = (r && r.results) || [];
      App.toast((rows[0] && rows[0].message) || (r && r.message) || (what + ': не удалось'), 'warn');
    };

    host.querySelector('#pw-fetch').onclick = () => runFetch({ nmIDs: [nmID] }, 'Витрина');
    host.querySelector('#pw-official').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const res = await API.invoke('spp:refresh');
        await S.loadGoods(false); await S.refreshFacts();
        App.toast(res.note || 'СПП обновлён из личного кабинета WB.', 'ok', 9000);
        await this.reloadCard(); if (this.tab === 'watch') await this.tabWatch(host);
      } catch (e) { App.toast(e.message || String(e), 'warn', 9000); }
      finally { if (button.isConnected) button.disabled = false; }
    };
    host.querySelector('#pw-open').onclick = () => {
      API.openExternal('https://www.wildberries.ru/catalog/' + nmID + '/detail.aspx');
    };
    host.querySelectorAll('.pw-comp').forEach((b) => {
      b.onclick = () => runFetch({ competitorSKUs: [String(b.dataset.sku)] }, 'Конкурент ' + b.dataset.sku);
    });
    const allBtn = host.querySelector('#pw-comp-all');
    if (allBtn) allBtn.onclick = () => runFetch({ competitorSKUs: comps.map((c) => String(c.sku)) }, 'Конкуренты');

    // ручной ввод: СПП считаем на лету, чтобы было видно, что запишется
    const shelfInp = host.querySelector('#pw-m-shelf');
    const buyerInp = host.querySelector('#pw-m-buyer');
    const sppOut = host.querySelector('#pw-m-spp');
    const liveSpp = () => {
      const sh = U.num(shelfInp.value);
      const by = U.num(buyerInp.value);
      sppOut.textContent = sh > 0 && by > 0 && by <= sh
        ? 'СПП: ' + U.pct(Math.round((1 - by / sh) * 10000) / 100)
        : 'СПП: —';
    };
    shelfInp.oninput = liveSpp;
    buyerInp.oninput = liveSpp;
    host.querySelector('#pw-m-save').onclick = async () => {
      const shelfPrice = U.num(shelfInp.value);
      const sppPrice = U.num(buyerInp.value);
      if (!(shelfPrice > 0) && !(sppPrice > 0)) { App.toast('Введите цену с витрины', 'warn'); return; }
      try {
        const r = await API.invoke('pricewatch:record', {
          nmID,
          shelfPrice: shelfPrice > 0 ? shelfPrice : undefined,
          sppPrice: sppPrice > 0 ? sppPrice : undefined,
          source: 'manual'
        });
        if (!r || r.ok === false) { App.toast((r && r.message) || 'Не удалось записать наблюдение', 'warn'); return; }
        App.toast('Наблюдение записано' + (r.sppPct === null || r.sppPct === undefined ? '' : ', СПП ' + U.pct(r.sppPct)), 'ok');
        await this.reloadCard();
        if (this.tab === 'watch') await this.tabWatch(host);
      } catch (e) {
        App.toast(e.message || String(e), 'warn');
      }
    };
  },

  // ───────────────────────── Комиссии и параметры ─────────────────────────

  tabCommissions(host) {
    const d = this.data;
    const ov = d.enteredCosts || d.overrides || {};
    const cfg = d.itemConfig || {};
    const cat = (d.settings.categoryDefaults || {})[d.item.categoryName || d.item.subjectName] || {};

    const fld = (key, label, val, hint, step) => `
      <label class="field">${label}
        <input type="number" step="${step || 'any'}" class="num" id="ic-p-${key}" value="${val === undefined || val === null || val === '' ? '' : val}" placeholder="${hint || ''}" />
      </label>`;

    host.innerHTML = `
      <div class="card">
        <h3>Личные параметры товара</h3>
        <p class="hint">Значения переопределяют справочник категории и факт из отчёта WB.
          Пустое поле — «как у категории». Справочник по категории «${U.esc(d.item.categoryName || d.item.subjectName || '—')}»:
          комиссия ${U.pct(U.num(cat.commissionPct, U.num(d.settings.commissionDefault)))},
          реклама ${U.pct(U.num(cat.adPct, U.num(d.settings.adPctDefault)))}.</p>
        <div class="grid g3" style="gap:10px;margin-top:10px">
          ${fld('costPriceRub', 'Себестоимость в выбранной валюте', ov.costEntered !== undefined && ov.costEntered !== null && ov.costEntered !== '' ? ov.costEntered : ov.costPriceRub, 'закупка/производство')}
          <label class="field">Валюта себестоимости<select id="ic-p-currency">${[...new Set(['RUB', ...Object.keys(d.settings.costRates || {}), ov.currency || 'RUB'])].map((currency) => `<option value="${U.esc(currency)}" ${currency === (ov.currency || 'RUB') ? 'selected' : ''}>${U.esc(currency)}</option>`).join('')}</select></label>
          ${fld('otherPct', 'Прочие расходы, % до СПП', ov.otherPct, 'пусто = 0', '0.01')}
          ${fld('otherRub', 'Прочие расходы, ₽/шт', ov.otherRub, 'прибавляется к проценту', '0.01')}
          ${fld('packagingRub', 'Упаковка, ₽', ov.packagingRub, 'коробка, пупырка, этикетка')}
          ${fld('commissionPct', 'Комиссия WB, %', ov.commissionPct, 'из отчёта или справочника', '0.1')}
          ${fld('logisticsRub', 'Логистика, ₽', ov.logisticsRub, 'за одну продажу', '0.01')}
          ${fld('storageRub', 'Хранение, ₽', ov.storageRub, 'в сутки или за продажу', '0.01')}
          ${fld('adPct', 'Реклама, %', ov.adPct, 'доля от выручки', '0.1')}
          ${fld('sppPct', 'СПП, %', ov.sppPct, 'скидка WB за счёт площадки', '0.1')}
          ${fld('stock', 'Остаток, шт', ov.stock, 'если не берём из WB', '1')}
          ${fld('salesPerDay', 'Продаж в день', ov.salesPerDay, 'если нет статистики', '0.01')}
        </div>
      </div>

      <div class="card" style="margin-top:12px">
        <h3>СПП из ЛК и наблюдений</h3>
        ${d.facts?.sppPctOfficial !== null && d.facts?.sppPctOfficial !== undefined ? `<div class="alert info">Последнее наблюдение ЛК: ${U.pct(d.facts.sppPctOfficial)} · ${U.esc(d.facts.sppOfficialSource === 'orders' ? 'заказ' : 'продажа')} ${U.date(d.facts.sppOfficialAt, true)}. Не live-витрина. Получено ${U.date(d.facts.sppOfficialReceivedAt, true)}.</div>` : ''}
        <p class="hint">СПП — скидка, которую WB даёт покупателю за свой счёт. В официальных заказах и продажах есть <span class="mono">spp</span>: используем последнее известное наблюдение с датой.
          Это не гарантирует цену витрины сейчас. Если WB блокирует витрину, запросы прекращаются; ручной ввод и официальная статистика продолжают работать.</p>
        ${(d.facts && d.facts.sppPctWatch !== undefined && d.facts.sppPctWatch !== null) ? `<div class="alert ok" style="margin-bottom:10px">
            <b>По наблюдению витрины: СПП ${U.pct(U.num(d.facts.sppPctWatch), 2)}</b>
            <span class="hint">(медиана за 7 дней по ${U.fmt(d.facts.sppWatchSamples || 0)} замерам${d.facts.sppWatchAt ? ', последний ' + U.date(d.facts.sppWatchAt, true) : ''}).
            Использование зависит от ручного ввода и даты более свежего официального наблюдения; источник расчёта указан отдельно.</span>
          </div>` : ''}
        ${(d.facts && d.facts.sppPctAvg !== null && d.facts.sppPctAvg !== undefined) ? `<div class="alert ok" style="margin-bottom:10px">
            <b>По факту продаж WB: СПП ${U.pct(U.num(d.facts.sppPctAvg), 2)}</b>
            <span class="hint">(по ${U.fmt(d.facts.sppSalesQty || 0)} продажам за окно статистики).
            Это среднее за период, а не обещание текущей скидки каждому покупателю.</span>
          </div>`
        : `<div class="alert info" style="margin-bottom:10px">Нет среднего по загруженным продажам. В расчёте используется последний доступный источник; общая настройка кабинета (${U.pct(U.num(d.settings.sppDefault))}).
            Загрузите статистику или введите СПП вручную по витрине — калькулятор ниже.</div>`}
        <p class="hint">Калькулятор ниже — для случая, когда нужно уточнить СПП глазами с витрины
          (например, для нового товара без продаж).</p>
        <div class="grid g3" style="gap:10px;margin-top:10px">
          <label class="field">Наша цена со скидкой, ₽
            <input type="number" class="num" id="ic-spp-ours" step="1" value="${Math.round(this.econ().current.revenue * 100) / 100}" /></label>
          <label class="field">Цена покупателю на витрине, ₽
            <input type="number" class="num" id="ic-spp-shelf" step="1" placeholder="сколько видит покупатель" /></label>
          <label class="field">Получается СПП, %
            <input type="number" class="num" id="ic-spp-result" step="0.1" readonly placeholder="—" /></label>
        </div>
        <div class="row wrap" style="margin-top:10px;gap:8px">
          <button class="btn btn-sm" id="ic-spp-calc">Рассчитать СПП</button>
          <button class="btn btn-sm" id="ic-spp-watch">Подтянуть с витрины</button>
          <button class="btn btn-sm btn-primary" id="ic-spp-apply">Подставить в поле «СПП, %»</button>
          <button class="btn btn-sm btn-ghost" id="ic-spp-open">Открыть товар на витрине ↗</button>
          <span class="hint" id="ic-spp-note"></span>
        </div>
        <p class="hint" style="margin-top:8px">Значение сохраняется в личных параметрах товара и используется
          в расчёте цены покупателю, в стратегии «Удержание РРЦ» и в отстройке от конкурента «с учётом СПП».</p>
      </div>

      <div class="card" style="margin-top:12px">
        <h3>Стратегия репрайсера для этого товара</h3>
        <div class="grid g3" style="gap:10px">
          <label class="field">Стратегия
            <select id="ic-p-strategy">
              <option value="">Как в общих настройках</option>
              ${RP.STRATEGIES.map((s) => `<option value="${s.id}" ${cfg.strategy === s.id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}
            </select></label>
        </div>
        <div class="thresholds" id="ic-thresholds">
          <div class="th-head"><span>Расчётные значения — обновляются при вводе</span><span>Пороги товара — заполняются цифрами</span></div>
          <div class="th-grid">
            <div class="th-calc">
              <div><span>Расчётная мин. цена, ₽</span><b id="th-floor">—</b></div>
              <div><span>Мин. цена для покупателя (после СПП), ₽</span><b id="th-floor-buyer">—</b></div>
              <div><span>Марж. расчётной мин. цены</span><b id="th-floor-margin">—</b></div>
              <div><span>Расчётный потолок, ₽</span><b id="th-ceil">—</b></div>
              <div><span>Рабочий коридор репрайсера</span><b id="th-corridor">—</b></div>
            </div>
            <div class="th-inputs">
              ${fld('minPrice', 'Мин. цена, ₽ *', cfg.minPrice, 'не ниже этой цены')}
              ${fld('minMarginPct', 'Мин. марж., %', cfg.minMarginPct, 'пол по марже')}
              ${fld('minMarginRub', 'Мин. марж., ₽', cfg.minMarginRub, 'пол по прибыли')}
              ${fld('maxPrice', 'Макс. цена, ₽', cfg.maxPrice, 'не выше этой цены')}
              ${fld('maxMarginPct', 'Макс. марж., %', cfg.maxMarginPct, 'потолок по марже')}
              ${fld('maxMarginRub', 'Макс. марж., ₽', cfg.maxMarginRub, 'потолок по прибыли')}
            </div>
          </div>
          <p class="hint">Мин. цена заполняется в валюте кабинета: «удерживать цену не ниже 500 ₽» — заполнить 500; «ровно 500» — Мин и Макс по 500. Действующий минимум — самый строгий из минимальных порогов, потолок — самый строгий из максимальных; репрайсер строго работает внутри коридора. Расчёт слева предварительный, по текущей экономике карточки; точный коридор покажет пересчёт репрайсера.</p>
        </div>
        <p class="hint" style="margin-top:8px">Личная стратегия важнее общей: она применяется только к этому артикулу.</p>
      </div>

      <div class="row wrap" style="margin-top:12px;gap:8px">
        <button class="btn btn-primary" id="ic-p-save">Сохранить параметры</button>
        <button class="btn btn-ghost" id="ic-p-reset">Очистить личные значения</button>
        <span class="hint">После сохранения экономика и репрайсер пересчитаются автоматически.</span>
      </div>`;

    const num = (key) => {
      const el = host.querySelector('#ic-p-' + key);
      if (!el || el.value === '') return null;
      return U.num(el.value);
    };

    // Компактный блок порогов (как в INDEEPA): слева расчёт, справа ввод; пересчёт при вводе.
    const thParams = this.econ().params;
    const thSpp = U.num(thParams.sppPct);
    const thUnitAt = (price) => EC.calcUnit(price, thParams);
    const thPriceFor = (get, target) => {
      let lo = 1, hi = Math.max(100000, U.num(this.econ().current.revenue) * 4);
      if (get(thUnitAt(hi)) < target) return null;
      for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (get(thUnitAt(mid)) >= target) hi = mid; else lo = mid; }
      return hi;
    };
    const updateThresholds = () => {
      const v = (k) => { const el = host.querySelector('#ic-p-' + k); return el && el.value !== '' ? U.num(el.value) : null; };
      const floorByPct = v('minMarginPct') > 0 ? thPriceFor((u) => u.marginPct, v('minMarginPct')) : null;
      const floorByRub = v('minMarginRub') > 0 ? thPriceFor((u) => u.profit, v('minMarginRub')) : null;
      const floors = [v('minPrice'), floorByPct, floorByRub].filter((x) => x > 0);
      const floor = floors.length ? Math.max(...floors) : null;
      const ceilByPct = v('maxMarginPct') > 0 ? thPriceFor((u) => u.marginPct, v('maxMarginPct')) : null;
      const ceilByRub = v('maxMarginRub') > 0 ? thPriceFor((u) => u.profit, v('maxMarginRub')) : null;
      const ceils = [v('maxPrice'), ceilByPct, ceilByRub].filter((x) => x > 0);
      const ceil = ceils.length ? Math.min(...ceils) : null;
      const set = (id, text) => { const el = host.querySelector(id); if (el) el.textContent = text; };
      set('#th-floor', floor ? U.money(floor) : 'не задан');
      set('#th-floor-buyer', floor ? U.money(floor * (1 - thSpp / 100)) : '—');
      set('#th-floor-margin', floor ? U.pct(thUnitAt(floor).marginPct) + ' · ' + U.money(thUnitAt(floor).profit) : '—');
      set('#th-ceil', ceil ? U.money(ceil) : 'не задан');
      set('#th-corridor', floor || ceil ? (floor ? U.money(floor) : '…') + ' — ' + (ceil ? U.money(ceil) : '…') + (floor && ceil && ceil < floor ? ' ⚠ конфликт: применится минимум' : '') : 'не задан');
    };
    ['minPrice', 'minMarginPct', 'minMarginRub', 'maxPrice', 'maxMarginPct', 'maxMarginRub'].forEach((k) => {
      const el = host.querySelector('#ic-p-' + k);
      if (el) el.addEventListener('input', updateThresholds);
    });
    updateThresholds();

    /**
     * СПП считается от двух цен: нашей (после наших скидок) и той, что видит покупатель
     * на витрине. Формула: spp = (1 − ценаНаВитрине / нашаЦена) × 100.
     * Витринную цену WB по API не отдаёт, поэтому её вводят глазами с карточки товара.
     */
    const calcSpp = () => {
      const ours = U.num(host.querySelector('#ic-spp-ours').value);
      const shelf = U.num(host.querySelector('#ic-spp-shelf').value);
      const out = host.querySelector('#ic-spp-result');
      const note = host.querySelector('#ic-spp-note');
      if (!(ours > 0) || !(shelf > 0)) {
        out.value = '';
        note.textContent = 'Заполните обе цены: нашу и ту, что видит покупатель.';
        note.className = 'hint warnc';
        return null;
      }
      if (shelf > ours) {
        out.value = '';
        note.textContent = 'Цена на витрине выше нашей — так не бывает: проверьте, ту ли карточку открыли.';
        note.className = 'hint warnc';
        return null;
      }
      const spp = Math.round((1 - shelf / ours) * 10000) / 100;
      out.value = spp;
      note.textContent = 'СПП ' + U.pct(spp, 2) + ': наша ' + U.money(ours) + ' → покупателю ' + U.money(shelf) +
        ' (разница ' + U.money(ours - shelf) + ' за счёт WB).';
      note.className = 'hint pos';
      return spp;
    };

    host.querySelector('#ic-spp-calc').onclick = () => calcSpp();
    host.querySelector('#ic-spp-shelf').oninput = U.debounce(() => calcSpp(), 400);
    host.querySelector('#ic-spp-ours').oninput = U.debounce(() => calcSpp(), 400);

    host.querySelector('#ic-spp-apply').onclick = () => {
      const spp = calcSpp();
      if (spp === null) return;
      const field = host.querySelector('#ic-p-sppPct');
      if (field) {
        field.value = spp;
        App.toast('СПП ' + U.pct(spp, 2) + ' подставлен и будет сохранён локально', 'ok', 6000);
      }
    };

    /**
     * «Подтянуть с витрины» — один осознанный запрос наблюдателя цен (force обходит
     * выключенные автозапросы и кэш). Обе цены подставляются в калькулятор, наблюдение
     * записывается в историю, и СПП сразу считается.
     * Если витрина заблокировала запрос — пишем об этом честно и предлагаем ручной ввод.
     */
    host.querySelector('#ic-spp-watch').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const note = host.querySelector('#ic-spp-note');
      btn.disabled = true;
      note.className = 'hint';
      note.textContent = 'Читаем карточку на витрине WB…';
      try {
        const r = await API.invoke('pricewatch:fetch', { nmIDs: [this.nmID], force: true });
        const res = ((r && r.results) || [])[0] || null;
        if (!res || !res.ok) {
          note.className = 'hint warnc';
          note.textContent = (res && res.message) || (r && r.message) || 'Витрина не ответила — впишите цены руками.';
          return;
        }
        host.querySelector('#ic-spp-ours').value = (res.shelfPrice === null || res.shelfPrice === undefined) ? '' : res.shelfPrice;
        host.querySelector('#ic-spp-shelf').value = (res.sppPrice === null || res.sppPrice === undefined) ? '' : res.sppPrice;
        calcSpp();
        note.className = 'hint pos';
        note.textContent += ' Наблюдение записано' +
          ((res.stock === null || res.stock === undefined) ? '' : ', остаток на витрине ' + U.num(res.stock).toFixed(0) + ' шт') + '.';
        // перечитываем карточку: СПП по витрине уже участвует в экономике
        await this.reloadCard();
      } catch (e) {
        note.className = 'hint warnc';
        note.textContent = e.message || String(e);
      } finally {
        btn.disabled = false;
      }
    };

    host.querySelector('#ic-spp-open').onclick = () => {
      // карточка товара на витрине: по нм-коду, без домена кабинета
      API.openExternal('https://www.wildberries.ru/catalog/' + this.nmID + '/detail.aspx');
      App.toast('Открыли карточку на витрине. Перепишите цену, которую видит покупатель, и нажмите «Рассчитать СПП».', 'ok', 10000);
    };

    host.querySelector('#ic-p-save').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      try {
        const costs = {};
        ['costPriceRub', 'packagingRub', 'commissionPct', 'logisticsRub', 'storageRub', 'adPct', 'sppPct', 'stock', 'salesPerDay']
          .forEach((k) => { costs[k === 'costPriceRub' ? 'costEntered' : k] = num(k); });
        await S.saveCosts({ [String(this.nmID)]: costs });

        const strategy = host.querySelector('#ic-p-strategy').value;
        const itemCfg = { strategy: strategy || null, minPrice: num('minPrice'), maxPrice: num('maxPrice'), minMarginPct: num('minMarginPct'), minMarginRub: num('minMarginRub'), maxMarginPct: num('maxMarginPct'), maxMarginRub: num('maxMarginRub') };
        await API.invoke('repricer:item-configs:save', { items: { [String(this.nmID)]: itemCfg } });

        S.invalidate();
        await S.reloadOverrides();
        App.toast('Параметры товара сохранены', 'ok', 5000);
        this.data = await API.invoke('items:card', { nmID: this.nmID });
        this.paint();
      } catch (err) {
        App.toast(err.message, 'err', 9000);
        btn.disabled = false;
      }
    };

    host.querySelector('#ic-p-reset').onclick = async () => {
      await S.saveCosts({ [String(this.nmID)]: null });
      await API.invoke('repricer:item-configs:save', { items: { [String(this.nmID)]: null } });
      S.invalidate();
      App.toast('Личные значения очищены — работаем по категории', 'ok');
      this.data = await API.invoke('items:card', { nmID: this.nmID });
      this.paint();
    };
  },

  // ───────────────────────── Акции ─────────────────────────

  tabPromos(host) {
    const d = this.data;
    const list = d.promos || [];
    const url = U.promoCabinetUrl;

    const cfg = d.itemConfig || {};
    const val = (x) => x === undefined || x === null || x === '' ? '' : x;
    host.innerHTML = `
      <div class="card promo-price-block" id="ic-promo-price-block">
        <div class="card-head"><h3>Цены товара в акции и вне акции</h3>
          <span class="hint">как в INDEEPA: слева расчёт, справа ввод цифрами</span></div>
        <div class="pp-grid">
          <section class="pp-col">
            <h4>Мин цена (в акции)</h4>
            <div class="pp-row"><span>Расчётная мин. цена, ₽</span><b id="pp-min-calc">—</b><label>Мин. цена, ₽ *<input type="number" class="num" id="pp-minPrice" step="1" value="${val(cfg.minPrice)}" placeholder="не ниже этой цены" /></label></div>
            <div class="pp-row"><span>Расчётная мин. цена с СПП, ₽</span><b id="pp-min-spp">—</b><label>Мин. марж., % *<input type="number" class="num" id="pp-minMarginPct" step="0.5" value="${val(cfg.minMarginPct)}" placeholder="пол по марже" /></label></div>
            <div class="pp-row"><span>Марж. расчётной мин. цены, %</span><b id="pp-min-margin-pct">—</b><label>Мин. марж., ₽ *<input type="number" class="num" id="pp-minMarginRub" step="1" value="${val(cfg.minMarginRub)}" placeholder="пол по прибыли" /></label></div>
            <div class="pp-row"><span>Марж. расчётной мин. цены, ₽</span><b id="pp-min-margin-rub">—</b><span class="pp-index">Прогнозный индекс мин. цены<br><b>Без индекса</b></span></div>
          </section>
          <section class="pp-col">
            <h4>Цена (вне акции)</h4>
            <div class="pp-row"><span>Расчётная базовая цена, ₽</span><b id="pp-base-calc">—</b><label>Базовая цена, ₽ *<input type="number" class="num" id="pp-basePriceTarget" step="1" value="${val(cfg.basePriceTarget)}" placeholder="обычная цена" /></label></div>
            <div class="pp-row"><span>Расчётная базовая цена с СПП, ₽</span><b id="pp-base-spp">—</b><label>Базовая марж., % *<input type="number" class="num" id="pp-targetMarginPct" step="0.5" value="${val(cfg.targetMarginPct)}" placeholder="целевая маржа" /></label></div>
            <div class="pp-row"><span>Марж. расчётной базовой цены, %</span><b id="pp-base-margin-pct">—</b><label>Базовая марж., ₽ *<input type="number" class="num" id="pp-targetMarginRub" step="1" value="${val(cfg.targetMarginRub)}" placeholder="прибыль с единицы" /></label></div>
            <div class="pp-row"><span>Марж. расчётной базовой цены, ₽</span><b id="pp-base-margin-rub">—</b><span class="pp-index">Прогнозный индекс базовой цены<br><b>Без индекса</b></span></div>
          </section>
        </div>
        <div class="row wrap" style="gap:8px;margin-top:10px">
          <button class="btn btn-primary btn-sm" id="pp-save">Сохранить цены и пороги</button>
          <span class="hint" id="pp-status">Расчёт предварительный по экономике карточки; репрайсер строго не выйдет за мин./макс. пороги.</span>
        </div>
        <p class="hint" style="margin-top:6px">Для WB вместо колонки «по карте Ozon» показана цена покупателя после СПП. «Не ниже 500 ₽» — Мин. цена 500; «ровно 500» — Мин. цена 500 и максимальная цена 500 во вкладке «Комиссии и параметры».</p>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="card-head"><h3>Акции, к которым относится товар</h3>
          <span class="hint">${list.length ? list.length + ' шт.' : 'нет данных'}</span></div>
        <div style="padding:12px 16px 16px">
          ${list.length ? `<table class="grid-table"><thead><tr>
              <th>Акция</th><th>Тип</th><th class="num">Скидка ≥</th><th class="num">Плановая цена</th>
              <th>Статус</th><th>Период</th><th></th></tr></thead><tbody>
            ${list.map((p) => `<tr>
              <td><b>${U.esc(p.name || p.id)}</b><div class="tiny muted">ID ${U.esc(String(p.id))}</div></td>
              <td>${UI.badge(p.type === 'auto' ? 'автоакция' : 'обычная', p.type === 'auto' ? 'danger' : '')}</td>
              <td class="num">${U.pct(U.num(p.requiredDiscountPct || p.participationPercentage), 0)}</td>
              <td class="num">${p.planPrice ? U.money(p.planPrice) : '—'}</td>
              <td>${p.inAction ? UI.badge('участвует', 'ok') : UI.badge(p.eligible ? 'подходит' : 'кандидат', 'info')}
                <div class="tiny muted">${{ file: 'из файла кабинета', inferred: 'по факту скидки', api: 'из WB API', none: 'состав не загружен' }[p.source] || ''}</div></td>
              <td class="tiny">${U.date(p.startDateTime)} — ${U.date(p.endDateTime)}</td>
              <td><button class="btn btn-xs" data-promo="${U.esc(String(p.id))}" data-name="${U.esc(String(p.name || ''))}">Перейти к акции</button></td>
            </tr>`).join('')}</tbody></table>`
            : '<p class="muted">Товар не числится ни в одной акции календаря (или состав акции не загружен).</p>'}

          <div class="alert info" style="margin-top:12px">
            <b>Состав акции — из файла кабинета, не из API.</b> Метод состава у WB помечен
            «Not applicable for auto promotions» и отвечает <span class="mono">HTTP 422</span> почти на любой акции,
            поэтому приложение к нему не обращается. Как получить точный состав: «Перейти к акции» (кабинет WB в браузере) →
            <b>«Перейти к товарам для акции» → «Сформировать» → «Скачать»</b> → в приложении раздел «Акции» →
            «Загрузить товары из файла».
            <br><span class="tiny">Пока файла нет, участие определяется по факту скидки товара: WB сообщает, что скидка есть,
            но не сообщает, в какой именно акции. Этого достаточно для расчёта экономики, но не для точного состава.</span>
          </div>
        </div>
      </div>`;

    // Блок «Мин цена (в акции) / Цена (вне акции)»: расчёт слева, ввод справа, пересчёт при вводе.
    const ppParams = this.econ().params;
    const ppSpp = U.num(ppParams.sppPct);
    const ppUnitAt = (price) => EC.calcUnit(price, ppParams);
    const ppPriceFor = (get, target) => {
      let lo = 1, hi = Math.max(100000, U.num(this.econ().current.revenue) * 4);
      if (get(ppUnitAt(hi)) < target) return null;
      for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (get(ppUnitAt(mid)) >= target) hi = mid; else lo = mid; }
      return hi;
    };
    const ppVal = (id) => { const el = host.querySelector(id); return el && el.value !== '' ? U.num(el.value) : null; };
    const ppSet = (id, text) => { const el = host.querySelector(id); if (el) el.textContent = text; };
    const updatePromoPrices = () => {
      const floorParts = [ppVal('#pp-minPrice'), ppVal('#pp-minMarginPct') > 0 ? ppPriceFor((u) => u.marginPct, ppVal('#pp-minMarginPct')) : null, ppVal('#pp-minMarginRub') > 0 ? ppPriceFor((u) => u.profit, ppVal('#pp-minMarginRub')) : null].filter((x) => x > 0);
      const floor = floorParts.length ? Math.max(...floorParts) : null;
      const baseParts = [ppVal('#pp-basePriceTarget'), ppVal('#pp-targetMarginPct') > 0 ? ppPriceFor((u) => u.marginPct, ppVal('#pp-targetMarginPct')) : null, ppVal('#pp-targetMarginRub') > 0 ? ppPriceFor((u) => u.profit, ppVal('#pp-targetMarginRub')) : null].filter((x) => x > 0);
      const base = baseParts.length ? Math.max(...baseParts) : U.num(this.econ().current.revenue);
      ppSet('#pp-min-calc', floor ? U.money(floor) : 'не задан');
      ppSet('#pp-min-spp', floor ? U.money(floor * (1 - ppSpp / 100)) : '—');
      ppSet('#pp-min-margin-pct', floor ? U.pct(ppUnitAt(floor).marginPct) : '—');
      ppSet('#pp-min-margin-rub', floor ? U.money(ppUnitAt(floor).profit) : '—');
      ppSet('#pp-base-calc', base ? U.money(base) : '—');
      ppSet('#pp-base-spp', base ? U.money(base * (1 - ppSpp / 100)) : '—');
      ppSet('#pp-base-margin-pct', base ? U.pct(ppUnitAt(base).marginPct) : '—');
      ppSet('#pp-base-margin-rub', base ? U.money(ppUnitAt(base).profit) : '—');
    };
    ['#pp-minPrice', '#pp-minMarginPct', '#pp-minMarginRub', '#pp-basePriceTarget', '#pp-targetMarginPct', '#pp-targetMarginRub'].forEach((id) => {
      const el = host.querySelector(id); if (el) el.addEventListener('input', updatePromoPrices);
    });
    updatePromoPrices();
    host.querySelector('#pp-save').onclick = async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      const status = host.querySelector('#pp-status');
      try {
        const patch = { minPrice: ppVal('#pp-minPrice'), minMarginPct: ppVal('#pp-minMarginPct'), minMarginRub: ppVal('#pp-minMarginRub'), basePriceTarget: ppVal('#pp-basePriceTarget'), targetMarginPct: ppVal('#pp-targetMarginPct'), targetMarginRub: ppVal('#pp-targetMarginRub') };
        await API.invoke('repricer:item-configs:save', { items: { [String(this.nmID)]: patch } });
        const target = this.data.itemConfig || (this.data.itemConfig = {});
        Object.entries(patch).forEach(([k, v]) => { if (v === null) delete target[k]; else target[k] = v; });
        S.invalidate();
        status.textContent = 'Сохранено. Репрайсер применит пороги при следующем пересчёте; в WB цены этим действием не отправляются.';
        App.toast('Цены и пороги товара сохранены', 'ok', 5000);
      } catch (e) {
        status.textContent = e.message || String(e);
        App.toast(e.message || String(e), 'err', 8000);
      } finally { btn.disabled = false; }
    };

    host.querySelectorAll('[data-promo]').forEach((b) => {
      b.onclick = () => {
        const pid = b.getAttribute('data-promo');
        const name = b.getAttribute('data-name') || '';
        API.openExternal(url({ id: pid, name: name }, d.settings));
        App.toast('Открыли акцию «' + (name || pid) + '» в кабинете WB — скачайте файл состава', 'ok', 9000);
      };
    });
  },

  // ───────────────────────── История пересчёта ─────────────────────────

  tabHistory(host) {
    const d = this.data;
    const recalc = d.recalcHistory || [];
    const prices = d.priceHistory || [];

    host.innerHTML = `
      <div class="grid g2" style="gap:12px">
        <div class="card">
          <div class="card-head"><h3>Пересчёты репрайсера по этому артикулу</h3>
            <span class="hint">${recalc.length ? recalc.length + ' записей' : 'пусто'}</span></div>
          <div style="padding:10px 16px 16px;max-height:340px;overflow:auto">
            ${recalc.length ? `<table class="grid-table"><thead><tr><th>Когда</th><th>Фаза</th>
              <th class="num">Цена</th><th class="num">Было</th><th>Стратегия</th><th>Причина</th></tr></thead><tbody>
              ${recalc.map((h) => `<tr>
                <td class="tiny">${U.date(h.at, true)}</td>
                <td>${h.phase === 'send' ? UI.badge('отправлено', 'ok') : UI.badge('предложено', 'info')}</td>
                <td class="num"><b>${U.money(h.sellerPrice)}</b><div class="tiny muted">база ${U.money(h.basePrice)} · скидка ${U.pct(h.discount, 0)}</div></td>
                <td class="num muted">${h.prevSellerPrice ? U.money(h.prevSellerPrice) : '—'}</td>
                <td class="tiny">${U.esc(h.strategy || '—')}</td>
                <td class="tiny muted">${U.esc(h.reason || '')}</td>
              </tr>`).join('')}</tbody></table>`
              : '<p class="muted">Пересчётов по этому артикулу ещё не было.</p>'}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>История цен</h3>
            <span class="hint">${prices.length ? prices.length + ' записей' : 'пусто'}</span></div>
          <div style="padding:10px 16px 16px;max-height:340px;overflow:auto">
            ${prices.length ? `<table class="grid-table"><thead><tr><th>Когда</th>
              <th class="num">Базовая</th><th class="num">Скидка</th><th class="num">Цена</th><th>Откуда</th></tr></thead><tbody>
              ${prices.map((h) => `<tr>
                <td class="tiny">${U.date(h.at, true)}</td>
                <td class="num">${U.money(h.basePrice)}</td>
                <td class="num">${U.pct(h.discount, 0)}</td>
                <td class="num"><b>${U.money(h.sellerPrice)}</b></td>
                <td class="tiny muted">${U.esc(h.source || '')}</td>
              </tr>`).join('')}</tbody></table>`
              : '<p class="muted">Цен в WB ещё не меняли.</p>'}
          </div>
        </div>
      </div>`;
  }
};
