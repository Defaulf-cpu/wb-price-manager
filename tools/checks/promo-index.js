// Проверка: загруженный вручную файл дополняет индекс акций и виден репрайсеру.
// Берём акцию с неполным составом — на ней прирост виден наглядно.
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
async function inv(c, a) {
  const r = await fetch(BASE + '/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: c, args: a === undefined ? [] : [a] }) });
  const j = await r.json();
  if (!j.ok) { console.log('   !! ошибка:', JSON.stringify(j.error)); return null; }
  return j.data;
}
(async () => {
  await inv('keys:clear');
  await inv('keys:set', { demoMode: true });
  await inv('data:refresh-all', { facts: false });

  const idx0 = await inv('promos:index', {});
  // акция с самым неполным составом — там файл реально что-то добавит
  const target = (idx0.promos || []).slice().sort((a, b) => a.eligible - b.eligible)[0];
  console.log('акция:', target.promoId, target.promoName, '| тип', target.type, '| порог', target.requiredDiscountPct + '%');
  console.log('ДО:  в акции', target.inAction, '| кандидатов', target.eligible, '| из файла', target.manualCount);

  const g = await inv('wb:goods', {});
  const items = g.items || [];
  const nomsIn = await inv('wb:promo-nomenclatures', { promotionID: target.promoId, inAction: true });
  const nomsCand = await inv('wb:promo-nomenclatures', { promotionID: target.promoId, inAction: false });
  const known = new Set([...(nomsIn || []), ...(nomsCand || [])].map((x) => String(x.nmID)));
  const outsiders = items.filter((x) => !known.has(String(x.nmID))).slice(0, 6);
  console.log('товаров вне состава акции по API:', items.length - known.size, '| берём для файла:', outsiders.length,
    '→', outsiders.map((x) => x.vendorCode).join(', '));

  const req = target.requiredDiscountPct;
  const head = 'Артикул WB;Артикул продавца;Наименование;Цена до скидки;Скидка;Плановая цена;Участвует';
  const lines = outsiders.map((x, i) => [x.nmID, x.vendorCode, '"' + String(x.title || '').replace(/"/g, '') + '"',
    x.price, req, Math.round(x.price * (1 - req / 100)), i === 0 ? '1' : '0'].join(';'));
  const csv = [head].concat(lines).join('\n');
  const imp = await inv('promos:import-noms', { promotionID: target.promoId, fileName: 'wb-promo-list.csv', base64: Buffer.from(csv, 'utf8').toString('base64') });
  console.log('импорт →', imp && imp.message);

  const idx1 = await inv('promos:index', {});
  const a = (idx1.promos || []).find((x) => String(x.promoId) === String(target.promoId));
  console.log('ПОСЛЕ: в акции', a.inAction, '| кандидатов', a.eligible, '| из файла', a.manualCount, '(' + a.manualFile + ')');
  console.log('прирост: кандидатов +' + (a.eligible - target.eligible) + ', в акции +' + (a.inAction - target.inAction) + ', из файла ' + a.manualCount);

  const plan = await inv('repricer:promo-plan', {});
  const byNm = new Map((plan.items || []).map((x) => [String(x.nmID), x]));
  let withAction = 0;
  outsiders.forEach((x) => {
    const it = byNm.get(String(x.nmID));
    const act = it ? (it.actions || []).find((ac) => String(ac.promoId) === String(target.promoId)) : null;
    if (act) withAction++;
    console.log('   ·', x.vendorCode, '→', act
      ? act.action + ' | ' + String(act.reason || '').slice(0, 64)
      : (it ? 'в плане, нет действия по акции' : 'НЕТ в плане'));
  });
  console.log('решений репрайсера по загруженным товарам:', withAction + '/' + outsiders.length);

  await inv('promos:clear-noms', { promotionID: target.promoId });
  const idx2 = await inv('promos:index', {});
  const c = (idx2.promos || []).find((x) => String(x.promoId) === String(target.promoId));
  console.log('ПОСЛЕ УДАЛЕНИЯ: кандидатов', c.eligible, '(было до импорта', target.eligible + ') | из файла', c.manualCount);
})();
