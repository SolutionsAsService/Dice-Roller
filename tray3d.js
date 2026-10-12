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
  plan: null,
  raf: 0,
  safety: 0,
  finish: null,
  animating: false,
  width: 0,
  height: 0,
};

const assets = { geometry: {}, materials: {}, glowTexture: null };

// ------------------------------------------------------------------ helpers
function mixHex(a, b, t) {
  return '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
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
  const dark = style.ink !== '#ffffff' && style.ink !== '#f0d48a';
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
function buildPolyhedron(kind) {
  const die = Geo.getDie(kind);
  const style = STYLE[kind];
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
  const material = new THREE.MeshPhysicalMaterial({
    map: canvasTexture(canvas),
    roughness: kind.startsWith('d100') ? 0.38 : 0.3,
    metalness: kind.startsWith('d100') ? 0.25 : 0.02,
    clearcoat: 0.7,
    clearcoatRoughness: 0.22,
  });
  return { geometry, material };
}

const PIPS = { 1: [[0, 0]], 2: [[-1, 1], [1, -1]], 3: [[-1, 1], [0, 0], [1, -1]], 4: [[-1, 1], [1, 1], [-1, -1], [1, -1]],
  5: [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]], 6: [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]] };

/** Rounded cube with pips (matches the CSS d6). */
function buildD6() {
  const die = Geo.getDie('d6');
  const style = STYLE.d6;
  const edge = die.inradius * 2;
  const geometry = new RoundedBoxGeometry(edge, edge, edge, 5, edge * 0.14);
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
      g.addColorStop(0, one ? '#7a1220' : '#1e130a');
      g.addColorStop(1, one ? '#c02a35' : '#5a3a1c');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
    });
    return new THREE.MeshPhysicalMaterial({
      map: canvasTexture(canvas),
      roughness: 0.34,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    });
  });
  return { geometry, material: materials };
}

function kindAssets(kind) {
  if (!assets.geometry[kind]) {
    const built = kind === 'd6' ? buildD6() : buildPolyhedron(kind);
    assets.geometry[kind] = built.geometry;
    assets.materials[kind] = built.material;
  }
  return { geometry: assets.geometry[kind], material: assets.materials[kind] };
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
      });
    }
    fitCamera();
    if (!state.canvas.hidden && !state.animating) render();
  });
}

// ---------------------------------------------------------------- dice life
function disposeDice() {
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
}

function hideCanvas() {
  if (state.canvas) state.canvas.hidden = true;
  if (state.tray) state.tray.classList.remove('is-3d');
}

function stopAnimation(resolve) {
  cancelAnimationFrame(state.raf);
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
  const size = dieSize(bodies.length);
  const plan = Phys.planRoll({
    dice: bodies.map((b) => ({ kind: b.kind, value: b.value, size: size * KIND_SCALE[b.kind] })),
    bounds: state.bounds,
    reduced,
  });
  state.plan = plan;
  state.dice = bodies.map((b, i) => {
    const { geometry, material } = kindAssets(b.kind);
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
  clear,
  inspect,
  get animating() { return state.animating; },
};
