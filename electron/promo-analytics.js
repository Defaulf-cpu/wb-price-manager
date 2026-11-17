'use strict';

const EC = require('./economics');

const DAY_MS = 86400000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

function number(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function nullableNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round((number(v) + Number.EPSILON) * 100) / 100;
}

function dayOf(v) {
  if (!v) return '';
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

function addDays(day, offset) {
  const d = new Date(String(day).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(offset || 0));
  return d.toISOString().slice(0, 10);
}

function dayCount(from, to) {
  if (!from || !to || to < from) return 0;
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / DAY_MS) + 1 : 0;
}

function clampWindowDays(value, fallback) {
  const n = Math.floor(number(value, fallback || DEFAULT_WINDOW_DAYS));
  return Math.max(1, Math.min(MAX_WINDOW_DAYS, n || DEFAULT_WINDOW_DAYS));
}

function normalizedPromoKey(event) {
  const id = nullableNumber(event && event.promoId);
  if (id !== null && id > 0) return 'id:' + String(Math.round(id));
  const name = String((event && event.promoName) || '').trim().toLowerCase();
  return name ? 'name:' + name : 'unknown';
}

/**
 * Спаривает только успешные входы/выходы одного товара в одной акции.
 * Дублирующий вход, пока позиция уже открыта, не создаёт вторую сессию.
 */
function pairPromoEpisodes(events) {
  const ordered = (Array.isArray(events) ? events : []).filter((e) => {
    return e && e.ok !== false && (e.action === 'join' || e.action === 'exit') &&
      Number(e.nmID) > 0 && dayOf(e.at);
  }).map((e, i) => Object.assign({}, e, {
    _day: dayOf(e.at),
    _sourceIndex: i,
    _promoKey: normalizedPromoKey(e)
  })).sort((a, b) => {
    const byAt = String(a.at || '').localeCompare(String(b.at || ''));
    if (byAt) return byAt;
    // If timestamps are identical, close the previous session before opening another.
    if (a.action !== b.action) return a.action === 'exit' ? -1 : 1;
    return a._sourceIndex - b._sourceIndex;
  });

  const active = new Map();
  const episodes = [];
  const seenEvents = new Set();
  for (const e of ordered) {
    const nmID = Number(e.nmID);
    const key = String(nmID) + '|' + e._promoKey;
    const eventKey = [key, e.action, String(e.at || ''), String(e.priceAfter || '')].join('|');
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);

    if (e.action === 'join') {
      if (active.has(key)) continue;
      const episode = {
        nmID,
        vendorCode: e.vendorCode || '',
        title: e.title || '',
        promoId: nullableNumber(e.promoId),
        promoName: e.promoName || (e.promoId ? 'Акция ' + e.promoId : 'Акция без названия'),
        promoKey: e._promoKey,
        joinedAt: e.at,
        joinedDay: e._day,
        promoStartAt: e.promoStartAt || '',
        promoEndAt: e.promoEndAt || '',
        forecast: e.forecast || null,
        exitAt: null,
        exitDay: '',
        source: e.source || ''
      };
      active.set(key, episode);
      episodes.push(episode);
    } else {
      const episode = active.get(key);
      if (!episode) continue;
      episode.exitAt = e.at;
      episode.exitDay = e._day;
      episode.exitSource = e.source || '';
      active.delete(key);
    }
  }
  return episodes;
}

function coveredSet(values, byItemDay) {
  const set = new Set((Array.isArray(values) ? values : []).map(dayOf).filter(Boolean));
  // Compatibility for a daily cache written before explicit coverage was introduced:
  // observed transaction dates are known, but absent dates are deliberately not assumed zero.
  if (!set.size && byItemDay && typeof byItemDay === 'object') {
    Object.keys(byItemDay).forEach((day) => { if (dayOf(day)) set.add(dayOf(day)); });
  }
  return set;
}

function sumsForWindow(nmID, from, to, coveredDates, byItemDay, params) {
  const totalDays = dayCount(from, to);
  if (!totalDays) {
    return { status: 'not-started', from: from || '', to: to || '', totalDays: 0, coveredDays: 0, metrics: null };
  }
  let coveredDays = 0;
  const raw = {
    salesQty: 0, returnsQty: 0, revenue: 0, commission: 0,
    logistics: 0, storage: 0, acceptance: 0, acquiring: 0,
    penalties: 0, deductions: 0, forPay: 0, sppWeightedTotal: 0, sppCount: 0
  };

  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!coveredDates.has(d)) continue;
    coveredDays++;
    const byNm = (byItemDay && byItemDay[d]) || {};
    const row = byNm[String(nmID)] || byNm[Number(nmID)] || null;
    if (!row) continue; // a covered day with no transaction is an actual zero
    raw.salesQty += number(row.salesQty);
    raw.returnsQty += number(row.returnsQty);
    raw.revenue += number(row.revenueTotal);
    raw.commission += number(row.commissionTotal);
    raw.logistics += number(row.logisticsTotal);
    raw.storage += number(row.storageTotal);
    raw.acceptance += number(row.acceptanceTotal);
    raw.acquiring += number(row.acquiringTotal);
    raw.penalties += number(row.penaltyTotal);
    raw.deductions += number(row.deductionTotal);
    raw.forPay += number(row.forPayTotal);
    raw.sppWeightedTotal += number(row.sppWeightedTotal);
    raw.sppCount += number(row.sppCount);
  }

  if (!coveredDays) {
    return { status: 'no-report', from, to, totalDays, coveredDays, metrics: null };
  }

  const p = params || {};
  const costKnown = Number(p.costPriceRub) > 0;
  const forPay = raw.forPay > 0 ? raw.forPay : raw.revenue - raw.commission - raw.acquiring;
  const cogs = costKnown ? raw.salesQty * number(p.costPriceRub) : null;
  const packaging = raw.salesQty * number(p.packagingRub);
  const ad = raw.revenue * number(p.adPct) / 100 + raw.salesQty * number(p.adRub);
  const tax = raw.revenue * number(p.taxRatePct) / 100;
  const wbExpenses = raw.commission + raw.logistics + raw.storage + raw.acceptance +
    raw.acquiring + raw.penalties + raw.deductions;
  const totalExpenses = costKnown ? wbExpenses + cogs + packaging + ad + tax : null;
  const profit = costKnown ? forPay - raw.logistics - raw.storage - raw.acceptance -
    raw.penalties - raw.deductions - cogs - packaging - ad - tax : null;
  const metrics = {
    salesQty: round2(raw.salesQty),
    returnsQty: round2(raw.returnsQty),
    revenue: round2(raw.revenue),
    profit: profit === null ? null : round2(profit),
    costKnown,
    forPay: round2(forPay),
    sppPct: raw.sppCount > 0 ? round2(raw.sppWeightedTotal / raw.sppCount) : null,
    expenses: {
      commission: round2(raw.commission),
      logistics: round2(raw.logistics),
      storage: round2(raw.storage),
      acceptance: round2(raw.acceptance),
      acquiring: round2(raw.acquiring),
      penalties: round2(raw.penalties),
      deductions: round2(raw.deductions),
      cogs: cogs === null ? null : round2(cogs),
      packaging: round2(packaging),
      advertising: round2(ad),
      tax: round2(tax),
      wbTotal: round2(wbExpenses),
      total: totalExpenses === null ? null : round2(totalExpenses)
    }
  };
  return {
    status: coveredDays === totalDays ? 'complete' : 'partial',
    from, to, totalDays, coveredDays,
    metrics
  };
}

function firstAndLastDate(values) {
  const dates = Array.isArray(values) ? values.map(dayOf).filter(Boolean).sort() : [];
  return { from: dates[0] || '', to: dates[dates.length - 1] || '' };
}

function aggregateGroup(items) {
  const eligible = items.filter((x) => x.eligibleForConclusion);
  const totals = {
    salesBefore: 0, salesDuring: 0,
    revenueBefore: 0, revenueDuring: 0,
    profitBefore: 0, profitDuring: 0,
    expensesBefore: 0, expensesDuring: 0,
    actualProfitGainMonthly: 0,
    actualProfitMonthDuring: 0,
    forecastProfitMonthDuring: 0,
    forecastProfitGainMonth: 0,
    beforeExposureDays: 0, duringExposureDays: 0,
    stockoutCount: items.filter((x) => x.stockout).length,
    pendingCount: items.filter((x) => !x.effectEvaluable && !x.stockout).length,
    positiveCount: eligible.filter((x) => x.effect === 'positive').length,
    negativeCount: eligible.filter((x) => x.effect === 'negative').length,
    neutralCount: eligible.filter((x) => x.effect === 'neutral').length,
    eligibleCount: eligible.length
  };
  eligible.forEach((x) => {
    totals.salesBefore += number(x.before.metrics && x.before.metrics.salesQty);
    totals.salesDuring += number(x.during.metrics && x.during.metrics.salesQty);
    totals.revenueBefore += number(x.before.metrics && x.before.metrics.revenue);
    totals.revenueDuring += number(x.during.metrics && x.during.metrics.revenue);
    totals.profitBefore += number(x.before.metrics && x.before.metrics.profit);
    totals.profitDuring += number(x.during.metrics && x.during.metrics.profit);
    totals.expensesBefore += number(x.before.metrics && x.before.metrics.expenses && x.before.metrics.expenses.total);
    totals.expensesDuring += number(x.during.metrics && x.during.metrics.expenses && x.during.metrics.expenses.total);
    totals.beforeExposureDays += number(x.before.totalDays);
    totals.duringExposureDays += number(x.during.totalDays);
    totals.actualProfitGainMonthly += number(x.comparison.actualProfitGainMonthly);
    totals.actualProfitMonthDuring += number(x.comparison.actualProfitMonthDuring);
    totals.forecastProfitMonthDuring += number(x.comparison.forecastProfitMonthDuring);
    totals.forecastProfitGainMonth += number(x.comparison.forecastProfitGainMonth);
  });
  const beforePerDay = totals.beforeExposureDays > 0 ? totals.salesBefore / totals.beforeExposureDays : null;
  const duringPerDay = totals.duringExposureDays > 0 ? totals.salesDuring / totals.duringExposureDays : null;
  const salesUpliftPct = beforePerDay > 0 && duringPerDay !== null
    ? round2((duringPerDay / beforePerDay - 1) * 100) : null;

  return Object.assign({
    itemCount: items.length,
    effectEvaluatedCount: eligible.length,
    salesUpliftActualPct: salesUpliftPct
  }, totals, {
    salesBefore: eligible.length ? round2(totals.salesBefore) : null,
    salesDuring: eligible.length ? round2(totals.salesDuring) : null,
    revenueBefore: eligible.length ? round2(totals.revenueBefore) : null,
    revenueDuring: eligible.length ? round2(totals.revenueDuring) : null,
    profitBefore: eligible.length ? round2(totals.profitBefore) : null,
    profitDuring: eligible.length ? round2(totals.profitDuring) : null,
    expensesBefore: eligible.length ? round2(totals.expensesBefore) : null,
    expensesDuring: eligible.length ? round2(totals.expensesDuring) : null,
    actualProfitGainMonthly: eligible.length ? round2(totals.actualProfitGainMonthly) : null,
    actualProfitMonthDuring: eligible.length ? round2(totals.actualProfitMonthDuring) : null,
    forecastProfitMonthDuring: eligible.length ? round2(totals.forecastProfitMonthDuring) : null,
    forecastProfitGainMonth: eligible.length ? round2(totals.forecastProfitGainMonth) : null
  });
}

function promoAnalytics(input) {
  const src = input || {};
  const days = clampWindowDays(src.days, DEFAULT_WINDOW_DAYS);
  const now = src.now ? new Date(src.now) : new Date();
  const today = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const byItemDay = src.byItemDay && typeof src.byItemDay === 'object' ? src.byItemDay : {};
  const coveredDates = coveredSet(src.coveredDates, byItemDay);
  const episodes = pairPromoEpisodes(src.journal);
  const goodsByNm = new Map((Array.isArray(src.goods) ? src.goods : []).map((g) => [String(g.nmID), g]));
  const overrides = src.overrides && typeof src.overrides === 'object' ? src.overrides : {};
  const settings = src.settings || {};
  const stockDays = src.stockHistory && src.stockHistory.days && typeof src.stockHistory.days === 'object'
    ? src.stockHistory.days : (src.stockHistory && typeof src.stockHistory === 'object' ? src.stockHistory : {});
  const hasDailyData = Object.keys(byItemDay).length > 0 && coveredDates.size > 0;
  const legacyFactData = !!src.legacyFactData;
  const incompleteFinanceData = !!src.incompleteFinanceData || !!(src.reportMeta && src.reportMeta.reportTruncated);
  const dateRange = firstAndLastDate(Array.from(coveredDates));

  const items = episodes.map((episode, index) => {
    const joinDay = episode.joinedDay;
    const beforeFrom = addDays(joinDay, -days);
    const beforeTo = addDays(joinDay, -1);
    const targetEnd = addDays(joinDay, days - 1);
    const scheduledEnd = dayOf(episode.promoEndAt);
    const naturalEnds = [episode.exitDay, scheduledEnd].filter((d) => d && d >= joinDay);
    const expectedEnd = naturalEnds.length ? naturalEnds.reduce((m, d) => d < m ? d : m, targetEnd) : targetEnd;
    const actualEnd = expectedEnd < today ? expectedEnd : today;
    const duringFrom = joinDay;
    const duringTo = actualEnd >= joinDay ? actualEnd : '';
    const duringDays = dayCount(duringFrom, duringTo);
    const periodComplete = !!duringDays && today >= expectedEnd;
    const item = goodsByNm.get(String(episode.nmID)) || { nmID: episode.nmID, title: episode.title, vendorCode: episode.vendorCode };
    const ov = overrides[String(episode.nmID)] || {};
    const params = EC.resolveParams(settings, item, ov, {});
    const before = sumsForWindow(episode.nmID, beforeFrom, beforeTo, coveredDates, byItemDay, params);
    const during = sumsForWindow(episode.nmID, duringFrom, duringTo, coveredDates, byItemDay, params);
    const forecastInput = episode.forecast || {};
    const forecast = {
      profitMonthNow: nullableNumber(forecastInput.profitMonthNow),
      profitMonthWithPromo: nullableNumber(forecastInput.profitMonthWithPromo),
      salesUpliftPct: nullableNumber(forecastInput.salesUpliftPct),
      breakEvenUpliftPct: nullableNumber(forecastInput.breakEvenUpliftPct)
    };
    const windowsComplete = periodComplete && before.status === 'complete' && during.status === 'complete';
    const costKnown = !!(before.metrics && during.metrics && before.metrics.costKnown && during.metrics.costKnown);
    const effectEvaluable = windowsComplete && costKnown;
    let actualSalesUpliftPct = null;
    let salesDeviationPct = null;
    let salesUpliftDeltaPp = null;
    let actualProfitMonthDuring = null;
    let forecastProfitMonthDuring = forecast.profitMonthWithPromo;
    let profitForecastDeviationPct = null;
    let actualProfitGainMonthly = null;
    let forecastProfitGainMonth = (forecast.profitMonthNow !== null && forecast.profitMonthWithPromo !== null)
      ? forecast.profitMonthWithPromo - forecast.profitMonthNow : null;
    let profitGainDeviationPct = null;
    let breakEvenMet = null;

    if (windowsComplete && before.metrics && during.metrics && before.totalDays > 0 && during.totalDays > 0) {
      const beforeSalesPerDay = before.metrics.salesQty / before.totalDays;
      const duringSalesPerDay = during.metrics.salesQty / during.totalDays;
      if (beforeSalesPerDay > 0) actualSalesUpliftPct = round2((duringSalesPerDay / beforeSalesPerDay - 1) * 100);
      if (actualSalesUpliftPct !== null && forecast.salesUpliftPct !== null) {
        salesUpliftDeltaPp = round2(actualSalesUpliftPct - forecast.salesUpliftPct);
        if (Math.abs(forecast.salesUpliftPct) > 0.000001) {
          salesDeviationPct = round2((actualSalesUpliftPct - forecast.salesUpliftPct) / Math.abs(forecast.salesUpliftPct) * 100);
        }
      }
      if (actualSalesUpliftPct !== null && forecast.breakEvenUpliftPct !== null) {
        breakEvenMet = actualSalesUpliftPct >= forecast.breakEvenUpliftPct;
      }
      if (effectEvaluable && before.metrics.profit !== null && during.metrics.profit !== null) {
        actualProfitMonthDuring = round2(during.metrics.profit / during.totalDays * 30);
        const beforeProfitMonth = round2(before.metrics.profit / before.totalDays * 30);
        actualProfitGainMonthly = round2(actualProfitMonthDuring - beforeProfitMonth);
        if (forecastProfitMonthDuring !== null && Math.abs(forecastProfitMonthDuring) > 0.000001) {
          profitForecastDeviationPct = round2((actualProfitMonthDuring - forecastProfitMonthDuring) / Math.abs(forecastProfitMonthDuring) * 100);
        }
        if (forecastProfitGainMonth !== null && Math.abs(forecastProfitGainMonth) > 0.000001) {
          profitGainDeviationPct = round2((actualProfitGainMonthly - forecastProfitGainMonth) / Math.abs(forecastProfitGainMonth) * 100);
        }
      }
    }

    const stockSnapshotDates = Object.keys(stockDays).filter((d) => d >= duringFrom && duringTo && d <= duringTo &&
      stockDays[d] && stockDays[d].complete !== false);
    const stockoutSnapshot = stockSnapshotDates.find((d) => {
      const zeroNms = Array.isArray(stockDays[d].zeroNms) ? stockDays[d].zeroNms : [];
      return zeroNms.some((nm) => String(nm) === String(episode.nmID));
    }) || '';
    const stockout = !!stockoutSnapshot;
    let effect = 'pending';
    if (stockout) effect = 'truncated';
    else if (effectEvaluable && actualProfitGainMonthly !== null) {
      effect = actualProfitGainMonthly > 0.01 ? 'positive' : (actualProfitGainMonthly < -0.01 ? 'negative' : 'neutral');
    }
    const beforePeriod = {
      from: before.from, to: before.to,
      days: before.totalDays, coveredDays: before.coveredDays,
      status: before.status, metrics: before.metrics
    };
    const duringPeriod = {
      from: during.from, to: during.to,
      days: during.totalDays, coveredDays: during.coveredDays,
      status: during.status, metrics: during.metrics
    };
    const comparison = {
      actualSalesUpliftPct,
      forecastSalesUpliftPct: forecast.salesUpliftPct,
      salesUpliftDeltaPp,
      salesDeviationPct,
      actualProfitMonthDuring,
      forecastProfitMonthDuring,
      profitForecastDeviationPct,
      actualProfitGainMonthly,
      forecastProfitGainMonth,
      profitGainDeviationPct,
      breakEvenMet,
      periodComplete,
      effectEvaluable,
      explanation: effectEvaluable ? '' : (!periodComplete
        ? 'Окно участия ещё не завершено.'
        : (before.status !== 'complete' || during.status !== 'complete'
          ? 'Финансовый отчёт WB покрывает не все дни окна.'
          : (!costKnown ? 'Не задана себестоимость товара; прибыль и эффект не оцениваются.' : '')))
    };
    return {
      id: [episode.promoKey, episode.nmID, episode.joinedAt, index].join('|'),
      nmID: episode.nmID,
      vendorCode: episode.vendorCode,
      title: episode.title || item.title || '',
      promoId: episode.promoId,
      promoName: episode.promoName,
      joinedAt: episode.joinedAt,
      joinedDay: episode.joinedDay,
      exitAt: episode.exitAt,
      promoEndAt: episode.promoEndAt || '',
      source: episode.source,
      windowDays: days,
      costKnown,
      windowsComplete,
      before: beforePeriod,
      during: duringPeriod,
      forecast,
      comparison,
      stockout,
      stockoutDate: stockoutSnapshot,
      stockStatus: stockout ? 'zero-observed' : (stockSnapshotDates.length ? 'observed-no-zero' : 'unknown'),
      stockObservedDays: stockSnapshotDates.length,
      effect,
      effectEvaluable,
      eligibleForConclusion: effectEvaluable && !stockout
    };
  });

  const groupMap = new Map();
  items.forEach((item) => {
    const key = item.promoId !== null ? 'id:' + item.promoId : 'name:' + String(item.promoName || '').toLowerCase();
    let group = groupMap.get(key);
    if (!group) {
      group = { key, promoId: item.promoId, promoName: item.promoName, items: [] };
      groupMap.set(key, group);
    }
    group.items.push(item);
  });
  const promos = Array.from(groupMap.values()).map((group) => Object.assign(group, aggregateGroup(group.items)));
  promos.sort((a, b) => String(a.promoName || '').localeCompare(String(b.promoName || ''), 'ru'));
  const summary = aggregateGroup(items);
  summary.stockoutCount = items.filter((x) => x.stockout).length;
  summary.pendingCount = items.filter((x) => !x.effectEvaluable && !x.stockout).length;
  summary.reportAvailable = hasDailyData;
  summary.noReportItemCount = items.filter((x) => x.before.status === 'no-report' || x.during.status === 'no-report').length;

  let dataStatus = 'ready';
  let message = '';
  if (!hasDailyData) {
    if (incompleteFinanceData) {
      dataStatus = 'incomplete-report';
      message = 'Последний финансовый отчёт WB загружен не полностью (достигнут лимит страниц). Неполные строки не используются как полное покрытие; отсутствующие даты не считаются нулевыми. Повторите загрузку отчёта.';
    } else if (legacyFactData) {
      dataStatus = 'daily-data-unavailable';
      message = 'Сохранённый финансовый отчёт не содержит разбивки по товарам и дням. После загрузки отчёта WB эта разбивка будет записана; до этого значения не подменяются нулями.';
    } else {
      dataStatus = 'no-report';
      message = 'Данных ещё нет: финансовый отчёт WB не загружен. Загрузите его через существующий раздел «Фактические расходы»; аналитика сама не обращается к WB и не расходует лимит «Финансы». Значения окон остаются пустыми, а не нулевыми.';
    }
  } else if (incompleteFinanceData) {
    dataStatus = 'incomplete-report';
    message = 'Последняя загрузка финансового отчёта WB неполная. Аналитика сохраняет ранее подтверждённые полные даты; отсутствующие в неполной загрузке дни не считаются нулевыми.';
  } else if (summary.pendingCount || summary.noReportItemCount) {
    message = 'Часть окон пока не покрыта сохранёнными финансовыми отчётами WB или ещё не завершилась. Для этих окон выводы не делаются.';
  }

  return {
    ok: true,
    days,
    dataStatus,
    reportAvailable: hasDailyData,
    message,
    meta: {
      reportFrom: dateRange.from,
      reportTo: dateRange.to,
      coveredDates: coveredDates.size,
      dailyItemsAvailable: hasDailyData,
      source: src.reportMeta && src.reportMeta.source || '',
      loadedAt: src.reportMeta && (src.reportMeta.loadedAt || src.reportMeta.updatedAt) || null
    },
    summary,
    promos,
    items
  };
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  clampWindowDays,
  pairPromoEpisodes,
  promoAnalytics
};
