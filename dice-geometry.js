/*
 * Dungeon Dice Box – polyhedral dice geometry (pure math, no three.js, no DOM).
 *
 * Describes every die shape the 3D tray renders: vertices, faces, which value
 * each face carries, the local direction that must point "up" for a given
 * value, the exact rest orientation for a value, and the rotational symmetries
 * used to re-label a physically simulated die so it lands on the value that
 * DiceCore already rolled. Physics never decides a result.
 *
 * Works as a classic browser script (window.DiceGeometry) and in Node
 * (module.exports) so the maths can be unit-tested without WebGL.
 *
 * Conventions: vectors are [x, y, z]; quaternions are [x, y, z, w]; world up is
 * +Y. Shapes are normalised to a circumradius of 1 (scale them when rendering).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.DiceGeometry = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;
  const UP = Object.freeze([0, 1, 0]);
  const PHI = (1 + Math.sqrt(5)) / 2;

  // ------------------------------------------------------------ vector math
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = (a) => Math.sqrt(dot(a, a));
  const normalize = (a) => {
    const l = length(a);
    return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
  };

  // -------------------------------------------------------- quaternion math
  const quatIdentity = () => [0, 0, 0, 1];

  function quatMultiply(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  }

  function quatNormalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  function quatConjugate(q) {
    return [-q[0], -q[1], -q[2], q[3]];
  }

  function quatFromAxisAngle(axis, angle) {
    const n = normalize(axis);
    const s = Math.sin(angle / 2);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
  }

  /** Shortest rotation taking unit vector a onto unit vector b. */
  function quatFromUnitVectors(a, b) {
    let r = dot(a, b) + 1;
    let q;
    if (r < EPS) {
      // Opposite vectors: rotate 180° around any perpendicular axis.
      r = 0;
      q = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0, r] : [0, -a[2], a[1], r];
    } else {
      const c = cross(a, b);
      q = [c[0], c[1], c[2], r];
    }
    return quatNormalize(q);
  }

  function quatRotate(q, v) {
    // v' = q * v * q^-1, expanded.
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;
    return [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
  }

  function quatSlerp(a, b, t) {
    let [bx, by, bz, bw] = b;
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cos > 0.9995) {
      return quatNormalize([
        a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t,
      ]);
    }
    const theta = Math.acos(Math.min(1, cos));
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  }

  /** Angle (radians) between two orientations. */
  function quatAngle(a, b) {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, d));
  }

  // ------------------------------------------------------------ convex hull
  /** Faces of a convex polyhedron given its vertices (coplanar vertices merged). */
  function hullFaces(V) {
    const faces = [];
    const seen = new Set();
    const n = V.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          let normal = cross(sub(V[j], V[i]), sub(V[k], V[i]));
          if (length(normal) < EPS) continue;
          normal = normalize(normal);
          let d = dot(normal, V[i]);
          let above = 0;
          let below = 0;
          for (let m = 0; m < n; m++) {
            const s = dot(normal, V[m]) - d;
            if (s > 1e-5) above++;
            else if (s < -1e-5) below++;
          }
          if (above && below) continue;
          if (above) { normal = scale(normal, -1); d = -d; }
          const verts = [];
          for (let m = 0; m < n; m++) if (Math.abs(dot(normal, V[m]) - d) <= 1e-5) verts.push(m);
          const key = verts.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const center = scale(verts.reduce((acc, m) => add(acc, V[m]), [0, 0, 0]), 1 / verts.length);
          const ref = normalize(sub(V[verts[0]], center));
          const side = cross(normal, ref);
          const ang = (m) => {
            const p = sub(V[m], center);
            const a = Math.atan2(dot(p, side), dot(p, ref));
            return a < -1e-9 ? a + 2 * Math.PI : a;
          };
          verts.sort((a, b) => ang(a) - ang(b)); // counter-clockwise seen from outside
          faces.push({ verts, normal, center, distance: d });
        }
      }
    }
    return faces;
  }

  // ---------------------------------------------------------------- shapes
  function normalizeVertices(V) {
    const r = Math.max(...V.map(length));
    return V.map((v) => scale(v, 1 / r));
  }

  function tetrahedron() {
    return normalizeVertices([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]);
  }

  function cube() {
    const V = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) V.push([x, y, z]);
    return normalizeVertices(V);
  }

  function octahedron() {
    return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  }

  function dodecahedron() {
    const V = [];
    const a = 1 / PHI;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) V.push([x, y, z]);
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        V.push([0, s1 * a, s2 * PHI]);
        V.push([s1 * a, s2 * PHI, 0]);
        V.push([s1 * PHI, 0, s2 * a]);
      }
    }
    return normalizeVertices(V);
  }

  function icosahedron() {
    const V = [];
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        V.push([0, s1, s2 * PHI]);
        V.push([s1, s2 * PHI, 0]);
        V.push([s1 * PHI, 0, s2]);
      }
    }
    return normalizeVertices(V);
  }

  /**
   * Pentagonal trapezohedron (the classic d10): two apexes on the Y axis and
   * two staggered rings of five vertices. The ring height is solved so every
   * kite is exactly planar: y0 = h (1 - cos 36°) / (1 + cos 36°).
   */
  function trapezohedron() {
    const h = 1.05;
    const c = Math.cos(Math.PI / 5);
    const y0 = (h * (1 - c)) / (1 + c);
    const V = [[0, h, 0], [0, -h, 0]];
    for (let k = 0; k < 5; k++) {
      const a = (2 * Math.PI * k) / 5;
      V.push([Math.cos(a), y0, Math.sin(a)]);
    }
    for (let k = 0; k < 5; k++) {
      const a = (2 * Math.PI * k) / 5 + Math.PI / 5;
      V.push([Math.cos(a), -y0, Math.sin(a)]);
    }
    return normalizeVertices(V);
  }

  // ------------------------------------------------------------ die kinds
  function range(lo, hi) {
    const out = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  /*
   * Kinds: d4 d6 d8 d10 d12 d20 plus the two halves of a d100:
   *   d100t – tens die, faces 00 10 … 90 (value = tens digit 0–9)
   *   d100u – units die, faces 0 … 9   (value = units digit 0–9)
   * A d4 is read by the number at its top vertex, like a real d4.
   */
  const KIND_INFO = {
    d4: { shape: tetrahedron, read: 'vertex', values: range(1, 4) },
    d6: { shape: cube, read: 'face', values: range(1, 6) },
    d8: { shape: octahedron, read: 'face', values: range(1, 8) },
    d10: { shape: trapezohedron, read: 'face', values: range(1, 10) },
    d12: { shape: dodecahedron, read: 'face', values: range(1, 12) },
    d20: { shape: icosahedron, read: 'face', values: range(1, 20) },
    d100t: { shape: trapezohedron, read: 'face', values: range(0, 9) },
    d100u: { shape: trapezohedron, read: 'face', values: range(0, 9) },
  };
  const KINDS = Object.freeze(Object.keys(KIND_INFO));

  function labelFor(kind, value) {
    if (kind === 'd100t') return value === 0 ? '00' : String(value * 10);
    return String(value);
  }

  function isD10Shape(kind) {
    return kind === 'd10' || kind === 'd100t' || kind === 'd100u';
  }

  /** "Text up" direction for a face, before projecting onto the face plane. */
  function faceUpHint(kind, face, V) {
    if (isD10Shape(kind)) {
      // Numbers point toward the kite's apex (the vertex furthest from the equator).
      let best = face.verts[0];
      face.verts.forEach((i) => { if (Math.abs(V[i][1]) > Math.abs(V[best][1])) best = i; });
      return sub(V[best], face.center);
    }
    if (kind === 'd6') {
      return sub(scale(add(V[face.verts[0]], V[face.verts[1]]), 0.5), face.center);
    }
    return sub(V[face.verts[0]], face.center);
  }

  const cache = {};

  /**
   * Full description of a die kind (cached). Faces carry: verts (CCW from
   * outside), normal, center, value, label, and a 2D layout (u/v axes, radius,
   * per-vertex coordinates in [-1, 1]) used to place numbers on face textures.
   */
  function getDie(kind) {
    if (cache[kind]) return cache[kind];
    const info = KIND_INFO[kind];
    if (!info) throw new Error('Unknown die kind: ' + kind);
    const V = info.shape();
    let faces = hullFaces(V);

    if (kind === 'd6') {
      // Match THREE.BoxGeometry / RoundedBoxGeometry material groups: +x, -x, +y, -y, +z, -z.
      const order = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      faces = order.map((n) => faces.find((f) => dot(f.normal, n) > 0.99));
      [1, 6, 2, 5, 3, 4].forEach((v, i) => { faces[i].value = v; });
    } else if (info.read === 'face') {
      // Opposite faces sum to (min + max), like real dice.
      const lo = info.values[0];
      const hi = info.values[info.values.length - 1];
      let next = lo;
      faces.forEach((f) => {
        if (f.value !== undefined) return;
        const opp = faces.find((g) => g !== f && g.value === undefined && dot(g.normal, f.normal) < -0.999);
        f.value = next;
        if (opp) opp.value = lo + hi - next;
        next++;
      });
    }

    const vertexValues = info.read === 'vertex' ? info.values.slice() : null;

    faces.forEach((f, index) => {
      f.index = index;
      if (info.read === 'vertex') {
        f.value = null;
        f.label = null;
        f.cornerLabels = f.verts.map((i) => String(vertexValues[i])); // a d4 face shows its corners' values
      } else {
        f.label = labelFor(kind, f.value);
      }
      const hint = faceUpHint(kind, f, V);
      const vAxis = normalize(sub(hint, scale(f.normal, dot(hint, f.normal))));
      const uAxis = cross(vAxis, f.normal); // u × v = n: the texture is not mirrored from outside
      const pts = f.verts.map((i) => {
        const p = sub(V[i], f.center);
        return [dot(p, uAxis), dot(p, vAxis)];
      });
      const radius = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])));
      f.layout = { uAxis, vAxis, radius, points: pts.map((p) => [p[0] / radius, p[1] / radius]) };
    });

    const die = {
      kind,
      read: info.read,
      values: info.values.slice(),
      vertices: V,
      faces,
      vertexValues,
      inradius: faces[0].distance,
      circumradius: 1,
    };
    cache[kind] = die;
    return die;
  }

  /** Index of the face (face-read dice) or vertex (d4) that represents a value. */
  function featureForValue(kind, value) {
    const die = getDie(kind);
    const i = die.read === 'vertex'
      ? die.vertexValues.indexOf(value)
      : die.faces.findIndex((face) => face.value === value);
    if (i < 0) throw new RangeError(kind + ' has no value ' + value);
    return i;
  }

  /** Local unit vector that must point world-up for value to be the result. */
  function upNormal(kind, value) {
    const die = getDie(kind);
    const i = featureForValue(kind, value);
    return die.read === 'vertex' ? normalize(die.vertices[i]) : die.faces[i].normal.slice();
  }

  /** Value currently facing up for a die with orientation q. */
  function valueUp(kind, q) {
    const die = getDie(kind);
    let best = null;
    let bestY = -Infinity;
    die.values.forEach((v) => {
      const y = quatRotate(q, upNormal(kind, v))[1];
      if (y > bestY) { bestY = y; best = v; }
    });
    return best;
  }

  /** Exact resting orientation: value up, then spun yaw radians around world up. */
  function restQuaternion(kind, value, yaw) {
    const align = quatFromUnitVectors(upNormal(kind, value), UP);
    return quatNormalize(quatMultiply(quatFromAxisAngle(UP, yaw || 0), align));
  }

  /** Smallest correction that turns orientation q so value points exactly up. */
  function snapToValue(kind, value, q) {
    const current = normalize(quatRotate(q, upNormal(kind, value)));
    return quatNormalize(quatMultiply(quatFromUnitVectors(current, UP), q));
  }

  /** True when rotation R maps the die's vertex set onto itself. */
  function isSymmetry(kind, R, tol) {
    const V = getDie(kind).vertices;
    const t = tol || 1e-4;
    return V.every((v) => {
      const w = quatRotate(R, v);
      return V.some((u) => Math.abs(u[0] - w[0]) < t && Math.abs(u[1] - w[1]) < t && Math.abs(u[2] - w[2]) < t);
    });
  }

  const symCache = {};
  const allSymCache = {};

  /**
   * Every proper rotation R of the solid onto itself with R · up(fromValue) =
   * up(toValue) (one per rotational symmetry of the face, e.g. 3 for a d20
   * triangle, 4 for a d6 square, 1 for a d10 kite).
   */
  function symmetriesBetween(kind, fromValue, toValue) {
    const key = kind + ':' + fromValue + ':' + toValue;
    if (allSymCache[key]) return allSymCache[key];
    const V = getDie(kind).vertices;
    const a = upNormal(kind, fromValue);
    const b = upNormal(kind, toValue);
    const q0 = quatFromUnitVectors(a, b);
    const ref = quatRotate(q0, V.find((v) => Math.abs(dot(normalize(v), a)) < 0.999));
    const perp = (v) => normalize(sub(v, scale(b, dot(v, b))));
    const r0 = perp(ref);
    const found = [];
    for (const v of V) {
      if (Math.abs(dot(normalize(v), b)) > 0.999) continue;
      if (Math.abs(dot(v, b) - dot(ref, b)) > 1e-4) continue; // same height along the axis
      const r1 = perp(v);
      const angle = Math.atan2(dot(cross(r0, r1), b), dot(r0, r1));
      const R = quatNormalize(quatMultiply(quatFromAxisAngle(b, angle), q0));
      if (isSymmetry(kind, R) && !found.some((S) => quatAngle(S, R) < 1e-6)) found.push(R);
    }
    if (!found.length) throw new Error('No symmetry maps ' + kind + ' ' + fromValue + ' to ' + toValue);
    allSymCache[key] = found;
    return found;
  }

  /** Local "text up" direction of the label read for value (face dice), or null (d4). */
  function labelUp(kind, value) {
    const die = getDie(kind);
    if (die.read === 'vertex') return null;
    return die.faces[featureForValue(kind, value)].layout.vAxis.slice();
  }

  /**
   * A proper rotation R of the solid onto itself with R · up(fromValue) = up(toValue).
   * Rendering a simulated orientation q as q · R shows fromValue exactly where
   * physics put toValue without changing the die's shape, so every bounce and
   * collision stays physically identical.
   */
  function symmetryBetween(kind, fromValue, toValue) {
    const key = kind + ':' + fromValue + ':' + toValue;
    if (!symCache[key]) symCache[key] = symmetriesBetween(kind, fromValue, toValue)[0];
    return symCache[key];
  }

  /** Split a d100 result (1–100) into tens and units digits. 100 shows as "00" + "0". */
  function splitD100(value) {
    const v = value % 100;
    return { tens: Math.floor(v / 10), units: v % 10 };
  }

  /** Bodies (kind + face value) needed to show one DiceCore die, or null if unsupported. */
  function bodiesFor(sides, value) {
    if (sides === 100) {
      const s = splitD100(value);
      return [{ kind: 'd100t', value: s.tens }, { kind: 'd100u', value: s.units }];
    }
    const kind = 'd' + sides;
    return KIND_INFO[kind] ? [{ kind, value }] : null;
  }

  return {
    UP,
    KINDS,
    vec: { add, sub, scale, dot, cross, length, normalize },
    quat: {
      identity: quatIdentity,
      multiply: quatMultiply,
      normalize: quatNormalize,
      conjugate: quatConjugate,
      fromAxisAngle: quatFromAxisAngle,
      fromUnitVectors: quatFromUnitVectors,
      rotate: quatRotate,
      slerp: quatSlerp,
      angle: quatAngle,
    },
    hullFaces,
    getDie,
    labelFor,
    featureForValue,
    upNormal,
    valueUp,
    restQuaternion,
    snapToValue,
    isSymmetry,
    symmetryBetween,
    symmetriesBetween,
    labelUp,
    splitD100,
    bodiesFor,
  };
});
