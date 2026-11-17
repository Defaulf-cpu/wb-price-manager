'use strict';

/** Экономика: симулятор «что если», подбор цены, сводка по магазину и категориям. */
window.Views = window.Views || {};

Views.economics = {
  title: 'Экономика',
  subtitle: 'Юнит-экономика, подбор цены под цель и симулятор изменений',

  render(container) {
    const st = S.state;
    this.container = container;
    this.sim = this.sim || { basePrice: 2490, discount: 35, commission: null, costPrice: 620, logistics: null, storage: null, packaging: null, adPct: null, taxMode: null, spp: null };

    container.innerHTML = `
      <div class="tabs" id="ec-tabs">
        <div class="tab active" data-t="summary">Сводка по магазину</div>
        <div class="tab" data-t="calc">Калькулятор цены</div>
        <div class="tab" data-t="scenario">Сценарии переценки</div>
      </div>
      <div id="ec-host"></div>
    `;
    container.querySelectorAll('#ec-tabs .tab').forEach((t) => {
      t.onclick = () => {
        container.querySelectorAll('#ec-tabs .tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        this.tab = t.dataset.t;
        this.draw();
      };
    });
    this.tab = 'summary';
    this.draw();
  },

  draw() {
    const host = this.container.querySelector('#ec-host');
    host.innerHTML = '';
    if (this.tab === 'summary') this.summary(host);
    else if (this.tab === 'calc') this.calc(host);
    else this.scenario(host);
  },

  // ─────────── Сводка ───────────
  summary(host) {
    const st = S.state;
    const rows = S.getRows(true);
    const t = S.totals(rows);
    const s = st.settings;

    const cats = Array.from(U.groupBy(rows, (r) => r.category || 'Без категории')).map(([cat, list]) => {
      const sales = U.sum(list, (r) => r.sales30);
      const rev = U.sum(list, (r) => r.revenue30);
      const prof = U.sum(list, (r) => r.profit30);
      const avgMargin = list.length ? U.sum(list, (r) => r.margin) / list.length : 0;
      const loss = list.filter((r) => r.profit < 0).length;
      return { cat, count: list.length, sales, rev, prof, margin: rev ? (prof / rev) * 100 : 0, avgMargin, loss };
    }).sort((a, b) => b.prof - a.prof);

    const structure = {
      'Комиссия WB': U.sum(rows, (r) => r.c.commission * r.sales30),
      'Логистика': U.sum(rows, (r) => r.c.logistics * r.sales30),
      'Реклама': U.sum(rows, (r) => r.c.ad * r.sales30),
      'Налог': U.sum(rows, (r) => r.c.tax * r.sales30),
      'Себестоимость': U.sum(rows, (r) => r.c.cogs * r.sales30),
      'Упаковка': U.sum(rows, (r) => r.c.packaging * r.sales30),
      'Хранение': U.sum(rows, (r) => r.c.storage * r.sales30),
      'Эквайринг': U.sum(rows, (r) => r.c.acquiring * r.sales30)
    };
    const maxS = Math.max(1, ...Object.values(structure));
    const totalCosts = U.sum(Object.values(structure), (x) => x);

    host.innerHTML = `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="card stat"><span class="label">Выручка (30 дней)</span><span class="value">${U.compact(t.revenue30)} ₽</span><span class="hint">${U.fmt(t.sales30)} продаж</span></div>
        <div class="card stat"><span class="label">Расходы и удержания</span><span class="value neg">${U.compact(totalCosts)} ₽</span><span class="hint">${revenuePct(totalCosts, t.revenue30)} выручки</span></div>
        <div class="card stat"><span class="label">Прибыль (30 дней)</span><span class="value ${U.profitClass(t.profit30)}">${U.compact(t.profit30)} ₽</span><span class="hint">маржа ${U.pct(t.margin30)}</span></div>
        <div class="card stat"><span class="label">Средняя маржа по позициям</span><span class="value ${U.profitClass(t.avgMargin)}">${U.pct(t.avgMargin)}</span><span class="hint">цель ${U.pct(s.targetMarginPct, 0)}</span></div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h2>Структура расходов за 30 дней</h2>
          <div class="bars">
            ${Object.entries(structure).map(([k, v]) => UI.bar(k, v, maxS, U.compact(v) + ' ₽ · ' + revenuePct(v, t.revenue30))).join('')}
          </div>
          <p class="hint" style="margin-top:10px">Расчёт по формуле: выплата = цена после скидки продавца − комиссия − логистика − хранение − реклама − налог − себестоимость.
          СПП (скидка постоянного покупателя) компенсируется Wildberries и из выплаты не вычитается.</p>
        </div>
        <div class="card">
          <h2>Распределение по маржинальности</h2>
          <div class="bars" id="margin-buckets"></div>
          <div class="divider"></div>
          <h2>Что сделать прямо сейчас</h2>
          <div class="col" id="recs"></div>
        </div>
      </div>

      <div class="card pad0">
        <div class="card-head" style="padding:14px 16px 0"><h2>Экономика по категориям</h2>
          <button class="btn btn-ghost btn-sm" id="ec-export">Экспорт CSV</button></div>
        <div style="padding:10px 16px 16px" id="cats-host"></div>
      </div>
    `;

    // распределение маржи
    const buckets = [
      { label: 'Убыток (< 0%)', test: (r) => r.margin < 0, kind: 'neg' },
      { label: `0 – ${U.num(s.minMarginPctAlert, 10)}%`, test: (r) => r.margin >= 0 && r.margin < U.num(s.minMarginPctAlert) },
      { label: `${U.num(s.minMarginPctAlert, 10)} – ${U.num(s.targetMarginPct, 20)}%`, test: (r) => r.margin >= U.num(s.minMarginPctAlert) && r.margin < U.num(s.targetMarginPct) },
      { label: `${U.num(s.targetMarginPct, 20)} – 35%`, test: (r) => r.margin >= U.num(s.targetMarginPct) && r.margin < 35 },
      { label: '35% и выше', test: (r) => r.margin >= 35 }
    ];
    const maxB = Math.max(1, ...buckets.map((b) => rows.filter(b.test).length));
    host.querySelector('#margin-buckets').innerHTML = buckets.map((b) => {
      const n = rows.filter(b.test).length;
      return UI.bar(b.label, n, maxB, `${n} тов.`, b.kind === 'neg');
    }).join('');

    // рекомендации
    const lossRows = rows.filter((r) => r.profit < 0).sort((a, b) => a.profit30 - b.profit30);
    const noCogs = rows.filter((r) => !r.costPrice);
    const illiquid = rows.filter((r) => r.stock > 0 && r.turnoverDays > 90);
    const fixable = lossRows.filter((r) => r.minPriceTarget && r.minPriceTarget <= r.basePrice);
    const recs = [];
    if (lossRows.length) recs.push(['danger', `<b>${lossRows.length}</b> товаров в убытке (−${U.compact(Math.abs(U.sum(lossRows, (r) => r.profit30)))} ₽ за 30 дней). У <b>${fixable.length}</b> из них убыток лечится снижением скидки до целевой маржи.`]);
    if (noCogs.length) recs.push(['info', `<b>${noCogs.length}</b> товаров без себестоимости — загрузите её в разделе «Себестоимость» (CSV), иначе экономика считается неверно.`]);
    if (illiquid.length) recs.push(['warn', `<b>${illiquid.length}</b> неликвидных позиций: деньги заморожены на ${U.compact(U.sum(illiquid, (r) => r.stock * r.costPrice))} ₽. Помогут акции или скидка 10–15%.`]);
    if (t.avgDiscount > 55) recs.push(['warn', `Средняя скидка ${U.pct(t.avgDiscount, 0)} — очень глубоко. Проверьте, не продаёте ли вы ниже рынка без нужды.`]);
    if (!recs.length) recs.push(['ok', 'Критичных проблем не найдено: все товары в плюсе и соответствуют целевой марже.']);
    host.querySelector('#recs').innerHTML = recs.map((r) => `<div class="alert ${r[0]}">${r[1]}</div>`).join('');

    // таблица категорий
    const grid = UI.table({
      columns: [
        { title: 'Категория', render: (c) => `<b>${U.esc(c.cat)}</b>` },
        { title: 'Товаров', num: true, value: (c) => U.fmt(c.count) },
        { title: 'Продажи 30д', num: true, value: (c) => U.fmt(c.sales) },
        { title: 'Выручка', num: true, render: (c) => U.compact(c.rev) + ' ₽' },
        { title: 'Прибыль', num: true, render: (c) => `<span class="${U.profitClass(c.prof)}">${U.compact(c.prof)} ₽</span>` },
        { title: 'Маржа', num: true, render: (c) => `<span class="${U.profitClass(c.margin)}">${U.pct(c.margin)}</span>` },
        { title: 'Убыточных', num: true, render: (c) => c.loss ? `<span class="neg">${c.loss}</span>` : '0' }
      ],
      rows: cats,
      empty: 'Нет данных'
    });
    host.querySelector('#cats-host').appendChild(grid.el);

    host.querySelector('#ec-export').onclick = () => {
      API.exportCsv(`wb-economics-${new Date().toISOString().slice(0, 10)}.csv`, U.toCsv(rows.map((r) => ({
        'нм-код': r.nmID, 'Артикул': r.vendorCode, 'Название': r.title, 'Категория': r.category,
        'Базовая цена': r.basePrice, 'Скидка %': r.discount, 'ЦенаWB': Math.round(r.sellerPrice),
        'Комиссия %': r.commission, 'Комиссия ₽': r.c.commission, 'Логистика ₽': r.c.logistics,
        'Хранение ₽': r.c.storage, 'Упаковка ₽': r.c.packaging, 'Реклама ₽': r.c.ad, 'Налог ₽': r.c.tax,
        'Себестоимость ₽': r.costPrice, 'Прибыль ₽': r.profit, 'Маржа %': r.margin,
        'Продажи 30д': r.sales30, 'Выручка 30д': Math.round(r.revenue30), 'Прибыль 30д': Math.round(r.profit30)
      }))));
      App.toast('Экономика выгружена в CSV', 'ok');
    };

    function revenuePct(v, rev) {
      return rev > 0 ? U.pct((v / rev) * 100, 0) : '0%';
    }
  },

  // ─────────── Калькулятор ───────────
  calc(host) {
    const st = S.state;
    const s = st.settings;
    const sim = this.sim;
    const rows = S.getRows();
    const first = rows[0];

    if (sim.commission === null) {
      sim.commission = first ? first.commission : U.num(s.commissionDefault);
      sim.logistics = first ? first.logistics : 50;
      sim.storage = first ? first.storage : U.num(s.storageRubPerUnit);
      sim.packaging = first ? first.packaging : U.num(s.packagingRub);
      sim.adPct = first ? first.p.adPct : U.num(s.adPctDefault);
      sim.taxMode = s.taxMode;
      sim.spp = first ? first.spp : U.num(s.sppDefault);
      if (first) { sim.basePrice = first.basePrice; sim.discount = first.discount; sim.costPrice = first.costPrice; }
    }

    host.innerHTML = `
      <div class="grid g2">
        <div class="card">
          <h2>Исходные данные</h2>
          <div class="grid g2" style="gap:10px">
            <label class="field">Базовая цена, ₽<input type="number" class="num" id="s-base" value="${sim.basePrice}" step="10" /></label>
            <label class="field">Скидка продавца, %<input type="number" class="num" id="s-disc" value="${sim.discount}" step="1" /></label>
            <label class="field">Себестоимость, ₽<input type="number" class="num" id="s-cogs" value="${sim.costPrice}" step="1" /></label>
            <label class="field">Комиссия WB, %<input type="number" class="num" id="s-comm" value="${sim.commission}" step="0.5" /></label>
            <label class="field">Логистика, ₽/шт<input type="number" class="num" id="s-log" value="${sim.logistics}" step="1" /></label>
            <label class="field">Хранение, ₽/шт<input type="number" class="num" id="s-stor" value="${sim.storage}" step="1" /></label>
            <label class="field">Упаковка, ₽/шт<input type="number" class="num" id="s-pack" value="${sim.packaging}" step="1" /></label>
            <label class="field">Реклама, % от цены<input type="number" class="num" id="s-ad" value="${sim.adPct}" step="0.5" /></label>
            <label class="field">Налоговый режим
              <select id="s-tax">${EC.TAX_MODES.map((m) => `<option value="${m.id}" ${sim.taxMode === m.id ? 'selected' : ''}>${U.esc(m.label)}</option>`).join('')}</select>
            </label>
            <label class="field">СПП покупателя, %<input type="number" class="num" id="s-spp" value="${sim.spp}" step="1" /></label>
          </div>
          <div class="divider"></div>
          <h2>Подобрать цену</h2>
          <div class="grid g2" style="gap:10px">
            <label class="field">Целевая маржинальность, %<input type="number" class="num" id="s-target" value="${U.num(s.targetMarginPct)}" step="1" /></label>
            <label class="field">Или прибыль с единицы, ₽<input type="number" class="num" id="s-profit" value="" step="10" placeholder="например 300" /></label>
          </div>
          <div class="row wrap" style="margin-top:10px">
            <button class="btn btn-primary" id="s-solve">Рассчитать нужную цену</button>
            <button class="btn btn-ghost" id="s-reset">Сбросить</button>
          </div>
          <div id="s-solve-out" style="margin-top:12px"></div>
        </div>
        <div class="card">
          <h2>Результат</h2>
          <div id="s-out"></div>
        </div>
      </div>
    `;

    const ids = { base: '#s-base', disc: '#s-disc', cogs: '#s-cogs', comm: '#s-comm', log: '#s-log', stor: '#s-stor', pack: '#s-pack', ad: '#s-ad', tax: '#s-tax', spp: '#s-spp' };
    const read = () => {
      const v = (sel) => host.querySelector(sel);
      return {
        basePrice: U.num(v(ids.base).value),
        discountPct: U.num(v(ids.disc).value),
        costPriceRub: U.num(v(ids.cogs).value),
        commissionPct: U.num(v(ids.comm).value),
        logisticsRub: U.num(v(ids.log).value),
        storageRub: U.num(v(ids.stor).value),
        packagingRub: U.num(v(ids.pack).value),
        adPct: U.num(v(ids.ad).value),
        adRub: 0,
        acceptRub: U.num(s.acceptRub),
        acquiringPct: U.num(s.acquiringPct),
        taxMode: v(ids.tax).value,
        taxRatePct: EC.resolveTax(Object.assign({}, s, { taxRate: U.num((EC.TAX_MODES.find((m) => m.id === v(ids.tax).value) || {}).rate) }), v(ids.tax).value).effectiveRate,
        taxDetails: EC.resolveTax(Object.assign({}, s, { taxRate: U.num((EC.TAX_MODES.find((m) => m.id === v(ids.tax).value) || {}).rate) }), v(ids.tax).value),
        sppPct: U.num(v(ids.spp).value),
        volumeLiters: 0
      };
    };

    const drawOut = () => {
      const p = read();
      Object.assign(this.sim, {
        basePrice: p.basePrice, discount: p.discountPct, costPrice: p.costPriceRub,
        commission: p.commissionPct, logistics: p.logisticsRub, storage: p.storageRub,
        packaging: p.packagingRub, adPct: p.adPct, taxMode: p.taxMode, spp: p.sppPct
      });
      const seller = p.basePrice * (1 - p.discountPct / 100);
      const c = EC.calcUnit(seller, p);
      const maxCost = Math.max(1, c.commission, c.logistics, c.ad, c.tax, c.cogs, c.storage, c.packaging, c.acquiring);
      host.querySelector('#s-out').innerHTML = `
        <div class="calc-lines">
          <div class="calc-line"><span class="k">Базовая цена</span><span>${U.money(p.basePrice)}</span></div>
          <div class="calc-line"><span class="k">Скидка продавца ${U.pct(p.discountPct, 0)}</span><span>− ${U.money(p.basePrice - seller)}</span></div>
          <div class="calc-line"><span class="k"><b>Цена для WB</b></span><span><b>${U.money(seller)}</b></span></div>
          <div class="calc-line"><span class="k">СПП ${U.pct(p.sppPct, 0)} (платит покупатель)</span><span class="muted">${U.money(c.buyerPrice)}</span></div>
        </div>
        <div class="divider"></div>
        <div class="bars">
          ${UI.bar('Комиссия WB ' + U.pct(p.commissionPct), c.commission, maxCost, U.money(c.commission))}
          ${UI.bar('Логистика', c.logistics, maxCost, U.money(c.logistics))}
          ${UI.bar('Реклама ' + U.pct(p.adPct), c.ad, maxCost, U.money(c.ad))}
          ${UI.bar('Налог ' + U.pct(p.taxRatePct), c.tax, maxCost, U.money(c.tax))}
          ${UI.bar('Себестоимость', c.cogs, maxCost, U.money(c.cogs))}
          ${UI.bar('Упаковка', c.packaging, maxCost, U.money(c.packaging))}
          ${UI.bar('Хранение', c.storage, maxCost, U.money(c.storage))}
          ${UI.bar('Эквайринг', c.acquiring, maxCost, U.money(c.acquiring))}
        </div>
        <div class="divider"></div>
        <div class="calc-lines">
          <div class="calc-line total"><span class="k">Прибыль с единицы</span><span class="${U.profitClass(c.profit)}">${U.money(c.profit)}</span></div>
          <div class="calc-line"><span class="k">Маржинальность</span><span class="${U.profitClass(c.marginPct)}">${U.pct(c.marginPct)}</span></div>
          <div class="calc-line"><span class="k">Наценка на себестоимость</span><span>${U.pct(c.markupPct)}</span></div>
          <div class="calc-line"><span class="k">Цена безубыточности</span><span>${c.breakEvenPrice === null ? '—' : U.money(c.breakEvenPrice)}</span></div>
          <div class="calc-line"><span class="k">Запас прочности</span><span>${c.breakEvenPrice ? U.pct(((seller - c.breakEvenPrice) / seller) * 100) : '—'}</span></div>
        </div>
      `;
    };

    Object.values(ids).forEach((sel) => {
      const e = host.querySelector(sel);
      e.oninput = drawOut;
      e.onchange = drawOut;
    });

    host.querySelector('#s-reset').onclick = () => { this.sim.commission = null; this.draw(); };

    host.querySelector('#s-solve').onclick = () => {
      const p = read();
      const target = U.num(host.querySelector('#s-target').value);
      const profitRub = U.num(host.querySelector('#s-profit').value);
      const seller = profitRub ? EC.calcPriceForProfitRub(p, profitRub) : EC.calcPriceForMarginPct(p, target);
      const out = host.querySelector('#s-solve-out');
      if (seller === null) {
        out.innerHTML = `<div class="alert danger">Невозможно: сумма процентных удержаний (комиссия + налог + реклама + эквайринг ${profitRub ? '' : '+ цель'}) ≥ 100%. Уменьшите процентные ставки.</div>`;
        return;
      }
      const curSeller = p.basePrice * (1 - p.discountPct / 100);
      const neededDisc = p.basePrice > seller ? (1 - seller / p.basePrice) * 100 : 0;
      const neededBase = p.discountPct < 100 ? seller / (1 - p.discountPct / 100) : seller;
      out.innerHTML = `
        <div class="alert ${seller > curSeller ? 'info' : 'ok'}">
          Нужная цена для WB: <b>${U.money(seller)}</b>
          (${profitRub ? 'прибыль ' + U.money(profitRub) + '/шт' : 'маржа ' + U.pct(target)})
        </div>
        <div style="margin-top:10px">${UI.kv([
          ['Текущая цена для WB', U.money(curSeller)],
          ['Изменение', `<span class="${seller >= curSeller ? 'pos' : 'neg'}">${U.signed(seller - curSeller)} ₽ (${U.signed(curSeller ? ((seller - curSeller) / curSeller) * 100 : 0, 1)}%)</span>`],
          ['Вариант 1: при базовой цене ' + U.money(p.basePrice), `скидка <b>${U.pct(neededDisc)}</b>`],
          ['Вариант 2: при скидке ' + U.pct(p.discountPct, 0), `базовая цена <b>${U.money(neededBase)}</b>`]
        ])}</div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-sm" id="s-use">Подставить в калькулятор</button>
        </div>`;
      out.querySelector('#s-use').onclick = () => {
        host.querySelector('#s-base').value = Math.round(p.basePrice);
        host.querySelector('#s-disc').value = Math.round(neededDisc * 10) / 10;
        drawOut();
      };
    };

    drawOut();
  },

  // ─────────── Сценарии ───────────
  scenario(host) {
    const st = S.state;
    const rows = S.getRows(true);
    const t0 = S.totals(rows);

    host.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h2>Что будет с экономикой, если изменить цены или скидки</h2>
        <div class="grid g3" style="gap:10px;margin-top:10px">
          <label class="field">Изменить итоговую цену всех товаров, %
            <input type="number" class="num" id="sc-price" value="0" step="1" /></label>
          <label class="field">Изменить скидку всех товаров, п.п.
            <input type="number" class="num" id="sc-disc" value="0" step="1" /></label>
          <label class="field">Изменение конверсии (эластичность), %
            <input type="number" class="num" id="sc-conv" value="0" step="1" /></label>
        </div>
        <p class="hint" style="margin-top:8px">Эластичность — насколько изменятся продажи: например, −10% цены даёт +15% продаж → укажите 15. По умолчанию продажи не меняются.</p>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn btn-primary" id="sc-run">Рассчитать сценарий</button>
          <button class="btn btn-ghost" id="sc-clear">Сбросить</button>
        </div>
      </div>
      <div id="sc-out"></div>
    `;

    const setInputs = (p, d, c) => {
      host.querySelector('#sc-price').value = p;
      host.querySelector('#sc-disc').value = d;
      host.querySelector('#sc-conv').value = c;
    };

    host.querySelector('#sc-clear').onclick = () => { setInputs(0, 0, 0); host.querySelector('#sc-out').innerHTML = ''; };

    host.querySelector('#sc-run').onclick = () => {
      const dp = U.num(host.querySelector('#sc-price').value);
      const dd = U.num(host.querySelector('#sc-disc').value);
      const dc = U.num(host.querySelector('#sc-conv').value);

      let rev = 0, prof = 0, loss = 0, sales = 0;
      const perRow = rows.map((r) => {
        const ov = st.overrides[String(r.nmID)] || {};
        let base = r.basePrice;
        let disc = Math.max(0, Math.min(95, r.discount + dd));
        if (dp !== 0) {
          const cur = base * (1 - r.discount / 100);
          const target = cur * (1 + dp / 100);
          disc = base > target ? Math.max(0, Math.min(95, (1 - target / base) * 100)) : 0;
        }
        const a = EC.analyze(st.settings, r.item, ov, { basePrice: base, discountPct: disc });
        const qty = Math.max(0, r.sales30 * (1 + dc / 100));
        const rowRev = a.next.revenue * qty;
        const rowProf = a.next.profit * qty;
        rev += rowRev; prof += rowProf; sales += qty;
        if (a.next.profit < 0) loss++;
        return { r, next: a.next, qty, rowRev, rowProf, delta: rowProf - r.profit30 };
      });

      const base30 = t0.revenue30 || U.sum(rows, (r) => r.sellerPrice * r.sales30);
      const baseProf = t0.profit30;
      const dRev = rev - base30;
      const dProf = prof - baseProf;

      const sorted = perRow.slice().sort((a, b) => b.delta - a.delta);
      const worst = sorted.slice(-8).reverse();
      const best = sorted.slice(0, 8);

      host.querySelector('#sc-out').innerHTML = `
        <div class="grid g4" style="margin-bottom:14px">
          <div class="card stat"><span class="label">Выручка (30 дней)</span>
            <span class="value">${U.compact(rev)} ₽</span>
            <span class="hint ${U.profitClass(dRev)}">${U.signed(Math.round(dRev))} ₽ (${U.signed(base30 ? (dRev / base30) * 100 : 0, 1)}%)</span></div>
          <div class="card stat"><span class="label">Прибыль (30 дней)</span>
            <span class="value ${U.profitClass(prof)}">${U.compact(prof)} ₽</span>
            <span class="hint ${U.profitClass(dProf)}">${U.signed(Math.round(dProf))} ₽ (${U.signed(baseProf ? (dProf / Math.abs(baseProf)) * 100 : 0, 1)}%)</span></div>
          <div class="card stat"><span class="label">Маржинальность</span>
            <span class="value ${U.profitClass(rev ? prof / rev * 100 : 0)}">${U.pct(rev ? (prof / rev) * 100 : 0)}</span>
            <span class="hint">было ${U.pct(t0.margin30)}</span></div>
          <div class="card stat"><span class="label">Убыточных позиций</span>
            <span class="value ${loss ? 'neg' : 'pos'}">${loss}</span>
            <span class="hint">было ${t0.lossCount}</span></div>
        </div>
        <div class="grid g2">
          <div class="card pad0"><div class="card-head" style="padding:14px 16px 0"><h2>Больше всего выигрывают</h2></div>
            <div style="padding:10px 16px 16px">${deltaTable(best)}</div></div>
          <div class="card pad0"><div class="card-head" style="padding:14px 16px 0"><h2>Больше всего теряют</h2></div>
            <div style="padding:10px 16px 16px">${deltaTable(worst)}</div></div>
        </div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn" id="sc-apply">Применить сценарий к ценам</button>
          <span class="hint">Откроет раздел «Цены» с этим правилом — перед отправкой в WB будет предпросмотр.</span>
        </div>
      `;

      host.querySelector('#sc-apply').onclick = () => {
        const stt = S.state;
        stt.priceRule = dp !== 0
          ? { type: 'delta-pct', value: dp, roundTo: 10, minPrice: 0 }
          : { type: 'delta-discount', value: dd, roundTo: 0, minPrice: 0 };
        if (dp === 0 && dd !== 0) {
          // правило «изменить скидку на N п.п.» реализуется как set-discount относительно текущей
          stt.priceRule = { type: 'delta-discount', value: dd, roundTo: 0, minPrice: 0 };
        }
        App.toast('Правило перенесено в раздел «Цены»', 'ok');
        App.go('prices');
      };

      function deltaTable(list) {
        return `<table class="grid-table"><thead><tr><th>Товар</th><th class="num">Цена</th><th class="num">Скидка</th><th class="num">Прибыль/шт</th><th class="num">Δ за 30 дн</th></tr></thead>
          <tbody>${list.map((x) => `<tr>
            <td><div class="rowtitle"><b class="trunc">${U.esc(x.r.title)}</b><span class="tiny muted">${x.r.nmID}</span></div></td>
            <td class="num">${U.money(x.r.sellerPrice)} → <b>${U.money(x.next.revenue)}</b></td>
            <td class="num">${U.pct(x.r.discount, 0)} → ${U.pct(x.next.discountPct, 0)}</td>
            <td class="num ${U.profitClass(x.next.profit)}">${U.money(x.next.profit)}</td>
            <td class="num ${U.profitClass(x.delta)}">${U.signed(Math.round(x.delta))} ₽</td>
          </tr>`).join('')}</tbody></table>`;
      }
    };
  }
};
