/*
 * Dungeon Dice Box – 3D dice tray (three.js, vendored in vendor/three).
 *
 * Renders the roll that DiceCore already decided: real polyhedra tumble across
 * a felt floor inside wooden walls (motion from dice-physics.js) and come to
 * rest showing exactly the rolled values (orientation maths in
 * dice-geometry.js). Exposes window.DiceTray3D for script.js; if WebGL or this
 * module is unavailable, script.js keeps using the CSS tray animation.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const Geo = window.DiceGeometry;
const Phys = window.DicePhysics;

const HALF_WIDTH = 10; // world units; tray depth follows the container's aspect ratio
const WALL_HEIGHT = 0.9;
const WALL_THICK = 14; // walls run off-screen so the canvas edge always shows wood
const CAMERA_TILT = THREE.MathUtils.degToRad(15);
const MAX_PIXEL_RATIO = 2;

const STYLE = {
  d4: { a: '#5fd39b', b: '#12583a', ink: '#ffffff', edge: 'rgba(240,212,138,0.55)' },
  d6: { a: '#fbf3e2', b: '#c8b48a', ink: '#3a2412', edge: 'rgba(120,84,40,0.35)' },
  d8: { a: '#6d9cf0', b: '#1a3577', ink: '#ffffff', edge: 'rgba(240,212,138,0.55)' },
  d10: { a: '#b98cf0', b: '#44207a', ink: '#ffffff', edge: 'rgba(240,212,138,0.55)' },
  d12: { a: '#f3b955', b: '#8a4c0e', ink: '#ffffff', edge: 'rgba(255,240,200,0.55)' },
  d20: { a: '#f06a5f', b: '#7a1220', ink: '#ffffff', edge: 'rgba(240,212,138,0.6)' },
  d100t: { a: '#5b5b6b', b: '#121219', ink: '#f0d48a', edge: 'rgba(240,212,138,0.6)' },
  d100u: { a: '#6a6a7c', b: '#1a1a24', ink: '#f0d48a', edge: 'rgba(240,212,138,0.6)' },
};
const KIND_SCALE = { d4: 1.12, d6: 0.92, d8: 0.98, d10: 0.98, d12: 0.98, d20: 1, d100t: 0.98, d100u: 0.98 };
const FONT = '700 PX "Cinzel", "Trajan Pro", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';

const state = {
  ready: false,
  failed: false,
  tray: null,
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  bounds: { hw: HALF_WIDTH, hd: HALF_WIDTH * 9 / 16 },
  floor: null,
  walls: [],
  sun: null,
  diceGroup: null,
  dice: [], // { mesh, glow, plan index, info }
  fx: [], // extra scene objects (sparkles, flames, scorch marks) owned by the current dice
  fxRaf: 0,
  plan: null,
  raf: 0,
  safety: 0,
  finish: null,
  animating: false,
  width: 0,
  height: 0,
};

const assets = { geometry: {}, looks: new Map(), glowTexture: null, starTexture: null };
const MAX_LOOK_CACHE = 48; // kind × look materials kept around before the cache is flushed

// ------------------------------------------------------------------ helpers
function mixHex(a, b, t) {
  return '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
}

/** Relative luminance (0–1) of an sRGB "#rrggbb" colour. */
function srgbLuminance(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return 1;
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function hexAlpha(hex, a) {
  const n = new THREE.Color(hex).getHex();
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/** Canvas colours for one die kind in a player's look (null look / no body colour = classic rainbow). */
function styleFor(kind, look) {
  if (!look || !look.body) return Object.assign({ classic: true }, STYLE[kind]);
  const ink = look.ink || '#ffffff';
  return {
    classic: false,
    a: mixHex(look.body, '#ffffff', 0.1),
    b: mixHex(look.body, '#000000', kind === 'd100t' ? 0.62 : 0.5),
    ink,
    edge: hexAlpha(ink, 0.45),
  };
}

function lookKey(look) {
  if (!look || !look.body) return 'classic:' + ((look && look.finish) || 'glossy');
  return look.body + look.ink + ':' + (look.finish || 'glossy');
}

/** MeshPhysicalMaterial settings for a finish. */
function finishParams(finish, kind, classic) {
  if (finish === 'matte') return { roughness: 0.78, metalness: 0, clearcoat: 0.05, clearcoatRoughness: 0.6 };
  if (finish === 'metal') return { roughness: 0.3, metalness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.3 };
  if (finish === 'pearl') {
    return { roughness: 0.3, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.15, iridescence: 1, iridescenceIOR: 1.5,
      iridescenceThicknessRange: [180, 620], sheen: 0.25, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5 };
  }
  if (finish === 'gem') {
    return { roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.84, ior: 1.7, specularIntensity: 1 };
  }
  // glossy (the original look)
  if (kind === 'd6') return { roughness: 0.34, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 };
  if (classic && kind.startsWith('d100')) return { roughness: 0.38, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.22 };
  return { roughness: 0.3, metalness: 0.02, clearcoat: 0.7, clearcoatRoughness: 0.22 };
}

function font(px) {
  return FONT.replace('PX', Math.round(px) + 'px');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(canvas, srgb) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = state.renderer ? Math.min(8, state.renderer.capabilities.getMaxAnisotropy()) : 1;
  tex.needsUpdate = true;
  return tex;
}

/** Distance from the origin to the nearest edge of a polygon (normalised face layout). */
function polygonInradius(points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const d = Math.abs(x1 * y2 - x2 * y1) / Math.hypot(x2 - x1, y2 - y1);
    best = Math.min(best, d);
  }
  return best;
}

function drawLabel(ctx, text, x, y, px, style, rotation) {
  ctx.save();
  ctx.translate(x, y);
  if (rotation) ctx.rotate(rotation);
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const dark = srgbLuminance(style.ink) < 0.45;
  ctx.lineWidth = Math.max(2, px * 0.09);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.55)';
  ctx.strokeText(text, 0, px * 0.04);
  ctx.fillStyle = style.ink;
  ctx.fillText(text, 0, px * 0.04);
  if (text === '6' || text === '9') {
    // Underline 6 and 9 so they can't be confused.
    const w = ctx.measureText(text).width;
    ctx.fillRect(-w * 0.42, px * 0.46, w * 0.84, Math.max(2, px * 0.07));
  }
  ctx.restore();
}

function faceBackground(ctx, x, y, size, style) {
  const g = ctx.createRadialGradient(x + size * 0.42, y + size * 0.38, size * 0.05, x + size / 2, y + size / 2, size * 0.72);
  g.addColorStop(0, mixHex(style.a, style.b, 0.18));
  g.addColorStop(1, mixHex(style.a, style.b, 0.62));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, size, size);
}

// -------------------------------------------------------------- die meshes
/** Texture atlas + flat-shaded BufferGeometry for a polyhedral (non-d6) kind. */
function buildPolyhedron(kind, style, finish) {
  const die = Geo.getDie(kind);
  const F = die.faces.length;
  const cols = Math.ceil(Math.sqrt(F));
  const rows = Math.ceil(F / cols);
  const cell = 256;
  const canvas = makeCanvas(cols * cell, rows * cell);
  const ctx = canvas.getContext('2d');
  const k = 0.92; // keep the face polygon inside its cell

  const positions = [];
  const normals = [];
  const uvs = [];

  die.faces.forEach((face, fi) => {
    const col = fi % cols;
    const row = Math.floor(fi / cols);
    const ox = col * cell;
    const oy = row * cell;
    const cx = ox + cell / 2;
    const cy = oy + cell / 2;
    const toPx = (p) => [cx + p[0] * k * cell / 2, cy - p[1] * k * cell / 2];

    faceBackground(ctx, ox, oy, cell, style);
    // Thin inset edge line for crisp facets.
    ctx.beginPath();
    face.layout.points.forEach((p, i) => {
      const [x, y] = toPx([p[0] * 0.95, p[1] * 0.95]);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = style.edge;
    ctx.stroke();

    const inr = polygonInradius(face.layout.points) * k * cell / 2;
    if (die.read === 'vertex') {
      // d4: each corner carries its own number, pointing at the corner.
      face.layout.points.forEach((p, i) => {
        const [x, y] = toPx([p[0] * 0.5, p[1] * 0.5]);
        drawLabel(ctx, face.cornerLabels[i], x, y, inr * 0.78, style, Math.atan2(p[0], p[1]));
      });
    } else {
      const len = face.label.length;
      const px = inr * (len === 1 ? 1.3 : len === 2 ? 1.02 : 0.8);
      drawLabel(ctx, face.label, cx, cy, px, style, 0);
    }

    const n = face.normal;
    const tri = (a, b, c) => {
      [a, b, c].forEach((vi) => {
        const v = die.vertices[face.verts[vi]];
        positions.push(v[0], v[1], v[2]);
        normals.push(n[0], n[1], n[2]);
        const p = face.layout.points[vi];
        const [x, y] = toPx(p);
        uvs.push(x / canvas.width, 1 - y / canvas.height);
      });
    };
    for (let i = 1; i < face.verts.length - 1; i++) tri(0, i, i + 1);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  const material = new THREE.MeshPhysicalMaterial(Object.assign({ map: canvasTexture(canvas) }, finishParams(finish, kind, style.classic)));
  return { geometry, material };
}

const PIPS = { 1: [[0, 0]], 2: [[-1, 1], [1, -1]], 3: [[-1, 1], [0, 0], [1, -1]], 4: [[-1, 1], [1, 1], [-1, -1], [1, -1]],
  5: [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]], 6: [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]] };

/** Rounded cube with pips (matches the CSS d6). */
function buildD6(style, finish) {
  const die = Geo.getDie('d6');
  const edge = die.inradius * 2;
  const geometry = assets.geometry.d6 || new RoundedBoxGeometry(edge, edge, edge, 5, edge * 0.14);
  const materials = die.faces.map((face) => {
    const size = 256;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');
    faceBackground(ctx, 0, 0, size, style);
    const one = face.value === 1;
    PIPS[face.value].forEach(([px, py]) => {
      const x = size / 2 + px * size * 0.25;
      const y = size / 2 - py * size * 0.25;
      const r = size * (one ? 0.13 : 0.085);
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      if (style.classic) {
        g.addColorStop(0, one ? '#7a1220' : '#1e130a');
        g.addColorStop(1, one ? '#c02a35' : '#5a3a1c');
      } else {
        g.addColorStop(0, mixHex(style.ink, '#000000', 0.35));
        g.addColorStop(1, style.ink);
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
    });
    return new THREE.MeshPhysicalMaterial(Object.assign({ map: canvasTexture(canvas) }, finishParams(finish, 'd6', style.classic)));
  });
  return { geometry, material: materials };
}

/** Geometry (shared per kind) and material (per kind × player look). */
function kindAssets(kind, look) {
  const key = kind + '|' + lookKey(look);
  let material = assets.looks.get(key);
  if (!material) {
    const style = styleFor(kind, look);
    const finish = (look && look.finish) || 'glossy';
    const built = kind === 'd6' ? buildD6(style, finish) : buildPolyhedron(kind, style, finish);
    if (!assets.geometry[kind]) assets.geometry[kind] = built.geometry;
    else if (built.geometry !== assets.geometry[kind]) built.geometry.dispose();
    material = built.material;
    assets.looks.set(key, material);
  }
  return { geometry: assets.geometry[kind], material };
}

/** Free cached look materials once too many have piled up (only between rolls, when no mesh uses them). */
function trimLookCache() {
  if (assets.looks.size <= MAX_LOOK_CACHE) return;
  assets.looks.forEach((m) => {
    (Array.isArray(m) ? m : [m]).forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); });
  });
  assets.looks.clear();
}

function cloneMaterial(m) {
  return Array.isArray(m) ? m.map((x) => x.clone()) : m.clone();
}

function eachMaterial(mesh, fn) {
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(fn);
}

// -------------------------------------------------------------- the table
function feltTexture() {
  const size = 1024;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
  g.addColorStop(0, '#2f5e46');
  g.addColorStop(0.55, '#1c3d2c');
  g.addColorStop(1, '#0d2219');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Felt fibres: lots of faint specks.
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? 'rgba(255,255,255,' + (0.02 + Math.random() * 0.05) + ')' : 'rgba(0,0,0,' + (0.04 + Math.random() * 0.08) + ')';
    ctx.fillRect(x, y, 1 + Math.random() * 1.5, 1);
  }
  return canvasTexture(canvas);
}

function woodTexture() {
  const w = 1024;
  const h = 256;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#6b4428');
  g.addColorStop(0.35, '#4a2d18');
  g.addColorStop(0.6, '#5c3a20');
  g.addColorStop(1, '#33200f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 140; i++) {
    const y = Math.random() * h;
    const amp = 2 + Math.random() * 6;
    const freq = 0.004 + Math.random() * 0.01;
    const phase = Math.random() * 10;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const yy = y + Math.sin(x * freq + phase) * amp;
      if (x) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
    }
    ctx.lineWidth = 0.6 + Math.random() * 1.6;
    ctx.strokeStyle = Math.random() < 0.6 ? 'rgba(20,10,4,0.22)' : 'rgba(255,220,170,0.06)';
    ctx.stroke();
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function glowTexture() {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(canvas);
}

/** Soft teardrop flame (white; tinted per sprite). */
function flameTexture() {
  const w = 64;
  const h = 128;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.bezierCurveTo(w * 0.62, h * 0.3, w * 0.98, h * 0.55, w * 0.9, h * 0.75);
  ctx.bezierCurveTo(w * 0.82, h * 0.97, w * 0.18, h * 0.97, w * 0.1, h * 0.75);
  ctx.bezierCurveTo(w * 0.02, h * 0.55, w * 0.38, h * 0.3, w / 2, 2);
  ctx.closePath();
  const g = ctx.createRadialGradient(w / 2, h * 0.72, 1, w / 2, h * 0.62, h * 0.48);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.filter = 'blur(2px)';
  ctx.fill();
  return canvasTexture(canvas);
}

/** Four-pointed twinkle for lucky dice. */
function starTexture() {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? c : c * 0.16;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  return canvasTexture(canvas);
}

function buildTable() {
  const scene = state.scene;
  const floorMat = new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 1, metalness: 0 });
  state.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
  state.floor.rotation.x = -Math.PI / 2;
  state.floor.receiveShadow = true;
  scene.add(state.floor);

  const wood = woodTexture();
  const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.62, metalness: 0.04, color: 0xffffff });
  for (let i = 0; i < 4; i++) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    state.walls.push(wall);
  }
  // Brass trim along the inner top edge of the walls.
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xd9b25f, roughness: 0.35, metalness: 0.85 });
  state.trims = [];
  for (let i = 0; i < 4; i++) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), trimMat);
    scene.add(trim);
    state.trims.push(trim);
  }
  layoutTable();
}

function layoutTable() {
  const { hw, hd } = state.bounds;
  const T = WALL_THICK;
  const H = WALL_HEIGHT;
  state.floor.scale.set(hw * 2 + 0.2, hd * 2 + 0.2, 1);
  const [left, right, back, front] = state.walls;
  left.scale.set(T, H, hd * 2 + T * 2); left.position.set(-hw - T / 2, H / 2, 0);
  right.scale.set(T, H, hd * 2 + T * 2); right.position.set(hw + T / 2, H / 2, 0);
  back.scale.set(hw * 2, H, T); back.position.set(0, H / 2, -hd - T / 2);
  front.scale.set(hw * 2, H, T); front.position.set(0, H / 2, hd + T / 2);
  state.walls.forEach((w) => {
    // Keep the grain at a sensible scale on every wall.
    const tex = w.material.map;
    tex.repeat.set(1.5, 1);
  });
  const t = 0.07;
  const [tl, tr, tb, tf] = state.trims;
  tl.scale.set(t, t, hd * 2 + t * 2); tl.position.set(-hw - t / 2, H + t / 2, 0);
  tr.scale.set(t, t, hd * 2 + t * 2); tr.position.set(hw + t / 2, H + t / 2, 0);
  tb.scale.set(hw * 2, t, t); tb.position.set(0, H + t / 2, -hd - t / 2);
  tf.scale.set(hw * 2, t, t); tf.position.set(0, H + t / 2, hd + t / 2);

  const s = state.sun.shadow.camera;
  s.left = -hw - 2; s.right = hw + 2; s.top = hd + 2; s.bottom = -hd - 2;
  s.updateProjectionMatrix();
}

function fitCamera() {
  const cam = state.camera;
  const { hw, hd } = state.bounds;
  cam.aspect = state.width / Math.max(1, state.height);
  const dir = new THREE.Vector3(0, Math.cos(CAMERA_TILT), Math.sin(CAMERA_TILT));
  const pts = [];
  for (const x of [-hw, hw]) for (const z of [-hd, hd]) pts.push(new THREE.Vector3(x, WALL_HEIGHT, z));
  const target = new THREE.Vector3(0, 0, 0);
  const fits = (dist) => {
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return pts.every((p) => {
      const v = p.clone().project(cam);
      return Math.abs(v.x) <= 0.99 && Math.abs(v.y) <= 0.99;
    });
  };
  for (let pass = 0; pass < 3; pass++) {
    let lo = 2;
    let hi = 400;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    fits(hi);
    // Re-centre vertically so the near and far walls get equal margins.
    const ys = pts.map((p) => p.clone().project(cam).y);
    const off = (Math.max(...ys) + Math.min(...ys)) / 2;
    if (Math.abs(off) < 0.005) break;
    target.z -= off * hd * 0.5;
  }
}

function measure() {
  const rect = state.tray.getBoundingClientRect();
  state.width = Math.max(1, Math.round(rect.width));
  state.height = Math.max(1, Math.round(rect.height));
}

function boundsForSize() {
  const aspect = state.height / Math.max(1, state.width);
  return { hw: HALF_WIDTH, hd: Math.max(4, Math.min(16, HALF_WIDTH * aspect / Math.cos(CAMERA_TILT) * 0.96)) };
}

function render() {
  if (state.renderer) state.renderer.render(state.scene, state.camera);
}

// -------------------------------------------------------------------- init
function init() {
  if (state.ready) return true;
  if (state.failed) return false;
  try {
    if (!Geo || !Phys) throw new Error('dice geometry/physics scripts missing');
    const tray = document.getElementById('tray');
    if (!tray) throw new Error('no tray');
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) throw new Error('WebGL unavailable');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();

    state.tray = tray;
    const canvas = document.createElement('canvas');
    canvas.className = 'tray-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    tray.insertBefore(canvas, document.getElementById('tray-more'));
    state.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    state.renderer = renderer;

    const scene = new THREE.Scene();
    state.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xffe2b0, 0x0b1a12, 0.45));
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
    sun.position.set(-7, 22, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.radius = 5;
    sun.shadow.blurSamples = 12;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    state.sun = sun;
    // Warm candle glow from the far corner.
    const candle = new THREE.PointLight(0xff9a3c, 55, 40, 2);
    candle.position.set(9, 6, -7);
    scene.add(candle);

    state.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 600);
    state.diceGroup = new THREE.Group();
    scene.add(state.diceGroup);
    assets.glowTexture = glowTexture();
    assets.starTexture = starTexture();
    assets.flameTexture = flameTexture();

    measure();
    state.bounds = boundsForSize();
    buildTable();
    renderer.setSize(state.width, state.height, false);
    fitCamera();

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      state.failed = true;
      state.ready = false;
      stopAnimation(true);
      hideCanvas();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(onResize).observe(tray);
    } else {
      window.addEventListener('resize', onResize);
    }
    state.ready = true;
    return true;
  } catch (err) {
    console.warn('3D dice tray unavailable, using the CSS tray instead:', err && err.message ? err.message : err);
    state.failed = true;
    if (state.canvas) state.canvas.remove();
    return false;
  }
}

let resizeQueued = false;
function onResize() {
  if (!state.ready || resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const oldW = state.width;
    const oldH = state.height;
    measure();
    if (state.width === oldW && state.height === oldH) return;
    state.renderer.setSize(state.width, state.height, false);
    if (!state.animating) {
      // Between rolls the tray can reshape: stretch settled dice into the new floor.
      const next = boundsForSize();
      const sx = next.hw / state.bounds.hw;
      const sz = next.hd / state.bounds.hd;
      state.bounds = next;
      layoutTable();
      state.dice.forEach((d) => {
        const r = d.inradius;
        d.mesh.position.x = THREE.MathUtils.clamp(d.mesh.position.x * sx, -next.hw + r, next.hw - r);
        d.mesh.position.z = THREE.MathUtils.clamp(d.mesh.position.z * sz, -next.hd + r, next.hd - r);
        if (d.glow) d.glow.position.set(d.mesh.position.x, 0.012, d.mesh.position.z);
        if (d.halo) d.halo.position.set(d.mesh.position.x, 0.011, d.mesh.position.z);
        if (d.badge) d.badge.position.set(d.mesh.position.x + d.size * 0.75, d.mesh.position.y + d.size * 0.95, d.mesh.position.z);
      });
    }
    fitCamera();
    if (!state.canvas.hidden && !state.animating) render();
  });
}

// ---------------------------------------------------------------- dice life
function addFx(obj) {
  state.scene.add(obj);
  state.fx.push(obj);
  return obj;
}

function removeFx(obj) {
  const i = state.fx.indexOf(obj);
  if (i >= 0) state.fx.splice(i, 1);
  state.scene.remove(obj);
  if (obj.material) obj.material.dispose();
  if (obj.geometry && !obj.isSprite) obj.geometry.dispose();
}

function disposeFx() {
  cancelAnimationFrame(state.fxRaf);
  state.fxRaf = 0;
  state.fx.slice().forEach(removeFx);
  state.fx = [];
}

function sprite(texture, color, opacity, additive) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, color, transparent: true, opacity, depthWrite: false,
    blending: additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
  }));
  return s;
}

function floorDecal(color, size, opacity, additive) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: assets.glowTexture, color, transparent: true, opacity, depthWrite: false,
      blending: additive === false ? THREE.NormalBlending : THREE.AdditiveBlending }),
  );
  m.scale.set(size, size, 1);
  m.rotation.x = -Math.PI / 2;
  return m;
}

function disposeDice() {
  disposeFx();
  state.dice.forEach((d) => {
    eachMaterial(d.mesh, (m) => m.dispose());
    state.diceGroup.remove(d.mesh);
    if (d.glow) {
      d.glow.material.dispose();
      d.glow.geometry.dispose();
      state.scene.remove(d.glow);
    }
  });
  state.dice = [];
  state.plan = null;
  trimLookCache();
}

function hideCanvas() {
  if (state.canvas) state.canvas.hidden = true;
  if (state.tray) state.tray.classList.remove('is-3d');
}

function stopAnimation(resolve) {
  cancelAnimationFrame(state.raf);
  cancelAnimationFrame(state.fxRaf);
  state.fxRaf = 0;
  clearTimeout(state.safety);
  state.raf = 0;
  state.animating = false;
  const done = state.finish;
  state.finish = null;
  if (resolve && done) done();
}

function dieSize(count) {
  const { hw, hd } = state.bounds;
  return THREE.MathUtils.clamp(Math.sqrt((4 * hw * hd) / (Math.max(1, count) * 9)), 0.72, 1.75);
}

function applyHighlight(d) {
  const info = d.info;
  eachMaterial(d.mesh, (m) => {
    if (info.sign < 0) m.color.multiplyScalar(0.72);
    if (!info.kept) {
      m.transparent = true;
      m.opacity = 0.42;
      m.color.multiplyScalar(0.55);
      m.clearcoat = 0.2;
    } else if (info.crit) {
      m.emissive.set(0xf5c542);
      m.emissiveIntensity = 0.32;
    } else if (info.fumble) {
      m.emissive.set(0xe2553f);
      m.emissiveIntensity = 0.3;
    } else if (info.max) {
      m.emissive.set(0xf0d48a);
      m.emissiveIntensity = 0.05;
    }
    m.needsUpdate = true;
  });
  if (info.lucky) {
    // Lucky die: a soft clover-gold halo and a little star badge. Purely decorative.
    eachMaterial(d.mesh, (m) => {
      if (!info.crit && !info.fumble && !info.max) {
        m.emissive.set(0xffe08a);
        m.emissiveIntensity = 0.06;
      }
    });
    const halo = addFx(floorDecal(0xb8f07a, d.size * 3.2, info.kept ? 0.55 : 0.25));
    halo.position.set(d.mesh.position.x, 0.011, d.mesh.position.z);
    d.halo = halo;
    const badge = addFx(sprite(assets.starTexture, 0xfff1b0, info.kept ? 0.95 : 0.5));
    badge.scale.setScalar(d.size * 0.55);
    badge.position.set(d.mesh.position.x + d.size * 0.75, d.mesh.position.y + d.size * 0.95, d.mesh.position.z);
    d.badge = badge;
  }
  if (info.kept && (info.crit || info.fumble || info.max)) {
    const color = info.crit ? 0xf5c542 : info.fumble ? 0xe2553f : 0xf0d48a;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: assets.glowTexture, color, transparent: true, opacity: info.max ? 0.45 : 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const s = d.size * (info.max ? 3 : 3.8);
    glow.scale.set(s, s, 1);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(d.mesh.position.x, 0.012, d.mesh.position.z);
    state.scene.add(glow);
    d.glow = glow;
  }
}

function setPose(d, pose) {
  d.mesh.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  d.mesh.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
}

/**
 * Show a roll. list: [{ sides, value, sign, kept, crit, fumble }] in display
 * order (already capped by script.js). Resolves once every die has settled.
 */
function roll(list, options) {
  if (!init()) return Promise.reject(new Error('3D tray unavailable'));
  const reduced = !!(options && options.reduced);
  stopAnimation(true);
  disposeDice();

  measure();
  state.renderer.setSize(state.width, state.height, false);
  state.bounds = boundsForSize();
  layoutTable();
  fitCamera();

  const bodies = [];
  list.forEach((item) => {
    const parts = Geo.bodiesFor(item.sides, item.value);
    if (!parts) return;
    parts.forEach((p) => bodies.push({ kind: p.kind, value: p.value, info: Object.assign({
      max: item.kept && item.value === item.sides && !item.crit,
    }, item) }));
  });
  const look = (options && options.look) || null;
  const size = dieSize(bodies.length);
  const plan = Phys.planRoll({
    dice: bodies.map((b) => ({ kind: b.kind, value: b.value, size: size * KIND_SCALE[b.kind] })),
    bounds: state.bounds,
    reduced,
  });
  state.plan = plan;
  state.dice = bodies.map((b, i) => {
    const { geometry, material } = kindAssets(b.kind, look);
    const mesh = new THREE.Mesh(geometry, cloneMaterial(material));
    const s = plan.dice[i].size;
    mesh.scale.setScalar(s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    state.diceGroup.add(mesh);
    return { mesh, glow: null, info: b.info, kind: b.kind, value: b.value, size: s, inradius: Geo.getDie(b.kind).inradius * s };
  });

  state.canvas.hidden = false;
  state.tray.classList.add('is-3d');

  const settleAll = () => {
    state.dice.forEach((d, i) => {
      setPose(d, Phys.poseAt(plan, i, Infinity));
      applyHighlight(d);
    });
    render();
    if (!reduced) sparkleLucky();
  };

  if (reduced || plan.duration <= 0) {
    settleAll();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    state.animating = true;
    state.finish = resolve;
    const start = performance.now();
    const finish = () => {
      if (state.plan !== plan) return;
      stopAnimation(false);
      settleAll();
      resolve();
    };
    const frame = () => {
      if (state.plan !== plan) return;
      const t = (performance.now() - start) / 1000;
      if (t >= plan.duration) { finish(); return; }
      state.dice.forEach((d, i) => setPose(d, Phys.poseAt(plan, i, t)));
      render();
      state.raf = requestAnimationFrame(frame);
    };
    state.dice.forEach((d, i) => setPose(d, Phys.poseAt(plan, i, 0)));
    render();
    state.raf = requestAnimationFrame(frame);
    // Background tabs pause requestAnimationFrame; still deliver the result on time.
    const safety = () => {
      const left = plan.duration * 1000 - (performance.now() - start);
      if (left <= 0) finish();
      else state.safety = setTimeout(safety, left + 250);
    };
    state.safety = setTimeout(safety, plan.duration * 1000 + 250);
  });
}

/** A short burst of twinkling stars around lucky dice after they settle (skipped for reduced motion). */
function sparkleLucky(targets, duration) {
  const lucky = targets || state.dice.filter((d) => d.info && d.info.lucky && d.info.kept);
  if (!lucky.length) return;
  const total = duration || 2.4;
  const stars = [];
  lucky.forEach((d) => {
    for (let k = 0; k < 9; k++) {
      const s = addFx(sprite(assets.starTexture, k % 3 === 0 ? 0xb8f07a : 0xffe7a0, 0));
      stars.push({ s, d, angle: (k / 9) * Math.PI * 2 + Math.random() * 0.4, radius: d.size * (0.9 + Math.random() * 0.7),
        height: d.size * (0.2 + Math.random() * 1.3), phase: Math.random() * Math.PI * 2, speed: 5 + Math.random() * 5,
        scale: d.size * (0.35 + Math.random() * 0.4) });
    }
  });
  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const env = Math.min(1, t / 0.25) * Math.min(1, Math.max(0, (total - t) / 0.6));
    stars.forEach((st) => {
      const tw = Math.abs(Math.sin(t * st.speed + st.phase));
      const a = st.angle + t * 0.9;
      st.s.position.set(st.d.mesh.position.x + Math.cos(a) * st.radius, st.d.mesh.position.y + st.height + t * 0.25,
        st.d.mesh.position.z + Math.sin(a) * st.radius);
      st.s.scale.setScalar(st.scale * (0.35 + 0.65 * tw));
      st.s.material.opacity = env * (0.35 + 0.65 * tw);
    });
    render();
    if (t < total) {
      state.fxRaf = requestAnimationFrame(frame);
    } else {
      state.fxRaf = 0;
      stars.forEach((st) => removeFx(st.s));
      render();
    }
  };
  cancelAnimationFrame(state.fxRaf);
  state.fxRaf = requestAnimationFrame(frame);
}

/**
 * Run a scripted animation; step(t) is called every frame with the animation
 * time in seconds. Time advances by at most 0.1 s per frame, so a slow device
 * (or a first-frame shader compile) plays the whole effect instead of skipping
 * to the end. If frames stop entirely (background tab), it finishes anyway.
 */
function timeline(duration, step) {
  return new Promise((resolve) => {
    state.animating = true;
    state.finish = resolve;
    let t = 0;
    let last = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Like stopAnimation(false), but lets an fx burst (sparkles) finish on its own.
      cancelAnimationFrame(state.raf);
      clearTimeout(state.safety);
      state.raf = 0;
      state.animating = false;
      state.finish = null;
      step(duration);
      render();
      resolve();
    };
    const frame = () => {
      if (done || state.finish !== resolve) return;
      const now = performance.now();
      t += Math.min((now - last) / 1000, 0.1);
      last = now;
      if (t >= duration) { finish(); return; }
      step(t);
      render();
      seen = performance.now();
      state.raf = requestAnimationFrame(frame);
    };
    step(0);
    render();
    last = performance.now();
    let seen = last;
    state.raf = requestAnimationFrame(frame);
    const watchdog = () => {
      if (done || state.finish !== resolve) return;
      if (performance.now() - seen > 1500) finish(); // frames stalled: deliver the end state
      else state.safety = setTimeout(watchdog, 500);
    };
    state.safety = setTimeout(watchdog, duration * 1000 + 400);
  });
}

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Meshes for one die of the given type resting at (x, z), using the player's look. */
function placeDie(sides, value, look, x, z, size, info) {
  const parts = Geo.bodiesFor(sides, value) || [];
  const plan = Phys.planRoll({
    dice: parts.map((p) => ({ kind: p.kind, value: p.value, size: size * KIND_SCALE[p.kind] })),
    bounds: state.bounds,
    reduced: true,
  });
  return parts.map((p, i) => {
    const { geometry, material } = kindAssets(p.kind, look);
    const mesh = new THREE.Mesh(geometry, cloneMaterial(material));
    const s = plan.dice[i].size;
    mesh.scale.setScalar(s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const pose = Phys.poseAt(plan, i, Infinity);
    const offset = parts.length > 1 ? (i - 0.5) * s * 2.3 : 0;
    mesh.position.set(x + offset, pose.pos[1], z);
    mesh.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
    state.diceGroup.add(mesh);
    const d = { mesh, glow: null, info: Object.assign({ kept: true, sign: 1, sides, value }, info), kind: p.kind, value: p.value, size: s,
      inradius: Geo.getDie(p.kind).inradius * s, restY: pose.pos[1] };
    state.dice.push(d);
    return d;
  });
}

/**
 * The ceremonial burning of a die: it trembles, catches fire, chars, melts
 * into a scorch mark, and a fresh replacement drops into the tray.
 * opts: { sides, look, reduced, lucky }. Resolves when the replacement has landed.
 */
function burn(opts) {
  if (!init()) return Promise.reject(new Error('3D tray unavailable'));
  const o = opts || {};
  const sides = o.sides;
  stopAnimation(true);
  disposeDice();
  measure();
  state.renderer.setSize(state.width, state.height, false);
  state.bounds = boundsForSize();
  layoutTable();
  fitCamera();
  state.canvas.hidden = false;
  state.tray.classList.add('is-3d');

  const size = THREE.MathUtils.clamp(state.bounds.hd * 0.32, 1.1, 2.1);
  const doomedX = -size * 1.1;
  const freshX = size * 1.7;
  const scorch = addFx(floorDecal(0x000000, size * 4, 0, false));
  scorch.position.set(doomedX, 0.013, 0.2);

  if (o.reduced) {
    scorch.material.opacity = 0.7;
    placeDie(sides, sides, o.look, freshX, 0.2, size, {});
    render();
    return Promise.resolve();
  }

  const doomed = placeDie(sides, 1, o.look, doomedX, 0.2, size, { lucky: !!o.lucky });
  const original = doomed.map((d) => {
    const mats = [];
    eachMaterial(d.mesh, (m) => {
      m.transparent = true;
      mats.push({ m, color: m.color.clone(), opacity: m.opacity });
    });
    return mats;
  });
  const charcoal = new THREE.Color(0x24170f);
  const fire = new THREE.Color(0xff6a1f);

  const light = addFx(new THREE.PointLight(0xff7a2a, 0, size * 9, 2));
  light.position.set(doomedX, size * 1.2, 0.2);

  const flames = [];
  const respawn = (f, t) => {
    const a = Math.random() * Math.PI * 2;
    const r = size * (0.15 + Math.random() * 0.6);
    f.ox = Math.cos(a) * r;
    f.oz = Math.sin(a) * r * 0.8;
    f.y0 = size * (0.2 + Math.random() * 0.6);
    f.born = t;
    f.life = 0.45 + Math.random() * 0.5;
    f.speed = size * (1.2 + Math.random() * 1.3);
    f.drift = (Math.random() - 0.5) * size * 0.6;
    f.big = 0.6 + Math.random() * 0.5;
  };
  for (let i = 0; i < 40; i++) {
    const s = addFx(sprite(assets.flameTexture, 0xffa040, 0));
    // Fire engulfs the die: draw flames over it rather than hiding them behind it.
    s.material.depthTest = false;
    s.renderOrder = 10;
    const f = { s };
    respawn(f, 0.95 + Math.random() * 0.8);
    flames.push(f);
  }
  const smoke = [];
  for (let i = 0; i < 14; i++) {
    const s = addFx(sprite(assets.glowTexture, 0x4a4440, 0, false));
    smoke.push({ s, born: 2.2 + i * 0.1, ox: (Math.random() - 0.5) * size, oz: (Math.random() - 0.5) * size * 0.6 });
  }

  const DURATION = 4.4;
  const FRESH_START = 3.45;
  let fresh = null;
  let freshSparkled = false;
  const tremble = (t) => (t > 0.15 && t < 1.25 ? Math.sin(t * 70) * size * 0.035 * (1 - smoothstep(0.9, 1.25, t)) : 0);

  return timeline(DURATION, (t) => {
    const burnK = smoothstep(1.0, 2.6, t); // how charred
    const env = smoothstep(0.95, 1.35, t) * (1 - smoothstep(2.7, 3.3, t)); // fire intensity
    const flicker = 0.75 + 0.25 * Math.sin(t * 37) * Math.sin(t * 23 + 1.3);
    const melt = smoothstep(2.25, 3.15, t);
    const fade = 1 - smoothstep(2.95, 3.3, t);

    doomed.forEach((d, i) => {
      const sy = 1 - melt * 0.85;
      const sxz = 1 + melt * 0.4;
      d.mesh.scale.set(d.size * sxz, d.size * sy, d.size * sxz);
      d.mesh.position.x = doomedX + (doomed.length > 1 ? (i - 0.5) * d.size * 2.3 : 0) + tremble(t);
      d.mesh.position.y = d.restY * sy;
      d.mesh.visible = fade > 0.001;
      original[i].forEach(({ m, color, opacity }) => {
        m.color.copy(color).lerp(charcoal, burnK);
        m.emissive.copy(fire);
        m.emissiveIntensity = env * flicker * 0.6 + burnK * (1 - fade) * 0.3;
        m.opacity = opacity * fade;
        m.clearcoat = 0.7 * (1 - burnK);
      });
    });
    if (doomed[0] && doomed[0].badge) {
      doomed[0].badge.material.opacity = 0.95 * (1 - smoothstep(0.9, 1.4, t));
    }

    light.intensity = env * flicker * 40;
    scorch.material.opacity = 0.75 * smoothstep(1.4, 2.8, t);

    flames.forEach((f) => {
      let age = t - f.born;
      if (age > f.life && t < 2.85) { respawn(f, t); age = 0; }
      if (age < 0 || age > f.life) { f.s.material.opacity = 0; return; }
      const k = age / f.life;
      f.s.position.set(doomedX + f.ox * (1 - k * 0.5) + f.drift * k, f.y0 * (1 - melt * 0.6) + f.speed * age, 0.2 + f.oz);
      const fs = size * f.big * (0.75 + 0.5 * Math.sin(k * Math.PI)) * (1 - k * 0.5);
      f.s.scale.set(fs, fs * 1.8, 1);
      f.s.material.color.setHSL(0.11 - k * 0.09, 1, 0.5 - k * 0.18);
      f.s.material.opacity = env * Math.sin(k * Math.PI) * 0.6;
    });
    smoke.forEach((m) => {
      const age = t - m.born;
      if (age < 0) { m.s.material.opacity = 0; return; }
      const k = Math.min(1, age / 1.6);
      m.s.position.set(doomedX + m.ox + k * size * 0.4, size * 0.6 + age * size * 1.3, 0.2 + m.oz);
      m.s.scale.setScalar(size * (1 + k * 2));
      m.s.material.opacity = 0.32 * Math.sin(k * Math.PI);
    });

    if (t >= FRESH_START && !fresh) {
      fresh = placeDie(sides, sides, o.look, freshX, 0.2, size, {});
    }
    if (fresh) {
      const k = THREE.MathUtils.clamp((t - FRESH_START) / 0.6, 0, 1);
      // Drop with a little bounce.
      const bounce = k < 0.7 ? 1 - Math.pow(k / 0.7, 2) : Math.sin(((k - 0.7) / 0.3) * Math.PI) * 0.12;
      fresh.forEach((d) => { d.mesh.position.y = d.restY + bounce * size * 4; });
      if (k >= 1 && !freshSparkled) {
        freshSparkled = true;
        sparkleLucky(fresh, 1.1);
      }
    }
  }).then(() => {
    doomed.forEach((d) => {
      eachMaterial(d.mesh, (m) => m.dispose());
      state.diceGroup.remove(d.mesh);
    });
    state.dice = state.dice.filter((d) => !doomed.includes(d));
    flames.forEach((f) => removeFx(f.s));
    smoke.forEach((m) => removeFx(m.s));
    removeFx(light);
    if (!fresh) fresh = placeDie(sides, sides, o.look, freshX, 0.2, size, {});
    fresh.forEach((d) => { d.mesh.position.y = d.restY; });
    render();
  });
}

/** Remove every die and hide the 3D tray (between rolls / when the selection changes). */
function clear() {
  if (!state.ready) return;
  stopAnimation(true);
  disposeDice();
  hideCanvas();
}

/** Debug/test helper: the value each rendered mesh currently shows on top. */
function inspect() {
  return state.dice.map((d) => {
    const q = d.mesh.quaternion;
    return { kind: d.kind, value: d.value, shown: Geo.valueUp(d.kind, [q.x, q.y, q.z, q.w]), position: d.mesh.position.toArray() };
  });
}

window.DiceTray3D = {
  available: () => init(),
  roll,
  burn,
  clear,
  inspect,
  get animating() { return state.animating; },
};
