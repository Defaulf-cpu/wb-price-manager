'use strict';

/** Участие по условию цены — наблюдение, не подтверждение состава акции WB. Черновики сюда не передаются. */
function observePromoPrice(good, target, promo, now) {
  const g = good || {}, threshold = Number(target) || 0;
  const t = now === undefined ? Date.now() : new Date(now).getTime();
  const start = Date.parse(promo && (promo.startDateTime || promo.startAt) || '');
  const end = Date.parse(promo && (promo.endDateTime || promo.endAt) || '');
  const datesKnown = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const active = datesKnown && t >= start && t <= end;
  const discount = Number(g.discount) || 0;
  const sizes = Array.isArray(g.sizes) && g.sizes.length ? g.sizes : [g];
  const prices = sizes.map((size) => {
    const actual = Number(size.discountedPrice);
    if (actual > 0) return actual;
    const base = Number(size.price);
    return base > 0 && discount >= 0 && discount < 100 ? base * (1 - discount / 100) : null;
  });
  const available = prices.filter((n) => Number.isFinite(n) && n > 0);
  const known = threshold > 0 && available.length > 0 && prices.every((n) => n !== null);
  const qualifies = known && available.every((price) => price <= threshold + 0.005);
  const partial = known && !qualifies && available.some((price) => price <= threshold + 0.005);
  return { known, qualifies, partial, active, datesKnown, inAction: active && qualifies,
    minPrice: available.length ? Math.min(...available) : null, maxPrice: available.length ? Math.max(...available) : null,
    threshold: threshold || null, observedAt: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
    status: !known ? 'unknown-price' : partial ? 'partial-sizes' : !datesKnown ? 'unknown-period'
      : t < start ? (qualifies ? 'ready' : 'not-started') : t > end ? 'ended' : qualifies ? 'by-price' : 'above-price' };
}
module.exports = { observePromoPrice };
