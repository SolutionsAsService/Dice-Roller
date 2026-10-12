/*
 * Dungeon Dice Box – 3D dice tray (three.js, vendored in vendor/three).
 *
 * Renders the roll that DiceCore already decided: real polyhedra tumble across
 * a felt floor inside wooden walls (motion from dice-physics.js) and come to
 * rest showing exactly the rolled values (orientation maths in
 * dice-geometry.js). Every die can wear its own look (colours, pattern,
 * finish, number style, opacity, glow, inlay – see dice-profiles.js); hovering
 * or tapping a die names it. Also provides a small stand-alone preview
 * renderer for the die editor. Exposes window.DiceTray3D for script.js; if
 * WebGL or this module is unavailable, script.js keeps using the CSS tray.
 *
 * Performance: geometry is shared per die kind; textures/materials are cached
 * per (kind, look, resolution) and only cloned per mesh (clones share the
 * textures). With many different looks in one roll the texture resolution
 * steps down so ~20 individually styled dice stay light on memory.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const Geo = window.DiceGeometry;
const Phys = window.DicePhysics;
const Prof = window.DiceProfiles || null;

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
  d12: { a: '#f3b955', b: '#6e3a08', ink: '#ffffff', edge: 'rgba(255,240,200,0.55)' },
  d20: { a: '#f06a5f', b: '#7a1220', ink: '#ffffff', edge: 'rgba(240,212,138,0.6)' },
  d100t: { a: '#5b5b6b', b: '#121219', ink: '#f0d48a', edge: 'rgba(240,212,138,0.6)' },
  d100u: { a: '#6a6a7c', b: '#1a1a24', ink: '#f0d48a', edge: 'rgba(240,212,138,0.6)' },
};
const KIND_SCALE = { d4: 1.12, d6: 0.92, d8: 0.98, d10: 0.98, d12: 0.98, d20: 1, d100t: 0.98, d100u: 0.98 };
const KIND_SIDES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100t: 100, d100u: 100 };
const FONTS = {
  classic: '700 PX "Cinzel", "Trajan Pro", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif',
  sans: '800 PX system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fantasy: '400 PX "DiceFantasy", "Cinzel", Georgia, serif',
};
const EMOJI_FONT = '700 PX "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Segoe UI Symbol", system-ui, sans-serif';
const FANTASY_URL = new URL('./vendor/fonts/MedievalSharp/MedievalSharp.ttf', import.meta.url).href;

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
  dice: [], // { mesh, glow, info, kind, value, size, inradius, item }
  fx: [], // extra scene objects (sparkles, flames, scorch marks, glow pools) owned by the current dice
  fxRaf: 0,
  plan: null,
  raf: 0,
  safety: 0,
  finish: null,
  animating: false,
  width: 0,
  height: 0,
  // identity overlay
  overlay: null,
  tip: null,
  tags: [],
  showTags: false,
  ring: null,
  hoverItem: null,
  pinnedItem: null,
  externalItem: null,
  onHover: null,
  pointer: null,
  items: null, // the rolled dice (display order) the meshes belong to
  rollToken: 0,
};

const assets = { geometry: {}, looks: new Map(), glowTexture: null, starTexture: null, ringTexture: null };
const MAX_LOOK_CACHE = 64; // kind × look × resolution materials kept around (least recently used are freed between rolls)
const fontState = { fantasy: 'idle', promise: null };

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

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small seeded PRNG so a look always paints the same swirls/veins/specks (cosmetic only). */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Default appearance for a die type when the caller gave none (player look or classic). */
function fallbackAppearance(sides, look) {
  if (Prof) return Prof.resolveAppearance(look || null, null, sides);
  return { classic: true, pattern: 'solid', finish: (look && look.finish) || 'glossy', font: 'classic', pips: true, opacity: 1, glow: 0, inlay: null, inlayText: '' };
}

function keyOf(ap) {
  if (Prof) return Prof.appearanceKey(ap);
  return JSON.stringify(ap);
}

/** Everything the painters need for one die kind in one appearance. */
function styleFor(kind, ap) {
  const base = STYLE[kind];
  const classic = !!ap.classic;
  let a;
  let b;
  if (classic) {
    a = base.a; b = base.b;
  } else if (ap.pattern === 'solid') {
    a = mixHex(ap.body, '#ffffff', 0.1);
    b = kind === 'd100t' ? mixHex(ap.body2, '#000000', 0.25) : ap.body2;
  } else {
    a = ap.body; b = ap.body2;
  }
  const ink = classic ? base.ink : ap.ink;
  const edgeColor = ap.edge && !classic ? ap.edge : null;
  return {
    classic,
    kind,
    a,
    b,
    body: classic ? base.a : ap.body,
    body2: classic ? base.b : ap.body2,
    ink,
    edge: edgeColor ? hexAlpha(edgeColor, 0.9) : (classic ? base.edge : hexAlpha(ink, 0.45)),
    edgeWidth: edgeColor ? 5 : 3,
    pattern: classic ? 'solid' : ap.pattern,
    finish: ap.finish || 'glossy',
    font: fontState.fantasy !== 'loaded' && ap.font === 'fantasy' ? 'classic' : (ap.font || 'classic'),
    pips: kind !== 'd6' || ap.pips !== false,
    opacity: Number.isFinite(ap.opacity) ? ap.opacity : 1,
    glow: Number.isFinite(ap.glow) ? ap.glow : 0,
    glowColor: ap.glowColor || ink,
    inlay: ap.inlay || null,
    inlayText: ap.inlayText || '',
    seed: hashString(keyOf(ap) + kind),
  };
}

/** MeshPhysicalMaterial settings for a finish. */
function finishParams(finish, kind, classic) {
  if (finish === 'matte') return { roughness: 0.78, metalness: 0, clearcoat: 0.05, clearcoatRoughness: 0.6 };
  if (finish === 'metal') return { roughness: 0.3, metalness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.3 };
  if (finish === 'pearl') {
    return { roughness: 0.3, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.15, iridescence: 1, iridescenceIOR: 1.5,
      iridescenceThicknessRange: [180, 620], sheen: 0.25, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5 };
  }
  if (finish === 'gem') return { roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, ior: 1.7, specularIntensity: 1 };
  if (finish === 'glass') return { roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.6 };
  if (finish === 'glitter') {
    return { roughness: 0.32, metalness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.12, sheen: 0.35, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.3 };
  }
  if (finish === 'neon') return { roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3 };
  if (finish === 'wood') return { roughness: 0.68, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.45 };
  if (finish === 'bone') return { roughness: 0.6, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color(0xfff4d6), sheenRoughness: 0.7 };
  if (finish === 'stone') return { roughness: 0.92, metalness: 0, clearcoat: 0, clearcoatRoughness: 1 };
  // glossy (the original look)
  if (kind === 'd6') return { roughness: 0.34, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 };
  if (classic && kind.startsWith('d100')) return { roughness: 0.38, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.22 };
  return { roughness: 0.3, metalness: 0.02, clearcoat: 0.7, clearcoatRoughness: 0.22 };
}

/** Body opacity (numbers and edges stay solid). */
function bodyAlpha(st) {
  const k = st.finish === 'glass' ? 0.62 : st.finish === 'gem' ? 0.86 : 1;
  return Math.max(0.15, Math.min(1, st.opacity * k));
}

function needsAlpha(st) {
  return bodyAlpha(st) < 0.999;
}

function needsEmissiveMap(st) {
  return st.finish === 'neon' || st.finish === 'glitter';
}

function fontFor(st, px) {
  return (FONTS[st.font] || FONTS.classic).replace('PX', Math.round(px) + 'px');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(canvas, srgb, renderer) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  const r = renderer || state.renderer;
  tex.anisotropy = r ? Math.min(8, r.capabilities.getMaxAnisotropy()) : 1;
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

// --------------------------------------------------------- runic numerals
/**
 * "Runic (carved)" numbers: our own angular stroke digits, drawn as chisel
 * cuts (no font file needed). Coordinates: x 0–0.6, y 0–1 (top = 0).
 */
const RUNE_DIGITS = {
  0: [[[0.3, 0], [0.6, 0.22], [0.6, 0.78], [0.3, 1], [0, 0.78], [0, 0.22], [0.3, 0]]],
  1: [[[0.12, 0.2], [0.34, 0], [0.34, 1]], [[0.12, 1], [0.54, 1]]],
  2: [[[0, 0.18], [0.3, 0], [0.6, 0.18], [0.6, 0.38], [0, 1], [0.6, 1]]],
  3: [[[0, 0], [0.6, 0], [0.2, 0.44], [0.6, 0.66], [0.6, 0.82], [0.32, 1], [0, 0.86]]],
  4: [[[0.46, 1], [0.46, 0], [0, 0.66], [0.6, 0.66]]],
  5: [[[0.6, 0], [0.04, 0], [0, 0.46], [0.42, 0.42], [0.6, 0.6], [0.6, 0.82], [0.36, 1], [0, 0.9]]],
  6: [[[0.52, 0], [0, 0.56], [0, 0.82], [0.24, 1], [0.46, 1], [0.6, 0.84], [0.6, 0.6], [0.42, 0.46], [0.16, 0.46], [0, 0.56]]],
  7: [[[0, 0], [0.6, 0], [0.16, 1]], [[0.12, 0.52], [0.5, 0.52]]],
  8: [[[0.3, 0], [0.56, 0.24], [0.3, 0.48], [0.04, 0.24], [0.3, 0]], [[0.3, 0.48], [0.6, 0.74], [0.3, 1], [0, 0.74], [0.3, 0.48]]],
  9: [[[0.08, 1], [0.6, 0.44], [0.6, 0.18], [0.36, 0], [0.14, 0], [0, 0.16], [0, 0.4], [0.18, 0.54], [0.44, 0.54], [0.6, 0.44]]],
};

function drawRunes(ctx, text, px, color, outline) {
  const w = px * 0.6;
  const gap = px * 0.16;
  const chars = String(text).split('');
  const total = chars.length * w + (chars.length - 1) * gap;
  let x0 = -total / 2;
  const y0 = -px / 2;
  const strokeAll = (width, style) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    let x = x0;
    chars.forEach((ch) => {
      (RUNE_DIGITS[ch] || []).forEach((line) => {
        ctx.beginPath();
        line.forEach(([u, v], i) => {
          const X = x + u * px;
          const Y = y0 + v * px;
          if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        });
        ctx.stroke();
      });
      x += w + gap;
    });
  };
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'square';
  ctx.miterLimit = 3;
  if (outline) strokeAll(px * 0.2, outline);
  strokeAll(px * 0.12, color);
}

/**
 * Draw a face number. mode: 'color' | 'alpha' (solid white) | 'glow' (ink on black).
 */
function drawLabel(ctx, text, x, y, px, st, rotation, mode) {
  ctx.save();
  ctx.translate(x, y);
  if (rotation) ctx.rotate(rotation);
  const solid = mode === 'alpha' ? '#ffffff' : st.ink;
  const dark = srgbLuminance(st.ink) < 0.45;
  const outline = mode === 'color' ? (dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.55)') : null;
  const isDigits = /^[0-9]+$/.test(text);
  if (st.font === 'runic' && isDigits) {
    drawRunes(ctx, text, px * 0.82, solid, mode === 'alpha' ? '#ffffff' : outline);
  } else {
    ctx.font = fontFor(st, px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const dy = px * 0.04;
    if (outline || mode === 'alpha') {
      ctx.lineWidth = Math.max(2, px * (mode === 'alpha' ? 0.12 : 0.09));
      ctx.strokeStyle = mode === 'alpha' ? '#ffffff' : outline;
      ctx.strokeText(text, 0, dy);
    }
    ctx.fillStyle = solid;
    ctx.fillText(text, 0, dy);
  }
  if (text === '6' || text === '9') {
    // Underline 6 and 9 so they can't be confused.
    const w = px * 0.5;
    ctx.fillStyle = solid;
    ctx.fillRect(-w / 2, px * 0.48, w, Math.max(2, px * 0.07));
  }
  ctx.restore();
}

/** The inlay symbol (vector path or a short custom text/emoji). */
function drawInlay(ctx, st, x, y, size, mode) {
  ctx.save();
  ctx.translate(x, y);
  const info = Prof && Prof.INLAYS ? Prof.INLAYS[st.inlay] : null;
  if (st.inlay === 'text' && st.inlayText) {
    if (mode === 'alpha') {
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else {
      ctx.font = EMOJI_FONT.replace('PX', Math.round(size * (Array.from(st.inlayText).length > 1 ? 0.62 : 0.95)) + 'px');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = st.ink;
      if (mode === 'color') {
        ctx.lineWidth = Math.max(2, size * 0.06);
        ctx.strokeStyle = srgbLuminance(st.ink) < 0.45 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.5)';
        ctx.strokeText(st.inlayText, 0, size * 0.04);
      }
      ctx.fillText(st.inlayText, 0, size * 0.04);
    }
  } else if (info && info.path && typeof Path2D === 'function') {
    const path = new Path2D(info.path);
    const k = size / 24;
    ctx.scale(k, k);
    ctx.translate(-12, -12);
    const rule = info.evenodd ? 'evenodd' : 'nonzero';
    if (mode === 'color') {
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = srgbLuminance(st.ink) < 0.45 ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.55)';
      ctx.stroke(path);
    }
    ctx.fillStyle = mode === 'alpha' ? '#ffffff' : st.ink;
    ctx.fill(path, rule);
  }
  ctx.restore();
}

// ------------------------------------------------------- face backgrounds
/** Paint the body of one face cell (x, y, size) for the colour map. */
function paintBody(ctx, x, y, size, st, faceIndex) {
  const rnd = seeded(st.seed + faceIndex * 7919);
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  if (st.pattern === 'solid') {
    const g = ctx.createRadialGradient(x + size * 0.42, y + size * 0.38, size * 0.05, cx, cy, size * 0.72);
    g.addColorStop(0, mixHex(st.a, st.b, 0.18));
    g.addColorStop(1, mixHex(st.a, st.b, 0.62));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  } else if (st.pattern === 'gradient') {
    const ang = rnd() * Math.PI * 2;
    const dx = Math.cos(ang) * size * 0.55;
    const dy = Math.sin(ang) * size * 0.55;
    const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    g.addColorStop(0, st.body);
    g.addColorStop(1, st.body2);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  } else if (st.pattern === 'twotone') {
    ctx.fillStyle = st.body;
    ctx.fillRect(x, y, size, size);
    const ang = (faceIndex % 2 ? 0.25 : -0.25) * Math.PI + (rnd() - 0.5) * 0.4;
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = st.body2;
    ctx.fillRect(-size, 0, size * 2, size);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-size, -size * 0.008, size * 2, size * 0.016);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else if (st.pattern === 'speckle') {
    ctx.fillStyle = st.body;
    ctx.fillRect(x, y, size, size);
    const n = 70 + Math.floor(rnd() * 50);
    for (let i = 0; i < n; i++) {
      const r = size * (0.006 + rnd() * 0.018);
      ctx.beginPath();
      ctx.arc(x + rnd() * size, y + rnd() * size, r, 0, Math.PI * 2);
      ctx.fillStyle = rnd() < 0.8 ? st.body2 : mixHex(st.body, '#ffffff', 0.5);
      ctx.fill();
    }
  } else {
    // swirl / marble: base colour with ribbons or veins of the second colour.
    ctx.fillStyle = st.body;
    ctx.fillRect(x, y, size, size);
    const swirl = st.pattern === 'swirl';
    const strands = swirl ? 4 : 7;
    for (let s = 0; s < strands; s++) {
      let px = x + rnd() * size;
      let py = y + rnd() * size;
      let ang = rnd() * Math.PI * 2;
      const pts = [[px, py]];
      const steps = swirl ? 26 : 18;
      const curl = (rnd() - 0.5) * (swirl ? 0.5 : 1.1);
      for (let i = 0; i < steps; i++) {
        ang += curl + (rnd() - 0.5) * (swirl ? 0.15 : 0.9);
        px += Math.cos(ang) * size * 0.06;
        py += Math.sin(ang) * size * 0.06;
        pts.push([px, py]);
      }
      const passes = swirl ? [[0.16, 0.28], [0.1, 0.5], [0.05, 0.85]] : [[0.035, 0.25], [0.014, 0.8]];
      passes.forEach(([w, alpha]) => {
        ctx.beginPath();
        pts.forEach(([X, Y], i) => { if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.lineWidth = size * w * (swirl ? 1 : 0.6 + rnd());
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = hexAlpha(st.body2, alpha);
        ctx.stroke();
      });
      if (!swirl && rnd() < 0.5) {
        ctx.beginPath();
        pts.forEach(([X, Y], i) => { if (i) ctx.lineTo(X + 3, Y + 2); else ctx.moveTo(X + 3, Y + 2); });
        ctx.lineWidth = Math.max(1, size * 0.006);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
      }
    }
    // A soft light falloff so it still reads as a lit face.
    const g = ctx.createRadialGradient(x + size * 0.4, y + size * 0.35, size * 0.05, cx, cy, size * 0.75);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  }
  paintFinish(ctx, x, y, size, st, rnd, seeded(st.seed + faceIndex * 7919 + 3));
  ctx.restore();
}

/** Material texture on top of the body colours (wood grain, stone, bone, glitter). */
function paintFinish(ctx, x, y, size, st, rnd, glitterRnd) {
  if (st.finish === 'wood') {
    const dark = mixHex(st.body, '#000000', 0.45);
    for (let i = 0; i < 26; i++) {
      const yy = y + rnd() * size;
      const amp = size * (0.01 + rnd() * 0.03);
      const freq = (2 + rnd() * 4) / size;
      const ph = rnd() * 10;
      ctx.beginPath();
      for (let xx = 0; xx <= size; xx += size / 24) {
        const Y = yy + Math.sin(xx * freq + ph) * amp;
        if (xx) ctx.lineTo(x + xx, Y); else ctx.moveTo(x, Y);
      }
      ctx.lineWidth = size * (0.003 + rnd() * 0.01);
      ctx.strokeStyle = rnd() < 0.75 ? hexAlpha(dark, 0.35) : 'rgba(255,230,190,0.12)';
      ctx.stroke();
    }
    if (rnd() < 0.5) {
      ctx.beginPath();
      ctx.ellipse(x + rnd() * size, y + rnd() * size, size * 0.06, size * 0.03, rnd(), 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(dark, 0.5);
      ctx.fill();
    }
  } else if (st.finish === 'stone') {
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,' + (0.08 + rnd() * 0.18) + ')' : 'rgba(255,255,255,' + (0.05 + rnd() * 0.12) + ')';
      const s = size * (0.004 + rnd() * 0.012);
      ctx.fillRect(x + rnd() * size, y + rnd() * size, s, s);
    }
  } else if (st.finish === 'bone') {
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let px = x + rnd() * size;
      let py = y + rnd() * size;
      ctx.moveTo(px, py);
      for (let k = 0; k < 6; k++) {
        px += (rnd() - 0.5) * size * 0.12;
        py += (rnd() - 0.5) * size * 0.12;
        ctx.lineTo(px, py);
      }
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.strokeStyle = 'rgba(80,60,30,0.25)';
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(x + size * 0.5, y + size * 0.5, size * 0.1, x + size * 0.5, y + size * 0.5, size * 0.75);
    g.addColorStop(0, 'rgba(255,250,235,0)');
    g.addColorStop(1, 'rgba(120,95,50,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  } else if (st.finish === 'glitter') {
    paintGlitter(ctx, x, y, size, st, glitterRnd, 'color'); // same specks as the glow map
  }
}

function paintGlitter(ctx, x, y, size, st, rnd, mode) {
  const n = 160;
  for (let i = 0; i < n; i++) {
    const s = size * (0.004 + rnd() * 0.01);
    const light = rnd();
    if (mode === 'glow') ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + light * 0.75) + ')';
    else ctx.fillStyle = light < 0.6 ? 'rgba(255,255,255,0.85)' : hexAlpha(mixHex(st.body2, '#ffffff', 0.5), 0.9);
    ctx.fillRect(x + rnd() * size, y + rnd() * size, s, s);
  }
}

/** Background for the other maps: alpha (body opacity as grey) or glow (black + glow tint). */
function paintPlain(ctx, x, y, size, st, faceIndex, mode) {
  if (mode === 'alpha') {
    const v = Math.round(bodyAlpha(st) * 255);
    ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    ctx.fillRect(x, y, size, size);
    return;
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, size, size);
  if (st.glow > 0) {
    ctx.fillStyle = hexAlpha(st.glowColor, Math.min(1, st.glow * 0.8));
    ctx.fillRect(x, y, size, size);
  }
  if (st.finish === 'glitter') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    paintGlitter(ctx, x, y, size, st, seeded(st.seed + faceIndex * 7919 + 3), 'glow');
    ctx.restore();
  }
}

// -------------------------------------------------------------- die meshes
/** Grid layout of a polyhedral kind's faces in its texture atlas (resolution independent). */
function atlasLayout(kind) {
  const die = Geo.getDie(kind);
  const F = die.faces.length;
  const cols = Math.ceil(Math.sqrt(F));
  const rows = Math.ceil(F / cols);
  return { die, cols, rows, k: 0.92 };
}

/** Face (index) that carries the inlay: the highest value (d4: every face around the 4). */
function inlayFaces(kind) {
  const die = Geo.getDie(kind);
  if (die.read === 'vertex') {
    const top = String(KIND_SIDES[kind]);
    return new Set(die.faces.map((f, i) => (f.cornerLabels.includes(top) ? i : -1)).filter((i) => i >= 0));
  }
  let best = -Infinity;
  let at = -1;
  die.faces.forEach((f, i) => { if (f.value > best) { best = f.value; at = i; } });
  return new Set([at]);
}

/** Flat-shaded BufferGeometry with atlas UVs for a polyhedral (non-d6) kind; shared by every look. */
function polyGeometry(kind) {
  if (assets.geometry[kind]) return assets.geometry[kind];
  const { die, cols, rows, k } = atlasLayout(kind);
  const positions = [];
  const normals = [];
  const uvs = [];
  die.faces.forEach((face, fi) => {
    const col = fi % cols;
    const row = Math.floor(fi / cols);
    const n = face.normal;
    const tri = (a, b, c) => {
      [a, b, c].forEach((vi) => {
        const v = die.vertices[face.verts[vi]];
        positions.push(v[0], v[1], v[2]);
        normals.push(n[0], n[1], n[2]);
        const p = face.layout.points[vi];
        const u = (col + 0.5 + p[0] * k / 2) / cols;
        const w = (row + 0.5 - p[1] * k / 2) / rows;
        uvs.push(u, 1 - w);
      });
    };
    for (let i = 1; i < face.verts.length - 1; i++) tri(0, i, i + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  assets.geometry[kind] = geometry;
  return geometry;
}

function d6Geometry() {
  if (assets.geometry.d6) return assets.geometry.d6;
  const edge = Geo.getDie('d6').inradius * 2;
  assets.geometry.d6 = new RoundedBoxGeometry(edge, edge, edge, 5, edge * 0.14);
  return assets.geometry.d6;
}

/** Paint a polyhedral kind's atlas in one mode ('color' | 'alpha' | 'glow'). */
function paintPolyAtlas(kind, st, cell, mode) {
  const { die, cols, rows, k } = atlasLayout(kind);
  const canvas = makeCanvas(cols * cell, rows * cell);
  const ctx = canvas.getContext('2d');
  const inlayAt = st.inlay ? inlayFaces(kind) : null;
  const scale = cell / 256;
  die.faces.forEach((face, fi) => {
    const ox = (fi % cols) * cell;
    const oy = Math.floor(fi / cols) * cell;
    const cx = ox + cell / 2;
    const cy = oy + cell / 2;
    const toPx = (p) => [cx + p[0] * k * cell / 2, cy - p[1] * k * cell / 2];
    if (mode === 'color') paintBody(ctx, ox, oy, cell, st, fi);
    else paintPlain(ctx, ox, oy, cell, st, fi, mode);
    const showInk = mode !== 'glow' || st.finish === 'neon';
    // Thin inset edge line for crisp facets.
    if (showInk || mode === 'alpha') {
      ctx.beginPath();
      face.layout.points.forEach((p, i) => {
        const [x, y] = toPx([p[0] * 0.95, p[1] * 0.95]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.lineWidth = st.edgeWidth * scale;
      ctx.strokeStyle = mode === 'alpha' ? '#ffffff' : (mode === 'glow' ? st.edge : st.edge);
      ctx.stroke();
    }
    if (!showInk) return;
    const inr = polygonInradius(face.layout.points) * k * cell / 2;
    const withInlay = inlayAt && inlayAt.has(fi);
    if (die.read === 'vertex') {
      // d4: each corner carries its own number, pointing at the corner.
      face.layout.points.forEach((p, i) => {
        const [x, y] = toPx([p[0] * 0.5, p[1] * 0.5]);
        drawLabel(ctx, face.cornerLabels[i], x, y, inr * 0.78, st, Math.atan2(p[0], p[1]), mode);
      });
      if (withInlay) drawInlay(ctx, st, cx, cy, inr * 0.62, mode);
    } else if (withInlay) {
      drawInlay(ctx, st, cx, cy - inr * 0.36, inr * 0.78, mode);
      drawLabel(ctx, face.label, cx, cy + inr * 0.42, inr * (face.label.length > 1 ? 0.62 : 0.78), st, 0, mode);
    } else {
      const len = face.label.length;
      const px = inr * (len === 1 ? 1.3 : len === 2 ? 1.02 : 0.8);
      drawLabel(ctx, face.label, cx, cy, px, st, 0, mode);
    }
  });
  return canvas;
}

const PIPS = { 1: [[0, 0]], 2: [[-1, 1], [1, -1]], 3: [[-1, 1], [0, 0], [1, -1]], 4: [[-1, 1], [1, 1], [-1, -1], [1, -1]],
  5: [[-1, 1], [1, 1], [0, 0], [-1, -1], [1, -1]], 6: [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]] };

/** One d6 face canvas in one mode. */
function paintD6Face(face, fi, st, size, mode) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (mode === 'color') paintBody(ctx, 0, 0, size, st, fi);
  else paintPlain(ctx, 0, 0, size, st, fi, mode);
  const showInk = mode !== 'glow' || st.finish === 'neon';
  if (st.edgeWidth > 3 && (showInk || mode === 'alpha')) {
    ctx.lineWidth = size * 0.025;
    ctx.strokeStyle = mode === 'alpha' ? '#ffffff' : st.edge;
    ctx.strokeRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84);
  }
  if (!showInk) return canvas;
  const withInlay = st.inlay && face.value === 6;
  if (withInlay) {
    drawInlay(ctx, st, size / 2, size * 0.42, size * 0.46, mode);
    drawLabel(ctx, '6', size / 2, size * 0.8, size * 0.2, st, 0, mode);
    return canvas;
  }
  if (!st.pips) {
    drawLabel(ctx, String(face.value), size / 2, size / 2, size * 0.5, st, 0, mode);
    return canvas;
  }
  const one = face.value === 1;
  PIPS[face.value].forEach(([px, py]) => {
    const x = size / 2 + px * size * 0.25;
    const y = size / 2 - py * size * 0.25;
    const r = size * (one ? 0.13 : 0.085);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (mode === 'alpha') {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      return;
    }
    if (mode === 'glow') {
      ctx.fillStyle = st.ink;
      ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    if (st.classic) {
      g.addColorStop(0, one ? '#7a1220' : '#1e130a');
      g.addColorStop(1, one ? '#c02a35' : '#5a3a1c');
    } else {
      g.addColorStop(0, mixHex(st.ink, '#000000', 0.35));
      g.addColorStop(1, st.ink);
    }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2 * size / 256;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
  });
  return canvas;
}

function makeMaterial(kind, st, maps) {
  const m = new THREE.MeshPhysicalMaterial(Object.assign({ map: maps.color }, finishParams(st.finish, kind, st.classic)));
  if (maps.alpha) {
    m.alphaMap = maps.alpha;
    m.transparent = true;
    m.depthWrite = bodyAlpha(st) > 0.55;
  }
  if (maps.glow) {
    m.emissiveMap = maps.glow;
    m.emissive.set(0xffffff);
    m.emissiveIntensity = st.finish === 'neon' ? 1.2 + st.glow : 0.5 + st.glow * 0.6;
  } else if (st.glow > 0) {
    m.emissive.set(st.glowColor);
    m.emissiveIntensity = st.glow * 0.75;
  }
  m.userData.baseEmissive = { color: m.emissive.clone(), intensity: m.emissiveIntensity };
  m.userData.ownsMaps = true;
  return m;
}

/** Build (uncached) the material(s) of one kind in one appearance at a texture resolution. */
function buildMaterial(kind, ap, res, renderer) {
  const st = styleFor(kind, ap);
  const alpha = needsAlpha(st);
  const glow = needsEmissiveMap(st);
  if (kind === 'd6') {
    return Geo.getDie('d6').faces.map((face, fi) => makeMaterial(kind, st, {
      color: canvasTexture(paintD6Face(face, fi, st, res, 'color'), true, renderer),
      alpha: alpha ? canvasTexture(paintD6Face(face, fi, st, Math.max(64, res / 2), 'alpha'), false, renderer) : null,
      glow: glow ? canvasTexture(paintD6Face(face, fi, st, Math.max(64, res / 2), 'glow'), true, renderer) : null,
    }));
  }
  return makeMaterial(kind, st, {
    color: canvasTexture(paintPolyAtlas(kind, st, res, 'color'), true, renderer),
    alpha: alpha ? canvasTexture(paintPolyAtlas(kind, st, Math.max(64, res / 2), 'alpha'), false, renderer) : null,
    glow: glow ? canvasTexture(paintPolyAtlas(kind, st, Math.max(64, res / 2), 'glow'), true, renderer) : null,
  });
}

function geometryFor(kind) {
  return kind === 'd6' ? d6Geometry() : polyGeometry(kind);
}

/** Free a material built by buildMaterial, including its textures. */
function disposeBuilt(m) {
  (Array.isArray(m) ? m : [m]).forEach((x) => {
    ['map', 'alphaMap', 'emissiveMap'].forEach((k) => { if (x[k]) x[k].dispose(); });
    x.dispose();
  });
}

/** Geometry (shared per kind) and material (cached per kind × look × resolution, least recently used first out). */
function kindAssets(kind, ap, res) {
  const key = kind + '|' + res + '|' + (ap.font === 'fantasy' ? fontState.fantasy : '') + '|' + keyOf(ap);
  let material = assets.looks.get(key);
  if (material) {
    assets.looks.delete(key); // refresh LRU position
  } else {
    material = buildMaterial(kind, ap, res);
  }
  assets.looks.set(key, material);
  return { geometry: geometryFor(kind), material };
}

/** Free the least recently used looks once too many have piled up (only between rolls, when no mesh uses them). */
function trimLookCache() {
  while (assets.looks.size > MAX_LOOK_CACHE) {
    const oldest = assets.looks.keys().next().value;
    disposeBuilt(assets.looks.get(oldest));
    assets.looks.delete(oldest);
  }
}

function cloneMaterial(m) {
  const copy = (x) => {
    const c = x.clone();
    c.userData = { baseEmissive: x.userData.baseEmissive };
    return c;
  };
  return Array.isArray(m) ? m.map(copy) : copy(m);
}

function eachMaterial(mesh, fn) {
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(fn);
}

/** Load the vendored fantasy font before painting with it (once; falls back to serif if it can't load). */
function ensureFonts(appearances) {
  if (!appearances.some((a) => a && a.font === 'fantasy')) return Promise.resolve();
  if (fontState.fantasy === 'loaded' || fontState.fantasy === 'failed') return Promise.resolve();
  if (!fontState.promise) {
    fontState.fantasy = 'loading';
    let load;
    try {
      const face = new FontFace('DiceFantasy', 'url(' + JSON.stringify(FANTASY_URL) + ')');
      load = face.load().then((f) => { document.fonts.add(f); fontState.fantasy = 'loaded'; });
    } catch (e) {
      load = Promise.reject(e);
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, 2500));
    fontState.promise = Promise.race([load.catch(() => { fontState.fantasy = 'failed'; }), timeout]).then(() => {
      if (fontState.fantasy === 'loading') fontState.fantasy = 'failed';
    });
  }
  return fontState.promise;
}

/** Texture resolution for a roll: lower when many different looks share the tray. */
function resolutionFor(bodies) {
  const distinct = new Set(bodies.map((b) => b.kind + keyOf(b.appearance))).size;
  return distinct <= 6 ? 256 : distinct <= 12 ? 192 : 128;
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
    assets.ringTexture = ringTexture();
    bindPointer(canvas);

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
        if (d.pool) d.pool.position.set(d.mesh.position.x, 0.01, d.mesh.position.z);
      });
    }
    fitCamera();
    if (!state.canvas.hidden && !state.animating) {
      render();
      updateOverlay(false);
    }
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
  state.items = null;
  resetIdentity();
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

/** Thin glowing ring marking the die you are pointing at. */
function ringTexture() {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.72, 0, Math.PI * 2);
  ctx.lineWidth = size * 0.07;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.stroke();
  return canvasTexture(canvas);
}

function applyHighlight(d) {
  const info = d.info;
  eachMaterial(d.mesh, (m) => {
    const base = m.userData.baseEmissive;
    const glowing = !!(base && base.intensity > 0.01);
    if (info.sign < 0) m.color.multiplyScalar(0.72);
    if (!info.kept) {
      m.transparent = true;
      m.opacity = 0.42;
      m.color.multiplyScalar(0.55);
      m.clearcoat = 0.2;
      m.emissiveIntensity *= 0.3;
    } else if (info.crit) {
      m.emissive.set(0xf5c542);
      m.emissiveIntensity = Math.max(0.32, glowing ? base.intensity : 0);
    } else if (info.fumble) {
      m.emissive.set(0xe2553f);
      m.emissiveIntensity = Math.max(0.3, glowing ? base.intensity : 0);
    } else if (info.max && !glowing) {
      m.emissive.set(0xf0d48a);
      m.emissiveIntensity = 0.05;
    }
    m.needsUpdate = true;
  });
  const ap = info.appearance;
  if (info.kept && ap && !ap.classic && (ap.glow > 0 || ap.finish === 'neon')) {
    // A pool of light on the felt under glowing dice.
    const pool = addFx(floorDecal(ap.glowColor || ap.ink, d.size * 2.8, Math.min(0.75, 0.22 + (ap.glow || 0) * 0.6)));
    pool.position.set(d.mesh.position.x, 0.01, d.mesh.position.z);
    d.pool = pool;
  }
  if (info.lucky) {
    // Lucky die: a soft clover-gold halo and a little star badge. Purely decorative.
    eachMaterial(d.mesh, (m) => {
      const base = m.userData.baseEmissive;
      if (!info.crit && !info.fumble && !info.max && !(base && base.intensity > 0.01)) {
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

// ------------------------------------------------------------ identities
function ensureOverlay() {
  if (state.overlay || !state.tray) return;
  const o = document.createElement('div');
  o.className = 'tray-overlay';
  o.setAttribute('aria-hidden', 'true');
  const tip = document.createElement('div');
  tip.className = 'tray-tip';
  tip.hidden = true;
  o.appendChild(tip);
  state.tray.appendChild(o);
  state.overlay = o;
  state.tip = tip;
}

function itemMeshes(i) {
  return state.dice.filter((d) => d.item === i);
}

/** Screen position (px in the tray) just above a rolled die (both halves of a d100). */
function itemAnchor(i) {
  const ds = itemMeshes(i);
  if (!ds.length || !state.camera) return null;
  const v = new THREE.Vector3();
  let top = 0;
  ds.forEach((d) => {
    v.add(d.mesh.position);
    top = Math.max(top, d.mesh.position.y + d.size * 0.9);
  });
  v.divideScalar(ds.length);
  const floor = v.clone();
  v.y = top;
  const p = v.clone().project(state.camera);
  let spread = 0;
  ds.forEach((d) => { spread = Math.max(spread, Math.hypot(d.mesh.position.x - floor.x, d.mesh.position.z - floor.z) + d.size); });
  return { x: (p.x + 1) / 2 * state.width, y: (1 - p.y) / 2 * state.height, floor, spread };
}

function activeItem() {
  if (state.animating) return null;
  if (state.externalItem !== null) return state.externalItem;
  if (state.hoverItem !== null) return state.hoverItem;
  return state.pinnedItem;
}

function tipText(item) {
  const id = item.ident || {};
  const parts = [];
  parts.push((id.label || ('d' + item.sides)) + (id.lucky ? ' \u2605' : ''));
  if (id.name && id.name !== id.label) parts.push(id.name);
  parts.push('rolled ' + item.value + (item.kept === false ? ' (dropped)' : ''));
  return parts;
}

/** Ring + tooltip for the active die and the optional name tags on every die. */
function updateOverlay(notify) {
  if (!state.ready) return;
  ensureOverlay();
  state.tags.forEach((t) => t.remove());
  state.tags = [];
  const items = state.items || [];
  if (state.showTags && !state.animating) {
    items.forEach((it, i) => {
      if (!it || !it.ident) return;
      const a = itemAnchor(i);
      if (!a) return;
      const tag = document.createElement('span');
      tag.className = 'tray-tag' + (it.ident.house ? ' is-house' : '') + (it.kept === false ? ' is-dropped' : '');
      tag.textContent = it.ident.tag || it.ident.label || '';
      if (it.ident.color) tag.style.setProperty('--tag-color', it.ident.color);
      tag.style.left = Math.round(a.x) + 'px';
      tag.style.top = Math.round(a.y) + 'px';
      state.overlay.insertBefore(tag, state.tip);
      state.tags.push(tag);
    });
  }
  const i = activeItem();
  const item = i !== null ? items[i] : null;
  const a = item ? itemAnchor(i) : null;
  if (!state.ring) {
    state.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: assets.ringTexture, color: 0xf0d48a,
      transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
    state.ring.rotation.x = -Math.PI / 2;
    state.scene.add(state.ring);
  }
  if (item && a) {
    state.ring.visible = true;
    state.ring.position.set(a.floor.x, 0.014, a.floor.z);
    state.ring.scale.set(a.spread * 2.4, a.spread * 2.4, 1);
    const lines = tipText(item);
    state.tip.textContent = '';
    lines.forEach((line, k) => {
      const span = document.createElement('span');
      span.className = k === 0 ? 'tray-tip-label' : 'tray-tip-line';
      span.textContent = line;
      state.tip.appendChild(span);
    });
    state.tip.style.setProperty('--tag-color', (item.ident && item.ident.color) || '#d9b25f');
    state.tip.style.left = Math.round(Math.min(Math.max(a.x, 70), state.width - 70)) + 'px';
    state.tip.style.top = Math.round(Math.max(a.y, 46)) + 'px';
    state.tip.hidden = false;
  } else {
    state.ring.visible = false;
    state.tip.hidden = true;
  }
  if (!state.animating) render();
  if (notify && state.onHover) {
    try { state.onHover(state.hoverItem !== null ? state.hoverItem : state.pinnedItem); } catch (e) { /* UI callback errors stay out of the renderer */ }
  }
}

function pickItem(ev) {
  if (!state.dice.length) return null;
  const rect = state.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, state.camera);
  const hits = ray.intersectObjects(state.dice.map((d) => d.mesh), false);
  const it = hits.length ? hits[0].object.userData.item : undefined;
  return Number.isInteger(it) ? it : null;
}

function bindPointer(canvas) {
  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch' || state.animating) return;
    const i = pickItem(ev);
    canvas.style.cursor = i !== null ? 'pointer' : '';
    if (i !== state.hoverItem) {
      state.hoverItem = i;
      updateOverlay(true);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    canvas.style.cursor = '';
    if (state.hoverItem !== null) {
      state.hoverItem = null;
      updateOverlay(true);
    }
  });
  canvas.addEventListener('pointerdown', (ev) => { state.pointer = { x: ev.clientX, y: ev.clientY }; });
  canvas.addEventListener('pointerup', (ev) => {
    const start = state.pointer;
    state.pointer = null;
    if (!start || state.animating || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) return;
    const i = pickItem(ev);
    state.pinnedItem = i === state.pinnedItem ? null : i; // tap a die to name it, tap again (or the felt) to hide
    updateOverlay(true);
  });
}

function resetIdentity() {
  state.hoverItem = null;
  state.pinnedItem = null;
  state.externalItem = null;
  if (state.ring) state.ring.visible = false;
  if (state.tip) state.tip.hidden = true;
  state.tags.forEach((t) => t.remove());
  state.tags = [];
}

/**
 * Show a roll. list: [{ sides, value, sign, kept, crit, fumble, lucky,
 * appearance?, ident? }] in display order (already capped by script.js).
 * appearance: a resolved look (DiceProfiles.resolveAppearance); ident: the
 * die's identity for the hover tag ({ label, name, tag, color, house, lucky }).
 * Resolves once every die has settled.
 */
function roll(list, options) {
  if (!init()) return Promise.reject(new Error('3D tray unavailable'));
  const reduced = !!(options && options.reduced);
  const look = (options && options.look) || null;
  stopAnimation(true);
  disposeDice();
  const token = ++state.rollToken;
  const bodies = [];
  list.forEach((item, itemIndex) => {
    const parts = Geo.bodiesFor(item.sides, item.value);
    if (!parts) return;
    const appearance = item.appearance || fallbackAppearance(item.sides, look);
    parts.forEach((p) => bodies.push({ kind: p.kind, value: p.value, item: itemIndex, appearance, info: Object.assign({
      max: item.kept && item.value === item.sides && !item.crit,
    }, item, { appearance }) }));
  });
  state.items = list;
  return ensureFonts(bodies.map((b) => b.appearance)).then(() => {
    if (token !== state.rollToken) return undefined; // superseded by a newer roll
    return throwDice(bodies, reduced);
  });
}

function throwDice(bodies, reduced) {
  measure();
  state.renderer.setSize(state.width, state.height, false);
  state.bounds = boundsForSize();
  layoutTable();
  fitCamera();

  const size = dieSize(bodies.length);
  const res = resolutionFor(bodies);
  const plan = Phys.planRoll({
    dice: bodies.map((b) => ({ kind: b.kind, value: b.value, size: size * KIND_SCALE[b.kind] })),
    bounds: state.bounds,
    reduced,
  });
  state.plan = plan;
  state.dice = bodies.map((b, i) => {
    const { geometry, material } = kindAssets(b.kind, b.appearance, res);
    const mesh = new THREE.Mesh(geometry, cloneMaterial(material));
    const s = plan.dice[i].size;
    mesh.scale.setScalar(s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.item = b.item;
    state.diceGroup.add(mesh);
    return { mesh, glow: null, info: b.info, kind: b.kind, value: b.value, size: s, item: b.item, inradius: Geo.getDie(b.kind).inradius * s };
  });

  state.canvas.hidden = false;
  state.tray.classList.add('is-3d');

  const settleAll = () => {
    state.dice.forEach((d, i) => {
      setPose(d, Phys.poseAt(plan, i, Infinity));
      applyHighlight(d);
    });
    render();
    updateOverlay(false);
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

/** Meshes for one die of the given type resting at (x, z), in the given look. */
function placeDie(sides, value, ap, x, z, size, info) {
  const parts = Geo.bodiesFor(sides, value) || [];
  const plan = Phys.planRoll({
    dice: parts.map((p) => ({ kind: p.kind, value: p.value, size: size * KIND_SCALE[p.kind] })),
    bounds: state.bounds,
    reduced: true,
  });
  return parts.map((p, i) => {
    const { geometry, material } = kindAssets(p.kind, ap, 256);
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
      inradius: Geo.getDie(p.kind).inradius * s, restY: pose.pos[1], item: null };
    state.dice.push(d);
    return d;
  });
}


/**
 * The ceremonial burning of a die: it trembles, catches fire, chars, melts
 * into a scorch mark, and a fresh replacement drops into the tray.
 * opts: { sides, appearance, freshAppearance, look, reduced, lucky } – the doomed die burns in its own
 * look, the replacement arrives in freshAppearance (both default to the player look).
 * Resolves when the replacement has landed.
 */
function burn(opts) {
  if (!init()) return Promise.reject(new Error('3D tray unavailable'));
  const o = opts || {};
  const token = ++state.rollToken;
  stopAnimation(true);
  disposeDice();
  const doomedLook = o.appearance || fallbackAppearance(o.sides, o.look);
  const freshLook = o.freshAppearance || doomedLook;
  return ensureFonts([doomedLook, freshLook]).then(() => {
    if (token !== state.rollToken) return undefined;
    return burnNow(o, doomedLook, freshLook);
  });
}

function burnNow(o, doomedLook, freshLook) {
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
    placeDie(sides, sides, freshLook, freshX, 0.2, size, {});
    render();
    return Promise.resolve();
  }

  const doomed = placeDie(sides, 1, doomedLook, doomedX, 0.2, size, { lucky: !!o.lucky });
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
      fresh = placeDie(sides, sides, freshLook, freshX, 0.2, size, {});
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
    if (!fresh) fresh = placeDie(sides, sides, freshLook, freshX, 0.2, size, {});
    fresh.forEach((d) => { d.mesh.position.y = d.restY; });
    render();
  });
}


/** Remove every die and hide the 3D tray (between rolls / when the selection changes). */
function clear() {
  if (!state.ready) return;
  state.rollToken++;
  stopAnimation(true);
  disposeDice();
  hideCanvas();
}

/** Debug/test helper: the value each rendered mesh currently shows on top, and which rolled die it belongs to. */
function inspect() {
  return state.dice.map((d) => {
    const q = d.mesh.quaternion;
    const item = d.item !== null && state.items ? state.items[d.item] : null;
    return { kind: d.kind, value: d.value, shown: Geo.valueUp(d.kind, [q.x, q.y, q.z, q.w]), position: d.mesh.position.toArray(),
      item: d.item, label: item && item.ident ? item.ident.label : null, finish: item && item.appearance ? item.appearance.finish : null };
  });
}

/** Point at a rolled die from outside (e.g. hovering its result chip). null clears. */
function highlight(index) {
  state.externalItem = Number.isInteger(index) ? index : null;
  updateOverlay(false);
}

/** Show or hide a small name tag above every die. */
function setTags(on) {
  state.showTags = !!on;
  if (state.ready) updateOverlay(false);
}

// ------------------------------------------------------------- preview
/**
 * A small stand-alone renderer showing one die (two for d100) in a look, for
 * the die editor. Drag or use the arrow keys to rotate; it turns slowly on
 * its own unless reduced motion is on (or you have grabbed it).
 * Returns { show(sides, appearance), setAutoRotate(on), dispose() } or null without WebGL.
 */
function createPreview(canvas, options) {
  const opts = options || {};
  if (!Geo) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffe2b0, 0x0b1a12, 0.65));
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.3);
  sun.position.set(-4, 8, 6);
  scene.add(sun);
  const rim = new THREE.PointLight(0xff9a3c, 16, 30, 2);
  rim.position.set(4, 3, -3);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.6, 7);
  camera.lookAt(0, 0, 0);
  const spin = new THREE.Group(); // user / automatic rotation
  const tilt = new THREE.Group(); // the inlay face looks at the camera
  tilt.rotation.x = 1.2;
  spin.add(tilt);
  scene.add(spin);

  let built = [];
  let meshes = [];
  let raf = 0;
  let last = 0;
  let disposed = false;
  let auto = !opts.reduced;
  let drag = null;

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const draw = () => { if (!disposed) renderer.render(scene, camera); };
  const loop = (t) => {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (auto && !drag) spin.rotation.y += dt * 0.7;
    draw();
    if (auto && !drag) raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (!raf && !disposed) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  const clearMeshes = () => {
    meshes.forEach((m) => tilt.remove(m));
    meshes = [];
    built.forEach(disposeBuilt);
    built = [];
  };
  const ro = window.ResizeObserver ? new ResizeObserver(() => { fit(); draw(); }) : null;
  if (ro) ro.observe(canvas);

  const rotateBy = (dy, dx) => {
    spin.rotation.y += dy;
    spin.rotation.x = THREE.MathUtils.clamp(spin.rotation.x + dx, -1.2, 1.2);
    draw();
  };
  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY };
    auto = false;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    rotateBy((ev.clientX - drag.x) * 0.012, (ev.clientY - drag.y) * 0.012);
    drag = { x: ev.clientX, y: ev.clientY };
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('keydown', (ev) => {
    const step = 0.35;
    const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (keys[ev.key]) {
      auto = false;
      rotateBy(keys[ev.key][0], keys[ev.key][1]);
    } else if (ev.key === 'Home') {
      spin.rotation.set(0, 0, 0);
      draw();
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      auto = !auto && !opts.reduced;
      if (auto) kick();
    } else {
      return;
    }
    ev.preventDefault();
  });

  function show(sides, ap) {
    if (disposed) return Promise.resolve();
    const look = ap || fallbackAppearance(sides, null);
    return ensureFonts([look]).then(() => {
      if (disposed) return;
      clearMeshes();
      const parts = sides === 100 ? [{ kind: 'd100t', value: 9 }, { kind: 'd100u', value: 9 }] : [{ kind: 'd' + sides, value: sides }];
      parts.forEach((p, i) => {
        const mat = buildMaterial(p.kind, look, 256, renderer);
        built.push(mat);
        const mesh = new THREE.Mesh(geometryFor(p.kind), mat);
        mesh.scale.setScalar((parts.length > 1 ? 1.05 : 1.45) * KIND_SCALE[p.kind]);
        const q = Geo.restQuaternion(p.kind, p.value, 0);
        mesh.quaternion.set(q[0], q[1], q[2], q[3]);
        mesh.position.set(parts.length > 1 ? (i - 0.5) * 2.5 : 0, 0, 0);
        if (look.glow > 0 || look.finish === 'neon') {
          // keep the base glow, nothing else to highlight in the preview
        }
        tilt.add(mesh);
        meshes.push(mesh);
      });
      fit();
      draw();
      if (auto) kick();
    });
  }

  return {
    show,
    setAutoRotate(on) {
      auto = !!on && !opts.reduced;
      if (auto) kick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      clearMeshes();
      envRT.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}

window.DiceTray3D = {
  available: () => init(),
  roll,
  burn,
  clear,
  inspect,
  highlight,
  setTags,
  createPreview,
  set onHover(fn) { state.onHover = typeof fn === 'function' ? fn : null; },
  get animating() { return state.animating; },
};
