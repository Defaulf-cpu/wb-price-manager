'use strict';

/** Малый живой renderer: новые действия без тысяч тяжёлых DOM-строк. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createProfileHub } = require('../../electron/profiles');
const { createService } = require('../../electron/service');
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = async function ({ check, ROOT, fixture, temp, hubs }) {
  const errors = [], requests = [];
  let extraCatalog = [];
  const from = new Date(Date.now() - 7 * 86400000).toISOString(), to = new Date(Date.now() + 7 * 86400000).toISOString();
  const promo = { id: 3148, name: 'Тестовая акция 3148', startDateTime: from, endDateTime: to, requiredDiscountPct: 10 };
  const at = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const promos = [promo,
    { id: 3149, name: 'Предстоящая тестовая акция', requiredDiscountPct: 70, startDateTime: at(10), endDateTime: at(20) },
    { id: 3150, name: 'Завершённая тестовая акция', requiredDiscountPct: 70, startDateTime: at(-20), endDateTime: at(-10) },
    { id: 3151, name: 'Акция без дат', requiredDiscountPct: 0 }];
  const goods = [
    { nmID: 100000101, price: 2000, discount: 10, vendorCode: 'SYN-1', title: 'Первый тестовый товар', categoryName: 'Тест' },
    { nmID: 100000102, price: 2000, discount: 50, vendorCode: 'SYN-2', title: 'Второй тестовый товар', categoryName: 'Тест' },
    { nmID: 100000103, price: 2000, discount: 0, vendorCode: 'SYN-3', title: 'Размерный тестовый товар', categoryName: 'Тест', editableSizePrice: true, sizes: [{ sizeID: 331, price: 1000 }, { sizeID: 332, price: 2000 }] }
  ];
  const hub = createProfileHub({ dataDir: temp(), createService: (store, emit, electron, hooks) => {
    store.saveSettings({ demoMode: true, firstRun: false });
    store.saveCosts(Object.fromEntries(goods.map((g) => [String(g.nmID), { costPriceRub: 200 }])));
    store.saveItemConfigs(Object.fromEntries(goods.map((g) => [String(g.nmID), { minPrice: 300, basePrice: 2500 }])));
    const service = createService(store, emit, electron, hooks);
    service.getDemo().getGoods = async () => ({ items: goods.concat([{ nmID: 1234567890 }], extraCatalog).map((g) => ({ ...g })), source: 'demo', complete: true, scope: 'full', total: goods.length + 1 + extraCatalog.length, totalKnown: true });
    service.handlers['wb:goods'] = async () => {
      const items = JSON.parse(JSON.stringify(goods)); service.cache.goods = { items, source: 'demo' }; service.cache.goodsAt = Date.now();
      return { demo: true, items, stats: [], overrides: store.loadCosts().items || {}, settings: service.getSettings() };
    };
    service.handlers['wb:promos'] = async () => promos;
    return service;
  } }); hubs.push(hub);
  const store = hub.getActiveStore(), bid = (await hub.handlers['profiles:create']({ name: 'Второй' })).profile.id;
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const vc = new VirtualConsole(); vc.on('error', (...args) => errors.push(args.join(' '))); vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc });
  const w = dom.window, doc = w.document;
  const style = doc.createElement('style'); style.textContent = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8'); doc.head.appendChild(style);
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    try { const data = await hub.handlers[body.channel](...body.args); return { json: async () => ({ ok: true, data }) }; }
    catch (e) { return { json: async () => ({ ok: false, error: { message: e.message, code: e.code } }) }; }
  };
  const until = async (predicate) => { for (let i = 0; i < 150; i++) { if (predicate()) return true; await tick(); } return false; };
  const modal = () => Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
  const closeModals = () => doc.querySelectorAll('#modal-root .modal-close').forEach((button) => button.click());
  try {
    await tick();
    w.eval(fs.readFileSync(path.join(ROOT, 'electron/economics.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'electron/repricer-engine.js'), 'utf8'));
    for (const match of html.matchAll(/<script src="\.\/(js\/[^"]+)"><\/script>/g)) w.eval(fs.readFileSync(path.join(ROOT, 'src/renderer', match[1].split('?')[0]), 'utf8'));
    doc.dispatchEvent(new w.Event('DOMContentLoaded'));
    await until(() => w.S.state.appState && w.S.state.items.length && !w.API.pending());
    check('UI: удалённые три пункта отсутствуют в боковом меню', !doc.querySelector('#nav [data-id="prices"], #nav [data-id="economics"], #nav [data-id="costs"]') && doc.querySelectorAll('#nav .nav-item').length === 6);
    w.App.go('prices'); await until(() => doc.querySelector('#grid-host tbody tr'));
    check('UI: старый переход к ценам открывает вложенную панель репрайсера', w.S.state.view === 'repricer' && w.Views.repricer.tab === 'price-tools' && !!doc.querySelector('#rp-tabs') && !!doc.querySelector('#grid-host'));
    w.App.go('economics'); await until(() => doc.querySelector('#ec-tabs'));
    check('UI: экономика и калькулятор остались внутри репрайсера', w.S.state.view === 'repricer' && w.Views.repricer.tab === 'economics' && !!doc.querySelector('#ec-tabs'));
    w.App.go('costs'); await until(() => doc.querySelector('#c-grid tbody tr'));
    check('UI: себестоимость осталась внутри репрайсера', w.S.state.view === 'repricer' && w.Views.repricer.tab === 'costs' && !!doc.querySelector('#c-grid'));
    w.App.go('repricer'); await until(() => doc.querySelector('#rp-grid tbody tr[data-row-id]'));
    const view = w.Views.repricer;
    check('UI: все вкладки репрайсера одного типа и со скруглением как у журнала', doc.querySelectorAll('#rp-tabs button.tab').length === 12 && w.getComputedStyle(doc.querySelector('#rp-tabs [data-t="promos"]')).borderRadius === w.getComputedStyle(doc.querySelector('#rp-tabs [data-t="journal-prices"]')).borderRadius);
    const themeButton = doc.querySelector('[data-theme-toggle]'); themeButton.click();
    check('UI: светлая тема включается явной кнопкой', w.App.getTheme() === 'light' && doc.documentElement.dataset.theme === 'light');
    check('UI: выбор темы переживает перерисовку', w.localStorage.getItem('wb.ui.theme') === 'light');
    themeButton.click(); check('UI: тёмная тема доступна той же кнопкой', w.App.getTheme() === 'dark');
    const firstTable = doc.querySelector('#rp-grid table');
    check('UI: неудобные выпадающие списки имеют читаемую исходную ширину', firstTable.querySelector('col[data-col-id="strategy"]').style.width === '250px' && firstTable.querySelector('col[data-col-id="offset"]').style.width === '290px');
    check('UI: выбранный пункт стратегии доступен целиком в подсказке', !!doc.querySelector('#rp-grid .rp-strategy').title);
    let handle = doc.querySelector('#rp-grid th[data-col-id="strategy"] .grid-col-resize');
    handle.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 }));
    doc.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 170 })); doc.dispatchEvent(new w.MouseEvent('pointerup', { clientX: 170 }));
    check('UI: ширина меняется реальным перетаскиванием границы', w.GridLayout.load('repricer-products').widths.strategy === 320);
    view.renderResults();
    check('UI: ширина сохраняется после перерисовки', doc.querySelector('#rp-grid col[data-col-id="strategy"]').style.width === '320px');
    const beforeHeaders = Array.from(doc.querySelectorAll('#rp-grid thead tr:last-child th')).map((th) => th.dataset.colId).filter(Boolean);
    const sourceHeader = doc.querySelector('#rp-grid th[data-col-id="strategy"] .grid-column-title');
    sourceHeader.dispatchEvent(new w.Event('dragstart', { bubbles: true, cancelable: true }));
    doc.querySelector('#rp-grid th[data-col-id="priceNow"]').dispatchEvent(new w.Event('drop', { bubbles: true, cancelable: true }));
    const afterHeaders = Array.from(doc.querySelectorAll('#rp-grid thead tr:last-child th')).map((th) => th.dataset.colId).filter(Boolean);
    check('UI: колонка переносится за заголовок, товар остаётся закреплён', afterHeaders[0] === 'item' && afterHeaders.indexOf('strategy') < afterHeaders.indexOf('priceNow') && beforeHeaders.join() !== afterHeaders.join());
    check('UI: после переноса ячейки всё ещё соответствуют своим заголовкам', !!doc.querySelector('#rp-grid td[data-col-id="strategy"] .rp-strategy') && !!doc.querySelector('#rp-grid td[data-col-id="cost"] .rp-cost'));
    let rows = Array.from(doc.querySelectorAll('#rp-grid tbody tr[data-row-id]'));
    const lastNm = rows[rows.length - 1].dataset.rowId, firstNm = rows[0].dataset.rowId;
    rows[rows.length - 1].querySelector('.grid-row-grip').dispatchEvent(new w.Event('dragstart', { bubbles: true, cancelable: true }));
    rows[0].dispatchEvent(new w.Event('drop', { bubbles: true, cancelable: true }));
    check('UI: строка переносится за маркер, не меняя nmID товара', doc.querySelector('#rp-grid tbody tr[data-row-id]').dataset.rowId === lastNm && w.GridLayout.load('repricer-products').rowOrder[0] === lastNm && firstNm !== lastNm);
    const rowHandle = doc.querySelector('#rp-grid tbody tr .grid-row-resize');
    rowHandle.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 50 }));
    doc.dispatchEvent(new w.MouseEvent('pointermove', { clientY: 110 })); doc.dispatchEvent(new w.MouseEvent('pointerup', { clientY: 110 }));
    check('UI: высота отдельной строки меняется и сохраняется', w.GridLayout.load('repricer-products').heights[lastNm] === 140);
    view.renderResults();
    check('UI: новая высота восстановлена при отрисовке', doc.querySelector('#rp-grid tbody tr').style.height === '140px');
    const all = doc.querySelector('#rp-grid th.rp-check input'); all.checked = true; all.dispatchEvent(new w.Event('change'));
    const strategy = doc.querySelector('#rp-grid .rp-strategy'); strategy.value = strategy.options[1].value; strategy.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('UI: выбор всех не теряет обработчики редактирования ячеек', view.pendingEdits.has(strategy.dataset.nm));
    view.pendingEdits.clear(); w.S.state.priceEdits.clear();
    await until(() => !w.API.pending());
    await w.App.switchProfile(bid, true);
    check('UI: размеры и ручной порядок строк не переходят в другой кабинет', !w.GridLayout.load('repricer-products').widths.strategy && !w.GridLayout.load('repricer-products').rowOrder.length);
    await until(() => !w.API.pending()); await w.App.switchProfile('default', true);
    check('UI: возврат к кабинету восстанавливает его вид таблицы', w.GridLayout.load('repricer-products').widths.strategy === 320);

    const external = []; w.API.openExternal = async (url) => external.push(url);
    check('UI: старая ссылка главной игнорируется в пользу точной action=3148', w.U.promoCabinetUrl({ id: 3148 }, { promoCabinetUrl: 'https://seller.wildberries.ru/' }) === 'https://seller.wildberries.ru/dp-promo-calendar?action=3148');
    await w.Views.promos.openPromo(promo);
    Array.from(modal().querySelectorAll('.modal-foot .btn')).find((b) => /Перейти к акции/.test(b.textContent)).click();
    check('UI: кнопка передаёт браузеру точную прямую ссылку WB', external[0] === 'https://seller.wildberries.ru/dp-promo-calendar?action=3148', JSON.stringify(external));
    closeModals();
    w.API.importFile = async () => ({ fileName: 'wb.xlsx', size: fixture('promo-wb-export-synthetic.xlsx').length, base64: fixture('promo-wb-export-synthetic.xlsx').toString('base64') });
    const tasksBefore = store.loadTasks().length;
    await w.Views.promos.importNoms(promo);
    check('UI: выбранный XLSX показывает строки до сохранения', /Предпросмотр условий/.test(modal().textContent) && modal().querySelectorAll('tbody tr').length === 3);
    check('UI: предпросмотр не сохраняет состав автоматически', !store.loadPromoNoms()['3148']);
    await modal().querySelector('.btn-primary').onclick();
    await until(() => modal() && modal().querySelector('#promo-grid tbody tr'));
    check('UI: после Сохранить видны товары акции из файла', !!store.loadPromoNoms()['3148'] && !!modal().querySelector('#promo-grid tbody tr'));
    check('UI: в окне условий только Сохранить, а не Ввести выбранные', !/Ввести выбранные|Войти в акцию/.test(modal().textContent) && Array.from(modal().querySelectorAll('.modal-foot button')).some((b) => b.textContent === 'Сохранить'));
    const save = Array.from(modal().querySelectorAll('.modal-foot button')).find((b) => b.textContent === 'Сохранить');
    await save.onclick();
    await until(() => store.loadPromoNoms()['3148'].selectedOnly && !w.API.pending() && !doc.contains(save));
    check('UI: сохранение выбора акционных товаров не отправляет цены', store.loadPromoNoms()['3148'].selectedOnly && store.loadTasks().length === tasksBefore && !requests.some((r) => r.channel === 'wb:promo-join'));
    closeModals();
    const schemaXlsx = fixture('promo-wb-export-pdf-schema-synthetic.xlsx');
    w.API.importFile = async () => ({ fileName: 'synthetic-pdf-schema.xlsx', size: schemaXlsx.length, base64: schemaXlsx.toString('base64') });
    await w.Views.promos.importNoms(promo);
    const previewCells = modal().querySelector('tbody tr').querySelectorAll('td');
    check('UI: схема PDF показывает все 4 вымышленные строки исходного XLSX', modal().querySelectorAll('tbody tr').length === 4 && modal().querySelectorAll('thead th').length === 10);
    check('UI: наименование и предмет видны отдельно, название не потеряно', /Полное название тестового товара 1/.test(previewCells[2].textContent) && /Тестовая категория/.test(previewCells[2].textContent));
    check('UI: текущая и загружаемая скидки не смешаны в предпросмотре', /5/.test(previewCells[5].textContent) && /13/.test(previewCells[6].textContent));
    check('UI: оба склада видны раздельно в предпросмотре', previewCells[7].textContent === '3' && previewCells[8].textContent === '13');
    check('UI: предпросмотр поясняет приоритет точной плановой цены', /Плановая цена — точный порог/.test(modal().textContent));
    await modal().querySelector('.btn-primary').onclick();
    await until(() => modal() && modal().querySelector('#promo-grid tbody tr'));
    const schemaRows = w.Views.promos.promoRows;
    const firstSchemaRow = schemaRows.candidates.find((r) => r.nmID === 100000101);
    check('UI: сохранены и отображаются все товары схемы PDF', schemaRows.candidates.length + schemaRows.inside.length === 4 && store.loadPromoNoms()['3148'].items.length === 4);
    check('UI: после импорта показана скидка WB, не устаревшая скидка файла', firstSchemaRow.curDiscount === 10);
    check('UI: нужная скидка считается по порогу товара, не общему проценту календаря', firstSchemaRow.requiredDiscount === 12.5 && firstSchemaRow.gap === 2.5);
    check('UI: расчётная цена акции равна точному порогу, не 13% от старой базы', firstSchemaRow.sellerPrice === 1750);
    check('UI: общий остаток не теряет склад продавца', firstSchemaRow.stock === 16 && firstSchemaRow.stockWb === 3 && firstSchemaRow.stockSeller === 13);
    check('UI: статус файла и наблюдение цены показаны раздельно', /Статус на дату файла/.test(modal().textContent) && /Наблюдение цены/.test(modal().textContent) && /снимок из файла/.test(modal().textContent));
    closeModals();
    const beforePdf = JSON.stringify(store.loadPromoNoms());
    w.API.importFile = async () => ({ fileName: 'owner.pdf', size: 8, base64: Buffer.from('%PDF-1.7').toString('base64') });
    await w.Views.promos.importNoms(promo);
    check('UI: PDF объясняется как пример структуры, не как поддерживаемый импорт', /Файл акции не прочитан/.test(modal().textContent) && /PDF.*проверки заголовков/.test(modal().textContent) && !/пришлите сам файл/.test(modal().textContent));
    check('UI: неудачная загрузка PDF не стирает сохранённые товары', JSON.stringify(store.loadPromoNoms()) === beforePdf);
    closeModals();
    await until(() => !w.API.pending());
    w.App.go('repricer'); await until(() => doc.querySelector('#rp-tabs [data-t="params"]'));
    doc.querySelector('#rp-tabs [data-t="params"]').click(); await until(() => doc.querySelector('#pm-taxmode'));
    const tax = doc.querySelector('#pm-taxmode'); tax.value = 'nds22'; tax.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('UI: налоги и отдельный НДС доступны в параметрах РП', !!doc.querySelector('#pm-vat') && !!doc.querySelector('#pm-annual') && /18[,.]033/.test(doc.querySelector('#pm-tax-summary').textContent));
    tax.value = 'usn6'; tax.dispatchEvent(new w.Event('change', { bubbles: true }));
    check('UI: переключение с НДС на УСН не оставляет скрытый НДС 22%', doc.querySelector('#pm-vat').value === '0');
    tax.value = 'nds22'; tax.dispatchEvent(new w.Event('change', { bubbles: true }));
    await doc.querySelector('#pm-save').onclick();
    check('UI: НДС 22 сохраняется в текущем кабинете', store.loadSettings().taxMode === 'nds22' && store.loadSettings().taxVatRate === 22 && hub.getProfile(bid).store.loadSettings().taxMode === 'usn6');
    await until(() => !w.API.pending());
    await require('./promo-workspace-ui')({ check, w, doc, until, modal, closeModals, requests, store, hub, bid, promo, promos, setCatalogExtras: (items) => { extraCatalog = items; } });
    check('UI: новые сценарии не создали ошибок JavaScript', errors.length === 0, errors.join(' | '));
  } finally { dom.window.close(); }
};
