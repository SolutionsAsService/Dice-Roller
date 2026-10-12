/*
 * Dice Box – core dice logic (no DOM).
 *
 * Works as a classic browser script (exposes window.DiceCore) and as a
 * CommonJS module for Node tests (require('./dice-core.js') or
 * import DiceCore from './dice-core.js').
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.DiceCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Standard dice offered in the rack. */
  const DICE = Object.freeze([4, 6, 8, 10, 12, 20, 100]);

  const LIMITS = Object.freeze({
    maxDicePerTerm: 100,
    maxTotalDice: 200,
    maxSides: 1000,
    maxModifier: 9999,
    maxFormulaLength: 200,
  });

  const UINT32_RANGE = 0x100000000; // 2^32

  class DiceError extends Error {
    constructor(message) {
      super(message);
      this.name = 'DiceError';
    }
  }

  function defaultSource() {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new DiceError('Secure randomness (crypto.getRandomValues) is not available.');
    }
    return c;
  }

  /**
   * Uniform integer in [1, sides] using crypto.getRandomValues and rejection
   * sampling: raw 32-bit values at or above the largest multiple of sides
   * are discarded, so every face is exactly equally likely (no modulo bias).
   *
   * @param {number} sides
   * @param {{getRandomValues(a: Uint32Array): Uint32Array}} [source]
   */
  function randomInt(sides, source) {
    if (!Number.isInteger(sides) || sides < 1 || sides > UINT32_RANGE) {
      throw new RangeError('sides must be an integer between 1 and 2^32');
    }
    if (sides === 1) return 1;
    const src = source || defaultSource();
    const limit = UINT32_RANGE - (UINT32_RANGE % sides);
    const buf = new Uint32Array(1);
    let x;
    do {
      src.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return (x % sides) + 1;
  }

  /**
   * Parse dice notation such as "2d6+3", "d20", "d%", "4d6kh3", "4d6dl1",
   * "2d20kl1", "1d8 + 2d6 - 1".
   *
   * Returns { terms: [{count, sides, sign, keep}], modifier }.
   * keep is null or { type: 'h' | 'l', n }.
   * A formula with only a flat number is valid here (terms = []); rolling it
   * is rejected by rollExpression.
   */
  function parseNotation(input) {
    if (typeof input !== 'string') throw new DiceError('Formula must be text.');
    // "3d6 4" must not silently become "3d64": spaces may only separate terms.
    if (/[0-9a-z%]\s+[0-9a-z%]/i.test(input)) {
      throw new DiceError('Separate dice groups with + or -.');
    }
    const s = input.toLowerCase().replace(/\s+/g, '').replace(/\u2212/g, '-');
    if (!s) throw new DiceError('Enter a formula like 2d6+3.');
    if (s.length > LIMITS.maxFormulaLength) throw new DiceError('That formula is too long.');

    const re = /([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl|k|dh|dl)(\d*))?|(\d+))/y;
    const terms = [];
    let modifier = 0;
    let totalDice = 0;
    let pos = 0;

    while (pos < s.length) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (!m) throw new DiceError('Can\'t read "' + s.slice(pos) + '".');
      if (pos > 0 && !m[1]) throw new DiceError('Missing + or - before "' + m[0] + '".');
      const sign = m[1] === '-' ? -1 : 1;

      if (m[6] !== undefined) {
        modifier += sign * parseInt(m[6], 10);
      } else {
        const count = m[2] === '' ? 1 : parseInt(m[2], 10);
        const sides = m[3] === '%' ? 100 : parseInt(m[3], 10);
        if (count < 1) throw new DiceError('Roll at least one die per group.');
        if (count > LIMITS.maxDicePerTerm) {
          throw new DiceError('At most ' + LIMITS.maxDicePerTerm + ' dice per group.');
        }
        if (sides < 2 || sides > LIMITS.maxSides) {
          throw new DiceError('Dice need between 2 and ' + LIMITS.maxSides + ' sides.');
        }
        let keep = null;
        if (m[4]) {
          const n = m[5] === '' ? 1 : parseInt(m[5], 10);
          if (m[4] === 'dl' || m[4] === 'dh') {
            if (n >= count) throw new DiceError('Can\'t drop ' + n + ' of ' + count + ' dice.');
            keep = n === 0 ? null : { type: m[4] === 'dl' ? 'h' : 'l', n: count - n };
          } else {
            if (n < 1 || n > count) throw new DiceError('Can\'t keep ' + n + ' of ' + count + ' dice.');
            keep = n === count ? null : { type: m[4] === 'kl' ? 'l' : 'h', n };
          }
        }
        totalDice += count;
        if (totalDice > LIMITS.maxTotalDice) {
          throw new DiceError('At most ' + LIMITS.maxTotalDice + ' dice per roll.');
        }
        terms.push({ count, sides, sign, keep });
      }
      pos = re.lastIndex;
    }

    if (Math.abs(modifier) > LIMITS.maxModifier) throw new DiceError('Modifier is too large.');
    return { terms, modifier };
  }

  function termToNotation(t) {
    let out = (t.count === 1 ? '' : String(t.count)) + 'd' + t.sides;
    if (t.keep) out += (t.keep.type === 'h' ? 'kh' : 'kl') + t.keep.n;
    return out;
  }

  /** Canonical notation string for a parsed expression. */
  function toNotation(parsed) {
    let out = '';
    parsed.terms.forEach((t, i) => {
      if (t.sign < 0) out += '-';
      else if (i > 0) out += '+';
      out += termToNotation(t);
    });
    const mod = parsed.modifier || 0;
    if (mod !== 0) {
      if (out) out += (mod > 0 ? '+' : '-') + Math.abs(mod);
      else out = String(mod);
    }
    return out;
  }

  /** Build a parsed expression from rack counts ({4: n, 6: n, ...}). */
  function fromPool(pool, modifier) {
    const terms = [];
    for (const sides of DICE) {
      const count = Math.max(0, Math.floor(Number(pool && pool[sides]) || 0));
      if (count > 0) terms.push({ count, sides, sign: 1, keep: null });
    }
    return { terms, modifier: Math.trunc(Number(modifier) || 0) };
  }

  function poolToNotation(pool, modifier) {
    return toNotation(fromPool(pool, modifier));
  }

  /**
   * Convert a parsed expression to rack counts when it only uses positive,
   * standard dice with no keep/drop. Returns null otherwise.
   */
  function toPool(parsed, maxPerDie) {
    const cap = maxPerDie || 99;
    const pool = {};
    for (const s of DICE) pool[s] = 0;
    for (const t of parsed.terms) {
      if (t.sign < 0 || t.keep || !DICE.includes(t.sides)) return null;
      pool[t.sides] += t.count;
      if (pool[t.sides] > cap) return null;
    }
    return { pool, modifier: parsed.modifier || 0 };
  }

  function countDice(parsed) {
    return parsed.terms.reduce((n, t) => n + t.count, 0);
  }

  /** True when advantage/disadvantage would affect this expression. */
  function hasAdvantageTarget(parsed) {
    return parsed.terms.some((t) => t.sides === 20 && !t.keep);
  }

  /** Lowest and highest possible totals. */
  function expressionRange(parsed) {
    let min = parsed.modifier || 0;
    let max = parsed.modifier || 0;
    for (const t of parsed.terms) {
      const k = t.keep ? t.keep.n : t.count;
      if (t.sign > 0) {
        min += k;
        max += k * t.sides;
      } else {
        min -= k * t.sides;
        max -= k;
      }
    }
    return { min, max };
  }

  /** Mark the n highest/lowest dice as kept (ties keep the earliest roll). */
  function applyKeep(dice, keep) {
    const order = dice.map((d, i) => i);
    order.sort((a, b) => {
      const diff = keep.type === 'h' ? dice[b].value - dice[a].value : dice[a].value - dice[b].value;
      return diff || a - b;
    });
    order.forEach((idx, rank) => {
      dice[idx].kept = rank < keep.n;
    });
    return dice;
  }

  /**
   * Roll a parsed expression (or notation string).
   * options.mode: 'normal' | 'adv' | 'dis'. Advantage/disadvantage applies to
   * every d20 in groups without an explicit keep/drop: each such d20 is rolled
   * twice and the higher (adv) or lower (dis) result is kept.
   * options.source: optional getRandomValues provider (for tests).
   */
  function rollExpression(expr, options) {
    const opts = options || {};
    const parsed = typeof expr === 'string' ? parseNotation(expr) : expr;
    if (!parsed.terms.length) throw new DiceError('Add at least one die to roll.');
    const mode = opts.mode === 'adv' || opts.mode === 'dis' ? opts.mode : 'normal';
    const source = opts.source;
    let modeApplied = false;

    const groups = parsed.terms.map((term) => {
      const dice = [];
      const adv = mode !== 'normal' && term.sides === 20 && !term.keep;
      if (adv) modeApplied = true;
      for (let i = 0; i < term.count; i++) {
        if (adv) {
          const a = randomInt(term.sides, source);
          const b = randomInt(term.sides, source);
          const keepA = mode === 'adv' ? a >= b : a <= b;
          dice.push({ value: a, kept: keepA, pair: i });
          dice.push({ value: b, kept: !keepA, pair: i });
        } else {
          dice.push({ value: randomInt(term.sides, source), kept: true });
        }
      }
      if (term.keep) applyKeep(dice, term.keep);
      let subtotal = 0;
      for (const d of dice) {
        d.sides = term.sides;
        d.crit = term.sides === 20 && d.kept && d.value === 20;
        d.fumble = term.sides === 20 && d.kept && d.value === 1;
        if (d.kept) subtotal += d.value;
      }
      return {
        count: term.count,
        sides: term.sides,
        sign: term.sign,
        keep: term.keep,
        adv,
        label: termToNotation(term),
        dice,
        subtotal: subtotal * term.sign,
      };
    });

    const modifier = parsed.modifier || 0;
    const total = groups.reduce((sum, g) => sum + g.subtotal, 0) + modifier;
    let crits = 0;
    let fumbles = 0;
    for (const g of groups) {
      for (const d of g.dice) {
        if (d.crit) crits++;
        if (d.fumble) fumbles++;
      }
    }
    return {
      notation: toNotation(parsed),
      mode: modeApplied ? mode : 'normal',
      groups,
      modifier,
      total,
      crits,
      fumbles,
      timestamp: Date.now(),
    };
  }

  function formatSigned(n) {
    return (n < 0 ? '\u2212' : '+') + Math.abs(n);
  }

  /** Compact per-die summary, e.g. "4, 5 +3" or "d20: 17, (4) · 2d6: 3, 6 +5". */
  function formatDetail(result) {
    const single = result.groups.length === 1 && result.groups[0].sign > 0;
    const parts = result.groups.map((g) => {
      const vals = g.dice.map((d) => (d.kept ? String(d.value) : '(' + d.value + ')')).join(', ');
      const label = (g.sign < 0 ? '\u2212' : '') + g.label;
      return single ? vals : label + ': ' + vals;
    });
    let out = parts.join(' \u00b7 ');
    if (result.modifier) out += ' ' + formatSigned(result.modifier);
    return out;
  }

  function modeLabel(mode) {
    return mode === 'adv' ? 'advantage' : mode === 'dis' ? 'disadvantage' : '';
  }

  /** Screen-reader friendly sentence describing a roll. */
  function describeRoll(result) {
    const mode = modeLabel(result.mode);
    const parts = result.groups.map((g) => {
      const kept = g.dice.filter((d) => d.kept).map((d) => d.value);
      const dropped = g.dice.filter((d) => !d.kept).map((d) => d.value);
      let s = (g.sign < 0 ? 'minus ' : '') + g.label + ': ' + kept.join(', ');
      if (dropped.length) s += ' (dropped ' + dropped.join(', ') + ')';
      return s;
    });
    let out = 'Rolled ' + result.notation + (mode ? ' with ' + mode : '') + '. ' + parts.join('; ');
    if (result.modifier) {
      out += '; modifier ' + (result.modifier > 0 ? 'plus ' : 'minus ') + Math.abs(result.modifier);
    }
    out += '. Total ' + result.total + '.';
    if (result.crits) out += result.crits > 1 ? ' ' + result.crits + ' natural 20s!' : ' Natural 20!';
    if (result.fumbles) out += result.fumbles > 1 ? ' ' + result.fumbles + ' natural 1s.' : ' Natural 1.';
    return out;
  }

  return {
    DICE,
    LIMITS,
    DiceError,
    randomInt,
    parseNotation,
    toNotation,
    termToNotation,
    fromPool,
    poolToNotation,
    toPool,
    countDice,
    hasAdvantageTarget,
    expressionRange,
    applyKeep,
    rollExpression,
    formatDetail,
    formatSigned,
    describeRoll,
    modeLabel,
  };
});
