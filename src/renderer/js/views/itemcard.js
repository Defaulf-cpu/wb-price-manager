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
      content: UI.loading('Читаем данные товара из WB и кэша приложения…'),
      buttons: [{ label: 'Закрыть' }]
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
            ['Остаток на складах', U.fmt((d.overrides || {}).stock || 0) + ' шт'],
            ['Объём, л', card && card.volumeLiters ? U.num(card.volumeLiters, 2) + ' л' : '—'],
            ['Габариты, см', card && card.dimensions
              ? U.num(card.dimensions.length) + ' × ' + U.num(card.dimensions.width) + ' × ' + U.num(card.dimensions.height)
              : '—']
          ])}
          ${(d.statsMeta && d.statsMeta.truncated) ? '<p class="hint warnc" style="margin-top:8px">WB отдал не все страницы статистики — цифры за период могут быть неполными.</p>' : ''}
          ${(d.statsMeta && d.statsMeta.stale) ? '<p class="hint warnc" style="margin-top:8px">Статистика от ' + U.esc(U.date(d.statsMeta.staleAt, true)) + ': последний запрос к WB отклонён (лимит 1 запрос в минуту).</p>' : ''}
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
        const map = { fact: 'факт WB', manual: 'вручную', category: 'справочник', settings: 'настройки', formula: 'формула', none: '—' };
        const v = src[key] || 'none';
        const kind = v === 'fact' ? 'ok' : (v === 'manual' ? 'info' : (v === 'none' ? 'warn' : ''));
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

  // ───────────────────────── Конкуренты ─────────────────────────

  /**
   * Цена конкурента в нашей системе координат — как колонки «Цена с СПП» и
   * «Цена с кошельком» в репрайсере INDEEPA. WB показывает покупателю цену с СПП,
   * поэтому для честного сравнения цену конкурента приводят к нашей цене до СПП:
   * с СПП = цена / (1 − СПП/100), с кошельком = дополнительно / (1 − кошелёк/100).
   */
  sppPctNow() {
    const ov = this.data.overrides || {};
    if (U.num(ov.sppPct) > 0) return U.num(ov.sppPct);
    if (U.num(this.data.item && this.data.item.sppPct) > 0) return U.num(this.data.item.sppPct);
    return U.num((this.data.settings || {}).sppDefault);
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
    const list = (this.data.competitors || []).slice();

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
          <td class="num"><input type="number" step="10" class="num ic-c-edit" data-i="${i}" data-f="price" value="${U.num(c.price)}" style="width:92px" /></td>
          <td class="num tiny muted">${U.money(this.sppPrice(U.num(c.price)))}<div>кошелёк ${U.money(this.walletPrice(U.num(c.price)))}</div></td>
          <td class="num"><input type="number" step="1" class="num ic-c-edit" data-i="${i}" data-f="stock" value="${U.num(c.stock, 1)}" style="width:90px" /></td>
          <td><input type="checkbox" class="ic-c-edit" data-i="${i}" data-f="enabled" ${c.enabled === false ? '' : 'checked'} /></td>
          <td class="tiny muted">${c.updatedAt ? U.date(c.updatedAt, true) : '—'}</td>
          <td><button class="btn btn-xs btn-ghost ic-c-del" data-i="${i}">удалить</button></td>
        </tr>`).join('')}</tbody></table>`;

      listHost.querySelectorAll('.ic-c-edit').forEach((inp) => {
        inp.onchange = () => {
          const i = Number(inp.dataset.i);
          const f = inp.dataset.f;
          list[i][f] = f === 'enabled' ? inp.checked : (f === 'name' ? String(inp.value) : U.num(inp.value));
        };
      });
      listHost.querySelectorAll('.ic-c-del').forEach((b) => {
        b.onclick = async () => {
          list.splice(Number(b.dataset.i), 1);
          await save();
          paintList();
        };
      });
    };

    const save = async () => {
      const items = {};
      items[String(this.nmID)] = list.map((c, i) => ({
        id: c.id || (this.nmID + '-c' + (i + 1)),
        name: String(c.name || 'Конкурент'),
        // SKU конкурента храним отдельно: по нему наблюдатель цен сможет сам
        // найти карточку на витрине и обновить цену с остатком
        sku: String(c.sku || ''),
        price: Number(c.price) || 0,
        stock: c.stock === undefined ? 1 : Number(c.stock),
        enabled: c.enabled !== false,
        updatedAt: new Date().toISOString()
      }));
      await API.invoke('repricer:competitors:save', { items });
      this.data.competitors = items[String(this.nmID)];
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
      await save();
      host.querySelector('#ic-c-name').value = '';
      host.querySelector('#ic-c-price').value = '';
      App.toast('Конкурент добавлен', 'ok');
      paintList();
    };

    // сохранение правок — при уходе с вкладки
    host.querySelector('#ic-c-add').parentElement.insertAdjacentHTML('beforeend',
      '<button class="btn" id="ic-c-save">Сохранить изменения</button>');
    host.querySelector('#ic-c-save').onclick = async () => {
      await save();
      App.toast('Конкуренты сохранены', 'ok');
      paintList();
    };

    paintList();
  },

  // ───────────────────────── Комиссии и параметры ─────────────────────────

  tabCommissions(host) {
    const d = this.data;
    const ov = d.overrides || {};
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
          ${fld('costPriceRub', 'Себестоимость, ₽', ov.costPriceRub, 'закупка/производство')}
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
        <h3>СПП по цене на витрине</h3>
        <p class="hint">СПП — скидка, которую WB даёт покупателю за свой счёт. Витринную цену «здесь и сейчас»
          по API не отдать, но <b>реальный СПП уже есть в статистике продаж WB</b>: в каждой строке продажи
          указано поле <span class="mono">spp</span>, и приложение берёт среднее по вашим продажам.</p>
        ${(d.facts && d.facts.sppPctAvg) ? `<div class="alert ok" style="margin-bottom:10px">
            <b>По факту продаж WB: СПП ${U.pct(U.num(d.facts.sppPctAvg), 2)}</b>
            <span class="hint">(по ${U.fmt(d.facts.sppSalesQty || 0)} продажам за окно статистики).
            Это значение уже используется в расчёте — источник помечен как «факт WB».</span>
          </div>`
        : `<div class="alert info" style="margin-bottom:10px">По этому товару ещё нет продаж в загруженной статистике,
            поэтому СПП берётся из настройки кабинета (${U.pct(U.num(d.settings.sppDefault))}).
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
          ${fld('minPrice', 'Минимальная цена (пол), ₽', cfg.minPrice, 'ниже не опускаемся')}
          ${fld('maxPrice', 'Максимальная цена (потолок), ₽', cfg.maxPrice, 'выше не поднимаем')}
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
        App.toast('СПП ' + U.pct(spp, 2) + ' подставлен — нажмите «Сохранить параметры»', 'ok', 6000);
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
          .forEach((k) => { costs[k] = num(k); });
        await S.saveCosts({ [String(this.nmID)]: costs });

        const strategy = host.querySelector('#ic-p-strategy').value;
        const itemCfg = { strategy: strategy || null, minPrice: num('minPrice'), maxPrice: num('maxPrice') };
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

    host.innerHTML = `
      <div class="card">
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
