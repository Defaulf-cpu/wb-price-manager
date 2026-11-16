'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createWebServer, getClientIp } = require('../web-server');

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
  const app = createWebServer({
    mode: 'lan', port: 0, dataDir, user: 'tester', pass: 'correct horse battery staple',
    getClientIp: (req) => req.headers['x-test-client-ip'] || getClientIp(req),
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
