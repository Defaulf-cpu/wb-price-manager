// Загрузка состава акции на РЕАЛЬНЫХ артикулах каталога — так, как это делает пользователь.
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

  const g = await inv('wb:goods', {});
  const items = g.items || [];
  console.log('каталог:', items.length, 'товаров');

  const promos = await inv('wb:promos', { days: 60 });
  const target = promos.find((p) => String(p.type || '').toLowerCase() === 'auto') || promos[0];
  const req = Number(target.requiredDiscountPct || target.participationPercentage || 25);
  console.log('акция:', target.id, target.name, '| тип', target.type, '| требуемая скидка', req + '%');

  // берём товары, которых НЕТ в акции по данным API — именно их пользователь донесёт файлом
  const noms = await inv('wb:promo-nomenclatures', { promotionID: target.id, inAction: false });
  const knownIds = new Set((noms || []).map((x) => String(x.nmID)));
  const outsiders = items.filter((x) => !knownIds.has(String(x.nmID))).slice(0, 5);
  console.log('товаров, неизвестных API по этой акции:', outsiders.length, '→', outsiders.map((x) => x.nmID).join(', '));

  const before = await inv('repricer:promo-plan', {});
  const seenBefore = (before.items || []).filter((it) => (it.actions || []).some((a) => String(a.promoId) === String(target.id)));
  console.log('ДО загрузки: решений по акции у', seenBefore.length, 'товаров');

  // файл как из кабинета WB: заголовки + артикулы + плановая цена/скидка
  const head = 'Артикул WB;Артикул продавца;Наименование;Цена до скидки;Скидка;Плановая цена;Участвует';
  const lines = outsiders.map((x) => {
    const plan = Math.round(x.price * (1 - req / 100));
    return [x.nmID, x.vendorCode, '"' + String(x.title || '').replace(/"/g, '') + '"', x.price, req, plan, '0'].join(';');
  });
  const csv = [head].concat(lines).join('\n');
  const imp = await inv('promos:import-noms', { promotionID: target.id, fileName: 'wb-promo-list.csv', base64: Buffer.from(csv, 'utf8').toString('base64') });
  console.log('импорт →', imp && imp.message);

  const after = await inv('repricer:promo-plan', {});
  const seenAfter = (after.items || []).filter((it) => (it.actions || []).some((a) => String(a.promoId) === String(target.id)));
  console.log('ПОСЛЕ загрузки: решений по акции у', seenAfter.length, 'товаров (было', seenBefore.length + ')');

  const byNm = new Map((after.items || []).map((x) => [String(x.nmID), x]));
  outsiders.forEach((x) => {
    const it = byNm.get(String(x.nmID));
    const act = it ? (it.actions || []).find((a) => String(a.promoId) === String(target.id)) : null;
    console.log('   ·', x.nmID, x.vendorCode, '→', it ? ('решение: ' + (act ? act.type + (act.reason ? ' («' + String(act.reason).slice(0, 60) + '»)' : '') : 'нет действия по акции')) : 'НЕТ в плане');
  });

  const rec = await inv('promos:noms', { promotionID: target.id });
  console.log('сохранено:', rec && rec.loaded, '| товаров:', rec && rec.record && rec.record.count, '| плановые цены:',
    (rec && rec.record && rec.record.items || []).filter((i) => i.planPrice > 0).length);

  await inv('promos:clear-noms', { promotionID: target.id });
  console.log('очищено →', (await inv('promos:noms', { promotionID: target.id })).loaded === false);
})();
