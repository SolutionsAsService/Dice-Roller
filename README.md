# Dungeon Dice Box

A polished, dependency-free dice roller with a tabletop "dice box" feel. Pick your dice from the rack, add a modifier, choose advantage or disadvantage, and roll – the dice tumble across a felt-lined wooden tray and land showing their results.

Plain HTML, CSS and JavaScript. No build step, no frameworks, no CDNs – it runs straight from GitHub Pages or any static file host.

## Features

- **Dice rack** – d4, d6, d8, d10, d12, d20 and d100, each with its own shape and colour. Click a die to add it, use **−/+** to adjust the count (right-click a die to remove one).
- **Dice box** – your selection waits in the tray; press **Roll** and the dice tumble in with a 3D CSS animation and settle on their faces (d6s show pips).
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
- **Accessible** – real buttons and radio groups, visible focus rings, screen-reader announcements of every roll, `prefers-reduced-motion` support (dice simply fade in), high-contrast friendly.
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

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup |
| `styles.css` | Theme, dice shapes, tray and animations |
| `dice-core.js` | Pure dice logic: fair RNG, notation parser, rolling, keep/drop, advantage, formatting. Works in the browser (`window.DiceCore`) and in Node. |
| `script.js` | UI: rack, tray animation, results, history, presets, keyboard |
| `tests/dice.test.mjs` | Node tests for the dice logic |

## Tests

Requires Node 18+ (no dependencies to install):

```sh
npm test            # or: node --test tests/*.test.mjs
node --check script.js
```

The tests cover rejection sampling (with a fake random source), bounds and face coverage for every standard die, a chi-square uniformity check, notation parsing and error cases, keep/drop, advantage/disadvantage, crit/fumble detection, and that totals always land inside the formula's min–max range.
