'use strict';

/** Общие налоговые настройки в «Параметрах» РП и в настройках кабинета. */
window.TaxUI = (function () {
  function fields(prefix, settings) {
    const s = settings || {}, p = prefix;
    return `<div class="tax-extra" style="grid-column:1 / -1">
      <div class="grid g3" style="gap:10px">
        <label class="field">НДС отдельно от УСН, включён в цену
          <select id="${p}-vat">${[[0, 'Без НДС'], [5, 'НДС 5%'], [7, 'НДС 7%'], [10, 'НДС 10%'], [22, 'НДС 22%']].map(([rate, text]) => `<option value="${rate}" ${Number(s.taxVatRate) === rate ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
        <label class="checkline"><input id="${p}-ip" type="checkbox" ${s.taxInsuranceEnabled || s.taxMode === 'usn6_ip' ? 'checked' : ''}> ИП на УСН «Доходы»: взносы отдельно</label>
        <label class="field">Годовой доход всего ИП, ₽<input id="${p}-annual" type="number" min="0" step="1000" value="${s.taxAnnualRevenue > 0 ? s.taxAnnualRevenue : ''}" placeholder="Для распределения годовых взносов"></label>
        <label class="field">Фиксированные взносы в год, ₽<input id="${p}-fixed" type="number" min="0" value="${s.ipFixedContribution ?? 57390}" step="1"></label>
        <label class="field">Предел дополнительного 1% в год, ₽<input id="${p}-ipcap" type="number" min="0" value="${s.ipExtraContributionCap ?? 321818}" step="1"></label>
        <div class="col"><label class="checkline"><input id="${p}-staff" type="checkbox" ${s.ipHasEmployees ? 'checked' : ''}> У ИП есть работники</label>
          <label class="checkline"><input id="${p}-deduct" type="checkbox" ${s.ipDeductContributions !== false ? 'checked' : ''}> Уменьшать УСН на взносы (расчётная оценка)</label></div>
      </div>
      <p id="${p}-tax-summary" class="hint" role="status"></p>
      <p class="tiny muted">НДС 22% из включающей его цены — цена × 22/122, не 22% сверху. Взнос ИП — 1% только с годового превышения 300 000 ₽, с пределом и возможным уменьшением УСН. Укажите доход <b>всего ИП по всем кабинетам</b>; взносы распределяются пропорционально, не целиком на каждый товар. Суммы 57 390 / 321 818 ₽ — для полного 2026 года, измените при льготе или другом периоде. Это юнит-экономика, не декларация; входной НДС, налог на прибыль/НДФЛ ОСНО и все виды льгот не рассчитываются.</p>
    </div>`;
  }
  function read(prefix, container) {
    const root = container || document, byId = (id) => root.querySelector('#' + prefix + '-' + id);
    return { taxMode: byId('taxmode').value, taxRate: U.num(byId('taxrate').value), taxVatRate: U.num(byId('vat').value),
      taxInsuranceEnabled: byId('ip').checked, taxAnnualRevenue: byId('annual').value === '' ? null : Math.max(0, U.num(byId('annual').value)),
      ipFixedContribution: Math.max(0, U.num(byId('fixed').value)), ipExtraContributionCap: Math.max(0, U.num(byId('ipcap').value)),
      ipHasEmployees: byId('staff').checked, ipDeductContributions: byId('deduct').checked };
  }
  function bind(prefix, settings, container) {
    const root = container || document, get = (id) => root.querySelector('#' + prefix + '-' + id);
    let previousMode = get('taxmode').value;
    const update = () => {
      const mode = get('taxmode').value, ip = /^usn6/.test(mode);
      if (mode === 'nds22') get('vat').value = '22';
      if (mode === 'none') get('vat').value = '0';
      if (mode === 'usn6_ip') get('ip').checked = true;
      get('vat').disabled = mode === 'nds22' || mode === 'none'; get('taxrate').disabled = mode === 'nds22' || mode === 'none';
      get('ip').disabled = !ip || mode === 'usn6_ip';
      for (const id of ['annual', 'fixed', 'ipcap', 'staff', 'deduct']) get(id).disabled = !ip || !get('ip').checked;
      const info = EC.resolveTax({ ...settings, ...read(prefix, root) }, mode);
      get('tax-summary').textContent = 'Расчётная нагрузка: ' + U.pct(info.effectiveRate, 3) + ' от выручки. НДС: ' + U.pct(info.vatEffective, 3) +
        (info.ipEnabled && info.annualGross ? '; доп. взнос: ' + U.money(info.extraAnnual, 2) + '/год; уменьшение УСН: ' + U.money(info.deductibleAnnual, 2) + '/год.' : '.') +
        (info.warnings.length ? ' ' + info.warnings.join(' ') : '');
    };
    get('taxmode').addEventListener('change', () => {
      const preset = EC.TAX_MODES.find((m) => m.id === get('taxmode').value);
      if (preset) get('taxrate').value = preset.rate;
      if (preset && preset.id === 'nds22') get('vat').value = '22';
      else if (previousMode === 'nds22') get('vat').value = '0';
      previousMode = get('taxmode').value;
      update();
    });
    for (const id of ['taxrate', 'vat', 'ip', 'annual', 'fixed', 'ipcap', 'staff', 'deduct']) {
      get(id).addEventListener('change', update); get(id).addEventListener('input', update);
    }
    update();
  }
  return { fields, read, bind };
})();
