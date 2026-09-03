/**
 * Quite for YouTube — page-world ad neutralisation.
 *
 * Two layers, covering different paths. Only one can apply on any given load.
 *
 *   1. RESPONSE REWRITE — for player responses that arrive over fetch or XHR,
 *      which is every video opened from inside YouTube. The ad keys are
 *      RENAMED in the body before the page parses it, so they never exist.
 *      This removes the ad outright, adSlots included, with no stall.
 *
 *   2. GLOBAL NEUTRALISATION — for a cold page load, where YouTube embeds the
 *      player response in the HTML and there is no request to rewrite:
 *
 *        set-constant  ytInitialPlayerResponse.adPlacements  undefined
 *        set-constant  ytInitialPlayerResponse.playerAds     undefined
 *        set-constant  playerResponse.adPlacements           undefined
 *
 *      adSlots is NOT touched on this path. Removing it stalls the player
 *      dead, and neither the stall recovery (0.20.0) nor uBO's client-identity
 *      retry (0.20.1) rescues it — both were tried and measured. Those ads
 *      play and are skipped by content.js. See neutralise().
 *
 * THERE IS NO STALL RECOVERY, AND THAT IS THE FIX
 *
 * 0.19.0 added one: on a dead buffer at 0x0 it reloaded the player, later
 * under a rotated client identity. It was added because uBO appeared to have
 * one. Measured on 2026-08-27, on a two-hour stream replay carrying 54 ad
 * placements, tab visible throughout:
 *
 *   recovery enabled    4 loads, 3 played, 1 fired the recovery — and that
 *                       one showed YouTube's "This content isn't available"
 *                       screen with the player dead at readyState 0
 *   recovery disabled   4 loads, 4 played, no error screen
 *
 * In eight versions it was never once observed rescuing a load. The error
 * screen reported from 0.19.0 onward was this. Removed entirely, along with
 * the identity rotation and the request editing that existed only to serve
 * it — about 200 lines.
 *
 * google_ad_status is also set, and is close to pointless: YouTube sets it to
 * 1 itself, measured with ?ytacnostatus=1.
 *
 * TWO THINGS THIS FILE USED TO CLAIM ABOUT uBO, BOTH FALSE
 *
 * Read from uBlock Origin's live lists on 2026-08-27 (uAssets filters.txt and
 * quick-fixes.txt), rather than from memory:
 *
 *   1. It said uBO applies its `$replace=` filters in the NETWORK STACK, so
 *      doing the same in page script would be a needless stall. The network
 *      form is the `!#else` branch, taken only where the browser can filter
 *      response bodies — Firefox. On Chrome, the `!#if !cap_html_filtering`
 *      branch is taken and uBO does exactly what this file called too slow:
 *      trusted-replace-fetch-response and trusted-replace-xhr-response, in
 *      page script, renaming `"adSlots"` to `"no_ads"` in /player responses.
 *
 *   2. It said recovery — reloading the player after a stall — was additive
 *      complexity uBO does not have. uBO has it. quick-fixes.txt patches
 *      YouTube's own serverContract() with a watcher that reads
 *      getStatsForNerds() and, on buffer_health_seconds "0.00 s" with
 *      resolution "0x0", calls loadVideoById to retry the load under a
 *      rotated client userAgent. That stall signature is the one measured
 *      here: media never arrives and the player sits at readyState 0.
 *
 * So uBO does neutralise adSlots on www.youtube.com. Copying its layers did
 * NOT buy its behaviour: the recovery was measured causing an error screen and
 * never seen rescuing anything, and the identity retry did not help either.
 * Both are gone. What is left is the response rewrite (0.18.0) and the global
 * neutralisation, which are the two things with measurements behind them.
 *
 * uBO's live rules were also read in a profile where its Quick Fixes list —
 * the one carrying that recovery scriptlet — was not even enabled. Three
 * versions were built on a rule that was not running.
 *
 * Ad requests are not blocked at all: the declarative rules that did that were
 * removed in 0.17.0 because they stopped playback outright.
 *
 * WHAT WAS REMOVED, AND WHY
 *
 * Earlier versions added a hidden error screen, a stall notice, a remembered
 * "flagged" state and request shaping. Each produced a bug:
 *
 *   - the stall notice fired on a timer and appeared over videos that were
 *     merely slow to start
 *   - request shaping made YouTube answer with muteOnStart, silencing playback
 *   - neutralising adBreakHeartbeatParams stopped playback for six versions
 *
 * None of it rescued a flagged session either — measured with the bypass
 * switch: with this extension fully disabled the block persisted identically.
 * The block is YouTube's and is decided server-side.
 *
 * Every path is wrapped: any failure leaves the data exactly as it arrived,
 * because a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  // ?ytacnorewrite=1 disables the RESPONSE REWRITING only — the cold-load
  // neutralise and the fetch/XHR rename. It must not stand the whole file down;
  // ?ytacoff=1 and ?ytacnoinject=1 already do that. 0.31.4 wired it into off(),
  // which is the master bypass, so the A/B arm run on 2026-08-29 measured
  // "inject.js entirely off" while claiming to measure "rewrite off".
  // OFF BY DEFAULT since 0.31.23. Bisected on the live site 2026-09-02: with
  // only the response rewrite left on, the anti-adblock wall appears and the
  // video never gets a media source (readyState 0). With it off and the prune
  // scoped, the same video plays at readyState 4. It was also measured across
  // 200 loads to make no difference to whether an advert appeared, so it was
  // costing the wall and buying nothing. ?ytacrewrite=1 turns it back on.
  const NO_REWRITE = location.search.indexOf("ytacrewrite=1") === -1;

  // ?ytacsabr= — the SABR backoff. Read ONCE, like NO_REWRITE above; two reads
  // of one switch is how they came to disagree.
  //
  // WHY THIS EXISTS. YouTube's SABR streaming protocol carries a backoffTimeMs
  // field telling the player how long to wait before requesting video data.
  // That wait EXISTS TO COVER THE AD SLOT. With no blocker the advert fills it
  // and nobody notices. With a blocker the advert is gone and the wait remains,
  // so the viewer trades an advert for a spinner of the same length and
  // correctly reports that blocking did nothing.
  //
  // First mechanism that accounts for every symptom on file at once:
  //   - "two ads speeded up and spinning wheel"
  //   - 2026-08-27 bisect: extension live, 3 of 7 hops over 3s, worst 10.4s;
  //     bypassed, 12 of 12 hops at 173-432ms
  //   - 2026-08-30 A/B pilot: on ad-carrying loads the extension arm was SLOWER
  //     (13.56s) than the bypassed arm (11.30s). We removed the advert and cost
  //     the viewer more time than leaving it alone.
  //   - the stall recovery that shipped in eleven versions and was never once
  //     observed rescuing a load: aimed at this stall, with the wrong fix.
  //
  // Source: brave-yt-sabr-fix.js in brave/adblock-resources, itself crediting
  // https://iter.ca/post/yt-adblock/. Brave does NOT ship it: the filter line is
  // commented out in brave-specific.txt and the header tells users to paste it
  // in by hand.
  //
  //   ?ytacsabr=observe  scan and REPORT, change nothing. The positive control:
  //                      if ad-carrying loads show no backoff over 500ms then
  //                      this idea is wrong, and no behaviour was altered to
  //                      find that out.
  //   ?ytacsabr=1        rewrite backoffTimeMs
  //   ?ytacsabr=2        rewrite + force a fresh ad-free SABR session. Riskier:
  //                      cancelPlayback/loadVideoById can break playback.
  //
  // None of these is a default and none becomes one without a measurement.
  const SABR_MODE = (() => {
    const m = /[?&]ytacsabr=([a-z0-9]+)/i.exec(location.search);
    return m ? m[1].toLowerCase() : "";
  })();
  const SABR_ON = /^(observe|1|2)$/.test(SABR_MODE);
  const SABR_PATCH = SABR_MODE === "1" || SABR_MODE === "2";
  const SABR_FRESH = SABR_MODE === "2";

  // Published FIRST, before any switch can return early. This used to live in
  // publish(), which the bypass below skips — so the report of which switch was
  // in force disappeared exactly when a switch was in force, and that same A/B
  // arm could not be validated from the report at all. A switch that cannot
  // say it is on is the fault this project keeps paying for.
  try {
    const q = location.search;
    document.documentElement.setAttribute(
      "data-ytac-switches",
      [
        q.indexOf("ytacoff=1") !== -1 ? "off" : "",
        NO_REWRITE ? "norewrite" : "",
        location.search.indexOf("ytacobserve=1") !== -1 ? "observe" : "",
        q.indexOf("ytacnoinject=1") !== -1 ? "noinject" : "",
        q.indexOf("ytacprune=1") !== -1 ? "prune" : "",
        q.indexOf("ytacslots=") !== -1 ? "slots" : "",
        q.indexOf("ytacshorts=1") !== -1 ? "shorts" : "",
        SABR_ON ? "sabr:" + SABR_MODE : "",
      ]
        .filter(Boolean)
        .join(",") || "none",
    );
  } catch {
    /* reporting only */
  }

  // The keys uBO names. adSlots is listed here but skipped by default — see
  // neutralise(). Adding a FOURTH key broke playback for six versions; do not
  // extend this list without measuring playback afterwards.
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];

  // A player response always carries one of these, so this can only ever act
  // on a real player payload and never on something that merely looks similar.
  const isPlayerPayload = (o) =>
    !!o &&
    typeof o === "object" &&
    (!!o.playabilityStatus ||
      !!(o.streamingData && o.streamingData.serverAbrStreamingUrl));

  /**
   * Make a patched function report the native one when inspected.
   *
   * Measured 2026-09-02 on the reader's own browser, both extensions live:
   *
   *   window.fetch (ours)          Function.prototype.toString -> NOT native
   *   XHR.open     (ours)          NOT native
   *   JSON.parse   (Adblock)       native
   *   Response.json(Adblock)       native
   *
   * Any page can run
   *   Function.prototype.toString.call(window.fetch).includes('[native code]')
   * and know an extension is intercepting. This file patched fetch three times
   * and XHR twice and masked none of them, so it announced itself on every
   * load.
   *
   * Setting wrapper.toString alone is not enough: Function.prototype.toString
   * ignores an own toString property and reads the internal source. So the
   * mapping is kept in a WeakMap and Function.prototype.toString itself is
   * routed through it — then hidden the same way, or it becomes the tell.
   *
   * This reduces the fingerprint; it is not a guarantee. An === comparison
   * against a pristine Function.prototype.toString from a fresh iframe still
   * detects it. It closes the one-line check, not the determined one.
   */
  const NATIVE_OF = new WeakMap();

  // ?ytacdeepmask=1 — ALSO route Function.prototype.toString through the map,
  // which is the only way to defeat
  //   Function.prototype.toString.call(window.fetch)
  // rather than merely String(window.fetch).
  //
  // OFF by default, deliberately. Replacing Function.prototype.toString is a
  // global change to a primitive YouTube's own code uses, and in the first
  // regression run one video of four never started (it did not reproduce in a
  // second run: 0/4). One unexplained stall in eight loads against none in
  // eight control loads is not enough to ship a global prototype patch on, and
  // Adblock for Youtube — which works — does not do this. It masks the own
  // toString property only, which is what stays on below.
  //
  // Turn this on to measure it; do not make it the default without a reading
  // against YouTube's real detector.
  if (location.search.indexOf("ytacdeepmask=1") !== -1) {
    try {
      const nativeFPT = Function.prototype.toString;
      const wrapper = function () {
        const real = NATIVE_OF.get(this);
        return nativeFPT.call(real || this);
      };
      NATIVE_OF.set(wrapper, nativeFPT);
      Object.defineProperty(wrapper, "name", { value: "toString" });
      Function.prototype.toString = wrapper;
      document.documentElement.setAttribute("data-ytac-deepmask", "1");
    } catch {
      /* falls back to the own-property masking below */
    }
  }

  function hideNative(patched, native) {
    try {
      NATIVE_OF.set(patched, native);
      patched.toString = native.toString.bind(native);
      // name and length were never masked, and both are tells on their own:
      // measured 2026-09-03, our fetch wrapper read name "" and length 2
      // against the native "fetch" and 1. A wrapper written as
      // `function (input, init)` has length 2 whatever it wraps.
      Object.defineProperty(patched, "name", { value: native.name, configurable: true });
      Object.defineProperty(patched, "length", { value: native.length, configurable: true });
    } catch {
      /* masking is best-effort and must never cost the page */
    }
  }

  let neutralised = 0;

  function off() {
    try {
      // ?ytacoff=1 disables everything for one page load, so the same video can
      // be measured with this extension on and off. Diagnostic only.
      if (location.search.indexOf("ytacoff=1") !== -1) return true;
      // ytacnorewrite is deliberately NOT checked here: this function is the
      // master bypass, and gating it on a rewrite-only switch turned that arm
      // into a whole-file bypass. It is applied at the two rewrite sites.
      const root = document.documentElement;
      return (
        root.hasAttribute("data-ytac-all-off") || root.hasAttribute("data-ytac-strip-off")
      );
    } catch {
      return false;
    }
  }

  function publish() {
    try {
      document.documentElement.setAttribute("data-ytac-rewrites", String(neutralised));
    } catch {
      /* reporting must never break playback */
    }
  }

  /**
   * ?ytacprune=1 — remove adSlots from BOTH paths at once.
   *
   * Every stall measured so far removed adSlots from one path while the other
   * still carried it, and a working blocker removes it from both with no stall
   * at all. So this is the combination that has never been run, and it stays a
   * switch until it has been.
   *
   * Cold path: adSlots is deleted alongside the other ad keys.
   * Fetch path: the response is parsed and the properties are DELETED, then
   * re-serialised — rather than renaming the key in the text, which leaves the
   * value in place under another name.
   */
  const pruneMode = location.search.indexOf("ytacprune=1") !== -1;

  // Which shape adSlots is given. Diagnostic switch; see neutralise().
  const slotsMode =
    (location.search.match(/[?&]ytacslots=(keep|delete|undef|empty)/) || [])[1] || "keep";
  try {
    // Always stamped, not only when overridden: which mode ran is the first
    // thing any reading about a stall needs to say.
    document.documentElement.setAttribute("data-ytac-slots", slotsMode);
    // Stamped whether on or off: a reading that does not say which arm it came
    // from is the reading that gets attributed to the wrong one.
    document.documentElement.setAttribute("data-ytac-prune", pruneMode ? "1" : "0");
  } catch {
    /* reporting only */
  }

  /**
   * Record what was scheduled BEFORE it is neutralised.
   *
   * Without this, a failed load cannot be told apart from a load that simply
   * had no ad to remove — and that is exactly the distinction needed. On
   * 2026-08-26 six of twenty videos never started with the extension on; all
   * six were heavily monetised, and none reproduced later once repeat visits
   * had stopped YouTube serving a pre-roll. That is a hypothesis about ad
   * scheduling that no reading taken so far can confirm or kill, because the
   * neutralisation erases the evidence before anything else looks at it.
   */
  const LABELS = { adPlacements: "P", adSlots: "S", playerAds: "A" };
  const scheduled = [];

  function recordSchedule(payload) {
    for (const key of AD_KEYS) {
      const value = payload[key];
      const n = Array.isArray(value) ? value.length : value ? 1 : 0;
      if (n) scheduled.push(`${LABELS[key]}=${n}`);
    }
    try {
      document.documentElement.setAttribute(
        "data-ytac-adsched",
        scheduled.length ? scheduled.join(",") : "none",
      );
    } catch {
      /* reporting only */
    }
  }

  /** Make one response's ad fields read as undefined, without deleting them. */
  function neutralise(payload) {
    if (off() || NO_REWRITE || !isPlayerPayload(payload)) return false;
    recordSchedule(payload);
    let hit = false;
    for (const key of AD_KEYS) {
      if (!(key in payload)) continue;

      // adSlots is LEFT ALONE. Removing it was tried twice more and failed
      // twice more; this is now three measured attempts, not an assumption.
      //
      //   getter -> undefined   n=14 cold   0 fast, 6 slow, 8 never started
      //   delete the key        n=7  cold   0 fast, 3 slow, 4 never started
      //   untouched             n=4  cold   all fast (~1.5s), the ad plays
      //
      // 0.20.0 removed it anyway, betting that the stall recovery would carry
      // the failures. It did not: a cold load reached 10-15s and two reloads.
      // 0.20.1 then added uBO's client-identity retry — rotating
      // INNERTUBE_CONTEXT.client.userAgent and setting clientScreen CHANNEL on
      // the retried request — on the theory that an identical retry gets an
      // identical answer. Measured 2026-08-27, tab visible throughout:
      //
      //   5ZsnnvcPuNg   P=24,S=8   recovery fired, identity rotated,
      //                            request edited, and at 18s AND 36s the
      //                            player was still readyState 0 with only
      //                            loadstart in data-ytac-ttff. Dead.
      //
      // So neither recovery nor a rotated identity rescues this. Whatever uBO
      // does to survive removing adSlots, it is not only these two things.
      // Until that is understood, the ad plays on the cold path and is skipped
      // by content.js, which costs an ad and never costs the video.
      //
      // The in-session path is unaffected and still removes ads outright —
      // that is layer 1, and it is where most viewing happens.
      //
      //   (default)           leave adSlots alone
      //   ?ytacslots=undef    the getter; stalls, kept for re-testing
      //   ?ytacslots=delete   delete the key; stalls the same way
      //   ?ytacslots=empty    an empty array; removes the ad, stalls 9s
      if (key === "adSlots") {
        // Under ?ytacprune=1 it goes here too, so the cold payload and every
        // later response tell the player the same story.
        if (pruneMode) {
          try {
            delete payload[key];
            neutralised++;
          } catch {
            /* leave it rather than break the payload */
          }
          continue;
        }
        if (slotsMode === "keep") continue;
        // ?ytacslots=empty — an EMPTY ARRAY rather than nothing.
        //
        // Traced 2026-08-27: on a stalled load the player response arrives
        // 200 and the SABR media request comes back 503. The player is not
        // waiting for an ad; the media server is refusing the playback
        // request. That request's context is built from the player response,
        // so a missing adSlots may simply make it malformed. An empty array
        // is well-formed and still carries no ads.
        //
        // TESTED 2026-08-28, on a video that serves an ad every time
        // (CZPklgZ5Tqs), window foregrounded, both arms valid:
        //
        //   ?ytacslots=empty   first frame 10,053ms   no ad
        //   ?ytacslots=keep     first frame  1,345ms   ad played
        //
        // So the empty array DOES remove the ad and DOES stall, by nine
        // seconds — the same stall class as delete and undef. The malformed-
        // context theory is wrong: a well-formed empty array stalls just as
        // hard. All three ways of touching adSlots cost the load.
        //
        // A working blocker (Adblock for Youtube 7.2.5, read from disk the same
        // afternoon) blocks the same ad on the same video in 266ms with no
        // stall — and it DOES remove adSlots. So "touching adSlots costs the
        // load" is true of these three implementations, not of the technique.
        //
        // What it does that we do not:
        //   - prunes the PROPERTY from fetch and XHR responses, rather than
        //     renaming the key in the response text
        //   - removes adPlacements, playerAds AND adSlots on those responses
        //   - sets ytInitialPlayerResponse.adSlots undefined on the cold path
        //     as well, so both paths agree
        //   - prunes conditionally on playerResponse.streamingData
        //     .serverAbrStreamingUrl being present, i.e. only SABR responses
        //
        // The inconsistency theory — that the stall came from removing adSlots
        // on one path while the other still carried it — was TESTED on
        // 2026-08-28 via ?ytacprune=1, which deletes the properties from the
        // cold payload and from every fetch response. Both arms valid, window
        // foregrounded, same session:
        //
        //   ?ytacprune=1   first frame 10,235ms   no ad
        //   control         first frame  1,227ms   ad played
        //
        // Refuted. Consistency makes no difference; that is four ways of
        // removing adSlots — getter, delete, empty array, prune-both-paths —
        // each costing about nine seconds and each removing the ad.
        //
        // FIFTH attempt, 2026-09-02: SABR-GATED. Adblock for Youtube prunes
        // adPlacements+adSlots only when playerResponse.streamingData
        // .serverAbrStreamingUrl exists, and touches nothing otherwise. Every
        // previous attempt here was UNGATED, so "the gate is the difference"
        // was a live hypothesis. Implemented it — prune all three keys on SABR
        // responses, leave non-SABR responses completely alone — and measured
        // 4 videos per arm, first frame from the page's own media events:
        //
        //   no extension     1,755ms median
        //   SABR-gated      17,141ms median   <- three of four took 10-18s
        //   ungated          1,396ms median
        //
        // Refuted, and worse than doing nothing. That is five ways of touching
        // adSlots — getter, delete, empty array, prune-both-paths, SABR-gated —
        // every one of them costing the load. Do not try a sixth without a new
        // mechanism to point at; the gate is not it.
        //
        // Since a shipped blocker removes adSlots with no stall at all, the
        // difference is not in how the JSON is edited. What it has and we do
        // not is network-level blocking: declarativeNetRequest, webRequest and
        // <all_urls>. The player presumably never waits on ad media it was
        // never allowed to request. Note 0.17.0 removed hand-written DNR rules
        // from this extension for stalling the player — so the lesson is that
        // OUR rules were wrong, not that the approach is.
        if (slotsMode === "empty") {
          try {
            Object.defineProperty(payload, key, {
              configurable: true,
              enumerable: true,
              get: () => [],
              set: () => {},
            });
            hit = true;
          } catch {
            /* a locked property is left alone */
          }
          continue;
        }
        if (slotsMode === "delete") {
          try {
            delete payload[key];
            hit = true;
          } catch {
            /* a locked property is left alone */
          }
          continue;
        }
        // slotsMode === "undef" falls through to the getter below.
      }

      try {
        if (payload[key] === undefined) continue;
        Object.defineProperty(payload, key, {
          configurable: true,
          enumerable: true,
          get: () => undefined,
          set: () => {},
        });
        hit = true;
      } catch {
        /* a locked property is left alone */
      }
    }
    if (hit) {
      neutralised++;
      publish();
    }
    return hit;
  }

  /**
   * Catch the cold load: YouTube embeds the player response in the page HTML,
   * so there is no request to intercept for the first video.
   */
  function guardGlobal(name) {
    let held;
    try {
      held = window[name];
      if (held) neutralise(held);
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => held,
        set: (value) => {
          try {
            neutralise(value);
          } catch {
            /* never block the assignment */
          }
          held = value;
        },
      });
    } catch {
      /* if it cannot be redefined, the response paths below still apply */
    }
  }

  // A REAL bypass: nothing below is installed at all.
  //
  // The previous version consulted off() only inside neutralise(), so with
  // ?ytacoff=1 the property accessors and google_ad_status were still replaced
  // — the page was structurally modified while the switch claimed to be off.
  // Every "both arms behave the same, so it is not us" conclusion drawn from
  // that switch was comparing this extension against itself.
  if (off()) {
    try {
      document.documentElement.setAttribute("data-ytac-bypassed", "1");
    } catch {
      /* reporting only */
    }
    return;
  }


  // ?ytacnoinject=1 — everything else stays on, only this file stands down.
  //
  // Measured on 2026-08-26: across 20 videos, one load each, six never got
  // past `loadstart` with the extension on, and all twenty played with it
  // bypassed. `?ytacoff=1` proves the extension is responsible but not WHICH
  // part, and the whole-extension switch is the only one that existed. This
  // splits the page-world script off from the stylesheet and the player loop
  // so the failing third can be named rather than guessed at.
  if (location.search.indexOf("ytacnoinject=1") !== -1) {
    try {
      document.documentElement.setAttribute("data-ytac-noinject", "1");
    } catch {
      /* reporting only */
    }
    return;
  }

  /**
   * PARSE-TIME PRUNING — ?ytacjsonprune=1
   *
   * The one structural difference left between this file and Adblock for
   * Youtube 7.2.5, which works on the same account where this extension is
   * walled. Read from its source on 2026-09-02:
   *
   *   nativeJSONParse = JSON.parse
   *   JSON.parse = (...a) => jsonPruner(nativeJSONParse.apply(JSON, a))
   *   Response.prototype.json = function () {
   *     return nativeJson.apply(this).then(jsonPruner)
   *   }
   *
   * It DELETES adPlacements, playerAds and adSlots from the object as it is
   * parsed, so the player never observes them in any state. This file instead
   * patches fetch and XHR and edits objects that already exist — and every one
   * of its five attempts at adSlots (getter, delete, empty array,
   * prune-both-paths, SABR-gated) stalled the player for ~9-17s. Adblock
   * removes the same key with no stall at all, which says the difference is
   * WHEN the key disappears, not whether it does.
   *
   * Installed AFTER the master bypass, not before. Placed before it in
   * 0.31.20 and it ran under ?ytacoff=1 — the page was modified while the
   * switch claimed to be off, which is the exact bug this file already fixed
   * once and documented above the bypass guard. Any arm measured with that
   * build is comparing this extension against itself.
   *
   * ON by default since 0.31.20. Measured 2026-09-02, four videos per arm,
   * first frame from the page's own media events:
   *
   *   control (no extension)   1,683ms   ads 3/4
   *   shipped (fetch/XHR)      1,459ms   ads 3/4
   *   parse-time prune         1,275ms   ads 3/4   24 keys removed per load
   *
   * No stall — the fastest arm of the three — while deleting adSlots, which
   * five earlier attempts could not do without costing ~9-17s. The stall was
   * never about touching adSlots; it was about touching it after the object
   * existed.
   *
   * It did not reduce adverts IN THIS RIG, but the rig's own control also saw
   * 3/4, signed out on fresh profiles. Adblock for Youtube blocks 5/5 on the
   * reader's real signed-in profile, so the rig is not reproducing whatever
   * path the adverts take there.
   *
   * OFF BY DEFAULT since 0.31.24. ?ytacjsonprune=1 turns it on.
   *
   * Measured on the live site 2026-09-02, and this is the finding that ends
   * the argument the whole 0.20-0.31 series was built on:
   *
   *   with this extension bypassed and Adblock for Youtube 7.2.5 the only
   *   blocker acting, the player response still carried adPlacements (11
   *   entries), playerAds, adSlots and adBreakHeartbeatParams, and an advert
   *   was PLAYING (ad-showing, currentTime advancing, no wall).
   *
   * Adblock does not prune. It is never walled because it does not remove the
   * advert. There was no working competitor to copy — copying it means letting
   * the advert play, which is what this default now does.
   *
   * Our own bisect the same day, arm by arm on one video:
   *
   *   prune on, unscoped   wall, readyState 0, no media source
   *   prune on, scoped     wall, readyState 0
   *   response rewrite on  wall, readyState 0
   *   neither              NO wall, readyState 4, plays
   *
   * The clean arm came back clean BETWEEN two walled arms, so this is the
   * extension load-by-load, not the account and not a sticky flag.
   */
  if (location.search.indexOf("ytacjsonprune=1") !== -1) {
    try {
      // Adblock for Youtube 7.2.5's own list, read from its source:
      //   json-prune  playerResponse.adPlacements playerResponse.playerAds
      //               playerResponse.adSlots adPlacements playerAds adSlots
      //   json-prune  entries.[-].command.reelWatchEndpoint.adClientParams.isAd
      // The walk below reaches nested playerResponse objects on its own, so the
      // prefixed and bare forms are the same three names here.
      const PRUNE = ["adPlacements", "playerAds", "adSlots"];
      // Shorts. Their second scriptlet prunes the isAd flag inside a reel
      // watch endpoint; nothing in this file has ever touched that path, so
      // Shorts adverts were never addressed at all.
      const pruneReelAd = (node) => {
        try {
          const c = node && node.command && node.command.reelWatchEndpoint;
          if (c && c.adClientParams && "isAd" in c.adClientParams) {
            delete c.adClientParams.isAd;
            return true;
          }
        } catch { /* never let a prune break the page */ }
        return false;
      };
      let pruned = 0;
      // SCOPED, like Adblock's. Its json-prune is gated on
      //   playerResponse.streamingData.serverAbrStreamingUrl
      // and URL-scoped to player/watch/get_watch responses. 0.31.20 copied the
      // technique and dropped the scope: it pruned EVERY object passed through
      // JSON.parse, six levels deep, 40 keys a load. Bisected on the live site
      // 2026-09-02 — that unscoped prune triggers the anti-adblock wall on its
      // own, while google_ad_status does not. Only player payloads now.
      const isPlayerish = (o) =>
        !!o && typeof o === "object" &&
        (!!o.playabilityStatus ||
          !!(o.streamingData && o.streamingData.serverAbrStreamingUrl) ||
          !!(o.playerResponse &&
            (o.playerResponse.playabilityStatus ||
              (o.playerResponse.streamingData &&
                o.playerResponse.streamingData.serverAbrStreamingUrl))));

      const prune = (o) => {
        if (!o || typeof o !== "object") return o;
        if (!isPlayerish(o)) return o;
        const seen = new Set();
        const walk = (node, depth) => {
          if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
          seen.add(node);
          for (const k of PRUNE) {
            if (Object.prototype.hasOwnProperty.call(node, k)) {
              try { delete node[k]; pruned++; } catch { /* frozen */ }
            }
          }
          if (pruneReelAd(node)) pruned++;
          for (const v of Object.values(node)) {
            if (v && typeof v === "object") walk(v, depth + 1);
          }
        };
        walk(o, 0);
        try {
          document.documentElement.setAttribute("data-ytac-jsonpruned", String(pruned));
        } catch { /* reporting only */ }
        return o;
      };

      const nativeParse = JSON.parse;
      const parseWrapper = function (...a) { return prune(nativeParse.apply(JSON, a)); };
      hideNative(parseWrapper, nativeParse);
      JSON.parse = parseWrapper;

      if (typeof Response !== "undefined") {
        const nativeJson = Response.prototype.json;
        const jsonWrapper = function () {
          return nativeJson.apply(this).then(prune);
        };
        hideNative(jsonWrapper, nativeJson);
        Response.prototype.json = jsonWrapper;
      }
      document.documentElement.setAttribute("data-ytac-jsonprune", "1");
    } catch {
      /* the existing paths still apply */
    }
  }

  guardGlobal("ytInitialPlayerResponse");
  guardGlobal("playerResponse");

  // ---------------------------------------------------- player responses
  //
  // RENAME the ad keys in the response body, before the page parses it.
  //
  // This is uBO's second layer, and on Chrome it is page script exactly like
  // this — trusted-replace-fetch-response and trusted-replace-xhr-response,
  // '"adSlots"' to '"no_ads"', on /player. The network-level `replace=` form
  // of the same rule is the Firefox branch. An earlier version of this file
  // asserted the opposite and dropped the idea as too slow.
  //
  // Renaming beats both other shapes, measured 2026-08-27:
  //
  //   getter -> undefined   n=14 cold   0 fast, 6 slow, 8 never started
  //   delete the key        n=7  cold   0 fast, 3 slow, 4 never started
  //   RENAME, in-session    n=3         all played, no ad, buffer 15-24s
  //
  // In the rename runs the player's own getPlayerResponse() came back with
  // adSlots and adPlacements absent and no_ads present, so the edited body
  // reached the player rather than the behaviour merely looking right.
  //
  // Why this shape works where the others did not: a getter and a delete both
  // leave the player having already been told an ad was scheduled, and then
  // unable to fetch it. A rename means the key never exists as far as the
  // parser is concerned, so nothing can react to a slot that was never there.
  //
  // NOT measured, and not claimed: the cold load. YouTube embeds the player
  // response in the page HTML, so there is no request to rewrite and this
  // layer cannot apply. Cold loads still take the keep path in neutralise().
  //
  // Only /player and /get_watch bodies are read. Every other request is
  // returned untouched and unbuffered, which is the part the old blanket fetch
  // wrapper got wrong.
  const PLAYER_URL = /\/youtubei\/v1\/(player|get_watch)(\?|$)/;
  // Shorts. MEASURED INERT — read this before believing it does anything.
  //
  // Written on 2026-08-29 by copying uBO's rule for reelWatchSequenceResponse
  // ...adClientParams.isAd, on the premise that this file touched nothing on
  // Shorts. Run for the first time on 2026-08-30, and the premise was wrong
  // twice over:
  //
  //   1. /reel_watch_sequence is NEVER CALLED. Not on a direct Shorts load, and
  //      not on advancing to the next Short — advancing is a full navigation
  //      here. Across both, the only youtubei endpoints seen were player and
  //      log_event. This handler cannot fire in that configuration.
  //   2. A Shorts page calls /youtubei/v1/player, which PLAYER_URL already
  //      matches, so Shorts player responses were being rewritten all along.
  //      The "gap" this was written to close was largely not a gap.
  //
  // Kept, switch-gated, because a configuration that does call the endpoint may
  // exist (the Shorts shelf inside the home feed, or mobile) and the code is
  // harmless when it never runs. reelSeen counts responses that reached it, so
  // "never fired" is distinguishable from "fired and found nothing" — the
  // distinction this handler could not make on the day it was written.
  const REEL_URL = /\/reel_watch_sequence/;
  const SHORTS_ON = location.search.indexOf("ytacshorts=1") !== -1;
  const REEL_AD_RE = /"isAd"\s*:\s*true/g;
  // adSlots is NOT renamed. The cold-load path learned this in 0.17.5 —
  // taking that key away stalls the player — and the same lesson simply was
  // never applied to the fetch path, which is where clicking a video goes.
  //
  // Measured 2026-08-27, visible tab, six clicked hops per arm:
  //
  //   rewrite ON,  response carries adSlots   6 of 6 slow, ~5.3s, gaps ~4.2s
  //   rewrite OFF, response carries adSlots   fast, 528ms, gap 272ms
  //   neither arm, no adSlots in response     fast in both
  //
  // That is the delay reported from live use for days: a four-second wait on exactly
  // the videos where YouTube fills ad slots, on exactly the navigation path he
  // uses. adPlacements and playerAds are still renamed, and those are what
  // actually carry the ads that get removed.
  //
  // adSlots is not renamed here, and the reason is now measured rather than
  // argued. On 2026-08-30, across 16+ loads, data-ytac-adsched-fetch read "P,A"
  // every single time and never once "P,S,A": THE FETCH RESPONSE DOES NOT CARRY
  // adSlots. Adding it to this regex matches a key that is never in the body.
  // ?ytacfetchslots=1 existed to test exactly that, and is removed as a proven
  // no-op.
  //
  // The decisive load was fLexgOxsZu0:
  //
  //   cold payload   P=1,S=4,A=1   adSlots present — and AD_KEYS has always
  //                                neutralised all three
  //   fetch response P,A           adSlots absent, nothing here to rename
  //   advert         PLAYED
  //
  // So on a load where an advert appeared, every ad key this extension knows
  // about had already been neutralised, and the advert arrived anyway. Renaming
  // these fields does not prevent it — it reaches the player by another route,
  // not through the JSON we edit. uBO renames adSlots on get_watch and would
  // meet the same body we do.
  //
  // The response-rewrite hypothesis is closed. Anything further has to act on
  // the media stream, not the player response.
  const AD_KEY_RE = /"(adPlacements|playerAds)"/g;
  // Only under ?ytacprune=1, and note adSlots is in this list where it is
  // deliberately absent from AD_KEY_RE above.
  const PRUNE_KEYS = ["adPlacements", "playerAds", "adSlots"];
  // reel is SEPARATE from fetch on purpose. The Shorts handler first written on
  // 2026-08-29 incremented rewrites.fetch, so "fetch=3" would have meant three
  // player responses, or three Shorts sequences, or any mix — one number under
  // two labels, the identical fault this file's own 0.31.0 commit describes.
  let rewrites = { fetch: 0, xhr: 0, reel: 0, reelSeen: 0 };

  // Same flag as the cold-load path above, read once at the top of the file.
  // Two independent reads of the same switch is how they came to disagree.
  const noRewrite = NO_REWRITE;

  function publishRewrites() {
    try {
      document.documentElement.setAttribute(
        "data-ytac-rewrote",
        `fetch=${rewrites.fetch},xhr=${rewrites.xhr},reel=${rewrites.reel}/${rewrites.reelSeen}`,
      );
    } catch {
      /* reporting only */
    }
  }

  // Published once at zero, before anything can rewrite. Under ?ytacnorewrite=1
  // the interceptor is never installed, so this attribute was simply ABSENT and
  // a report could not tell "nothing was rewritten" from "nothing was measured".
  // That is the same fault as the switch reporting fixed above, one level down:
  // verified on the live site 2026-08-29, where the norewrite arm returned
  // rewrote=null while the cold-load counter correctly returned "0".
  publishRewrites();

  /** Returns the patched body, or null when there was nothing to rename. */
  function renameAdKeys(text) {
    if (typeof text !== "string" || text.indexOf('"ad') === -1) return null;
    AD_KEY_RE.lastIndex = 0;
    // Under prune, a body carrying only adSlots is worth processing — the
    // rename regex would have skipped it, which is how the two paths came to
    // disagree in the first place.
    if (!AD_KEY_RE.test(text) && !(pruneMode && text.indexOf('"adSlots"') !== -1)) return null;
    AD_KEY_RE.lastIndex = 0;

    // Record what this RESPONSE carried. data-ytac-adsched only ever saw the
    // embedded cold-load payload, so during a clicked session it read "none"
    // however many ad-laden responses went past — the schedule for every video
    // after the first was invisible.
    try {
      const seen = [];
      for (const [key, label] of Object.entries(LABELS)) {
        if (text.indexOf('"' + key + '"') !== -1) seen.push(label);
      }
      document.documentElement.setAttribute(
        "data-ytac-adsched-fetch",
        seen.length ? seen.join(",") : "none",
      );
    } catch {
      /* reporting only */
    }
    // ?ytacprune=1 — delete the properties outright, adSlots included, the way
    // the working blocker does. Renaming leaves the value in place under
    // another name; a parse/delete/stringify removes it, and removes it from
    // the same response the cold path has already been cleaned of.
    //
    // Falls back to renaming if the body is not JSON we can round-trip. A
    // response we cannot parse must be returned untouched rather than
    // half-processed.
    if (pruneMode) {
      try {
        const obj = JSON.parse(text);
        let hit = 0;
        const strip = (o) => {
          if (!o || typeof o !== "object") return;
          for (const key of PRUNE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(o, key)) {
              delete o[key];
              hit++;
            }
          }
          if (o.playerResponse) strip(o.playerResponse);
        };
        strip(obj);
        if (!hit) return null;
        return JSON.stringify(obj);
      } catch {
        /* not round-trippable; fall through to the rename below */
      }
    }

    // "no_ads" is what uBO renames these to. The name is arbitrary; what
    // matters is that it is inert and the same length class, so nothing that
    // walks the object finds an ad key.
    return text.replace(AD_KEY_RE, '"no_ads"');
  }

  /**
   * Record how the MEDIA requests fared, not just the player response.
   *
   * A hop measured on 2026-08-27 sat 11.5 seconds between loadstart and
   * loadedmetadata — the player asked for media and got nothing back. The one
   * time a stall was traced at the network layer, videoplayback answered 503.
   * That was a single observation and has never been repeated, because
   * catching it requires watching the network at the exact moment it happens.
   *
   * So the page keeps the tally itself: status codes for videoplayback, by
   * count. Bodies are never read and nothing is modified — this only observes.
   */
  const mediaStatus = Object.create(null);

  function noteMedia(status) {
    try {
      mediaStatus[status] = (mediaStatus[status] || 0) + 1;
      document.documentElement.setAttribute(
        "data-ytac-media",
        Object.keys(mediaStatus)
          .map((k) => `${k}x${mediaStatus[k]}`)
          .join(","),
      );
    } catch {
      /* reporting only */
    }
  }

  const sabr = { req: 0, small: 0, found: 0, patched: 0, fresh: 0, max: 0 };

  // Counts its own successes. A feature that cannot report having done
  // something useful does not get to stay. `max` is the decisive number: the
  // largest backoff actually observed. If ad-carrying loads never show one over
  // 500ms this whole idea is wrong, and the counter says so out loud.
  //
  // `found` is the over-firing guard. 0x20 also occurs as ordinary data, so if
  // `found` runs far above one per request the value band below is too loose
  // and this comes straight back out.
  function publishSabr() {
    try {
      document.documentElement.setAttribute(
        "data-ytac-sabr",
        `mode=${SABR_MODE || "off"},req=${sabr.req},small=${sabr.small},` +
          `found=${sabr.found},max=${sabr.max},patched=${sabr.patched},fresh=${sabr.fresh}`,
      );
    } catch {
      /* reporting only */
    }
  }

  // Read a stream, abandoning it once `cap` bytes accumulate. null means "media
  // chunk, not a control message" — those stream to the player untouched.
  function sabrReadAll(reader, cap) {
    const chunks = [];
    let total = 0;
    return reader.read().then(function pump(r) {
      if (r.done) {
        const out = new Uint8Array(total);
        for (let i = 0, off = 0; i < chunks.length; off += chunks[i].length, i++) {
          out.set(chunks[i], off);
        }
        return out;
      }
      chunks.push(r.value);
      total += r.value.length;
      if (total >= cap) {
        try {
          reader.cancel();
        } catch {
          /* already gone */
        }
        return null;
      }
      return reader.read().then(pump);
    });
  }

  /**
   * Find protobuf field 4, wire type 0 (varint) — backoffTimeMs. Tag byte is
   * (4 << 3 | 0) = 0x20.
   *
   * Rewrites IN PLACE at the SAME byte width, so the message length and every
   * offset after it stay valid. A naive single-byte write leaves an orphaned
   * continuation byte and corrupts every field that follows; the test for this
   * function passed 41 assertions against exactly that bug before being rewritten
   * to walk the whole message as protobuf. It now reports "bad wire type" and
   * "field 0 is invalid" on the mutant, which is what a real test looks like.
   */
  function sabrScan(bytes) {
    let hits = 0;
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] !== 0x20) continue;
      let val = 0;
      let shift = 0;
      let end = i + 1;
      while (end < bytes.length && shift < 35) {
        val |= (bytes[end] & 0x7f) << shift;
        if (!(bytes[end] & 0x80)) {
          end++;
          break;
        }
        shift += 7;
        end++;
      }
      if (val <= 500 || val >= 100000) continue;
      hits++;
      if (val > sabr.max) sabr.max = val;
      if (!SABR_PATCH) continue;
      // 50-150ms rather than 0: a clean zero is a fingerprint, ordinary backoff
      // noise is not. Same reasoning that made renaming keys safe where crude
      // deletion was not.
      let remaining = 50 + Math.floor(Math.random() * 100);
      let pos = i + 1;
      while (pos < end - 1) {
        bytes[pos++] = (remaining & 0x7f) | 0x80;
        remaining >>>= 7;
      }
      bytes[pos] = remaining & 0x7f;
      sabr.patched++;
    }
    return hits;
  }

  // ?ytacsabr=2 only. Guarded once per video id so a session that still backs
  // off falls back to patching instead of looping, and skipped once playback is
  // under way — a backoff mid-video is ordinary pacing, not an ad slot.
  let sabrReloaded = null;
  function sabrForceFresh() {
    try {
      const vid = new URL(location.href).searchParams.get("v");
      if (!vid || vid === sabrReloaded) return;
      const v = document.querySelector("video");
      if (v && v.currentTime > 1) return;
      const pl = document.getElementById("movie_player");
      if (!pl || !pl.cancelPlayback || !pl.loadVideoById) return;
      sabrReloaded = vid;
      const vd = pl.getVideoData && pl.getVideoData();
      if (vd) vd.isInlinePlaybackNoAd = true;
      pl.cancelPlayback();
      const realLoad = pl.loadVideoById.bind(pl);
      pl.loadVideoById = () => {};
      setTimeout(() => {
        pl.loadVideoById = realLoad;
        pl.loadVideoById(vid);
      }, 1000);
      sabr.fresh++;
      publishSabr();
    } catch {
      /* a failed reload must never take the player with it */
    }
  }

  if (SABR_ON) {
    try {
      const sabrNativeFetch = window.fetch;
      const __nf1 = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string"
            ? input
            : (input && (input.url || String(input))) || "";
        // SABR media only. Every other request passes through untouched.
        if (url.indexOf("googlevideo.com") === -1 || url.indexOf("sabr=1") === -1) {
          return sabrNativeFetch.apply(this, arguments);
        }
        sabr.req++;
        return sabrNativeFetch.apply(this, arguments).then((res) => {
          try {
            if (!res || !res.ok || !res.body) return res;
            let pass;
            let scan;
            let reinit;
            try {
              [pass, scan] = res.body.tee();
              reinit = {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              };
            } catch {
              // Locked or unteeable: hand the original back. A missing media
              // stream is a dead video, far worse than a spinner.
              return res;
            }

            if (!SABR_PATCH) {
              // OBSERVE. Return the untouched stream immediately and scan the
              // copy in parallel so nothing waits on us. That is what makes it
              // a control rather than a third variant with its own timing.
              sabrReadAll(scan.getReader(), 1000)
                .then((bytes) => {
                  if (bytes === null) return;
                  sabr.small++;
                  sabr.found += sabrScan(bytes);
                  publishSabr();
                })
                .catch(() => {
                  /* observation only */
                });
              return new Response(pass, reinit);
            }

            // PATCH. Must buffer the control message, rewrite, and re-emit.
            return sabrReadAll(scan.getReader(), 1000)
              .then((bytes) => {
                if (bytes === null) return new Response(pass, reinit);
                sabr.small++;
                const hits = sabrScan(bytes);
                if (hits) {
                  sabr.found += hits;
                  if (SABR_FRESH) sabrForceFresh();
                }
                publishSabr();
                const out = new Response(bytes, reinit);
                try {
                  Object.defineProperty(out, "url", { value: res.url, configurable: true });
                  Object.defineProperty(out, "type", { value: res.type, configurable: true });
                } catch {
                  /* cosmetic only */
                }
                return out;
              })
              .catch(() => res);
          } catch {
            return res;
          }
        });
      };
      hideNative(window.fetch, __nf1);
      publishSabr();
    } catch {
      /* a failed install must leave window.fetch alone */
    }
  }

  const MEDIA_URL = /\/videoplayback/;

  /**
   * With the rewrite disabled, OBSERVE the player responses anyway.
   *
   * ?ytacnorewrite=1 used to install nothing, so the control arm could not
   * report what a response carried — and the one thing that separates fast
   * hops from slow ones so far is whether adSlots was present. A control that
   * cannot see the suspected cause is not a control; it is a second
   * uncontrolled session. This reads the body of a CLONE and modifies nothing.
   */
  // OFF BY DEFAULT since 0.31.43, behind ?ytacobserve=1.
  //
  // With the rewrite off this was the ONLY wrapper still installed, and it is
  // fully fingerprintable: measured live, window.fetch read name "", length 2,
  // and Function.prototype.toString.call() non-native, against a pristine
  // "fetch" / 1 / native with the extension bypassed. It exists to feed the
  // hops trace — it removes no advert and hides nothing. Every wall trigger
  // found today was something YouTube could see; this is something YouTube
  // can see, for a measurement benefit only. Measurements go behind switches.
  //
  // Verified live on 0.31.43: default load, fetch reads "fetch" / 1 / native
  // and the switches line carries no "observe"; with ?ytacobserve=1 the wrapper
  // is present, name and length still match native, fetch.toString() reads
  // native, and data-ytac-media publishes. Function.prototype.toString.call()
  // still tells — the deep mask is off deliberately, see hideNative — which is
  // why the observer is an arm and not a default.
  const OBSERVE_ON = location.search.indexOf("ytacobserve=1") !== -1;
  if (noRewrite && OBSERVE_ON) {
    try {
      const nativeFetch = window.fetch;
      const __nf2 = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string"
            ? input
            : (input && (input.url || String(input))) || "";
        const pending = nativeFetch.apply(this, arguments);
        if (MEDIA_URL.test(url)) {
          pending.then(
            (res) => noteMedia(res.status),
            () => noteMedia("failed"),
          );
        }
        if (SHORTS_ON && REEL_URL.test(url)) {
          return pending.then((res) => {
            try {
              if (!res || res.status !== 200) return res;
              rewrites.reelSeen++;
              publishRewrites();
              return res
                .clone()
                .text()
                .then((body) => {
                  if (!REEL_AD_RE.test(body)) return res;
                  REEL_AD_RE.lastIndex = 0;
                  const out = body.replace(REEL_AD_RE, '"isAd":false');
                  rewrites.reel++;
                  publishRewrites();
                  // "isAd":true -> "isAd":false is one byte LONGER per hit, so
                  // the inherited content-length now understates the body. The
                  // player path ten lines below already deletes it for exactly
                  // this reason; the first version of this handler copied the
                  // headers wholesale and would have shipped a response whose
                  // declared length was short.
                  const headers = new Headers(res.headers);
                  headers.delete("content-length");
                  return new Response(out, {
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                  });
                })
                .catch(() => res);
            } catch {
              return res;
            }
          });
        }

        if (!PLAYER_URL.test(url)) return pending;
        pending
          .then((res) => (res && res.status === 200 ? res.clone().text() : null))
          .then((text) => {
            if (!text) return;
            const seen = [];
            for (const [key, label] of Object.entries(LABELS)) {
              if (text.indexOf('"' + key + '"') !== -1) seen.push(label);
            }
            document.documentElement.setAttribute(
              "data-ytac-adsched-fetch",
              seen.length ? seen.join(",") : "none",
            );
          })
          .catch(() => {});
        return pending;
      };
      hideNative(window.fetch, __nf2);
    } catch {
      /* observation is optional */
    }
  }

  if (!noRewrite) {
    try {
      const nativeFetch = window.fetch;
      const __nf3 = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string"
            ? input
            : (input && (input.url || String(input))) || "";
        const pending = nativeFetch.apply(this, arguments);

        if (MEDIA_URL.test(url)) {
          pending.then(
            (res) => noteMedia(res.status),
            () => noteMedia("failed"),
          );
        }

        if (!PLAYER_URL.test(url)) return pending;

        return pending.then((res) => {
          // Any failure here must hand back the untouched response: a missing
          // player response is a dead player, which is far worse than an ad.
          try {
            // A body can only be read ONCE. Reading the real response and then
            // returning it on failure hands YouTube a consumed stream, and the
            // caller throws "body stream already read" — an error this file
            // caused and then hid behind its own catch. Inspect a CLONE, so
            // the original is always intact to fall back to.
            if (!res || res.status === 0 || res.status === 204 || res.status === 304) {
              return res;
            }
            return res
              .clone()
              .text()
              .then((text) => {
                const patched = renameAdKeys(text);
                // Nothing to rename: give back the original, untouched and
                // unbuffered, rather than rebuilding an identical one.
                if (!patched) return res;
                rewrites.fetch++;
                publishRewrites();
                const headers = new Headers(res.headers);
                // The body length changed, so a stale value would be a lie.
                headers.delete("content-length");
                return new Response(patched, {
                  status: res.status,
                  statusText: res.statusText,
                  headers,
                });
              })
              .catch(() => res);
          } catch {
            return res;
          }
        });
      };
      hideNative(window.fetch, __nf3);
    } catch {
      /* the global neutralisation above still applies */
    }

    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;

      const __nx_open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__ytacUrl = String(url || "");
        } catch {
          /* ignore */
        }
        return nativeOpen.apply(this, arguments);
      };
      hideNative(XMLHttpRequest.prototype.open, __nx_open);

      const __nx_send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        try {
          // Media over XHR was not being counted at all, so a media failure on
          // that path looked like a clean session. A tally with a hole in it is
          // worse than no tally: it reads as evidence of absence.
          if (MEDIA_URL.test(this.__ytacUrl || "")) {
            this.addEventListener("loadend", function () {
              noteMedia(this.status || "failed");
            });
          }
          if (PLAYER_URL.test(this.__ytacUrl || "")) {
            this.addEventListener("readystatechange", function () {
              if (this.readyState !== 4) return;
              try {
                // responseText throws when responseType is set to anything
                // other than "" or "text"; those responses are left alone.
                const patched = renameAdKeys(this.responseText);
                if (!patched) return;
                Object.defineProperty(this, "responseText", { value: patched });
                Object.defineProperty(this, "response", { value: patched });
                rewrites.xhr++;
                publishRewrites();
              } catch {
                /* leave the response exactly as it arrived */
              }
            });
          }
        } catch {
          /* ignore */
        }
        return nativeSend.apply(this, arguments);
      };
      hideNative(XMLHttpRequest.prototype.send, __nx_send);
    } catch {
      /* fetch covers the modern path; XHR is a backstop */
    }

    publishRewrites();
  } else {
    try {
      document.documentElement.setAttribute("data-ytac-norewrite", "1");
    } catch {
      /* reporting only */
    }
  }

  // Detection scripts read this to decide whether ads loaded.
  //
  // Suspect: this claims ads loaded successfully while none ever play. If the
  // player waits on an ad it believes is in flight, that would look exactly
  // like readyState 0 with paused false — which is the symptom being chased.
  // ?ytacnostatus=1 leaves this alone, so it can be isolated from the rest in
  // a single page load rather than a build-and-reload cycle each time.
  if (location.search.indexOf("ytacnostatus=1") === -1) {
    try {
      Object.defineProperty(window, "google_ad_status", {
        configurable: true,
        get: () => 1,
        set: () => {},
      });
    } catch {
      /* optional */
    }
  } else {
    try {
      document.documentElement.setAttribute("data-ytac-nostatus", "1");
    } catch {
      /* reporting only */
    }
  }

  Object.defineProperty(window, "__ytacNeutralised", { get: () => neutralised });
  publish();
})();
