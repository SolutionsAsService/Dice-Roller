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

const first = (p, s) => p.bag[s][0];

// ------------------------------------------------------------------ schema
test('default data is a valid v2 document with one player and one die per type in the bag', () => {
  const d = P.defaultData(OPTS());
  assert.equal(d.version, P.SCHEMA_VERSION);
  assert.equal(P.SCHEMA_VERSION, 2);
  assert.equal(d.players.length, 1);
  const p = P.activePlayer(d);
  assert.equal(p.id, d.activeId);
  assert.deepEqual(p.look, { theme: 'classic', body: null, ink: null, finish: 'glossy' });
  assert.deepEqual(p.hand, {});
  assert.equal(p.dice, undefined, 'the v1 single-die field is gone');
  for (const s of P.TRACKED) {
    assert.equal(p.bag[s].length, 1);
    const die = first(p, s);
    assert.equal(die.sides, s);
    assert.equal(die.faces.length, s);
    assert.equal(die.style, null, 'new dice wear the player look');
    assert.equal(P.dieStats(die).rolls, 0);
    assert.ok(die.name.length > 0);
  }
  assert.deepEqual(p.graveyard, []);
});

test('serialize/parse round-trips without loss (slots, hand, styles, graveyard)', () => {
  const d = P.defaultData(OPTS());
  const p = P.activePlayer(d);
  P.updateLook(p, { theme: 'bard' });
  const extra = P.addDie(p, 20, OPTS());
  P.setDieStyle(p, extra.id, 'galaxy');
  P.toggleHand(p, extra.id);
  P.recordRoll(p, { groups: [{ sides: 20, dice: [{ value: 20 }, { value: 3 }] }] });
  P.setLucky(p, extra.id, true);
  P.burnDie(p, 6, { epitaph: 'Too many ones.', now: 5 });
  const r = P.parse(P.serialize(d));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, JSON.parse(P.serialize(d)));
});

test('normalizeData repairs bad v2 fields instead of crashing', () => {
  const r = P.normalizeData({
    version: 2,
    activeId: 'nope',
    players: [
      null,
      42,
      { id: 'a', name: '   ', look: { theme: 'bogus', body: 'red', finish: 'lava' },
        bag: {
          20: [{ id: 'x', sides: 20, name: 'Kev', faces: [1, -3, 'x', 2.7, null], recent: [1, 99, 'a', 4], lucky: true }, 'junk', { id: 'x', sides: 20 }],
          6: { sides: 6, id: 'solo', name: 'Single' }, // an object where a list belongs
          8: [{ lucky: true, id: 'e' }, { sides: 10 }],
          12: 'nope',
          4: Array.from({ length: 30 }, (_, i) => ({ id: 'f' + i })),
        },
        hand: { 20: ['x', 'x', 'ghost', 7], 8: ['solo'], 6: 'nope' },
        graveyard: [{ sides: 7 }, 'junk', { sides: 4, id: 'g', name: 'Old', died: 'yesterday', faces: [1], slot: 99 }] },
      { id: 'a', name: 'Dup <b>' },
    ],
  }, OPTS());
  assert.equal(r.players.length, 2);
  const [a, dup] = r.players;
  assert.notEqual(dup.id, a.id, 'duplicate ids are re-issued');
  assert.equal(r.activeId, a.id, 'unknown active id falls back to the first player');
  assert.equal(a.name, 'Adventurer');
  assert.deepEqual(a.look, { theme: 'classic', body: null, ink: null, finish: 'glossy' });
  const d20 = a.bag[20];
  assert.equal(d20.length, 2, 'junk entries dropped');
  assert.notEqual(d20[1].id, d20[0].id, 'duplicate die ids re-issued');
  assert.deepEqual(d20[0].faces.slice(0, 5), [1, 0, 0, 2, 0]);
  assert.deepEqual(d20[0].recent, [1, 4]);
  assert.equal(a.bag[6].length, 1);
  assert.equal(a.bag[6][0].name, 'Single');
  assert.equal(a.bag[8].length, 1, 'wrong-type die dropped');
  assert.equal(a.bag[8][0].lucky, true, 'first lucky die in rack order keeps the title');
  assert.equal(d20[0].lucky, false, 'only one lucky die survives');
  assert.equal(a.bag[12].length, 1, 'garbage bag replaced by a fresh die');
  assert.equal(a.bag[4].length, P.MAX_PER_TYPE, 'capped at ' + P.MAX_PER_TYPE);
  assert.deepEqual(a.hand, { 20: ['x'] }, 'unknown, duplicate and wrong-type picks dropped');
  assert.equal(a.graveyard.length, 1);
  assert.equal(a.graveyard[0].cause, 'burned');
  assert.equal(a.graveyard[0].epitaph, 'No last words.');
  assert.equal(a.graveyard[0].slot, undefined, 'out-of-range slot dropped');
  assert.ok(Number.isFinite(a.graveyard[0].died));
  assert.equal(dup.name, 'Dup <b>', 'names are stored as text (escaped at render time)');
});

test('corrupt per-die styles are repaired field by field', () => {
  const r = P.normalizeData({ version: 2, players: [{ id: 'p', bag: { 6: [
    { id: 'a', style: { body: 'javascript:alert(1)', ink: '#FFF', finish: 'plasma', pattern: 'zebra', font: 'comic',
      opacity: -5, glow: 99, inlay: 'bomb', inlayText: '<script>', pips: 'yes', edge: 12 } },
    { id: 'b', style: 'red' },
    { id: 'c', style: { inlay: 'text', inlayText: '  ' } },
    { id: 'd', style: { inlay: 'text', inlayText: '\u{1F409}\u{1F525}xyz', opacity: '0.5', glow: '' } },
  ] } }] }, OPTS());
  const [a, b, c, d] = r.players[0].bag[6];
  const base = P.styleFromLook(null, 6);
  assert.equal(a.style.body, base.body, 'bad colour falls back');
  assert.equal(a.style.ink, '#ffffff');
  assert.equal(a.style.finish, base.finish);
  assert.equal(a.style.pattern, 'solid');
  assert.equal(a.style.font, 'classic');
  assert.equal(a.style.opacity, P.MIN_OPACITY, 'opacity clamped');
  assert.equal(a.style.glow, 1, 'glow clamped');
  assert.equal(a.style.inlay, null);
  assert.equal(a.style.pips, true);
  assert.equal(b.style, null, 'non-object style means "player look"');
  assert.equal(c.style.inlay, null, 'empty custom inlay dropped');
  assert.equal(d.style.inlayText, '\u{1F409}\u{1F525}x', 'inlay text capped at 3 code points');
  assert.equal(d.style.opacity, 0.5);
  assert.equal(d.style.glow, 0, 'empty string is not a number');
  assert.equal(P.sanitizeInlayText('<b>&"\''), 'b');
});

test('every generated die name survives a save/load round trip intact', () => {
  for (const firstName of P.FIRST_NAMES) {
    for (const epithet of P.EPITHETS) {
      const name = firstName + ' ' + epithet;
      assert.ok(name.length <= P.MAX_DIE_NAME, name);
      const p = P.newPlayer('A', OPTS());
      first(p, 20).name = name;
      const back = P.parse(P.serialize({ version: 2, activeId: p.id, players: [p] })).data.players[0];
      assert.equal(first(back, 20).name, name);
    }
  }
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

test('looks: presets, custom colours and finishes (including the new finishes)', () => {
  const p = P.newPlayer('A', OPTS());
  assert.deepEqual(P.updateLook(p, { theme: 'hoard' }), { theme: 'hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'metal' });
  assert.deepEqual(P.updateLook(p, { finish: 'gem' }), { theme: 'hoard', body: '#d4a63a', ink: '#3a1f05', finish: 'gem' });
  assert.deepEqual(P.updateLook(p, { body: '#112233' }), { theme: 'custom', body: '#112233', ink: '#3a1f05', finish: 'gem' });
  assert.deepEqual(P.updateLook(p, { ink: 'nonsense', finish: 'plasma' }), { theme: 'custom', body: '#112233', ink: '#3a1f05', finish: 'gem' });
  assert.equal(P.updateLook(p, { finish: 'wood' }).finish, 'wood');
  assert.deepEqual(P.updateLook(p, { theme: 'classic' }), { theme: 'classic', body: null, ink: null, finish: 'glossy' });
  for (const f of ['glass', 'glitter', 'neon', 'wood', 'bone', 'stone']) assert.ok(P.FINISHES[f], f);
});

// --------------------------------------------------------------- migration
const V1_DOC = () => ({
  version: 1,
  activeId: 'p2',
  players: [
    { id: 'p1', name: 'Alice', created: 10, look: { theme: 'lich', body: '#1f1b2b', ink: '#8cf5b0', finish: 'matte' },
      dice: {
        4: { id: 'd4a', sides: 4, name: 'Pip the Bold', born: 11, lucky: false, faces: [1, 2, 3, 4], recent: [1, 2, 2, 3, 3, 3, 4, 4, 4, 4] },
        20: { id: 'd20a', sides: 20, name: 'Kevin the Smug', born: 12, lucky: true, faces: Array.from({ length: 20 }, (_, i) => (i === 19 ? 3 : 1)), recent: [20, 20, 5] },
      },
      graveyard: [{ id: 'g1', sides: 6, name: 'Old Gus the Chipped', born: 1, lucky: false, faces: [5, 0, 0, 0, 0, 1], recent: [1, 1, 6], died: 20, epitaph: 'Ones.', cause: 'burned' }] },
    { id: 'p2', name: 'Bob', created: 30, look: { theme: 'classic' }, dice: {}, graveyard: [] },
  ],
});

test('v1 profiles migrate to v2: each die becomes slot #1 with stats, lucky mark and history intact', () => {
  const v1 = V1_DOC();
  const r = P.parse(JSON.stringify(v1), OPTS());
  assert.equal(r.status, 'migrated');
  assert.equal(r.from, 1);
  assert.equal(r.data.version, 2);
  assert.equal(r.data.activeId, 'p2');
  const [alice, bob] = r.data.players;
  assert.equal(alice.dice, undefined);
  for (const s of P.TRACKED) assert.equal(alice.bag[s].length, 1, 'd' + s + ' has exactly one slot');
  const d20 = first(alice, 20);
  assert.equal(d20.id, 'd20a');
  assert.equal(d20.name, 'Kevin the Smug');
  assert.equal(d20.born, 12);
  assert.equal(d20.lucky, true);
  assert.deepEqual(d20.faces, v1.players[0].dice[20].faces);
  assert.deepEqual(d20.recent, [20, 20, 5]);
  assert.equal(d20.style, null);
  assert.equal(P.dieStats(d20).rolls, 22);
  assert.deepEqual(first(alice, 4).faces, [1, 2, 3, 4]);
  assert.equal(P.luckyDie(alice).id, 'd20a');
  assert.equal(alice.graveyard.length, 1);
  assert.equal(alice.graveyard[0].epitaph, 'Ones.');
  assert.deepEqual(alice.look, v1.players[0].look);
  for (const s of P.TRACKED) assert.equal(bob.bag[s].length, 1, 'missing dice are filled in');
  // After a save it reads back as current data.
  const again = P.parse(P.serialize(r.data), OPTS());
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.data, r.data);
});

test('v1 lucky die whose slot is pardoned/burned keeps working after migration', () => {
  const r = P.parse(JSON.stringify(V1_DOC()), OPTS());
  const alice = r.data.players[0];
  const pardoned = P.resurrectDie(alice, 'g1', OPTS());
  assert.equal(pardoned.restored.id, 'g1');
  assert.equal(alice.bag[6].length, 2, 'the old d6 rejoins next to the current one');
  assert.equal(P.dieStats(pardoned.restored).rolls, 6);
});

test('load() backs up v1 data before upgrading it, and the upgrade is saved once', () => {
  const text = JSON.stringify(V1_DOC());
  const store = new MemoryStorage({ [P.STORAGE_KEY]: text });
  const r = P.load(store, OPTS());
  assert.equal(r.status, 'migrated');
  assert.equal(store.getItem(P.BACKUP_KEY), text);
  assert.ok(P.save(store, r.data));
  assert.equal(JSON.parse(store.getItem(P.STORAGE_KEY)).version, 2);
  assert.equal(P.load(store, OPTS()).status, 'ok');
});

test('v0 data (bare array or unversioned object) migrates all the way to v2', () => {
  const arr = P.parse(JSON.stringify([{ name: 'Alice', color: '#f00', ink: '#fff' }, 'Bob', 7]), OPTS());
  assert.equal(arr.status, 'migrated');
  assert.equal(arr.from, 0);
  assert.equal(arr.data.version, 2);
  assert.deepEqual(arr.data.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.deepEqual(arr.data.players[0].look, { theme: 'custom', body: '#ff0000', ink: '#ffffff', finish: 'glossy' });
  assert.equal(arr.data.players[1].look.theme, 'classic');

  const obj = P.parse(JSON.stringify({ active: 'b', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', color: '00ff00' }] }), OPTS());
  assert.equal(obj.status, 'migrated');
  assert.equal(obj.data.activeId, 'b');
  assert.equal(obj.data.players[1].look.body, '#00ff00');
  for (const p of obj.data.players) for (const s of P.TRACKED) assert.equal(first(p, s).faces.length, s);
});

test('corrupt v1 data still migrates into something usable', () => {
  const r = P.parse(JSON.stringify({ version: 1, players: [
    { id: 'x', dice: 'lol' },
    { id: 'y', dice: { 20: 'nope', 6: { sides: 8, faces: [1] }, 8: { faces: [0, 0, 0, 0, 0, 0, 0, 9] } }, bag: 'also nope' },
    'garbage',
  ] }), OPTS());
  assert.equal(r.status, 'migrated');
  assert.equal(r.data.players.length, 2);
  const y = r.data.players[1];
  for (const s of P.TRACKED) assert.equal(y.bag[s].length, 1);
  assert.equal(first(y, 6).sides, 6, 'mismatched die replaced');
  assert.equal(first(y, 8).faces[7], 9, 'good die kept');
});

test('data from a newer version is refused, not mangled', () => {
  const text = JSON.stringify({ version: 99, players: [{ name: 'Future' }] });
  const r = P.parse(text, OPTS());
  assert.equal(r.status, 'future');
  assert.equal(r.data.players[0].name, 'Adventurer');
  assert.throws(() => P.migrate({ version: 3 }), P.ProfileError);
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
  const emptyPlayers = P.parse(JSON.stringify({ version: 2, players: [] }), OPTS());
  assert.equal(emptyPlayers.status, 'ok');
  assert.equal(emptyPlayers.data.players.length, 1);
});

test('load() backs up unreadable data before it can be overwritten', () => {
  const store = new MemoryStorage({ [P.STORAGE_KEY]: '{"version":2,"players":[{"name":"Ali' });
  const r = P.load(store, OPTS());
  assert.equal(r.status, 'corrupt');
  assert.equal(r.persistent, true);
  assert.equal(store.getItem(P.BACKUP_KEY), '{"version":2,"players":[{"name":"Ali');
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
  const firstId = d.activeId;
  const b = P.addPlayer(d, 'Bea', OPTS());
  assert.equal(d.activeId, b.id, 'new player becomes active');
  const c = P.addPlayer(d, '', OPTS());
  assert.equal(c.name, 'Player 3');
  assert.equal(P.cyclePlayer(d, 1).id, firstId, 'wraps forward');
  assert.equal(P.cyclePlayer(d, -1).id, c.id, 'wraps backward');
  assert.equal(P.setActive(d, 'missing'), false);
  assert.ok(P.setActive(d, b.id));
  P.removePlayer(d, b.id);
  assert.equal(d.players.length, 2);
  assert.equal(d.activeId, c.id, 'active moves to a neighbour');
  P.removePlayer(d, c.id);
  assert.throws(() => P.removePlayer(d, firstId), P.ProfileError);
  while (d.players.length < P.MAX_PLAYERS) P.addPlayer(d, 'x', OPTS());
  assert.throws(() => P.addPlayer(d, 'one too many'), P.ProfileError);
});

test('players keep separate dice, stats and graveyards', () => {
  const d = P.defaultData(OPTS());
  const a = P.activePlayer(d);
  const b = P.addPlayer(d, 'B', OPTS());
  P.recordRoll(a, { groups: [{ sides: 20, dice: [{ value: 1 }] }] });
  P.burnDie(b, 20, {});
  assert.equal(P.dieStats(first(a, 20)).rolls, 1);
  assert.equal(P.dieStats(first(b, 20)).rolls, 0);
  assert.equal(a.graveyard.length, 0);
  assert.equal(b.graveyard.length, 1);
});

// -------------------------------------------------------------------- slots
test('bag slots: add up to 20 per type with distinct names, then refuse', () => {
  const p = P.newPlayer('A', { rng: seq(3), now: 1 });
  const added = P.addDice(p, 6, 30, { rng: seq(5), now: 2 });
  assert.equal(added.length, P.MAX_PER_TYPE - 1);
  assert.equal(p.bag[6].length, P.MAX_PER_TYPE);
  assert.equal(new Set(p.bag[6].map((d) => d.id)).size, P.MAX_PER_TYPE, 'unique ids');
  assert.ok(new Set(p.bag[6].map((d) => d.name)).size >= P.MAX_PER_TYPE - 2, 'names are (almost always) unique');
  assert.throws(() => P.addDie(p, 6), P.ProfileError);
  assert.throws(() => P.addDie(p, 7), P.ProfileError);
  assert.equal(P.addDie(p, 20, { name: '  Twin  ' }).name, 'Twin');
  assert.equal(P.slotLabel(6, 2), 'd6 #3');
  const at = P.findDie(p, p.bag[6][4].id);
  assert.deepEqual([at.sides, at.index], [6, 4]);
  assert.equal(P.findDie(p, 'nope'), null);
  assert.equal(P.allDice(p).length, 20 + 2 + 5);
});

test('bag slots: reorder, rename and remove (rolled dice retire, unrolled ones vanish, the last stays)', () => {
  const p = P.newPlayer('A', OPTS());
  const [a] = p.bag[6];
  const b = P.addDie(p, 6, OPTS());
  const c = P.addDie(p, 6, OPTS());
  assert.equal(P.moveDie(p, c.id, 0), 0);
  assert.deepEqual(p.bag[6].map((d) => d.id), [c.id, a.id, b.id]);
  assert.equal(P.moveDie(p, c.id, 99), 2, 'clamped');
  assert.deepEqual(p.bag[6].map((d) => d.id), [a.id, b.id, c.id]);
  assert.equal(P.renameDie(p, b.id, '  Lefty\n'), 'Lefty');
  assert.equal(P.renameDie(p, b.id, '   '), 'Lefty', 'blank names are ignored');
  assert.equal(P.renameDie(p, b.id, 'x'.repeat(99)).length, P.MAX_DIE_NAME);
  P.toggleHand(p, c.id);
  P.recordRoll(p, { groups: [{ sides: 6, dice: [{ value: 2 }] }] }); // c is picked, so c rolls it
  const gone = P.removeDie(p, c.id, { now: 9 });
  assert.equal(gone.retired.cause, 'retired');
  assert.equal(gone.retired.slot, 2);
  assert.equal(p.graveyard[0].id, c.id);
  assert.deepEqual(p.hand, {}, 'removed dice leave the hand');
  const quiet = P.removeDie(p, b.id);
  assert.equal(quiet.retired, null, 'never rolled: no Hall entry');
  assert.equal(p.graveyard.length, 1);
  assert.throws(() => P.removeDie(p, a.id), P.ProfileError, 'the last d6 stays');
  assert.throws(() => P.moveDie(p, 'nope', 1), P.ProfileError);
});

// --------------------------------------------------------------- assignment
test('assignment: bag order by default, picked dice first, then the rest, then house dice', () => {
  const p = P.newPlayer('A', OPTS());
  const [d1] = p.bag[6];
  const d2 = P.addDie(p, 6, OPTS());
  const d3 = P.addDie(p, 6, OPTS());
  let plan = P.planDice(p, [6, 6, 6, 6, 6]);
  assert.deepEqual(plan.map((x) => x.dieId), [d1.id, d2.id, d3.id, null, null]);
  assert.deepEqual(plan.map((x) => x.label), ['d6 #1', 'd6 #2', 'd6 #3', 'House d6 #1', 'House d6 #2']);
  assert.ok(plan[3].house && plan[4].house);
  P.toggleHand(p, d3.id);
  P.toggleHand(p, d1.id);
  assert.deepEqual(P.handOf(p, 6), [d3.id, d1.id]);
  plan = P.planDice(p, [6, 6, 6, 6]);
  assert.deepEqual(plan.map((x) => x.dieId), [d3.id, d1.id, d2.id, null]);
  assert.deepEqual(plan.map((x) => x.slot), [2, 0, 1, null], 'slot numbers stay the bag positions');
  assert.equal(P.toggleHand(p, d3.id), -1, 'unpicked');
  assert.deepEqual(P.setHand(p, 6, ['bogus', d2.id, d2.id]), [d2.id]);
  assert.deepEqual(P.setHand(p, 6, []), []);
  assert.deepEqual(p.hand, {}, 'empty hand = automatic');
});

test('assignment covers every rolled die: mixed groups, adv/dis, keep/drop, d100 and untracked dice', () => {
  const p = P.newPlayer('A', OPTS());
  const twin = P.addDie(p, 20, OPTS());
  const source = queueSource([19, 0, 3, 5, 2, 4, 41, 6]);
  const result = Dice.rollExpression('d20+3d6+d6+d100+d7', { mode: 'adv', source });
  const before = JSON.stringify(result);
  const a = P.assignDice(p, result);
  assert.equal(JSON.stringify(result), before, 'result untouched');
  const flat = P.flattenResult(result);
  assert.equal(a.length, flat.length);
  const d20s = a.filter((x) => x && x.sides === 20);
  assert.deepEqual(d20s.map((x) => x.dieId), [first(p, 20).id, twin.id], 'advantage uses both owned d20s');
  const d6s = a.filter((x) => x && x.sides === 6);
  assert.deepEqual(d6s.map((x) => x.label), ['d6 #1', 'House d6 #1', 'House d6 #2', 'House d6 #3'], 'shared across d6 groups, never reused');
  assert.equal(a.find((x) => x && x.sides === 100).dieId, first(p, 100).id);
  assert.equal(a[a.length - 1], null, 'untracked d7 has no bag die');
  assert.deepEqual(P.assignDice(p, result), a, 'deterministic');
  assert.deepEqual(P.assignDice(p, null), []);
});

test('recordRoll credits the specific bag die that rolled each value; house dice are not tracked', () => {
  const p = P.newPlayer('A', OPTS());
  P.addDice(p, 6, 2, OPTS());
  const source = queueSource([0, 1, 2, 3, 4, 5, 0, 1]); // 8d6: 1 2 3 4 5 6 1 2
  const result = Dice.rollExpression('8d6', { source });
  const assignment = P.assignDice(p, result);
  const credited = P.recordRoll(p, result, assignment);
  assert.deepEqual(credited.map((c) => [c.label, c.values]), [['d6 #1', [1]], ['d6 #2', [2]], ['d6 #3', [3]]]);
  assert.deepEqual(p.bag[6].map((d) => P.dieStats(d).rolls), [1, 1, 1]);
  assert.equal(p.bag[6][2].faces[2], 1);
  // A stale assignment pointing at another type is ignored rather than mis-credited.
  const wrong = assignment.map((x) => Object.assign({}, x, { dieId: first(p, 20).id }));
  assert.deepEqual(P.recordRoll(p, result, wrong), []);
});

test('recordRoll credits every rolled die (dropped ones too) and leaves the result untouched', () => {
  const p = P.newPlayer('A', OPTS());
  P.addDie(p, 20, OPTS()); // two d20s for advantage
  const source = queueSource([19, 0, 3, 5, 2]); // adv d20: 20 & 1; 3d6: 4, 6, 3
  const result = Dice.rollExpression('d20+3d6+2', { mode: 'adv', source });
  const snapshot = JSON.stringify(result);
  const credited = P.recordRoll(p, result);
  assert.equal(JSON.stringify(result), snapshot, 'result not modified');
  assert.deepEqual(credited.map((c) => [c.label, c.values]), [['d20 #1', [20]], ['d20 #2', [1]], ['d6 #1', [4]]]);
  assert.equal(P.dieStats(p.bag[20][0]).natMax, 1);
  assert.equal(P.dieStats(p.bag[20][1]).natMin, 1, 'the dropped die is credited too');
  const s6 = P.dieStats(first(p, 6));
  assert.equal(s6.rolls, 1, 'the other two d6s were house dice');
});

test('recordRoll ignores non-standard dice and garbage', () => {
  const p = P.newPlayer('A', OPTS());
  const result = Dice.rollExpression('3d7+d1000', { source: queueSource([0, 1, 2, 999]) });
  assert.deepEqual(P.recordRoll(p, result), []);
  assert.deepEqual(P.recordRoll(p, null), []);
  assert.deepEqual(P.recordRoll(p, { groups: [{ sides: 6, dice: [{ value: 9 }, { value: 0 }, {}] }] }), []);
  for (const d of P.allDice(p)) assert.equal(P.dieStats(d).rolls, 0);
});

test('d100 rolls are tracked on all 100 faces', () => {
  const p = P.newPlayer('A', OPTS());
  P.addDie(p, 100, OPTS());
  P.recordRoll(p, Dice.rollExpression('2d100', { source: queueSource([99, 0]) }));
  assert.equal(P.dieStats(p.bag[100][0]).natMax, 1);
  assert.equal(P.dieStats(p.bag[100][1]).natMin, 1);
});

test('recent rolls are capped at 20', () => {
  const p = P.newPlayer('A', OPTS());
  for (let i = 0; i < 30; i++) P.recordRoll(p, { groups: [{ sides: 4, dice: [{ value: (i % 4) + 1 }] }] });
  assert.equal(first(p, 4).recent.length, 20);
  assert.equal(P.dieStats(first(p, 4)).rolls, 30);
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

test('only one lucky die per player, across every slot; toggling clears it', () => {
  const p = P.newPlayer('A', OPTS());
  const twin = P.addDie(p, 20, OPTS());
  assert.equal(P.luckyDie(p), null);
  assert.equal(P.setLucky(p, twin.id), true);
  assert.equal(P.luckyDie(p).id, twin.id);
  assert.equal(P.planDice(p, [20, 20])[1].lucky, true, 'the plan knows which die is lucky');
  P.setLucky(p, 8, true); // shorthand: slot #1 of the d8s
  assert.equal(P.luckyDie(p).sides, 8);
  assert.equal(twin.lucky, false);
  assert.equal(P.setLucky(p, 8), false);
  assert.equal(P.luckyDie(p), null);
  assert.equal(P.setLucky(p, 7), false);
  assert.equal(P.setLucky(p, 'nope'), false);
});

// ------------------------------------------------------------ burn & pardon
test('burning retires the die with its stats and puts a fresh die (same look) in the same slot', () => {
  const p = P.newPlayer('A', OPTS());
  const one = first(p, 20);
  const two = P.addDie(p, 20, OPTS());
  P.setDieStyle(p, two.id, 'ember');
  P.toggleHand(p, two.id);
  P.recordRoll(p, { groups: [{ sides: 20, dice: [{ value: 1 }, { value: 1 }, { value: 2 }] }] }); // two, one, house
  P.setLucky(p, two.id, true);
  const { burned, replacement, slot } = P.burnDie(p, two.id, { now: 123, rng: seq(3) });
  assert.equal(slot, 1);
  assert.equal(burned.id, two.id);
  assert.equal(burned.cause, 'burned');
  assert.equal(burned.died, 123);
  assert.equal(burned.slot, 1);
  assert.equal(burned.replacedBy, replacement.id);
  assert.equal(burned.epitaph, 'Was supposed to be the lucky one.');
  assert.equal(P.dieStats(burned).rolls, 1, 'sad stats preserved');
  assert.equal(burned.style.inlay, 'flame', 'it burns in its own colours');
  assert.equal(p.graveyard[0], burned);
  assert.equal(p.bag[20][1], replacement);
  assert.equal(p.bag[20][0], one, 'other slots untouched');
  assert.deepEqual(replacement.style, burned.style, 'the slot keeps its look');
  assert.notEqual(replacement.id, two.id);
  assert.notEqual(replacement.name, two.name);
  assert.equal(P.dieStats(replacement).rolls, 0);
  assert.equal(replacement.lucky, false, 'the lucky title burns with the die');
  assert.deepEqual(P.handOf(p, 20), [replacement.id], 'the replacement takes its place in the hand');
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

test('pardoning: an unused replacement makes way, a used one keeps its place and the old die rejoins', () => {
  const p = P.newPlayer('A', OPTS());
  P.recordRoll(p, { groups: [{ sides: 12, dice: [{ value: 1 }] }] });
  const { burned, replacement } = P.burnDie(p, 12, {});
  // Unused replacement: discarded, the old die takes its slot back.
  let r = P.resurrectDie(p, burned.id, { now: 9 });
  assert.equal(r.displaced, null);
  assert.equal(r.slot, 0);
  assert.equal(p.bag[12].length, 1);
  assert.equal(first(p, 12).id, burned.id);
  assert.equal(first(p, 12).died, undefined);
  assert.equal(first(p, 12).epitaph, undefined);
  assert.equal(first(p, 12).slot, undefined);
  assert.equal(P.dieStats(first(p, 12)).rolls, 1);
  assert.equal(p.graveyard.length, 0);
  assert.ok(!P.findDie(p, replacement.id));
  // Used replacement: both stay, the pardoned die returns to its old slot number.
  const second = P.burnDie(p, 12, {});
  P.recordRoll(p, { groups: [{ sides: 12, dice: [{ value: 12 }] }] });
  r = P.resurrectDie(p, second.burned.id, { now: 10 });
  assert.equal(r.displaced, null);
  assert.equal(r.slot, 0);
  assert.deepEqual(p.bag[12].map((d) => d.id), [second.burned.id, second.replacement.id]);
  assert.throws(() => P.resurrectDie(p, 'nope'), P.ProfileError);
});

test('pardoning into a full type retires the replacement instead', () => {
  const p = P.newPlayer('A', OPTS());
  P.addDice(p, 6, P.MAX_PER_TYPE - 1, OPTS());
  const { burned, replacement } = P.burnDie(p, p.bag[6][3].id, {});
  P.toggleHand(p, replacement.id);
  P.recordRoll(p, { groups: [{ sides: 6, dice: [{ value: 6 }] }] }); // the picked replacement rolls
  const r = P.resurrectDie(p, burned.id, { now: 10 });
  assert.equal(r.displaced.id, replacement.id);
  assert.equal(r.displaced.cause, 'retired');
  assert.match(r.displaced.epitaph, /Stepped aside/);
  assert.equal(p.bag[6].length, P.MAX_PER_TYPE);
  assert.equal(p.bag[6][3].id, burned.id);
  assert.deepEqual(P.handOf(p, 6), [], 'a retired die leaves the hand');
  assert.ok(P.scatterAshes(p, replacement.id));
  assert.equal(p.graveyard.length, 0);
});

test('a pardoned lucky die does not create a second lucky die', () => {
  const p = P.newPlayer('A', OPTS());
  P.setLucky(p, 20, true);
  const { burned } = P.burnDie(p, 20, {});
  P.setLucky(p, 8, true);
  P.resurrectDie(p, burned.id, {});
  assert.equal(P.allDice(p).filter((d) => d.lucky).length, 1);
  assert.equal(P.luckyDie(p).sides, 8);
});

// ------------------------------------------------------- per-die styles
test('per-die style: patches start from the current look, presets, reset, and rendering appearance', () => {
  const p = P.newPlayer('A', OPTS());
  P.updateLook(p, { theme: 'vampire' });
  const die = P.addDie(p, 6, OPTS());
  let a = P.appearanceOf(p, die);
  assert.equal(a.custom, false);
  assert.equal(a.classic, false);
  assert.equal(a.body, '#6e0f1f', 'inherits the player look');
  const st = P.setDieStyle(p, die.id, { ink: '#00ff00', pattern: 'swirl', body2: '#000000', pips: false, font: 'runic', finish: 'neon', glow: 0.4, inlay: 'skull' });
  assert.equal(st.body, '#6e0f1f', 'unpatched fields keep the current look');
  assert.equal(st.ink, '#00ff00');
  assert.equal(st.pips, false);
  a = P.appearanceOf(p, die);
  assert.equal(a.custom, true);
  assert.equal(a.finish, 'neon');
  assert.equal(P.appearanceOf(p, first(p, 6)).body, '#6e0f1f', 'other dice unaffected');
  P.setDieStyle(p, die.id, { opacity: 0.1, glow: 3, finish: 'lava', ink: 'nope' });
  assert.equal(die.style.opacity, P.MIN_OPACITY);
  assert.equal(die.style.glow, 1);
  assert.equal(die.style.finish, 'neon');
  assert.equal(die.style.ink, '#00ff00');
  const preset = P.setDieStyle(p, die.id, 'bone');
  assert.equal(preset.finish, 'bone');
  assert.equal(preset.inlay, 'skull');
  assert.equal(preset.pips, true, 'presets are complete looks');
  assert.equal(preset.glow, 0);
  assert.throws(() => P.setDieStyle(p, die.id, 'nope'), P.ProfileError);
  assert.equal(P.setDieStyle(p, die.id, null), null);
  assert.equal(P.appearanceOf(p, die).custom, false);
  P.updateLook(p, { theme: 'classic' });
  a = P.appearanceOf(p, die);
  assert.equal(a.classic, true);
  assert.equal(a.body, P.CLASSIC_COLORS[6].body);
  assert.notEqual(P.appearanceKey(a), P.appearanceKey(P.appearanceOf(p, first(p, 20))));
});

test('copy a look to the rest of its type or to the whole bag', () => {
  const p = P.newPlayer('A', OPTS());
  const a = P.addDie(p, 6, OPTS());
  P.addDie(p, 6, OPTS());
  P.setDieStyle(p, a.id, 'galaxy');
  assert.equal(P.copyStyle(p, a.id, 'type'), 2);
  assert.ok(p.bag[6].every((d) => d.style && d.style.finish === 'glitter'));
  assert.equal(first(p, 20).style, null);
  assert.equal(P.copyStyle(p, a.id, [first(p, 20).id, 'ghost']), 1);
  assert.equal(first(p, 20).style.finish, 'glitter');
  assert.equal(P.copyStyle(p, a.id, 'all'), P.allDice(p).length - 1);
  p.bag[6][0].style.body = '#000000';
  assert.notEqual(a.style.body, '#000000', 'copies are independent');
  P.setDieStyle(p, a.id, null);
  P.copyStyle(p, a.id, 'type');
  assert.ok(p.bag[6].every((d) => d.style === null), 'copying "player look" resets');
});

test('contrast checks and warnings for unreadable colour combinations', () => {
  assert.equal(Math.round(P.contrastRatio('#ffffff', '#000000')), 21);
  assert.equal(P.contrastRatio('#777777', '#777777'), 1);
  assert.equal(P.readableOn('#101010'), '#ffffff');
  assert.equal(P.readableOn('#f5f5f5'), '#111111');
  const base = P.resolveAppearance(null, P.normalizeStyle({ body: '#888888', ink: '#999999' }), 20);
  const w = P.readabilityWarnings(base);
  assert.equal(w[0].key, 'contrast');
  assert.ok(w[0].ratio < P.MIN_CONTRAST);
  const twoTone = P.resolveAppearance(null, P.normalizeStyle({ body: '#000000', body2: '#ffffff', ink: '#ffffff', pattern: 'twotone' }), 20);
  assert.match(P.readabilityWarnings(twoTone)[0].message, /second colour/);
  const solid = P.resolveAppearance(null, P.normalizeStyle({ body: '#000000', body2: '#ffffff', ink: '#ffffff', pattern: 'solid' }), 20);
  assert.deepEqual(P.readabilityWarnings(solid), [], 'body2 only matters for two-colour patterns');
  const ghost = P.resolveAppearance(null, P.normalizeStyle({ body: '#000000', ink: '#ffffff', opacity: 0.4 }), 20);
  assert.equal(P.readabilityWarnings(ghost)[0].key, 'opacity');
  for (const t of Object.keys(P.THEMES)) {
    for (const s of P.TRACKED) {
      const look = P.normalizeLook({ theme: t });
      assert.deepEqual(P.readabilityWarnings(P.resolveAppearance(look, null, s)).filter((x) => x.key === 'contrast'), [], t + ' d' + s);
    }
  }
  for (const k of Object.keys(P.DIE_PRESETS)) {
    const p = P.newPlayer('A', OPTS());
    P.setDieStyle(p, first(p, 20).id, k);
    assert.deepEqual(P.readabilityWarnings(P.appearanceOf(p, first(p, 20))), [], 'preset ' + k + ' is readable');
  }
});

test('randomize always produces a valid, readable look', () => {
  const rng = seq(11);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const s = P.randomStyle({ rng });
    assert.deepEqual(P.normalizeStyle(s), s, 'already normalised');
    assert.deepEqual(P.readabilityWarnings(P.resolveAppearance(null, s, 20)), []);
    seen.add(s.finish);
    seen.add(s.pattern);
  }
  assert.ok(seen.size >= 12, 'explores finishes and patterns');
});

// ------------------------------------------------------------ export/import
test('export/import merges players by id, migrates old backups and validates input', () => {
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
  assert.deepEqual(P.importJSON(home, JSON.stringify(V1_DOC()), OPTS()), { added: 2, replaced: 0, skipped: 0 });
  assert.equal(home.players[2].bag[20][0].id, 'd20a', 'v1 backup migrated on import');
  assert.throws(() => P.importJSON(home, 'nope'), P.ProfileError);
  assert.throws(() => P.importJSON(home, '{"hello":1}'), P.ProfileError);
  assert.throws(() => P.importJSON(home, '{"version":42,"players":[{}]}'), P.ProfileError);
  assert.equal(home.players.length, 4, 'failed imports change nothing');
});

// ---------------------------------------------------------------- fairness
test('profiles never touch the RNG: identical random streams give identical rolls', () => {
  const raw = Array.from({ length: 80 }, (_, i) => (i * 2654435761) >>> 0);
  const plain = Dice.rollExpression('4d20+8d6', { mode: 'adv', source: queueSource(raw) });
  const p = P.newPlayer('A', OPTS());
  P.setLucky(p, 20, true);
  P.updateLook(p, { theme: 'lich' });
  P.burnDie(p, 6, {});
  P.addDice(p, 6, 3, OPTS());
  P.addDice(p, 20, 2, OPTS());
  P.toggleHand(p, p.bag[6][2].id);
  P.setDieStyle(p, p.bag[20][1].id, 'neon');
  const src = queueSource(raw);
  const tracked = Dice.rollExpression('4d20+8d6', { mode: 'adv', source: src });
  const left = src.remaining;
  const assignment = P.assignDice(p, tracked);
  P.recordRoll(p, tracked, assignment);
  P.planDice(p, [6, 6, 20]);
  assert.equal(src.remaining, left, 'assignment and stats draw no random numbers');
  const strip = (r) => JSON.stringify(Object.assign({}, r, { timestamp: 0 }));
  assert.equal(strip(tracked), strip(plain));
});

test('assignment is cosmetic: any bag layout leaves the totals and values identical', () => {
  const raw = Array.from({ length: 40 }, (_, i) => (i * 40503 + 7) >>> 0);
  const roll = () => Dice.rollExpression('8d6+2d20+d100', { mode: 'dis', source: queueSource(raw) });
  const reference = roll();
  const layouts = [
    (p) => p,
    (p) => { P.addDice(p, 6, 10, OPTS()); return p; },
    (p) => { P.addDice(p, 6, 2, OPTS()); P.setHand(p, 6, [p.bag[6][2].id]); return p; },
    (p) => { P.addDice(p, 20, 5, OPTS()); P.copyStyle(p, P.setDieStyle(p, p.bag[20][0].id, 'ember') && p.bag[20][0].id, 'all'); return p; },
  ];
  for (const layout of layouts) {
    const p = layout(P.newPlayer('A', OPTS()));
    const r = roll();
    P.recordRoll(p, r);
    assert.equal(r.total, reference.total);
    assert.deepEqual(r.groups.map((g) => g.dice.map((d) => d.value)), reference.groups.map((g) => g.dice.map((d) => d.value)));
  }
});

test('dice-profiles.js has no access to the dice RNG', () => {
  const src = readFileSync(new URL('../dice-profiles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /getRandomValues|randomInt|rollExpression|crypto/);
});
