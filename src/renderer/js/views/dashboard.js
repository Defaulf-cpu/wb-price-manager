'use strict';

/** Панель: сводка по магазину, риски, быстрые действия. */
window.Views = window.Views || {};

Views.dashboard = {
  title: 'Панель',
  subtitle: 'Сводка по ценам, маржинальности и рискам',

  render(container) {
    const st = S.state;
    if (!st.items.length) {
      container.innerHTML = `<div class="card">${UI.loading('Загружаем товары и цены из Wildberries…')}</div>`;
      return;
    }

    const rows = S.getRows(true);
    const t = S.totals(rows);
    const s = st.settings;

    const lossRows = rows.filter((r) => r.profit < 0);
    const lowRows = rows.filter((r) => r.profit >= 0 && r.margin < U.num(s.minMarginPctAlert));
    const noCogs = rows.filter((r) => !r.costPrice);
    const illiquid = rows.filter((r) => r.stock > 0 && r.turnoverDays > 90);

    const byCat = Array.from(U.groupBy(rows, (r) => r.category || 'Без категории'))
      .map(([cat, list]) => {
        const rev = U.sum(list, (r) => r.revenue30);
        const prof = U.sum(list, (r) => r.profit30);
        return { cat, count: list.length, rev, prof, margin: rev > 0 ? (prof / rev) * 100 : 0 };
      })
      .sort((a, b) => b.rev - a.rev);

    const maxRev = Math.max(1, ...byCat.map((c) => c.rev));

    const top = rows.slice().sort((a, b) => b.profit30 - a.profit30).slice(0, 8);
    const worst = lossRows.slice().sort((a, b) => a.profit30 - b.profit30).slice(0, 8);

    container.innerHTML = `
      ${st.demo ? (App.hasRealKey() ? `<div class="alert warn" style="margin-bottom:14px">
        <div class="spread wrap" style="gap:10px">
          <div><b>Ключ сохранён, но включён демо-режим.</b> Показаны сгенерированные данные, а не ваш кабинет.
          Нажмите кнопку — приложение выгрузит реальные товары, цены, акции и расходы из WB.</div>
          <button class="btn btn-primary" id="dash-golive">Перейти на данные кабинета</button>
        </div>
      </div>` : `<div class="alert warn" style="margin-bottom:14px">
        <b>Демо-режим.</b> Показаны сгенерированные данные магазина, изменения цен никуда не отправляются.
        Чтобы работать с реальным кабинетом — добавьте API-ключ в разделе «Настройки»: демо-режим выключится сам.
      </div>`) : ''}

      <div class="grid g5" style="margin-bottom:14px">
        <div class="card stat">
          <span class="label">Товаров в работе</span>
          <span class="value">${U.fmt(t.count)}</span>
          <span class="hint">артикулов (нм-кодов)</span>
        </div>
        <div class="card stat">
          <span class="label">Выручка за 30 дней</span>
          <span class="value">${U.compact(t.revenue30)} ₽</span>
          <span class="hint">${U.fmt(t.sales30)} продаж</span>
        </div>
        <div class="card stat">
          <span class="label">Прибыль за 30 дней</span>
          <span class="value ${U.profitClass(t.profit30)}">${U.compact(t.profit30)} ₽</span>
          <span class="hint">маржинальность ${U.pct(t.margin30)}</span>
        </div>
        <div class="card stat">
          <span class="label">Средняя скидка</span>
          <span class="value">${U.pct(t.avgDiscount, 0)}</span>
          <span class="hint">целевая маржа ${U.pct(s.targetMarginPct, 0)}</span>
        </div>
        <div class="card stat">
          <span class="label">Остатки на складах</span>
          <span class="value">${U.fmt(t.stockUnits)} шт</span>
          <span class="hint">по себестоимости ${U.compact(t.stockValue)} ₽</span>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <div class="card-head"><h2>Требует внимания</h2>
            <button class="btn btn-ghost btn-sm" id="dash-goto-prices">Открыть репрайсер</button>
          </div>
          <div class="col">
            <div class="alert ${lossRows.length ? 'danger' : 'ok'}">
              <b>${lossRows.length}</b> товаров продаются в убыток
              ${lossRows.length ? ` — суммарно ${U.money(Math.abs(U.sum(lossRows, (r) => r.profit30)))} за 30 дней` : ''}
            </div>
            <div class="alert ${lowRows.length ? 'warn' : 'ok'}">
              <b>${lowRows.length}</b> товаров с маржой ниже порога ${U.pct(s.minMarginPctAlert, 0)}
            </div>
            <div class="alert ${illiquid.length ? 'warn' : 'ok'}">
              <b>${illiquid.length}</b> неликвид: остаток есть, оборачиваемость больше 90 дней
            </div>
            <div class="alert ${noCogs.length ? 'info' : 'ok'}">
              <b>${noCogs.length}</b> товаров без указанной себестоимости — экономика по ним не считается
            </div>
            <div class="alert" id="dash-rp"><span class="muted small">загружаем статус репрайсера…</span></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Выручка по категориям (30 дней)</h2></div>
          <div class="bars">
            ${byCat.slice(0, 8).map((c) => UI.bar(c.cat, c.rev, maxRev,
              `${U.compact(c.rev)} ₽ · ${U.pct(c.margin, 0)}`, c.margin < 0)).join('')}
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <div class="card-head" style="padding:14px 16px 0"><h2>Самые прибыльные</h2></div>
          <div style="padding:10px 16px 16px">
            ${miniTable(top)}
          </div>
        </div>
        <div class="card pad0">
          <div class="card-head" style="padding:14px 16px 0"><h2>Убыточные — исправить в первую очередь</h2></div>
          <div style="padding:10px 16px 16px">
            ${miniTable(worst)}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h2>Быстрые действия</h2>
        <div class="row wrap">
          <button class="btn btn-primary" data-act="repricer">Пересчитать цены репрайсером</button>
          <button class="btn" data-act="loss">Поднять цену на убыточные</button>
          <button class="btn" data-act="illiquid">Скидка на неликвид</button>
          <button class="btn" data-act="target">Привести к целевой марже</button>
          <button class="btn btn-ghost" data-act="promos">Проверить вход в акции</button>
        </div>
        <p class="hint" style="margin:10px 0 0">Действия открывают «Репрайсер» с нужным отбором товаров: цены там считаются по минимальному/максимальному порогам и стратегиям и уходят в WB только после подтверждения.</p>
      </div>
    `;

    const gotoPrices = container.querySelector('#dash-goto-prices'); if (gotoPrices) gotoPrices.onclick = () => App.go('repricer');
    const goLive = container.querySelector('#dash-golive');
    if (goLive) goLive.onclick = () => App.switchToLive({ refresh: true });

    // статус репрайсера подгружаем отдельно, чтобы не тормозить отрисовку панели
    (async () => {
      try {
        const rs = await API.invoke('repricer:state');
        const el = container.querySelector('#dash-rp');
        if (!el || !el.isConnected) return;
        const last = (rs.runs || [])[0];
        const custom = Object.keys(rs.itemConfigs || {}).length;
        el.className = 'alert ' + (rs.config.enabled ? 'ok' : 'info');
        el.innerHTML = `<b>Репрайсер:</b> ${rs.config.enabled ? 'автообновление включено' : 'автообновление выключено'} ·
          индивидуальные настройки у ${custom} товаров · конкуренты у ${rs.competitorCount} товаров ·
          лимит шага ${U.pct(rs.config.limits.maxChangePerUpdatePct, 0)}
          ${last ? '· последний запуск ' + U.date(last.at, true) : ''}
          <button class="btn btn-xs btn-ghost" id="dash-rp-go" style="margin-left:8px">открыть</button>`;
        const b = el.querySelector('#dash-rp-go');
        if (b) b.onclick = () => App.go('repricer');
      } catch (e) {
        const el = container.querySelector('#dash-rp');
        if (el) el.remove();
      }
    })();

    container.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'promos') return App.go('promos');
        if (act === 'repricer') return App.go('repricer');
        // ручных правил переценки больше нет: открываем репрайсер с отбором по признаку
        if (window.Views && Views.repricer) {
          Views.repricer.itemFilter.seg = act === 'loss' ? 'loss' : 'all';
          Views.repricer.itemFilter.tile = act === 'illiquid' ? 'badturn' : '';
        }
        App.go('repricer');
      };
    });

    function miniTable(list) {
      if (!list.length) return '<div class="muted small">Пусто</div>';
      return `<table class="grid-table">
        <thead><tr><th>Товар</th><th class="num">Цена</th><th class="num">Прибыль/шт</th><th class="num">Маржа</th><th class="num">Прибыль 30 дн</th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td><div class="rowtitle"><b class="trunc">${U.esc(r.title)}</b><span class="tiny muted">${UI.idsPair(r)}</span></div></td>
          <td class="num">${U.money(r.sellerPrice)}</td>
          <td class="num ${U.profitClass(r.profit)}">${U.money(r.profit)}</td>
          <td class="num ${U.profitClass(r.margin)}">${U.pct(r.margin)}</td>
          <td class="num ${U.profitClass(r.profit30)}">${U.compact(r.profit30)} ₽</td>
        </tr>`).join('')}</tbody></table>`;
    }
  }
};
