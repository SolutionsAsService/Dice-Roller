# Dungeon Dice Box

A polished dice roller with a tabletop "dice box" feel. Pick your dice from the rack, add a modifier, choose advantage or disadvantage, and roll – real 3D dice tumble across a felt-lined wooden tray and land showing their results.

Plain HTML, CSS and JavaScript. No build step, no frameworks, no CDNs – the only library, [three.js](https://threejs.org/), is vendored in `vendor/three/`, so it runs straight from GitHub Pages, Shadw or any static file host.

## Features

- **Dice rack** – d4, d6, d8, d10, d12, d20 and d100, each with its own shape and colour. Click a die to add it, use **−/+** to adjust the count (right-click a die to remove one).
- **3D dice box** – your selection waits in the tray; press **Roll** and real polyhedra (d4 tetrahedron, rounded-cube d6 with pips, d8, d10 pentagonal trapezohedron, d12, d20; a d100 is a tens die `00–90` plus a units die `0–9`) are tossed in with spin, bounce off the felt and the wooden walls, knock into each other and settle. Rendered with three.js: canvas-texture numbers, soft shadows, warm lighting.
  - **The physics never decides a result.** DiceCore rolls first; the throw is then simulated and each die is re-labelled with a rotational symmetry of its own shape so the face that lands on top *is* the rolled value, followed by a tiny final snap so it sits perfectly flat.
  - The tray fits its container, resizes responsively, caps the pixel ratio at 2 and stops rendering once the dice are still.
  - No WebGL (or opened via `file://`, where browsers block ES modules)? The previous CSS tumbling animation is used automatically.
- **Modifier** – flat bonus or penalty from −999 to +999.
- **Advantage / disadvantage** – every plain d20 is rolled twice; the kept die is highlighted and the other is shown as dropped.
- **Results** – per-die chips grouped by die type, subtotals, a big total, and **Natural 20 / Natural 1** highlights on d20s (with a glow in the tray).
- **Formula box** – type standard notation:
  - `2d6+3`, `d20`, `d%` (= d100), `d8+3d6-1`
  - keep/drop: `4d6kh3` (keep highest 3), `4d6dl1` (drop lowest 1), `2d20kl1` (keep lowest)
  - live validation with the min–max range shown as you type
- **Quick rolls** – one-tap presets (Attack `d20+5`, Damage `2d6+3`, Ability score `4d6kh3`, Fireball `8d6`, …) plus **Save current** for your own.
- **History** – last 50 rolls saved in `localStorage`; click any entry to roll it again; **Clear** wipes it. Your current dice and mode are remembered too.
- **Fair randomness** – `crypto.getRandomValues` with rejection sampling, so every face is exactly equally likely (no modulo bias, no `Math.random` for results).
- **Accessible** – real buttons and radio groups, visible focus rings, screen-reader announcements of every roll, `prefers-reduced-motion` support (no tumble – the settled dice are shown straight away), high-contrast friendly. The 3D canvas is decorative (`aria-hidden`); results are always in the text.
- **Responsive** – works from phones to wide desktops.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1`–`7` | Add d4, d6, d8, d10, d12, d20, d100 |
| `Shift` + `1`–`7` | Remove that die |
| `Space` / `Enter` / `R` | Roll |
| `+` / `-` | Raise / lower the modifier |
| `A` / `D` / `N` | Advantage / disadvantage / normal |
| `F` | Focus the formula box |
| `C` / `Esc` | Clear the dice |
| `?` | Show / hide shortcut help |

## Usage

Serve the folder over HTTP (needed for the ES-module 3D tray; opening `index.html` directly still works with the CSS tray):

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup (plus the import map for three.js) |
| `styles.css` | Theme, dice shapes, tray and CSS animations |
| `dice-core.js` | Pure dice logic: fair RNG, notation parser, rolling, keep/drop, advantage, formatting. Works in the browser (`window.DiceCore`) and in Node. |
| `dice-geometry.js` | Pure maths for the 3D dice: polyhedra, face values, face normals, rest orientations, shape symmetries. Browser + Node. |
| `dice-physics.js` | Small hand-written rigid-body throw (gravity, bounces, walls, die–die knocks, friction, sleeping) and the final snap to the rolled face. Browser + Node. |
| `tray3d.js` | ES module: three.js scene, dice meshes and textures, felt/wood tray, lights, camera fit, render loop (`window.DiceTray3D`) |
| `script.js` | UI: rack, results, history, presets, keyboard; uses the 3D tray or falls back to the CSS tray |
| `vendor/three/` | three.js r186 (MIT) – `three.module.min.js`, `three.core.min.js`, the `RoundedBoxGeometry` and `RoomEnvironment` addons, and `LICENSE` |
| `tests/dice.test.mjs` | Node tests for the dice logic |
| `tests/geometry.test.mjs` | Node tests for the 3D maths: every value of every die faces up, symmetries, simulated throws |

## Tests

Requires Node 18+ (no dependencies to install):

```sh
npm test            # or: node --test tests/*.test.mjs
node --check script.js
```

`tests/geometry.test.mjs` checks, without WebGL, that for every die type and every value the chosen face normal (or the d4's top vertex) is rotated exactly onto the up vector, that opposite faces sum like real dice, that the symmetries used for re-labelling keep each solid's shape, and that simulated throws always come to rest showing the rolled value inside the tray.

The dice-logic tests cover rejection sampling (with a fake random source), bounds and face coverage for every standard die, a chi-square uniformity check, notation parsing and error cases, keep/drop, advantage/disadvantage, crit/fumble detection, and that totals always land inside the formula's min–max range.

## Credits

- 3D rendering by [three.js](https://github.com/mrdoob/three.js) r186 – Copyright © 2010-2026 three.js authors, MIT License (see `vendor/three/LICENSE`). Vendored from the `three@0.186.1` npm package: `build/three.module.js` and `build/three.core.js` were minified with Terser (the npm package no longer ships `.min.js` builds; see `vendor/three/README.md`), and `examples/jsm/geometries/RoundedBoxGeometry.js` and `examples/jsm/environments/RoomEnvironment.js` are copied unmodified.
