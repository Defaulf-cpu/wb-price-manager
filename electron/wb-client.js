'use strict';

const { WB_HOSTS, RATE_LIMITS, MAX_ITEMS_PER_PRICE_TASK, MAX_SIZE_ITEMS_PER_PRICE_TASK } = require('./config');

/** Ошибка WB API с понятным текстом для интерфейса. */
class WBError extends Error {
  constructor(message, { status = 0, code = '', category = '', retryable = false } = {}) {
    super(message);
    this.name = 'WBError';
    this.status = status;
    this.code = code;
    this.category = category;
    this.retryable = retryable;
  }
}

const STATUS_HINTS = {
  401: 'Неверный или отозванный API-ключ. Проверьте токен в личном кабинете WB.',
  403: 'У токена нет доступа к этой категории. Пересоздайте ключ с нужными правами.',
  404: 'Метод не найден или товар не принадлежит вашему кабинету.',
  // WB отвечает 422 «Unprocessable entity» на /calendar/promotions/nomenclatures для автоакций:
  // документация прямо пишет «Not applicable for auto promotions». Это не сбой ключа и не
  // ошибка параметров — состав такой акции через API не отдаётся вообще.
  422: 'WB не обрабатывает этот запрос: состав акции через API недоступен (обычно так отвечают автоакции и закрытые акции). Скачайте файл состава в кабинете и загрузите его в разделе «Акции».',
  429: 'WB ограничил частоту запросов: раздел будет догружен автоматически, как только лимит сбросится.',
  500: 'Ошибка на стороне Wildberries. Повторите позже.'
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ограничитель частоты запросов по правилам WB (скользящее окно + минимальный интервал
 * + «охлаждение» после реального ответа 429).
 *
 * maxWaitMs — потолок ожидания. Если по лимитам WB ждать нужно дольше, запрос не
 * отправляется: ограничитель бросает ошибку RATE_WAIT с временем, когда можно
 * повторить (retryAt). Благодаря этому «Обновить данные из WB» не висит минуту
 * молча, а честно говорит: раздел дозагрузится в такое-то время.
 */
class RateLimiter {
  constructor(opts) {
    this.category = opts.category || '';
    this.perWindow = opts.perWindow || 10;
    this.windowMs = opts.windowMs || 6000;
    this.minIntervalMs = opts.minIntervalMs || 620;
    this.maxWaitMs = opts.maxWaitMs === undefined ? 10000 : opts.maxWaitMs;
    this.stamps = [];
    this.last = 0;
    this.queue = Promise.resolve();
    this.cooldownUntil = 0;      // WB сам сказал, когда можно повторить (429)
    this.lastRemaining = null;   // X-Ratelimit-Remaining из последнего ответа
  }

  /** Сколько миллисекунд нужно выждать перед следующим запросом. */
  waitNeeded(now) {
    const t = now || Date.now();
    this.stamps = this.stamps.filter((x) => t - x < this.windowMs);
    let wait = 0;
    if (this.stamps.length >= this.perWindow) wait = this.windowMs - (t - this.stamps[0]) + 20;
    const sinceLast = t - this.last;
    if (sinceLast < this.minIntervalMs) wait = Math.max(wait, this.minIntervalMs - sinceLast);
    if (this.cooldownUntil > t) wait = Math.max(wait, this.cooldownUntil - t + 50);
    return Math.max(0, wait);
  }

  /** Момент (epoch мс), когда категория снова будет свободна. */
  nextFreeAt() {
    return Date.now() + this.waitNeeded(Date.now());
  }

  /** WB ответил 429: запоминаем, когда можно повторить. */
  noteRateLimited(retryAfterSec, fallbackSec) {
    const sec = Number(retryAfterSec) > 0 ? Number(retryAfterSec) : Number(fallbackSec || 62);
    const until = Date.now() + Math.max(1000, sec * 1000);
    this.cooldownUntil = Math.max(this.cooldownUntil, until);
    return until;
  }

  acquire(maxWaitMs) {
    const limit = (maxWaitMs === undefined || maxWaitMs === null) ? this.maxWaitMs : Number(maxWaitMs);
    const run = async () => {
      const now = Date.now();
      const wait = this.waitNeeded(now);
      if (wait > 0) {
        if (wait > limit) {
          const err = new WBError(
            `WB отдаёт данные этой категории не чаще раза в ${Math.round(this.windowMs / 1000)} с. ` +
            `Повторить можно через ${Math.ceil(wait / 1000)} с — запрос не отправлен, раздел догрузится автоматически.`,
            { code: 'RATE_WAIT', category: this.category || '', retryable: true }
          );
          err.retryAt = now + wait;
          err.retryAfterSec = Math.ceil(wait / 1000);
          err.waitMs = wait;
          throw err;
        }
        await sleep(wait);
      }
      this.last = Date.now();
      this.stamps.push(this.last);
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}

/** Названия категорий токена — для понятных сообщений об ограничениях WB. */
const CATEGORY_TITLES = {
  prices: 'Цены и скидки',
  calendar: 'Календарь акций',
  statistics: 'Статистика',
  content: 'Контент',
  finance: 'Финансы',
  advert: 'Продвижение',
  common: 'Общие методы',
  analytics: 'Аналитика',
  marketplace: 'Маркетплейс'
};

function categoryTitle(c) {
  return CATEGORY_TITLES[c] || c || 'WB API';
}

function pick(obj, keys, def = undefined) {
  if (!obj) return def;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return def;
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function r2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

/**
 * Ссылка на фото карточки. WB отдаёт `photos: [{ big, small, video }]` —
 * собирать URL руками из nmID нельзя: корзина (basket-NN) и путь зависят от товара.
 */
function photoUrl(photos) {
  if (!Array.isArray(photos) || !photos.length) return undefined;
  const first = photos[0];
  if (typeof first === 'string') return first;
  return (first && (first.big || first.small || first.preview)) || undefined;
}


/**
 * Строка финансового отчёта WB → единый формат приложения.
 * WB дважды менял этот метод (snake_case → camelCase, числа → строки),
 * поэтому читаем оба варианта имён и приводим суммы к числу.
 */
function normalizeReportRow(r) {
  const n = (...names) => {
    for (const k of names) {
      const v = r[k];
      if (v !== undefined && v !== null && v !== '') {
        const num = Number(String(v).replace(/\s/g, '').replace(',', '.'));
        if (Number.isFinite(num)) return num;
      }
    }
    return 0;
  };
  const str = (...names) => {
    for (const k of names) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return String(r[k]);
    return '';
  };

  const docType = str('docTypeName', 'doc_type_name', 'supplierOperName', 'supplier_oper_name', 'sellerOperName');
  const low = docType.toLowerCase();
  const isReturn = /возвр|return/.test(low);
  const isLogistics = /логистик|logistic|доставк|delivery/.test(low);
  const isSale = !isReturn && !isLogistics && (/продаж|sale|реализ|pr$/.test(low) || low === '');

  return {
    nmId: n('nmId', 'nm_id', 'nmID', 'imid'),
    vendorCode: str('vendorCode', 'sa_name', 'supplierArticle', 'saName'),
    title: str('title', 'subjectName', 'subject_name'),
    barcode: str('sku', 'barcode', 'shkId', 'shk_id'),
    techSize: str('techSize', 'tech_size', 'ts_name', 'tsName'),
    officeName: str('officeName', 'office_name', 'warehouseName'),
    docType,
    isSale,
    isReturn,
    isLogistics,
    date: str('rrDate', 'rr_dt', 'rrDt', 'saleDt', 'date').slice(0, 10),
    quantity: n('quantity'),
    retailPrice: n('retailPrice', 'retail_price'),
    retailPriceWithDisc: n('retailPriceWithDisc', 'retail_price_withdisc_rub'),
    retailAmount: n('retailAmount', 'retail_amount'),
    salePercent: n('salePercent', 'sale_percent'),
    commissionPercent: n('commissionPercent', 'commission_percent', 'ppvz_kvw_prc', 'kgvp'),
    commission: n('commission', 'ppvzSalesCommission', 'ppvz_sales_commission', 'vw', 'kvw'),
    forPay: n('forPay', 'ppvzForPay', 'ppvz_for_pay'),
    logistics: n('deliveryService', 'deliveryRub', 'delivery_rub', 'logisticsCost', 'logistics_cost'),
    returnLogistics: n('returnService', 'returnCost', 'return_cost'),
    storage: n('storageFee', 'storage_fee', 'storageCost'),
    acceptance: n('paidAcceptance', 'acceptance', 'acceptance_cost', 'acceptanceCost'),
    acquiring: n('acquiringFee', 'acquiring_fee', 'acquiring'),
    deduction: n('deduction'),
    penalty: n('penalty'),
    spp: n('spp', 'ppvzSppPrc', 'ppvz_spp_prc'),
    rrdId: n('rrdId', 'rrd_id'),
    reportId: n('reportId', 'realizationreport_id', 'realizationReportId')
  };
}

/**
 * Клиент Wildberries API.
 * Разделы требуют разных токенов:
 *  - prices    : «Цены и скидки» (discounts-prices-api) — цены, скидки, загрузки цен
 *  - calendar  : «Цены и скидки» (dp-calendar-api)      — календарь акций
 *  - statistics: «Статистика»    (statistics-api)       — заказы и продажи для экономики
 *  - content   : «Контент»       (content-api)          — карточки, названия, габариты
 *  - finance   : «Финансы»       (finance-api)          — отчёты о реализации: фактическая
 *                логистика, комиссия, хранение, приёмка, эквайринг по каждой продаже
 */
class WBClient {
  constructor({ keys = {}, sandbox = false, onLog = null, timeoutMs = 30000 } = {}) {
    this.keys = keys || {};
    this.sandbox = !!sandbox;
    this.hosts = this.sandbox ? WB_HOSTS.sandbox : WB_HOSTS.prod;
    this.onLog = typeof onLog === 'function' ? onLog : () => {};
    this.timeoutMs = timeoutMs;
    this.limiters = {};
    for (const cat of Object.keys(RATE_LIMITS)) {
      this.limiters[cat] = new RateLimiter(Object.assign({ category: cat }, RATE_LIMITS[cat]));
    }
    this.stats = { requests: 0, errors: 0, lastError: null, remaining: {}, rateLimited: {} };
  }

  /**
   * Ключ для категории.
   *
   * WB выдаёт один JWT на выбранные категории, поэтому достаточно ОДНОГО ключа:
   * если в кабинете создан токен со всеми нужными разделами, его можно вставить
   * в поле «Один ключ на все разделы» — он будет использован для любого хоста.
   * Отдельные ключи по категориям имеют приоритет (на случай, если права разделены).
   */
  keyFor(category) {
    const universal = ['single', 'universal', 'all', 'master', 'main'];
    const map = {
      prices: ['prices'],
      calendar: ['prices', 'calendar'],
      statistics: ['statistics', 'stats'],
      content: ['content'],
      finance: ['finance', 'finances'],
      common: [],
      advert: ['advert', 'promotion'],
      analytics: ['analytics'],
      marketplace: ['marketplace', 'market', 'seller']
    };
    const order = (map[category] || []).concat(universal);
    for (const c of order) {
      if (this.keys[c] && String(this.keys[c]).trim()) return String(this.keys[c]).trim();
    }
    throw new WBError(
      `Не задан API-ключ${category ? ` для категории «${category}»` : ''}. ` +
      'Вставьте один общий ключ в разделе «Настройки» → «Подключение к Wildberries».',
      { category, code: 'NO_KEY' }
    );
  }

  /** Какие категории покрыты заданными ключами (для подсказок в интерфейсе). */
  keyCoverage() {
    const cats = ['prices', 'calendar', 'statistics', 'content', 'finance', 'advert', 'analytics', 'marketplace'];
    const out = {};
    cats.forEach((c) => {
      try { this.keyFor(c); out[c] = true; } catch (e) { out[c] = false; }
    });
    out.universal = !!(this.keys.single || this.keys.universal || this.keys.all || this.keys.master || this.keys.main);
    return out;
  }

  async request(category, method, urlPath, opts) {
    const { query, body, retries = 2, maxWaitMs } = opts || {};
    const limiter = this.limiters[category];
    await limiter.acquire(maxWaitMs);
    const key = this.keyFor(category);
    const host = this.hosts[category === 'calendar' ? 'calendar' : category];
    const url = new URL(host + urlPath);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
        else url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.stats.requests++;
    this.onLog({ category, method, url: url.toString(), at: Date.now() });

    let res;
    try {
      res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: Object.assign({ Authorization: key, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      clearTimeout(timer);
      this.stats.errors++;
      const err = e && e.name === 'AbortError'
        ? new WBError(`WB не ответил за ${this.timeoutMs / 1000} с.`, { category, code: 'TIMEOUT', retryable: true })
        : new WBError(`Нет связи с WB API (${host}): ${e && e.message ? e.message : e}`, { category, code: 'NETWORK', retryable: true });
      this.stats.lastError = err.message;
      if (retries > 0) { await sleep(1500); return this.request(category, method, urlPath, Object.assign({}, opts, { retries: retries - 1 })); }
      throw err;
    }
    clearTimeout(timer);

    // WB в каждом ответе (кроме 429) сообщает, сколько запросов осталось: X-Ratelimit-Remaining.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining !== '' && Number.isFinite(Number(remaining))) {
      this.stats.remaining[category] = Number(remaining);
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }

    if (res.status === 429) {
      this.stats.errors++;
      // WB сообщает срок повтора заголовком X-Ratelimit-Retry (в секундах), иногда Retry-After.
      // Если заголовков нет — берём лимит категории (для статистики и финансов это минута).
      const retrySec = Number(res.headers.get('x-ratelimit-retry') || res.headers.get('retry-after') || 0);
      const cfg = RATE_LIMITS[category] || {};
      const fallbackSec = Math.max(2, Math.round((cfg.windowMs || 60000) / 1000) + 2);
      const until = limiter.noteRateLimited(retrySec, fallbackSec);
      const waitSec = Math.max(1, Math.round((until - Date.now()) / 1000));
      this.stats.rateLimited[category] = { at: Date.now(), retryAt: until, retryAfterSec: waitSec };
      const err = new WBError(
        `WB ограничил частоту запросов (HTTP 429). Категория «${categoryTitle(category)}»: ` +
        `следующий запрос возможен через ${waitSec} с.`,
        { status: 429, category, code: 'RATE_LIMIT', retryable: true }
      );
      err.retryAt = until;
      err.retryAfterSec = waitSec;
      this.stats.lastError = err.message;
      // Ломиться повторно через 3 секунды бессмысленно: лимит «Статистика» и «Финансы»
      // сбрасывается раз в минуту, а каждый лишний запрос лишь продлевает блокировку.
      // Короткий повтор делаем только тогда, когда WB сам разрешил быстро.
      if (retries > 0 && waitSec <= 5) {
        await sleep(waitSec * 1000 + 250);
        return this.request(category, method, urlPath, Object.assign({}, opts, { retries: retries - 1, maxWaitMs: Math.max(Number(maxWaitMs) || 0, waitSec * 1000 + 2000) }));
      }
      throw err;
    }

    if (res.status >= 500) {
      this.stats.errors++;
      const err = new WBError(`${STATUS_HINTS[res.status] || 'Ошибка WB API'} (HTTP ${res.status})`, { status: res.status, category, code: 'SERVER', retryable: true });
      this.stats.lastError = err.message;
      if (retries > 0) { await sleep(1500); return this.request(category, method, urlPath, Object.assign({}, opts, { retries: retries - 1 })); }
      throw err;
    }

    if (!res.ok) {
      this.stats.errors++;
      const detail = json ? (json.errorText || json.message || json.error || '') : text.slice(0, 200);
      const err = new WBError(`${STATUS_HINTS[res.status] || 'Ошибка запроса'} (HTTP ${res.status})${detail ? ': ' + detail : ''}`, { status: res.status, category, code: String(res.status) });
      this.stats.lastError = err.message;
      throw err;
    }

    if (json && json.error === true) {
      throw new WBError(json.errorText || 'WB вернул ошибку без описания.', { status: res.status, category, code: 'API_ERROR' });
    }
    // asText: вернуть сырой текст (для /download отчётов заданием — там может быть CSV).
    if (opts && opts.asText) return text;
    return json;
  }

  // ───────────────────────── Проверка доступа ─────────────────────────

  /**
   * Реальная проверка прав по каждой категории ключа.
   *
   * Раньше здесь был запрос на `host + '/ping'` — такого эндпоинта у WB нет,
   * поэтому проверка возвращала 404 и «нет доступа» даже с полностью рабочим ключом.
   * Теперь каждая категория проверяется своим настоящим, самым дешёвым методом:
   * limit=1 / окно в один день, чтобы не тянуть данные и не упираться в лимиты.
   */
  static CHECKS = [
    {
      category: 'prices', title: 'Цены и скидки',
      hint: 'категория «Цены и скидки»',
      call(c) { return c.request('prices', 'GET', '/api/v2/list/goods/filter', { query: { limit: 1 }, retries: 0 }); },
      detail(json) {
        const d = (json && json.data) || {};
        const n = Array.isArray(d.goods) ? d.goods.length : (Array.isArray(json && json.goods) ? json.goods.length : 0);
        return 'метод цен отвечает (' + n + ' товар(ов) в выборке)';
      }
    },
    {
      category: 'calendar', title: 'Календарь акций',
      hint: 'категория «Цены и скидки» (календарь акций входит в неё)',
      call(c) {
        // обязательные параметры метода: startDateTime, endDateTime (RFC3339) и allPromo (boolean).
        // С dateFrom/dateTo WB отвечает 400 «не передан обязательный параметр».
        const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
        return c.request('calendar', 'GET', '/api/v1/calendar/promotions', {
          query: {
            startDateTime: fmt(new Date()),
            endDateTime: fmt(new Date(Date.now() + 60 * 86400000)),
            allPromo: true, limit: 1, offset: 0
          },
          retries: 0
        });
      },
      detail(json) {
        const list = (json && json.data && json.data.promotions) || [];
        return 'календарь акций отвечает' + (Array.isArray(list) ? ' (' + list.length + ' в выборке)' : '');
      }
    },
    {
      category: 'statistics', title: 'Статистика',
      hint: 'категория «Статистика»',
      call(c) {
        const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
        // Проба должна быть мгновенной: ждать минуту в окне «Проверить доступ» нельзя,
        // поэтому maxWaitMs=0 — если лимит занят, честно вернём «проверка не выполнена».
        return c.request('statistics', 'GET', '/api/v1/supplier/orders', { query: { dateFrom: from, flag: 1 }, retries: 0, maxWaitMs: 0 });
      },
      detail(json) {
        const n = Array.isArray(json) ? json.length : 0;
        return 'отчёт о заказах доступен (' + n + ' строк за 2 дня)';
      }
    },
    {
      category: 'content', title: 'Контент',
      hint: 'категория «Контент»',
      call(c) {
        // withPhoto — целое число (-1 = любые карточки), курсор обязателен внутри settings;
        // с boolean WB отвечает HTTP 400 «request body could not be decoded»
        return c.request('content', 'POST', '/content/v2/get/cards/list', {
          body: { settings: { cursor: { limit: 1 }, filter: { withPhoto: -1 } } },
          retries: 0
        });
      },
      detail(json) {
        const n = json && Array.isArray(json.cards) ? json.cards.length : 0;
        return 'карточки доступны' + (n ? ' (' + n + ' в выборке)' : '');
      }
    },
    {
      category: 'finance', title: 'Финансы',
      hint: 'категория «Финансы» — отчёты о реализации',
      call(c) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        return c.request('finance', 'POST', '/api/finance/v1/sales-reports/list', {
          body: { dateFrom: from, dateTo: to, period: 'daily', limit: 1, offset: 0 },
          retries: 0, maxWaitMs: 0
        });
      },
      detail() { return 'отчёты о реализации доступны'; }
    },
    {
      category: 'analytics', title: 'Аналитика',
      hint: 'категория «Аналитика» — остатки на складах WB',
      call(c) {
        // Самый дешёвый метод категории: отчёт остатков с одной строкой.
        // Если у ключа нет категории «Аналитика» — WB отвечает 403, и это
        // честно показывается как «нет доступа к разделу «Аналитика», а не как
        // «нет доступа ко всему».
        return c.request('analytics', 'POST', '/api/analytics/v1/stocks-report/wb-warehouses', {
          body: { limit: 1, offset: 0 },
          retries: 0, maxWaitMs: 0
        });
      },
      detail(json) {
        const rows = pick(json, ['rows', 'stocks', 'data'], []) || [];
        return 'отчёт остатков WB отвечает' + (Array.isArray(rows) ? ' (' + rows.length + ' строк в выборке)' : '');
      }
    },
    {
      category: 'marketplace', title: 'Маркетплейс',
      hint: 'категория «Маркетплейс» — склады продавца и остатки FBS',
      call(c) {
        return c.request('marketplace', 'GET', '/api/v3/warehouses', {
          query: { limit: 1 },
          retries: 0, maxWaitMs: 0
        });
      },
      detail(json) {
        const list = pick(json, ['warehouses', 'data'], []) || [];
        return 'склады продавца доступны' + (Array.isArray(list) ? ' (' + list.length + ' в выборке)' : '');
      }
    }
  ];

  static maskKey(k) {
    const s = String(k || '');
    if (!s) return '';
    return s.length <= 12 ? s.slice(0, 2) + '••••' : s.slice(0, 6) + '••••••••••' + s.slice(-4);
  }

  /** Что именно не так — по коду ответа WB. */
  static accessHint(status, category, check) {
    const need = check && check.hint ? 'нужна ' + check.hint : 'нужны права на раздел';
    if (status === 401) return 'Ключ не принят WB: скопируйте токен целиком (он длинный, начинается с eyJ…) и проверьте, не отозван ли он. Также ' + need + '.';
    if (status === 403) return 'Ключ принят, но прав на раздел не хватает: ' + need + ' (кабинет WB → Настройки → Доступ к API).';
    if (status === 404) return 'Метод не найден: ' + need + '. Если категория включена — возможно, WB ещё не применил права (1–2 минуты).';
    if (status === 429) return 'Слишком много запросов к WB — повторите проверку через минуту.';
    if (status >= 500) return 'WB API недоступен (ошибка на стороне WB) — повторите позже.';
    return '';
  }

  /**
   * @returns {Promise<Array<{category,title,ok,status,ms,host,keyUsed,error,hint,detail}>>}
   */
  async checkAccess() {
    const out = [];
    for (const check of WBClient.CHECKS) {
      const host = this.hosts[check.category] || '';
      const t0 = Date.now();
      let keyUsed = '';
      try {
        keyUsed = WBClient.maskKey(this.keyFor(check.category));
      } catch (e) {
        out.push({
          category: check.category, title: check.title, ok: false, status: 0, ms: Date.now() - t0,
          host, keyUsed: '', code: 'NO_KEY', checked: false,
          error: 'Ключ для этого раздела не задан',
          hint: 'Вставьте один общий ключ в поле «Один ключ на все разделы» — или отдельный ключ: ' + check.hint + '.',
          detail: ''
        });
        continue;
      }
      try {
        const json = await check.call(this);
        out.push({
          category: check.category, title: check.title, ok: true, status: 200, ms: Date.now() - t0,
          host, keyUsed, code: '', checked: true, error: '', hint: '',
          detail: (check.detail ? check.detail(json) : '') || 'доступ есть'
        });
      } catch (e) {
        const status = Number(e && e.status) || 0;
        const code = (e && e.code) || '';
        // Лимит WB — это не «нет доступа»: запрос даже не ушёл (RATE_WAIT) или WB
        // попросил подождать (RATE_LIMIT). Честно показываем «проверка не выполнена»
        // и время, когда можно повторить, вместо ложной ошибки про ключ.
        if (code === 'RATE_WAIT' || code === 'RATE_LIMIT') {
          const retryAt = Number(e && e.retryAt) || this.nextFreeAt(check.category);
          out.push({
            category: check.category, title: check.title, ok: null, status: status || 0, ms: Date.now() - t0,
            host, keyUsed, code, checked: false, retryAt,
            error: (e && e.message) || 'Лимит частоты запросов WB',
            hint: 'Это не проблема с ключом: WB отдаёт данные категории «' + check.title +
              '» не чаще раза в минуту. Повторите проверку после ' +
              new Date(retryAt).toLocaleTimeString('ru-RU') + '.',
            detail: ''
          });
          continue;
        }
        out.push({
          category: check.category, title: check.title, ok: false, status, ms: Date.now() - t0,
          host, keyUsed, code, checked: true,
          error: (e && e.message) || String(e),
          hint: WBClient.accessHint(status, check.category, check) || ((e && e.code === 'NETWORK') ? 'Нет связи с WB — проверьте интернет/прокси.' : ''),
          detail: ''
        });
      }
    }
    return out;
  }

  /**
   * Когда категория снова будет свободна по лимитам WB (epoch мс).
   * Используется, чтобы не ждать минуту молча, а честно сказать:
   * «раздел дозагрузится в 12:34:56».
   */
  nextFreeAt(category) {
    const l = this.limiters[category];
    return l ? l.nextFreeAt() : Date.now();
  }

  /** Сколько ждать до следующего запроса категории, мс. */
  waitMs(category) {
    const l = this.limiters[category];
    return l ? l.waitNeeded(Date.now()) : 0;
  }

  /** Состояние лимитов по категориям — для диагностики в интерфейсе. */
  rateState() {
    const out = {};
    for (const cat of Object.keys(this.limiters)) {
      const l = this.limiters[cat];
      out[cat] = {
        waitMs: l.waitNeeded(Date.now()),
        nextFreeAt: l.nextFreeAt(),
        cooldownUntil: l.cooldownUntil || null,
        remaining: this.stats.remaining[cat] === undefined ? null : this.stats.remaining[cat],
        rateLimited: this.stats.rateLimited[cat] || null,
        limit: RATE_LIMITS[cat] ? { perWindow: RATE_LIMITS[cat].perWindow, windowMs: RATE_LIMITS[cat].windowMs } : null
      };
    }
    return out;
  }

  /** @deprecated используйте checkAccess(): /ping у WB не существует. Оставлено для совместимости. */
  async ping() { return this.checkAccess(); }

  // ───────────────────────── Цены и скидки ─────────────────────────

  static normalizeGood(g) {
    const sizes = Array.isArray(g.sizes) ? g.sizes : [];
    /**
     * Базовая цена товара. У товаров с поразмерными ценами (`editableSizePrice: true`,
     * а также у любого товара с включённой опцией «Разные цены для размеров») WB
     * НЕ отдаёт `price` на уровне товара — цена лежит только в `sizes[].price`.
     * Раньше это давало `price: 0`, и репрайсер честно, но неверно писал
     * «не задана базовая цена», хотя в кабинете цена есть.
     * Берём минимальную цену размера (расчёт по худшей цене — осторожнее по марже)
     * и помечаем источник, чтобы интерфейс сказал, откуда взялась цифра.
     */
    const sizePrices = sizes.map((s) => Number(s.price) || 0).filter((p) => p > 0);
    const rawPrice = Number(g.price || 0);
    const priceFromSizes = !(rawPrice > 0) && sizePrices.length > 0;
    const price = rawPrice > 0 ? rawPrice : (priceFromSizes ? Math.min.apply(null, sizePrices) : 0);
    const sizePriceMax = sizePrices.length ? Math.max.apply(null, sizePrices) : 0;
    const discount = Number(g.discount || 0);
    // `discountedPrice` WB может отдать нулём даже при живой цене — тогда считаем сами
    const rawDiscounted = Number(pick(g, ['discountedPrice'], 0) || 0);
    const discounted = rawDiscounted > 0 ? rawDiscounted : price * (1 - discount / 100);
    const volumeCm3 = Number(pick(g, ['volume', 'volumeCm3'], 0) || 0);
    const name = pick(g, ['subjectName', 'subject', 'categoryName'], '') || '';
    return {
      nmID: Number(g.nmID),
      vendorCode: g.vendorCode || '',
      brand: g.brand || '',
      categoryName: name,
      title: [g.brand, name, g.vendorCode].filter(Boolean).join(' · '),
      price,
      priceFromSizes,
      sizePriceMin: priceFromSizes ? price : undefined,
      sizePriceMax: priceFromSizes ? sizePriceMax : undefined,
      discount,
      discountedPrice: r2(discounted),
      clubDiscount: Number(g.clubDiscount || 0),
      currency: g.currencyIsoCode4217 || 'RUB',
      editableSizePrice: toBool(g.editableSizePrice),
      isBadTurnover: toBool(pick(g, ['isBadTurnover'], false)),
      inPromo: toBool(pick(g, ['inPromo', 'promo'], false)),
      plannedPrice: pick(g, ['plannedPrice'], undefined),
      plannedDiscount: pick(g, ['planDiscount', 'plannedDiscount'], undefined),
      volumeLiters: volumeCm3 ? r2(volumeCm3 / 1000) : undefined,
      sizesCount: sizes.length,
      sizes: sizes.map((s) => ({
        sizeID: Number(s.sizeID),
        techSizeName: String(pick(s, ['techSizeName'], '') || ''),
        price: Number(s.price || 0),
        discountedPrice: Number(s.discountedPrice || 0),
        clubDiscountedPrice: Number(s.clubDiscountedPrice || 0),
        isBadTurnover: toBool(s.isBadTurnover)
      })),
      photo: Array.isArray(g.photos) && g.photos.length ? g.photos[0] : undefined,
      raw: g
    };
  }

  /**
   * GET /api/v2/list/goods/filter — товары с ценами (постранично, до maxItems).
   */
  async getGoods(opts) {
    const { limit = 1000, maxItems = 5000, filterNmID } = opts || {};
    const out = [];
    let offset = 0;
    let total = Infinity;
    while (out.length < Math.min(total, maxItems)) {
      const json = await this.request('prices', 'GET', '/api/v2/list/goods/filter', {
        query: { limit: Math.min(limit, 1000), offset, filterNmID }
      });
      const data = (json && json.data) || {};
      const list = Array.isArray(data.goods) ? data.goods : (Array.isArray(data.listGoods) ? data.listGoods : []);
      total = Number(data.total || list.length || 0);
      list.forEach((g) => out.push(WBClient.normalizeGood(g)));
      if (!list.length || out.length >= total) break;
      offset += list.length;
      if (offset > 100000) break; // защита от бесконечного цикла
    }
    return { items: out, total: out.length, source: 'wb' };
  }

  /** GET /api/v2/list/goods/size/nm — цены по размерам одного товара. */
  async getSizes(nmID) {
    const json = await this.request('prices', 'GET', '/api/v2/list/goods/size/nm', { query: { nmID } });
    const data = (json && json.data) || {};
    const list = Array.isArray(data.goods) ? data.goods : (Array.isArray(data.listGoods) ? data.listGoods : []);
    return list.map((g) => WBClient.normalizeGood(g));
  }

  /**
   * POST /api/v2/upload/task — установить цены и скидки.
   * Автоматически режет на пачки по 1000 товаров и собирает ошибки из состояний загрузки.
   */
  async applyPrices(items, opts) {
    const { waitDetails = true } = opts || {};
    if (!Array.isArray(items) || !items.length) throw new WBError('Нет товаров для обновления цен.', { category: 'prices', code: 'EMPTY' });

    const batches = [];
    for (let i = 0; i < items.length; i += MAX_ITEMS_PER_PRICE_TASK) {
      const chunk = items.slice(i, i + MAX_ITEMS_PER_PRICE_TASK).map((it) => ({
        nmID: Number(it.nmID),
        price: Math.round(Number(it.price)),
        discount: Math.round(Number(it.discount))
      }));
      const response = await this.request('prices', 'POST', '/api/v2/upload/task', { body: { data: chunk } });
      batches.push({ batch: i / MAX_ITEMS_PER_PRICE_TASK + 1, count: chunk.length, response, items: chunk });
    }

    if (!waitDetails) return { uploaded: items.length, batches, details: [] };

    const details = await this._collectUploadDetails(batches);
    return { uploaded: items.length, batches, details };
  }

  /**
   * POST /api/v2/upload/task/size — установить цены по размерам
   * (только для товаров с `editableSizePrice: true`).
   * Автоматически режет на пачки по 1000 размеров и собирает ошибки из состояний загрузки.
   */
  async applySizePrices(items, opts) {
    const { waitDetails = true } = opts || {};
    if (!Array.isArray(items) || !items.length) throw new WBError('Нет размеров для обновления цен.', { category: 'prices', code: 'EMPTY' });

    const batches = [];
    for (let i = 0; i < items.length; i += MAX_SIZE_ITEMS_PER_PRICE_TASK) {
      const chunk = items.slice(i, i + MAX_SIZE_ITEMS_PER_PRICE_TASK).map((it) => ({
        nmID: Number(it.nmID),
        sizeID: Number(it.sizeID),
        price: Math.round(Number(it.price)),
        discount: Math.round(Number(it.discount))
      }));
      const response = await this.request('prices', 'POST', '/api/v2/upload/task/size', { body: { data: chunk } });
      batches.push({ batch: i / MAX_SIZE_ITEMS_PER_PRICE_TASK + 1, count: chunk.length, response, items: chunk });
    }

    if (!waitDetails) return { uploaded: items.length, batches, details: [] };

    const details = await this._collectUploadDetails(batches);
    return { uploaded: items.length, batches, details };
  }

  /**
   * Детали обработанной загрузки (ошибки по товарам/размерам, в т.ч. карантин цен).
   * Общая логика для цен товара (`upload/task`) и цен по размерам (`upload/task/size`):
   * опрос истории по taskId и разбор `goods[]` с состояниями.
   */
  async _collectUploadDetails(batches) {
    await sleep(1500);
    const details = [];
    for (const b of batches) {
      const taskId = pick(b.response && b.response.data, ['taskId', 'id']);
      if (taskId === undefined || taskId === null) continue;
      try {
        const json = await this.request('prices', 'GET', '/api/v2/history/goods/task', { query: { taskId } });
        const goods = pick(json && json.data, ['goods', 'listGoods'], []) || [];
        goods.forEach((g) => details.push({
          taskId,
          nmID: Number(g.nmID),
          vendorCode: g.vendorCode || '',
          price: Number(g.price || 0),
          discount: Number(g.discount || 0),
          status: Number(g.status || 0),
          statusText: WBClient.uploadStatusText(g.status),
          errorText: g.errorText || ''
        }));
      } catch (e) {
        details.push({ taskId, error: e.message });
      }
    }
    return details;
  }

  static uploadStatusText(status) {
    switch (Number(status)) {
      case 0: return 'Не обработано';
      case 1: return 'В обработке';
      case 3: return 'Обработано без ошибок';
      case 4: return 'Отменено';
      case 5: return 'Обработано с ошибками в части товаров';
      case 6: return 'Обработано, все товары с ошибками';
      default: return `Статус ${status}`;
    }
  }

  /** GET /api/v2/history/tasks — состояния обработанных загрузок цен. */
  async uploadStates() {
    const json = await this.request('prices', 'GET', '/api/v2/history/tasks');
    const list = pick(json && json.data, ['uploads', 'tasks', 'history'], []) || [];
    return list.map((t) => ({
      taskId: Number(pick(t, ['id', 'taskId'])),
      status: Number(pick(t, ['status'], 0)),
      statusText: WBClient.uploadStatusText(pick(t, ['status'], 0)),
      createdAt: pick(t, ['createdAt', 'date', 'uploadDate'], ''),
      changedAt: pick(t, ['changedAt', 'updateDate'], ''),
      goodsCount: Number(pick(t, ['goodsCount', 'count'], 0) || 0),
      raw: t
    }));
  }

  // ───────────────────────── Календарь акций ─────────────────────────

  /** GET /api/v1/calendar/promotions — список акций за период. */
  async getPromotions(opts) {
    const { startDateTime, endDateTime, allPromo = false, limit = 1000, offset = 0 } = opts || {};
    const json = await this.request('calendar', 'GET', '/api/v1/calendar/promotions', {
      query: { startDateTime, endDateTime, allPromo, limit, offset }
    });
    const list = pick(json && json.data, ['promotions'], []) || [];
    return list.map((p) => ({
      id: Number(p.id),
      name: p.name || '',
      startDateTime: p.startDateTime || '',
      endDateTime: p.endDateTime || '',
      type: p.type || '',
      joinType: pick(p, ['joinType', 'join_type'], '') || '',
      raw: p
    }));
  }

  /** GET /api/v1/calendar/promotions/details — детали акций (условия участия). */
  async getPromotionDetails(promotionIDs) {
    const ids = (Array.isArray(promotionIDs) ? promotionIDs : [promotionIDs]).map(Number).filter(Boolean);
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const json = await this.request('calendar', 'GET', '/api/v1/calendar/promotions/details', { query: { promotionIDs: ids.slice(i, i + 100) } });
      const list = pick(json && json.data, ['promotions'], []) || [];
      out.push(...list);
    }
    return out.map((p) => {
      const ranging = Array.isArray(p.ranging) ? p.ranging : [];
      const rate = ranging.length ? Number(pick(ranging[0], ['participationRate', 'rate'], 0) || 0) : Number(pick(p, ['participationRate', 'discount'], 0) || 0);
      return {
        id: Number(p.id),
        name: p.name || '',
        description: p.description || '',
        startDateTime: p.startDateTime || '',
        endDateTime: p.endDateTime || '',
        type: p.type || '',
        joinType: pick(p, ['joinType', 'join_type'], '') || '',
        participationPercentage: Number(pick(p, ['participationPercentage'], 0) || 0),
        requiredDiscountPct: rate,
        inActionTotal: Number(pick(p, ['inPromoActionTotal', 'productsInPromotion', 'totalProducts'], 0) || 0),
        inActionCount: Number(pick(p, ['inPromoActionCount'], 0) || 0),
        notInActionCount: Number(pick(p, ['notInPromoActionCount'], 0) || 0),
        notInActionLeftovers: Number(pick(p, ['notInPromoActionLeftovers'], 0) || 0),
        exceptionProductsCount: Number(pick(p, ['exceptionProductsCount'], 0) || 0),
        ranging,
        raw: p
      };
    });
  }

  /** GET /api/v1/calendar/promotions/nomenclatures — товары в акции / кандидаты. */
  async getPromotionNomenclatures(promotionID, opts) {
    const { inAction = false, limit = 1000, offset = 0, maxItems = 5000 } = opts || {};
    const out = [];
    let off = offset;
    while (out.length < maxItems) {
      const json = await this.request('calendar', 'GET', '/api/v1/calendar/promotions/nomenclatures', {
        query: { promotionID, inAction, limit: Math.min(limit, 1000), offset: off }
      });
      const data = (json && json.data) || {};
      const list = Array.isArray(data.nomenclatures) ? data.nomenclatures
        : (Array.isArray(data.products) ? data.products : (Array.isArray(data.goods) ? data.goods : []));
      const total = Number(data.total || 0);
      list.forEach((n) => out.push(WBClient.normalizeNomenclature(n, promotionID, inAction)));
      if (!list.length) break;
      off += list.length;
      if (total && off >= total) break;
      if (off > 100000) break;
    }
    return out;
  }

  static normalizeNomenclature(n, promotionID, inAction) {
    const price = Number(pick(n, ['price'], 0) || 0);
    const discount = Number(pick(n, ['discount'], 0) || 0);
    const planDiscount = Number(pick(n, ['planDiscount', 'plannedDiscount'], 0) || 0);
    const plannedPrice = Number(pick(n, ['plannedPrice', 'planPrice'], price * (1 - (planDiscount || discount) / 100)) || 0);
    return {
      promotionID: Number(promotionID),
      nmID: Number(n.nmID),
      vendorCode: n.vendorCode || '',
      brand: n.brand || '',
      sizeID: n.sizeID ? Number(n.sizeID) : undefined,
      techSizeName: String(pick(n, ['techSizeName', 'size'], '') || ''),
      price,
      discount,
      plannedPrice: r2(plannedPrice),
      plannedDiscount: planDiscount,
      requiredDiscountPct: Number(pick(n, ['planDiscount', 'requiredDiscount', 'discount'], 0) || 0),
      inAction: inAction === true ? true : toBool(pick(n, ['inAction', 'inPromo'], false)),
      stock: Number(pick(n, ['stock', 'leftovers', 'quantity'], 0) || 0),
      raw: n
    };
  }

  /**
   * POST /api/v1/calendar/promotions/upload — добавить товары в акцию.
   *
   * Контракт WB (тело ОБЁРНУТО в `data`, а `nomenclatures` — массив ЧИСЕЛ-nmID):
   *   { "data": { "promotionID": 1, "uploadNow": true, "nomenclatures": [75632091, 31322455] } }
   *   ответ: { "data": { "alreadyExists": false, "uploadID": 11 } }
   *
   * Цены и скидки этим методом НЕ задаются: их нужно отправить заранее через
   * POST /api/v2/upload/task (см. wb:apply-prices) — товар попадает в акцию, когда его
   * цена со скидкой удовлетворяет условиям. Поэтому applyPromoActions() делает два шага:
   * сначала цены, потом добавление nmID в акцию.
   *
   * Для автоакций (type: "auto") метод не применяется — WB их через API не управляет.
   *
   * @param {number} promotionID
   * @param {Array<number|{nmID:number}>} nomenclatures — числа или объекты с nmID (принимаем оба варианта)
   * @param {{uploadNow?:boolean}} opts — uploadNow: true = применить скидку сразу (по умолчанию),
   *        false = применить к старту акции
   */
  async joinPromotion(promotionID, nomenclatures, opts) {
    const list = Array.isArray(nomenclatures) ? nomenclatures : [];
    const nmIDs = list
      .map((n) => Number(typeof n === 'object' && n !== null ? n.nmID : n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!nmIDs.length) {
      throw new WBError('Список товаров для входа в акцию пуст.', { category: 'calendar', code: 'EMPTY' });
    }
    const uploadNow = !(opts && opts.uploadNow === false);
    const json = await this.request('calendar', 'POST', '/api/v1/calendar/promotions/upload', {
      body: { data: { promotionID: Number(promotionID), uploadNow, nomenclatures: nmIDs } }
    });
    const d = (json && json.data) || {};
    return {
      promotionID: Number(promotionID),
      sent: nmIDs.length,
      nmIDs,
      uploadID: Number(d.uploadID || 0) || undefined,
      alreadyExists: d.alreadyExists === true,
      response: json
    };
  }

  // ───────────────────────── Статистика ─────────────────────────

  /**
   * GET /api/v1/supplier/sales и /api/v1/supplier/orders — постранично.
   *
   * Смысл параметра flag (документация WB, раздел Reports):
   *  - flag=1 → WB отдаёт строки ТОЛЬКО за одну дату, равную dateFrom (время в дате игнорируется).
   *    Раньше приложение звало метод с flag=1 и датой «30 дней назад», то есть получало
   *    один день вместо месяца — отсюда «0 товаров с продажами» у живого кабинета.
   *  - flag=0 (или флаг не передан) → отдаются все строки, изменённые с dateFrom,
   *    до ~80 000 за один ответ. Следующая страница запрашивается с
   *    dateFrom = lastChangeDate последней строки предыдущего ответа; пустой массив []
   *    означает, что данные кончились.
   *
   * Лимит категории «Статистика» — 1 запрос в минуту, поэтому:
   *  - страниц тянем не больше maxPages (каждая страница = минута ожидания);
   *  - если ответ заметно меньше потолка 80 000 строк — дальше не идём, данных больше нет.
   *
   * @returns {Promise<{rows:Array,pages:number,truncated:boolean}>}
   */
  async getStatRows(path, dateFrom, opts = {}) {
    const { flag = 0, maxPages = 3, maxWaitMs, pageWaitMs = 300000, rowCap = 80000, onProgress = null } = opts;
    const rows = [];
    let cursor = dateFrom;
    let pages = 0;
    let truncated = false;
    let partialError = null;
    while (pages < maxPages) {
      pages++;
      // Первую страницу ждём недолго: если лимит WB занят, раздел уйдёт в фоновую
      // догрузку вместо того, чтобы заблокировать интерфейс на минуту.
      // Следующие страницы — терпеливо (pageWaitMs): данные уже наполовину загружены,
      // и начинать заново дороже, чем подождать сброса лимита.
      let json;
      try {
        json = await this.request('statistics', 'GET', path, {
          query: { dateFrom: cursor, flag },
          retries: 0,
          maxWaitMs: pages === 1 ? maxWaitMs : Math.max(Number(pageWaitMs) || 0, Number(maxWaitMs) || 0)
        });
      } catch (e) {
        // Если первая страница не получена — данных нет вовсе, это ошибка.
        // Если часть строк уже есть — отдаём их и честно помечаем, что загрузка оборвалась.
        if (!rows.length) throw e;
        truncated = true;
        partialError = e;
        break;
      }
      const arr = Array.isArray(json) ? json : [];
      if (!arr.length) break;
      for (const r of arr) rows.push(r);
      if (typeof onProgress === 'function') onProgress({ path, pages, rows: rows.length });
      // неполная страница = WB отдал всё, что есть; лишний запрос стоил бы минуты
      if (arr.length < Math.floor(rowCap * 0.9)) break;
      const last = arr[arr.length - 1];
      const next = String(last.lastChangeDate || last.date || '');
      if (!next || next === cursor) { truncated = true; break; }
      cursor = next;
      if (pages >= maxPages) truncated = true;
    }
    return { rows, pages, truncated, error: partialError };
  }

  /** Продажи и возвраты за период (flag=0, постранично по lastChangeDate). */
  async getSales(dateFrom, opts) {
    const o = (opts && typeof opts === 'object') ? opts : { flag: opts };
    const res = await this.getStatRows('/api/v1/supplier/sales', dateFrom, o);
    return res.rows;
  }

  /** Заказы за период (flag=0, постранично по lastChangeDate). */
  async getOrders(dateFrom, opts) {
    const o = (opts && typeof opts === 'object') ? opts : { flag: opts };
    const res = await this.getStatRows('/api/v1/supplier/orders', dateFrom, o);
    return res.rows;
  }

  /**
   * Агрегированная статистика по nmID за период (для экономики: оборачиваемость, средняя цена, СПП).
   *
   * @param {string} dateFrom  начало окна (RFC3339)
   * @param {{withOrders?:boolean, maxPages?:number, maxWaitMs?:number, onError?:function,
   *          onProgress?:function, windowFrom?:string}} opts
   *        withOrders=false — не тратить вторую минуту лимита на заказы (их можно
   *        догрузить позже отдельным запросом).
   * @returns {Promise<Array>}
   */
  async getSalesAggregated(dateFrom, opts) {
    const options = opts || {};
    const withOrders = options.withOrders !== false;
    const pageOpts = {
      flag: 0,
      maxPages: Number(options.maxPages) || 3,
      maxWaitMs: options.maxWaitMs,
      onProgress: options.onProgress
    };
    const winFrom = String(options.windowFrom || dateFrom || '').slice(0, 10);
    let sales = [];
    let orders = [];
    const meta = { salesPages: 0, ordersPages: 0, truncated: false };
    // Ошибку не глотаем молча: иначе при ключе без категории «Статистика»
    // полное обновление показывало бы «✓ 0 товаров» вместо честной ошибки.
    const report = (e, source) => { if (typeof options.onError === 'function') options.onError(e, source); };
    try {
      const res = await this.getStatRows('/api/v1/supplier/sales', dateFrom, pageOpts);
      sales = res.rows; meta.salesPages = res.pages; meta.truncated = meta.truncated || res.truncated;
      if (res.error) report(res.error, 'sales');   // часть строк получена, загрузка оборвалась
    } catch (e) { sales = []; report(e, 'sales'); }
    if (withOrders) {
      try {
        const res = await this.getStatRows('/api/v1/supplier/orders', dateFrom, pageOpts);
        orders = res.rows; meta.ordersPages = res.pages; meta.truncated = meta.truncated || res.truncated;
        if (res.error) report(res.error, 'orders');
      } catch (e) { orders = []; report(e, 'orders'); }
    }
    if (typeof options.onMeta === 'function') options.onMeta(meta);
    // flag=0 отдаёт строки, изменённые с dateFrom, — туда попадают и старые продажи
    // (например, поздний возврат). Для окна в N дней считаем только строки своего периода.
    const inWindow = (r) => {
      const d = String(r.date || '').slice(0, 10);
      return !winFrom || !d || d >= winFrom;
    };
    sales = sales.filter(inWindow);
    orders = orders.filter(inWindow);

    const agg = {};
    const ensure = (nm) => (agg[nm] = agg[nm] || {
      nmID: nm, salesQty: 0, salesSum: 0, salesForPay: 0, ordersQty: 0, ordersSum: 0,
      returnsQty: 0, sppSum: 0, sppCount: 0, warehouses: {}, days: {}
    });

    for (const s of sales) {
      const nm = Number(s.nmId || s.nmID || 0);
      if (!nm) continue;
      const a = ensure(nm);
      const isReturn = String(s.subjectName || '').length >= 0 && (s.isReturn || s.return || false);
      const price = Number(s.price || 0);
      const forPay = Number(s.ppvz_for_pay || s.ppvzForPay || 0);
      const spp = Number(s.spp || 0);
      const day = String(s.date || '').slice(0, 10);
      if (isReturn) { a.returnsQty++; continue; }
      a.salesQty++;
      a.salesSum += price;
      a.salesForPay += forPay;
      if (spp > 0) { a.sppSum += spp; a.sppCount++; }
      if (s.warehouseName) a.warehouses[s.warehouseName] = (a.warehouses[s.warehouseName] || 0) + 1;
      if (day) a.days[day] = (a.days[day] || 0) + 1;
    }

    for (const o of orders) {
      const nm = Number(o.nmId || o.nmID || 0);
      if (!nm) continue;
      const a = ensure(nm);
      a.ordersQty++;
      a.ordersSum += Number(o.price || 0);
    }

    return Object.values(agg).map((a) => ({
      nmID: a.nmID,
      salesQty: a.salesQty,
      salesSum: r2(a.salesSum),
      salesForPay: r2(a.salesForPay),
      avgPrice: a.salesQty ? r2(a.salesSum / a.salesQty) : 0,
      avgForPay: a.salesQty ? r2(a.salesForPay / a.salesQty) : 0,
      avgSppPct: a.sppCount ? r2(a.sppSum / a.sppCount) : 0,
      ordersQty: a.ordersQty,
      returnsQty: a.returnsQty,
      days: a.days,
      warehouses: a.warehouses
    }));
  }

  // ───────────────────────── Финансы: отчёты о реализации ─────────────────────────

  /**
   * POST /api/finance/v1/sales-reports/list — список отчётов реализации.
   * @param {{dateFrom:string,dateTo:string,period?:'daily'|'weekly',limit?:number,offset?:number}} opts
   */
  async getSalesReportsList(opts) {
    const { dateFrom, dateTo, period = 'daily', limit = 100, offset = 0, maxWaitMs } = opts || {};
    const json = await this.request('finance', 'POST', '/api/finance/v1/sales-reports/list', {
      body: { dateFrom, dateTo, period, limit, offset }, retries: 1, maxWaitMs
    });
    const list = Array.isArray(json) ? json : pick(json, ['reports', 'salesReports', 'data'], []);
    return (Array.isArray(list) ? list : []).map((r) => ({
      reportId: Number(r.reportId || r.report_id || 0),
      dateFrom: r.dateFrom || r.date_from || '',
      dateTo: r.dateTo || r.date_to || '',
      createDate: r.createDate || r.create_date || '',
      period: r.period || period,
      currency: r.currency || 'RUB',
      reportType: Number(r.reportType || r.report_type || 0),
      raw: r
    }));
  }

  /**
   * Детализация отчёта о реализации — фактические расходы по каждой продаже.
   *
   * Основной метод: POST https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed
   * (введён 15.04.2026, поля в camelCase, денежные суммы — строками, токен категории «Финансы»).
   * Пагинация: начинаем с rrdId = 0 и передаём rrdId последней полученной строки,
   * пока WB не вернёт пустой ответ / 204.
   *
   * Запасной метод: GET https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod
   * (отключён WB 15.07.2026, но в части кабинетов ещё отвечает — пробуем его при 404).
   *
   * @param {{dateFrom:string,dateTo:string,period?:'daily'|'weekly',fields?:string[],maxPages?:number,onProgress?:Function}} opts
   * @returns {Promise<{rows:Array,report:object|null,source:string,pages:number}>}
   */
  async getSalesReportDetailed(opts) {
    const {
      dateFrom, dateTo, period = 'daily', fields = null, maxPages = 200,
      onProgress = null, maxWaitMs, pageWaitMs = 300000
    } = opts || {};
    const body = { dateFrom, dateTo, period, limit: 100000 };
    if (Array.isArray(fields) && fields.length) body.fields = fields;

    const rows = [];
    let rrdId = 0;
    let pages = 0;
    let report = null;

    try {
      while (pages < maxPages) {
        pages++;
        // Лимит категории «Финансы» — 1 запрос в минуту, поэтому между страницами
        // придётся ждать. Первую страницу ждём недолго (иначе «Обновить данные»
        // зависнет), а дальше — терпеливо: pageWaitMs.
        const json = await this.request('finance', 'POST', '/api/finance/v1/sales-reports/detailed', {
          body: Object.assign({}, body, { rrdId }),
          retries: 1,
          maxWaitMs: pages === 1 ? maxWaitMs : Math.max(Number(pageWaitMs) || 0, Number(maxWaitMs) || 0)
        });
        const list = Array.isArray(json) ? json : pick(json, ['data', 'rows', 'report'], null);
        const arr = Array.isArray(list) ? list : [];
        if (json && !Array.isArray(json)) report = json;
        if (!arr.length) break;
        for (const r of arr) rows.push(normalizeReportRow(r));
        const lastId = Number(arr[arr.length - 1].rrdId || arr[arr.length - 1].rrd_id || 0);
        if (onProgress) onProgress({ pages, rows: rows.length, rrdId: lastId });
        if (!lastId || lastId === rrdId) break;
        rrdId = lastId;
      }
      return { rows, report, source: 'finance-api', pages };
    } catch (e) {
      const status = Number(e && e.status);
      if (status === 404 || status === 405 || (e && e.code === '404')) {
        this.onLog({ category: 'finance', note: 'finance-api вернул 404 — пробуем старый reportDetailByPeriod' });
        return this.getReportDetailLegacy({ dateFrom, dateTo, period, maxPages, onProgress });
      }
      if (status === 401 || status === 403) {
        throw new WBError('У токена нет доступа к финансовым отчётам. Нужен ключ категории «Финансы» ' +
          '(кабинет WB → Настройки → Доступ к API → категория «Финансы»).', { status, category: 'finance', code: String(status) });
      }
      throw e;
    }
  }

  /** Запасной путь: GET /api/v5/supplier/reportDetailByPeriod (statistics-api, snake_case). */
  async getReportDetailLegacy(opts) {
    const { dateFrom, dateTo, period = 'daily', maxPages = 200, onProgress = null } = opts || {};
    const rows = [];
    let rrdid = 0;
    let pages = 0;
    while (pages < maxPages) {
      pages++;
      const json = await this.request('statistics', 'GET', '/api/v5/supplier/reportDetailByPeriod', {
        query: { dateFrom, dateTo, period, rrdid, limit: 100000, timezone: 'Europe/Moscow' }
      });
      const arr = Array.isArray(json) ? json : (pick(json, ['data', 'rrd'], null) || []);
      if (!Array.isArray(arr) || !arr.length) break;
      for (const r of arr) rows.push(normalizeReportRow(r));
      const lastId = Number(arr[arr.length - 1].rrd_id || arr[arr.length - 1].rrdId || 0);
      if (onProgress) onProgress({ pages, rows: rows.length, rrdId: lastId });
      if (!lastId || lastId === rrdid) break;
      rrdid = lastId;
    }
    return { rows, report: null, source: 'reportDetailByPeriod', pages };
  }

  // ───────────────────────── Контент ─────────────────────────

  /** POST /content/v2/get/cards/list — карточки (названия, габариты, фото). */
  /**
   * POST /content/v2/get/cards/list — карточки товаров (габариты, объём, бренд, фото).
   *
   * Два подводных камня, из-за которых метод падал или отдавал только первую страницу:
   *
   * 1. `filter.withPhoto` — ЦЕЛОЕ число, а не boolean:
   *    -1 = любые карточки, 0 или отсутствие параметра = любые, 1 = только с фото, 2 = только без фото.
   *    При `withPhoto: false` WB отвечает HTTP 400:
   *    «request body could not be decoded: … Filter.WithPhoto: readUint32: unexpected character».
   * 2. Курсор живёт ВНУТРИ `settings` и его нужно возвращать в следующем запросе:
   *    из ответа берём `cursor.updatedAt` и `cursor.nmID`, повторяем, пока `cursor.total < limit`.
   *    Ответ имеет вид `{ cards: [...], cursor: { updatedAt, nmID, total } }` — без обёртки `data`,
   *    поэтому прежний разбор `json.data.cards` всегда ломался на второй странице.
   *
   * Нужен токен категории «Контент»: с 3 августа 2025 категория «Продвижение» для этого метода не работает.
   */
  async getCards(opts) {
    const { limit = 100, maxCards = 2000 } = opts || {};
    const pageLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const out = [];
    const cursor = { limit: pageLimit };
    let guard = 0;
    let minimalBody = false;
    while (guard++ < 200) {
      const body = minimalBody
        // запасной вариант, если WB снова поменяет схему: минимальное тело без sort/filter документировано как рабочее
        ? { settings: { cursor } }
        : { settings: { sort: { ascending: true }, cursor, filter: { withPhoto: -1 } } };
      let json;
      try {
        json = await this.request('content', 'POST', '/content/v2/get/cards/list', { body });
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (!minimalBody && e && e.status === 400 && /could not be decoded|readUint32|unexpected character/i.test(msg)) {
          minimalBody = true;
          continue;
        }
        throw e;
      }
      const cards = Array.isArray(json && json.cards) ? json.cards : [];
      const c = (json && json.cursor) || {};
      const total = Number(c.total || 0);
      cards.forEach((card) => out.push(WBClient.normalizeCard(card)));
      if (!cards.length || out.length >= maxCards) break;
      // total — сколько карточек вернула эта страница; меньше limit значит страница последняя
      if (total && total < pageLimit) break;
      if (c.nmID === undefined && !c.updatedAt) break;
      if (c.nmID !== undefined && c.nmID !== null) cursor.nmID = c.nmID;
      if (c.updatedAt) cursor.updatedAt = c.updatedAt;
    }
    return out;
  }

  static normalizeCard(c) {
    const dims = c.dimensions || {};
    const volumeCm3 = Number(dims.length || 0) * Number(dims.width || 0) * Number(dims.height || 0);
    const photos = Array.isArray(c.photos) ? c.photos : [];
    return {
      nmID: Number(c.nmID || 0),
      imtID: Number(c.imtID || 0),
      vendorCode: c.vendorCode || '',
      subjectName: pick(c, ['subjectName'], '') || '',
      brand: pick(c, ['brand'], '') || '',
      title: pick(c, ['title'], '') || '',
      volumeCm3: volumeCm3 || undefined,
      volumeLiters: volumeCm3 ? r2(volumeCm3 / 1000) : undefined,
      dimensions: dims,
      photo: photoUrl(photos),
      photos,
      /**
       * Баркоды товара: контент-API WB отдаёт их массивом `skus` (первый — основной).
       * В демо-данных баркодов нет, поэтому поле может быть пустым — интерфейс
       * показывает прочерк и не выдумывает значение.
       */
      skus: (Array.isArray(c.skus) ? c.skus : []).map((x) => String(x)).filter(Boolean),
      barcode: String((Array.isArray(c.skus) && c.skus[0]) || c.barcode || '')
    };
  }

  // ───────────────────────── Остатки по складам ─────────────────────────

  /**
   * Строка отчёта остатков → единый формат.
   *
   * WB уже несколько раз менял схемы отчётов (snake_case → camelCase, числовые
   * значения → строки), поэтому каждое поле читается по нескольким кандидатам,
   * а числа приводятся через Number() с проверкой.
   */
  static normalizeStockRow(r) {
    const n = (...names) => {
      for (const k of names) {
        const v = r[k];
        if (v !== undefined && v !== null && v !== '') {
          const num = Number(String(v).replace(/\s/g, '').replace(',', '.'));
          if (Number.isFinite(num)) return num;
        }
      }
      return null;
    };
    const str = (...names) => {
      for (const k of names) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return String(r[k]);
      return '';
    };
    return {
      nmID: n('nmID', 'nmId', 'nm_id', 'imid'),
      sizeID: n('sizeID', 'sizeId', 'size_id'),
      stock: n('stock', 'qty', 'quantity', 'leftovers', 'leftover'),
      warehouseId: n('warehouseId', 'warehouse_id', 'whId', 'wh_id'),
      warehouseName: str('warehouseName', 'warehouse_name', 'whName', 'wh_name', 'officeName', 'office_name'),
      region: str('region', 'regionName', 'region_name', 'regionTitle')
    };
  }

  /**
   * Агрегация строк отчёта по nmID: сумма по складам + разбивка по складам
   * и регионам. Один размер на одном складе — одна строка, поэтому суммируем
   * все строки nmID (всех размеров и всех складов).
   */
  static aggregateStocks(rows) {
    const out = {};
    for (const r of rows || []) {
      const nm = Number(r && (r.nmID !== undefined ? r.nmID : (r.nmId || r.nm_id || 0)));
      if (!(nm > 0)) continue;
      const qty = Number(r.stock);
      if (!(qty > 0)) continue;
      const a = out[nm] || (out[nm] = { nmID: nm, total: 0, byWarehouse: {}, byRegion: {}, sizeRows: 0 });
      a.total += qty;
      a.sizeRows++;
      const wh = String(r.warehouseName || ('склад ' + (r.warehouseId || '?')));
      a.byWarehouse[wh] = (a.byWarehouse[wh] || 0) + qty;
      const region = String(r.region || 'неизвестный');
      a.byRegion[region] = (a.byRegion[region] || 0) + qty;
    }
    return out;
  }

  /** Разобрать ответ отчёта остатков: массив строк может быть в data/rows/stocks. */
  static extractStockRows(json) {
    if (Array.isArray(json)) return json;
    if (!json) return [];
    if (Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.rows)) return json.data.rows;
    if (json.data && Array.isArray(json.data.stocks)) return json.data.stocks;
    return pick(json, ['rows', 'stocks', 'items'], []) || [];
  }

  /**
   * POST /api/analytics/v1/stocks-report/wb-warehouses — остатки на складах WB.
   *
   * Основной метод. Категория токена «Аналитика», лимит — 1 запрос в 20 секунд,
   * в ответе до 250 000 строк, поэтому пагинация по offset: страница за страницей,
   * между запросами лимитер категории заставляет выжидать.
   *
   * Первая страница жётся недолго (maxWaitMs): если лимит занят — бросает
   * RATE_WAIT/RATE_LIMIT, и раздел уходит в фоновую догрузку, а не блокирует
   * интерфейс. Последующие страницы — терпеливо (pageWaitMs): отчёт уже загружен
   * частично, и начинать заново дороже, чем подождать сброса лимита.
   */
  async getStocksReport(opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(Number(o.limit) || 1000, 10000));
    const maxPages = Math.max(1, Math.min(Number(o.maxPages) || 250, 250));
    const rows = [];
    let offset = 0;
    let pages = 0;
    let total = 0;
    while (pages < maxPages) {
      pages++;
      const json = await this.request('analytics', 'POST', '/api/analytics/v1/stocks-report/wb-warehouses', {
        body: { limit, offset },
        retries: 0,
        maxWaitMs: pages === 1 ? o.maxWaitMs : Math.max(Number(o.pageWaitMs) || 0, Number(o.maxWaitMs) || 0)
      });
      const list = WBClient.extractStockRows(json);
      const declared = Number(pick(json, ['total', 'totalRows', 'total_rows'], 0) || 0);
      if (declared > 0) total = declared;
      list.forEach((r) => rows.push(WBClient.normalizeStockRow(r)));
      if (!list.length) break;
      offset += list.length;
      if (total > 0 && offset >= total) break;
    }
    return { rows, aggregated: WBClient.aggregateStocks(rows), pages, total: total || rows.length, source: 'wb-warehouses' };
  }

  /**
   * Запасной путь: отчёт об остатках на складах WB заданием.
   *
   * GET /api/v1/warehouse_remains — создать задачу (не чаще 1 раза в минуту:
   * держим метку последнего создания, чтобы не ломать лимит WB),
   * GET .../tasks/{task_id}/status — опрашивать статус с шагом в несколько секунд
   * с ограничением числа попыток, GET .../download — скачать результат.
   *
   * Используется, когда основной метод (stocks-report/wb-warehouses) недоступен
   * для ключа (403/404/405/422).
   */
  async getStocksByTask(opts) {
    const o = opts || {};
    const maxAttempts = Math.max(1, Math.min(Number(o.maxAttempts) || 20, 60));
    const pollMs = Math.max(1000, Number(o.pollMs) || 3000);
    if (this._lastRemainsTaskAt && Date.now() - this._lastRemainsTaskAt < 60000) {
      throw new WBError('Отчёт об остатках задачей создан недавно — WB разрешает создавать не чаще раза в минуту. Повторите позже.', { category: 'marketplace', code: 'TASK_RATE' });
    }
    this._lastRemainsTaskAt = Date.now();
    const created = await this.request('marketplace', 'GET', '/api/v1/warehouse_remains', {
      query: o.query, retries: 0
    });
    const taskId = Number(pick(created, ['task_id', 'taskId', 'id'], 0) ||
      pick(created && created.data, ['task_id', 'taskId', 'id'], 0) || 0);
    if (!(taskId > 0)) {
      throw new WBError('WB не вернул ID задачи отчёта об остатках.', { category: 'marketplace', code: 'NO_TASK' });
    }
    let finished = false;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(pollMs);
      const st = await this.request('marketplace', 'GET', '/api/v1/warehouse_remains/tasks/' + taskId + '/status', {
        retries: 0, maxWaitMs: pollMs + 5000
      });
      const status = String(pick(st, ['status', 'state'], '') || '').toLowerCase();
      if (/done|finish|success|complete|ready|export/.test(status)) { finished = true; break; }
      if (/error|fail|cancel/.test(status)) {
        throw new WBError('Задача отчёта об остатках завершилась с ошибкой у WB.', { category: 'marketplace', code: 'TASK_ERROR' });
      }
    }
    if (!finished) {
      throw new WBError('Задача отчёта об остатках не завершилась за ' + (maxAttempts * pollMs / 1000) + ' с — попробуйте позже.', { category: 'marketplace', code: 'TASK_TIMEOUT', retryable: true });
    }
    const raw = await this.request('marketplace', 'GET', '/api/v1/warehouse_remains/tasks/' + taskId + '/download', {
      retries: 0, asText: true
    });
    const rows = WBClient.parseRemainsPayload(raw).map((r) => WBClient.normalizeStockRow(r));
    return { rows, aggregated: WBClient.aggregateStocks(rows), pages: 1, total: rows.length, source: 'warehouse-remains', taskId };
  }

  /**
   * Разбор payload от /download: JSON (в том числе обёрнутый в data) или CSV
   * с заголовками (первые столбцы — nmID, размер, остаток, склад, регион).
   */
  static parseRemainsPayload(payload) {
    if (payload === null || payload === undefined) return [];
    if (typeof payload === 'string') {
      const t = payload.trim();
      if (!t) return [];
      try { return WBClient.extractStockRows(JSON.parse(t)); } catch (e) { /* не JSON — CSV */ }
      const lines = t.split(/\r?\n/).filter((l) => l.trim().length);
      if (lines.length < 2) return [];
      const head = lines[0].split(',').map((x) => x.trim().toLowerCase());
      const idx = (...names) => {
        for (let i = 0; i < head.length; i++) {
          if (names.some((n) => head[i] === n || head[i].includes(n))) return i;
        }
        return -1;
      };
      const cols = { nmID: idx('nmid', 'nm_id', 'имт', 'артикул'), stock: idx('stock', 'остаток', 'qty', 'quantity'), wh: idx('warehouse', 'склад', 'wh'), region: idx('region', 'регион') };
      const out = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(',');
        const nm = Number(String(cells[cols.nmID] || '').replace(/\s/g, ''));
        if (!(nm > 0)) continue;
        out.push({
          nmID: nm,
          stock: Number(String(cells[cols.stock] || '0').replace(/\s/g, '').replace(',', '.')) || 0,
          warehouseName: String(cells[cols.wh] || '').trim(),
          region: String(cells[cols.region] || '').trim()
        });
      }
      return out;
    }
    return WBClient.extractStockRows(payload);
  }

  /** GET /api/v3/warehouses — список складов продавца (FBS). Категория «Маркетплейс». */
  async getWarehouses() {
    const json = await this.request('marketplace', 'GET', '/api/v3/warehouses');
    const list = WBClient.extractWarehouses(json);
    return list.map((w) => ({
      id: Number(pick(w, ['id', 'warehouseId', 'warehouse_id'], 0) || 0),
      name: String(pick(w, ['name', 'title', 'warehouseName', 'warehouse_name'], '') || ''),
      region: String(pick(w, ['region', 'regionName', 'region_name'], '') || ''),
      type: String(pick(w, ['type', 'warehouseType', 'warehouse_type'], '') || ''),
      address: String(pick(w, ['address', 'street'], '') || ''),
      raw: w
    }));
  }

  /** Разбор ответа /api/v3/warehouses: data / data.warehouses / warehouses / массив. */
  static extractWarehouses(json) {
    if (Array.isArray(json)) return json;
    if (!json) return [];
    if (Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.warehouses)) return json.data.warehouses;
    return pick(json, ['warehouses', 'items'], []) || [];
  }

  /**
   * POST /api/v3/stocks/{warehouseId} — остатки на складе продавца.
   * Категория «Маркетплейс», лимит 3 запроса в 30 секунд.
   */
  async getSellerStocks(warehouseId, opts) {
    const id = Number(warehouseId);
    if (!(id > 0)) throw new WBError('Не указан ID склада.', { category: 'marketplace', code: 'BAD_WH' });
    const json = await this.request('marketplace', 'POST', '/api/v3/stocks/' + id, {
      body: Object.assign({ limit: 1000 }, (opts && opts.body) || {})
    });
    const rows = WBClient.extractStockRows(json).map((r) => WBClient.normalizeStockRow(r));
    return { warehouseId: id, rows, aggregated: WBClient.aggregateStocks(rows) };
  }

  /**
   * PUT /api/v3/stocks/{warehouseId} — обновление остатков (до 1000 позиций,
   * при успехе 204). Категория «Маркетплейс».
   */
  async updateStocks(warehouseId, positions) {
    const id = Number(warehouseId);
    if (!(id > 0)) throw new WBError('Не указан ID склада.', { category: 'marketplace', code: 'BAD_WH' });
    const list = (Array.isArray(positions) ? positions : [])
      .slice(0, 1000)
      .map((p) => ({ id: Number(p.nmID || p.id), qty: Math.max(0, Math.round(Number(p.qty || p.stock || 0))) }))
      .filter((p) => p.id > 0);
    if (!list.length) throw new WBError('Нет позиций для обновления остатков.', { category: 'marketplace', code: 'EMPTY' });
    const res = await this.request('marketplace', 'PUT', '/api/v3/stocks/' + id, {
      body: { positions: list }, retries: 0
    });
    return { warehouseId: id, sent: list.length, response: res };
  }
}

module.exports = { WBClient, WBError, RateLimiter, sleep, pick, toBool, STATUS_HINTS, normalizeReportRow };
