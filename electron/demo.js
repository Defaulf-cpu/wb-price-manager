'use strict';

/**
 * Демо-режим: генерирует правдоподобный «магазин» Wildberries,
 * чтобы приложение можно было изучить и показать заказчику без API-ключа.
 * Данные детерминированные (одинаковые при каждом запуске) и помечаются как демо.
 * Структура ответов полностью совпадает с нормализованными ответами WBClient.
 */

// единый нормализатор строк финансового отчёта — тот же, что использует боевой клиент
const { normalizeReportRow } = require('./wb-client');

const CATEGORIES = [
  { name: 'Женская одежда', commission: 22.5, ad: 8, pack: 15, vol: [0.6, 3.2], price: [890, 5200], cogs: [0.26, 0.44], brands: ['Mira Collection', 'Lina Studio', 'NORDVEK'], items: ['Платье летнее миди', 'Блуза шифоновая', 'Юбка плиссе', 'Кардиган вязаный', 'Брюки палаццо', 'Топ базовый', 'Жакет oversize', 'Худи с капюшоном'] },
  { name: 'Мужская одежда', commission: 22.5, ad: 8, pack: 15, vol: [0.8, 3.5], price: [990, 5900], cogs: [0.28, 0.45], brands: ['URBAN FOX', 'Graf Nord', 'BRUTALY'], items: ['Футболка хлопок', 'Рубашка оксфорд', 'Джинсы прямые', 'Свитшот флис', 'Куртка ветровка', 'Шорты спортивные'] },
  { name: 'Детская одежда', commission: 21, ad: 7, pack: 12, vol: [0.4, 2.0], price: [490, 2900], cogs: [0.24, 0.4], brands: ['Kids Land', 'Malinka', 'TOYWEAR'], items: ['Комбинезон детский', 'Футболка детская', 'Пижамный набор', 'Школьная рубашка', 'Колготки 3 шт'] },
  { name: 'Обувь', commission: 19.5, ad: 9, pack: 18, vol: [3.0, 9.0], price: [1490, 7900], cogs: [0.3, 0.48], brands: ['STEP&GO', 'Rialto', 'COMFORTA'], items: ['Кроссовки беговые', 'Ботинки демисезон', 'Сандалии', 'Кеды текстильные', 'Сапоги зимние'] },
  { name: 'Аксессуары', commission: 20, ad: 8, pack: 10, vol: [0.2, 1.6], price: [390, 3400], cogs: [0.18, 0.38], brands: ['Lumea', 'BagStory', 'FINECRAFT'], items: ['Сумка кросс-боди', 'Ремень кожаный', 'Шапка трикотажная', 'Перчатки сенсорные', 'Кошелёк компактный'] },
  { name: 'Косметика', commission: 17, ad: 12, pack: 14, vol: [0.1, 1.1], price: [290, 2400], cogs: [0.2, 0.42], brands: ['PURE LAB', 'BioDerm', 'AURA skin'], items: ['Сыворотка для лица', 'Крем увлажняющий', 'Шампунь бессульфатный', 'Тканевые маски 10 шт', 'Скраб для тела'] },
  { name: 'Товары для дома', commission: 21, ad: 10, pack: 25, vol: [2.0, 14.0], price: [590, 6900], cogs: [0.3, 0.5], brands: ['HomeStory', 'COSY', 'DomTek'], items: ['Постельное бельё 2-сп', 'Плед флисовый', 'Набор полотенец', 'Органайзер для белья', 'Термокружка 450 мл'] },
  { name: 'Электроника', commission: 12, ad: 6, pack: 30, vol: [0.2, 3.4], price: [690, 9900], cogs: [0.4, 0.62], brands: ['VoltEdge', 'TECHNOMAX', 'SoundPulse'], items: ['Наушники TWS', 'Powerbank 20000 mAh', 'Умная колонка', 'Фитнес-браслет', 'Беспроводная зарядка'] },
  { name: 'Игрушки', commission: 18, ad: 9, pack: 16, vol: [1.0, 8.0], price: [390, 3900], cogs: [0.25, 0.45], brands: ['PlayJoy', 'Кубик&Mama', 'FUNTOY'], items: ['Конструктор 240 дет', 'Мягкая игрушка мишка', 'Настольная игра', 'Машинка инерционная'] },
  { name: 'Спорт', commission: 19, ad: 8, pack: 20, vol: [1.0, 12.0], price: [690, 8900], cogs: [0.3, 0.5], brands: ['FITZONE', 'IronWill', 'SPORTLAB'], items: ['Коврик для йоги', 'Гантели 2×5 кг', 'Резинки фитнес 5 шт', 'Бутылка спортивная 750 мл'] }
];

const SIZE_SETS = [
  ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  ['36', '37', '38', '39', '40', '41'],
  ['ONE SIZE'],
  ['80', '92', '104', '116', '128'],
  ['200 мл', '500 мл']
];

/** Склады продавца (имитация /api/v3/warehouses) — с регионом, как в реальном ответе WB. */
const WAREHOUSES = [
  { id: 1, name: 'Коледино', region: 'Москва и Московская область', type: 'FBS', address: 'Москва, ул. Коледино, 1' },
  { id: 2, name: 'Электросталь', region: 'Московская область', type: 'FBS', address: 'Электросталь, ул. Ленина, 5' },
  { id: 3, name: 'Казань', region: 'Татарстан', type: 'FBS', address: 'Казань, ул. Пугачёва, 20' },
  { id: 4, name: 'Тула', region: 'Тульская область', type: 'FBS', address: 'Тула, ул. Металлургов, 8' },
  { id: 5, name: 'Краснодар', region: 'Краснодарский край', type: 'FBS', address: 'Краснодар, ул. Саратовская, 12' }
];

/** Простой детерминированный ГПСЧ (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCatalog(seed = 20261112) {
  const rnd = mulberry32(seed);
  const rand = (min, max) => min + rnd() * (max - min);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const goods = [];
  let nm = 148000000;
  let sizeId = 3100000000;

  CATEGORIES.forEach((cat, ci) => {
    const count = 18 + Math.floor(rnd() * 8);
    for (let i = 0; i < count; i++) {
      nm += 1000 + Math.floor(rnd() * 9000);
      const brand = pick(cat.brands);
      const title = pick(cat.items);
      const vendorCode = `${brand.slice(0, 2).toUpperCase()}-${String(ci + 1).padStart(2, '0')}${String(i + 1).padStart(3, '0')}`;
      const basePrice = Math.round(rand(cat.price[0], cat.price[1]) / 10) * 10 - 1;
      const discount = Math.round(rand(18, 68));
      const cogsRatio = rand(cat.cogs[0], cat.cogs[1]);
      const costPrice = Math.round(basePrice * (1 - discount / 100) * cogsRatio);
      const volume = Math.round(rand(cat.vol[0], cat.vol[1]) * 100) / 100;
      const sizeSet = pick(SIZE_SETS);
      const sizesCount = sizeSet.length === 1 ? 1 : 2 + Math.floor(rnd() * (sizeSet.length - 1));
      const editableSizePrice = sizeSet.length > 2 && rnd() > 0.75;

      const sizes = [];
      for (let s = 0; s < sizesCount; s++) {
        const techSizeName = sizeSet[s];
        const sPrice = editableSizePrice ? Math.round(basePrice * rand(0.92, 1.08)) : basePrice;
        const discountedPrice = Math.round(sPrice * (1 - discount / 100));
        sizes.push({
          sizeID: ++sizeId,
          techSizeName,
          price: sPrice,
          discountedPrice,
          clubDiscountedPrice: Math.round(discountedPrice * 0.95),
          isBadTurnover: rnd() > 0.9
        });
      }

      const salesPerDay = Math.max(0, Math.round(rand(0, 9) * rand(0.2, 1.4)));
      const stock = Math.round(rand(0, 480));
      const isBadTurnover = stock > 200 && salesPerDay < 1;

      goods.push({
        nmID: nm,
        vendorCode,
        brand,
        categoryName: cat.name,
        subjectName: cat.name,
        title: `${title} ${brand}`.trim(),
        price: basePrice,
        discount,
        discountedPrice: Math.round(basePrice * (1 - discount / 100)),
        clubDiscount: rnd() > 0.6 ? 5 : 0,
        currency: 'RUB',
        editableSizePrice,
        isBadTurnover,
        inPromo: false,           // заполняется ниже по календарю акций
        plannedPrice: 0,
        plannedDiscount: 0,
        promoPlanPrice: 0,        // плановая цена акции (порог участия)
        promoIds: [],             // в каких акциях участвует товар
        promoNames: [],
        volumeLiters: volume,
        sizesCount: sizes.length,
        sizes,
        // демо-поля себестоимости и продаж (в реальном режиме берутся из хранилища и статистики)
        demo: {
          costPrice,
          salesPerDay,
          stock,
          commission: cat.commission,
          adPct: cat.ad,
          packaging: cat.pack,
          spp: Math.round(rand(8, 24))
        }
      });
    }
  });

  return goods;
}

/** Статистика продаж за N дней (имитация ответов statistics-api). */
function buildStats(goods, days = 30) {
  const rnd = mulberry32(777);
  const today = new Date();
  const from = new Date(today.getTime() - days * 86400000);
  const rows = [];
  for (const g of goods) {
    const perDay = g.demo.salesPerDay;
    if (!perDay) continue;
    const n = Math.max(0, Math.round(perDay * days * (0.75 + rnd() * 0.5)));
    const warehouses = ['Коледино', 'Электросталь', 'Казань', 'Тула', 'Краснодар'];
    for (let i = 0; i < n; i++) {
      const d = new Date(from.getTime() + rnd() * (today.getTime() - from.getTime()));
      const price = g.discountedPrice;
      const spp = g.demo.spp;
      const forPay = Math.round(price * (1 - g.demo.commission / 100) * 100) / 100;
      rows.push({
        nmID: g.nmID,
        nmId: g.nmID,
        vendorCode: g.vendorCode,
        date: d.toISOString(),
        price,
        convertedPrice: price,
        salePercent: g.discount,
        spp,
        ppvz_for_pay: forPay,
        warehouseName: warehouses[Math.floor(rnd() * warehouses.length)],
        isReturn: rnd() > 0.94,
        subjectName: g.categoryName
      });
    }
  }
  return rows;
}

/** Календарь акций (имитация dp-calendar-api). */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (def === undefined ? 0 : def);
}

function buildPromotions(goods) {
  const rnd = mulberry32(4242);
  const now = new Date();
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const shift = (days) => new Date(now.getTime() + days * 86400000);

  const defs = [
    { name: 'Чёрная пятница', start: -2, end: 5, type: 'manual', joinType: 'Присоединиться вручную', required: 40, cats: null },
    { name: 'Скидки недели', start: 0, end: 7, type: 'auto', joinType: 'Автоматическое участие', required: 25, cats: null },
    { name: 'Новогодняя распродажа', start: 18, end: 45, type: 'manual', joinType: 'Присоединиться вручную', required: 45, cats: ['Товары для дома', 'Игрушки', 'Электроника', 'Косметика'] },
    { name: 'Товары для дома −30%', start: 3, end: 20, type: 'manual', joinType: 'Присоединиться вручную', required: 30, cats: ['Товары для дома'] },
    { name: 'Зимняя обувь', start: -5, end: 12, type: 'auto', joinType: 'Автоматическое участие', required: 20, cats: ['Обувь'] },
    { name: 'Бьюти-фестиваль', start: 6, end: 16, type: 'manual', joinType: 'Присоединиться вручную', required: 35, cats: ['Косметика'] }
  ];

  return defs.map((d, i) => {
    const id = 91000 + i;
    const eligible = goods.filter((g) => !d.cats || d.cats.includes(g.categoryName));
    const inAction = eligible.filter((g) => g.discount >= d.required);
    const candidates = eligible.filter((g) => g.discount < d.required);
    const inStock = inAction.reduce((s, g) => s + g.demo.stock, 0);
    return {
      id,
      name: d.name,
      description: `Акция «${d.name}»: скидка не ниже ${d.required}% от базовой цены. Участие даёт плашку акции и дополнительный трафик.`,
      startDateTime: iso(shift(d.start)),
      endDateTime: iso(shift(d.end)),
      type: d.type,
      joinType: d.joinType,
      requiredDiscountPct: d.required,
      participationPercentage: d.required,
      inActionTotal: eligible.length,
      inActionCount: inAction.length,
      notInActionCount: candidates.length,
      notInActionLeftovers: candidates.reduce((s, g) => s + g.demo.stock, 0),
      inActionStock: inStock,
      exceptionProductsCount: Math.floor(rnd() * 6),
      ranging: [{ condition: 'productsInPromotion', participationRate: d.required }],
      categories: d.cats || ['Все категории'],
      _eligible: eligible.map((g) => g.nmID),
      _inAction: inAction.map((g) => g.nmID)
    };
  });
}

/**
 * Конкуренты по артикулу (имитация данных конкурентного следования).
 * В реальном режиме список конкурентов ведёт пользователь (вручную или импортом CSV),
 * так как официальный WB API цены конкурентов в карточке не отдаёт.
 */
function buildCompetitors(goods) {
  const rnd = mulberry32(31337);
  const names = [
    'ООО «Ромашка»', 'ИП Кузнецов А.В.', 'BrandStore', 'MEGAMARKET',
    'ТД «Восток»', 'SHOP24', 'ИП Смирнова Е.П.', 'Retail Group', 'LUXTRADE'
  ];
  const out = {};
  for (const g of goods) {
    if (rnd() > 0.78) continue; // не у всех товаров есть отслеживаемые конкуренты
    const count = 2 + Math.floor(rnd() * 3);
    const buyerPrice = g.discountedPrice * (1 - g.demo.spp / 100);
    const list = [];
    for (let i = 0; i < count; i++) {
      const k = 0.78 + rnd() * 0.55;
      list.push({
        id: `${g.nmID}-c${i + 1}`,
        name: names[Math.floor(rnd() * names.length)],
        price: Math.round(buyerPrice * k),
        stock: rnd() > 0.2 ? Math.floor(rnd() * 300) : 0,
        enabled: rnd() > 0.15,
        rating: Math.round((3.8 + rnd() * 1.2) * 10) / 10,
        updatedAt: new Date().toISOString()
      });
    }
    out[String(g.nmID)] = list;
  }
  return out;
}

/**
 * Отчёт о реализации (имитация finance-api /api/finance/v1/sales-reports/detailed).
 * Именно здесь видна ФАКТИЧЕСКАЯ логистика и комиссия по каждой продаже —
 * они плавают от дня к дню (склад, коэффициент, доначисления), поэтому приложение
 * берёт среднее за окно (по умолчанию 7 дней).
 */
function buildFinanceReport(goods, salesRows) {
  const rnd = mulberry32(20260715);
  const byNm = {};
  goods.forEach((g) => { byNm[String(g.nmID)] = g; });
  const rows = [];
  let rrdId = 1000;

  for (const s of salesRows) {
    const g = byNm[String(s.nmID)];
    if (!g) continue;
    const volume = g.volumeLiters || 1;
    // тариф логистики плавает: база по объёму + суточный коэффициент склада + шум
    const tariffBase = volume > 5 ? 145 : 50 + Math.max(0, volume - 1) * 15;
    const dayFactor = 0.85 + rnd() * 0.4;
    const logistics = Math.round(tariffBase * dayFactor * 100) / 100;
    const commissionPct = Math.round((g.demo.commission + (rnd() - 0.5) * 1.2) * 100) / 100;
    const amount = s.price;
    const commission = Math.round(amount * commissionPct) / 100;
    const acquiring = Math.round(amount * 0.01 * 100) / 100;
    const storage = Math.round((1 + rnd() * 4) * 100) / 100;
    const acceptance = rnd() > 0.92 ? Math.round((20 + rnd() * 40) * 100) / 100 : 0;
    const isReturn = !!s.isReturn;

    rows.push({
      rrdId: rrdId++,
      reportId: 500000 + Math.floor(rnd() * 40),
      nmId: g.nmID,
      vendorCode: g.vendorCode,
      title: g.title,
      techSize: g.sizes && g.sizes.length ? g.sizes[0].techSizeName : 'ONE SIZE',
      sku: String(900000000 + g.nmID % 1000000),
      officeName: s.warehouseName || 'Коледино',
      docTypeName: isReturn ? 'Возврат' : 'Продажа',
      quantity: 1,
      rrDate: s.date,
      saleDt: s.date,
      retailPrice: String(g.price),
      retailPriceWithDisc: String(amount),
      retailAmount: String(amount),
      salePercent: g.discount,
      commissionPercent: commissionPct,
      commission: String(commission),
      deliveryService: String(logistics),
      returnService: isReturn ? String(logistics) : '0',
      storageFee: String(storage),
      paidAcceptance: String(acceptance),
      acquiringFee: String(acquiring),
      forPay: String(Math.round((amount - commission - acquiring) * 100) / 100),
      spp: s.spp,
      deduction: '0',
      penalty: '0'
    });
  }
  rows.sort((a, b) => String(a.rrDate).localeCompare(String(b.rrDate)));
  return rows;
}

/** Карточки товаров (имитация content-api). */
function buildCards(goods) {
  return goods.map((g) => ({
    nmID: g.nmID,
    vendorCode: g.vendorCode,
    brand: g.brand,
    title: g.title,
    subjectName: g.categoryName,
    volumeLiters: g.volumeLiters,
    dimensions: {
      length: Math.round(Math.cbrt(g.volumeLiters * 1000) * 1.4),
      width: Math.round(Math.cbrt(g.volumeLiters * 1000) * 1.1),
      height: Math.round(Math.cbrt(g.volumeLiters * 1000))
    }
  }));
}

/**
 * Остатки по складам (имитация /api/analytics/v1/stocks-report/wb-warehouses).
 * Один размер на одном складе — одна строка, как в реальном отчёте WB:
 * распределяем демо-остаток товара по 2–4 складам, сумма равна g.demo.stock.
 */
function buildStocks(goods) {
  const rnd = mulberry32(5150);
  const rows = [];
  for (const g of goods) {
    const total = g.demo.stock;
    if (total <= 0) continue;
    const count = 2 + Math.floor(rnd() * 3);
    const whs = WAREHOUSES.slice().sort(() => rnd() - 0.5).slice(0, count);
    const parts = whs.map(() => Math.max(0, Math.floor(total * (0.2 + rnd() * 0.8) / count)));
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    const sizeID = g.sizes && g.sizes[0] ? g.sizes[0].sizeID : 0;
    whs.forEach((wh, i) => {
      const qty = i === whs.length - 1 ? total - parts.slice(0, i).reduce((a, b) => a + b, 0) : parts[i];
      if (qty > 0) {
        rows.push({
          nmID: g.nmID,
          nmId: g.nmID,
          sizeID,
          stock: qty,
          warehouseId: wh.id,
          warehouseName: wh.name,
          region: wh.region
        });
      }
    });
  }
  return rows;
}

/**
 * Демо-API: повторяет интерфейс, используемый приложением,
 * но работает на локальных данных и ничего не отправляет в Wildberries.
 */
function createDemoApi(opts) {
  const goods = buildCatalog();
  const salesRows = buildStats(goods, 30);
  const promos = buildPromotions(goods);

  // проставляем в карточках участие в акциях и плановую цену —
  // в бою эти поля приходят из /api/v2/list/goods/filter (plannedPrice/planPrice)
  goods.forEach((g) => {
    const mine = promos.filter((pr) => pr._inAction.includes(g.nmID));
    g.inPromo = mine.length > 0;
    g.promoIds = mine.map((pr) => pr.id);
    g.promoNames = mine.map((pr) => pr.name);
    // плановая цена = порог участия; если акций несколько — самая жёсткая (минимальная)
    const plans = mine.map((pr) => Math.round(g.price * (1 - num(pr.requiredDiscountPct) / 100))).filter((x) => x > 0);
    g.promoPlanPrice = plans.length ? Math.min.apply(null, plans) : 0;
    g.plannedPrice = g.promoPlanPrice;
    g.plannedDiscount = g.promoPlanPrice ? Math.round((1 - g.promoPlanPrice / g.price) * 100) : 0;
    // участник акции обязан давать цену не выше плановой — иначе WB выводит товар сам
    if (g.inPromo && g.price * (1 - g.discount / 100) > g.promoPlanPrice) {
      g.discount = Math.min(90, Math.ceil((1 - g.promoPlanPrice / g.price) * 100));
      g.discountedPrice = Math.round(g.price * (1 - g.discount / 100));
    }
  });

  const cards = buildCards(goods);
  const competitors = buildCompetitors(goods);
  const financeRows = buildFinanceReport(goods, salesRows);
  const stockRows = buildStocks(goods);
  const tasks = [];
  let taskSeq = 5000;

  const byNm = new Map(goods.map((g) => [g.nmID, g]));

  /** Демо-значения себестоимости и расходов (в реальном режиме их задаёт пользователь). */
  function overridesOf(g) {
    return {
      costPriceRub: g.demo.costPrice,
      commissionPct: g.demo.commission,
      adPct: g.demo.adPct,
      packagingRub: g.demo.packaging,
      sppPct: g.demo.spp,
      storageRub: Math.round(2 + g.volumeLiters * 1.5),
      volumeLiters: g.volumeLiters,
      stock: g.demo.stock,
      salesPerDay: g.demo.salesPerDay
    };
  }

  // карта «нм-код → демо-расходы»: не зависит от того, передан товар с полем demo или без него
  const overridesByNm = new Map(goods.map((g) => [g.nmID, overridesOf(g)]));
  const demoOverrides = (nmID) => overridesByNm.get(Number(nmID)) || {};

  return {
    mode: 'demo',
    goods,
    overridesFor: demoOverrides,
    demoOverrides,

    /**
     * В демо-режиме реальных запросов к WB нет, поэтому «доступ есть» здесь показывать нельзя —
     * пользователь принимал зелёные галочки за настоящую проверку ключей.
     * Честный ответ: проверка не выполнялась.
     */
    async ping() {
      const cats = [
        { category: 'prices', title: 'Цены и скидки' },
        { category: 'calendar', title: 'Календарь акций' },
        { category: 'statistics', title: 'Статистика' },
        { category: 'content', title: 'Контент' },
        { category: 'finance', title: 'Финансы' }
      ];
      return cats.map((c) => ({
        category: c.category, title: c.title, ok: null, checked: false, status: 0,
        ms: 0, host: 'демо-режим', keyUsed: '', code: 'DEMO', demo: true,
        error: 'Проверка не выполнялась',
        hint: 'Демо-режим: запросов к WB не было. Вставьте ключ и снимите галку «Демо-режим», чтобы проверить настоящие права.',
        detail: ''
      }));
    },

    async getGoods() {
      const overrides = {};
      for (const g of goods) overrides[String(g.nmID)] = demoOverrides(g.nmID);
      return {
        items: goods.slice(),
        total: goods.length,
        source: 'demo',
        overrides
      };
    },

    async getSizes(nmID) {
      const g = byNm.get(Number(nmID));
      return g ? [g] : [];
    },

    async applyPrices(items) {
      const details = [];
      const taskId = ++taskSeq;
      const now = new Date().toISOString();
      for (const it of items) {
        const g = byNm.get(Number(it.nmID));
        if (!g) { details.push({ taskId, nmID: it.nmID, status: 6, statusText: 'Ошибка', errorText: 'Товар не найден' }); continue; }
        const oldSeller = g.price * (1 - g.discount / 100);
        const newPrice = it.price === undefined ? g.price : Math.round(Number(it.price));
        const newDiscount = it.discount === undefined ? g.discount : Math.round(Number(it.discount));
        const newSeller = newPrice * (1 - newDiscount / 100);
        const quarantine = oldSeller > 0 && newSeller < oldSeller / 3;
        if (quarantine) {
          details.push({ taskId, nmID: g.nmID, vendorCode: g.vendorCode, price: it.price, discount: it.discount, status: 6, statusText: 'Карантин цены', errorText: 'Новая цена со скидкой более чем в 3 раза ниже прежней — товар в карантине, цена не изменена.' });
          continue;
        }
        g.price = newPrice;
        g.discount = newDiscount;
        g.discountedPrice = Math.round(g.price * (1 - g.discount / 100));
        g.sizes.forEach((s) => {
          // Общая базовая цена выравнивает размеры, запрос только со скидкой — нет.
          s.price = it.price === undefined ? Math.round(s.price) : g.price;
          s.discountedPrice = Math.round(s.price * (1 - g.discount / 100));
        });
        // WB сам выводит товар из акции, когда цена перестаёт удовлетворять условиям
        // (цена со скидкой выше плановой цены акции). Отдельного API для выхода нет.
        const leftPromos = [];
        for (const pr of promos) {
          if (!pr._inAction.includes(g.nmID)) continue;
          const plan = Math.round(g.price * (1 - pr.requiredDiscountPct / 100));
          if (g.discountedPrice > plan) {
            pr._inAction = pr._inAction.filter((id) => id !== g.nmID);
            pr.inActionCount = pr._inAction.length;
            pr.notInActionCount = pr._eligible.length - pr._inAction.length;
            leftPromos.push(pr.name);
          }
        }
        if (leftPromos.length) {
          const mine = promos.filter((pr) => pr._inAction.includes(g.nmID));
          g.inPromo = mine.length > 0;
          g.promoIds = mine.map((pr) => pr.id);
          g.promoNames = mine.map((pr) => pr.name);
          const plans = mine.map((pr) => Math.round(g.price * (1 - num(pr.requiredDiscountPct) / 100))).filter((x) => x > 0);
          g.promoPlanPrice = plans.length ? Math.min.apply(null, plans) : 0;
          g.plannedPrice = g.promoPlanPrice;
          g.plannedDiscount = g.promoPlanPrice ? Math.round((1 - g.promoPlanPrice / g.price) * 100) : 0;
        }
        details.push({
          taskId, nmID: g.nmID, vendorCode: g.vendorCode, price: g.price, discount: g.discount,
          status: 3, statusText: 'Обработано без ошибок', errorText: '',
          leftPromotions: leftPromos
        });
      }
      const ok = details.filter((d) => d.status === 3).length;
      const task = {
        taskId,
        createdAt: now,
        source: 'demo',
        total: items.length,
        ok,
        failed: items.length - ok,
        status: ok === items.length ? 3 : (ok ? 5 : 6),
        statusText: ok === items.length ? 'Обработано без ошибок' : (ok ? 'Обработано с ошибками в части товаров' : 'Все товары с ошибками'),
        details
      };
      tasks.unshift(task);
      return { uploaded: items.length, demo: true, task, details, batches: [] };
    },

    /** Цены по размерам — POST /api/v2/upload/task/size (демо-заглушка). */
    async applySizePrices(items) {
      const details = [];
      const taskId = ++taskSeq;
      const now = new Date().toISOString();
      for (const it of items) {
        const g = byNm.get(Number(it.nmID));
        if (!g) { details.push({ taskId, nmID: it.nmID, sizeID: it.sizeID, status: 6, statusText: 'Ошибка', errorText: 'Товар не найден' }); continue; }
        const size = (g.sizes || []).find((s) => Number(s.sizeID) === Number(it.sizeID));
        if (!size) { details.push({ taskId, nmID: g.nmID, sizeID: it.sizeID, status: 6, statusText: 'Ошибка', errorText: 'Размер не найден у товара' }); continue; }
        const oldSeller = Number(size.price) * (1 - (Number(g.discount) || 0) / 100);
        const newSeller = Number(it.price) * (1 - (Number(g.discount) || 0) / 100);
        const quarantine = oldSeller > 0 && newSeller < oldSeller / 3;
        if (quarantine) {
          details.push({ taskId, nmID: g.nmID, sizeID: it.sizeID, price: it.price, discount: it.discount, status: 6, statusText: 'Карантин цены', errorText: 'Новая цена со скидкой более чем в 3 раза ниже прежней — размер в карантине, цена не изменена.' });
          continue;
        }
        size.price = Math.round(Number(it.price));
        size.discount = Number(g.discount) || 0;
        size.discountedPrice = Math.round(size.price * (1 - size.discount / 100));
        // товар с поразмерными ценами: базовую цену пересчитываем из размеров
        if (g.editableSizePrice) {
          const live = (g.sizes || []).map((s) => Number(s.price) || 0).filter((p) => p > 0);
          if (live.length) {
            g.price = Math.min.apply(null, live);
            g.discountedPrice = Math.round(g.price * (1 - g.discount / 100));
          }
        }
        details.push({ taskId, nmID: g.nmID, sizeID: it.sizeID, price: size.price, discount: size.discount, status: 3, statusText: 'Обработано без ошибок', errorText: '' });
      }
      const ok = details.filter((d) => d.status === 3).length;
      const task = {
        taskId,
        createdAt: now,
        source: 'demo',
        total: items.length,
        ok,
        failed: items.length - ok,
        status: ok === items.length ? 3 : (ok ? 5 : 6),
        statusText: ok === items.length ? 'Обработано без ошибок' : (ok ? 'Обработано с ошибками в части товаров' : 'Все товары с ошибками'),
        details
      };
      tasks.unshift(task);
      return { uploaded: items.length, demo: true, task, details, batches: [] };
    },

    async uploadStates() {
      return tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        statusText: t.statusText,
        createdAt: t.createdAt,
        goodsCount: t.total,
        ok: t.ok,
        failed: t.failed,
        demo: true
      }));
    },

    async taskDetails(taskId) {
      const t = tasks.find((x) => x.taskId === Number(taskId));
      return t ? t.details : [];
    },

    async getPromotions() {
      return promos.map(({ _eligible, _inAction, ...p }) => p);
    },

    async getPromotionDetails(ids) {
      const wanted = (Array.isArray(ids) ? ids : [ids]).map(Number);
      return promos
        .filter((p) => !wanted.length || wanted.includes(p.id))
        .map(({ _eligible, _inAction, ...p }) => p);
    },

    async getPromotionNomenclatures(promotionID, opts) {
      const p = promos.find((x) => x.id === Number(promotionID));
      if (!p) return [];
      const inAction = !!(opts && opts.inAction);
      const ids = inAction ? p._inAction : p._eligible.filter((id) => !p._inAction.includes(id));
      return ids.map((id) => {
        const g = byNm.get(id);
        if (!g) return null;
        const planned = Math.max(p.requiredDiscountPct, g.discount);
        return {
          promotionID: p.id,
          nmID: g.nmID,
          vendorCode: g.vendorCode,
          brand: g.brand,
          categoryName: g.categoryName,
          title: g.title,
          price: g.price,
          discount: g.discount,
          plannedPrice: Math.round(g.price * (1 - planned / 100)),
          plannedDiscount: planned,
          requiredDiscountPct: p.requiredDiscountPct,
          inAction,
          stock: g.demo.stock,
          volumeLiters: g.volumeLiters
        };
      }).filter(Boolean);
    },

    async joinPromotion(promotionID, nomenclatures) {
      const p = promos.find((x) => x.id === Number(promotionID));
      if (!p) throw new Error('Акция не найдена (демо)');
      const results = [];
      for (const n of nomenclatures) {
        const g = byNm.get(Number(n.nmID));
        if (!g) { results.push({ nmID: n.nmID, ok: false, errorText: 'Товар не найден' }); continue; }
        const disc = Math.max(Number(n.discount) || 0, p.requiredDiscountPct);
        g.discount = Math.round(disc);
        g.discountedPrice = Math.round(g.price * (1 - g.discount / 100));
        g.inPromo = true;
        if (!p._inAction.includes(g.nmID)) p._inAction.push(g.nmID);
        const mine = promos.filter((pr) => pr._inAction.includes(g.nmID));
        g.promoIds = mine.map((pr) => pr.id);
        g.promoNames = mine.map((pr) => pr.name);
        const plans = mine.map((pr) => Math.round(g.price * (1 - num(pr.requiredDiscountPct) / 100))).filter((x) => x > 0);
        g.promoPlanPrice = plans.length ? Math.min.apply(null, plans) : 0;
        g.plannedPrice = g.promoPlanPrice;
        g.plannedDiscount = g.promoPlanPrice ? Math.round((1 - g.promoPlanPrice / g.price) * 100) : 0;
        results.push({ nmID: g.nmID, ok: true, discount: g.discount });
      }
      p.inActionCount = p._inAction.length;
      p.notInActionCount = p._eligible.length - p._inAction.length;
      return { promotionID: p.id, sent: nomenclatures.length, demo: true, results };
    },

    async getSalesAggregated() {
      const agg = {};
      for (const s of salesRows) {
        const a = agg[s.nmID] = agg[s.nmID] || { nmID: s.nmID, salesQty: 0, salesSum: 0, salesForPay: 0, ordersQty: 0, returnsQty: 0, sppSum: 0, sppCount: 0, days: {} };
        if (s.isReturn) { a.returnsQty++; continue; }
        a.salesQty++;
        a.salesSum += s.price;
        a.salesForPay += s.ppvz_for_pay;
        a.sppSum += s.spp;
        a.sppCount++;
        const day = s.date.slice(0, 10);
        a.days[day] = (a.days[day] || 0) + 1;
      }
      return Object.values(agg).map((a) => ({
        nmID: a.nmID,
        salesQty: a.salesQty,
        salesSum: Math.round(a.salesSum * 100) / 100,
        salesForPay: Math.round(a.salesForPay * 100) / 100,
        avgPrice: a.salesQty ? Math.round((a.salesSum / a.salesQty) * 100) / 100 : 0,
        avgForPay: a.salesQty ? Math.round((a.salesForPay / a.salesQty) * 100) / 100 : 0,
        avgSppPct: a.sppCount ? Math.round((a.sppSum / a.sppCount) * 10) / 10 : 0,
        ordersQty: Math.round(a.salesQty * 1.18),
        returnsQty: a.returnsQty,
        days: a.days
      }));
    },

    async getCards() {
      return cards;
    },

    async getCompetitors() {
      return JSON.parse(JSON.stringify(competitors));
    },

    /** Имитация /api/v3/warehouses — склады продавца. */
    async getWarehouses() {
      return WAREHOUSES.map((w) => Object.assign({}, w));
    },

    /**
     * Имитация /api/analytics/v1/stocks-report/wb-warehouses.
     * Демо-остатки распределены по складам и регионам — структура строки
     * полностью совпадает с нормализованными строками боевого клиента.
     */
    async getStocksReport() {
      return {
        rows: stockRows.map((r) => Object.assign({}, r)),
        aggregated: require('./wb-client').WBClient.aggregateStocks(stockRows),
        pages: 1,
        total: stockRows.length,
        source: 'demo-wb-warehouses'
      };
    },

    demoStockRows: stockRows,

    /** Имитация finance-api: список отчётов о реализации. */
    async getSalesReportsList(opts) {
      const o = opts || {};
      const dates = Array.from(new Set(financeRows.map((r) => String(r.rrDate).slice(0, 10)))).sort();
      return dates
        .filter((d) => (!o.dateFrom || d >= String(o.dateFrom).slice(0, 10)) && (!o.dateTo || d <= String(o.dateTo).slice(0, 10)))
        .map((d) => ({
          reportId: 500000 + Number(d.slice(8, 10)),
          dateFrom: d, dateTo: d, createDate: d,
          period: 'daily', currency: 'RUB', reportType: 1
        }));
    },

    /**
     * Имитация finance-api: детализация отчёта о реализации.
     * Поддерживает пагинацию по rrdId — как настоящий метод WB.
     */
    async getSalesReportDetailed(opts) {
      const o = opts || {};
      const from = o.dateFrom ? String(o.dateFrom).slice(0, 10) : '';
      const to = o.dateTo ? String(o.dateTo).slice(0, 10) : '';
      const maxPages = Number(o.maxPages || 200);
      const pageSize = 5000;
      let rrdId = Number(o.rrdId || 0);
      const out = [];
      let pages = 0;
      // пагинация по rrdId — ровно как в настоящем finance-api
      while (pages < maxPages) {
        pages++;
        // курсор WB — это rrdId, поэтому строки должны идти строго по его возрастанию
        const page = financeRows.filter((r) => {
          const d = String(r.rrDate).slice(0, 10);
          return (!from || d >= from) && (!to || d <= to) && r.rrdId > rrdId;
        }).sort((a, b) => a.rrdId - b.rrdId).slice(0, pageSize);
        if (!page.length) break;
        out.push(...page.map((r) => normalizeReportRow(r)));
        rrdId = page[page.length - 1].rrdId;
        if (o.onProgress) o.onProgress({ pages, rows: out.length, rrdId });
        if (page.length < pageSize) break;
      }
      return { rows: out, report: null, source: 'demo-finance-api', pages };
    },

    demoFinanceRows: financeRows,

    /** Имитация изменения рыночных цен — чтобы посмотреть, как реагирует репрайсер. */
    async driftCompetitors() {
      const rnd = Math.random;
      let changed = 0;
      for (const list of Object.values(competitors)) {
        for (const c of list) {
          const k = 0.96 + rnd() * 0.09;
          const np = Math.max(50, Math.round(c.price * k));
          if (np !== c.price) { c.price = np; changed++; }
          if (rnd() > 0.9) c.stock = rnd() > 0.4 ? Math.floor(rnd() * 300) : 0;
          c.updatedAt = new Date().toISOString();
        }
      }
      return { changed };
    },

    demoSalesRows: salesRows
  };
}

module.exports = { createDemoApi, buildCatalog, buildPromotions, buildStats, buildCards, buildStocks, CATEGORIES, WAREHOUSES };
