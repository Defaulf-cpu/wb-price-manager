'use strict';

/** Акции: календарь, условия входа, расчёт выгодности участия. */
window.Views = window.Views || {};

Views.promos = {
  title: 'Акции WB',
  subtitle: 'Календарь акций, контроль входа и расчёт экономики по акционной цене',

  /** Раздел «Акции» — тот же календарь, что открывается вкладкой репрайсера. */
  render(container) { this.mount(container); },

  /**
   * Календарь акций в произвольном контейнере: раздел «Акции» и вложенная вкладка
   * «Акции» репрайсера используют один код (календарь, вход/выход, импорт состава,
   * ссылка в кабинет), поэтому поведение одинаковое.
   */
  mount(container) {
    const st = S.state;
    this.container = container;
    container.innerHTML = `<div class="card">${UI.loading('Загружаем календарь акций из Wildberries…')}</div>`;

    (async () => {
      try {
        if (!st.promos.length) await S.loadPromos();
        this.renderList();
      } catch (e) {
        container.innerHTML = `<div class="card"><div class="alert danger">${U.esc(e.message)}</div>
          <p class="hint" style="margin-top:10px">Календарь акций доступен по токену категории «Цены и скидки» (хост dp-calendar-api.wildberries.ru).</p>
          <button class="btn" id="retry">Повторить</button></div>`;
        container.querySelector('#retry').onclick = () => this.mount(container);
      }
    })();
  },

  renderList() {
    const st = S.state;
    const container = this.container;
    const rows = S.getRows();
    const byNm = new Map(rows.map((r) => [Number(r.nmID), r]));

    container.innerHTML = `
      <div class="row wrap" style="margin-bottom:12px">
        <div class="alert info grow">Акции берутся из календаря WB (<span class="mono">dp-calendar-api</span>). Для каждой акции приложение считает,
        какие товары проходят по требуемой скидке, а какие — станут убыточными при входе.
        <br><span class="tiny">Состав акции WB по API отдаёт не всегда (автоакции не управляются вообще) —
        поэтому список товаров можно загрузить файлом из кабинета: карточка акции → «Загрузить товары из файла».</span></div>
        <button class="btn btn-sm" id="p-refresh">Обновить акции</button>
      </div>
      <div id="promo-noapi-banner"></div>
      <div class="grid g3" id="promo-cards"></div>
      <div id="promo-detail" style="margin-top:14px"></div>
    `;
    container.querySelector('#p-refresh').onclick = async () => {
      st.promos = [];
      await S.loadPromos();
      this.renderList();
      App.toast('Список акций обновлён', 'ok');
    };

    const host = container.querySelector('#promo-cards');
    if (!st.promos.length) {
      host.innerHTML = '<div class="card muted">Акций в выбранном периоде нет.</div>';
      return;
    }

    st.promos.forEach((p) => {
      const req = U.num(p.requiredDiscountPct || p.participationPercentage);
      const eligible = rows.filter((r) => !p.categories || p.categories.includes('Все категории') || p.categories.includes(r.category));
      const pool = eligible.length ? eligible : rows;
      const inPromo = pool.filter((r) => U.num(r.discount) >= req);
      const needMore = pool.filter((r) => U.num(r.discount) < req);

      // экономика при входе в акцию
      let profitDelta = 0, losses = 0, belowTarget = 0;
      needMore.forEach((r) => {
        const ov = st.overrides[String(r.nmID)] || {};
        const a = EC.analyze(st.settings, r.item, ov, { discountPct: req });
        if (!a.next) return;
        profitDelta += a.next.profit - r.profit;
        if (a.next.profit < 0) losses++;
        else if (a.next.marginPct < U.num(st.settings.targetMarginPct)) belowTarget++;
      });

      const start = new Date(p.startDateTime);
      const end = new Date(p.endDateTime);
      const daysLeft = Math.round((end - Date.now()) / 86400000);
      const running = start <= new Date() && end >= new Date();

      const card = U.el(`
        <div class="card promo-card">
          <div class="spread">
            <h2 style="margin:0">${U.esc(p.name)}</h2>
            ${running ? UI.badge('идёт сейчас', 'ok') : UI.badge(daysLeft > 0 ? 'старт через ' + daysLeft + ' дн' : 'завершена')}
          </div>
          <div class="dates">${U.date(p.startDateTime)} — ${U.date(p.endDateTime)} · ${U.esc(p.joinType || p.type || '')}</div>
          <div class="row wrap" style="gap:6px;margin-top:6px">
            ${String(p.type || '').toLowerCase() === 'auto' ? UI.badge('автоакция', 'danger') : UI.badge('обычная акция')}
            <span class="hint" data-src="${p.id}"></span>
          </div>
          <div class="divider"></div>
          <div class="grid g2" style="gap:8px">
            <div class="stat"><span class="label">Требуемая скидка</span><span class="value">${U.pct(req, 0)}</span></div>
            <div class="stat"><span class="label">Подходят уже</span><span class="value pos">${inPromo.length}</span><span class="hint">из ${pool.length} товаров</span></div>
            <div class="stat"><span class="label">Нужно докрутить скидку</span><span class="value ${needMore.length ? 'warnc' : 'pos'}">${needMore.length}</span></div>
            <div class="stat"><span class="label">Станут убыточными</span><span class="value ${losses ? 'neg' : 'pos'}">${losses}</span><span class="hint">ещё ${belowTarget} ниже цели</span></div>
          </div>
          <div class="divider"></div>
          <div class="spread">
            <span class="hint">Δ прибыли при входе: <b class="${U.profitClass(profitDelta)}">${U.signed(Math.round(profitDelta))} ₽/шт</b></span>
            <span class="row wrap" style="gap:6px">
              <button class="btn btn-sm" data-upload="${p.id}">Загрузить товары из файла</button>
              <button class="btn btn-sm btn-primary" data-open="${p.id}">Открыть товары</button>
              <button class="btn btn-sm btn-ghost" data-link="${p.id}" data-name="${U.esc(p.name || '')}"
                title="Открыть акцию в кабинете Wildberries в браузере — там же скачивается файл состава">Перейти к акции ↗</button>
            </span>
          </div>
          <div class="hint" data-manual="${p.id}" style="margin-top:6px"></div>
          <div class="hint" data-noapi="${p.id}" style="margin-top:4px"></div>
        </div>
      `);
      card.querySelector('[data-open]').onclick = () => this.openPromo(p);
      card.querySelector('[data-upload]').onclick = () => this.importNoms(p, () => this.renderList());
      // Открываем точный action=ID в системном браузере. Если WB потребует вход,
      // авторизуйтесь в нём; приложение не подменяет ссылку общей главной страницей.
      card.querySelector('[data-link]').onclick = () => {
        const url = U.promoCabinetUrl({ id: p.id, name: card.querySelector('[data-link]').getAttribute('data-name') }, st.settings);
        API.openExternal(url);
        App.toast('Открыли акцию «' + (p.name || p.id) + '» в кабинете WB: «Перейти к товарам для акции» → ' +
          '«Сформировать» → «Скачать», затем загрузите файл сюда.', 'ok', 12000);
      };
      host.appendChild(card);
    });

    this.markManualNoms();
    this.markNoApi();
    this.markSources();
  },

  /**
   * Подписывает, откуда известен состав акции: из загруженного файла кабинета,
   * по факту скидки товара или не загружен вообще. К WB за составом не ходим:
   * метод nomenclatures отвечает 422 почти на всех акциях.
   */
  async markSources() {
    const host = this.container && this.container.querySelector('#promo-cards');
    if (!host) return;
    let idx;
    try { idx = await API.invoke('promos:index'); } catch (e) { return; }
    const byId = new Map(((idx && idx.promos) || []).map((x) => [String(x.promoId), x]));
    byId.forEach((rec, pid) => {
      const el = host.querySelector('[data-src="' + pid + '"]');
      if (!el) return;
      if (rec.manualCount > 0) {
        el.innerHTML = UI.badge('состав из файла: ' + U.fmt(rec.manualCount), 'ok');
      } else if (rec.eligible > 0) {
        el.innerHTML = UI.badge('по скидке товара: ' + U.fmt(rec.eligible), 'info') +
          ' <span class="tiny muted">WB не сообщает, в какой именно акции товар — загрузите файл для точного состава</span>';
      } else {
        el.innerHTML = UI.badge('состав не загружен', 'warn') +
          ' <span class="tiny muted">скачайте файл в кабинете и загрузите сюда</span>';
      }
    });
  },

  /**
   * Помечает акции, состав которых WB через API не отдаёт (автоакции — всегда,
   * закрытые акции — отвечают HTTP 422). Раньше на каждую такую акцию в интерфейс
   * прилетала ошибка «HTTP 422: Unprocessable entity» — теперь одна понятная подпись.
   */
  async markNoApi() {
    const host = this.container && this.container.querySelector('#promo-cards');
    if (!host) return;
    let idx;
    try { idx = await API.invoke('promos:index'); } catch (e) { return; }
    const byId = new Map(((idx && idx.promos) || []).map((x) => [String(x.promoId), x]));
    let marked = 0;
    byId.forEach((rec, pid) => {
      const el = host.querySelector('[data-noapi="' + pid + '"]');
      if (!el || !rec.noApi) return;
      marked++;
      el.innerHTML = '<span class="warnc">⚠ ' + U.esc(rec.noApi) + '.</span> ' +
        '<span class="muted">Состав берётся файлом: «Перейти к акции» → скачать → «Загрузить товары из файла».</span>';
    });
    // одна сводная плашка на весь раздел вместо потока одинаковых ошибок
    const banner = this.container.querySelector('#promo-noapi-banner');
    if (banner) {
      banner.innerHTML = (idx && idx.noApiCount)
        ? `<div class="alert warn" style="margin-bottom:12px">WB не отдаёт состав через API по <b>${U.num(idx.noApiCount)}</b> акциям
            (автоакции отвечают <span class="mono">HTTP 422</span> — это не ошибка ключа).
            По таким акциям товары загружаются файлом из кабинета: кнопка «Перейти к акции» откроет календарь акций,
            там «Перейти к товарам для акции» → «Сформировать» → «Скачать», затем «Загрузить товары из файла».</div>`
        : '';
    }
    return marked;
  },

  /**
   * Ручная загрузка состава акции из файла кабинета WB (XLSX «Настроить список товаров» или CSV).
   *
   * Зачем: по API состав акции отдаётся не всегда, а автоакции через API не управляются вообще.
   * Загруженный файл дополняет индекс акций, и репрайсер начинает видеть эти товары:
   * считает вход/выход, плановую цену и экономику — так же, как если бы состав приехал из API.
   */
  async importNoms(p, after) {
    let file;
    try { file = await API.importFile({ title: 'Товары акции «' + p.name + '»', extensions: ['xlsx', 'csv', 'txt'], filterName: 'Выгрузка WB (XLSX / CSV)' }); }
    catch (error) { App.toast(error.message, 'err'); return; }
    if (!file) return;
    const wait = UI.modal({ title: 'Чтение выгрузки WB', size: 'sm', dismissable: false, content: UI.loading('Читаем «' + file.fileName + '»…') });
    const payload = { promotionID: p.id, fileName: file.fileName, base64: file.base64 };
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Файл больше 50 МБ. Выгрузите меньшую таблицу.');
      const result = await API.invoke('promos:import-noms', { ...payload, action: 'preview' });
      wait.close();
      const sample = (result.items || result.sample || []).slice(0, 100);
      const modal = UI.modal({ title: 'Предпросмотр условий акции', size: 'lg',
        content: `<div class="alert info">Прочитано <b>${U.fmt(result.count)}</b> товаров. Пока ничего не сохранено и не отправлено в WB.</div>
          <p class="hint">Файл: ${U.esc(file.fileName)} · лист ${U.esc(result.sheet || 'таблица')} · заголовок ${result.headerRow || 'без заголовка'} · пропущено строк ${U.fmt(result.skipped)}.</p>
          ${(result.warnings || []).map((text) => '<div class="alert warn">' + U.esc(text) + '</div>').join('')}
          <p class="tiny muted">Колонки: ${U.esc((result.headers || []).join(' | '))}</p>
          <div class="tablewrap" style="max-height:45vh"><table class="grid-table" style="min-width:1250px"><thead><tr><th>Артикул WB</th><th>Артикул продавца</th><th>Наименование / предмет</th><th>Плановая цена для акции, ₽</th><th>Розничная цена до скидки, ₽</th><th>Текущая скидка, %</th><th>Загружаемая скидка, %</th><th>Остаток WB</th><th>Склад продавца</th><th>Статус из файла</th></tr></thead><tbody>
          ${sample.map((row) => `<tr><td>${row.nmID}</td><td>${U.esc(row.vendorCode)}</td><td>${U.esc(row.title)}<div class="tiny muted">${U.esc([row.categoryName, row.brand].filter(Boolean).join(' · '))}</div></td><td>${row.planPrice ? U.money(row.planPrice, 2) : 'порог не распознан'}</td><td>${row.price ? U.money(row.price, 2) : '—'}</td><td>${row.discount === undefined ? '—' : U.pct(row.discount, 0)}</td><td>${U.pct(row.planDiscount, 0)}</td><td>${row.stockWb === undefined ? '—' : U.fmt(row.stockWb)}</td><td>${row.stockSeller === undefined ? '—' : U.fmt(row.stockSeller)}</td><td>${U.esc(row.fileStatus || (row.inActionKnown ? row.inAction ? 'участвует на дату файла' : 'не участвует на дату файла' : 'не указан'))}</td></tr>`).join('')}
          </tbody></table></div><p class="hint">Показаны первые ${sample.length} строк. Все значения здесь — на дату выгрузки. Плановая цена — точный порог; текущая и загружаемая скидки не смешиваются. Сохранится весь список, без отправки цен в WB. Дальнейшее участие отслеживается по фактической цене WB, а не по ручному черновику.</p><p id="promo-import-error" class="neg"></p>`,
        buttons: [{ label: 'Отмена', class: 'btn-ghost' }, { label: 'Сохранить', class: 'btn-primary', keepOpen: true, onClick: async (dialog) => {
          const button = dialog.foot.querySelector('.btn-primary'); button.disabled = true;
          try {
            await API.invoke('promos:import-noms', { ...payload, action: 'apply' });
            dialog.close(); if (this.promoModal) this.promoModal.close();
            window.__promoDecisions = null;
            if (after) after();
            App.toast('Условия сохранены для репрайсера. Цены в WB не отправлялись.', 'ok', 7000);
            await this.openPromo(p);
          } catch (error) { dialog.body.querySelector('#promo-import-error').textContent = error.message; button.disabled = false; }
        } }] });
    } catch (error) {
      wait.close();
      UI.modal({ title: 'Файл акции не прочитан', size: 'md', content: '<div class="alert danger">' + U.esc(error.message) + '</div><p class="hint">Для загрузки в приложение выберите исходную выгрузку WB в XLSX/CSV с колонкой «Артикул WB / nmID». Лист с инструкцией и строки перед заголовком допускаются. PDF и скриншоты пригодны для сверки структуры, но не для импорта точных артикулов.</p>', buttons: [{ label: 'Закрыть', class: 'btn-primary' }] });
    }
  },

  /** Подписи о загруженных вручную списках товаров на карточках акций. */
  async markManualNoms() {
    const host = this.container && this.container.querySelector('#promo-cards');
    if (!host) return;
    let res;
    try { res = await API.invoke('promos:noms', {}); } catch (e) { return; }
    const all = (res && res.all) || {};
    Object.keys(all).forEach((pid) => {
      const el = host.querySelector('[data-manual="' + pid + '"]');
      if (!el) return;
      const rec = all[pid];
      el.innerHTML = '<b class="pos">✓ из файла загружено ' + U.fmt(rec.count) + ' товаров</b> ' +
        '<span class="muted">(' + U.esc(String(rec.fileName || '')) + ', ' + U.date(rec.at, true) + ')</span>';
    });
  },

  async openPromo(p) {
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
        { label: 'Экспорт CSV', class: 'btn-ghost', keepOpen: true, onClick: () => this.exportPromo(p) },
        { label: 'Закрыть' },
        { label: 'Сохранить', class: 'btn-primary', keepOpen: true, onClick: () => this.saveSelection(p) }
      ]
    });

    // решения репрайсера по акциям — считаем один раз и держим в памяти
    if (!window.__promoDecisions) {
      try {
        const plan = await API.invoke('repricer:promo-plan', {});
        window.__promoDecisions = {};
        (plan.items || []).forEach((it) => { window.__promoDecisions[String(it.nmID)] = it; });
      } catch (e) { window.__promoDecisions = {}; }
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

    const srcLabel = {
      file: 'состав из файла кабинета WB' + (promoData.fileInfo ? ' («' + U.esc(promoData.fileInfo.fileName || '') + '», ' + U.fmt(promoData.fileInfo.count) + ' строк)' : ''),
      api: 'состав из WB API',
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
        ${promoData.apiError ? UI.badge('API: ' + U.esc(promoData.apiError), 'warn') : ''}
        <span class="hint">К WB за составом не обращаемся: окно строится из загруженного файла и данных ваших товаров.</span>
      </div>
      <div class="alert info">«Сохранить» задаёт товары для управления репрайсером — без отправки цен. Участие по цене означает, что все известные размеры стоят не выше порога из файла во время акции; это не подтверждение состава от WB. Отправка — только в репрайсере или по явно включённому расписанию.</div>
      <div class="grid g5" style="margin-bottom:12px">
        <div class="card stat"><span class="label">Требуемая скидка</span><span class="value">${U.pct(req, 0)}</span><span class="hint">${U.esc(p.joinType || p.type || '')}</span></div>
        <div class="card stat"><span class="label">Кандидатов</span><span class="value">${candidates.length}</span><span class="hint">уже в акции: ${inside.length}</span></div>
        <div class="card stat"><span class="label">Вход безопасен</span><span class="value pos">${okCount.length}</span></div>
        <div class="card stat"><span class="label">Ниже целевой маржи</span><span class="value ${below.length ? 'warnc' : 'pos'}">${below.length}</span></div>
        <div class="card stat"><span class="label">Убыток при входе</span><span class="value ${losses.length ? 'neg' : 'pos'}">${losses.length}</span></div>
      </div>
      <div class="tabs" id="promo-tabs">
        <div class="tab active" data-tab="candidates">Кандидаты на вход (${candidates.length})</div>
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
      <div id="promo-grid"></div>
    `;

    let tab = 'candidates';
    const draw = () => {
      const q = (body.querySelector('#promo-q').value || '').toLowerCase();
      let list = tab === 'inside' ? inside
        : tab === 'risky' ? losses
        : tab === 'safe' ? candidates.filter((c) => c.verdict !== 'loss')
        : candidates;
      if (q) list = list.filter((c) => String(c.nmID).includes(q) || String(c.vendorCode).toLowerCase().includes(q) || String(c.title).toLowerCase().includes(q));

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
        rows: list.slice(0, 500),
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

      gridHost.querySelectorAll('[data-exit]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); Views.promos.exitOne(p, Number(b.dataset.exit), body, draw); };
      });
      gridHost.querySelectorAll('[data-joinone]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          st.promoSelection = new Set([Number(b.dataset.joinone)]);
          body.querySelector('#promo-selinfo').textContent = 'Выбрано: 1';
          Views.promos.joinSelected(p);
        };
      });
    };

    body.querySelectorAll('#promo-tabs .tab').forEach((t) => {
      t.onclick = () => {
        body.querySelectorAll('#promo-tabs .tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        tab = t.dataset.tab;
        draw();
      };
    });
    body.querySelector('#promo-q').oninput = U.debounce(draw, 200);
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

  /**
   * Выход из акции. API Wildberries не даёт исключить товар из акции,
   * поэтому единственный рабочий путь — поднять цену со скидкой выше плановой:
   * товар перестаёт соответствовать условиям и WB выводит его сам.
   * Приложение запоминает прежнюю цену и возвращает её после выхода.
   */
  async exitOne(p, nmID, body, redraw) {
    const rows = S.getRows();
    const r = rows.find((x) => Number(x.nmID) === Number(nmID));
    const cur = r ? r.sellerPrice : 0;
    const planPrice = U.num(p.planPrice) || U.num(p.price) || 0;
    const buffer = 2; // % запаса выше плановой цены
    const raiseTo = planPrice ? Math.ceil(planPrice * (1 + buffer / 100)) + 1 : Math.ceil(cur * 1.05);

    UI.confirmDialog(
      `Выйти из акции «${p.name}»`,
      `<div class="alert warn">
         WB <b>не даёт</b> исключить товар из акции через API — ни из обычной, ни из автоакции.
         Единственный программный способ: <b>поднять цену выше плановой цены акции</b>,
         тогда товар перестаёт соответствовать условиям и WB выводит его сам.
       </div>
       ${UI.kv([
         ['Товар', `${nmID}${r ? ' · ' + U.esc(r.vendorCode) : ''}`],
         ['Цена сейчас', U.money(cur)],
         ['Плановая цена акции', planPrice ? U.money(planPrice) : 'не известна'],
         ['Поднимем до', `<b>${U.money(raiseTo)}</b> (+${buffer}% к плановой)`]
       ])}
       <p class="hint" style="margin-top:10px">Приложение сохранит текущую цену (${U.money(cur)}) и вернёт её,
       как только товар фактически выйдет из акции — раздел «Репрайсер → Акции → Очередь возврата цен».</p>
       <p class="hint">Повышение цены не рискует карантином WB: карантин срабатывает только при резком <b>снижении</b>.</p>`,
      async () => {
        try {
          const res = await API.invoke('repricer:promo-exit', {
            items: [{ nmID: Number(nmID), promoId: p.id, promoName: p.name, raiseTo, restoreSellerPrice: cur }]
          });
          App.toast(res.exited ? `Цена поднята до ${U.money(raiseTo)} — ждём выхода из акции` : 'Изменений не отправлено', res.exited ? 'ok' : 'warn', 6000);
          window.__promoDecisions = null;
          await S.loadGoods(true);
          S.invalidate();
          st.promos = [];
          if (redraw) redraw();
        } catch (e) {
          App.toast(e.message, 'err', 6000);
        }
      },
      `Поднять цену до ${U.money(raiseTo)}`,
      'btn-danger'
    );
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
    const rows = (this.promoRows.candidates || []).map((c) => ({
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
