'use strict';

/** Отдельный калькулятор цены: категория, ручные ставки, ROI и полный итог без отправки в WB. */
window.Views = window.Views || {};

Views.calculator = {
  title: 'Калькулятор',
  subtitle: 'Цена, комиссия категории, выкуп, возвраты, брак, налоги, маржа и ROI — локальный расчёт без изменения товаров',

  render(container) {
    this.container = container;
    const s = S.state.settings || {};
    const rows = S.getRows ? S.getRows() : [];
    const first = rows[0] || {};
    if (!this.data) {
      this.data = {
        category: first.category || Object.keys(s.categoryDefaults || {})[0] || '',
        basePrice: U.num(first.basePrice, 2490), discount: U.num(first.discount, 35),
        costPrice: U.num(first.costPrice, 620), volume: U.num(first.volume, 1),
        spp: U.num(first.spp, U.num(s.sppDefault)), wallet: U.num(s.walletPct || (s.priceEdit || {}).walletPct || 0),
        qtyDay: 1, targetMargin: U.num(s.targetMarginPct, 20), targetProfit: 0, shelfPrice: 0,
        buyoutPct: 90, returnLogisticsRub: 50, defectPct: 1,
        repackReturns: false, purchaseWithVat: false, useProfitTax: false
      };
    }
    const d = this.data;
    const taxModes = EC.TAX_MODES.concat([
      { id: 'osno_vat22_credit', label: 'ОСНО (НДС 22% с вычетом входного НДС)' },
      { id: 'usn6_vat5', label: 'УСН «Доходы» 6% + НДС 5%' },
      { id: 'usn6_vat7', label: 'УСН «Доходы» 6% + НДС 7%' }
    ]);
    const categories = [...new Set([...(S.categories ? S.categories() : []), ...Object.keys(s.categoryDefaults || {})])].sort((a, b) => a.localeCompare(b, 'ru'));
    if (d.category && !categories.includes(d.category)) categories.unshift(d.category);
    const warehouseTip = 'Введите значение уже с учётом актуального коэффициента склада (КЛ/КХ) или индекса локализации.';
    container.innerHTML = `
      <div class="alert info">Выберите категорию — комиссия, реклама, упаковка и тариф логистики подставятся из справочника категорий. Каждое значение можно изменить вручную; расчёт ничего не сохраняет в товары и не отправляет в WB.</div>
      <div class="grid g2 calc-layout" style="margin-top:12px;align-items:start">
        <div class="card calc-input-panel"><div class="spread"><h2>Исходные данные</h2><button class="btn btn-ghost btn-sm" id="calc-toggle-inputs" type="button">Свернуть</button></div><div id="calc-collapsed-summary" class="calc-collapsed-summary" hidden></div><div id="calc-inputs"><div class="grid g2" style="gap:10px">
          <label class="field">Категория WB<select id="calc-category"><option value="">Без категории — общие настройки</option>${categories.map((c) => `<option value="${U.esc(c)}" ${c === d.category ? 'selected' : ''}>${U.esc(c)}</option>`).join('')}</select></label>
          <label class="field">Налоговый режим<select id="calc-tax">${taxModes.map((m) => `<option value="${m.id}">${U.esc(m.label)}</option>`).join('')}</select></label>
          <label class="field">Базовая цена, ₽<input type="number" class="num" id="calc-base" min="0" step="0.01" value="${d.basePrice}"></label>
          <label class="field">Скидка продавца, %<input type="number" class="num" id="calc-discount" min="0" max="95" step="0.1" value="${d.discount}"></label>
          <label class="field">Себестоимость, ₽<input type="number" class="num" id="calc-cost" min="0" step="0.01" value="${d.costPrice}"></label>
          <label class="field">Объём, л<input type="number" class="num" id="calc-volume" min="0" step="0.1" value="${d.volume}"></label>
          <label class="field">Комиссия WB, %<input type="number" class="num calc-rate" id="calc-commission" min="0" max="100" step="0.1"></label>
          <label class="field" title="${warehouseTip}">Логистика, ₽/шт<input type="number" class="num" id="calc-logistics" min="0" step="0.01" title="${warehouseTip}"></label>
          <label class="field" title="${warehouseTip}">Хранение, ₽/шт<input type="number" class="num calc-rate" id="calc-storage" min="0" step="0.01" title="${warehouseTip}"></label>
          <label class="field">Упаковка, ₽/шт<input type="number" class="num calc-rate" id="calc-packaging" min="0" step="0.01"></label>
          <label class="field">Приёмка, ₽/шт<input type="number" class="num calc-rate" id="calc-accept" min="0" step="0.01"></label>
          <label class="field">Процент выкупа, %<input type="number" class="num" id="calc-buyout" min="1" max="100" step="0.1" value="${d.buyoutPct}"></label>
          <label class="field">Обратная логистика (возврат), ₽<input type="number" class="num" id="calc-return-logistics" min="0" step="0.01" value="${d.returnLogisticsRub}"></label>
          <label class="checkline"><input type="checkbox" id="calc-repack" ${d.repackReturns ? 'checked' : ''}> Переупаковка при возврате</label>
          <label class="field">Процент брака / утери, %<input type="number" class="num" id="calc-defect" min="0" max="100" step="0.1" value="${d.defectPct}"></label>
          <label class="field">Реклама, %<input type="number" class="num calc-rate" id="calc-ad-pct" min="0" max="100" step="0.1"></label>
          <label class="field">Реклама, ₽/шт<input type="number" class="num" id="calc-ad-rub" min="0" step="0.01" value="0"></label>
          <label class="field">Эквайринг, % от цены после СПП<input type="number" class="num calc-rate" id="calc-acquiring" min="0" max="100" step="0.1"></label>
          <label class="field">Прочие расходы, % от цены до СПП<input type="number" class="num" id="calc-other-pct" min="0" max="99" step="0.01" value="0"></label>
          <label class="field">Прочие расходы, ₽/шт<input type="number" class="num" id="calc-other-rub" min="0" step="0.01" value="0"></label>
          <label class="field">СПП, %<input type="number" class="num" id="calc-spp" min="0" max="100" step="0.1" value="${d.spp}"></label>
          <label class="field">Желаемая цена на полке, ₽<input type="number" class="num" id="calc-shelf" min="0" step="0.01" value="${d.shelfPrice || ''}" placeholder="0 — считать от базовой цены"></label>
          <label class="checkline"><input type="checkbox" id="calc-purchase-vat" ${d.purchaseWithVat ? 'checked' : ''}> Закупка с НДС (для вычета в ОСНО)</label>
          <label class="checkline"><input type="checkbox" id="calc-profit-tax" ${d.useProfitTax ? 'checked' : ''}> Учитывать налог на прибыль 25% (ОСНО)</label>
          <label class="field">Продажи, шт/день<input type="number" class="num" id="calc-qty" min="0" step="0.1" value="${d.qtyDay}"></label>
          <label class="field">Целевая маржа, %<input type="number" class="num" id="calc-target" min="-100" max="99" step="0.1" value="${d.targetMargin}"></label>
          <label class="field">Целевая прибыль, ₽/шт<input type="number" class="num" id="calc-target-profit" step="0.01" value="${d.targetProfit}"></label>
        </div>
        <p class="hint" style="margin-top:8px">Если «Желаемая цена на полке» больше 0, весь расчёт идёт от неё: калькулятор сам выведет цену продавца до СПП и базовую цену, которую нужно поставить. Если поле пустое или 0 — расчёт идёт от базовой цены.</p>
        <div class="row wrap" style="margin-top:12px"><button class="btn btn-primary" id="calc-solve" type="button">Рассчитать нужную цену</button><button class="btn" id="calc-apply-category" type="button">Подставить категорию заново</button><button class="btn btn-ghost" id="calc-reset" type="button">Сбросить</button></div>
        <div id="calc-reverse-out" style="margin-top:10px"></div>
        <p class="hint" id="calc-source" style="margin-top:8px"></p></div></div>
        <div class="card calc-result-panel"><h2>Итог расчёта</h2><div id="calc-out"></div></div>
      </div>`;
    const $ = (id) => container.querySelector(id);
    const num = (id) => U.num($(id).value);
    let logisticsAuto = true;
    let reverseShown = false;
    let inputsCollapsed = false;
    try { inputsCollapsed = localStorage.getItem('wb.calculator.inputsCollapsed') === '1'; } catch (_) { /* хранилище недоступно */ }
    const setInputsCollapsed = (value) => {
      inputsCollapsed = !!value;
      container.querySelector('.calc-layout').classList.toggle('inputs-collapsed', inputsCollapsed);
      $('#calc-inputs').hidden = inputsCollapsed;
      $('#calc-collapsed-summary').hidden = !inputsCollapsed;
      const button = $('#calc-toggle-inputs');
      button.textContent = inputsCollapsed ? 'Развернуть' : 'Свернуть';
      button.title = inputsCollapsed ? 'Показать исходные данные' : 'Свернуть исходные данные до компактного блока';
      try { localStorage.setItem('wb.calculator.inputsCollapsed', inputsCollapsed ? '1' : '0'); } catch (_) { /* не критично */ }
    };
    const applyCategory = () => {
      const cat = $('#calc-category').value;
      const def = (s.categoryDefaults || {})[cat] || {};
      const taxMode = def.taxMode && def.taxMode !== 'inherit' ? def.taxMode : (s.taxMode || 'usn6');
      $('#calc-tax').value = taxMode;
      $('#calc-commission').value = def.commissionPct ?? s.commissionDefault ?? 0;
      $('#calc-ad-pct').value = def.adPct ?? s.adPctDefault ?? 0;
      $('#calc-packaging').value = def.packagingRub ?? s.packagingRub ?? 0;
      $('#calc-storage').value = s.storageRubPerUnit ?? 0;
      $('#calc-accept').value = s.acceptRub ?? 0;
      $('#calc-acquiring').value = U.num(s.acquiringPct) || 1.5;
      const p = { volumeLiters: num('#calc-volume'), logisticsRub: 0,
        logisticsBaseRub: def.logisticsBaseRub ?? s.logisticsBaseRub ?? 0,
        logisticsPerLiterRub: def.logisticsPerLiterRub ?? s.logisticsPerLiterRub ?? 0,
        literThreshold: def.literThreshold ?? s.literThreshold ?? 5,
        logisticsLargeRub: def.logisticsLargeRub ?? s.logisticsLargeRub ?? 0 };
      $('#calc-logistics').value = EC.calcLogistics(p);
      logisticsAuto = true;
      $('#calc-source').textContent = cat ? 'Категория «' + cat + '»: комиссия и ставки подставлены из справочника, их можно править вручную.' : 'Категории нет: использованы общие настройки приложения.';
      draw();
    };
    const updateLogistics = () => {
      const cat = $('#calc-category').value, def = (s.categoryDefaults || {})[cat] || {};
      $('#calc-logistics').value = EC.calcLogistics({ volumeLiters: num('#calc-volume'), logisticsRub: 0,
        logisticsBaseRub: def.logisticsBaseRub ?? s.logisticsBaseRub ?? 0,
        logisticsPerLiterRub: def.logisticsPerLiterRub ?? s.logisticsPerLiterRub ?? 0,
        literThreshold: def.literThreshold ?? s.literThreshold ?? 5,
        logisticsLargeRub: def.logisticsLargeRub ?? s.logisticsLargeRub ?? 0 });
    };
    const params = () => {
      const taxMode = $('#calc-tax').value;
      const taxDetails = EC.resolveTax(s, taxMode);
      return {
        categoryName: $('#calc-category').value, basePrice: num('#calc-base'), discountPct: num('#calc-discount'),
        costPriceRub: num('#calc-cost'), volumeLiters: num('#calc-volume'), sppPct: num('#calc-spp'),
        commissionPct: num('#calc-commission'), logisticsRub: num('#calc-logistics'), storageRub: num('#calc-storage'),
        packagingRub: num('#calc-packaging'), acceptRub: num('#calc-accept'), adPct: num('#calc-ad-pct'), adRub: num('#calc-ad-rub'),
        acquiringPct: num('#calc-acquiring'), otherPct: num('#calc-other-pct'), otherRub: num('#calc-other-rub'),
        buyoutPct: Math.min(100, Math.max(1, num('#calc-buyout') || 100)), returnLogisticsRub: num('#calc-return-logistics'),
        repackReturns: $('#calc-repack').checked, defectPct: num('#calc-defect'),
        purchaseWithVat: $('#calc-purchase-vat').checked, useProfitTax: $('#calc-profit-tax').checked,
        taxMode, taxRatePct: taxDetails.effectiveRate, taxDetails,
        logisticsBaseRub: U.num(s.logisticsBaseRub), logisticsPerLiterRub: U.num(s.logisticsPerLiterRub),
        literThreshold: U.num(s.literThreshold, 5), logisticsLargeRub: U.num(s.logisticsLargeRub)
      };
    };
    const compute = (sellerPrice, p) => {
      const seller = Math.max(0, U.num(sellerPrice));
      const buyout = Math.min(100, Math.max(1, U.num(p.buyoutPct, 100))) / 100;
      const directLogistics = U.num(p.logisticsRub);
      const logistics = directLogistics / buyout + U.num(p.returnLogisticsRub) * (1 - buyout) / buyout;
      const packaging = p.repackReturns ? U.num(p.packagingRub) / buyout : U.num(p.packagingRub);
      const sppPrice = seller * (1 - U.num(p.sppPct) / 100);
      const commission = seller * U.num(p.commissionPct) / 100;
      const ad = seller * U.num(p.adPct) / 100 + U.num(p.adRub);
      const acquiring = sppPrice * U.num(p.acquiringPct) / 100;
      const other = seller * U.num(p.otherPct) / 100 + U.num(p.otherRub);
      const cogs = U.num(p.costPriceRub);
      const defectLoss = (cogs + U.num(p.packagingRub)) * U.num(p.defectPct) / 100;
      const storage = U.num(p.storageRub), accept = U.num(p.acceptRub);
      const expenses = commission + logistics + storage + accept + packaging + ad + acquiring + other + cogs + defectLoss;
      const profitBeforeTax = seller - expenses;
      let outgoingVat = 0, inputVat = 0, vatPayable = 0, profitTax = 0, tax;
      if (p.taxMode === 'osno_vat22_credit') {
        const k = 22 / 122;
        outgoingVat = seller * k;
        const vatExpenses = commission + logistics + ad + storage + packaging + (p.purchaseWithVat ? cogs : 0);
        inputVat = vatExpenses * k;
        vatPayable = outgoingVat - inputVat;
        const taxableProfit = profitBeforeTax - vatPayable;
        profitTax = p.useProfitTax ? Math.max(0, taxableProfit) * 0.25 : 0;
        tax = vatPayable + profitTax;
      } else if (p.taxMode === 'usn6_vat5' || p.taxMode === 'usn6_vat7') {
        const vatRate = p.taxMode === 'usn6_vat5' ? 5 : 7;
        const vatEffective = vatRate / (100 + vatRate);
        tax = seller * (vatEffective + 0.06 * (1 - vatEffective));
        outgoingVat = seller * vatEffective; vatPayable = outgoingVat;
      } else {
        tax = seller * U.num(p.taxRatePct) / 100;
      }
      const profit = profitBeforeTax - tax;
      const totalCosts = expenses + tax;
      return { seller, sppPrice, directLogistics, logistics, packaging, commission, ad, acquiring, other, cogs,
        defectLoss, storage, accept, expenses, profitBeforeTax, outgoingVat, inputVat, vatPayable, profitTax, tax,
        totalCosts, profit, marginPct: seller > 0 ? profit / seller * 100 : 0 };
    };
    const solvePrice = (p, goal) => {
      const value = (price) => goal(compute(price, p), price);
      if (value(0) >= 0) return 0;
      let hi = Math.max(1000, p.basePrice * 2, 1000);
      while (value(hi) < 0 && hi < 1e12) hi *= 2;
      if (value(hi) < 0) return null;
      let lo = 0;
      for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (value(mid) >= 0) hi = mid; else lo = mid; }
      return hi;
    };
    const draw = () => {
      const p = params();
      Object.assign(this.data, { category: p.categoryName, basePrice: p.basePrice, discount: p.discountPct, costPrice: p.costPriceRub, volume: p.volumeLiters, spp: p.sppPct, shelfPrice: num('#calc-shelf'), qtyDay: num('#calc-qty'), targetMargin: num('#calc-target'), targetProfit: num('#calc-target-profit'), buyoutPct: p.buyoutPct, returnLogisticsRub: p.returnLogisticsRub, defectPct: p.defectPct, repackReturns: p.repackReturns, purchaseWithVat: p.purchaseWithVat, useProfitTax: p.useProfitTax });
      const osno = p.taxMode === 'osno_vat22_credit';
      $('#calc-purchase-vat').disabled = !osno; $('#calc-profit-tax').disabled = !osno;
      const shelfSet = num('#calc-shelf');
      if (shelfSet > 0 && p.sppPct >= 100) { $('#calc-out').innerHTML = '<div class="alert warn">При СПП 100% и выше цену продавца от цены на полке вывести нельзя. Уменьшите СПП.</div>'; return; }
      let seller, calcBase;
      if (shelfSet > 0) { seller = shelfSet / (1 - p.sppPct / 100); calcBase = seller / (1 - p.discountPct / 100); }
      else { calcBase = p.basePrice; seller = calcBase * (1 - p.discountPct / 100); }
      const c = compute(seller, p);
      $('#calc-collapsed-summary').innerHTML = '<b>Калькулятор свёрнут</b><br>' + U.esc(p.categoryName || 'Без категории') + '<br>База: ' + U.money(calcBase) + '<br>Покупателю: ' + U.money(c.sppPrice) + '<br>СПП: ' + U.pct(p.sppPct);
      const roi = p.costPriceRub > 0 ? c.profit / p.costPriceRub * 100 : 0;
      const costReturn = c.totalCosts > 0 ? c.profit / c.totalCosts * 100 : 0;
      const breakEvenPrice = solvePrice(p, (x) => x.profit);
      const targetPrice = solvePrice(p, (x, price) => x.profit - price * num('#calc-target') / 100);
      const targetProfitPrice = solvePrice(p, (x) => x.profit - num('#calc-target-profit'));
      const qty = num('#calc-qty');
      const expense = (v) => v < 0 ? '+' + U.money(-v) : '−' + U.money(v);
      const priceLine = (price) => price === null ? 'недостижима при этих ставках' : U.money(price) + (p.discountPct < 100 ? ' · базовая ' + U.money(price / (1 - p.discountPct / 100)) : '');
      const renderLines = (rows) => '<div class="calc-lines">' + rows.map(([k, v]) => `<div class="calc-line"><span class="k">${U.esc(k)}</span><span>${v}</span></div>`).join('') + '</div>';
      const section = (title, rows) => '<details class="calc-cat"><summary>' + U.esc(title) + '</summary>' + renderLines(rows) + '</details>';
      const kpis = '<div class="calc-kpis">' +
        '<div class="calc-kpi accent"><span>Базовая цена — какую ставить</span><b>' + U.money(calcBase) + '</b></div>' +
        '<div class="calc-kpi accent"><span>Цена для покупателя</span><b>' + U.money(c.sppPrice) + '</b><small>с СПП и скидкой продавца</small></div>' +
        '<div class="calc-kpi"><span>Маржа на выходе, ₽</span><b class="' + U.profitClass(c.profit) + '">' + U.money(c.profit) + '</b></div>' +
        '<div class="calc-kpi"><span>Маржа на выходе, %</span><b class="' + U.profitClass(c.marginPct) + '">' + U.pct(c.marginPct) + '</b></div>' +
        '<div class="calc-kpi"><span>ROI</span><b class="' + U.profitClass(roi) + '">' + U.pct(roi) + '</b></div>' +
        '</div>';
      $('#calc-out').innerHTML = kpis +
        section('Цены', [
          ['Режим расчёта', shelfSet > 0 ? 'от желаемой цены на полке' : 'от базовой цены'],
          ['Желаемая цена на полке', shelfSet > 0 ? U.money(shelfSet) : 'не задана'],
          ['Базовая цена (расчётная)', U.money(calcBase)], ['Скидка продавца', U.pct(p.discountPct) + ' · −' + U.money(calcBase - seller)],
          ['Цена до СПП (для WB)', '<b>' + U.money(seller) + '</b>'], ['Цена для покупателя (с СПП)', U.money(c.sppPrice)]
        ]) +
        section('Комиссии и удержания WB', [
          ['Комиссия WB', '−' + U.money(c.commission)], ['Прямая логистика', '−' + U.money(c.directLogistics)],
          ['Эффективная логистика на 1 выкуп', '−' + U.money(c.logistics)], ['Хранение', '−' + U.money(c.storage)],
          ['Приёмка', '−' + U.money(c.accept)], ['Упаковка эффективная', '−' + U.money(c.packaging)],
          ['Эквайринг (от цены после СПП)', '−' + U.money(c.acquiring)]
        ]) +
        section('Прочие расходы и налоги', [
          ['Реклама', '−' + U.money(c.ad)], ['Брак / утери', '−' + U.money(c.defectLoss)], ['Прочие расходы', '−' + U.money(c.other)],
          ...(osno ? [['Исходящий НДС 22%', '−' + U.money(c.outgoingVat)], ['Входящий НДС к вычету', '+' + U.money(c.inputVat)], ['НДС к уплате', expense(c.vatPayable)], ['Налог на прибыль 25%', '−' + U.money(c.profitTax)]] : []),
          ['Налог (расчётная нагрузка)', expense(c.tax)], ['Себестоимость', '−' + U.money(c.cogs)],
          ['Все расходы и себестоимость', '−' + U.money(c.totalCosts)], ['Рентабельность всех затрат', U.pct(costReturn)],
          ['Наценка к себестоимости по цене продажи', U.pct(p.costPriceRub > 0 ? (seller - p.costPriceRub) / p.costPriceRub * 100 : 0)]
        ]) +
        section('Итоги и подбор цены', [
          ['Прибыль до налога', U.money(c.profitBeforeTax)], ['Прибыль с единицы', '<b class="' + U.profitClass(c.profit) + '">' + U.money(c.profit) + '</b>'],
          ['Маржа', '<b class="' + U.profitClass(c.marginPct) + '">' + U.pct(c.marginPct) + '</b>'], ['ROI по себестоимости', U.pct(roi)],
          ['Цена безубыточности (до СПП)', breakEvenPrice === null ? 'недостижима при этих ставках' : U.money(breakEvenPrice)],
          ['Цена для целевой маржи', priceLine(targetPrice)], ['Цена для целевой прибыли', priceLine(targetProfitPrice)],
          ['Запас до безубыточности', breakEvenPrice ? U.pct((seller - breakEvenPrice) / seller * 100) : '—'],
          ['Выручка в день / 30 дней', U.money(seller * qty) + ' / ' + U.money(seller * qty * 30)],
          ['Прибыль в день / 30 дней', U.money(c.profit * qty) + ' / ' + U.money(c.profit * qty * 30)]
        ]) +
        '<p class="hint" style="margin-top:10px">Главные показатели всегда сверху. Остальные данные сгруппированы по категориям ниже. Эффективная логистика учитывает выкуп и возвраты, эквайринг считается от цены после СПП; отдельная скидка карты/кошелька в калькуляторе больше не используется.</p>';
      if (reverseShown) {
        $('#calc-reverse-out').innerHTML = '<div class="alert ok"><b>Подобранная цена:</b><br>По целевой марже: ' + U.esc(priceLine(targetPrice)) + '<br>По целевой прибыли: ' + U.esc(priceLine(targetProfitPrice)) + '<br><span class="tiny">В расчёте учтены выкуп, возвраты, переупаковка, брак, эквайринг после СПП и выбранный налоговый режим.</span></div>';
      }
    };
    container.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => { if (el.id === 'calc-logistics') logisticsAuto = false; if ((el.id === 'calc-volume') && logisticsAuto) updateLogistics(); draw(); });
      el.addEventListener('change', () => { if (el.id === 'calc-category') applyCategory(); else draw(); });
    });
    $('#calc-toggle-inputs').onclick = () => setInputsCollapsed(!inputsCollapsed);
    $('#calc-solve').onclick = () => { reverseShown = true; draw(); };
    $('#calc-apply-category').onclick = applyCategory;
    $('#calc-reset').onclick = () => { this.data = null; this.render(container); };
    setInputsCollapsed(inputsCollapsed);
    applyCategory();
  }
};
