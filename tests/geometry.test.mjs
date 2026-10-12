// 3D tray maths (no WebGL): face values, rest orientations, symmetries, physics settling.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import Geo from '../dice-geometry.js';
import Phys from '../dice-physics.js';

const { quat, vec } = Geo;
const UP = [0, 1, 0];
const close = (a, b, eps = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) <= eps);

/** Small deterministic PRNG so failures are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXPECT = {
  d4: { faces: 4, values: [1, 2, 3, 4] },
  d6: { faces: 6, values: [1, 2, 3, 4, 5, 6] },
  d8: { faces: 8, values: [1, 2, 3, 4, 5, 6, 7, 8] },
  d10: { faces: 10, values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  d12: { faces: 12, values: Array.from({ length: 12 }, (_, i) => i + 1) },
  d20: { faces: 20, values: Array.from({ length: 20 }, (_, i) => i + 1) },
  d100t: { faces: 10, values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  d100u: { faces: 10, values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
};

test('every die kind has the right shape and each value exactly once', () => {
  assert.deepEqual([...Geo.KINDS].sort(), Object.keys(EXPECT).sort());
  for (const kind of Geo.KINDS) {
    const die = Geo.getDie(kind);
    assert.equal(die.faces.length, EXPECT[kind].faces, kind + ' face count');
    const shown = die.read === 'vertex' ? die.vertexValues : die.faces.map((f) => f.value);
    assert.deepEqual([...shown].sort((a, b) => a - b), EXPECT[kind].values, kind + ' values');
    for (const f of die.faces) {
      // Outward unit normals, all faces equally far from the centre (fair shape).
      assert.ok(Math.abs(vec.length(f.normal) - 1) < 1e-9);
      assert.ok(vec.dot(f.normal, f.center) > 0, kind + ' normal points outward');
      assert.ok(Math.abs(f.distance - die.inradius) < 1e-9, kind + ' face distance');
      for (const vi of f.verts) assert.ok(Math.abs(vec.dot(f.normal, die.vertices[vi]) - f.distance) < 1e-9, kind + ' face is planar');
    }
  }
});

test('opposite faces sum like real dice; d4 corners and d100 labels are right', () => {
  for (const kind of ['d6', 'd8', 'd10', 'd12', 'd20', 'd100u']) {
    const die = Geo.getDie(kind);
    const vals = EXPECT[kind].values;
    const sum = vals[0] + vals[vals.length - 1];
    for (const f of die.faces) {
      const opp = die.faces.find((g) => vec.dot(g.normal, f.normal) < -0.999);
      assert.ok(opp, kind + ' has an opposite face');
      assert.equal(f.value + opp.value, sum, kind + ' ' + f.value + ' opposite ' + opp.value);
    }
  }
  const d4 = Geo.getDie('d4');
  for (const f of d4.faces) {
    // A d4 face shows the values of its three corners, and never the vertex opposite it.
    assert.deepEqual(f.cornerLabels, f.verts.map((v) => String(d4.vertexValues[v])));
  }
  assert.deepEqual(Geo.getDie('d100t').faces.map((f) => f.label).sort(), ['00', '10', '20', '30', '40', '50', '60', '70', '80', '90']);
  assert.deepEqual(Geo.splitD100(100), { tens: 0, units: 0 });
  assert.deepEqual(Geo.splitD100(1), { tens: 0, units: 1 });
  assert.deepEqual(Geo.splitD100(10), { tens: 1, units: 0 });
  assert.deepEqual(Geo.splitD100(57), { tens: 5, units: 7 });
  assert.deepEqual(Geo.splitD100(99), { tens: 9, units: 9 });
  // Every d100 result maps back from its two dice.
  for (let v = 1; v <= 100; v++) {
    const [t, u] = Geo.bodiesFor(100, v);
    const back = (t.value * 10 + u.value) || 100;
    assert.equal(back, v);
  }
  assert.equal(Geo.bodiesFor(7, 3), null, 'non-standard dice have no 3D body');
});

test('for every die type and value, the chosen face normal maps to the up vector', () => {
  const rand = mulberry32(42);
  for (const kind of Geo.KINDS) {
    for (const value of EXPECT[kind].values) {
      const n = Geo.upNormal(kind, value);
      for (let k = 0; k < 8; k++) {
        const yaw = rand() * Math.PI * 2;
        const q = Geo.restQuaternion(kind, value, yaw);
        assert.ok(close(quat.rotate(q, n), UP, 1e-9), kind + ' value ' + value + ' points up');
        assert.equal(Geo.valueUp(kind, q), value, kind + ' reads ' + value);
        // Every other value's face/vertex points strictly lower.
        for (const other of EXPECT[kind].values) {
          if (other !== value) assert.ok(quat.rotate(q, Geo.upNormal(kind, other))[1] < 1 - 1e-6);
        }
      }
      // Snapping from a random tumbling orientation also lands exactly on the value.
      const q0 = Phys.randomQuat(rand);
      const snapped = Geo.snapToValue(kind, value, q0);
      assert.ok(close(quat.rotate(snapped, n), UP, 1e-9), kind + ' snap ' + value);
    }
  }
});

test('symmetries map each die onto itself and any value onto any other', () => {
  for (const kind of Geo.KINDS) {
    const vals = EXPECT[kind].values;
    for (const from of vals) {
      for (const to of vals) {
        const R = Geo.symmetryBetween(kind, from, to);
        assert.ok(Geo.isSymmetry(kind, R), kind + ' ' + from + '→' + to + ' keeps the shape');
        assert.ok(close(quat.rotate(R, Geo.upNormal(kind, from)), Geo.upNormal(kind, to), 1e-9));
      }
    }
  }
});

test('each face has one symmetry per rotational symmetry of its polygon', () => {
  const expected = { d4: 3, d6: 4, d8: 3, d10: 1, d12: 5, d20: 3, d100t: 1, d100u: 1 };
  for (const kind of Geo.KINDS) {
    const vals = EXPECT[kind].values;
    for (const from of vals) {
      for (const to of vals) {
        const all = Geo.symmetriesBetween(kind, from, to);
        assert.equal(all.length, expected[kind], kind + ' ' + from + '→' + to);
        for (const R of all) assert.ok(Geo.isSymmetry(kind, R));
      }
    }
  }
});

test('reduced-motion dice rest with their number turned toward the viewer', () => {
  const rand = mulberry32(3);
  for (const kind of Geo.KINDS) {
    if (kind === 'd4') continue;
    const dice = EXPECT[kind].values.map((value) => ({ kind, value, size: 1 }));
    const plan = Phys.planRoll({ dice, bounds: { hw: 10, hd: 6 }, rand, reduced: true });
    plan.dice.forEach((d, i) => {
      const textUp = quat.rotate(d.restQuat, Geo.labelUp(kind, dice[i].value));
      assert.ok(vec.dot(textUp, [0, 0, -1]) > Math.cos(0.31), kind + ' ' + dice[i].value + ' is upright');
    });
  }
});

test('simulated throws always come to rest showing the rolled value, inside the tray', () => {
  const rand = mulberry32(7);
  const bounds = { hw: 10, hd: 5.6 };
  for (const n of [1, 2, 5, 12, 40]) {
    for (let trial = 0; trial < 4; trial++) {
      const dice = [];
      for (let i = 0; i < n; i++) {
        const kind = Geo.KINDS[Math.floor(rand() * Geo.KINDS.length)];
        const vals = EXPECT[kind].values;
        dice.push({ kind, value: vals[Math.floor(rand() * vals.length)], size: n > 10 ? 0.8 : 1.4 });
      }
      for (const reduced of [false, true]) {
        const plan = Phys.planRoll({ dice, bounds, rand, reduced });
        if (reduced) assert.equal(plan.duration, 0);
        else assert.ok(plan.duration > 0.3 && plan.duration < 5, 'duration ' + plan.duration);
        plan.dice.forEach((d, i) => {
          const end = Phys.poseAt(plan, i, plan.duration + 0.01);
          assert.ok(end.settled);
          const up = quat.rotate(end.quat, Geo.upNormal(d.kind, dice[i].value));
          assert.ok(close(up, UP, 1e-6), d.kind + ' rolled ' + dice[i].value + ' must face up');
          assert.equal(Geo.valueUp(d.kind, end.quat), dice[i].value);
          const r = Geo.getDie(d.kind).inradius * d.size;
          assert.ok(Math.abs(end.pos[1] - r) < 1e-9, 'resting on the felt');
          assert.ok(Math.abs(end.pos[0]) <= bounds.hw && Math.abs(end.pos[2]) <= bounds.hd, 'inside the walls');
          if (!reduced) {
            // Mid-flight poses stay sane (finite, above the floor-ish).
            for (let t = 0; t < plan.duration; t += 0.1) {
              const p = Phys.poseAt(plan, i, t);
              assert.ok(p.pos.every(Number.isFinite) && p.quat.every(Number.isFinite));
              assert.ok(p.pos[1] > -0.5);
            }
          }
        });
      }
    }
  }
});
