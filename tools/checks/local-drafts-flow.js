'use strict';

/** Явное сохранение: ввод только в памяти; API вызывается лишь по кнопке «Сохранить». */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
let pass = 0, fail = 0;
const windows = [];
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));
async function check(name, fn) { try { await fn(); pass++; console.log('OK   черновики: ' + name); } catch (e) { fail++; console.error('FAIL черновики: ' + name + ' — ' + e.stack); } }
function create(storage = {}) {
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<body><main></main><div id="modal-root"></div><div id="toast-root"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc });
  const w = dom.window, doc = w.document, calls = [], saved = { costs: {}, settings: {}, drafts: {}, configs: {}, competitors: {} };
  windows.push(w);
  Object.entries(storage).forEach(([key, value]) => w.localStorage.setItem(key, value));
  let profile = 'default', epoch = 1, context = 'context-A', intercept = null;
  w.Views = { repricer: { results: [], pendingEdits: new Map(), invalidLocalInput: () => null } };
  w.S = { state: { dataContext: context, priceEdits: new Map(), settings: {} }, invalidate() {}, reloadOverrides: async () => {}, loadDrafts: async () => { w.S.state.priceDrafts = plain(saved.drafts); } };
  w.API = { activeProfileId: () => profile, generation: () => epoch, async invoke(channel, payload = {}) {
    calls.push({ channel, payload: plain(payload) });
    if (intercept) await intercept(channel, payload);
    if (channel === 'costs:get') return { items: plain(saved.costs) };
    if (channel === 'settings:save') { Object.assign(saved.settings, plain(payload)); return plain(saved.settings); }
    const target = { 'costs:save': saved.costs, 'prices:draft-save': saved.drafts, 'repricer:item-configs:save': saved.configs, 'repricer:competitors:save': saved.competitors }[channel];
    if (target) for (const [key, value] of Object.entries(payload.items || {})) target[key] = value === null ? null : { ...target[key], ...plain(value) };
    return { ok: true };
  } };
  for (const name of ['util.js', 'ui.js', 'local-drafts.js']) w.eval(fs.readFileSync(path.join(__dirname, '../../src/renderer/js', name), 'utf8'));
  const send = (el, value, event = 'input') => { el.value = String(value); el.dispatchEvent(new w.Event(event, { bubbles: true })); };
  const form = (id, initial = 2, root) => {
    const host = doc.createElement('div'); host.innerHTML = `<input id="a" type="number" min="0" step="any" value="${initial}"><input id="b" type="number" min="0" step="any" value="5">`;
    (root || doc.querySelector('main')).appendChild(host);
    const binding = w.LocalDrafts.bind(host, id, () => [{ channel: 'costs:save', payload: { items: { 11: { otherRub: Number(host.querySelector('#a').value), otherPct: Number(host.querySelector('#b').value) } } } }]);
    return { host, binding, a: host.querySelector('#a'), b: host.querySelector('#b') };
  };
  return { w, doc, calls, saved, errors, send, form, setIntercept: (fn) => { intercept = fn; }, switch: (id, ctx) => { profile = id; context = ctx; epoch++; w.S.state.dataContext = ctx; } };
}
async function main() {
  await check('allowlist запрещает отправку WB, секреты, прототипы и не-JSON значения', async () => {
    const { w } = create(), q = w.LocalDrafts;
    const op = (channel, payload) => [{ channel, payload }];
    for (const [channel, payload] of [['wb:apply-prices', { items: {} }], ['keys:set', { single: 'secret' }], ['settings:save', { demoMode: false }], ['repricer:save', { enabled: true, secret: 'x' }], ['repricer:item-configs:save', { items: { 11: { boost: { token: 'x' } } } }]]) assert.throws(() => q.validateOperations(op(channel, payload)));
    for (const bad of [NaN, Infinity, () => {}, Symbol('x'), new Date(), Object.assign(Object.create({ inherited: true }), { otherRub: 2 }), JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(() => q.validateOperations(op('costs:save', { items: { 11: bad } })));
    assert.doesNotThrow(() => q.validateOperations(op('costs:save', { items: { 11: { otherPct: 2, otherRub: 3, currency: 'CNY', costEntered: 40 } } })));
    assert.equal({}.polluted, undefined);
  });
  await check('ввод не вызывает API и не пишет localStorage; сохраняет только явный commit', async () => {
    const c = create(), f = c.form('cost-form'); c.send(f.a, 7);
    assert.equal(c.calls.length, 0); assert.equal(c.w.localStorage.length, 0); assert.equal(c.w.LocalDrafts.pending(), 1);
    assert.match(f.binding.status.textContent, /Не сохранено/);
    assert.equal(await c.w.LocalDrafts.commit({ scope: f.host, report: true }), true);
    const writes = c.calls.filter((x) => x.channel === 'costs:save'); assert.deepEqual(writes.map((x) => x.payload), [{ items: { 11: { otherRub: 7 } } }]);
    assert.match(f.binding.status.textContent, /Сохранено локально/); assert.equal(c.w.LocalDrafts.pending(), 0);
  });
  await check('правка во время in-flight явного сохранения не стирается ответом', async () => {
    const c = create(), f = c.form('racing'); let release, entered;
    const firstStarted = new Promise((resolve) => { entered = resolve; }); let n = 0;
    c.setIntercept(async (channel) => { if (channel === 'costs:save' && ++n === 1) { entered(); await new Promise((resolve) => { release = resolve; }); } });
    c.send(f.a, 10); const saving = c.w.LocalDrafts.commit({ scope: f.host }); await firstStarted;
    c.send(f.a, 12); c.send(f.b, 8); release(); assert.equal(await saving, true);
    assert.equal(c.saved.costs['11'].otherRub, 12); assert.equal(c.saved.costs['11'].otherPct, 8); assert.equal(c.w.LocalDrafts.pending(), 0);
    assert.equal(c.calls.filter((r) => r.channel === 'costs:save').length, 2);
  });
  await check('ошибка явного сохранения оставляет черновик только в памяти', async () => {
    const c = create(), f = c.form('retry'); c.setIntercept(async (channel) => { if (channel === 'costs:save') throw new Error('Синтетический отказ диска'); }); c.send(f.a, 15);
    assert.equal(await c.w.LocalDrafts.commit({ scope: f.host }), false); assert.equal(c.w.LocalDrafts.pending(), 1);
    assert.equal(c.w.localStorage.length, 0); assert.match(c.doc.querySelector('#local-draft-banner').textContent, /отказ диска/);
    c.setIntercept(null); assert.equal(await c.w.LocalDrafts.commit({ scope: f.host }), true); assert.equal(c.saved.costs['11'].otherRub, 15);
  });
  await check('закрытие модалки не сохраняет: только записывает черновик в память', async () => {
    const c = create(), box = c.doc.createElement('div'), modal = c.w.UI.modal({ title: 'Цена', content: box }), f = c.form('close-form', 2, box);
    c.send(f.a, -1); assert.equal(await modal.close(), false); assert.equal(modal.root.isConnected, true); assert.equal(c.calls.length, 0);
    c.send(f.a, 18); assert.equal(await modal.close(), true); assert.equal(modal.root.isConnected, false); assert.equal(c.calls.length, 0); assert.equal(c.w.LocalDrafts.pending(), 1);
    assert.equal(await c.w.LocalDrafts.commit({ id: 'close-form' }), true); assert.equal(c.saved.costs['11'].otherRub, 18);
  });
  await check('async confirmDialog ждёт callback, false/exception не закрывают окно', async () => {
    const c = create(); let release;
    const modal = c.w.UI.confirmDialog('Подтвердить', 'Тест', async () => { await new Promise((resolve) => { release = resolve; }); return false; });
    const button = modal.foot.querySelector('.btn-primary'), promise = button.onclick(); await sleep(); assert.equal(modal.root.isConnected, true); assert.equal(button.disabled, true); release(); await promise;
    assert.equal(modal.root.isConnected, true); assert.equal(button.disabled, false);
    const rejected = c.w.UI.confirmDialog('Ошибка', 'Тест', async () => { throw new Error('Нет'); }); await rejected.foot.querySelector('.btn-primary').onclick(); assert.equal(rejected.root.isConnected, true);
  });
  await check('Escape закрывает только верхнее из вложенных окон', async () => {
    const c = create(), a = c.w.UI.modal({ title: 'Родитель' }), b = c.w.UI.modal({ title: 'Дочернее' }); c.doc.dispatchEvent(new c.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep();
    assert.equal(b.root.isConnected, false); assert.equal(a.root.isConnected, true);
  });
  await check('перепривязка одного host не оставляет дублирующие обработчики старой формы', async () => {
    const c = create(), f = c.form('rebinding'); c.send(f.a, 3); assert.equal(await c.w.LocalDrafts.commit({ scope: f.host }), true); f.host.innerHTML = '<input id="x" type="number" value="2">';
    c.w.LocalDrafts.bind(f.host, 'rebinding', () => [{ channel: 'costs:save', payload: { items: { 11: { otherRub: Number(f.host.querySelector('#x').value) } } } }]);
    c.send(f.host.querySelector('#x'), 21); assert.equal(c.calls.filter((r) => r.channel === 'costs:save').length, 1); assert.equal(await c.w.LocalDrafts.commit({ scope: f.host }), true); assert.equal(c.calls.filter((r) => r.channel === 'costs:save').length, 2); assert.equal(c.saved.costs['11'].otherRub, 21);
  });
  await check('включение автоматики не применяется без явного подтверждения в баннере', async () => {
    const c = create(); c.w.LocalDrafts.stage('auto', [{ channel: 'repricer:save', payload: { enabled: true, schedule: { autoSend: true } } }]);
    assert.equal(await c.w.LocalDrafts.commit(), false); assert.equal(c.calls.length, 0);
    c.doc.querySelector('#local-draft-banner [data-save]').click(); assert.equal(c.calls.length, 0);
    await c.doc.querySelector('#modal-root .btn-primary').onclick(); assert.equal(c.calls.filter((r) => r.channel === 'repricer:save').length, 1); assert.equal(c.w.LocalDrafts.pending(), 0);
  });
  await check('черновик не восстанавливается из localStorage в новом окне', async () => {
    const c1 = create(), f = c1.form('memory-only'); c1.send(f.a, 44);
    const keys = []; for (let i = 0; i < c1.w.localStorage.length; i++) keys.push(c1.w.localStorage.key(i));
    assert.deepEqual(keys, []);
    const c2 = create(); assert.equal(c2.w.LocalDrafts.pending(), 0); assert.equal(typeof c2.w.LocalDrafts.restore, 'undefined');
  });
  await check('смена кабинета не переносит черновик и старый ответ не затирает новое состояние', async () => {
    const c = create(); c.w.LocalDrafts.stage('settings-A', [{ channel: 'settings:save', payload: { shopName: 'Старый' } }]);
    c.switch('second', 'context-B'); c.w.S.state.settings = { shopName: 'Новый' };
    assert.equal(c.w.LocalDrafts.pending(), 0); assert.equal(await c.w.LocalDrafts.commit({ id: 'settings-A' }), true); assert.equal(c.calls.length, 0); assert.equal(c.w.S.state.settings.shopName, 'Новый');
  });
  await check('beforeunload предупреждает о несохранённых черновиках', async () => {
    const c = create(), f = c.form('unload'); c.send(f.a, -2); const event = new c.w.Event('beforeunload', { cancelable: true }); c.w.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  });
  await check('явное сохранение не использует ни один канал отправки WB', async () => {
    const c = create(), f = c.form('no-send'); c.send(f.a, 8); await c.w.LocalDrafts.commit({ scope: f.host });
    assert.ok(c.calls.every((r) => !['wb:apply-prices', 'wb:apply-size-prices', 'repricer:send', 'repricer:proposal-send', 'keys:set'].includes(r.channel))); assert.deepEqual(c.errors, []);
  });
}
main().catch((e) => { fail++; console.error(e.stack); }).finally(() => { windows.forEach((w) => w.close()); console.log(`\nИТОГО черновики: ${pass} пройдено, ${fail} ошибок`); process.exitCode = fail ? 1 : 0; });
