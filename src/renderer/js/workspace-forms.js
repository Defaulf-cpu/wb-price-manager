'use strict';

/** Существующие формы репрайсера используют одну локальную очередь вместо обязательной кнопки Save. */
(function () {
  const rp = Views.repricer;
  function values(host, mapping) {
    const result = {};
    for (const [id, path] of Object.entries(mapping)) {
      const input = host.querySelector('#' + id); if (!input) continue;
      let value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.value === '' ? null : Number(input.value) : input.value;
      const keys = path.split('.'); let object = result;
      keys.slice(0, -1).forEach((key) => { object = object[key] || (object[key] = {}); });
      object[keys[keys.length - 1]] = value;
    }
    return result;
  }
  function confirmAutomation(host, id, paths) {
    const previous = new Map(Object.keys(paths).map((key) => [key, !!host.querySelector('#' + key)?.checked]));
    host.addEventListener('change', (event) => {
      const input = event.target; if (!previous.has(input.id)) return;
      const before = previous.get(input.id), next = input.checked;
      if (!before && next && !input._automationConfirmed) {
        event.stopImmediatePropagation(); input.checked = before;
        UI.confirmDialog('Включить автоматическое действие', '<div class="alert warn">Эта настройка разрешает автоматическую работу. При включённой автоотправке цены могут уходить в WB по расписанию. Черновик в памяти не включает её без вашего согласия и нажатия «Сохранить».</div>', () => { LocalDrafts.authorize(id, [paths[input.id]]); input._automationConfirmed = true; input.checked = next; input.dispatchEvent(new Event('change', { bubbles: true })); }, 'Включить осознанно');
      } else { previous.set(input.id, next); input._automationConfirmed = false; }
    }, true);
  }
  function form(host, id, collect, buttonId, selector, after) {
    const binding = LocalDrafts.bind(host, id, collect, selector || 'input:not([id="pm-rate-code"]), select, textarea', after);
    const button = buttonId ? host.querySelector('#' + buttonId) : null;
    if (button) button.onclick = async () => { binding.dirty = true; await LocalDrafts.commit({ scope: host, report: true }); };
    return binding;
  }
  const params = rp.tabParams;
  rp.tabParams = async function (host) {
    await params.call(this, host); if (!host.isConnected || !host.querySelector('#pm-save')) return;
    const controller = this;
    const mapping = {
      'pm-marginmode': 'marginMode', 'pm-sizemode': 'sizePriceMode', 'pm-baseprice': 'priceEdit.canChangeBasePrice', 'pm-canceldisc': 'priceEdit.canCancelDiscount', 'pm-wallet': 'priceEdit.walletPct', 'pm-discstep': 'priceEdit.targetDiscountStep',
      'pm-step': 'limits.maxChangePerUpdatePct', 'pm-day': 'limits.maxChangePerDayPct', 'pm-ignorestep': 'limits.ignoreStepIfBelowMin', 'pm-quarantine': 'limits.blockQuarantine',
      'pm-promospp': 'promo.useForecastSpp', 'pm-promolimit': 'promo.ignoreChangeLimitOnEntry', 'pm-autoexit': 'promo.autoExitAutoPromos', 'pm-autoexit-manual': 'promo.autoExitManualPromos', 'pm-autojoin': 'promo.autoJoin', 'pm-restore': 'promo.restorePriceAfterExit', 'pm-holdauto': 'promo.restoreAfterAutoPromoEnds', 'pm-exitbuffer': 'promo.exitBufferPct', 'pm-joinlead': 'promo.joinLeadDays', 'pm-uplift': 'promo.expectedSalesUpliftPct', 'pm-promomargin': 'promo.minMarginInPromoPct',
      'pm-defstrategy': 'defaults.strategy', 'pm-defmargin': 'defaults.targetMarginPct', 'pm-defminmargin': 'defaults.minMarginPct', 'pm-defturn': 'defaults.targetTurnoverDays', 'pm-defuplift': 'defaults.promoUpliftPct', 'pm-defliq': 'defaults.liquidationTurnoverDays', 'pm-defoos': 'defaults.oosProtection', 'pm-defneg': 'defaults.allowNegativeMargin', 'pm-defbp': 'defaults.beautifulPrice.enabled', 'pm-defbpend': 'defaults.beautifulPrice.ending', 'pm-defbpmode': 'defaults.beautifulPrice.mode'
    };
    Object.keys(mapping).forEach((id) => { const input = host.querySelector('#' + id); if (input?.type === 'number' && id !== 'pm-promomargin') { input.required = true; input.step = id === 'pm-defturn' || id === 'pm-defliq' ? '1' : '0.01'; } });
    confirmAutomation(host, 'repricer-params', { 'pm-autojoin': 'promo.autoJoin', 'pm-autoexit': 'promo.autoExitAutoPromos', 'pm-autoexit-manual': 'promo.autoExitManualPromos', 'pm-restore': 'promo.restorePriceAfterExit', 'pm-holdauto': 'promo.restoreAfterAutoPromoEnds' });
    form(host, 'repricer-params', () => {
      const patch = values(host, mapping); patch.limits.discountStepPct = patch.priceEdit.targetDiscountStep;
      const costRates = {}; host.querySelectorAll('[data-rate]').forEach((input) => { if (input.value !== '' && Number(input.value) > 0) costRates[input.dataset.rate] = Number(input.value); });
      const settings = { costRates, shopName: host.querySelector('#pm-shopname').value.trim(), ...TaxUI.read('pm', host) };
      return [{ channel: 'settings:save', payload: settings }, { channel: 'repricer:save', payload: patch }];
    }, 'pm-save');
    const reset = host.querySelector('#pm-reset');
    reset.onclick = () => UI.confirmDialog('Вернуть безопасные базовые параметры', '<div class="alert warn">Общие параметры будут сброшены к базовым. Планировщик и автоотправка будут выключены. Личные настройки товаров, ключи и выбранный налоговый режим не меняются.</div>', async () => {
      if (LocalDrafts.hasWork()) { App.toast('Есть несохранённые изменения: сначала нажмите «Сохранить» или отмените их. Сброс не сохраняет черновик.', 'warn'); return false; }
      await API.invoke('repricer:save', RP.DEFAULT_CONFIG); controller.rstate = await API.invoke('repricer:state'); controller.draw();
    }, 'Вернуть базовые');
  };
  const schedule = rp.tabSchedule;
  rp.tabSchedule = async function (host) {
    await schedule.call(this, host); if (!host.isConnected || !host.querySelector('#ps-save')) return;
    confirmAutomation(host, 'repricer-schedule', { 'ps-enabled': 'enabled', 'ps-autosend': 'schedule.autoSend' });
    const mapping = { 'ps-enabled': 'enabled', 'ps-mode': 'schedule.mode', 'ps-interval': 'schedule.intervalMinutes', 'ps-hour': 'schedule.hourOfDay', 'ps-twophase': 'schedule.twoPhase', 'ps-autosend': 'schedule.autoSend', 'ps-senddelay': 'schedule.sendDelayMinutes' };
    host.querySelectorAll('input[type="number"]').forEach((input) => input.required = true);
    form(host, 'repricer-schedule', () => [{ channel: 'repricer:save', payload: values(host, mapping) }], 'ps-save');
  };
  const prices = rp.tabPrices;
  rp.tabPrices = async function (host) {
    await prices.call(this, host); if (!host.isConnected || !host.querySelector('#rp-schedule')) return;
    const selector = '#rp-schedule, #rp-interval';
    form(host, 'repricer-quick-schedule', () => [{ channel: 'repricer:save', payload: { schedule: { mode: host.querySelector('#rp-schedule').value, intervalMinutes: Number(host.querySelector('#rp-interval').value) } } }], '', selector);
    const enabled = host.querySelector('#rp-enabled');
    if (enabled) {
      const original = enabled.onchange;
      enabled.onchange = async (event) => {
        if (enabled.checked) { enabled.checked = false; UI.confirmDialog('Включить планировщик', '<div class="alert warn">Планировщик начнёт расчёты по расписанию. Если ранее была включена автоотправка, сохранённые предложения могут отправляться в WB автоматически.</div>', async () => { enabled.checked = true; await original(event); }, 'Включить'); }
        else await original(event);
      };
    }
  };
  // Шаблоны сохраняются после ввода. Сброс — отдельное явное действие.
  const library = Views.strategies.render;
  Views.strategies.render = async function (container) {
    await library.call(this, container); if (!container.isConnected) return;
    container.querySelectorAll('[data-template]').forEach((card) => {
      const id = card.dataset.template, collect = () => {
        const value = {}; card.querySelectorAll('[data-strategy-field]').forEach((input) => value[input.dataset.strategyField] = Number(input.value));
        return [{ channel: 'strategies:template', payload: { strategy: id, values: value } }];
      };
      const binding = LocalDrafts.bind(card, 'strategy-template-' + id, collect, '[data-strategy-field]');
      card.querySelector('[data-template-save]').onclick = async () => { binding.dirty = true; await LocalDrafts.commit({ scope: card, report: true }); };
      card.querySelector('[data-template-reset]').onclick = async () => {
        LocalDrafts.discard('strategy-template-' + id);
        await API.invoke('strategies:template', { strategy: id, values: null }); rp.results = []; await this.render(container);
      };
    });
  };
  // Карточка товара находится и внутри РП. Её цена остаётся локальным черновиком.
  const cardEcon = Views.itemcard.tabEcon;
  Views.itemcard.tabEcon = function (host) {
    cardEcon.call(this, host);
    if (!host.querySelector('#ic-base')) return;
    const nmID = this.nmID, drop = host.querySelector('#ic-drop');
    if (drop) { const original = drop.onclick; drop.onclick = async () => { LocalDrafts.discard('card-price-' + nmID); await original(); }; }
    host.querySelector('#ic-base').required = true; host.querySelector('#ic-base').min = '1'; host.querySelector('#ic-base').step = '1';
    const discount = host.querySelector('#ic-disc'); discount.min = '0'; discount.max = '95'; discount.step = '1'; discount.required = true;
    form(host, 'card-price-' + nmID, () => [{ channel: 'prices:draft-save', payload: { items: { [String(nmID)]: { basePrice: Number(host.querySelector('#ic-base').value), discount: Number(host.querySelector('#ic-disc').value), note: host.querySelector('#ic-note').value } } } }], 'ic-save', '#ic-base, #ic-disc, #ic-note', () => this.nmID === nmID && this.reloadCard());
  };
  const cardCosts = Views.itemcard.tabCommissions;
  Views.itemcard.tabCommissions = function (host) {
    cardCosts.call(this, host); if (!host.querySelector('#ic-p-save')) return;
    const nmID = this.nmID;
    host.querySelectorAll('[id^="ic-p-"][type="number"]').forEach((input) => { input.min = '0'; input.step = 'any'; if (/Pct$/.test(input.id)) input.max = '100'; });
    form(host, 'card-settings-' + nmID, () => {
      const costs = {}, config = {};
      for (const key of ['costPriceRub', 'packagingRub', 'commissionPct', 'logisticsRub', 'storageRub', 'adPct', 'sppPct', 'stock', 'salesPerDay', 'otherPct', 'otherRub']) { const input = host.querySelector('#ic-p-' + key); costs[key === 'costPriceRub' ? 'costEntered' : key] = !input || input.value === '' ? null : Number(input.value); }
      costs.currency = host.querySelector('#ic-p-currency').value;
      config.strategy = host.querySelector('#ic-p-strategy').value || null;
      for (const key of ['minPrice', 'maxPrice', 'minMarginPct', 'minMarginRub', 'maxMarginPct', 'maxMarginRub']) { const input = host.querySelector('#ic-p-' + key); config[key] = !input || input.value === '' ? null : Number(input.value); }
      return [{ channel: 'costs:save', payload: { items: { [String(nmID)]: costs } } }, { channel: 'repricer:item-configs:save', payload: { items: { [String(nmID)]: config } } }];
    }, 'ic-p-save', '[id^="ic-p-"]', () => this.nmID === nmID && this.reloadCard());
    const originalReset = host.querySelector('#ic-p-reset').onclick;
    host.querySelector('#ic-p-reset').onclick = async () => { LocalDrafts.discard('card-settings-' + nmID); await originalReset(); };
    const applySpp = host.querySelector('#ic-spp-apply').onclick;
    host.querySelector('#ic-spp-apply').onclick = (...args) => { applySpp(...args); host.querySelector('#ic-p-sppPct').dispatchEvent(new Event('input', { bubbles: true })); };
    const strategy = host.querySelector('#ic-p-strategy');
    strategy.addEventListener('change', () => { if (strategy.value === 'boost') App.toast('Стратегия записана только в черновик. Нажмите «Сохранить параметры», затем откройте лесенку кнопкой ⚙ в таблице.', 'warn', 7000); });
  };
})();
