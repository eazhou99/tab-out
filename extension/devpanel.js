/**
 * devpanel.js — floating design-controls panel.
 *
 * Adds a small gear button to the bottom-right. Clicking it opens a
 * glass overlay with sliders + color pickers bound to the CSS custom
 * properties in style.css. Changes persist to localStorage.
 *
 * The panel is fully self-contained — injects its own styles and DOM
 * so nothing else in the extension has to know about it.
 */

(function () {
  const root = document.documentElement;

  // ---------- Defaults (must match :root in style.css) ----------
  const DEFAULTS = {
    'glass-bg-opacity':     0,
    'glass-border-opacity': 0.24,
    'blur':                 22,
    'saturate':             110,
    'brightness':           1.10,
    'bg-veil':              0,
    'accent-primary':       '#06b6d4',
    'accent-sage':          '#10b981',
    'accent-rose':          '#db6aa0',
    'status-cooling':       '#f59e0b',
  };

  const STATE = { ...DEFAULTS };

  try {
    const saved = JSON.parse(localStorage.getItem('tabout-devpanel') || '{}');
    Object.assign(STATE, saved);
  } catch (_) { /* ignore */ }

  function persist() {
    try { localStorage.setItem('tabout-devpanel', JSON.stringify(STATE)); } catch (_) {}
  }

  // ---------- Helpers ----------
  function hexToRgbTriple(hex) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }

  // ---------- Apply state → CSS ----------
  function apply() {
    // Glass — write the *scalar* tokens. --glass-bg / --glass-bg-hover
    // / --glass-border / --glass-border-strong derive from these via
    // calc() in style.css, so hover and "strong" states stay in the
    // same relationship to the base that the user tuned.
    root.style.setProperty('--glass-bg-opacity',     STATE['glass-bg-opacity']);
    root.style.setProperty('--glass-border-opacity', STATE['glass-border-opacity']);
    root.style.setProperty('--glass-filter',
      `blur(${STATE.blur}px) saturate(${STATE.saturate}%) brightness(${STATE.brightness})`);
    root.style.setProperty('--bg-veil', STATE['bg-veil']);

    // Accent colors — set both the hex form and the RGB triple so both
    // `color:` usage and `rgba()` tints update together.
    ['accent-primary', 'accent-sage', 'accent-rose', 'status-cooling'].forEach(key => {
      const hex = STATE[key];
      root.style.setProperty(`--${key}`, hex);
      const rgb = hexToRgbTriple(hex);
      if (rgb) root.style.setProperty(`--${key}-rgb`, rgb);
    });
    // Keep the legacy `amber` alias in lock-step with primary.
    root.style.setProperty('--accent-amber', STATE['accent-primary']);
  }

  // ---------- Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    .devpanel-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.45);
      background: rgba(255,255,255,0.18);
      color: #0d2340;
      cursor: pointer;
      backdrop-filter: blur(18px) saturate(160%) brightness(1.1);
      -webkit-backdrop-filter: blur(18px) saturate(160%) brightness(1.1);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 6px 18px rgba(0,0,0,0.14);
      transition: background 180ms ease, border-color 180ms ease, transform 180ms ease;
    }
    .devpanel-btn:hover {
      background: rgba(255,255,255,0.35);
      border-color: rgba(255,255,255,0.65);
      transform: translateY(-2px);
    }
    .devpanel-btn:active { transform: scale(0.96); }
    .devpanel-btn svg { width: 18px; height: 18px; }

    .devpanel-overlay {
      position: fixed;
      inset: 0;
      background: rgba(13,35,64,0.18);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      z-index: 9998;
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms ease;
    }
    .devpanel-overlay.open { opacity: 1; pointer-events: auto; }

    .devpanel {
      position: fixed;
      top: 50%;
      right: 20px;
      width: 320px;
      max-height: 85vh;
      overflow-y: auto;
      padding: 18px 18px 16px;
      border-radius: 16px;
      background: rgba(255,255,255,0.60);
      border: 1px solid rgba(255,255,255,0.80);
      backdrop-filter: blur(28px) saturate(180%) brightness(1.05);
      -webkit-backdrop-filter: blur(28px) saturate(180%) brightness(1.05);
      box-shadow: 0 20px 56px rgba(13,35,64,0.25);
      z-index: 9999;
      color: #0d2340;
      font-family: 'DM Sans', sans-serif;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-50%) translateX(20px);
      transition: opacity 260ms ease, transform 260ms cubic-bezier(0.16,1,0.3,1);
    }
    .devpanel.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(-50%) translateX(0);
    }
    .devpanel::-webkit-scrollbar { width: 5px; }
    .devpanel::-webkit-scrollbar-thumb { background: rgba(13,35,64,0.22); border-radius: 3px; }
    .devpanel::-webkit-scrollbar-track { background: transparent; }

    .devpanel h3 {
      font-family: 'Newsreader', serif;
      font-style: italic;
      font-weight: 400;
      font-size: 17px;
      margin: 0 0 14px;
      letter-spacing: -0.2px;
      color: #0d2340;
    }

    .devpanel .section {
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(13,35,64,0.10);
    }
    .devpanel .section:last-of-type {
      border-bottom: none;
      margin-bottom: 8px;
      padding-bottom: 0;
    }
    .devpanel .section-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.4px;
      color: rgba(13,35,64,0.50);
      margin-bottom: 10px;
      display: block;
    }

    .devpanel .row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 12px;
      min-height: 22px;
    }
    .devpanel .row:last-child { margin-bottom: 0; }
    .devpanel .row > label {
      flex: 0 0 84px;
      color: rgba(13,35,64,0.76);
      font-weight: 500;
    }
    .devpanel .row input[type="range"] {
      flex: 1;
      min-width: 0;
      accent-color: var(--accent-primary);
      cursor: pointer;
    }
    .devpanel .row .value {
      flex: 0 0 46px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: rgba(13,35,64,0.58);
    }
    .devpanel .row input[type="color"] {
      width: 34px;
      height: 24px;
      padding: 0;
      border: 1px solid rgba(13,35,64,0.20);
      border-radius: 5px;
      cursor: pointer;
      background: transparent;
      flex: 0 0 34px;
    }
    .devpanel .row input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
    .devpanel .row input[type="color"]::-webkit-color-swatch { border: none; border-radius: 3px; }
    .devpanel .row .hex {
      flex: 1;
      font-size: 11px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      color: rgba(13,35,64,0.70);
      text-align: right;
    }

    .devpanel-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    .devpanel-actions button {
      flex: 1;
      padding: 8px 12px;
      border-radius: 999px;
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .devpanel-actions .reset {
      border: 1px solid rgba(13,35,64,0.22);
      background: rgba(255,255,255,0.35);
      color: rgba(13,35,64,0.82);
    }
    .devpanel-actions .reset:hover {
      background: rgba(255,255,255,0.55);
      border-color: rgba(13,35,64,0.40);
    }
    .devpanel-actions .close {
      border: 1px solid rgba(var(--accent-primary-rgb), 0.50);
      background: rgba(var(--accent-primary-rgb), 0.14);
      color: var(--accent-primary);
    }
    .devpanel-actions .close:hover {
      background: rgba(var(--accent-primary-rgb), 0.26);
      border-color: rgba(var(--accent-primary-rgb), 0.80);
    }
  `;
  document.head.appendChild(style);

  // ---------- Floating gear button ----------
  const btn = document.createElement('button');
  btn.className = 'devpanel-btn';
  btn.setAttribute('aria-label', 'Design controls');
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/>' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>' +
    '</svg>';
  document.body.appendChild(btn);

  // ---------- Overlay + Panel ----------
  const overlay = document.createElement('div');
  overlay.className = 'devpanel-overlay';
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.className = 'devpanel';
  panel.innerHTML = `
    <h3>Design controls</h3>

    <div class="section">
      <label class="section-label">Glass</label>
      <div class="row">
        <label>Fill</label>
        <input type="range" data-key="glass-bg-opacity" min="0" max="0.40" step="0.01">
        <span class="value"></span>
      </div>
      <div class="row">
        <label>Border</label>
        <input type="range" data-key="glass-border-opacity" min="0" max="1" step="0.02">
        <span class="value"></span>
      </div>
      <div class="row">
        <label>Blur</label>
        <input type="range" data-key="blur" min="0" max="60" step="1">
        <span class="value"></span>
      </div>
      <div class="row">
        <label>Saturate</label>
        <input type="range" data-key="saturate" min="50" max="220" step="5">
        <span class="value"></span>
      </div>
      <div class="row">
        <label>Brightness</label>
        <input type="range" data-key="brightness" min="0.60" max="1.60" step="0.02">
        <span class="value"></span>
      </div>
    </div>

    <div class="section">
      <label class="section-label">Background</label>
      <div class="row">
        <label>White veil</label>
        <input type="range" data-key="bg-veil" min="0" max="0.60" step="0.01">
        <span class="value"></span>
      </div>
    </div>

    <div class="section">
      <label class="section-label">Accent colors</label>
      <div class="row">
        <label>Primary</label>
        <input type="color" data-key="accent-primary">
        <span class="hex" data-hex-for="accent-primary"></span>
      </div>
      <div class="row">
        <label>Sage</label>
        <input type="color" data-key="accent-sage">
        <span class="hex" data-hex-for="accent-sage"></span>
      </div>
      <div class="row">
        <label>Rose</label>
        <input type="color" data-key="accent-rose">
        <span class="hex" data-hex-for="accent-rose"></span>
      </div>
      <div class="row">
        <label>Cooling</label>
        <input type="color" data-key="status-cooling">
        <span class="hex" data-hex-for="status-cooling"></span>
      </div>
    </div>

    <div class="devpanel-actions">
      <button class="reset" data-action="reset">Reset</button>
      <button class="close" data-action="close">Close</button>
    </div>
  `;
  document.body.appendChild(panel);

  // ---------- Bind inputs ----------
  function formatValue(key) {
    const v = STATE[key];
    if (key === 'blur')           return v + 'px';
    if (key === 'saturate')       return v + '%';
    if (key === 'brightness')     return Number(v).toFixed(2) + '×';
    if (typeof v === 'number' && v < 1)  return Number(v).toFixed(2);
    return String(v);
  }

  function syncInput(input) {
    const key = input.dataset.key;
    input.value = STATE[key];
    const row = input.closest('.row');
    const valueEl = row.querySelector('.value');
    const hexEl = panel.querySelector(`[data-hex-for="${key}"]`);
    if (valueEl) valueEl.textContent = formatValue(key);
    if (hexEl) hexEl.textContent = STATE[key];
  }

  panel.querySelectorAll('input[data-key]').forEach(input => {
    syncInput(input);
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      STATE[key] = input.type === 'range' ? parseFloat(input.value) : input.value;
      syncInput(input);
      apply();
      persist();
    });
  });

  // ---------- Open / close ----------
  function open()  { overlay.classList.add('open');  panel.classList.add('open'); }
  function close() { overlay.classList.remove('open'); panel.classList.remove('open'); }

  btn.addEventListener('click', open);
  overlay.addEventListener('click', close);
  panel.querySelector('[data-action="close"]').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) close();
  });

  // ---------- Reset ----------
  panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
    Object.assign(STATE, DEFAULTS);
    panel.querySelectorAll('input[data-key]').forEach(syncInput);
    apply();
    persist();
  });

  // ---------- First paint ----------
  apply();
})();
