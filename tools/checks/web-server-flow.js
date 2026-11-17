'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { createWebServer, getClientIp, parseArgs, printStartup } = require('../web-server');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('OK   ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function request(port, method, route, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: route,
      headers: Object.assign({}, o.headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

function cookiesFrom(response) {
  const out = {};
  for (const item of response.headers['set-cookie'] || []) {
    const pair = item.split(';')[0];
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}
function cookieHeader(cookies) { return Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; '); }
function form(values) { return new URLSearchParams(values).toString(); }

async function loginCookie(port, testIp) {
  const extra = testIp ? { 'x-test-client-ip': testIp } : {};
  const page = await request(port, 'GET', '/login', { headers: extra });
  const cookie = cookiesFrom(page);
  const match = page.body.match(/name="csrf" value="([^"]+)"/);
  return { cookies: cookie, csrf: match && match[1], extra };
}

async function postLogin(port, state, user, password) {
  return request(port, 'POST', '/login', {
    headers: Object.assign({
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(state.cookies)
    }, state.extra || {}),
    body: form({ user, pass: password, csrf: state.csrf })
  });
}

function invokeApi(port, cookies, csrf, channel, args) {
  return request(port, 'POST', '/api/invoke', {
    headers: { Cookie: cookieHeader(cookies), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ channel, args: args || [] })
  });
}

function fakeTunnelChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('close', 0, 'SIGTERM'); };
  return child;
}

function streamEvents(port, cookies) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookieHeader(cookies) } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); return reject(new Error('SSE returned ' + res.statusCode));
      }
      let buffer = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE event timeout')); }, 5000);
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('event: svc:log\n') && buffer.includes('Черновик цен сохранён')) {
          clearTimeout(timer); req.destroy(); resolve(true);
        }
      });
      res.on('error', (err) => { if (err.code !== 'ECONNRESET') { clearTimeout(timer); reject(err); } });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

async function main() {
  const dataDir = path.join(__dirname, '..', '..', '.data-test-web-server-flow');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const defaultArgs = parseArgs([], {});
  check('режим по умолчанию — tunnel, автозапуск туннеля включён', defaultArgs.mode === 'tunnel' && defaultArgs.tunnelAutostart === true);
  const newFlags = parseArgs(['--mode', 'tunnel', '--insecure-i-know', '--no-tunnel-autostart', '--tunnel-provider', 'tailscale'], {});
  check('parseArgs принимает режим tunnel, insecure-i-know, отключение автозапуска и провайдера',
    newFlags.mode === 'tunnel' && newFlags.insecureIKnow && !newFlags.tunnelAutostart && newFlags.tunnelProvider === 'tailscale');
  const providerAlias = parseArgs(['--tunnel-provider=cloudflared', '--tunnel-autostart=false'], {});
  check('parseArgs нормализует cloudflared и принимает булевы флаги через равно',
    providerAlias.tunnelProvider === 'cloudflare' && providerAlias.tunnelAutostart === false);

  const defaultTunnelDir = path.join(__dirname, '..', '..', '.data-test-web-tunnel-default');
  fs.rmSync(defaultTunnelDir, { recursive: true, force: true });
  const defaultTunnel = createWebServer({ port: 0, dataDir: defaultTunnelDir, host: '0.0.0.0', tunnelAutostart: false, user: 'tester', pass: 'correct horse battery staple', log: () => {}, errorLog: () => {} });
  try {
    const tunnelAddress = await defaultTunnel.listen();
    check('createWebServer по умолчанию слушает только 127.0.0.1 даже при host=0.0.0.0',
      defaultTunnel.mode === 'tunnel' && defaultTunnel.host === '127.0.0.1' && tunnelAddress.address === '127.0.0.1',
      JSON.stringify({ mode: defaultTunnel.mode, host: tunnelAddress.address }));
    const startupLines = [];
    printStartup(defaultTunnel, tunnelAddress, { log: (line) => startupLines.push(line), warn: (line) => startupLines.push(line) });
    const startupText = startupLines.join('\n');
    check('стартовый экран печатает команды и ожидаемые HTTPS-адреса обоих туннелей',
      startupText.includes('cloudflared tunnel --url http://127.0.0.1:') && startupText.includes('tailscale serve --bg http://127.0.0.1:') && startupText.includes('.trycloudflare.com') && startupText.includes('.<tailnet>.ts.net'));
  } finally {
    await defaultTunnel.close();
    fs.rmSync(defaultTunnelDir, { recursive: true, force: true });
  }

  const internetDeniedDir = path.join(__dirname, '..', '..', '.data-test-web-internet-denied');
  fs.rmSync(internetDeniedDir, { recursive: true, force: true });
  const denied = spawnSync(process.execPath, [path.join(__dirname, '..', 'web-server.js'), '--mode', 'internet', '--port', '0', '--data', internetDeniedDir], {
    cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
    env: Object.assign({}, process.env, { WB_WEB_CERT: '', WB_WEB_KEY: '' })
  });
  check('internet без сертификата и --insecure-i-know не стартует и печатает причину',
    denied.status !== 0 && /Режим internet требует HTTPS/.test(denied.stderr || '') && !fs.existsSync(internetDeniedDir),
    'exit=' + denied.status);

  const insecureDir = path.join(__dirname, '..', '..', '.data-test-web-insecure');
  fs.rmSync(insecureDir, { recursive: true, force: true });
  const insecureApp = createWebServer({ mode: 'internet', insecureIKnow: true, host: '127.0.0.1', port: 0, dataDir: insecureDir, user: 'tester', pass: 'correct horse battery staple', log: () => {}, errorLog: () => {} });
  try {
    const insecurePort = (await insecureApp.listen()).port;
    const insecureLoginPage = await request(insecurePort, 'GET', '/login');
    check('--insecure-i-know запускает HTTP и предупреждение видно на странице входа',
      insecureApp.insecureHttp && insecureLoginPage.status === 200 && insecureLoginPage.body.includes('ВНИМАНИЕ: интернет-доступ работает по HTTP без TLS'));
    const insecureLogin = await loginCookie(insecurePort);
    const insecureGood = await postLogin(insecurePort, insecureLogin, 'tester', 'correct horse battery staple');
    const insecureCookies = Object.assign({}, insecureLogin.cookies, cookiesFrom(insecureGood));
    const insecureMainPage = await request(insecurePort, 'GET', '/', { headers: { Cookie: cookieHeader(insecureCookies) } });
    check('--insecure-i-know показывает предупреждение и на авторизованной HTML-странице',
      insecureMainPage.status === 200 && insecureMainPage.body.includes('ВНИМАНИЕ: интернет-доступ работает по HTTP без TLS'));
  } finally {
    await insecureApp.close();
    fs.rmSync(insecureDir, { recursive: true, force: true });
  }

  const noTunnelDir = path.join(__dirname, '..', '..', '.data-test-web-no-tunnel-binary');
  fs.rmSync(noTunnelDir, { recursive: true, force: true });
  const noTunnelLines = [];
  const noTunnel = createWebServer({ mode: 'tunnel', port: 0, dataDir: noTunnelDir, tunnelAutostart: true, tunnelProvider: 'auto', env: { PATH: '' }, findExecutable: () => null, log: (line) => noTunnelLines.push(line), errorLog: () => {} });
  try {
    const noTunnelAddress = await noTunnel.listen();
    const noTunnelResult = noTunnel.startTunnel(noTunnelAddress.port);
    check('без cloudflared и tailscale туннель честно сообщает установку и сервер продолжает работать',
      noTunnelResult.reason === 'not-installed' && noTunnel.server.listening && noTunnelLines.some((line) => line.includes('не найден(ы) в PATH')) && noTunnelLines.some((line) => line.includes('tailscale.com/download')));
  } finally {
    await noTunnel.close();
    fs.rmSync(noTunnelDir, { recursive: true, force: true });
  }

  const autoTunnelDir = path.join(__dirname, '..', '..', '.data-test-web-tunnel-autostart');
  fs.rmSync(autoTunnelDir, { recursive: true, force: true });
  const fakeChild = fakeTunnelChild();
  const tunnelCalls = [];
  const tunnelLines = [];
  const autoTunnel = createWebServer({
    mode: 'tunnel', port: 0, dataDir: autoTunnelDir, tunnelAutostart: true, tunnelProvider: 'cloudflare', env: { PATH: '' },
    findExecutable: (name) => name === 'cloudflared' ? '/fake/bin/cloudflared' : null,
    spawn: (executable, args) => { tunnelCalls.push({ executable, args }); return fakeChild; },
    log: (line) => tunnelLines.push(line), errorLog: (line) => tunnelLines.push(line)
  });
  try {
    const autoResult = autoTunnel.startTunnel(18765);
    fakeChild.stdout.emit('data', Buffer.from('Quick Tunnel: https://sample-name.trycloudflare.com\n'));
    check('найденный cloudflared автоматически запускается с loopback-адресом',
      autoResult.started && autoResult.provider === 'cloudflare' && tunnelCalls.length === 1 && tunnelCalls[0].args.join(' ') === 'tunnel --url http://127.0.0.1:18765');
    check('URL Cloudflare Tunnel печатается после появления в выводе процесса', tunnelLines.some((line) => line.includes('https://sample-name.trycloudflare.com')));
  } finally {
    await autoTunnel.close();
    check('закрытие веб-сервера завершает процесс Cloudflare Tunnel', fakeChild.killed);
    fs.rmSync(autoTunnelDir, { recursive: true, force: true });
  }

  const tailscaleDir = path.join(__dirname, '..', '..', '.data-test-web-tailscale-autostart');
  fs.rmSync(tailscaleDir, { recursive: true, force: true });
  const tailscaleChild = fakeTunnelChild();
  const tailscaleCalls = [];
  const tailscaleLines = [];
  const autoTailscale = createWebServer({
    mode: 'tunnel', port: 0, dataDir: tailscaleDir, tunnelAutostart: true, tunnelProvider: 'tailscale', env: { PATH: '' },
    findExecutable: (name) => name === 'tailscale' ? '/fake/bin/tailscale' : null,
    spawn: (executable, args) => { tailscaleCalls.push({ executable, args }); return tailscaleChild; },
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({ Self: { DNSName: 'wb-machine.tailnet.ts.net.' } }) }),
    log: (line) => tailscaleLines.push(line), errorLog: (line) => tailscaleLines.push(line)
  });
  try {
    const tailscaleResult = autoTailscale.startTunnel(18766);
    check('найденный tailscale автоматически настраивает Serve на loopback',
      tailscaleResult.started && tailscaleResult.provider === 'tailscale' && tailscaleCalls.length === 1 && tailscaleCalls[0].args.join(' ') === 'serve http://127.0.0.1:18766');
    check('адрес Tailscale Serve выводится из состояния устройства',
      tailscaleLines.some((line) => line.includes('https://wb-machine.tailnet.ts.net')));
  } finally {
    await autoTailscale.close();
    check('закрытие веб-сервера завершает foreground-процесс Tailscale Serve', tailscaleChild.killed);
    fs.rmSync(tailscaleDir, { recursive: true, force: true });
  }

  const telegramCalls = [];
  const app = createWebServer({
    mode: 'lan', port: 0, dataDir, user: 'tester', pass: 'correct horse battery staple',
    getClientIp: (req) => req.headers['x-test-client-ip'] || getClientIp(req),
    fetch: async (url, init) => {
      telegramCalls.push({ url: String(url), init: init || {} });
      return { ok: true, status: 200, json: async () => String(url).endsWith('/getMe')
        ? { ok: true, result: { id: 123, username: 'web_test_bot' } }
        : { ok: true, result: { message_id: telegramCalls.length } } };
    },
    log: () => {}, errorLog: (line) => console.error(line)
  });
  let port;
  try {
    const address = await app.listen();
    port = address.port;

    const unauth = await request(port, 'POST', '/api/invoke', {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'app:state', args: [] })
    });
    check('API invoke без сессии возвращает 401', unauth.status === 401, 'status=' + unauth.status);

    const brute = await loginCookie(port, '127.0.0.2');
    const firstBad = await postLogin(port, brute, 'tester', 'wrong-password');
    check('неверный пароль возвращает 401', firstBad.status === 401, 'status=' + firstBad.status);
    let fifth;
    for (let i = 1; i < 5; i++) fifth = await postLogin(port, brute, 'tester', 'wrong-password');
    check('после пяти неудачных попыток возвращается 429 с Retry-After', fifth && fifth.status === 429 && Number(fifth.headers['retry-after']) > 0,
      'status=' + (fifth && fifth.status) + ', Retry-After=' + (fifth && fifth.headers['retry-after']));

    const login = await loginCookie(port);
    const good = await postLogin(port, login, 'tester', 'correct horse battery staple');
    const sessionCookies = Object.assign({}, login.cookies, cookiesFrom(good));
    check('успешный вход выдаёт HttpOnly session cookie', good.status === 303 && !!sessionCookies.wb_web_session && /HttpOnly/i.test((good.headers['set-cookie'] || []).join(';')),
      'status=' + good.status);
    check('CSRF cookie выдаётся без HttpOnly', (good.headers['set-cookie'] || []).some((x) => /wb_web_csrf=/.test(x) && !/HttpOnly/i.test(x)));
    const sessionSetCookie = (good.headers['set-cookie'] || []).find((x) => x.indexOf('wb_web_session=') === 0) || '';
    check('cookie сессии по умолчанию SameSite=Lax и живёт 12 часов',
      /SameSite=Lax/.test(sessionSetCookie) && /Max-Age=43200/.test(sessionSetCookie) && !/Secure/i.test(sessionSetCookie),
      sessionSetCookie.split(';').slice(1).join(';').trim());

    const page = await request(port, 'GET', '/', { headers: { Cookie: cookieHeader(sessionCookies) } });
    check('статика отдаётся с активной сессией', page.status === 200 && /WB Price Manager/.test(page.body), 'status=' + page.status);
    check('HTML имеет no-cache и security headers', page.headers['cache-control'] === 'no-cache' && page.headers['x-content-type-options'] === 'nosniff' && page.headers['x-frame-options'] === 'DENY');

    const csrf = sessionCookies.wb_web_csrf;
    const stateResponse = await request(port, 'POST', '/api/invoke', {
      headers: { Cookie: cookieHeader(sessionCookies), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ channel: 'app:state', args: [] })
    });
    let stateData = {};
    try { stateData = JSON.parse(stateResponse.body).data || {}; } catch (_) {}
    check('app:state с сессией возвращает 200 и demo:true', stateResponse.status === 200 && stateData.demo === true,
      'status=' + stateResponse.status + ', demo=' + stateData.demo);

    const backupResponse = await invokeApi(port, sessionCookies, csrf, 'backup:list');
    const backupEnvelope = JSON.parse(backupResponse.body);
    check('backup:list доступен через авторизованный веб IPC', backupResponse.status === 200 && backupEnvelope.ok === true && Array.isArray(backupEnvelope.data.backups));
    const exportResponse = await invokeApi(port, sessionCookies, csrf, 'backup:export');
    const exportEnvelope = JSON.parse(exportResponse.body);
    check('backup:export возвращает .wbpm.json в веб-версии', exportResponse.status === 200 && exportEnvelope.ok === true && exportEnvelope.data.fileName.endsWith('.wbpm.json') && JSON.parse(exportEnvelope.data.content).format === 'wb-price-manager-backup');

    const webToken = '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn654321';
    const saveNotify = await invokeApi(port, sessionCookies, csrf, 'notify:save', [{ token: webToken, chatId: '123456789', events: { sendSuccess: true } }]);
    const notifySaved = JSON.parse(saveNotify.body);
    const notifyRead = JSON.parse((await invokeApi(port, sessionCookies, csrf, 'notify:get')).body);
    check('notify:save и notify:get работают в веб-версии, не раскрывая токен', saveNotify.status === 200 && notifySaved.ok && notifySaved.data.tokenSaved && notifyRead.ok && notifyRead.data.tokenSaved && !JSON.stringify(notifyRead).includes(webToken));
    const webTest = JSON.parse((await invokeApi(port, sessionCookies, csrf, 'notify:test')).body);
    check('notify:test вызывает getMe и sendMessage через веб fetch', webTest.ok && webTest.data.ok && telegramCalls.length === 2 && telegramCalls[0].url.endsWith('/getMe') && telegramCalls[1].url.endsWith('/sendMessage'));
    check('веб-хранилище также отделяет Telegram-токен от settings.json', !fs.readFileSync(app.store.paths.settingsPath, 'utf8').includes(webToken) && app.store.loadSecrets().telegramBotToken === webToken);

    const noCsrf = await request(port, 'POST', '/api/invoke', {
      headers: { Cookie: cookieHeader(sessionCookies), 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'app:state', args: [] })
    });
    check('POST без X-CSRF-Token возвращает 403', noCsrf.status === 403, 'status=' + noCsrf.status);

    const outside = await request(port, 'POST', '/api/invoke', {
      headers: { 'x-test-client-ip': '8.8.8.8', Cookie: cookieHeader(sessionCookies), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ channel: 'app:state', args: [] })
    });
    check('в режиме lan IP вне приватных диапазонов получает 403', outside.status === 403, 'status=' + outside.status);

    const eventPromise = streamEvents(port, sessionCookies);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const invoke = await request(port, 'POST', '/api/invoke', {
      headers: { Cookie: cookieHeader(sessionCookies), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ channel: 'prices:draft-save', args: [{ items: { '123456': { basePrice: 100, discount: 5 } } }] })
    });
    check('вызов сервиса принят для SSE-проверки', invoke.status === 200 && JSON.parse(invoke.body).ok === true, 'status=' + invoke.status);
    check('SSE доставляет событие svc:log', await eventPromise);

    // защита от кликджекинга: по умолчанию встраивание в iframe запрещено,
    // а --allow-framing снимает запрет (нужно для доверенного портала/предпросмотра)
    const framed = await request(port, 'GET', '/', { headers: { Cookie: cookieHeader(sessionCookies) } });
    check('по умолчанию страница запрещает встраивание в iframe',
      framed.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(framed.headers['content-security-policy'] || ''),
      'X-Frame-Options=' + framed.headers['x-frame-options']);

    const openApp = createWebServer({
      mode: 'local', port: 0, dataDir, user: 'tester', pass: 'correct horse battery staple',
      allowFraming: true, sameSite: 'none', log: () => {}, errorLog: () => {}
    });
    try {
      const openPort = (await openApp.listen()).port;
      const openLogin = await loginCookie(openPort);
      const openGood = await postLogin(openPort, openLogin, 'tester', 'correct horse battery staple');
      const openCookies = Object.assign({}, openLogin.cookies, cookiesFrom(openGood));
      const openPage = await request(openPort, 'GET', '/', { headers: { Cookie: cookieHeader(openCookies) } });
      check('--allow-framing снимает запрет встраивания (и только его)',
        openPage.status === 200 && openPage.headers['x-frame-options'] === undefined &&
          /frame-ancestors \*/.test(openPage.headers['content-security-policy'] || '') &&
          openPage.headers['x-content-type-options'] === 'nosniff',
        'X-Frame-Options=' + (openPage.headers['x-frame-options'] || 'нет'));
      // SameSite=None нужен, когда страницу встраивают в iframe на чужом сайте:
      // без него браузер не отправит cookie и вход закольцуется на /login
      const openSetCookie = (openGood.headers['set-cookie'] || []).find((x) => x.indexOf('wb_web_session=') === 0) || '';
      check('--samesite none добавляет SameSite=None и обязательный Secure',
        /SameSite=None/.test(openSetCookie) && /Secure/i.test(openSetCookie),
        openSetCookie.split(';').slice(1).join(';').trim());
      const openArgs = require('../web-server').parseArgs(['--mode', 'internet', '--allow-framing', '--samesite', 'none', '--port', '9001'], {});
      check('флаг --allow-framing не «съедает» следующий аргумент',
        openArgs.allowFraming === true && openArgs.port === 9001 && openArgs.mode === 'internet' && openArgs.sameSite === 'none',
        JSON.stringify({ flag: openArgs.allowFraming, samesite: openArgs.sameSite, port: openArgs.port }));
    } finally {
      await openApp.close();
    }

    check('классификатор IP принимает приватные сети и отвергает публичный IPv4/IPv6',
      ['10.2.3.4', '172.20.1.1', '192.168.1.2', '127.1.2.3', 'fd12::1', '::ffff:127.0.0.1'].every(require('../web-server').isPrivateIp) &&
      !require('../web-server').isPrivateIp('8.8.8.8') && !require('../web-server').isPrivateIp('2001:4860:4860::8888'));
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('\nВсего проверок: ' + (pass + fail) + ' / пройдено: ' + pass + ' / провалено: ' + fail);
  if (failures.length) console.log('Провалы:\n- ' + failures.join('\n- '));
  else console.log('ИТОГ: ВСЁ ЗЕЛЁНОЕ');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  console.log('\nВсего проверок: ' + (pass + fail) + ' / пройдено: ' + pass + ' / провалено: ' + fail);
  process.exit(1);
});
