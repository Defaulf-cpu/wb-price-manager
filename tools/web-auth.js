'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const SESSION_COOKIE = 'wb_web_session';
const CSRF_COOKIE = 'wb_web_csrf';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

class WebAuth {
  constructor(dataDir, options) {
    this.file = path.join(dataDir, 'web-sessions.json');
    this.secure = !!(options && options.secure);
    // SameSite=None — только по явному запросу: нужен, когда страницу встраивают в iframe
    // на чужом сайте (такие запросы браузер считает сторонними и Lax-cookie не отправляет).
    this.sameSite = String((options && options.sameSite) || '').toLowerCase() === 'none' ? 'None' : 'Lax';
    this.failures = new Map();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this._load();

    const requestedUser = options && options.user ? String(options.user) : 'admin';
    let requestedPass = options && options.pass ? String(options.pass) : '';
    if (!requestedPass && this.state.password && !this.state.password.generated) {
      requestedPass = '';
    }

    const oldUser = this.state.user || 'admin';
    const userChanged = requestedUser !== oldUser;
    if (requestedPass) {
      const salt = crypto.randomBytes(16);
      const hash = hashPassword(requestedPass, salt);
      const samePassword = this.state.password && this.state.password.salt &&
        safeEqual(hashPassword(requestedPass, Buffer.from(this.state.password.salt, 'hex')), Buffer.from(this.state.password.hash, 'hex'));
      if (!samePassword || userChanged) {
        this.state.password = { salt: salt.toString('hex'), hash: hash.toString('hex'), generated: false };
        this.state.sessions = {};
      }
      this.state.user = requestedUser;
    } else if (!this.state.password || !this.state.password.salt || !this.state.password.hash) {
      requestedPass = b64url(crypto.randomBytes(24));
      const salt = crypto.randomBytes(16);
      this.state.password = { salt: salt.toString('hex'), hash: hashPassword(requestedPass, salt).toString('hex'), generated: true };
      this.state.user = requestedUser;
      this.generatedPassword = requestedPass;
    } else if (userChanged) {
      this.state.user = requestedUser;
      this.state.sessions = {};
    }

    if (!this.state.secret || !/^[a-f0-9]{64}$/i.test(this.state.secret)) this.state.secret = crypto.randomBytes(32).toString('hex');
    if (!this.state.sessions || typeof this.state.sessions !== 'object' || Array.isArray(this.state.sessions)) this.state.sessions = {};
    this._purgeSessions();
    this._save();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid session store');
      return parsed;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
        console.error('[web-auth] Повреждён файл сессий; создан новый ключ подписи, старые сессии отозваны.');
      }
      return { version: 1, secret: crypto.randomBytes(32).toString('hex'), user: 'admin', password: null, sessions: {} };
    }
  }

  _save() {
    this.state.version = 1;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_) {}
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_) {}
  }

  _purgeSessions() {
    const now = Date.now();
    for (const [id, session] of Object.entries(this.state.sessions || {})) {
      if (!session || Number(session.expiresAt) <= now || !session.csrf) delete this.state.sessions[id];
    }
  }

  _signature(id) {
    return b64url(crypto.createHmac('sha256', Buffer.from(this.state.secret, 'hex')).update(id).digest());
  }

  sessionCookieValue(id) { return this._signature(id); }

  cookieHeader(name, value, opts) {
    const o = opts || {};
    const none = this.sameSite === 'None';
    const bits = [name + '=' + value, 'Path=/', 'SameSite=' + (none ? 'None' : 'Lax')];
    if (o.httpOnly) bits.push('HttpOnly');
    if (o.maxAge !== undefined) bits.push('Max-Age=' + Math.max(0, Math.floor(o.maxAge)));
    // без Secure браузер cookie с SameSite=None просто отбросит
    if (this.secure || none) bits.push('Secure');
    return bits.join('; ');
  }

  clearCookies() {
    return [
      this.cookieHeader(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }),
      this.cookieHeader(CSRF_COOKIE, '', { maxAge: 0 })
    ];
  }

  loginCsrfCookie() { return this.cookieHeader(CSRF_COOKIE, b64url(crypto.randomBytes(24)), { maxAge: 900 }); }

  getCookies(req) { return parseCookies(req.headers.cookie); }

  getSession(req) {
    const cookies = this.getCookies(req);
    const token = cookies[SESSION_COOKIE] || '';
    if (!token) return null;
    const session = this.state.sessions[token];
    if (!session || Number(session.expiresAt) <= Date.now() || !session.id || !safeEqual(token, this._signature(session.id))) return null;
    return { id: token, session, cookies };
  }

  checkCsrf(req, suppliedToken, currentSession) {
    const cookies = currentSession ? currentSession.cookies : this.getCookies(req);
    const cookieToken = cookies[CSRF_COOKIE] || '';
    if (!cookieToken || !suppliedToken || !safeEqual(cookieToken, suppliedToken)) return false;
    if (currentSession) return safeEqual(cookieToken, currentSession.session.csrf);
    return true;
  }

  checkLoginRate(ip) {
    const now = Date.now();
    const record = this.failures.get(ip);
    if (!record) return { limited: false, retryAfter: 0 };
    record.times = record.times.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (!record.times.length) { this.failures.delete(ip); return { limited: false, retryAfter: 0 }; }
    if (record.times.length >= MAX_LOGIN_FAILURES) {
      return { limited: true, retryAfter: Math.max(1, Math.ceil((record.times[0] + LOGIN_WINDOW_MS - now) / 1000)) };
    }
    return { limited: false, retryAfter: 0 };
  }

  recordLoginFailure(ip) {
    const now = Date.now();
    let record = this.failures.get(ip);
    if (!record) { record = { times: [] }; this.failures.set(ip, record); }
    record.times = record.times.filter((t) => now - t < LOGIN_WINDOW_MS);
    record.times.push(now);
  }

  async authenticate(user, pass, ip) {
    const rate = this.checkLoginRate(ip);
    if (rate.limited) return { ok: false, limited: true, retryAfter: rate.retryAfter };
    const pw = this.state.password;
    let valid = false;
    try {
      const candidate = hashPassword(String(pass || ''), Buffer.from(pw.salt, 'hex'));
      valid = safeEqual(String(user || ''), this.state.user) && safeEqual(candidate, Buffer.from(pw.hash, 'hex'));
    } catch (_) { valid = false; }
    if (!valid) {
      this.recordLoginFailure(ip);
      const next = this.checkLoginRate(ip);
      return { ok: false, limited: next.limited, retryAfter: next.retryAfter };
    }
    this.failures.delete(ip);
    const id = b64url(crypto.randomBytes(32));
    const cookie = this.sessionCookieValue(id);
    const csrf = b64url(crypto.randomBytes(24));
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.state.sessions[cookie] = { id, csrf, createdAt: Date.now(), expiresAt };
    this._save();
    return { ok: true, id, csrf, expiresAt, cookie };
  }

  revoke(req) {
    const current = this.getSession(req);
    if (!current) return false;
    delete this.state.sessions[current.id];
    this._save();
    return true;
  }
}

module.exports = {
  WebAuth, SESSION_TTL_MS, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES,
  SESSION_COOKIE, CSRF_COOKIE, parseCookies, safeEqual
};
