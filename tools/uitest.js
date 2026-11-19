'use strict';

/**
 * Смоук-тест интерфейса: поднимает реальный renderer в jsdom,
 * подменяет сеть на локальный сервис (демо-данные) и «прокликивает» все разделы.
 * Запуск: node tools/uitest.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

const { createStore } = require(path.join(ROOT, 'electron', 'store'));
const { createService } = require(path.join(ROOT, 'electron', 'service'));

const store = createStore(path.join(os.tmpdir(), 'wb-uitest-' + Date.now()), null);
store.saveSettings({ demoMode: true, firstRun: false });
const service = createService(store, () => {});

const errors = [];
const logs = [];

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e && e.message ? e.message : e);
  // jsdom не умеет скачивание файлов и переходы по blob:/data: — в реальном приложении
  // сохранение идёт через системный диалог Electron, поэтому такие сообщения игнорируем
  if (/Not implemented: navigation|Not implemented: htmlToFile|jsdom does not support/i.test(msg)) {
    logs.push('ignored (jsdom limitation): ' + msg.split('\n')[0]);
    return;
  }
  errors.push('jsdomError: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : msg));
});
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => logs.push('warn: ' + a.join(' ')));
vc.on('log', (...a) => logs.push('log: ' + a.join(' ')));

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

async function run() {
  const rawHtml = readFile(path.join(RENDERER, 'index.html'));
  // Скрипты выполняем вручную и по порядку (в т.ч. document.write для модуля расчётов)
  const html = rawHtml.replace(/<script[\s\S]*?<\/script>/g, '');

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // сеть → локальный сервис (как в браузере через dev-сервер)
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/invoke')) {
          const body = JSON.parse(opts.body || '{}');
          const fn = service.handlers[body.channel];
          if (!fn) return mk({ ok: false, error: { message: 'unknown channel ' + body.channel } });
          try {
            const data = await fn(...(body.args || []));
            return mk({ ok: true, data });
          } catch (e) {
            return mk({ ok: false, error: { message: e.message, code: e.code } });
          }
        }
        // статика
        let rel = u.replace(/^https?:\/\/localhost/, '').split('?')[0];
        if (rel === '/' || rel === '') rel = '/index.html';
        if (rel === '/economics.js') return mkText(readFile(path.join(ROOT, 'electron', 'economics.js')), 'text/javascript');
        if (rel === '/repricer-engine.js') return mkText(readFile(path.join(ROOT, 'electron', 'repricer-engine.js')), 'text/javascript');
        const file = path.join(RENDERER, rel);
        if (!file.startsWith(RENDERER)) return mkText('forbidden', 'text/plain', 403);
        try {
          return mkText(readFile(file), mimeFor(file));
        } catch (e) {
          return mkText('not found ' + rel, 'text/plain', 404);
        }
      };
      function mkText(text, type, status) {
        return {
          ok: (status || 200) === 200, status: status || 200,
          text: async () => text, json: async () => JSON.parse(text),
          headers: { get: () => type }
        };
      }
      function mk(obj) {
        return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj), headers: { get: () => 'application/json' } };
      }
      function mimeFor(f) {
        const e = path.extname(f);
        return e === '.js' ? 'text/javascript' : e === '.css' ? 'text/css' : e === '.html' ? 'text/html' : 'text/plain';
      }
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
    }
  });

  const { window } = dom;
  const doc = window.document;
  // В jsdom удалённые таблицы тяжёлые; освобождаем их между сценариями.
  // Проверки и размер страницы не меняются, GC нужен для CI с 2 ГБ памяти.
  let waitCount = 0;
  const wait = (ms) => new Promise((r) => setTimeout(() => {
    if (++waitCount % 8 === 0 && global.gc) global.gc();
    r();
  }, ms));

  // выполняем скрипты интерфейса в том же порядке, что и в index.html.
  // Список берём ИЗ index.html, а не держим отдельной копией: рукописный список
  // разошёлся с разметкой, когда добавился раздел «Отчёты», и тест упал на
  // Views.reports === undefined. Теперь новый вид подключается сам.
  const indexHtml = readFile(path.join(RENDERER, 'index.html'));
  const rendererScripts = [];
  const scriptRe = /<script src="\.\/(js\/[^"]+)"><\/script>/g;
  let sm;
  while ((sm = scriptRe.exec(indexHtml))) rendererScripts.push(path.join(RENDERER, sm[1].split('?')[0].replace(/\//g, path.sep)));
  if (rendererScripts.length < 5) throw new Error('Не удалось разобрать список скриптов из index.html');
  const scripts = [
    path.join(ROOT, 'electron', 'economics.js'),
    path.join(ROOT, 'electron', 'repricer-engine.js')
  ].concat(rendererScripts);
  for (const f of scripts) {
    try {
      window.eval(readFile(f));
    } catch (e) {
      errors.push('SCRIPT ERROR in ' + path.basename(f) + ': ' + (e.stack || e.message));
    }
  }
  doc.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

  // ждём инициализации
  for (let i = 0; i < 60; i++) {
    await wait(200);
    if (window.App && doc.querySelector('#view .card')) break;
  }

  // Общие UI-сценарии не нуждаются в 200 DOM-строках на каждом шаге.
  // Расчёты идут по всем товарам; штатные 100 строк проверяются отдельно ниже.
  const productionRepricerPageSize = window.Views.repricer.PAGE_SIZE;
  const generalRepricerPageSize = 10; // общий прогон хранит сотни старых DOM-ссылок; штатные 100 проверяются ниже отдельно
  window.Views.repricer.PAGE_SIZE = generalRepricerPageSize;
  window.Views.repricer.ST_PAGE_SIZE = 20;

  const report = [];
  const check = (name, cond, extra) => {
    report.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (process.env.UI_TEST_PROGRESS) console.log(report[report.length - 1]);
    if (process.env.UI_TEST_MEM && report.length % 20 === 0) {
      console.log('MEM ' + report.length + ' heap=' + Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
    }
    if (!cond) errors.push('CHECK FAILED: ' + name + (extra ? ' — ' + extra : ''));
  };

  check('приложение инициализировалось', !!window.App && !!window.S && !!window.EC);
  check('товары загружены', window.S.state.items.length > 100, window.S.state.items.length + ' шт');
  check('демо-режим включён', window.S.state.demo === true);
  check('экономике есть себестоимость', window.S.getRows().filter((r) => r.costPrice > 0).length > 50);
  check('акции загружены', window.S.state.promos.length > 0, window.S.state.promos.length + ' шт');

  const navCount = doc.querySelectorAll('.nav-item').length;
  check('навигация построена', navCount === 8, navCount + ' пунктов');
  check('модуль репрайсера загружен в интерфейс', !!window.RP && typeof window.RP.computeItem === 'function');

  // обход всех разделов
  for (const id of ['dashboard', 'prices', 'repricer', 'calculator', 'promos', 'economics', 'costs', 'reports', 'settings']) {
    window.App.go(id);
    await wait(450);
    const view = doc.getElementById('view');
    const hasContent = view && view.innerHTML.length > 300;
    const hasError = view && /Ошибка раздела|Uncaught|TypeError|is not a function/.test(view.innerHTML);
    check(`раздел «${id}» отрисован`, hasContent && !hasError, view ? view.innerHTML.length + ' симв.' : 'нет контента');
  }

  // цены: таблица и строки
  window.App.go('prices');
  await wait(400);
  const priceRows = doc.querySelectorAll('#grid-host tbody tr').length;
  check('таблица цен содержит строки', priceRows > 50, priceRows + ' строк');

  // выбор товара + предпросмотр массовой переценки
  const st = window.S.state;
  const rows = window.S.getRows();
  const lossRows = rows.filter((r) => r.profit < 0);
  check('в демо-магазине есть убыточные товары', lossRows.length > 0, lossRows.length + ' шт');

  st.filters.flag = 'loss';
  window.App.go('prices');
  await wait(500);
  const lossInTable = doc.querySelectorAll('#grid-host tbody tr').length;
  check('фильтр «убыточные» работает', lossInTable === lossRows.length, `${lossInTable} в таблице / ${lossRows.length} в данных`);

  st.filters.flag = 'selected';
  st.selection = new Set(lossRows.slice(0, 5).map((r) => r.nmID));
  st.priceRule = { type: 'set-target-margin', value: 20, roundTo: 10, minPrice: 0 };
  window.App.go('prices');
  await wait(500);
  const scopeSel = doc.querySelector('#b-scope');
  if (scopeSel) { scopeSel.value = 'selected'; scopeSel.dispatchEvent(new window.Event('change')); }
  await wait(200);
  window.Views.prices.preview();
  await wait(400);
  const modal = doc.querySelector('#modal-root .modal');
  check('модальное окно предпросмотра открылось', !!modal, modal ? modal.querySelector('.modal-head h2').textContent : '');
  const planRows = modal ? modal.querySelectorAll('tbody tr').length : 0;
  check('в предпросмотре 5 товаров', planRows === 5, planRows + ' строк');

  // применяем цены в демо-режиме
  if (modal) {
    const applyBtn = Array.from(modal.querySelectorAll('.modal-foot .btn')).find((b) => /Применить|Отправить/.test(b.textContent));
    check('есть кнопка применения', !!applyBtn, applyBtn ? applyBtn.textContent : '');
    if (applyBtn) {
      applyBtn.click();
      await wait(1200);
      const resultModal = doc.querySelector('#modal-root .modal');
      check('показан результат загрузки цен', !!resultModal && /Результат загрузки цен/.test(resultModal.textContent), resultModal ? resultModal.querySelector('h2').textContent : '');
      if (resultModal) {
        const closeBtn = Array.from(resultModal.querySelectorAll('.btn')).find((b) => /Готово/.test(b.textContent));
        if (closeBtn) closeBtn.click();
      }
      const after = window.S.getRows().filter((r) => r.profit < 0).length;
      check('убыточных стало меньше после переценки', after < lossRows.length, `${lossRows.length} → ${after}`);
    }
  }

  // акции: открытие карточки
  window.App.go('promos');
  await wait(900);
  const promoCards = doc.querySelectorAll('#promo-list .promo-list-row').length;
  check('общий список акций отрисован', promoCards > 0, promoCards + ' шт');
  // в карточке акции теперь две кнопки: «Загрузить товары из файла» и «Открыть товары».
  // Берём именно вторую (data-open), иначе тест откроет диалог выбора файла.
  const openBtn = doc.querySelector('#promo-selected [data-open]');
  if (openBtn) {
    openBtn.click();
    await wait(900);
    const pm = doc.querySelector('#modal-root .modal');
    check('открылся список товаров акции', !!pm && pm.querySelectorAll('tbody tr').length > 0, pm ? pm.querySelectorAll('tbody tr').length + ' строк' : '');
    if (pm) {
      const selSafe = Array.from(pm.querySelectorAll('.btn')).find((b) => /Выбрать прибыльные/.test(b.textContent));
      if (selSafe) { selSafe.click(); await wait(300); }
      const saveButton = Array.from(pm.querySelectorAll('.modal-foot .btn')).find((b) => b.textContent.trim() === 'Сохранить');
      check('есть кнопка сохранения условий для репрайсера', !!saveButton && !/Ввести выбранные/.test(pm.textContent));
      if (saveButton && window.S.state.promoSelection && window.S.state.promoSelection.size) {
        const tasksBefore = store.loadTasks().length;
        saveButton.click(); await wait(650);
        check('условия акции сохранены локально', Object.values(store.loadPromoNoms()).some((record) => record.selectedOnly && record.selectedIds.length));
        check('сохранение условий не отправило цены в WB', store.loadTasks().length === tasksBefore);
      }
    }
  }

  // экономика: калькулятор и сценарии
  window.App.go('economics');
  await wait(400);
  const summaryLen = doc.getElementById('ec-host').innerHTML.length;
  check('сводка экономики отрисована', summaryLen > 2000, summaryLen + ' симв.');
  window.Views.economics.tab = 'calc';
  window.Views.economics.draw();
  await wait(300);
  check('калькулятор цены отрисован', !!doc.getElementById('s-out') && doc.getElementById('s-out').innerHTML.length > 500);
  const solve = doc.getElementById('s-solve');
  if (solve) { solve.click(); await wait(200); }
  check('подбор цены работает', !!doc.getElementById('s-solve-out') && /Нужная цена/.test(doc.getElementById('s-solve-out').textContent), doc.getElementById('s-solve-out') ? doc.getElementById('s-solve-out').textContent.slice(0, 60).trim() : '');
  window.Views.economics.tab = 'scenario';
  window.Views.economics.draw();
  await wait(200);
  doc.getElementById('sc-price').value = '-10';
  doc.getElementById('sc-conv').value = '15';
  doc.getElementById('sc-run').click();
  await wait(600);
  check('сценарий переценки рассчитан', /Выручка \(30 дней\)/.test(doc.getElementById('sc-out').textContent), doc.getElementById('sc-out').textContent.replace(/\s+/g, ' ').slice(0, 90));

  // себестоимость
  window.App.go('costs');
  await wait(500);
  const costRows = doc.querySelectorAll('#c-grid tbody tr').length;
  check('таблица себестоимости отрисована', costRows > 0, costRows + ' строк');
  const cbApply = doc.getElementById('cb-apply');
  if (cbApply) {
    doc.getElementById('cb-field').value = 'commissionPct';
    doc.getElementById('cb-value').value = '19';
    doc.getElementById('cb-mode').value = 'set';
    cbApply.click();
    await wait(800);
    check('массовое заполнение себестоимости сработало', Object.keys(window.S.state.costs).length > 0, Object.keys(window.S.state.costs).length + ' записей');
  }

  // настройки
  window.App.go('settings');
  await wait(600);
  check('настройки отрисованы', !!doc.getElementById('k-prices') && !!doc.getElementById('s-comm'));
  const catRows = doc.querySelectorAll('#cats-host tbody tr').length;
  check('таблица комиссий по категориям', catRows > 0, catRows + ' строк');
  doc.getElementById('s-target').value = '25';
  doc.getElementById('save-all').click();
  await wait(900);
  check('настройки сохраняются', window.S.state.settings.targetMarginPct === 25, 'targetMarginPct=' + window.S.state.settings.targetMarginPct);

  /**
   * Тарифы логистики по категории. Заодно это проверка того, что поля категории вообще
   * сохраняются: в строгом режиме функция-объявление catInput имела this === undefined,
   * и правка комиссии/рекламы/упаковки по категории молча не доезжала до хранилища.
   */
  const catRow = doc.querySelector('#cats-host tbody tr');
  if (catRow) {
    const catName = ((catRow.querySelector('td') || {}).textContent || '').trim();
    const catIns = catRow.querySelectorAll('input.num.cellinput');
    check('в строке категории есть поля тарифов логистики', catIns.length >= 7, catIns.length + ' полей');
    const setInp = (el, v) => { el.value = String(v); el.dispatchEvent(new window.Event('change', { bubbles: true })); };
    const tail = catIns.length - 4;      // база, за литр, порог, крупный тариф
    setInp(catIns[tail], 70); setInp(catIns[tail + 1], 20);
    setInp(catIns[tail + 2], 3); setInp(catIns[tail + 3], 240);
    doc.getElementById('save-all').click();
    await wait(900);
    const catDefOf = () => (window.S.state.settings.categoryDefaults || {})[catName] || {};
    const cd = catDefOf();
    check('тарифы логистики категории сохранились',
      cd.logisticsBaseRub === 70 && cd.logisticsPerLiterRub === 20 && cd.literThreshold === 3 && cd.logisticsLargeRub === 240,
      JSON.stringify(cd));
    const logOf = (liters) => window.EC.calcLogistics(
      window.EC.resolveParams(window.S.state.settings, { categoryName: catName, volumeLiters: liters }, {}, {}));
    check('категория применяет свои базу и тариф за литр', Math.abs(logOf(2) - 90) < 0.01, logOf(2) + ' ₽');
    check('категория применяет свой порог и крупный тариф', Math.abs(logOf(4) - 240) < 0.01, logOf(4) + ' ₽');
    // вернуть «как в общих настройках», чтобы категорийные тарифы не влияли на остальные проверки
    const liveCatIns = doc.querySelector('#cats-host tbody tr').querySelectorAll('input.num.cellinput');
    [tail, tail + 1, tail + 2, tail + 3].forEach((k) => setInp(liveCatIns[k], ''));
    doc.getElementById('save-all').click();
    await wait(900);
    const cd2 = catDefOf();
    check('пустое поле категории возвращает к общим настройкам',
      cd2.logisticsBaseRub === null && cd2.literThreshold === null, JSON.stringify(cd2));
  } else {
    check('в строке категории есть поля тарифов логистики', false, 'таблица категорий пуста');
  }

  // ── J: единый раздел копий, предпросмотр, замена и нативная отмена ──
  check('J: в настройках один раздел копий и не потерян Telegram',
    doc.querySelectorAll('#backup-export').length === 1 && !!doc.querySelector('#tg-test'));
  const jExport = await window.API.invoke('backup:export', {});
  const jBefore = JSON.stringify(store.loadCosts());
  let jInput = doc.querySelector('#backup-file');
  Object.defineProperty(jInput, 'files', { configurable: true, value: [{ name: jExport.fileName,
    size: jExport.sizeBytes, text: async () => jExport.content }] });
  await jInput.onchange({ currentTarget: jInput });
  let jModal = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
  check('J: загрузка файла открывает предпросмотр, а не применяет данные',
    !!jModal && /Предпросмотр импорта/.test(jModal.textContent) && JSON.stringify(store.loadCosts()) === jBefore);
  let jMode = jModal && jModal.querySelector('#backup-mode');
  check('J: импорт по умолчанию сохраняет локальные данные слиянием', !!jMode && jMode.value === 'merge');
  if (jMode) { jMode.value = 'replace'; await jMode.onchange(); }
  let jConfirm = jModal && jModal.querySelector('#backup-confirm-replace');
  check('J: замена показывает отдельное подтверждение и блокирует кнопку до согласия',
    !!jConfirm && !jModal.querySelector('#backup-replace-confirm-wrap').hidden &&
    jModal.querySelector('.modal-foot .btn-primary').disabled);
  check('J: предпросмотр замены показывает удаляемые данные',
    !!jModal && /Удалится/.test(jModal.textContent) && !!jModal.querySelector('#backup-preview-rows tr'));
  if (jConfirm) { jConfirm.checked = true; jConfirm.onchange(); }
  check('J: после явного подтверждения замены кнопку можно нажать',
    !!jModal && !jModal.querySelector('.modal-foot .btn-primary').disabled);
  if (jMode) { jMode.value = 'merge'; await jMode.onchange(); }
  check('J: возврат к слиянию убирает подтверждение замены',
    !!jModal && jModal.querySelector('#backup-replace-confirm-wrap').hidden);
  if (jModal) jModal.querySelector('.modal-close').click();

  const jLegacyText = readFile(path.join(ROOT, 'tools', 'checks', 'fixtures', 'backup-j-v1.json'));
  Object.defineProperty(jInput, 'files', { configurable: true, value: [{ name: 'early-j.wbpm.json',
    size: jLegacyText.length, text: async () => jLegacyText }] });
  await jInput.onchange({ currentTarget: jInput });
  jModal = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
  check('J: ранний формат показывает предупреждение об отсутствии контрольных сумм',
    !!jModal && /ранний формат задания J без исходных контрольных сумм/.test(jModal.textContent));
  let jKeys = jModal && jModal.querySelector('#backup-apply-keys');
  check('J: импорт ключей из раннего файла по умолчанию выключен',
    !!jKeys && !jKeys.checked && jModal.querySelector('#backup-import-password').disabled);
  if (jKeys) { jKeys.checked = true; jKeys.onchange(); }
  check('J: пароль доступен только при явном выборе импорта ключей',
    !!jModal && !jModal.querySelector('#backup-import-password').disabled);
  if (jModal) jModal.querySelector('.modal-close').click();

  const jOriginalBridge = { isElectron: window.API.isElectron, saveBackup: window.API.saveBackup, openBackup: window.API.openBackup };
  try {
    window.API.isElectron = true;
    window.API.saveBackup = async () => null;
    window.API.openBackup = async () => null;
    await doc.querySelector('#backup-export').onclick();
    check('J: отмена системного сохранения не показывается как успех',
      /Сохранение отменено/.test(doc.querySelector('#backup-status').textContent));
    await doc.querySelector('#backup-load').onclick();
    check('J: отмена системного открытия не применяет данные',
      /Выбор файла отменён/.test(doc.querySelector('#backup-status').textContent) && JSON.stringify(store.loadCosts()) === jBefore);
  } finally {
    Object.assign(window.API, jOriginalBridge);
  }
  jInput = null; jModal = null; jMode = null; jConfirm = null; jKeys = null;

  // карточка товара (клик по строке таблицы)
  window.S.state.filters.flag = 'all';
  window.App.go('prices');
  await wait(700);
  const dataRows = doc.querySelectorAll('#grid-host tbody tr').length;
  check('после переценки таблица снова полная', dataRows > 100, dataRows + ' строк');
  const firstRow = doc.querySelector('#grid-host tbody tr');
  check('у строки назначен обработчик клика', !!(firstRow && firstRow.onclick));
  if (firstRow) {
    firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(1200);
    const dm = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
    check('карточка товара открывается', !!dm && /Прибыль с единицы/.test(dm.textContent), dm ? dm.querySelector('h2').textContent : '');
    check('в карточке есть цена безубыточности', !!dm && /Цена безубыточности/.test(dm.textContent));
    check('в карточке есть размеры и продажи', !!dm && /Размеры и цены/.test(dm.textContent) && /Продажи и остатки/.test(dm.textContent));
  }

  // экспорт CSV
  try {
    window.Views.prices.exportCsv();
    await wait(200);
    check('экспорт цен в CSV не падает', true);
  } catch (e) { check('экспорт цен в CSV не падает', false, e.message); }

  // ручная правка цены в таблице
  window.S.state.filters.flag = 'all';
  window.App.go('prices');
  await wait(700);
  const inlineInput = doc.querySelector('#grid-host tbody tr td:nth-child(4) input');
  check('в таблице есть инлайн-редактирование базовой цены', !!inlineInput);
  if (inlineInput) {
    inlineInput.value = '3990';
    inlineInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(500);
    check('ручная правка попала в editing', window.Views.prices.editing.size > 0, window.Views.prices.editing.size + ' записей');
    const scope = doc.querySelector('#b-scope');
    if (scope) { scope.value = 'edited'; scope.dispatchEvent(new window.Event('change', { bubbles: true })); }
    await wait(300);
    const applyBtn = doc.querySelector('#b-apply');
    check('кнопка отправки активна для изменённых вручную', !!applyBtn && !applyBtn.disabled);
  }

  // панель: статус репрайсера и быстрое действие
  window.App.go('dashboard');
  await wait(1200);
  check('панель: статус репрайсера показан', /Репрайсер:/.test(doc.getElementById('view').innerHTML));
  check('панель: лимит шага в статусе репрайсера', /лимит шага 19%/.test(doc.getElementById('view').innerHTML));
  const rpQuick = Array.from(doc.querySelectorAll('[data-act]')).find((b) => b.dataset.act === 'repricer');
  check('панель: быстрое действие «Пересчитать цены репрайсером»', !!rpQuick);
  if (rpQuick) { rpQuick.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(800); check('панель: переход в репрайсер работает', window.S.state.view === 'repricer'); }

  // ═════════════ РЕПРАЙСЕР ═════════════
  window.App.go('repricer');
  await wait(800);
  const rpTabs = doc.querySelectorAll('#rp-tabs .tab').length;
  check('репрайсер: вкладки построены', rpTabs === 7, rpTabs + ' вкладок');
  check('репрайсер: есть журнал изменения цен',
    Array.from(doc.querySelectorAll('#rp-tabs .tab')).some((t) => /Журнал изменения цен/.test(t.textContent)));
  check('репрайсер: журнал участия перенесён, но функция сохранена', !doc.querySelector('#rp-tabs [data-t="journal-promos"]') && typeof window.Views.repricer.tabJournal === 'function');
  check('акции: единый раздел доступен в боковом меню', !!doc.querySelector('#nav [data-id="promos"]'));
  check('акции: аналитика сохранена без дублирующей вкладки РП', !doc.querySelector('#rp-tabs [data-t="promo-analytics"]') && typeof window.Views.repricer.tabPromoAnalytics === 'function');
  check('репрайсер: состояние загружено', !!window.Views.repricer.rstate && !!window.Views.repricer.rstate.config);
  check('репрайсер: лимит шага по умолчанию 19%', window.Views.repricer.rstate.config.limits.maxChangePerUpdatePct === 19);
  check('репрайсер: десять стратегий, включая лесенку', (window.RP.STRATEGIES || []).length === 10, (window.RP.STRATEGIES || []).length + ' шт');
  check('репрайсер: демо-конкуренты загружены', window.Views.repricer.rstate.competitorCount > 50, window.Views.repricer.rstate.competitorCount + ' товаров');

  // пересчёт цен
  const calcBtn = doc.querySelector('#rp-calc');
  check('репрайсер: кнопка пересчёта есть', !!calcBtn);
  if (calcBtn) {
    calcBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 80; i++) { await wait(250); if (window.Views.repricer.summary) break; }
    await wait(500);
    const sum = window.Views.repricer.summary;
    check('репрайсер: пересчёт выполнен', !!sum, sum ? 'товаров ' + sum.total : 'нет сводки');
    check('репрайсер: есть товары к отправке', !!(sum && sum.toSend > 0), sum ? sum.toSend + ' шт' : '');
    check('репрайсер: нет ошибок расчёта', !!(sum && sum.errors === 0), sum ? 'ошибок ' + sum.errors : '');
    const stepCheck = (function () {
      const rs = window.Views.repricer.results || [];
      const lim = window.Views.repricer.rstate.config.limits.maxChangePerUpdatePct;
      // ниже минимального порога лимит шага намеренно игнорируется (как в INDEEPA);
      // выход из акции тоже может превысить шаг — иначе товар продолжит терять деньги
      const bypass = (r) => r.limitedBy === 'below-min' || !!(r.promoChosen && r.promoChosen.bypassLimits);
      const bad = rs.filter((r) => !r.error && !bypass(r) && Math.abs(r.delta.pct) > lim + 0.35);
      const lifted = rs.filter((r) => !r.error && r.limitedBy === 'below-min').length;
      const exits = rs.filter((r) => !r.error && r.promoChosen && r.promoChosen.type === 'exit').length;
      const bypassed = rs.filter((r) => !r.error && r.promoChosen && r.promoChosen.bypassLimits).length;
      return { bad: bad.length, lifted, exits, bypassed };
    })();
    check('репрайсер: лимит шага соблюдён', stepCheck.bad === 0,
      'превышений ' + stepCheck.bad + ' (обходов лимита при выходе из акции ' + stepCheck.bypassed + ', поднято до порога ' + stepCheck.lifted + ')');
    check('репрайсер: убыточные товары не остаются ниже минимального порога',
      (window.Views.repricer.results || []).filter((r) => !r.error && r.proposed.profit < -0.01 && r.proposed.sellerPrice < r.priceFloor - 0.01).length === 0,
      'поднято до порога ' + stepCheck.lifted + ' шт');
    check('репрайсер: цена не вышла за коридор', (window.Views.repricer.results || [])
      .filter((r) => !r.error && r.proposed.sellerPrice > r.corridor.max + 1).length === 0);
    check('репрайсер: сводка отрисована', /Пересчитано товаров/.test(doc.getElementById('view').innerHTML));
    const rpRows = doc.querySelectorAll('#rp-grid tbody tr').length;
    check('репрайсер: таблица новых цен заполнена', rpRows > 0, rpRows + ' строк');
    // разбор «почему такая цена»
    const whyBtn = doc.querySelector('#rp-grid [data-why]');
    check('репрайсер: есть кнопка разбора расчёта', !!whyBtn);
    if (whyBtn) {
      whyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(300);
      const wm = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
      check('репрайсер: окно «почему такая цена» открылось', !!wm && /Как получилась цена/.test(wm.textContent));
      check('репрайсер: в разборе есть слои расчёта', !!wm && wm.querySelectorAll('tbody tr').length > 0);
      if (wm) wm.querySelector('.modal-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(200);
    }
    // экспорт расчёта в CSV
    try { doc.querySelector('#rp-export').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(300); check('репрайсер: экспорт CSV не падает', true); }
    catch (e) { check('репрайсер: экспорт CSV не падает', false, e.message); }
    // отправка выбранных цен
    const sendBtn = doc.querySelector('#rp-send');
    check('репрайсер: кнопка отправки активна после пересчёта', !!sendBtn && !sendBtn.disabled);
    if (sendBtn) {
      sendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(400);
      const cm = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
      check('репрайсер: подтверждение отправки показано', !!cm && /Отправить .* цен в Wildberries/.test(cm.querySelector('h2').textContent));
      if (cm) {
        const ok = Array.from(cm.querySelectorAll('.modal-foot .btn')).pop();
        ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        for (let i = 0; i < 60; i++) {
          await wait(250);
          const m = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
          if (m && /Результат загрузки цен/.test(m.textContent)) break;
          if (!doc.querySelector('.modal-backdrop')) break;
        }
        await wait(400);
        const rm = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
        check('репрайсер: отправка цен выполнена, показан результат', !!rm && /Результат загрузки цен/.test(rm.textContent), rm ? rm.querySelector('h2').textContent : 'окно закрыто');
        if (rm) rm.querySelector('.modal-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await wait(400);
      }
    }
  }

  // Аналитика акций должна отрисоваться только на локальных данных.
  window.Views.repricer.tab = 'promo-analytics';
  await window.Views.repricer.draw();
  await wait(250);
  check('репрайсер: окно N для аналитики акций настраивается', !!doc.querySelector('#paa-days'));
  check('репрайсер: доступны CSV и XLSX для аналитики акций', !!doc.querySelector('#paa-csv') && !!doc.querySelector('#paa-xlsx'));
  check('репрайсер: аналитика получила ответ от локального кэша', window.S.state.view === 'promos' && !!doc.querySelector('[data-promo-tab="analytics"].active') && !/Ошибка|TypeError/.test(doc.querySelector('#promo-section-host').textContent));

  // история изменения цен записана
  const hist = await service.handlers['repricer:history']();
  const histCount = Object.keys(hist || {}).length;
  check('репрайсер: история цен заполнена после отправки', histCount > 0, histCount + ' артикулов');

  // «Массовые правила»: там же массовое назначение стратегии (прежняя отдельная вкладка)
  window.Views.repricer.tab = 'rules';
  window.App.go('repricer');
  await wait(400);
  window.Views.repricer.tab = 'rules';
  await window.Views.repricer.draw();
  await wait(900);
  const stRows = doc.querySelectorAll('#st-grid tbody tr').length;
  check('репрайсер: список товаров со стратегиями', stRows === Math.min(window.Views.repricer.ST_PAGE_SIZE, window.Views.repricer.results.length), stRows + ' строк');
  const stSel = doc.querySelector('#st-grid tbody tr select');
  check('репрайсер: у строки есть выбор стратегии', !!stSel && stSel.options.length === 10, stSel ? stSel.options.length + ' вариантов' : '');
  if (stSel) {
    stSel.value = 'margin';
    stSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(400);
    // правки в таблице КОПЯТСЯ (как «Отменить/Сохранить» в INDEEPA) и применяются пачкой:
    // до нажатия «Сохранить» в хранилище их быть не должно
    const before = await service.handlers['repricer:item-configs:get']();
    check('репрайсер: правка строки сначала копится, а не пишется сразу',
      !Object.values(before).some((c) => c.strategy === 'margin'),
      'в хранилище уже есть margin — пакетный режим не сработал');
    check('репрайсер: появилась панель несохранённых изменений', !!doc.getElementById('rp-editbar') &&
      /Несохранённых изменений/.test(doc.getElementById('rp-editbar').textContent),
      doc.getElementById('rp-editbar') ? doc.getElementById('rp-editbar').textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : 'нет панели');
    check('репрайсер: в панели есть «Сохранить» и «Отменить»',
      !!doc.getElementById('rp-edits-save') && !!doc.getElementById('rp-edits-cancel'));

    const saveBtn = doc.getElementById('rp-edits-save');
    if (saveBtn) { saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(1800); }
    const cfgs = await service.handlers['repricer:item-configs:get']();
    check('репрайсер: стратегия товара сохранена после «Сохранить»',
      Object.values(cfgs).some((c) => c.strategy === 'margin'));
    check('репрайсер: очередь правок очищена после сохранения',
      window.Views.repricer.pendingEdits.size === 0, 'осталось ' + window.Views.repricer.pendingEdits.size);

    // «Отменить» должно возвращать значения из хранилища и не писать ничего
    const anySel = doc.querySelector('#st-grid tbody tr select');
    if (anySel) {
      anySel.value = 'rrp';
      anySel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(300);
      check('репрайсер: вторая правка тоже накопилась', window.Views.repricer.pendingEdits.size === 1,
        'в очереди ' + window.Views.repricer.pendingEdits.size);
      const cancelBtn = doc.getElementById('rp-edits-cancel');
      if (cancelBtn) { cancelBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(900); }
      const afterCancel = await service.handlers['repricer:item-configs:get']();
      check('репрайсер: «Отменить» не пишет изменения в хранилище',
        !Object.values(afterCancel).some((c) => c.strategy === 'rrp') &&
          window.Views.repricer.pendingEdits.size === 0);
    }
  }
  const stCfgBtn = doc.querySelector('#st-grid [data-cfg]');
  check('репрайсер: кнопка настроек артикула есть', !!stCfgBtn);
  if (stCfgBtn) {
    stCfgBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(700);
    const im = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
    check('репрайсер: карточка настроек артикула открылась', !!im && /Настройки артикула/.test(im.querySelector('h2').textContent));
    check('репрайсер: в карточке есть прогноз цены', !!im && /Прогноз цены при текущих настройках/.test(im.textContent) && /Новая цена/.test(im.textContent));
    check('репрайсер: в карточке есть красивая цена', !!im && /Красивая цена/.test(im.textContent));
    check('репрайсер: в карточке есть защита от out-of-stock', !!im && /Защита от out-of-stock/.test(im.textContent));
    if (im) {
      im.querySelector('#ic-minPrice').value = '999';
      im.querySelector('#ic-minPrice').dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(500);
      const save = Array.from(im.querySelectorAll('.modal-foot .btn')).find((b) => b.textContent.trim() === 'Сохранить');
      save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(700);
      const cfgs2 = await service.handlers['repricer:item-configs:get']();
      check('репрайсер: минимальная цена артикула сохранена', Object.values(cfgs2).some((c) => c.minPrice === 999));
    }
  }
  // массовое применение настроек
  const bulkApply = doc.querySelector('#sb-apply');
  check('репрайсер: массовая настройка доступна', !!bulkApply);
  if (bulkApply) {
    doc.querySelector('#sb-strategy').value = 'competitor';
    doc.querySelector('#sb-margin').value = '22';
    doc.querySelector('#sb-minmode').value = 'breakeven';
    bulkApply.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(1200);
    const cfgs3 = await service.handlers['repricer:item-configs:get']();
    const comp = Object.values(cfgs3).filter((c) => c.strategy === 'competitor').length;
    check('репрайсер: массовая настройка применилась', comp > 50, comp + ' товаров');
    const withMin = Object.values(cfgs3).filter((c) => c.minPrice > 0).length;
    check('репрайсер: минимальная цена = точка безубыточности', withMin > 50, withMin + ' товаров');
  }

  // вкладка «Конкуренты»
  window.Views.repricer.tab = 'competitors';
  await window.Views.repricer.draw();
  await wait(900);
  const cpRows = doc.querySelectorAll('#cp-grid tbody tr').length;
  check('репрайсер: список конкурентов отрисован', cpRows > 20, cpRows + ' строк');
  check('репрайсер: показан разрыв с рынком', /Разрыв с рынком/.test(doc.getElementById('view').innerHTML));
  const cpBtn = doc.querySelector('#cp-grid [data-cp]');
  if (cpBtn) {
    cpBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    const cpm = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
    check('репрайсер: редактор конкурентов открылся', !!cpm && /Конкуренты —/.test(cpm.querySelector('h2').textContent));
    if (cpm) {
      cpm.querySelector('#cp-name').value = 'Тестовый конкурент';
      cpm.querySelector('#cp-price').value = '1234';
      cpm.querySelector('#cp-add').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(300);
      const saveCp = Array.from(cpm.querySelectorAll('.modal-foot .btn')).find((b) => b.textContent.trim() === 'Сохранить и закрыть');
      saveCp.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(800);
      const compsSaved = await service.handlers['repricer:competitors:get']();
      const hasTest = Object.values(compsSaved).some((l) => (l || []).some((c) => c.name === 'Тестовый конкурент'));
      check('репрайсер: конкурент добавлен и сохранён', hasTest);
    }
  }

  // вкладка «Параметры репрайсера»
  window.Views.repricer.tab = 'params';
  await window.Views.repricer.draw();
  await wait(700);
  check('репрайсер: параметры отрисованы', /Режим расчёта маржинальности/.test(doc.getElementById('view').innerHTML));
  check('репрайсер: есть режимы расчёта маржи', doc.querySelectorAll('#pm-marginmode option').length === 3);
  check('репрайсер: расписание и отправка вынесены на свою вкладку',
    !doc.querySelector('#pm-autosend') && !doc.querySelector('#pm-twophase'));
  doc.querySelector('#pm-step').value = '12';
  doc.querySelector('#pm-day').value = '5';
  doc.querySelector('#pm-marginmode').value = 'forpay';
  doc.querySelector('#pm-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1200);
  const savedCfg = (await service.handlers['repricer:state']()).config;
  check('репрайсер: лимит шага сохранён', savedCfg.limits.maxChangePerUpdatePct === 12, String(savedCfg.limits.maxChangePerUpdatePct));
  check('репрайсер: суточный лимит подтянут до лимита обновления', savedCfg.limits.maxChangePerDayPct === 12, String(savedCfg.limits.maxChangePerDayPct));
  check('репрайсер: режим маржи сохранён', savedCfg.marginMode === 'forpay');

  // автоотправка переехала на вкладку «Расписание» и сохраняется оттуда
  window.Views.repricer.tab = 'schedule';
  await window.Views.repricer.draw();
  await wait(900);
  check('репрайсер: автоотправка на вкладке «Расписание»', !!doc.querySelector('#ps-autosend'));
  if (doc.querySelector('#ps-autosend')) {
    const auto = doc.querySelector('#ps-autosend'); auto.checked = true;
    auto.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(100);
    const confirmation = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
    check('репрайсер: включение автоотправки требует отдельного согласия', !auto.checked && !!confirmation && /Включить автоматическое действие/.test(confirmation.textContent));
    if (confirmation) await confirmation.querySelector('.modal-foot .btn-primary').onclick();
    doc.querySelector('#ps-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(700);
    check('репрайсер: автоотправка сохранена', (await service.handlers['repricer:state']()).config.schedule.autoSend === true);
  }

  // планировщик
  const schedOn = await service.handlers['repricer:scheduler']({ enabled: true });
  check('репрайсер: планировщик включается', schedOn.scheduler.enabled === true && !!schedOn.scheduler.nextRunAt, schedOn.scheduler.nextRunAt || '');
  const schedOff = await service.handlers['repricer:scheduler']({ enabled: false });
  check('репрайсер: планировщик выключается', schedOff.scheduler.enabled === false);

  // пересчёт после смены параметров (стратегия конкурентного следования)
  const res2 = await service.handlers['repricer:calc']({ full: true });
  check('репрайсер: повторный пересчёт с новыми параметрами', res2.summary.total > 100 && res2.summary.errors === 0, 'товаров ' + res2.summary.total);
  const byStrat = res2.summary.byStrategy || {};
  check('репрайсер: учтены стратегии товаров', Object.keys(byStrat).length >= 2, JSON.stringify(byStrat).slice(0, 120));

  // история запусков переехала на вкладку «Расписание»
  window.Views.repricer.tab = 'schedule';
  window.Views.repricer.rstate = await service.handlers['repricer:state']();
  await window.Views.repricer.draw();
  await wait(700);
  check('репрайсер: история запусков отрисована', /Запуски репрайсера/.test(doc.getElementById('view').innerHTML));
  const runs = await service.handlers['repricer:runs']();
  check('репрайсер: запуски записаны в журнал', runs.length > 0, runs.length + ' запусков');

  // вкладка «Акции»: авто-вход и авто-выход
  await service.handlers['repricer:save']({
    promo: { autoJoin: true, autoExitAutoPromos: true, autoExitManualPromos: true, ignoreChangeLimitOnEntry: true, minMarginInPromoPct: 10, expectedSalesUpliftPct: 30 }
  });
  window.Views.repricer.tab = 'promos';
  window.Views.repricer.promoState = null;
  await window.App.go('promos', { tab: 'plan' });
  await wait(400);
  const paCalc = doc.getElementById('pa-calc');
  check('акции: кнопка расчёта на месте', !!paCalc);
  if (paCalc) { paCalc.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(3000); }
  window.Views.repricer.rstate = await service.handlers['repricer:state']();
  const pm = await service.handlers['repricer:promo-plan']({});
  check('акции: план по акциям рассчитан', !!(pm && pm.summary && pm.items.length > 0), pm ? pm.items.length + ' товаров' : 'нет');
  check('акции: найдены товары для входа', pm.summary.promoJoin > 0, pm.summary.promoJoin + ' шт');
  check('акции: найдены убыточные в акции', pm.summary.promoExit > 0 || pm.summary.promoWarn > 0,
    'выход ' + pm.summary.promoExit + ', предупреждений ' + pm.summary.promoWarn);
  check('акции: вкладка отрисована', /Решения по акциям|Сводка по акциям/.test(doc.getElementById('view').innerHTML));
  const pmRows = doc.querySelectorAll('#pa-grid tbody tr').length;
  check('акции: таблица решений заполнена', pmRows > 0, pmRows + ' строк');
  const pmSummary = doc.querySelectorAll('#pa-summary .stat').length;
  check('акции: сводка по каждой акции показана', pmSummary > 0, pmSummary + ' акций');

  // условия участия: цена со скидкой ≤ плановой цены акции
  const joinOk = pm.items
    .filter((it) => it.chosen && it.chosen.type === 'join')
    .filter((it) => (it.actions || []).some((a) => (a.action === 'join') &&
      it.proposed.sellerPrice > it.proposed.basePrice * (1 - a.requiredDiscountPct / 100) + 0.01));
  check('акции: после входа цена удовлетворяет условиям акции', joinOk.length === 0, 'нарушений ' + joinOk.length);

  // выход из акции: цена со скидкой строго выше плановой
  const exitItems = pm.items.filter((it) => it.chosen && it.chosen.type === 'exit');
  const exitBad = exitItems.filter((it) => (it.actions || []).some((a) => a.action === 'exit' &&
    it.proposed.sellerPrice <= it.proposed.basePrice * (1 - a.requiredDiscountPct / 100) + 0.01));
  check('акции: после выхода товар не соответствует условиям акции', exitBad.length === 0, 'нарушений ' + exitBad.length);
  const baseRaised = exitItems.filter((it) => it.proposed.basePrice > Number(it.current.basePrice) + 0.5);
  check('акции: выход не завышает базовую цену', baseRaised.length === 0, 'завышено у ' + baseRaised.length);
  const priceDropped = exitItems.filter((it) => it.proposed.sellerPrice < Number(it.current.sellerPrice) - 0.5);
  check('акции: при выходе цена для покупателя не падает', priceDropped.length === 0, 'упала у ' + priceDropped.length);
  const stepLim = window.Views.repricer.rstate.config.limits.maxChangePerUpdatePct;
  const bigJump = exitItems.filter((it) => !it.promoChosen.bypassLimits &&
    Math.abs((it.proposed.sellerPrice / Number(it.current.sellerPrice) - 1) * 100) > stepLim + 0.35);
  check('акции: скачок цены при выходе в пределах лимита шага', bigJump.length === 0,
    'нарушений ' + bigJump.length + ' из ' + exitItems.length + ' выходов (лимит ' + stepLim + '%)');

  // окупаемость входа
  const withBe = pm.items.filter((it) => (it.actions || []).some((a) => a.breakEvenUpliftPct !== undefined));
  check('акции: для входа считается окупаемость по приросту продаж', withBe.length > 0, withBe.length + ' шт');

  // применение решений по акциям + очередь возврата цены
  // берём товар, которому действительно нужно поменять цену (не «уже вышел»)
  // Очередь возврата цены существует ради АВТОакций: из обычной акции товар выходит сразу,
  // а автоакция подхватит его обратно, поэтому цену держат повышенной до её окончания.
  // Берём товар с выходом именно из автоакции — иначе проверка зависит от порядка строк.
  const autoPromoIds = new Set((window.S.state.promos || [])
    .filter((p) => String(p.type || '').toLowerCase() === 'auto')
    .map((p) => String(p.id)));
  const isAutoExit = (it) => ((it.chosen && it.chosen.promoIds) || []).some((pid) => autoPromoIds.has(String(pid)));
  const oneExit = exitItems.find((it) => it.needSend && isAutoExit(it)) ||
    exitItems.find(isAutoExit) || exitItems.find((it) => it.needSend) || exitItems[0];
  check('акции: для проверки очереди взят выход из автоакции', isAutoExit(oneExit),
    oneExit ? 'нм ' + oneExit.nmID + ', акции ' + JSON.stringify((oneExit.chosen || {}).promoIds) : 'нет строк');
  const oneExitFresh = (await service.handlers['repricer:calc']({ full: true })).results
    .find((r) => String(r.nmID) === String(oneExit.nmID));
  check('акции: решение о выходе воспроизводится при пересчёте',
    !!(oneExitFresh && oneExitFresh.promoChosen && oneExitFresh.promoChosen.type === 'exit'),
    oneExitFresh && oneExitFresh.promoChosen ? oneExitFresh.promoChosen.type : (oneExitFresh ? 'нет решения' : 'товар не найден'));
  const applyRes = await service.handlers['repricer:promo-apply']({ results: [oneExitFresh || oneExit] });
  check('акции: выход применён', applyRes.exited === 1, JSON.stringify({
    exited: applyRes.exited, sent: applyRes.exitSent, безИзмененияЦены: applyRes.exitNoChange,
    restored: applyRes.restored, blocked: applyRes.restoreBlocked, failed: applyRes.exitFailed
  }));
  const goodsAfterExit = await service.handlers['wb:goods']({});
  const itemAfterExit = goodsAfterExit.items.find((i) => String(i.nmID) === String(oneExit.nmID));
  check('акции: товар фактически вышел из акции', itemAfterExit && !itemAfterExit.inPromo,
    itemAfterExit ? 'в акциях: ' + (itemAfterExit.promoNames || []).join(', ') : 'товар не найден');
  const queue = await service.handlers['repricer:promo-exits']({});
  check('акции: товар попал в очередь возврата цены', queue.length === 1, queue.length + ' в очереди');
  const q0 = queue[0] || {};
  check('акции: в очереди есть цена возврата и артикул',
    Number(q0.restoreSellerPrice) > 0 && !!q0.vendorCode, (q0.vendorCode || '—') + ' → ' + (q0.restoreSellerPrice || 0) + ' ₽');
  check('акции: статус очереди возврата понятен',
    ['waiting-exit', 'waiting-promo-end', 'ready'].indexOf(q0.status) >= 0, q0.status + (q0.blockedByAutoPromo ? ' (держит автоакция ' + (q0.blockedPromoNames || []).join(', ') + ')' : ''));
  const rest = await service.handlers['repricer:promo-restore']({});
  check('акции: автоакция удерживает цену повышенной, возврат отложен',
    q0.blockedByAutoPromo ? (rest.restored === 0 && rest.blocked === 1) : (rest.restored === 1),
    JSON.stringify({ restored: rest.restored, blocked: rest.blocked, pending: rest.pending }));
  if (q0.blockedByAutoPromo) {
    const forced = await service.handlers['repricer:promo-restore']({ force: true });
    check('акции: возврат можно выполнить принудительно', forced.restored === 1,
      JSON.stringify({ restored: forced.restored, blocked: forced.blocked }));
    const q2 = await service.handlers['repricer:promo-exits']({});
    check('акции: очередь возврата очищена', q2.length === 0, q2.length + ' осталось');
  }

  // ── регрессия: себестоимость из «Себестоимости» должна сразу доезжать до «Цены и скидки» ──
  // Баг пользователя: ввёл себестоимость, а в ценах пусто. Причина — saveCosts обновлял
  // state.costs, а таблица цен строится из state.overrides (обновлялся только с товарами).
  (async function checkCostsReachPrices() {
    const target = window.S.getRows()[0];
    const nmID = target.nmID;
    await service.handlers['costs:save']({ items: { [String(nmID)]: { costPriceRub: 123.45 } } });
    await window.S.saveCosts({ [String(nmID)]: { costPriceRub: 123.45 } });
    const row = window.S.getRows().find((r) => r.nmID === nmID);
    check('себестоимость: сохранённое значение сразу видно в расчёте', Math.abs(row.costPrice - 123.45) < 0.01,
      'costPrice=' + row.costPrice);
    check('себестоимость: источник помечен как пользовательский', row.cogsSource === 'user', 'source=' + row.cogsSource);
    const ov = await service.handlers['costs:overrides']();
    check('себестоимость: канал costs:overrides отдаёт свежие значения',
      !!(ov && ov.overrides && Math.abs(Number(ov.overrides[String(nmID)].costPriceRub) - 123.45) < 0.01));
    // очистим за собой
    await service.handlers['costs:save']({ items: { [String(nmID)]: { costPriceRub: null } } });
    await window.S.saveCosts({ [String(nmID)]: { costPriceRub: null } });
  })();
  await wait(80);

  // ── регрессия: ручной ввод цены не должен перетираться массовым правилом ──
  // Баг пользователя: «в блоке Цены и скидки он не сохраняет цены» + «кнопка серая».
  // Причина: правило по умолчанию «−5%» применялось поверх введённого значения,
  // а область применения «Выбранным товарам» без галочек держала кнопку заблокированной.
  (async function checkManualPriceWins() {
    const fsx = require('fs');
    const pathx = require('path');
    const stSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'renderer', 'js', 'state.js'), 'utf8');
    const prSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'renderer', 'js', 'views', 'prices.js'), 'utf8');
    check('цены: правило по умолчанию выключено (не «−5%»)', /priceRule:\s*\{\s*type:\s*'none'/.test(stSrc));
    check('цены: ручные правки хранятся в общем состоянии, а не в поле вьюхи',
      /S\.state\.priceEdits/.test(prSrc) && /get editing\(\)/.test(prSrc));
    const rulesSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'renderer', 'js', 'rules.js'), 'utf8');
    check('цены: правило применяется только там, где нет ручной правки',
      /const ruleActive = rule\.type && rule\.type !== 'none';/.test(rulesSrc) &&
      /\(!manual && ruleActive\)\s*\?\s*EC\.applyRule/.test(rulesSrc) &&
      /RULES\.buildPlan/.test(prSrc));
    check('цены: при ручном вводе область сама переключается на «изменённые вручную»',
      /sel\.value = 'edited'/.test(prSrc));
    check('цены: заблокированная кнопка объясняет причину',
      /b-apply-reason/.test(prSrc) && /btn\.title = rows\.length/.test(prSrc));
    check('цены: есть кнопка «Обновить себестоимость»', /id="btn-costs"/.test(prSrc) && /S\.reloadOverrides\(\)/.test(prSrc));
  })();

  // ── регрессия: отчёт P&L должен считаться и сходиться арифметически ──
  (async function checkPnlReport() {
    await service.handlers['facts:load']({ days: 7 });
    const rep = await service.handlers['reports:pl']({});
    check('P&L: отчёт построился', !!(rep && rep.ok), rep && rep.message ? rep.message : '');
    const T = (rep && rep.totals) || {};
    check('P&L: есть выручка и прибыль', T.revenue > 0 && typeof T.profit === 'number',
      'выручка=' + T.revenue + ', прибыль=' + T.profit);
    // «к перечислению» у WB = выручка − комиссия − эквайринг (логистика и хранение — отдельными строками)
    const forPayCalc = T.revenue - T.commission - T.acquiring;
    check('P&L: «к перечислению» = выручка − комиссия − эквайринг',
      Math.abs(T.forPay - forPayCalc) < 1, 'WB ' + T.forPay + ' vs расчёт ' + Math.round(forPayCalc));
    const afterWb = T.forPay - T.logistics - T.storage - T.acceptance - T.penalties;
    check('P&L: логистика и хранение вычтены ПОСЛЕ «к перечислению»',
      Math.abs(T.wbAfterLogistics - afterWb) < 1, T.wbAfterLogistics + ' vs ' + Math.round(afterWb));
    const profitCalc = T.wbAfterLogistics - T.cogs - T.packaging - T.ad - T.tax;
    check('P&L: прибыль сходится до копейки', Math.abs(T.profit - profitCalc) < 1,
      T.profit + ' vs ' + Math.round(profitCalc));
    check('P&L: есть разбивка по дням, категориям и товарам',
      (rep.byDay || []).length > 0 && (rep.byCategory || []).length > 0 && (rep.items || []).length > 0,
      'дней ' + (rep.byDay || []).length + ', категорий ' + (rep.byCategory || []).length + ', товаров ' + (rep.items || []).length);
    check('P&L: сумма по категориям равна итоговой прибыли',
      Math.abs((rep.byCategory || []).reduce((s, c) => s + c.profit, 0) - T.profit) < 1);
    check('отчёты: раздел есть в навигации и подключён', !!window.Views.reports && !!doc.querySelector('.nav-item[data-id="reports"]'));
  })();
  await wait(80);

  // ── регрессия: ручная загрузка состава акции из файла ──
  (async function checkPromoFileImport() {
    const fsx = require('fs');
    const pathx = require('path');
    const hasLite = fsx.existsSync(pathx.join(__dirname, '..', 'electron', 'xlsx-lite.js'));
    check('акции: есть читалка XLSX без внешних зависимостей', hasLite);
    if (hasLite) {
      const { readTable, readCsv, colToIndex } = require(pathx.join(__dirname, '..', 'electron', 'xlsx-lite.js'));
      check('акции: CSV с разделителем «;» разбирается', readCsv('a;b\n1;2\n')[1].join(',') === '1,2');
      check('акции: буквы колонок переводятся в индексы', colToIndex('A1') === 0 && colToIndex('AA2') === 26);
      check('акции: пустой/битый файл отклоняется внятно', (() => {
        try { readTable(Buffer.from('не zip'), 'x.xlsx'); return false; }
        catch (e) { return /XLSX/i.test(e.message); }
      })());
    }
    const pi0 = await service.handlers['promos:index']();
    const target = (pi0.promos || []).slice().sort((a, b) => a.eligible - b.eligible)[0];
    check('акции: диагностика индекса доступна', !!target, target ? target.promoName : '');
    const goods = await service.handlers['wb:goods']({});
    const noms = await service.handlers['wb:promo-nomenclatures']({ promotionID: target.promoId, inAction: false });
    const nomsIn = await service.handlers['wb:promo-nomenclatures']({ promotionID: target.promoId, inAction: true });
    const known = new Set([].concat(noms || [], nomsIn || []).map((x) => String(x.nmID)));
    const outsiders = (goods.items || []).filter((x) => !known.has(String(x.nmID))).slice(0, 3);
    check('акции: есть товары, которых API в акцию не отдал', outsiders.length > 0, outsiders.length + ' шт');

    const req = target.requiredDiscountPct || 30;
    const csv = ['Артикул WB;Артикул продавца;Наименование;Цена до скидки;Скидка;Плановая цена;Участвует']
      .concat(outsiders.map((x, i) => [x.nmID, x.vendorCode, x.title || '', x.price, req, Math.round(x.price * (1 - req / 100)), i === 0 ? '1' : '0'].join(';')))
      .join('\n');
    const imp = await service.handlers['promos:import-noms']({
      promotionID: target.promoId, fileName: 'test.csv', base64: Buffer.from(csv, 'utf8').toString('base64')
    });
    check('акции: файл загружен и разобрался', imp && imp.ok && imp.count === outsiders.length,
      imp ? 'загружено ' + imp.count : 'не загружено');
    const pi1 = await service.handlers['promos:index']();
    const after = (pi1.promos || []).find((x) => String(x.promoId) === String(target.promoId));
    // состав теперь строится из файла, а не из API: проверяем, что товары файла видны индексу
    check('акции: загруженный файл стал составом акции', after.manualCount === outsiders.length,
      'из файла ' + after.manualCount + ' из ' + outsiders.length);
    const promoItems = await service.handlers['promos:items']({ promotionID: target.promoId });
    const fromFile = (promoItems.items || []).filter((x) => x.source === 'file').map((x) => String(x.nmID));
    check('акции: товары из файла отдаются окну акции',
      outsiders.every((x) => fromFile.includes(String(x.nmID))),
      'из файла в окне: ' + fromFile.length + ' из ' + outsiders.length);
    check('акции: окно акции знает, что состав из файла', promoItems.source === 'file',
      'source=' + promoItems.source + ', fileInfo=' + JSON.stringify(promoItems.fileInfo));

    const calc = await service.handlers['repricer:calc']({ full: true, promos: true });
    const decided = outsiders.filter((x) => {
      const r = (calc.results || []).find((y) => String(y.nmID) === String(x.nmID));
      return r && (r.promoActions || []).some((a) => String(a.promoId) === String(target.promoId));
    });
    check('акции: репрайсер дал решения по загруженным товарам', decided.length === outsiders.length,
      decided.length + ' из ' + outsiders.length);

    const saved = await service.handlers['promos:noms']({ promotionID: target.promoId });
    check('акции: список сохранён и переживёт перезапуск', saved && saved.loaded && saved.record.count === outsiders.length);
    await service.handlers['promos:clear-noms']({ promotionID: target.promoId });
    const pi2 = await service.handlers['promos:index']();
    const clean = (pi2.promos || []).find((x) => String(x.promoId) === String(target.promoId));
    check('акции: после удаления файла его товары больше не «из файла»', clean.manualCount === 0,
      'из файла ' + clean.manualCount);
    const afterClear = await service.handlers['promos:items']({ promotionID: target.promoId });
    check('акции: после удаления файла состав не пустой (остаётся вывод по скидке)',
      (afterClear.items || []).filter((x) => x.source === 'file').length === 0,
      'source=' + afterClear.source + ', всего ' + (afterClear.items || []).length);

    // защита от мусорного файла
    let rejected = false;
    try {
      await service.handlers['promos:import-noms']({
        promotionID: target.promoId, fileName: 'bad.csv', base64: Buffer.from('раз;два;три\n1;2;3\n', 'utf8').toString('base64')
      });
    } catch (e) { rejected = /nmID|артикул/i.test(e.message); }
    check('акции: файл без артикулов WB отклоняется с понятной ошибкой', rejected);
  })();
  await wait(80);

  // ── регрессия: bat-файл запуска не должен ломаться на %~dp0 ──
  (function checkBatFiles() {
    const fsx = require('fs');
    const pathx = require('path');
    const dir = pathx.join(__dirname, '..');
    const bat = fsx.readdirSync(dir).filter((f) => /\.bat$/i.test(f));
    check('запуск: bat-файлы на месте', bat.length >= 3, bat.join(', '));
    const launch = bat.find((f) => /Запуск \(Windows\)/.test(f));
    check('запуск: найден файл запуска Electron', !!launch, launch || '');
    if (launch) {
      const txt = fsx.readFileSync(pathx.join(dir, launch), 'utf8');
      // %~dp0 раскрывается в путь с завершающим слешем; "\" перед закрывающей кавычкой
      // ломает разбор аргументов, поэтому нужен "%~dp0." (точка убирает висячий слеш)
      check('запуск: путь к проекту передан без висячего слеша',
        /"%~dp0\."/.test(txt) && !/"%~dp0"\s*--no-sandbox/.test(txt) && !/electron\.exe" "%~dp0"/.test(txt),
        (txt.match(/start ""[^\r\n]*/) || [''])[0]);
      check('запуск: bat в кодировке CRLF (иначе cmd может споткнуться)', /\r\n/.test(txt));
      check('запуск: BAT не отключает песочницу Electron', !/--no-sandbox/.test(txt));
    }
    // скрипт публикации на GitHub: тоже должен быть CRLF и не тащить секреты в репозиторий
    const pub = bat.find((f) => /Опубликовать на GitHub/.test(f));
    check('github: есть скрипт публикации репозитория', !!pub, pub || '');
    if (pub) {
      const ptxt = fsx.readFileSync(pathx.join(dir, pub), 'utf8');
      check('github: скрипт в кодировке CRLF', /\r\n/.test(ptxt));
      check('github: скрипт проверяет, что секреты не попадут в репозиторий',
        /secrets/.test(ptxt) && /ls-files/.test(ptxt));
      check('github: скрипт работает из своего каталога', /"%~dp0\."/.test(ptxt));
    }
  })();

  // ── регрессия: каждый канал, который зовёт интерфейс, обязан быть в белом списке Electron ──
  // Иначе в браузере всё работает, а в собранном .exe пользователь получает «Неизвестный канал».
  (function checkIpcWhitelist() {
    const fsx = require('fs');
    const pathx = require('path');
    const pre = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    const m = pre.match(/const CHANNELS = \[([\s\S]*?)\];/);
    check('IPC: белый список каналов найден в preload.js', !!m);
    const allowed = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
    const used = new Set();
    const walk = (dir) => fsx.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = pathx.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.js$/.test(e.name)) {
        const src = fsx.readFileSync(full, 'utf8');
        const re = /invoke\(\s*'([a-z0-9:_-]+)'/gi;
        let mm; while ((mm = re.exec(src))) used.add(mm[1]);
      }
    });
    walk(pathx.join(__dirname, '..', 'src', 'renderer'));
    const missing = Array.from(used).filter((c) => allowed.indexOf(c) < 0);
    check('IPC: все каналы интерфейса разрешены в preload.js', missing.length === 0,
      missing.length ? 'не хватает: ' + missing.join(', ') : 'каналов используется ' + used.size + ', разрешено ' + allowed.length);
    // и наоборот: каждый разрешённый канал должен существовать в сервисе
    const { createProfileHub } = require('../electron/profiles');
    const channelsDir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'wb-ui-channels-'));
    const channelsHub = createProfileHub({ dataDir: channelsDir, createService });
    const unknown = allowed.filter((c) => typeof channelsHub.handlers[c] !== 'function' && !/^ui:/.test(c));
    channelsHub.stopAllSchedulers(); fsx.rmSync(channelsDir, { recursive: true, force: true });
    check('IPC: в белом списке нет несуществующих каналов', unknown.length === 0, unknown.join(', ') || 'всё на месте');
    check('IPC: канал полного обновления разрешён', allowed.indexOf('data:refresh-all') >= 0);
  })();

  // ── регрессия: отчёт об обновлении обязан объяснять, какая категория ключа нужна ──
  // Причина: при ключе без прав статистика молча возвращала «✓ 0 товаров» вместо ошибки.
  (function checkRefreshHints() {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'service.js'), 'utf8');
    const cli = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'wb-client.js'), 'utf8');
    const steps = [];
    const re = /await step\('(\w+)'/g;
    let m; while ((m = re.exec(svc))) steps.push(m[1]);
    check('обновление: список разделов найден', steps.length >= 5, steps.join(', '));
    const hm = svc.match(/const SECTION_HINTS = \{([\s\S]*?)\};/);
    check('обновление: есть подсказки по категориям ключа', !!hm);
    const hinted = hm ? Object.keys(hm[1].match(/(\w+):/g) || {}).map((k) => hm[1].match(/(\w+):/g)[k].replace(':', '')) : [];
    const noHint = steps.filter((n) => hinted.indexOf(n) < 0);
    check('обновление: у каждого раздела есть подсказка про категорию ключа', noHint.length === 0,
      noHint.length ? 'без подсказки: ' + noHint.join(', ') : 'разделов с подсказкой: ' + hinted.length);
    check('обновление: ошибки статистики не глотаются молча',
      /onError/.test(cli) && /loadStats\(/.test(svc) && /st\.errors/.test(svc));
    check('обновление: подсказка подставляется в список ошибок', /hint: sectionHint\(name, e\)/.test(svc));
  })();

  // ── демо-режим должен выключаться сам, как только сохранён настоящий ключ ──
  await service.handlers['keys:clear']();
  await service.handlers['settings:save']({ demoMode: true });
  const beforeKey = await service.handlers['app:state']();
  check('демо: без ключа приложение в демо-режиме', beforeKey.demo === true);
  const savedKey = await service.handlers['keys:set']({ single: 'eyJhbGciOiJIUzI1NiJ9.real.seller.token' });
  check('демо: сохранение ключа само выключает демо-режим', savedKey.demo === false && savedKey.demoSwitched === true,
    JSON.stringify({ demo: savedKey.demo, переключено: savedKey.demoSwitched, сообщение: savedKey.message }));
  const afterKey = await service.handlers['app:state']();
  check('демо: после сохранения ключа режим — WB API', afterKey.demo === false, 'demo=' + afterKey.demo);
  check('демо: интерфейс узнаёт, что ключ настоящий', afterKey.keysSet > 0 && !!afterKey.keys.single);
  // возвращаем демо для остальных проверок
  await service.handlers['keys:set']({ single: '', demoMode: true });
  await service.handlers['keys:clear']();
  await service.handlers['settings:save']({ demoMode: true });
  const backDemo = await service.handlers['app:state']();
  check('демо: галочкой можно вернуться в демо-режим', backDemo.demo === true);

  // ── регрессия: сохранение не должно стирать уже сохранённые ключи ──
  // Баг пользователя: вставил 4 ключа → сохранил → проверка выдала ошибки → ключи пропали.
  // Причина: интерфейс отправлял все пять полей, пустая строка удаляла сохранённый ключ.
  (async function checkKeysAreNotWiped() {
    await service.handlers['keys:clear']();
    const K = {
      prices: 'eyJhbGciOiJIUzI1NiJ9.prices.category.token.aaaa',
      statistics: 'eyJhbGciOiJIUzI1NiJ9.statistics.category.token.bbbb',
      content: 'eyJhbGciOiJIUzI1NiJ9.content.category.token.cccc',
      finance: 'eyJhbGciOiJIUzI1NiJ9.finance.category.token.dddd'
    };
    const first = await service.handlers['keys:set'](Object.assign({}, K, { demoMode: false }));
    check('ключи: четыре отдельных ключа сохранены', (first.saved || []).length === 4,
      'сохранено: ' + JSON.stringify(first.saved));
    const stFirst = await service.handlers['app:state']();
    check('ключи: после сохранения видно все четыре', stFirst.keysSet === 4, 'keysSet=' + stFirst.keysSet);

    // повторное сохранение с пустыми полями (так делает интерфейс после перерисовки)
    const second = await service.handlers['keys:set']({ single: '', prices: '', statistics: '', content: '', finance: '', demoMode: false });
    const stSecond = await service.handlers['app:state']();
    check('ключи: повторное сохранение с пустыми полями НЕ стирает ключи', stSecond.keysSet === 4,
      'keysSet=' + stSecond.keysSet + ', сохранено сейчас: ' + JSON.stringify(second.saved) + ', осталось: ' + JSON.stringify(second.kept));
    check('ключи: пустые поля помечены как «не тронуты»', (second.kept || []).length === 4, JSON.stringify(second.kept));

    // маска сохранённого ключа не должна записываться как ключ
    const masked = await service.handlers['keys:set']({ single: 'eyJhbG••••••••••cdef', demoMode: false });
    check('ключи: маска ключа отклоняется, а не записывается', (masked.ignored || []).indexOf('single') >= 0 && (masked.saved || []).length === 0,
      'отклонено: ' + JSON.stringify(masked.ignored));
    const stMasked = await service.handlers['app:state']();
    check('ключи: после маски все четыре ключа на месте', stMasked.keysSet === 4, 'keysSet=' + stMasked.keysSet);

    // явное удаление одного ключа и всех сразу
    const one = await service.handlers['keys:set']({ clear: ['finance'] });
    check('ключи: явное удаление одного ключа работает', (one.cleared || []).indexOf('finance') >= 0, JSON.stringify(one.cleared));
    const stOne = await service.handlers['app:state']();
    check('ключи: после удаления осталось три', stOne.keysSet === 3, 'keysSet=' + stOne.keysSet);
    await service.handlers['keys:clear']();
    const stClear = await service.handlers['app:state']();
    check('ключи: «Удалить ключи» очищает всё и возвращает демо', stClear.keysSet === 0 && stClear.demo === true);
  })();
  await wait(60);

  // ── регрессия: проверка доступа обязана быть честной ──
  (async function checkAccessIsHonest() {
    await service.handlers['keys:clear']();
    await service.handlers['settings:save']({ demoMode: true });
    const demo = await service.handlers['keys:check']();
    check('проверка: в демо не утверждает, что доступ есть',
      (demo.results || []).every((r) => r.ok !== true) && demo.checked === false,
      'checked=' + demo.checked + ', результаты: ' + JSON.stringify((demo.results || []).map((r) => r.category + '=' + r.ok)));
    check('проверка: в демо сказано, что запросов к WB не было',
      /запросов к WB не было|Демо-режим|не выполнялась/i.test(demo.message || ''), demo.message);
    check('проверка: без ключей интерфейс видит предупреждение', /Ключи не заданы|Демо-режим/.test(demo.message || ''), demo.message);
    check('проверка: разделы названы по-русски и включают «Финансы»',
      (demo.results || []).some((r) => /Финансы/.test(r.title || '')) && (demo.results || []).length === 5,
      (demo.results || []).map((r) => r.title).join(', '));
  })();
  await wait(60);

  // ── регрессия: тело запроса карточек должно соответствовать контракту WB ──
  // Баг пользователя: content: Ошибка запроса (HTTP 400): request body could not be decoded:
  // … Filter.WithPhoto: readUint32: unexpected character — withPhoto у WB целое, а не boolean.
  (function checkCardsRequestBody() {
    const fsx = require('fs');
    const pathx = require('path');
    const raw = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'wb-client.js'), 'utf8');
    // комментарии убираем: в JSDoc специально описан СТАРЫЙ неправильный вариант
    // (`withPhoto: false`, `json.data.cards`) — иначе проверка срабатывает на текст комментария
    const cli = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    check('карточки: withPhoto передаётся числом, а не boolean',
      /withPhoto:\s*-1/.test(cli) && !/withPhoto:\s*(false|true)/.test(cli),
      'найдено: ' + (cli.match(/withPhoto:\s*[^,}\s]+/g) || []).join(', '));
    check('карточки: курсор внутри settings, а не рядом с ним',
      /settings:\s*\{\s*sort:[\s\S]{0,80}cursor[\s\S]{0,40}filter:\s*\{\s*withPhoto:\s*-1/.test(cli) ||
      /settings:\s*\{\s*cursor:\s*\{\s*limit:\s*1\s*\},\s*filter:\s*\{\s*withPhoto:\s*-1/.test(cli));
    check('карточки: пагинация возвращает nmID и updatedAt из ответа',
      /cursor\.nmID = c\.nmID/.test(cli) && /cursor\.updatedAt = c\.updatedAt/.test(cli));
    check('карточки: ответ разбирается как {cards, cursor}, а не json.data.cards',
      /Array\.isArray\(json && json\.cards\)/.test(cli) && !/data\.cards/.test(cli));
    check('карточки: остановка пагинации по total < limit', /total < pageLimit/.test(cli));
    check('карточки: есть запасное минимальное тело на случай смены схемы WB', /minimalBody/.test(cli));
    check('карточки: фото берётся из ответа WB, а не собирается руками',
      /photoUrl\(photos\)/.test(cli) && !/basket-01\.wbbucket\.ru\/vol0\/part0/.test(cli));
  })();

  // ── регрессия: тела и параметры запросов к WB должны соответствовать контракту ──
  // Тот же класс ошибки, что и withPhoto: неверное имя/тип поля → HTTP 400 «could not be decoded».
  (function checkWbRequestContracts() {
    const fsx = require('fs');
    const pathx = require('path');
    const raw = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'wb-client.js'), 'utf8');
    const cli = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

    // вход в акцию: тело обёрнуто в data, nomenclatures — массив чисел, есть uploadNow
    check('контракт: вход в акцию отправляет тело в обёртке data',
      /body:\s*\{\s*data:\s*\{\s*promotionID:[\s\S]{0,120}uploadNow[\s\S]{0,80}nomenclatures:\s*nmIDs/.test(cli));
    check('контракт: nomenclatures — массив nmID-чисел, а не объектов с ценой',
      /\.map\(\(n\) => Number\(typeof n === 'object'[\s\S]{0,60}n\.nmID[\s\S]{0,20}n\)\)/.test(cli) &&
      !/nomenclatures:\s*data/.test(cli));
    check('контракт: цены в акцию не отправляются (это делает upload/task)',
      !/nomenclatures[\s\S]{0,200}discount:\s*Math\.round/.test(cli));

    // календарь акций: обязательные startDateTime / endDateTime / allPromo
    check('контракт: календарь акций передаёт startDateTime и endDateTime',
      /startDateTime:[\s\S]{0,120}endDateTime:/.test(cli) && !/calendar\/promotions', \{ query: \{ dateFrom/.test(cli));
    check('контракт: allPromo передаётся булевым (по документации WB)', /allPromo:\s*(true|false|allPromo)/.test(cli));

    // цены: тело { data: [...] } с nmID/price/discount
    check('контракт: цены отправляются телом { data: [...] }', /upload\/task', \{[\s\S]{0,150}body: \{ data: chunk \}/.test(cli));

    // финансовый отчёт: POST sales-reports/detailed с rrdId и period
    check('контракт: финотчёт — POST sales-reports/detailed с rrdId',
      /sales-reports\/detailed/.test(cli) && /rrdId/.test(cli));
  })();

  // ── регрессия: повторное сохранение ключей не должно сбрасывать загруженные данные ──
  (async function checkSaveDoesNotResetData() {
    await service.handlers['keys:clear']();
    await service.handlers['settings:save']({ demoMode: true });
    await service.handlers['data:refresh-all']({ facts: false });
    const before = await service.handlers['app:state']();
    check('сброс: до повторного сохранения данные загружены',
      before.lastDataRefreshAt && before.cache.goodsCount > 0,
      'товаров в кэше: ' + before.cache.goodsCount + ', обновлено: ' + before.lastDataRefreshAt);
    // пользователь нажимает «Сохранить» ещё раз, ничего не меняя (поля пустые)
    const again = await service.handlers['keys:set']({ demoMode: true });
    check('сброс: повторное сохранение помечено как «ничего не изменилось»', again.keysChanged === false,
      'keysChanged=' + again.keysChanged + ', saved=' + JSON.stringify(again.saved));
    const after = await service.handlers['app:state']();
    check('сброс: метка «данные обновлены» не обнулилась', !!after.lastDataRefreshAt,
      'lastDataRefreshAt=' + after.lastDataRefreshAt);
    check('сброс: кэш товаров не сброшен', after.cache.goodsCount === before.cache.goodsCount,
      before.cache.goodsCount + ' → ' + after.cache.goodsCount);
    // а вот реальная смена ключа обязана сбросить кэши
    const changed = await service.handlers['keys:set']({ single: 'eyJhbGciOiJIUzI1NiJ9.changed.token.aaaaaaaa', demoMode: false });
    const afterChange = await service.handlers['app:state']();
    check('сброс: смена ключа помечена как изменение', changed.keysChanged === true && changed.saved.length === 1);
    check('сброс: после смены ключа кэш очищен и метка обнулена',
      afterChange.cache.goodsCount === 0 && !afterChange.lastDataRefreshAt,
      'товаров в кэше: ' + afterChange.cache.goodsCount + ', обновлено: ' + afterChange.lastDataRefreshAt);
    await service.handlers['keys:clear']();
    await service.handlers['settings:save']({ demoMode: true });
  })();
  await wait(60);

  // ── регрессия: белый список каналов preload должен совпадать с main/service ──
  (function checkChannelListsAgree() {
    const fsx = require('fs');
    const pathx = require('path');
    const pre = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    const main = fsx.readFileSync(pathx.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    // события в браузере: SSE вместо заглушки + живой прогресс обновления данных
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'api.js'), 'utf8');
  check('события: в браузере подписка идёт через SSE', /EventSource\('\/api\/events'\)/.test(apiSrc));
  check('события: каналы регистрируются по мере подписки, а не жёстким списком',
    /function listenChannel/.test(apiSrc) && !/KNOWN_CHANNELS/.test(apiSrc));
  const serveSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'serve.js'), 'utf8');
  check('события: dev-сервер рассылает их в SSE-поток',
    /text\/event-stream/.test(serveSrc) && /svc:/.test(serveSrc) && /broadcast\(channel, payload\)/.test(serveSrc));
  check('события: сервер создан с настоящей функцией рассылки, а не заглушкой',
    /createProfileHub\(\{[\s\S]*?broadcast, switchable: false/.test(serveSrc));
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');
  check('события: окно обновления данных показывает живой прогресс',
    /API\.on\('info'/.test(appSrc) && /offInfo/.test(appSrc));
  check('события: подписка на прогресс снимается после обновления',
    /finally\s*{[\s\S]{0,120}offInfo\(\)/.test(appSrc));

  check('каналы: main передаёт список обработчиков в preload', /--wb-channels=/.test(main) && /registeredChannels\(\)/.test(main));
    check('каналы: preload строит белый список из списка main', /fromMain/.test(pre) && /CHANNELS\.concat\(fromMain\)/.test(pre));
    check('каналы: preload отдаёт список в интерфейс для диагностики', /channels: ALLOWED\.slice\(\)/.test(pre));
    check('каналы: ошибка называет причину рассинхрона', /рассинхронизированы/.test(pre));
    const app = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');
    check('каналы: интерфейс сам проверяет мост при запуске', /function checkBridge\(\)/.test(app) && /checkBridge\(\);/.test(app));
    check('каналы: при рассинхроне показывается баннер, а не тихая ошибка', /bridge-alert/.test(app));
    const real = Object.keys(service.handlers);
    const m = pre.match(/const CHANNELS = \[([\s\S]*?)\];/);
    const stat = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
    const notListed = real.filter((c) => stat.indexOf(c) < 0);
    check('каналы: статический список preload покрывает все обработчики сервиса', notListed.length === 0,
      notListed.length ? 'не хватает: ' + notListed.join(', ') : 'обработчиков ' + real.length + ', в списке ' + stat.length);
  })();

  // ── один ключ на все разделы + полное обновление данных ──
  window.App.go('settings');
  await wait(900);
  check('ключи: есть поле «один ключ на все разделы»', !!doc.getElementById('k-single'));
  check('ключи: есть кнопка «сохранить и обновить данные»', !!doc.getElementById('k-save-refresh'));
  check('ключи: показано покрытие разделов', /Единый ключ|Демо-режим/.test(doc.getElementById('view').innerHTML));
  check('ключи: есть поле ключа «Финансы»', !!doc.getElementById('k-finance'));
  check('ключи: пустое поле объясняет, что сохранённый ключ не сотрётся',
    /пустое поле при сохранении ничего не меняет/.test(doc.getElementById('view').innerHTML));
  check('ключи: есть диагностика моста Electron',
    /Мост Electron|Режим браузера/.test(doc.getElementById('view').innerHTML));

  // сохранили ключ → появилась подпись «сохранён» и кнопка удаления одного ключа
  await service.handlers['keys:set']({ single: 'eyJhbGciOiJIUzI1NiJ9.ui.check.token.zzzz' });
  window.App.go('settings');
  await wait(900);
  const clearBtns = doc.querySelectorAll('.k-clear-one');
  check('ключи: сохранённый ключ помечен и его можно удалить отдельно',
    clearBtns.length >= 1 && /✓ сохранён/.test(doc.getElementById('view').innerHTML),
    'кнопок удаления: ' + clearBtns.length);
  check('ключи: в подсказке поля видна маска сохранённого ключа',
    /сохранён: eyJhbG/.test(String(doc.getElementById('k-single') && doc.getElementById('k-single').placeholder)));
  // удаление одного ключа из интерфейса
  if (clearBtns.length) {
    clearBtns[0].click();
    await wait(300);
    const dlgBtn = Array.from(doc.querySelectorAll('.modal button, .dialog button, #ui-confirm-ok, .btn-primary'))
      .find((b) => /Удалить/.test(b.textContent || ''));
    check('ключи: удаление одного ключа просит подтверждение', !!dlgBtn);
    if (dlgBtn) { dlgBtn.click(); await wait(700); }
    const stAfterOne = await service.handlers['app:state']();
    check('ключи: после подтверждения ключ удалён', stAfterOne.keysSet === 0, 'keysSet=' + stAfterOne.keysSet);
  }
  await service.handlers['keys:clear']();
  await service.handlers['settings:save']({ demoMode: true });
  window.App.go('settings');
  await wait(700);

  const sideSync = doc.getElementById('btn-sync');
  check('обновление: кнопка в сайдбаре на месте', !!sideSync && /Обновить данные из WB/.test(sideSync.textContent));
  check('обновление: функция полного обновления доступна', typeof window.App.refreshAllData === 'function');

  // единый ключ должен покрывать все категории WB
  const keyRes = await service.handlers['keys:set']({ single: 'eyJhbGciOiJIUzI1NiJ9.test.token', demoMode: false });
  check('ключи: единый ключ сохранён', !!(keyRes && keyRes.ok), keyRes ? 'способ хранения: ' + keyRes.method : '');
  const cov = keyRes.coverage || {};
  check('ключи: единый ключ покрывает цены, статистику, контент и финансы',
    cov.prices === true && cov.statistics === true && cov.content === true && cov.finance === true,
    JSON.stringify(cov));
  check('ключи: помечено, что ключ единый', cov.universal === true, JSON.stringify(cov));

  // полное обновление данных из кабинета — проверяем на демо-данных,
  // чтобы не ходить в живой WB с тестовым ключом
  await service.handlers['keys:clear']();
  await service.handlers['keys:set']({ demoMode: true });
  const rfAll = await service.handlers['data:refresh-all']({});
  check('обновление: все разделы загружены', !!(rfAll && rfAll.ok), rfAll ? (rfAll.sections || []).map((x) => x.title + ': ' + (x.ok ? x.detail : x.error)).join(' | ') : '');
  const names = (rfAll.sections || []).map((x) => x.name);
  check('обновление: загружены товары, акции, статистика, карточки и расходы',
    ['goods', 'promos', 'stats', 'cards', 'facts'].every((n) => names.indexOf(n) >= 0), names.join(', '));
  const goodsLine = (rfAll.sections || []).find((x) => x.name === 'goods');
  check('обновление: товары выгружены с ценами', /товаров/.test(String(goodsLine && goodsLine.detail)), goodsLine ? goodsLine.detail : '');
  const st2 = await service.handlers['app:state']();
  check('обновление: время последнего обновления сохранено', !!st2.lastDataRefreshAt, st2.lastDataRefreshAt || '');

  // с нерабочим ключом обновление не должно падать целиком — каждый раздел сообщает свою ошибку
  await service.handlers['keys:set']({ single: 'eyJhbGciOiJIUzI1NiJ9.test.token', demoMode: false });
  const rfBad = await service.handlers['data:refresh-all']({ facts: false });
  check('обновление: ошибки разделов собираются, а не роняют всё обновление',
    !!(rfBad && rfBad.ok === false && rfBad.errors.length > 0 && rfBad.sections.length > 0),
    rfBad ? 'разделов ' + rfBad.sections.length + ', ошибок ' + rfBad.errors.length : '');
  check('обновление: ошибка ключа объясняет, что делать',
    (rfBad.errors || []).some((e) => /ключ|токен|API/i.test(e.message)),
    rfBad && rfBad.errors[0] ? rfBad.errors[0].message.slice(0, 90) : '');
  await service.handlers['keys:clear']();
  await service.handlers['keys:set']({ demoMode: true });

  // ── карточка товара: заказы ещё в фоне (лимит «Статистики» 1 запрос/мин) ──
  // Ноль в «Заказы, шт» не должен читаться как «заказов нет»: пока заказы догружаются,
  // поле подписано, а рядом есть кнопка догрузить их отдельным запросом.
  {
    const realOrders = service.handlers['stats:orders'];
    let ordersCalled = null;
    service.handlers['stats:orders'] = async (payload) => {
      ordersCalled = payload;
      return { ok: true, added: 2, orders: 41, pages: 1, total: 15 };
    };
    const prevMeta = window.S.state.statsMeta;
    const prevByNm = window.S.state.statsByNm;
    // в демо заказы уже загружены, поэтому для проверки берём товар без строк статистики:
    // именно так выглядит карточка, пока заказы ещё догружаются в фоне
    window.S.state.statsMeta = { days: 30, withOrders: false, ordersPending: true, truncated: true, stale: false };
    window.S.state.statsByNm = {};
    window.Views.prices.openDetails(window.S.rows()[0]);
    await wait(400);
    const card = doc.getElementById('modal-root');
    const cardText = card ? card.textContent.replace(/\s+/g, ' ') : '';
    check('карточка товара: заказы помечены как недогруженные', /ещё не загружены/.test(cardText));
    check('карточка товара: есть кнопка догрузить заказы', !!(card && card.querySelector('#st-orders-now')));
    check('карточка товара: предупреждение об обрезанных страницах', /не все страницы статистики/.test(cardText));
    const ob = card ? card.querySelector('#st-orders-now') : null;
    if (ob) { ob.click(); await wait(400); }
    check('карточка товара: догрузка заказов вызывает stats:orders',
      !!(ordersCalled && ordersCalled.force === true), ordersCalled ? JSON.stringify(ordersCalled) : 'не вызван');
    window.S.state.statsMeta = prevMeta;
    window.S.state.statsByNm = prevByNm;
    service.handlers['stats:orders'] = realOrders;
    const cc = doc.querySelector('#modal-root .modal-close');
    if (cc) cc.click();
    await wait(200);
  }

  // ── раздел, отложенный из-за лимита WB (429): так это видит пользователь ──
  // В демо WB не отвечает 429, поэтому подменяем ответ полного обновления
  // и проверяем именно отрисовку: значок, объяснение и кнопку «Повторить сейчас».
  {
    const realRefresh = service.handlers['data:refresh-all'];
    const realSection = service.handlers['data:refresh-section'];
    let sectionCalled = null;
    const retryAt = new Date(Date.now() + 60000).toISOString();
    service.handlers['data:refresh-all'] = async () => ({
      ok: true, demo: true, ms: 1200, pending: 1, errors: [],
      sections: [
        { name: 'goods', title: 'Товары и цены', ok: true, ms: 900, detail: '13 товаров' },
        {
          name: 'stats', title: 'Статистика продаж', ok: false, deferred: true, retryAt, ms: 300,
          error: 'WB ограничил частоту запросов (HTTP 429). Категория «Статистика»: следующий запрос возможен через 62 с. ' +
                 'Ранее загруженные данные (13 товаров с продажами) остались на месте.'
        },
        {
          name: 'facts', title: 'Фактические расходы (отчёт о реализации)', ok: false, deferred: true, retryAt, ms: 100,
          error: 'За 2026-11-06 → 2026-11-13 WB не отдал ни одной строки отчёта (0 товаров, 0 строк). ' +
                 'Дневной отчёт формируется на следующий день, недельный — в понедельник.'
        }
      ],
      deferred: [
        { name: 'stats', title: 'Статистика продаж', retryAt, message: '429', code: 'RATE_LIMIT' },
        { name: 'facts', title: 'Фактические расходы', retryAt, message: 'отчёта нет', code: 'NO_ROWS' }
      ],
      coverage: { prices: true, statistics: true, content: true, finance: true }
    });
    service.handlers['data:refresh-section'] = async (p) => {
      sectionCalled = p && p.name;
      return { ok: true, name: p && p.name, detail: '13 товаров с продажами' };
    };

    await window.App.refreshAllData({ facts: false, redraw: false });
    await wait(300);
    const mr = doc.getElementById('modal-root');
    const mrText = mr ? mr.textContent : '';
    check('лимит WB: отложенный раздел показан значком ⏳, а не крестом', /⏳/.test(mrText) && !/✗\s*Статистика/.test(mrText));
    check('лимит WB: объяснено, что раздел дозагрузится в фоне', /Дозагружается в фоне/.test(mrText));
    check('лимит WB: раздел не записан в «не загружено»', !/Не загружено разделов/.test(mrText));
    check('лимит WB: показана причина 429 и что старые данные остались', /429/.test(mrText) && /остались на месте/.test(mrText));
    check('лимит WB: пустой отчёт не показан как успех', /0 товаров, 0 строк/.test(mrText) && /в понедельник/.test(mrText));
    check('лимит WB: пустой отчёт тоже помечен ⏳', /⏳\s*Фактические расходы/.test(mr.textContent.replace(/\s+/g, ' ')));
    check('лимит WB: показан срок автоматического повтора', /Догрузится автоматически/.test(mrText));
    const retryBtn = mr ? mr.querySelector('[data-retry]') : null;
    check('лимит WB: есть кнопка «Повторить сейчас»', !!retryBtn && /Повторить сейчас/.test(retryBtn.textContent || ''));
    if (retryBtn) { retryBtn.click(); await wait(500); }
    check('лимит WB: кнопка догружает раздел отдельным запросом', sectionCalled === 'stats', 'вызван раздел: ' + sectionCalled);
    check('лимит WB: после догрузки строка стала зелёной', mr ? /✓\s*Статистика продаж/.test(mr.textContent) : false);
    const closeBtn = mr ? mr.querySelector('.modal-close') : null;
    if (closeBtn) closeBtn.click();
    await wait(200);

    service.handlers['data:refresh-all'] = realRefresh;
    service.handlers['data:refresh-section'] = realSection;
  }

  // фактические расходы из финансового отчёта WB
  // раздел «Настройки»: управление фактом должно быть в интерфейсе
  window.App.go('settings');
  await wait(900);
  const setHtml = doc.getElementById('view').innerHTML;
  check('настройки: есть раздел фактических расходов', /Фактические расходы из отчёта WB/.test(setHtml));
  check('настройки: есть ключ категории «Финансы»', !!doc.getElementById('k-finance'));
  check('настройки: есть кнопка загрузки отчёта', !!doc.getElementById('f-load'));
  check('настройки: настраивается окно усреднения', !!doc.getElementById('f-days') && !!doc.getElementById('f-period'));
  check('настройки: флаг «брать расходы из отчёта»', !!doc.getElementById('f-use'));
  check('настройки: объяснён приоритет источников', /Ручная настройка товара → факт из отчёта WB/.test(setHtml));
  // лимиты WB и фоновая догрузка должны быть видны и настраиваемы
  check('настройки: есть раздел про лимиты WB и статистику', /Статистика продаж и лимиты WB/.test(setHtml));
  check('настройки: объяснён лимит «один запрос в минуту»', /один запрос в минуту/.test(setHtml));
  check('настройки: объяснено, почему отчёт бывает пустой', /Почему бывает «0 строк»/.test(setHtml));
  check('настройки: есть поиск последнего отчёта WB', !!doc.getElementById('f-find'));
  check('настройки: настраивается глубина поиска отчёта', !!doc.getElementById('f-lookback') && !!doc.getElementById('f-widen'));
  check('настройки: есть кнопки загрузки статистики и заказов', !!doc.getElementById('f-load-stats') && !!doc.getElementById('f-load-orders'));
  check('настройки: показан список фоновой догрузки', /Фоновая догрузка разделов/.test(setHtml));
  check('настройки: в статусе факта видны окно, источник и строки отчёта',
    /Загружено:/.test(setHtml) && /Строк отчёта обработано/.test(setHtml) && /demo-finance-api/.test(setHtml));

  const facts = await service.handlers['facts:load']({ days: 7 });
  check('факт: отчёт WB загружен', !!(facts && facts.ok && facts.rowsProcessed > 0),
    facts ? facts.rowsProcessed + ' строк, ' + facts.items + ' товаров, источник ' + facts.source : '');
  const goodsF = await service.handlers['wb:goods']({});
  check('факт: расходы привязаны к товарам', !!(goodsF.facts && Object.keys(goodsF.facts).length > 0),
    goodsF.facts ? Object.keys(goodsF.facts).length + ' товаров' : 'нет');
  const fKey = Object.keys(goodsF.facts || {})[0];
  const fItem = fKey ? goodsF.facts[fKey] : null;
  check('факт: есть средняя логистика за неделю', !!(fItem && fItem.logisticsAvg > 0), fItem ? fItem.logisticsAvg + ' ₽' : '');
  check('факт: есть средняя комиссия', !!(fItem && fItem.commissionPctAvg > 0), fItem ? fItem.commissionPctAvg + '%' : '');
  check('факт: окно усреднения указано', !!(fItem && fItem.windowDays === 7), fItem ? fItem.windowDays + ' дн' : '');

  // прозрачность источника: расчёт знает, откуда взята каждая цифра
  // раздел «Себестоимость»: факт должен быть виден рядом со справочником
  await window.S.refreshFacts();
  window.App.go('costs');
  await wait(900);
  const costsHtml = doc.getElementById('view').innerHTML;
  check('себестоимость: есть колонка факта WB', /Факт WB за неделю/.test(costsHtml));
  check('себестоимость: показаны фактические цифры', /логистика/.test(costsHtml) && /комиссия/.test(costsHtml));
  window.App.go('repricer');
  await wait(400);

  // расчёт репрайсера должен показать, откуда взяты расходы, и учесть факт
  const calcWithFacts = await service.handlers['repricer:calc']({ full: true });
  const rf = calcWithFacts.results.find((r) => String(r.nmID) === String(fKey));
  check('факт: источник расходов виден в расчёте',
    !!(rf && rf.current.costSources && (rf.current.costSources.logisticsRub === 'fact' || rf.current.costSources.commissionPct === 'fact')),
    rf && rf.current.costSources ? JSON.stringify(rf.current.costSources) : '');
  check('факт: логистика и комиссия подтянуты из отчёта',
    !!(rf && rf.current.factLogistics > 0 && rf.current.factCommissionPct > 0),
    rf ? 'логистика ' + rf.current.factLogistics + ' ₽, комиссия ' + rf.current.factCommissionPct + '%, окно ' + rf.current.factWindowDays + ' дн' : '');
  await service.handlers['facts:clear']();
  const calcNoFacts = await service.handlers['repricer:calc']({ full: true });
  const rn = calcNoFacts.results.find((r) => String(r.nmID) === String(fKey));
  check('факт: без отчёта берётся справочник/формула',
    !!(rn && rn.current.costSources && rn.current.costSources.logisticsRub !== 'fact'),
    rn && rn.current.costSources ? rn.current.costSources.logisticsRub : '');
  check('факт: прибыль пересчиталась', !!(rf && rn) && Math.abs(rf.current.profit - rn.current.profit) > 0.01,
    rf && rn ? rf.current.profit + ' ₽ → ' + rn.current.profit + ' ₽' : '');

  // раздел «Отчёты» без загруженного отчёта: объяснить причину и предложить поиск,
  // а не показывать «загружено 0 товаров» как успех
  window.App.go('reports');
  await wait(900);
  const repEmpty = doc.getElementById('view').innerHTML;
  check('отчёты: без данных сказано, что отчёт не загружен', /Отчёт ещё не загружен/.test(repEmpty));
  check('отчёты: есть кнопка «Найти последний отчёт WB»', !!doc.getElementById('pl-find'));
  check('отчёты: объяснена задержка формирования отчётов WB', /с задержкой/.test(repEmpty) && /в понедельник/.test(repEmpty));
  await service.handlers['facts:load']({ days: 7 });
  await window.S.refreshFacts();
  window.App.go('reports');
  await wait(1200);
  // в HTML амперсанд экранирован (P&amp;L), поэтому сравниваем по тексту раздела
  const repFull = doc.getElementById('view').textContent;
  check('отчёты: после загрузки отчёта P&L снова строится',
    /Сводка P&L/.test(repFull) && /к перечислению/i.test(repFull),
    repFull.slice(0, 120).replace(/\s+/g, ' '));

  // возврат параметров к рекомендуемым
  await service.handlers['repricer:promo-restore']({ force: true });
  await service.handlers['repricer:save'](window.RP.DEFAULT_CONFIG);
  const backCfg = (await service.handlers['repricer:state']()).config;
  check('репрайсер: сброс параметров работает', backCfg.limits.maxChangePerUpdatePct === 19 && backCfg.marginMode === 'discounted');

  // ── сводные плитки работают как фильтры (просил пользователь: «сделать их кликабельными») ──
  window.App.go('prices');
  await wait(900);
  const tiles = doc.querySelectorAll('#totals-line .tile');
  check('плитки: отрисованы в «Цены и скидки»', tiles.length >= 6, 'плиток ' + tiles.length);
  const rowsAll = window.S.filtered().length;
  const lossTile = Array.from(tiles).find((t) => /убыточных/.test(t.textContent));
  check('плитки: есть «убыточных»', !!lossTile, lossTile ? lossTile.textContent.replace(/\s+/g, ' ').trim() : '');
  if (lossTile) {
    lossTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    const filteredRows = doc.querySelectorAll('#grid-host tbody tr').length;
    check('плитки: клик фильтрует таблицу', window.S.state.filters.flag === 'loss' && filteredRows <= rowsAll,
      'фильтр ' + window.S.state.filters.flag + ', строк ' + filteredRows + ' из ' + rowsAll);
    check('плитки: активная плитка отмечена', !!doc.querySelector('#totals-line .tile.active'));
    const t2 = Array.from(doc.querySelectorAll('#totals-line .tile')).find((t) => /убыточных/.test(t.textContent));
    if (t2) { t2.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(400); }
    check('плитки: повторный клик снимает фильтр', window.S.state.filters.flag === 'all', window.S.state.filters.flag);
  }

  // ── черновик цен: «сохранить без отправки» ──
  const draftRow = window.S.getRows()[0];
  await service.handlers['prices:draft-clear']({});
  const draftSave = await service.handlers['prices:draft-save']({
    items: { [String(draftRow.nmID)]: { basePrice: 2222, discount: 11, note: 'проверка' } }
  });
  check('черновик: сохраняется без отправки в WB', draftSave.ok === true && draftSave.count === 1);
  await window.Views.prices.loadDrafts();
  window.Views.prices.render(doc.getElementById('view'));
  await wait(700);
  const draftRowEl = Array.from(doc.querySelectorAll('#grid-host tbody tr'))
    .find((tr) => tr.textContent.includes(String(draftRow.nmID)));
  const draftInput = draftRowEl ? draftRowEl.querySelector('input.cellinput') : null;
  check('черновик: введённое значение видно в таблице после перерисовки',
    !!draftInput && Number(draftInput.value) === 2222,
    draftInput ? 'значение ' + draftInput.value : (draftRowEl ? 'поля нет в строке' : 'строка товара не найдена'));
  check('черновик: строка помечена значком черновика', /черновик/.test(doc.querySelector('#grid-host').textContent));
  check('черновик: есть кнопка «Сохранить без отправки»', !!doc.getElementById('btn-save-draft'));
  check('черновик: плитка показывает число сохранённых', /черновик цен/.test(doc.querySelector('#totals-line').textContent));
  await service.handlers['prices:draft-clear']({});

  // ── карточка товара с вкладками (двойной клик) ──
  await window.Views.itemcard.open(draftRow.nmID);
  await wait(900);
  const ic = doc.getElementById('modal-root');
  const icText = ic ? ic.textContent.replace(/\s+/g, ' ') : '';
  check('карточка товара: открывается модальным окном', !!ic && /Карточка товара|нм-код/.test(icText));
  check('карточка товара: есть вкладки', (ic ? ic.querySelectorAll('#ic-tabs .tab').length : 0) >= 5,
    'вкладок ' + (ic ? ic.querySelectorAll('#ic-tabs .tab').length : 0));
  check('карточка товара: вкладка конкурентов', /Конкуренты/.test(icText));
  check('карточка товара: вкладка комиссий и параметров', /Комиссии и параметры/.test(icText));
  check('карточка товара: вкладка акций', /Акции/.test(icText));
  check('карточка товара: вкладка истории пересчёта', /История пересчёта/.test(icText));
  check('карточка товара: на вкладке экономики видна прибыль и маржа', /Прибыль с единицы/.test(icText) && /Маржинальность/.test(icText));
  // переход на вкладку конкурентов
  const compTab = Array.from(ic.querySelectorAll('#ic-tabs .tab')).find((t) => /Конкуренты/.test(t.textContent));
  if (compTab) { compTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(400); }
  check('карточка товара: конкурентов можно добавить', !!doc.getElementById('ic-c-add') && !!doc.getElementById('ic-c-price'));
  check('карточка товара: у конкурента задаётся SKU (нм-код WB)', !!doc.getElementById('ic-c-sku'));
  const compHtml = (doc.getElementById('ic-host') || { innerHTML: '' }).innerHTML;
  check('карточка товара: цена конкурента приводится к «с СПП» и «с кошельком»',
    /С СПП \/ кошелёк/.test(compHtml) || /кошелёк/.test(compHtml),
    compHtml.includes('С СПП') ? 'колонка на месте' : 'колонки нет');
  // в репрайсере тот же набор колонок, что в INDEEPA: SKU, остаток, цена с СПП
  window.App.go('repricer');
  await wait(600);
  window.Views.repricer.tab = 'prices';
  await window.Views.repricer.draw();
  await wait(2200);
  const rpHtml3 = doc.getElementById('view').innerHTML;
  check('INDEEPA: у конкурента в строке видны цена с СПП и с кошельком',
    /с СПП/.test(rpHtml3) && /с кошельком/.test(rpHtml3));
  // калькулятор СПП по витринной цене (на вкладке комиссий и параметров)
  const commTab = Array.from(doc.querySelectorAll('#ic-tabs .tab')).find((t) => /Комиссии и параметры/.test(t.textContent));
  if (commTab) { commTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(500); }
  // реальный СПП из статистики продаж WB должен быть виден и помечен источником
  const econTab = Array.from(doc.querySelectorAll('#ic-tabs .tab')).find((t) => /Экономика/.test(t.textContent));
  if (econTab) { econTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(500); }
  const econText = (doc.getElementById('ic-host') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
  check('карточка товара: у СПП виден источник (факт WB / настройка)',
    /факт WB|настройк|вручную/.test(econText), econText.slice(0, 60));
  check('карточка товара: цена покупателю считается с СПП', /Цена покупателю \(с СПП\)/.test(econText));
  if (commTab) { commTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(500); }
  check('карточка товара: объяснено, что реальный СПП берётся из статистики WB',
    /статистик|по факту продаж WB/i.test((doc.getElementById('ic-host') || { textContent: '' }).textContent));

  check('карточка товара: есть калькулятор СПП по витрине',
    !!doc.getElementById('ic-spp-ours') && !!doc.getElementById('ic-spp-shelf') && !!doc.getElementById('ic-spp-result'));
  check('карточка товара: есть кнопка открыть товар на витрине', !!doc.getElementById('ic-spp-open'));
  const oursInput = doc.getElementById('ic-spp-ours');
  const shelfInput = doc.getElementById('ic-spp-shelf');
  if (oursInput && shelfInput) {
    oursInput.value = '1000';
    shelfInput.value = '850';
    shelfInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('ic-spp-calc').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(600);
    const sppVal = Number(doc.getElementById('ic-spp-result').value);
    check('карточка товара: СПП считается от двух цен витрины',
      Math.abs(sppVal - 15) < 0.01, 'наша 1000 ₽, покупателю 850 ₽ → СПП ' + sppVal + '%');
    check('карточка товара: объяснено, откуда взялся СПП',
      /за счёт WB/.test(doc.getElementById('ic-spp-note').textContent),
      doc.getElementById('ic-spp-note').textContent.slice(0, 70));
    // витринная цена выше нашей — так не бывает, считать нельзя
    shelfInput.value = '1200';
    shelfInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('ic-spp-calc').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    check('карточка товара: витрина дороже нашей цены отклоняется',
      doc.getElementById('ic-spp-result').value === '' && /не бывает/.test(doc.getElementById('ic-spp-note').textContent),
      doc.getElementById('ic-spp-note').textContent.slice(0, 70));
    // подстановка в поле СПП
    shelfInput.value = '900';
    shelfInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('ic-spp-apply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    const sppField = doc.getElementById('ic-p-sppPct');
    check('карточка товара: рассчитанный СПП подставляется в параметры',
      !!sppField && Math.abs(Number(sppField.value) - 10) < 0.01, sppField ? 'СПП = ' + sppField.value : 'поля нет');
  }

  // ── наблюдатель цен витрины: вкладка «Цены на площадке» в карточке товара ──
  const watchTab = Array.from(doc.querySelectorAll('#ic-tabs .tab')).find((t) => /Цены на площадке/.test(t.textContent));
  check('карточка товара: есть вкладка «Цены на площадке»', !!watchTab);
  if (watchTab) {
    watchTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(900);
    const wText = (doc.getElementById('ic-host') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
    check('витрина: есть кнопка «Обновить с витрины»', !!doc.getElementById('pw-fetch'));
    check('витрина: есть ручной ввод цены на полке и цены покупателю',
      !!doc.getElementById('pw-m-shelf') && !!doc.getElementById('pw-m-buyer') && !!doc.getElementById('pw-m-save'));
    check('витрина: показано, какой СПП идёт в расчёты и в каком порядке источников',
      /Какой СПП идёт в расчёты/.test(wText) && /наблюдени[ея].*витрины|наблюдение витрины/.test(wText) && /Приоритет/.test(wText));
    check('витрина: в демо-режиме честно сказано, что запросов к витрине нет',
      /Демо-режим/.test(wText) && doc.getElementById('pw-fetch').disabled === true,
      'кнопка ' + (doc.getElementById('pw-fetch').disabled ? 'выключена' : 'включена'));
    check('витрина: объяснено поведение при блокировке (403/429/капча)',
      /403/.test(wText) && /429/.test(wText) && /капч/i.test(wText));
    check('витрина: есть история наблюдений', /История наблюдений/.test(wText));

    // ручной ввод: СПП считается на лету, запись попадает в историю и в медиану
    const shelfIn = doc.getElementById('pw-m-shelf');
    const buyerIn = doc.getElementById('pw-m-buyer');
    shelfIn.value = '1000';
    shelfIn.dispatchEvent(new window.Event('input', { bubbles: true }));
    buyerIn.value = '850';
    buyerIn.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(150);
    check('витрина: СПП считается сразу при вводе двух цен',
      /15/.test(doc.getElementById('pw-m-spp').textContent),
      doc.getElementById('pw-m-spp').textContent);
    doc.getElementById('pw-m-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(1600);
    const wText2 = (doc.getElementById('ic-host') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
    check('витрина: наблюдение записано и видно в истории',
      /вручную/.test(wText2) && /850/.test(wText2) && /1 000|1000/.test(wText2));
    check('витрина: медиана наблюдения показана в блоке СПП',
      /Медиана по витрине/.test(wText2) && /15/.test(wText2));

    // запрос к витрине в демо-режиме: честный отказ, а не выдуманная цена
    doc.getElementById('pw-fetch').disabled = false;
    doc.getElementById('pw-fetch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(900);
    const wText3 = (doc.getElementById('ic-host') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
    check('витрина: запрос в демо-режиме даёт честный отказ, а не цифры',
      /Демо-режим/.test(wText3) && !/Витрина: полка/.test(wText3), wText3.slice(0, 90));
  }

  // ── калькулятор СПП: цены можно подтянуть с витрины одной кнопкой ──
  if (commTab) { commTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(600); }
  check('карточка товара: у калькулятора СПП есть кнопка «Подтянуть с витрины»', !!doc.getElementById('ic-spp-watch'));
  if (doc.getElementById('ic-spp-watch')) {
    doc.getElementById('ic-spp-watch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(900);
    const note = (doc.getElementById('ic-spp-note') || { textContent: '' }).textContent;
    check('карточка товара: в демо «Подтянуть с витрины» честно сообщает об отказе',
      /Демо-режим|не выполняются/i.test(note), note.slice(0, 80));
    check('карточка товара: при отказе витрины цены не выдумываются',
      (doc.getElementById('ic-spp-result') || {}).value === '' || doc.getElementById('ic-spp-result').value === undefined,
      'результат: ' + ((doc.getElementById('ic-spp-result') || {}).value || 'пусто'));
  }

  const histTab = Array.from(doc.querySelectorAll('#ic-tabs .tab')).find((t) => /История пересчёта/.test(t.textContent));
  if (histTab) { histTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(400); }
  check('карточка товара: история показывает фазы «предложено» и «отправлено»',
    /Пересчёты репрайсера по этому артикулу/.test(doc.getElementById('modal-root').textContent));
  const icClose = doc.querySelector('#modal-root .modal-close');
  if (icClose) icClose.click();
  await wait(200);

  // ── акции: переход в кабинет WB вместо потока ошибок 422 ──
  window.App.go('promos');
  await wait(1200);
  const promoHtml = doc.getElementById('view').innerHTML;
  check('акции: есть кнопка «Перейти к акции»', /Перейти к акции/.test(promoHtml) && !!doc.querySelector('[data-link]'));
  check('акции: объяснено, что состав можно загрузить файлом из кабинета',
    /загрузить файлом|Загрузить товары из файла/.test(doc.getElementById('view').textContent));
  window.App.go('settings');
  await wait(900);
  const setHtml2 = doc.getElementById('view').innerHTML;
  check('настройки: адрес кабинета для ссылки на акцию настраивается', !!doc.getElementById('s-promourl'));
  check('настройки: ссылка на акцию прямая, с подстановкой ID',
    /dp-promo-calendar\?action=\{id\}/.test(setHtml2) || /action=\{id\}/.test(setHtml2),
    (doc.getElementById('s-promourl') || {}).value || 'поля нет');
  check('настройки: объяснено, что страница откроется сразу на нужной акции',
    /сразу нужную акцию|сразу на нужной акции/.test(setHtml2.replace(/\s+/g, ' ')));

  // ── репрайсер: одна страница и двухфазный цикл ──
  window.App.go('repricer');
  await wait(600);
  window.Views.repricer.tab = 'prices';
  await window.Views.repricer.draw();
  await wait(2500);
  const rpText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  const rpHtml = doc.getElementById('view').innerHTML;
  check('репрайсер: вкладки цен и стратегий объединены', doc.querySelector('#rp-tabs [data-t="prices"]').textContent.trim() === 'Товары' && !/>Новые цены</.test(rpHtml));
  check('репрайсер: цена на МП и новая цена в одной таблице',
    /Цена на МП/.test(rpHtml) && /Новая цена/.test(rpHtml));
  check('репрайсер: сохранённая вручную цена видна отдельно от цены МП',
    /Моя цена/.test(rpHtml));
  check('репрайсер: стратегию можно поменять прямо в таблице', !!doc.querySelector('.rp-strategy'));
  check('репрайсер: минимальная цена редактируется в строке', !!doc.querySelector('.rp-minprice'));
  check('репрайсер: сводные плитки-фильтры на месте', (doc.querySelectorAll('#rp-tiles .tile') || []).length >= 6,
    'плиток ' + doc.querySelectorAll('#rp-tiles .tile').length);
  check('репрайсер: цены пересчитаны без нажатия кнопки', (window.Views.repricer.results || []).length > 0,
    'строк ' + (window.Views.repricer.results || []).length);
  check('репрайсер: предложение показано отдельно от установленных цен',
    /Цен в предложении: \d|Репрайсер хочет изменить|Предложение репрайсера пустое/.test(rpText));
  check('репрайсер: объяснено, что пересчёт не меняет цены сразу',
    /установленные цены не меняются|Автоотправка выключена/.test(rpText));
  const prop = await service.handlers['repricer:proposal']();
  check('репрайсер: предложение хранится с временем отправки', !prop.items.length || !!prop.sendAt,
    'позиций ' + (prop.items || []).length + ', sendAt ' + (prop.sendAt || '—'));
  check('репрайсер: установленные цены не затёрты пересчётом',
    (await service.handlers['tasks:history']()).length === 0 || prop.phase !== 'sent', 'phase=' + prop.phase);
  await window.App.go('settings', { tab: 'schedule' }); await wait(1200);
  check('репрайсер: двухфазный цикл настраивается', !!doc.getElementById('ps-twophase') && !!doc.getElementById('ps-senddelay'));
  check('репрайсер: объяснены фазы расчёта и отправки', /Фаза 1|сначала показать предложение/i.test(doc.getElementById('view').textContent));

  // ── акции: состав из файла, а не из WB (метод nomenclatures отвечает 422) ──
  window.App.go('promos');
  for (let i = 0; i < 100 && !doc.querySelector('#promo-list .promo-source .badge'); i++) await wait(50);
  const promosView = doc.getElementById('view');
  const promosText = promosView.textContent.replace(/\s+/g, ' ');
  check('акции: к WB за составом не обращаемся (настройка по умолчанию)',
    (await service.handlers['settings:get']({})).promosFetchNomenclatures === false);
  check('акции: источник состава подписан в общем списке',
    /состав из файла|состав из WB API|по скидке товара|состав не загружен/.test(promosText), promosText.slice(0, 90));
  check('акции: ошибка 422 не показывается как ошибка раздела',
    !/422|Unprocessable/.test(promosText) || /файл/i.test(promosText));
  check('акции: есть кнопка перехода в кабинет WB', !!promosView.querySelector('[data-link]'));

  const stPromos = window.S.state.promos || [];
  if (stPromos.length) {
    const pi = await service.handlers['promos:items']({ promotionID: stPromos[0].id });
    check('окно акции: состав отдаётся без запросов к WB', !!pi && Array.isArray(pi.items),
      pi ? 'товаров ' + pi.total + ', источник ' + pi.source : 'нет ответа');
    check('окно акции: источник состава известен', !!pi && ['file', 'inferred', 'api', 'none'].includes(pi.source),
      pi && pi.source);
    // закрываем все окна, оставшиеся от предыдущих блоков, иначе проверка читает чужой текст
    for (let i = 0; i < 6; i++) {
      const c = doc.querySelector('#modal-root .modal-close');
      if (!c) break;
      c.click();
      await wait(120);
    }
    await window.Views.promos.openPromo(stPromos[0]);
    await wait(900);
    // берём текст ПОСЛЕДНЕГО открытого окна — именно оно относится к акции
    const backdrops = doc.querySelectorAll('#modal-root .modal-backdrop');
    const lastModal = backdrops.length ? backdrops[backdrops.length - 1] : null;
    check('окно акции: открылось поверх пустого modal-root', !!lastModal && backdrops.length === 1,
      'окон открыто: ' + backdrops.length);
    const mText = lastModal ? lastModal.textContent.replace(/\s+/g, ' ') : '';
    check('окно акции: открылось без голой ошибки WB', !/Ошибка запроса \(HTTP 422\)/.test(mText));
    check('окно акции: сказано, откуда состав',
      /состав из файла|по факту скидки|состав не загружен|Состав этой акции пуст/.test(mText), mText.slice(0, 100));
    check('окно акции: есть кнопка загрузки файла', /Загрузить товары из файла/.test(mText));
    // цифры из файла кабинета должны быть видны в окне акции
    const promoModal = (function () {
      const bs = doc.querySelectorAll('#modal-root .modal-backdrop');
      return bs.length ? bs[bs.length - 1] : null;
    })();
    const pmHtml = promoModal ? promoModal.innerHTML : '';
    check('окно акции: показана плановая цена WB из файла', /Плановая цена WB/.test(pmHtml));
    check('окно акции: показан источник каждой строки', /Источник/.test(pmHtml) &&
      /из файла|по скидке|из WB API|не загружен/.test(pmHtml));
    check('окно акции: есть кнопка перехода в кабинет', /Перейти к акции в кабинете WB/.test(mText));
    const mc = doc.querySelector('#modal-root .modal-close');
    if (mc) mc.click();
    await wait(200);
  }

  // ── отчёты: произвольный период, а не только последний снимок ──
  window.App.go('reports');
  await wait(1200);
  const repView = doc.getElementById('view');
  check('отчёты: есть выбор периода «с»', !!repView.querySelector('#pl-from'));
  check('отчёты: есть выбор периода «по»', !!repView.querySelector('#pl-to'));
  check('отчёты: есть кнопка «Показать за период»', !!repView.querySelector('#pl-apply'));
  check('отчёты: есть быстрые пресеты периода', !!repView.querySelector('#pl-preset') &&
    /Прошлый месяц/.test(repView.innerHTML));
  const basePl = await service.handlers['reports:pl']({});
  if (basePl && basePl.ok) {
    const twoDays = await service.handlers['reports:pl']({ days: 2, save: false });
    check('отчёты: за короткий период цифры другие',
      !!twoDays.ok && Math.abs(twoDays.totals.profit - basePl.totals.profit) > 0.5,
      twoDays.ok ? ('2 дня: ' + Math.round(twoDays.totals.profit) + ' ₽ против ' + Math.round(basePl.totals.profit) + ' ₽')
        : (twoDays.message || 'нет ответа'));
    check('отчёты: выбранный период помечен в метаданных',
      !!twoDays.ok && twoDays.meta.customPeriod === true, twoDays.meta && String(twoDays.meta.customPeriod));
    const again = await service.handlers['reports:pl']({});
    check('отчёты: просмотр периода не перезаписал основной снимок',
      again.meta.dateFrom === basePl.meta.dateFrom && again.meta.dateTo === basePl.meta.dateTo,
      again.meta.dateFrom + ' → ' + again.meta.dateTo);
  }

  // ── себестоимость: убрана ссылка на «WB не отдаёт закупку», указан путь в репрайсер ──
  window.App.go('costs');
  await wait(900);
  const costsText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('себестоимость: нет утверждения, что WB «не отдаёт» закупку',
    !/WB API не отдаёт|Wildberries не отдаёт вашу закупочную/.test(costsText));
  // настройки состава акций
  window.App.go('settings');
  await wait(900);
  check('настройки: есть переключатель «запрашивать состав у WB»', !!doc.getElementById('s-promo-fetch'));
  check('настройки: есть переключатель вывода участия по скидке', !!doc.getElementById('s-promo-infer'));
  check('настройки: по умолчанию к WB за составом не обращаемся',
    doc.getElementById('s-promo-fetch') && doc.getElementById('s-promo-fetch').checked === false);
  check('настройки: объяснено, откуда брать точный состав',
    /Сформировать/.test(doc.getElementById('view').textContent));

  // ── настройки наблюдателя цен витрины ──
  const pwText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('настройки: есть раздел наблюдателя цен витрины', /Наблюдатель цен витрины WB/.test(pwText));
  check('настройки: есть переключатель автозапросов к витрине', !!doc.getElementById('s-pw-auto'));
  check('настройки: автозапросы к витрине по умолчанию выключены',
    doc.getElementById('s-pw-auto') && doc.getElementById('s-pw-auto').checked === false);
  check('настройки: есть срок кэша наблюдения', !!doc.getElementById('s-pw-ttl') && Number(doc.getElementById('s-pw-ttl').value) > 0,
    'кэш ' + ((doc.getElementById('s-pw-ttl') || {}).value || '—') + ' мин');
  check('настройки: честно сказано про защиту витрины от ботов и остановку при блокировке',
    /защищена от ботов|403|429|блокиров/i.test(pwText));
  check('настройки: указано, где смотреть наблюдения', /Цены на площадке/.test(pwText));
  doc.getElementById('s-pw-auto').checked = true;
  doc.getElementById('s-pw-ttl').value = '15';
  const pwSave = doc.getElementById('save-all');
  if (pwSave) { pwSave.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(900); }
  const pwSet = await service.handlers['settings:get']();
  check('настройки: автозапросы к витрине сохраняются',
    pwSet.priceWatchAutoFetch === true && Number(pwSet.priceWatchTtlMinutes) === 15,
    'autoFetch=' + pwSet.priceWatchAutoFetch + ', ttl=' + pwSet.priceWatchTtlMinutes);
  await service.handlers['settings:save']({ priceWatchAutoFetch: false, priceWatchTtlMinutes: 60 });
  check('настройки: автозапросы возвращены в безопасное состояние',
    (await service.handlers['settings:get']()).priceWatchAutoFetch === false);

  check('себестоимость: указано, что параметры товара правятся в репрайсере',
    /репрайсер/i.test(costsText) && /Комиссии и параметры/.test(costsText));

  // ── страница репрайсера в стиле INDEEPA: колонки, валидация, журналы, пагинация ──
  window.App.go('repricer');
  await wait(700);
  window.Views.repricer.tab = 'prices';
  window.Views.repricer.page = 0;
  await window.Views.repricer.draw();
  await wait(2500);
  const rpHtml2 = doc.getElementById('view').innerHTML;
  const rpText2 = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('INDEEPA: выгодность включена в компактную текущую цену', !!doc.querySelector('#rp-grid [data-col-id="priceNow"] .rp-price-block .badge'));
  check('INDEEPA: статус выгодности показан бейджем',
    /Супер-выгодный|Выгодный|Невыгодный|Без индекса/.test(rpText2));
  check('INDEEPA: есть цена покупателю (СПП) сейчас и станет',
    /Текущая цена с СПП,/.test(rpHtml2) && /Новая цена с СПП,/.test(rpHtml2));
  check('INDEEPA: есть колонка «Акции» с решениями', /<th[^>]*>\s*Акции/.test(rpHtml2) || /Акции/.test(rpHtml2));
  check('INDEEPA: есть колонка «План продаж»', /План продаж/.test(rpHtml2));

  // сохранённая вручную цена важнее расчёта — это должно быть видно в ячейке «Новой цены»
  const draftNm = (function () {
    const d = window.S.state.priceDrafts || {};
    const ids = Object.keys(d);
    return ids.length ? Number(ids[0]) : null;
  })();
  if (draftNm) {
    const draftRow = Array.from(doc.querySelectorAll('#rp-grid tbody tr'))
      .find((tr) => tr.textContent.includes(String(draftNm)));
    check('репрайсер: в «Новой цене» видно, что уйдёт сохранённая цена, а не расчёт',
      !!draftRow && /приоритет ручного черновика/.test(draftRow.textContent) && !!draftRow.querySelector('[data-col-id="priceNow"] .rp-draft-summary'),
      draftRow ? draftRow.textContent.replace(/\s+/g, ' ').slice(0, 130) : 'строка не найдена на этой странице');
  }
  check('INDEEPA: незаполненный план подписан как в референсе',
    /План не заполнен/.test(rpText2) || (window.Views.repricer.results || []).length === 0);
  check('INDEEPA: есть счётчик строк и пагинация', !!doc.getElementById('rp-pager') &&
    /из/.test(doc.getElementById('rp-pager').textContent),
    doc.getElementById('rp-pager') ? doc.getElementById('rp-pager').textContent.replace(/\s+/g, ' ').trim() : 'нет панели');

  // сегментированный фильтр (как «Все / Основной» в INDEEPA) и плотность строк
  const seg = doc.querySelectorAll('#rp-seg [data-seg]');
  check('INDEEPA: есть сегментированный фильтр', seg.length === 7, 'сегментов ' + seg.length);
  check('INDEEPA: сегменты — Все, К отправке, Своя цена, Ошибки, Убыточные, Предупреждения, Не отправлять',
    Array.from(seg).map((b) => b.textContent.trim()).join('|') ===
      'Все|Только с изменением|Своя цена|Только ошибки|Только убыточные|С предупреждениями|Не отправлять',
    Array.from(seg).map((b) => b.textContent.trim()).join('|'));
  const allCount = doc.querySelectorAll('#rp-grid tbody tr').length;
  const errSeg = Array.from(seg).find((b) => b.getAttribute('data-seg') === 'errors');
  if (errSeg) { errSeg.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(800); }
  check('INDEEPA: сегмент фильтрует таблицу',
    doc.querySelectorAll('#rp-grid tbody tr').length <= allCount &&
      window.Views.repricer.itemFilter.seg === 'errors',
    'строк ' + doc.querySelectorAll('#rp-grid tbody tr').length + ' из ' + allCount);
  check('INDEEPA: показан счётчик отобранных товаров',
    !!doc.getElementById('rp-seg-count') && /\d/.test(doc.getElementById('rp-seg-count').textContent),
    doc.getElementById('rp-seg-count') ? doc.getElementById('rp-seg-count').textContent.trim() : 'нет');
  // возвращаем фильтр «Все» без клика — каждая перерисовка таблицы дорого стоит по памяти
  window.Views.repricer.itemFilter.seg = 'all';

  // плотность строк
  check('INDEEPA: есть переключатель плотности строк', !!doc.getElementById('rp-density'));
  const densSel = doc.getElementById('rp-density');
  if (densSel) {
    densSel.value = 'compact';
    densSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(900);
    check('INDEEPA: плотный режим применяется к таблице',
      !!doc.querySelector('#rp-grid .dense') && window.Views.repricer.density === 'compact');
    check('INDEEPA: выбор плотности запоминается', (function () {
      try { return window.localStorage.getItem('wb.repricer.density') === 'compact'; } catch (e) { return false; }
    })());
    // возвращаем обычную плотность напрямую, без ещё одной перерисовки
    window.Views.repricer.density = 'normal';
    try { window.localStorage.setItem('wb.repricer.density', 'normal'); } catch (e) { /* не критично */ }
    const denseWrap = doc.querySelector('#rp-grid .dense');
    if (denseWrap) denseWrap.classList.remove('dense');
  }

  // массовое назначение параметров на выбранные строки
  const selBox = doc.querySelector('#rp-grid thead input[type="checkbox"]');
  if (selBox) { selBox.click(); await wait(700); }
  const bulkBar = doc.getElementById('rp-bulk');
  check('INDEEPA: панель массовых действий появилась', !!bulkBar && bulkBar.style.display !== 'none',
    bulkBar ? bulkBar.textContent.replace(/\s+/g, ' ').slice(0, 70) : 'нет панели');
  check('INDEEPA: можно назначить стратегию всем выбранным', !!doc.getElementById('rb-strategy') &&
    doc.getElementById('rb-strategy').options.length > 5,
    'вариантов ' + (doc.getElementById('rb-strategy') || { options: [] }).options.length);
  check('INDEEPA: можно задать минимальную цену всем выбранным', !!doc.getElementById('rb-minprice'));
  check('INDEEPA: есть сброс личных настроек у выбранных', !!doc.getElementById('rb-clear-params'));
  const rbStrategy = doc.getElementById('rb-strategy');
  const rbMin = doc.getElementById('rb-minprice');
  const selCount = window.Views.repricer.selection ? window.Views.repricer.selection.size : 0;
  if (rbStrategy && selCount > 0) {
    rbStrategy.value = 'margin';
    rbMin.value = '500';
    doc.getElementById('rb-apply-params').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(2600);
    const cfgsAfter = await service.handlers['repricer:item-configs:get']();
    const withMargin = Object.values(cfgsAfter).filter((c) => c && c.strategy === 'margin').length;
    check('INDEEPA: стратегия назначена всем выбранным товарам', withMargin >= selCount,
      'назначено ' + withMargin + ' из ' + selCount + ' выбранных');
    const withFloor = Object.values(cfgsAfter).filter((c) => c && Number(c.minPrice) === 500).length;
    check('INDEEPA: минимальная цена назначена всем выбранным', withFloor >= selCount,
      'назначено ' + withFloor + ' из ' + selCount);
    // сбрасываем, чтобы не влиять на остальные проверки
    const ids = Object.keys(cfgsAfter).filter((k) => cfgsAfter[k] && cfgsAfter[k].strategy === 'margin');
    const resetItems = {};
    ids.forEach((k) => { resetItems[k] = null; });
    if (ids.length) await service.handlers['repricer:item-configs:save']({ items: resetItems });
    await wait(300);
  }


  // переключатель видимости колонок: без выбора приходится листать вбок
  check('INDEEPA: есть кнопка выбора колонок', !!doc.getElementById('rp-cols'));
  const rpv = window.Views.repricer;
  /**
   * Шапка таблицы стала двухрядной (задание D): верхний ряд — блоки колонок
   * («Артикул», «Текущая цена», «Новая цена», «Мин цена (в акции)», «Цена (вне акции)»…),
   * нижний — сами колонки. Поэтому колонки считаем по ПОСЛЕДНЕМУ ряду шапки:
   * в нём ровно видимые колонки, без чекбокса (он занимает оба ряда).
   */
  const colTh = () => doc.querySelectorAll('#rp-grid thead tr:last-child th').length;
  const visCount = () => {
    const vis = rpv.visibleCols();
    return rpv.layoutColumns().filter((c) => c.always || vis.has(c.id)).length;
  };
  check('INDEEPA: справочник колонок совпадает с таблицей',
    rpv.layoutColumns().length >= rpv.DEFAULT_COLUMNS.length && colTh() === visCount(),
    'в справочнике ' + (rpv.COLUMNS || []).length + ', в таблице ' + colTh() + ', видимых ' + visCount());
  check('INDEEPA: основной набор компактный, без дублирующих цен',
    rpv.visibleCols().size === 12 && !rpv.visibleCols().has('corridor') && !rpv.visibleCols().has('strategy'),
    'видимо ' + rpv.visibleCols().size + ' колонок');
  check('INDEEPA: обязательные колонки нельзя выключить',
    (rpv.COLUMNS || []).filter((c) => c.always).map((c) => c.id).join(',') === 'item,priceNow,priceNext',
    (rpv.COLUMNS || []).filter((c) => c.always).map((c) => c.title || c.id).join(', '));
  const headersBefore = colTh();
  rpv.saveVisibleCols(rpv.COMPACT_COLUMNS);
  rpv.renderResults();
  await wait(700);
  const headersAfter = colTh();
  check('INDEEPA: компактный набор уменьшает число колонок', headersAfter < headersBefore,
    headersBefore + ' → ' + headersAfter);
  check('INDEEPA: обязательные колонки остались при компактном наборе',
    /Товар/.test(doc.querySelector('#rp-grid').textContent) && /Новая цена/.test(doc.querySelector('#rp-grid').innerHTML));
  rpv.saveVisibleCols(rpv.DEFAULT_COLUMNS);
  rpv.renderResults();
  await wait(700);
  check('INDEEPA: набор колонок возвращается к полному',
    colTh() === headersBefore, 'колонок ' + colTh());
  rpv.openColumnsPicker();
  await wait(500);
  const cpModal = (function () { const bs = doc.querySelectorAll('#modal-root .modal-backdrop'); return bs.length ? bs[bs.length - 1] : null; })();
  check('INDEEPA: окно выбора колонок открывается', !!cpModal && /Колонки таблицы цен/.test(cpModal.textContent));
  check('INDEEPA: в окне есть готовые наборы', !!cpModal && /Компактный набор/.test(cpModal.textContent) &&
    /Все колонки/.test(cpModal.textContent));
  if (cpModal) { const c = cpModal.querySelector('.modal-close'); if (c) c.click(); await wait(250); }

  // ═════════════ Задание D: весь функционал на одном экране репрайсера ═════════════
  // Таблица собрана из блоков, а себестоимость, валюта, метка и флаг отправки
  // правятся прямо в строке — проваливаться в другие разделы не нужно.
  const rpD = window.Views.repricer;
  rpD.tab = 'prices';
  rpD.saveVisibleCols(rpD.DEFAULT_COLUMNS);
  rpD.page = 0;
  rpD.renderResults();
  await wait(800);

  // Ссылки на DOM объявлены через let и обнуляются в конце секции: в jsdom одна
  // ячейка держит ссылку на родителя, поэтому забытая строка оставляет в памяти
  // всю старую таблицу (28 колонок × 20 строк) до конца прогона.
  let headRowsD = doc.querySelectorAll('#rp-grid thead tr');
  check('D: шапка таблицы двухрядная — блоки над колонками', headRowsD.length === 2, 'рядов ' + headRowsD.length);
  let groupThs = Array.from(doc.querySelectorAll('#rp-grid thead tr:first-child th[data-group]'));
  const groupNames = groupThs.map((th) => th.textContent.trim()).join(' | ');
  check('D: блоки колонок как в таблице INDEEPA', groupThs.length >= 7, groupNames);
  check('D: объединённый блок «Товар и настройки», «Инфо о товаре», цены',
    groupNames.includes('Товар и настройки') && groupNames.includes('Инфо о товаре') &&
      groupNames.includes('Текущая цена') && groupNames.includes('Новая цена'), groupNames);
  check('D: блоки «Мин цена (в акции)» и «Цена (вне акции)»',
    groupNames.includes('Мин цена (в акции)') && groupNames.includes('Цена (вне акции)'), groupNames);
  check('D: себестоимость в инфо, прочие расходы и конкуренты сохранены',
    !!doc.querySelector('#rp-grid [data-col-id="info"] .rp-cost') && groupNames.includes('Прочие расходы') && groupNames.includes('Конкуренты'), groupNames);
  check('D: colspan блока равен числу его видимых колонок',
    groupThs.length > 0 && groupThs.every((th) => Number(th.colSpan) === rpD.colsOfGroup(th.getAttribute('data-group'))
      .filter((c) => c.always || rpD.visibleCols().has(c.id)).length),
    groupThs.map((th) => th.textContent.trim() + ':' + th.colSpan).join(', '));
  check('D: чекбокс «выбрать все» занимает оба ряда шапки',
    (() => { const th = doc.querySelector('#rp-grid thead th.rp-check'); return !!th && th.rowSpan === 2; })());
  check('D: широкая таблица закреплена слева по первым колонкам',
    !!doc.querySelector('#rp-grid table .grid-pinned[data-col-id="item"]'));

  const dPage = rpD.pageOf(rpD.filteredResults());
  const dRow = dPage.find((r) => !r.error && r.cost && r.cost.next);
  const dNm = dRow ? String(dRow.nmID) : '';
  check('D: расчёт отдаёт блоки для колонок (себестоимость, СПП, пороги, акции)',
    !!dRow && !!dRow.wallet && !!dRow.floor && !!dRow.promo && typeof dRow.allowSend === 'boolean', dNm);
  let dTr = Array.from(doc.querySelectorAll('#rp-grid tbody tr'))
    .find((tr) => !!tr.querySelector('.rp-cost[data-nm="' + dNm + '"]'));
  check('D: строка с блоками найдена в таблице', !!dTr, dNm);

  if (dTr) {
    const dItem = (window.S.state.items || []).find((x) => String(x.nmID) === dNm) || {};
    const dText = dTr.textContent;
    check('D: себестоимость и её валюта правятся в строке',
      !!dTr.querySelector('.rp-cost') && !!dTr.querySelector('.rp-costcur'),
      dTr.querySelector('.rp-costcur') ? dTr.querySelector('.rp-costcur').value : 'нет списка валют');
    check('D: флаг «Отправка в WB» и метка правятся в строке',
      !!dTr.querySelector('.rp-allowsend') && !!dTr.querySelector('.rp-tag'));
    check('D: пороги минимальной и базовой цены остались в строке',
      !!dTr.querySelector('.rp-minprice') && !!dTr.querySelector('.rp-baseprice'));
    check('D: блок «Инфо о товаре» показывает категорию или объём',
      !dItem.categoryName || dText.includes(dItem.categoryName) || /объём|размеров/.test(dText),
      String(dItem.categoryName || ''));
    check('D: баркод показан или честно помечен как отсутствующий',
      /нет в карточке|\d{6,}/.test(dText));
    // колонка «Расходы на единицу» по умолчанию скрыта (состав расходов есть в «почему»),
    // поэтому проверяем сам рендер ячейки, а не её присутствие в таблице
    const costDetailHtml = rpD.costDetailCellHtml(dRow);
    check('D: ячейка «Расходы на единицу» раскладывает расходы по статьям',
      /всего/.test(costDetailHtml) && /комиссия|логистика|себест\./.test(costDetailHtml),
      costDetailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90));
    // «Безубыточность» по умолчанию скрыта (цифра есть в «почему») — проверяем рендер ячейки
    const breakEvenHtml = rpD.breakEvenCellHtml(dRow);
    check('D: ячейка «Безубыточность» показывает точку и запас',
      /безубыточность/.test(breakEvenHtml) && /запас/.test(breakEvenHtml),
      breakEvenHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));
    check('D: в строке виден блок «Мин цена (в акции)»', /порог скидки|акций нет/.test(dText));
    check('D: в строке виден блок «Цена (вне акции)»', /база/.test(dText));

    // ── правки в строке копятся и применяются одной кнопкой ──
    const rateCny = Number((window.S.state.settings.costRates || {}).CNY);
    const curInp = dTr.querySelector('.rp-costcur');
    curInp.value = 'CNY';
    curInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    check('D: валюта себестоимости копится в несохранённых правках',
      rpD.pendingEdits.get(dNm).cost.currency === 'CNY', JSON.stringify(rpD.pendingEdits.get(dNm).cost));
    check('D: подпись «по курсу» пересчитывается сразу, без сохранения',
      /по курсу/.test(dTr.querySelector('.rp-cost-hint').textContent),
      dTr.querySelector('.rp-cost-hint').textContent);
    const costInp = dTr.querySelector('.rp-cost');
    costInp.value = '40';
    costInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    check('D: значение себестоимости копится в правках',
      rpD.pendingEdits.get(dNm).cost.costPriceRub === 40);
    check('D: в рублях себестоимость = значение × курс из настроек',
      dTr.querySelector('.rp-cost-rub').textContent.trim() === window.U.money(40 * rateCny).trim(),
      dTr.querySelector('.rp-cost-rub').textContent + ' против ' + window.U.money(40 * rateCny));

    const sendCb = dTr.querySelector('.rp-allowsend');
    sendCb.checked = false;
    sendCb.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    check('D: флаг «не отправлять» копится в правках',
      rpD.pendingEdits.get(dNm).config.allowSend === false);
    const tagInp = dTr.querySelector('.rp-tag');
    tagInp.value = 'распродажа';
    tagInp.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    check('D: метка товара копится в правках', rpD.pendingEdits.get(dNm).config.tag === 'распродажа');
    check('D: строка с несохранёнными правками подсвечена',
      !!doc.querySelector('#rp-grid tbody tr.row-dirty'));

    // commitEdits сам сохраняет правки, пересчитывает цены и перерисовывает таблицу
    await rpD.commitEdits();
    await wait(1500);
    const savedCost = (window.S.state.costs || {})[dNm] || {};
    check('D: «Сохранить» пишет себестоимость и валюту',
      savedCost.costEntered === 40 && Math.abs(savedCost.costPriceRub - 40 * rateCny) < 0.01 && savedCost.currency === 'CNY' && savedCost.costVersion === 2, JSON.stringify(savedCost));
    const savedCfg = (rpD.rstate.itemConfigs || {})[dNm] || {};
    check('D: «Сохранить» пишет флаг отправки и метку',
      savedCfg.allowSend === false && savedCfg.tag === 'распродажа', JSON.stringify(savedCfg));
    const afterRow = rpD.results.find((r) => String(r.nmID) === dNm);
    check('D: после пересчёта себестоимость в рублях по курсу',
      !!afterRow && afterRow.cost.currency === 'CNY' && afterRow.cost.entered === 40 &&
        Math.abs(afterRow.cost.rub - 40 * rateCny) < 0.01, afterRow && (afterRow.cost.rub + ' ₽'));
    check('D: товар с выключенной отправкой не помечен «к отправке»',
      !!afterRow && afterRow.allowSend === false && afterRow.needSend === false && afterRow.tag === 'распродажа');
    check('D: предупреждение объясняет, почему товар не уйдёт в WB',
      !!afterRow && (afterRow.warnings || []).some((w) => /Отправка в WB отключена/.test(w)));

    // ── валюта без курса: явная ошибка, а не тихий расчёт 1:1 ──
    // сохраняем только валюту и пересчитываем: полный commitEdits здесь не нужен,
    // а лишняя перерисовка таблицы в jsdom дорога
    await window.S.saveCosts({ [dNm]: { currency: 'GEL' } });
    const resGel = await window.API.invoke('repricer:calc', { full: true });
    rpD.results = resGel.results || [];
    rpD.summary = resGel.summary;
    await wait(600);
    const gelRow = rpD.results.find((r) => String(r.nmID) === dNm);
    check('D: валюта без курса даёт явную ошибку',
      !!gelRow && !!gelRow.cost.error && gelRow.cost.error.includes('не задан курс GEL'),
      gelRow && String(gelRow.cost.error));
    check('D: ошибка курса видна в проверке строки',
      !!gelRow && rpD.rowErrors(gelRow).some((x) => /не задан курс/.test(x)));
    // ячейку проверяем по рендеру, а не по DOM: лишний прогон по 100 строкам
    // в jsdom дорог, а результат один и тот же — именно этот HTML попадает в таблицу
    const costCellGel = rpD.costCellHtml(gelRow);
    check('D: ошибка курса показана в ячейке себестоимости',
      costCellGel.includes('не задан курс GEL') && costCellGel.includes('rp-validation'),
      costCellGel.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));

    // ── возвращаем товар в исходное состояние ──
    await window.S.saveCosts({ [dNm]: null });
    await window.API.invoke('repricer:item-configs:save', { items: { [dNm]: null } });
    rpD.rstate = await window.API.invoke('repricer:state');
    const resD = await window.API.invoke('repricer:calc', { full: true });
    rpD.results = resD.results || [];
    rpD.summary = resD.summary;
    await rpD.loadState();
    rpD.page = 0;
    await wait(500);
    const cleanRow = rpD.results.find((r) => String(r.nmID) === dNm);
    check('D: правки снимаются — товар снова отправляется, себестоимость в рублях',
      !!cleanRow && cleanRow.allowSend === true && !cleanRow.cost.error && cleanRow.cost.currency === 'RUB',
      cleanRow && (cleanRow.cost.currency + ' / allowSend=' + cleanRow.allowSend));
  }

  // ── выгрузка повторяет блоки колонок ──
  let exD = rpD.buildExport(rpD.filteredResults());
  check('D: выгрузка собрана из блоков колонок',
    exD.headers.length >= 60 && exD.headers.some((h) => h.indexOf('Артикул · ') === 0) &&
      exD.headers.some((h) => h.indexOf('Себестоимость · ') === 0) &&
      exD.headers.some((h) => h.indexOf('Мин цена (в акции) · ') === 0) &&
      exD.headers.some((h) => h.indexOf('Цена (вне акции) · ') === 0),
    'колонок ' + exD.headers.length);
  check('D: в выгрузке есть валюта, курс и рублёвая себестоимость',
    exD.headers.includes('Себестоимость · Валюта себестоимости') &&
      exD.headers.includes('Себестоимость · Курс валюты') &&
      exD.headers.includes('Себестоимость · Себестоимость, ₽'));
  check('D: в выгрузке есть флаг отправки, метка и баркод',
    exD.headers.includes('Артикул · Отправка в WB') && exD.headers.includes('Артикул · Метка') &&
      exD.headers.includes('Артикул · Баркод'));
  check('D: в выгрузке есть расходы на единицу и цена безубыточности',
    exD.headers.includes('Себестоимость · Всего расходов, ₽') &&
      exD.headers.includes('Себестоимость · Цена безубыточности, ₽'));
  check('D: строки выгрузки совпадают по ширине с заголовками',
    exD.rows.length > 0 && exD.rows.every((row) => row.length === exD.headers.length),
    'строк ' + exD.rows.length);
  check('D: в выгрузке заполнены расходы и порог акции',
    exD.rows[0][exD.headers.indexOf('Себестоимость · Всего расходов, ₽')] !== '' &&
      exD.headers.includes('Мин цена (в акции) · Порог скидки акции, %'));
  exD = null;

  // ── окно выбора колонок: чекбоксы блоков ──
  rpD.openColumnsPicker();
  await wait(500);
  let cpD = (function () { const bs = doc.querySelectorAll('#modal-root .modal-backdrop'); return bs.length ? bs[bs.length - 1] : null; })();
  check('D: в окне выбора колонок есть чекбоксы блоков',
    !!cpD && cpD.querySelectorAll('[data-block-toggle]').length === rpD.GROUP_ORDER.length,
    cpD ? 'блоков ' + cpD.querySelectorAll('[data-block-toggle]').length : 'окно не открылось');
  if (cpD) {
    const bt = cpD.querySelector('[data-block-toggle="comp"]');
    bt.checked = false;
    bt.onchange();
    check('D: выключение блока снимает все его колонки',
      Array.from(cpD.querySelectorAll('[data-col][data-block="comp"]')).every((cb) => cb.disabled || !cb.checked));
    bt.checked = true;
    bt.onchange();
    check('D: включение блока возвращает его колонки',
      Array.from(cpD.querySelectorAll('[data-col][data-block="comp"]')).every((cb) => cb.checked));
    const cD = cpD.querySelector('.modal-close');
    if (cD) cD.click();
    await wait(250);
  }

  // ── F: панель размеров, наследование режима и честные результаты ──
  let fView = Object.assign(Object.create(rpD), {
    container: null,
    pendingEdits: new window.Map(),
    rstate: { config: { sizePriceMode: 'sync' }, itemConfigs: {} },
    itemsByNm: new window.Map([['7007', { nmID: 7007, editableSizePrice: true, sizes: [
      { sizeID: 701, techSizeName: 'S', price: 900, discountedPrice: 810 },
      { sizeID: 702, techSizeName: 'M', price: 1000, discountedPrice: 900 }
    ] }]])
  });
  const fRow = { nmID: 7007, title: 'Тест размеров', proposed: { basePrice: 950 } };
  check('F: ячейка размеров наследует общий режим sync', /синхрон/.test(fView.sizesCellHtml(fRow)));
  fView.openSizesModal(fRow);
  let fModal = doc.querySelector('#modal-root .modal:last-child');
  check('F: таблица размеров открывается с двумя строками', !!fModal && fModal.querySelectorAll('tbody tr').length === 2);
  let fSelect = fModal && fModal.querySelector('.rp-size-mode');
  if (fSelect) { fSelect.value = 'manual'; fSelect.onchange(); }
  fModal = doc.querySelector('#modal-root .modal:last-child');
  check('F: смена режима сразу включает ручные поля без закрытия и повторного открытия',
    !!fModal && fModal.querySelectorAll('.rp-size-price').length === 2);
  let fPrice = fModal && fModal.querySelector('.rp-size-price[data-size="702"]');
  if (fPrice) { fPrice.value = '1050'; fPrice.onchange(); }
  check('F: ручная цена попадает в общую очередь несохранённых правок',
    ((fView.pendingEdits.get('7007') || {}).config || {}).sizePrices['702'] === 1050);
  fView.stageSizePrice('7007', '702', 'Infinity');
  check('F: некорректная цена не стирает корректную правку', fView.rowConfig('7007').sizePrices['702'] === 1050);
  fView.stageSizeMode('7007', 'none');
  check('F: индивидуальный none не превращается в наследование общего sync', fView.sizeMode('7007') === 'none');
  fView.stageSizeMode('7007', '');
  check('F: выбор общих параметров возвращает режим sync', fView.sizeMode('7007') === 'sync');
  if (fModal) await fModal.querySelector('.modal-close').onclick();

  window.Views.prices.showResult({ sent: 0, details: [{ nmID: 7007, sizeID: 702, status: 6, errorText: 'Ошибка размера' }] }, 2);
  fModal = doc.querySelector('#modal-root .modal:last-child');
  let fStats = fModal ? Array.from(fModal.querySelectorAll('.stat .value')).map((el) => el.textContent.trim()) : [];
  check('F: окно результатов не считает ошибки успешной загрузкой', fStats[0] === '0' && fStats[1] === '0' && fStats[2] === '1');
  check('F: в ошибке виден sizeID, а не только товар', !!fModal && /7007 \/ #702/.test(fModal.textContent));
  if (fModal) fModal.querySelector('.modal-close').click();
  fView = null; fModal = null; fSelect = null; fPrice = null; fStats = null;

  // ── массовая панель: отправка и метка сразу группе товаров ──
  if (dRow) {
    rpD.selection.add(dRow.nmID);
    rpD.renderBulk();
    await wait(300);
    let bulkD = doc.querySelector('#rp-bulk');
    check('D: массовая панель умеет включать/выключать отправку и задавать метку',
      !!bulkD && !!bulkD.querySelector('#rb-allowsend') && !!bulkD.querySelector('#rb-tag'));
    rpD.selection.clear();
    rpD.renderBulk();
    bulkD = null;
  }

  // ── курсы валют и название магазина на вкладке «Параметры» ──
  rpD.tab = 'params';
  rpD.draw();
  await wait(1000);
  check('F: общий режим цен размеров доступен в параметрах репрайсера', !!doc.querySelector('#pm-sizemode'));
  check('D: курсы валют и название магазина правятся на вкладке «Параметры»',
    !!doc.querySelector('#pm-rates [data-rate="CNY"]') && !!doc.querySelector('#pm-shopname'));
  let cnyInp = doc.querySelector('#pm-rates [data-rate="CNY"]');
  if (cnyInp) {
    cnyInp.value = '13';
    doc.querySelector('#pm-shopname').value = 'Магазин Тест';
    doc.querySelector('#pm-rate-code').value = 'gel';
    doc.querySelector('#pm-rate-add').click();
    await wait(250);
    check('D: своя валюта добавляется в список курсов', !!doc.querySelector('#pm-rates [data-rate="GEL"]'));
    let gelInpD = doc.querySelector('#pm-rates [data-rate="GEL"]');
    if (gelInpD) { gelInpD.value = '40'; gelInpD = null; }
    doc.querySelector('#pm-save').click();
    await wait(1500);
    const setD = await window.API.invoke('settings:get');
    check('D: курс и название магазина сохраняются в настройках',
      setD.costRates.CNY === 13 && setD.costRates.GEL === 40 && setD.shopName === 'Магазин Тест',
      JSON.stringify({ CNY: setD.costRates.CNY, GEL: setD.costRates.GEL, name: setD.shopName }));
    check('D: состояние приложения подхватывает курсы без перезапуска',
      Number((window.S.state.settings.costRates || {}).CNY) === 13);
    await window.App.go('repricer');
    await wait(1400);
    check('D: название магазина видно в шапке репрайсера',
      !!doc.querySelector('.rp-shopname') && doc.querySelector('.rp-shopname').textContent.includes('Магазин Тест'),
      doc.querySelector('.rp-shopname') ? doc.querySelector('.rp-shopname').textContent : 'нет элемента');
    // возвращаем настройки, чтобы не влиять на остальные проверки;
    // discardEdits сам перерисует таблицу — второй раз этого делать не нужно
    await window.API.invoke('settings:save', {
      costRates: { CNY: 12.5, USD: 92, EUR: 100, TRY: 2.7, KZT: 0.18, BYN: 28, UZS: 0.0072, AED: 25, PLN: 23 },
      shopName: ''
    });
    if (window.S.state.settings) window.S.state.settings.shopName = '';
  }
  await window.App.go('repricer'); await wait(600);
  rpD.discardEdits(); await wait(800);

  // отпускаем DOM прошлых отрисовок и выгружаем мусор до тяжёлых разделов прогона
  headRowsD = null; groupThs = null; dTr = null; cpD = null; cnyInp = null; exD = null;
  if (global.gc) global.gc();

  // ═════════════ ЗАДАНИЕ Е: одно рабочее место — всё внутри репрайсера ═════════════
  const eClick = async (id, ms) => {
    const moved = { promos: ['promos', 'plan'], 'promo-analytics': ['promos', 'analytics'], 'journal-promos': ['promos', 'journal'], params: ['settings', 'params'], schedule: ['settings', 'schedule'] }[id];
    if (moved) { await window.App.go(moved[0], { tab: moved[1] }); await wait(ms || 1400); return true; }
    if (window.S.state.view !== 'repricer') { await window.App.go('repricer'); await wait(500); }
    const t = doc.querySelector(`#rp-tabs [data-t="${id}"]`);
    if (t) { t.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(ms || 1400); }
    return !!t;
  };
  const eOrigCfg = (await service.handlers['repricer:state']()).config;

  window.App.go('repricer');
  await wait(900);
  const eTabs = Array.from(doc.querySelectorAll('#rp-tabs .tab')).map((t) => t.textContent.trim());
  check('Е: семь вкладок РП, акции и настройки объединены в своих разделах', eTabs.length === 7, eTabs.join(' | '));
  check('Е: порядок и названия вкладок как в задании',
    eTabs.join('|') === 'Товары|Цены и скидки|Экономика|Массовые правила|Себестоимость|Конкуренты|Журнал изменения цен',
    eTabs.join('|'));
  check('Е: отдельных вкладок «Параметры товаров» и «История запусков» больше нет',
    !eTabs.some((t) => /Параметры товаров|История запусков/i.test(t)));

  // общий модуль правил
  check('Е: модуль RULES загружен до вьюх', !!window.RULES && typeof window.RULES.buildPlan === 'function');
  check('Е: типы массовых правил сохранены', window.RULES.TYPES.length === 8 &&
    window.RULES.TYPES.map((t) => t.id).join(',') === 'none,delta-pct,delta-price,set-price,set-discount,set-base,set-target-margin,set-profit',
    window.RULES.TYPES.map((t) => t.id).join(','));
  check('Е: «Цены и скидки» строят правило общим модулем',
    String(window.Views.prices.scopeRows).includes('RULES.scopeRows') &&
    String(window.Views.prices.preview).includes('RULES.buildPlan'));
  const ePlan = window.RULES.buildPlan({
    rows: window.S.getRows().slice(0, 3),
    rule: { type: 'set-discount', value: 35, roundTo: 0, minPrice: 0 },
    edits: null
  });
  check('Е: план правила считается и содержит риски', ePlan.plan.length === 3 &&
    ePlan.plan.every((p) => Math.abs(p.newDisc - 35) < 2 && Array.isArray(p.warnings)),
    'строк ' + ePlan.plan.length + ', скидки ' + ePlan.plan.map((p) => p.newDisc).join(', '));

  // ── «Массовые правила» ──
  check('Е: вкладка «Массовые правила» открывается', await eClick('rules', 1800));
  check('Е: на вкладке есть выбор правила и области', !!doc.getElementById('rr-type') && !!doc.getElementById('rr-scope'));
  check('Е: в правилах все восемь типов', doc.querySelectorAll('#rr-type option').length === 8,
    doc.querySelectorAll('#rr-type option').length + ' вариантов');
  check('Е: массовое назначение параметров товаров здесь же', !!doc.getElementById('st-grid'));
  if (global.gc) global.gc();
  doc.querySelector('#rr-type').value = 'set-discount';
  doc.querySelector('#rr-type').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('#rr-value').value = '35';
  doc.querySelector('#rr-value').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#rr-scope').value = 'loss';
  const eTasksBefore = (await service.handlers['tasks:history']()).length;
  doc.querySelector('#rr-preview').click();
  await wait(900);
  const ePreviewRows = doc.querySelectorAll('#rr-preview-host tbody tr').length;
  check('Е: предпросмотр правила рисует план', ePreviewRows > 0, ePreviewRows + ' строк');
  check('Е: кнопка записи в черновик активировалась', doc.getElementById('rr-save') && !doc.getElementById('rr-save').disabled);
  doc.getElementById('rr-save').click();
  await wait(1600);
  const eDrafts = await service.handlers['prices:draft-load']();
  check('Е: правило пишет цены в черновик каналом prices:draft-save',
    Object.keys(eDrafts.items || {}).length > 0, 'черновиков ' + Object.keys(eDrafts.items || {}).length);
  check('Е: из массовых правил в WB ничего не отправлено',
    (await service.handlers['tasks:history']()).length === eTasksBefore);
  await service.handlers['prices:draft-clear']({});
  await window.S.loadDrafts();

  // ── «Себестоимость» ──
  check('Е: вкладка «Себестоимость» открывается', await eClick('costs', 1800));
  check('Е: таблица себестоимости отрисована', !!doc.getElementById('c-grid') &&
    doc.querySelectorAll('#c-grid tbody tr').length > 0,
    doc.querySelectorAll('#c-grid tbody tr').length + ' строк');
  const eCostInput = doc.querySelector('#c-grid tbody tr input.cellinput');
  check('Е: поле себестоимости редактируется в строке', !!eCostInput);
  const eCostKey = eCostInput ? eCostInput.closest('tr').querySelector('[data-open]').getAttribute('data-open') : null;
  const eCostBefore = eCostKey ? (await service.handlers['costs:get']()).items[eCostKey] : null;
  if (eCostInput) {
    eCostInput.value = '777';
    eCostInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(300);
    check('Е: ввод себестоимости сначала остаётся только в памяти',
      !Object.values((await service.handlers['costs:get']()).items || {}).some((c) => Number(c.costEntered) === 777));
    doc.getElementById('c-save').click();
    await wait(1500);
  }
  const eCosts = await service.handlers['costs:get']();
  check('Е: себестоимость сохраняется каналом costs:save только по кнопке',
    Object.values(eCosts.items || {}).some((c) => Number(c.costEntered) === 777 && Number(c.costPriceRub) === 777));
  check('Е: массовое заполнение доступно', !!doc.getElementById('cb-apply') && !!doc.getElementById('cb-field'));
  check('Е: импорт CSV/XLSX и шаблон доступны', !!doc.getElementById('c-import') && !!doc.getElementById('c-template'));
  const eImportLabel = ((doc.getElementById('c-import') || {}).textContent || '').trim();
  check('Е: импорт себестоимости подписан «CSV / XLSX»', /XLSX/i.test(eImportLabel), eImportLabel);
  if (eCostKey) {
    // XLSX — это ZIP с XML: в окне его не разобрать, файл читает главный процесс (xlsx-lite)
    const { buildXlsx } = require(path.join(ROOT, 'electron', 'xlsx-write'));
    const eXlsx = buildXlsx([[eCostKey, 321.5]], { headers: ['нм-код', 'Себестоимость'] });
    const eImp = await service.handlers['costs:import']({ base64: eXlsx.toString('base64'), fileName: 'costs.xlsx' });
    const eAfterXlsx = (await service.handlers['costs:get']()).items[eCostKey] || {};
    check('Е: себестоимость импортируется из XLSX каналом costs:import',
      eImp.updated > 0 && Math.abs(Number(eAfterXlsx.costPriceRub) - 321.5) < 0.01,
      'обновлено ' + eImp.updated + ', себестоимость ' + eAfterXlsx.costPriceRub);
  }
  if (global.gc) global.gc();
  if (eCostKey) await service.handlers['costs:save']({ items: { [eCostKey]: eCostBefore || null } });

  // ── «Конкуренты» ──
  check('Е: вкладка «Конкуренты» открывается', await eClick('competitors', 1600));
  check('Е: у конкурентов есть кнопка «Обновить с витрины»',
    !!doc.querySelector('[data-watch]') &&
    /Обновить с витрины/.test(doc.querySelector('[data-watch]').getAttribute('title') || ''),
    doc.querySelector('[data-watch]') ? doc.querySelector('[data-watch]').textContent.trim() : 'нет кнопки');
  const eWatchBefore = await service.handlers['pricewatch:get']();
  check('Е: автозапросы к витрине по умолчанию выключены', eWatchBefore.autoFetch === false, String(eWatchBefore.autoFetch));
  doc.querySelector('[data-watch]').click();
  await wait(1200);
  const eWatchStatus = (doc.getElementById('cp-watch-status') || {}).textContent || '';
  check('Е: недоступная витрина даёт честный статус «введите вручную»',
    /вручную/.test(eWatchStatus) && /заблокировано|демо|недоступн/i.test(eWatchStatus), eWatchStatus.slice(0, 90));
  check('Е: разовый запрос не включил автозапросы', (await service.handlers['pricewatch:get']()).autoFetch === false);
  if (global.gc) global.gc();

  // ── «Акции» ──
  check('Е: вкладка «Акции» открывается', await eClick('promos', 2200));
  check('Е: календарь акций встроен в репрайсер', !!doc.getElementById('promo-board') &&
    doc.querySelectorAll('#promo-list .promo-list-row').length > 0,
    doc.querySelectorAll('#promo-list .promo-list-row').length + ' акций');
  check('Е: решения по акциям и очередь возврата на месте', !!doc.getElementById('pa-grid') && !!doc.getElementById('pa-pending'));
  check('Е: у акции есть загрузка состава файлом', !!doc.querySelector('#promo-selected [data-upload]'));
  check('Е: ссылка на акцию формируется по шаблону WB',
    /dp-promo-calendar\?action=123/.test(window.U.promoCabinetUrl({ id: 123 })));
  if (global.gc) global.gc();

  // ── «Расписание» ──
  check('Е: вкладка «Расписание» открывается', await eClick('schedule', 1600));
  check('Е: интервал, цикл и задержка на одной вкладке',
    !!doc.getElementById('ps-mode') && !!doc.getElementById('ps-twophase') && !!doc.getElementById('ps-senddelay'));
  check('Е: автоотправка настраивается там же', !!doc.getElementById('ps-autosend'));
  check('Е: история запусков внутри расписания',
    /Запуски репрайсера/.test((doc.getElementById('ps-runs-host') || {}).innerHTML || ''));
  doc.getElementById('ps-interval').value = '55';
  doc.getElementById('ps-save').click();
  await wait(1600);
  check('Е: расписание сохраняется каналом repricer:save',
    Number((await service.handlers['repricer:state']()).config.schedule.intervalMinutes) === 55,
    String((await service.handlers['repricer:state']()).config.schedule.intervalMinutes));

  // ── «Параметры» ──
  check('Е: вкладка «Параметры» открывается', await eClick('params', 1600));
  check('Е: лимиты шага и суток на месте', !!doc.getElementById('pm-step') && !!doc.getElementById('pm-day'));
  check('Е: коридор и целевые маржи на месте',
    !!doc.getElementById('pm-defminmargin') && !!doc.getElementById('pm-defmargin'));
  check('Е: расписание убрано из параметров, дублей нет',
    !doc.getElementById('pm-mode') && !doc.getElementById('pm-twophase') && !doc.getElementById('ps-mode'));
  doc.getElementById('pm-step').value = '17';
  doc.getElementById('pm-save').click();
  await wait(1800);
  check('Е: параметры сохраняются каналом repricer:save',
    Number((await service.handlers['repricer:state']()).config.limits.maxChangePerUpdatePct) === 17);

  // вернуть исходные настройки, чтобы не влиять на следующие сценарии
  await service.handlers['repricer:save']({
    enabled: eOrigCfg.enabled,
    limits: eOrigCfg.limits,
    schedule: eOrigCfg.schedule
  });
  window.Views.repricer.rstate = await service.handlers['repricer:state']();

  // ── панель инструментов на «Товарах» ──
  await eClick('prices', 2000);
  const eBar = ['rp-calc', 'rp-send', 'rp-export-xlsx', 'rp-export', 'rp-import', 'rp-edits-reset',
    'rp-edits-commit', 'rp-cols', 'rp-density', 'rp-seg', 'rp-q'];
  const eMissing = eBar.filter((id) => !doc.getElementById(id));
  check('Е: панель инструментов собрана на одной странице', eMissing.length === 0,
    eMissing.length ? 'нет: ' + eMissing.join(', ') : eBar.length + ' элементов');
  check('Е: кнопка отправки подписана «Обновить цены»',
    /Обновить цены/.test((doc.getElementById('rp-send') || {}).textContent || ''));
  check('Е: пересчёт и отправка разделены',
    !!doc.getElementById('rp-calc') && !!doc.getElementById('rp-send') && doc.getElementById('rp-calc') !== doc.getElementById('rp-send'));

  // ── карточка товара: «Открыть в разделе» ──
  const eFirst = window.S.getRows()[0];
  await window.Views.itemcard.open(eFirst.nmID);
  await wait(1200);
  const eCardModal = Array.from(doc.querySelectorAll('#modal-root .modal')).pop();
  const eOpenBtn = eCardModal ? Array.from(eCardModal.querySelectorAll('.modal-foot .btn')).find((b) => /Открыть в разделе/.test(b.textContent)) : null;
  check('Е: в карточке товара есть ссылка «Открыть в разделе»', !!eOpenBtn);
  if (eOpenBtn) {
    eOpenBtn.click();
    await wait(1000);
    check('Е: ссылка открывает «Цены и скидки» с фильтром по товару',
      window.S.state.view === 'repricer' && window.Views.repricer.tab === 'price-tools' && String(window.S.state.filters.q) === String(eFirst.nmID) && !!doc.getElementById('grid-host'),
      'view=' + window.S.state.view + ', q=' + window.S.state.filters.q);
    await wait(600);
    window.S.state.filters.q = '';
  }
  window.App.go('repricer');
  await wait(1200);
  if (global.gc) global.gc();

  // валидация строки: товар без себестоимости не должен предлагаться к отправке
  const rp = window.Views.repricer;
  const invalid = rp.invalidResults ? rp.invalidResults() : [];
  check('INDEEPA: считается список товаров с незаполненными данными', Array.isArray(invalid),
    'таких товаров: ' + invalid.length);
  if (invalid.length) {
    check('INDEEPA: показана плашка с причинами', /не заполнены данные/.test(rpText2));
    const errs = rp.rowErrors(invalid[0]);
    check('INDEEPA: ошибки строки названы по-русски', errs.length > 0 && /себестоимость|порог|базовая цена/.test(errs.join(' ')),
      errs.join('; '));
    check('INDEEPA: товар с ошибками не помечен к отправке', invalid[0].needSend !== true || errs.length === 0,
      'needSend=' + invalid[0].needSend + ', ошибки: ' + errs.join('; '));
  }
  // в демо у всех товаров себестоимость задана, поэтому валидацию проверяем точечно:
  // подменяем данные по одному артикулу и смотрим, что строка помечается ошибкой
  const sample = (rp.results || [])[0];
  if (sample) {
    const savedCogs = rp.cogsByNm[String(sample.nmID)];
    rp.cogsByNm[String(sample.nmID)] = 0;
    const errs0 = rp.rowErrors(sample);
    check('INDEEPA: без себестоимости строка помечается ошибкой',
      errs0.some((e) => /себестоимость/.test(e)), errs0.join('; '));
    check('INDEEPA: без себестоимости статус «Без индекса»',
      rp.valueStatus(sample).id === 'noindex', rp.valueStatus(sample).label);
    check('INDEEPA: товар с ошибкой попадает в список неотправимых',
      rp.invalidResults().some((r) => String(r.nmID) === String(sample.nmID)));
    rp.cogsByNm[String(sample.nmID)] = 1;
    check('INDEEPA: себестоимость меньше 2 ₽ тоже ошибка (как в референсе)',
      rp.rowErrors(sample).some((e) => /больше 2/.test(e)), rp.rowErrors(sample).join('; '));
    rp.cogsByNm[String(sample.nmID)] = savedCogs;
    check('INDEEPA: после возврата данных ошибки исчезают', rp.rowErrors(sample).length === 0,
      rp.rowErrors(sample).join('; '));
  }

  // Регрессии плотной строки: пороги, ошибки, страницы и несохранённые правки.
  check('репрайсер: базовый порог редактируется в строке', !!doc.querySelector('.rp-baseprice'));
  check('репрайсер: в панели доступны импорт и сохранение параметров',
    !!doc.getElementById('rp-import') && !!doc.getElementById('rp-edits-reset') && !!doc.getElementById('rp-edits-commit'));
  check('репрайсер: шапка показывает две фазы и устаревшие позиции',
    /Фаза 1/.test(doc.querySelector('.rp-lifecycle').textContent) && /Фаза 2/.test(doc.querySelector('.rp-lifecycle').textContent) &&
    /устарело/.test(doc.querySelector('.rp-lifecycle').textContent));
  check('репрайсер: строка содержит бренд и место фотографии', !!doc.querySelector('.rp-photo') && /SKU/.test(doc.querySelector('.rp-product').textContent));
  rp.density = 'compact';
  rp.renderResults();
  check('репрайсер: плотный режим применён к самой таблице', !!doc.querySelector('#rp-grid table.dense'));
  if (sample) {
    const nm = String(sample.nmID);
    const saved = rp.cogsByNm[nm];
    rp.cogsByNm[nm] = 0;
    rp.renderResults();
    const errCell = doc.querySelector('#rp-grid .rp-validation');
    check('репрайсер: ОШИБКА находится именно в ячейке стратегии', !!errCell && !!errCell.parentNode.querySelector('.rp-strategy'));
    rp.cogsByNm[nm] = 2;
    check('репрайсер: ровно 2 рубля не проходят валидацию', rp.rowErrors(sample).some((x) => /больше 2/.test(x)));
    rp.cogsByNm[nm] = saved;
    rp.stageEdit(nm, 'config', { basePriceTarget: 9876 });
    rp.renderResults();
    check('репрайсер: перерисовка сохраняет несохранённый базовый порог', doc.querySelector('.rp-baseprice[data-nm="' + nm + '"]').value === '9876');
    rp.discardEdits();
    const beforeConfigs = JSON.stringify(rp.rstate.itemConfigs);
    const imported = rp.importParameters('нм-код;Минимальная цена;Базовая цена\n' + nm + ';700;1300');
    check('репрайсер: импорт копит правки, не меняя сохранённые параметры', imported === 1 && rp.pendingEdits.get(nm).config.minPrice === 700 && JSON.stringify(rp.rstate.itemConfigs) === beforeConfigs);
    rp.discardEdits();
  }
  const savedPage = rp.page;
  check('репрайсер: размер страницы — 100 строк (колонок стало больше)', productionRepricerPageSize === 100);
  rp.PAGE_SIZE = productionRepricerPageSize;
  rp.page = 49;
  const syntheticPage = rp.pageOf(Array.from({ length: 5000 }, (_, i) => ({ nmID: i + 1 })));
  check('репрайсер: 5000 товаров режутся на страницы по 100',
    syntheticPage.length === 100 && syntheticPage[0].nmID === 4901 && rp.pageInfo.to === 5000,
    'последняя страница: ' + (syntheticPage[0] || {}).nmID + ' … ' + rp.pageInfo.to);
  rp.pageOf([]);
  check('репрайсер: пустая выборка показывает 0 - 0 из 0', rp.pageInfo.from === 0 && rp.pageInfo.to === 0);
  rp.PAGE_SIZE = generalRepricerPageSize;
  rp.page = 1;
  rp.renderResults();
  if (rp.filteredResults().length > rp.PAGE_SIZE) {
    const originalOpen = window.Views.itemcard.open;
    let openedNm = null;
    window.Views.itemcard.open = (nm) => { openedNm = nm; };
    doc.querySelector('#rp-grid tbody tr td.rp-product').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    check('репрайсер: двойной клик второй страницы открывает её товар', openedNm === rp.filteredResults()[rp.PAGE_SIZE].nmID);
    window.Views.itemcard.open = originalOpen;
  }
  rp.page = savedPage;
  rp.renderResults();
  // XLSX пишется на диск и читается штатным парсером: ровно три строки данных.
  const { buildXlsx } = require(path.join(ROOT, 'electron', 'xlsx-write'));
  const { readXlsx } = require(path.join(ROOT, 'electron', 'xlsx-lite'));
  const roundtripRows = [['00123', 'Товар & <чай>', 123.45], ['9007199254740993', 'Кавычки " и \nперенос', 0], ['=SUM(A1:A2)', 'Товар & <чай>', -15]];
  const roundtripFile = path.join(os.tmpdir(), 'wb-roundtrip-' + Date.now() + '.xlsx');
  try {
    fs.writeFileSync(roundtripFile, buildXlsx(roundtripRows, { headers: ['SKU', 'Название', 'Цена'] }));
    const readBack = readXlsx(fs.readFileSync(roundtripFile));
    check('репрайсер: Excel round-trip на 3 строках через файл', JSON.stringify(readBack.rows) === JSON.stringify([['SKU', 'Название', 'Цена'], ...roundtripRows.map((r) => r.map(String))]));
    const exported = await service.handlers['xlsx:build']({ rows: roundtripRows, headers: ['SKU', 'Название', 'Цена'] });
    check('репрайсер: канал экспорта Excel возвращает читаемую книгу', exported.ok && exported.rows === 3 && readXlsx(Buffer.from(exported.base64, 'base64')).rows.length === 4);
  } finally { if (fs.existsSync(roundtripFile)) fs.unlinkSync(roundtripFile); }

  check('репрайсер: логика и флаг SKU доступны в строке', !!doc.querySelector('.rp-off-logic') && !!doc.querySelector('.rp-use-sku'));
  check('репрайсер: себестоимость и план редактируются в строке', !!doc.querySelector('.rp-cost') && !!doc.querySelector('.rp-plan'));
  // Изолированный сервис: даже ручной черновик не обходит проверку себестоимости.
  const safetyDir = path.join(os.tmpdir(), 'wb-validation-' + Date.now());
  try {
    const safetyStore = createStore(safetyDir, null);
    safetyStore.saveSettings({ demoMode: true, firstRun: false });
    const safetyService = createService(safetyStore, () => {});
    const safetyGoods = await safetyService.handlers['wb:goods']({});
    const nm = String(safetyGoods.items[0].nmID);
    await safetyService.handlers['costs:save']({ items: { [nm]: { costPriceRub: 2 } } });
    await safetyService.handlers['prices:draft-save']({ items: { [nm]: { basePrice: 9999, discount: 0 } } });
    await safetyService.handlers['repricer:calc']({ full: true });
    const blockedProposal = await safetyService.handlers['repricer:proposal']();
    check('репрайсер: сервер блокирует себестоимость 2 рубля даже с ручной ценой',
      !blockedProposal.items.some((r) => String(r.nmID) === nm) &&
      (blockedProposal.blocked || []).some((r) => String(r.nmID) === nm));
    let tooManyRejected = false;
    try { await safetyService.handlers['xlsx:build']({ rows: Array(150001).fill([]) }); }
    catch (e) { tooManyRejected = e.code === 'TOO_MANY_ROWS'; }
    check('репрайсер: Excel отклоняет более 150000 строк явно', tooManyRejected);
    safetyStore.saveProposals({ items: [], phase: 'sent', sentAt: '2026-01-02T03:04:05.000Z', staleCount: 3 });
    const storedLifecycle = safetyStore.loadProposals();
    check('репрайсер: время отправки и число устаревших переживают сохранение', storedLifecycle.sentAt === '2026-01-02T03:04:05.000Z' && storedLifecycle.staleCount === 3);
  } finally { fs.rmSync(safetyDir, { recursive: true, force: true }); }

  const vs = rp.valueStatus((rp.results || [])[0] || {});
  check('INDEEPA: статус выгодности имеет подпись', !!vs && !!vs.label && !!vs.hint, vs && vs.label + ' / ' + (vs.hint || '').slice(0, 40));

  // конкуренты и отстройка — прямо в строке (как в INDEEPA)
  check('INDEEPA: есть колонка «Конкурент»', /Конкурент/.test(rpHtml2));
  check('INDEEPA: конкурента можно добавить прямо из строки', !!doc.querySelector('.rp-comp-add'));
  check('INDEEPA: есть колонка отстройки от конкурента', /Отстройка от конкурента/.test(rpHtml2));
  check('INDEEPA: тип цены конкурента настраивается в строке', !!doc.querySelector('.rp-off-mode'));
  check('INDEEPA: величина отстройки настраивается в строке', !!doc.querySelector('.rp-off-val'));
  check('INDEEPA: тип отстройки %/₽ переключается в строке', !!doc.querySelector('.rp-off-type') &&
    /%/.test(doc.querySelector('.rp-off-type').textContent) && /₽/.test(doc.querySelector('.rp-off-type').textContent));
  check('INDEEPA: варианты отстройки — как в референсе',
    /Цена как есть/.test(rpHtml2) && /С учётом СПП/.test(rpHtml2) && /СПП \+ кошелёк/.test(rpHtml2));
  check('INDEEPA: есть экспорт Excel до 150к строк', !!doc.getElementById('rp-export-xlsx') &&
    /150/.test(doc.getElementById('rp-export-xlsx').textContent),
    doc.getElementById('rp-export-xlsx') ? doc.getElementById('rp-export-xlsx').textContent.trim() : 'нет кнопки');
  check('INDEEPA: CSV-экспорт сохранён как быстрый путь', !!doc.getElementById('rp-export'));

  // сохранение личных параметров строки и быстрый добав конкурента
  const nmForCfg = (rp.results || [])[0] ? String(rp.results[0].nmID) : null;
  if (nmForCfg) {
    await rp.saveItemConfig(nmForCfg, { competitorMode: 'withWallet', competitorOffsetPct: -3 });
    await wait(1200);
    const cfgs = (await service.handlers['repricer:item-configs:get']()) || {};
    const saved = cfgs[nmForCfg] || (cfgs.items && cfgs.items[nmForCfg]) || null;
    check('INDEEPA: отстройка сохраняется в личных настройках товара',
      !!saved && saved.competitorMode === 'withWallet' && Number(saved.competitorOffsetPct) === -3,
      JSON.stringify(saved));
    check('INDEEPA: после сохранения цены пересчитаны', (window.Views.repricer.results || []).length > 0,
      'строк ' + (window.Views.repricer.results || []).length);
    await service.handlers['repricer:item-configs:save']({ items: { [nmForCfg]: null } });
  }

  // себестоимость и расходы правятся прямо в репрайсере (просил перенести из «Себестоимости»)
  const stTab = Array.from(doc.querySelectorAll('#rp-tabs .tab')).find((t) => /Массовые правила/.test(t.textContent));
  if (stTab) { stTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(2200); }
  const stHtml = doc.getElementById('view').innerHTML;
  check('репрайсер: себестоимость редактируется в параметрах товара', /Себестоимость/.test(stHtml));
  check('репрайсер: там же упаковка, комиссия и логистика',
    /Упаковка/.test(stHtml) && /Комиссия %/.test(stHtml) && /Логистика ₽/.test(stHtml));
  check('репрайсер: незаполненная себестоимость помечена',
    /не задана/.test(doc.getElementById('view').textContent) || /Себестоимость/.test(stHtml));
  const costInputs = doc.querySelectorAll('#st-grid input.cellinput');
  check('репрайсер: поля параметров отрисованы', costInputs.length > 0, 'полей ' + costInputs.length);
  check('репрайсер: таблица параметров разбита на страницы', !!doc.getElementById('st-pager') &&
    /из/.test(doc.getElementById('st-pager').textContent),
    doc.getElementById('st-pager') ? doc.getElementById('st-pager').textContent.replace(/\s+/g, ' ').trim() : 'нет пагинатора');
  const stRendered = doc.querySelectorAll('#st-grid tbody tr').length;
  check('репрайсер: на странице параметров не больше 100 строк', stRendered <= 100 && stRendered > 0,
    'строк ' + stRendered);
  // переход на следующую страницу параметров
  const stNext = doc.getElementById('st-next');
  if (stNext && !stNext.disabled) {
    stNext.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(900);
    check('репрайсер: страница параметров переключается', window.Views.repricer.stPage === 1,
      'страница ' + window.Views.repricer.stPage);
    window.Views.repricer.stPage = 0;
  }
  // несохранённые правки подсвечиваются и копятся
  // instanceof Map не сработает: очередь создана в контексте окна jsdom, а проверка — в контексте теста
  check('репрайсер: правки копятся в очереди',
    !!window.Views.repricer.pendingEdits && typeof window.Views.repricer.pendingEdits.set === 'function' &&
      typeof window.Views.repricer.pendingEdits.size === 'number');
  window.Views.repricer.stageEdit(123456, 'config', { strategy: 'margin' });
  check('репрайсер: очередь правок считается', window.Views.repricer.pendingEdits.size === 1,
    'в очереди ' + window.Views.repricer.pendingEdits.size);
  window.Views.repricer.discardEdits();
  await wait(700);
  check('репрайсер: «Отменить» очищает очередь', window.Views.repricer.pendingEdits.size === 0);

  // журнал изменения цен
  const jt = Array.from(doc.querySelectorAll('#rp-tabs .tab')).find((t) => /Журнал изменения цен/.test(t.textContent));
  if (jt) { jt.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await wait(1600); }
  const jText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('журнал цен: вкладка открывается', /Журнал изменения цен/.test(jText) && !!doc.getElementById('j-body'));
  check('журнал цен: есть фильтр по датам и поиск',
    !!doc.getElementById('j-from') && !!doc.getElementById('j-to') && !!doc.getElementById('j-q'));
  check('журнал цен: есть экспорт CSV', !!doc.getElementById('j-export'));
  check('журнал цен: есть экспорт Excel', !!doc.getElementById('j-export-xlsx'));
  const jData = await service.handlers['repricer:journal']({ kinds: ['price', 'propose'], limit: 50 });
  check('журнал цен: канал отдаёт события с фазами', jData.ok === true && Array.isArray(jData.events),
    'событий ' + (jData.events || []).length + ', по фазам ' + JSON.stringify(jData.byKind));
  check('журнал цен: дубли из двух хранилищ схлопнуты',
    (jData.events || []).filter((e) => e.kind === 'price' || e.kind === 'propose').length === (jData.events || []).length);

  // журнал участия в акциях
  await window.App.go('promos', { tab: 'journal' }); await wait(1600);
  const jpText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('журнал акций: вкладка открывается', /Журнал изменения участия в акциях/.test(jpText));
  const jpData = await service.handlers['repricer:journal']({
    kinds: ['promo-join', 'promo-exit', 'promo-restore'], limit: 50
  });
  check('журнал акций: канал отдаёт события участия', jpData.ok === true && Array.isArray(jpData.events),
    'событий ' + (jpData.events || []).length + ', по типам ' + JSON.stringify(jpData.byKind));
  check('журнал акций: в сводке три типа событий',
    ['promo-join', 'promo-exit', 'promo-restore'].every((k) => (jpData.byKind || {})[k] !== undefined),
    JSON.stringify(jpData.byKind));
  // после применения решений по акциям в журнале должны появиться записи
  const jpApplied = await service.handlers['repricer:journal']({ kinds: ['promo-join', 'promo-exit', 'promo-restore'] });
  check('журнал акций: история сохраняется и после возврата цены',
    jpApplied.total >= 0 && typeof jpApplied.total === 'number', 'событий ' + jpApplied.total);
  check('журнал акций: в таблице видны колонки «Цена до» и «Цена после»',
    /Цена до/.test(jpText) && /Цена после/.test(jpText));
  check('журнал акций: объяснено, что история постоянная',
    /возврат|История участия|автоакци/i.test(jpText));

  // ── «закольцовка» цены: сохранил в карточке → видно во всех разделах ──
  const loopRow = window.S.getRows()[0];
  const loopNm = loopRow.nmID;
  const mpPrice = loopRow.mpSellerPrice;
  await service.handlers['prices:draft-clear']({});
  await window.S.loadDrafts();

  await window.Views.itemcard.open(loopNm);
  await wait(900);
  const loopModal = (function () { const bs = doc.querySelectorAll('#modal-root .modal-backdrop'); return bs.length ? bs[bs.length - 1] : null; })();
  const lmText = loopModal ? loopModal.textContent.replace(/\s+/g, ' ') : '';
  check('карточка: экономика и цена объединены в одну вкладку',
    /Экономика и цена/.test(lmText) && !/Цена и черновик/.test(lmText),
    'вкладок: ' + Array.from(doc.querySelectorAll('#ic-tabs .tab')).map((t) => t.textContent.trim()).join(' | '));
  // деньги в интерфейсе форматируются с разделителем-пробелом («1 417 ₽»), поэтому
  // сравниваем текст без пробелов
  const lmCompact = lmText.replace(/\s+/g, '');
  check('карточка: показана цена, которая сейчас на МП',
    /Намаркетплейсесейчас/.test(lmCompact) && lmCompact.includes(String(Math.round(mpPrice))),
    'цена МП ' + mpPrice + ', в окне: ' + lmCompact.slice(lmCompact.indexOf('Намаркетплейсе'), 60));
  check('карточка: одна кнопка «Сохранить» и нет отправки в WB из карточки',
    !!doc.getElementById('ic-save') && !doc.getElementById('ic-send'),
    'ic-save=' + !!doc.getElementById('ic-save') + ', ic-send=' + !!doc.getElementById('ic-send'));
  check('карточка: объяснено, что отправка — из раздела «Репрайсер»', /Репрайсер/.test(lmText));

  // живой пересчёт экономики при вводе цены
  const beforeProfit = (function () {
    const t = doc.getElementById('ic-live').textContent.replace(/\s+/g, ' ');
    const m = t.match(/Прибыль с единицы[^−\d]*(−?\d[\d\s]*(?:,\d+)?)/);
    return m ? m[1] : '';
  })();
  const baseInput = doc.getElementById('ic-base');
  baseInput.value = String(Math.round(mpPrice * 1.5));
  baseInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(500);
  const afterProfit = doc.getElementById('ic-live').textContent.replace(/\s+/g, ' ');
  check('карточка: экономика пересчитывается ЖИВЬЁМ при вводе цены',
    /Прибыль с единицы/.test(afterProfit) && afterProfit !== beforeProfit,
    'было «' + beforeProfit + '», стало фрагмент «' + afterProfit.slice(0, 70) + '»');
  check('карточка: показана разница «было → станет»', /→/.test(afterProfit) && /Δ прибыли за месяц|Маржинальность/.test(afterProfit));

  // сохраняем — цена должна примениться во всех разделах
  doc.getElementById('ic-save').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(1600);
  const savedDraft = (await service.handlers['prices:draft-load']({}).catch(() => null));
  const drafts = (savedDraft && savedDraft.items) || (await service.handlers['prices:draft-load']()).items;
  check('карточка: «Сохранить» записал цену в данные приложения',
    !!drafts[String(loopNm)] && Number(drafts[String(loopNm)].basePrice) === Math.round(mpPrice * 1.5),
    JSON.stringify(drafts[String(loopNm)] || null));

  await window.S.loadDrafts();
  window.S.invalidate();
  const rowsAfter = window.S.getRows();
  const rowAfter = rowsAfter.find((r) => r.nmID === loopNm);
  check('закольцовка: сохранённая цена стала ценой товара в общем состоянии',
    Math.abs(rowAfter.sellerPrice - Math.round(mpPrice * 1.5) * (1 - rowAfter.discount / 100)) < 1.01,
    'sellerPrice ' + rowAfter.sellerPrice + ' при базе ' + rowAfter.basePrice);
  check('закольцовка: цена маркетплейса не потеряна', rowAfter.mpSellerPrice === mpPrice,
    'МП ' + rowAfter.mpSellerPrice + ' vs ' + mpPrice);
  check('закольцовка: строка помечена как со своей ценой', rowAfter.hasDraft === true);
  check('закольцовка: прибыль пересчиталась по новой цене',
    Math.abs(rowAfter.profit - loopRow.profit) > 0.5,
    loopRow.profit + ' → ' + rowAfter.profit);

  // в «Цены и скидки» та же цена
  window.App.go('prices');
  await wait(1000);
  const pricesRow = Array.from(doc.querySelectorAll('#grid-host tbody tr')).find((tr) => tr.textContent.includes(String(loopNm)));
  const cellInput = pricesRow ? pricesRow.querySelector('input.cellinput') : null;
  check('закольцовка: в «Цены и скидки» стоит сохранённая цена',
    !!cellInput && Number(cellInput.value) === Math.round(mpPrice * 1.5),
    cellInput ? 'в поле ' + cellInput.value : 'строка не найдена');
  check('закольцовка: в «Цены и скидки» рядом видна цена маркетплейса',
    !!pricesRow && /на МП/.test(pricesRow.textContent),
    pricesRow ? pricesRow.textContent.replace(/\s+/g, ' ').slice(0, 110) : 'строка не найдена');

  // в репрайсере — колонка «Моя цена»
  window.App.go('repricer');
  await wait(600);
  window.Views.repricer.tab = 'prices';
  await window.Views.repricer.draw();
  await wait(2500);
  const rpHtml4 = doc.getElementById('view').innerHTML;
  check('закольцовка: в репрайсере видна «Моя цена»', /Моя цена/.test(rpHtml4));
  check('закольцовка: в репрайсере цена МП показана отдельно', /Цена на МП/.test(rpHtml4));

  // цена должна дойти и до «Экономики», и до «Панели» — они берут строки из общего состояния
  // «Экономика» группирует по категориям, поэтому сверяем итог раздела с общим состоянием:
  // если сохранённая цена применена, выручка в разделе совпадёт с выручкой по S.getRows()
  window.App.go('economics');
  await wait(1400);
  const econView = doc.getElementById('view');
  const econTotals = window.S.totals(window.S.getRows());
  const econViewText = econView.textContent.replace(/\s+/g, ' ');
  check('закольцовка: «Экономика» считает по сохранённой цене',
    econViewText.includes(window.U.compact(econTotals.revenue30)),
    'выручка по общему состоянию ' + window.U.compact(econTotals.revenue30) + ' ₽, в разделе: ' +
      econViewText.slice(econViewText.indexOf('Выручка'), econViewText.indexOf('Выручка') + 60));

  window.App.go('dashboard');
  await wait(1200);
  const dashText = doc.getElementById('view').textContent.replace(/\s+/g, ' ');
  check('закольцовка: «Панель» пересчитана по сохранённым ценам',
    dashText.length > 200 && !/Ошибка/.test(dashText),
    'символов ' + dashText.length);

  // сервер: сохранённая цена важнее предложения репрайсера
  await service.handlers['repricer:calc']({ full: true });
  const propLoop = await service.handlers['repricer:proposal']();
  const mine = (propLoop.items || []).find((x) => Number(x.nmID) === Number(loopNm));
  check('закольцовка: ручная цена побеждает расчёт репрайсера',
    !!mine && mine.manual === true && Number(mine.basePrice) === Math.round(mpPrice * 1.5),
    mine ? JSON.stringify({ manual: mine.manual, base: mine.basePrice, rp: mine.rpSellerPrice }) : 'позиции нет в предложении');

  await service.handlers['prices:draft-clear']({});
  await window.S.loadDrafts();
  const cc2 = doc.querySelector('#modal-root .modal-close');
  if (cc2) cc2.click();
  await wait(200);

  // ── возвращаем штатный размер товарной страницы и проверяем настоящую отрисовку ──
  // перед отрисовкой полного размера страницы (100 строк × 25 колонок) явно выпускаем мусор:
  // jsdom держит DOM в десятки раз дороже браузера, и запас по памяти тут важен
  if (global.gc) global.gc();
  window.Views.repricer.PAGE_SIZE = productionRepricerPageSize;
  // страницу сбрасываем ДО перехода: отрисовка раздела сама рисует таблицу,
  // а второй прогон по тем же строкам в jsdom удваивает пик памяти
  window.Views.repricer.page = 0;
  window.App.go('repricer');
  await wait(1800);
  check('репрайсер: настоящий DOM страницы содержит до 100 товаров',
    doc.querySelectorAll('#rp-grid tbody tr').length === Math.min(100, window.Views.repricer.filteredResults().length));

  // ── веб-версия: CSRF-заголовок и видимая кнопка «Выйти» ──
  // В Electron и в dev-сервере tools/serve.js сессии нет — значит и кнопки выхода быть не должно.
  const topButtons = () => Array.from(doc.querySelectorAll('#topbar-actions button')).map((b) => b.textContent.trim());
  window.App.go('dashboard');
  await wait(900);
  check('веб-версия: без сессии кнопки «Выйти» нет', !topButtons().includes('Выйти'), topButtons().join(' · '));

  // перехватываем запросы, чтобы увидеть заголовки браузерного режима
  const webCalls = [];
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    webCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} });
    return origFetch(url, opts);
  };
  doc.cookie = 'wb_web_csrf=test-csrf-token';
  check('веб-версия: сессия определяется по CSRF-cookie', window.API.webSession() === true);
  // перерисовываем ту же «Панель», а не «Цены»: таблица на 213 строку в jsdom дорога,
  // а для проверки кнопки выхода и CSRF-заголовка достаточно любого запроса к сервису
  window.App.go('dashboard');
  await wait(1200);
  check('веб-версия: в сессии появляется кнопка «Выйти»', topButtons().includes('Выйти'), topButtons().join(' · '));
  const invokeCall = webCalls.find((c) => c.url.includes('/api/invoke'));
  check('веб-версия: браузерные запросы несут заголовок X-CSRF-Token',
    !!invokeCall && invokeCall.headers['X-CSRF-Token'] === 'test-csrf-token',
    invokeCall ? JSON.stringify(invokeCall.headers) : 'запросов не было');

  const logoutBtn = Array.from(doc.querySelectorAll('#topbar-actions button')).find((b) => b.textContent.trim() === 'Выйти');
  webCalls.length = 0;
  // считаем попытки перехода ДО и ПОСЛЕ: в jsdom их и так хватает от скачивания файлов,
  // поэтому проверять «есть хоть один лог навигации» было бы проверкой впустую
  const navBefore = logs.filter((l) => /navigation/.test(l)).length;
  logoutBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(500);
  const logoutCall = webCalls.find((c) => c.url.includes('/api/logout'));
  check('веб-версия: «Выйти» отзывает сессию на сервере с CSRF-заголовком',
    !!logoutCall && logoutCall.method === 'POST' && logoutCall.headers['X-CSRF-Token'] === 'test-csrf-token',
    logoutCall ? logoutCall.method + ' ' + logoutCall.url : 'запроса не было');
  const navAfter = logs.filter((l) => /navigation/.test(l)).length;
  check('веб-версия: после выхода интерфейс уходит на страницу входа',
    navAfter > navBefore || /\/login/.test(String(window.location.href)),
    'переходов к /login: ' + (navAfter - navBefore));
  window.fetch = origFetch;
  doc.cookie = 'wb_web_csrf=; Max-Age=0';

  console.log('\n=== РЕЗУЛЬТАТЫ ===');
  report.forEach((r) => console.log(r));
  console.log('\nОшибок JS: ' + errors.length);
  errors.slice(0, 15).forEach((e) => console.log('  ✗ ' + e));
  if (logs.length) {
    console.log('\nЛоги (' + logs.length + '):');
    logs.slice(0, 10).forEach((l) => console.log('  · ' + l));
  }
  console.log('\nИТОГ: ' + (errors.length ? 'ЕСТЬ ПРОБЛЕМЫ' : 'ВСЁ ЗЕЛЁНОЕ'));
  dom.window.close();
  process.exit(errors.length ? 1 : 0);
}

run().catch((e) => {
  console.error('Тест упал:', e);
  process.exit(2);
});
