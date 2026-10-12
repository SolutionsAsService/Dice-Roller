/*
 * Dungeon Dice Box – player profiles, dice bags, lucky dice and the Hall of Shame (no DOM).
 *
 * Everything here is bookkeeping and cosmetics. Nothing in this file rolls a
 * die or touches DiceCore's random source: stats are recorded *after* a roll
 * has been decided, and assigning bag dice to the rolled dice is a pure
 * function of the finished result. Profiles, looks, slots, lucky marks and
 * burnings can never change what you roll.
 *
 * Works as a classic browser script (window.DiceProfiles) and as a CommonJS
 * module for Node tests.
 *
 * Storage schema (localStorage key "diceBox.profiles"), version 2:
 * {
 *   version: 2,
 *   activeId: "<player id>",
 *   players: [{
 *     id, name, created,
 *     look: { theme, body, ink, finish },          // the player's default look; body/ink null = classic colours
 *     bag: { "4": [Die, ...], "6": [Die, ...], ..., "100": [Die, ...] },   // 1..20 dice per type, slot order
 *     hand: { "6": [dieId, ...], ... },             // dice picked to roll first ("use these dice"); missing = auto
 *     graveyard: [Die & { died, epitaph, cause: "burned" | "retired", slot?, replacedBy? }]   // newest first
 *   }]
 * }
 * Die: { id, sides, name, born, lucky, faces: [count of 1s, count of 2s, ...], recent: [last values], style: Style | null }
 * Style (per-die look, overrides the player's look when set):
 *   { body, body2, pattern, ink, edge, finish, font, pips, opacity, glow, glowColor, inlay, inlayText }
 * Roll count, sum and average are derived from "faces", so they can't disagree.
 *
 * Migrations: v0 (unversioned: a bare array of players or an object without
 * "version", players shaped like { name, color, ink }) -> v1 -> v2. v1 had a
 * single die per type in player.dice; it becomes slot #1 of that type's bag
 * with its stats, lucky mark and history intact.
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

  const SCHEMA_VERSION = 2;
  const STORAGE_KEY = 'diceBox.profiles';
  const BACKUP_KEY = 'diceBox.profiles.backup';
  const TRACKED = Object.freeze([4, 6, 8, 10, 12, 20, 100]);
  const MAX_PLAYERS = 12;
  const MAX_PER_TYPE = 20; // dice of one type in a bag
  const MAX_NAME = 24; // player names
  const MAX_DIE_NAME = 48; // generated die names ("Lady Fortuna the Reliable(ish)") and renamed dice
  const MAX_EPITAPH = 140;
  const MAX_GRAVEYARD = 40;
  const MAX_RECENT = 20;
  const MIN_SAMPLE = 20; // rolls before we pass judgement on a die's luck
  const MIN_OPACITY = 0.35;
  const MIN_CONTRAST = 3; // WCAG ratio below which numbers count as hard to read

  const FINISHES = Object.freeze({
    glossy: 'Glossy',
    matte: 'Matte',
    metal: 'Metallic',
    pearl: 'Pearlescent',
    gem: 'Gemstone',
    glass: 'Glass (translucent)',
    glitter: 'Glitter',
    neon: 'Neon glow',
    wood: 'Wood',
    bone: 'Bone',
    stone: 'Stone',
  });

  const PATTERNS = Object.freeze({
    solid: 'Solid',
    gradient: 'Gradient',
    twotone: 'Two-tone',
    swirl: 'Swirl',
    marble: 'Marbled',
    speckle: 'Speckled',
  });

  const FONTS = Object.freeze({
    classic: 'Classic serif',
    sans: 'Clean sans',
    fantasy: 'Fantasy (MedievalSharp)',
    runic: 'Runic (carved)',
  });

  /**
   * Inlays drawn on a die's highest face. Paths are our own simple 24×24 SVG
   * path data (no external assets), shared by the 3D textures and the HTML.
   */
  const INLAYS = Object.freeze({
    star: Object.freeze({ label: 'Star', path: 'M12 1.8l3 6.7 7.2.7-5.5 4.8 1.7 7.1L12 17.4l-6.4 3.7 1.7-7.1-5.5-4.8 7.2-.7z' }),
    heart: Object.freeze({ label: 'Heart', path: 'M12 21.5s-7.6-4.7-9.7-9.4C.8 8.6 2.9 4.5 6.7 4.5c2.2 0 3.6 1.2 5.3 3.2 1.7-2 3.1-3.2 5.3-3.2 3.8 0 5.9 4.1 4.4 7.6-2.1 4.7-9.7 9.4-9.7 9.4z' }),
    skull: Object.freeze({ label: 'Skull', evenodd: true,
      path: 'M12 1.8c-5 0-8.7 3.7-8.7 8.4 0 2.9 1.3 5 3.1 6.2v3.4c0 .9.7 1.6 1.6 1.6h1v-2.6h1.6v2.6h2.8v-2.6H15v2.6h1c.9 0 1.6-.7 1.6-1.6v-3.4c1.8-1.2 3.1-3.3 3.1-6.2 0-4.7-3.7-8.4-8.7-8.4zM8.4 14.2a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6zm7.2 0a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6z' }),
    crown: Object.freeze({ label: 'Crown', path: 'M2 6.5l5.5 4.3L12 3.5l4.5 7.3L22 6.5l-1.6 11H3.6zM3.6 19h16.8v2.5H3.6z' }),
    moon: Object.freeze({ label: 'Moon', path: 'M15.6 2.2A10 10 0 1 0 21.8 19a8.3 8.3 0 0 1-6.2-16.8z' }),
    sun: Object.freeze({ label: 'Sun',
      path: 'M12 6.8a5.2 5.2 0 1 0 0 10.4 5.2 5.2 0 0 0 0-10.4zM10.9.5h2.2v4h-2.2zM10.9 19.5h2.2v4h-2.2zM.5 10.9h4v2.2h-4zM19.5 10.9h4v2.2h-4zM3.3 4.9l1.6-1.6 2.8 2.8-1.6 1.6zM16.3 17.9l1.6-1.6 2.8 2.8-1.6 1.6zM3.3 19.1l2.8-2.8 1.6 1.6-2.8 2.8zM16.3 6.1l2.8-2.8 1.6 1.6-2.8 2.8z' }),
    flame: Object.freeze({ label: 'Flame', path: 'M12.2 2c.9 3.4-1.6 5-1.6 7.6 0 1.2.8 2.1 1.9 2.1 1.4 0 2.1-1.3 1.7-3.1 2.7 1.8 4.1 4.4 4.1 7.1A6.3 6.3 0 0 1 12 22a6.2 6.2 0 0 1-6.3-6.2c0-2.7 1.4-4.8 3.1-6.3.4-2.9 1.9-5.4 3.4-7.5z' }),
    clover: Object.freeze({ label: 'Clover',
      path: 'M8.4 7.2a3.6 3.6 0 1 0 7.2 0 3.6 3.6 0 1 0-7.2 0zM13.2 12a3.6 3.6 0 1 0 7.2 0 3.6 3.6 0 1 0-7.2 0zM8.4 16.8a3.6 3.6 0 1 0 7.2 0 3.6 3.6 0 1 0-7.2 0zM3.6 12a3.6 3.6 0 1 0 7.2 0 3.6 3.6 0 1 0-7.2 0zM11.2 17.5h1.6l1.6 5.5h-1.7z' }),
    sword: Object.freeze({ label: 'Sword', path: 'M19.8 1.8l2.4-.1-.1 2.4L10.6 15.6l-2.3-2.3zM6.6 12.6l4.8 4.8-1.6 1.6-1.3-1.3-3.5 3.5-1.7-1.7 3.5-3.5-1.3-1.3z' }),
    eye: Object.freeze({ label: 'Eye', evenodd: true,
      path: 'M12 5C6.5 5 2.5 9.5 1 12c1.5 2.5 5.5 7 11 7s9.5-4.5 11-7c-1.5-2.5-5.5-7-11-7zm0 11.2a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' }),
    text: Object.freeze({ label: 'Your own symbol', path: null }),
  });
  const MAX_INLAY_TEXT = 3; // code points (an emoji, a rune, initials)

  /** The original per-type rainbow (also used by the 3D tray and the CSS dice). */
  const CLASSIC_COLORS = Object.freeze({
    4: Object.freeze({ body: '#5fd39b', body2: '#12583a', ink: '#ffffff' }),
    6: Object.freeze({ body: '#fbf3e2', body2: '#c8b48a', ink: '#3a2412' }),
    8: Object.freeze({ body: '#6d9cf0', body2: '#1a3577', ink: '#ffffff' }),
    10: Object.freeze({ body: '#b98cf0', body2: '#44207a', ink: '#ffffff' }),
    12: Object.freeze({ body: '#f3b955', body2: '#6e3a08', ink: '#ffffff' }),
    20: Object.freeze({ body: '#f06a5f', body2: '#7a1220', ink: '#ffffff' }),
    100: Object.freeze({ body: '#5b5b6b', body2: '#121219', ink: '#f0d48a' }),
  });

  /** Borrowed "house dice": plain, grey, clearly not yours. */
  const HOUSE_STYLE = Object.freeze({
    body: '#9a9ca3', body2: '#5d6068', pattern: 'solid', ink: '#16181d', edge: '#2a2d33', finish: 'matte', font: 'sans',
    pips: true, opacity: 1, glow: 0, glowColor: '#ffffff', inlay: null, inlayText: '',
  });

  /** Preset looks for the player. body/ink null = the classic per-die rainbow. */
  const THEMES = Object.freeze({
    classic: Object.freeze({ label: 'Classic rainbow', body: null, ink: null, finish: 'glossy' }),
    hoard: Object.freeze({ label: 'Dragon\u2019s hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'metal' }),
    lich: Object.freeze({ label: 'Lich-light', body: '#1f1b2b', ink: '#8cf5b0', finish: 'matte' }),
    bard: Object.freeze({ label: 'Bubblegum bard', body: '#ff7eb9', ink: '#ffffff', finish: 'pearl' }),
    frost: Object.freeze({ label: 'Frost wizard', body: '#8fd3ff', ink: '#0b3557', finish: 'gem' }),
    goblin: Object.freeze({ label: 'Goblin budget', body: '#7d8f3c', ink: '#f4e8a6', finish: 'matte' }),
    vampire: Object.freeze({ label: 'Vampire velvet', body: '#6e0f1f', ink: '#f0d48a', finish: 'glossy' }),
  });

  /** Preset looks for a single die (partial styles; missing fields use neutral defaults). */
  const DIE_PRESETS = Object.freeze({
    ember: Object.freeze({ label: 'Ember', body: '#c9410c', body2: '#5a0d00', pattern: 'swirl', ink: '#fff3c4', edge: '#ffd27a', finish: 'glossy', glow: 0.25, glowColor: '#ff7a2a', inlay: 'flame' }),
    frostglass: Object.freeze({ label: 'Frost glass', body: '#9fe3ff', body2: '#ffffff', pattern: 'marble', ink: '#08263f', edge: '#e8f8ff', finish: 'glass', opacity: 0.85 }),
    obsidian: Object.freeze({ label: 'Obsidian', body: '#17131f', body2: '#4b3a66', pattern: 'marble', ink: '#e7c35f', edge: '#e7c35f', finish: 'gem' }),
    neon: Object.freeze({ label: 'Neon nights', body: '#120a1e', body2: '#2a1145', pattern: 'gradient', ink: '#39ff14', edge: '#ff2bd6', finish: 'neon', glow: 0.35, glowColor: '#39ff14' }),
    oak: Object.freeze({ label: 'Old oak', body: '#8a5a2b', body2: '#4f2d12', pattern: 'solid', ink: '#f6e7c8', edge: '#2a1608', finish: 'wood', font: 'runic' }),
    bone: Object.freeze({ label: 'Necromancer\u2019s bone', body: '#ece2cb', body2: '#b9a985', pattern: 'speckle', ink: '#3b2a1a', edge: '#7a6648', finish: 'bone', font: 'fantasy', inlay: 'skull' }),
    granite: Object.freeze({ label: 'Granite', body: '#6d6f76', body2: '#33353a', pattern: 'speckle', ink: '#ffffff', edge: '#1d1e22', finish: 'stone', font: 'runic' }),
    galaxy: Object.freeze({ label: 'Galaxy', body: '#1a1446', body2: '#5a2ccc', pattern: 'swirl', ink: '#ffffff', edge: '#b9a6ff', finish: 'glitter', inlay: 'star' }),
    royal: Object.freeze({ label: 'Royal decree', body: '#3a0f5c', body2: '#6b3c12', pattern: 'twotone', ink: '#ffe9a6', edge: '#f0d48a', finish: 'metal', inlay: 'crown' }),
    clover: Object.freeze({ label: 'Four-leaf', body: '#2f8f4e', body2: '#0f3d1f', pattern: 'gradient', ink: '#ffffff', edge: '#b8f07a', finish: 'pearl', inlay: 'clover' }),
    blood: Object.freeze({ label: 'Blood moon', body: '#8a0f1c', body2: '#2a0005', pattern: 'marble', ink: '#ffffff', edge: '#ff8a8a', finish: 'gem', inlay: 'moon' }),
    paladin: Object.freeze({ label: 'Paladin', body: '#f4f1e8', body2: '#c9b27a', pattern: 'gradient', ink: '#1d3a8a', edge: '#c9a443', finish: 'pearl', font: 'fantasy', inlay: 'sun' }),
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
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

  /** Cosmetic id (Math.random is fine – ids never influence a roll). */
  function makeId(prefix, opts) {
    const rng = rngOf(opts);
    let s = '';
    for (let i = 0; i < 8; i++) s += Math.floor(rng() * 36).toString(36);
    return prefix + '_' + nowOf(opts).toString(36) + s;
  }

  function sanitizeName(name, fallback, max) {
    const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim() : '';
    return (s || fallback || 'Adventurer').slice(0, max || MAX_NAME);
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

  /** A short symbol for an inlay: up to 3 code points, no controls, no markup characters, no spaces. */
  function sanitizeInlayText(t) {
    if (typeof t !== 'string') return '';
    const clean = t.replace(CONTROL_CHARS, '').replace(/[<>&"'\x60\\]/g, '').replace(/\s+/g, '');
    return Array.from(clean).slice(0, MAX_INLAY_TEXT).join('');
  }

  function finiteTime(t, fallback) {
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : fallback;
  }

  // ------------------------------------------------------------------ colour
  function rgbOf(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexOf(rgb) {
    return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  function mixColor(a, b, t) {
    const x = rgbOf(a);
    const y = rgbOf(b);
    return hexOf(x.map((v, i) => v + (y[i] - v) * t));
  }

  /** WCAG relative luminance of "#rrggbb". */
  function relativeLuminance(hex) {
    const lin = rgbOf(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  /** WCAG contrast ratio (1–21) between two "#rrggbb" colours. */
  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Near-black or white, whichever reads better on "bg". */
  function readableOn(bg) {
    return contrastRatio('#ffffff', bg) >= contrastRatio('#111111', bg) ? '#ffffff' : '#111111';
  }

  function hslHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }

  // ------------------------------------------------------------------ styles
  /** A complete style built from the player's look (what a die with style null looks like). */
  function styleFromLook(look, sides) {
    const classic = CLASSIC_COLORS[sides] || CLASSIC_COLORS[20];
    const custom = look && look.body;
    return {
      body: custom ? look.body : classic.body,
      body2: custom ? mixColor(look.body, '#000000', 0.5) : classic.body2,
      pattern: 'solid',
      ink: custom ? (look.ink || '#ffffff') : classic.ink,
      edge: null,
      finish: (look && FINISHES[look.finish]) ? look.finish : 'glossy',
      font: 'classic',
      pips: true,
      opacity: 1,
      glow: 0,
      glowColor: custom ? (look.ink || '#ffffff') : classic.ink,
      inlay: null,
      inlayText: '',
    };
  }

  /**
   * Validate a stored/patched per-die style. Returns a complete style or null
   * ("use the player's look"). base fills missing or invalid fields.
   */
  function normalizeStyle(raw, base) {
    if (!isObj(raw)) return null;
    const b = base || styleFromLook(null, 20);
    const color = (v, fb) => sanitizeColor(v) || fb;
    const num = (v, lo, hi, fb) => {
      const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
      return Number.isFinite(n) ? Math.round(clamp(n, lo, hi) * 100) / 100 : fb;
    };
    const style = {
      body: color(raw.body, b.body),
      body2: color(raw.body2, b.body2),
      pattern: PATTERNS[raw.pattern] ? raw.pattern : b.pattern,
      ink: color(raw.ink, b.ink),
      edge: raw.edge === null ? null : color(raw.edge, b.edge),
      finish: FINISHES[raw.finish] ? raw.finish : b.finish,
      font: FONTS[raw.font] ? raw.font : b.font,
      pips: typeof raw.pips === 'boolean' ? raw.pips : b.pips,
      opacity: num(raw.opacity, MIN_OPACITY, 1, b.opacity),
      glow: num(raw.glow, 0, 1, b.glow),
      glowColor: color(raw.glowColor, b.glowColor || b.ink),
      inlay: raw.inlay === null ? null : (INLAYS[raw.inlay] ? raw.inlay : (b.inlay || null)),
      inlayText: raw.inlayText !== undefined ? sanitizeInlayText(raw.inlayText) : (b.inlayText || ''),
    };
    if (style.inlay === 'text' && !style.inlayText) style.inlay = null;
    return style;
  }

  /**
   * Everything a renderer needs to draw a die: the die's own style, or the
   * player's look. classic: true means "use the original per-type rainbow".
   */
  function resolveAppearance(look, style, sides) {
    if (style) return Object.assign({ classic: false, custom: true }, style);
    const base = styleFromLook(look, sides);
    return Object.assign({ classic: !(look && look.body), custom: false }, base);
  }

  function appearanceOf(player, die) {
    return resolveAppearance(player && player.look, die && die.style, die ? die.sides : 20);
  }

  /** Stable string for caching textures/materials of an appearance. */
  function appearanceKey(a) {
    if (!a) return 'none';
    return [a.classic ? 'C' : 'X', a.body, a.body2, a.pattern, a.ink, a.edge || '-', a.finish, a.font, a.pips ? 1 : 0,
      a.opacity, a.glow, a.glowColor, a.inlay || '-', a.inlayText || ''].join('|');
  }

  /**
   * The colours the numbers actually sit on. A solid die is shaded from a
   * slightly lighter body colour towards its second colour (the renderers
   * draw the same gradient), so its typical face tone is checked; patterned
   * dice are checked against both colours (speckles are only small dots).
   */
  function faceTones(a) {
    if (a.pattern === 'solid') return [mixColor(mixColor(a.body, '#ffffff', 0.1), a.body2, 0.4)];
    if (a.pattern === 'speckle') return [a.body];
    return [a.body, a.body2];
  }

  /**
   * Readability warnings for an appearance, e.g. numbers that blend into the
   * body. Returns [{ key, message, ratio? }] (empty = fine).
   */
  function readabilityWarnings(a) {
    if (!a) return [];
    const out = [];
    const tones = faceTones(a);
    const ratios = tones.map((t) => contrastRatio(a.ink, t));
    const worst = Math.min.apply(null, ratios);
    if (worst < MIN_CONTRAST) {
      const shown = Math.round(worst * 10) / 10;
      const second = tones.length > 1 && ratios[1] < ratios[0];
      out.push({
        key: 'contrast',
        ratio: shown,
        message: 'The numbers and the ' + (second ? 'second colour' : 'body colour') + ' are too similar (contrast ' +
          shown + ':1). Numbers may be hard to read \u2013 aim for at least ' + MIN_CONTRAST + ':1.',
      });
    }
    if (a.opacity < 0.6 || (a.finish === 'glass' && a.opacity < 0.7)) {
      out.push({ key: 'opacity', message: 'Very see-through dice can be hard to read on the felt.' });
    }
    return out;
  }

  /** A random but always readable style (cosmetic; Math.random is fine). */
  function randomStyle(opts) {
    const rng = rngOf(opts);
    const hue = rng() * 360;
    const sat = 0.35 + rng() * 0.55;
    const light = 0.18 + rng() * 0.6;
    const body = hslHex(hue, sat, light);
    const shift = pick([0, 30, -30, 150, 180, 210], rng);
    const body2 = hslHex(hue + shift, clamp(sat + (rng() - 0.5) * 0.3, 0.2, 1), clamp(light + (rng() < 0.5 ? -0.25 : 0.25), 0.08, 0.92));
    let pattern = pick(Object.keys(PATTERNS), rng);
    const finish = pick(Object.keys(FINISHES), rng);
    // Pick the most readable ink against both colours from a few candidates.
    const candidates = ['#ffffff', '#111111', '#f0d48a', '#1d3a8a', hslHex(hue + 180, 0.9, 0.85), hslHex(hue + 180, 0.9, 0.12)];
    const fancy = rng() < 0.5;
    const chooseInk = () => {
      const tones = faceTones({ body, body2, pattern });
      const score = (c) => Math.min.apply(null, tones.map((t) => contrastRatio(c, t)));
      let ink = candidates[0];
      let best = -1;
      candidates.forEach((c) => {
        // Prefer something fancier than black/white when it is clearly readable.
        const bonus = fancy && c !== '#ffffff' && c !== '#111111' && score(c) >= 4.5 ? 2 : 0;
        if (score(c) + bonus > best) { best = score(c) + bonus; ink = c; }
      });
      return { ink, score: score(ink) };
    };
    let choice = chooseInk();
    if (choice.score < 4.5) {
      pattern = 'solid'; // two clashing colours: keep it readable
      choice = chooseInk();
    }
    const ink = choice.ink;
    const glowy = finish === 'neon' || rng() < 0.15;
    const inlayKeys = Object.keys(INLAYS).filter((k) => k !== 'text');
    return normalizeStyle({
      body, body2, pattern, ink,
      edge: rng() < 0.5 ? ink : mixColor(body2, '#000000', 0.3),
      finish,
      font: pick(Object.keys(FONTS), rng),
      pips: rng() < 0.75,
      opacity: finish === 'glass' ? 0.85 : 1,
      glow: glowy ? Math.round((0.15 + rng() * 0.35) * 100) / 100 : 0,
      glowColor: rng() < 0.5 ? ink : body2,
      inlay: rng() < 0.35 ? pick(inlayKeys, rng) : null,
    });
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
      name: (opts && opts.name) ? sanitizeName(opts.name, null, MAX_DIE_NAME) : dieName(opts),
      born: nowOf(opts),
      lucky: false,
      faces: new Array(sides).fill(0),
      recent: [],
      style: (opts && opts.style) ? normalizeStyle(opts.style, styleFromLook(null, sides)) : null,
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
      name: sanitizeName(raw.name, dieName(opts), MAX_DIE_NAME),
      born: finiteTime(raw.born, nowOf(opts)),
      lucky: raw.lucky === true,
      faces,
      recent,
      style: normalizeStyle(raw.style, styleFromLook(null, s)),
    };
    if (withDeath) {
      die.died = finiteTime(raw.died, nowOf(opts));
      die.epitaph = sanitizeText(raw.epitaph, MAX_EPITAPH) || 'No last words.';
      die.cause = raw.cause === 'retired' ? 'retired' : 'burned';
      if (Number.isInteger(raw.slot) && raw.slot >= 0 && raw.slot < MAX_PER_TYPE) die.slot = raw.slot;
      if (typeof raw.replacedBy === 'string' && raw.replacedBy) die.replacedBy = raw.replacedBy.slice(0, 64);
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
    const bag = {};
    TRACKED.forEach((s) => { bag[s] = [newDie(s, opts)]; });
    return bag;
  }

  function newPlayer(name, opts) {
    return {
      id: makeId('p', opts),
      name: sanitizeName(name),
      created: nowOf(opts),
      look: normalizeLook(opts && opts.look),
      bag: freshBag(opts),
      hand: {},
      graveyard: [],
    };
  }

  /** Repair the hand (picked dice) against the bag: known ids of the right type, no duplicates. */
  function normalizeHand(raw, bag) {
    const hand = {};
    if (!isObj(raw)) return hand;
    TRACKED.forEach((s) => {
      if (!Array.isArray(raw[s])) return;
      const ids = new Set((bag[s] || []).map((d) => d.id));
      const list = [];
      raw[s].forEach((id) => { if (typeof id === 'string' && ids.has(id) && !list.includes(id)) list.push(id); });
      if (list.length) hand[s] = list;
    });
    return hand;
  }

  function normalizePlayer(raw, opts) {
    if (!isObj(raw)) return null;
    const player = {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : makeId('p', opts),
      name: sanitizeName(raw.name),
      created: finiteTime(raw.created, nowOf(opts)),
      look: normalizeLook(raw.look),
      bag: {},
      hand: {},
      graveyard: [],
    };
    const bag = isObj(raw.bag) ? raw.bag : {};
    const seen = new Set();
    let luckyTaken = false;
    TRACKED.forEach((s) => {
      let list = bag[s];
      if (isObj(list)) list = [list]; // a single die where a list belongs
      const dice = (Array.isArray(list) ? list : [])
        .map((d) => normalizeDie(d, s, opts, false))
        .filter(Boolean)
        .slice(0, MAX_PER_TYPE);
      if (!dice.length) dice.push(newDie(s, opts));
      dice.forEach((d) => {
        while (seen.has(d.id)) d.id = makeId('die', opts);
        seen.add(d.id);
        if (d.lucky && luckyTaken) d.lucky = false; // only one lucky die per player
        if (d.lucky) luckyTaken = true;
      });
      player.bag[s] = dice;
    });
    player.hand = normalizeHand(raw.hand, player.bag);
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

  /** Validate/repair a current-version object. Always returns usable data with at least one player. */
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

  /**
   * v1 -> v2: one die per type (player.dice[sides]) becomes slot #1 of a bag
   * (player.bag[sides] = [die]) with its id, name, stats, lucky mark and
   * history untouched. Unknown fields are dropped later by normalizeData.
   */
  function migrateV1(raw) {
    const players = (isObj(raw) && Array.isArray(raw.players) ? raw.players : []).map((p) => {
      if (!isObj(p)) return p;
      const out = Object.assign({}, p);
      const dice = isObj(p.dice) ? p.dice : {};
      if (!isObj(p.bag)) {
        out.bag = {};
        TRACKED.forEach((s) => { if (isObj(dice[s])) out.bag[s] = [dice[s]]; });
      }
      delete out.dice;
      return out;
    });
    return { version: 2, activeId: isObj(raw) ? raw.activeId : null, players };
  }

  const MIGRATIONS = { 0: migrateV0, 1: migrateV1 };

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
   * Data from an older version is backed up the same way before it is upgraded.
   * Returns { data, status, persistent, error? }.
   */
  function load(storage, opts) {
    const persistent = probeStorage(storage);
    let text = null;
    try { text = storage ? storage.getItem(STORAGE_KEY) : null; } catch (e) { text = null; }
    const r = parse(text, opts);
    if (persistent && (r.status === 'corrupt' || r.status === 'future' || r.status === 'migrated')) {
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

  // ------------------------------------------------------------- the bag
  function bagOf(player, sides) {
    return (player && player.bag && player.bag[sides]) || [];
  }

  /** Every die in the bag, in rack order then slot order. */
  function allDice(player) {
    const out = [];
    TRACKED.forEach((s) => bagOf(player, s).forEach((d) => out.push(d)));
    return out;
  }

  /** { die, sides, index } for a die id in the bag, or null. */
  function findDie(player, id) {
    for (const s of TRACKED) {
      const i = bagOf(player, s).findIndex((d) => d.id === id);
      if (i >= 0) return { die: player.bag[s][i], sides: s, index: i };
    }
    return null;
  }

  /** Accepts a die id, or (shorthand) a die type meaning slot #1 of that type. */
  function locate(player, ref) {
    if (typeof ref === 'number') {
      const list = bagOf(player, ref);
      return list.length ? { die: list[0], sides: ref, index: 0 } : null;
    }
    return findDie(player, ref);
  }

  function slotLabel(sides, index) {
    return 'd' + sides + ' #' + (index + 1);
  }

  /** A die name not already used in this player's bag (gives up after a few tries). */
  function uniqueName(player, opts) {
    const used = new Set(allDice(player).map((d) => d.name));
    let name = dieName(opts);
    for (let i = 0; i < 12 && used.has(name); i++) name = dieName(opts);
    return name;
  }

  /** Put a new die in the bag (after the others of its type). opts: { name, style, rng, now }. */
  function addDie(player, sides, opts) {
    if (!TRACKED.includes(sides)) throw new ProfileError('Untracked die: d' + sides);
    const list = bagOf(player, sides);
    if (list.length >= MAX_PER_TYPE) throw new ProfileError('The bag holds at most ' + MAX_PER_TYPE + ' d' + sides + 's.');
    const die = newDie(sides, Object.assign({}, opts, { name: (opts && opts.name) || uniqueName(player, opts) }));
    player.bag[sides] = list.concat(die);
    return die;
  }

  /** Add up to n dice of a type (stops at the cap). Returns the new dice. */
  function addDice(player, sides, n, opts) {
    const out = [];
    for (let i = 0; i < n && bagOf(player, sides).length < MAX_PER_TYPE; i++) out.push(addDie(player, sides, opts));
    return out;
  }

  function dropFromHand(player, sides, id) {
    const h = player.hand && player.hand[sides];
    if (!h) return;
    const i = h.indexOf(id);
    if (i >= 0) h.splice(i, 1);
    if (!h.length) delete player.hand[sides];
  }

  function pushGrave(player, entry) {
    player.graveyard.unshift(entry);
    if (player.graveyard.length > MAX_GRAVEYARD) player.graveyard.length = MAX_GRAVEYARD;
  }

  /**
   * Take a die out of the bag. A die that has been rolled retires to the Hall
   * of Shame (cause "retired", pardonable); an unrolled one just goes. The last
   * die of a type can't be removed (burn it to replace it instead).
   * Returns { removed, retired } (retired is the Hall entry or null).
   */
  function removeDie(player, id, opts) {
    const at = findDie(player, id);
    if (!at) throw new ProfileError('That die is not in the bag.');
    const list = player.bag[at.sides];
    if (list.length <= 1) throw new ProfileError('Keep at least one d' + at.sides + ' in the bag (burn it to get a fresh one).');
    list.splice(at.index, 1);
    dropFromHand(player, at.sides, id);
    let retired = null;
    if (dieStats(at.die).rolls > 0) {
      retired = Object.assign(clone(at.die), {
        died: nowOf(opts),
        epitaph: sanitizeText(opts && opts.epitaph, MAX_EPITAPH) || 'Retired from the bag. Honourably, probably.',
        cause: 'retired',
        lucky: false,
        slot: at.index,
      });
      pushGrave(player, retired);
    }
    return { removed: at.die, retired };
  }

  /** Move a die to another slot of its type (index clamped). Returns the new index. */
  function moveDie(player, id, toIndex) {
    const at = findDie(player, id);
    if (!at) throw new ProfileError('That die is not in the bag.');
    const list = player.bag[at.sides];
    const to = clamp(Math.trunc(Number(toIndex)) || 0, 0, list.length - 1);
    if (to === at.index) return to;
    list.splice(at.index, 1);
    list.splice(to, 0, at.die);
    return to;
  }

  function renameDie(player, id, name) {
    const at = findDie(player, id);
    if (!at) throw new ProfileError('That die is not in the bag.');
    at.die.name = sanitizeName(name, at.die.name, MAX_DIE_NAME);
    return at.die.name;
  }

  /**
   * Change a die's own look. patch: partial style merged over the die's
   * current appearance, a preset id string, or null to go back to the
   * player's look. Returns the new style (or null).
   */
  function setDieStyle(player, id, patch) {
    const at = findDie(player, id);
    if (!at) throw new ProfileError('That die is not in the bag.');
    if (patch === null) {
      at.die.style = null;
      return null;
    }
    const base = Object.assign({}, appearanceOf(player, at.die));
    delete base.classic; delete base.custom;
    let p = patch;
    if (typeof patch === 'string') {
      if (!DIE_PRESETS[patch]) throw new ProfileError('Unknown preset.');
      // Presets are complete looks: start from neutral defaults, not from the current die.
      p = Object.assign({ edge: null, font: 'classic', pips: true, opacity: 1, glow: 0, inlay: null, inlayText: '' }, DIE_PRESETS[patch]);
      delete p.label;
    } else if (!isObj(patch)) {
      throw new ProfileError('Unknown style.');
    }
    at.die.style = normalizeStyle(Object.assign({}, base, p), base);
    return at.die.style;
  }

  /**
   * Copy one die's look to others. to: 'type' (the rest of its type), 'all'
   * (every other die in the bag) or an array of die ids. Returns how many changed.
   */
  function copyStyle(player, fromId, to) {
    const src = findDie(player, fromId);
    if (!src) throw new ProfileError('That die is not in the bag.');
    let targets;
    if (to === 'type') targets = bagOf(player, src.sides);
    else if (to === 'all') targets = allDice(player);
    else targets = (Array.isArray(to) ? to : []).map((id) => (findDie(player, id) || {}).die).filter(Boolean);
    let n = 0;
    targets.forEach((d) => {
      if (d.id === fromId) return;
      d.style = src.die.style ? normalizeStyle(clone(src.die.style), styleFromLook(null, d.sides)) : null;
      n++;
    });
    return n;
  }

  // ------------------------------------------------------- picking dice
  function handOf(player, sides) {
    return (player && player.hand && player.hand[sides]) ? player.hand[sides].slice() : [];
  }

  /** Set the dice to roll first for a type ("use these dice"), in order. Empty = automatic (bag order). */
  function setHand(player, sides, ids) {
    if (!player.hand) player.hand = {};
    const raw = {};
    raw[sides] = ids;
    const fixed = normalizeHand(raw, player.bag);
    if (fixed[sides]) player.hand[sides] = fixed[sides];
    else delete player.hand[sides];
    return handOf(player, sides);
  }

  /** Pick / unpick a die. Returns its 0-based position in the pick order, or -1 when unpicked. */
  function toggleHand(player, id) {
    const at = findDie(player, id);
    if (!at) throw new ProfileError('That die is not in the bag.');
    const h = handOf(player, at.sides);
    const i = h.indexOf(id);
    if (i >= 0) h.splice(i, 1);
    else h.push(id);
    setHand(player, at.sides, h);
    return i >= 0 ? -1 : h.length - 1;
  }

  function houseDie(sides, n) {
    const label = 'House d' + sides + ' #' + (n + 1);
    return { sides, dieId: null, slot: null, label, name: label, house: true, houseIndex: n, lucky: false };
  }

  /**
   * Decide which physical die stands for each die in a list of die types
   * (purely cosmetic and deterministic). For each type: picked dice first (in
   * pick order), then the rest of the bag in slot order, then numbered house
   * dice. A die is never used twice in one roll. Untracked types get null.
   * Returns [{ sides, dieId, slot, label, name, house, houseIndex, lucky }].
   */
  function planDice(player, sidesList) {
    const queues = {};
    const used = {};
    const house = {};
    return (sidesList || []).map((sides) => {
      if (!TRACKED.includes(sides) || !player || !player.bag) return null;
      if (!queues[sides]) {
        const list = bagOf(player, sides);
        const picked = handOf(player, sides).map((id) => list.find((d) => d.id === id)).filter(Boolean);
        queues[sides] = picked.concat(list.filter((d) => !picked.includes(d)));
        used[sides] = 0;
        house[sides] = 0;
      }
      const die = queues[sides][used[sides]];
      if (!die) return houseDie(sides, house[sides]++);
      used[sides]++;
      const slot = bagOf(player, sides).indexOf(die);
      return { sides, dieId: die.id, slot, label: slotLabel(sides, slot), name: die.name, house: false, houseIndex: null, lucky: die.lucky };
    });
  }

  /** Flatten a DiceCore result into [{ group, index, sides, value }] in display order. */
  function flattenResult(result) {
    const out = [];
    if (!result || !Array.isArray(result.groups)) return out;
    result.groups.forEach((g, gi) => {
      (Array.isArray(g && g.dice) ? g.dice : []).forEach((d, di) => {
        out.push({ group: gi, index: di, sides: Number(g.sides) || (d && d.sides), value: d && d.value });
      });
    });
    return out;
  }

  /**
   * Assign bag dice to every die of a finished roll (after the roll; never
   * changes the result). Returns an array aligned with flattenResult(result).
   */
  function assignDice(player, result) {
    const flat = flattenResult(result);
    const plan = planDice(player, flat.map((f) => f.sides));
    return flat.map((f, i) => (plan[i] ? Object.assign({ group: f.group, index: f.index, value: f.value }, plan[i]) : null));
  }

  // --------------------------------------------------------- stats tracking
  /**
   * Credit a finished DiceCore roll result to the bag dice that rolled it.
   * Every physically rolled die counts (dropped advantage/keep dice too);
   * house dice and non-standard dice aren't tracked. Never modifies "result".
   * assignment: from assignDice (computed if omitted).
   * Returns [{ sides, dieId, name, slot, label, lucky, values }] per credited die.
   */
  function recordRoll(player, result, assignment) {
    const credited = new Map();
    if (!player || !result || !Array.isArray(result.groups)) return [];
    const plan = Array.isArray(assignment) ? assignment : assignDice(player, result);
    const flat = flattenResult(result);
    const touched = new Set();
    flat.forEach((f, i) => {
      const a = plan[i];
      if (!a || a.house || !a.dieId) return;
      const at = findDie(player, a.dieId);
      if (!at || at.sides !== f.sides) return;
      const die = at.die;
      const v = f.value;
      if (!Number.isInteger(v) || v < 1 || v > die.sides) return;
      die.faces[v - 1] += 1;
      die.recent.push(v);
      touched.add(die);
      if (!credited.has(die.id)) {
        credited.set(die.id, { sides: die.sides, dieId: die.id, name: die.name, slot: at.index, label: slotLabel(die.sides, at.index), lucky: die.lucky, values: [] });
      }
      credited.get(die.id).values.push(v);
    });
    touched.forEach((die) => {
      if (die.recent.length > MAX_RECENT) die.recent.splice(0, die.recent.length - MAX_RECENT);
    });
    return Array.from(credited.values());
  }

  /**
   * Mark one die as the player's lucky die (only one per player). ref: die id
   * (or a die type for slot #1). on=false clears it; omitted toggles.
   */
  function setLucky(player, ref, on) {
    const at = locate(player, ref);
    if (!at) return false;
    const target = at.die;
    const want = on === undefined ? !target.lucky : !!on;
    allDice(player).forEach((d) => { d.lucky = false; });
    target.lucky = want;
    return want;
  }

  function luckyDie(player) {
    return allDice(player).find((d) => d.lucky) || null;
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
   * Send a die to the Hall of Shame and put a brand-new die (fresh name, zero
   * stats, same look) in its slot. ref: die id (or a die type for slot #1).
   * opts: { epitaph, now, rng }. Returns { burned, replacement, slot }.
   */
  function burnDie(player, ref, opts) {
    const at = locate(player, ref);
    if (!at) throw new ProfileError('No such die to burn.');
    const die = at.die;
    const epitaph = sanitizeText(opts && opts.epitaph, MAX_EPITAPH) || autoEpitaph(die, opts);
    let replacement = newDie(at.sides, Object.assign({}, opts, { name: uniqueName(player, opts) }));
    let guard = 0;
    while (replacement.name === die.name && guard++ < 5) replacement = newDie(at.sides, opts);
    replacement.style = die.style ? clone(die.style) : null; // the slot keeps its look
    const burned = Object.assign(clone(die), { died: nowOf(opts), epitaph, cause: 'burned', slot: at.index, replacedBy: replacement.id });
    player.bag[at.sides][at.index] = replacement;
    const h = player.hand && player.hand[at.sides];
    if (h && h.indexOf(die.id) >= 0) h[h.indexOf(die.id)] = replacement.id;
    pushGrave(player, burned);
    return { burned, replacement, slot: at.index };
  }

  /**
   * Pardon a die from the Hall of Shame: it goes back in the bag with its old
   * stats and look. If the die that replaced it was never rolled, the pardoned
   * die simply takes its slot back. Otherwise it rejoins the bag as an extra
   * die (in its old slot if possible). Only when that type is full (20 dice)
   * does the replacement retire to the Hall (cause "retired", pardonable too).
   * Returns { restored, displaced, slot } (displaced may be null).
   */
  function resurrectDie(player, dieId, opts) {    const i = player.graveyard.findIndex((g) => g.id === dieId);
    if (i < 0) throw new ProfileError('That die is not in the Hall of Shame.');
    const entry = player.graveyard[i];
    const sides = entry.sides;
    const list = bagOf(player, sides).slice();
    if (findDie(player, entry.id)) throw new ProfileError('That die is already in the bag.');
    player.graveyard.splice(i, 1);
    const restored = clone(entry);
    const wantSlot = Number.isInteger(entry.slot) ? entry.slot : list.length;
    delete restored.died; delete restored.epitaph; delete restored.cause; delete restored.slot; delete restored.replacedBy;
    // Keep the lucky title where it is.
    if (restored.lucky && luckyDie(player)) restored.lucky = false;

    let displaced = null;
    let slot;
    const repIndex = entry.replacedBy ? list.findIndex((d) => d.id === entry.replacedBy) : -1;
    const unused = repIndex >= 0 && dieStats(list[repIndex]).rolls === 0 && !list[repIndex].lucky;
    if (unused) {
      const rep = list[repIndex];
      list[repIndex] = restored;
      const h = player.hand && player.hand[sides];
      if (h && h.indexOf(rep.id) >= 0) h[h.indexOf(rep.id)] = restored.id;
      slot = repIndex;
    } else if (list.length < MAX_PER_TYPE) {
      slot = clamp(wantSlot, 0, list.length);
      list.splice(slot, 0, restored);
    } else {
      // That type is full: the replacement (or the last die) steps aside.
      const out = repIndex >= 0 ? repIndex : list.length - 1;
      const current = list[out];
      displaced = Object.assign(clone(current), {
        died: nowOf(opts),
        epitaph: 'Stepped aside when ' + restored.name + ' was pardoned.',
        cause: 'retired',
        lucky: false,
        slot: out,
      });
      if (current.lucky) restored.lucky = true; // the title passes on instead of vanishing
      dropFromHand(player, sides, current.id);
      list[out] = restored;
      pushGrave(player, displaced);
      slot = out;
    }
    player.bag[sides] = list;
    return { restored, displaced, slot };
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
   * new ones are added (up to MAX_PLAYERS). Older backups are migrated.
   * Throws ProfileError on bad input. Returns { added, replaced, skipped }.
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
    MAX_PER_TYPE,
    MAX_NAME,
    MAX_DIE_NAME,
    MAX_INLAY_TEXT,
    MIN_OPACITY,
    MIN_CONTRAST,
    FIRST_NAMES,
    EPITHETS,
    MAX_EPITAPH,
    MAX_GRAVEYARD,
    MIN_SAMPLE,
    FINISHES,
    PATTERNS,
    FONTS,
    INLAYS,
    CLASSIC_COLORS,
    HOUSE_STYLE,
    THEMES,
    DIE_PRESETS,
    ProfileError,
    sanitizeName,
    sanitizeColor,
    sanitizeInlayText,
    contrastRatio,
    readableOn,
    faceTones,
    mixColor,
    newDie,
    newPlayer,
    defaultData,
    defaultLook,
    normalizeLook,
    normalizeStyle,
    normalizeData,
    styleFromLook,
    resolveAppearance,
    appearanceOf,
    appearanceKey,
    readabilityWarnings,
    randomStyle,
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
    bagOf,
    allDice,
    findDie,
    slotLabel,
    addDie,
    addDice,
    removeDie,
    moveDie,
    renameDie,
    setDieStyle,
    copyStyle,
    handOf,
    setHand,
    toggleHand,
    planDice,
    flattenResult,
    assignDice,
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
