/* Dungeon Dice Box – UI. Dice math lives in dice-core.js (window.DiceCore). */
(() => {
  'use strict';

  const Core = window.DiceCore;
  if (!Core) {
    document.body.insertAdjacentHTML('afterbegin', '<p class="noscript">dice-core.js failed to load.</p>');
    return;
  }

  const { DICE } = Core;
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
    el.rack.querySelectorAll('.rack-item').forEach((li) => {
      const sides = Number(li.dataset.sides);
      const n = state.pool[sides];
      li.classList.toggle('is-selected', n > 0);
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
    result.groups.forEach((g) => g.dice.forEach((d) => list.push(Object.assign({ sign: g.sign }, d))));
    return list;
  }

  function finalizeDie(die, d) {
    setFace(die, d.sides, d.value);
    die.classList.toggle('is-dropped', !d.kept);
    die.classList.toggle('is-crit', !!d.crit);
    die.classList.toggle('is-fumble', !!d.fumble);
    die.classList.toggle('is-max', d.kept && d.value === d.sides && !d.crit);
  }

  function animateRoll(result) {
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
    showResult(result);
    addHistory(result);
    updateRollButton();
  }

  function showResult(result) {
    el.resultCard.dataset.state = 'done';
    el.resultCard.classList.remove('is-stale', 'is-crit', 'is-fumble');
    el.resultLabel.textContent = 'Result';
    const modeText = result.mode !== 'normal' ? ' · ' + Core.modeLabel(result.mode) : '';
    el.resultNotation.textContent = result.notation + modeText;
    el.total.textContent = result.total;
    el.total.classList.remove('pop');
    if (!reducedMotion.matches) {
      void el.total.offsetWidth;
      el.total.classList.add('pop');
    }

    const msgs = [];
    if (result.crits) msgs.push('<span class="banner-crit">' + (result.crits > 1 ? result.crits + ' × ' : '') + 'Natural 20!</span>');
    if (result.fumbles) msgs.push('<span class="banner-fumble">' + (result.fumbles > 1 ? result.fumbles + ' × ' : '') + 'Natural 1</span>');
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
      return '<li class="' + cls + '">' +
        '<button type="button" class="history-btn" data-id="' + escapeHtml(h.id) + '"' +
        ' aria-label="Roll ' + escapeHtml(h.notation) + (h.mode !== 'normal' ? ' with ' + Core.modeLabel(h.mode) : '') + ' again (previous total ' + h.total + ')">' +
          '<span class="h-total">' + h.total + '</span>' +
          '<span class="h-main">' +
            '<span class="h-notation">' + escapeHtml(h.notation) + ' ' + mode + '</span>' +
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
    const t = e.target;
    const tag = t && t.tagName;
    const isTextField = (tag === 'INPUT' && !['radio', 'checkbox', 'button', 'submit'].includes(t.type)) ||
      tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    if (isTextField) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const interactive = tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'INPUT';

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
    buildRack();
    setMode(state.mode);
    renderPresets();
    renderHistory();
    selectionChanged();
    el.formula.value = currentNotation();
    bindEvents();
    document.documentElement.classList.add('js-ready');
  }

  init();
})();
