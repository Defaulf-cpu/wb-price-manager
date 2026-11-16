'use strict';

/**
 * Движок массовых правил переценки — общий модуль для «Цен и скидок» и репрайсера.
 *
 * Раньше вся логика (типы правил, выбор области применения, сборка плана с проверкой
 * карантина и минимальной маржи) жила внутри `views/prices.js`, поэтому вторая копия
 * для репрайсера неизбежно разошлась бы с первой. Теперь правило считается здесь,
 * а виды только рисуют результат.
 *
 * Модуль ничего не отправляет в WB: `buildPlan` строит план на клиенте через
 * `EC.applyRule` и `EC.analyze`, а отправка остаётся в «Ценах и скидках» и в
 * кнопках раздела «Репрайсер».
 */
window.RULES = (function () {

  /** Типы правил — те же, что были в «Ценах и скидках»; порядок и подписи сохранены. */
  const TYPES = [
    { id: 'none', label: 'Не менять — отправить только ручной ввод' },
    { id: 'delta-pct', label: 'Изменить итоговую цену на %' },
    { id: 'delta-price', label: 'Изменить итоговую цену на ₽' },
    { id: 'set-price', label: 'Установить итоговую цену, ₽' },
    { id: 'set-discount', label: 'Установить скидку, %' },
    { id: 'set-base', label: 'Установить базовую цену, ₽' },
    { id: 'set-target-margin', label: 'Цена под маржинальность, %' },
    { id: 'set-profit', label: 'Цена под прибыль, ₽/шт' }
  ];

  /** Правило по умолчанию: ничего не менять, лимитов нет. */
  const DEFAULTS = { type: 'none', value: 0, roundTo: 0, minPrice: 0 };

  /** Привести правило к полному виду, не потеряв число 0 (он осмыслен: отстройка 0%). */
  function normalize(rule) {
    const r = rule || {};
    return {
      type: TYPES.some((t) => t.id === r.type) ? r.type : DEFAULTS.type,
      value: Number(r.value) || 0,
      roundTo: Number(r.roundTo) || 0,
      minPrice: Number(r.minPrice) || 0
    };
  }

  function typeLabel(id) {
    const t = TYPES.find((x) => x.id === id);
    return t ? t.label : String(id || '');
  }

  /** Подпись к полю «Значение» зависит от типа правила. */
  function valueTitle(type) {
    return {
      'delta-pct': 'На сколько процентов изменить итоговую цену (минус — снизить)',
      'delta-price': 'На сколько рублей изменить итоговую цену (минус — снизить)',
      'set-price': 'Итоговая цена для покупателя, ₽',
      'set-discount': 'Скидка, %',
      'set-base': 'Базовая цена (цена до скидки), ₽',
      'set-target-margin': 'Целевая маржинальность, %',
      'set-profit': 'Желаемая прибыль с единицы, ₽'
    }[type] || 'Значение правила';
  }

  /**
   * Товары, к которым применяется правило. Логика та же, что была в «Ценах и скидках»:
   * «выбранные» — галочки, «изменённые вручную» — очередь ввода, «текущий фильтр» —
   * S.filtered(), остальные — готовые срезы по экономике.
   */
  function scopeRows(scope, opts) {
    const st = S.state;
    const editing = opts && opts.editing;
    const all = S.getRows();
    switch (scope) {
      case 'selected': return all.filter((r) => st.selection.has(r.nmID));
      case 'edited': return all.filter((r) => editing && editing.has(r.nmID));
      case 'filtered': return S.filtered();
      case 'loss': return all.filter((r) => r.profit < 0);
      case 'low': return all.filter((r) => r.profit >= 0 && r.margin < U.num(st.settings.minMarginPctAlert));
      case 'illiquid': case 'badturn': return all.filter((r) => r.stock > 0 && r.turnoverDays > 90);
      default: return S.filtered();
    }
  }

  /**
   * Собрать план массовой переценки: старые и новые цены, прибыль, маржа,
   * предупреждения и пометка «карантин» (WB не примет цену ниже трети прежней).
   *
   * @param {object} o { rows, rule, edits:Map, settings }
   * @returns {{plan:Array, changed:Array, risky:Array, quarantined:Array, deltaProfit:number}}
   */
  function buildPlan(o) {
    const opts = o || {};
    const st = S.state;
    const settings = opts.settings || st.settings;
    const rule = normalize(opts.rule);
    const edits = opts.edits;
    const targets = opts.rows || [];
    const plan = [];

    for (const r of targets) {
      const ov = st.overrides[String(r.nmID)] || {};
      const manual = edits ? edits.get(r.nmID) : null;
      let base = manual ? U.num(manual.basePrice, r.basePrice) : U.num(r.basePrice);
      let disc = manual ? U.num(manual.discount, r.discount) : U.num(r.discount);

      // ВАЖНО: ручная правка важнее массового правила.
      // Раньше правило применялось поверх введённого вручную значения, и поскольку
      // правило по умолчанию — «изменить итоговую цену на −5%», введённая цена
      // молча заменялась расчётной. Пользователь видел, что цены «не сохраняются».
      const ruleActive = rule.type && rule.type !== 'none';
      const applied = (!manual && ruleActive) ? EC.applyRule(settings, r.item, ov, rule) : null;
      if (applied && rule.type !== 'set-base') { base = applied.basePrice; disc = applied.discountPct; }
      else if (applied && rule.type === 'set-base') { base = applied.basePrice; }

      disc = Math.max(0, Math.min(95, U.num(disc)));
      base = Math.max(1, Math.round(U.num(base)));
      if (rule.minPrice > 0) {
        const seller = base * (1 - disc / 100);
        if (seller < rule.minPrice && base > rule.minPrice) disc = Math.max(0, Math.round((1 - rule.minPrice / base) * 1000) / 10);
      }

      const a = EC.analyze(settings, r.item, ov, { basePrice: base, discountPct: disc });
      const newSeller = a.next.revenue;
      const oldSeller = r.sellerPrice;
      const warnings = [];
      if (oldSeller > 0 && newSeller < oldSeller / 3) warnings.push('карантин цены WB (>3× вниз)');
      const maxChange = U.num(settings.maxPriceChangePct);
      if (maxChange && oldSeller > 0 && Math.abs((newSeller - oldSeller) / oldSeller) * 100 > maxChange) warnings.push(`изменение > ${maxChange}%`);
      if (a.next.profit < 0) warnings.push('убыток после изменения');
      else if (a.next.marginPct < U.num(settings.minMarginPctAlert)) warnings.push('маржа ниже порога');

      plan.push({
        nmID: r.nmID, vendorCode: r.vendorCode, title: r.title,
        oldBase: r.basePrice, oldDisc: r.discount, oldSeller,
        newBase: base, newDisc: disc, newSeller,
        oldProfit: r.profit, newProfit: a.next.profit,
        oldMargin: r.margin, newMargin: a.next.marginPct,
        changePct: oldSeller ? ((newSeller - oldSeller) / oldSeller) * 100 : 0,
        source: manual ? 'manual' : (ruleActive ? 'rule' : 'none'),
        warnings, skipped: warnings.includes('карантин цены WB (>3× вниз)')
      });
    }

    return summarize(plan);
  }

  /** Итоги плана: изменившиеся, рискованные, карантин и суммарная Δ прибыли. */
  function summarize(plan) {
    const list = plan || [];
    return {
      plan: list,
      changed: list.filter((p) => Math.abs(p.newSeller - p.oldSeller) > 0.5 || p.newBase !== p.oldBase),
      risky: list.filter((p) => p.warnings.length),
      quarantined: list.filter((p) => p.skipped),
      deltaProfit: U.sum(list, (p) => p.newProfit - p.oldProfit)
    };
  }

  return { TYPES, DEFAULTS, normalize, typeLabel, valueTitle, scopeRows, buildPlan, summarize };
})();
