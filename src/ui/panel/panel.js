// Панель перехвата (FR-08, FR-33): элемент <docx-anonymizer-root> с закрытым Shadow DOM.
// Это только представление: логика обмена с ядром — в src/content/flow.js.
//
// Заметка: имя тега валидно для custom element, но регистрируем его не через customElements.define —
// в изолированном мире content script реестр может быть недоступен. Для панели регистрация не нужна.
import { h, clear } from '../components/dom.js';
import { createT } from '../i18n/index.js';
import { common } from '../i18n/common.js';
import { panel as dict } from '../i18n/panel.js';
import { createPreview } from '../preview/preview.js';
import { PANEL_CSS } from './styles.js';
import { formatSize } from '../../content/files.js';

export const PANEL_TAG = 'docx-anonymizer-root';
const SVG_NS = 'http://www.w3.org/2000/svg';

function logo() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z', 'M9 9.5h6M9 12.5h6M9 15.5h3.5']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/**
 * @typedef {object} PanelHandlers
 * @property {() => void} onAnonymize
 * @property {() => void} onOriginal     вызывается уже после подтверждения
 * @property {() => void} onCancel
 * @property {(i: number, asIs: boolean) => void} onAsIs
 * @property {(i: number) => void} onRetry
 * @property {() => void} onDisableSite
 * @property {(pos: {x: number, y: number}) => void} onPosition
 */

export class Panel {
  /**
   * @param {{lang: 'ru'|'en', catalog: any, origin: string, position?: {x: number, y: number}, openShadow?: boolean, handlers: PanelHandlers}} o
   */
  constructor(o) {
    this.o = o;
    this.lang = o.lang;
    this.t = createT({ ru: { ...common.ru, ...dict.ru }, en: { ...common.en, ...dict.en } }, o.lang);
    /** @type {any[]} */
    this.files = [];
    this.active = 0;
    this.phase = 'review';
    this.destroyed = false;
    this.build(o.openShadow ? 'open' : 'closed');
    this.onKey = this.onKey.bind(this);
    window.addEventListener('keydown', this.onKey, true);
    this.onResize = () => this.clamp();
    window.addEventListener('resize', this.onResize);
  }

  build(mode) {
    const t = this.t;
    this.host = document.createElement(PANEL_TAG);
    this.shadow = this.host.attachShadow({ mode: /** @type {'open'|'closed'} */ (mode) });
    this.titleSub = h('span', { 'data-testid': 'panel-subtitle' });
    this.hdr = h(
      'div',
      { class: 'hdr' },
      h('div', { class: 'logo' }, logo()),
      h('div', { class: 'ttl' }, h('b', { text: t('title') }), this.titleSub),
      (this.siteBtn = h('button', {
        class: 'link site-off',
        type: 'button',
        text: t('disableSite'),
        'data-testid': 'btn-disable-site',
        onClick: () => this.o.handlers.onDisableSite(),
      })),
      h('button', {
        class: 'x',
        type: 'button',
        'aria-label': t('close'),
        title: t('close'),
        text: '×',
        'data-testid': 'panel-close',
        onClick: () => this.requestClose(),
      }),
    );
    this.filesBar = h('div', { class: 'files', role: 'tablist', hidden: true });
    this.body = h('div', { class: 'body' });
    this.footer = h('div', { class: 'ftr' });
    this.root = h(
      'div',
      { class: 'root', role: 'dialog', 'aria-label': t('title'), 'aria-modal': 'false', 'data-testid': 'panel' },
      this.hdr,
      this.filesBar,
      this.body,
      this.footer,
    );
    this.shadow.append(h('style', { text: PANEL_CSS }), this.root);
    this.place(this.o.position);
    this.enableDrag();
    this.updateChrome();
  }

  mount() {
    (document.documentElement || document).append(this.host);
    this.clamp();
  }

  /* ---------- положение и перетаскивание (FR-08) ---------- */
  place(pos) {
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      this.root.style.left = `${pos.x}px`;
      this.root.style.top = `${pos.y}px`;
    } else {
      this.root.style.right = '20px';
      this.root.style.bottom = '20px';
    }
  }

  clamp() {
    if (this.destroyed || !this.root.style.left) return;
    const r = this.root.getBoundingClientRect();
    const x = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
    const y = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - 48));
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
  }

  enableDrag() {
    let start = null;
    this.hdr.addEventListener('pointerdown', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      this.root.style.left = `${r.left}px`;
      this.root.style.top = `${r.top}px`;
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
      this.hdr.classList.add('dragging');
      this.hdr.setPointerCapture(e.pointerId);
    });
    this.hdr.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = this.root.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - start.dx), Math.max(0, window.innerWidth - r.width));
      const y = Math.min(Math.max(0, e.clientY - start.dy), Math.max(0, window.innerHeight - 48));
      this.root.style.left = `${x}px`;
      this.root.style.top = `${y}px`;
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.hdr.classList.remove('dragging');
      const r = this.root.getBoundingClientRect();
      this.o.handlers.onPosition({ x: Math.round(r.left), y: Math.round(r.top) });
    };
    this.hdr.addEventListener('pointerup', end);
    this.hdr.addEventListener('pointercancel', end);
  }

  /* ---------- клавиатура ---------- */
  onKey(e) {
    if (e.key !== 'Escape' || this.destroyed) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.phase === 'applying') return;
    if (this.phase === 'confirm-original' || this.phase === 'confirm-close') return this.backFromConfirm();
    this.requestClose();
  }

  requestClose() {
    if (this.phase === 'done') return this.o.handlers.onCancel();
    if (this.phase === 'applying') return;
    if (this.phase === 'notice') return this.o.handlers.onCancel();
    this.showConfirm('close');
  }

  /* ---------- файлы ---------- */
  addFile(name, size) {
    const t = this.t;
    const view = h('div', { class: 'fview' });
    const f = { name, size, state: 'queued', view, asIs: false, preview: null, progress: null, stage: null, bar: null };
    this.setCenter(f, h('h3', { text: t('queued') }), h('div', { class: 'bar' }, h('i')));
    this.body.append(view);
    this.files.push(f);
    this.renderFilesBar();
    if (this.files.length === 1) this.setActive(0);
    this.updateChrome();
    return this.files.length - 1;
  }

  setCenter(f, ...children) {
    clear(f.view);
    f.view.append(h('div', { class: 'center' }, ...children));
  }

  setProgress(i, stage, percent) {
    const f = this.files[i];
    if (!f) return;
    f.state = 'analyzing';
    if (!f.bar) {
      f.stage = h('p', { 'data-testid': 'stage' });
      f.bar = h('i');
      this.setCenter(f, h('h3', { text: this.t('analyzing') }), f.stage, h('div', { class: 'bar', role: 'progressbar' }, f.bar));
    }
    f.stage.textContent = this.t(`stage.${stage}`);
    f.bar.style.width = `${Math.max(3, Math.min(100, percent || 0))}%`;
    this.renderFilesBar();
    this.updateChrome();
  }

  /** @param {number} i @param {{entities: any[], warnings?: any[], restored?: boolean, api: any}} d */
  setReady(i, d) {
    const f = this.files[i];
    if (!f) return;
    f.state = 'ready';
    f.bar = null;
    f.preview = createPreview({ lang: this.lang, catalog: this.o.catalog, api: d.api, onChange: () => this.updateChrome() });
    clear(f.view);
    const warns = [];
    if (d.restored) warns.push(h('div', { class: 'note', text: this.t('restored'), 'data-testid': 'restored-note' }));
    for (const w of d.warnings || []) {
      const reason = w.details?.reason === 'MODEL_LOAD_FAILED' ? 'MODEL_LOAD_FAILED' : 'INFERENCE_FAILED';
      const text =
        w.code === 'EMBEDDED_NOT_PROCESSED'
          ? this.t('warnEmbedded', { n: w.count ?? 0 })
          : w.code === 'NER_FAILED' // WP8: сбой модели NER не мешает результату правил (NFR-13)
            ? this.t('warnNer', { reason: this.t(`nerReason_${reason}`) })
            : this.t('warnGeneric', { code: w.code });
      warns.push(h('div', { class: 'warn', text }));
    }
    if (warns.length) f.view.append(h('div', { class: 'warns' }, ...warns));
    if (!d.entities.length) {
      f.view.append(
        h(
          'div',
          { class: 'center' },
          h('div', { class: 'ok-ic', text: '✓' }),
          h('p', { class: 'empty-found', text: this.t('noEntities'), 'data-testid': 'no-entities' }),
        ),
      );
    } else {
      f.view.append(f.preview.el);
      f.preview.setEntities(d.entities);
    }
    this.renderFilesBar();
    this.updateChrome();
    requestAnimationFrame(() => f.preview.relayout());
  }

  setError(i, err) {
    const f = this.files[i];
    if (!f) return;
    f.state = 'error';
    f.bar = null;
    f.error = err;
    f.preview?.destroy();
    f.preview = null;
    this.renderError(f, i);
    this.renderFilesBar();
    this.updateChrome();
  }

  renderError(f, i) {
    const t = this.t;
    const asIs = h('button', {
      class: `btn btn-sm${f.asIs ? ' btn-primary' : ''}`,
      type: 'button',
      'data-testid': 'btn-asis',
      text: f.asIs ? t('btnAsIsDone') : t('btnAsIs'),
      onClick: () => {
        f.asIs = !f.asIs;
        this.renderError(f, i);
        this.updateChrome();
        this.o.handlers.onAsIs(i, f.asIs);
      },
    });
    const retry = f.error.retry
      ? h('button', { class: 'btn btn-sm', type: 'button', text: t('btnRetry'), 'data-testid': 'btn-retry', onClick: () => this.o.handlers.onRetry(i) })
      : null;
    this.setCenter(
      f,
      h('div', { class: 'err-ic', text: '!' }),
      h('h3', { text: f.error.message, 'data-testid': 'error-message' }),
      h('p', { text: f.asIs ? t('asIsNote') : t('errNeedDecision') }),
      h('div', { class: 'actions-inline' }, asIs, retry),
    );
  }

  getPreview(i) {
    return this.files[i]?.preview || null;
  }

  setActive(i) {
    this.active = i;
    this.files.forEach((f, k) => f.view.classList.toggle('active', k === i));
    this.renderFilesBar();
    this.updateChrome();
    this.files[i]?.preview?.relayout();
  }

  renderFilesBar() {
    clear(this.filesBar);
    this.filesBar.hidden = this.files.length < 2 || this.phase === 'done' || this.phase === 'notice';
    this.files.forEach((f, i) => {
      this.filesBar.append(
        h(
          'button',
          {
            class: 'ftab',
            type: 'button',
            role: 'tab',
            'aria-selected': String(i === this.active),
            title: f.name,
            'data-testid': 'file-tab',
            onClick: () => this.setActive(i),
          },
          h('i', { class: `dot ${f.state}` }),
          h('span', { class: 'n', text: f.name }),
        ),
      );
    });
  }

  /* ---------- состояние ---------- */
  get readyCount() {
    return this.files.filter((f) => f.state === 'ready').length;
  }
  get canAnonymize() {
    if (this.phase !== 'review') return false;
    if (this.files.some((f) => f.state === 'queued' || f.state === 'analyzing')) return false;
    if (this.files.some((f) => f.state === 'error' && !f.asIs)) return false;
    return this.readyCount > 0;
  }
  isAsIs(i) {
    return !!this.files[i]?.asIs;
  }

  updateChrome() {
    if (this.destroyed) return;
    const t = this.t;
    const f = this.files[this.active];
    if (this.phase === 'done') this.titleSub.textContent = '';
    else if (this.files.length > 1) this.titleSub.textContent = t('filesCount', { n: this.files.length });
    else if (f) this.titleSub.textContent = `${f.name} · ${formatSize(f.size, this.lang)}`;
    else this.titleSub.textContent = '';
    this.siteBtn.hidden = this.phase !== 'review';
    this.root.classList.toggle('compact', this.phase === 'done' || this.phase === 'notice');
    if (this.phase === 'review') this.renderFooter();
  }

  renderFooter() {
    const t = this.t;
    clear(this.footer);
    const total = this.files.reduce((n, f) => n + (f.preview ? f.preview.plannedReplacements() : 0), 0);
    this.footer.append(
      h('button', { class: 'btn', type: 'button', text: t('btnCancel'), 'data-testid': 'btn-cancel', onClick: () => this.o.handlers.onCancel() }),
      h('button', { class: 'btn', type: 'button', text: t('btnOriginal'), 'data-testid': 'btn-original', onClick: () => this.showConfirm('original') }),
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: t('btnAnonymize'),
        title: total ? `${total}` : '',
        disabled: !this.canAnonymize,
        'data-testid': 'btn-anonymize',
        onClick: () => this.o.handlers.onAnonymize(),
      }),
    );
  }

  /* ---------- подтверждения (FR-38) ---------- */
  showConfirm(kind) {
    const t = this.t;
    this.removeOverlay();
    this.prevPhase = this.phase;
    this.phase = kind === 'original' ? 'confirm-original' : 'confirm-close';
    const yes = h('button', {
      class: 'btn btn-danger',
      type: 'button',
      text: t('confirmOriginalYes'),
      'data-testid': 'btn-original-confirm',
      onClick: () => this.o.handlers.onOriginal(),
    });
    const back = h('button', {
      class: 'btn',
      type: 'button',
      text: kind === 'original' ? t('btnBack') : t('confirmCloseNo'),
      'data-testid': 'btn-confirm-back',
      onClick: () => this.backFromConfirm(),
    });
    const buttons =
      kind === 'original'
        ? [back, yes]
        : [
            back,
            h('button', {
              class: 'btn',
              type: 'button',
              text: t('confirmCloseCancel'),
              'data-testid': 'btn-confirm-cancel',
              onClick: () => this.o.handlers.onCancel(),
            }),
            yes,
          ];
    this.overlay = h(
      'div',
      { class: 'overlay', 'data-testid': 'confirm' },
      h(
        'div',
        { class: 'dialog', role: 'alertdialog' },
        h('h3', { text: kind === 'original' ? t('confirmOriginalTitle') : t('confirmCloseTitle') }),
        h('p', { text: kind === 'original' ? t('confirmOriginalText') : t('confirmCloseText') }),
        h('div', { class: 'row' }, ...buttons),
      ),
    );
    this.body.append(this.overlay);
    back.focus();
  }

  removeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  backFromConfirm() {
    this.removeOverlay();
    this.phase = this.prevPhase || 'review';
    this.updateChrome();
  }

  /* ---------- применение / готово / уведомление ---------- */
  showApplying() {
    this.removeOverlay();
    this.phase = 'applying';
    this.applyBar = h('i');
    this.applyStage = h('p', { 'data-testid': 'stage', text: this.t('applying') });
    for (const f of this.files) f.view.classList.remove('active');
    this.applyView = h(
      'div',
      { class: 'fview active' },
      h('div', { class: 'center' }, h('h3', { text: this.t('applying') }), this.applyStage, h('div', { class: 'bar' }, this.applyBar)),
    );
    this.body.append(this.applyView);
    clear(this.footer);
    this.updateChrome();
  }

  setApplyProgress(stage, percent) {
    if (this.applyStage) this.applyStage.textContent = this.t(`stage.${stage}`);
    if (this.applyBar) this.applyBar.style.width = `${Math.max(3, percent || 0)}%`;
  }

  /**
   * @param {{replacements: number, names: string[], resultFiles: File[], mappingText: string|null, mappingName: string}} d
   */
  showDone(d) {
    const t = this.t;
    this.removeOverlay();
    this.phase = 'done';
    this.applyView?.remove();
    for (const f of this.files) f.view.remove();
    this.renderFilesBar();
    const download = (name, blob) => {
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      a.style.display = 'none';
      this.shadow.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    this.body.append(
      h(
        'div',
        { class: 'fview active' },
        h(
          'div',
          { class: 'center' },
          h('div', { class: 'ok-ic', text: '✓' }),
          h('h3', { text: t('doneTitle', { n: d.replacements }), 'data-testid': 'done-title' }),
          h('p', { text: t('doneFiles', { names: d.names.join(', ') }), 'data-testid': 'done-files' }),
          h('p', { text: t('doneHint') }),
        ),
      ),
    );
    clear(this.footer);
    this.footer.append(
      h('button', { class: 'btn', type: 'button', text: t('btnClose'), 'data-testid': 'btn-done-close', onClick: () => this.o.handlers.onCancel() }),
      h('span', { class: 'sp' }),
      h('button', {
        class: 'btn',
        type: 'button',
        text: t('btnDownloadResult'),
        'data-testid': 'btn-download-result',
        onClick: () => d.resultFiles.forEach((f) => download(f.name, f)),
      }),
      d.mappingText != null
        ? h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: t('btnDownloadMapping'),
            'data-testid': 'btn-download-mapping',
            onClick: () => download(d.mappingName, new Blob([d.mappingText], { type: 'application/json' })),
          })
        : null,
    );
    this.updateChrome();
  }

  /** Уведомление без обмена с ядром (инвалидация контекста FR-09, сбои). */
  showNotice({ title, text, allowOriginal }) {
    const t = this.t;
    this.removeOverlay();
    this.phase = 'notice';
    this.applyView?.remove();
    for (const f of this.files) f.view.remove();
    this.renderFilesBar();
    this.body.append(
      h(
        'div',
        { class: 'fview active' },
        h(
          'div',
          { class: 'center' },
          h('div', { class: 'err-ic', text: '!' }),
          h('h3', { text: title, 'data-testid': 'notice-title' }),
          h('p', { text, 'data-testid': 'notice-text' }),
        ),
      ),
    );
    clear(this.footer);
    this.footer.append(
      h('span', { class: 'sp' }),
      h('button', { class: 'btn', type: 'button', text: t('btnClose'), 'data-testid': 'btn-notice-close', onClick: () => this.o.handlers.onCancel() }),
      allowOriginal
        ? h('button', {
            class: 'btn btn-danger',
            type: 'button',
            text: t('confirmOriginalYes'),
            'data-testid': 'btn-notice-original',
            onClick: () => this.o.handlers.onOriginal(),
          })
        : null,
    );
    this.updateChrome();
  }

  /** Возврат в режим проверки после ошибки применения. */
  backToReview() {
    this.removeOverlay();
    this.applyView?.remove();
    this.phase = 'review';
    this.setActive(this.active);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    for (const f of this.files) f.preview?.destroy();
    this.host.remove();
  }
}
