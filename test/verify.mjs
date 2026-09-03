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
// Comments mention the very selectors and properties these checks look for,
// so every selector-level check runs against the stripped source.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
// Same for JS. Four separate checks today matched prose in a comment that
// described the very thing the check forbade, and reported the code guilty or
// innocent on that basis. Strip comments once, here, and use these everywhere
// a check is about what the CODE does.
const stripJs = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const content = read('content.js');
const contentCode = stripJs(content);
// The body of one top-level function, so a check can be confined to it. A
// check that searched [\s\S]*? across the whole file once found a call in a
// different function and reported an invariant held after the real one had
// been removed.
const bodyOf = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) return '';
  const open = src.indexOf('{', at);
  const close = src.indexOf('\n  }', open);
  return close === -1 ? '' : src.slice(open, close);
};

const out = [];
const check = (name, pass, detail) => out.push({ name, pass: !!pass, detail });

/*
 * EVERY control built with .replace() carries a `copy !== original` guard.
 * A replace whose target text has drifted silently does nothing, and the
 * control then passes on an unchanged file — which is a control that cannot
 * fail. It happened twice today (the pod control, and an earlier one that
 * split on the wrong fragment) before this became a rule. Controls that
 * APPEND or test a literal cannot be vacuous and carry no guard.
 */

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
const bare = LOAD_BEARING.filter(sel => hidesBare(cssCode, sel));
check('css: nothing load-bearing is hidden outright', bare.length === 0,
      bare.length ? `hidden as itself: ${bare.join(', ')}` : 'none of the 9 playback-critical selectors');

// CONTROL. Hide the watch page and require the check to trip.
const sabotagedCss = css + '\nytd-watch-flexy { display: none !important; }\n';
check('CONTROL: hiding ytd-watch-flexy DOES trip that check — so it can fail',
      LOAD_BEARING.filter(s => hidesBare(sabotagedCss, s)).length > 0,
      'over-broad selector detected in the sabotaged copy');

// The feed rules must stand down on the watch page. Measured 2026-09-03: with
// them active there, YouTube walls the video before the player starts.
// ONE HIDING METHOD. display:none on a YouTube ad container is detected
// wherever it happens — on the FEED it sets the flag and the wall lands on the
// next video clicked into, which is why every direct URL load reads clean.
const AD_SELECTORS = /(ytd-[a-z-]*ad[a-z-]*-renderer|ytd-promoted-[a-z-]+|ytd-companion-slot-renderer|ytm-companion-[a-z-]+|\.ytp-ad-[a-z-]+|ad-slot-renderer)/;
const blocks = cssCode.split('}').filter(b => AD_SELECTORS.test(b));
const hardBlocks = blocks.filter(b => /display:\s*none/.test(b));
check('css: no ad-container rule uses display:none',
      blocks.length > 0 && hardBlocks.length === 0,
      `${blocks.length} ad-container blocks, ${hardBlocks.length} using display:none` +
      (hardBlocks.length ? ` -> ${hardBlocks[0].trim().split('\n')[0]}` : ''));
check('test: the selector pattern covers .ytp-ad-* as well as ytd-*',
      AD_SELECTORS.test('.ytp-ad-overlay-container') &&
      AD_SELECTORS.test('ytd-ad-slot-renderer'),
      'the first version listed only ytd-* and missed four overlay rules');
check('css: they hide by opacity instead',
      blocks.some(b => /opacity:\s*0\s*!important/.test(b)),
      'opacity keeps offsetHeight and offsetParent normal; display:none does not');

// CONTROL. Put display:none back on an ad container and require the check to
// trip.
const hardCss = cssCode.replace('  opacity: 0 !important;\n  pointer-events: none !important;',
                            '  display: none !important;');
const regressedBlocks = hardCss.split('}').filter(b => AD_SELECTORS.test(b));
check('CONTROL: display:none on an ad container DOES trip that check — so it can fail',
      hardCss !== cssCode && regressedBlocks.filter(b => /display:\s*none/.test(b)).length > 0,
      'the 0.31.35 behaviour, which walled the video on an in-session click');

// data-ytac-hidden is the tab-visibility VALIDITY flag on <html>. No CSS rule
// may target it: a descendant rule once did, dead but one edit from hiding the
// whole page under the same name.
check('css: no rule targets the data-ytac-hidden validity flag',
      !/\[data-ytac-hidden/.test(cssCode),
      'the attribute means "tab was hidden", not "hide this"');
check('CONTROL: a rule on data-ytac-hidden DOES trip that check — so it can fail',
      /\[data-ytac-hidden/.test(cssCode + '\n[data-ytac-hidden="1"] { opacity: 0 }'),
      'the rule that shipped until 0.31.44');

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
check('css: the hiding is on by default (opt-OUT switch)',
      cssCode.includes(':not([data-ytac-nosofthide])'),
      'shipping it opt-in would mean nothing is hidden anywhere');

/* ---- 2a2. no wrapper on window.fetch by default -------------------------- */

// With the rewrite off, the fetch OBSERVER was the only wrapper still on
// window.fetch, and it was fully fingerprintable — name "", length 2, toString
// non-native. It feeds diagnostics and nothing else. Measurement goes behind a
// switch; the default leaves fetch pristine.
const injectCode = stripJs(inject);
check('inject: the fetch observer is opt-IN (?ytacobserve=1)',
      /const OBSERVE_ON = location\.search\.indexOf\("ytacobserve=1"\) !== -1/.test(injectCode) &&
      /if \(noRewrite && OBSERVE_ON\)/.test(injectCode),
      'a detectable wrapper that removes no advert has no business being on by default');
check('inject: hideNative preserves name and length, not only toString',
      /defineProperty\(patched, "name"/.test(injectCode) &&
      /defineProperty\(patched, "length"/.test(injectCode),
      'two of the three tells were never masked at all');
check('inject: the observe arm announces itself on the switches line',
      /"ytacobserve=1"\) !== -1 \? "observe"/.test(injectCode),
      'an arm that does not report itself reads like the default');

// CONTROL. Make the observer unconditional again and require the check to trip.
const alwaysObserve = injectCode.replace('if (noRewrite && OBSERVE_ON)', 'if (noRewrite)');
check('CONTROL: an unconditional observer DOES trip that check — so it can fail',
      alwaysObserve !== injectCode && !/if \(noRewrite && OBSERVE_ON\)/.test(alwaysObserve),
      'the 0.31.42 behaviour: a fingerprintable fetch on every load');

/* ---- 2a3. the bypass is decided once, for the whole page ---------------- */

// inject.js and the CSS gates read ?ytacoff=1 at document_start and keep the
// answer through soft navigations. tick() re-read the URL every pass, so the
// first click un-bypassed the loop while the ARM line still said BYPASSED.
const bypassReads = (contentCode.match(/indexOf\("ytacoff=1"\)/g) || []).length;
check('content: ?ytacoff=1 is read exactly once, into BYPASSED',
      bypassReads === 1 && /const BYPASSED = location\.search\.indexOf\("ytacoff=1"\)/.test(contentCode),
      `${bypassReads} reads of the switch (want 1 — every other site must use BYPASSED)`);
check('content: the loop gate uses BYPASSED, not a live URL read',
      /if \(!settings\.enabled \|\| BYPASSED\)/.test(contentCode),
      'a live read un-bypasses on the first in-session click');

// CONTROL. Put the live read back in the loop gate and require the check to trip.
const liveRead = contentCode.replace('if (!settings.enabled || BYPASSED)',
                                     'if (!settings.enabled || location.search.indexOf("ytacoff=1") !== -1)');
check('CONTROL: a live URL read in the loop gate DOES trip that check — so it can fail',
      liveRead !== contentCode &&
      (liveRead.match(/indexOf\("ytacoff=1"\)/g) || []).length > 1,
      'the 0.31.44 behaviour: a half-bypassed hop reported as fully bypassed');

/* ---- 2b. the third measured trigger: the ad-skip loop ------------------ */

// Bisected 2026-09-03 against clean baselines: with inject.js off AND every
// CSS gate set, the player loop still walls the video on its own. So the skip
// and the seek are opt-IN, and gated on a URL switch rather than on
// settings.skipVideoAds, which a stored profile value could flip back on.
const skipOptIn = /const SKIP_ON = SKIP_MODE\.size > 0;/.test(contentCode) &&
                  /if \(!m\) return new Set\(\);/.test(contentCode);
check('content: ad skip/seek is OFF by default (?ytacskip=<mode> opts in)',
      skipOptIn, 'measured: loop alone => wall, after the video had started playing');
// Under an action mode, an advert that no action lands on — an unskippable in
// click mode — must still be counted as played through, or the arm's own
// readout undercounts. It is settled at the gap, and for a pod when the next
// advert begins.
check('content: an advert under an action mode is credited at the gap if no action landed',
      /> AD_GAP_MS\) \{[\s\S]{0,700}?if \(adPendingCredit\) creditPlayedThrough\(\);/.test(contentCode) &&
      !/if \(!adGoneSince\) \{[\s\S]{0,300}?creditPlayedThrough/.test(contentCode) &&
      /if \(!adCredited\) adPendingCredit = true;/.test(contentCode) &&
      (contentCode.match(/creditPlayedThrough\(\)/g) || []).length >= 4,
      'default path, gap path and pod path all share one credit');
const noPending = contentCode.replace('if (!adCredited) adPendingCredit = true;', '');
check('CONTROL: dropping the pending mark DOES trip that check — so it can fail',
      noPending !== contentCode && !/if \(!adCredited\) adPendingCredit = true;/.test(noPending),
      'the 0.31.50 behaviour: unskippables uncounted under click mode');

// The gate must NOT sit at the top of the function. 0.31.25 put it there and
// the extension stopped counting adverts it could see — a live report said
// "video ads reaching playback: 0" while carrying 3 ad sightings.
check('content: an unskipped ad is still COUNTED (recordAd before the gate returns)',
      /if \(!SKIP_ON\) \{[\s\S]{0,400}?recordAd\(/.test(content),
      'a feature that cannot count what it saw cannot report the trade it is making');
// The loop's three actions are gated SEPARATELY, so each can be measured as
// its own arm. The loop as a whole walled; which action did was never
// isolated, and a single switch cannot isolate anything.
check('content: click, speed and seek each have their own gate',
      /if \(CLICK_ON && isVisible\(skip\)\)/.test(contentCode) &&
      /if \(SPEED_ON && video\.playbackRate < 8\)/.test(contentCode) &&
      /if \(!SEEK_ON\) return;/.test(contentCode),
      'one switch for three actions cannot say which one walls');
check('content: the mode parser only admits click, speed, seek',
      /x === "click" \|\| x === "speed" \|\| x === "seek"/.test(contentCode),
      'an unknown mode must enable nothing');
check('content: the advert is still covered and muted while an action is allowed',
      /quietAd\(p, p\.querySelector\("video"\)\);[\s\S]{0,160}?const skip = p\.querySelector\(SKIP_BUTTONS\);/.test(contentCode) &&
      !/const skip = p\.querySelector\(SKIP_BUTTONS\);[\s\S]*?quietAd\(p, p\.querySelector\("video"\)\)/.test(bodyOf(contentCode, 'handleVideoAd')),
      'Skip takes five seconds to appear and unskippables never offer one');
check('content: the skip mode is published on the page and in the payload',
      /data-ytac-skipmode/.test(contentCode) && /skipMode:/.test(contentCode) && /skip actions allowed/.test(popup),
      'an arm that does not announce itself reads like the default');

// CONTROL. Collapse two gates into one and require the check to trip.
const oneGate = contentCode.replace('if (SPEED_ON && video.playbackRate < 8)', 'if (SKIP_ON && video.playbackRate < 8)');
check('CONTROL: a shared gate DOES trip that check — so it can fail',
      oneGate !== contentCode && !/if \(SPEED_ON && video\.playbackRate < 8\)/.test(oneGate),
      'the 0.31.49 shape: one switch, three actions');

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
      /if \(!SKIP_ON\) \{/.test(contentCode) &&
      /const SKIP_ON = SKIP_MODE\.size > 0;/.test(contentCode),
      'a stored setting must not re-enable the action, but detection must survive');

// CONTROL. Remove the gate and require both checks to fail.
const unskipped = content.replace('if (!SKIP_ON) {', 'if (false) {');
check('CONTROL: removing the skip gate DOES fail that check — so it can fail',
      unskipped !== content && !/if \(!SKIP_ON\) \{/.test(unskipped),
      'the 0.31.24 behaviour, which walled the video on a live measurement');

// A pod plays its adverts back to back with NO gap, so a gap-based reset can
// never fire between them: a real two-advert pod was credited once on
// 2026-09-03, while the comment claimed pods were counted.
check('content: a second advert in a pod re-opens crediting',
      /function newAdStarted\(/.test(contentCode) &&
      /if \(newAdStarted\([\s\S]{0,60}\)\) \{[\s\S]{0,160}?adCredited = false;/.test(contentCode),
      'the gap reset cannot fire inside a pod — there is no gap');
check('content: the playhead is forgotten when the break ends',
      /lastAdCt = 0;/.test(contentCode),
      'else the first advert of the next break looks like a continuation');

// CONTROL. Remove the pod detection and require the check to trip.
const noPod = contentCode.replace(/if \(newAdStarted\([\s\S]*?\)\) \{[\s\S]*?adCredited = false;\s*\}/, '');
check('CONTROL: dropping pod detection DOES trip that check — so it can fail',
      noPod !== contentCode &&
      !/if \(newAdStarted\([\s\S]{0,60}\)\) \{[\s\S]{0,160}?adCredited = false;/.test(noPod),
      'the 0.31.41 behaviour: two adverts counted as one');

/* ---- 2b2. the sighting probe can see a Shorts advert -------------------- */

// A Shorts advert is an ad slot inside the reel, not a ytp-ad* element in the
// player, so the probe could not record one at all. Whether ad-showing lands on
// the player for it is the reading that decides if the cover fires on Shorts,
// and nothing had captured it.
const observeBody = bodyOf(contentCode, 'observePlayer');
const reelTriggerAt = observeBody.indexOf('activeReelAdSlot()');
const classGateAt = observeBody.indexOf('cls === lastPlayerClasses');
check('content: a Shorts ad slot in the active reel records a sighting',
      /function activeReelAdSlot\(/.test(contentCode) && reelTriggerAt !== -1,
      'without this the Shorts question is unmeasurable even in real use');
check('content: the Shorts trigger runs BEFORE the player class-change gate',
      reelTriggerAt !== -1 && classGateAt !== -1 && reelTriggerAt < classGateAt,
      'after the gate it only runs when the player classes change — which a Shorts advert may never do');
check('content: the sighting records surface and adSlotInActiveReel',
      /surface: location\.pathname\.startsWith\("\/shorts\/"\)/.test(contentCode) &&
      /adSlotInActiveReel: !!activeReelAdSlot\(\)/.test(contentCode),
      'adStateClass alone cannot say which surface it came from');
check('content: sightings are readable from the page, and stamped 0 at start',
      /data-ytac-sightings/.test(contentCode) &&
      /setAttribute\("data-ytac-sightings", "0"\)/.test(contentCode) &&
      /data-ytac-lastsighting/.test(contentCode),
      'absent must mean "never ran", not "no sighting yet"');

check('popup: flags a Shorts advert that got no ad-showing',
      /SHORTS ADVERT WITHOUT ad-showing/.test(popup),
      'the reading that matters must be loud in the report, not buried');

// CONTROL. Drop the Shorts trigger and require the check to trip.
const noShorts = contentCode.replace('const reelSlot = activeReelAdSlot();', 'const reelSlot = null;');
check('CONTROL: dropping the Shorts trigger DOES trip that check — so it can fail',
      noShorts !== contentCode && bodyOf(noShorts, 'observePlayer').indexOf('activeReelAdSlot()') === -1,
      'the 0.31.45 probe, blind to Shorts adverts');
// CONTROL for the ordering: move the trigger below the gate and require a trip.
const afterGate = (() => {
  const body = bodyOf(contentCode, 'observePlayer');
  const trig = body.slice(body.indexOf('const reelSlot'), body.indexOf('const cls ='));
  return contentCode.replace(trig, '').replace('lastPlayerClasses = cls;', 'lastPlayerClasses = cls;\n' + trig);
})();
check('CONTROL: the trigger placed AFTER the gate DOES trip that check — so it can fail',
      afterGate !== contentCode && (() => { const b = bodyOf(afterGate, 'observePlayer'); return b.indexOf('activeReelAdSlot()') > b.indexOf('cls === lastPlayerClasses'); })(),
      'the 0.31.47 placement, which the positive control caught');

/* ---- 2c. quiet ads: cover and mute, never remove ------------------------ */

// The cover must be OUR node laid on top, never a rule against a YouTube
// element — hiding one of theirs is what the wall detects.
check('content: the ad cover is an element we add, not a YouTube node hidden',
      /createElement\("div"\)[\s\S]{0,200}ytac-ad-cover/.test(content),
      'nothing of YouTube\'s may be hidden, resized or removed');
const coverDecls = (/#ytac-ad-cover\s*\{([\s\S]*?)\}/.exec(cssCode) || [, ''])[1];
const coverZ = parseInt((/z-index:\s*(\d+)/.exec(coverDecls) || [, '0'])[1], 10);
check('css: the cover styles target our own id only',
      /#ytac-ad-cover/.test(cssCode) &&
      !/ytd-[a-z-]+[^{]*\{[^}]*z-index:\s*\d+/.test(cssCode),
      'a rule against their element would be a bait-check target');
// Measured 2026-09-03: the advertiser card container is z 850, the Skip
// button 1000. Below 850 the card draws on top of the panel; at or above 1000
// the viewer loses the Skip button.
check('css: the cover sits above the advert card (850) and below Skip (1000)',
      coverZ > 850 && coverZ < 1000,
      `cover z-index ${coverZ}`);
// CONTROL. Put it back to 30 and require the check to trip.
const lowCover = cssCode.replace(/(#ytac-ad-cover\s*\{[\s\S]*?z-index:\s*)\d+/, '$130');
const lowZ = parseInt((/z-index:\s*(\d+)/.exec((/#ytac-ad-cover\s*\{([\s\S]*?)\}/.exec(lowCover) || [, ''])[1]) || [, '0'])[1], 10);
check('CONTROL: a cover at 30 DOES trip that check — so it can fail',
      lowCover !== cssCode && !(lowZ > 850 && lowZ < 1000),
      'the 0.31.48 layer, under the advertiser card');
check('content: quiet mode never touches currentTime or playbackRate',
      !/function quietAd\([\s\S]*?\n  \}/.test(content) ||
      !/currentTime\s*=|playbackRate\s*=/.test(
        (/function quietAd\([\s\S]*?\n  \}/.exec(content) || [''])[0]),
      'seeking and fast-forwarding are both measured wall triggers');
// The cover and the mute are applied by the loop. EVERY path that stops the
// loop must release them, or the viewer is left with a black panel over their
// own video and no sound until they reload.
const shutdownBody = bodyOf(content, 'shutdown');
check('content: shutdown() releases the cover and the mute',
      /unquietAd\(\)/.test(shutdownBody),
      'reloading the extension mid-advert strands the cover otherwise');
check('content: disabling Protection mid-advert releases them too',
      /if \(!settings\.enabled \|\| BYPASSED\) \{\s*\n\s*unquietAd\(\);/.test(contentCode),
      'a black screen sends people to the off switch; it must not make it stick');

// CONTROL. Take the release back out of shutdown and require the check to fail.
const stranded = content.replace(/    try \{\n      unquietAd\(\);\n    \} catch \{\n      \/\* nothing left to clean up with \*\/\n    \}\n/, '');
check('CONTROL: a shutdown without release DOES fail that check — so it can fail',
      stranded !== content && !/unquietAd\(\)/.test(bodyOf(stranded, 'shutdown')),
      'the 0.31.37 behaviour: cover and mute stranded on teardown');

check('content: the cover countdown is bounded by MAX_AD_SECONDS',
      /raw <= MAX_AD_SECONDS \? raw : null/.test(content),
      'a live stream made the first version read "8725s"');

// No path may unmute unconditionally. restoreSpeed() did, so a viewer who had
// muted the video themselves got sound blasted at them when speed was handed
// back.
const unconditionalUnmute = /\.muted = false/g;
const guarded = /priorMuted === false && v\.muted\) v\.muted = false/;
check('content: nothing unmutes unconditionally',
      (contentCode.match(unconditionalUnmute) || []).length === 1 &&
      guarded.test(contentCode),
      'the single permitted site is the guarded one inside restoreMute()');

// CONTROL. Add an unguarded unmute back and require the check to trip.
const blaring = contentCode.replace('      restoreMute();\n    }',
                                    '      video.muted = false;\n    }');
check('CONTROL: an unguarded unmute DOES trip that check — so it can fail',
      blaring !== contentCode &&
      (blaring.match(unconditionalUnmute) || []).length > 1,
      'the 0.31.38 behaviour in restoreSpeed()');

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

/* ---- 2d. the popup preview must not drift from the popup ---------------- */

// test/popup-preview.html renders the popup without the extension. It had gone
// stale: it still declared version "0.7.0" and stubbed none of the fields added
// since, so the preview showed a report no user has ever seen — and could not
// have caught a regression in the lines it omitted.
const preview = read('test/popup-preview.html');
const reportBlock = (/lastReport = \[[\s\S]*?\.join\("\\n"\)/.exec(popup) || [''])[0];
const readsFields = [...new Set(
  (reportBlock.match(/\b(?:d|s|lt)\.[a-zA-Z]+/g) || []).map(m => m.split('.')[1]),
)].filter(f => f !== 'join');
const missingFromPreview = readsFields.filter(f => !preview.includes(f));
// The preview is GENERATED from popup.html. If what is on disk is not what
// the generator produces, someone edited the copy or popup.html moved on —
// either way the preview no longer shows the product.
const { buildPreview } = await import('./build-preview.mjs');
const generated = buildPreview();
check('preview: is exactly what build-preview.mjs generates from popup.html',
      preview === generated,
      preview === generated ? 'no drift' : 'DRIFT — run: node test/build-preview.mjs');
// CONTROL. A one-word change in the preview must trip it.
check('CONTROL: an edited preview DOES trip that check — so it can fail',
      preview.replace('Ads silenced', 'Ads skipped') !== generated &&
      preview.includes('Ads silenced'),
      'the hand-maintained copy that drifted for hours');

check('preview: stubs every field the report reads',
      readsFields.length > 0 && missingFromPreview.length === 0,
      missingFromPreview.length
        ? `missing: ${missingFromPreview.join(', ')}`
        : `${readsFields.length} fields, all stubbed`);
const series = manifest.version.split('.').slice(0, 2).join('.');
const previewVersion = (/version: "([\d.]+)"/.exec(preview) || [, ''])[1];
check('preview: is from this version series, not a museum piece',
      previewVersion.startsWith(series + '.'),
      `preview declares ${previewVersion || '(none)'}, product is ${manifest.version}`);

// CONTROL. Drop a field from the preview and require the check to trip.
const previewDrifted = preview.replace('videoAdsPlayedThrough', 'xxxDrifted');
check('CONTROL: a field missing from the preview DOES trip that check — so it can fail',
      previewDrifted !== preview && readsFields.filter(f => !previewDrifted.includes(f)).length > 0,
      'fixture drift is now a build failure, not something someone has to notice');

/* ---- 2e. the popup must describe what the build actually does ----------- */

// Every one of these described behaviour that was switched off today. A popup
// that promises skipping while the code is built not to skip is the same
// defect as a check that reads its own documentation.
const popupHtml = read('popup.html');
const STALE_CLAIMS = [
  'Ads skipped as they appear',
  'Clicks Skip, fast-forwards unskippable ones',
];
const stale = STALE_CLAIMS.filter(c => popupHtml.includes(c) || popup.includes(c));
check('popup: no copy promising the skipping this build disables',
      stale.length === 0,
      stale.length ? `still claims: ${stale.join(' | ')}` : 'copy matches behaviour');
check('popup: the headline stat is one that actually moves',
      /sClean[\s\S]{0,60}adsPlayedThrough/.test(popup),
      '"Time saved" was the headline and is permanently 0 with skipping off');

// CONTROL. Put a stale claim back and require the check to trip.
const stalePopup = popupHtml.replace('Ads muted and hidden as they appear',
                                     'Ads skipped as they appear');
check('CONTROL: stale copy DOES trip that check — so it can fail',
      stalePopup !== popupHtml && STALE_CLAIMS.some(c => stalePopup.includes(c)),
      'the 0.31.39 copy, which described a feature that had been disabled');

/* ---- 2f. what we TELL people must match what the build does ------------- */

// The popup, the store description and the README all promised skipping after
// it had been switched off. The store description is the worst of the three:
// it is the sentence someone reads before installing.
const readme = read('README.md');
const PROMISES_SKIPPING = /skips video ads|Skip is clicked|fast-forwards unskippable/i;
check('manifest: the store description does not promise skipping',
      !PROMISES_SKIPPING.test(manifest.description),
      `description: "${manifest.description}"`);
check('manifest: the description fits the store limit',
      manifest.description.length <= 132,
      `${manifest.description.length} chars, limit 132`);
check('readme: does not promise skipping either',
      !PROMISES_SKIPPING.test(readme),
      'the README is the second thing people read');

// CONTROL. Put the old sentence back and require the checks to trip.
check('CONTROL: the old description DOES trip that check — so it can fail',
      PROMISES_SKIPPING.test(
        'Removes YouTube ads: skips video ads, and hides feed, sidebar, search and Shorts ad panels.',
      ),
      'the wording shipped until 0.31.41');

/* ---- 2g. the wall detector is not English-only --------------------------- */

// The report's "anti-adblock wall on screen" line was a regex on English
// innerText — a diagnostic that lies for any other UI language, in exactly the
// case it exists for. A structural branch is OR-ed alongside it.
check('content: the wall detector has a structural branch, not only English text',
      /walled:\s*\n?\s*\/Ad blockers violate\/i\.test\([\s\S]{0,80}\|\|\s*!!document\.querySelector\("ytd-enforcement-message-view-model"\)/.test(contentCode),
      'English innerText alone reads "no" during a wall in any other language');
// CONTROL. Drop the structural branch and require the check to trip.
const textOnly = contentCode.replace(/\s*\|\|\s*!!document\.querySelector\("ytd-enforcement-message-view-model"\)/, '');
check('CONTROL: an English-only detector DOES trip that check — so it can fail',
      textOnly !== contentCode && !/ytd-enforcement-message-view-model/.test(textOnly),
      'the 0.31.51 detector');

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
      drifted !== content && driftLit[1] !== manifest.version,
      `sabotaged copy reports ${driftLit[1]}`);

check('popup: the report states which arm it is', /ARM:/.test(popup),
      'a bypassed run and a live one read identically without this');
check('popup: a hidden-tab reading is marked VOID, not merely odd',
      /VOID/.test(popup) && /tabHidden/.test(popup),
      'CLAUDE.md records two false "cannot reproduce" verdicts from hidden tabs');
check('content: the diagnostics payload carries both arm signals',
      /bypassed:/.test(content) && /tabHidden:/.test(content),
      'the popup cannot state an arm the content script never sends');

// CONTROL. Strip the ARM line and require the check to fail.
const noArm = popup.replace(/ARM:/g, 'xxx');
check('CONTROL: removing the ARM line DOES fail that check — so it can fail',
      noArm !== popup && !/ARM:/.test(noArm), 'sabotaged copy has no arm marker');

let bad = 0;
console.log('');
for (const r of out) { if (!r.pass) bad++; console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`); }
console.log(`\n  ${out.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
