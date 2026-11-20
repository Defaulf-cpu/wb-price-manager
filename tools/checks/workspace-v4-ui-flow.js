'use strict';

/** Небольшой реальный renderer + временное хранилище: редакторы, collectors, локальная запись. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const RP = require('../../electron/repricer-engine');
const ROOT = path.join(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 250; i++) { if (fn()) return; await sleep(10); }
  throw new Error('Не дождались: ' + label);
}
let passed = 0, failed = 0, service, dom, dir;
async function check(name, fn) { try { await fn(); passed++; console.log('OK   v4 UI: ' + name); } catch (e) { failed++; console.error('FAIL v4 UI: ' + name + ' — ' + e.stack); } }
const oldFetch = global.fetch;
global.fetch = async (url) => { throw new Error('Сеть запрещена в UI-приёмке: ' + url); };
async function main() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v4-ui-'));
  const store = createStore(dir);
  store.saveSettings({ demoMode: true, firstRun: false, costRates: { CNY: 13 } });
  service = createService(store, () => {});
  const goods = (await service.getDemo().getGoods()).items.slice(0, 3).map((g) => ({ ...g, price: 3000, discount: 10, sizes: [], editableSizePrice: false }));
  const nm = String(goods[0].nmID);
  service.getDemo().getGoods = async () => ({ items: plain(goods), total: goods.length, totalKnown: true, complete: true, scope: 'full', source: 'demo' });
  service.getDemo().getPromotions = async () => [];
  service.getDemo().getSalesAggregated = async () => [];
  store.saveCosts(Object.fromEntries(goods.map((g) => [g.nmID, { costPriceRub: 100, currency: 'RUB', otherPct: 1, otherRub: 2 }])));
  store.saveItemConfigs(Object.fromEntries(goods.map((g) => [g.nmID, { minPrice: 500 }])));
  const calls = [], errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push(a.join(' ')));
  dom = new JSDOM(read('src/renderer/index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc });
  const w = dom.window, doc = w.document;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(plain(body));
    try { return { json: async () => ({ ok: true, data: plain(await service.handlers[body.channel](...body.args)) }) }; }
    catch (e) { return { json: async () => ({ ok: false, error: { message: e.message, code: e.code } }) }; }
  };
  w.eval(read('electron/economics.js')); w.eval(read('electron/repricer-engine.js'));
  for (const m of read('src/renderer/index.html').matchAll(/<script src="\.\/(js\/[^"?]+)(?:\?[^"\s]+)?"><\/script>/g)) w.eval(read('src/renderer/' + m[1]));
  await until(() => w.S.state.items.length && !w.API.pending(), 'пуск');
  const rp = w.Views.repricer;
  const input = (selector, value, event = 'input', host = doc) => {
    const el = host.querySelector(selector); assert.ok(el, selector);
    if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = String(value);
    el.dispatchEvent(new w.Event(event, { bubbles: true })); return el;
  };
  async function rows() { await w.App.go('repricer'); await until(() => doc.querySelector('#rp-grid tbody tr') && !w.API.pending(), 'таблица РП'); }
  async function modal() { await until(() => doc.querySelector('#modal-root .modal') && rp._strategyCapture, 'редактор стратегии'); return doc.querySelector('#modal-root .modal'); }
  async function closeStrategy() { const box = await modal(); await box.querySelector('.modal-close').onclick(); await until(() => !box.isConnected, 'закрытие редактора'); }
  const foot = (box, label) => { const b = [...box.querySelectorAll('.modal-foot button')].find((b) => b.textContent === label); assert.ok(b, label); return b; };
  await rows();
  await check('информация репрайсера скрыта за кнопкой уведомлений и раскрывается по ней', async () => {
    const toggle = doc.querySelector('#rp-notices-toggle'), panel = doc.querySelector('#rp-notices');
    assert.ok(toggle && panel); assert.equal(panel.hidden, true);
    assert.match(doc.querySelector('#rp-notices-list').textContent, /три слоя/);
    assert.ok(![...doc.querySelectorAll('#rp-host .alert.info')].some((el) => /три слоя/.test(el.textContent)));
    toggle.click(); assert.equal(panel.hidden, false); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    doc.querySelector('#rp-notices-close').click(); assert.equal(panel.hidden, true);
  });
  await check('выключенное демо не принимает демо-товары без явной ошибки', async () => {
    const before = plain(w.S.state.items), realInvoke = w.API.invoke, realAppState = w.S.state.appState;
    try {
      w.S.state.appState = { ...realAppState, demo: false };
      w.API.invoke = async (channel) => channel === 'wb:goods'
        ? { demo: true, items: plain(goods), overrides: {}, stats: [], settings: w.S.state.settings }
        : realInvoke(channel);
      await assert.rejects(() => w.S.loadGoods(true), /демо-товары/);
      assert.deepEqual(plain(w.S.state.items), before);
    } finally { w.API.invoke = realInvoke; w.S.state.appState = realAppState; }
  });
  await check('назначение открывает редактор; отмена убирает сам выбор, сохраняя предыдущую правку', async () => {
    rp.stageEdit(nm, 'config', { tag: 'До редактора' });
    input('.rp-strategy[data-nm="' + nm + '"]', 'margin', 'change');
    const box = await modal(); input('[data-strategy-field="targetMarginPct"]', 41, 'input', box);
    await foot(box, 'Отменить изменения').onclick();
    assert.equal(rp._strategyEditorOpen, false);
    assert.deepEqual(plain(rp.pendingEdits.get(nm)), { config: { tag: 'До редактора' }, cost: {} });
    assert.equal(store.loadItemConfigs()[nm].strategy, undefined);
    await rp.commitEdits(null, { quiet: true }); assert.equal(store.loadItemConfigs()[nm].tag, 'До редактора');
  });
  await check('крестик применяет параметры локально; «Сохранить и закрыть» применяет, повторное открытие показывает число', async () => {
    await rp.openStrategyEditor(nm, 'margin'); const box = await modal();
    input('[data-strategy-field="targetMarginPct"]', 37, 'input', box); await closeStrategy();
    assert.equal(store.loadItemConfigs()[nm].targetMarginPct, 37);
    await rp.openStrategyEditor(nm, 'margin'); const box2 = await modal(); input('[data-strategy-field="targetMarginPct"]', 37, 'input', box2); await foot(box2, 'Сохранить и закрыть').onclick();
    assert.equal(store.loadItemConfigs()[nm].targetMarginPct, 37); assert.equal(store.loadItemConfigs()[nm].strategy, 'margin');
    await rp.openStrategyEditor(nm); assert.equal(doc.querySelector('[data-strategy-field="targetMarginPct"]').value, '37'); await closeStrategy();
  });
  await check('ввод и возврат к исходному значению не сохраняют промежуточный pending patch', async () => {
    await rp.openStrategyEditor(nm); const box = await modal();
    input('[data-strategy-field="targetMarginPct"]', 48, 'input', box);
    input('[data-strategy-field="targetMarginPct"]', 37, 'input', box); await foot(box, 'Сохранить и закрыть').onclick();
    assert.equal(store.loadItemConfigs()[nm].targetMarginPct, 37);
  });
  await check('сброс базовых параметров применяется по «Сохранить и закрыть», неверное число удерживает окно', async () => {
    await rp.openStrategyEditor(nm); const box = await modal();
    input('[data-strategy-field="targetMarginPct"]', 150, 'input', box);
    assert.equal(await box.querySelector('.modal-close').onclick(), false);
    await sleep(); assert.ok(box.isConnected); assert.equal(store.loadItemConfigs()[nm].targetMarginPct, 37);
    await foot(box, 'Вернуть базовые параметры').onclick(); await foot(box, 'Сохранить и закрыть').onclick();
    assert.equal(store.loadItemConfigs()[nm].targetMarginPct, RP.DEFAULT_CONFIG.defaults.targetMarginPct);
  });
  await check('сырой CNY и прочие расходы из строки совпадают с карточкой и не конвертируются повторно', async () => {
    input('.rp-cost[data-nm="' + nm + '"]', 40); input('.rp-costcur[data-nm="' + nm + '"]', 'CNY', 'change');
    input('.rp-other-pct[data-nm="' + nm + '"]', 3); input('.rp-other-rub[data-nm="' + nm + '"]', 7);
    assert.equal(await rp.commitEdits(null, { quiet: true }), true);
    const card = await service.handlers['items:card']({ nmID: Number(nm) });
    assert.equal(card.enteredCosts.costEntered, 40); assert.equal(card.enteredCosts.costPriceRub, 520); assert.equal(card.enteredCosts.currency, 'CNY'); assert.equal(card.overrides.costPriceRub, 520);
    await w.Views.itemcard.open(Number(nm)); w.Views.itemcard.tab = 'commissions'; await w.Views.itemcard.drawTab();
    assert.equal(doc.querySelector('#ic-p-costPriceRub').value, '40'); assert.equal(doc.querySelector('#ic-p-currency').value, 'CNY');
    input('#ic-p-otherRub', 8); await w.Views.itemcard.modal.close();
    assert.equal(store.loadCosts().items[nm].otherRub, 8);
    await w.Views.itemcard.open(Number(nm)); w.Views.itemcard.tab = 'commissions'; await w.Views.itemcard.drawTab(); input('#ic-p-otherRub', 8); doc.querySelector('#ic-p-save').click(); await until(() => store.loadCosts().items[nm].otherRub === 8 && !w.API.pending(), 'явное сохранение карточки');
    assert.equal(store.loadCosts().items[nm].costEntered, 40); assert.equal(store.loadCosts().items[nm].costPriceRub, 520); assert.equal(store.loadCosts().items[nm].otherRub, 8);
    assert.equal((await service.handlers['items:card']({ nmID: Number(nm) })).overrides.costPriceRub, 520);
    await w.Views.itemcard.modal.close();
  });
  await check('старый редактор себестоимости использует исходную валюту; закрытие окна применяет её локально', async () => {
    w.Views.costs.openItemEditor(Number(nm)); const box = doc.querySelector('#modal-root .modal');
    assert.equal(box.querySelector('#ce-costPriceRub').value, '40'); assert.equal(box.querySelector('#ce-currency').value, 'CNY');
    input('#ce-costPriceRub', 42, 'input', box); await box.querySelector('.modal-close').onclick();
    assert.equal(store.loadCosts().items[nm].costEntered, 42);
    w.Views.costs.openItemEditor(Number(nm)); const box2 = doc.querySelector('#modal-root .modal'); input('#ce-costPriceRub', 42, 'input', box2); await box2.querySelector('.btn-primary').onclick();
    assert.equal(store.loadCosts().items[nm].costEntered, 42); assert.equal(store.loadCosts().items[nm].costPriceRub, 546); assert.equal(store.loadCosts().items[nm].currency, 'CNY');
    assert.equal((await service.handlers['items:card']({ nmID: Number(nm) })).overrides.costPriceRub, 546);
  });
  await check('карточка товара: цены руками нет — только цена WB, пороги и предложение репрайсера', async () => {
    await w.Views.itemcard.open(Number(nm));
    assert.equal(doc.querySelector('#ic-base'), null); assert.equal(doc.querySelector('#ic-save'), null);
    assert.equal(store.loadPriceDrafts, undefined);
    assert.match(doc.querySelector('#modal-root .modal').textContent, /Ручных цен в приложении нет/);
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !doc.querySelector('#modal-root .modal'), 'Escape карточки');
    assert.equal(goods[0].price, 3000);
  });
  await check('конкурент сохраняется по «Сохранить и закрыть», последнее поле читается даже без потери фокуса', async () => {
    rp.openCompetitors(Number(nm)); const box = doc.querySelector('#modal-root .modal');
    input('#cp-name', 'UI collector'); input('#cp-price', 1234); doc.querySelector('#cp-add').click();
    const last = [...box.querySelectorAll('#cp-list [data-f="price"]')].at(-1); last.value = '1250';
    await foot(box, 'Сохранить и закрыть').onclick();
    const saved = (await service.handlers['repricer:competitors:get']())[nm];
    assert.equal(saved.at(-1).name, 'UI collector'); assert.equal(saved.at(-1).price, 1250);
  });
  await check('СПП 0 с источником и датой видна в компактном блоке без обещания live-витрины', async () => {
    const row = plain((await rp.calculate({ full: true })).results.find((r) => String(r.nmID) === nm));
    const before = w.S.state.facts[nm]; w.S.state.facts[nm] = { sppPctOfficial: 0, sppOfficialAt: '2026-06-15T09:30:00Z', sppOfficialSource: 'orders' };
    row.current.costSources.sppPct = 'official'; row.wallet.sppPct = 0;
    const html = rp.currentPriceBlock(row); assert.match(html, /СПП из ЛК: заказ/); assert.match(html, /15[.]06[.]2026/); assert.match(html, /не live-витрина/);
    w.S.state.facts[nm] = before;
  });
  await check('collector Параметров сохраняет только изменённую настройку; автоотправка остаётся выключенной', async () => {
    await w.App.go('settings', { tab: 'params' }); await until(() => doc.querySelector('#pm-wallet') && !w.API.pending(), 'параметры');
    input('#pm-wallet', 2.5); assert.equal(store.loadRepricer().priceEdit?.walletPct, undefined); doc.querySelector('#pm-save').click(); await until(() => store.loadRepricer().priceEdit?.walletPct === 2.5 && !w.API.pending(), 'явное сохранение параметров');
    assert.equal(store.loadRepricer().priceEdit?.walletPct, 2.5); assert.notEqual(store.loadRepricer().enabled, true); assert.notEqual(store.loadRepricer().schedule?.autoSend, true);
  });
  await check('collector Расписания сохраняет задержку, а включение autoSend требует отдельного согласия', async () => {
    await w.App.go('settings', { tab: 'schedule' }); await until(() => doc.querySelector('#ps-senddelay') && !w.API.pending(), 'расписание');
    input('#ps-senddelay', 45); assert.notEqual(store.loadRepricer().schedule?.sendDelayMinutes, 45); doc.querySelector('#ps-save').click(); await until(() => store.loadRepricer().schedule?.sendDelayMinutes === 45 && !w.API.pending(), 'явное сохранение расписания');
    input('#ps-autosend', true, 'change'); assert.equal(doc.querySelector('#ps-autosend').checked, false);
    const box = doc.querySelector('#modal-root .modal'); assert.ok(box); await box.querySelector('.modal-close').onclick();
    assert.notEqual(store.loadRepricer().schedule?.autoSend, true);
  });
  await check('шаблон стратегии сохраняется по кнопке, сброс не включает автоматику', async () => {
    await w.App.go('strategies'); await until(() => doc.querySelector('[data-template="margin"]') && !w.API.pending(), 'шаблоны');
    const card = doc.querySelector('[data-template="margin"]'); input('[data-strategy-field="targetMarginPct"]', 32, 'input', card);
    assert.equal(store.loadRepricer().strategyTemplates?.margin, undefined); await card.querySelector('[data-template-save]').onclick(); assert.equal(store.loadRepricer().strategyTemplates?.margin?.targetMarginPct, 32);
    await card.querySelector('[data-template-reset]').onclick(); assert.equal(store.loadRepricer().strategyTemplates?.margin, undefined);
    assert.notEqual(store.loadRepricer().enabled, true); assert.notEqual(store.loadRepricer().schedule?.autoSend, true);
  });
  await check('ошибка одного товара видна в центре; клик открывает только затронутые строки', async () => {
    await service.handlers['costs:save']({ items: { [nm]: { costPriceRub: 1, currency: 'RUB' } } });
    await w.S.reloadOverrides(); await w.App.go('dashboard'); await until(() => doc.querySelector('[data-health-level="critical"]') && !w.API.pending(), 'центр ошибок');
    doc.querySelector('[data-health-level="critical"]').click(); await until(() => doc.querySelector('#rp-grid tbody tr') && !w.API.pending(), 'фильтр ошибок');
    assert.equal(rp.itemFilter.issueLevel, 'critical');
    assert.ok(rp.filteredResults().length >= 1); assert.ok(rp.filteredResults().every((r) => r.autoBlocked));
    assert.ok(rp.results.some((r) => !r.autoBlocked)); assert.ok(doc.querySelector('#rp-health-filter'));
  });
  await check('закрытие редактора конкурентов применяет последнее значение локально', async () => {
    rp.openCompetitors(Number(nm)); const box = doc.querySelector('#modal-root .modal');
    const last = [...box.querySelectorAll('#cp-list [data-f="price"]')].at(-1); last.value = '1300';
    await box.querySelector('.modal-close').onclick();
    const saved = (await service.handlers['repricer:competitors:get']())[nm];
    assert.equal(saved.at(-1).price, 1300);
  });
  await check('отдельный калькулятор считает категорию, цену покупателя, маржу и ROI без сохранения товара', async () => {
    assert.match(doc.querySelector('[data-theme-toggle]').textContent, /Светлая|Тёмная/);
    assert.ok(doc.querySelector('.sidebar-footer .sidebar-controls #theme-toggle'));
    assert.ok(doc.querySelector('.sidebar-footer .sidebar-controls #sidebar-toggle svg'));
    assert.ok(doc.querySelector('#btn-sync').previousElementSibling.classList.contains('sidebar-controls'));
    assert.ok(!doc.querySelector('.logo #sidebar-toggle'));
    assert.ok(!doc.querySelector('#topbar-actions [data-theme-toggle]'));
    await w.App.go('calculator'); await until(() => doc.querySelector('#calc-out') && !w.API.pending(), 'калькулятор');
    assert.ok(doc.querySelector('#calc-category')); assert.match(doc.querySelector('#calc-out').textContent, /ROI по себестоимости/);
    assert.match(doc.querySelector('#calc-out').textContent, /Цена для покупателя/);
    assert.ok(!doc.querySelector('#calc-wallet'));
    doc.querySelector('#sidebar-toggle').click(); assert.ok(doc.body.classList.contains('sidebar-collapsed')); assert.equal(w.App.getSidebarCollapsed(), true);
    doc.querySelector('#sidebar-toggle').click(); assert.ok(!doc.body.classList.contains('sidebar-collapsed'));
    doc.querySelector('#calc-toggle-inputs').click(); assert.ok(doc.querySelector('.calc-layout').classList.contains('inputs-collapsed')); assert.equal(doc.querySelector('#calc-inputs').hidden, true); assert.equal(doc.querySelector('#calc-collapsed-summary').hidden, false);
    doc.querySelector('#calc-toggle-inputs').click(); assert.equal(doc.querySelector('#calc-inputs').hidden, false);
    const costBefore = plain(store.loadCosts().items[nm]);
    input('#calc-base', 2000); input('#calc-cost', 500);
    assert.match(doc.querySelector('#calc-out').textContent, /Прибыль с единицы/);
    assert.deepEqual(plain(store.loadCosts().items[nm]), costBefore);
  });
  await check('калькулятор учитывает выкуп, возвраты, эквайринг после СПП, брак и обратный расчёт', async () => {
    await w.App.go('calculator'); await until(() => doc.querySelector('#calc-out') && !w.API.pending(), 'калькулятор 2');
    input('#calc-tax', 'none', 'change'); input('#calc-base', 2000); input('#calc-discount', 0); input('#calc-cost', 500);
    input('#calc-logistics', 100); input('#calc-buyout', 50); input('#calc-return-logistics', 50);
    input('#calc-packaging', 100); input('#calc-spp', 10); input('#calc-acquiring', 10); input('#calc-defect', 10);
    const text = doc.querySelector('#calc-out').textContent.replace(/\s+/g, ' ');
    assert.match(text, /Эффективная логистика на 1 выкуп−250/);
    assert.match(text, /Эквайринг \(от цены после СПП\)−180/);
    assert.match(text, /Брак \/ утери−60/);
    input('#calc-repack', true); assert.match(doc.querySelector('#calc-out').textContent.replace(/\s+/g, ' '), /Упаковка эффективная−200/); input('#calc-repack', false);
    input('#calc-target-profit', 100); doc.querySelector('#calc-solve').click();
    assert.match(doc.querySelector('#calc-reverse-out').textContent, /По целевой прибыли:/);
    assert.match(doc.querySelector('#calc-reverse-out').textContent, /В расчёте учтены выкуп, возвраты/);
    input('#calc-discount', 20); input('#calc-shelf', 1800);
    const shelfText = doc.querySelector('#calc-out').textContent.replace(/\s+/g, ' ');
    assert.match(shelfText, /Базовая цена — какую ставить2 500 ₽/); assert.match(shelfText, /Режим расчётаот желаемой цены на полке/);
    input('#calc-tax', 'osno_vat22_credit', 'change'); input('#calc-purchase-vat', true);
    const osno = doc.querySelector('#calc-out').textContent.replace(/\s+/g, ' ');
    assert.match(osno, /Исходящий НДС 22%−361/); assert.match(osno, /Входящий НДС к вычету\+264/); assert.match(osno, /НДС к уплате−97/);
    input('#calc-tax', 'usn6_vat5', 'change');
    assert.match(doc.querySelector('#calc-out').textContent.replace(/\s+/g, ' '), /Налог \(расчётная нагрузка\)−210/);
  });
  await check('все реальные локальные collectors обошлись без WB send/включения планировщика и без JS ошибок', async () => {
    const forbidden = ['wb:apply-prices', 'wb:apply-size-prices', 'repricer:send', 'repricer:proposal-send', 'repricer:promo-apply'];
    assert.ok(calls.every((r) => !forbidden.includes(r.channel))); assert.deepEqual(errors, []);
    assert.notEqual(store.loadRepricer().enabled, true); assert.notEqual(store.loadRepricer().schedule?.autoSend, true);
  });
}
main().catch((e) => { failed++; console.error('FAIL v4 UI: запуск — ' + e.stack); }).finally(() => {
  dom?.window.close(); service?.dispose(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); global.fetch = oldFetch;
  console.log(`\nИТОГО v4 UI: ${passed} пройдено, ${failed} ошибок`); process.exitCode = failed ? 1 : 0;
});
