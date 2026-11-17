'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
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
const VALID_MODES = Object.freeze(['tunnel', 'local', 'lan', 'internet']);
const VALID_TUNNEL_PROVIDERS = Object.freeze(['auto', 'cloudflare', 'tailscale', 'off']);
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

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (/^(1|true|yes|on|y)$/i.test(String(value).trim())) return true;
  if (/^(0|false|no|off|n)$/i.test(String(value).trim())) return false;
  return fallback;
}

function findExecutable(command, env, platform) {
  const e = env || process.env;
  const isWindows = (platform || process.platform) === 'win32';
  const pathValue = e.PATH || e.Path || e.path || '';
  const searchDirs = String(pathValue).split(isWindows ? ';' : path.delimiter).filter(Boolean);
  const commandText = String(command || '');
  const hasDirectory = /[\\/]/.test(commandText);
  const directories = hasDirectory ? [''] : searchDirs;
  const extensions = isWindows ? String(e.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const names = isWindows && !path.extname(commandText)
    ? extensions.map((extension) => commandText + extension.toLowerCase()).concat(extensions.map((extension) => commandText + extension.toUpperCase()))
    : [commandText];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.resolve(directory, name) : path.resolve(name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) { /* продолжить поиск в PATH */ }
    }
  }
  return null;
}

function normalizeTunnelProvider(value) {
  const provider = String(value || 'auto').trim().toLowerCase();
  return provider === 'cloudflared' ? 'cloudflare' : provider;
}

function parseArgs(argv, env) {
  const e = env || process.env;
  const out = {
    mode: e.WB_WEB_MODE || 'tunnel',
    port: e.PORT === undefined ? 8080 : Number(e.PORT),
    dataDir: e.WB_WEB_DATA || path.join(PROJECT_ROOT, '.data'),
    user: e.WB_WEB_USER || '',
    pass: e.WB_WEB_PASS || '',
    cert: e.WB_WEB_CERT || '',
    key: e.WB_WEB_KEY || '',
    insecureIKnow: parseBoolean(e.WB_WEB_INSECURE_I_KNOW, false),
    tunnelAutostart: parseBoolean(e.WB_WEB_TUNNEL_AUTOSTART, true),
    tunnelProvider: normalizeTunnelProvider(e.WB_WEB_TUNNEL_PROVIDER || 'auto'),
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
    else if (key === '--insecure-i-know') out.insecureIKnow = eq >= 0 ? parseBoolean(value, false) : true;
    else if (key === '--start-tunnel' || key === '--tunnel-autostart') out.tunnelAutostart = eq >= 0 ? parseBoolean(value, true) : true;
    else if (key === '--no-start-tunnel' || key === '--no-tunnel-autostart') out.tunnelAutostart = false;
    else if (key === '--tunnel-provider') { out.tunnelProvider = normalizeTunnelProvider(value); if (eq < 0) i++; }
    // флаг без значения: следующий аргумент не считаем его значением
    else if (key === '--allow-framing') { out.allowFraming = eq >= 0 ? parseBoolean(value, false) : true; }
    else if (key === '--samesite') { out.sameSite = String(value || '').toLowerCase() === 'none' ? 'none' : 'lax'; if (eq < 0) i++; }
  }
  if (!out.user) out.user = 'admin';
  out.dataDir = path.resolve(PROJECT_ROOT, out.dataDir);
  if (!VALID_MODES.includes(out.mode)) throw new Error('Недопустимый режим --mode: ' + out.mode);
  if (!VALID_TUNNEL_PROVIDERS.includes(out.tunnelProvider)) throw new Error('Недопустимый туннель --tunnel-provider: ' + out.tunnelProvider + ' (допустимо auto, cloudflare, tailscale или off).');
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
  const mode = opts.mode || 'tunnel';
  if (!VALID_MODES.includes(mode)) throw new Error('Недопустимый режим: ' + mode);
  const certSupplied = !!opts.cert;
  const keySupplied = !!opts.key;
  if (certSupplied !== keySupplied) throw new Error('Для HTTPS задайте одновременно --cert и --key (или WB_WEB_CERT и WB_WEB_KEY).');
  const secure = certSupplied && keySupplied;
  const insecureIKnow = opts.insecureIKnow === true;
  if (mode === 'internet' && !secure && !insecureIKnow) {
    throw new Error('Режим internet требует HTTPS: задайте --cert и --key (или WB_WEB_CERT и WB_WEB_KEY). Для явного небезопасного HTTP используйте --insecure-i-know; безопасный вариант для доступа извне — --mode tunnel.');
  }
  const tunnelAutostart = opts.tunnelAutostart !== false;
  const tunnelProvider = normalizeTunnelProvider(opts.tunnelProvider || 'auto');
  if (!VALID_TUNNEL_PROVIDERS.includes(tunnelProvider)) throw new Error('Недопустимый туннель --tunnel-provider: ' + tunnelProvider + '.');
  const port = opts.port === undefined ? 8080 : Number(opts.port);
  const host = mode === 'tunnel' ? '127.0.0.1' : (opts.host || (mode === 'local' ? '127.0.0.1' : '0.0.0.0'));
  const dataDir = path.resolve(opts.dataDir || path.join(PROJECT_ROOT, '.data'));
  const tlsOptions = secure ? {
    cert: fs.readFileSync(path.resolve(opts.cert)), key: fs.readFileSync(path.resolve(opts.key)),
    minVersion: 'TLSv1.2'
  } : {};
  const insecureHttp = mode === 'internet' && !secure;
  const log = opts.log || ((line) => console.log(line));
  const errorLog = opts.errorLog || ((line) => console.error(line));
  const getIp = opts.getClientIp || getClientIp;
  const tunnelEnv = opts.env || process.env;
  const childSpawn = opts.spawn || spawn;
  const childSpawnSync = opts.spawnSync || spawnSync;
  const executableLookup = typeof opts.findExecutable === 'function'
    ? opts.findExecutable
    : (name) => findExecutable(name, tunnelEnv, opts.platform || process.platform);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sameSite = String(opts.sameSite || '').toLowerCase() === 'none' ? 'none' : 'lax';
  const auth = new WebAuth(dataDir, { user: opts.user || 'admin', pass: opts.pass || '', secure: secure || mode === 'tunnel', sameSite });
  const store = createStore(dataDir, null);
  const backupManager = createBackupManager({ store, dir: dataDir, appVersion: require('../package.json').version, now: opts.now });
  backupManager.startScheduler();
  const telegramNotifier = createTelegramNotifier({ store, fetch: opts.fetch, now: opts.now, batchDelayMs: opts.notifyBatchDelayMs });
  const sseClients = new Set();
  const allowFraming = !!opts.allowFraming;
  const indexHtml = fs.readFileSync(path.join(RENDERER_ROOT, 'index.html'), 'utf8');
  const csp = makeCsp(indexHtml, allowFraming);
  let stopping = false;
  let activeTunnel = null;
  let tunnelAttempted = false;

  function decorateHtml(html) {
    if (!insecureHttp) return html;
    const banner = '<aside role="alert" aria-live="assertive" style="position:sticky;top:0;z-index:2147483647;padding:10px 16px;background:#7f1d1d;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center;border-bottom:2px solid #fecaca">ВНИМАНИЕ: интернет-доступ работает по HTTP без TLS. Пароль и данные могут быть перехвачены. Отключите этот режим и используйте HTTPS или режим tunnel.</aside>';
    const source = String(html);
    const bodyStart = source.toLowerCase().indexOf('<body');
    if (bodyStart < 0) return banner + source;
    const bodyEnd = source.indexOf('>', bodyStart);
    if (bodyEnd < 0) return banner + source;
    return source.slice(0, bodyEnd + 1) + banner + source.slice(bodyEnd + 1);
  }

  function installHint(provider) {
    if (provider === 'cloudflare') return 'Установите Cloudflare Tunnel (cloudflared): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
    if (provider === 'tailscale') return 'Установите Tailscale на сервер и клиент: https://tailscale.com/download';
    return 'Установите один из туннелей: cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) или Tailscale (https://tailscale.com/download).';
  }

  function tailscaleUrl(executable) {
    try {
      const result = childSpawnSync(executable, ['status', '--json'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, env: tunnelEnv
      });
      if (result.error || result.status !== 0) return '';
      const status = JSON.parse(String(result.stdout || ''));
      let dnsName = String(status && status.Self && status.Self.DNSName || '').trim();
      while (dnsName.endsWith('.')) dnsName = dnsName.slice(0, -1);
      return dnsName ? 'https://' + dnsName : '';
    } catch (_) { return ''; }
  }

  function extractExternalUrl(source, suffix) {
    for (const part of String(source || '').split(' ')) {
      let candidate = part.trim();
      while (candidate) {
        const last = candidate[candidate.length - 1];
        if (last.charCodeAt(0) > 32 && !['\"', "'", '<', '>', ')', ',', '.', ';'].includes(last)) break;
        candidate = candidate.slice(0, -1);
      }
      if (candidate.startsWith('https://') && candidate.toLowerCase().includes(suffix)) return candidate;
    }
    return '';
  }

  function startTunnel(actualPort) {
    const targetPort = Number(actualPort || port);
    const target = (secure ? 'https' : 'http') + '://127.0.0.1:' + targetPort;
    const manualCommands = {
      cloudflare: 'cloudflared tunnel --url ' + target + (secure ? ' --no-tls-verify' : ''),
      tailscale: 'tailscale serve --bg ' + target
    };
    if (mode !== 'tunnel') return { started: false, reason: 'not-tunnel-mode' };
    if (tunnelAttempted) return { started: !!activeTunnel, reason: 'already-attempted' };
    tunnelAttempted = true;
    if (!tunnelAutostart) {
      log('[tunnel] Автозапуск выключен. Запустите вручную одну из команд: ' + manualCommands.cloudflare + '  |  ' + manualCommands.tailscale);
      return { started: false, reason: 'autostart-disabled', commands: manualCommands };
    }
    if (tunnelProvider === 'off') {
      log('[tunnel] Автозапуск отключён параметром --tunnel-provider off. Сервер доступен только локально: ' + target);
      return { started: false, reason: 'provider-disabled', commands: manualCommands };
    }
    const candidates = tunnelProvider === 'auto' ? ['cloudflare', 'tailscale'] : [tunnelProvider];
    let selected = null;
    for (const provider of candidates) {
      const binary = provider === 'cloudflare' ? 'cloudflared' : 'tailscale';
      const executable = executableLookup(binary);
      if (executable) { selected = { provider, binary, executable }; break; }
    }
    if (!selected) {
      const missingProvider = tunnelProvider === 'auto' ? 'auto' : tunnelProvider;
      const reason = 'Туннель не запущен: ' + (missingProvider === 'auto' ? 'cloudflared и tailscale' : (tunnelProvider === 'cloudflare' ? 'cloudflared' : 'tailscale')) + ' не найден(ы) в PATH. ' + installHint(missingProvider === 'auto' ? '' : missingProvider);
      log('[tunnel] ' + reason);
      log('[tunnel] Сервер продолжает работать только на ' + target + '. Команды для ручного запуска: ' + manualCommands.cloudflare + '  |  ' + manualCommands.tailscale);
      return { started: false, reason: 'not-installed', message: reason, commands: manualCommands };
    }

    // Keep Tailscale Serve in the foreground so it belongs to this server lifecycle.
    // The documented --bg command is printed separately for users who want to manage it themselves.
    const args = selected.provider === 'cloudflare'
      ? ['tunnel', '--url', target].concat(secure ? ['--no-tls-verify'] : [])
      : ['serve', target];
    const command = selected.binary + ' ' + args.join(' ');
    log('[tunnel] Запускаю: ' + command);
    let child;
    try {
      child = childSpawn(selected.executable, args, {
        cwd: PROJECT_ROOT,
        env: tunnelEnv,
        windowsHide: true,
        shell: process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(selected.executable).toLowerCase()),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      const reason = 'Не удалось запустить ' + selected.binary + ': ' + (error && error.message || error) + '. ' + installHint(selected.provider);
      errorLog('[tunnel] ' + reason);
      return { started: false, reason: 'spawn-failed', message: reason };
    }
    activeTunnel = child;
    let output = '';
    let announcedUrl = '';
    const onOutput = (chunk) => {
      const textValue = String(chunk || '');
      output = (output + textValue).slice(-32768);
      const suffix = selected.provider === 'cloudflare' ? '.trycloudflare.com' : '.ts.net';
      const external = extractExternalUrl(textValue, suffix);
      if (external && external !== announcedUrl) {
        announcedUrl = external;
        log('[tunnel] Внешний HTTPS-адрес: ' + announcedUrl);
      }
      if (textValue.trim()) log('[' + selected.binary + '] ' + textValue.trim());
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onOutput);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', onOutput);
    if (selected.provider === 'tailscale') {
      const external = tailscaleUrl(selected.executable);
      if (external) {
        announcedUrl = external;
        log('[tunnel] Ожидаемый внешний HTTPS-адрес: ' + external);
      }
    }
    child.once('error', (error) => {
      if (activeTunnel === child) activeTunnel = null;
      if (stopping) return;
      const reason = 'Процесс ' + selected.binary + ' завершился с ошибкой: ' + (error && error.message || error) + '. ' + installHint(selected.provider);
      errorLog('[tunnel] ' + reason);
    });
    child.once('close', (code, signal) => {
      if (activeTunnel === child) activeTunnel = null;
      if (stopping) return;
      const details = 'Сервер продолжает работать только локально. ' + installHint(selected.provider);
      if (code === 0) log('[tunnel] ' + selected.binary + ' завершился; ' + details);
      else errorLog('[tunnel] ' + selected.binary + ' завершился (код ' + code + (signal ? ', сигнал ' + signal : '') + '). ' + details);
    });
    return { started: true, provider: selected.provider, command, target };
  }

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

  const server = (secure ? https : http).createServer(tlsOptions, (req, res) => {
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
        return res.end(decorateHtml(loginHtml(token)));
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
          const body = decorateHtml(loginHtml(cookies[CSRF_COOKIE], 'Неверный логин или пароль.'));
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
            if (request.method === 'HEAD') response.end();
            else response.end(ext === '.html' && insecureHttp ? Buffer.from(decorateHtml(buf.toString('utf8')), 'utf8') : buf);
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

    const tunnel = activeTunnel;
    activeTunnel = null;
    const stopTunnel = new Promise((resolve) => {
      if (!tunnel || typeof tunnel.kill !== 'function' ||
          (tunnel.exitCode !== null && tunnel.exitCode !== undefined) || tunnel.signalCode) return resolve();
      let timer;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      if (typeof tunnel.once === 'function') {
        tunnel.once('close', finish);
        tunnel.once('error', finish);
      }
      timer = setTimeout(() => {
        try { tunnel.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch (_) {}
        finish();
      }, 3000);
      try { if (tunnel.kill() === false) finish(); }
      catch (_) { finish(); }
    });
    const stopServer = new Promise((resolve) => {
      if (!server.listening) return resolve();
      let timer;
      server.close(() => { if (timer) clearTimeout(timer); resolve(); });
      timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        resolve();
      }, 5000);
      if (timer.unref) timer.unref();
    });
    return Promise.all([stopTunnel, stopServer]).then(() => {});
  }

  return { server, store, service, auth, backupManager, telegramNotifier, sseClients, mode, host, port, dataDir, allowFraming, sameSite, secure, insecureHttp, tunnelAutostart, tunnelProvider, startTunnel, listen, close, getClientIp: getIp };
}

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) for (const net of list || []) {
    if (!net.internal && net.family === 'IPv4') out.push(net.address);
  }
  return Array.from(new Set(out));
}

function printStartup(app, address, logger) {
  const log = logger && typeof logger.log === 'function' ? logger.log.bind(logger) : console.log.bind(console);
  const warn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn.bind(console);
  const actualPort = address.port;
  const scheme = app.secure ? 'https' : 'http';
  const local = scheme + '://127.0.0.1:' + actualPort;
  log('');
  log('WB Price Manager — веб-сервер');
  log('Режим доступа: ' + app.mode);
  log('Данные: ' + app.dataDir);
  log('Локальный адрес: ' + local);
  if (app.mode === 'tunnel') {
    log('Сервер слушает только 127.0.0.1; наружу порт не пробрасывается.');
    log('Команда для ручного Cloudflare Tunnel: cloudflared tunnel --url ' + local + (app.secure ? ' --no-tls-verify' : ''));
    log('Ожидаемый адрес Cloudflare: https://<случайное-имя>.trycloudflare.com (фактический URL появится в выводе cloudflared).');
    log('Команда для ручного Tailscale Serve: tailscale serve --bg ' + local);
    log('Ожидаемый адрес Tailscale: https://<устройство>.<tailnet>.ts.net (точный адрес: tailscale serve status).');
    log('Автозапуск туннеля: ' + (app.tunnelAutostart && app.tunnelProvider !== 'off' ? 'включён, провайдер ' + app.tunnelProvider : 'выключен; используйте команду выше вручную'));
  } else if (app.mode === 'local') {
    log('LAN-адреса не слушаются: сервер принимает соединения только с этого компьютера.');
  } else {
    const addresses = localAddresses();
    log('Адреса интерфейсов LAN: ' + (addresses.length ? addresses.map((ip) => scheme + '://' + ip + ':' + actualPort).join(', ') : 'не найдены'));
  }
  log('Логин: ' + (app.auth.state.user || 'admin'));
  if (app.auth.generatedPassword) log('Сгенерированный пароль (сохраните сейчас): ' + app.auth.generatedPassword);
  if (app.sameSite === 'none') {
    warn('ВНИМАНИЕ: --samesite none разрешает отправлять cookie с чужих сайтов (нужно для iframe-портала). Требуется HTTPS на внешнем адресе.');
  }
  if (app.allowFraming) warn('ВНИМАНИЕ: --allow-framing разрешает встраивать страницу в iframe на любом сайте. Защита от кликджекинга отключена — используйте только для доверенного портала.');
  if (app.mode === 'internet') warn('ВНИМАНИЕ: режим internet слушает внешний интерфейс. Используйте только с HTTPS, надёжным паролем и без проброса незашифрованного порта.');
  if (app.insecureHttp) warn('ОПАСНО: HTTP без TLS включён флагом --insecure-i-know. На каждой HTML-странице показывается предупреждение; не используйте в публичной сети.');
  else if (app.mode === 'lan' && !app.secure) warn('ВНИМАНИЕ: HTTP в LAN не шифрует трафик. Для недоверенной сети настройте локальный сертификат.');
  if (app.mode === 'lan' && !app.secure) {
    log('HTTPS в LAN: mkcert -install; mkcert -cert-file lan.crt -key-file lan.key localhost 127.0.0.1 <IP-LAN>, затем задайте WB_WEB_CERT=lan.crt и WB_WEB_KEY=lan.key.');
  }
  if (app.mode === 'internet' && app.secure) {
    log('HTTPS активен на сервере; сертификат и ключ заданы через --cert/--key (или WB_WEB_CERT/WB_WEB_KEY).');
  }
  log('');
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
  if (app.mode === 'tunnel') app.startTunnel(address.port);
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

module.exports = { createWebServer, parseArgs, printStartup, findExecutable, isPrivateIp, getClientIp, makeCsp, MAX_BODY_BYTES, MAX_INVOKE_BODY_BYTES, SSE_MAX };
