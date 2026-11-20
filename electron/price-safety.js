'use strict';

/** Одна серверная проверка фактической пары/размера перед любым изменением цены. UI-экономике не доверяем. */
const RP = require('./repricer-engine');
const Boost = require('./boost-ladder');
const A = require('./workspace-analytics');
function evaluate(row, candidate, options = {}) {
  const ctx = { ...row.ctx }, cfg = row.cfg, ic = row.itemCfg, issues = [];
  const add = (code, message) => { if (!issues.some((i) => i.code === code && i.message === message)) issues.push({ code, message, level: 'critical' }); };
  if (!candidate || !A.finite(candidate.basePrice) || !A.finite(candidate.discount)) return { ok: false, issues: [{ code: 'PRICE_INVALID', message: 'Цена и скидка должны быть конечными числами.', level: 'critical' }] };
  const basePrice = Math.round(Number(candidate.basePrice)), discount = Math.round(Number(candidate.discount)), sellerPrice = basePrice * (1 - discount / 100);
  if (!Number.isSafeInteger(basePrice) || basePrice < 1 || basePrice > 1000000000 || discount < 0 || discount > 95) add('PRICE_INVALID', 'Недопустимая цена или скидка после округления.');
  if (!RP.STRATEGIES.some((s) => s.id === ic.strategy) && !(cfg.customStrategies || []).some((s) => s.id === ic.strategy)) add('STRATEGY_INVALID', 'Неизвестная стратегия товара — проверьте настройки.');
  if (ctx.allowSend === false) add('SEND_DISABLED', 'Отправка в WB отключена для товара.');
  if (options.lock && options.lock.active) add('SAFETY_LOCK', 'Есть критическая ошибка последнего расчёта. Исправьте её и выполните пересчёт.');
  if (ic.strategy === 'boost' && !options.boost) add('BOOST_PROTECTED', 'Товар управляется лесенкой. Прямое изменение цены вне её подтверждённого предложения запрещено.');
  if (options.boost) ctx.boostPlan = options.boost;
  let result;
  try {
    result = RP.computeItem(ctx, cfg, ic);
    const marginCtx = { ...ctx, marginMode: cfg.marginMode, walletPct: Number(cfg.priceEdit.walletPct) || 0, forPayRatio: ctx.sellerPrice > 0 ? ctx.forPayAvg / ctx.sellerPrice : 1 };
    marginCtx.forPayAtPrice = (price) => price * marginCtx.forPayRatio;
    const economics = RP.marginOf(marginCtx, sellerPrice);
    result.proposed = { basePrice, discount, sellerPrice, profit: economics.profit, marginPct: economics.marginPct };
    result.cost.next = ctx.econAt(sellerPrice);
    if (options.boost) result.boost = Boost.checkResult(result, options.boost, options.good);
    issues.push(...A.issuesFor(result).filter((i) => i.level === 'critical'));
    if (sellerPrice < Number(result.corridor.min) - .005) add('BELOW_MIN', 'Цена после округления ниже безопасного минимального порога.');
    if (!ic.allowNegativeMargin && Number(economics.marginPct) < Number(ic.minMarginPct || 0) - .01) add('MIN_MARGIN', 'Маржа фактической пары ниже заданного минимума.');
    if (cfg.limits.blockQuarantine !== false && ctx.sellerPrice > 0 && sellerPrice < ctx.sellerPrice / 3 - .005) add('QUARANTINE', 'Снижение более чем в три раза заблокировано защитой от карантина WB.');
  } catch (e) { add('CALC_ERROR', 'Не удалось проверить цену: ' + e.message); }
  return { ok: issues.length === 0, issues, result, basePrice, discount, sellerPrice: Math.round(sellerPrice * 100) / 100 };
}
module.exports = { evaluate };
