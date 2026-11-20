'use strict';

/**
 * Отчёты: P&L (прибыли и убытки) по финансовому отчёту WB.
 *
 * Зачем отдельный раздел: загрузка отчёта о реализации раньше только пересчитывала
 * расходы внутри экономики, а самих цифр отчёта пользователь нигде не видел.
 * Здесь — выручка, все удержания WB, себестоимость, реклама, налог и итоговая прибыль
 * за загруженный период, плюс разбивка по дням, категориям и товарам.
 */
window.Views = window.Views || {};

Views.reports = {
  title: 'Отчёты',
  subtitle: 'P&L по финансовому отчёту WB: выручка, удержания, себестоимость и прибыль',

  tab: 'summary',
  /**
   * Выбранный период отчёта. Пустой = «взять уже загруженный снимок» (быстро, без WB).
   * Как только продавец выбрал даты, отчёт WB дочитывается под этот диапазон,
   * а основной снимок расходов не перезаписывается.
   */
  period: null,

  render(container) {
    this.container = container;
    this.draw();
  },

  async draw() {
    const container = this.container;
    container.innerHTML = `<div class="card">${UI.loading(this.period
      ? 'Читаем отчёт WB за выбранный период… (лимит WB — 1 запрос в минуту)'
      : 'Считаем P&L по загруженному отчёту…')}</div>`;

    let rep;
    try {
      rep = await API.invoke('reports:pl', this.period
        ? Object.assign({}, this.period, { save: false, patient: true })
        : {});
    } catch (e) {
      container.innerHTML = `<div class="card"><div class="alert danger">${U.esc(e.message)}</div></div>`;
      return;
    }

    if (!rep || !rep.ok) {
      container.innerHTML = `
        <div class="card">
          <h2>Отчёт ещё не загружен</h2>
          <div class="alert warn">${U.esc((rep && rep.message) || 'Нет данных финансового отчёта WB.')}</div>
          <p class="hint">P&L строится из отчёта о реализации (finance-api, токен категории «Финансы»).
            WB формирует отчёты с задержкой: дневной — на следующий день, недельный — в понедельник за прошлую
            неделю; лимит запросов — 1 в минуту. Поэтому за «сегодня» строк может не быть вовсе.</p>
          <div class="row wrap" style="margin-top:12px;gap:8px">
            <button class="btn btn-primary" id="pl-load">Загрузить отчёт за 7 дней</button>
            <button class="btn" id="pl-load30">Загрузить за 30 дней</button>
            <button class="btn" id="pl-find">Найти последний отчёт WB</button>
            <button class="btn btn-ghost" id="pl-settings">Открыть настройки</button>
          </div>
          <div id="pl-load-status" style="margin-top:12px"></div>
        </div>`;
      const run = async (days, patient) => {
        const host = container.querySelector('#pl-load-status');
        const btns = Array.from(container.querySelectorAll('button'));
        btns.forEach((b) => { b.disabled = true; });
        if (host) {
          host.innerHTML = UI.loading(patient
            ? 'Ищем последний сформированный отчёт WB… Это два-три запроса с лимитом 1 в минуту — займёт пару минут.'
            : 'Запрашиваем отчёт о реализации у WB…');
        }
        try {
          const res = await API.invoke('facts:load', { days, patient: !!patient });
          // WB может ответить пустым отчётом: показывать «загружено 0 товаров» как успех нельзя
          if (!res || res.ok === false || res.empty) {
            if (host) {
              host.innerHTML = `<div class="alert warn">${U.esc(String((res && (res.message || res.error)) || 'WB не отдал ни одной строки отчёта.'))}</div>` +
                (patient ? '' : '<p class="hint">Нажмите «Найти последний отчёт WB» — приложение спросит у WB список отчётов и возьмёт последний сформированный.</p>');
            }
            btns.forEach((b) => { b.disabled = false; });
            return;
          }
          if (host) host.innerHTML = `<div class="alert ok">Загружено: ${U.esc(String(res.items || 0))} товаров,
            ${U.fmt(res.rowsProcessed || 0)} строк за ${U.esc(String(res.dateFrom || ''))} → ${U.esc(String(res.dateTo || ''))}.` +
            (res.widened ? ' <b>Взят последний доступный отчёт WB</b> (запрошено ' + U.esc(String(res.requestedFrom || '')) +
              ' → ' + U.esc(String(res.requestedTo || '')) + ').' : '') + `</div>`;
          await S.refreshFacts();
          S.invalidate();
          App.toast('Отчёт загружен — пересчитываем P&L', 'ok');
          await this.draw();
        } catch (e) {
          if (host) host.innerHTML = `<div class="alert danger">${U.esc(e.message)}</div>`;
          btns.forEach((b) => { b.disabled = false; });
        }
      };
      container.querySelector('#pl-load').onclick = () => run(7);
      container.querySelector('#pl-load30').onclick = () => run(30);
      container.querySelector('#pl-find').onclick = () => run(U.num(S.state.settings && S.state.settings.factWindowDays, 7), true);
      container.querySelector('#pl-settings').onclick = () => App.go('settings');
      return;
    }

    const T = rep.totals || {};
    const meta = rep.meta || {};
    const tabs = [
      { id: 'summary', label: 'Сводка P&L' },
      { id: 'days', label: 'По дням' },
      { id: 'cats', label: 'По категориям' },
      { id: 'items', label: 'По товарам' }
    ];

    container.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="row wrap" style="gap:8px;align-items:end">
          <label class="field" style="margin:0">Период с
            <input type="date" id="pl-from" value="${U.esc(this.period && this.period.dateFrom ? String(this.period.dateFrom).slice(0, 10) : String(meta.dateFrom || '').slice(0, 10))}" /></label>
          <label class="field" style="margin:0">по
            <input type="date" id="pl-to" value="${U.esc(this.period && this.period.dateTo ? String(this.period.dateTo).slice(0, 10) : String(meta.dateTo || '').slice(0, 10))}" /></label>
          <button class="btn btn-sm btn-primary" id="pl-apply">Показать за период</button>
          <select id="pl-preset" style="width:210px">
            <option value="">Быстрый выбор периода…</option>
            <option value="7">Последние 7 дней</option>
            <option value="14">Последние 14 дней</option>
            <option value="30">Последние 30 дней</option>
            <option value="90">Последние 90 дней</option>
            <option value="month">Этот месяц</option>
            <option value="prevmonth">Прошлый месяц</option>
            <option value="year">Этот год</option>
          </select>
          ${this.period ? '<button class="btn btn-sm btn-ghost" id="pl-reset">Вернуться к загруженному отчёту</button>' : ''}
        </div>
        <div class="row wrap" style="gap:8px;align-items:center;margin-top:10px">
          ${UI.badge('период: ' + U.esc(String(meta.dateFrom || '—')) + ' → ' + U.esc(String(meta.dateTo || '—')), 'info')}
          ${UI.badge((meta.days || 0) + ' дн', 'info')}
          ${UI.badge('строк отчёта: ' + U.fmt(meta.rowsProcessed || 0))}
          ${UI.badge('товаров: ' + U.fmt(meta.items || 0))}
          ${rep.demo ? UI.badge('демо-данные', 'demo') : UI.badge('источник: ' + U.esc(String(meta.source || 'finance-api')), 'live')}
          ${meta.widened ? UI.badge('взят последний доступный отчёт WB (запрошен ' + U.esc(String(meta.requestedFrom || '?')) +
            ' → ' + U.esc(String(meta.requestedTo || '?')) + ')', 'warn') : ''}
          <div class="grow"></div>
          <button class="btn btn-sm" id="pl-refresh">Пересчитать</button>
          <button class="btn btn-sm" id="pl-reload">Загрузить отчёт заново</button>
          <button class="btn btn-ghost btn-sm" id="pl-export">Экспорт CSV</button>
        </div>
        ${rep.missingCostCount ? `<div class="alert warn" style="margin:10px 0 0">
            У <b>${U.fmt(rep.missingCostCount)}</b> товаров не указана себестоимость — их прибыль в отчёте завышена.
            Задайте её в разделе «Себестоимость».</div>` : ''}
      </div>

      <div class="tabs" style="margin-bottom:12px">
        ${tabs.map((t) => `<button class="tab ${this.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>
      <div id="pl-body"></div>`;

    /** Произвольный период: отчёт WB дочитывается под него, основной снимок не трогается. */
    container.querySelector('#pl-apply').onclick = async (e) => {
      const from = String(container.querySelector('#pl-from').value || '').slice(0, 10);
      const to = String(container.querySelector('#pl-to').value || '').slice(0, 10);
      if (!from || !to) { App.toast('Укажите обе границы периода', 'warn'); return; }
      if (from > to) { App.toast('Дата «с» позже даты «по» — так не бывает', 'warn'); return; }
      const btn = e.target;
      btn.disabled = true; btn.textContent = 'Читаем отчёт WB…';
      this.period = { dateFrom: from, dateTo: to };
      try {
        await this.draw();
      } finally {
        const b2 = this.container.querySelector('#pl-apply');
        if (b2) { b2.disabled = false; b2.textContent = 'Показать за период'; }
      }
    };

    container.querySelector('#pl-preset').onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      const iso = (d) => d.toISOString().slice(0, 10);
      const today = new Date();
      let from;
      let to = today;
      if (v === 'month') from = new Date(today.getFullYear(), today.getMonth(), 1);
      else if (v === 'prevmonth') { from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); }
      else if (v === 'year') from = new Date(today.getFullYear(), 0, 1);
      else from = new Date(Date.now() - Number(v) * 86400000);
      container.querySelector('#pl-from').value = iso(from);
      container.querySelector('#pl-to').value = iso(to);
      e.target.value = '';
      container.querySelector('#pl-apply').click();
    };

    const reset = container.querySelector('#pl-reset');
    if (reset) reset.onclick = () => { this.period = null; this.draw(); };

    container.querySelector('#pl-refresh').onclick = () => this.draw();
    container.querySelector('#pl-reload').onclick = async (e) => {
      const b = e.target;
      b.disabled = true; b.textContent = 'Загружаем…';
      try {
        const res = await API.invoke('facts:load', { days: meta.requestedDays || meta.days || 7 });
        // пустой ответ WB — не успех: иначе кнопка рапортовала бы «обновлено» при нуле строк
        if (!res || res.ok === false || res.empty) {
          App.toast((res && (res.message || res.error)) || 'WB не отдал ни одной строки отчёта за этот период', 'warn', 10000);
          b.disabled = false; b.textContent = 'Загрузить отчёт заново';
          return;
        }
        await S.refreshFacts();
        S.invalidate();
        App.toast('Отчёт обновлён' + (res.widened ? ' (взят последний доступный отчёт WB за ' + res.dateFrom + ' → ' + res.dateTo + ')' : ''), 'ok', 7000);
        await this.draw();
      } catch (err) {
        App.toast(err.message, 'err', 8000);
        b.disabled = false; b.textContent = 'Загрузить отчёт заново';
      }
    };
    container.querySelector('#pl-export').onclick = () => this.exportCsv(rep);
    Array.from(container.querySelectorAll('.tab')).forEach((b) => {
      b.onclick = () => { this.tab = b.dataset.tab; this.draw(); };
    });

    const body = container.querySelector('#pl-body');
    if (this.tab === 'summary') body.innerHTML = this.summaryHtml(rep);
    else if (this.tab === 'days') this.daysTab(body, rep);
    else if (this.tab === 'cats') this.catsTab(body, rep);
    else this.itemsTab(body, rep);
  },

  /** Строка P&L: статья, сумма, доля от выручки. */
  plLine(label, value, revenue, opts) {
    const o = opts || {};
    const share = revenue > 0 ? (Math.abs(value) / revenue) * 100 : 0;
    const cls = o.total ? ' total' : '';
    const val = o.plain ? String(value) : U.money(value);
    return `<div class="calc-line${cls}">
        <span class="k">${U.esc(label)}${o.note ? ` <span class="tiny muted">${U.esc(o.note)}</span>` : ''}</span>
        <span class="${o.cls || ''}">${o.sign === false ? '' : (value < 0 ? '−' : '')}${o.plain ? '' : U.money(Math.abs(value))}
          ${revenue > 0 && !o.noShare ? `<span class="tiny muted">${U.pct(share, 1)}</span>` : ''}</span>
      </div>`;
  },

  summaryHtml(rep) {
    const T = rep.totals || {};
    const rev = T.revenue || 0;
    const stat = (label, value, hint, cls) => `<div class="stat">
        <div class="label">${U.esc(label)}</div>
        <div class="value ${cls || ''}">${value}</div>
        ${hint ? `<div class="hint">${U.esc(hint)}</div>` : ''}
      </div>`;

    return `
      <div class="grid g4" style="margin-bottom:14px">
        ${stat('Выручка за период', U.compact(rev) + ' ₽', U.fmt(T.salesQty || 0) + ' продаж, средний чек ' + U.money(T.avgCheck || 0))}
        ${stat('Прибыль', U.compact(T.profit || 0) + ' ₽', 'возвраты без списания себестоимости; со списанием ' + U.compact(T.profitWithReturnCogs || 0) + ' ₽', U.profitClass(T.profit))}
        ${stat('Маржинальность', U.pct(T.marginPct || 0), 'прибыль / выручка', U.profitClass(T.marginPct))}
        ${stat('Прибыль на продажу', U.money(T.avgProfitPerUnit || 0), 'возвраты: ' + U.pct(T.returnSharePct || 0), U.profitClass(T.avgProfitPerUnit))}
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-head"><h2>P&L: что осталось от выручки</h2></div>
          <div class="calc-lines">
            ${this.plLine('Выручка (розничная цена со скидкой)', rev, 0, { sign: false, cls: 'pos' })}
            ${this.plLine('− Комиссия WB', T.commission, rev, { note: U.pct(T.commissionPct || 0, 1) + ' от выручки' })}
            ${this.plLine('− Эквайринг', T.acquiring, rev)}
            ${this.plLine('= К перечислению от WB', T.forPay, rev, { total: true, sign: false, note: 'ppvz_for_pay' })}
            ${this.plLine('− Логистика и возвраты', T.logistics, rev, { note: U.pct(T.logisticsPct || 0, 1) })}
            ${this.plLine('− Хранение', T.storage, rev)}
            ${this.plLine('− Приёмка', T.acceptance, rev)}
            ${this.plLine('− Штрафы и удержания', T.penalties, rev)}
            ${this.plLine('= После расходов WB', T.wbAfterLogistics, rev, { total: true, sign: false })}
            ${this.plLine('− Себестоимость проданного', T.cogs, rev, { note: 'возвращённые единицы не списаны' })}
            ${this.plLine('Справочно: себестоимость возвращённых единиц', T.returnedCogs || 0, rev, { note: 'не вычтена в основной прибыли' })}
            ${this.plLine('Справочно: прибыль со списанием возвратов', T.profitWithReturnCogs || 0, rev, { total: true, sign: false, cls: U.profitClass(T.profitWithReturnCogs || 0), note: 'если возвращённый товар нельзя продать снова' })}
            ${this.plLine('− Упаковка', T.packaging, rev)}
            ${this.plLine('− Реклама', T.ad, rev)}
            ${this.plLine('− Налог', T.tax, rev, { note: U.esc(String(rep.taxMode || '')) })}
            ${this.plLine('= Чистая прибыль', T.profit, rev, { total: true, sign: false, cls: U.profitClass(T.profit) })}
          </div>
          <p class="hint" style="margin-top:10px">Всё до строки «После расходов WB» — факт из отчёта о реализации WB.
            Обратите внимание: «к перечислению» (<span class="mono">ppvz_for_pay</span>) WB считает как
            выручка − комиссия − эквайринг, а логистику, хранение, приёмку и штрафы выставляет отдельными строками —
            поэтому они вычитаются следующим шагом. Себестоимость, упаковка, реклама и налог — ваши данные:
            WB их не знает, они берутся из раздела «Себестоимость» и настроек.</p>
          ${T.forPayFromWb ? '' : '<p class="hint warnc" style="margin-top:6px">WB не отдал сумму «к перечислению» — она посчитана из выручки, комиссии и эквайринга.</p>'}
        </div>

        <div class="card">
          <div class="card-head"><h2>Структура расходов</h2></div>
          <div class="bars">
            ${(function (that) {
              const parts = [
                ['Комиссия WB', T.commission], ['Логистика', T.logistics], ['Себестоимость', T.cogs],
                ['Реклама', T.ad], ['Налог', T.tax], ['Хранение', T.storage],
                ['Эквайринг', T.acquiring], ['Приёмка', T.acceptance], ['Штрафы', T.penalties],
                ['Упаковка', T.packaging]
              ].filter((p) => p[1] > 0).sort((a, b) => b[1] - a[1]);
              const max = parts.length ? parts[0][1] : 0;
              return parts.map((p) => UI.bar(p[0], p[1], max, U.compact(p[1]) + ' ₽')).join('') ||
                '<span class="muted tiny">Нет данных о расходах</span>';
            })(this)}
          </div>
          <div class="divider"></div>
          <div class="card-head"><h2>Требует внимания</h2></div>
          <div class="col">
            <div class="alert ${(rep.bottom || []).length && rep.bottom[0].profit < 0 ? 'danger' : 'ok'}">
              <b>${(rep.bottom || []).filter((x) => x.profit < 0).length}</b> товаров в убытке за период
              ${rep.bottom && rep.bottom[0] && rep.bottom[0].profit < 0
                ? `— худший: ${U.esc(rep.bottom[0].vendorCode || String(rep.bottom[0].nmID))} (${U.money(rep.bottom[0].profit)})` : ''}
            </div>
            <div class="alert ${rep.missingCostCount ? 'warn' : 'ok'}">
              <b>${U.fmt(rep.missingCostCount || 0)}</b> товаров без себестоимости — прибыль по ним завышена
            </div>
            <div class="alert ${T.returnSharePct > 10 ? 'warn' : 'ok'}">
              Доля возвратов: <b>${U.pct(T.returnSharePct || 0)}</b> (${U.fmt(T.returnsQty || 0)} шт.)
            </div>
          </div>
        </div>
      </div>`;
  },

  daysTab(body, rep) {
    const days = rep.byDay || [];
    if (!days.length) {
      body.innerHTML = `<div class="card"><div class="alert warn">Разбивки по дням нет: отчёт загружен без дат
        или загружен до появления этой возможности. Нажмите «Загрузить отчёт заново».</div></div>`;
      return;
    }
    const maxRev = Math.max.apply(null, days.map((d) => d.revenue || 0).concat([1]));
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Динамика по дням</h2>
          <span class="hint">выручка и удержания WB по датам из отчёта о реализации</span></div>
        <div class="bars" style="margin-bottom:14px">
          ${days.map((d) => UI.bar(U.esc(d.date), d.revenue, maxRev, U.compact(d.revenue) + ' ₽ · ' + U.fmt(d.salesQty) + ' шт.')).join('')}
        </div>
        <div id="pl-days-table"></div>
      </div>`;
    const grid = UI.table({
      columns: [
        { title: 'Дата', key: 'date', render: (r) => U.esc(r.date) },
        { title: 'Продажи, шт', key: 'salesQty', num: true, render: (r) => U.fmt(r.salesQty) },
        { title: 'Возвраты, шт', key: 'returnsQty', num: true, render: (r) => U.fmt(r.returnsQty) },
        { title: 'Выручка', key: 'revenue', num: true, render: (r) => U.money(r.revenue) },
        { title: 'Комиссия', key: 'commission', num: true, render: (r) => U.money(r.commission) },
        { title: 'Логистика', key: 'logistics', num: true, render: (r) => U.money(r.logistics) },
        { title: 'К перечислению', key: 'forPay', num: true, render: (r) => `<b>${U.money(r.forPay)}</b>` }
      ],
      rows: days,
      sort: { key: 'date', dir: 'asc', onSort: () => {} },
      footer: (c) => {
        const sum = (f) => U.sum(days, f);
        switch (c.key) {
          case 'date': return `<b>${days.length}</b> <span class="muted tiny">дней</span>`;
          case 'salesQty': return U.fmt(sum((r) => r.salesQty));
          case 'returnsQty': return U.fmt(sum((r) => r.returnsQty));
          case 'revenue': return U.money(sum((r) => r.revenue));
          case 'commission': return U.money(sum((r) => r.commission));
          case 'logistics': return U.money(sum((r) => r.logistics));
          case 'forPay': return `<b>${U.money(sum((r) => r.forPay))}</b>`;
          default: return '';
        }
      }
    });
    body.querySelector('#pl-days-table').appendChild(grid.el);
  },

  catsTab(body, rep) {
    const cats = rep.byCategory || [];
    body.innerHTML = `<div class="card">
        <div class="card-head"><h2>Прибыль по категориям</h2>
          <span class="hint">сортировка по прибыли; себестоимость и реклама — ваши данные</span></div>
        <div id="pl-cats-table"></div>
      </div>`;
    const grid = UI.table({
      columns: [
        { title: 'Категория', key: 'category', render: (r) => `<b>${U.esc(r.category)}</b> <span class="tiny muted">${U.fmt(r.items)} тов.</span>` },
        { title: 'Продажи, шт', key: 'salesQty', num: true, render: (r) => U.fmt(r.salesQty) },
        { title: 'Выручка', key: 'revenue', num: true, render: (r) => U.money(r.revenue) },
        { title: 'Комиссия', key: 'commission', num: true, render: (r) => U.money(r.commission) },
        { title: 'Логистика', key: 'logistics', num: true, render: (r) => U.money(r.logistics) },
        { title: 'К перечислению', key: 'forPay', num: true, render: (r) => U.money(r.forPay) },
        { title: 'После расходов WB', key: 'wbAfterLogistics', num: true, render: (r) => U.money(r.wbAfterLogistics) },
        { title: 'Себестоимость', key: 'cogs', num: true, render: (r) => U.money(r.cogs) },
        { title: 'Прибыль', key: 'profit', num: true, render: (r) => `<b class="${U.profitClass(r.profit)}">${U.money(r.profit)}</b><div class="tiny muted">со спис. возвратов: ${U.money(r.profitWithReturnCogs || 0)}</div>` },
        { title: 'Маржа %', key: 'marginPct', num: true, render: (r) => `<span class="${U.profitClass(r.marginPct)}">${U.pct(r.marginPct)}</span>` }
      ],
      rows: cats,
      sort: { key: 'profit', dir: 'desc', onSort: () => {} },
      footer: (c) => {
        const T = rep.totals || {};
        switch (c.key) {
          case 'category': return `<b>${cats.length}</b> <span class="muted tiny">категорий</span>`;
          case 'salesQty': return U.fmt(T.salesQty);
          case 'revenue': return U.money(T.revenue);
          case 'commission': return U.money(T.commission);
          case 'logistics': return U.money(T.logistics);
          case 'forPay': return U.money(T.forPay);
          case 'wbAfterLogistics': return U.money(T.wbAfterLogistics);
          case 'cogs': return U.money(T.cogs);
          case 'profit': return `<b class="${U.profitClass(T.profit)}">${U.money(T.profit)}</b>`;
          case 'marginPct': return U.pct(T.marginPct);
          default: return '';
        }
      }
    });
    body.querySelector('#pl-cats-table').appendChild(grid.el);
  },

  itemsTab(body, rep) {
    const items = rep.items || [];
    body.innerHTML = `<div class="card">
        <div class="card-head"><h2>P&L по товарам</h2>
          <span class="hint">${U.fmt(items.length)} товаров с продажами за период</span></div>
        <div id="pl-items-table"></div>
      </div>`;
    const grid = UI.table({
      columns: [
        { title: 'Товар', key: 'title', width: '280px', render: (r) => `<div class="rowtitle">
            <b class="trunc" title="${U.esc(r.title)}">${U.esc(r.title || '—')}</b>
            <span class="tiny muted">${UI.idsPair(r)}</span></div>` },
        { title: 'Продажи', key: 'salesQty', num: true, render: (r) => U.fmt(r.salesQty) },
        { title: 'Возвр. %', key: 'returnSharePct', num: true, render: (r) => r.returnSharePct ? `<span class="${r.returnSharePct > 15 ? 'warnc' : 'muted'}">${U.pct(r.returnSharePct, 0)}</span>` : '—' },
        { title: 'Выручка', key: 'revenue', num: true, render: (r) => U.money(r.revenue) },
        { title: 'Комиссия', key: 'commission', num: true, render: (r) => `${U.money(r.commission)} <span class="tiny muted">${U.pct(r.commissionPct, 0)}</span>` },
        { title: 'Логистика', key: 'logistics', num: true, render: (r) => `${U.money(r.logistics)} <span class="tiny muted">${U.money(r.logisticsAvg)}/шт</span>` },
        { title: 'К перечислению', key: 'forPay', num: true, render: (r) => U.money(r.forPay) },
        { title: 'После расх. WB', key: 'wbAfterLogistics', num: true, render: (r) => U.money(r.wbAfterLogistics) },
        { title: 'Себест.', key: 'cogs', num: true, render: (r) => r.hasCost ? U.money(r.cogs) : '<span class="badge badge-info">нет</span>' },
        { title: 'Реклама+налог', key: 'ad', num: true, render: (r) => U.money(r.ad + r.tax) },
        { title: 'Прибыль', key: 'profit', num: true, render: (r) => `<b class="${U.profitClass(r.profit)}">${U.money(r.profit)}</b><div class="tiny muted">со спис. возвратов: ${U.money(r.profitWithReturnCogs || 0)}</div>` },
        { title: 'Маржа %', key: 'marginPct', num: true, render: (r) => `<span class="${U.profitClass(r.marginPct)}">${U.pct(r.marginPct)}</span>` }
      ],
      rows: items,
      tall: true,
      sort: { key: 'profit', dir: 'desc', onSort: () => {} },
      footer: (c) => {
        const T = rep.totals || {};
        switch (c.key) {
          case 'title': return `<b>${U.fmt(items.length)}</b> <span class="muted tiny">товаров</span>`;
          case 'salesQty': return U.fmt(T.salesQty);
          case 'revenue': return U.money(T.revenue);
          case 'commission': return U.money(T.commission);
          case 'logistics': return U.money(T.logistics);
          case 'forPay': return U.money(T.forPay);
          case 'wbAfterLogistics': return U.money(T.wbAfterLogistics);
          case 'cogs': return U.money(T.cogs);
          case 'ad': return U.money(T.ad + T.tax);
          case 'profit': return `<b class="${U.profitClass(T.profit)}">${U.money(T.profit)}</b>`;
          case 'marginPct': return U.pct(T.marginPct);
          default: return '';
        }
      }
    });
    body.querySelector('#pl-items-table').appendChild(grid.el);
  },

  exportCsv(rep) {
    const T = rep.totals || {};
    const meta = rep.meta || {};
    const lines = [];
    lines.push(['P&L', meta.dateFrom + ' → ' + meta.dateTo, (meta.days || 0) + ' дн'].join(';'));
    lines.push(['Статья', 'Сумма ₽', 'Доля от выручки %'].join(';'));
    const row = (name, val) => [name, String(Math.round((Number(val) || 0) * 100) / 100),
      T.revenue > 0 ? String(Math.round(Math.abs(val) / T.revenue * 10000) / 100) : '0'].join(';');
    lines.push(row('Выручка', T.revenue));
    lines.push(row('Комиссия WB', T.commission));
    lines.push(row('Эквайринг', T.acquiring));
    lines.push(row('К перечислению от WB', T.forPay));
    lines.push(row('Логистика и возвраты', T.logistics));
    lines.push(row('Хранение', T.storage));
    lines.push(row('Приёмка', T.acceptance));
    lines.push(row('Штрафы и удержания', T.penalties));
    lines.push(row('После расходов WB', T.wbAfterLogistics));
    lines.push(row('Себестоимость (без списания возвратов)', T.cogs));
    lines.push(row('Себестоимость возвращённых (справочно, не вычтена)', T.returnedCogs || 0));
    lines.push(row('Упаковка', T.packaging));
    lines.push(row('Реклама', T.ad));
    lines.push(row('Налог', T.tax));
    lines.push(row('Чистая прибыль', T.profit));
    lines.push(row('Прибыль со списанием себестоимости возвратов (справочно)', T.profitWithReturnCogs || 0));
    lines.push(['Маржинальность %', String(T.marginPct || 0), ''].join(';'));
    lines.push('');
    lines.push(['Товар', 'nmID', 'Артикул', 'Категория', 'Продажи шт', 'Выручка', 'Комиссия', 'Логистика',
      'К перечислению', 'После расходов WB', 'Себестоимость (без списания возвратов)', 'Себестоимость возвращённых (справочно)', 'Упаковка', 'Реклама', 'Налог', 'Прибыль', 'Прибыль со списанием возвратов', 'Маржа %'].join(';'));
    (rep.items || []).forEach((r) => lines.push([
      '"' + String(r.title || '').replace(/"/g, '""') + '"', r.nmID, r.vendorCode,
      '"' + String(r.category || '').replace(/"/g, '""') + '"',
      r.salesQty, r.revenue, r.commission, r.logistics, r.forPay, r.wbAfterLogistics,
      r.cogs, r.returnedCogs || 0, r.packaging, r.ad, r.tax, r.profit, r.profitWithReturnCogs || 0, r.marginPct
    ].join(';')));
    API.exportCsv('pl-wb-' + (meta.dateFrom || '') + '-' + (meta.dateTo || '') + '.csv', lines.join('\r\n'));
    App.toast('P&L выгружен в CSV', 'ok');
  }
};
