'use strict';

/**
 * Единая точка доступа к логике приложения.
 *  - в Electron  → IPC через preload (window.wbApp)
 *  - в браузере  → HTTP на локальный dev-сервер (tools/serve.js)
 */
window.API = (function () {

  const isElectron = !!(window.wbApp && typeof window.wbApp.invoke === 'function');

  async function invoke(channel, ...args) {
    if (isElectron) {
      const res = await window.wbApp.invoke(channel, ...args);
      if (!res || res.ok === false) {
        const e = (res && res.error) || { message: 'Неизвестная ошибка' };
        const err = new Error(e.message || 'Ошибка');
        err.code = e.code; err.status = e.status; err.category = e.category;
        throw err;
      }
      return res.data;
    }
    const r = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    });
    const res = await r.json();
    if (!res || res.ok === false) {
      const e = (res && res.error) || { message: 'Сервер не ответил' };
      const err = new Error(e.message || 'Ошибка');
      err.code = e.code; err.status = e.status;
      throw err;
    }
    return res.data;
  }

  // ───────────────────────── События ─────────────────────────
  /**
   * В Electron события приходят через preload (`svc:<channel>`), а в браузере — по SSE
   * с dev-сервера (`GET /api/events`). Формат один и тот же, поэтому подписчики
   * (App.toast на `warn`, прогресс фоновой догрузки на `deferred`, уведомления репрайсера)
   * работают в обоих режимах без изменений.
   */
  const subs = {};                 // channel → [cb]
  let es = null;                   // EventSource
  let esRetry = 0;

  function handleEvent(channel, payload) {
    const list = subs[channel];
    if (!list || !list.length) return;
    list.slice().forEach((cb) => {
      try { cb(payload); } catch (e) { /* ошибка подписчика не должна ронять поток */ }
    });
  }

  function openStream() {
    if (isElectron || es || typeof window.EventSource !== 'function') return;
    try {
      es = new EventSource('/api/events');
    } catch (e) { es = null; return; }

    /**
     * Сервер шлёт именованные события `svc:<channel>`. EventSource требует регистрации
     * слушателя на каждое имя, а список каналов заранее неизвестен, поэтому
     * слушаем общий `message` и разбираем имя из поля `event` вручную — сервер
     * дополнительно дублирует канал в теле сообщения.
     */
    es.onmessage = (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (!data || typeof data !== 'object') return;
      if (data.channel) handleEvent(String(data.channel), data.payload);
    };

    // именованные события регистрируются по мере подписки (listenChannel),
    // а не по жёсткому списку: сервис может добавить канал, и интерфейс
    // не должен из-за этого терять события
    Object.keys(subs).forEach(listenChannel);

    es.onerror = () => {
      // EventSource переподключается сам; при длительном обрыве даём знать интерфейсу
      esRetry++;
      if (esRetry === 3) {
        handleEvent('warn', {
          where: 'события',
          message: 'Поток событий прерван — прогресс фоновых операций может не отображаться. Данные при этом загружаются.'
        });
      }
    };
    es.onopen = () => { esRetry = 0; };
  }

  /** Уже зарегистрированные именованные слушатели SSE: канал → true. */
  const listening = {};

  /**
   * Зарегистрировать слушателя на именованное событие `svc:<channel>`.
   *
   * Почему не общий `onmessage`: EventSource доставляет в `onmessage` только события
   * БЕЗ имени, а сервер шлёт их с именем (`event: svc:info`). Со жёстким списком
   * каналов часть событий терялась — например `info` с прогрессом обновления данных.
   */
  function listenChannel(channel) {
    if (!es || listening[channel]) return;
    listening[channel] = true;
    es.addEventListener('svc:' + channel, (ev) => {
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      handleEvent(channel, payload);
    });
  }

  function on(channel, cb) {
    if (typeof cb !== 'function') return function () {};
    if (isElectron && window.wbApp.on) return window.wbApp.on('svc:' + channel, cb);
    (subs[channel] = subs[channel] || []).push(cb);
    openStream();
    listenChannel(channel);
    // отписка
    return function () {
      const list = subs[channel];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async function exportCsv(filename, content) {
    if (isElectron) {
      const res = await window.wbApp.invoke('ui:export-csv', { defaultPath: filename, content });
      if (res && res.ok && res.data && res.data.filePath) return res.data.filePath;
      if (res && res.ok && res.data && res.data.canceled) return null;
      U.download(filename, content);
      return filename;
    }
    U.download(filename, content);
    return filename;
  }

  async function importCsv() {
    if (isElectron) {
      const res = await window.wbApp.invoke('ui:import-csv');
      if (res && res.ok && res.data && res.data.content) return res.data.content;
      return null;
    }
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.csv,.txt';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve(null);
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || '').replace(/^\uFEFF/, ''));
        fr.readAsText(f, 'utf-8');
      };
      inp.click();
    });
  }

  /**
   * Выбор файла с двоичным содержимым (XLSX) — возвращает { fileName, base64, size }.
   * В Electron файл читает основной процесс, в браузере — FileReader.
   */
  async function importFile(opts) {
    const o = opts || {};
    if (isElectron) {
      const res = await window.wbApp.invoke('ui:import-file', {
        title: o.title, extensions: o.extensions, filterName: o.filterName
      });
      if (res && res.ok && res.data && res.data.base64) return res.data;
      return null;
    }
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = (o.extensions || ['xlsx', 'csv']).map((e) => '.' + e).join(',');
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve(null);
        const fr = new FileReader();
        fr.onload = () => {
          const bytes = new Uint8Array(fr.result);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          resolve({ fileName: f.name, size: f.size, base64: btoa(bin) });
        };
        fr.onerror = () => resolve(null);
        fr.readAsArrayBuffer(f);
      };
      inp.click();
    });
  }

  async function openExternal(url) {
    if (isElectron) { await window.wbApp.invoke('ui:open-external', url); return; }
    window.open(url, '_blank', 'noopener');
  }

  async function appInfo() {
    if (isElectron) {
      const res = await window.wbApp.invoke('ui:app-info');
      return res && res.ok ? res.data : null;
    }
    return { version: 'web-preview', platform: navigator.platform, appDir: 'tools/.data', electron: '—', encryption: '—' };
  }

  return { invoke, on, exportCsv, importCsv, importFile, openExternal, appInfo, isElectron };
})();
