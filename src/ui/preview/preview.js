// Общий компонент превью (FR-30, FR-31): таблица сущностей и вкладка «Текст».
// Используется панелью на сайте; рабочему пространству подойдёт тот же API.
import { h, clear } from '../components/dom.js';
import { createT } from '../i18n/index.js';
import { preview as dict } from '../i18n/preview.js';
import {
  toItems,
  filterItems,
  sortItems,
  setEnabled,
  isWeak,
  summary,
  categoryCounts,
  toDecisions,
  replacementText,
  setReplacement,
  plannedReplacements,
} from './model.js';

const ROW_H = 62;
const OVERSCAN = 6;
const TEXT_PAGE = 200;
const LEVEL_ICON = { validated: '✓', labeled: '●', kb: '◆', ner: '◈', weak: '○' };

/**
 * @param {{lang: 'ru'|'en', catalog: {list: any[], byId: Map<string, any>},
 *   api: {getText: (from: number, count: number) => Promise<any>, addEntity: (category: string, text: string) => Promise<any[]>, ignoreForever?: (item: any) => void},
 *   onChange?: () => void}} opts
 */
export function createPreview(opts) {
  const { lang, catalog, api } = opts;
  const t = createT(dict, lang);
  const catLabel = (id) => catalog.byId.get(id)?.label?.[lang] || id;
  const catColor = (id) => catalog.byId.get(id)?.color || '#7f8c8d';
  const catOrder = catalog.list.map((c) => c.id);

  /** @type {import('./model.js').Item[]} */
  let items = [];
  const filter = { categories: new Set(), query: '' };
  let sortBy = 'order';
  let view = [];
  let tab = 'entities';
  let textLoaded = false;
  let destroyed = false;

  const changed = () => {
    renderSummary();
    opts.onChange?.();
  };

  /* ---------- каркас ---------- */
  const summaryEl = h('div', { class: 'pv-summary', 'data-testid': 'pv-summary' });
  const searchInput = /** @type {HTMLInputElement} */ (
    h('input', {
      class: 'pv-search',
      type: 'search',
      placeholder: t('search'),
      'aria-label': t('search'),
      onInput: (e) => {
        filter.query = e.target.value;
        applyView(true);
      },
    })
  );
  const sortSelect = /** @type {HTMLSelectElement} */ (
    h(
      'select',
      {
        class: 'pv-select',
        'aria-label': t('sortBy'),
        onChange: (e) => {
          sortBy = e.target.value;
          applyView(true);
        },
      },
      h('option', { value: 'order', text: t('sortOrder') }),
      h('option', { value: 'category', text: t('sortCategory') }),
      h('option', { value: 'count', text: t('sortCount') }),
    )
  );
  const chipsEl = h('div', { class: 'pv-chips', role: 'group' });
  const bulkEl = h(
    'div',
    { class: 'pv-bulk' },
    h('button', { class: 'link', type: 'button', text: t('enableAll'), 'data-testid': 'pv-enable-all', onClick: () => bulk(true) }),
    h('button', { class: 'link', type: 'button', text: t('disableAll'), 'data-testid': 'pv-disable-all', onClick: () => bulk(false) }),
    h('button', { class: 'link', type: 'button', text: t('disableWeak'), 'data-testid': 'pv-disable-weak', onClick: () => bulk(false, isWeak) }),
  );
  const spacer = h('div', { class: 'pv-spacer' });
  const rowsEl = h('div', { class: 'pv-rows', 'data-testid': 'pv-rows', tabindex: '-1' }, spacer);
  rowsEl.addEventListener('scroll', () => requestAnimationFrame(renderRows), { passive: true });
  const emptyEl = h('div', { class: 'pv-empty', hidden: true });

  const entitiesPane = h(
    'div',
    { class: 'pv-pane' },
    h('div', { class: 'pv-toolbar' }, searchInput, sortSelect),
    chipsEl,
    h('div', { class: 'pv-bulkrow' }, summaryEl, bulkEl),
    h('div', { class: 'pv-table' }, rowsEl, emptyEl),
  );

  function ignoreItem(item) {
    opts.api.ignoreForever?.(item);
    item.enabled = false;
    renderRows();
    changed();
    showToast(t('ignored', { value: item.value }));
  }

  /* ---------- вкладка «Текст» ---------- */
  const textBody = h('div', { class: 'pv-text', 'data-testid': 'pv-text' });
  const selBar = h('div', { class: 'pv-selbar', hidden: true });
  const toast = h('div', { class: 'pv-toast', role: 'status', hidden: true });
  const menu = h('div', { class: 'pv-menu', hidden: true });
  const textPane = h('div', { class: 'pv-pane', hidden: true }, textBody, selBar, menu);
  let textFrom = 0;
  let textTotal = 0;
  let pendingSelection = '';

  const tabEntities = h('button', {
    class: 'pv-tab',
    type: 'button',
    role: 'tab',
    'aria-selected': 'true',
    text: t('tabEntities'),
    'data-testid': 'pv-tab-entities',
    onClick: () => setTab('entities'),
  });
  const tabText = h('button', {
    class: 'pv-tab',
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
    text: t('tabText'),
    'data-testid': 'pv-tab-text',
    onClick: () => setTab('text'),
  });
  const tabsEl = h('div', { class: 'pv-tabs', role: 'tablist' }, tabEntities, tabText);

  const el = h('div', { class: 'pv' }, tabsEl, entitiesPane, textPane, toast);

  function setTab(next) {
    tab = next;
    tabEntities.setAttribute('aria-selected', String(next === 'entities'));
    tabText.setAttribute('aria-selected', String(next === 'text'));
    entitiesPane.hidden = next !== 'entities';
    textPane.hidden = next !== 'text';
    if (next === 'text') {
      if (!textLoaded) loadText(true);
      else refreshMarks();
    } else renderRows();
  }

  /* ---------- сущности ---------- */
  function bulk(enabled, pred) {
    setEnabled(view, enabled, pred);
    renderRows();
    changed();
  }

  function renderChips() {
    clear(chipsEl);
    const counts = categoryCounts(items);
    if (counts.size < 2) return;
    chipsEl.append(
      h('button', {
        class: 'chip chip-all',
        type: 'button',
        'aria-pressed': String(filter.categories.size === 0),
        text: t('all'),
        onClick: () => {
          filter.categories.clear();
          renderChips();
          applyView(true);
        },
      }),
    );
    const ordered = [...counts.keys()].sort((a, b) => catOrder.indexOf(a) - catOrder.indexOf(b));
    for (const c of ordered) {
      chipsEl.append(
        h('button', {
          class: 'chip',
          type: 'button',
          style: { '--c': catColor(c) },
          'aria-pressed': String(filter.categories.has(c)),
          'data-cat': c,
          text: `${catLabel(c)} ${counts.get(c)}`,
          onClick: () => {
            if (filter.categories.has(c)) filter.categories.delete(c);
            else filter.categories.add(c);
            renderChips();
            applyView(true);
          },
        }),
      );
    }
  }

  function renderSummary() {
    const s = summary(items);
    summaryEl.textContent = t('found', { total: s.total, enabled: s.enabled });
  }

  function applyView(resetScroll) {
    view = sortItems(filterItems(items, filter), sortBy, catOrder);
    spacer.style.height = `${view.length * ROW_H}px`;
    emptyEl.hidden = view.length > 0;
    emptyEl.textContent = items.length ? t('emptyFilter') : '';
    if (resetScroll) rowsEl.scrollTop = 0;
    renderRows();
  }

  function renderRows() {
    if (destroyed) return;
    for (const r of rowsEl.querySelectorAll('.pv-row')) r.remove();
    if (!view.length) return;
    const viewportH = rowsEl.clientHeight || 360;
    const first = Math.max(0, Math.floor(rowsEl.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(view.length, Math.ceil((rowsEl.scrollTop + viewportH) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(renderRow(view[i], i));
    rowsEl.append(frag);
  }

  function renderRow(item, index) {
    const color = catColor(item.category);
    const n = item.occurrences.length;
    const active = n - item.excluded.size;
    const ctx = (item.occurrences[0]?.context || '').replace(/[⟦⟧]/g, '');
    const check = h('input', {
      type: 'checkbox',
      class: 'pv-check',
      checked: item.enabled,
      'aria-label': t('toggle', { value: item.value }),
      'data-testid': 'pv-check',
      onChange: (e) => {
        item.enabled = e.target.checked;
        row.classList.toggle('off', !item.enabled);
        changed();
      },
    });
    const input = /** @type {HTMLInputElement} */ (
      h('input', {
        class: 'pv-repl',
        type: 'text',
        value: replacementText(item),
        spellcheck: false,
        'aria-label': t('replacement'),
        'data-testid': 'pv-replacement',
        onInput: (e) => setReplacement(item, e.target.value),
        onBlur: (e) => {
          if (!e.target.value.trim()) e.target.value = replacementText(item);
        },
      })
    );
    const meta = h(
      'div',
      { class: 'pv-meta' },
      h('span', { class: `lvl lvl-${item.level}`, title: t(`level_${item.level}`), text: LEVEL_ICON[item.level] || '·' }),
      h('span', { text: n > 1 ? `${t('occurrences', { n: active })}` : t('occurrences', { n: 1 }) }),
      item.source === 'user' ? h('span', { class: 'pv-user', text: t('source_user') }) : null,
      ctx ? h('span', { class: 'pv-ctx', title: ctx, text: ctx }) : null,
    );
    const ignore = opts.api.ignoreForever
      ? h('button', {
          class: 'pv-ignore',
          type: 'button',
          title: t('ignoreForever', { value: item.value }),
          'aria-label': t('ignoreForever', { value: item.value }),
          text: '⊘',
          'data-testid': 'pv-ignore',
          onClick: () => ignoreItem(item),
        })
      : null;
    const row = h(
      'div',
      {
        class: `pv-row${item.enabled ? '' : ' off'}`,
        style: { transform: `translateY(${index * ROW_H}px)`, height: `${ROW_H}px`, '--c': color },
        'data-id': item.id,
      },
      check,
      h(
        'div',
        { class: 'pv-main' },
        h(
          'div',
          { class: 'pv-head' },
          h('span', { class: 'cat', text: catLabel(item.category) }),
          h('span', { class: 'val', title: item.value, text: item.value }),
        ),
        meta,
      ),
      input,
      ignore,
    );
    return row;
  }

  /* ---------- вкладка «Текст» ---------- */
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.hidden = true), 3500);
  }

  async function loadText(reset) {
    if (reset) {
      textFrom = 0;
      clear(textBody);
    }
    textBody.append(h('div', { class: 'pv-loading', text: t('textLoading') }));
    try {
      const r = await api.getText(textFrom, TEXT_PAGE);
      textBody.querySelector('.pv-loading')?.remove();
      textTotal = r.total;
      textLoaded = true;
      textBody.querySelector('.pv-more')?.remove();
      if (!r.paragraphs.length && textFrom === 0) textBody.append(h('div', { class: 'pv-empty', text: t('textEmpty') }));
      for (const p of r.paragraphs) textBody.append(renderParagraph(p));
      textFrom += r.paragraphs.length;
      if (textFrom < textTotal) textBody.append(h('button', { class: 'link pv-more', type: 'button', text: t('textMore'), onClick: () => loadText(false) }));
    } catch (err) {
      textBody.querySelector('.pv-loading')?.remove();
      textBody.append(h('div', { class: 'pv-empty', text: String(err.message || err) }));
    }
  }

  function renderParagraph(p) {
    const para = h('p', { class: 'pv-p' });
    let pos = 0;
    for (const s of p.spans) {
      if (s.start < pos) continue;
      if (s.start > pos) para.append(p.text.slice(pos, s.start));
      const item = items.find((i) => i.id === s.entityId);
      const mark = h('mark', {
        class: `pv-mark${item && (!item.enabled || item.excluded.has(s.occurrenceId)) ? ' off' : ''}`,
        style: { '--c': catColor(s.category) },
        'data-eid': s.entityId,
        'data-oid': s.occurrenceId,
        title: `${catLabel(s.category)}`,
        text: p.text.slice(s.start, s.end),
      });
      mark.addEventListener('click', (e) => openMenu(e, mark));
      para.append(mark);
      pos = s.end;
    }
    if (pos < p.text.length) para.append(p.text.slice(pos));
    if (!p.text) para.append(h('br'));
    return para;
  }

  function refreshMarks() {
    for (const m of textBody.querySelectorAll('.pv-mark')) {
      const item = items.find((i) => i.id === m.getAttribute('data-eid'));
      m.classList.toggle('off', !!item && (!item.enabled || item.excluded.has(m.getAttribute('data-oid'))));
    }
  }

  function openMenu(ev, mark) {
    ev.stopPropagation();
    const item = items.find((i) => i.id === mark.getAttribute('data-eid'));
    if (!item) return;
    const oid = mark.getAttribute('data-oid');
    const occOff = item.excluded.has(oid);
    clear(menu);
    menu.append(
      h('button', {
        type: 'button',
        text: occOff ? t('includeOcc') : t('excludeOcc'),
        onClick: () => {
          if (occOff) item.excluded.delete(oid);
          else item.excluded.add(oid);
          closeMenu();
          refreshMarks();
          changed();
        },
      }),
      h('button', {
        type: 'button',
        text: item.enabled ? t('excludeEntity') : t('includeEntity'),
        onClick: () => {
          item.enabled = !item.enabled;
          closeMenu();
          refreshMarks();
          renderRows();
          changed();
        },
      }),
    );
    const box = textPane.getBoundingClientRect();
    const r = mark.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = `${Math.max(4, Math.min(r.left - box.left, box.width - 230))}px`;
    menu.style.top = `${Math.max(4, r.bottom - box.top + 4)}px`;
  }
  const closeMenu = () => (menu.hidden = true);
  textPane.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target))) closeMenu();
  });

  function showSelectionHint() {
    pendingSelection = '';
    selBar.hidden = true;
  }

  textBody.addEventListener('mouseup', () => {
    const raw = (window.getSelection?.()?.toString() || '').replace(/\u00a0/g, ' ').trim();
    if (!raw) return showSelectionHint();
    if (raw.length > 200 || /[\n\r]/.test(raw)) {
      pendingSelection = '';
      clear(selBar);
      selBar.append(h('span', { class: 'bad', text: t('selectionBad') }));
      selBar.hidden = false;
      return;
    }
    pendingSelection = raw;
    clear(selBar);
    const select = /** @type {HTMLSelectElement} */ (
      h(
        'select',
        { class: 'pv-select', 'aria-label': t('asCategory'), 'data-testid': 'pv-sel-category' },
        catalog.list.map((c) => h('option', { value: c.id, text: c.label?.[lang] || c.id })),
      )
    );
    selBar.append(
      h('span', { class: 'sel-text', title: raw, text: `«${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}»` }),
      h('span', { class: 'sel-lab', text: t('asCategory') }),
      select,
      h('button', {
        class: 'btn btn-primary btn-sm',
        type: 'button',
        text: t('apply'),
        'data-testid': 'pv-sel-apply',
        onClick: () => addSelection(select.value),
      }),
    );
    selBar.hidden = false;
  });

  async function addSelection(category) {
    const text = pendingSelection;
    if (!text) return;
    showSelectionHint();
    try {
      const before = items.reduce((n, i) => n + i.occurrences.length, 0);
      const entities = await api.addEntity(category, text);
      setEntities(entities, true);
      const after = items.reduce((n, i) => n + i.occurrences.length, 0);
      showToast(t('added', { n: Math.max(1, after - before) }));
      textLoaded = false;
      if (tab === 'text') loadText(true);
      window.getSelection?.()?.removeAllRanges();
    } catch (err) {
      showToast(t('addFailed', { msg: err.message || err }));
    }
  }

  /* ---------- API ---------- */
  function setEntities(entities, keepLocal = false) {
    items = toItems(entities, keepLocal ? items : []);
    renderChips();
    renderSummary();
    applyView(!keepLocal);
    opts.onChange?.();
  }

  return {
    el,
    setEntities,
    getDecisions: () => toDecisions(items),
    getItems: () => items,
    summary: () => summary(items),
    plannedReplacements: () => plannedReplacements(items),
    removeItem(id) {
      items = items.filter((i) => i.id !== id);
      renderChips();
      applyView(false);
      opts.onChange?.();
    },
    showToast,
    relayout: renderRows,
    destroy() {
      destroyed = true;
      el.remove();
    },
  };
}
