/* Dungeon Dice Box – UI. Dice math lives in dice-core.js (window.DiceCore). */
(() => {
  'use strict';

  const Core = window.DiceCore;
  if (!Core) {
    document.body.insertAdjacentHTML('afterbegin', '<p class="noscript">dice-core.js failed to load.</p>');
    return;
  }

  const { DICE } = Core;
  // Player profiles, lucky dice and the Hall of Shame (dice-profiles.js). Optional:
  // if it failed to load, the dice box works exactly as before without them.
  const Profiles = window.DiceProfiles || null;
  const STORAGE_KEYS = {
    history: 'diceBox.history.v1',
    presets: 'diceBox.presets.v1',
    state: 'diceBox.state.v1',
  };
  const MAX_HISTORY = 50;
  const MAX_PER_DIE = 99;
  const MAX_USER_PRESETS = 12;
  const MAX_VISUAL_DICE = 60;
  const MOD_LIMIT = 999;
  const SHORTCUT_KEYS = ['1', '2', '3', '4', '5', '6', '7'];

  const DEFAULT_PRESETS = [
    { label: 'Attack', notation: 'd20+5' },
    { label: 'Damage', notation: '2d6+3' },
    { label: 'Ability score', notation: '4d6kh3' },
    { label: 'Fireball', notation: '8d6' },
    { label: 'Sneak attack', notation: 'd8+3d6+4' },
    { label: 'Percentile', notation: 'd100' },
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    box: $('box'),
    tray: $('tray'),
    trayEmpty: $('tray-empty'),
    trayPreview: $('tray-preview'),
    trayDice: $('tray-dice'),
    trayMore: $('tray-more'),
    rack: $('rack'),
    modInput: $('mod-input'),
    modUp: $('mod-up'),
    modDown: $('mod-down'),
    modeGroup: $('mode-group'),
    rollBtn: $('roll-btn'),
    rollFormula: $('roll-formula'),
    clearBtn: $('clear-btn'),
    resultCard: $('result-card'),
    resultLabel: $('result-label'),
    resultNotation: $('result-notation'),
    total: $('total'),
    banner: $('banner'),
    breakdown: $('breakdown'),
    announcer: $('announcer'),
    formulaForm: $('formula-form'),
    formula: $('formula'),
    formulaHint: $('formula-hint'),
    presetList: $('preset-list'),
    savePreset: $('save-preset'),
    historyList: $('history-list'),
    historyEmpty: $('history-empty'),
    clearHistory: $('clear-history'),
    helpToggle: $('help-toggle'),
    helpPanel: $('help-panel'),
    playerChip: $('player-chip'),
    playersPanel: $('players-panel'),
    playerList: $('player-list'),
    addPlayer: $('add-player'),
    storageNote: $('storage-note'),
    playerEditor: $('player-editor'),
    editorName: $('editor-name'),
    playerForm: $('player-form'),
    playerName: $('player-name'),
    playerTheme: $('player-theme'),
    playerBody: $('player-body'),
    playerInk: $('player-ink'),
    playerFinish: $('player-finish'),
    lookPreview: $('look-preview'),
    deletePlayer: $('delete-player'),
    exportProfiles: $('export-profiles'),
    importProfiles: $('import-profiles'),
    importFile: $('import-file'),
    bagPanel: $('bag-panel'),
    bagOwner: $('bag-owner'),
    bagList: $('bag-list'),
    bagStatus: $('bag-status'),
    shamePanel: $('shame-panel'),
    shameCount: $('shame-count'),
    shameEmpty: $('shame-empty'),
    shameList: $('shame-list'),
    burnDialog: $('burn-dialog'),
    burnTitle: $('burn-title'),
    burnSummary: $('burn-summary'),
    burnEpitaph: $('burn-epitaph'),
    burnCancel: $('burn-cancel'),
  };

  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const state = {
    pool: emptyPool(),
    modifier: 0,
    custom: null, // notation (without flat modifier) that the rack can't represent
    mode: 'normal',
    rolling: false,
    lastResult: null,
    lastNotation: null,
    history: [],
    presets: [],
  };

  // ---------------------------------------------------------------- storage
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage full or disabled – the app still works without it */
    }
  }

  function emptyPool() {
    const pool = {};
    DICE.forEach((s) => { pool[s] = 0; });
    return pool;
  }

  function clampInt(n, lo, hi) {
    n = Math.trunc(Number(n));
    if (!Number.isFinite(n)) n = 0;
    return Math.min(hi, Math.max(lo, n));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function saveState() {
    save(STORAGE_KEYS.state, { pool: state.pool, modifier: state.modifier, custom: state.custom, mode: state.mode });
  }

  function restore() {
    const saved = load(STORAGE_KEYS.state, null);
    if (saved && typeof saved === 'object') {
      DICE.forEach((s) => { state.pool[s] = clampInt(saved.pool && saved.pool[s], 0, MAX_PER_DIE); });
      state.modifier = clampInt(saved.modifier, -MOD_LIMIT, MOD_LIMIT);
      if (['normal', 'adv', 'dis'].includes(saved.mode)) state.mode = saved.mode;
      if (typeof saved.custom === 'string' && saved.custom) {
        try {
          const p = Core.parseNotation(saved.custom);
          if (p.terms.length) {
            state.custom = Core.toNotation({ terms: p.terms, modifier: 0 });
            state.pool = emptyPool();
          }
        } catch (e) { /* ignore stale formula */ }
      }
      if (Core.countDice(currentParsed()) > Core.LIMITS.maxTotalDice) {
        state.pool = emptyPool();
        state.custom = null;
      }
    } else {
      state.pool[20] = 1; // a friendly default: one d20 on the table
    }
    const hist = load(STORAGE_KEYS.history, []);
    state.history = Array.isArray(hist)
      ? hist.filter((h) => h && typeof h.notation === 'string' && Number.isFinite(h.total)).slice(0, MAX_HISTORY)
      : [];
    const presets = load(STORAGE_KEYS.presets, []);
    state.presets = Array.isArray(presets)
      ? presets.filter((p) => p && typeof p.notation === 'string').slice(0, MAX_USER_PRESETS)
      : [];
  }

  // ------------------------------------------------------------- expression
  function currentParsed() {
    if (state.custom) {
      const p = Core.parseNotation(state.custom);
      return { terms: p.terms, modifier: state.modifier };
    }
    return Core.fromPool(state.pool, state.modifier);
  }

  function currentNotation() {
    return Core.toNotation(currentParsed());
  }

  /** Load a notation string into the rack (or as a custom formula). Throws DiceError. */
  function setExpression(text) {
    const trimmed = String(text).trim();
    if (!trimmed) {
      state.pool = emptyPool();
      state.custom = null;
      state.modifier = 0;
      return null;
    }
    const parsed = Core.parseNotation(trimmed);
    if (Math.abs(parsed.modifier) > MOD_LIMIT) throw new Core.DiceError('Keep the modifier between −999 and +999.');
    const asPool = Core.toPool(parsed, MAX_PER_DIE);
    if (asPool) {
      state.pool = asPool.pool;
      state.custom = null;
    } else {
      state.pool = emptyPool();
      state.custom = Core.toNotation({ terms: parsed.terms, modifier: 0 });
    }
    state.modifier = parsed.modifier;
    return parsed;
  }

  // ------------------------------------------------------------------ dice
  const PIP_LAYOUT = {
    1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9],
  };

  function faceMarkup(sides, value) {
    if (sides === 6 && typeof value === 'number') {
      const on = PIP_LAYOUT[value] || [];
      let html = '';
      for (let i = 1; i <= 9; i++) html += on.includes(i) ? '<i class="pip"></i>' : '<i></i>';
      return { html, cls: 'pips' };
    }
    const underline = typeof value === 'number' && sides >= 8 && (value === 6 || value === 9);
    return { html: escapeHtml(value), cls: underline ? 'underline' : '' };
  }

  function setFace(die, sides, value) {
    const face = die.querySelector('.die-face');
    const f = faceMarkup(sides, value);
    face.className = 'die-face' + (f.cls ? ' ' + f.cls : '') + (String(value).length >= 3 ? ' small' : '');
    face.innerHTML = f.html;
  }

  function createDie(sides, value, extraClass) {
    const die = document.createElement('span');
    die.className = 'die die-d' + sides + (extraClass ? ' ' + extraClass : '');
    die.innerHTML = '<span class="die-body"><span class="die-face"></span></span>';
    setFace(die, sides, value);
    return die;
  }

  function rackFace(sides) {
    return sides === 100 ? '%' : String(sides);
  }

  // ------------------------------------------------------------------- rack
  function buildRack() {
    const frag = document.createDocumentFragment();
    DICE.forEach((sides, i) => {
      const li = document.createElement('li');
      li.className = 'rack-item';
      li.dataset.sides = sides;
      const key = SHORTCUT_KEYS[i];
      li.innerHTML =
        '<button type="button" class="rack-die" data-action="add" aria-keyshortcuts="' + key + '"' +
        ' aria-describedby="rack-count-' + sides + '">' +
          '<kbd class="rack-key" aria-hidden="true">' + key + '</kbd>' +
          '<span class="rack-lucky" aria-hidden="true" title="Lucky die">★</span>' +
          '<span class="rack-icon"></span>' +
          '<span class="rack-name"><span class="visually-hidden">Add a </span>d' + sides + '</span>' +
        '</button>' +
        '<div class="rack-stepper">' +
          '<button type="button" class="step step-small" data-action="remove" aria-label="Remove a d' + sides + '">−</button>' +
          '<span class="rack-count" id="rack-count-' + sides + '"><span class="num">0</span><span class="visually-hidden"> d' + sides + ' selected</span></span>' +
          '<button type="button" class="step step-small" data-action="add" aria-label="Add a d' + sides + '">+</button>' +
        '</div>';
      li.querySelector('.rack-icon').appendChild(createDie(sides, rackFace(sides), 'die-icon'));
      frag.appendChild(li);
    });
    el.rack.appendChild(frag);
  }

  function updateRack() {
    const lucky = luckySides();
    el.rack.querySelectorAll('.rack-item').forEach((li) => {
      const sides = Number(li.dataset.sides);
      const n = state.pool[sides];
      li.classList.toggle('is-selected', n > 0);
      li.classList.toggle('is-lucky', sides === lucky);
      li.querySelector('.num').textContent = n;
      li.querySelector('[data-action="remove"]').disabled = n === 0;
    });
    el.rack.classList.toggle('is-custom', !!state.custom);
  }

  function changeDie(sides, delta) {
    if (state.rolling) return;
    if (state.custom) {
      // Editing the rack replaces a custom formula.
      state.custom = null;
      state.pool = emptyPool();
    }
    const next = clampInt(state.pool[sides] + delta, 0, MAX_PER_DIE);
    const totalNow = DICE.reduce((n, s) => n + state.pool[s], 0);
    if (delta > 0 && totalNow + (next - state.pool[sides]) > Core.LIMITS.maxTotalDice) {
      showHint('The box holds at most ' + Core.LIMITS.maxTotalDice + ' dice.', 'error');
      return;
    }
    if (next === state.pool[sides]) return;
    state.pool[sides] = next;
    selectionChanged();
    pulse(el.rack.querySelector('[data-sides="' + sides + '"] .rack-die'));
  }

  function changeModifier(delta) {
    setModifier(state.modifier + delta);
  }

  function setModifier(value) {
    if (state.rolling) return;
    const v = clampInt(value, -MOD_LIMIT, MOD_LIMIT);
    if (v === state.modifier) {
      el.modInput.value = v;
      return;
    }
    state.modifier = v;
    selectionChanged();
  }

  function setMode(mode) {
    if (!['normal', 'adv', 'dis'].includes(mode)) return;
    state.mode = mode;
    const radio = el.modeGroup.querySelector('input[value="' + mode + '"]');
    if (radio) radio.checked = true;
    saveState();
    updateRollButton();
    updateFormulaHint();
  }

  function clearSelection() {
    if (state.rolling) return;
    state.pool = emptyPool();
    state.custom = null;
    state.modifier = 0;
    selectionChanged();
  }

  function pulse(node) {
    if (!node || reducedMotion.matches) return;
    node.classList.remove('pulse');
    void node.offsetWidth;
    node.classList.add('pulse');
  }

  // ------------------------------------------------------------- rendering
  function selectionChanged() {
    updateRack();
    el.modInput.value = state.modifier;
    if (document.activeElement !== el.formula) el.formula.value = currentNotation();
    el.formula.removeAttribute('aria-invalid');
    updateFormulaHint();
    updateRollButton();
    renderPreview();
    markStale();
    saveState();
  }

  function updateRollButton() {
    const parsed = currentParsed();
    const hasDice = parsed.terms.length > 0;
    const notation = Core.toNotation(parsed);
    let label = hasDice ? notation : 'Pick dice';
    if (hasDice && state.mode !== 'normal' && Core.hasAdvantageTarget(parsed)) {
      label += state.mode === 'adv' ? ' · adv' : ' · dis';
    }
    el.rollFormula.textContent = label;
    el.rollBtn.disabled = !hasDice || state.rolling;
    el.rollBtn.setAttribute('aria-label', hasDice ? 'Roll ' + notation + (label.includes('·') ? ' with ' + Core.modeLabel(state.mode) : '') : 'Roll (pick some dice first)');
    el.clearBtn.disabled = state.rolling || (!hasDice && state.modifier === 0);
  }

  function showHint(text, kind) {
    el.formulaHint.textContent = text;
    el.formulaHint.className = 'hint' + (kind ? ' hint-' + kind : '');
  }

  function updateFormulaHint() {
    const parsed = currentParsed();
    if (!parsed.terms.length) {
      showHint('Add dice from the rack or type a formula.');
      return;
    }
    const range = Core.expressionRange(parsed);
    const n = Core.countDice(parsed);
    let text = n + (n === 1 ? ' die' : ' dice') + ' · range ' + range.min + '–' + range.max;
    if (state.custom) text += ' · custom formula (rack edits replace it)';
    if (state.mode !== 'normal' && !Core.hasAdvantageTarget(parsed)) {
      text += ' · ' + Core.modeLabel(state.mode) + ' only affects plain d20s';
    }
    showHint(text);
  }

  function markStale() {
    if (!state.lastResult) return;
    const stale = currentNotation() !== state.lastNotation;
    el.resultCard.classList.toggle('is-stale', stale);
    el.resultLabel.textContent = stale ? 'Last roll' : 'Result';
  }

  function renderPreview() {
    if (state.rolling) return;
    const parsed = currentParsed();
    const notation = Core.toNotation(parsed);
    if (state.lastResult && notation === state.lastNotation && el.tray.dataset.state === 'result') return;
    el.trayPreview.innerHTML = '';
    el.trayDice.innerHTML = '';
    clear3d();
    el.trayMore.hidden = true;
    if (!parsed.terms.length) {
      el.tray.dataset.state = 'empty';
      return;
    }
    el.tray.dataset.state = 'preview';
    const frag = document.createDocumentFragment();
    let shown = 0;
    let total = 0;
    parsed.terms.forEach((t) => {
      total += t.count;
      for (let i = 0; i < t.count && shown < MAX_VISUAL_DICE; i++, shown++) {
        const die = createDie(t.sides, rackFace(t.sides), 'is-preview');
        if (t.sign < 0) die.classList.add('is-negative');
        frag.appendChild(die);
      }
    });
    el.trayPreview.appendChild(frag);
    sizePreview(shown);
    if (total > shown) {
      el.trayMore.textContent = '+' + (total - shown) + ' more';
      el.trayMore.hidden = false;
    }
  }

  function sizePreview(n) {
    const rect = el.tray.getBoundingClientRect();
    const area = Math.max(1, rect.width * rect.height);
    const size = Math.max(28, Math.min(64, Math.sqrt(area / (Math.max(n, 1) * 3.2))));
    el.trayPreview.style.setProperty('--size', Math.round(size) + 'px');
  }

  // ------------------------------------------------------------ roll + anim
  function shuffle(arr) {
    // Cosmetic only (dice placement), so Math.random is fine here.
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function layoutPositions(n, W, H) {
    const pad = 10;
    let size = Math.max(30, Math.min(80, Math.sqrt((W * H) / (n * 3.4))));
    let cols;
    let rows;
    for (;;) {
      const cell = size * 1.28;
      cols = Math.max(1, Math.floor((W - pad * 2) / cell));
      rows = Math.max(1, Math.floor((H - pad * 2) / cell));
      if (cols * rows >= n || size <= 22) break;
      size -= 2;
    }
    const cellW = (W - pad * 2) / cols;
    const cellH = (H - pad * 2) / rows;
    const cells = shuffle([...Array(cols * rows).keys()]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = cells[i % cells.length];
      const slackX = Math.max(0, cellW - size) * 0.8;
      const slackY = Math.max(0, cellH - size) * 0.8;
      const cx = pad + ((c % cols) + 0.5) * cellW + (Math.random() - 0.5) * slackX;
      const cy = pad + (Math.floor(c / cols) + 0.5) * cellH + (Math.random() - 0.5) * slackY;
      out.push({ cx, cy, size });
    }
    return out;
  }

  function flattenDice(result) {
    const list = [];
    const lucky = luckySides();
    result.groups.forEach((g) => g.dice.forEach((d) => list.push(Object.assign({ sign: g.sign, lucky: d.sides === lucky }, d))));
    return list;
  }

  function finalizeDie(die, d) {
    setFace(die, d.sides, d.value);
    die.classList.toggle('is-dropped', !d.kept);
    die.classList.toggle('is-crit', !!d.crit);
    die.classList.toggle('is-fumble', !!d.fumble);
    die.classList.toggle('is-max', d.kept && d.value === d.sides && !d.crit);
    die.classList.toggle('is-lucky', !!d.lucky);
  }

  // The 3D tray (tray3d.js, an ES module using three.js) registers window.DiceTray3D.
  // If WebGL or the module is unavailable, the CSS tray below is used instead.
  function tray3d() {
    const t = window.DiceTray3D;
    try {
      return t && t.available() ? t : null;
    } catch (e) {
      return null;
    }
  }

  function clear3d() {
    if (window.DiceTray3D) window.DiceTray3D.clear();
  }

  function animateRoll(result) {
    const t3d = tray3d();
    if (!t3d) return animateRollCss(result);
    const dice = flattenDice(result);
    const visual = dice.slice(0, MAX_VISUAL_DICE).map((d) => Object.assign({}, d, {
      max: d.kept && d.value === d.sides && !d.crit,
    }));
    const extra = dice.length - visual.length;
    const reduced = reducedMotion.matches;

    el.trayPreview.innerHTML = '';
    el.trayDice.innerHTML = '';
    el.tray.dataset.state = 'result';
    el.trayMore.hidden = extra <= 0;
    if (extra > 0) el.trayMore.textContent = '+' + extra + ' more in the results';

    if (!reduced) {
      el.box.classList.remove('is-shaking');
      void el.box.offsetWidth;
      el.box.classList.add('is-shaking');
    }
    return t3d.roll(visual, { reduced, look: playerLook() }).then(
      () => { el.box.classList.remove('is-shaking'); },
      () => {
        clear3d();
        return animateRollCss(result);
      },
    );
  }

  function animateRollCss(result) {
    clear3d();
    const dice = flattenDice(result);
    const visual = dice.slice(0, MAX_VISUAL_DICE);
    const extra = dice.length - visual.length;
    const rect = el.tray.getBoundingClientRect();
    const W = Math.max(rect.width, 200);
    const H = Math.max(rect.height, 160);
    const positions = layoutPositions(visual.length, W, H);
    const reduced = reducedMotion.matches;

    el.trayPreview.innerHTML = '';
    el.trayDice.innerHTML = '';
    el.tray.dataset.state = 'result';
    el.trayMore.hidden = extra <= 0;
    if (extra > 0) el.trayMore.textContent = '+' + extra + ' more in the results';

    const fromLeft = Math.random() < 0.5;
    const ends = [];
    const nodes = visual.map((d, i) => {
      const p = positions[i];
      const die = createDie(d.sides, reduced ? d.value : randomFace(d.sides), 'in-tray');
      if (d.sign < 0) die.classList.add('is-negative');
      die.style.setProperty('--size', Math.round(p.size) + 'px');
      die.style.left = ((p.cx - p.size / 2) / W) * 100 + '%';
      die.style.top = ((p.cy - p.size / 2) / H) * 100 + '%';
      if (reduced) {
        die.classList.add('appear');
        finalizeDie(die, d);
      } else {
        const originX = fromLeft ? -p.size - Math.random() * 40 : W + Math.random() * 40;
        const originY = H * (0.55 + Math.random() * 0.5);
        const spin = (fromLeft ? 1 : -1) * (540 + Math.random() * 540);
        const delay = Math.min(i * 28, 420);
        const dur = 850 + Math.random() * 300;
        die.style.setProperty('--sx', Math.round(originX - p.cx) + 'px');
        die.style.setProperty('--sy', Math.round(originY - p.cy) + 'px');
        die.style.setProperty('--r0', Math.round(spin) + 'deg');
        die.style.setProperty('--r1', Math.round(spin * 0.45) + 'deg');
        die.style.setProperty('--r2', Math.round(spin * 0.12) + 'deg');
        die.style.setProperty('--rest', Math.round((Math.random() - 0.5) * 40) + 'deg');
        die.style.setProperty('--tx', Math.round((Math.random() - 0.5) * 70) + 'deg');
        die.style.setProperty('--ty', Math.round((Math.random() - 0.5) * 70) + 'deg');
        die.style.setProperty('--delay', delay + 'ms');
        die.style.setProperty('--dur', Math.round(dur) + 'ms');
        die.classList.add('tumbling');
        ends.push(delay + dur);
      }
      el.trayDice.appendChild(die);
      return die;
    });

    if (reduced) return Promise.resolve();

    el.box.classList.remove('is-shaking');
    void el.box.offsetWidth;
    el.box.classList.add('is-shaking');

    return new Promise((resolve) => {
      const start = performance.now();
      const longest = Math.max.apply(null, ends);
      const timer = setInterval(() => {
        const t = performance.now() - start;
        nodes.forEach((die, i) => {
          if (die.dataset.settled) return;
          if (t >= ends[i] * 0.82) {
            die.dataset.settled = '1';
            finalizeDie(die, visual[i]);
          } else if (t > (parseFloat(die.style.getPropertyValue('--delay')) || 0)) {
            setFace(die, visual[i].sides, randomFace(visual[i].sides));
          }
        });
      }, 70);
      setTimeout(() => {
        clearInterval(timer);
        nodes.forEach((die, i) => finalizeDie(die, visual[i]));
        el.box.classList.remove('is-shaking');
        resolve();
      }, longest + 40);
    });
  }

  function randomFace(sides) {
    // Cosmetic flicker while tumbling; real results come from DiceCore.
    return 1 + Math.floor(Math.random() * sides);
  }

  async function roll(options) {
    const opts = options || {};
    if (state.rolling) return;
    if (opts.notation) {
      try {
        setExpression(opts.notation);
      } catch (e) {
        showHint(e.message, 'error');
        return;
      }
      if (opts.mode) setMode(opts.mode);
      selectionChanged();
    }
    const parsed = currentParsed();
    if (!parsed.terms.length) {
      showHint('Pick at least one die first.', 'error');
      pulse(el.rack);
      return;
    }
    let result;
    try {
      result = Core.rollExpression(parsed, { mode: state.mode });
    } catch (e) {
      showHint(e.message, 'error');
      return;
    }

    state.rolling = true;
    el.rollBtn.setAttribute('aria-busy', 'true');
    el.resultCard.dataset.state = 'rolling';
    updateRollButton();
    el.announcer.textContent = 'Rolling…';

    await animateRoll(result);

    state.rolling = false;
    el.rollBtn.removeAttribute('aria-busy');
    state.lastResult = result;
    state.lastNotation = Core.toNotation(parsed);
    // Bookkeeping only: the result was already decided by DiceCore above.
    const credited = recordProfileRoll(result);
    showResult(result, credited);
    addHistory(result);
    updateRollButton();
  }

  function showResult(result, credited) {
    el.resultCard.dataset.state = 'done';
    el.resultCard.classList.remove('is-stale', 'is-crit', 'is-fumble');
    el.resultLabel.textContent = 'Result';
    const modeText = result.mode !== 'normal' ? ' · ' + Core.modeLabel(result.mode) : '';
    const luckyType = luckySides();
    const who = profiles && profiles.players.length > 1 ? ' · ' + player().name : '';
    el.resultNotation.textContent = result.notation + modeText + who;
    el.total.textContent = result.total;
    el.total.classList.remove('pop');
    if (!reducedMotion.matches) {
      void el.total.offsetWidth;
      el.total.classList.add('pop');
    }

    const msgs = [];
    if (result.crits) msgs.push('<span class="banner-crit">' + (result.crits > 1 ? result.crits + ' × ' : '') + 'Natural 20!</span>');
    if (result.fumbles) msgs.push('<span class="banner-fumble">' + (result.fumbles > 1 ? result.fumbles + ' × ' : '') + 'Natural 1</span>');
    const luckyRoll = (credited || []).find((c) => c.lucky);
    if (luckyRoll) {
      if (luckyRoll.values.includes(luckyRoll.sides)) msgs.push('<span class="banner-lucky">★ Lucky die delivers!</span>');
      else if (luckyRoll.values.includes(1)) msgs.push('<span class="banner-lucky is-sus">★ “Lucky” die, huh?</span>');
    }
    el.banner.innerHTML = msgs.join('');
    el.banner.hidden = msgs.length === 0;
    if (result.crits) el.resultCard.classList.add('is-crit');
    else if (result.fumbles) el.resultCard.classList.add('is-fumble');
    flashTray(result);

    let html = '';
    result.groups.forEach((g) => {
      const chips = g.dice.map((d) => {
        const cls = ['chip', 'chip-d' + d.sides];
        let title = 'd' + d.sides + ': ' + d.value;
        if (!d.kept) { cls.push('dropped'); title += ' (dropped)'; }
        if (d.crit) { cls.push('crit'); title += ' – natural 20'; }
        if (d.fumble) { cls.push('fumble'); title += ' – natural 1'; }
        if (d.kept && d.value === d.sides && !d.crit) cls.push('max');
        if (d.sides === luckyType) { cls.push('lucky'); title += ' – lucky die'; }
        return '<li class="' + cls.join(' ') + '" title="' + title + '">' + d.value + '</li>';
      }).join('');
      const extra = g.adv ? ' <span class="tag">' + (result.mode === 'adv' ? 'adv' : 'dis') + '</span>' : '';
      html +=
        '<div class="group">' +
          '<span class="group-label">' + (g.sign < 0 ? '− ' : '') + escapeHtml(g.label) + extra + '</span>' +
          '<ul class="chips" aria-label="' + escapeHtml(g.label) + ' results">' + chips + '</ul>' +
          '<span class="group-sub">' + (g.subtotal < 0 ? '−' : '') + Math.abs(g.subtotal) + '</span>' +
        '</div>';
    });
    if (result.modifier) {
      html += '<div class="group group-mod"><span class="group-label">Modifier</span><span class="chips"></span>' +
        '<span class="group-sub">' + Core.formatSigned(result.modifier) + '</span></div>';
    }
    el.breakdown.innerHTML = html;
    el.announcer.textContent = Core.describeRoll(result);
  }

  function flashTray(result) {
    el.tray.classList.remove('flash-crit', 'flash-fumble');
    if (reducedMotion.matches) return;
    void el.tray.offsetWidth;
    if (result.crits) el.tray.classList.add('flash-crit');
    else if (result.fumbles) el.tray.classList.add('flash-fumble');
  }

  // ---------------------------------------------------------------- history
  function addHistory(result) {
    state.history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      notation: result.notation,
      mode: result.mode,
      total: result.total,
      detail: Core.formatDetail(result),
      crit: result.crits > 0,
      fumble: result.fumbles > 0,
      time: result.timestamp,
      player: profiles ? player().name : undefined,
    });
    state.history.length = Math.min(state.history.length, MAX_HISTORY);
    save(STORAGE_KEYS.history, state.history);
    renderHistory();
  }

  function renderHistory() {
    el.historyEmpty.hidden = state.history.length > 0;
    el.clearHistory.disabled = state.history.length === 0;
    el.historyList.innerHTML = state.history.map((h) => {
      const time = new Date(h.time);
      const timeText = isNaN(time) ? '' : time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const mode = h.mode === 'adv' ? '<span class="tag">adv</span>' : h.mode === 'dis' ? '<span class="tag">dis</span>' : '';
      const cls = 'history-item' + (h.crit ? ' crit' : '') + (h.fumble ? ' fumble' : '');
      const who = h.player && profiles && profiles.players.length > 1 ? '<span class="tag tag-player">' + escapeHtml(h.player) + '</span>' : '';
      return '<li class="' + cls + '">' +
        '<button type="button" class="history-btn" data-id="' + escapeHtml(h.id) + '"' +
        ' aria-label="Roll ' + escapeHtml(h.notation) + (h.mode !== 'normal' ? ' with ' + Core.modeLabel(h.mode) : '') + ' again (previous total ' + h.total + ')">' +
          '<span class="h-total">' + h.total + '</span>' +
          '<span class="h-main">' +
            '<span class="h-notation">' + escapeHtml(h.notation) + ' ' + mode + who + '</span>' +
            '<span class="h-detail">' + escapeHtml(h.detail || '') + '</span>' +
          '</span>' +
          '<span class="h-side"><time datetime="' + (isNaN(time) ? '' : time.toISOString()) + '">' + timeText + '</time>' +
          '<span class="h-again" aria-hidden="true">↻</span></span>' +
        '</button></li>';
    }).join('');
  }

  // ---------------------------------------------------------------- presets
  function renderPresets() {
    const all = DEFAULT_PRESETS.map((p) => Object.assign({ builtIn: true }, p)).concat(state.presets);
    el.presetList.innerHTML = all.map((p, i) => {
      const label = escapeHtml(p.label || p.notation);
      const note = escapeHtml(p.notation);
      const remove = p.builtIn ? '' :
        '<button type="button" class="preset-remove" data-remove="' + (i - DEFAULT_PRESETS.length) + '" aria-label="Remove quick roll ' + note + '">×</button>';
      return '<li class="preset' + (p.builtIn ? '' : ' preset-user') + '">' +
        '<button type="button" class="preset-btn" data-notation="' + note + '" aria-label="Roll ' + label + ': ' + note + '">' +
          '<span class="preset-label">' + label + '</span><span class="preset-notation">' + note + '</span>' +
        '</button>' + remove + '</li>';
    }).join('');
  }

  function saveCurrentPreset() {
    const parsed = currentParsed();
    if (!parsed.terms.length) {
      showHint('Pick some dice before saving a quick roll.', 'error');
      return;
    }
    const notation = Core.toNotation(parsed);
    const exists = DEFAULT_PRESETS.concat(state.presets).some((p) => p.notation === notation);
    if (exists) {
      showHint(notation + ' is already a quick roll.');
      return;
    }
    if (state.presets.length >= MAX_USER_PRESETS) state.presets.shift();
    state.presets.push({ label: notation, notation });
    save(STORAGE_KEYS.presets, state.presets);
    renderPresets();
    showHint('Saved ' + notation + ' to quick rolls.', 'ok');
  }

  // --------------------------------------------------------------- profiles
  // Everything below is bookkeeping and cosmetics; DiceCore alone decides rolls.
  const profileStore = (() => {
    try { return window.localStorage; } catch (e) { return null; }
  })();
  let profiles = null;
  let profilesPersistent = false;
  let burnTarget = null;

  function loadProfiles() {
    if (!Profiles) return;
    const r = Profiles.load(profileStore);
    profiles = r.data;
    profilesPersistent = r.persistent;
    let note = '';
    if (!r.persistent) {
      note = 'This browser isn\u2019t letting the page save data, so players and dice stats last only until the tab closes. Use Backup \u2192 Export to keep them.';
    } else if (r.status === 'corrupt' || r.status === 'future') {
      note = (r.status === 'future' ? 'Your saved profiles come from a newer version of the dice box' : 'Your saved profiles couldn\u2019t be read') +
        ', so a fresh table was set up. The old data was kept as a backup in this browser.';
    }
    if (r.status === 'migrated') persistProfiles();
    el.storageNote.textContent = note;
    el.storageNote.hidden = !note;
  }

  function persistProfiles() {
    if (!profiles || !profilesPersistent) return;
    if (!Profiles.save(profileStore, profiles)) {
      el.storageNote.textContent = 'Couldn\u2019t save profiles (is storage full?). Export a backup to be safe.';
      el.storageNote.hidden = false;
    }
  }

  function player() {
    return profiles ? Profiles.activePlayer(profiles) : null;
  }

  function playerLook() {
    const p = player();
    return p ? p.look : null;
  }

  function luckySides() {
    const p = player();
    const d = p && Profiles.luckyDie(p);
    return d ? d.sides : null;
  }

  function recordProfileRoll(result) {
    const p = player();
    if (!p) return [];
    const credited = Profiles.recordRoll(p, result);
    if (credited.length) {
      persistProfiles();
      renderBag();
    }
    return credited;
  }

  /** "#rrggbb" mixed toward black (t>0) or white (t<0). */
  function shade(hex, t) {
    const n = parseInt(hex.slice(1), 16);
    const target = t < 0 ? 255 : 0;
    const k = Math.abs(t);
    const ch = (v) => Math.round(v + (target - v) * k).toString(16).padStart(2, '0');
    return '#' + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
  }

  /** Swatch CSS (custom properties) for a look; values are sanitised hex colours. */
  function swatchStyle(look) {
    if (!look || !look.body) return '';
    return '--sw-a:' + shade(look.body, -0.1) + ';--sw-b:' + shade(look.body, 0.45) + ';--sw-ink:' + look.ink;
  }

  /** Recolour the CSS dice (rack, previews, fallback tray) to the active player's look. */
  function applyLook() {
    const look = playerLook();
    const root = document.documentElement;
    if (look && look.body) {
      root.dataset.look = 'custom';
      root.style.setProperty('--look-a', shade(look.body, -0.1));
      root.style.setProperty('--look-b', shade(look.body, 0.5));
      root.style.setProperty('--look-ink', look.ink);
      root.style.setProperty('--look-ink-shadow', luminance(look.ink) < 0.45 ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.55)');
    } else {
      delete root.dataset.look;
    }
    root.dataset.finish = look ? look.finish : 'glossy';
  }

  function luminance(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  }

  function dieLabel(die) {
    return die.name + ' (d' + die.sides + ')';
  }

  function statLine(die) {
    const st = Profiles.dieStats(die);
    if (!st.rolls) return 'No rolls yet';
    const max = die.sides === 20 ? 'nat 20' : 'max';
    const min = die.sides === 20 ? 'nat 1' : '1s';
    return st.rolls + (st.rolls === 1 ? ' roll' : ' rolls') + ' · avg ' + st.average.toFixed(1) + ' (fair ' + st.expected + ')' +
      ' · ' + max + ' ×' + st.natMax + ' · ' + min + ' ×' + st.natMin;
  }

  function renderPlayers() {
    const p = player();
    el.playerList.innerHTML = profiles.players.map((x, i) => {
      const id = 'player-opt-' + i;
      return '<input type="radio" name="player" id="' + id + '" value="' + escapeHtml(x.id) + '"' + (x.id === p.id ? ' checked' : '') + '>' +
        '<label for="' + id + '" class="player-opt"><span class="swatch' + (x.look.body ? '' : ' swatch-classic') + '" style="' + swatchStyle(x.look) + '" aria-hidden="true"></span>' +
        '<span class="player-opt-name">' + escapeHtml(x.name) + '</span></label>';
    }).join('');
    el.addPlayer.disabled = profiles.players.length >= Profiles.MAX_PLAYERS;
    el.deletePlayer.disabled = profiles.players.length <= 1;
    // Header chip: quick "next player" button, handy on phones where the panel is far below.
    el.playerChip.hidden = false;
    el.playerChip.querySelector('.player-chip-name').textContent = p.name;
    const sw = el.playerChip.querySelector('.swatch');
    sw.className = 'swatch' + (p.look.body ? '' : ' swatch-classic');
    sw.setAttribute('style', swatchStyle(p.look));
    const multi = profiles.players.length > 1;
    el.playerChip.setAttribute('aria-label', 'Rolling as ' + p.name + (multi ? '. Switch to the next player' : '. Manage players'));
    el.playerChip.title = multi ? 'Next player (P)' : 'Players';
  }

  function renderEditor() {
    const p = player();
    el.editorName.textContent = p.name + '\u2019s';
    if (document.activeElement !== el.playerName) el.playerName.value = p.name;
    el.playerTheme.value = p.look.theme;
    el.playerBody.value = p.look.body || '#f06a5f';
    el.playerInk.value = p.look.ink || '#ffffff';
    el.playerFinish.value = p.look.finish;
    el.lookPreview.innerHTML = '';
    [20, 6, 12].forEach((s) => el.lookPreview.appendChild(createDie(s, s === 6 ? 5 : s, 'die-icon')));
  }

  function renderBag(focusSelector) {
    const p = player();
    if (!p) return;
    el.bagOwner.textContent = p.name;
    el.bagList.innerHTML = Profiles.TRACKED.map((s) => {
      const die = p.dice[s];
      const st = Profiles.dieStats(die);
      const label = escapeHtml(dieLabel(die));
      return '<li class="bag-item' + (die.lucky ? ' is-lucky' : '') + '" data-sides="' + s + '">' +
        '<span class="bag-icon" aria-hidden="true"></span>' +
        '<div class="bag-main">' +
          '<span class="bag-name"><span class="bag-type">d' + s + '</span> ' + escapeHtml(die.name) +
          (die.lucky ? ' <span class="lucky-badge">★ Lucky</span>' : '') + '</span>' +
          '<span class="bag-stats">' + escapeHtml(statLine(die)) + '</span>' +
          '<span class="verdict verdict-' + st.verdict.key + '" title="' + escapeHtml(st.verdict.note) + '">' + escapeHtml(st.verdict.label) +
          '<span class="visually-hidden">: ' + escapeHtml(st.verdict.note) + '</span></span>' +
        '</div>' +
        '<div class="bag-actions">' +
          '<button type="button" class="icon-btn lucky-btn" data-lucky="' + s + '" aria-pressed="' + die.lucky + '"' +
          ' aria-label="' + (die.lucky ? 'Unmark ' + label + ' as your lucky die' : 'Mark ' + label + ' as your lucky die') + '"' +
          ' title="' + (die.lucky ? 'Your lucky die' : 'Mark as lucky') + '"><span aria-hidden="true">★</span></button>' +
          '<button type="button" class="icon-btn burn-btn" data-burn="' + s + '" aria-label="Burn ' + label + '" title="Burn it">' +
          '<svg class="icon-flame" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.2 2c.9 3.4-1.6 5-1.6 7.6 0 1.2.8 2.1 1.9 2.1 1.4 0 2.1-1.3 1.7-3.1 2.7 1.8 4.1 4.4 4.1 7.1A6.3 6.3 0 0 1 12 22a6.2 6.2 0 0 1-6.3-6.2c0-2.7 1.4-4.8 3.1-6.3.4-2.9 1.9-5.4 3.4-7.5z"/></svg></button>' +
        '</div></li>';
    }).join('');
    el.bagList.querySelectorAll('.bag-item').forEach((li) => {
      const s = Number(li.dataset.sides);
      li.querySelector('.bag-icon').appendChild(createDie(s, rackFace(s), 'die-icon'));
    });
    if (focusSelector) {
      const f = el.bagList.querySelector(focusSelector);
      if (f) f.focus();
    }
  }

  function renderShame(focusSelector) {
    const p = player();
    if (!p) return;
    const list = p.graveyard;
    el.shameEmpty.hidden = list.length > 0;
    el.shameCount.textContent = list.length ? list.length + (list.length === 1 ? ' soul' : ' souls') : '';
    el.shameList.innerHTML = list.map((g) => {
      const died = new Date(g.died);
      const when = isNaN(died) ? '' : died.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      const label = escapeHtml(dieLabel(g));
      return '<li class="tomb tomb-' + g.cause + '">' +
        '<div class="tomb-head"><span class="tomb-name">' + escapeHtml(g.name) + '</span> <span class="bag-type">d' + g.sides + '</span>' +
        (g.lucky ? ' <span class="lucky-badge is-ex">ex-lucky</span>' : '') + '</div>' +
        '<p class="tomb-epitaph">\u201c' + escapeHtml(g.epitaph) + '\u201d</p>' +
        '<p class="tomb-meta">' + (g.cause === 'retired' ? 'Retired' : 'Burned') + (when ? ' ' + escapeHtml(when) : '') + ' · ' + escapeHtml(statLine(g)) + '</p>' +
        '<div class="tomb-actions">' +
          '<button type="button" class="btn btn-ghost btn-small" data-pardon="' + escapeHtml(g.id) + '" aria-label="Pardon ' + label + ' and put it back in the bag">Pardon</button>' +
          '<button type="button" class="btn btn-ghost btn-small btn-danger" data-scatter="' + escapeHtml(g.id) + '" aria-label="Scatter the ashes of ' + label + ' (delete for good)">Scatter ashes</button>' +
        '</div></li>';
    }).join('');
    if (focusSelector) {
      const f = el.shameList.querySelector(focusSelector) || el.shameList.querySelector('button') || el.bagList.querySelector('button');
      if (f) f.focus();
    }
  }

  /** Re-render everything that depends on the active player. */
  function profilesChanged() {
    renderPlayers();
    renderEditor();
    renderBag();
    renderShame();
    applyLook();
    updateRack();
    renderHistory();
    if (state.lastResult && el.resultCard.dataset.state === 'done') {
      const who = profiles.players.length > 1 ? ' · ' + player().name : '';
      el.resultNotation.textContent = state.lastResult.notation + (state.lastResult.mode !== 'normal' ? ' · ' + Core.modeLabel(state.lastResult.mode) : '') + who;
    }
  }

  function bagSay(text) {
    el.bagStatus.textContent = text;
  }

  function switchPlayer(dirOrId) {
    if (!profiles || state.rolling) return;
    if (typeof dirOrId === 'string') Profiles.setActive(profiles, dirOrId);
    else if (profiles.players.length > 1) Profiles.cyclePlayer(profiles, dirOrId);
    persistProfiles();
    profilesChanged();
    el.announcer.textContent = player().name + ' is rolling.';
  }

  function setLuckyDie(sides) {
    const p = player();
    const die = p.dice[sides];
    const on = Profiles.setLucky(p, sides);
    persistProfiles();
    renderBag('[data-lucky="' + sides + '"]');
    updateRack();
    bagSay(on ? '★ ' + dieLabel(die) + ' is now ' + p.name + '\u2019s lucky die. We\u2019ll see about that.' : dieLabel(die) + ' is just a regular die again.');
  }

  function openBurn(sides) {
    const p = player();
    const die = p.dice[sides];
    burnTarget = { playerId: p.id, sides, dieId: die.id };
    el.burnTitle.textContent = 'Burn ' + die.name + '?';
    el.burnSummary.textContent = p.name + '\u2019s d' + sides + ' · ' + statLine(die) + (die.lucky ? ' · currently the lucky die (allegedly)' : '');
    el.burnEpitaph.value = Profiles.autoEpitaph(die);
    if (typeof el.burnDialog.showModal === 'function') {
      el.burnDialog.returnValue = '';
      el.burnDialog.showModal();
      el.burnEpitaph.focus();
      el.burnEpitaph.select();
    } else if (window.confirm('Burn ' + dieLabel(die) + '? It goes to the Hall of Shame and a fresh die takes its place.')) {
      confirmBurn(el.burnEpitaph.value);
    }
  }

  async function confirmBurn(epitaph) {
    const target = burnTarget;
    burnTarget = null;
    if (!target || state.rolling) return;
    const p = profiles.players.find((x) => x.id === target.playerId);
    if (!p || p.dice[target.sides].id !== target.dieId) return;
    const wasLucky = p.dice[target.sides].lucky;
    const { burned, replacement } = Profiles.burnDie(p, target.sides, { epitaph });
    persistProfiles();
    renderBag();
    renderShame();
    updateRack();
    bagSay(burned.name + ' is on fire\u2026');
    state.rolling = true;
    updateRollButton();
    try {
      await animateBurn(target.sides, wasLucky);
    } finally {
      state.rolling = false;
      updateRollButton();
    }
    const msg = burned.name + ' has been reduced to ash. ' + replacement.name + ', a fresh d' + target.sides + ', joins ' + p.name + '\u2019s bag.';
    bagSay(msg);
    el.announcer.textContent = msg;
    const btn = el.bagList.querySelector('[data-burn="' + target.sides + '"]');
    if (btn) btn.focus({ preventScroll: true }); // keep the fresh die in view
  }

  function pardon(dieId) {
    const p = player();
    let r;
    try {
      r = Profiles.resurrectDie(p, dieId);
    } catch (e) {
      bagSay(e.message);
      return;
    }
    persistProfiles();
    renderBag();
    renderShame('[data-pardon]');
    updateRack();
    bagSay(r.restored.name + ' has been pardoned and is back in the bag' +
      (r.displaced ? '; ' + r.displaced.name + ' retires to the Hall.' : '.'));
  }

  function scatter(dieId) {
    const p = player();
    const g = p.graveyard.find((x) => x.id === dieId);
    if (!g || !window.confirm('Scatter the ashes of ' + dieLabel(g) + '? Its record is deleted for good.')) return;
    Profiles.scatterAshes(p, dieId);
    persistProfiles();
    renderShame('[data-scatter]');
    bagSay(g.name + '\u2019s ashes drift away on the wind.');
  }

  function animateBurn(sides, lucky) {
    const reduced = reducedMotion.matches;
    el.trayPreview.innerHTML = '';
    el.trayDice.innerHTML = '';
    el.trayMore.hidden = true;
    el.tray.dataset.state = 'result';
    state.lastNotation = null; // the tray no longer shows the last roll
    markStale();
    const rect = el.box.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      el.box.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    }
    const t3d = tray3d();
    if (t3d && t3d.burn) {
      return t3d.burn({ sides, look: playerLook(), reduced, lucky }).catch(() => animateBurnCss(sides, reduced));
    }
    return animateBurnCss(sides, reduced);
  }

  function animateBurnCss(sides, reduced) {
    clear3d();
    el.trayDice.innerHTML = '';
    const stage = document.createElement('div');
    stage.className = 'burn-stage' + (reduced ? ' is-done' : '');
    const size = Math.round(Math.max(56, Math.min(110, el.tray.getBoundingClientRect().height * 0.32)));
    stage.style.setProperty('--size', size + 'px');
    const pyre = document.createElement('span');
    pyre.className = 'burn-pyre';
    pyre.innerHTML = '<span class="scorch"></span><span class="flames"><i></i><i></i><i></i><i></i><i></i></span>';
    if (!reduced) pyre.insertBefore(createDie(sides, 1, 'burn-doomed'), pyre.lastChild);
    const fresh = createDie(sides, sides, 'burn-fresh');
    stage.appendChild(pyre);
    stage.appendChild(fresh);
    el.trayDice.appendChild(stage);
    if (reduced) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, 3900));
  }

  function exportProfiles() {
    const blob = new Blob([Profiles.exportJSON(profiles)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dice-box-profiles-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    bagSay('Exported ' + profiles.players.length + (profiles.players.length === 1 ? ' player.' : ' players.'));
  }

  function importProfiles(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      bagSay('That file is too big to be a dice box backup.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const r = Profiles.importJSON(profiles, String(reader.result));
        persistProfiles();
        profilesChanged();
        bagSay('Imported: ' + r.added + ' new, ' + r.replaced + ' updated' + (r.skipped ? ', ' + r.skipped + ' skipped (table full)' : '') + '.');
      } catch (e) {
        bagSay('Import failed: ' + e.message);
      }
    };
    reader.onerror = () => bagSay('Couldn\u2019t read that file.');
    reader.readAsText(file);
  }

  function initProfilesUI() {
    if (!Profiles || !profiles) return;
    el.playersPanel.hidden = false;
    el.bagPanel.hidden = false;
    el.shamePanel.hidden = false;
    el.playerTheme.innerHTML = Object.keys(Profiles.THEMES).map((k) =>
      '<option value="' + k + '">' + escapeHtml(Profiles.THEMES[k].label) + '</option>').join('') +
      '<option value="custom">Custom colours</option>';
    el.playerFinish.innerHTML = Object.keys(Profiles.FINISHES).map((k) =>
      '<option value="' + k + '">' + escapeHtml(Profiles.FINISHES[k]) + '</option>').join('');
    profilesChanged();

    el.playerChip.addEventListener('click', () => {
      if (profiles.players.length > 1) {
        switchPlayer(1);
      } else {
        el.playersPanel.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
        el.addPlayer.focus({ preventScroll: true });
      }
    });
    el.playerList.addEventListener('change', (e) => {
      if (e.target.name === 'player') {
        switchPlayer(e.target.value);
        const r = el.playerList.querySelector('input[value="' + CSS.escape(e.target.value) + '"]');
        if (r) r.focus();
      }
    });
    el.addPlayer.addEventListener('click', () => {
      try {
        const p = Profiles.addPlayer(profiles, '');
        persistProfiles();
        profilesChanged();
        el.playerEditor.open = true;
        el.playerName.focus();
        el.playerName.select();
        el.announcer.textContent = p.name + ' joined the table with a fresh bag of dice.';
      } catch (e) {
        bagSay(e.message);
      }
    });
    el.playerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      el.playerName.blur();
    });
    el.playerName.addEventListener('change', () => {
      Profiles.renamePlayer(player(), el.playerName.value);
      persistProfiles();
      profilesChanged();
    });
    el.playerTheme.addEventListener('change', () => {
      const v = el.playerTheme.value;
      if (v === 'custom') Profiles.updateLook(player(), { body: el.playerBody.value, ink: el.playerInk.value });
      else Profiles.updateLook(player(), { theme: v });
      persistProfiles();
      profilesChanged();
    });
    const colourChanged = () => {
      Profiles.updateLook(player(), { body: el.playerBody.value, ink: el.playerInk.value });
      persistProfiles();
      profilesChanged();
    };
    el.playerBody.addEventListener('input', colourChanged);
    el.playerInk.addEventListener('input', colourChanged);
    el.playerFinish.addEventListener('change', () => {
      Profiles.updateLook(player(), { finish: el.playerFinish.value });
      persistProfiles();
      profilesChanged();
    });
    el.deletePlayer.addEventListener('click', () => {
      const p = player();
      if (profiles.players.length <= 1) return;
      if (!window.confirm('Remove ' + p.name + ' and all of their dice stats? This can\u2019t be undone (unless you exported a backup).')) return;
      Profiles.removePlayer(profiles, p.id);
      persistProfiles();
      profilesChanged();
      el.announcer.textContent = p.name + ' left the table.';
      el.deletePlayer.focus();
    });
    el.exportProfiles.addEventListener('click', exportProfiles);
    el.importProfiles.addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', () => {
      importProfiles(el.importFile.files && el.importFile.files[0]);
      el.importFile.value = '';
    });

    el.bagList.addEventListener('click', (e) => {
      const lucky = e.target.closest('[data-lucky]');
      if (lucky) { setLuckyDie(Number(lucky.dataset.lucky)); return; }
      const burnBtn = e.target.closest('[data-burn]');
      if (burnBtn && !state.rolling) openBurn(Number(burnBtn.dataset.burn));
    });
    el.shameList.addEventListener('click', (e) => {
      const pb = e.target.closest('[data-pardon]');
      if (pb) { pardon(pb.dataset.pardon); return; }
      const sb = e.target.closest('[data-scatter]');
      if (sb) scatter(sb.dataset.scatter);
    });
    el.burnDialog.addEventListener('close', () => {
      if (el.burnDialog.returnValue === 'burn') {
        confirmBurn(el.burnEpitaph.value);
      } else {
        const t = burnTarget;
        burnTarget = null;
        if (t) {
          bagSay('Spared. For now.');
          const btn = el.bagList.querySelector('[data-burn="' + t.sides + '"]');
          if (btn) btn.focus();
        }
      }
    });
    window.addEventListener('storage', (e) => {
      // Another tab changed the profiles: pick up the new data.
      if (e.key !== Profiles.STORAGE_KEY || state.rolling) return;
      const r = Profiles.parse(e.newValue);
      if (r.status === 'ok' || r.status === 'migrated') {
        profiles = r.data;
        profilesChanged();
      }
    });
  }

  // ------------------------------------------------------------------- help
  function toggleHelp(force) {
    const open = typeof force === 'boolean' ? force : el.helpPanel.hidden;
    el.helpPanel.hidden = !open;
    el.helpToggle.setAttribute('aria-expanded', String(open));
  }

  // ----------------------------------------------------------------- events
  function bindEvents() {
    el.rack.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const sides = Number(btn.closest('.rack-item').dataset.sides);
      changeDie(sides, btn.dataset.action === 'add' ? 1 : -1);
    });
    el.rack.addEventListener('contextmenu', (e) => {
      // Right-click a die to remove one.
      const btn = e.target.closest('.rack-die');
      if (!btn) return;
      e.preventDefault();
      changeDie(Number(btn.closest('.rack-item').dataset.sides), -1);
    });

    el.modUp.addEventListener('click', () => changeModifier(1));
    el.modDown.addEventListener('click', () => changeModifier(-1));
    el.modInput.addEventListener('change', () => setModifier(el.modInput.value));
    el.modInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setModifier(el.modInput.value);
        roll();
      }
    });

    el.modeGroup.addEventListener('change', (e) => {
      if (e.target.name === 'mode') setMode(e.target.value);
    });

    el.rollBtn.addEventListener('click', () => roll());
    el.clearBtn.addEventListener('click', clearSelection);

    el.formula.addEventListener('input', () => {
      const text = el.formula.value.trim();
      if (!text) {
        el.formula.removeAttribute('aria-invalid');
        showHint('Type a formula like 2d6+3, or leave empty to clear.');
        return;
      }
      try {
        const p = Core.parseNotation(text);
        el.formula.removeAttribute('aria-invalid');
        if (!p.terms.length) {
          showHint('Add at least one die, e.g. d20' + Core.formatSigned(p.modifier) + '.');
        } else {
          const r = Core.expressionRange(p);
          showHint('Range ' + r.min + '–' + r.max + ' · press Enter to roll', 'ok');
        }
      } catch (err) {
        el.formula.setAttribute('aria-invalid', 'true');
        showHint(err.message, 'error');
      }
    });
    el.formula.addEventListener('change', () => commitFormula(false));
    el.formula.addEventListener('blur', () => {
      if (el.formula.getAttribute('aria-invalid') !== 'true') el.formula.value = currentNotation();
    });
    el.formulaForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (commitFormula(true)) roll();
    });

    el.presetList.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        state.presets.splice(Number(rm.dataset.remove), 1);
        save(STORAGE_KEYS.presets, state.presets);
        renderPresets();
        el.savePreset.focus();
        return;
      }
      const btn = e.target.closest('[data-notation]');
      if (btn) roll({ notation: btn.dataset.notation });
    });
    el.savePreset.addEventListener('click', saveCurrentPreset);

    el.historyList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      const h = state.history.find((x) => x.id === btn.dataset.id);
      if (h) roll({ notation: h.notation, mode: h.mode !== 'normal' ? h.mode : undefined });
    });
    el.clearHistory.addEventListener('click', () => {
      if (!state.history.length) return;
      state.history = [];
      save(STORAGE_KEYS.history, state.history);
      renderHistory();
      el.announcer.textContent = 'History cleared.';
    });

    el.helpToggle.addEventListener('click', () => toggleHelp());

    document.addEventListener('keydown', onKeyDown);

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (el.tray.dataset.state === 'preview') sizePreview(el.trayPreview.children.length);
      }, 150);
    });
  }

  function commitFormula(fromSubmit) {
    const text = el.formula.value;
    try {
      const parsed = setExpression(text);
      el.formula.removeAttribute('aria-invalid');
      selectionChanged();
      el.formula.value = currentNotation();
      if (fromSubmit && (!parsed || !parsed.terms.length)) {
        showHint('Add at least one die to roll.', 'error');
        return false;
      }
      return true;
    } catch (err) {
      el.formula.setAttribute('aria-invalid', 'true');
      showHint(err.message + ' (still using ' + (currentNotation() || 'no dice') + ')', 'error');
      return false;
    }
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (el.burnDialog && el.burnDialog.open) return; // the dialog handles its own keys
    const t = e.target;
    const tag = t && t.tagName;
    const isTextField = (tag === 'INPUT' && !['radio', 'checkbox', 'button', 'submit'].includes(t.type)) ||
      tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    if (isTextField) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const interactive = tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'INPUT';
    if ((e.key === 'p' || e.key === 'P') && profiles) {
      e.preventDefault();
      switchPlayer(e.shiftKey ? -1 : 1);
      return;
    }

    const digit = /^(?:Digit|Numpad)([1-7])$/.exec(e.code || '');
    if (digit) {
      e.preventDefault();
      changeDie(DICE[Number(digit[1]) - 1], e.shiftKey ? -1 : 1);
      return;
    }

    switch (e.key) {
      case ' ':
      case 'Enter':
        if (interactive) return; // let the focused control handle it
        roll();
        break;
      case 'r':
      case 'R':
        roll();
        break;
      case '+':
      case '=':
        changeModifier(1);
        break;
      case '-':
      case '_':
        changeModifier(-1);
        break;
      case 'a':
      case 'A':
        setMode('adv');
        break;
      case 'd':
      case 'D':
        setMode('dis');
        break;
      case 'n':
      case 'N':
        setMode('normal');
        break;
      case 'f':
      case 'F':
        el.formula.focus();
        el.formula.select();
        break;
      case 'Escape':
        if (!el.helpPanel.hidden) {
          toggleHelp(false);
          el.helpToggle.focus();
          break;
        }
        clearSelection();
        break;
      case 'c':
      case 'C':
        clearSelection();
        break;
      case '?':
        toggleHelp();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ------------------------------------------------------------------- init
  function init() {
    restore();
    loadProfiles();
    buildRack();
    setMode(state.mode);
    renderPresets();
    renderHistory();
    selectionChanged();
    el.formula.value = currentNotation();
    bindEvents();
    initProfilesUI();
    document.documentElement.classList.add('js-ready');
  }

  init();
})();
