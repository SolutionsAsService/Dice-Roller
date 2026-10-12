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
- **Results** – per-die chips grouped by die type, subtotals, a big total, and **Natural 20 / Natural 1** highlights on d20s (with a glow in the tray). Each chip is drawn in its die's own colours and shows its slot and name (`#3 Clementine`, or `House #2` for borrowed dice); hovering or focusing a chip highlights that die in the tray, and **Name tags in tray** labels every die in the 3D box.
- **Formula box** – type standard notation:
  - `2d6+3`, `d20`, `d%` (= d100), `d8+3d6-1`
  - keep/drop: `4d6kh3` (keep highest 3), `4d6dl1` (drop lowest 1), `2d20kl1` (keep lowest)
  - live validation with the min–max range shown as you type
- **Quick rolls** – one-tap presets (Attack `d20+5`, Damage `2d6+3`, Ability score `4d6kh3`, Fireball `8d6`, …) plus **Save current** for your own.
- **History** – last 50 rolls saved in `localStorage`; click any entry to roll it again; **Clear** wipes it. Your current dice and mode are remembered too.
- **Players** – everyone at the table gets a profile with their own name and default dice look (preset themes like *Dragon's hoard*, *Lich-light* or *Bubblegum bard*, or custom dice and number colours with a finish). Dice without their own look use it. Switch players with one tap.
- **A real dice bag** – up to 20 dice of each type per player, each in a numbered slot with its own name, stats, lucky mark and look. Roll more dice than you own and grey **house dice** fill in (shown as `House d6 #1`, not tracked), with a one-click **Add … to my bag**.
- **Per-die looks** – body and second colour, pattern (solid, gradient, two-tone, swirl, marbled, speckled), number colour, edge outline, finish (glossy, matte, metallic, pearlescent, gemstone, glass, glitter, neon, wood, bone, stone), number font (incl. the vendored *MedievalSharp* fantasy font), pips on d6s, opacity, glow, and an inlay on the highest face (star, skull, flame, … or your own 1–3 characters). Twelve quick looks, **Randomise**, copy to other dice, a live 3D preview you can drag or turn with the arrow keys, and a warning when the numbers would be hard to read.
- **Lucky die** – mark one die in your bag as lucky. It gets a star badge, a halo and a burst of sparkles in the tray, and the Dice bag keeps its stats so you can find out whether it actually is.
- **Burn a die** – a die betrayed you? Send it to the fire. It trembles, burns, melts into a scorch mark, and goes to the **Hall of Shame** with its sad stats and an epitaph; a fresh die takes its place. Changed your mind? **Pardon** it.
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
| `P` / `Shift` + `P` | Next / previous player |
| `?` | Show / hide shortcut help |

## Players, lucky dice & the Hall of Shame

All of this lives in your browser's `localStorage`, per device and per browser. There is no backend and no account.

- **Players panel** – **+ New player** adds someone (up to 12). Pick who's rolling with the player buttons, the name chip in the header (tap it to go to the next player) or `P`. **Customise … dice** sets the name, a theme, dice colour, number colour and finish. **Remove player** deletes them and their stats.
- **Dice bag** – grouped by die type; each die sits in a numbered slot (`d6 #1`, `d6 #2`, …) and starts with a random name such as *Grimbold the Fickle*. **+ d6** adds a die (up to 20 per type), the arrows move a die to an earlier or later slot, **✎** opens its editor (rename, restyle, move, remove from bag). Every die you physically roll counts, including the dropped die of advantage/disadvantage and keep/drop rolls. Each row shows rolls, average against a fair die's average, max/nat 20s and 1s, and a verdict. The verdict waits for 20 rolls, then compares the average with a fair die (z-score: *Honest die*, *Running hot/cold*, *Suspiciously lucky*, *Cursed*).
  - **Which die rolls?** Dice roll in slot order: `3d6` uses d6 #1, #2 and #3. Press **Use** on a die to send it in first (picked dice show a badge; press again to un-pick). The *Rolling with* line under the controls always shows which dice will be used and how many house dice will fill in. Advantage and keep/drop use one physical die per rolled die, e.g. `2d20` with advantage uses four d20s.
  - **★** marks the lucky die (one per player; press it again to unmark). Lucky dice show a star in the rack, the result chips and the tray, and the result banner comments when they roll their best face (or a 1).
  - **Flame button** opens the burn dialog with an epitaph based on the die's record (`Rolled 3 natural 1s in 10 rolls. Knew exactly what it was doing.`), which you can rewrite. Confirming plays the burn and puts a fresh die with zero stats (and the same look) in that slot.
- **Hall of Shame** – burned dice with their epitaph, date, former slot and final stats. **Pardon** puts a die back in its old slot with its old stats. If its replacement was never rolled it simply makes way; otherwise both stay in the bag (or, when that type already holds 20 dice, the replacement retires to the Hall). **Scatter ashes** deletes the record for good.
- **Backup & restore** – **Export JSON** downloads all profiles. **Import JSON** merges a backup: players with the same id are updated and new ones are added.

**Fairness:** profiles, looks, slots, picked dice, lucky marks and burnings never touch the dice. Which bag die stands for which rolled die is decided by a deterministic function (`planDice`/`assignDice`: picked dice, then slot order, then house dice) applied to the finished result, so it can't influence a value. Every roll still comes from `DiceCore.rollExpression` exactly as before. Stats are recorded afterwards from the finished result, and `dice-profiles.js` has no access to the random source (a test checks this, and another checks that identical random streams give identical rolls with profile tracking on).

**Motion:** with `prefers-reduced-motion`, the burn skips straight to the scorch mark and the fresh die, lucky sparkles and twinkles are off, the lucky halo and badge stay static, and the editor preview doesn't spin on its own.

**Storage format** (`diceBox.profiles`, schema version 2): `{ version, activeId, players: [{ id, name, created, look: { theme, body, ink, finish }, bag: { "4": [Die, …], … "100": [Die, …] }, hand: { "6": [dieId, …] }, graveyard: [Die + { died, epitaph, cause, slot, replacedBy }] }] }`. Each bag type holds 1–20 dice in slot order; `hand` lists picked dice. A die is `{ id, sides, name, born, lucky, faces, recent, style }`: per-face counts (`faces`) and its last 20 values, so roll count, sum and average can't drift apart, and `style` (`null` = the player's look) with `body, body2, pattern, ink, edge, finish, font, pips, opacity, glow, glowColor, inlay, inlayText`. Loading is defensive:

- unversioned (v0) and v1 data are migrated: a v1 player's single die of each type becomes slot #1 of that type with its name, stats, history and lucky mark; the original v1 data is first copied to `diceBox.profiles.backup`
- bad fields are repaired
- if the saved data can't be read (corrupt JSON, or a version from the future), it's copied to `diceBox.profiles.backup` before a fresh table is set up
- if storage is blocked or full, the app still works and says that profiles will only last for the session

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
| `tray3d.js` | ES module: three.js scene, dice meshes and textures (per player look and finish), felt/wood tray, lights, camera fit, render loop, per-die appearances (patterns, finishes, fonts, inlays, glow) with texture caches, hover/tap identification, highlights and name tags, lucky sparkles, the burn effect and the editor preview (`window.DiceTray3D`) |
| `dice-profiles.js` | Pure profile logic (no DOM, no RNG): versioned storage schema, v0/v1→v2 migration, repair of corrupt data, players, bags with slots (add/remove/move/rename), die picking and deterministic die assignment, per-die styles/presets/randomise/copy and contrast checks, stats and luck verdicts, lucky die, burn/replace/pardon, export/import. Browser (`window.DiceProfiles`) + Node. |
| `script.js` | UI: rack, results and per-die chips, history, presets, players, dice bag with slots, die picker, die editor with 3D preview, Hall of Shame, keyboard; uses the 3D tray or falls back to the CSS tray |
| `vendor/fonts/` | MedievalSharp (SIL Open Font License, see the folder) for the *Fantasy* number font |
| `vendor/three/` | three.js r186 (MIT) – `three.module.min.js`, `three.core.min.js`, the `RoundedBoxGeometry` and `RoomEnvironment` addons, and `LICENSE` |
| `tests/dice.test.mjs` | Node tests for the dice logic |
| `tests/geometry.test.mjs` | Node tests for the 3D maths: every value of every die faces up, symmetries, simulated throws |
| `tests/profiles.test.mjs` | Node tests for profiles: schema, migration, corrupt/blocked/full storage, players, stats, lucky die, burn/replace/pardon, export/import, RNG isolation |

## Tests

Requires Node 18+ (no dependencies to install):

```sh
npm test            # or: node --test tests/*.test.mjs
node --check script.js
```

`tests/geometry.test.mjs` checks, without WebGL, that for every die type and every value the chosen face normal (or the d4's top vertex) is rotated exactly onto the up vector, that opposite faces sum like real dice, that the symmetries used for re-labelling keep each solid's shape, and that simulated throws always come to rest showing the rolled value inside the tray.

`tests/profiles.test.mjs` covers:

- the v2 schema round trip and repair of malformed fields
- v0 → v2 and v1 → v2 migration (stats, names and lucky marks kept, backup written)
- bag slots: add/remove/move/rename, the 20-per-type limit, picked dice
- deterministic die assignment (picked dice → slot order → house dice) and that it never changes a roll
- per-die styles, presets, randomise, copy, and contrast warnings
- refusing data from newer versions
- corrupt JSON with a backup kept before overwrite
- missing, throwing and quota-full storage
- adding, switching and removing players
- per-player isolation
- stats credited from real `rollExpression` results (including dropped advantage dice and d100) without modifying the result
- luck verdicts
- the one-lucky-die rule
- burning (stats preserved, fresh replacement in the same slot, lucky title lost), epitaphs, the Hall of Shame cap, and pardoning back into the old slot
- export/import
- that profile tracking can't change a roll

The dice-logic tests cover rejection sampling (with a fake random source), bounds and face coverage for every standard die, a chi-square uniformity check, notation parsing and error cases, keep/drop, advantage/disadvantage, crit/fumble detection, and that totals always land inside the formula's min–max range.

## Credits

- 3D rendering by [three.js](https://github.com/mrdoob/three.js) r186 – Copyright © 2010-2026 three.js authors, MIT License (see `vendor/three/LICENSE`). Vendored from the `three@0.186.1` npm package: `build/three.module.js` and `build/three.core.js` were minified with Terser (the npm package no longer ships `.min.js` builds; see `vendor/three/README.md`), and `examples/jsm/geometries/RoundedBoxGeometry.js` and `examples/jsm/environments/RoomEnvironment.js` are copied unmodified.
