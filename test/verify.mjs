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

// The feed rules must stand down on the watch page. Measured 2026-09-03: with
// them active there, YouTube walls the video before the player starts.
const feedRules = (css.match(/html:not\(\[data-ytac-feed-off\]\)[^,{]*/g) || []);
const unscoped = feedRules.filter(r => !r.includes(':not([data-ytac-watch])'));
check('css: every feed rule stands down on the watch page',
      feedRules.length > 0 && unscoped.length === 0,
      `${feedRules.length} feed rules, ${unscoped.length} still active on /watch`);
check('content: data-ytac-watch is refreshed on soft navigation',
      (content.match(/data-ytac-watch/g) || []).length >= 3,
      'a stale attribute either leaks the hiding onto /watch or kills it on the feed');

// CONTROL. Unscope one rule and require the check to trip.
const leaky = css.replace('html:not([data-ytac-feed-off]):not([data-ytac-watch])',
                          'html:not([data-ytac-feed-off])');
const leakyRules = (leaky.match(/html:not\(\[data-ytac-feed-off\]\)[^,{]*/g) || []);
check('CONTROL: an unscoped feed rule DOES trip that check — so it can fail',
      leakyRules.filter(r => !r.includes(':not([data-ytac-watch])')).length > 0,
      'the 0.31.26 behaviour, which walled the video on a live measurement');

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

/* ---- 2a. the watch page hides ads by OPACITY, never by display ---------- */

// display:none on the watch page's ad slots walls the video before playback
// starts; opacity:0 does not, measured on three videos. So the watch-page rules
// must never use display, and must keep the box.
const WATCH_RULE = /html\[data-ytac-watch\][\s\S]*?\{([\s\S]*?)\}/;
const watchDecls = (WATCH_RULE.exec(css) || [, ''])[1];
check('css: the watch-page rules hide by opacity, not display',
      /opacity:\s*0\s*!important/.test(watchDecls) &&
      !/display:\s*none/.test(watchDecls),
      `watch-page declarations: ${watchDecls.trim().replace(/\s+/g, ' ')}`);
check('css: the watch-page hiding is on by default (opt-OUT switch)',
      css.includes(':not([data-ytac-nosofthide])'),
      'shipping it opt-in would mean nothing is hidden on the watch page');

// CONTROL. Swap opacity for display and require the check to trip.
const hardHide = css.replace('opacity: 0 !important', 'display: none !important');
check('CONTROL: display:none in the watch rules DOES trip that check — so it can fail',
      /display:\s*none/.test((WATCH_RULE.exec(hardHide) || [, ''])[1]),
      'the 0.31.26 behaviour, which walled the video on a live measurement');

/* ---- 2b. the third measured trigger: the ad-skip loop ------------------ */

// Bisected 2026-09-03 against clean baselines: with inject.js off AND every
// CSS gate set, the player loop still walls the video on its own. So the skip
// and the seek are opt-IN, and gated on a URL switch rather than on
// settings.skipVideoAds, which a stored profile value could flip back on.
const skipOptIn = /const SKIP_ON = location\.search\.indexOf\("ytacskip=1"\) !== -1/.test(content);
check('content: ad skip/seek is OFF by default (?ytacskip=1 opts in)',
      skipOptIn, 'measured: loop alone => wall, after the video had started playing');
// The gate must NOT sit at the top of the function. 0.31.25 put it there and
// the extension stopped counting adverts it could see — a live report said
// "video ads reaching playback: 0" while carrying 3 ad sightings.
check('content: an unskipped ad is still COUNTED (recordAd before the gate returns)',
      /if \(!SKIP_ON\) \{[\s\S]{0,400}?recordAd\(/.test(content),
      'a feature that cannot count what it saw cannot report the trade it is making');
check('content: the SKIP_ON gate is not the first test in handleVideoAd',
      !/function handleVideoAd\(\) \{\s*if \(!SKIP_ON/.test(content),
      'gating the whole function disables the counting with the skipping');

// CONTROL. Put the gate back at the top and require that check to fail.
const regressed = content.replace(
  'function handleVideoAd() {\n    if (!settings.skipVideoAds',
  'function handleVideoAd() {\n    if (!SKIP_ON || !settings.skipVideoAds');
check('CONTROL: the gate back at the top DOES fail that check — so it can fail',
      regressed !== content &&
      /function handleVideoAd\(\) \{\s*if \(!SKIP_ON/.test(regressed),
      'the 0.31.25 regression, caught from a live popup report');

// The report line must not be derived only from the actions the default
// disables. "video ads reaching playback" was skipped + seeked, which is
// permanently 0 with skipping off — it could not report its own subject.
check('popup: "reaching playback" counts ads played through as well',
      /videoAdsSkipped \+ s\.videoAdsSeeked \+ \(s\.videoAdsPlayedThrough/.test(popup),
      'a counter gated on the value the default zeroes cannot ever fire');
check('content: a played-through ad does NOT credit adsSkipped or secondsSaved',
      /NOT recordAd\(\)/.test(content) &&
      /session\.videoAdsPlayedThrough\+\+/.test(content),
      'nothing was skipped and no time was saved — claiming either is a false number');
check('content: the counter is published at ZERO on start, not left absent',
      /publishPlayedThrough\(\);/.test(content.split('function start()')[1] || ''),
      'absent and zero are different states — "no ad yet" vs "never ran"');

check('content: the played-through count is readable from the page',
      /data-ytac-adsplayed/.test(content),
      'it could previously only be read by copying a popup report by hand');

// CONTROL. Revert the report line and require the check to fail.
const oldReport = popup.replace(
  /const reached =\s*\n?\s*s\.videoAdsSkipped \+ s\.videoAdsSeeked \+ \(s\.videoAdsPlayedThrough \?\? 0\);/,
  'const reached = s.videoAdsSkipped + s.videoAdsSeeked;');
check('CONTROL: the old skipped+seeked line DOES fail that check — so it can fail',
      oldReport !== popup &&
      !/videoAdsSkipped \+ s\.videoAdsSeeked \+ \(s\.videoAdsPlayedThrough/.test(oldReport),
      'the line that reported 0 while three ads had been seen');

check('content: the skip ACTION is gated, not the whole function',
      /if \(!SKIP_ON\) \{/.test(content) &&
      /const SKIP_ON = location\.search/.test(content),
      'a stored setting must not re-enable the action, but detection must survive');

// CONTROL. Remove the gate and require both checks to fail.
const unskipped = content.replace('if (!SKIP_ON) {', 'if (false) {');
check('CONTROL: removing the skip gate DOES fail that check — so it can fail',
      unskipped !== content && !/if \(!SKIP_ON\) \{/.test(unskipped),
      'the 0.31.24 behaviour, which walled the video on a live measurement');

/* ---- 2c. quiet ads: cover and mute, never remove ------------------------ */

// The cover must be OUR node laid on top, never a rule against a YouTube
// element — hiding one of theirs is what the wall detects.
check('content: the ad cover is an element we add, not a YouTube node hidden',
      /createElement\("div"\)[\s\S]{0,200}ytac-ad-cover/.test(content),
      'nothing of YouTube\'s may be hidden, resized or removed');
check('css: the cover styles target our own id only',
      /#ytac-ad-cover/.test(css) &&
      !/ytd-[a-z-]+[^{]*\{[^}]*z-index:\s*30/.test(css),
      'a rule against their element would be a bait-check target');
check('content: quiet mode never touches currentTime or playbackRate',
      !/function quietAd\([\s\S]*?\n  \}/.test(content) ||
      !/currentTime\s*=|playbackRate\s*=/.test(
        (/function quietAd\([\s\S]*?\n  \}/.exec(content) || [''])[0]),
      'seeking and fast-forwarding are both measured wall triggers');
check('content: the cover countdown is bounded by MAX_AD_SECONDS',
      /raw <= MAX_AD_SECONDS \? raw : null/.test(content),
      'a live stream made the first version read "8725s"');

check('content: the viewer\'s own mute state is restored, not clobbered',
      /priorMuted === false && v\.muted/.test(content),
      'only hand back the state we found');

// CONTROL. Make quietAd seek and require that check to trip.
const seeking = content.replace('if (!video.muted) video.muted = true;',
                                'video.currentTime = video.duration;');
const seekBody = (/function quietAd\([\s\S]*?\n  \}/.exec(seeking) || [''])[0];
check('CONTROL: a seek inside quietAd DOES trip that check — so it can fail',
      /currentTime\s*=/.test(seekBody),
      'seeking is one of the four measured wall triggers');

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
