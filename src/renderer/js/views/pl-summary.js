'use strict';

/**
 * Сводный P&L по всем профилям (кабинетам WB).
 *
 * Собирает P&L каждого профиля в одном отчёте и показывает, из какого кабинета
 * пришли данные. Итоговые показатели суммируются по всем профилям; у каждого
 * профиля — своя строка с выручкой, удержаниями, себестоимостьстью и прибылью.
 */
window.Views = window.Views || {};

Views.plSummary = {
  title: 'Сводка P&L',
  subtitle: 'P&L по всем кабинетам: выручка, удержания, себестоимость и прибыль с указанием профиля',

  render(container) {
    this.container = container;
    this.draw();
  },

  async draw() {
    const container = this.container;
    container.innerHTML = `<div class="card">${UI.loading('Считаем P&L по всем профилям…')}</div>`;

    let res;
    try {
      res = await API.invoke('profiles:pl-summary');
    } catch (e) {
      container.innerHTML = `<div class="card"><div class="alert danger">${U.esc(e.message)}</div></div>`;
      return;
    }

    const profiles = (res && res.profiles) || [];
    const totals = (res && res.totals) || {};
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

    const money = (v) => U.fmt(r2(v));
    const pct = (v) => U.pct(r2(v));
    const cls = (v) => U.profitClass(r2(v));

    // строка P&L: статья, сумма, доля от выручки
    const line = (label, value, share, opts) => {
      const o = opts || {};
      const sign = o.sign !== false && Number(value) < 0 ? '−' : '';
      const clsAttr = o.cls ? ` class="${o.cls}"` : '';
      return `<tr${clsAttr}>
        <td class="lbl">${label}</td>
        <td class="num ${o.cls || ''}">${sign}${money(value)}</td>
        <td class="num muted">${share && Number(totals.revenue) > 0 ? pct(value / totals.revenue * 100) : '—'}</td>
      </tr>`;
    };

    const totalsCard = `
      <div class="card-head"><h2>Итого по всем кабинетам</h2>
        <span class="hint">${profiles.filter((p) => p.ok && p.totals).length} из ${profiles.length} профилей со данными</span>
      </div>
      <table class="tbl">
        <thead><tr><th>Статья P&L</th><th class="num">Сумма, ₽</th><th class="num">Доля от выручки</th></tr></thead>
        <tbody>
          ${line('Выручка', totals.revenue)}
          ${line('− Комиссия WB', -totals.commission)}
          ${line('− Логистика', -totals.logistics)}
          ${line('− Хранение', -totals.storage)}
          ${line('− Приёмка', -totals.acceptance)}
          ${line('− Эквайринг', -totals.acquiring)}
          ${line('− Штрафы и удержания', -totals.penalties)}
          ${line('= К перечислению (после логистики)', totals.wbAfterLogistics)}
          ${line('− Себестоимость', -totals.cogs)}
          ${line('− Упаковка', -totals.packaging)}
          ${line('− Реклама', -totals.ad)}
          ${line('− Налог', -totals.tax)}
          ${line('= Чистая прибыль', totals.profit, 0, { cls: cls(totals.profit), sign: false })}
        </tbody>
      </table>
      <div class="row wrap" style="gap:16px;margin-top:10px">
        <span class="muted">Маржинальность: <b class="${cls(totals.marginPct)}">${pct(totals.marginPct)}</b></span>
        <span class="muted">Комиссия: <b>${pct(totals.commissionPct)}</b></span>
        <span class="muted">Товары/продажи: <b>${U.fmt(totals.salesQty)}</b></span>
      </div>`;

    const profileCards = profiles.map((p) => {
      const t = p.totals;
      if (!p.ok || !t || Number(t.revenue) <= 0) {
        return `<div class="card">
          <div class="card-head"><h2>${U.esc(p.profileName)}</h2>
            <span class="badge badge-demo">без данных</span></div>
          <div class="alert warn">${U.esc((p && p.message) || 'Финансовый отчёт WB не загружен для этого кабинета.')}</div>
        </div>`;
      }
      return `<div class="card">
        <div class="card-head"><h2>${U.esc(p.profileName)}</h2>
          <span class="badge badge-live">кабинет</span></div>
        <table class="tbl">
          <thead><tr><th>Статья P&L</th><th class="num">Сумма, ₽</th></tr></thead>
          <tbody>
            ${line('Выручка', t.revenue)}
            ${line('− Комиссия', -t.commission)}
            ${line('− Логистика', -t.logistics)}
            ${line('− Хранение', -t.storage)}
            ${line('− Приёмка', -t.acceptance)}
            ${line('− Эквайринг', -t.acquiring)}
            ${line('− Штрафы', -t.penalties)}
            ${line('= К перечислению', t.wbAfterLogistics)}
            ${line('− Себестоимость', -t.cogs)}
            ${line('− Упаковка', -t.packaging)}
            ${line('− Реклама', -t.ad)}
            ${line('− Налог', -t.tax)}
            ${line('= Прибыль', t.profit, 0, { cls: cls(t.profit), sign: false })}
          </tbody>
        </table>
        <div class="row wrap" style="gap:14px;margin-top:8px">
          <span class="muted">Маржинальность: <b class="${cls(t.marginPct)}">${pct(t.marginPct)}</b></span>
          <span class="muted">Товары: <b>${U.fmt(t.salesQty)}</b></span>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = `
      <div class="col" style="gap:16px">
        ${res.empty ? `<div class="alert info">Пока ни в одном кабинете не загружен финансовый отчёт WB —
          загрузите его в разделе «Отчёты» или «Настройки → Фактические расходы» для каждого профиля.</div>` : ''}
        ${totalsCard}
        <div class="card-head"><h2>По кабинетам</h2>
          <span class="hint">каждая карточка — свой кабинет WB</span></div>
        ${profileCards}
      </div>`;
  }
};
