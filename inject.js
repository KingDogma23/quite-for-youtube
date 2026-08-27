/**
 * Quite for YouTube — page-world ad neutralisation.
 *
 * Deliberately minimal. This does what uBlock Origin's live YouTube rules do,
 * and nothing else:
 *
 *   set-constant  ytInitialPlayerResponse.adPlacements  undefined
 *   set-constant  ytInitialPlayerResponse.playerAds     undefined
 *   set-constant  playerResponse.adPlacements           undefined
 *   set-constant  google_ad_status                      1
 *
 * adSlots is deliberately NOT in that list here, though uBO does name it.
 * Neutralising it — as a getter or by deleting the key, both were measured —
 * stops the player ever receiving media on videos that carry slots. See
 * neutralise() for the numbers. google_ad_status is also close to pointless:
 * YouTube sets it to 1 itself, measured with ?ytacnostatus=1.
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
 * So uBO does neutralise adSlots on www.youtube.com, and it evidently hits the
 * same wall, because it ships a dedicated recovery for it — plus a seek to
 * duration when getStatsForNerds() reports "SSAP, AD", which is YouTube
 * stitching the ad into the stream server-side. Three layers where this file
 * has one. Leaving adSlots alone is the honest single-layer answer; matching
 * uBO would mean adding the response rewrite and the stall recovery, and
 * measuring both.
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

  let neutralised = 0;

  function off() {
    try {
      // ?ytacoff=1 disables everything for one page load, so the same video can
      // be measured with this extension on and off. Diagnostic only.
      if (location.search.indexOf("ytacoff=1") !== -1) return true;
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

  // Which shape adSlots is given. Diagnostic switch; see neutralise().
  const slotsMode =
    (location.search.match(/[?&]ytacslots=(keep|delete|undef)/) || [])[1] || "keep";
  try {
    if (slotsMode !== "keep") {
      document.documentElement.setAttribute("data-ytac-slots", slotsMode);
    }
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
    if (off() || !isPlayerPayload(payload)) return false;
    recordSchedule(payload);
    let hit = false;
    for (const key of AD_KEYS) {
      if (!(key in payload)) continue;

      // adSlots is LEFT ALONE, and that is the whole fix for the hang.
      //
      // Measured on 2026-08-26, cold loads of never-visited videos, first
      // frame taken from the page's own media events:
      //
      //   adSlots -> getter undefined   n=14   0 fast, 6 slow (5-10s), 8 never
      //   adSlots -> deleted            n=7    0 fast, 3 slow,          4 never
      //   adSlots -> untouched          n=4    all fast (~1.5s)
      //   no adSlots in the response    n=20+  all fast, ads gone
      //
      // The guess that got tested here was that the SHAPE of the edit was
      // wrong — that a getter leaves the key present so `"adSlots" in r`
      // still passes, where uBO's json-prune deletes it and that guard skips.
      // Deleting the key measured the same as the getter. The shape is not
      // what matters; removing the schedule at all is.
      //
      // What is left is a plain statement of fact: on videos where YouTube
      // fills ad SLOTS, taking the slots away stops the player getting media.
      // Those ads are handled the way this extension handles any ad that
      // actually plays — the skip loop in content.js. Everything else still
      // has its schedule neutralised, which is where the ads really do vanish.
      //
      //   (default)           leave adSlots untouched
      //   ?ytacslots=delete   delete the key, as json-prune does
      //   ?ytacslots=undef    the getter this shipped with, for re-testing
      if (key === "adSlots") {
        if (slotsMode === "keep") continue;
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

  guardGlobal("ytInitialPlayerResponse");
  guardGlobal("playerResponse");

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
