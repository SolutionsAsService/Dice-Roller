// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import P from '../dice-profiles.js';
import Dice from '../dice-core.js';

/** Deterministic cosmetic rng for names/ids. */
function seq(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const OPTS = () => ({ rng: seq(7), now: 1_700_000_000_000 });

/** In-memory Storage double. */
class MemoryStorage {
  constructor(init) { this.map = new Map(Object.entries(init || {})); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
/** Storage that throws on every access (e.g. blocked cookies / sandboxed iframe). */
const brokenStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
  removeItem() { throw new Error('SecurityError'); },
};
/** Storage that reads fine but refuses writes (quota exceeded / private mode). */
class FullStorage extends MemoryStorage {
  setItem() { throw new Error('QuotaExceededError'); }
}

/** Fake getRandomValues replaying uint32 values (face v = raw v-1). */
function queueSource(values) {
  const q = [...values];
  return { getRandomValues(buf) { buf[0] = q.shift(); return buf; }, get remaining() { return q.length; } };
}

// ------------------------------------------------------------------ schema
test('default data is a valid v1 document with one player and a full bag of dice', () => {
  const d = P.defaultData(OPTS());
  assert.equal(d.version, P.SCHEMA_VERSION);
  assert.equal(d.players.length, 1);
  const p = P.activePlayer(d);
  assert.equal(p.id, d.activeId);
  assert.deepEqual(p.look, { theme: 'classic', body: null, ink: null, finish: 'glossy' });
  for (const s of P.TRACKED) {
    assert.equal(p.dice[s].sides, s);
    assert.equal(p.dice[s].faces.length, s);
    assert.equal(P.dieStats(p.dice[s]).rolls, 0);
    assert.ok(p.dice[s].name.length > 0);
  }
  assert.deepEqual(p.graveyard, []);
});

test('serialize/parse round-trips without loss', () => {
  const d = P.defaultData(OPTS());
  const p = P.activePlayer(d);
  P.updateLook(p, { theme: 'bard' });
  P.recordRoll(p, { groups: [{ sides: 20, dice: [{ value: 20 }, { value: 3 }] }] });
  P.setLucky(p, 20, true);
  P.burnDie(p, 6, { epitaph: 'Too many ones.', now: 5 });
  const r = P.parse(P.serialize(d));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, JSON.parse(P.serialize(d)));
});

test('normalizeData repairs bad fields instead of crashing', () => {
  const r = P.normalizeData({
    version: 1,
    activeId: 'nope',
    players: [
      null,
      42,
      { id: 'a', name: '   ', look: { theme: 'bogus', body: 'red', finish: 'lava' },
        dice: { 20: { id: 'x', sides: 20, name: 'Kev', faces: [1, -3, 'x', 2.7, null], recent: [1, 99, 'a', 4], lucky: true },
          6: { sides: 8 }, 8: { lucky: true } },
        graveyard: [{ sides: 7 }, 'junk', { sides: 4, id: 'g', name: 'Old', died: 'yesterday', faces: [1] }] },
      { id: 'a', name: 'Dup <b>' },
    ],
  }, OPTS());
  assert.equal(r.players.length, 2);
  const [a, dup] = r.players;
  assert.notEqual(dup.id, a.id, 'duplicate ids are re-issued');
  assert.equal(r.activeId, a.id, 'unknown active id falls back to the first player');
  assert.equal(a.name, 'Adventurer');
  assert.deepEqual(a.look, { theme: 'classic', body: null, ink: null, finish: 'glossy' });
  const d20 = a.dice[20];
  assert.equal(d20.faces.length, 20);
  assert.deepEqual(d20.faces.slice(0, 5), [1, 0, 0, 2, 0]);
  assert.deepEqual(d20.recent, [1, 4]);
  assert.equal(a.dice[8].lucky, true, 'first lucky die in rack order keeps the title');
  assert.equal(d20.lucky, false, 'only one lucky die survives');
  assert.equal(a.dice[6].sides, 6, 'mismatched die replaced by a fresh d6');
  assert.equal(a.graveyard.length, 1);
  assert.equal(a.graveyard[0].cause, 'burned');
  assert.equal(a.graveyard[0].epitaph, 'No last words.');
  assert.ok(Number.isFinite(a.graveyard[0].died));
  assert.equal(dup.name, 'Dup <b>', 'names are stored as text (escaped at render time)');
});

test('names, colours and epitaphs are sanitised', () => {
  assert.equal(P.sanitizeName('  Zed\n\tthe   Great  '), 'Zed the Great');
  assert.equal(P.sanitizeName('x'.repeat(100)).length, P.MAX_NAME);
  assert.equal(P.sanitizeName(''), 'Adventurer');
  assert.equal(P.sanitizeColor('#ABC'), '#aabbcc');
  assert.equal(P.sanitizeColor('12ab34'), '#12ab34');
  assert.equal(P.sanitizeColor('url(javascript:1)'), null);
  assert.equal(P.sanitizeColor('#12345'), null);
  const p = P.newPlayer('A', OPTS());
  const { burned } = P.burnDie(p, 4, { epitaph: 'a'.repeat(500) });
  assert.equal(burned.epitaph.length, P.MAX_EPITAPH);
});

test('looks: presets, custom colours and finishes', () => {
  const p = P.newPlayer('A', OPTS());
  assert.deepEqual(P.updateLook(p, { theme: 'hoard' }), { theme: 'hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'metal' });
  assert.deepEqual(P.updateLook(p, { finish: 'gem' }), { theme: 'hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'gem' });
  assert.deepEqual(P.updateLook(p, { body: '#112233' }), { theme: 'custom', body: '#112233', ink: '#3a1f05', finish: 'gem' });
  assert.deepEqual(P.updateLook(p, { ink: 'nonsense', finish: 'plasma' }), { theme: 'custom', body: '#112233', ink: '#3a1f05', finish: 'gem' });
  assert.deepEqual(P.updateLook(p, { theme: 'classic' }), { theme: 'classic', body: null, ink: null, finish: 'glossy' });
});

// --------------------------------------------------------------- migration
test('v0 data (bare array or unversioned object) migrates to v1', () => {
  const arr = P.parse(JSON.stringify([{ name: 'Alice', color: '#f00', ink: '#fff' }, 'Bob', 7]), OPTS());
  assert.equal(arr.status, 'migrated');
  assert.equal(arr.from, 0);
  assert.equal(arr.data.version, 1);
  assert.deepEqual(arr.data.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.deepEqual(arr.data.players[0].look, { theme: 'custom', body: '#ff0000', ink: '#ffffff', finish: 'glossy' });
  assert.equal(arr.data.players[1].look.theme, 'classic');

  const obj = P.parse(JSON.stringify({ active: 'b', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', color: '00ff00' }] }), OPTS());
  assert.equal(obj.status, 'migrated');
  assert.equal(obj.data.activeId, 'b');
  assert.equal(obj.data.players[1].look.body, '#00ff00');
  for (const p of obj.data.players) for (const s of P.TRACKED) assert.equal(p.dice[s].faces.length, s);
});

test('data from a newer version is refused, not mangled', () => {
  const text = JSON.stringify({ version: 99, players: [{ name: 'Future' }] });
  const r = P.parse(text, OPTS());
  assert.equal(r.status, 'future');
  assert.equal(r.data.players[0].name, 'Adventurer');
  assert.throws(() => P.migrate({ version: 2 }), P.ProfileError);
  assert.throws(() => P.migrate({ version: 'one' }), P.ProfileError);
});

// ------------------------------------------------------------ corrupt data
test('corrupt or empty storage falls back to fresh profiles', () => {
  for (const bad of ['{not json', '"a string"', '42', 'null', 'true']) {
    const r = P.parse(bad, OPTS());
    assert.equal(r.status, 'corrupt', bad);
    assert.equal(r.data.players.length, 1);
  }
  assert.equal(P.parse(null).status, 'empty');
  assert.equal(P.parse('').status, 'empty');
  const emptyPlayers = P.parse(JSON.stringify({ version: 1, players: [] }), OPTS());
  assert.equal(emptyPlayers.status, 'ok');
  assert.equal(emptyPlayers.data.players.length, 1);
});

test('load() backs up unreadable data before it can be overwritten', () => {
  const store = new MemoryStorage({ [P.STORAGE_KEY]: '{"version":1,"players":[{"name":"Ali' });
  const r = P.load(store, OPTS());
  assert.equal(r.status, 'corrupt');
  assert.equal(r.persistent, true);
  assert.equal(store.getItem(P.BACKUP_KEY), '{"version":1,"players":[{"name":"Ali');
  assert.ok(P.save(store, r.data));
  assert.equal(P.load(store, OPTS()).status, 'ok');

  const future = new MemoryStorage({ [P.STORAGE_KEY]: '{"version":7}' });
  assert.equal(P.load(future, OPTS()).status, 'future');
  assert.equal(future.getItem(P.BACKUP_KEY), '{"version":7}');
});

test('missing, throwing or full storage never breaks the app', () => {
  for (const s of [null, undefined, brokenStorage]) {
    const r = P.load(s, OPTS());
    assert.equal(r.persistent, false);
    assert.equal(r.data.players.length, 1);
    assert.equal(P.save(s, r.data), false);
  }
  const full = new FullStorage();
  assert.equal(P.probeStorage(full), false);
  const r = P.load(full, OPTS());
  assert.equal(r.persistent, false);
  assert.equal(P.save(full, r.data), false);
  assert.equal(P.probeStorage(new MemoryStorage()), true);
});

// ------------------------------------------------------------------ players
test('add, switch, cycle and remove players', () => {
  const d = P.defaultData(OPTS());
  const first = d.activeId;
  const b = P.addPlayer(d, 'Bea', OPTS());
  assert.equal(d.activeId, b.id, 'new player becomes active');
  const c = P.addPlayer(d, '', OPTS());
  assert.equal(c.name, 'Player 3');
  assert.equal(P.cyclePlayer(d, 1).id, first, 'wraps forward');
  assert.equal(P.cyclePlayer(d, -1).id, c.id, 'wraps backward');
  assert.equal(P.setActive(d, 'missing'), false);
  assert.ok(P.setActive(d, b.id));
  P.removePlayer(d, b.id);
  assert.equal(d.players.length, 2);
  assert.equal(d.activeId, c.id, 'active moves to a neighbour');
  P.removePlayer(d, c.id);
  assert.throws(() => P.removePlayer(d, first), P.ProfileError);
  while (d.players.length < P.MAX_PLAYERS) P.addPlayer(d, 'x', OPTS());
  assert.throws(() => P.addPlayer(d, 'one too many'), P.ProfileError);
});

test('players keep separate dice, stats and graveyards', () => {
  const d = P.defaultData(OPTS());
  const a = P.activePlayer(d);
  const b = P.addPlayer(d, 'B', OPTS());
  P.recordRoll(a, { groups: [{ sides: 20, dice: [{ value: 1 }] }] });
  P.burnDie(b, 20, {});
  assert.equal(P.dieStats(a.dice[20]).rolls, 1);
  assert.equal(P.dieStats(b.dice[20]).rolls, 0);
  assert.equal(a.graveyard.length, 0);
  assert.equal(b.graveyard.length, 1);
});

// -------------------------------------------------------------------- stats
test('recordRoll credits every rolled die (dropped ones too) and leaves the result untouched', () => {
  const p = P.newPlayer('A', OPTS());
  const source = queueSource([19, 0, 3, 5, 2]); // adv d20: 20 & 1; 3d6: 4, 6, 3
  const result = Dice.rollExpression('d20+3d6+2', { mode: 'adv', source });
  const snapshot = JSON.stringify(result);
  const credited = P.recordRoll(p, result);
  assert.equal(JSON.stringify(result), snapshot, 'result not modified');
  assert.deepEqual(credited.map((c) => [c.sides, c.values]), [[20, [20, 1]], [6, [4, 6, 3]]]);
  const s20 = P.dieStats(p.dice[20]);
  assert.equal(s20.rolls, 2);
  assert.equal(s20.natMax, 1);
  assert.equal(s20.natMin, 1);
  assert.equal(s20.average, 10.5);
  const s6 = P.dieStats(p.dice[6]);
  assert.equal(s6.rolls, 3);
  assert.equal(s6.sum, 13);
  assert.deepEqual(p.dice[6].recent, [4, 6, 3]);
});

test('recordRoll ignores non-standard dice and garbage', () => {
  const p = P.newPlayer('A', OPTS());
  const result = Dice.rollExpression('3d7+d1000', { source: queueSource([0, 1, 2, 999]) });
  assert.deepEqual(P.recordRoll(p, result), []);
  assert.deepEqual(P.recordRoll(p, null), []);
  assert.deepEqual(P.recordRoll(p, { groups: [{ sides: 6, dice: [{ value: 9 }, { value: 0 }, {}] }] }), []);
  for (const s of P.TRACKED) assert.equal(P.dieStats(p.dice[s]).rolls, 0);
});

test('d100 rolls are tracked on all 100 faces', () => {
  const p = P.newPlayer('A', OPTS());
  P.recordRoll(p, Dice.rollExpression('2d100', { source: queueSource([99, 0]) }));
  const st = P.dieStats(p.dice[100]);
  assert.equal(st.rolls, 2);
  assert.equal(st.natMax, 1);
  assert.equal(st.natMin, 1);
});

test('recent rolls are capped at 20', () => {
  const p = P.newPlayer('A', OPTS());
  for (let i = 0; i < 30; i++) P.recordRoll(p, { groups: [{ sides: 4, dice: [{ value: (i % 4) + 1 }] }] });
  assert.equal(p.dice[4].recent.length, 20);
  assert.equal(P.dieStats(p.dice[4]).rolls, 30);
});

test('luck verdicts wait for a sample, then compare against a fair die', () => {
  const die = P.newDie(20, OPTS());
  assert.equal(P.dieStats(die).verdict.key, 'new');
  die.faces[19] = 5;
  assert.equal(P.dieStats(die).verdict.key, 'early');
  const fair = P.newDie(20, OPTS());
  fair.faces = fair.faces.map(() => 2); // perfectly flat: 40 rolls, avg 10.5
  assert.equal(P.dieStats(fair).average, 10.5);
  assert.equal(P.dieStats(fair).verdict.key, 'fair');
  const hot = P.newDie(20, OPTS());
  hot.faces[19] = 15; hot.faces[17] = 15; // avg 19
  assert.equal(P.dieStats(hot).verdict.key, 'blessed');
  const cold = P.newDie(20, OPTS());
  cold.faces[0] = 20; cold.faces[9] = 10;
  assert.equal(P.dieStats(cold).verdict.key, 'cursed');
});

test('only one lucky die per player; toggling clears it', () => {
  const p = P.newPlayer('A', OPTS());
  assert.equal(P.luckyDie(p), null);
  assert.equal(P.setLucky(p, 20), true);
  assert.equal(P.luckyDie(p).sides, 20);
  P.setLucky(p, 8, true);
  assert.equal(P.luckyDie(p).sides, 8);
  assert.equal(p.dice[20].lucky, false);
  assert.equal(P.setLucky(p, 8), false);
  assert.equal(P.luckyDie(p), null);
  assert.equal(P.setLucky(p, 7), false);
});

// ------------------------------------------------------------ burn & pardon
test('burning retires the die with its stats and replaces it with a fresh one', () => {
  const p = P.newPlayer('A', OPTS());
  const old = p.dice[20];
  P.recordRoll(p, { groups: [{ sides: 20, dice: [{ value: 1 }, { value: 1 }, { value: 2 }] }] });
  P.setLucky(p, 20, true);
  const { burned, replacement } = P.burnDie(p, 20, { now: 123, rng: seq(3) });
  assert.equal(burned.id, old.id);
  assert.equal(burned.cause, 'burned');
  assert.equal(burned.died, 123);
  assert.equal(burned.epitaph, 'Was supposed to be the lucky one.');
  assert.equal(P.dieStats(burned).rolls, 3, 'sad stats preserved');
  assert.equal(p.graveyard[0], burned);
  assert.equal(p.dice[20], replacement);
  assert.notEqual(replacement.id, old.id);
  assert.notEqual(replacement.name, old.name);
  assert.equal(P.dieStats(replacement).rolls, 0);
  assert.equal(replacement.lucky, false, 'the lucky title burns with the die');
  // Stats now go to the replacement.
  P.recordRoll(p, { groups: [{ sides: 20, dice: [{ value: 17 }] }] });
  assert.equal(P.dieStats(p.dice[20]).rolls, 1);
  assert.equal(P.dieStats(p.graveyard[0]).rolls, 3);
});

test('epitaphs reflect the crime', () => {
  const opts = { rng: () => 0 };
  const die = P.newDie(20, OPTS());
  assert.match(P.autoEpitaph(die, opts), /Pre-emptive/);
  die.faces[0] = 3; die.faces[9] = 7;
  assert.match(P.autoEpitaph(die, opts), /3 natural 1s in 10 rolls/);
  const d6 = P.newDie(6, OPTS());
  d6.faces[1] = 6; d6.faces[2] = 2; // avg 2.25, no ones
  assert.match(P.autoEpitaph(d6, opts), /Averaged 2\.3 when 3\.5/);
  const d8 = P.newDie(8, OPTS());
  d8.faces[7] = 1; d8.recent = [8];
  assert.ok(P.autoEpitaph(d8, opts).length > 5);
  const p = P.newPlayer('A', OPTS());
  assert.equal(P.burnDie(p, 4, { epitaph: '  Custom   words ' }).burned.epitaph, 'Custom words');
});

test('the Hall of Shame is capped', () => {
  const p = P.newPlayer('A', OPTS());
  for (let i = 0; i < P.MAX_GRAVEYARD + 5; i++) P.burnDie(p, 6, { now: i + 1 });
  assert.equal(p.graveyard.length, P.MAX_GRAVEYARD);
  assert.equal(p.graveyard[0].died, P.MAX_GRAVEYARD + 5, 'newest first');
});

test('pardoning restores the old die; a used replacement retires, an unused one vanishes', () => {
  const p = P.newPlayer('A', OPTS());
  P.recordRoll(p, { groups: [{ sides: 12, dice: [{ value: 1 }] }] });
  const { burned, replacement } = P.burnDie(p, 12, {});
  // Unused replacement: discarded.
  let r = P.resurrectDie(p, burned.id, { now: 9 });
  assert.equal(r.displaced, null);
  assert.equal(p.dice[12].id, burned.id);
  assert.equal(p.dice[12].died, undefined);
  assert.equal(p.dice[12].epitaph, undefined);
  assert.equal(P.dieStats(p.dice[12]).rolls, 1);
  assert.equal(p.graveyard.length, 0);
  assert.ok(!p.graveyard.some((g) => g.id === replacement.id));
  // Used replacement: retires to the Hall.
  const second = P.burnDie(p, 12, {});
  P.recordRoll(p, { groups: [{ sides: 12, dice: [{ value: 12 }] }] });
  r = P.resurrectDie(p, second.burned.id, { now: 10 });
  assert.equal(r.displaced.id, second.replacement.id);
  assert.equal(r.displaced.cause, 'retired');
  assert.match(r.displaced.epitaph, /Stepped aside/);
  assert.equal(p.graveyard[0].id, second.replacement.id);
  assert.throws(() => P.resurrectDie(p, 'nope'), P.ProfileError);
  assert.ok(P.scatterAshes(p, second.replacement.id));
  assert.equal(p.graveyard.length, 0);
});

test('a pardoned lucky die does not create a second lucky die', () => {
  const p = P.newPlayer('A', OPTS());
  P.setLucky(p, 20, true);
  const { burned } = P.burnDie(p, 20, {});
  P.setLucky(p, 8, true);
  P.resurrectDie(p, burned.id, {});
  assert.equal(P.TRACKED.filter((s) => p.dice[s].lucky).length, 1);
  assert.equal(P.luckyDie(p).sides, 8);
});

// ------------------------------------------------------------ export/import
test('export/import merges players by id and validates input', () => {
  const home = P.defaultData(OPTS());
  const away = P.defaultData({ rng: seq(99), now: 2 });
  P.activePlayer(away).name = 'Visitor';
  const json = P.exportJSON(away);
  assert.equal(JSON.parse(json).version, P.SCHEMA_VERSION);
  assert.deepEqual(P.importJSON(home, json), { added: 1, replaced: 0, skipped: 0 });
  assert.deepEqual(home.players.map((p) => p.name), ['Adventurer', 'Visitor']);
  P.activePlayer(away).name = 'Visitor 2';
  assert.deepEqual(P.importJSON(home, P.exportJSON(away)), { added: 0, replaced: 1, skipped: 0 });
  assert.equal(home.players[1].name, 'Visitor 2');
  assert.throws(() => P.importJSON(home, 'nope'), P.ProfileError);
  assert.throws(() => P.importJSON(home, '{"hello":1}'), P.ProfileError);
  assert.throws(() => P.importJSON(home, '{"version":42,"players":[{}]}'), P.ProfileError);
  assert.equal(home.players.length, 2, 'failed imports change nothing');
});

// ---------------------------------------------------------------- fairness
test('profiles never touch the RNG: identical random streams give identical rolls', () => {
  const raw = Array.from({ length: 50 }, (_, i) => (i * 2654435761) >>> 0);
  const plain = Dice.rollExpression('4d20+2d6', { mode: 'adv', source: queueSource(raw) });
  const p = P.newPlayer('A', OPTS());
  P.setLucky(p, 20, true);
  P.updateLook(p, { theme: 'lich' });
  P.burnDie(p, 6, {});
  const src = queueSource(raw);
  const tracked = Dice.rollExpression('4d20+2d6', { mode: 'adv', source: src });
  P.recordRoll(p, tracked);
  const strip = (r) => JSON.stringify(Object.assign({}, r, { timestamp: 0 }));
  assert.equal(strip(tracked), strip(plain));
});

test('dice-profiles.js has no access to the dice RNG', () => {
  const src = readFileSync(new URL('../dice-profiles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /getRandomValues|randomInt|rollExpression|crypto/);
});
