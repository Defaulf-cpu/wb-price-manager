'use strict';

/** Настройки: API-ключи, режим, налоговая модель, комиссия, логистика, защитные пороги. */
window.Views = window.Views || {};

const KEY_NAMES = {
  single: 'Один ключ на все разделы',
  prices: 'Цены и скидки',
  statistics: 'Статистика',
  content: 'Контент',
  finance: 'Финансы'
};

/**
 * Подпись под полем ключа: сохранён ли он и кнопка «удалить этот ключ».
 * Пустое поле при сохранении больше НЕ удаляет ключ (иначе повторное нажатие
 * «Сохранить» стирало все ключи), поэтому удаление сделано явной кнопкой.
 */
function keySavedRow(name, masked) {
  if (!masked) {
    return '<span class="tiny muted">не сохранён — пустое поле при сохранении ничего не меняет</span>';
  }
  return `<span class="row tiny" style="gap:8px;margin-top:4px;align-items:center">
      <b class="pos">✓ сохранён</b> <span class="muted mono">${String(masked)}</span>
      <button class="btn btn-ghost btn-sm k-clear-one" data-key="${name}" type="button">Удалить этот ключ</button>
    </span>`;
}

Views.settings = {
  title: 'Настройки',
  subtitle: 'API-ключи Wildberries, параметры расчёта и защитные ограничения',

  render(container) {
    this.container = container;
    this.draw();
  },

  async draw() {
    const container = this.container;
    if (this.updateStatusOff) { this.updateStatusOff(); this.updateStatusOff = null; }
    container.innerHTML = UI.loading('Читаем настройки…');
    const info = await API.invoke('app:state');
    const s = info.settings;
    const appInfo = await API.appInfo();
    const initialUpdateState = API.isElectron
      ? await API.invoke('ui:update-state').catch(() => null)
      : null;
    const hasRealKey = !!(info.keys && (info.keys.single || info.keys.prices || info.keys.statistics || info.keys.content || info.keys.finance));
    const demoHint = s.demoMode
      ? (hasRealKey
        ? '<b class="warnc">Ключ задан, но демо-режим включён</b> — данные не настоящие. Снимите галку, чтобы работать со своим кабинетом.'
        : 'Включён: показываем сгенерированные данные магазина. Как только вставите ключ, галка снимется автоматически.')
      : '<b class="pos">Выключен</b> — работаем с реальными данными вашего кабинета WB.';

    const cov = info.coverage || {};
    const covRow = (key, title, note) => `<span class="tiny" style="margin-right:10px">
        ${cov[key] ? '<b class="pos">✓</b>' : '<b class="neg">✗</b>'} ${U.esc(title)}${note ? ' <span class="muted">' + U.esc(note) + '</span>' : ''}</span>`;
    const coverageHtml = info.demo
      ? '<span class="hint">Демо-режим: ключи не нужны, данные сгенерированы.</span>'
      : `<div class="row wrap" style="gap:2px;margin-bottom:6px">
           ${covRow('prices', 'Цены и скидки', '— цены, скидки, акции')}
           ${covRow('statistics', 'Статистика', '— продажи')}
           ${covRow('content', 'Контент', '— габариты')}
           ${covRow('finance', 'Финансы', '— факт расходов')}
         </div>
         <p class="hint" style="margin:0">${cov.universal
           ? 'Задан единый ключ — он используется для всех разделов. Отдельные ключи имеют приоритет, если заполнены.'
           : 'Единый ключ не задан: разделы работают по отдельным ключам. Раздел без ключа будет недоступен.'}</p>`;

    // Диагностика: канал полного обновления обязан быть разрешён мостом Electron.
    // Именно рассинхрон preload.js и service.js давал «Неизвестный канал: data:refresh-all».
    const bridge = window.wbApp;
    const bridgeChannels = bridge && Array.isArray(bridge.channels) ? bridge.channels : null;
    const bridgeInfo = !bridge
      ? '<span class="muted">Режим браузера / dev-сервер — мост Electron не используется, каналы берёт на себя сервер.</span>'
      : (bridgeChannels
        ? (bridgeChannels.indexOf('data:refresh-all') >= 0
          ? '<b class="pos">✓</b> Мост Electron в порядке: канал полного обновления доступен (разрешено ' + bridgeChannels.length + ' каналов' +
            (bridge.channelsFromMain ? ', список получен из основного процесса' : ', список из preload.js') + ').'
          : '<b class="neg">✗ Файлы приложения рассинхронизированы:</b> в <span class="mono">electron/preload.js</span> нет канала ' +
            '<span class="mono">data:refresh-all</span>, хотя <span class="mono">electron/service.js</span> его реализует. ' +
            'Скопируйте проект заново целиком и перезапустите приложение.')
        : '<b class="warnc">Мост Electron старый:</b> не отдаёт список каналов — обновите <span class="mono">electron/preload.js</span> и <span class="mono">electron/main.js</span>.');
    const secretsErrorHtml = info.secretsError
      ? `<div class="alert danger" style="margin-bottom:12px"><b>Сохранённые ключи не прочитались.</b><br>${U.esc(info.secretsError)}</div>`
      : '';

    // состояние статистики и фоновой догрузки — справочные каналы, в WB не ходят
    const statsInfo = await API.invoke('stats:state').catch(() => null);
    const deferredInfo = await API.invoke('data:deferred').catch(() => null);
    const rateInfo = await API.invoke('wb:rate-state').catch(() => null);
    const statsMeta = (statsInfo && statsInfo.meta) || {};
    const deferredItems = (deferredInfo && deferredInfo.items) || [];
    const rateCats = (rateInfo && rateInfo.categories) || null;

    const factsInfo = await API.invoke('facts:get').catch(() => null);
    const fMeta = (factsInfo && factsInfo.meta) || {};
    const fCount = factsInfo ? Number(factsInfo.count || 0) : 0;
    const factsBadge = fCount > 0
      ? UI.badge('загружено по ' + fCount + ' товарам', 'ok')
      : UI.badge('факт не загружен — работаем по справочнику', 'warn');
    const factsStatus = fCount > 0
      ? 'Загружено: <b>' + fCount + '</b> товаров, окно <b>' + U.esc(String(fMeta.dateFrom || '?')) + ' → ' + U.esc(String(fMeta.dateTo || '?')) +
        '</b> (' + U.num(fMeta.days || fMeta.windowDays, 0) + ' дн), источник <span class="mono">' + U.esc(String(fMeta.source || '—')) + '</span>' +
        (fMeta.loadedAt ? ', обновлено ' + U.date(fMeta.loadedAt, true) : '') +
        (fMeta.widened
          ? '<br><b class="warnc">Взят последний доступный отчёт WB</b>: за ' + U.esc(String(fMeta.requestedFrom || '?')) + ' → ' +
            U.esc(String(fMeta.requestedTo || '?')) + ' отчёта ещё нет (запрошен ' +
            (fMeta.requestedPeriod === 'weekly' ? 'недельный' : 'дневной') + ', загружен ' +
            (fMeta.period === 'weekly' ? 'недельный' : 'дневной') + ').'
          : '') +
        (Array.isArray(fMeta.reportsUsed) && fMeta.reportsUsed.length
          ? '<br>Отчёты WB: ' + fMeta.reportsUsed.slice(0, 6).map((r) =>
              '<span class="mono">' + U.esc(String(r.reportId || r.id || '?')) + '</span> (' +
              U.esc(String(r.dateFrom || '?')) + ' → ' + U.esc(String(r.dateTo || '?')) + ', ' +
              U.esc(String(r.period || '')) + ')').join(', ') +
            (fMeta.reportsUsed.length > 6 ? ' и ещё ' + (fMeta.reportsUsed.length - 6) : '')
          : '') +
        (fMeta.rowsProcessed ? '<br>Строк отчёта обработано: <b>' + U.num(fMeta.rowsProcessed) + '</b>' +
          (fMeta.pages ? ' (страниц WB: ' + U.num(fMeta.pages) + ')' : '') : '')
      : 'Факт не загружен. Нажмите «Загрузить фактические расходы» — понадобится ключ категории «Финансы». ' +
        'Если WB ответит пустым отчётом, ранее сохранённые расходы останутся на месте, ' +
        'а приложение предложит найти последний сформированный отчёт.';

    // что приложение делает в фоне прямо сейчас
    const DEFER_STATE = {
      scheduled: 'ожидает лимит WB',
      running: 'догружается…',
      done: 'дозагружено',
      failed: 'не догрузилось'
    };
    const deferredHtml = deferredItems.length
      ? deferredItems.map((d) => `<li><b>${U.esc(d.title)}</b> — ${U.esc(DEFER_STATE[d.state] || d.state)}` +
          (d.state === 'scheduled' && d.retryAt ? ' (повтор в ' + U.time(d.retryAt) + ')' : '') +
          (d.state === 'done' && d.detail ? ': ' + U.esc(d.detail) : '') +
          (d.state === 'failed' && d.error ? ': <span class="neg">' + U.esc(d.error) + '</span>' : '') +
          (d.state === 'scheduled' ? ` <button class="btn btn-sm btn-ghost" data-defer-run="${U.esc(d.name)}">Догрузить сейчас</button>` : '') +
          `</li>`).join('')
      : '<li class="muted">Ничего не отложено — все разделы загружены.</li>';

    const rateHtml = rateCats
      ? ['statistics', 'finance', 'prices', 'content'].filter((k) => rateCats[k]).map((k) => {
        const c = rateCats[k];
        const names = { statistics: 'Статистика', finance: 'Финансы', prices: 'Цены и скидки', content: 'Контент' };
        const wait = Number(c.waitMs || 0);
        return UI.badge(names[k] + ': ' + (wait > 0 ? 'свободна через ' + Math.ceil(wait / 1000) + ' с' : 'свободна'), wait > 0 ? 'warn' : 'ok');
      }).join(' ')
      : '<span class="hint">В демо-режиме запросы к WB не отправляются — лимиты не расходуются.</span>';

    const statsHtml = (statsInfo && statsInfo.count > 0)
      ? 'Загружено <b>' + U.num(statsInfo.count) + '</b> товаров с продажами' +
        (statsMeta.loadedAt ? ', ' + U.date(statsMeta.loadedAt, true) : '') +
        (statsMeta.withOrders ? ', заказы догружены' : (statsMeta.ordersPending ? ', <b class="warnc">заказы ещё не загружены</b>' : '')) +
        (statsMeta.salesPages ? ', страниц WB: ' + U.num(statsMeta.salesPages) : '') +
        (statsMeta.truncated ? ' <span class="neg">(данные обрезаны — увеличьте лимит страниц)</span>' : '')
      : 'Статистика не загружена. Нажмите «Обновить данные из WB» или «Загрузить статистику» ниже.';

    container.innerHTML = `
      <div class="grid g2">
        <div class="col">
          <div class="card">
            <h2>1. Подключение к Wildberries</h2>
            ${secretsErrorHtml}
            <div class="alert ${info.demo ? 'warn' : 'ok'}" style="margin-bottom:12px">
              ${info.demo
                ? '<b>Сейчас включён демо-режим.</b> Данные сгенерированы локально, в WB ничего не отправляется. Введите ключи ниже и снимите галку «Демо-режим», чтобы работать с реальным кабинетом.'
                : '<b>Работаем с реальными данными кабинета WB.</b> Все изменения цен отправляются в Wildberries после подтверждения.'}
            </div>

            <label class="checkline" style="margin-bottom:4px">
              <input type="checkbox" id="k-demo" ${s.demoMode ? 'checked' : ''} /> Демо-режим (без обращения к WB API)
            </label>
            <div id="k-demo-hint" class="hint" style="margin-bottom:12px">${demoHint}</div>

            <div class="col" style="gap:10px">
              <label class="field"><b>Один ключ на все разделы</b> <span class="muted tiny">— рекомендуется: вставьте сюда токен, созданный со всеми нужными категориями</span>
                <input type="password" id="k-single" placeholder="${info.keys.single ? 'сохранён: ' + info.keys.single + ' — вставьте новый, чтобы заменить' : 'eyJhbGciOi…'}" autocomplete="off" />
                ${keySavedRow('single', info.keys.single)}
              </label>
              <div id="k-coverage">${coverageHtml}</div>
              <details style="margin-bottom:4px">
                <summary class="hint" style="cursor:pointer">У меня отдельные ключи на каждую категорию — показать поля</summary>
                <div class="col" style="gap:10px;margin-top:10px">
                  <label class="field">Ключ «Цены и скидки» <span class="muted tiny">— цены, скидки, календарь акций</span>
                    <input type="password" id="k-prices" placeholder="${info.keys.prices ? 'сохранён: ' + info.keys.prices + ' — вставьте новый, чтобы заменить' : 'не задан'}" autocomplete="off" />
                    ${keySavedRow('prices', info.keys.prices)}
                  </label>
                  <label class="field">Ключ «Статистика» <span class="muted tiny">— продажи и заказы для экономики и оборачиваемости</span>
                    <input type="password" id="k-stats" placeholder="${info.keys.statistics ? 'сохранён: ' + info.keys.statistics + ' — вставьте новый, чтобы заменить' : 'не задан'}" autocomplete="off" />
                    ${keySavedRow('statistics', info.keys.statistics)}
                  </label>
                  <label class="field">Ключ «Контент» <span class="muted tiny">— названия, габариты и объём товаров (для логистики)</span>
                    <input type="password" id="k-content" placeholder="${info.keys.content ? 'сохранён: ' + info.keys.content + ' — вставьте новый, чтобы заменить' : 'не задан'}" autocomplete="off" />
                    ${keySavedRow('content', info.keys.content)}
                  </label>
                  <label class="field">Ключ «Финансы» <span class="muted tiny">— отчёты о реализации: фактическая логистика, комиссии, хранение, эквайринг</span>
                    <input type="password" id="k-finance" placeholder="${info.keys.finance ? 'сохранён: ' + info.keys.finance + ' — вставьте новый, чтобы заменить' : 'не задан'}" autocomplete="off" />
                    ${keySavedRow('finance', info.keys.finance)}
                  </label>
                  <p class="hint" style="margin:0">Отдельный ключ имеет приоритет над общим. Пустое поле = не задан.</p>
                </div>
              </details>
              <label class="checkline"><input type="checkbox" id="k-sandbox" ${s.sandbox ? 'checked' : ''} /> Песочница WB (тестовый контур API)</label>
            </div>

            <div class="row wrap" style="margin-top:12px">
              <button class="btn btn-primary" id="k-save-refresh">Сохранить ключи и обновить данные</button>
              <button class="btn" id="k-save">Только сохранить ключи</button>
              <button class="btn" id="k-check">Проверить доступ</button>
              <button class="btn btn-ghost" id="k-clear">Удалить ключи</button>
            </div>
            <div id="k-result" style="margin-top:12px"></div>

            <div class="divider"></div>
            <h3>Как получить ключ</h3>
            <ol class="hint" style="margin:0;padding-left:18px;line-height:1.7">
              <li>Зайдите в личный кабинет продавца: <a href="#" id="lnk-seller" style="color:var(--info)">seller.wildberries.ru</a></li>
              <li>«Настройки» → «Доступ к API» → «Создать токен».</li>
              <li>Отметьте категории: <b>Цены и скидки</b> (обязательно), <b>Статистика</b>, <b>Контент</b>, <b>Финансы</b> (фактическая логистика и комиссии).</li>
              <li>Скопируйте токен и вставьте в поле <b>«Один ключ на все разделы»</b> — этого достаточно.</li>
              <li>Нажмите <b>«Сохранить ключи и обновить данные»</b>: приложение сразу выгрузит товары, цены, акции, статистику и расходы из вашего кабинета.</li>
            </ol>
            <p class="hint" style="margin-top:8px">${bridgeInfo}</p>
            <p class="hint" style="margin-top:6px">Хранение: ${U.esc(info.secretsMethod || 'ключи ещё не сохранялись')}${info.keysSet ? ', сохранено ключей: <b>' + U.num(info.keysSet, 0) + '</b>' : ', ключи не сохранены'}. Ключи лежат в каталоге приложения
              (<span class="mono">${U.esc(appInfo ? appInfo.appDir : '')}</span>) и не передаются в интерфейс — все запросы к WB выполняет основной процесс.</p>
          </div>
        </div>

        <div class="col">
          <div class="card">
            <h2>2. Модель расчёта экономики</h2>
            <div class="grid g2" style="gap:10px">
              <label class="field">Схема работы
                <select id="s-model">
                  <option value="marketplace" ${s.model === 'marketplace' ? 'selected' : ''}>Маркетплейс (FBW/ВБ-склад)</option>
                  <option value="fbw" ${s.model === 'fbw' ? 'selected' : ''}>FBW (хранение WB)</option>
                </select>
              </label>
              <label class="field">Комиссия WB по умолчанию, %<input type="number" class="num" id="s-comm" value="${s.commissionDefault}" step="0.5" /></label>
              <label class="field">Логистика: база, ₽<input type="number" class="num" id="s-logbase" value="${s.logisticsBaseRub}" step="1" /></label>
              <label class="field">Логистика: за каждый литр свыше 1 л, ₽<input type="number" class="num" id="s-logliter" value="${s.logisticsPerLiterRub}" step="1" /></label>
              <label class="field">Порог «крупного» товара, л<input type="number" class="num" id="s-litthresh" value="${s.literThreshold}" step="1" /></label>
              <label class="field">Логистика крупного товара, ₽<input type="number" class="num" id="s-loglarge" value="${s.logisticsLargeRub}" step="1" /></label>
              <label class="field">Приёмка, ₽/шт<input type="number" class="num" id="s-accept" value="${s.acceptRub}" step="1" /></label>
              <label class="field">Хранение, ₽/шт в месяц<input type="number" class="num" id="s-storage" value="${s.storageRubPerUnit}" step="0.5" /></label>
              <label class="field">Упаковка, ₽/шт<input type="number" class="num" id="s-pack" value="${s.packagingRub}" step="1" /></label>
              <label class="field">Реклама по умолчанию, % от цены<input type="number" class="num" id="s-ad" value="${s.adPctDefault}" step="0.5" /></label>
              <label class="field">Эквайринг, %<input type="number" class="num" id="s-acq" value="${s.acquiringPct}" step="0.1" /></label>
              <label class="field">СПП по умолчанию, %<input type="number" class="num" id="s-spp" value="${s.sppDefault}" step="1" /></label>
              <label class="field">Налоговый режим
                <select id="s-taxmode">${EC.TAX_MODES.map((m) => `<option value="${m.id}" ${s.taxMode === m.id ? 'selected' : ''}>${U.esc(m.label)}</option>`).join('')}</select>
              </label>
              <label class="field">Ставка налога, % (если своя)<input type="number" class="num" id="s-taxrate" value="${s.taxRate}" step="0.5" /></label>
              <label class="field">Целевая маржинальность, %<input type="number" class="num" id="s-target" value="${s.targetMarginPct}" step="1" /></label>
              <label class="field">Порог «низкой маржи», %<input type="number" class="num" id="s-alert" value="${s.minMarginPctAlert}" step="1" /></label>
            </div>
            <p class="hint" style="margin-top:10px">Точную комиссию по каждому товару WB через API не отдаёт — укажите её по категории ниже
              (или возьмите из отчёта о реализации в личном кабинете). Значения по товару можно переопределить в разделе «Себестоимость».</p>
          </div>

          <div class="card">
            <h2>3. Защита от ошибок при переценке</h2>
            <label class="checkline"><input type="checkbox" id="g-quar" ${s.quarantineGuard ? 'checked' : ''} />
              Предупреждать о карантине цен WB (падение цены более чем в 3 раза)</label>
            <div class="grid g2" style="gap:10px;margin-top:10px">
              <label class="field">Максимальное изменение цены без предупреждения, %<input type="number" class="num" id="g-max" value="${s.maxPriceChangePct}" step="5" /></label>
              <label class="field">Требовать подтверждение при изменении свыше, %<input type="number" class="num" id="g-confirm" value="${s.requireConfirmAbove}" step="5" /></label>
            </div>
            <p class="hint" style="margin-top:8px">Любая массовая отправка цен проходит через предпросмотр: видно старую и новую цену, прибыль, маржу и все предупреждения.</p>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>3.1 Фактические расходы из отчёта WB</h2>
          <span class="hint">${factsBadge}</span></div>
        <div style="padding:14px 16px 16px">
          <div class="alert info" style="margin-bottom:12px">
            Логистика и комиссия WB — плавающие: они зависят от объёма, веса, направления и тарифов
            конкретного дня. Справочник категорий даёт лишь оценку. Точные цифры есть в
            <b>ежедневном отчёте о реализации</b> — том самом, по которому WB считает выплаты.
            Приложение загружает его через финансовый API и усредняет за выбранное окно.
          </div>

          <label class="checkline" style="margin-bottom:12px">
            <input type="checkbox" id="f-use" ${s.useFactCosts !== false ? 'checked' : ''} />
            <b>Брать логистику, комиссию, хранение, приёмку и эквайринг из отчёта WB</b>
          </label>

          <div class="grid g3" style="margin-bottom:12px">
            <label class="field">Окно усреднения, дней
              <input type="number" class="num" id="f-days" value="${U.num(s.factWindowDays, 7)}" min="1" max="90" step="1" /></label>
            <label class="field">Период отчёта
              <select id="f-period">
                <option value="daily" ${s.factCostsPeriod === 'weekly' ? '' : 'selected'}>Ежедневный (точнее)</option>
                <option value="weekly" ${s.factCostsPeriod === 'weekly' ? 'selected' : ''}>Недельный (быстрее)</option>
              </select></label>
            <label class="field">Автообновление, часов
              <input type="number" class="num" id="f-refresh" value="${U.num(s.factAutoRefreshHours, 12)}" min="0" max="168" step="1" /></label>
          </div>
          <p class="hint" style="margin-top:-4px">0 — не обновлять автоматически. Отчёт публикуется раз в сутки,
            поэтому данные за сегодня могут быть неполными; окно в 7 дней это сглаживает.</p>

          <div class="grid g3" style="margin:12px 0">
            <label class="field">Искать отчёт за последние, дней
              <input type="number" class="num" id="f-lookback" value="${U.num(s.factLookbackDays, 60)}" min="7" max="365" step="1" /></label>
            <label class="field">Страниц детализации (по 1 в минуту)
              <input type="number" class="num" id="f-maxpages" value="${U.num(s.factMaxPages, 10)}" min="1" max="200" step="1" /></label>
            <label class="checkline" style="align-self:end">
              <input type="checkbox" id="f-widen" ${s.factAutoWiden !== false ? 'checked' : ''} />
              <b>Брать последний доступный отчёт, если за выбранные дни пусто</b>
            </label>
          </div>
          <div class="alert warn" style="margin-bottom:12px">
            <b>Почему бывает «0 строк».</b> WB формирует отчёты о реализации с задержкой: дневной — на следующий день,
            недельный — в понедельник за прошлую неделю. Если за выбранные дни отчёта ещё нет, приложение не показывает
            пустые цифры как успех: оно ищет последний сформированный отчёт за указанное число дней и подписывает,
            какой период взят. Сохранённые ранее расходы при этом не стираются.
          </div>

          <div class="row wrap" style="margin-top:12px">
            <button class="btn btn-primary" id="f-load">Загрузить фактические расходы</button>
            <button class="btn btn-ghost" id="f-find">Найти последний отчёт WB</button>
            <button class="btn btn-ghost" id="f-clear">Очистить и вернуться к справочнику</button>
            <span class="hint" id="f-status">${factsStatus}</span>
          </div>

          <div class="alert warn" style="margin-top:12px">
            <b>Приоритет источников.</b> Ручная настройка товара → факт из отчёта WB → справочник категории →
            настройки кабинета → формула. Если вы указали значение руками, факт его не перекроет.
            Источник каждой цифры подписан в разделах «Экономика» и «Себестоимость».
          </div>
          <p class="hint">Нужен ключ категории <b>«Финансы»</b>; лимит WB — 1 запрос в минуту,
            поэтому загрузка отчёта за длинное окно может занять несколько минут.</p>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>3.2 Статистика продаж и лимиты WB</h2>
          <span class="hint">${rateHtml}</span></div>
        <div style="padding:14px 16px 16px">
          <div class="alert info" style="margin-bottom:12px">
            Категория <b>«Статистика»</b> у WB ограничена жёстко: <b>один запрос в минуту</b> (это не рекомендация,
            а потолок — иначе HTTP 429). Продажи и заказы — это два разных запроса, поэтому приложение грузит продажи
            сразу, а заказы добирает в фоне отдельным вызовом. Так «Обновить данные из WB» не висит минуту и не
            получает 429 на ровном месте.
          </div>
          <p class="hint" style="margin-bottom:10px">${statsHtml}</p>
          <div class="grid g3" style="margin-bottom:12px">
            <label class="checkline" style="align-self:end">
              <input type="checkbox" id="f-orders" ${s.statsLoadOrders !== false ? 'checked' : ''} />
              <b>Догружать заказы отдельным запросом</b>
            </label>
            <label class="field">Страниц статистики (по ~80 000 строк)
              <input type="number" class="num" id="f-statpages" value="${U.num(s.statsMaxPages, 3)}" min="1" max="20" step="1" /></label>
            <div class="row wrap" style="align-self:end">
              <button class="btn btn-sm" id="f-load-stats">Загрузить статистику</button>
              <button class="btn btn-sm btn-ghost" id="f-load-orders">Догрузить заказы</button>
            </div>
          </div>
          <div style="margin-top:6px">
            <b class="hint">Фоновая догрузка разделов</b>
            <ul class="tiny" style="margin:6px 0 0;padding-left:18px">${deferredHtml}</ul>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>3.3 Акции: переход в кабинет WB</h2></div>
        <div style="padding:14px 16px 16px">
          <div class="alert info" style="margin-bottom:12px">
            Кнопка <b>«Перейти к акции»</b> в разделах «Акции» и в карточке товара открывает в браузере
            <b>сразу нужную акцию</b> (в адрес подставляется её ID). На странице остаётся нажать
            <b>«Перейти к товарам для акции» → «Сформировать» → «Скачать»</b>, а скачанный файл загрузить
            в приложение кнопкой «Загрузить товары из файла».
          </div>
          <label class="field">Адрес кабинета WB (шаблон ссылки)
            <input id="s-promourl" value="${U.esc(s.promoCabinetUrl || '')}" style="width:100%"
              placeholder="https://seller.wildberries.ru/dp-promo-calendar?action={id}" /></label>
          <p class="hint" style="margin-top:6px">Ссылка открывается <b>сразу на нужной акции</b>: в шаблон подставляется
            <span class="mono">{id}</span> из календаря WB (доступна и подстановка <span class="mono">{name}</span>).
            На странице остаётся нажать «Перейти к товарам для акции» → «Сформировать» → «Скачать».
            Если WB поменяет адрес — поправьте эту строку, код менять не нужно.</p>
          <div class="row wrap" style="margin-top:10px">
            <button class="btn btn-sm" id="s-promourl-test">Открыть календарь акций сейчас</button>
            <button class="btn btn-sm btn-ghost" id="s-promourl-reset">Вернуть адрес по умолчанию</button>
          </div>

          <div class="divider" style="margin:14px 0"></div>
          <h3 style="margin:0 0 6px">Откуда брать состав акции</h3>
          <div class="alert info" style="margin-bottom:10px">
            Метод WB <span class="mono">/calendar/promotions/nomenclatures</span> помечен
            «Not applicable for auto promotions» и отвечает <span class="mono">HTTP 422</span> почти на любой акции.
            Точный состав — это файл из кабинета («Перейти к товарам для акции» → «Сформировать» → «Скачать»),
            который вы загружаете в разделе «Акции». Поэтому по умолчанию приложение к WB за составом не обращается.
          </div>
          <label class="checkline" style="margin-bottom:8px">
            <input type="checkbox" id="s-promo-infer" ${s.promosInferFromDiscount !== false ? 'checked' : ''} />
            <b>Определять участие по факту скидки товара</b>
            <span class="hint">WB сообщает, что скидка есть, но не сообщает, в какой именно акции.
              Товар со скидкой ≥ требуемой считается участником — этого достаточно для расчёта экономики.</span>
          </label>
          <label class="checkline">
            <input type="checkbox" id="s-promo-fetch" ${s.promosFetchNomenclatures === true ? 'checked' : ''} />
            <b>Запрашивать состав акции у WB</b>
            <span class="hint">Не рекомендуется: автоакции пропускаются всегда, а обычные часто отвечают 422.
              Включайте, только если у вас точно есть обычные акции, по которым WB отдаёт состав.</span>
          </label>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>3.4 Наблюдатель цен витрины WB</h2>
          <span class="hint">СПП, цена и остаток глазами покупателя</span></div>
        <div style="padding:14px 16px 16px">
          <div class="alert info" style="margin-bottom:12px">
            API продавца <b>не отдаёт</b> витринную цену, фактический СПП и остаток на витрине.
            Наблюдатель читает карточку товара на витрине WB и пишет наблюдения в файл
            <span class="mono">pricewatch.json</span>. Медиана СПП за 7 дней попадает в экономику
            как источник <b>«витрина WB»</b> — она свежее среднего по статистике продаж.
            Смотреть и править наблюдения: карточка товара → вкладка <b>«Цены на площадке»</b>.
          </div>
          <label class="checkline" style="margin-bottom:8px">
            <input type="checkbox" id="s-pw-auto" ${s.priceWatchAutoFetch === true ? 'checked' : ''} />
            <b>Разрешить автоматические запросы к витрине</b>
            <span class="hint">По умолчанию выключено, и это намеренно: витрина защищена от ботов.
              При ответе 403/429 или капчей наблюдатель честно сообщает о блокировке и останавливается
              до перезапуска приложения — повторные запросы только усилят блокировку.
              Кнопка «Обновить с витрины» в карточке товара работает и без этого переключателя.</span>
          </label>
          <div class="grid g3" style="gap:10px;margin-top:6px">
            <label class="field">Кэш наблюдения, минут
              <input type="number" class="num" id="s-pw-ttl" value="${U.num(s.priceWatchTtlMinutes, 60)}" min="1" max="1440" step="5" /></label>
          </div>
          <p class="hint" style="margin-top:8px">Ограничения наблюдателя: не более <b>200 товаров</b> за проход,
            запросы строго по очереди с паузой от <b>3 секунд</b> и случайной добавкой,
            история — до <b>50 записей</b> на товар. Цена конкурента записывается как цена покупателю (с СПП) —
            именно её сравнивает репрайсер в режиме «с СПП».</p>
          <p class="hint" style="margin-top:6px">В демо-режиме запросы к витрине не выполняются: демо-артикулы на WB не существуют.
            Ручной ввод при этом работает.</p>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>4. Комиссии и реклама по категориям</h2>
          <button class="btn btn-sm btn-ghost" id="cat-reset">Сбросить к значениям по умолчанию</button></div>
        <div id="cats-host"></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>5. Данные приложения</h2></div>
        <div class="row wrap">
          <button class="btn btn-sm" id="d-cache">Сбросить кэш товаров</button>
          <button class="btn btn-sm" id="d-tasks">История отправок цен</button>
          <button class="btn btn-sm btn-danger" id="d-reset">Сбросить все настройки</button>
          <div class="grow"></div>
          <span class="hint">Версия ${U.esc(appInfo ? appInfo.version : '')} · Electron ${U.esc(appInfo ? appInfo.electron : '')} · шифрование: ${U.esc(appInfo ? appInfo.encryption : '')}</span>
        </div>
        ${API.isElectron ? `
          <div style="border-top:1px solid var(--line);margin:12px 0 10px"></div>
          <div class="row wrap" style="gap:10px">
            <label class="row tiny" style="gap:8px;align-items:center;cursor:pointer">
              <input id="s-auto-update" type="checkbox" ${s.autoUpdateEnabled !== false ? 'checked' : ''}>
              Проверять обновления при запуске (рекомендуется)
            </label>
            <div class="grow"></div>
            <button class="btn btn-sm" id="btn-update-check" type="button">Проверить обновления</button>
            <button class="btn btn-sm btn-primary" id="btn-update-restart" type="button" hidden>Перезапустить и установить</button>
          </div>
          <p class="hint" id="update-status" role="status" aria-live="polite" style="margin:8px 0 0">Получаем состояние обновлений…</p>
          <p class="tiny muted" style="margin:5px 0 0">Новая версия загружается в фоне. Обновление приложения не удаляет пользовательские данные.</p>
        ` : ''}
      </div>

      <div style="margin-top:14px" class="row wrap">
        <button class="btn btn-primary" id="save-all">Сохранить настройки</button>
        <span class="hint">После сохранения расчёты во всех разделах пересчитаются автоматически.</span>
      </div>
    `;

    const $ = (id) => container.querySelector(id);

    function paintUpdateStatus(update) {
      const host = $('#update-status');
      const restartButton = $('#btn-update-restart');
      if (!host) return;
      if (!update || !update.status) {
        host.textContent = 'Не удалось получить состояние автообновления. Перезапустите приложение и попробуйте снова.';
        host.className = 'hint neg';
        if (restartButton) restartButton.hidden = true;
        return;
      }
      const version = update.updateVersion ? ' ' + update.updateVersion : '';
      const progress = Number.isFinite(Number(update.progress)) ? Math.floor(Number(update.progress)) : null;
      const messages = {
        idle: 'Проверка обновлений ещё не выполнялась.',
        checking: 'Проверяем GitHub Releases…',
        available: 'Доступна новая версия' + version + '; загружаем её в фоне.',
        downloading: 'Загружаем обновление' + version + (progress === null ? '…' : ': ' + progress + '%.'),
        downloaded: 'Обновление' + version + ' загружено. Нажмите «Перезапустить и установить», когда будете готовы.',
        'not-available': 'Установлена последняя версия' + version + '.',
        offline: 'Нет соединения с GitHub или сеть недоступна. Проверку можно повторить позже.',
        error: 'Не удалось проверить или загрузить обновление: ' + (update.error || 'неизвестная ошибка'),
        disabled: 'Автоматическая проверка при запуске отключена. Ручная проверка доступна кнопкой выше.',
        unavailable: 'Модуль автообновления недоступен: ' + (update.error || 'переустановите приложение из сборки с поддержкой обновлений.'),
        development: 'Автообновление доступно только в установленной Windows-сборке.',
        portable: 'Автообновление предназначено для установленной NSIS-версии. Портативную сборку обновляйте вручную.',
        unsupported: 'Автообновление поддерживается в Windows-сборке NSIS.',
        installing: 'Приложение закрывается для установки обновления…'
      };
      host.textContent = messages[update.status] || 'Состояние обновления: ' + update.status + '.';
      host.className = 'hint' + (update.status === 'downloaded' ? ' pos' :
        (update.status === 'offline' || update.status === 'error' || update.status === 'unavailable' ? ' warnc' : ''));
      if (restartButton) restartButton.hidden = update.status !== 'downloaded';
    }

    if (API.isElectron) {
      this.updateStatusOff = API.on('update-status', paintUpdateStatus);
      paintUpdateStatus(initialUpdateState);
      $('#s-auto-update').onchange = async (event) => {
        const checkbox = event.currentTarget;
        const enabled = checkbox.checked;
        checkbox.disabled = true;
        try {
          const result = await API.invoke('ui:update-enable', enabled);
          if (result && result.settings) S.state.settings = result.settings;
          paintUpdateStatus(result && result.update);
          UI.toast(enabled ? 'Автоматическая проверка обновлений включена' : 'Автоматическая проверка обновлений отключена', 'ok');
        } catch (error) {
          checkbox.checked = !enabled;
          UI.toast('Не удалось сохранить настройку обновлений: ' + error.message, 'err', 7000);
        } finally {
          checkbox.disabled = false;
        }
      };
      $('#btn-update-check').onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        paintUpdateStatus({ status: 'checking' });
        try { paintUpdateStatus(await API.invoke('ui:update-check')); }
        catch (error) { paintUpdateStatus({ status: 'error', error: error.message }); }
        finally { button.disabled = false; }
      };
      $('#btn-update-restart').onclick = async (event) => {
        event.currentTarget.disabled = true;
        try { await API.invoke('ui:update-restart'); }
        catch (error) {
          event.currentTarget.disabled = false;
          UI.toast('Не удалось запустить установку обновления: ' + error.message, 'err', 7000);
        }
      };
    }

    $('#lnk-seller').onclick = (e) => { e.preventDefault(); API.openExternal('https://seller.wildberries.ru/settings/access-to-api'); };

    // категории
    const catsHost = $('#cats-host');
    const cats = Object.keys(s.categoryDefaults || {});
    const grid = UI.table({
      columns: [
        { title: 'Категория', render: (c) => `<b>${U.esc(c.name)}</b>` },
        { title: 'Комиссия WB, %', num: true, render: (c) => catInput(c.name, 'commissionPct', c.def.commissionPct, '0.5') },
        { title: 'Реклама, %', num: true, render: (c) => catInput(c.name, 'adPct', c.def.adPct, '0.5') },
        { title: 'Упаковка, ₽', num: true, render: (c) => catInput(c.name, 'packagingRub', c.def.packagingRub, '1') },
        { title: 'Налоговый режим', render: (c) => {
            const sel = document.createElement('select');
            sel.style.width = '190px';
            const opts = [{ id: 'inherit', label: 'Как в общих настройках' }].concat(EC.TAX_MODES);
            opts.forEach((o) => {
              const op = document.createElement('option');
              op.value = o.id; op.textContent = o.label;
              if ((c.def.taxMode || 'inherit') === o.id) op.selected = true;
              sel.appendChild(op);
            });
            sel.onchange = () => { this.catPatch = this.catPatch || {}; this.catPatch[c.name] = Object.assign({}, this.catPatch[c.name], { taxMode: sel.value }); };
            return sel;
          } },
        { title: 'Товаров', num: true, render: (c) => U.fmt(c.count) }
      ],
      rows: cats.map((name) => ({
        name,
        def: s.categoryDefaults[name] || {},
        count: S.getRows().filter((r) => r.category === name).length
      })),
      empty: 'Категории появятся после загрузки товаров'
    });
    catsHost.appendChild(grid.el);

    function catInput(name, field, value, step) {
      const i = document.createElement('input');
      i.type = 'number'; i.step = step; i.className = 'num cellinput';
      i.value = value === undefined ? '' : value;
      i.onchange = () => {
        this.catPatch = this.catPatch || {};
        this.catPatch[name] = Object.assign({}, this.catPatch[name], { [field]: U.num(i.value) });
      };
      return i;
    }

    // сохранение
    $('#save-all').onclick = async () => {
      const patch = {
        model: $('#s-model').value,
        commissionDefault: U.num($('#s-comm').value),
        logisticsBaseRub: U.num($('#s-logbase').value),
        logisticsPerLiterRub: U.num($('#s-logliter').value),
        literThreshold: U.num($('#s-litthresh').value),
        logisticsLargeRub: U.num($('#s-loglarge').value),
        acceptRub: U.num($('#s-accept').value),
        storageRubPerUnit: U.num($('#s-storage').value),
        packagingRub: U.num($('#s-pack').value),
        adPctDefault: U.num($('#s-ad').value),
        acquiringPct: U.num($('#s-acq').value),
        sppDefault: U.num($('#s-spp').value),
        taxMode: $('#s-taxmode').value,
        taxRate: U.num($('#s-taxrate').value),
        targetMarginPct: U.num($('#s-target').value),
        minMarginPctAlert: U.num($('#s-alert').value),
        useFactCosts: $('#f-use').checked,
        factWindowDays: U.num($('#f-days').value, 7),
        factCostsPeriod: $('#f-period').value === 'weekly' ? 'weekly' : 'daily',
        factAutoRefreshHours: U.num($('#f-refresh').value, 12),
        factLookbackDays: U.num($('#f-lookback').value, 60),
        factMaxPages: U.num($('#f-maxpages').value, 10),
        factAutoWiden: $('#f-widen').checked,
        promoCabinetUrl: String($('#s-promourl').value || '').trim(),
        promosInferFromDiscount: $('#s-promo-infer').checked,
        promosFetchNomenclatures: $('#s-promo-fetch').checked,
        priceWatchAutoFetch: $('#s-pw-auto').checked,
        priceWatchTtlMinutes: U.num($('#s-pw-ttl').value, 60),
        statsLoadOrders: $('#f-orders').checked,
        statsMaxPages: U.num($('#f-statpages').value, 3),
        quarantineGuard: $('#g-quar').checked,
        maxPriceChangePct: U.num($('#g-max').value),
        requireConfirmAbove: U.num($('#g-confirm').value)
      };
      if (this.catPatch && Object.keys(this.catPatch).length) {
        patch.categoryDefaults = Object.assign({}, S.state.settings.categoryDefaults);
        for (const [name, vals] of Object.entries(this.catPatch)) {
          patch.categoryDefaults[name] = Object.assign({}, patch.categoryDefaults[name] || {}, vals);
        }
        this.catPatch = null;
      }
      await S.saveSettings(patch);
      S.invalidate();
      App.toast('Настройки сохранены', 'ok');
      App.refreshCurrent();
    };

    // фактические расходы из отчёта WB
    $('#f-load').onclick = async () => {
      const days = U.num($('#f-days').value, 7);
      const period = $('#f-period').value;
      const btn = $('#f-load');
      btn.disabled = true;
      $('#f-status').innerHTML = 'Загружаем отчёт о реализации… WB ограничивает частоту (1 запрос/мин), это может занять минуту-другую.';
      try {
        const res = await S.loadFacts({ days, period });
        if (res && res.ok) {
          App.toast('Фактические расходы загружены: ' + res.items + ' товаров, ' + res.rowsProcessed + ' строк отчёта' +
            (res.widened ? ' (взят последний доступный отчёт WB за ' + res.dateFrom + ' → ' + res.dateTo + ')' : ''), 'ok', 7000);
        } else if (res && res.empty) {
          // WB не отдал ни строки: это не сбой приложения, а отсутствие отчёта за период
          $('#f-status').innerHTML = '<b class="warnc">Отчёта за этот период у WB нет.</b> ' + U.esc(res.message || '') +
            '<br>Нажмите «Найти последний отчёт WB» — приложение просмотрит список отчётов и возьмёт последний сформированный.';
          App.toast('WB не отдал отчёт за выбранные дни — ищем последний доступный', 'warn', 8000);
        } else {
          App.toast((res && (res.message || res.error)) || 'Не удалось загрузить отчёт', 'err', 8000);
        }
      } catch (e) {
        App.toast(e.message, 'err', 8000);
      }
      this.draw();
    };

    /**
     * Поиск последнего сформированного отчёта WB: терпеливый режим (patient) —
     * приложение дожидается сброса минутного лимита, запрашивает список отчётов
     * за factLookbackDays дней и грузит детализацию за найденный период.
     */
    $('#f-find').onclick = async () => {
      const btn = $('#f-find');
      btn.disabled = true;
      $('#f-status').innerHTML = 'Спрашиваем у WB список отчётов о реализации… Лимит категории «Финансы» — 1 запрос в минуту, ' +
        'поиск с загрузкой детализации занимает одну-две минуты.';
      try {
        const res = await API.invoke('facts:load', {
          days: U.num($('#f-days').value, 7),
          period: $('#f-period').value,
          patient: true
        });
        if (res && res.ok) {
          await S.refreshFacts();
          S.invalidate();
          App.toast('Найден отчёт WB за ' + res.dateFrom + ' → ' + res.dateTo + ': ' + res.items + ' товаров, ' + res.rowsProcessed + ' строк', 'ok', 8000);
        } else {
          App.toast((res && (res.message || res.error)) || 'WB не сформировал ни одного отчёта', 'warn', 10000);
        }
      } catch (e) {
        App.toast(e.message, 'err', 9000);
      }
      this.draw();
    };

    // статистика: загрузить продажи (и заказы, если включено) / догрузить только заказы
    $('#f-load-stats').onclick = async () => {
      const btn = $('#f-load-stats');
      btn.disabled = true;
      btn.textContent = 'Загружаем… (лимит WB — 1 запрос/мин)';
      try {
        const res = await API.invoke('data:refresh-section', { name: 'stats', days: 30 });
        App.toast((res && res.detail) || 'Статистика загружена', 'ok', 7000);
        await S.loadGoods(false);
        S.invalidate();
      } catch (e) {
        App.toast(e.message, 'err', 9000);
      }
      this.draw();
    };

    $('#f-load-orders').onclick = async () => {
      const btn = $('#f-load-orders');
      btn.disabled = true;
      btn.textContent = 'Ждём лимит WB…';
      try {
        const res = await API.invoke('stats:orders', { days: 30, force: true });
        App.toast(res && res.skipped ? 'Заказы уже загружены' : 'Заказы догружены: ' + (res.orders || 0) + ' строк', 'ok', 7000);
        await S.loadGoods(false);
        S.invalidate();
      } catch (e) {
        App.toast(e.message, 'err', 9000);
      }
      this.draw();
    };

    $('#s-promourl-test').onclick = () => {
      const tpl = String($('#s-promourl').value || '').trim();
      if (!tpl) { App.toast('Укажите адрес кабинета WB', 'warn'); return; }
      API.openExternal(U.promoCabinetUrl({ id: '{id}', name: '{name}' }, { promoCabinetUrl: tpl }));
      App.toast('Открыли кабинет WB в браузере. Если страница не та — поправьте шаблон адреса и сохраните настройки.', 'ok', 8000);
    };

    $('#s-promourl-reset').onclick = () => {
      $('#s-promourl').value = 'https://seller.wildberries.ru/dp-promo-calendar?action={id}';
      App.toast('Адрес по умолчанию возвращён — нажмите «Сохранить настройки»', 'ok');
    };

    // фоновая догрузка: «Догрузить сейчас» для отложенного раздела
    container.querySelectorAll('[data-defer-run]').forEach((b) => {
      b.onclick = async () => {
        const name = b.getAttribute('data-defer-run');
        b.disabled = true;
        b.textContent = 'Догружаем…';
        try {
          const res = await API.invoke('data:refresh-section', { name });
          App.toast((res && res.detail) || 'Раздел догружен', 'ok', 7000);
          await S.reloadAfterDeferred(name);
        } catch (e) {
          App.toast(e.message, 'err', 9000);
        }
        this.draw();
      };
    });

    $('#f-clear').onclick = () => UI.confirmDialog('Очистить фактические расходы',
      '<div class="alert warn">Расчёты вернутся к справочнику категорий и формуле логистики. Загруженный отчёт будет удалён.</div>',
      async () => {
        await API.invoke('facts:clear');
        await S.refreshFacts();
        S.invalidate();
        App.toast('Фактические расходы очищены', 'ok');
        this.draw();
      });

    // Как только вставили настоящий ключ — демо-режим не нужен: снимаем галку сами.
    const keyInputs = ['#k-single', '#k-prices', '#k-stats', '#k-content', '#k-finance']
      .map((sel) => $(sel)).filter(Boolean);
    const hintOf = (checked, anyKey) => {
      if (checked) {
        return anyKey
          ? '<b class="warnc">Ключ задан, но демо-режим включён</b> — данные не настоящие. Снимите галку, чтобы работать со своим кабинетом.'
          : 'Включён: показываем сгенерированные данные магазина. Как только вставите ключ, галка снимется автоматически.';
      }
      return '<b class="pos">Выключен</b> — работаем с реальными данными вашего кабинета WB.';
    };
    const setHint = () => {
      const hint = $('#k-demo-hint');
      if (hint) hint.innerHTML = hintOf($('#k-demo').checked, keyInputs.some((i) => i.value.trim().length > 20));
    };
    // Демо снимаем только когда пользователь ВВОДИТ ключ. Если он сам вернул галку —
    // это его осознанный выбор, не спорим (иначе в демо нельзя было бы вернуться).
    const onKeyInput = () => {
      const anyKey = keyInputs.some((i) => i.value.trim().length > 20);
      if (anyKey && $('#k-demo').checked) {
        $('#k-demo').checked = false;
        const hint = $('#k-demo-hint');
        if (hint) hint.innerHTML = '<b class="pos">Ключ вставлен — демо-режим снят автоматически.</b> После сохранения приложение перейдёт на данные вашего кабинета WB.';
        return;
      }
      setHint();
    };
    keyInputs.forEach((i) => {
      i.addEventListener('input', onKeyInput);
      i.addEventListener('paste', () => setTimeout(onKeyInput, 0));
      i.addEventListener('change', onKeyInput);   // перетаскивание текста / автозаполнение
    });
    $('#k-demo').onchange = setHint;

    // ключи
    const KEY_FIELDS = { single: '#k-single', prices: '#k-prices', statistics: '#k-stats', content: '#k-content', finance: '#k-finance' };
    const KEY_TITLES = KEY_NAMES;
    const saveKeys = async () => {
      const payload = { demoMode: $('#k-demo').checked };
      const filled = [];
      for (const name of Object.keys(KEY_FIELDS)) {
        const el = $(KEY_FIELDS[name]);
        if (!el) continue;
        const v = el.value.trim();
        // Пустое поле НЕ отправляем: сервер трактует его как «не трогать сохранённый ключ».
        // Раньше уходила пустая строка — и сохранённые ключи удалялись при каждом «Сохранить».
        if (!v) continue;
        // маска сохранённого ключа (eyJhbG••••••••••cdef) — не ключ; записывать её нельзя
        if (/[•*]/.test(v)) {
          App.toast('В поле «' + KEY_TITLES[name] + '» маска сохранённого ключа, а не сам токен. Очистите поле и вставьте ключ заново.', 'warn', 9000);
          continue;
        }
        payload[name] = v;
        filled.push(name);
      }
      const res = await API.invoke('keys:set', payload);
      // Сервер сам снимает демо-режим при настоящем ключе — синхронизируем галку,
      // иначе следующий saveSettings вернул бы demoMode:true из устаревшего DOM.
      if (res && res.demoSwitched && $('#k-demo').checked) { $('#k-demo').checked = false; setHint(); }
      const demoToSave = (res && res.demoSwitched) ? false : $('#k-demo').checked;
      await S.saveSettings({ sandbox: $('#k-sandbox').checked, demoMode: demoToSave });
      await S.loadAppState();
      App.setModeBadge();
      if (res) res.filledNow = filled;
      return res;
    };

    const saveReport = (res) => {
      if (!res) return 'Ключи сохранены';
      const parts = [];
      if (res.saved && res.saved.length) parts.push('сохранено: ' + res.saved.map((k) => KEY_TITLES[k] || k).join(', '));
      if (res.ignored && res.ignored.length) parts.push('отклонено (похоже на маску, а не на ключ): ' + res.ignored.map((k) => KEY_TITLES[k] || k).join(', '));
      if (!parts.length) parts.push('ни одно поле не заполнено — сохранённые ключи не тронуты');
      return ((res.message ? res.message + ' ' : '') + '(' + parts.join('; ') + ')').trim();
    };

    $('#k-save').onclick = async () => {
      const res = await saveKeys();
      App.toast(saveReport(res), (res && res.saved && res.saved.length) ? 'ok' : 'warn', 8000);
      if (res && res.secretsError) App.toast(res.secretsError, 'err', 12000);
      this.draw();
    };

    // сохранить и сразу выгрузить всё из кабинета WB
    $('#k-save-refresh').onclick = async () => {
      const res = await saveKeys();
      App.toast(saveReport(res), (res && res.saved && res.saved.length) ? 'ok' : 'warn', 5000);
      if (res && res.demo && res.anyKeyAfterSave !== false) {
        App.toast('Демо-режим всё ещё включён — данные будут сгенерированными. Снимите галку «Демо-режим».', 'warn', 9000);
      }
      await App.refreshAllData({ facts: true, redraw: true });
      this.draw();
    };

    $('#k-check').onclick = async () => {
      const out = $('#k-result');
      out.innerHTML = UI.loading('Проверяем доступ к WB API…');
      try {
        const res = await API.invoke('keys:check');
        const rows = (res && res.results) || [];
        if (!rows.length) {
          out.innerHTML = '<div class="alert warn">Проверка не вернула ни одного раздела.</div>';
          return;
        }
        const body = rows.map((r) => {
          // ok === null / checked === false — проверка НЕ выполнялась (демо-режим).
          // Рисовать зелёное «доступ есть» в этом случае нельзя: пользователь
          // принимал это за настоящую проверку ключей.
          const badge = r.checked === false || r.ok === null
            ? UI.badge('не проверялось', 'warn')
            : (r.ok ? UI.badge('доступ есть', 'ok') : UI.badge('нет доступа', 'danger'));
          const what = r.error ? U.esc(r.error) : U.esc(r.detail || '');
          return `<tr>
            <td><b>${U.esc(r.title || r.category)}</b>
              ${r.keyUsed ? '<div class="tiny muted mono">ключ: ' + U.esc(r.keyUsed) + '</div>' : '<div class="tiny muted">ключ не задан</div>'}</td>
            <td>${badge}${r.status ? ' <span class="tiny muted">HTTP ' + U.num(r.status, 0) + '</span>' : ''}</td>
            <td class="tiny">${what}${r.hint ? '<div class="muted" style="margin-top:3px">→ ' + U.esc(r.hint) + '</div>' : ''}
              ${r.ms ? '<div class="muted" style="margin-top:2px">' + U.esc(r.host || '') + ' · ' + U.num(r.ms / 1000, 1) + ' с</div>' : ''}</td>
          </tr>`;
        }).join('');
        const banner = (res && res.checked === false)
          ? `<div class="alert warn" style="margin-bottom:10px"><b>Проверка не выполнялась — реальных запросов к WB не было.</b><br>${U.esc((res && res.message) || '')}</div>`
          : (res && res.secretsError ? `<div class="alert danger" style="margin-bottom:10px">${U.esc(res.secretsError)}</div>` : '');
        const okCount = rows.filter((r) => r.ok === true).length;
        const badCount = rows.filter((r) => r.ok === false).length;
        out.innerHTML = banner +
          `<table class="grid-table"><thead><tr><th>Раздел</th><th>Статус</th><th>Что ответил WB / что делать</th></tr></thead><tbody>${body}</tbody></table>
          <p class="hint" style="margin-top:8px">${res && res.demo
            ? 'Демо-режим: данные сгенерированы локально, в WB ничего не отправлялось.'
            : 'Отправлено по одному дешёвому запросу на раздел (limit=1 / окно в 1–2 дня). Работает: ' + okCount + ', не работает: ' + badCount + '.'}</p>`;
      } catch (e) {
        out.innerHTML = `<div class="alert danger">${U.esc(e.message)}</div>`;
      }
    };

    $('#k-clear').onclick = () => {
      UI.confirmDialog('Удалить API-ключи', '<div class="alert warn">Все сохранённые ключи будут удалены из хранилища приложения. Приложение вернётся в демо-режим.</div>', async () => {
        await API.invoke('keys:clear', {});
        await S.saveSettings({ demoMode: true });
        await S.loadAppState();
        App.setModeBadge();
        App.toast('Ключи удалены', 'ok');
        this.draw();
      }, 'Удалить');
    };

    // Удаление одного ключа. Пустое поле при сохранении ключ НЕ удаляет
    // (иначе повторное «Сохранить» стирало всё), поэтому удаление — явное.
    Array.from(container.querySelectorAll('.k-clear-one')).forEach((btn) => {
      btn.onclick = () => {
        const name = btn.getAttribute('data-key');
        const title = KEY_NAMES[name] || name;
        UI.confirmDialog('Удалить ключ «' + title + '»',
          '<div class="alert warn">Ключ будет удалён из хранилища. Раздел «' + U.esc(title) + '» перестанет работать, ' +
          'если не задан единый ключ на все разделы.</div>',
          async () => {
            const res = await API.invoke('keys:set', { clear: [name] });
            await S.loadAppState();
            App.setModeBadge();
            App.toast('Ключ «' + title + '» удалён' + (res && res.demo ? ' — приложение вернулось в демо-режим' : ''), 'ok', 6000);
            this.draw();
          }, 'Удалить');
      };
    });

    $('#cat-reset').onclick = async () => {
      const res = await API.invoke('settings:reset');
      S.state.settings = res;
      App.toast('Настройки сброшены', 'ok');
      this.draw();
    };

    $('#d-cache').onclick = async () => {
      await API.invoke('cache:clear', {});
      App.toast('Кэш сброшен, при следующем обновлении данные загрузятся заново', 'ok');
    };

    $('#d-tasks').onclick = async () => {
      const tasks = await API.invoke('tasks:history');
      UI.modal({
        title: 'История отправок цен',
        content: tasks.length ? `<table class="grid-table"><thead><tr><th>Когда</th><th class="num">Товаров</th><th class="num">Принято</th><th class="num">Ошибок</th><th>Источник</th></tr></thead>
          <tbody>${tasks.slice(0, 50).map((t) => `<tr><td>${U.date(t.createdAt, true)}</td><td class="num">${t.total}</td>
            <td class="num pos">${t.ok || 0}</td><td class="num ${t.failed ? 'neg' : ''}">${t.failed || 0}</td>
            <td>${t.source === 'demo' ? UI.badge('демо') : UI.badge('WB API', 'live')}</td></tr>`).join('')}</tbody></table>`
          : '<div class="muted">Отправок ещё не было.</div>',
        buttons: [{ label: 'Закрыть', class: 'btn-primary' }]
      });
    };

    $('#d-reset').onclick = () => {
      UI.confirmDialog('Сбросить всё', '<div class="alert danger">Будут удалены настройки, ключи и введённые себестоимости.</div>', async () => {
        await API.invoke('keys:clear', {});
        await API.invoke('costs:clear', {});
        const resetSettings = await API.invoke('settings:reset');
        if (API.isElectron) await API.invoke('ui:update-enable', resetSettings.autoUpdateEnabled !== false);
        await S.loadAppState();
        S.state.costs = {};
        App.toast('Приложение сброшено', 'ok');
        this.draw();
      }, 'Сбросить');
    };
  }
};
