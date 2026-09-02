/**
 * Regression tests for Quite for YouTube 0.31.24. Run with:
 *
 *     node test/verify.mjs
 *
 * This build ships NO declarativeNetRequest ruleset — the eight hand-written
 * rules were measured across four arms to block nothing, and removed. So what
 * is left to protect is different from what the old suite protected:
 *
 *   1. content.css must hide ad containers and NOTHING load-bearing. The
 *      failure mode is unchanged from the DNR days — a selector broad enough
 *      to catch the watch page as well as the advert.
 *
 *   2. The two arms measured on 2026-09-02 to trigger YouTube's anti-adblock
 *      wall — the parse-time prune and the response rewrite — must stay OFF by
 *      default. Each one on its own produced a wall and readyState 0, i.e. no
 *      video at all. This is the assertion that would have saved the 0.20-0.31
 *      series, so it is the one with the loudest control.
 *
 *   3. The version literal must match the manifest, and the popup report must
 *      say which arm it is.
 *
 * Every check below is followed by a CONTROL that breaks the thing it tests
 * and requires the check to FAIL. A suite that cannot report "broken" is what
 * CLAUDE.md was written about.
 */
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const EXT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const css = read('content.css'), inject = read('inject.js'), popup = read('popup.js');
const content = read('content.js');

const out = [];
const check = (name, pass, detail) => out.push({ name, pass: !!pass, detail });

/* ---- 1. the stylesheet hides adverts, not the page ---------------------- */

// Selectors that must never appear as a whole-element hide. Each is either the
// watch page itself or a container the video lives inside.
const LOAD_BEARING = [
  'ytd-watch-flexy', 'ytd-player', '#movie_player', '#player', 'video',
  'ytd-app', '#content', 'body', 'html',
];
// A selector is dangerous only if it is hidden AS ITSELF — `:has(> ad-slot)`
// narrows it to a container that demonstrably holds an advert, which is
// EasyList's own approach and is why no empty grid cell is left behind.
const hidesBare = (sheet, sel) => {
  const re = new RegExp(`(^|[,\\s])${sel.replace(/[#.]/g, '\\$&')}\\s*(,|\\{)`, 'm');
  return re.test(sheet);
};
const bare = LOAD_BEARING.filter(sel => hidesBare(css, sel));
check('css: nothing load-bearing is hidden outright', bare.length === 0,
      bare.length ? `hidden as itself: ${bare.join(', ')}` : 'none of the 9 playback-critical selectors');

// CONTROL. Hide the watch page and require the check to trip.
const sabotagedCss = css + '\nytd-watch-flexy { display: none !important; }\n';
check('CONTROL: hiding ytd-watch-flexy DOES trip that check — so it can fail',
      LOAD_BEARING.filter(s => hidesBare(sabotagedCss, s)).length > 0,
      'over-broad selector detected in the sabotaged copy');

check('css: hiding is the default, gated on an opt-OUT attribute',
      css.includes(':not([data-ytac-feed-off])'),
      'rules apply before any script runs, so slots never paint');

/* ---- 2. the two measured wall triggers are OFF by default -------------- */

// Read as the browser would: the prune runs only if the opt-IN switch is
// present, the rewrite only if its opt-IN switch is present. An opt-OUT form
// (`!== -1` for prune, `=== -1` for rewrite) means ON by default, which is the
// walled build.
const pruneOptIn = /indexOf\("ytacjsonprune=1"\)\s*!==\s*-1/.test(inject);
const rewriteOptIn = /indexOf\("ytacrewrite=1"\)\s*===\s*-1/.test(inject);
check('inject: parse-time prune is OFF by default (?ytacjsonprune=1 opts in)',
      pruneOptIn, 'measured 2026-09-02: prune alone => wall, readyState 0, no media source');
check('inject: response rewrite is OFF by default (?ytacrewrite=1 opts in)',
      rewriteOptIn, 'measured 2026-09-02: rewrite alone => wall, readyState 0');

// CONTROL. Restore either default and require the matching check to fail.
const walledPrune = inject.replace('indexOf("ytacjsonprune=1") !== -1',
                                   'indexOf("ytacnojsonprune=1") === -1');
check('CONTROL: an opt-OUT prune DOES fail that check — so it can fail',
      walledPrune !== inject &&
      !/indexOf\("ytacjsonprune=1"\)\s*!==\s*-1/.test(walledPrune),
      'the 0.31.23 default, which walled the video on a live measurement');

const walledRewrite = inject.replace('indexOf("ytacrewrite=1") === -1',
                                     'indexOf("ytacnorewrite=1") !== -1');
check('CONTROL: an opt-OUT rewrite DOES fail that check — so it can fail',
      walledRewrite !== inject &&
      !/indexOf\("ytacrewrite=1"\)\s*===\s*-1/.test(walledRewrite),
      'the 0.31.22 default, which walled the video on a live measurement');

/* ---- 3. the build can be identified, and the arm is stated ------------- */

const lit = /const VERSION = "([^"]+)"/.exec(content);
check('content: VERSION is a literal, not getManifest()', !!lit,
      lit ? `literal ${lit[1]}` : 'getManifest() reports the LOADED build, not the running code');
check('content: VERSION literal matches the manifest',
      !!lit && lit[1] === manifest.version,
      `${lit ? lit[1] : '(none)'} vs manifest ${manifest.version}`);

// CONTROL. Drift the literal and require the check to fail.
const drifted = content.replace(/const VERSION = "[^"]+"/, 'const VERSION = "0.0.0"');
const driftLit = /const VERSION = "([^"]+)"/.exec(drifted);
check('CONTROL: a drifted literal DOES fail that check — so it can fail',
      driftLit[1] !== manifest.version, `sabotaged copy reports ${driftLit[1]}`);

check('popup: the report states which arm it is', /ARM:/.test(popup),
      'a bypassed run and a live one read identically without this');
check('popup: a hidden-tab reading is marked VOID, not merely odd',
      /VOID/.test(popup) && /tabHidden/.test(popup),
      'CLAUDE.md records two false "cannot reproduce" verdicts from hidden tabs');
check('content: the diagnostics payload carries both arm signals',
      /bypassed:/.test(content) && /tabHidden:/.test(content),
      'the popup cannot state an arm the content script never sends');

// CONTROL. Strip the ARM line and require the check to fail.
check('CONTROL: removing the ARM line DOES fail that check — so it can fail',
      !/ARM:/.test(popup.replace(/ARM:/g, 'xxx')), 'sabotaged copy has no arm marker');

let bad = 0;
console.log('');
for (const r of out) { if (!r.pass) bad++; console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`); }
console.log(`\n  ${out.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
