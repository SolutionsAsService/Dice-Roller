/*
 * Dungeon Dice Box – a small hand-written rigid-body simulation for the 3D tray
 * (pure math, no three.js, no DOM).
 *
 * The throw is simulated up front: gravity, spin, bounces off the felt and the
 * wooden walls, sphere-approximated die–die knocks and friction until every die
 * goes to sleep. The result was already decided by DiceCore, so after the
 * simulation each die is re-labelled with a rotational symmetry of its own
 * shape (DiceGeometry.symmetryBetween) so the face that physics left on top
 * *is* the rolled value, and a short final slerp snaps it perfectly flat.
 *
 * Works as a classic browser script (window.DicePhysics) and in Node.
 */
(function (root, factory) {
  const geo = typeof module === 'object' && module && module.exports
    ? require('./dice-geometry.js')
    : root.DiceGeometry;
  const api = factory(geo);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.DicePhysics = api;
  }
})(typeof self !== 'undefined' ? self : this, function (Geo) {
  'use strict';

  if (!Geo) throw new Error('dice-physics.js needs dice-geometry.js');
  const { vec, quat } = Geo;
  const { add, sub, scale, dot, cross, length } = vec;

  const DEFAULTS = {
    dt: 1 / 120,
    gravity: 55,
    maxTime: 3.2,
    restitution: 0.42,
    friction: 0.45,
    dieRestitution: 0.35,
    dieFriction: 0.12,
    settleBefore: 0.1,
    settleAfter: 0.2,
  };

  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  function randomQuat(rand) {
    // Uniform random rotation (Shoemake).
    const u1 = rand();
    const u2 = rand() * 2 * Math.PI;
    const u3 = rand() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1);
    const b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  }

  function randomUnit(rand) {
    const z = rand() * 2 - 1;
    const t = rand() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), z, r * Math.sin(t)];
  }

  function makeBody(spec) {
    const die = Geo.getDie(spec.kind);
    const size = spec.size;
    const radius = size; // circumradius
    const inradius = die.inradius * size;
    const sphere = ((die.inradius + 1) / 2) * size; // die–die collision radius
    const gyr = 0.62 * size;
    return {
      kind: spec.kind,
      value: spec.value,
      size,
      hull: die.vertices.map((v) => scale(v, size)),
      radius,
      inradius,
      sphere,
      invMass: 1,
      invInertia: 1 / (0.4 * gyr * gyr),
      p: [0, 0, 0],
      v: [0, 0, 0],
      q: [0, 0, 0, 1],
      w: [0, 0, 0],
      asleep: false,
      calm: 0,
      sleepStep: -1,
      onFloor: false,
    };
  }

  /** Start positions near one wall, tossed toward the far side with plenty of spin. */
  function setupThrow(bodies, bounds, rand) {
    const side = rand() < 0.5 ? -1 : 1;
    const { hw, hd } = bounds;
    const placed = [];
    const speed = 7 + hw * 0.45;
    bodies.forEach((b) => {
      let pos = null;
      for (let attempt = 0; attempt < 60 && !pos; attempt++) {
        const spread = 1 + Math.floor(attempt / 15) * 0.6;
        const x = side * (hw - b.radius - 0.2 - rand() * hw * 0.45 * spread);
        const z = (rand() * 2 - 1) * Math.max(0.1, hd - b.radius - 0.2);
        const y = b.radius + 1 + rand() * 2.5 * spread;
        const cand = [Math.max(-hw + b.radius, Math.min(hw - b.radius, x)), y, z];
        if (placed.every((o) => length(sub(o.p, cand)) > o.sphere + b.sphere)) pos = cand;
      }
      if (!pos) pos = [side * (hw * 0.5), b.radius + 1 + placed.length * b.sphere * 1.5, (rand() * 2 - 1) * hd * 0.5];
      b.p = pos;
      b.v = [-side * speed * (0.75 + rand() * 0.5), 1 + rand() * 4, (rand() * 2 - 1) * 4 - b.p[2] * 0.4];
      b.q = randomQuat(rand);
      b.w = scale(randomUnit(rand), 14 + rand() * 16);
      placed.push(b);
    });
  }

  function applyImpulse(b, r, impulse) {
    b.v = add(b.v, scale(impulse, b.invMass));
    b.w = add(b.w, scale(cross(r, impulse), b.invInertia));
  }

  function solveWalls(b, bounds, cfg) {
    const { hw, hd } = bounds;
    const contacts = [];
    const push = [0, 0, 0];
    b.onFloor = false;
    for (const local of b.hull) {
      const r = Geo.quat.rotate(b.q, local);
      const x = b.p[0] + r[0];
      const y = b.p[1] + r[1];
      const z = b.p[2] + r[2];
      if (y < 0) { contacts.push({ r, n: [0, 1, 0] }); push[1] = Math.max(push[1], -y); b.onFloor = true; }
      if (y < 0.02) b.onFloor = true;
      if (x < -hw) { contacts.push({ r, n: [1, 0, 0] }); push[0] = Math.max(push[0], -hw - x); }
      if (x > hw) { contacts.push({ r, n: [-1, 0, 0] }); push[0] = Math.min(push[0], hw - x); }
      if (z < -hd) { contacts.push({ r, n: [0, 0, 1] }); push[2] = Math.max(push[2], -hd - z); }
      if (z > hd) { contacts.push({ r, n: [0, 0, -1] }); push[2] = Math.min(push[2], hd - z); }
    }
    if (!contacts.length) return;
    b.p = add(b.p, push);
    for (let iter = 0; iter < 4; iter++) {
      for (const c of contacts) {
        const { r, n } = c;
        const u = add(b.v, cross(b.w, r));
        const vn = dot(u, n);
        if (vn >= 0) continue;
        const e = iter === 0 && vn < -1.5 ? cfg.restitution : 0;
        const rn = cross(r, n);
        const kn = b.invMass + b.invInertia * dot(rn, rn);
        const jn = (-(1 + e) * vn) / kn;
        applyImpulse(b, r, scale(n, jn));
        // Coulomb friction against the sliding velocity at the contact.
        const u2 = add(b.v, cross(b.w, r));
        const ut = sub(u2, scale(n, dot(u2, n)));
        const speed = length(ut);
        if (speed > 1e-6) {
          const t = scale(ut, -1 / speed);
          const rt = cross(r, t);
          const kt = b.invMass + b.invInertia * dot(rt, rt);
          const jt = Math.min(speed / kt, cfg.friction * jn);
          applyImpulse(b, r, scale(t, jt));
        }
      }
    }
  }

  function solvePairs(bodies, cfg) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (a.asleep && b.asleep) continue;
        const d = sub(b.p, a.p);
        const dist = length(d);
        const min = a.sphere + b.sphere;
        if (dist >= min || dist < 1e-9) continue;
        const n = scale(d, 1 / dist);
        const overlap = min - dist;
        // Separate (sleeping dice act as heavy obstacles).
        const shareA = a.asleep ? 0 : b.asleep ? 1 : 0.5;
        a.p = sub(a.p, scale(n, overlap * shareA));
        b.p = add(b.p, scale(n, overlap * (1 - shareA)));
        const ra = scale(n, a.sphere);
        const rb = scale(n, -b.sphere);
        const u = sub(add(b.v, cross(b.w, rb)), add(a.v, cross(a.w, ra)));
        const vn = dot(u, n);
        if (vn >= 0) continue;
        if (vn < -0.8) {
          if (a.asleep) { a.asleep = false; a.calm = 0; a.sleepStep = -1; }
          if (b.asleep) { b.asleep = false; b.calm = 0; b.sleepStep = -1; }
        }
        const ima = a.asleep ? 0 : a.invMass;
        const imb = b.asleep ? 0 : b.invMass;
        if (ima + imb === 0) continue;
        const jn = (-(1 + cfg.dieRestitution) * vn) / (ima + imb);
        if (ima) applyImpulse(a, ra, scale(n, -jn * (ima / a.invMass)));
        if (imb) applyImpulse(b, rb, scale(n, jn * (imb / b.invMass)));
        // A little tangential friction makes knocked dice spin.
        const ut = sub(u, scale(n, vn));
        const s = length(ut);
        if (s > 1e-6) {
          const t = scale(ut, 1 / s);
          const jt = Math.min(s / (ima + imb + 1e-9) * 0.3, cfg.dieFriction * jn);
          if (ima) applyImpulse(a, ra, scale(t, jt));
          if (imb) applyImpulse(b, rb, scale(t, -jt));
        }
      }
    }
  }

  function integrate(b, cfg) {
    const dt = cfg.dt;
    b.v[1] -= cfg.gravity * dt;
    b.p = add(b.p, scale(b.v, dt));
    const [wx, wy, wz] = b.w;
    const q = b.q;
    const dq = quat.multiply([wx, wy, wz, 0], q);
    b.q = quat.normalize([q[0] + dq[0] * 0.5 * dt, q[1] + dq[1] * 0.5 * dt, q[2] + dq[2] * 0.5 * dt, q[3] + dq[3] * 0.5 * dt]);
    // Air drag, plus rolling resistance on the felt.
    b.v = scale(b.v, 1 - 0.05 * dt);
    b.w = scale(b.w, b.onFloor ? 1 - 2.4 * dt : 1 - 0.1 * dt);
  }

  function updateSleep(b, step, cfg) {
    const calm = b.onFloor && length(b.v) < 0.35 && length(b.w) < 1.2;
    b.calm = calm ? b.calm + 1 : 0;
    if (b.calm >= Math.round(0.12 / cfg.dt)) {
      b.asleep = true;
      b.sleepStep = step;
      b.v = [0, 0, 0];
      b.w = [0, 0, 0];
    }
  }

  /** Grid layout used for reduced motion (and as a fallback): no overlap, value up. */
  function restLayout(bodies, bounds, rand) {
    const n = bodies.length;
    const { hw, hd } = bounds;
    const cell = Math.max(...bodies.map((b) => b.sphere * 2.3));
    let cols = Math.max(1, Math.floor((hw * 2) / cell));
    let rows = Math.max(1, Math.ceil(n / cols));
    while (rows * cell > hd * 2 && cols * cell < hw * 2 * 1.6) { cols++; rows = Math.ceil(n / cols); }
    const cw = (hw * 2) / cols;
    const ch = (hd * 2) / Math.max(rows, 1);
    const order = [...Array(cols * rows).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Few dice: one centred row. More: shuffled cells of the grid.
    const used = order.slice(0, n).sort((a, b) => a - b);
    return bodies.map((b, i) => {
      const c = n <= cols ? i : used[i];
      const col = c % cols;
      const row = Math.floor(c / cols);
      const offsetX = n < cols ? ((cols - n) * cw) / 2 : 0;
      const jx = (rand() - 0.5) * Math.max(0, cw - b.sphere * 2) * 0.6;
      const jz = (rand() - 0.5) * Math.max(0, ch - b.sphere * 2) * 0.6;
      const rowsShown = n <= cols ? 1 : rows;
      const z0 = -((rowsShown * ch) / 2);
      return [
        -hw + offsetX + (col + 0.5) * cw + jx,
        b.inradius,
        z0 + ((n <= cols ? 0 : row) + 0.5) * ch + jz,
      ];
    });
  }

  /**
   * Of the symmetries that put value where physics left its top face, choose
   * the one whose number ends up most upright for the viewer (readDir is the
   * world direction that reads as "up" on screen). Physics is unaffected.
   */
  function pickSymmetry(kind, value, qEnd, physicalUp, readDir) {
    const options = Geo.symmetriesBetween(kind, value, physicalUp);
    const textUp = Geo.labelUp(kind, value);
    if (!textUp || options.length === 1) return options[0];
    let best = options[0];
    let bestScore = -Infinity;
    options.forEach((R) => {
      const score = dot(quat.rotate(quat.multiply(qEnd, R), textUp), readDir);
      if (score > bestScore) { bestScore = score; best = R; }
    });
    return best;
  }

  /** Rest orientation with value up and its number turned toward the viewer (± jitter radians). */
  function readableRest(kind, value, readDir, jitter) {
    const base = Geo.restQuaternion(kind, value, 0);
    const textUp = Geo.labelUp(kind, value);
    if (!textUp) return Geo.restQuaternion(kind, value, jitter + Math.PI * 2 * Math.random());
    const t = quat.rotate(base, textUp);
    const yaw = Math.atan2(t[0], t[2]) - Math.atan2(readDir[0], readDir[2]);
    return Geo.restQuaternion(kind, value, -yaw + jitter);
  }

  function clampInside(p, b, bounds) {
    const mx = Math.max(0, bounds.hw - b.inradius);
    const mz = Math.max(0, bounds.hd - b.inradius);
    return [Math.max(-mx, Math.min(mx, p[0])), b.inradius, Math.max(-mz, Math.min(mz, p[2]))];
  }

  /**
   * Plan a roll. dice: [{ kind, value, size }], bounds: { hw, hd } (inner half
   * extents of the tray floor, centred on the origin, floor at y = 0).
   * Returns a plan for poseAt(); plan.duration is the animation length in seconds.
   */
  function planRoll(options) {
    const cfg = Object.assign({}, DEFAULTS, options.config || {});
    const readDir = options.readDirection || [0, 0, -1];
    const rand = options.rand || Math.random;
    const bounds = options.bounds;
    const bodies = options.dice.map(makeBody);
    if (!bodies.length) return { dt: cfg.dt, duration: 0, dice: [], steps: 0 };

    if (options.reduced) {
      const spots = restLayout(bodies, bounds, rand);
      return {
        dt: cfg.dt,
        steps: 0,
        duration: 0,
        reduced: true,
        dice: bodies.map((b, i) => {
          const restQuat = readableRest(b.kind, b.value, readDir, (rand() - 0.5) * 0.6);
          return {
            kind: b.kind, value: b.value, size: b.size, frames: null, steps: 0,
            symmetry: quat.identity(), restPos: spots[i], restQuat, settleStart: 0, settleEnd: 0,
          };
        }),
      };
    }

    setupThrow(bodies, bounds, rand);
    const maxSteps = Math.ceil(cfg.maxTime / cfg.dt);
    const frames = bodies.map(() => new Float32Array((maxSteps + 1) * 7));
    const record = (step) => {
      bodies.forEach((b, i) => {
        const f = frames[i];
        const o = step * 7;
        f[o] = b.p[0]; f[o + 1] = b.p[1]; f[o + 2] = b.p[2];
        f[o + 3] = b.q[0]; f[o + 4] = b.q[1]; f[o + 5] = b.q[2]; f[o + 6] = b.q[3];
      });
    };
    record(0);
    let step = 0;
    while (step < maxSteps) {
      step++;
      bodies.forEach((b) => { if (!b.asleep) integrate(b, cfg); });
      solvePairs(bodies, cfg);
      bodies.forEach((b) => { if (!b.asleep) solveWalls(b, bounds, cfg); });
      bodies.forEach((b) => { if (!b.asleep) updateSleep(b, step, cfg); });
      record(step);
      if (bodies.every((b) => b.asleep)) break;
    }
    const steps = step;

    const dice = bodies.map((b, i) => {
      const endStep = b.asleep ? b.sleepStep : steps;
      const o = endStep * 7;
      const f = frames[i];
      const qEnd = quat.normalize([f[o + 3], f[o + 4], f[o + 5], f[o + 6]]);
      const pEnd = [f[o], f[o + 1], f[o + 2]];
      const physicalUp = Geo.valueUp(b.kind, qEnd);
      const symmetry = pickSymmetry(b.kind, b.value, qEnd, physicalUp, readDir);
      const shown = quat.multiply(qEnd, symmetry);
      const restQuat = Geo.snapToValue(b.kind, b.value, shown);
      const tEnd = endStep * cfg.dt;
      // A die left leaning on a neighbour needs a slightly longer, gentler snap.
      const settleAfter = cfg.settleAfter + quat.angle(shown, restQuat) * 0.4;
      return {
        kind: b.kind,
        value: b.value,
        size: b.size,
        frames: f,
        steps,
        physicalUp,
        symmetry,
        restPos: clampInside(pEnd, b, bounds),
        restQuat,
        settleStart: Math.max(0, tEnd - cfg.settleBefore),
        settleEnd: tEnd + settleAfter,
      };
    });
    return {
      dt: cfg.dt,
      steps,
      duration: Math.max(...dice.map((d) => d.settleEnd)),
      dice,
    };
  }

  /** Position and orientation of die i at time t (seconds) in a plan. */
  function poseAt(plan, i, t) {
    const d = plan.dice[i];
    if (!d.frames || t >= d.settleEnd) return { pos: d.restPos.slice(), quat: d.restQuat.slice(), settled: true };
    const x = Math.max(0, t / plan.dt);
    const s0 = Math.min(Math.floor(x), d.steps);
    const s1 = Math.min(s0 + 1, d.steps);
    const a = x - s0;
    const f = d.frames;
    const o0 = s0 * 7;
    const o1 = s1 * 7;
    let pos = [
      f[o0] + (f[o1] - f[o0]) * a,
      f[o0 + 1] + (f[o1 + 1] - f[o0 + 1]) * a,
      f[o0 + 2] + (f[o1 + 2] - f[o0 + 2]) * a,
    ];
    let q = quat.slerp(
      [f[o0 + 3], f[o0 + 4], f[o0 + 5], f[o0 + 6]],
      [f[o1 + 3], f[o1 + 4], f[o1 + 5], f[o1 + 6]],
      a,
    );
    q = quat.normalize(quat.multiply(q, d.symmetry));
    if (t > d.settleStart) {
      const k = smooth((t - d.settleStart) / Math.max(1e-6, d.settleEnd - d.settleStart));
      pos = [pos[0] + (d.restPos[0] - pos[0]) * k, pos[1] + (d.restPos[1] - pos[1]) * k, pos[2] + (d.restPos[2] - pos[2]) * k];
      q = quat.slerp(q, d.restQuat, k);
    }
    return { pos, quat: q, settled: false };
  }

  return { DEFAULTS, planRoll, poseAt, restLayout, randomQuat };
});
