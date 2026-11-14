// Быстрая проверка демо-режима через dev-сервер: полное обновление + репрайсер.
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
async function inv(c, a) {
  const r = await fetch(BASE + '/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: c, args: a === undefined ? [] : [a] }) });
  const j = await r.json();
  if (!j.ok) { console.log('   !!', JSON.stringify(j.error)); return {}; }
  return j.data;
}
(async () => {
  await inv('keys:clear');
  const k = await inv('keys:set', { demoMode: true });
  console.log('демо:', k.demo, '|', k.message);
  const rr = await inv('data:refresh-all', { facts: true, factDays: 7 });
  console.log('data:refresh-all → ok:', rr.ok, '| секций:', (rr.sections || []).length, '| ошибок:', (rr.errors || []).length, '| ms:', rr.ms);
  (rr.sections || []).forEach((s) => console.log('   ', s.ok ? '✓' : '✗', s.title, '—', s.detail || s.error));
  const st = await inv('app:state');
  console.log('app:state → demo:', st.demo, '| keysSet:', st.keysSet, '| secretsError:', JSON.stringify(st.secretsError), '| lastDataRefreshOk:', st.settings.lastDataRefreshOk);
  const g = await inv('wb:goods', {});
  console.log('товаров:', (g.items || []).length, '| в акциях:', (g.items || []).filter((x) => x.inPromo).length);
})();
