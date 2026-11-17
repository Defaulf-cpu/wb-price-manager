'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStore } = require('../electron/store');
const { createService } = require('../electron/service');
const { createBackupManager } = require('../electron/backup');
const { createTelegramNotifier } = require('../electron/notifications');
const { WebAuth, CSRF_COOKIE } = require('./web-auth');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RENDERER_ROOT = path.join(PROJECT_ROOT, 'src', 'renderer');
const MAX_BODY_BYTES = 25 * 1024 * 1024;
// JSON-кодирование строки файла может примерно удвоить размер 100-МиБ бэкапа.
// Прочие тела запросов по-прежнему ограничены 25 МиБ.
const MAX_INVOKE_BODY_BYTES = 220 * 1024 * 1024;
const SSE_MAX = 50;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf'
};

function parseArgs(argv, env) {
  const e = env || process.env;
  const out = {
    mode: e.WB_WEB_MODE || 'local',
    port: e.PORT === undefined ? 8080 : Number(e.PORT),
    dataDir: e.WB_WEB_DATA || path.join(PROJECT_ROOT, '.data'),
    user: e.WB_WEB_USER || '',
    pass: e.WB_WEB_PASS || '',
    cert: e.WB_WEB_CERT || '',
    key: e.WB_WEB_KEY || '',
    allowFraming: /^(1|true|yes|on)$/i.test(String(e.WB_WEB_ALLOW_FRAMING || '')),
    sameSite: /^none$/i.test(String(e.WB_WEB_SAMESITE || '')) ? 'none' : 'lax'
  };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[i + 1];
    if (key === '--mode') { out.mode = value; if (eq < 0) i++; }
    else if (key === '--port') { out.port = Number(value); if (eq < 0) i++; }
    else if (key === '--data') { out.dataDir = value; if (eq < 0) i++; }
    else if (key === '--user') { out.user = value; if (eq < 0) i++; }
    else if (key === '--pass') { out.pass = value; if (eq < 0) i++; }
    else if (key === '--cert') { out.cert = value; if (eq < 0) i++; }
    else if (key === '--key') { out.key = value; if (eq < 0) i++; }
    // флаг без значения: следующий аргумент не считаем его значением
    else if (key === '--allow-framing') { out.allowFraming = eq >= 0 ? /^(1|true|yes|on)$/i.test(value) : true; }
    else if (key === '--samesite') { out.sameSite = String(value || '').toLowerCase() === 'none' ? 'none' : 'lax'; if (eq < 0) i++; }
  }
  if (!out.user) out.user = 'admin';
  out.dataDir = path.resolve(PROJECT_ROOT, out.dataDir);
  if (!['local', 'lan', 'internet'].includes(out.mode)) throw new Error('Недопустимый режим --mode: ' + out.mode);
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('Порт должен быть числом от 0 до 65535.');
  if (!!out.cert !== !!out.key) throw new Error('Для HTTPS задайте одновременно WB_WEB_CERT и WB_WEB_KEY.');
  return out;
}

function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

function isPrivateIp(ip) {
  const s = normalizeIp(ip);
  if (s === '::1' || s === 'localhost') return true;
  const v4 = s.split('.');
  if (v4.length === 4 && v4.every((n) => /^\d{1,3}$/.test(n) && Number(n) >= 0 && Number(n) <= 255)) {
    const a = Number(v4[0]); const b = Number(v4[1]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // fd00::/8 — уникальные локальные адреса IPv6. Прочие глобальные и link-local диапазоны
  // приватными не считаем: иначе доступ из сети получила бы половина интернета.
  return /^fd[0-9a-f]{2}:/i.test(s);
}

function getClientIp(req) {
  // Заголовок X-Forwarded-For намеренно не используется: его подставляет кто угодно, а значит
  // по нему нельзя ни ограничивать доступ в режиме lan, ни считать блокировку попыток входа.
  // Доверять ему можно только за доверенным обратным прокси, которого здесь нет.
  return normalizeIp(req.socket && req.socket.remoteAddress || '');
}

function makeCsp(indexHtml, allowFraming) {
  const hashes = [];
  const re = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(indexHtml))) {
    hashes.push("'sha256-" + crypto.createHash('sha256').update(match[1]).digest('base64') + "'");
  }
  return "default-src 'self'; script-src 'self'" + (hashes.length ? ' ' + Array.from(new Set(hashes)).join(' ') : '') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
    // защита от кликджекинга: по умолчанию встраивать страницу в iframe запрещено.
    // --allow-framing снимает запрет — только для доверенного портала/предпросмотра.
    (allowFraming ? "frame-ancestors *" : "frame-ancestors 'none'");
}

function json(res, status, value, headers) {
  const body = JSON.stringify(value);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function text(res, status, value, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(value);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > limit) {
        done = true;
        reject(Object.assign(new Error('Размер тела запроса превышает ' + Math.ceil(limit / (1024 * 1024)) + ' МБ.'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
    req.on('aborted', () => { if (!done) { done = true; reject(Object.assign(new Error('Запрос прерван.'), { statusCode: 400 })); } });
  });
}

function parseLoginBody(buffer, contentType) {
  const raw = buffer.toString('utf8');
  if (!raw) return {};
  if (/application\/json/i.test(contentType || '')) {
    try { return JSON.parse(raw); } catch (_) { throw Object.assign(new Error('Некорректный JSON.'), { statusCode: 400 }); }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType || '')) {
    const form = new URLSearchParams(raw);
    return { user: form.get('user') || '', pass: form.get('pass') || '', csrf: form.get('csrf') || '' };
  }
  throw Object.assign(new Error('Ожидался JSON или form-urlencoded.'), { statusCode: 415 });
}

/**
 * Страница входа. Стили вписаны прямо в страницу (CSP разрешает 'unsafe-inline' для стилей),
 * чтобы оформление приложения не отдавалось неавторизованному посетителю вместе с CSS.
 */
function loginHtml(csrf, error) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
  const css = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0e1116;color:#e8ecf4;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}' +
    'main{width:min(400px,92vw);background:#141922;border:1px solid #252d3d;border-radius:12px;' +
    'padding:28px;box-shadow:0 12px 32px rgba(0,0,0,.45)}' +
    'h1{margin:0 0 4px;font-size:20px}p.sub{margin:0 0 20px;color:#8b96a9;font-size:13px}' +
    'label{display:block;margin-bottom:14px;color:#8b96a9;font-size:13px}' +
    'input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;' +
    'background:#0e1116;border:1px solid #2f3a4e;border-radius:8px;color:#e8ecf4;font-size:15px}' +
    'input:focus{outline:none;border-color:#a03cff}' +
    'button{width:100%;margin-top:6px;padding:11px;border:0;border-radius:8px;cursor:pointer;' +
    'background:#a03cff;color:#fff;font-size:15px;font-weight:600}' +
    'button:hover{background:#7b2fd4}' +
    '[role=alert]{margin:0 0 16px;padding:10px 12px;border-radius:8px;font-size:13px;' +
    'background:rgba(255,92,114,.14);border:1px solid rgba(255,92,114,.4);color:#ff8fa0}';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Вход — WB Price Manager</title><style>' + css + '</style></head>' +
    '<body><main><h1>WB Price Manager</h1>' +
    '<p class="sub">Веб-доступ к управлению ценами Wildberries. Ключи и данные остаются ' +
    'на компьютере, где запущен сервер.</p>' +
    (error ? '<p role="alert">' + esc(error) + '</p>' : '') +
    '<form method="post" action="/login"><input type="hidden" name="csrf" value="' + esc(csrf) + '">' +
    '<label>Логин <input name="user" autocomplete="username" required></label>' +
    '<label>Пароль <input type="password" name="pass" autocomplete="current-password" required></label>' +
    '<button type="submit">Войти</button></form></main></body></html>';
}

function createWebServer(options) {
  const opts = Object.assign({}, options || {});
  const mode = opts.mode || 'local';
  if (!['local', 'lan', 'internet'].includes(mode)) throw new Error('Недопустимый режим: ' + mode);
  const port = opts.port === undefined ? 8080 : Number(opts.port);
  const host = opts.host || (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
  const dataDir = path.resolve(opts.dataDir || path.join(PROJECT_ROOT, '.data'));
  const secure = !!(opts.cert && opts.key);
  const log = opts.log || ((line) => console.log(line));
  const errorLog = opts.errorLog || ((line) => console.error(line));
  const getIp = opts.getClientIp || getClientIp;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sameSite = String(opts.sameSite || '').toLowerCase() === 'none' ? 'none' : 'lax';
  const auth = new WebAuth(dataDir, { user: opts.user || 'admin', pass: opts.pass || '', secure, sameSite });
  const store = createStore(dataDir, null);
  const backupManager = createBackupManager({ store, dir: dataDir, appVersion: require('../package.json').version, now: opts.now });
  backupManager.startScheduler();
  const telegramNotifier = createTelegramNotifier({ store, fetch: opts.fetch, now: opts.now, batchDelayMs: opts.notifyBatchDelayMs });
  const sseClients = new Set();
  const allowFraming = !!opts.allowFraming;
  const indexHtml = fs.readFileSync(path.join(RENDERER_ROOT, 'index.html'), 'utf8');
  const csp = makeCsp(indexHtml, allowFraming);
  let stopping = false;

  function broadcast(channel, payload) {
    if (!sseClients.size) return;
    const safeChannel = String(channel || 'event').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 120) || 'event';
    let data;
    try { data = JSON.stringify(payload === undefined ? null : payload); }
    catch (_) { data = JSON.stringify({ unserializable: true }); }
    const frame = 'event: svc:' + safeChannel + '\ndata: ' + data + '\n\n';
    for (const client of Array.from(sseClients)) {
      try { if (!client.destroyed && !client.writableEnded) client.write(frame); else sseClients.delete(client); }
      catch (_) { sseClients.delete(client); }
    }
  }

  const service = createService(store, broadcast, null, { backupManager, telegramNotifier });
  try { service.applyScheduler(); } catch (e) { errorLog('[web] Планировщик: ' + (e.stack || e.message || e)); }

  const server = (secure ? https : http).createServer(secure ? {
    cert: fs.readFileSync(path.resolve(opts.cert)), key: fs.readFileSync(path.resolve(opts.key)),
    minVersion: 'TLSv1.2'
  } : {}, (req, res) => {
    const startAt = process.hrtime.bigint();
    let logged = false;
    const requestPath = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch (_) { return '<invalid>'; } })();
    const ip = normalizeIp(getIp(req));
    const commonHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': csp,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store'
    };
    res.setHeader('X-Content-Type-Options', commonHeaders['X-Content-Type-Options']);
    // при --allow-framing заголовок не ставится вовсе: DENY и CSP frame-ancestors *
    // противоречат друг другу, а браузеры смотрят на оба
    if (!allowFraming) res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', commonHeaders['Referrer-Policy']);
    res.setHeader('Content-Security-Policy', commonHeaders['Content-Security-Policy']);
    res.setHeader('Permissions-Policy', commonHeaders['Permissions-Policy']);
    res.setHeader('Cache-Control', commonHeaders['Cache-Control']);
    res.on('finish', () => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - startAt) / 1e6;
      log(new Date().toISOString() + ' ' + (ip || '-') + ' ' + req.method + ' ' + requestPath + ' ' + res.statusCode + ' ' + ms.toFixed(1) + 'ms');
    });
    res.on('close', () => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - startAt) / 1e6;
      log(new Date().toISOString() + ' ' + (ip || '-') + ' ' + req.method + ' ' + requestPath + ' ' + res.statusCode + ' ' + ms.toFixed(1) + 'ms (closed)');
    });

    const fail = (status, message, headers) => {
      if (res.headersSent) { res.destroy(); return; }
      if (requestPath.startsWith('/api/')) return json(res, status, { ok: false, error: { message } }, headers);
      return text(res, status, message, headers);
    };

    (async () => {
      if (stopping) return fail(503, 'Сервер завершает работу.');
      if (mode === 'lan' && !isPrivateIp(ip)) return fail(403, 'Доступ разрешён только из приватных сетей.');

      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch (_) { return fail(400, 'Некорректный URL.'); }
      const pathname = url.pathname;

      if (pathname === '/login' && req.method === 'GET') {
        if (auth.getSession(req)) { res.writeHead(303, { Location: '/' }); return res.end(); }
        const csrf = require('./web-auth').parseCookies(req.headers.cookie)[CSRF_COOKIE] || '';
        const token = csrf || require('crypto').randomBytes(24).toString('base64url');
        const setCookies = [];
        if (!csrf) setCookies.push(auth.cookieHeader(CSRF_COOKIE, token, { maxAge: 900 }));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}) });
        return res.end(loginHtml(token));
      }

      if (pathname === '/login' && req.method === 'POST') {
        let input;
        try { input = parseLoginBody(await readBody(req, MAX_BODY_BYTES), req.headers['content-type']); }
        catch (e) { return fail(e.statusCode || 400, e.message); }
        const cookies = require('./web-auth').parseCookies(req.headers.cookie);
        const loginToken = input.csrf || req.headers['x-csrf-token'] || '';
        if (!auth.checkCsrf(req, loginToken, null)) return fail(403, 'CSRF-токен недействителен. Обновите страницу входа.');
        const result = await auth.authenticate(input.user, input.pass, ip);
        if (!result.ok) {
          if (result.limited) return fail(429, 'Слишком много неудачных попыток входа. Повторите позже.', { 'Retry-After': String(result.retryAfter) });
          if (/application\/json/i.test(req.headers['content-type'] || '')) return json(res, 401, { ok: false, error: { message: 'Неверный логин или пароль.' } });
          const body = loginHtml(cookies[CSRF_COOKIE], 'Неверный логин или пароль.');
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(body);
        }
        const cookiesOut = [
          auth.cookieHeader('wb_web_session', result.cookie, { httpOnly: true, maxAge: 12 * 60 * 60 }),
          auth.cookieHeader(CSRF_COOKIE, result.csrf, { maxAge: 12 * 60 * 60 })
        ];
        if (/application\/json/i.test(req.headers['content-type'] || '')) {
          return json(res, 200, { ok: true }, { 'Set-Cookie': cookiesOut });
        }
        res.writeHead(303, { Location: '/', 'Set-Cookie': cookiesOut, 'Cache-Control': 'no-store' });
        return res.end();
      }

      const isApi = pathname === '/api' || pathname.startsWith('/api/');
      const session = auth.getSession(req);
      if (isApi && !session) return fail(401, 'Требуется вход.');
      if (!isApi && pathname !== '/login' && !session) {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (isApi && req.method === 'POST') {
        const csrf = req.headers['x-csrf-token'];
        if (typeof csrf !== 'string' || !auth.checkCsrf(req, csrf, session)) return fail(403, 'CSRF-токен отсутствует или недействителен.');
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        auth.revoke(req);
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookies() });
      }

      if (pathname === '/api/invoke' && req.method === 'POST') {
        let body;
        try {
          const buf = await readBody(req, MAX_INVOKE_BODY_BYTES);
          try { body = JSON.parse(buf.toString('utf8')); }
          catch (_) { return fail(400, 'Некорректный JSON в теле запроса.'); }
        } catch (e) { return fail(e.statusCode || 400, e.message || 'Не удалось прочитать запрос.'); }
        if (!body || typeof body !== 'object' || typeof body.channel !== 'string' || !Array.isArray(body.args)) {
          return fail(400, 'Ожидается JSON { channel, args: [] }.');
        }
        const handler = service.handlers[body.channel];
        if (typeof handler !== 'function') return json(res, 400, { ok: false, error: { message: 'Неизвестный канал: ' + body.channel } });
        try {
          const data = await handler(...body.args);
          return json(res, 200, { ok: true, data });
        } catch (e) {
          return json(res, 200, { ok: false, error: { message: e && e.message || String(e), code: e && e.code || '', status: e && e.status || 0 } });
        }
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        if (sseClients.size >= SSE_MAX) return fail(503, 'Слишком много подключений к потоку событий.');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('retry: 3000\n\n: connected\n\n');
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }
          catch (_) { cleanup(); }
        }, 25000);
        if (heartbeat.unref) heartbeat.unref();
        let cleaned = false;
        function cleanup() {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          sseClients.delete(res);
        }
        req.on('aborted', cleanup);
        res.on('close', cleanup);
        return;
      }

      if (pathname.startsWith('/api/')) return fail(404, 'Неизвестный API-маршрут.');
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Метод не поддерживается.', { Allow: 'GET, HEAD' });

      // Эти общие модули используются HTML-интерфейсом и в dev-сервере.
      if (pathname === '/economics.js' || pathname === '/repricer-engine.js') {
        const file = path.join(PROJECT_ROOT, 'electron', pathname.slice(1));
        return sendFile(file, req, res, { cache: 'public, max-age=3600' });
      }
      let decoded;
      try { decoded = decodeURIComponent(pathname); }
      catch (_) { return fail(400, 'Некорректный путь.'); }
      if (decoded.includes('\\') || decoded.includes('\0')) return fail(400, 'Некорректный путь.');
      if (decoded === '/' || decoded === '') decoded = '/index.html';
      const candidate = path.resolve(RENDERER_ROOT, '.' + decoded);
      const relative = path.relative(RENDERER_ROOT, candidate);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return fail(403, 'Путь за пределами каталога статики запрещён.');
      return sendFile(candidate, req, res, { cache: path.extname(candidate).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600' });
    })().catch((err) => {
      errorLog('[web] Ошибка запроса ' + req.method + ' ' + requestPath + ': ' + (err && err.stack || err));
      fail(500, 'Внутренняя ошибка сервера.');
    });

    function sendFile(filePath, request, response, cacheOpts) {
      fs.realpath(filePath, (realErr, realPath) => {
        if (realErr) return fail(404, 'Файл не найден.');
        const root = filePath === path.join(PROJECT_ROOT, 'electron', 'economics.js') || filePath === path.join(PROJECT_ROOT, 'electron', 'repricer-engine.js')
          ? path.join(PROJECT_ROOT, 'electron') : RENDERER_ROOT;
        const rel = path.relative(root, realPath);
        if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return fail(403, 'Путь за пределами каталога статики запрещён.');
        fs.stat(realPath, (statErr, stat) => {
          if (statErr || !stat.isFile()) return fail(404, 'Файл не найден.');
          fs.readFile(realPath, (readErr, buf) => {
            if (readErr) return fail(500, 'Не удалось прочитать файл.');
            const ext = path.extname(realPath).toLowerCase();
            const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheOpts.cache };
            if (ext === '.html') headers['Content-Security-Policy'] = csp;
            response.writeHead(200, headers);
            if (request.method === 'HEAD') response.end(); else response.end(buf);
          });
        });
      });
    }
  });

  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
      const onListening = () => { server.removeListener('error', onError); resolve(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function close() {
    stopping = true;
    for (const client of Array.from(sseClients)) {
      try { client.end(); } catch (_) {}
    }
    sseClients.clear();
    if (service.sched && service.sched.timer) { clearInterval(service.sched.timer); service.sched.timer = null; }
    backupManager.stopScheduler();
    telegramNotifier.stop();
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      const timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        resolve();
      }, 5000);
      if (timer.unref) timer.unref();
    });
  }

  return { server, store, service, auth, backupManager, telegramNotifier, sseClients, mode, host, port, dataDir, allowFraming, sameSite, listen, close, getClientIp: getIp };
}

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) for (const net of list || []) {
    if (!net.internal && net.family === 'IPv4') out.push(net.address);
  }
  return Array.from(new Set(out));
}

function printStartup(app, address) {
  const scheme = app.auth.secure ? 'https' : 'http';
  const actualPort = address.port;
  const local = scheme + '://127.0.0.1:' + actualPort;
  console.log('\nWB Price Manager — веб-сервер');
  console.log('Режим доступа: ' + app.mode);
  console.log('Данные: ' + app.dataDir);
  console.log('Локальный адрес: ' + local);
  const addresses = localAddresses();
  console.log('Адреса интерфейсов LAN' + (app.mode === 'local' ? ' (в режиме local не слушаются)' : '') + ': ' +
    (addresses.length ? addresses.map((ip) => scheme + '://' + ip + ':' + actualPort).join(', ') : 'не найдены'));
  console.log('Логин: ' + (app.auth.state.user || 'admin'));
  if (app.auth.generatedPassword) console.log('Сгенерированный пароль (сохраните сейчас): ' + app.auth.generatedPassword);
  if (app.sameSite === 'none') {
    console.warn('ВНИМАНИЕ: --samesite none разрешает отправлять cookie с чужих сайтов (нужно для iframe-портала). Работает только по HTTPS: без сертификата нужен туннель или прокси с TLS.');
  }
  if (app.allowFraming) console.warn('ВНИМАНИЕ: --allow-framing разрешает встраивать страницу в iframe на любом сайте. Защита от кликджекинга отключена — используйте только для доверенного портала.');
  if (app.mode === 'internet') console.warn('ВНИМАНИЕ: режим internet доступен извне. Используйте HTTPS, надёжный пароль и туннель/фаервол; ключи WB хранятся на этом компьютере.');
  if (!app.auth.secure) {
    console.warn('ВНИМАНИЕ: сейчас HTTP без шифрования. Не используйте обычный HTTP через интернет.');
    console.log('HTTPS: для LAN установите mkcert и выполните: mkcert -install; mkcert -cert-file lan.crt -key-file lan.key localhost 127.0.0.1 <IP-LAN>, затем задайте WB_WEB_CERT=lan.crt и WB_WEB_KEY=lan.key. Для публичного домена: certbot --nginx -d example.com (Let\'s Encrypt), затем WB_WEB_CERT=/etc/letsencrypt/live/example.com/fullchain.pem и WB_WEB_KEY=/etc/letsencrypt/live/example.com/privkey.pem.');
  }
  if (app.mode === 'internet') {
    console.log('Доступ без белого IP через Cloudflare Tunnel: cloudflared tunnel --url http://localhost:' + actualPort);
    console.log('Через Tailscale Serve: tailscale serve --bg ' + actualPort);
    console.log('Через SSH reverse tunnel (на сервере с публичным SSH): ssh -N -R 0.0.0.0:8443:localhost:' + actualPort + ' user@your-vps');
  }
  console.log('');
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.cert) {
    config.cert = path.resolve(PROJECT_ROOT, config.cert);
    config.key = path.resolve(PROJECT_ROOT, config.key);
  }
  const app = createWebServer(config);
  if (app.auth.generatedPassword && config.mode === 'internet') {
    console.warn('Для режима internet не задан WB_WEB_PASS/--pass. Создан новый пароль — без него вход невозможен.');
  }
  const address = await app.listen();
  printStartup(app, address);
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nПолучен ' + signal + ', завершаю сервер…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[uncaughtException] ' + (err && err.stack || err)));
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection] ' + (reason && reason.stack || reason)));
}

if (require.main === module) {
  main().catch((err) => { console.error('[web] Не удалось запустить сервер: ' + (err && err.stack || err)); process.exitCode = 1; });
}

module.exports = { createWebServer, parseArgs, isPrivateIp, getClientIp, makeCsp, MAX_BODY_BYTES, MAX_INVOKE_BODY_BYTES, SSE_MAX };
