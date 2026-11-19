'use strict';

/** Рабочее место v4: общие редакторы, компактные блоки и памятные черновики с явным сохранением. */
(function () {
  const rp = Views.repricer;
  const moscowDay = () => new Date(Date.now() + 10800000).toISOString().slice(0, 10);
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const merged = { myPrice: 'priceNow', buyerNow: 'priceNow', value: 'priceNow', buyerNext: 'priceNext', delta: 'priceNext', strategy: 'priceNext', status: 'priceNext', why: 'priceNext', sizes: 'info', cost: 'info', costDetail: 'priceNext', profit: 'priceNext', margin: 'priceNext', profitMonth: 'priceNext' };
  rp.COLUMNS.forEach((c) => { if (merged[c.id]) { c.mergedInto = merged[c.id]; c.always = false; } });
  rp.COLUMNS.push({ id: 'other', title: 'Прочие расходы', group: 'other' }, { id: 'abc', title: 'ABC анализ', group: 'abc' });
  rp.GROUP_TITLES.other = 'Прочие расходы'; rp.GROUP_TITLES.abc = 'ABC анализ';
  rp.GROUP_ORDER = ['article', 'info', 'now', 'next', 'minpromo', 'outpromo', 'other', 'abc', 'comp', 'cost'];
  rp.DEFAULT_COLUMNS = ['item', 'info', 'priceNow', 'priceNext', 'floor', 'promoMin', 'promos', 'restore', 'other', 'abc', 'competitor', 'offset'];
  rp.COMPACT_COLUMNS = ['item', 'info', 'priceNow', 'priceNext', 'floor', 'other', 'abc'];
  const oldVisible = rp.visibleCols;
  rp.visibleCols = function () { const set = oldVisible.call(this); if (!localStorage.getItem('wb.repricer.v4.' + API.activeProfileId())) { set.add('other'); set.add('abc'); this.saveVisibleCols(set); localStorage.setItem('wb.repricer.v4.' + API.activeProfileId(), '1'); } return set; };

  const originalDraw = rp.draw;
  rp.draw = async function () {
    const moved = { promos: ['promos', 'plan'], 'promo-analytics': ['promos', 'analytics'], 'journal-promos': ['promos', 'journal'], schedule: ['settings', 'schedule'], params: ['settings', 'params'] }[this.tab];
    if (moved && this === rp) return App.go(moved[0], { tab: moved[1] });
    return originalDraw.call(this);
  };
  rp.calculate = async function (options) {
    const revision = S.state.goodsRevision, epoch = API.generation();
    const result = await API.invoke('repricer:calc', options || { full: true });
    if (epoch !== API.generation() || revision !== S.state.goodsRevision) throw new Error('Товары обновились во время расчёта. Выполните новый пересчёт.');
    return result;
  };
  const loadState = rp.loadState;
  rp.loadState = async function () {
    const identity = [API.activeProfileId(), S.state.dataContext, S.state.demo, S.state.goodsRevision].join('|');
    if (this._dataIdentity && this._dataIdentity !== identity) { this.results = []; this.summary = null; this.selection = new Set(); }
    this._dataIdentity = identity;
    const result = await loadState.call(this);
    return result;
  };
  const oldErrors = rp.rowErrors;
  rp.rowErrors = function (row) { return [...new Set(oldErrors.call(this, row).concat((row.issues || []).filter((i) => i.level === 'critical').map((i) => i.message)))]; };
  const kv = (pairs) => '<div class="rp-price-matrix">' + pairs.map(([label, value]) => `<div class="rp-metric"><span>${U.esc(label)}</span><b>${value}</b></div>`).join('') + '</div>';
  rp.strategyControl = function (r) {
    const cfg = this.rowConfig(r.nmID), selected = cfg.strategy || '';
    return `<div class="rp-strategy-control"><select class="rp-strategy" data-nm="${r.nmID}" title="${U.esc(((this.rstate.strategies || []).find((s) => s.id === selected) || {}).hint || 'Общая стратегия кабинета')}" aria-label="Стратегия товара ${r.nmID}"><option value="">Общая стратегия</option>${(this.rstate.strategies || []).map((s) => `<option value="${s.id}" ${selected === s.id ? 'selected' : ''}>${U.esc(s.name)}</option>`).join('')}</select><button class="btn btn-xs rp-strategy-gear" data-strategy-edit="${r.nmID}" title="Настройки стратегии" aria-label="Настройки стратегии товара ${r.nmID}">⚙</button></div>`;
  };
  rp.currentPriceBlock = function (r) {
    const c = r.current || {}, w = r.wallet || {}, v = this.valueStatus(r), p = r.promo || {};
    const fact = (S.state.facts || {})[String(r.nmID)] || {};
    return `<div class="rp-price-block"><div class="spread">${UI.badge(v.label, v.kind)}${UI.badge(p.inPromo ? 'Есть наблюдение акции' : 'Участие не подтверждено', p.inPromo ? 'info' : '')}</div>${kv([
      ['Цена до СПП, ₽', U.money(c.sellerPrice)], ['Скидка продавца', U.pct(c.discount)],
      ['Цена с СПП, ₽', U.money(U.num(c.sellerPrice) * (1 - U.num(w.sppPct) / 100))], ['СПП WB', U.pct(w.sppPct)],
      ['С кошельком*, ₽', U.money(w.nowBuyer || c.buyerPrice)], ['Кошелёк* (модель)', U.pct(w.walletPct)],
      ['Текущая маржа', `<span class="${U.profitClass(c.marginPct)}">${U.pct(c.marginPct)}</span>`], ['Прибыль, ₽', `<span class="${U.profitClass(c.profit)}">${U.money(c.profit)}</span>`]
    ])}<div class="tiny muted">База ${U.money(c.basePrice)} ${this.sizePriceNote(r)}</div><div class="tiny rp-spp-source" title="Источник СПП; скидка кошелька задаётся отдельно">${(c.costSources || {}).sppPct === 'official' && fact.sppOfficialAt ? 'СПП из ЛК: ' + U.esc(fact.sppOfficialSource === 'orders' ? 'заказ' : 'продажа') + ' · ' + U.date(fact.sppOfficialAt, true) + ' · не live-витрина' : 'Источник СПП: ' + U.esc(((c.costSources || {}).sppPct || 'настройки'))}</div><div class="tiny muted">*Кошелёк — модель по настройке, не наблюдение WB.</div><div class="rp-draft-summary"><span class="tiny muted">Моя цена · локальный черновик</span><br>${this.myPriceCellHtml(r)}</div></div>`;
  };
  rp.nextPriceBlock = function (r) {
    const d = (S.state.priceDrafts || {})[String(r.nmID)], c = r.current || {}, w = r.wallet || {};
    const errors = this.rowErrors(r);
    const next = d ? { ...r.proposed, basePrice: Number(d.basePrice), discount: Number(d.discount) || 0, sellerPrice: Number(d.sellerPrice) || Number(d.basePrice) * (1 - Number(d.discount || 0) / 100) } : r.proposed || {};
    const raw = (S.state.items || []).find((i) => String(i.nmID) === String(r.nmID)) || {};
    const unit = d ? EC.analyze(S.state.settings, raw, (S.state.overrides || {})[String(r.nmID)] || {}, { basePrice: next.basePrice, discountPct: next.discount }, (S.state.facts || {})[String(r.nmID)]).next : ((r.cost || {}).next || {});
    if (d && unit) { next.profit = unit.profit; next.marginPct = unit.marginPct; }
    return `<div class="rp-price-block">${this.strategyControl(r)}${kv([
      ['Новая до СПП, ₽', U.money(next.sellerPrice)], ['Комиссия, ₽', U.money(unit.commission)],
      ['Новая с СПП, ₽', U.money(U.num(next.sellerPrice) * (1 - U.num(w.sppPct) / 100))], ['Логистика, ₽', U.money(unit.logistics)],
      ['С кошельком* (модель), ₽', U.money(U.num(next.sellerPrice) * (1 - U.num(w.sppPct) / 100) * (1 - U.num(w.walletPct) / 100))], ['Расходы всего, ₽', U.money(unit.totalCosts)],
      ['Новая маржа', `<span class="${U.profitClass(next.marginPct)}">${U.pct(next.marginPct)}</span>`], ['Новая прибыль, ₽', `<span class="${U.profitClass(next.profit)}">${U.money(next.profit)}</span>`]
    ])}<div class="tiny muted">База ${U.money(next.basePrice)} · скидка ${U.pct(next.discount)} · эквайринг ${U.money(unit.acquiring)}${d ? ' · приоритет ручного черновика' : ''}</div>
      <div class="spread tiny"><span>Δ ${U.signed(U.num(next.sellerPrice) - U.num(c.sellerPrice))} ₽</span><button class="btn btn-xs btn-ghost" data-why="${r.nmID}" data-dirty-nm="${r.nmID}">почему</button></div>
      ${r.boost ? `<div class="tiny ${r.boost.blocked ? 'neg' : 'muted'}">${U.esc(r.boost.reason || '')}</div>` : ''}
      ${errors.length ? '<div class="rp-validation neg tiny">Обновление заблокировано: ' + U.esc(errors.join('; ')) + '</div>' : (r.warnings || []).length ? `<div class="tiny warnc" title="${U.esc(r.warnings.join('\n'))}">⚠ ${r.warnings.length} предупреждений</div>` : UI.badge(r.needSend ? 'Предложено, не отправлено' : 'Без изменений')}
    </div>`;
  };
  const oldInfo = rp.itemInfoCellHtml;
  rp.itemInfoCellHtml = function (r) { return oldInfo.call(this, r) + '<div class="tiny">' + this.sizesCellHtml(r) + '</div>'; };
  rp.otherCostsBlock = function (r) {
    const nm = String(r.nmID), saved = (S.state.costs || {})[nm] || {}, pending = (this.pendingEdits.get(nm) || {}).cost || {}, value = { ...saved, ...pending };
    const pct = U.num(value.otherPct), rub = U.num(value.otherRub), price = U.num((r.current || {}).sellerPrice), spp = U.num((r.wallet || {}).sppPct), wallet = U.num((r.wallet || {}).walletPct), sum = price * pct / 100 + rub;
    const ratio = (denom) => denom > 0 ? U.pct(sum / denom * 100, 2) : '—';
    return `<div class="rp-other-costs"><label>От цены до СПП, %<input type="number" class="rp-other-pct num" data-nm="${nm}" min="0" max="99" step="0.01" value="${pct}" aria-label="Прочие расходы процент ${nm}"></label><label>Дополнительно, ₽/шт<input type="number" class="rp-other-rub num" data-nm="${nm}" min="0" step="0.01" value="${rub}" aria-label="Прочие расходы рубли ${nm}"></label><div class="tiny muted">Расход = процент × цена + фиксированная сумма. Оба поля складываются.</div>${kv([['Всего, ₽', U.money(sum)], ['% до СПП', ratio(price)], ['% с СПП', ratio(price * (1 - spp / 100))], ['% с кошельком', ratio(price * (1 - spp / 100) * (1 - wallet / 100))], ['% себестоимости', ratio((r.cost || {}).rub)]])}</div>`;
  };
  rp.abcBlock = function (r) {
    return '<div class="rp-abc" data-source="archive" title="Три буквы: выручка / оценочная прибыль / количество. A — первые 80%, B — до 95%, C — остальные. Равные вклады имеют один класс.">' + [[30, '1 мес · 30д'], [90, '3 мес · 90д'], [180, '6 мес · 180д']].map(([days, label]) => {
      const a = (r.abc || {})[days];
      return `<div><span class="tiny muted">${label}</span><div>${a && a.known ? a.code.split('').map((c) => `<span class="abc-letter abc-${c}">${c}</span>`).join('') : `<span class="muted" title="Нет полного покрытия периода${a ? ': пропущено ' + a.missingDays + ' дней' : ''}">— нет истории</span>`}</div></div>`;
    }).join('') + '<span class="tiny muted">В / П / шт · закрытые дни МСК · прибыль оценочная' + (S.state.demo ? ' · сгенерировано ДЕМО' : '') + '</span></div>';
  };
  rp.invalidLocalInput = function () { return this.container?.isConnected && [...this.container.querySelectorAll('#rp-grid input[data-local-touched]')].find((input) => !input.checkValidity()) || null; };
  const originalRenderResults = rp.renderResults;
  rp.renderResults = function () {
    if (!this.container || !this.container.querySelector('#rp-grid')) return;
    const invalid = this.invalidLocalInput(); if (invalid) { invalid.reportValidity(); App.toast('Исправьте некорректное поле перед перерисовкой таблицы.', 'warn'); return; }
    const scroll = this.container.querySelector('#rp-grid .tablewrap'), left = scroll && scroll.scrollLeft, top = scroll && scroll.scrollTop;
    const active = document.activeElement, focus = active && active.closest('#rp-grid') && active.dataset.nm ? { nm: active.dataset.nm, cls: [...active.classList].find((name) => /^rp-/.test(name)) } : null;
    originalRenderResults.call(this);
    const host = this.container;
    host.querySelectorAll('[data-strategy-edit]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); this.openStrategyEditor(b.dataset.strategyEdit); }; });
    host.querySelectorAll('.rp-other-pct, .rp-other-rub').forEach((i) => { i.onclick = (e) => e.stopPropagation(); i.onchange = () => { if (!i.checkValidity() || i.value === '' || !Number.isFinite(Number(i.value))) { App.toast('Укажите неотрицательные корректные прочие расходы', 'warn'); return; } this.stageEdit(i.dataset.nm, 'cost', { [i.classList.contains('rp-other-pct') ? 'otherPct' : 'otherRub']: Number(i.value) }); }; });
    host.querySelectorAll('.rp-allowsend').forEach((i) => { const row = this.results.find((r) => String(r.nmID) === i.dataset.nm); if (row && row.autoBlocked) { i.checked = false; i.disabled = true; i.title = 'Автоблокировка до устранения критических ошибок и пересчёта'; } });
    const next = host.querySelector('#rp-grid .tablewrap'); if (next && scroll) { next.scrollLeft = left; next.scrollTop = top; }
    if (focus && focus.cls && !document.querySelector('#modal-root .modal')) { const field = host.querySelector('.' + focus.cls + '[data-nm="' + focus.nm + '"]'); if (field) field.focus({ preventScroll: true }); }
    host.querySelectorAll('.rp-minprice, .rp-baseprice, .rp-off-val').forEach((input) => { input.step = '0.01'; });
    host.querySelectorAll('.rp-other-pct, .rp-other-rub, .rp-cost, .rp-tag, .rp-minprice, .rp-baseprice, .rp-plan, .rp-off-val').forEach((input) => { input.oninput = () => { input.dataset.localTouched = '1'; if (input.checkValidity() && input.onchange) input.onchange(); }; });
    this.drawHealthFilter();
  };
  const originalTabPrices = rp.tabPrices;
  rp.tabPrices = async function (host) {
    await originalTabPrices.call(this, host);
    if (!host.isConnected || !host.querySelector('#rp-cols')) return;
    const tools = host.querySelector('#rp-cols').parentElement;
    if (!tools.querySelector('#rp-spp-refresh')) {
      const spp = U.el('<button class="btn btn-sm" id="rp-spp-refresh">СПП из ЛК</button>'); tools.appendChild(spp);
      spp.onclick = async () => { spp.disabled = true; try { const res = await API.invoke('spp:refresh'); await S.loadGoods(false); await S.refreshFacts(); App.toast(res.note, 'ok', 9000); this.draw(); } catch (e) { App.toast(e.message, 'warn', 9000); } finally { spp.disabled = false; } };
      const abc = U.el('<button class="btn btn-sm" id="rp-abc-load">Загрузить ABC · 90д</button>'); tools.appendChild(abc);
      abc.onclick = async () => { abc.disabled = true; try { const res = await API.invoke('analytics:load'); App.toast(res.note, res.ok ? 'ok' : 'warn', 10000); this.results = []; await this.draw(); } catch (e) { App.toast(e.message, 'warn', 9000); } finally { abc.disabled = false; } };
    }
  };
  const oldFiltered = rp.filteredResults;
  rp.filteredResults = function () {
    const rows = oldFiltered.call(this), code = this.itemFilter.issueCode, level = this.itemFilter.issueLevel;
    return rows.filter((r) => (!code || (r.issues || []).some((i) => i.code === code && (!level || i.level === level))) && (!level || code || (r.issues || []).some((i) => i.level === level)));
  };
  rp.drawHealthFilter = function () {
    const old = this.container.querySelector('#rp-health-filter'); if (old) old.remove();
    if (!this.itemFilter.issueCode && !this.itemFilter.issueLevel) return;
    const banner = U.el(`<div class="alert ${this.itemFilter.issueLevel === 'critical' ? 'danger' : 'warn'}" id="rp-health-filter">Фильтр ошибок: ${U.esc(this.itemFilter.issueCode || this.itemFilter.issueLevel)} <button class="btn btn-xs">Снять фильтр</button></div>`);
    banner.querySelector('button').onclick = () => { this.itemFilter.issueCode = ''; this.itemFilter.issueLevel = ''; this.renderResults(); };
    const grid = this.container.querySelector('#rp-grid'); grid.parentElement.insertBefore(banner, grid);
  };

  // Последовательный автосейв: снимок записи удаляется лишь если за время запроса его не меняли.
  rp.stageEdit = function (nmID, kind, patch) {
    const nm = String(nmID);
    if (!['config', 'cost'].includes(kind)) throw new Error('Неподдерживаемая локальная правка');
    LocalDrafts.validateOperations([{ channel: kind === 'config' ? 'repricer:item-configs:save' : 'costs:save', payload: { items: { [nm]: patch } } }]);
    const current = this.pendingEdits.get(nm) || { config: {}, cost: {} };
    this.pendingEdits.set(nm, { config: { ...current.config }, cost: { ...current.cost }, [kind]: { ...current[kind], ...patch } });
    this.markDirtyRows(); this.drawEditBar();
  };
  rp.commitEdits = async function (button, options) {
    if (this._savingEdits) { if (!await this._savingEdits) return false; if (this.pendingEdits.size) return this.commitEdits(button, options); return true; }
    const invalid = this.container && [...this.container.querySelectorAll('#rp-grid input')].find((input) => !input.checkValidity());
    if (invalid) { invalid.reportValidity(); return false; }
    const entries = [...this.pendingEdits.entries()], epoch = API.generation(), context = S.state.dataContext;
    if (!entries.length) return true;
    const task = (async () => {
      if (button) button.disabled = true;
      try {
        const configs = {}, costs = {};
        for (const [nm, rec] of entries) {
          if (Object.keys(rec.config || {}).length) configs[nm] = { ...rec.config };
          if (Object.keys(rec.cost || {}).length) costs[nm] = { ...rec.cost };
        }
        if (Object.keys(costs).length) await S.saveCosts(costs);
        if (epoch !== API.generation() || context !== S.state.dataContext) return false;
        if (Object.keys(configs).length) await API.invoke('repricer:item-configs:save', { items: configs });
        if (epoch !== API.generation() || context !== S.state.dataContext) return false;
        for (const [nm, rec] of entries) if (this.pendingEdits.get(nm) === rec) this.pendingEdits.delete(nm);
        this.rstate = await API.invoke('repricer:state');
        if (!this.pendingEdits.size) {
          const res = await this.calculate({ full: true }); this.results = res.results || []; this.summary = res.summary;
          if (this.container && this.container.isConnected) { this.drawSummary(); this.renderResults(); this.drawTiles(); await this.drawProposal(); }
        }
        this.drawEditBar(); if (!(options && options.quiet)) App.toast('Сохранено локально. В WB ничего не отправлено.', 'ok');
        return true;
      } catch (e) { App.toast('Сохранение не выполнено: ' + e.message + '. Правки остались несохранёнными в памяти.', 'err', 10000); return false; }
      finally { if (button && button.isConnected) button.disabled = false; }
    })();
    this._savingEdits = task;
    try { return await task; } finally { if (this._savingEdits === task) this._savingEdits = null; if (this.pendingEdits.size && !(options && options.noRetry)) this.drawEditBar(); }
  };
  const oldEditBar = rp.drawEditBar;
  rp.drawEditBar = function () { oldEditBar.call(this); const hint = this.container && this.container.querySelector('#rp-editbar .hint'); if (hint) hint.textContent = 'Изменения только в памяти и не применены. Применит их кнопка «Сохранить»; отправка WB — только отдельным действием.'; };
  const oldDiscard = rp.discardEdits;
  rp.discardEdits = function () { return oldDiscard.call(this); };

  async function mountRPPane(host, tab, redraw) {
    const epoch = API.generation(), controller = Object.create(rp);
    Object.assign(controller, { container: host, tab, results: [], pendingEdits: new Map(), itemFilter: { ...rp.itemFilter }, draw: redraw });
    host.innerHTML = UI.loading('Загружаем раздел…');
    try {
      await controller.loadState(); if (!host.isConnected || epoch !== API.generation()) return;
      if (tab === 'plan') await controller.tabPromos(host, () => host.isConnected && epoch === API.generation() && Views.promos.tab === 'plan');
      else if (tab === 'analytics') await controller.tabPromoAnalytics(host);
      else if (tab === 'journal') await controller.tabJournal(host, 'promos');
      else if (tab === 'schedule') await controller.tabSchedule(host);
      else await controller.tabParams(host);
    } catch (e) { if (host.isConnected) host.innerHTML = '<div class="alert danger">' + U.esc(e.message) + '</div>'; }
  }
  const promosMount = Views.promos.mount;
  Views.promos.tab = 'calendar';
  Views.promos.render = function (container) { this.rootContainer = container; this.drawShell(); };
  Views.promos.drawShell = function () {
    const root = this.rootContainer; if (!root || !root.isConnected) return;
    root.innerHTML = `<div class="tabs workspace-tabs">${[['calendar', 'Календарь и товары'], ['plan', 'Решения и выход из акций'], ['analytics', 'Аналитика акций'], ['journal', 'Журнал участия']].map(([id, label]) => `<button class="tab ${this.tab === id ? 'active' : ''}" data-promo-tab="${id}">${label}</button>`).join('')}</div><div id="promo-section-host"></div>`;
    root.querySelectorAll('[data-promo-tab]').forEach((b) => { b.onclick = () => { this.tab = b.dataset.promoTab; this.drawShell(); }; });
    const host = root.querySelector('#promo-section-host');
    if (this.tab === 'calendar') promosMount.call(this, host);
    else mountRPPane(host, this.tab, () => this.drawShell());
  };
  const settingsDraw = Views.settings.draw;
  Views.settings.tab = 'general';
  Views.settings.render = function (container) { this.container = container; this.draw(); };
  Views.settings.draw = function () {
    const root = this.container; if (!root || !root.isConnected) return;
    root.innerHTML = `<div class="tabs workspace-tabs">${[['general', 'Подключение и общие'], ['schedule', 'Расписание РП'], ['params', 'Параметры РП']].map(([id, label]) => `<button class="tab ${this.tab === id ? 'active' : ''}" data-settings-tab="${id}">${label}</button>`).join('')}</div><div id="settings-section-host"></div>`;
    root.querySelectorAll('[data-settings-tab]').forEach((b) => { b.onclick = () => { this.tab = b.dataset.settingsTab; this.draw(); }; });
    const host = root.querySelector('#settings-section-host');
    if (this.tab === 'general') { const controller = Object.create(this); controller.container = host; controller.draw = () => this.draw(); return settingsDraw.call(controller); }
    return mountRPPane(host, this.tab, () => this.draw());
  };

  const fields = [
    ['targetMarginPct', 'Целевая маржа, %', -100, 99, 20], ['minMarginPct', 'Минимальная маржа, %', -100, 99, 0],
    ['planSensitivityPct', 'Чувствительность план-факт, %', 0, 30, 8], ['targetTurnoverDays', 'Целевая оборачиваемость, дней', 1, 365, 7],
    ['competitorOffsetPct', 'Отстройка от конкурента, %', -90, 500, 0], ['elasticityPct', 'Модельная эластичность AI, %', 0, 100, 12]
  ];
  const strategyFields = (s) => fields.filter(([id]) => ['targetMarginPct', 'minMarginPct'].includes(id) || s === 'planfact' && id === 'planSensitivityPct' || s === 'turnover' && id === 'targetTurnoverDays' || s === 'competitor' && id === 'competitorOffsetPct' || s === 'ai' && id === 'elasticityPct');
  function fieldsHtml(strategy, values) { return strategyFields(strategy).map(([id, label, min, max, def]) => `<label class="field">${label}<input type="number" data-strategy-field="${id}" min="${min}" max="${max}" step="0.1" value="${values[id] === undefined || values[id] === null ? def : values[id]}" required></label>`).join(''); }
  rp.openStrategyEditor = async function (nmID, strategyId, optionsBefore) {
    if (this._strategyEditorOpen) return;
    const config = this.rowConfig(nmID), strategy = strategyId || config.strategy || this.rstate.config.defaults.strategy, entry = (this.rstate.strategies || []).find((s) => s.id === strategy);
    if (!entry) return;
    this._strategyEditorOpen = true;
    const effective = RP.itemConfig(this.rstate.config.defaults, config, this.rstate.config.strategyTemplates), epoch = API.generation();
    const savedConfig = (this.rstate.itemConfigs || {})[String(nmID)] || {};
    const baselineEffective = RP.itemConfig(this.rstate.config.defaults, savedConfig, this.rstate.config.strategyTemplates);
    let options;
    if (strategy === 'boost') {
      try { options = await API.invoke('repricer:boost-options', { nmID }); }
      catch (e) { this._strategyEditorOpen = false; App.toast(e.message, 'err'); return; }
    }
    if (epoch !== API.generation()) { this._strategyEditorOpen = false; return; }
    const boost = config.boost || {}, selected = new Map((boost.steps || []).map((s) => [String(s.promoId), s]));
    const body = U.el(`<div><div class="alert info">${U.esc(entry.hint)}<br><b>Ввод только записывается в память. Кнопка «Сохранить и закрыть» применяет локально; крестик/Escape — без сохранения. В WB ничего не отправляется.</b></div>
      <div id="strategy-edit-error" aria-live="polite"></div>
      ${strategy === 'boost' ? `<div class="grid g2"><label class="field">Начало (МСК)<input id="boost-start" type="date" value="${boost.startDate || options.day || moscowDay()}" required></label><label class="field">Срок работы, дней<input id="boost-days" type="number" min="1" max="365" value="${boost.durationDays || 7}" required></label></div><label class="checkline"><input type="checkbox" id="boost-restart"> Явно перезапустить лесенку (сбросить текущий дневной счётчик)</label>
      <p class="hint">Ежедневный сброс в 00:00 МСК. Считаем заказы без известных отмен. Движение — от дешёвой ступени к дорогой; список ниже показан по убыванию цены. После последней — цена выше выбранных порогов до следующего дня. Срок включает день начала.</p>
      <div class="alert warn">WB отдаёт заказы с задержкой: лимит не гарантирует ровно N продаж. Цена может подходить сразу нескольким акциям. Отображаем расчётную маржу и отдельно задаём её допустимый минимум.</div>
      <div class="tablewrap boost-step-list"><table class="grid-table"><thead><tr><th>Включить / акция</th><th>Порог, ₽</th><th>Расчётная маржа / прибыль</th><th>Заказов в сутки</th><th>Минимальная маржа, %</th></tr></thead><tbody>${(options.promos || []).map((p) => { const row = selected.get(String(p.id)); return `<tr data-boost-promo="${p.id}"><td><label class="checkline"><input type="checkbox" class="boost-use" ${row ? 'checked' : ''}>${U.esc(p.name)}</label><div class="tiny muted">${U.date(p.startDateTime)} — ${U.date(p.endDateTime)}</div></td><td>${U.money(p.planPrice)}</td><td>${U.pct(p.economy.marginPct)} / ${U.money(p.economy.profit)}</td><td><input type="number" class="boost-quota" min="1" max="100000" step="1" value="${row ? row.quota : 2}" aria-label="Дневная квота ${p.id}"></td><td><input type="number" class="boost-margin" min="-100" max="99" step="0.1" value="${row ? row.minMarginPct : effective.minMarginPct || 0}" aria-label="Минимальная маржа ${p.id}"></td></tr>`; }).join('') || '<tr><td colspan="5">Нет проверенных точных цен. Сначала загрузите свой файл товаров нужных акций в «Акции WB».</td></tr>'}</tbody></table></div>` : `<div class="strategy-pipeline"><div>① Источник: ${U.esc(entry.name)}</div><span>→</span><div>② Маржа и коридор</div><span>→</span><div>③ Защитные лимиты</div><span>→</span><div>④ Предложение, не отправка</div></div><div class="grid g2">${fieldsHtml(strategy, effective)}</div>`}
      <p class="hint">Глобальные шаблоны и возврат к базовым настройкам — в отдельном разделе «Стратегии». При критической ошибке отправка этого товара автоматически блокируется.</p></div>`);
    let discard = false, saved = false;
    // Снимок ДО назначения стратегии: отмена убирает и сам выбор из строки.
    const previous = optionsBefore && Object.prototype.hasOwnProperty.call(optionsBefore, 'previousPending')
      ? optionsBefore.previousPending : this.pendingEdits.get(String(nmID));
    const previousPending = previous ? copy(previous) : null;
    const collectStrategy = () => {
        const invalid = [...body.querySelectorAll('input')].find((i) => !i.checkValidity());
        if (invalid) { invalid.reportValidity(); return false; }
        const patch = { strategy: strategyId ? strategy : config.strategy || null };
        if (strategy === 'boost') {
          const steps = [...body.querySelectorAll('[data-boost-promo]')].filter((tr) => tr.querySelector('.boost-use').checked).map((tr) => ({ promoId: tr.dataset.boostPromo, quota: Number(tr.querySelector('.boost-quota').value), minMarginPct: Number(tr.querySelector('.boost-margin').value) }));
          if (!steps.length) { body.querySelector('#strategy-edit-error').innerHTML = '<div class="alert danger">Выберите хотя бы одну проверенную акцию или отмените выбор стратегии.</div>'; return false; }
          patch.restartBoost = body.querySelector('#boost-restart').checked;
          patch.boost = { startDate: body.querySelector('#boost-start').value, durationDays: Number(body.querySelector('#boost-days').value), steps };
        } else body.querySelectorAll('[data-strategy-field]').forEach((i) => {
          const key = i.dataset.strategyField, value = Number(i.value);
          // Возврат к исходному числу должен отменить более ранний ввод в этом
          // же окне, а не оставить старый pending patch. Не фиксируем наследуемый шаблон.
          patch[key] = value !== Number(baselineEffective[key]) ? value : Object.prototype.hasOwnProperty.call(savedConfig, key) ? savedConfig[key] : null;
        });
        return patch;
    };
    this._strategyCapture = () => { const patch = collectStrategy(); if (!patch) return false; this.stageEdit(nmID, 'config', patch); return true; };
    body.addEventListener('input', () => { this._strategyEditorDirty = true; this._strategyCapture(); });
    body.addEventListener('change', () => { this._strategyEditorDirty = true; this._strategyCapture(); });
    const modal = UI.modal({ title: entry.name + ' · товар ' + nmID, size: 'lg', content: body,
      beforeClose: async () => {
        if (discard || saved || epoch !== API.generation()) return true;
        if (!this._strategyCapture()) return false;
        App.toast('Изменения стратегии остались несохранёнными в памяти. Нажмите «Сохранить» в панели изменений, чтобы применить.', 'warn', 7000);
        return true;
      },
      onClose: () => { this._strategyEditorOpen = false; this._strategyEditorDirty = false; this._strategyCapture = null; },
      buttons: [{ label: 'Вернуть базовые параметры', class: 'btn-ghost', keepOpen: true, onClick: () => { this._strategyEditorDirty = true; body.querySelectorAll('[data-strategy-field]').forEach((i) => { i.value = RP.DEFAULT_CONFIG.defaults[i.dataset.strategyField]; }); if (strategy === 'boost') { body.querySelector('#boost-days').value = 7; body.querySelectorAll('.boost-quota').forEach((i) => i.value = 2); body.querySelectorAll('.boost-margin').forEach((i) => i.value = Math.max(0, Number(effective.minMarginPct) || 0)); } this._strategyCapture(); } }, { label: 'Отменить изменения', class: 'btn-ghost', keepOpen: true, onClick: async () => { discard = true; if (previousPending) this.pendingEdits.set(String(nmID), copy(previousPending)); else this.pendingEdits.delete(String(nmID)); await modal.close(); this.renderResults(); this.drawEditBar(); } }, { label: 'Сохранить и закрыть', class: 'btn-primary', keepOpen: true, onClick: async () => { if (!this._strategyCapture()) return false; saved = true; if (!await this.commitEdits(null, { quiet: true, noRetry: true })) { saved = false; return false; } await modal.close(); } }] });
  };

  Views.strategies = {
    title: 'Стратегии', subtitle: 'Механика и параметры базовых шаблонов. Защитные ограничения остаются обязательными.',
    async render(container) {
      this.container = container; container.innerHTML = UI.loading(); const epoch = API.generation();
      try {
        const state = await API.invoke('repricer:state'); if (epoch !== API.generation() || !container.isConnected) return;
        container.innerHTML = `<div class="alert info">Шаблон задаёт значения для товаров без личного переопределения. Изменения не отправляют цены. «Лесенка буста» настраивается отдельно у каждого товара кнопкой ⚙; её квоты ежедневно сбрасываются в 00:00 МСК.</div><div class="strategy-library">${state.strategies.map((s) => `<section class="card strategy-template" data-template="${s.id}"><div class="spread"><h2>${U.esc(s.name)}</h2>${UI.badge((state.config.strategyTemplates || {})[s.id] ? 'Изменён' : 'Базовый', (state.config.strategyTemplates || {})[s.id] ? 'warn' : '')}</div><p>${U.esc(s.hint)}</p><div class="strategy-pipeline"><span>Источник</span><b>→</b><span>Маржа / коридор</span><b>→</b><span>Лимиты / контроль</span></div><div class="grid g2">${fieldsHtml(s.id, { ...state.defaults, ...(state.config.strategyTemplates || {})[s.id] })}</div><div class="row wrap"><button class="btn btn-primary btn-sm" data-template-save>Сохранить шаблон</button><button class="btn btn-ghost btn-sm" data-template-reset>Вернуть базовый</button></div></section>`).join('')}</div>`;
        container.querySelectorAll('[data-template]').forEach((card) => {
          const save = async (reset) => { if (!reset && [...card.querySelectorAll('input')].some((i) => !i.reportValidity())) return; const values = {}; card.querySelectorAll('[data-strategy-field]').forEach((i) => { values[i.dataset.strategyField] = Number(i.value); }); try { await API.invoke('strategies:template', { strategy: card.dataset.template, values: reset ? null : values }); rp.results = []; App.toast(reset ? 'Базовые настройки восстановлены' : 'Шаблон сохранён, требуется новый пересчёт', 'ok'); this.render(container); } catch (e) { App.toast(e.message, 'err'); } };
          card.querySelector('[data-template-save]').onclick = () => save(false); card.querySelector('[data-template-reset]').onclick = () => save(true);
        });
      } catch (e) { if (container.isConnected) container.innerHTML = '<div class="alert danger">' + U.esc(e.message) + '</div>'; }
    }
  };

  const dashRender = Views.dashboard.render;
  Views.dashboard.render = function (container) {
    dashRender.call(this, container); const epoch = API.generation();
    const card = U.el('<section class="card health-center" style="margin:14px 0"><h2>Ошибки и предупреждения РП</h2><div class="health-content">Проверяем товары…</div></section>'); container.prepend(card);
    API.invoke('repricer:health').then((result) => {
      if (!card.isConnected || epoch !== API.generation()) return;
      const groups = new Map(); (result.issues || []).forEach((i) => { const key = i.level + ':' + i.code; if (!groups.has(key)) groups.set(key, { ...i, nms: new Set() }); groups.get(key).nms.add(i.nmID); });
      card.querySelector('.health-content').innerHTML = `<div class="row wrap"><button class="btn btn-danger" data-health-level="critical">Критические: ${result.critical} · заблокировано товаров ${result.blockedItems}</button><button class="btn btn-sm" data-health-level="warning">Предупреждения: ${result.warning}</button></div><p class="hint">Критические ошибки автоматически запрещают обновление цены только проблемного товара. Остальные товары продолжают работать. После исправления выполните пересчёт.</p><div class="health-issues">${[...groups.values()].map((i) => `<button class="health-issue ${i.level}" data-issue="${U.esc(i.code)}" data-level="${i.level}"><span>${i.level === 'critical' ? '●' : '▲'} ${U.esc(i.message)}</span><b>${i.nms.size} →</b></button>`).join('') || '<div class="alert ok">В проверенных товарах ошибок не обнаружено.</div>'}</div>`;
      const open = (code, level) => { rp.itemFilter = { q: '', strategy: '', seg: 'all', tile: '', issueCode: code || '', issueLevel: level }; rp.page = 0; App.go('repricer'); };
      card.querySelectorAll('[data-health-level]').forEach((b) => { b.onclick = () => open('', b.dataset.healthLevel); }); card.querySelectorAll('[data-issue]').forEach((b) => { b.onclick = () => open(b.dataset.issue, b.dataset.level); });
    }).catch((e) => { if (card.isConnected) card.querySelector('.health-content').innerHTML = '<div class="alert warn">Проверка пока недоступна: ' + U.esc(e.message) + '. Не означает отсутствие ошибок.</div>'; });
  };

  // Дополнительные поля выгрузки, включая расчётный источник ABC, не только нарисованные значки.
  const exportSpec = rp.exportSpec;
  rp.exportSpec = function () { return exportSpec.call(this).concat([
    ['Прочие расходы', 'Процент до СПП', (r) => U.num(((S.state.costs || {})[String(r.nmID)] || {}).otherPct)],
    ['Прочие расходы', 'Фиксировано, ₽', (r) => U.num(((S.state.costs || {})[String(r.nmID)] || {}).otherRub)],
    ['Прочие расходы', 'Новая сумма, ₽', (r) => ((r.cost || {}).next || {}).other || 0],
    ...[30, 90, 180].map((d) => ['ABC анализ', d + ' дней (выручка/оценка прибыли/количество)', (r) => (r.abc || {})[d] && r.abc[d].known ? r.abc[d].code : 'нет полного покрытия']),
    ['Безопасность', 'Автоблокировка', (r) => r.autoBlocked ? 'да' : 'нет'], ['Безопасность', 'Причины', (r) => (r.issues || []).map((i) => i.message).join('; ')]
  ]); };
})();
