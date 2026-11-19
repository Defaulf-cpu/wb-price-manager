'use strict';

/** Отдельный калькулятор цены: категория, ручные ставки, ROI и полный итог без отправки в WB. */
window.Views = window.Views || {};

Views.calculator = {
  title: 'Калькулятор',
  subtitle: 'Цена, комиссия категории, дополнительные расходы, маржа и ROI — локальный расчёт без изменения товаров',

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
        qtyDay: 1, targetMargin: U.num(s.targetMarginPct, 20)
      };
    }
    const d = this.data;
    const categories = [...new Set([...(S.categories ? S.categories() : []), ...Object.keys(s.categoryDefaults || {})])].sort((a, b) => a.localeCompare(b, 'ru'));
    if (d.category && !categories.includes(d.category)) categories.unshift(d.category);
    container.innerHTML = `
      <div class="alert info">Выберите категорию — комиссия, реклама, упаковка и тариф логистики подставятся из справочника категорий. Каждое значение можно изменить вручную; расчёт ничего не сохраняет в товары и не отправляет в WB.</div>
      <div class="grid g2" style="margin-top:12px;align-items:start">
        <div class="card"><h2>Исходные данные</h2><div class="grid g2" style="gap:10px">
          <label class="field">Категория WB<select id="calc-category"><option value="">Без категории — общие настройки</option>${categories.map((c) => `<option value="${U.esc(c)}" ${c === d.category ? 'selected' : ''}>${U.esc(c)}</option>`).join('')}</select></label>
          <label class="field">Налоговый режим<select id="calc-tax">${EC.TAX_MODES.map((m) => `<option value="${m.id}">${U.esc(m.label)}</option>`).join('')}</select></label>
          <label class="field">Базовая цена, ₽<input type="number" class="num" id="calc-base" min="0" step="0.01" value="${d.basePrice}"></label>
          <label class="field">Скидка продавца, %<input type="number" class="num" id="calc-discount" min="0" max="95" step="0.1" value="${d.discount}"></label>
          <label class="field">Себестоимость, ₽<input type="number" class="num" id="calc-cost" min="0" step="0.01" value="${d.costPrice}"></label>
          <label class="field">Объём, л<input type="number" class="num" id="calc-volume" min="0" step="0.1" value="${d.volume}"></label>
          <label class="field">Комиссия WB, %<input type="number" class="num calc-rate" id="calc-commission" min="0" max="100" step="0.1"></label>
          <label class="field">Логистика, ₽/шт<input type="number" class="num" id="calc-logistics" min="0" step="0.01"></label>
          <label class="field">Хранение, ₽/шт<input type="number" class="num calc-rate" id="calc-storage" min="0" step="0.01"></label>
          <label class="field">Упаковка, ₽/шт<input type="number" class="num calc-rate" id="calc-packaging" min="0" step="0.01"></label>
          <label class="field">Приёмка, ₽/шт<input type="number" class="num calc-rate" id="calc-accept" min="0" step="0.01"></label>
          <label class="field">Реклама, %<input type="number" class="num calc-rate" id="calc-ad-pct" min="0" max="100" step="0.1"></label>
          <label class="field">Реклама, ₽/шт<input type="number" class="num" id="calc-ad-rub" min="0" step="0.01" value="0"></label>
          <label class="field">Эквайринг, %<input type="number" class="num calc-rate" id="calc-acquiring" min="0" max="100" step="0.1"></label>
          <label class="field">Прочие расходы, % от цены до СПП<input type="number" class="num" id="calc-other-pct" min="0" max="99" step="0.01" value="0"></label>
          <label class="field">Прочие расходы, ₽/шт<input type="number" class="num" id="calc-other-rub" min="0" step="0.01" value="0"></label>
          <label class="field">СПП, %<input type="number" class="num" id="calc-spp" min="0" max="100" step="0.1" value="${d.spp}"></label>
          <label class="field">Скидка карты WB / кошелька, %<input type="number" class="num" id="calc-wallet" min="0" max="100" step="0.1" value="${d.wallet}"></label>
          <label class="field">Продажи, шт/день<input type="number" class="num" id="calc-qty" min="0" step="0.1" value="${d.qtyDay}"></label>
          <label class="field">Целевая маржа, %<input type="number" class="num" id="calc-target" min="-100" max="99" step="0.1" value="${d.targetMargin}"></label>
        </div><div class="row wrap" style="margin-top:12px"><button class="btn" id="calc-apply-category">Подставить категорию заново</button><button class="btn btn-ghost" id="calc-reset">Сбросить</button></div>
        <p class="hint" id="calc-source" style="margin-top:8px"></p></div>
        <div class="card"><h2>Итог расчёта</h2><div id="calc-out"></div></div>
      </div>`;
    const $ = (id) => container.querySelector(id);
    const num = (id) => U.num($(id).value);
    let logisticsAuto = true;
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
      $('#calc-acquiring').value = s.acquiringPct ?? 0;
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
        taxMode, taxRatePct: taxDetails.effectiveRate, taxDetails,
        logisticsBaseRub: U.num(s.logisticsBaseRub), logisticsPerLiterRub: U.num(s.logisticsPerLiterRub),
        literThreshold: U.num(s.literThreshold, 5), logisticsLargeRub: U.num(s.logisticsLargeRub)
      };
    };
    const draw = () => {
      const p = params();
      Object.assign(this.data, { category: p.categoryName, basePrice: p.basePrice, discount: p.discountPct, costPrice: p.costPriceRub, volume: p.volumeLiters, spp: p.sppPct, wallet: num('#calc-wallet'), qtyDay: num('#calc-qty'), targetMargin: num('#calc-target') });
      const seller = p.basePrice * (1 - p.discountPct / 100);
      const c = EC.calcUnit(seller, p);
      const sppPrice = seller * (1 - p.sppPct / 100);
      const walletPrice = sppPrice * (1 - num('#calc-wallet') / 100);
      const combined = seller > 0 ? (1 - walletPrice / seller) * 100 : 0;
      const roi = p.costPriceRub > 0 ? c.profit / p.costPriceRub * 100 : 0;
      const costReturn = c.totalCosts > 0 ? c.profit / c.totalCosts * 100 : 0;
      const targetPrice = EC.calcPriceForMarginPct(p, num('#calc-target'));
      const qty = num('#calc-qty');
      const lines = [
        ['Базовая цена', U.money(p.basePrice)], ['Скидка продавца', U.pct(p.discountPct) + ' · −' + U.money(p.basePrice - seller)],
        ['Цена до СПП (для WB)', '<b>' + U.money(seller) + '</b>'], ['Цена с СПП', U.money(sppPrice)],
        ['Цена по карте WB', U.money(walletPrice)], ['СПП + карта суммарно', U.pct(combined)],
        ['Комиссия WB', '−' + U.money(c.commission)], ['Логистика', '−' + U.money(c.logistics)],
        ['Хранение / приёмка / упаковка', '−' + U.money(c.storage + c.accept + c.packaging)],
        ['Реклама', '−' + U.money(c.ad)], ['Эквайринг', '−' + U.money(c.acquiring)],
        ['Налог (расчётная нагрузка)', '−' + U.money(c.tax)], ['Прочие расходы', '−' + U.money(c.other)],
        ['Себестоимость', '−' + U.money(c.cogs)], ['Все расходы и себестоимость', '−' + U.money(c.totalCosts)],
        ['Прибыль до налога', U.money(c.profitBeforeTax)], ['Прибыль с единицы', '<b class="' + U.profitClass(c.profit) + '">' + U.money(c.profit) + '</b>'],
        ['Маржа', '<b class="' + U.profitClass(c.marginPct) + '">' + U.pct(c.marginPct) + '</b>'],
        ['ROI по себестоимости', U.pct(roi)], ['Рентабельность всех затрат', U.pct(costReturn)],
        ['Наценка к себестоимости по цене продажи', U.pct(p.costPriceRub > 0 ? (seller - p.costPriceRub) / p.costPriceRub * 100 : 0)], ['Цена безубыточности (до СПП)', c.breakEvenPrice === null ? 'недостижима при этих ставках' : U.money(c.breakEvenPrice)],
        ['Цена для целевой маржи', targetPrice === null ? 'недостижима при этих ставках' : U.money(targetPrice)],
        ['Запас до безубыточности', c.breakEvenPrice ? U.pct((seller - c.breakEvenPrice) / seller * 100) : '—'],
        ['Выручка в день / 30 дней', U.money(seller * qty) + ' / ' + U.money(seller * qty * 30)],
        ['Прибыль в день / 30 дней', U.money(c.profit * qty) + ' / ' + U.money(c.profit * qty * 30)]
      ];
      $('#calc-out').innerHTML = '<div class="calc-lines">' + lines.map(([k, v]) => `<div class="calc-line"><span class="k">${U.esc(k)}</span><span>${v}</span></div>`).join('') + '</div>' +
        '<p class="hint" style="margin-top:10px">СПП и карта WB показывают цену покупателя и не вычитаются из выплаты продавца второй раз. Прибыль и маржа считаются от цены до СПП после комиссии, логистики, рекламы, налога, прочих расходов и себестоимости.</p>';
    };
    container.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => { if (el.id === 'calc-logistics') logisticsAuto = false; if ((el.id === 'calc-volume') && logisticsAuto) updateLogistics(); draw(); });
      el.addEventListener('change', () => { if (el.id === 'calc-category') applyCategory(); });
    });
    $('#calc-apply-category').onclick = applyCategory;
    $('#calc-reset').onclick = () => { this.data = null; this.render(container); };
    applyCategory();
  }
};
