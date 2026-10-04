// Стили панели — строкой внутри JS (FR-08, дефект 10: без web_accessible_resources).
export const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.root {
  --bg: #ffffff; --surface: #f5f6f8; --surface-2: #eceef2; --text: #16181d; --muted: #667085; --border: #e2e5ea;
  --accent: #2b59e0; --accent-hover: #2349bb; --accent-soft: #e9eefc; --on-accent: #ffffff;
  --danger: #b42318; --danger-soft: #fdecea; --ok: #12703f; --ok-soft: #e6f5ec; --warn: #8a5a00; --warn-soft: #fff4d6;
  --shadow: 0 18px 50px rgba(16, 24, 40, .28), 0 2px 8px rgba(16, 24, 40, .12);
  position: fixed; z-index: 2147483647; width: min(640px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
  display: flex; flex-direction: column; background: var(--bg); color: var(--text); border-radius: 16px;
  box-shadow: var(--shadow), 0 0 0 1px var(--border);
  font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif; letter-spacing: normal;
  text-align: left; direction: ltr; overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #1b1d23; --surface: #23262e; --surface-2: #2c303a; --text: #eceef2; --muted: #9aa2b1; --border: #343845;
    --accent: #7c9cff; --accent-hover: #93adff; --accent-soft: #263154; --on-accent: #0f1630;
    --danger: #ff8a7d; --danger-soft: #3a2220; --ok: #5fd08f; --ok-soft: #1d3326; --warn: #f2c24d; --warn-soft: #3a3016;
    --shadow: 0 18px 50px rgba(0, 0, 0, .6), 0 2px 8px rgba(0, 0, 0, .4);
  }
}
.root.compact { width: min(520px, calc(100vw - 24px)); }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* шапка */
.hdr { display: flex; align-items: center; gap: 12px; padding: 14px 14px 12px 16px; cursor: grab; user-select: none; border-bottom: 1px solid var(--border); touch-action: none; }
.hdr.dragging { cursor: grabbing; }
.logo { flex: none; width: 34px; height: 34px; border-radius: 10px; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; }
.ttl { flex: 1; min-width: 0; }
.ttl b { display: block; font-size: 15px; font-weight: 650; line-height: 1.2; }
.ttl span { display: block; color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdr .site-off { font-size: 12.5px; margin-right: 2px; }
.x { flex: none; width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; }
.x:hover { background: var(--surface-2); color: var(--text); }

/* вкладки файлов */
.files { display: flex; gap: 6px; padding: 10px 16px 0; overflow-x: auto; }
.ftab { flex: none; max-width: 220px; display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; white-space: nowrap; }
.ftab span.n { overflow: hidden; text-overflow: ellipsis; }
.ftab[aria-selected="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.analyzing { background: var(--accent); animation: pulse 1s infinite; }
.dot.ready { background: var(--ok); }
.dot.error { background: var(--danger); }
@keyframes pulse { 50% { opacity: .35; } }

/* тело */
.body { position: relative; display: flex; flex-direction: column; height: min(58vh, 500px); min-height: 280px; padding: 12px 16px 0; }
.compact .body { height: auto; min-height: 0; padding-bottom: 4px; }
.fview { display: none; flex: 1; min-height: 0; flex-direction: column; }
.fview.active { display: flex; }
.warns { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.warn { padding: 7px 11px; border-radius: 9px; background: var(--warn-soft); color: var(--warn); font-size: 13px; }
.note { padding: 7px 11px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); font-size: 13px; margin-bottom: 8px; }
.center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 12px; padding: 12px 24px; }
.center h3 { margin: 0; font-size: 16px; font-weight: 650; }
.center p { margin: 0; color: var(--muted); max-width: 440px; }
.bar { width: min(360px, 80%); height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 99px; transition: width .2s; }
.err-ic, .ok-ic { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; font-size: 22px; font-weight: 700; }
.err-ic { background: var(--danger-soft); color: var(--danger); }
.ok-ic { background: var(--ok-soft); color: var(--ok); }
.actions-inline { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.empty-found { color: var(--muted); }

/* подвал */
.ftr { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--bg); }
.ftr .sp { flex: 1; }
.btn { border: 1px solid var(--border); background: var(--bg); padding: 8px 14px; border-radius: 10px; font-weight: 550; white-space: nowrap; }
.btn:hover { background: var(--surface); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn-sm { padding: 5px 10px; font-size: 13px; }
.btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
.link { border: 0; background: none; padding: 0; color: var(--accent); font-size: 13px; text-decoration: none; }
.link:hover { text-decoration: underline; }
.site-off { flex: none; white-space: nowrap; color: var(--muted); }
.site-off:hover { color: var(--accent); }

/* подтверждение */
.overlay { position: absolute; inset: 0; z-index: 3; background: color-mix(in srgb, var(--bg) 86%, transparent); backdrop-filter: blur(3px); display: grid; place-items: center; padding: 20px; }
.dialog { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; max-width: 420px; box-shadow: var(--shadow); }
.dialog h3 { margin: 0 0 6px; font-size: 16px; }
.dialog p { margin: 0 0 14px; color: var(--muted); }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }

/* превью */
.pv { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.pv-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
.pv-tab { border: 0; background: none; padding: 7px 12px; color: var(--muted); font-weight: 550; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.pv-tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.pv-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.pv-pane[hidden] { display: none; }
.pv-toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
.pv-search, .pv-select, .pv-repl { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; min-width: 0; }
.pv-search { flex: 1; }
.pv-select { max-width: 190px; }
.pv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.pv-chips:empty { display: none; }
.chip { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 2px 10px; font-size: 12.5px; }
.chip[style] { --c: #888; border-left: 3px solid var(--c); border-radius: 6px 999px 999px 6px; }
.chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.pv-bulkrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.pv-summary { font-weight: 600; font-size: 13px; }
.pv-bulk { display: flex; gap: 12px; }
.pv-table { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--bg); }
.pv-rows { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; }
.pv-spacer { width: 1px; }
.pv-row { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 10px; padding: 0 10px 0 12px; border-bottom: 1px solid var(--border); background: var(--bg); }
.pv-row:hover { background: var(--surface); }
.pv-row.off .pv-main { opacity: .5; }
.pv-check { flex: none; width: 17px; height: 17px; accent-color: var(--accent); margin: 0; }
.pv-main { flex: 1; min-width: 0; }
.pv-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.cat { flex: none; font-size: 11.5px; font-weight: 650; padding: 1px 7px; border-radius: 6px; color: color-mix(in srgb, var(--c) 78%, var(--text)); background: color-mix(in srgb, var(--c) 16%, transparent); }
.val { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pv-meta { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; margin-top: 3px; min-width: 0; }
.pv-meta > span { flex: none; }
.pv-ctx { flex: 1 1 0 !important; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }
.pv-user { color: var(--accent); }
.lvl { font-size: 11px; width: 16px; text-align: center; }
.lvl-validated { color: var(--ok); }
.lvl-labeled, .lvl-kb { color: var(--accent); }
.lvl-ner { color: var(--accent); }
.lvl-weak { color: var(--warn); }
.pv-repl { flex: none; width: 168px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pv-ignore { flex: none; border: 0; background: none; color: var(--muted); font-size: 16px; padding: 2px 4px; border-radius: 6px; }
.pv-ignore:hover { color: var(--danger); background: var(--danger-soft); }
.pv-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
.pv-empty[hidden] { display: none; }

/* текст */
.pv-text { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--bg); }
.pv-p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; }
.pv-mark { cursor: pointer; color: inherit; border-radius: 4px; padding: 0 1px; background: color-mix(in srgb, var(--c) 28%, transparent); box-shadow: inset 0 -2px 0 var(--c); }
.pv-mark.off { background: transparent; box-shadow: none; text-decoration: line-through; opacity: .6; }
.pv-loading { color: var(--muted); }
.pv-selbar { position: absolute; left: 8px; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--accent); border-radius: 12px; box-shadow: var(--shadow); font-size: 13px; }
.pv-selbar[hidden], .pv-menu[hidden], .pv-toast[hidden] { display: none; }
.sel-text { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sel-lab { color: var(--muted); }
.bad { color: var(--danger); }
.pv-menu { position: absolute; z-index: 4; display: flex; flex-direction: column; min-width: 220px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 4px; }
.pv-menu button { text-align: left; border: 0; background: none; padding: 7px 10px; border-radius: 7px; }
.pv-menu button:hover { background: var(--surface); }
.pv-toast { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 7px 14px; border-radius: 99px; font-size: 13px; z-index: 5; max-width: 90%; }

/* готово */
.done-list { margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 13px; }
`;
