'use strict';

/** Сводка локальных финансовых снимков: никаких неявных запросов в кабинеты WB. */
window.Views = window.Views || {};
Views['pl-summary'] = {
  title: 'Сводка P&L',
  subtitle: 'Прибыль по кабинетам из уже загруженных финансовых отчётов WB',
  render(container) { this.container = container; return this.draw(); },
  async draw() {
    const container = this.container;
    const epoch = API.generation();
    container.innerHTML = `<div class="card">${UI.loading('Считаем сводку по кабинетам…')}</div>`;
    let report;
    try { report = await API.invoke('profiles:pl-summary'); }
    catch (error) {
      if (epoch === API.generation()) container.innerHTML = `<div class="alert danger">${U.esc(error.message)}</div>`;
      return;
    }
    if (epoch !== API.generation()) return;
    const profiles = report.profiles || [];
    const money = (value) => U.fmt(Number(value) || 0, 2);
    const period = (meta) => meta && meta.dateFrom && meta.dateTo
      ? U.esc(U.date(meta.dateFrom)) + ' → ' + U.esc(U.date(meta.dateTo)) : 'период не указан';
    const total = report.totals;
    const metrics = [
      ['Выручка', 'revenue', 1], ['Комиссия WB', 'commission', -1], ['Логистика', 'logistics', -1],
      ['Хранение', 'storage', -1], ['Приёмка', 'acceptance', -1], ['Эквайринг', 'acquiring', -1],
      ['Штрафы и удержания', 'penalties', -1], ['После расходов WB', 'wbAfterLogistics', 1],
      ['Себестоимость', 'cogs', -1], ['Упаковка', 'packaging', -1], ['Реклама', 'ad', -1], ['Налог', 'tax', -1],
      ['Чистая прибыль', 'profit', 1]
    ];
    const details = (totals) => metrics.map(([label, key, sign]) => `<tr>
      <td>${label}</td><td class="num ${key === 'profit' ? U.profitClass(totals[key]) : ''}">${money(sign * (Number(totals[key]) || 0))}</td></tr>`).join('');
    const warning = report.periodsDiffer || report.mixedModes
      ? `<div class="alert warn">Общий итог не рассчитан: ${[
        report.periodsDiffer ? 'у кабинетов разные периоды финансовых отчётов' : '',
        report.mixedModes ? 'нельзя смешивать демо и реальные данные' : ''
      ].filter(Boolean).join('; ')}. Ниже показан каждый кабинет отдельно. Загрузите одинаковый период отчёта во всех кабинетах для общего итога.</div>` : '';
    const rows = profiles.map((p) => `<tr>
      <td><b>${U.esc(p.profileName)}</b><div class="tiny muted">${U.esc(p.profileId)}</div></td>
      <td>${period(p.meta)}<div class="tiny muted">${p.demo ? 'демо-данные' : 'данные WB'}${p.meta && p.meta.updatedAt ? ' · загружено ' + U.esc(U.date(p.meta.updatedAt, true)) : ''}</div></td>
      ${p.ok && p.totals ? `<td class="num">${money(p.totals.revenue)}</td><td class="num ${U.profitClass(p.totals.profit)}">${money(p.totals.profit)}</td><td class="num">${U.pct(p.totals.marginPct)}</td>`
        : `<td colspan="3" class="muted">${U.esc(p.message || 'Финансовый отчёт не загружен')}</td>`}
    </tr>`).join('');
    container.innerHTML = `<div class="col" style="gap:16px">
      <div class="alert info">${report.fixedProfile ? 'Веб-доступ ограничен выбранным при запуске кабинетом. ' : ''}Используются только сохранённые снимки; обновление сводки не обращается к WB. Период и источник подписаны у каждого кабинета.</div>
      ${warning}
      ${report.empty ? '<div class="alert warn">Нет загруженных финансовых отчётов. Загрузите отчёт в разделе «Отчёты» или «Настройки → Фактические расходы» выбранного кабинета.</div>' : ''}
      <div class="card"><div class="card-head"><h2>По кабинетам</h2><button class="btn btn-sm btn-ghost" id="pl-summary-refresh">Перечитать снимки</button></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Кабинет</th><th>Период и источник</th><th class="num">Выручка, ₽</th><th class="num">Прибыль, ₽</th><th class="num">Маржа</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      ${total ? `<div class="card"><div class="card-head"><h2>Итого по сопоставимым кабинетам</h2><span class="hint">${report.count} из ${profiles.length} · ${period(report.period)}</span></div>
        <table class="table"><thead><tr><th>Статья</th><th class="num">Сумма, ₽</th></tr></thead><tbody>${details(total)}</tbody></table>
        <p>Маржинальность: <b class="${U.profitClass(total.profit)}">${U.pct(total.marginPct)}</b> · Продаж: ${U.fmt(total.salesQty)}</p></div>` : ''}
      ${profiles.filter((p) => p.ok && p.totals).map((p) => `<details class="card"><summary><b>${U.esc(p.profileName)}</b> · ${period(p.meta)} · состав P&L</summary><table class="table"><thead><tr><th>Статья</th><th class="num">Сумма, ₽</th></tr></thead><tbody>${details(p.totals)}</tbody></table>
        ${p.missingCost && p.missingCost.length ? '<div class="alert warn">Для части товаров не задана себестоимость; прибыль может быть завышена.</div>' : ''}</details>`).join('')}
    </div>`;
    container.querySelector('#pl-summary-refresh').onclick = () => this.draw();
  }
};
