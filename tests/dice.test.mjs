// Run with: node --test tests/   (or: npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import Dice from '../dice-core.js';

// Node 18 has no global Web Crypto (browsers and Node 20+ do); DiceCore reads it lazily.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { DICE, randomInt, parseNotation, toNotation, rollExpression, poolToNotation, toPool,
  expressionRange, hasAdvantageTarget, formatDetail, describeRoll, DiceError } = Dice;

/** Fake getRandomValues that replays a queue of raw uint32 values. */
function queueSource(values) {
  const q = [...values];
  return {
    getRandomValues(buf) {
      if (!q.length) throw new Error('queue exhausted');
      buf[0] = q.shift();
      return buf;
    },
    get remaining() { return q.length; },
  };
}
/** Raw uint32 value that maps to face v (for any die size). */
const face = (v) => v - 1;

test('randomInt stays in bounds and hits every face for each standard die', () => {
  for (const sides of DICE) {
    const seen = new Set();
    const n = sides * 200;
    for (let i = 0; i < n; i++) {
      const v = randomInt(sides);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= sides, 'd' + sides + ' produced ' + v);
      seen.add(v);
    }
    assert.equal(seen.size, sides, 'd' + sides + ' should show every face');
  }
});

test('randomInt uses rejection sampling (no modulo bias)', () => {
  // For a d6, 2^32 % 6 = 4, so the 4 highest raw values must be rejected.
  const limit = 2 ** 32 - (2 ** 32 % 6);
  const src = queueSource([2 ** 32 - 1, limit, 7]);
  assert.equal(randomInt(6, src), (7 % 6) + 1);
  assert.equal(src.remaining, 0, 'both out-of-range values were rejected and consumed');
  // Highest accepted value is fine.
  assert.equal(randomInt(6, queueSource([limit - 1])), ((limit - 1) % 6) + 1);
  // Powers of two never reject.
  assert.equal(randomInt(4, queueSource([2 ** 32 - 1])), 4);
  assert.equal(randomInt(1), 1);
  assert.throws(() => randomInt(0), RangeError);
  assert.throws(() => randomInt(2.5), RangeError);
});

test('randomInt is roughly uniform (chi-square sanity check)', () => {
  for (const [sides, critical] of [[6, 30], [20, 60]]) {
    const n = 60000;
    const counts = new Array(sides).fill(0);
    for (let i = 0; i < n; i++) counts[randomInt(sides) - 1]++;
    const expected = n / sides;
    const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    assert.ok(chi < critical, 'd' + sides + ' chi-square ' + chi.toFixed(2) + ' too high');
  }
});

test('parseNotation handles common formulas', () => {
  assert.deepEqual(parseNotation('2d6+3'), { terms: [{ count: 2, sides: 6, sign: 1, keep: null }], modifier: 3 });
  assert.deepEqual(parseNotation('d20'), { terms: [{ count: 1, sides: 20, sign: 1, keep: null }], modifier: 0 });
  assert.deepEqual(parseNotation('D%').terms[0], { count: 1, sides: 100, sign: 1, keep: null });
  const multi = parseNotation(' 1d8 + 2d6 - 1d4 - 2 + 5 ');
  assert.equal(multi.terms.length, 3);
  assert.equal(multi.terms[2].sign, -1);
  assert.equal(multi.modifier, 3);
  assert.deepEqual(parseNotation('4d6kh3').terms[0].keep, { type: 'h', n: 3 });
  assert.deepEqual(parseNotation('4d6k3').terms[0].keep, { type: 'h', n: 3 });
  assert.deepEqual(parseNotation('4d6dl1').terms[0].keep, { type: 'h', n: 3 });
  assert.deepEqual(parseNotation('2d20kl1').terms[0].keep, { type: 'l', n: 1 });
  assert.deepEqual(parseNotation('3d6dh1').terms[0].keep, { type: 'l', n: 2 });
  assert.equal(parseNotation('2d6kh2').terms[0].keep, null, 'keeping all is a no-op');
  assert.deepEqual(parseNotation('5'), { terms: [], modifier: 5 });
  assert.equal(parseNotation('d20\u22121').modifier, -1, 'unicode minus');
});

test('parseNotation rejects bad input with friendly errors', () => {
  for (const bad of ['', '   ', 'abc', '2d', 'd', '0d6', '101d6', '2d6+', '3d6 4', '2 d6', 'd0', 'd1',
    'd1001', '5d6kh6', '4d6dl4', '2d6**2', '100d6+100d6+1d6', '1d6+99999', 'x'.repeat(201)]) {
    assert.throws(() => parseNotation(bad), DiceError, JSON.stringify(bad));
  }
  assert.throws(() => parseNotation(42), DiceError);
});

test('toNotation round-trips canonical notation', () => {
  for (const s of ['2d6+3', 'd20', 'd100', '4d6kh3', '2d20kl1', 'd8+3d6+4', 'd20-d4-1', '-2', '3d12-5']) {
    assert.equal(toNotation(parseNotation(s)), s);
  }
  assert.equal(toNotation(parseNotation('4d6dl1')), '4d6kh3');
  assert.equal(toNotation(parseNotation('1D20 + 0')), 'd20');
});

test('pool <-> notation conversion', () => {
  assert.equal(poolToNotation({ 4: 0, 6: 2, 20: 1 }, 3), '2d6+d20+3');
  assert.equal(poolToNotation({}, 0), '');
  assert.equal(poolToNotation({ 100: 1 }, -2), 'd100-2');
  const p = toPool(parseNotation('d6+d6+d20+1'));
  assert.equal(p.pool[6], 2);
  assert.equal(p.pool[20], 1);
  assert.equal(p.modifier, 1);
  assert.equal(toPool(parseNotation('4d6kh3')), null);
  assert.equal(toPool(parseNotation('d20-d4')), null);
  assert.equal(toPool(parseNotation('3d7')), null);
});

test('expressionRange gives min/max', () => {
  assert.deepEqual(expressionRange(parseNotation('2d6+3')), { min: 5, max: 15 });
  assert.deepEqual(expressionRange(parseNotation('4d6kh3')), { min: 3, max: 18 });
  assert.deepEqual(expressionRange(parseNotation('d20-d4')), { min: -3, max: 19 });
  assert.deepEqual(expressionRange(parseNotation('d100')), { min: 1, max: 100 });
});

test('roll totals always fall inside the expression range', () => {
  for (const s of ['2d6+3', '4d6kh3', 'd20-d4+2', '3d8dl1', 'd100', '10d4-10', 'd12+d10+d8']) {
    const parsed = parseNotation(s);
    const { min, max } = expressionRange(parsed);
    for (let i = 0; i < 2000; i++) {
      for (const mode of ['normal', 'adv', 'dis']) {
        const r = rollExpression(parsed, { mode });
        assert.ok(r.total >= min && r.total <= max, s + ' rolled ' + r.total);
        const recomputed = r.groups.reduce((t, g) =>
          t + g.sign * g.dice.filter((d) => d.kept).reduce((a, d) => a + d.value, 0), 0) + r.modifier;
        assert.equal(r.total, recomputed);
      }
    }
  }
});

test('keep highest / drop lowest marks the right dice', () => {
  // 4d6kh3 with faces 2, 6, 1, 6 -> keeps 2, 6, 6 = 14
  const r = rollExpression('4d6kh3', { source: queueSource([2, 6, 1, 6].map(face)) });
  assert.deepEqual(r.groups[0].dice.map((d) => d.kept), [true, true, false, true]);
  assert.equal(r.total, 14);
  // 3d6kl1 with ties: 4, 2, 2 -> keeps the first 2
  const r2 = rollExpression('3d6kl1', { source: queueSource([4, 2, 2].map(face)) });
  assert.deepEqual(r2.groups[0].dice.map((d) => d.kept), [false, true, false]);
  assert.equal(r2.total, 2);
});

test('advantage keeps the higher d20, disadvantage the lower', () => {
  const adv = rollExpression('d20+5', { mode: 'adv', source: queueSource([7, 15].map(face)) });
  assert.equal(adv.mode, 'adv');
  assert.equal(adv.groups[0].dice.length, 2);
  assert.equal(adv.total, 20);
  const dis = rollExpression('d20+5', { mode: 'dis', source: queueSource([7, 15].map(face)) });
  assert.equal(dis.total, 12);
  // Mode does not affect other dice, and is reported as normal when unused.
  const none = rollExpression('2d6', { mode: 'adv', source: queueSource([3, 4].map(face)) });
  assert.equal(none.mode, 'normal');
  assert.equal(none.total, 7);
  assert.equal(hasAdvantageTarget(parseNotation('2d20kh1')), false);
  assert.equal(hasAdvantageTarget(parseNotation('d20+d6')), true);
  // Statistical: advantage averages higher than disadvantage (expected 13.825 vs 7.175).
  let a = 0, d = 0;
  for (let i = 0; i < 5000; i++) {
    a += rollExpression('d20', { mode: 'adv' }).total;
    d += rollExpression('d20', { mode: 'dis' }).total;
  }
  assert.ok(a / 5000 > 12.5 && d / 5000 < 8.5, 'adv avg ' + a / 5000 + ', dis avg ' + d / 5000);
});

test('crits and fumbles are flagged only on kept d20s', () => {
  const crit = rollExpression('d20', { source: queueSource([face(20)]) });
  assert.equal(crit.crits, 1);
  assert.ok(crit.groups[0].dice[0].crit);
  const fumble = rollExpression('d20', { source: queueSource([face(1)]) });
  assert.equal(fumble.fumbles, 1);
  // A dropped natural 1 under advantage is not a fumble.
  const adv = rollExpression('d20', { mode: 'adv', source: queueSource([face(1), face(20)]) });
  assert.equal(adv.fumbles, 0);
  assert.equal(adv.crits, 1);
  // 20 on a d100 or 6 on a d6 is not a crit.
  const other = rollExpression('d100+d6', { source: queueSource([face(20), face(6)]) });
  assert.equal(other.crits + other.fumbles, 0);
});

test('rolling with no dice is rejected', () => {
  assert.throws(() => rollExpression('5'), DiceError);
});

test('formatDetail and describeRoll produce readable text', () => {
  const r = rollExpression('2d6+3', { source: queueSource([4, 5].map(face)) });
  assert.equal(formatDetail(r), '4, 5 +3');
  assert.match(describeRoll(r), /Rolled 2d6\+3\. 2d6: 4, 5; modifier plus 3\. Total 12\./);
  const adv = rollExpression('d20-1', { mode: 'adv', source: queueSource([face(3), face(20)]) });
  assert.equal(formatDetail(adv), '(3), 20 \u22121');
  assert.match(describeRoll(adv), /with advantage.*dropped 3.*Natural 20!/);
});
