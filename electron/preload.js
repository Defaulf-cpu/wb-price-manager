'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Безопасный мост между интерфейсом и основным процессом.
 * Все сетевые запросы к Wildberries и работа с файлами идут в main-процессе,
 * API-ключ в renderer не передаётся.
 */
const CHANNELS = [
  'app:state',
  'settings:get',
  'settings:save',
  'settings:reset',
  'keys:set',
  'keys:clear',
  'keys:check',
  'data:refresh-all',
  'data:refresh-section',
  'data:deferred',
  'stats:orders',
  'stats:state',
  'wb:rate-state',
  'wb:goods',
  'wb:sizes',
  'wb:apply-prices',
  'wb:apply-size-prices',
  'wb:upload-states',
  'wb:promos',
  'wb:promo-nomenclatures',
  'wb:promo-join',
  'promos:items',
  'promos:import-noms',
  'promos:noms',
  'promos:index',
  'promos:clear-noms',
  'wb:stats',
  'wb:cards',
  'costs:get',
  'costs:overrides',
  'costs:save',
  'costs:import',
  'costs:clear',
  'costs:rates',
  'cache:clear',
  'tasks:history',
  'repricer:state',
  'repricer:save',
  'repricer:item-configs:get',
  'repricer:item-configs:save',
  'pricewatch:get',
  'pricewatch:record',
  'pricewatch:fetch',
  'pricewatch:history',
  'pricewatch:open',
  'stocks:load',
  'stocks:state',
  'warehouses:list',
  'repricer:competitors:get',
  'repricer:competitors:save',
  'repricer:competitors:import',
  'repricer:competitors:drift',
  'repricer:calc',
  'repricer:send',
  'repricer:proposal',
  'repricer:proposal-send',
  'repricer:proposal-discard',
  'prices:draft-save',
  'prices:draft-load',
  'prices:draft-clear',
  'items:card',
  'xlsx:build',
  'repricer:runs',
  'repricer:history',
  'repricer:journal',
  'repricer:scheduler',
  'repricer:promo-plan',
  'repricer:promo-apply',
  'repricer:promo-exit',
  'repricer:promo-restore',
  'repricer:promo-exits',
  'facts:load',
  'facts:get',
  'facts:clear',
  'facts:reports',
  'reports:pl',
  'ui:export-csv',
  'ui:import-csv',
  'ui:import-file',
  'ui:open-external',
  'ui:app-info',
  'ui:theme',
  'ui:update-state',
  'ui:update-check',
  'ui:update-enable',
  'ui:update-restart',
  'backup:export',
  'backup:import',
  'backup:list',
  'backup:restore',
  'profiles:list',
  'profiles:switch',
  'profiles:create',
  'profiles:rename',
  'profiles:remove',
  'profiles:export',
  'profiles:import',
  'profiles:pl-summary',
  'notify:get',
  'notify:save',
  'notify:test'
];

/**
 * Список каналов, которые реально зарегистрированы в основном процессе,
 * приходит из main.js (webPreferences.additionalArguments) — он строится из
 * Object.keys(service.handlers), то есть не может разойтись с сервисом.
 *
 * Статический список выше оставлен как запасной (и как документация),
 * итоговый белый список — объединение обоих. Именно расхождение этих списков
 * давало «Неизвестный канал: data:refresh-all» в собранном приложении.
 */
const PREFIX = '--wb-channels=';
const fromMain = (() => {
  try {
    const arg = (process.argv || []).find((a) => typeof a === 'string' && a.indexOf(PREFIX) === 0);
    if (!arg) return [];
    return arg.slice(PREFIX.length).split(',').map((x) => x.trim()).filter(Boolean);
  } catch (e) { return []; }
})();

const ALLOWED = Array.from(new Set(CHANNELS.concat(fromMain)));

const api = {
  mode: 'electron',
  /** какие каналы разрешены — используется диагностикой в «Настройках» */
  channels: ALLOWED.slice(),
  channelsFromMain: fromMain.length,
  invoke(channel, ...args) {
    if (!ALLOWED.includes(channel)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'UNKNOWN_CHANNEL',
          message: 'Неизвестный канал: ' + channel + '. Файлы приложения рассинхронизированы: ' +
            'electron/preload.js старше electron/service.js. Скопируйте проект заново целиком и перезапустите приложение.'
        }
      });
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld('wbApp', api);
