// Проверка ручной загрузки состава акции из файла (XLSX/CSV) через dev-сервер.
const fs = require('fs');
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

  const promos = await inv('wb:promos', { days: 60 });
  const target = promos.find((p) => String(p.type || '').toLowerCase() === 'auto') || promos[0];
  console.log('1) акция для загрузки:', target.id, '—', target.name, '| тип:', target.type);

  const before = await inv('repricer:promo-plan', {});
  const bIdx = (before.byPromo || []).find((x) => String(x.promoId || x.id) === String(target.id));
  console.log('   до загрузки: кандидатов/участников по акции =', JSON.stringify(bIdx || {}).slice(0, 160));

  // XLSX, собранный как настоящий файл кабинета WB
  const b64 = fs.readFileSync('/tmp/t/promo.xlsx').toString('base64');
  const imp = await inv('promos:import-noms', { promotionID: target.id, fileName: 'promo.xlsx', base64: b64 });
  console.log('2) импорт XLSX →', imp && imp.message);
  console.log('   заголовки:', JSON.stringify(imp && imp.headers));
  console.log('   пропущено строк:', imp && imp.skipped);
  (imp && imp.sample || []).forEach((x) => console.log('     ·', x.nmID, '|', x.vendorCode || '—', '| план', x.planPrice || '—', '| скидка', x.planDiscount || '—', '|', x.inAction ? 'в акции' : 'кандидат'));

  const got = await inv('promos:noms', { promotionID: target.id });
  console.log('3) список сохранён:', got && got.loaded, '| товаров:', got && got.record && got.record.count, '| файл:', got && got.record && got.record.fileName);

  const all = await inv('promos:noms', {});
  console.log('4) всего загруженных списков:', all && all.count, JSON.stringify(all && all.all));

  // CSV-вариант того же файла
  const csv = 'Артикул WB;Артикул продавца;Наименование;Плановая цена;Скидка;Участвует\n' +
    '12345678;B-001;Товар один;900;40;1\n87654321;B-002;Товар два;1430;35;0\n;;;;;\n99999999;B-003;Товар три;700;45;0\n';
  const imp2 = await inv('promos:import-noms', { promotionID: target.id, fileName: 'promo.csv', base64: Buffer.from(csv, 'utf8').toString('base64') });
  console.log('5) импорт CSV →', imp2 && imp2.message, '| пропущено:', imp2 && imp2.skipped);

  // репрайсер должен увидеть загруженные товары
  const plan = await inv('repricer:promo-plan', {});
  const pIdx = (plan.byPromo || []).find((x) => String(x.promoId || x.id) === String(target.id));
  console.log('6) после загрузки, акция в плане:', JSON.stringify(pIdx || {}).slice(0, 200));
  const nmIDs = (plan.items || []).map((x) => String(x.nmID));
  console.log('   товары из файла видны репрайсеру:', ['12345678', '87654321', '99999999'].map((n) => n + '=' + (nmIDs.indexOf(n) >= 0)).join(', '));

  // удаление списка
  const cl = await inv('promos:clear-noms', { promotionID: target.id });
  const after = await inv('promos:noms', { promotionID: target.id });
  console.log('7) удаление списка → осталось:', cl && cl.left, '| loaded:', after && after.loaded);

  // защита от мусора
  const bad = await inv('promos:import-noms', { promotionID: target.id, fileName: 'bad.csv', base64: Buffer.from('раз;два;три\n1;2;3\n', 'utf8').toString('base64') });
  console.log('8) файл без артикулов →', bad === null ? 'отклонён (ожидаемо)' : 'принят: ' + JSON.stringify(bad).slice(0, 120));
})();
