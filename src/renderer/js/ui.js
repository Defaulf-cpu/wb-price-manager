'use strict';

/** Компоненты интерфейса: тосты, модалки, таблица, инпуты. */
window.UI = (function () {
  const esc = U.esc;

  // ─────────── Тосты ───────────
  /**
   * одинаковые сообщения не повторяем чаще раза в `DEDUPE_MS`.
   *
   * Без этого одна и та же ошибка WB (например, 422 на состав автоакции по каждой
   * акции календаря) вываливала в интерфейс десятки одинаковых тостов подряд,
   * и было непонятно, что реально произошло.
   */
  const DEDUPE_MS = 8000;
  const lastToastAt = new Map();

  function toast(message, kind, ms) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const key = (kind || '') + '|' + String(message || '');
    const now = Date.now();
    const prev = lastToastAt.get(key) || 0;
    if (now - prev < DEDUPE_MS) return;
    lastToastAt.set(key, now);
    // не даём таблице последних сообщений расти бесконечно
    if (lastToastAt.size > 200) {
      for (const [k, t] of lastToastAt.entries()) if (now - t > DEDUPE_MS * 6) lastToastAt.delete(k);
    }

    const t = U.el(`<div class="toast ${kind || ''}">${esc(message)}</div>`);
    root.appendChild(t);
    // больше трёх одинаковых по смыслу тостов подряд не держим
    const all = root.querySelectorAll('.toast');
    if (all.length > 6) all[0].remove();
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity .25s';
      setTimeout(() => t.remove(), 260);
    }, ms || 3600);
  }

  // ─────────── Модальные окна ───────────
  function modal(opts) {
    const o = opts || {};
    const root = document.getElementById('modal-root');
    const back = U.el('<div class="modal-backdrop"></div>');
    const box = U.el(`<div class="modal ${o.size || ''}"></div>`);
    box.innerHTML =
      `<div class="modal-head">
         <h2>${esc(o.title || '')}</h2>
         <button class="modal-close" title="Закрыть">×</button>
       </div>
       <div class="modal-body"></div>
       ${o.buttons ? '<div class="modal-foot"></div>' : ''}`;
    const body = box.querySelector('.modal-body');
    if (typeof o.content === 'string') body.innerHTML = o.content;
    else if (o.content) body.appendChild(o.content);

    const foot = box.querySelector('.modal-foot');
    const api = { close, root: box, body, foot };

    if (foot) {
      (o.buttons || []).forEach((b) => {
        const btn = U.el(`<button class="btn ${b.class || ''}">${esc(b.label)}</button>`);
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const r = b.onClick ? await b.onClick(api) : true;
            if (r !== false && !b.keepOpen) await close(b.closeIntent);
          } catch (error) { toast(error.message || String(error), 'err', 8000); }
          finally { if (btn.isConnected) btn.disabled = false; }
        };
        if (b.id) btn.dataset.id = b.id;
        foot.appendChild(btn);
      });
    }

    let closed = false, closingPromise = null;
    function closeNow() {
      if (closed) return true; closed = true;
      document.removeEventListener('keydown', onKey); back.remove();
      if (o.onClose) o.onClose();
      return true;
    }
    function close(intent) {
      if (closed) return true;
      if (closingPromise) return closingPromise;
      api.closeIntent = intent || api.closeIntent || 'commit';
      let result;
      try { result = o.beforeClose ? o.beforeClose(api, api.closeIntent) : window.LocalDrafts && LocalDrafts.hasScope(box) ? LocalDrafts.captureScope(box, true) : true; }
      catch (error) { toast(error.message || String(error), 'err', 8000); return false; }
      if (result && typeof result.then === 'function') {
        closingPromise = result.then((ok) => ok === false ? false : closeNow()).catch((error) => { toast(error.message || String(error), 'err', 8000); return false; }).finally(() => { closingPromise = null; });
        return closingPromise;
      }
      return result === false ? false : closeNow();
    }

    box.querySelector('.modal-close').onclick = close;
    back.onclick = (e) => { if (e.target === back && o.dismissable !== false) close(); };
    back.appendChild(box);
    root.appendChild(back);

    const onKey = (e) => { if (e.key === 'Escape' && o.dismissable !== false && root.lastElementChild === back) { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    if (o.onMount) o.onMount(api);
    return api;
  }

  function confirmDialog(title, html, onOk, okLabel) {
    return modal({
      title, size: 'sm', content: html,
      buttons: [
        { label: 'Отмена', class: 'btn-ghost' },
        { label: okLabel || 'Подтвердить', class: 'btn-primary', onClick: () => onOk() }
      ]
    });
  }

  function loading(text) {
    return `<div class="loader"><div class="spinner"></div><span>${esc(text || 'Загрузка данных из Wildberries…')}</span></div>`;
  }

  /**
   * Вкладки внутри блока или модального окна.
   *
   * @param {object} o { tabs: [{id, label, badge}], active, onChange(id) }
   * @returns {{el: HTMLElement, setActive: function(string), refresh: function()}}
   */
  function tabs(o) {
    const list = (o && o.tabs) || [];
    let active = (o && o.active) || (list[0] && list[0].id) || '';
    const el = U.el('<div class="tabs"></div>');

    function paint() {
      el.innerHTML = '';
      list.forEach((t) => {
        const b = U.el(`<div class="tab ${t.id === active ? 'active' : ''}">${esc(t.label || t.id)}` +
          (t.badge ? ` <span class="tiny muted">${esc(String(t.badge))}</span>` : '') + `</div>`);
        b.onclick = async () => {
          if (active === t.id || el.inert) return;
          el.inert = true;
          try {
            const allowed = o && o.beforeChange ? await o.beforeChange(t.id) : true;
            if (allowed === false || !el.isConnected) return;
            active = t.id; paint();
            if (o && typeof o.onChange === 'function') await o.onChange(t.id);
          } catch (error) { toast(error.message || String(error), 'err', 8000); }
          finally { el.inert = false; }
        };
        el.appendChild(b);
      });
    }
    paint();
    return {
      el,
      setActive(id) { active = id; paint(); },
      get active() { return active; },
      refresh() { paint(); }
    };
  }

  // ─────────── Таблица ───────────
  /**
   * opts: { columns, rows, select:{get,set,toggleAll}, sort:{key,dir,onSort},
   *         maxHeight, empty, footer, onRowClick, rowClass }
   */
  function table(opts) {
    const o = opts || {};
    const cols = o.columns || [];
    const wrap = U.el(`<div class="tablewrap ${o.tall ? 'tall' : ''}"></div>`);
    const tbl = U.el('<table class="grid-table"></table>');
    wrap.appendChild(tbl);

    /**
     * Шапка таблицы. Если хотя бы у одной колонки задан `group`, над рядом
     * заголовков колонок рисуется ряд блоков — как в таблице цен INDEEPA
     * («Артикул», «Инфо о товаре», «Текущая цена», «Новая цена»,
     * «Мин цена (в акции)», «Цена (вне акции)», «Себестоимость»…).
     * Блок занимает colspan по числу своих ВИДИМЫХ колонок, колонки без блока
     * получают пустую ячейку такой же ширины — поэтому ряды всегда совпадают,
     * а `thead tr:last-child th` по-прежнему даёт точный список колонок.
     * Названия блоков передаются в `o.groupTitles` ({ id: 'Название' }).
     * Таблицам без групп поведение не меняется: ряд блоков не создаётся.
     */
    function renderHead() {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      const hasGroups = cols.some((c) => c && c.group);
      const trTop = hasGroups ? document.createElement('tr') : null;
      if (trTop) {
        trTop.className = 'rp-head-groups';
        thead.appendChild(trTop);
      }
      thead.appendChild(tr);
      if (o.select) {
        const th = document.createElement('th');
        th.style.width = '34px';
        th.className = 'rp-check';
        // чекбокс «выбрать все» занимает оба ряда шапки
        if (trTop) th.rowSpan = 2;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const all = o.rows.length > 0 && o.rows.every((r) => o.select.get(r));
        cb.checked = all;
        cb.onchange = () => {
          if (o.select.toggleAll) o.select.toggleAll(o.rows, cb.checked);
          else o.rows.forEach((r) => o.select.set(r, cb.checked));
          if (o.onSelect) o.onSelect();
          // Не пересоздаём tbody: это теряло обработчики полей и маркеры размеров.
          tbl.querySelectorAll('tbody tr').forEach((row, i) => {
            const item = o.rows[i]; if (!item) return;
            const selected = o.select.get(item); row.classList.toggle('selected', selected);
            const checkbox = row.querySelector('td:first-child input[type="checkbox"]');
            if (checkbox) checkbox.checked = selected;
          });
        };
        th.appendChild(cb);
        (trTop || tr).appendChild(th);
      }
      if (trTop) {
        let i = 0;
        while (i < cols.length) {
          const g = cols[i] && cols[i].group;
          let j = i;
          while (j < cols.length && ((cols[j] && cols[j].group) || null) === (g || null)) j++;
          const th = document.createElement('th');
          th.colSpan = j - i;
          if (g) {
            th.className = 'rp-group';
            th.setAttribute('data-group', String(g));
            th.textContent = (o.groupTitles && o.groupTitles[String(g)]) || String(g);
          } else {
            th.className = 'rp-group rp-group-empty';
          }
          trTop.appendChild(th);
          i = j;
        }
      }
      cols.forEach((c) => {
        const th = document.createElement('th');
        th.textContent = c.title || '';
        if (c.num) th.className = 'num';
        if (c.width) th.style.width = c.width;
        if (o.sort && c.key) {
          th.classList.add('sortable');
          if (o.sort.key === c.key) {
            const a = document.createElement('span');
            a.className = 'arrow';
            a.textContent = o.sort.dir === 'desc' ? '▲' : '▼';
            th.appendChild(a);
          }
          th.onclick = () => o.sort.onSort(c.key);
        }
        if (c.group) th.setAttribute('data-group', String(c.group));
        if (c.colId) th.dataset.colId = c.colId;
        tr.appendChild(th);
      });
      return thead;
    }

    function renderBody() {
      const old = tbl.querySelector('tbody');
      if (old) old.remove();
      const tbody = document.createElement('tbody');
      if (!o.rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = cols.length + (o.select ? 1 : 0);
        td.innerHTML = `<div class="muted center" style="padding:26px">${o.empty || 'Нет данных'}</div>`;
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        o.rows.forEach((r) => {
          const tr = document.createElement('tr');
          const sel = o.select ? o.select.get(r) : false;
          if (sel) tr.classList.add('selected');
          if (o.rowClass) {
            const extra = o.rowClass(r);
            if (extra) tr.className += ' ' + extra;
          }
          if (o.select) {
            const td = document.createElement('td');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = sel;
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = () => {
              o.select.set(r, cb.checked);
              tr.classList.toggle('selected', cb.checked);
              if (o.onSelect) o.onSelect();
            };
            td.appendChild(cb);
            tr.appendChild(td);
          }
          cols.forEach((c) => {
            const td = document.createElement('td');
            if (c.num) td.className = 'num';
            if (c.colId) td.dataset.colId = c.colId;
            if (c.cls) td.className += ' ' + c.cls;
            if (c.render) {
              const out = c.render(r);
              if (out instanceof Node) td.appendChild(out);
              else td.innerHTML = out === undefined || out === null ? '' : out;
            } else {
              td.textContent = c.value ? c.value(r) : (r[c.key] !== undefined ? r[c.key] : '');
            }
            if (c.onCellClick) td.onclick = (e) => { e.stopPropagation(); c.onCellClick(r, e); };
            tr.appendChild(td);
          });
          if (o.onRowClick) {
            tr.style.cursor = 'pointer';
            tr.onclick = () => o.onRowClick(r);
          }
          // двойной клик открывает карточку товара: одинарный остаётся на выделение строки
          if (o.onRowDblClick) {
            tr.style.cursor = 'pointer';
            tr.ondblclick = () => o.onRowDblClick(r);
          }
          tbody.appendChild(tr);
        });
      }
      tbl.appendChild(tbody);
      renderFoot();
    }

    function renderFoot() {
      const old = tbl.querySelector('tfoot');
      if (old) old.remove();
      if (!o.footer) return;
      const tfoot = document.createElement('tfoot');
      const tr = document.createElement('tr');
      if (o.select) tr.appendChild(document.createElement('td'));
      cols.forEach((c) => {
        const td = document.createElement('td');
        if (c.num) td.className = 'num';
        const v = o.footer(c, o.rows);
        td.innerHTML = v === undefined || v === null ? '' : v;
        tr.appendChild(td);
      });
      tfoot.appendChild(tr);
      tbl.appendChild(tfoot);
    }

    const head = tbl.querySelector('thead');
    if (head) head.remove();
    tbl.insertBefore(renderHead(), tbl.firstChild);
    renderBody();

    return { el: wrap, renderBody, rerender: () => { const h = tbl.querySelector('thead'); if (h) h.remove(); tbl.insertBefore(renderHead(), tbl.firstChild); renderBody(); } };
  }

  // ─────────── Мелкие хелперы ───────────
  function badge(text, kind) {
    return `<span class="badge ${kind ? 'badge-' + kind : ''}">${esc(text)}</span>`;
  }

  function flagBadges(flags) {
    const map = {
      'loss': ['убыток', 'danger'],
      'low-margin': ['низкая маржа', 'warn'],
      'no-cogs': ['нет себестоимости', 'info'],
      'quarantine': ['карантин цены', 'danger'],
      'target-loss': ['цель → убыток', 'danger'],
      'target-low-margin': ['цель: низкая маржа', 'warn'],
      'below-target': ['ниже цели', 'warn']
    };
    return (flags || []).map((f) => map[f] ? badge(map[f][0], map[f][1]) : '').join(' ');
  }

  function kv(pairs) {
    return `<div class="kv">${pairs.map((p) => `<div>${esc(p[0])}</div><div>${p[1]}</div>`).join('')}</div>`;
  }

  function bar(label, value, max, text, neg) {
    const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="bar">
      <div class="muted trunc" title="${esc(label)}">${esc(label)}</div>
      <div class="track"><div class="fill ${neg ? 'neg' : ''}" style="width:${w.toFixed(1)}%"></div></div>
      <div class="val">${text}</div>
    </div>`;
  }

  function moneyInput(value, attrs) {
    return `<input type="number" class="num" value="${value === undefined || value === null || value === '' ? '' : value}" step="any" ${attrs || ''} />`;
  }

  return { toast, modal, confirmDialog, loading, table, badge, flagBadges, kv, bar, moneyInput, tabs };
})();
