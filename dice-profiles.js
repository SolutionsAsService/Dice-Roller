/*
 * Dungeon Dice Box – player profiles, lucky dice and the Hall of Shame (no DOM).
 *
 * Everything here is bookkeeping and cosmetics. Nothing in this file rolls a
 * die or touches DiceCore's random source: stats are recorded *after* a roll
 * has been decided, so profiles, looks, lucky marks and burnings can never
 * change what you roll.
 *
 * Works as a classic browser script (window.DiceProfiles) and as a CommonJS
 * module for Node tests.
 *
 * Storage schema (localStorage key "diceBox.profiles"), version 1:
 * {
 *   version: 1,
 *   activeId: "<player id>",
 *   players: [{
 *     id, name, created,
 *     look: { theme, body, ink, finish },      // body/ink "#rrggbb" or null (classic colours)
 *     dice: { "4": Die, "6": Die, ..., "100": Die },   // the die currently in the bag
 *     graveyard: [Die & { died, epitaph, cause: "burned" | "retired" }]   // newest first
 *   }]
 * }
 * Die: { id, sides, name, born, lucky, faces: [count of 1s, count of 2s, ...], recent: [last values] }
 * Roll count, sum and average are derived from "faces", so they can't disagree.
 *
 * Version 0 (unversioned) data – a bare array of players or an object without
 * "version", players shaped like { name, color, ink } – is migrated on load.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.DiceProfiles = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'diceBox.profiles';
  const BACKUP_KEY = 'diceBox.profiles.backup';
  const TRACKED = Object.freeze([4, 6, 8, 10, 12, 20, 100]);
  const MAX_PLAYERS = 12;
  const MAX_NAME = 24;
  const MAX_EPITAPH = 140;
  const MAX_GRAVEYARD = 40;
  const MAX_RECENT = 20;
  const MIN_SAMPLE = 20; // rolls before we pass judgement on a die's luck

  const FINISHES = Object.freeze({
    glossy: 'Glossy',
    matte: 'Matte',
    metal: 'Metallic',
    pearl: 'Pearlescent',
    gem: 'Gemstone',
  });

  /** Preset looks. body/ink null = the classic per-die rainbow. */
  const THEMES = Object.freeze({
    classic: Object.freeze({ label: 'Classic rainbow', body: null, ink: null, finish: 'glossy' }),
    hoard: Object.freeze({ label: 'Dragon\u2019s hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'metal' }),
    lich: Object.freeze({ label: 'Lich-light', body: '#1f1b2b', ink: '#8cf5b0', finish: 'matte' }),
    bard: Object.freeze({ label: 'Bubblegum bard', body: '#ff7eb9', ink: '#ffffff', finish: 'pearl' }),
    frost: Object.freeze({ label: 'Frost wizard', body: '#8fd3ff', ink: '#0b3557', finish: 'gem' }),
    goblin: Object.freeze({ label: 'Goblin budget', body: '#7d8f3c', ink: '#f4e8a6', finish: 'matte' }),
    vampire: Object.freeze({ label: 'Vampire velvet', body: '#6e0f1f', ink: '#f0d48a', finish: 'glossy' }),
  });

  const FIRST_NAMES = ['Grimbold', 'Pip', 'Bartholomew', 'Mildred', 'Sir Clatters', 'Old Gus', 'Lady Fortuna',
    'Dorian', 'Bramble', 'Nibbles', 'Agatha', 'Thaddeus', 'Wobbles', 'Gertrude', 'Kevin', 'Morwen', 'Biscuit',
    'Ignatius', 'Tumble', 'Esmeralda', 'Rollo', 'Clementine', 'Barnaby', 'Hex'];
  const EPITHETS = ['the Fickle', 'the Unblinking', 'the Mostly Fair', 'the Wobbly', 'the Bold', 'the Bashful',
    'the Sticky', 'the Hopeful', 'the Chipped', 'the Overconfident', 'the Tiny', 'the Reliable(ish)',
    'the Dramatic', 'the Squeaky-Clean', 'the Second Chance', 'the Unproven', 'the Polished', 'the Smug'];
  const GENERIC_EPITAPHS = [
    'Looked at its owner funny.',
    'Insufficiently heroic.',
    'Sacrificed to appease the dice gods.',
    'Gone, but not forgiven.',
    'Rolled with the punches. Then rolled a 2.',
    'Its numbers were technically all there.',
    'Died as it lived: rolling low.',
  ];

  class ProfileError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ProfileError';
    }
  }

  // ---------------------------------------------------------------- helpers
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const pick = (list, rng) => list[Math.min(list.length - 1, Math.floor((rng || Math.random)() * list.length))];
  const nowOf = (opts) => (opts && Number.isFinite(opts.now) ? opts.now : Date.now());
  const rngOf = (opts) => (opts && typeof opts.rng === 'function' ? opts.rng : Math.random);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

  /** Cosmetic id (Math.random is fine – ids never influence a roll). */
  function makeId(prefix, opts) {
    const rng = rngOf(opts);
    let s = '';
    for (let i = 0; i < 8; i++) s += Math.floor(rng() * 36).toString(36);
    return prefix + '_' + nowOf(opts).toString(36) + s;
  }

  function sanitizeName(name, fallback) {
    const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim() : '';
    return (s || fallback || 'Adventurer').slice(0, MAX_NAME);
  }

  function sanitizeText(text, max) {
    return typeof text === 'string' ? text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  /** "#abc" / "#AABBCC" -> "#aabbcc"; anything else -> null. */
  function sanitizeColor(c) {
    if (typeof c !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return null;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
    return '#' + hex;
  }

  function finiteTime(t, fallback) {
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : fallback;
  }

  // -------------------------------------------------------------------- dice
  function dieName(opts) {
    const rng = rngOf(opts);
    return pick(FIRST_NAMES, rng) + ' ' + pick(EPITHETS, rng);
  }

  function newDie(sides, opts) {
    if (!TRACKED.includes(sides)) throw new ProfileError('Untracked die: d' + sides);
    return {
      id: makeId('die', opts),
      sides,
      name: (opts && opts.name) ? sanitizeName(opts.name) : dieName(opts),
      born: nowOf(opts),
      lucky: false,
      faces: new Array(sides).fill(0),
      recent: [],
    };
  }

  /** Repair a stored die. withDeath: keep/require the Hall of Shame fields. */
  function normalizeDie(raw, sides, opts, withDeath) {
    if (!isObj(raw)) return null;
    const s = Number(raw.sides) || sides;
    if (!TRACKED.includes(s) || (sides && s !== sides)) return null;
    const faces = new Array(s).fill(0);
    if (Array.isArray(raw.faces)) {
      for (let i = 0; i < s; i++) {
        const n = Math.floor(Number(raw.faces[i]));
        faces[i] = Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
      }
    }
    const recent = Array.isArray(raw.recent)
      ? raw.recent.map(Number).filter((v) => Number.isInteger(v) && v >= 1 && v <= s).slice(-MAX_RECENT)
      : [];
    const die = {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : makeId('die', opts),
      sides: s,
      name: sanitizeName(raw.name, dieName(opts)),
      born: finiteTime(raw.born, nowOf(opts)),
      lucky: raw.lucky === true,
      faces,
      recent,
    };
    if (withDeath) {
      die.died = finiteTime(raw.died, nowOf(opts));
      die.epitaph = sanitizeText(raw.epitaph, MAX_EPITAPH) || 'No last words.';
      die.cause = raw.cause === 'retired' ? 'retired' : 'burned';
    }
    return die;
  }

  /** Derived numbers for a die: rolls, average, expected, nat max/min, luck verdict. */
  function dieStats(die) {
    const sides = die.sides;
    let rolls = 0;
    let sum = 0;
    die.faces.forEach((n, i) => { rolls += n; sum += n * (i + 1); });
    const expected = (sides + 1) / 2;
    const average = rolls ? sum / rolls : null;
    // z-score of the observed mean against a fair die's mean.
    const sd = Math.sqrt((sides * sides - 1) / 12);
    const z = rolls ? (average - expected) / (sd / Math.sqrt(rolls)) : 0;
    return {
      rolls,
      sum,
      average,
      expected,
      natMax: die.faces[sides - 1] || 0,
      natMin: die.faces[0] || 0,
      z,
      verdict: verdictFor(rolls, z),
    };
  }

  function verdictFor(rolls, z) {
    if (rolls === 0) return { key: 'new', label: 'Untested', note: 'Never rolled. Full of potential.' };
    if (rolls < MIN_SAMPLE) {
      const left = MIN_SAMPLE - rolls;
      return { key: 'early', label: 'Too early to tell', note: 'Needs ' + left + ' more roll' + (left === 1 ? '' : 's') + ' before judgement.' };
    }
    if (z >= 2) return { key: 'blessed', label: 'Suspiciously lucky', note: 'Statistically blessed. Keep it away from the DM.' };
    if (z >= 1) return { key: 'warm', label: 'Running hot', note: 'Above average, within the realm of plausible.' };
    if (z > -1) return { key: 'fair', label: 'Honest die', note: 'Boringly fair. As it should be.' };
    if (z > -2) return { key: 'cold', label: 'Running cold', note: 'Below average. Keep an eye on it.' };
    return { key: 'cursed', label: 'Cursed', note: 'Statistically awful. The fire is calling.' };
  }

  // ----------------------------------------------------------------- players
  function defaultLook() {
    return { theme: 'classic', body: null, ink: null, finish: 'glossy' };
  }

  function normalizeLook(raw) {
    const look = defaultLook();
    if (!isObj(raw)) return look;
    const theme = typeof raw.theme === 'string' && (THEMES[raw.theme] || raw.theme === 'custom') ? raw.theme : null;
    const body = sanitizeColor(raw.body);
    const ink = sanitizeColor(raw.ink);
    if (theme && theme !== 'custom') {
      const t = THEMES[theme];
      look.theme = theme;
      look.body = t.body;
      look.ink = t.ink;
      look.finish = t.finish;
    }
    const themed = theme && theme !== 'custom';
    if (theme === 'custom' || (!themed && (body || ink))) {
      look.theme = 'custom';
      look.body = body || '#7a1f2b';
      look.ink = ink || '#ffffff';
    }
    if (FINISHES[raw.finish]) look.finish = raw.finish;
    return look;
  }

  function freshBag(opts) {
    const dice = {};
    TRACKED.forEach((s) => { dice[s] = newDie(s, opts); });
    return dice;
  }

  function newPlayer(name, opts) {
    return {
      id: makeId('p', opts),
      name: sanitizeName(name),
      created: nowOf(opts),
      look: normalizeLook(opts && opts.look),
      dice: freshBag(opts),
      graveyard: [],
    };
  }

  function normalizePlayer(raw, opts) {
    if (!isObj(raw)) return null;
    const player = {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : makeId('p', opts),
      name: sanitizeName(raw.name),
      created: finiteTime(raw.created, nowOf(opts)),
      look: normalizeLook(raw.look),
      dice: {},
      graveyard: [],
    };
    const dice = isObj(raw.dice) ? raw.dice : {};
    let luckyTaken = false;
    TRACKED.forEach((s) => {
      const d = normalizeDie(dice[s], s, opts, false) || newDie(s, opts);
      if (d.lucky && luckyTaken) d.lucky = false; // only one lucky die per player
      if (d.lucky) luckyTaken = true;
      player.dice[s] = d;
    });
    if (Array.isArray(raw.graveyard)) {
      player.graveyard = raw.graveyard
        .map((g) => normalizeDie(g, null, opts, true))
        .filter(Boolean)
        .slice(0, MAX_GRAVEYARD);
    }
    return player;
  }

  function defaultData(opts) {
    const p = newPlayer('Adventurer', opts);
    return { version: SCHEMA_VERSION, activeId: p.id, players: [p] };
  }

  /** Validate/repair a v1 object. Always returns usable data with at least one player. */
  function normalizeData(raw, opts) {
    const data = { version: SCHEMA_VERSION, activeId: null, players: [] };
    const seen = new Set();
    const list = isObj(raw) && Array.isArray(raw.players) ? raw.players : [];
    for (const rp of list) {
      if (data.players.length >= MAX_PLAYERS) break;
      const p = normalizePlayer(rp, opts);
      if (!p) continue;
      while (seen.has(p.id)) p.id = makeId('p', opts);
      seen.add(p.id);
      data.players.push(p);
    }
    if (!data.players.length) return defaultData(opts);
    const active = isObj(raw) && data.players.find((p) => p.id === raw.activeId);
    data.activeId = active ? active.id : data.players[0].id;
    return data;
  }

  // --------------------------------------------------------------- migration
  /** v0 -> v1: bare arrays / unversioned objects with { name, color, ink } players. */
  function migrateV0(raw) {
    const list = Array.isArray(raw) ? raw : (isObj(raw) && Array.isArray(raw.players) ? raw.players : []);
    const players = list.map((p) => {
      if (typeof p === 'string') return { name: p };
      if (!isObj(p)) return null;
      const body = sanitizeColor(p.color || p.body);
      const ink = sanitizeColor(p.ink || p.inkColor || p.numberColor);
      return Object.assign({}, p, {
        look: isObj(p.look) ? p.look : (body || ink ? { theme: 'custom', body, ink, finish: p.finish } : undefined),
      });
    }).filter(Boolean);
    const active = isObj(raw) ? (raw.activeId || raw.active) : null;
    return { version: 1, activeId: typeof active === 'string' ? active : null, players };
  }

  const MIGRATIONS = { 0: migrateV0 };

  /**
   * Bring any parsed value up to the current schema.
   * Returns { data, from, migrated }. Throws ProfileError for data written by a
   * newer version (so the caller can keep it instead of overwriting it).
   */
  function migrate(raw, opts) {
    let from = 0;
    if (isObj(raw) && raw.version !== undefined) {
      from = Number(raw.version);
      if (!Number.isInteger(from) || from < 0) throw new ProfileError('Unknown profile version.');
    }
    if (from > SCHEMA_VERSION) throw new ProfileError('These profiles were saved by a newer version of the dice box.');
    let cur = raw;
    for (let v = from; v < SCHEMA_VERSION; v++) cur = MIGRATIONS[v](cur, opts);
    return { data: normalizeData(cur, opts), from, migrated: from !== SCHEMA_VERSION };
  }

  /**
   * Parse stored text. status: 'empty' | 'ok' | 'migrated' | 'corrupt' | 'future'.
   * Never throws; corrupt/future input yields fresh default data.
   */
  function parse(text, opts) {
    if (text === null || text === undefined || text === '') return { status: 'empty', data: defaultData(opts) };
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { status: 'corrupt', data: defaultData(opts), error: 'Saved profiles are not valid JSON.' };
    }
    if (!isObj(raw) && !Array.isArray(raw)) {
      return { status: 'corrupt', data: defaultData(opts), error: 'Saved profiles have an unexpected shape.' };
    }
    try {
      const m = migrate(raw, opts);
      return { status: m.migrated ? 'migrated' : 'ok', data: m.data, from: m.from };
    } catch (e) {
      const future = /newer version/.test(e.message);
      return { status: future ? 'future' : 'corrupt', data: defaultData(opts), error: e.message };
    }
  }

  function serialize(data) {
    return JSON.stringify(Object.assign({}, data, { version: SCHEMA_VERSION }));
  }

  // ----------------------------------------------------------------- storage
  /** True if the storage object really accepts writes (private modes, quotas, blocked storage...). */
  function probeStorage(storage) {
    if (!storage) return false;
    try {
      const k = '__diceBox_probe__';
      storage.setItem(k, '1');
      const ok = storage.getItem(k) === '1';
      storage.removeItem(k);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Load profiles from a Storage-like object. Never throws.
   * Unreadable data is copied to BACKUP_KEY before anything is written over
   * it, so a bad deploy or a newer version's data is never silently lost.
   * Returns { data, status, persistent, error? }.
   */
  function load(storage, opts) {
    const persistent = probeStorage(storage);
    let text = null;
    try { text = storage ? storage.getItem(STORAGE_KEY) : null; } catch (e) { text = null; }
    const r = parse(text, opts);
    if (persistent && (r.status === 'corrupt' || r.status === 'future')) {
      try { storage.setItem(BACKUP_KEY, text); } catch (e) { /* best effort */ }
    }
    r.persistent = persistent;
    return r;
  }

  function save(storage, data) {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, serialize(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------ data access
  function activePlayer(data) {
    return data.players.find((p) => p.id === data.activeId) || data.players[0];
  }

  function setActive(data, id) {
    if (!data.players.some((p) => p.id === id)) return false;
    data.activeId = id;
    return true;
  }

  /** Move the active player by +1 / -1 (wraps). Returns the new active player. */
  function cyclePlayer(data, dir) {
    const i = data.players.findIndex((p) => p.id === data.activeId);
    const n = data.players.length;
    const next = data.players[((((i < 0 ? 0 : i) + (dir < 0 ? -1 : 1)) % n) + n) % n];
    data.activeId = next.id;
    return next;
  }

  function addPlayer(data, name, opts) {
    if (data.players.length >= MAX_PLAYERS) throw new ProfileError('The table seats ' + MAX_PLAYERS + ' players at most.');
    const p = newPlayer(sanitizeName(name, 'Player ' + (data.players.length + 1)), opts);
    data.players.push(p);
    data.activeId = p.id;
    return p;
  }

  function removePlayer(data, id) {
    if (data.players.length <= 1) throw new ProfileError('Someone has to stay at the table.');
    const i = data.players.findIndex((p) => p.id === id);
    if (i < 0) return false;
    data.players.splice(i, 1);
    if (data.activeId === id) data.activeId = data.players[Math.min(i, data.players.length - 1)].id;
    return true;
  }

  function renamePlayer(player, name) {
    player.name = sanitizeName(name, player.name);
    return player.name;
  }

  /** Apply a theme id or a partial look ({ body, ink, finish }). Custom colours switch the theme to 'custom'. */
  function updateLook(player, patch) {
    const p = isObj(patch) ? patch : {};
    let next;
    if (typeof p.theme === 'string' && THEMES[p.theme]) {
      next = { theme: p.theme, finish: FINISHES[p.finish] ? p.finish : THEMES[p.theme].finish };
    } else {
      next = Object.assign({}, player.look);
      const body = sanitizeColor(p.body);
      const ink = sanitizeColor(p.ink);
      if (body || ink) {
        next.theme = 'custom';
        next.body = body || next.body || '#7a1f2b';
        next.ink = ink || next.ink || '#ffffff';
      }
      if (FINISHES[p.finish]) next.finish = p.finish;
    }
    player.look = normalizeLook(next);
    return player.look;
  }

  // --------------------------------------------------------- stats tracking
  /**
   * Credit a finished DiceCore roll result to the player's dice. Every
   * physically rolled die counts (dropped advantage/keep dice too); only the
   * standard rack dice are tracked. Never modifies "result".
   * Returns [{ sides, dieId, name, lucky, values }].
   */
  function recordRoll(player, result) {
    const credited = new Map();
    if (!player || !result || !Array.isArray(result.groups)) return [];
    for (const g of result.groups) {
      const die = player.dice[g.sides];
      if (!die || !Array.isArray(g.dice)) continue;
      for (const d of g.dice) {
        const v = d && d.value;
        if (!Number.isInteger(v) || v < 1 || v > die.sides) continue;
        die.faces[v - 1] += 1;
        die.recent.push(v);
        if (!credited.has(g.sides)) credited.set(g.sides, { sides: g.sides, dieId: die.id, name: die.name, lucky: die.lucky, values: [] });
        credited.get(g.sides).values.push(v);
      }
      if (die.recent.length > MAX_RECENT) die.recent.splice(0, die.recent.length - MAX_RECENT);
    }
    return Array.from(credited.values());
  }

  /** Mark one die as the player's lucky die (only one per player). on=false clears it; omitted toggles. */
  function setLucky(player, sides, on) {
    const target = player.dice[sides];
    if (!target) return false;
    const want = on === undefined ? !target.lucky : !!on;
    TRACKED.forEach((s) => { player.dice[s].lucky = false; });
    target.lucky = want;
    return want;
  }

  function luckyDie(player) {
    return TRACKED.map((s) => player.dice[s]).find((d) => d && d.lucky) || null;
  }

  // ----------------------------------------------------------- burn & pardon
  function onesWord(sides, n) {
    return sides === 20 ? (n === 1 ? 'natural 1' : 'natural 1s') : (n === 1 ? 'one' : 'ones');
  }

  /** A cause-of-death line based on the die's sad stats. */
  function autoEpitaph(die, opts) {
    const st = dieStats(die);
    const last = die.recent[die.recent.length - 1];
    if (st.rolls === 0) return 'Burned before it rolled a single number. Pre-emptive justice.';
    if (die.lucky) return 'Was supposed to be the lucky one.';
    if (st.natMin >= 2 && st.natMin / st.rolls >= 2 / die.sides) {
      return 'Rolled ' + st.natMin + ' ' + onesWord(die.sides, st.natMin) + ' in ' + st.rolls + ' rolls. Knew exactly what it was doing.';
    }
    if (st.rolls >= 5 && st.average < st.expected - 0.5) {
      return 'Averaged ' + st.average.toFixed(1) + ' when ' + st.expected.toFixed(1) + ' was expected. The maths was not on its side.';
    }
    if (last === 1) return 'Its final act: another 1.';
    return pick(GENERIC_EPITAPHS, rngOf(opts));
  }

  /**
   * Retire the player's current d<sides> to the Hall of Shame and put a
   * brand-new die (fresh name, zero stats) in its place.
   * opts: { epitaph, now, rng }. Returns { burned, replacement }.
   */
  function burnDie(player, sides, opts) {
    const die = player.dice[sides];
    if (!die) throw new ProfileError('No d' + sides + ' to burn.');
    const epitaph = sanitizeText(opts && opts.epitaph, MAX_EPITAPH) || autoEpitaph(die, opts);
    const burned = Object.assign(clone(die), { died: nowOf(opts), epitaph, cause: 'burned' });
    let replacement = newDie(sides, opts);
    let guard = 0;
    while (replacement.name === die.name && guard++ < 5) replacement = newDie(sides, opts);
    player.dice[sides] = replacement;
    player.graveyard.unshift(burned);
    if (player.graveyard.length > MAX_GRAVEYARD) player.graveyard.length = MAX_GRAVEYARD;
    return { burned, replacement };
  }

  /**
   * Pardon a die from the Hall of Shame: it goes back in the bag with its old
   * stats. The die it replaces is quietly discarded if it was never rolled,
   * otherwise it retires to the Hall (cause "retired") and can be pardoned too.
   * Returns { restored, displaced } (displaced may be null).
   */
  function resurrectDie(player, dieId, opts) {
    const i = player.graveyard.findIndex((g) => g.id === dieId);
    if (i < 0) throw new ProfileError('That die is not in the Hall of Shame.');
    const entry = player.graveyard.splice(i, 1)[0];
    const restored = clone(entry);
    delete restored.died; delete restored.epitaph; delete restored.cause;
    const current = player.dice[restored.sides];
    let displaced = null;
    if (current && dieStats(current).rolls > 0) {
      displaced = Object.assign(clone(current), {
        died: nowOf(opts),
        epitaph: 'Stepped aside when ' + restored.name + ' was pardoned.',
        cause: 'retired',
        lucky: false,
      });
      player.graveyard.unshift(displaced);
      if (player.graveyard.length > MAX_GRAVEYARD) player.graveyard.length = MAX_GRAVEYARD;
    }
    // Keep the lucky title where it is unless the pardoned die is taking its own slot back.
    const other = luckyDie(player);
    if (restored.lucky && other && other.sides !== restored.sides) restored.lucky = false;
    player.dice[restored.sides] = restored;
    return { restored, displaced };
  }

  /** Permanently remove a Hall of Shame entry ("scatter the ashes"). */
  function scatterAshes(player, dieId) {
    const i = player.graveyard.findIndex((g) => g.id === dieId);
    if (i < 0) return false;
    player.graveyard.splice(i, 1);
    return true;
  }

  // ----------------------------------------------------------- export/import
  function exportJSON(data) {
    return JSON.stringify(Object.assign({ app: 'dungeon-dice-box', exported: new Date().toISOString() }, data, { version: SCHEMA_VERSION }), null, 2);
  }

  /**
   * Merge exported JSON into "data": players with the same id are replaced,
   * new ones are added (up to MAX_PLAYERS). Throws ProfileError on bad input.
   * Returns { added, replaced, skipped }.
   */
  function importJSON(data, text, opts) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ProfileError('That file is not valid JSON.');
    }
    const hasPlayers = Array.isArray(raw) || (isObj(raw) && Array.isArray(raw.players) && raw.players.length > 0);
    if (!hasPlayers) throw new ProfileError('That file does not contain dice box profiles.');
    const incoming = migrate(raw, opts).data.players; // throws for newer versions
    let added = 0;
    let replaced = 0;
    let skipped = 0;
    for (const p of incoming) {
      const i = data.players.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        data.players[i] = p;
        replaced++;
      } else if (data.players.length < MAX_PLAYERS) {
        data.players.push(p);
        added++;
      } else {
        skipped++;
      }
    }
    return { added, replaced, skipped };
  }

  return {
    SCHEMA_VERSION,
    STORAGE_KEY,
    BACKUP_KEY,
    TRACKED,
    MAX_PLAYERS,
    MAX_NAME,
    MAX_EPITAPH,
    MAX_GRAVEYARD,
    MIN_SAMPLE,
    FINISHES,
    THEMES,
    ProfileError,
    sanitizeName,
    sanitizeColor,
    newDie,
    newPlayer,
    defaultData,
    defaultLook,
    normalizeLook,
    normalizeData,
    migrate,
    parse,
    serialize,
    probeStorage,
    load,
    save,
    activePlayer,
    setActive,
    cyclePlayer,
    addPlayer,
    removePlayer,
    renamePlayer,
    updateLook,
    recordRoll,
    dieStats,
    setLucky,
    luckyDie,
    autoEpitaph,
    burnDie,
    resurrectDie,
    scatterAshes,
    exportJSON,
    importJSON,
  };
});
