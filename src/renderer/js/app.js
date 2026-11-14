'use strict';

/** Точка входа интерфейса: роутинг разделов, загрузка данных, глобальные действия. */
window.App = (function () {

  const NAV = [
    { id: 'dashboard', ico: '▦', label: 'Панель' },
    { id: 'prices', ico: '₽', label: 'Цены и скидки' },
    { id: 'repricer', ico: '⟳', label: 'Репрайсер' },
    { id: 'promos', ico: '％', label: 'Акции WB' },
    { id: 'economics', ico: '∑', label: 'Экономика' },
    { id: 'costs', ico: '⚙', label: 'Себестоимость' },
    { id: 'reports', ico: '🖶', label: 'Отчёты' },
    { id: 'settings', ico: '⚿', label: 'Настройки' }
  ];

  function toast(msg, kind, ms) { UI.toast(msg, kind, ms); }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = '';
    NAV.forEach((n) => {
      const a = U.el(`<div class="nav-item ${n.id === S.state.view ? 'active' : ''}" data-id="${n.id}">
        <span class="ico">${n.ico}</span><span>${n.label}</span>
        <span class="nav-count" data-count="${n.id}" style="display:none"></span></div>`);
      a.onclick = () => go(n.id);
      nav.appendChild(a);
    });
  }

  /** Задан ли настоящий ключ WB (не демо-заглушка). */
  function hasRealKey() {
    const k = (S.state.appState && S.state.appState.keys) || {};
    return !!(k.single || k.prices || k.statistics || k.content || k.finance || k.master);
  }

  function setModeBadge() {
    const b = document.getElementById('mode-badge');
    const demo = S.state.demo;
    const key = hasRealKey();
    b.className = 'badge ' + (demo ? 'badge-demo' : 'badge-live');
    b.textContent = demo ? (key ? 'демо-режим (ключ задан)' : 'демо-режим') : 'WB API';
    // если ключ уже есть, а демо не выключен — переключаемся в один клик прямо отсюда
    b.style.cursor = (demo && key) ? 'pointer' : '';
    b.title = (demo && key) ? 'Ключ сохранён, но включён демо-режим. Нажмите, чтобы перейти на данные кабинета WB.' : '';
    b.onclick = (demo && key) ? () => switchToLive() : null;
  }

  /**
   * Переключить приложение с демо-данных на реальный кабинет WB.
   * Демо-режим нужен только пока нет ключа: как только ключ сохранён, он мешает.
   */
  async function switchToLive(opts) {
    const o = opts || {};
    if (!hasRealKey()) {
      toast('Сначала сохраните API-ключ в разделе «Настройки»', 'warn', 6000);
      go('settings');
      return;
    }
    const doSwitch = async () => {
      await S.saveSettings({ demoMode: false });
      await S.loadAppState();
      toast('Демо-режим выключен — работаем с кабинетом WB', 'ok');
      setModeBadge();
      if (o.refresh !== false) await refreshAllData({ facts: true });
      else refreshCurrent();
    };
    if (o.confirm === false) return doSwitch();
    UI.confirmDialog('Перейти на данные кабинета WB',
      `<div class="alert info">Ключ сохранён, поэтому демо-режим больше не нужен.
       Приложение перечитает товары, цены, акции, статистику и расходы из вашего кабинета WB.
       Демо-данные никуда не отправлялись и останутся доступны, если вернуть галочку в настройках.</div>`,
      doSwitch);
  }

  function updateNavCounts() {
    const rows = S.getRows();
    const loss = rows.filter((r) => r.profit < 0).length;
    const noCogs = rows.filter((r) => !r.costPrice || r.cogsSource !== 'user').length;
    setCount('prices', loss ? loss + ' убыт.' : '');
    setCount('costs', noCogs ? noCogs : '');
    setCount('promos', S.state.promos.length ? S.state.promos.length : '');
  }

  function setCount(id, text) {
    const el = document.querySelector(`[data-count="${id}"]`);
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  function updateSyncInfo() {
    const el = document.getElementById('sync-info');
    const st = S.state;
    if (!st.items.length) { el.textContent = 'данные не загружены'; return; }
    // когда всё выгружено из кабинета одним нажатием — показываем именно это время
    const when = st.lastDataRefreshAt || st.goodsLoadedAt;
    const facts = st.factsMeta && st.factsMeta.loadedAt
      ? `<br>расходы из отчёта: ${U.date(st.factsMeta.loadedAt, true)}`
      : '';
    el.innerHTML = `${U.fmt(st.items.length)} товаров · ${st.demo ? 'демо' : 'WB API'}<br>обновлено ${U.date(when, true)}${facts}`;
  }

  function go(id) {
    S.state.view = id;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
    const view = Views[id];
    document.getElementById('page-title').textContent = view.title;
    document.getElementById('page-subtitle').textContent = view.subtitle || '';
    renderTopActions(id);
    const host = document.getElementById('view');
    host.innerHTML = '';
    try {
      view.render(host);
    } catch (e) {
      host.innerHTML = `<div class="card"><div class="alert danger">Ошибка раздела: ${U.esc(e.message)}</div><pre class="tiny muted">${U.esc(e.stack || '')}</pre></div>`;
      console.error(e);
    }
  }

  /**
   * Полное обновление данных из кабинета WB: товары и цены, календарь акций,
   * статистика продаж, карточки (габариты) и фактические расходы из отчёта о реализации.
   * Показывает прогресс по разделам и итог — что загружено, а что не удалось и почему.
   */
  async function refreshAllData(opts) {
    const o = opts || {};
    const modal = UI.modal({
      title: 'Обновление данных из кабинета WB',
      dismissable: false,
      size: 'md',
      content: `<div class="col" style="gap:8px">
          <div class="alert info" style="margin:0">Загружаем всё сразу: товары и цены, акции, статистику продаж,
            габариты и фактические расходы. Категории WB «Статистика» и «Финансы» отдаются не чаще одного запроса
            в минуту, поэтому длинное окно грузится пару минут, а раздел, упёршийся в лимит, помечается ⏳
            и догружается в фоне сам — приложение сообщит, когда данные придут.</div>
          <div id="rf-log" class="col" style="gap:4px"></div>
        </div>`,
      buttons: [{ label: 'Закрыть', disabled: true }]
    });
    const log = modal.body.querySelector('#rf-log');
    const line = (text, kind) => {
      const el = U.el(`<div class="tiny ${kind || ''}">${text}</div>`);
      log.appendChild(el);
      return el;
    };
    line('Запрашиваем данные…', 'muted');

    let res = null;
    try {
      res = await API.invoke('data:refresh-all', { facts: o.facts !== false });
    } catch (e) {
      line('<b class="neg">Ошибка:</b> ' + U.esc(e.message), 'neg');
    }

    // перечитываем состояние приложения
    try {
      await S.loadAppState();
      await S.loadGoods(true);
      await S.loadPromos();
      await S.refreshFacts();
      S.invalidate();
    } catch (e) {
      line('<b class="neg">Не удалось перечитать данные:</b> ' + U.esc(e.message), 'neg');
    }

    if (res) {
      log.innerHTML = '';
      (res.sections || []).forEach((sec) => {
        if (sec.deferred) {
          // раздел упёрся в лимит WB (1 запрос в минуту) или данных за период ещё нет —
          // это не ошибка: он догрузится в фоне, о результате придёт событие
          const el = line(
            `<b class="warn">⏳</b> <b>${U.esc(sec.title)}</b> — <span class="warn">${U.esc(String(sec.error || 'лимит WB'))}</span>` +
            ` <span class="muted">(${(sec.ms / 1000).toFixed(1)} с)</span>` +
            `<div class="tiny muted" style="margin-top:2px">Догрузится автоматически${sec.retryAt ? ' в ' + U.esc(U.date(sec.retryAt, true)) : ''}. ` +
            `<button class="btn btn-sm btn-ghost" data-retry="${U.esc(sec.name)}">Повторить сейчас</button></div>`);
          const btn = el.querySelector('[data-retry]');
          if (btn) {
            btn.onclick = async () => {
              btn.disabled = true;
              btn.textContent = 'Ждём сброса лимита WB…';
              try {
                const r = await API.invoke('data:refresh-section', { name: sec.name });
                if (r && r.ok === false) { btn.textContent = 'Уже догружается…'; return; }
                el.innerHTML = `<b class="pos">✓</b> <b>${U.esc(sec.title)}</b> — ${U.esc(String((r && r.detail) || 'готово'))}`;
                await S.reloadAfterDeferred(sec.name);
                refreshCurrent();
              } catch (e) {
                btn.disabled = false;
                btn.textContent = 'Повторить сейчас';
                toast(e.message, 'err', 8000);
              }
            };
          }
          return;
        }
        line(`${sec.ok ? '<b class="pos">✓</b>' : '<b class="neg">✗</b>'} <b>${U.esc(sec.title)}</b> — ` +
          (sec.ok ? U.esc(String(sec.detail || 'готово')) : '<span class="neg">' + U.esc(String(sec.error || 'ошибка')) + '</span>') +
          ` <span class="muted">(${(sec.ms / 1000).toFixed(1)} с)</span>`);
      });
      if (res.errors && res.errors.length) {
        const hint = res.errors.map((e) => `<li><b>${U.esc(e.title)}</b>: ${U.esc(e.message)}${e.hint ? ' — ' + U.esc(e.hint) : ''}</li>`).join('');
        line(`<div class="alert warn" style="margin-top:8px"><b>Не загружено разделов: ${res.errors.length}.</b><ul style="margin:6px 0 0;padding-left:18px">${hint}</ul></div>`);
      }
      if (res.deferred && res.deferred.length) {
        const names = res.deferred.map((d) => U.esc(d.title)).join(', ');
        line(`<div class="alert warn" style="margin-top:8px"><b>Дозагружается в фоне: ${names}.</b>
          <div class="tiny" style="margin-top:4px">WB отдаёт «Статистику» и «Финансы» не чаще одного запроса в минуту,
          поэтому раздел не блокирует обновление, а догружается сам. Приложение сообщит, когда данные придут —
          или нажмите «Повторить сейчас» выше.</div></div>`);
      }
      if (!(res.errors && res.errors.length) && !(res.deferred && res.deferred.length)) {
        line('<div class="alert ok" style="margin-top:8px">Все разделы загружены.</div>');
      }
      const cov = res.coverage || {};
      if (!res.demo) {
        const missing = ['prices', 'statistics', 'content', 'finance'].filter((k) => !cov[k]);
        if (missing.length) {
          line(`<div class="alert warn" style="margin-top:8px">Нет ключа для разделов: <b>${U.esc(missing.join(', '))}</b>.
            Вставьте один общий ключ в «Настройки → Подключение к Wildberries».</div>`);
        }
      }
    }

    const btn = (modal.foot && modal.foot.querySelector('button')) || null;
    if (btn) { btn.disabled = false; btn.textContent = 'Закрыть'; }
    if (o.redraw !== false) refreshCurrent();
    setModeBadge();
    updateSyncInfo();
    if (res && res.errors && res.errors.length) toast('Данные обновлены частично: ' + res.errors.length + ' раздел(ов) с ошибкой', 'warn', 6000);
    else if (res && res.deferred && res.deferred.length) toast('Данные обновлены. ' + res.deferred.length + ' раздел(ов) дозагрузятся в фоне — WB даёт один запрос в минуту', 'warn', 8000);
    else toast('Данные из кабинета WB обновлены', 'ok');
    try { await S.loadDeferred(); } catch (e) { /* не критично */ }
    return res;
  }

  function refreshCurrent() {
    updateNavCounts();
    updateSyncInfo();
    setModeBadge();
    go(S.state.view);
  }

  function renderTopActions(id) {
    const host = document.getElementById('topbar-actions');
    host.innerHTML = '';
    const mk = (label, cls, fn) => {
      const b = U.el(`<button class="btn btn-sm ${cls || ''}">${label}</button>`);
      b.onclick = fn;
      host.appendChild(b);
      return b;
    };
    if (id === 'prices' || id === 'dashboard' || id === 'promos' || id === 'costs' || id === 'economics') {
      mk('Обновить из WB', '', async (e) => {
        e.target.disabled = true;
        try { await refreshAllData({ facts: true }); }
        catch (err) { toast(err.message, 'err', 6000); }
        finally { e.target.disabled = false; }
      });
    }
    if (id === 'economics') mk('Открыть цены', 'btn-ghost', () => go('prices'));
    mk('Справка', 'btn-ghost', showHelp);
  }

  function showHelp() {
    UI.modal({
      title: 'Как пользоваться приложением',
      content: `
        <div class="col" style="gap:12px">
          <div class="alert info"><b>Шаг 1 — себестоимость.</b> Заполните её в разделе «Себестоимость»: вручную, массовой подстановкой
            по категории или импортом CSV (там же есть шаблон). Править параметры одного товара удобнее в репрайсере:
            двойной клик по строке → вкладка «Комиссии и параметры».</div>
          <div class="alert info"><b>Шаг 2 — цены.</b> В разделе «Цены и скидки» выделите товары (или выберите правило отбора: убыточные, неликвид, низкая маржа),
            задайте правило изменения — «−5% к итоговой цене», «цена под маржу 20%», «установить скидку 35%» — и нажмите «Рассчитать предпросмотр».
            Приложение покажет старые и новые цены, прибыль, маржу и все риски. Только после подтверждения данные уходят в WB.</div>
          <div class="alert info"><b>Шаг 3 — акции.</b> В разделе «Акции WB» виден календарь акций, требуемая скидка и расчёт: какие товары можно ввести
            безопасно, какие уйдут в минус. <b>Состав акции берётся из файла кабинета WB</b> — по API его нет (метод отвечает
            <span class="mono">HTTP 422</span>): кнопка «Перейти к акции» открывает кабинет, там «Перейти к товарам для акции» →
            «Сформировать» → «Скачать», затем «Загрузить товары из файла». Вход в акцию — через
            <span class="mono">/api/v1/calendar/promotions/upload</span>.</div>
          <div class="alert info"><b>Шаг 4 — репрайсер.</b> В разделе «Репрайсер» цены пересчитываются автоматически: выберите стратегию
            (конкуренты, целевая маржа, план-факт, оборачиваемость, РРЦ, AI-подбор), задайте коридор «минимальная ↔ базовая цена»
            и лимит шага (рекомендуется 19%). Нажмите «Пересчитать цены» — увидите отчёт «было → станет» с прибылью и маржой,
            а по кнопке «почему» — разбор расчёта по слоям. Отправка в WB — только после подтверждения;
            автообновление по расписанию и автоотправка включаются на вкладке «Параметры репрайсера».</div>
          <div class="alert warn"><b>Конкуренты.</b> WB API не отдаёт цены конкурентов, поэтому их список вы ведёте сами
            (вкладка «Конкуренты»: вручную или импорт CSV — там же скачивается шаблон). Без конкурентов стратегия
            «Конкурентный приоритет» автоматически переключается на «По умолчанию».</div>
          <div class="alert warn"><b>Карантин цен.</b> Если новая цена со скидкой окажется минимум в 3 раза ниже прежней, Wildberries не применит её
            и отправит товар в карантин. Приложение такие строки помечает и не отправляет.</div>
          <div class="alert warn"><b>Лимиты API.</b> «Цены и скидки», «Календарь акций» и «Контент» — 10 запросов за 6 секунд на кабинет.
            А вот <b>«Статистика» и «Финансы» — один запрос в минуту</b>, это жёсткий потолок WB: продажи — одна минута,
            заказы — ещё одна, детализация отчёта о реализации грузится по странице в минуту. Приложение выдерживает паузы само,
            а раздел, упёршийся в лимит (HTTP 429), помечает ⏳ и догружает в фоне — повторять вручную не нужно.
            Уже загруженные данные при этом не стираются.</div>
          <div class="alert warn"><b>Отчёты WB формируются с задержкой.</b> Дневной отчёт о реализации появляется на следующий день,
            недельный — в понедельник за прошлую неделю. Если за выбранные дни отчёта нет, приложение не показывает «0 строк» как успех:
            оно ищет последний сформированный отчёт (кнопка «Найти последний отчёт WB» в «Отчётах» и в «Настройках») и подписывает,
            какой период взят. Статистика продаж и заказов хранится у WB не более 90 дней.</div>
          <div class="alert"><b>Демо-режим.</b> Пока нет ключа, приложение работает на сгенерированных данных: можно посмотреть все разделы
            и «отправлять» цены — они изменятся только локально. Ключ создаётся в кабинете WB: Настройки → Доступ к API.</div>
          <div class="alert"><b>Формула прибыли.</b><br>
            <span class="mono">прибыль = ценаWB × (1 − комиссия% − налог% − реклама% − эквайринг%) − логистика − приёмка − хранение − упаковка − себестоимость</span><br>
            где <span class="mono">ценаWB = базовая цена × (1 − скидка продавца)</span>. СПП (скидка постоянного покупателя) компенсирует WB,
            поэтому из выплаты она не вычитается, но показывается отдельно — видно, сколько фактически платит покупатель.</div>
        </div>`,
      buttons: [{ label: 'Понятно', class: 'btn-primary' }]
    });
  }

  /**
   * Самопроверка моста Electron при запуске.
   *
   * Белый список каналов в preload.js раньше был отдельной копией списка обработчиков,
   * и при рассинхроне файлов пользователь получал «Неизвестный канал: data:refresh-all»
   * без объяснений. Теперь main.js передаёт список в preload, а интерфейс при старте
   * проверяет: если мост старый или канала нет — сразу показываем понятный баннер,
   * не дожидаясь, пока человек нажмёт кнопку обновления.
   */
  function checkBridge() {
    const bridge = window.wbApp;
    if (!bridge || API.isElectron !== true) return '';      // браузер / dev-сервер — мост не используется
    if (!Array.isArray(bridge.channels)) {
      return 'Файлы приложения устарели: <span class="mono">electron/preload.js</span> не отдаёт список каналов. ' +
        'Скопируйте проект заново целиком и перезапустите приложение — иначе часть кнопок (например, «Обновить данные из WB») ' +
        'будет отвечать «Неизвестный канал».';
    }
    if (bridge.channels.indexOf('data:refresh-all') < 0) {
      return 'Файлы приложения рассинхронизированы: в <span class="mono">electron/preload.js</span> нет канала ' +
        '<span class="mono">data:refresh-all</span>. Скопируйте проект заново целиком и перезапустите приложение.';
    }
    return '';
  }

  async function init() {
    S.setEconomics(window.EC);
    buildNav();
    const bridgeProblem = checkBridge();
    if (bridgeProblem) {
      setTimeout(() => {
        const host = document.getElementById('view');
        if (!host) return;
        const bar = U.el(`<div class="alert danger" id="bridge-alert" style="margin:0 0 12px">
            <b>Требуется обновить файлы приложения.</b><br>${bridgeProblem}</div>`);
        host.insertBefore(bar, host.firstChild);
      }, 1200);
      toast('Файлы приложения рассинхронизированы — см. баннер на странице', 'err', 12000);
    }
    document.getElementById('btn-sync').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Обновляем…';
      try { await refreshAllData({ facts: true }); }
      catch (err) { toast(err.message, 'err', 6000); }
      finally { e.target.disabled = false; e.target.textContent = 'Обновить данные из WB'; }
    };

    API.on('log', () => {});
    API.on('warn', (p) => toast(`${p.where}: ${p.message}`, 'warn', 6000));
    API.on('facts', (p) => {
      if (p && p.type === 'loaded') {
        toast(`Фактические расходы загружены: ${p.items} товаров, ${p.rowsProcessed} строк отчёта` +
          (p.widened ? ` за ${U.date(p.dateFrom)} → ${U.date(p.dateTo)}` : ''), 'ok', 6000);
      }
    });
    /**
     * Фоновая догрузка разделов, упёршихся в лимит WB (1 запрос в минуту).
     * Без этого слушателя «Статистика» так и осталась бы незагруженной после 429,
     * хотя сообщение обещало повтор.
     */
    API.on('deferred', async (p) => {
      if (!p || !p.name) return;
      if (p.type === 'scheduled' || p.type === 'rescheduled') {
        toast(`${p.title}: ${p.type === 'rescheduled' ? 'WB всё ещё держит лимит' : 'дозагрузится в фоне'} — ${U.time(p.retryAt)}`, 'warn', 7000);
      } else if (p.type === 'done') {
        toast(`${p.title}: ${p.detail || 'дозагружено'}`, 'ok', 7000);
        try {
          await S.reloadAfterDeferred(p.name);
          refreshCurrent();
        } catch (e) { /* данные на сервере уже обновлены */ }
      } else if (p.type === 'failed') {
        toast(`${p.title}: не догрузилось — ${p.error}`, 'err', 9000);
        try { await S.loadDeferred(); } catch (e) { /* ignore */ }
      }
      try { await S.loadDeferred(); } catch (e) { /* ignore */ }
    });

    try {
      await S.loadAppState();
      setModeBadge();
      await S.loadGoods(false);
      try { await S.refreshFacts(); } catch (e) { /* факт не обязателен для старта */ }
      S.invalidate();
      try { await S.loadPromos(); } catch (e) { /* акции не критичны для старта */ }
      updateNavCounts();
      updateSyncInfo();
      go('dashboard');
      if (!S.state.settings || S.state.settings.firstRun !== false) {
        await S.saveSettings({ firstRun: false });
        setTimeout(showHelp, 600);
      }
    } catch (e) {
      document.getElementById('view').innerHTML =
        `<div class="card"><div class="alert danger">Не удалось запустить приложение: ${U.esc(e.message)}</div>
         <p class="hint">Проверьте, что запущен основной процесс (npm start) или dev-сервер (npm run ui).</p></div>`;
      console.error(e);
    }
  }

  return { init, go, toast, refreshCurrent, refreshAllData, setModeBadge, updateNavCounts, updateSyncInfo, switchToLive, hasRealKey };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
