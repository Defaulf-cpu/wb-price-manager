'use strict';

/** Памятные черновики локальных правок. Ввод ничего не записывает и не отправляет: запись происходит только по явному нажатию «Сохранить». Ни отправка WB, ни ключи, ни переключение режима сюда не допускаются. */
window.LocalDrafts = (function () {
  const ALLOWED = new Set(['costs:save', 'repricer:item-configs:save', 'prices:draft-save', 'repricer:competitors:save', 'strategies:template', 'repricer:save', 'settings:save']);
  const COST_FIELDS = new Set(('costPriceRub costEntered currency packagingRub commissionPct logisticsRub storageRub acceptRub adPct adRub sppPct volumeLiters stock salesPerDay taxMode taxRatePct otherPct otherRub note targetMarginPct acquiringPct returnPct').split(' '));
  const ITEM_FIELDS = new Set(('strategy minPrice maxPrice basePrice basePriceTarget targetMarginPct minMarginPct allowNegativeMargin allowSend tag rrp targetDiscountPct planQtyMonth planSensitivityPct targetTurnoverDays oosUpliftPct promoUpliftPct liquidationTurnoverDays liquidationDiscountPct elasticityPct oosProtection beautifulPrice competitorMode competitorId competitorOffsetMode competitorOffsetRub competitorOffsetPct sizePriceMode sizePrices sppMode boost restartBoost').split(' '));
  const SETTINGS_FIELDS = new Set(('shopName costRates taxMode taxRate taxVatRate taxInsuranceEnabled taxAnnualRevenue ipFixedContribution ipExtraContributionCap ipHasEmployees ipDeductContributions').split(' '));
  const CONFIG_FIELDS = {
    enabled: null, marginMode: null, sizePriceMode: null,
    schedule: new Set('mode intervalMinutes hourOfDay autoSend twoPhase sendDelayMinutes sendIntervalMinutes'.split(' ')),
    priceEdit: new Set('canChangeBasePrice canCancelDiscount targetDiscountStep walletPct'.split(' ')),
    limits: new Set('maxChangePerUpdatePct maxChangePerDayPct ignoreStepIfBelowMin discountStepPct blockQuarantine'.split(' ')),
    promo: new Set('useForecastSpp ignoreChangeLimitOnEntry autoExitAutoPromos autoExitManualPromos autoJoin restorePriceAfterExit restoreAfterAutoPromoEnds exitBufferPct joinLeadDays expectedSalesUpliftPct minMarginInPromoPct'.split(' ')),
    defaults: ITEM_FIELDS
  };
  const records = new Map(), forms = new Map(), grants = new Map();
  let running = null, failure = '';
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const identity = () => [API.activeProfileId() || 'single', S.state.dataContext || ''].join('|');
  const current = (record) => record.identity === identity() && record.epoch === API.generation();
  const grantKey = (id) => identity() + '|' + API.generation() + '|' + id;
  const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
  const within = (host, element) => !host || host === element || host.contains(element);

  function assertJson(value, depth = 0, counter = { n: 0 }) {
    if (++counter.n > 100000 || depth > 16) throw new Error('Слишком большая локальная правка.');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= 20000) return;
    if (Array.isArray(value)) { value.forEach((v) => assertJson(v, depth + 1, counter)); return; }
    if (!object(value)) throw new Error('Некорректная структура локальной правки.');
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && !(Object.getPrototypeOf(proto) === null && Object.prototype.hasOwnProperty.call(proto, 'constructor') && typeof proto.constructor === 'function' && proto.constructor.name === 'Object')) throw new Error('В локальной очереди допустимы только обычные данные.');
    for (const [key, v] of Object.entries(value)) {
      if (key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key) || /key|secret|token|password|authorization/i.test(key)) throw new Error('Ключи, секреты и служебные поля запрещены в локальной очереди.');
      assertJson(v, depth + 1, counter);
    }
  }
  function allowedFields(value, allowed) {
    if (!object(value) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Недопустимые поля локальной настройки.');
  }
  function itemMap(payload, validate) {
    allowedFields(payload, new Set(['items']));
    if (!object(payload.items) || Object.keys(payload.items).length > 20000) throw new Error('Некорректный список товаров в локальной очереди.');
    for (const [nm, value] of Object.entries(payload.items)) {
      if (!/^[1-9]\d*$/.test(nm) || !Number.isSafeInteger(Number(nm))) throw new Error('Некорректный артикул WB в очереди.');
      validate(value);
    }
  }
  /** Одинаковая проверка при вводе И при восстановлении после перезапуска. */
  function validateOperations(operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 5) throw new Error('Некорректная локальная операция.');
    assertJson(operations);
    for (const op of operations) {
      allowedFields(op, new Set(['channel', 'payload']));
      if (!ALLOWED.has(op.channel) || !object(op.payload)) throw new Error('Недопустимая операция локального черновика.');
      if (op.channel === 'settings:save') allowedFields(op.payload, SETTINGS_FIELDS);
      if (op.channel === 'repricer:save') {
        allowedFields(op.payload, new Set(Object.keys(CONFIG_FIELDS)));
        for (const [key, value] of Object.entries(op.payload)) if (CONFIG_FIELDS[key]) allowedFields(value, CONFIG_FIELDS[key]);
      }
      if (op.channel === 'costs:save') itemMap(op.payload, (v) => { if (v !== null) allowedFields(v, COST_FIELDS); });
      if (op.channel === 'repricer:item-configs:save') itemMap(op.payload, (v) => { if (v !== null) allowedFields(v, ITEM_FIELDS); });
      if (op.channel === 'prices:draft-save') itemMap(op.payload, (v) => {
        allowedFields(v, new Set(['basePrice', 'discount', 'note']));
        if (!(Number(v.basePrice) > 0) || !Number.isFinite(Number(v.basePrice)) || v.discount === undefined || !Number.isFinite(Number(v.discount)) || Number(v.discount) < 0 || Number(v.discount) > 95) throw new Error('Укажите корректную базовую цену и скидку.');
      });
      if (op.channel === 'repricer:competitors:save') itemMap(op.payload, (v) => { if (v !== null && (!Array.isArray(v) || v.length > 1000)) throw new Error('Некорректный список конкурентов.'); });
      if (op.channel === 'strategies:template') {
        allowedFields(op.payload, new Set(['strategy', 'values']));
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(op.payload.strategy || '') || !(op.payload.values === null || object(op.payload.values))) throw new Error('Некорректный шаблон стратегии.');
      }
    }
    return operations;
  }
  function activations(operations) {
    const result = [];
    for (const op of operations) {
      if (op.channel === 'repricer:save') {
        if (op.payload.enabled === true) result.push('enabled');
        if (op.payload.schedule?.autoSend === true) result.push('schedule.autoSend');
        for (const key of ['autoJoin', 'autoExitAutoPromos', 'autoExitManualPromos', 'restorePriceAfterExit', 'restoreAfterAutoPromoEnds']) if (op.payload.promo?.[key] === true) result.push('promo.' + key);
      }
      if (op.channel === 'repricer:item-configs:save') for (const [nm, cfg] of Object.entries(op.payload.items || {})) {
        if (cfg && cfg.restartBoost === true) result.push('item.' + nm + '.restartBoost');
      }
    }
    return result;
  }
  /** Вызывается только из явной кнопки подтверждения, не из change/input/recovery. */
  function authorize(id, paths) {
    const key = grantKey(id), set = grants.get(key) || new Set();
    paths.forEach((path) => set.add(path)); grants.set(key, set);
  }
  function banner() {
    let el = document.getElementById('local-draft-banner');
    if (!el) { el = U.el('<div id="local-draft-banner" role="status" aria-live="polite"></div>'); document.body.appendChild(el); }
    const pending = [...records.values()].filter(current), review = pending.some((r) => r.review);
    el.hidden = !(pending.length || failure);
    if (el.hidden) return;
    el.className = 'alert warn';
    el.innerHTML = `<b>Не сохранено изменений: ${pending.length}.</b> ${U.esc(review ? 'Включение автоматики требует явного подтверждения.' : failure || 'Они находятся только в памяти, не применены и не отправлены.')} <button class="btn btn-xs" data-save>Сохранить все</button><button class="btn btn-xs btn-ghost" data-discard>Отменить все</button><span class="tiny">Сохранение записывает только локальные настройки приложения. Цены в WB не отправляются.</span>`;
    el.querySelector('[data-save]').onclick = async () => {
      if (review) UI.confirmDialog('Подтвердить настройки автоматики', '<div class="alert warn">В черновике есть включение автоматических действий. Их сохранение может разрешить отправки цен по расписанию. Продолжить?</div>', async () => {
        pending.forEach((r) => { authorize(r.id, activations(r.operations)); r.review = false; }); banner(); return commit();
      }, 'Подтверждаю автоматику');
      else await commit();
    };
    el.querySelector('[data-discard]').onclick = () => UI.confirmDialog('Отменить несохранённые изменения', '<div class="alert warn">Черновики из памяти будут удалены. Уже сохранённые настройки не изменятся. Цены в WB этим действием не меняются.</div>', () => { discardAll(); }, 'Отменить изменения');
  }
  function removeForm(id, form) {
    if (form.changed) { form.host.removeEventListener('input', form.changed); form.host.removeEventListener('change', form.changed); }
    if (forms.get(id) === form) forms.delete(id);
  }
  function stage(id, operations, options = {}) {
    validateOperations(operations);
    if (typeof id !== 'string' || !id || id.length > 150) throw new Error('Некорректный идентификатор локальной правки.');
    const permits = grants.get(grantKey(id)) || new Set();
    const record = { id, operations: clone(operations), identity: identity(), epoch: API.generation(), review: activations(operations).some((path) => !permits.has(path)), after: options.after, form: options.form, snapshot: options.snapshot };
    records.set(id, record); banner();
    return record;
  }
  async function refreshState(channel, result, record) {
    if (!current(record)) return;
    if (channel === 'settings:save') { S.state.settings = result; S.invalidate(); }
    if (channel === 'costs:save') { const costs = await API.invoke('costs:get'); if (!current(record)) return; S.state.costs = costs.items || {}; await S.reloadOverrides(); }
    if (channel === 'prices:draft-save') {
      await S.loadDrafts(); if (!current(record)) return;
      const operation = record.operations.find((o) => o.channel === channel);
      for (const [nm, value] of Object.entries(operation.payload.items || {})) {
        const map = S.state.priceEdits, old = map.get(Number(nm)) || map.get(nm);
        if (old && Number(old.basePrice) === Number(value.basePrice) && Number(old.discount) === Number(value.discount)) { map.delete(Number(nm)); map.delete(nm); }
      }
      S.invalidate();
    }
    if (Views.repricer) { Views.repricer.results = []; Views.repricer.summary = null; }
  }
  function setStatus(form, text, error) {
    if (!form?.status.isConnected) return;
    form.status.textContent = text; form.status.classList.toggle('error', !!error);
  }
  function changedPaths(before, after, path = [], result = []) {
    if (same(before, after)) return result;
    if (object(before) && object(after)) {
      new Set([...Object.keys(before), ...Object.keys(after)]).forEach((key) => changedPaths(before[key], after[key], path.concat(key), result));
    } else result.push(path);
    return result;
  }
  function at(value, path) { for (const key of path) value = value?.[key]; return value; }
  function put(value, path, item) { let target = value; path.slice(0, -1).forEach((key) => { target = target[key] || (target[key] = {}); }); target[path[path.length - 1]] = item === undefined ? null : clone(item); }
  /** Берём только затронутые поля, но не теряем их при следующем вводе, пока предыдущая запись ещё в пути. */
  function formOperations(form, snapshot) {
    const output = [];
    snapshot.forEach((op, i) => {
      const paths = form.touched[i] || (form.touched[i] = new Map());
      changedPaths(form.last[i]?.payload, op.payload).forEach((path) => paths.set(JSON.stringify(path), path));
      if (!paths.size) return;
      if (op.channel === 'prices:draft-save' || op.channel === 'strategies:template' || op.channel === 'repricer:competitors:save') { output.push(clone(op)); return; }
      const payload = {}; for (const path of paths.values()) put(payload, path, at(op.payload, path));
      output.push({ channel: op.channel, payload });
    });
    form.last = clone(snapshot); return output;
  }
  function capture(form, report) {
    if (!current(form) || !form.dirty) return true;
    const invalid = [...form.host.querySelectorAll(form.selector)].find((i) => typeof i.checkValidity === 'function' && !i.checkValidity());
    if (invalid) { setStatus(form, 'Некорректное поле — исправьте перед переходом', true); if (report) invalid.reportValidity(); return false; }
    try {
      const snapshot = form.collect(); if (!snapshot) return false; validateOperations(snapshot);
      const operations = formOperations(form, snapshot);
      if (operations.length) { stage(form.id, operations, { after: form.after, form, snapshot }); setStatus(form, 'Не сохранено — нажмите «Сохранить». Изменения только в памяти, не применены.'); }
      form.dirty = false; return true;
    } catch (e) { failure = e.message; setStatus(form, e.message, true); banner(); return false; }
  }
  async function commit(options = {}) {
    let valid = true;
    for (const form of forms.values()) if (within(options.scope, form.host) && !capture(form, options.report)) valid = false;
    if (!valid) return false;
    const matches = (record) => current(record) && (!options.id || record.id === options.id) && (!options.scope || record.form && within(options.scope, record.form.host));
    if (running) { const active = running, ok = await active; if (running === active) running = null; if (!ok) return false; return [...records.values()].some(matches) ? commit(options) : true; }
    const task = (async () => {
      for (;;) {
        const record = [...records.values()].find((r) => matches(r) && !r.review);
        if (!record) { banner(); return ![...records.values()].some((r) => matches(r) && r.review); }
        try {
          for (const op of record.operations) {
            if (!current(record)) return false;
            const result = await API.invoke(op.channel, op.payload);
            if (!current(record)) return false;
            await refreshState(op.channel, result, record);
            if (!current(record)) return false;
          }
          if (records.get(record.id) === record) {
            records.delete(record.id);
            if (record.form) { record.form.touched = []; setStatus(record.form, '✓ Сохранено локально · цены не отправлены'); }
          }
          failure = ''; banner();
          if (record.after && current(record)) await record.after();
          for (const [id, form] of forms) if (!form.host.isConnected && !form.dirty && !records.has(id)) removeForm(id, form);
        } catch (e) {
          failure = e.message || String(e); banner(); setStatus(record.form || forms.get(record.id), 'Ошибка сохранения: ' + failure + '. Черновик остался в памяти.', true);
          return false;
        }
      }
    })();
    running = task;
    try { return await task; } finally { if (running === task) running = null; }
  }
  function bind(host, id, collect, selector = 'input, select, textarea', after) {
    const old = forms.get(id); if (old && old.host === host && old.status.isConnected && host.contains(old.status) && current(old)) return old;
    if (old && current(old) && old.dirty && !capture(old, false)) throw new Error('Сначала исправьте несохранённые поля предыдущей формы.');
    if (old) removeForm(id, old);
    for (const [key, item] of forms) if (!item.host.isConnected && !item.dirty && !records.has(key)) removeForm(key, item);
    const status = U.el('<span class="draft-status" aria-live="polite">Изменения сначала попадают только в память. Применит их кнопка «Сохранить»; отправки в WB здесь нет.</span>'); host.appendChild(status);
    let initial; try { initial = collect(); } catch (_) { initial = []; }
    const form = { id, host, collect, selector, after, status, identity: identity(), epoch: API.generation(), dirty: false, last: clone(initial || []), touched: [] };
    forms.set(id, form);
    const changed = (event) => { if (!event.target.matches(selector)) return; form.dirty = true; capture(form, false); };
    form.changed = changed;
    host.addEventListener('input', changed); host.addEventListener('change', changed);
    return form;
  }
  async function commitAll() {
    if (!await commit({ report: true })) return false;
    const rp = Views.repricer;
    if (rp?._strategyEditorOpen) { App.toast('Сначала нажмите «Сохранить и закрыть» или «Отменить изменения» в редакторе стратегии.', 'warn'); return false; }
    const invalid = rp?.invalidLocalInput?.(); if (invalid) { invalid.reportValidity(); return false; }
    if (rp?.pendingEdits?.size) return rp.commitEdits(null, { quiet: true, noRetry: true });
    return true;
  }
  function captureScope(host, report = true) {
    let valid = true;
    for (const form of forms.values()) if (within(host, form.host) && !capture(form, report)) valid = false;
    return valid;
  }
  function draftItems(id, channel) {
    const record = records.get(id); if (!record || !current(record)) return {};
    const out = {};
    for (const op of record.operations) if (!channel || op.channel === channel) for (const [nm, value] of Object.entries(op.payload.items || {})) out[nm] = value === null ? null : { ...(out[nm] || {}), ...clone(value) };
    return out;
  }
  function discard(id) {
    records.delete(id); const form = forms.get(id); if (form) { form.dirty = false; form.touched = []; setStatus(form, 'Черновик отменён. Показаны последние сохранённые значения после обновления экрана.'); }
    grants.delete(grantKey(id)); failure = ''; banner();
  }
  function discardAll() {
    records.clear(); grants.clear(); failure = '';
    for (const form of forms.values()) { form.dirty = false; form.touched = []; setStatus(form, 'Черновик отменён. Показаны последние сохранённые значения после обновления экрана.'); }
    banner();
  }
  const hasWork = () => [...records.values()].some(current) || [...forms.values()].some((form) => current(form) && form.dirty) || !!Views.repricer?.invalidLocalInput?.();
  window.addEventListener('beforeunload', (event) => {
    if (hasWork() || Views.repricer?.pendingEdits?.size || Views.repricer?._strategyEditorDirty) { event.preventDefault(); event.returnValue = ''; }
  });
  return { stage, bind, commit, commitAll, captureScope, draftItems, hasWork, authorize, discard, discardAll, validateOperations, activations, hasScope: (host) => [...forms.values()].some((form) => current(form) && within(host, form.host)), pending: () => [...records.values()].filter(current).length };
})();
