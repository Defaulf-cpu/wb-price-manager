'use strict';

const EVENT_SETTINGS = Object.freeze({
  proposalReady: 'proposalReady',
  sendSuccess: 'sendSuccess',
  sendError: 'sendError',
  quarantine: 'quarantine',
  rateLimit: 'rateLimit',
  promoStarted: 'promoStarted',
  promoEnded: 'promoEnded',
  competitorPrice: 'competitorPrice',
  lowStock: 'lowStock'
});
const EVENT_LABELS = Object.freeze({
  proposalReady: 'Готово предложение репрайсера',
  sendSuccess: 'Отправка выполнена',
  sendError: 'Ошибка отправки',
  quarantine: 'Карантин цены',
  rateLimit: 'Раздел WB отложен из-за лимита',
  promoStarted: 'Акция началась',
  promoEnded: 'Акция закончилась',
  competitorPrice: 'Изменилась цена конкурента',
  lowStock: 'Низкий остаток'
});
const DEFAULT_EVENTS = Object.freeze(Object.keys(EVENT_SETTINGS).reduce((out, key) => { out[key] = false; return out; }, {}));
const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, start: '22:00', end: '08:00' });
const MAX_MESSAGE_LENGTH = 3900;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateTime(value, fallback) {
  const text = String(value || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return fallback;
  return text;
}

function normalizeConfig(raw) {
  const value = isObject(raw) ? raw : {};
  const events = Object.assign({}, DEFAULT_EVENTS);
  if (isObject(value.events)) {
    for (const key of Object.keys(EVENT_SETTINGS)) events[key] = value.events[key] === true;
  }
  const quiet = isObject(value.quietHours) ? value.quietHours : {};
  return {
    chatId: String(value.chatId || '').trim().slice(0, 256),
    events,
    quietHours: {
      enabled: quiet.enabled === true,
      start: validateTime(quiet.start, DEFAULT_QUIET_HOURS.start),
      end: validateTime(quiet.end, DEFAULT_QUIET_HOURS.end)
    }
  };
}

function clockMinutes(text) {
  const parts = String(text).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function quietState(date, quietHours) {
  const q = quietHours || DEFAULT_QUIET_HOURS;
  if (q.enabled !== true) return { quiet: false, waitMs: 0 };
  const start = clockMinutes(q.start);
  const end = clockMinutes(q.end);
  if (start === end) return { quiet: false, waitMs: 0 };
  const minute = date.getHours() * 60 + date.getMinutes();
  const active = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!active) return { quiet: false, waitMs: 0 };
  const nextEnd = new Date(date);
  nextEnd.setSeconds(0, 0);
  if (start < end || minute < end) nextEnd.setHours(Math.floor(end / 60), end % 60, 0, 0);
  else {
    nextEnd.setDate(nextEnd.getDate() + 1);
    nextEnd.setHours(Math.floor(end / 60), end % 60, 0, 0);
  }
  return { quiet: true, waitMs: Math.max(1000, nextEnd.getTime() - date.getTime()) };
}

function rub(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

function countWithNoun(value, one, few, many) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  const lastTwo = count % 100;
  const last = count % 10;
  const noun = lastTwo >= 11 && lastTwo <= 14 ? many : (last === 1 ? one : (last >= 2 && last <= 4 ? few : many));
  return count + ' ' + noun;
}

function formatEvent(type, payload) {
  const p = isObject(payload) ? payload : {};
  switch (type) {
    case 'proposalReady': {
      const summary = isObject(p.summary) ? p.summary : {};
      const count = Number(summary.toSend || p.count || 0);
      const delta = Number(summary.profitDeltaMonth || p.profitDeltaMonth || 0);
      const sign = delta > 0 ? '+' : '';
      return `Готово предложение репрайсера: ${countWithNoun(count, 'позиция', 'позиции', 'позиций')}; Δ прибыли за месяц ${sign}${rub(delta)} ₽.`;
    }
    case 'sendSuccess':
      return `Отправка цен выполнена: ${countWithNoun(p.count || p.sent || 0, 'позиция', 'позиции', 'позиций')}${p.source ? ' (' + String(p.source) + ')' : ''}.`;
    case 'sendError':
      return `Ошибка отправки цен${p.failed ? ' (' + countWithNoun(p.failed, 'позиция', 'позиции', 'позиций') + ')' : ''}: ${String(p.message || 'неизвестная ошибка').slice(0, 800)}`;
    case 'quarantine': {
      const rows = Array.isArray(p.items) ? p.items : (Array.isArray(p.warnings) ? p.warnings : []);
      const ids = rows.slice(0, 8).map((row) => row && row.nmID ? String(row.nmID) : '').filter(Boolean);
      return `Карантин цены: ${countWithNoun(p.count || rows.length || 0, 'позиция', 'позиции', 'позиций')}${ids.length ? '; nmID: ' + ids.join(', ') : ''}.`;
    }
    case 'rateLimit': {
      const retryValue = p.retryAt;
      const retryDate = retryValue ? new Date(typeof retryValue === 'number' || /^\d+$/.test(String(retryValue)) ? Number(retryValue) : retryValue) : null;
      const retryText = retryDate && Number.isFinite(retryDate.getTime()) ? ' (повтор ' + retryDate.toLocaleString('ru-RU') + ')' : '';
      return `Лимит WB: ${String(p.title || p.name || 'раздел')} ушёл в фоновую догрузку${retryText}. ${String(p.message || p.reason || '').slice(0, 700)}`.trim();
    }
    case 'promoStarted':
      return `Акция началась: ${String(p.name || p.promoName || ('№' + (p.id || p.promoId || '?')))}${p.endDateTime ? '; окончание ' + new Date(p.endDateTime).toLocaleString('ru-RU') : ''}.`;
    case 'promoEnded':
      return `Акция закончилась: ${String(p.name || p.promoName || ('№' + (p.id || p.promoId || '?')))}.`;
    case 'competitorPrice':
      return `Цена конкурента ${String(p.sku || p.competitorSKU || '?')} изменилась: ${rub(p.oldPrice)} → ${rub(p.newPrice)} ₽.`;
    case 'lowStock':
      return `Низкий остаток: nmID ${String(p.nmID || '?')} — ${Number(p.stock || 0)} шт., примерно ${rub(p.daysLeft)} дн. запаса (порог ${Number(p.thresholdDays || 0)} дн.).`;
    default:
      return '';
  }
}

function createTelegramNotifier(options) {
  const o = options || {};
  const store = o.store;
  if (!store || typeof store.loadSettings !== 'function' || typeof store.saveSettings !== 'function' || typeof store.loadSecrets !== 'function' || typeof store.saveSecrets !== 'function') {
    throw new Error('telegram-notifier: store с настройками и секретами обязателен');
  }
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const getFetch = () => typeof o.fetch === 'function' ? o.fetch : global.fetch;
  const delay = typeof o.setTimeout === 'function' ? o.setTimeout : setTimeout;
  const cancel = typeof o.clearTimeout === 'function' ? o.clearTimeout : clearTimeout;
  const batchDelayMs = Math.max(0, Number(o.batchDelayMs === undefined ? 1200 : o.batchDelayMs));
  const minChatIntervalMs = Math.max(0, Number(o.minChatIntervalMs === undefined ? 3100 : o.minChatIntervalMs));
  const baseRetryDelayMs = Math.max(1, Number(o.baseRetryDelayMs === undefined ? 1000 : o.baseRetryDelayMs));
  const maxAttempts = Math.max(1, Math.min(5, Number(o.maxAttempts === undefined ? 3 : o.maxAttempts)));
  let queue = [];
  let timer = null;
  let sending = false;
  let stopped = false;
  let lastSentAt = 0;
  let lastError = '';
  let dropped = 0;

  function settings() {
    const all = store.loadSettings();
    return normalizeConfig(all && all.telegramNotifications);
  }

  function token() {
    const secrets = store.loadSecrets();
    if (store.secretsError && store.secretsError()) return '';
    return String(secrets.telegramBotToken || '').trim();
  }

  function status() {
    const cfg = settings();
    const savedToken = !!token();
    const quiet = quietState(now(), cfg.quietHours);
    return {
      config: cfg,
      tokenSaved: savedToken,
      configured: savedToken && !!cfg.chatId,
      queue: { pending: queue.length, sending, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null, lastError, dropped },
      quietNow: quiet.quiet
    };
  }

  function saveConfiguration(input) {
    const p = isObject(input) ? input : {};
    const currentSecrets = store.loadSecrets();
    const secretError = store.secretsError && store.secretsError();
    if (secretError && (String(p.token || '').trim() || p.clearToken === true)) {
      throw new Error('Сохранённые секреты не прочитались; нельзя безопасно изменить Telegram-токен, чтобы не затереть ключи WB. ' + secretError);
    }
    let secretChanged = false;
    if (p.clearToken === true) {
      if (Object.prototype.hasOwnProperty.call(currentSecrets, 'telegramBotToken')) {
        delete currentSecrets.telegramBotToken;
        secretChanged = true;
      }
    } else if (p.token !== undefined && String(p.token).trim()) {
      const value = String(p.token).trim();
      if (value.length > 512 || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error('Проверьте токен Telegram: нужен токен BotFather без пробелов и переносов строк.');
      if (currentSecrets.telegramBotToken !== value) {
        currentSecrets.telegramBotToken = value;
        secretChanged = true;
      }
    }
    if (secretChanged) store.saveSecrets(currentSecrets);

    const existing = settings();
    const next = normalizeConfig({
      chatId: p.chatId === undefined ? existing.chatId : p.chatId,
      events: Object.assign({}, existing.events, isObject(p.events) ? p.events : {}),
      quietHours: Object.assign({}, existing.quietHours, isObject(p.quietHours) ? p.quietHours : {})
    });
    store.saveSettings({ telegramNotifications: next });
    return status();
  }

  function sanitizeError(value, secret) {
    let text = String(value && value.message || value || 'Неизвестная ошибка');
    if (secret) text = text.split(secret).join('[токен скрыт]');
    text = text.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[токен скрыт]');
    text = text.replace(/[\r\n\t]+/g, ' ').slice(0, 800);
    return text || 'Неизвестная ошибка';
  }

  function fetchTelegram(method, botToken, body) {
    const fetcher = getFetch();
    if (typeof fetcher !== 'function') throw new Error('В этой среде нет встроенного fetch для соединения с Telegram.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeout = null;
    if (controller) timeout = delay(() => controller.abort(), 12000);
    const init = body === undefined
      ? { method: 'GET', signal: controller ? controller.signal : undefined }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller ? controller.signal : undefined };
    return Promise.resolve().then(() => fetcher('https://api.telegram.org/bot' + botToken + '/' + method, init))
      .then(async (response) => {
        let result;
        try { result = await response.json(); } catch (_) { result = null; }
        if (!response || !response.ok || !result || result.ok !== true) {
          const error = new Error(sanitizeError(result && result.description || 'Telegram не подтвердил запрос (HTTP ' + Number(response && response.status || 0) + ').', botToken));
          error.status = Number(response && response.status || 0);
          error.retryAfter = Number(result && result.parameters && result.parameters.retry_after) || 0;
          throw error;
        }
        return result.result;
      })
      .catch((error) => {
        const safe = new Error(sanitizeError(error, botToken));
        safe.status = Number(error && error.status) || 0;
        safe.retryAfter = Number(error && error.retryAfter) || 0;
        throw safe;
      })
      .finally(() => { if (timeout) cancel(timeout); });
  }

  async function test() {
    const cfg = settings();
    const botToken = token();
    if (!botToken) return { ok: false, stage: 'configuration', message: 'Сначала сохраните токен Telegram-бота.' };
    if (!cfg.chatId) return { ok: false, stage: 'configuration', message: 'Укажите chat_id и сохраните настройки.' };
    try {
      const me = await fetchTelegram('getMe', botToken);
      if (!me || !me.id) return { ok: false, stage: 'getMe', message: 'Telegram не вернул сведения о боте.' };
    } catch (error) {
      return { ok: false, stage: 'getMe', message: 'Проверка getMe не прошла: ' + sanitizeError(error, botToken) };
    }
    try {
      await fetchTelegram('sendMessage', botToken, {
        chat_id: cfg.chatId,
        text: 'Тестовое сообщение WB Price Manager — проверка уведомлений Telegram.'
      });
      return { ok: true, stage: 'complete', message: 'Бот подтвердил getMe и отправил тестовое сообщение в указанный чат.' };
    } catch (error) {
      return { ok: false, stage: 'sendMessage', message: 'getMe прошёл, но тестовое сообщение не отправлено: ' + sanitizeError(error, botToken) };
    }
  }

  function currentQuiet() {
    return quietState(now(), settings().quietHours);
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) cancel(timer);
    timer = delay(() => {
      timer = null;
      void drain();
    }, Math.max(0, Number(ms) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function composeBatch(batch) {
    const summarize = batch.length > 12 || batch.some((entry) => entry.quiet === true);
    if (!summarize) {
      const text = batch.map((entry) => entry.text).join('\n');
      if (text.length <= MAX_MESSAGE_LENGTH) return text;
      return text.slice(0, MAX_MESSAGE_LENGTH - 50) + '\n… Остальные события вошли в сводку очереди.';
    }
    const grouped = {};
    for (const entry of batch) grouped[entry.label] = (grouped[entry.label] || 0) + 1;
    const lines = ['Сводка уведомлений (' + batch.length + ' событий):'];
    for (const [label, count] of Object.entries(grouped)) lines.push('• ' + label + ': ' + count);
    lines.push('', 'Последние события:');
    for (const entry of batch.slice(-8)) lines.push('• ' + entry.text.replace(/\n/g, ' '));
    return lines.join('\n').slice(0, MAX_MESSAGE_LENGTH);
  }

  async function drain() {
    if (stopped || sending || !queue.length) return;
    const cfg = settings();
    const botToken = token();
    if (!botToken || !cfg.chatId) {
      lastError = 'Для отправки уведомлений нужны сохранённый токен и chat_id.';
      queue = [];
      return;
    }
    const quiet = quietState(now(), cfg.quietHours);
    if (quiet.quiet) {
      schedule(quiet.waitMs);
      return;
    }
    const wait = Math.max(0, minChatIntervalMs - (now().getTime() - lastSentAt));
    if (wait > 0) {
      schedule(wait);
      return;
    }
    sending = true;
    const batch = queue.splice(0, Math.min(queue.length, 200));
    const text = composeBatch(batch);
    try {
      await fetchTelegram('sendMessage', botToken, { chat_id: cfg.chatId, text, disable_web_page_preview: true });
      lastSentAt = now().getTime();
      lastError = '';
    } catch (error) {
      lastError = sanitizeError(error, botToken);
      const attempts = Math.max(0, ...batch.map((entry) => entry.attempts || 0));
      if (!stopped && attempts + 1 < maxAttempts) {
        for (const entry of batch) entry.attempts = attempts + 1;
        queue = batch.concat(queue);
        const backoff = baseRetryDelayMs * (2 ** attempts);
        const retryAfter = Math.max(0, Number(error && error.retryAfter) || 0) * 1000;
        schedule(Math.min(60 * 60 * 1000, Math.max(backoff, retryAfter)));
      } else {
        dropped += batch.length;
      }
    } finally {
      sending = false;
      if (!stopped && queue.length && !timer) schedule(Math.max(batchDelayMs, minChatIntervalMs - (now().getTime() - lastSentAt)));
    }
  }

  function enqueue(type, payload) {
    if (stopped) return false;
    try {
      const key = EVENT_SETTINGS[type];
      if (!key) return false;
      const cfg = settings();
      if (!cfg.events[key] || !cfg.chatId || !token()) return false;
      const text = formatEvent(type, payload);
      if (!text) return false;
      const currentTime = now();
      queue.push({ type, label: EVENT_LABELS[type] || type, text, at: currentTime.toISOString(), attempts: 0, quiet: quietState(currentTime, cfg.quietHours).quiet });
      if (queue.length > 1000) { queue.shift(); dropped++; }
      if (!timer && !sending) schedule(batchDelayMs);
      return true;
    } catch (_) {
      // Уведомления — best effort: ошибка Telegram не должна влиять на основную операцию.
      return false;
    }
  }

  function handleServiceEvent(channel, payload) {
    try {
      const p = isObject(payload) ? payload : {};
      if (channel === 'app-event') return enqueue(p.type, p);
      if (channel === 'repricer' && p.type === 'proposal') return enqueue('proposalReady', p);
      if (channel === 'deferred' && (p.type === 'scheduled' || p.type === 'rescheduled')) {
        return enqueue('rateLimit', { name: p.name, title: p.title, retryAt: p.retryAt, message: p.reason || p.message });
      }
    } catch (_) { /* ошибка уведомления не должна прерывать работу сервиса */ }
    return false;
  }

  async function flushNow() {
    if (timer) { cancel(timer); timer = null; }
    await drain();
    return status();
  }

  function stop() {
    stopped = true;
    if (timer) cancel(timer);
    timer = null;
    queue = [];
  }

  return {
    getState: status,
    saveConfiguration,
    test,
    enqueue,
    handleServiceEvent,
    flushNow,
    stop,
    isBusy: () => sending,
    constants: { EVENT_SETTINGS, EVENT_LABELS, MAX_MESSAGE_LENGTH, MAX_ATTEMPTS: maxAttempts }
  };
}

module.exports = {
  createTelegramNotifier,
  EVENT_SETTINGS,
  EVENT_LABELS,
  DEFAULT_EVENTS,
  DEFAULT_QUIET_HOURS,
  quietState,
  formatEvent
};
