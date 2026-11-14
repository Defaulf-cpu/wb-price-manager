// Проверка отчёта P&L через dev-сервер.
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
async function inv(c, a) {
  const r = await fetch(BASE + '/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: c, args: a === undefined ? [] : [a] }) });
  const j = await r.json();
  if (!j.ok) { console.log('   !!', JSON.stringify(j.error)); return null; }
  return j.data;
}
const m = (v) => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('ru-RU') + ' ₽';
(async () => {
  await inv('keys:clear');
  await inv('keys:set', { demoMode: true });
  console.log('1) до загрузки отчёта:');
  let rep = await inv('reports:pl', {});
  console.log('   ok:', rep && rep.ok, '| empty:', rep && rep.empty, '|', rep && rep.message ? rep.message.slice(0, 90) : '');

  const f = await inv('facts:load', { days: 7 });
  console.log('2) загрузка отчёта → товаров:', f.items, '| строк:', f.rowsProcessed, '|', f.dateFrom, '→', f.dateTo);

  rep = await inv('reports:pl', {});
  if (!rep || !rep.ok) { console.log('   P&L не построился:', rep && rep.message); return; }
  const T = rep.totals;
  console.log('3) P&L за', rep.meta.dateFrom, '→', rep.meta.dateTo, '(' + rep.meta.days + ' дн), товаров:', rep.meta.items);
  console.log('   Выручка:            ', m(T.revenue));
  console.log('   − Комиссия WB:      ', m(T.commission), '(' + T.commissionPct + '%)');
  console.log('   − Логистика:        ', m(T.logistics), '(' + T.logisticsPct + '%)');
  console.log('   − Хранение:         ', m(T.storage));
  console.log('   − Приёмка:          ', m(T.acceptance));
  console.log('   − Эквайринг:        ', m(T.acquiring));
  console.log('   − Штрафы:           ', m(T.penalties));
  console.log('   = К перечислению:   ', m(T.forPay));
  console.log('   − Себестоимость:    ', m(T.cogs));
  console.log('   − Упаковка:         ', m(T.packaging));
  console.log('   − Реклама:          ', m(T.ad));
  console.log('   − Налог (' + rep.taxMode + '):', m(T.tax));
  console.log('   = ЧИСТАЯ ПРИБЫЛЬ:   ', m(T.profit), '| маржа', T.marginPct + '%');
  console.log('   Продаж:', T.salesQty, '| возвратов:', T.returnsQty, '(' + T.returnSharePct + '%) | средний чек', m(T.avgCheck), '| прибыль/продажу', m(T.avgProfitPerUnit));
  console.log('4) дней в динамике:', (rep.byDay || []).length, '| категорий:', (rep.byCategory || []).length, '| товаров:', (rep.items || []).length);
  console.log('   без себестоимости:', rep.missingCostCount);
  console.log('   топ-3 прибыли:', (rep.top || []).slice(0, 3).map((x) => x.vendorCode + '=' + m(x.profit)).join(', '));
  console.log('   худшие-3:     ', (rep.bottom || []).slice(0, 3).map((x) => x.vendorCode + '=' + m(x.profit)).join(', '));
  if ((rep.byDay || []).length) {
    const d = rep.byDay[0];
    console.log('   первый день:', d.date, '| продаж', d.salesQty, '| выручка', m(d.revenue), '| к перечислению', m(d.forPay));
  }
  // арифметика P&L должна сходиться
  // «к перечислению» у WB = выручка − комиссия − эквайринг (логистика/хранение — отдельными строками)
  const calcForPay = T.revenue - T.commission - T.acquiring;
  console.log('5) сверка «к перечислению»: WB', m(T.forPay), 'vs выручка−комиссия−эквайринг', m(calcForPay),
    '| расхождение', m(Math.abs(T.forPay - calcForPay)));
  const afterWb = T.forPay - T.logistics - T.storage - T.acceptance - T.penalties;
  console.log('   после расходов WB:', m(T.wbAfterLogistics), 'vs расчёт', m(afterWb),
    '| расхождение', m(Math.abs(T.wbAfterLogistics - afterWb)));
  const prof = T.wbAfterLogistics - T.cogs - T.packaging - T.ad - T.tax;
  console.log('   сверка прибыли:', m(T.profit), 'vs', m(prof), '| расхождение', m(Math.abs(T.profit - prof)));
  console.log('   строк «к перечислению» пришло от WB:', T.forPayFromWb, 'из', rep.meta.items);
})();
