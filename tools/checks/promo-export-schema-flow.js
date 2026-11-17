'use strict';

/** Заголовки сверены с PDF владельца; товары/значения и XLSX полностью синтетические. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parsePromoNoms, bestPromoTable } = require('../../electron/promo-import');
const { readTable, parseSheet } = require('../../electron/xlsx-lite');
const { createStore } = require('../../electron/store');
const { createService } = require('../../electron/service');
const fixture = require('./fixtures/promo-wb-export-pdf-schema-synthetic.json');
const xlsx = fs.readFileSync(path.join(__dirname, 'fixtures/promo-wb-export-pdf-schema-synthetic.xlsx'));
let pass = 0, fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const one = (patch = {}, headers = fixture.headers) => {
  const row = Object.fromEntries(fixture.headers.map((h, i) => [h, fixture.rows[0][i]]));
  Object.assign(row, patch);
  return parsePromoNoms([headers, headers.map((h) => row[h] ?? '')]);
};
const current = 'Текущая скидка на сайте, %', loaded = 'Загружаемая скидка для участия в акции';
const flag = 'Товар уже участвует в акции', status = 'Статус';
const wb = 'Остаток товара на складах Wb (шт.)', seller = 'Остаток товара на складе продавца Wb (шт.)';
async function rejects(name, fn, message) {
  let error; try { await fn(); } catch (e) { error = e; }
  check(name, !!error && (!message || message.test(error.message)), error && error.message);
}

(async () => {
  const raw = parsePromoNoms([fixture.headers, ...fixture.rows]);
  const parsed = bestPromoTable(readTable(xlsx, 'synthetic.xlsx'));
  const first = parsed.items[0], second = parsed.items[1];
  check('Фикстура явно обозначена синтетической, не файлом владельца', /Синтетические/.test(fixture._note));
  check('В схеме все 17 заголовков PDF в исходном порядке', fixture.headers.length === 17 && fixture.headers[5] === 'Артикул WB' && fixture.headers[11] === 'Плановая цена для акции' && fixture.headers[16] === 'Статус');
  check('XLSX: инструкция пропущена, найдены 4 вымышленных товара', parsed.sheet === 'sheet2' && parsed.items.length === 4);
  check('XLSX: заголовки прочитаны полностью, не обрезаны по ширине', equal(parsed.headers, fixture.headers) && parsed.headerRow === 1);
  check('XLSX и табличные строки дают одинаковые поля', equal(raw.items, parsed.items));
  check('Предмет не подменяет полное наименование', first.title === fixture.rows[0][3] && first.title !== first.categoryName);
  check('Предмет сохранён как категория', first.categoryName === fixture.rows[0][2]);
  check('Бренд сохранён отдельно от категории и названия', first.brand === fixture.rows[0][1]);
  check('Артикул поставщика сохранён', first.vendorCode === 'PDF-TEST-1');
  check('nmID взят из Артикул WB, а не из баркода', first.nmID === 100000101);
  check('Научный формат отображения Excel не округляет nmID', parsed.items[3].nmID === 1234567890);
  check('Последний баркод не стал отдельным товаром', !parsed.items.some((i) => i.nmID === 4600000000001));
  check('Плановая цена прочитана точно, без вычисления по целому проценту', first.planPrice === 1750 && first.planPrice !== first.price * (1 - first.planDiscount / 100));
  check('Текущая скидка читается отдельно', first.discount === 5);
  check('Загружаемая скидка не подменяет текущую', first.planDiscount === 13 && first.discount !== first.planDiscount);
  check('Текущая розничная цена — база до скидки', first.price === 2000);
  check('Валюта прочитана из отдельной колонки', first.currency === 'RUB');
  check('Остаток WB/ВБ читается отдельно', first.stockWb === 3 && parsePromoNoms([['Артикул WB', 'Остаток на складах ВБ'], [100000101, 2]]).items[0].stockWb === 2);
  check('Склад продавца читается отдельно', first.stockSeller === 13);
  check('Общий остаток складывает два известных склада', first.stock === 16);
  check('Известные нулевые остатки не теряются', second.stockWb === 0 && second.stockSeller === 0 && second.stock === 0);
  check('Не участвует не превращается в положительный статус', first.inActionKnown && !first.inAction);
  check('Да и Участвует распознаются согласованно', second.inActionKnown && second.inAction);
  check('Полный текст статуса сохранён как снимок файла', first.fileStatus === fixture.rows[0][16]);
  check('Пустой бренд остаётся пустым, не берётся соседняя ячейка', parsed.items[2].brand === '' && parsed.items[2].categoryName === 'Третья категория');
  check('Нулевая текущая скидка — известное значение', parsed.items[3].discount === 0);
  check('Перестановка колонок не меняет распознавание', equal(one({}, [...fixture.headers].reverse()).items[0], raw.items[0]));
  check('Краткая Скидка не вытесняет точную загружаемую скидку', one({ 'Скидка': 99 }, ['Скидка', ...fixture.headers]).items[0].planDiscount === 13);
  check('Рекомендуемая цена не вытесняет точную плановую', one({ 'Рекомендуемая цена': 500 }, ['Рекомендуемая цена', ...fixture.headers]).items[0].planPrice === 1750);
  check('Только Предмет не выдаётся за название товара', parsePromoNoms([['Артикул WB', 'Предмет'], [100000101, 'Категория']]).items[0].title === '');
  check('Статус работает и без флага участия', one({}, fixture.headers.filter((h) => h !== flag)).items[0].inActionKnown);
  check('Не добавлен распознаётся как отрицательный статус', one({ [flag]: '', [status]: 'Не добавлен' }).items[0].inAction === false && one({ [flag]: '', [status]: 'Не добавлен' }).items[0].inActionKnown);
  check('Добавлен распознаётся как положительный статус', one({ [flag]: '', [status]: 'Добавлен' }).items[0].inAction);
  check('Пустой статус не считается известным неучастием', !one({ [flag]: '', [status]: '' }).items[0].inActionKnown);
  check('Нераспознанный статус не становится подтверждением', !one({ [flag]: '', [status]: 'Проверяется' }).items[0].inActionKnown);
  check('Флаг используется, когда текстовый статус пуст', one({ [flag]: 'Да', [status]: '' }).items[0].inAction);
  const conflict = one({ [flag]: 'Да' });
  check('Противоречащие друг другу флаг и статус не подтверждают участие', !conflict.items[0].inActionKnown && !conflict.items[0].inAction);
  check('Противоречие статусов видно в предупреждении', conflict.warnings.some((w) => /противоречат/.test(w)));
  check('Пустая текущая скидка не подменяется нулём', one({ [current]: '' }).items[0].discount === undefined);
  check('Некорректная текущая скидка не превращается в ноль', one({ [current]: 'нет данных' }).items[0].discount === undefined);
  check('Скидка вне диапазона не принимается за текущую', one({ [current]: 120 }).items[0].discount === undefined);
  check('Нет остатков — нет выдуманного нулевого остатка', one({ [wb]: '', [seller]: '' }).items[0].stock === undefined);
  const partialStock = one({ [seller]: '' }).items[0];
  check('Один склад не выдаётся за полный общий остаток', partialStock.stockWb === 3 && partialStock.stock === undefined && partialStock.stockSeller === undefined);
  check('Пропущенный WB не принимается за WB=0', one({ [wb]: '' }).items[0].stockWb === undefined && one({ [wb]: '' }).items[0].stockSeller === 13);
  check('Прежняя общая колонка Остаток совместима', parsePromoNoms([['Артикул WB', 'Остаток'], [100000101, 8]]).items[0].stock === 8);
  const duplicate = parsePromoNoms([fixture.headers, fixture.rows[0], fixture.rows[0]]);
  check('Повтор строки не удваивает остаток', duplicate.items.length === 1 && duplicate.items[0].stock === 16);
  const different = [...fixture.rows[0]]; different[9] = 7; different[11] = 1600;
  const sizes = parsePromoNoms([fixture.headers, fixture.rows[0], different]);
  check('Разные размерные остатки не складываются наугад', sizes.items[0].stockWb === undefined && sizes.items[0].stock === undefined && sizes.items[0].stockSeller === 13);
  check('Разный порог размеров объединяется безопасно по минимуму', sizes.items[0].planPrice === 1600 && sizes.warnings.some((w) => /меньший/.test(w)));
  const yes = [...fixture.rows[0]]; yes[0] = 'Да'; yes[16] = 'Участвует';
  const unknown = [...yes]; unknown[0] = ''; unknown[16] = '';
  check('Положительный статус одного размера не подтверждает весь товар', !parsePromoNoms([fixture.headers, yes, fixture.rows[0]]).items[0].inAction);
  check('Неизвестный второй размер не становится известным участником', !parsePromoNoms([fixture.headers, yes, unknown]).items[0].inActionKnown);
  check('Одноколоночный список nmID без заголовка совместим', parsePromoNoms([[100000101], [100000102]]).items.length === 2);
  check('Одна лишь колонка Баркод не становится nmID', parsePromoNoms([['Последний баркод'], ['4600000000001']]).items.length === 0);
  const csv = [fixture.headers, ...fixture.rows].map((row) => row.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
  check('CSV с точными 17 колонками даёт те же поля', equal(bestPromoTable(readTable(Buffer.from(csv), 'synthetic.csv')).items, raw.items));
  check('UTF-16 CSV с теми же колонками читается', bestPromoTable(readTable(Buffer.from('\ufeff' + csv, 'utf16le'), 'synthetic.csv')).items.length === 4);
  check('Процент в ячейке nmID не принимается за артикул', one({ 'Артикул WB': '100000101%' }).items.length === 0);
  check('Валюта в ячейке nmID не принимается за артикул', one({ 'Артикул WB': '100000101 RUB' }).items.length === 0);
  check('Слишком большой неточный nmID отклоняется', one({ 'Артикул WB': '9007199254740993' }).items.length === 0);
  check('Дробный nmID отклоняется', one({ 'Артикул WB': '100000101.5' }).items.length === 0);
  const scientific = parseSheet('<worksheet><row><c r="A1"><v>1.234567890E+09</v></c></row></worksheet>', [])[0][0];
  check('Полная научная запись числового значения XLSX читается без округления', parsePromoNoms([['Артикул WB'], [scientific]]).items[0].nmID === 1234567890);
  await rejects('PDF отклоняется с объяснением, а не читается как CSV', () => readTable(Buffer.from('%PDF-1.7\n'), 'source.pdf'), /PDF.*XLSX/);
  await rejects('Переименованный PDF определяется по сигнатуре', () => readTable(Buffer.from('%PDF-1.7\nАртикул WB\n100000101'), 'source.csv'), /PDF/);
  await rejects('PDF в текстовом входе тоже не становится таблицей', () => readTable('%PDF-1.7\n', ''), /PDF/);

  await serviceCases();
})().catch((error) => { fail++; console.error('FAIL исключение:', error.stack || error); }).finally(() => {
  console.log('\nИТОГО схема выгрузки WB по PDF: ' + pass + ' пройдено, ' + fail + ' ошибок');
  process.exitCode = fail ? 1 : 0;
});

async function serviceCases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-promo-schema-'));
  const store = createStore(dir, null);
  store.saveSettings({ demoMode: false, firstRun: false, promosFetchNomenclatures: false, promosInferFromDiscount: false });
  store.saveSecrets({ single: 'fixture-not-a-real-api-key' }); // исключаем демо-источник; сеть подменена
  const service = createService(store, () => {});
  let apiCalls = 0;
  service.handlers['wb:promo-nomenclatures'] = async () => { apiCalls++; throw new Error('API состава запрещён в тесте'); };
  service.handlers['wb:promos'] = async () => [{ id: 3148, name: 'Синтетическая акция', type: 'auto', requiredDiscountPct: 40,
    startDateTime: new Date(Date.now() - 86400000).toISOString(), endDateTime: new Date(Date.now() + 86400000).toISOString() }];
  const catalogItems = [
    { nmID: 100000101, price: 2200, discount: 0 },
    { nmID: 100000102, price: 2500, discount: 0 },
    { nmID: 100000103, price: 1800, discount: 0, editableSizePrice: true, sizes: [{ sizeID: 11, price: 1800 }, { sizeID: 12, price: 2100 }] }
    , { nmID: 1234567890 } // свой товар без живой цены: проверяем честный снимок файла
  ];
  service.getClient().getGoods = async () => ({ items: catalogItems, total: catalogItems.length, totalKnown: true, source: 'wb', complete: true, scope: 'full' });
  service.getClient().getCards = async () => [];
  const payload = { promotionID: 3148, fileName: 'synthetic.xlsx', base64: xlsx.toString('base64') };
  try {
    const before = JSON.stringify(store.loadPromoNoms()), config = JSON.stringify(store.loadRepricer());
    const preview = await service.handlers['promos:import-noms']({ ...payload, action: 'preview' });
    check('Сервис: предпросмотр возвращает все 4 строки и точные поля', preview.count === 4 && preview.items[0].discount === 5 && preview.items[0].categoryName === fixture.rows[0][2]);
    check('Сервис: предпросмотр не пишет состав', JSON.stringify(store.loadPromoNoms()) === before);
    await service.handlers['promos:import-noms']({ ...payload, action: 'apply' });
    const stored = store.loadPromoNoms()['3148'];
    check('Сервис: сохранение пишет все товары', stored.items.length === 4);
    check('Сервис: снимок текущей скидки не теряется при сохранении', stored.items[0].discount === 5 && stored.items[0].planDiscount === 13);
    check('Сервис: сохраняются оба склада, бренд и категория', stored.items[0].stockWb === 3 && stored.items[0].stockSeller === 13 && !!stored.items[0].brand && !!stored.items[0].categoryName);
    check('Сервис: условие — абсолютная плановая цена', stored.absolutePrices && stored.items[0].planPrice === 1750);
    const items = (await service.handlers['promos:items']({ promotionID: 3148 })).items;
    const first = items.find((i) => i.nmID === 100000101), second = items.find((i) => i.nmID === 100000102);
    check('Сервис: актуальная база WB важнее розничной цены файла', first.price === 2200);
    check('Сервис: актуальная нулевая скидка WB важнее 5% в файле', first.discount === 0 && first.discountSource === 'wb');
    check('Сервис: старая скидка 60% из файла не выдаётся за текущую', second.discount === 0);
    check('Сервис: файл не затирается при чтении актуальных цен', store.loadPromoNoms()['3148'].items[0].discount === 5);
    check('Сервис: точный порог не пересчитывается из загружаемых 13%', first.planPrice === 1750);
    check('Сервис: оба склада доходят до окна товаров', first.stockWb === 3 && first.stockSeller === 13 && first.stock === 16);
    check('Сервис: текстовый статус сохраняется отдельно от текущего наблюдения', second.fileStatus.startsWith('Участвует:') && !second.inAction && second.observation.status === 'above-price');
    check('Сервис: один дешёвый размер не подтверждает весь товар', items.find((i) => i.nmID === 100000103).observation.status === 'partial-sizes');
    const fallback = items.find((i) => i.nmID === 1234567890);
    check('Сервис: без цены WB доступен явно помеченный снимок файла', fallback.priceSource === 'file' && fallback.discountSource === 'file' && fallback.discount === 0);
    const selection = await service.handlers['promos:save-selection']({ promotionID: 3148, nmIDs: [100000101, 100000102] });
    check('Сервис: Сохранить выбор не отправляет его в WB', selection.sentToWb === false && selection.saved === 2);
    check('Сервис: импорт и выбор не включают автоотправку', JSON.stringify(store.loadRepricer()) === config && store.loadTasks().length === 0);
    check('Сервис: нет бесполезных запросов состава автоакции', apiCalls === 0);
    const stable = JSON.stringify(store.loadPromoNoms());
    await rejects('Сервис: PDF не сохраняется как пустая/ошибочная акция', () => service.handlers['promos:import-noms']({ ...payload, fileName: 'owner.pdf', base64: Buffer.from('%PDF-1.7').toString('base64'), action: 'apply' }), /PDF/);
    check('Сервис: ошибка PDF сохраняет прежние условия', JSON.stringify(store.loadPromoNoms()) === stable);
    await rejects('Сервис: файл с баркодами вместо nmID отклоняется', () => service.handlers['promos:import-noms']({ promotionID: 3148, rows: [['Последний баркод', 'Плановая цена для акции'], ['4600000000001', 1000]], action: 'apply' }), /nmID/);
    check('Сервис: неудачный новый импорт не стирает список и выбор', JSON.stringify(store.loadPromoNoms()) === stable);
  } finally { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}
