// End-to-end check of the dice bag in a real (headless) Chromium.
//
// Not part of \`npm test\` (that stays dependency-free). Needs Playwright with a
// Chromium build; either install it where Node can find it, or point
// PLAYWRIGHT_DIR at a folder whose node_modules contain it:
//
//   PLAYWRIGHT_DIR=/path/to/project-with-playwright node tests/browser/bag.e2e.mjs
//
// Options (env): PHASES=desktop,phone,reduced  OUT=<screenshot dir>  NO3D=1
// The script serves the repo itself on a free localhost port, runs each phase
// in a fresh browser context (one Chromium at a time), and exits non-zero on
// any failed check or console error/warning.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dice-e2e');
const PHASES = (process.env.PHASES || 'desktop,phone,reduced').split(',').map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_DIR) {
    const req = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_DIR), 'noop.js'));
    return req('playwright');
  }
  try {
    return await import('playwright');
  } catch (e) {
    console.error('Playwright not found. Set PLAYWRIGHT_DIR to a folder with playwright in node_modules.');
    process.exit(2);
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain' };
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const T0 = 1_700_000_000_000;
const V1 = {
  version: 1, activeId: 'p1',
  players: [{
    id: 'p1', name: 'Ada', created: T0, look: { theme: 'classic', body: null, ink: null, finish: 'glossy' },
    dice: {
      4: { id: 'd4a', sides: 4, name: 'Pointy Pete', born: T0, lucky: false, faces: [1, 1, 1, 1], recent: [1, 2, 3, 4] },
      6: { id: 'd6a', sides: 6, name: 'Old Faithful', born: T0, lucky: true, faces: [1, 2, 3, 4, 5, 6], recent: [6, 5, 6] },
      20: { id: 'd20a', sides: 20, name: 'Grim Reaper', born: T0, lucky: false, faces: new Array(20).fill(1), recent: [20, 1] },
    },
    graveyard: [{ id: 'gone1', sides: 8, name: 'Traitor Tim', born: T0, lucky: false, faces: [5, 0, 0, 0, 0, 0, 0, 1], recent: [1, 1], died: T0 + 1000, epitaph: 'Rolled 5 ones.', cause: 'burned' }],
  }],
};

async function runPhase(chromium, base, PHASE) {
  const problems = [];
  const t0 = Date.now();
  const log = (...a) => console.log('[' + PHASE + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's]', ...a);
  const check = (ok, what) => { if (!ok) problems.push(what); log((ok ? 'ok   ' : 'FAIL ') + what); };

  // NO3D=1 turns WebGL off (the app falls back to the flat tray); useful where
  // software GL crashes the headless browser.
  const args = process.env.NO3D ? ['--disable-webgl', '--disable-3d-apis'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args });
  const ctxOpts = PHASE === 'phone'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1400, height: 950 } };
  if (PHASE === 'reduced') ctxOpts.reducedMotion = 'reduce';
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  page.on('crash', () => problems.push('page crashed (renderer died)'));
  browser.on('disconnected', () => log('browser disconnected'));

  const shot = (name, full) => page.screenshot({ path: path.join(OUT, PHASE + '-' + name + '.png'), fullPage: !!full });
  const q = (sel, fn) => page.$eval(sel, fn);
  async function rollFormula(f, mode) {
    if (mode) await page.evaluate((m) => document.querySelector('#mode-' + m).click(), mode);
    await page.fill('#formula', f);
    const before = await page.evaluate(() => document.getElementById('history-list').children.length);
    await page.press('#formula', 'Enter');
    await page.waitForFunction((b) => document.getElementById('history-list').children.length > b &&
      document.getElementById('result-card').dataset.state === 'done', before, { timeout: 90000 });
  }
  const chips = () => page.$$eval('#breakdown .chip', (cs) => cs.map((c) => ({
    text: c.getAttribute('aria-label') || c.title, house: c.classList.contains('house'), name: (c.querySelector('.chip-name') || {}).textContent || '' })));
  const bagCount = (s) => page.$$eval('.bag-group[data-sides="' + s + '"] .bag-item', (x) => x.length);
  const slotId = (s, n) => q('.bag-group[data-sides="' + s + '"] .bag-item:nth-child(' + n + ')', (li) => li.dataset.id);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('diceBox.profiles')));
  async function openEditor(id) {
    await page.click('[data-edit="' + id + '"]');
    await page.waitForSelector('#die-dialog[open]');
  }
  async function closeEditor() {
    await page.click('#die-dialog .dialog-actions button');
    await page.waitForFunction(() => !document.querySelector('#die-dialog[open]'));
  }
  const setControl = (sel, value) => page.evaluate(([s, v]) => {
    const n = document.querySelector(s);
    if (n.type === 'checkbox') n.checked = v; else n.value = v;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, value]);

  try {
    // ---- v1 profile data migrates to v2 (old dice become slot #1)
    await page.goto(base + '/index.html');
    await page.evaluate((fx) => { localStorage.clear(); localStorage.setItem('diceBox.profiles', JSON.stringify(fx)); }, V1);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('js-ready'));
    const has3d = await page.waitForFunction(() => window.DiceTray3D && window.DiceTray3D.available(), null, { timeout: 15000 }).then(() => true, () => false);
    log('3D tray available:', has3d);
    const mig = await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('diceBox.profiles'));
      const b = JSON.parse(localStorage.getItem('diceBox.profiles.backup') || 'null');
      const d6 = d.players[0].bag[6][0];
      return { version: d.version, name: d6.name, rolls: d6.faces.reduce((a, c) => a + c, 0), lucky: d6.lucky, types: Object.keys(d.players[0].bag).length,
        backup: b && b.version, shame: document.querySelectorAll('#shame-list .tomb').length, status: document.getElementById('bag-status').textContent };
    });
    check(mig.version === 2 && mig.name === 'Old Faithful' && mig.rolls === 21 && mig.lucky && mig.types === 7, 'v1 data migrated to v2 with names/stats/lucky kept ' + JSON.stringify(mig));
    check(mig.backup === 1, 'v1 backup kept');
    check(mig.shame === 1 && /upgraded/.test(mig.status), 'Hall of Shame kept and upgrade explained');

    // ---- rolling more dice than owned -> house dice + one-click add
    await rollFormula('8d6');
    let c = await chips();
    check(c.length === 8 && c.filter((x) => x.house).length === 7, '8d6 with one owned d6 uses 7 house dice');
    if (has3d) {
      const ins = await page.evaluate(() => window.DiceTray3D.inspect());
      check(ins.length === 8 && ins.every((d) => d.shown === d.value), '3D tray shows the rolled faces');
    }
    await shot('01-house');
    await page.click('#breakdown .house-used [data-add-sides="6"]');
    check(await bagCount(6) === 8, 'Add-from-note fills the bag to 8 d6 slots');
    const slotsText = await page.$$eval('.bag-group[data-sides="6"] .slot-no', (x) => x.map((n) => n.textContent).join(' '));
    check(slotsText === '#1 #2 #3 #4 #5 #6 #7 #8', 'each d6 has its own numbered slot');
    const names = await page.$$eval('.bag-group[data-sides="6"] .bag-name', (x) => x.map((n) => n.textContent));
    check(new Set(names).size === 8, 'every d6 has its own name');
    await rollFormula('8d6');
    c = await chips();
    check(!c.some((x) => x.house) && c.every((x) => /^#\d /.test(x.name)), 'owned dice roll with their slot + name on the chips');
    if (PHASE !== 'phone' && has3d) {
      await page.hover('#breakdown .chip[data-i="2"]');
      await page.waitForTimeout(250);
      const tip = await page.evaluate(() => { const t = document.querySelector('.tray-tip'); return t && !t.hidden ? t.textContent : null; });
      check(!!tip && /#3/.test(tip), 'hovering a chip points at that die in the tray');
    }
    await page.check('#show-tags');
    await page.waitForTimeout(200);
    if (has3d) check((await page.$$eval('.tray-tag', (t) => t.length)) === 8, 'name tags shown for all 8 dice');

    // ---- advantage uses one physical die per rolled die
    await rollFormula('2d20', 'adv');
    c = await chips();
    check(c.length === 4 && c.filter((x) => x.house).length === 3, '2d20 with advantage: 4 physical d20s (1 owned + 3 house)');
    await page.evaluate(() => document.querySelector('#mode-normal').click());

    // ---- per-die editor
    const id2 = await slotId(6, 2);
    await openEditor(id2);
    if (has3d && PHASE === 'desktop') {
      await page.waitForTimeout(500);
      check(await page.evaluate(() => document.getElementById('die-preview-wrap').classList.contains('is-3d')), 'editor shows a live 3D preview');
    }
    const opts = await page.evaluate(() => ({
      patterns: document.querySelectorAll('#die-pattern option').length, finishes: document.querySelectorAll('#die-finish option').length,
      fonts: document.querySelectorAll('#die-font option').length, inlays: document.querySelectorAll('#die-inlay option').length,
      presets: document.querySelectorAll('#die-presets [data-preset]').length,
    }));
    check(opts.patterns >= 6 && opts.finishes >= 10 && opts.fonts >= 3 && opts.inlays >= 4 && opts.presets >= 10, 'editor offers patterns/finishes/fonts/inlays/presets ' + JSON.stringify(opts));
    await page.click('#die-presets [data-preset="ember"]');
    await page.evaluate(() => { const b = document.getElementById('die-body').value; const ink = document.getElementById('die-ink'); ink.value = b; ink.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(150);
    check(/hard to read|too similar/.test(await q('#die-warnings', (n) => n.textContent)), 'unreadable numbers trigger a warning');
    // set every option by hand
    await setControl('#die-body', '#224466');
    await setControl('#die-body2', '#88aacc');
    await setControl('#die-ink', '#ffee00');
    await setControl('#die-pattern', 'marble');
    await setControl('#die-finish', 'glass');
    await setControl('#die-font', await page.$eval('#die-font option:last-child', (o) => o.value));
    await setControl('#die-edge-on', true);
    await setControl('#die-edge', '#000000');
    await setControl('#die-opacity', '0.8');
    await setControl('#die-glow', '0.5');
    await setControl('#die-glow-color', '#00ffcc');
    await setControl('#die-pips', false);
    await setControl('#die-inlay', 'text');
    await page.fill('#die-inlay-text', 'AB');
    await page.fill('#die-name', 'Sparky');
    await page.press('#die-name', 'Enter');
    await page.waitForTimeout(400);
    await shot('02-editor', PHASE === 'phone');
    if (has3d && PHASE === 'desktop') {
      const box = await page.locator('.die-preview').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 4 });
      await page.mouse.up();
      await page.focus('.die-preview');
      await page.keyboard.press('ArrowLeft');
    }
    // copy to one other die
    await page.selectOption('#die-copy-target', 'pick');
    const id1 = await slotId(6, 1);
    await page.check('#die-copy-list input[value="' + id1 + '"]');
    await page.click('#die-copy');
    check(/Copied this look to 1 die/.test(await q('#die-status', (n) => n.textContent)), 'copy look to a chosen die');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#die-dialog[open]'));
    let data = await stored();
    const d2 = data.players[0].bag[6].find((d) => d.id === id2);
    const st = d2.style || {};
    check(d2.name === 'Sparky', 'rename saved');
    check(st.body === '#224466' && st.body2 === '#88aacc' && st.ink === '#ffee00' && st.pattern === 'marble' && st.finish === 'glass' &&
      st.edge === '#000000' && st.opacity === 0.8 && st.glow === 0.5 && st.glowColor === '#00ffcc' && st.pips === false &&
      st.inlay === 'text' && st.inlayText === 'AB', 'every editor option saved on that one die ' + JSON.stringify(st));
    const others = data.players[0].bag[6].filter((d) => d.id !== id2);
    check(others.filter((d) => d.style && d.style.body === '#224466').length === 1 && (others.find((d) => d.id === id1).style || {}).body === '#224466', 'other d6s keep their own look (only the copied one changed)');
    check(/Sparky/.test(await q('.bag-group[data-sides="6"] .bag-item:nth-child(2) .bag-name', (n) => n.textContent)), 'bag shows the new name in slot #2');

    // ---- picker: "Use" sends a die in first and puts it on the table
    await page.click('#clear-btn');
    const id5 = await slotId(6, 5);
    await page.click('[data-pick="' + id5 + '"]');
    const pool6 = await page.evaluate(() => JSON.parse(localStorage.getItem('diceBox.state.v1')).pool[6]);
    check(pool6 === 1, 'Use on an unrolled die puts a d6 on the table');
    check(/#5 /.test(await q('#lineup', (n) => n.textContent)), 'Rolling-with line names the picked die');
    await page.click('#roll-btn');
    await page.waitForFunction(() => document.getElementById('result-card').dataset.state === 'done' && document.querySelectorAll('#breakdown .chip').length === 1, null, { timeout: 90000 });
    c = await chips();
    check(/^#5 /.test(c[0].name), 'the picked die is the one that rolled');
    await rollFormula('3d6');
    c = await chips();
    check(/^#5 /.test(c[0].name) && /^#1 /.test(c[1].name) && /^#2 /.test(c[2].name), 'picked die first, then slot order');
    await page.click('[data-move="' + id5 + '"][data-dir="-1"]');
    check(await slotId(6, 4) === id5, 'move up changes the slot');

    // ---- several dice of every type, individually styled
    if (PHASE === 'desktop') {
      for (const s of [8, 10, 12]) for (let i = 0; i < 3; i++) await page.click('.bag-group[data-sides="' + s + '"] [data-add="' + s + '"]');
      const ids = await page.$$eval('.bag-group[data-sides="8"] .bag-item, .bag-group[data-sides="10"] .bag-item, .bag-group[data-sides="12"] .bag-item', (x) => x.map((li) => li.dataset.id));
      for (const id of ids) {
        await openEditor(id);
        await page.click('#die-random');
        await closeEditor();
      }
      data = await stored();
      const styled = ['8', '10', '12'].flatMap((s) => data.players[0].bag[s]).filter((d) => d.style);
      check(styled.length === 12, '12 more dice styled one by one');
      await rollFormula('8d6+4d8+4d10+4d12');
      c = await chips();
      check(c.length === 20 && !c.some((x) => x.house), '20-die roll uses only own dice');
      if (has3d) {
        const ins = await page.evaluate(() => window.DiceTray3D.inspect());
        check(ins.length === 20 && ins.every((d) => d.shown === d.value), '20 styled dice show the right faces in 3D');
      }
      await shot('03-twenty');
    }

    // ---- burn and pardon keep slots
    const burnId = await slotId(6, 2);
    await page.click('[data-burn="' + burnId + '"]');
    await page.waitForSelector('#burn-dialog[open]');
    await page.click('#burn-confirm');
    await page.waitForFunction(() => /reduced to ash/.test(document.getElementById('bag-status').textContent), null, { timeout: 30000 });
    const tomb = await page.evaluate(() => (document.querySelector('#shame-list .tomb') || {}).textContent || '');
    check(await slotId(6, 2) !== burnId && /was #2/.test(tomb), 'burned die leaves slot #2 to a fresh die and goes to the Hall');
    await page.click('[data-pardon="' + burnId + '"]');
    check(await slotId(6, 2) === burnId, 'pardon puts it back in slot #2');

    // ---- remove from bag via the editor
    const n6 = await bagCount(6);
    const lastId = await slotId(6, n6);
    await openEditor(lastId);
    await page.click('#die-remove');
    await page.waitForFunction(() => !document.querySelector('#die-dialog[open]'));
    check(await bagCount(6) === n6 - 1, 'remove from bag drops a slot');

    // ---- everything survives a reload
    const snap = await page.evaluate(() => localStorage.getItem('diceBox.profiles'));
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('js-ready'));
    const after = await page.evaluate(() => ({ snap: localStorage.getItem('diceBox.profiles'),
      d6: document.querySelectorAll('.bag-group[data-sides="6"] .bag-item').length, picked: document.querySelectorAll('.bag-item.is-picked').length,
      tags: document.getElementById('show-tags').checked, styled: document.querySelectorAll('.bag-icon .die.has-look').length }));
    check(after.snap === snap && after.d6 === n6 - 1 && after.picked === 1 && after.tags && after.styled >= 2, 'bag, picks and looks persist across reload ' + JSON.stringify({ ...after, snap: undefined }));

    // ---- layout: nothing wider than the viewport
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll('.bag-item, .bag-group-head, .rack, .controls, .result-card')).filter((n) => n.getBoundingClientRect().right > w + 1).length;
    });
    check(overflow === 0, 'no horizontal overflow in the bag/rack/controls');
    await page.evaluate(() => document.getElementById('bag-panel').scrollIntoView());
    await shot('04-bag');
    await shot('05-full', true);
  } catch (e) {
    problems.push('exception: ' + (e && e.message ? e.message.split('\n')[0] : e));
  } finally {
    await browser.close();
  }
  log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'all checks passed');
  return problems;
}

const { chromium } = await loadPlaywright();
const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
let failed = 0;
for (const phase of PHASES) failed += (await runPhase(chromium, base, phase)).length;
server.close();
console.log(failed ? failed + ' problem(s); screenshots in ' + OUT : 'All phases passed; screenshots in ' + OUT);
process.exit(failed ? 1 : 0);
