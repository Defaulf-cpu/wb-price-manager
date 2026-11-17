'use strict';

/**
 * Dev-сервер для просмотра интерфейса в обычном браузере (без установки Electron).
 *   node tools/serve.js            — демо-режим
 *   WB_API_KEY=... node tools/serve.js   — реальные данные WB
 *
 * Тот же слой логики (electron/service.js), что и в десктопном приложении.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createProfileHub } = require('../electron/profiles');
const { createTelegramNotifier } = require('../electron/notifications');
const { createService } = require('../electron/service');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, '..', '.data');
// ───────────────────────── События (SSE) ─────────────────────────
/**
 * В Electron события идут через ipcRenderer (`svc:<channel>`), а в браузере их раньше
 * не было вовсе: сервис создавался с пустым emit, поэтому прогресс фоновой догрузки
 * разделов, предупреждения WB и уведомления репрайсера в веб-версии не показывались.
 *
 * Теперь dev-сервер держит список SSE-подключений и рассылает им те же события
 * в том же формате (`event: svc:<channel>`, `data: <json>`), что и preload.
 */
const sseClients = new Set();
const SSE_MAX = 50;

function broadcast(channel, payload) {
  if (!sseClients.size) return;
  let frame;
  try {
    frame = 'event: svc:' + channel + '\ndata: ' + JSON.stringify(payload === undefined ? null : payload) + '\n\n';
  } catch (e) {
    // payload с циклическими ссылками не сериализуется — событие важнее деталей
    frame = 'event: svc:' + channel + '\ndata: ' + JSON.stringify({ unserializable: true }) + '\n\n';
  }
  for (const res of Array.from(sseClients)) {
    try { res.write(frame); } catch (e) { sseClients.delete(res); }
  }
}

// Даже dev-сервер использует тот же каталог выбранного профиля, а не создаёт
// заново старые корневые файлы после миграции Electron/защищённой веб-версии.
const service = createProfileHub({ dataDir: DATA_DIR, createService, createTelegramNotifier,
  appVersion: require('../package.json').version, broadcast, switchable: false,
  profileId: process.env.WB_WEB_PROFILE || '' });
const store = service.getActiveStore();

// Ключи из окружения — удобно проверить реальное API без сборки Electron
const envKeys = {};
if (process.env.WB_API_KEY) { envKeys.single = process.env.WB_API_KEY; }
if (process.env.WB_PRICES_KEY) envKeys.prices = process.env.WB_PRICES_KEY;
if (process.env.WB_STAT_KEY) envKeys.statistics = process.env.WB_STAT_KEY;
if (process.env.WB_CONTENT_KEY) envKeys.content = process.env.WB_CONTENT_KEY;
if (Object.keys(envKeys).length) {
  const existing = store.loadSecrets();
  store.saveSecrets(Object.assign({}, existing, envKeys));
}

const forceDemo = process.argv.includes('--demo');
if (forceDemo) store.saveSettings({ demoMode: true });
else if (Object.keys(envKeys).length) store.saveSettings({ demoMode: false });

try { service.startAllSchedulers(); }
catch (error) { console.log('  Планировщик: ' + error.message); }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) { reject(new Error('Слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Некорректный JSON в теле запроса')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
  }

  if (url.pathname === '/api/invoke' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const channel = body.channel;
      const args = Array.isArray(body.args) ? body.args : [];
      const fn = service.handlers[channel];
      if (!fn) return send(res, 400, JSON.stringify({ ok: false, error: { message: 'Неизвестный канал: ' + channel } }), { 'Content-Type': 'application/json; charset=utf-8' });
      const data = await fn(...args);
      return send(res, 200, JSON.stringify({ ok: true, data }), { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, error: { message: e.message || String(e), code: e.code || '', status: e.status || 0 } }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
  }

  /**
   * SSE-поток событий. EventSource в браузере сам переподключается при обрыве,
   * поэтому достаточно держать соединение и слать heartbeat, чтобы прокси
   * (и превью-сервер) не закрывали его по таймауту.
   */
  if (url.pathname === '/api/events') {
    if (sseClients.size >= SSE_MAX) {
      return send(res, 503, 'Слишком много подключений к потоку событий', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'   // nginx/прокси не должны буферизовать поток
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    sseClients.add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* соединение уже закрыто */ }
    }, 25000);
    if (ping.unref) ping.unref();

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  // общие модули расчётов (один источник для Node и браузера)
  if (url.pathname === '/economics.js' || url.pathname === '/repricer-engine.js') {
    const f = url.pathname.slice(1);
    return fs.readFile(path.join(__dirname, '..', 'electron', f), (err, buf) => {
      if (err) return send(res, 404, f + ' not found');
      send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8' });
    });
  }

  // статика
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'Not found: ' + rel);
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  });
});

server.listen(PORT, HOST, () => {
  const mode = service.getActive().service.isDemo() ? 'ДЕМО-данные (API-ключ не задан)' : 'реальные данные WB API';
  console.log('');
  console.log('  WB Price Manager — интерфейс запущен');
  console.log('  Режим: ' + mode);
  console.log(`  Адрес:  http://localhost:${PORT}`);
  console.log('  Данные: ' + DATA_DIR);
  console.log('');
  console.log('  Для боевого режима:  WB_API_KEY=ваш_ключ node tools/serve.js');
  console.log('');
});

function closeDevServer() {
  service.stopAllSchedulers();
  for (const response of sseClients) response.end();
  server.close();
}
process.once('SIGINT', closeDevServer);
process.once('SIGTERM', closeDevServer);
