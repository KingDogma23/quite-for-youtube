/**
 * Quite for YouTube — page-world ad neutralisation.
 *
 * Three layers. The first two cover different paths, and only one of them can
 * apply on any given load; the third catches what the second cannot fix.
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
 *      adSlots is left ALONE on this path. Taking it away here — as a getter
 *      or by deleting the key, both measured — stops the player ever
 *      receiving media. Those ads play and are skipped by content.js instead.
 *      See neutralise() for the numbers.
 *
 *   3. STALL RECOVERY — the safety net under both, at the end of this file.
 *      When the player has nothing loaded AND reports a dead buffer at 0x0,
 *      it is reloaded once, which turns the embedded-response path into a
 *      fetch that layer 1 can clean.
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
 * So uBO does neutralise adSlots on www.youtube.com, and it evidently hits the
 * same wall, because it ships a dedicated recovery for it — plus a seek to
 * duration when getStatsForNerds() reports "SSAP, AD", which is YouTube
 * stitching the ad into the stream server-side. This file now has two of
 * uBO's three layers — the response rewrite (0.18.0) and the stall recovery
 * (0.19.0) — and not the SSAP seek. adSlots is still left alone on the
 * cold-load path: removing it and relying on recovery is the obvious next
 * move, and it is not the default until it has been measured that way.
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
  const AD_KEY_RE = /"(adPlacements|adSlots|playerAds)"/g;
  let rewrites = { fetch: 0, xhr: 0 };

  const noRewrite = location.search.indexOf("ytacnorewrite=1") !== -1;

  function publishRewrites() {
    try {
      document.documentElement.setAttribute(
        "data-ytac-rewrote",
        `fetch=${rewrites.fetch},xhr=${rewrites.xhr}`,
      );
    } catch {
      /* reporting only */
    }
  }

  /** Returns the patched body, or null when there was nothing to rename. */
  function renameAdKeys(text) {
    if (typeof text !== "string" || text.indexOf('"ad') === -1) return null;
    AD_KEY_RE.lastIndex = 0;
    if (!AD_KEY_RE.test(text)) return null;
    AD_KEY_RE.lastIndex = 0;
    // "no_ads" is what uBO renames these to. The name is arbitrary; what
    // matters is that it is inert and the same length class, so nothing that
    // walks the object finds an ad key.
    return text.replace(AD_KEY_RE, '"no_ads"');
  }

  if (!noRewrite) {
    try {
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string"
            ? input
            : (input && (input.url || String(input))) || "";
        const pending = nativeFetch.apply(this, arguments);
        if (!PLAYER_URL.test(url)) return pending;

        return pending.then((res) => {
          // Any failure here must hand back the untouched response: a missing
          // player response is a dead player, which is far worse than an ad.
          try {
            return res
              .text()
              .then((text) => {
                const patched = renameAdKeys(text);
                if (patched) {
                  rewrites.fetch++;
                  publishRewrites();
                }
                const headers = new Headers(res.headers);
                // The body length changed, so a stale value would be a lie.
                headers.delete("content-length");
                return new Response(patched || text, {
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
    } catch {
      /* the global neutralisation above still applies */
    }

    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__ytacUrl = String(url || "");
        } catch {
          /* ignore */
        }
        return nativeOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        try {
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

  // ------------------------------------------------------- stall recovery
  //
  // uBO's third layer, and the reason it can afford to remove adSlots outright
  // where this extension cannot. quick-fixes.txt watches getStatsForNerds()
  // and, on buffer_health_seconds "0.00 s" with resolution "0x0", calls
  // loadVideoById to retry the load.
  //
  // Why a retry helps rather than repeating the same failure: the stall only
  // happens on a COLD load, where the player response was embedded in the page
  // HTML and no request existed to rewrite. loadVideoById makes the player
  // FETCH a fresh player response — which the rewrite above does clean. So the
  // retry does not repeat the failing path, it moves onto the working one.
  //
  // Three guards, because reloading a video that is merely slow would be worse
  // than the bug:
  //
  //   - two independent signals must agree: the media element reports nothing
  //     loaded AND the player's own stats report a dead buffer at 0x0
  //   - the condition must hold for SETTLE_SAMPLES consecutive seconds, so a
  //     video that is starting normally is never touched
  //   - at most MAX_RECOVERIES attempts, and only in the first WINDOW_MS after
  //     load, after which a stall is someone else's problem
  const MAX_RECOVERIES = 2;
  const SETTLE_SAMPLES = 4; // seconds of agreement before acting
  const WINDOW_MS = 45000;

  let recoveries = 0;
  let stalledFor = 0;

  function publishRecovery(note) {
    try {
      document.documentElement.setAttribute(
        "data-ytac-recovered",
        `${recoveries}${note ? "," + note : ""}`,
      );
    } catch {
      /* reporting only */
    }
  }

  /** Both signals must agree, and neither is trusted on its own. */
  function isStalled(player, video) {
    if (!player || !video) return false;
    // Signal one: the media element has nothing and is not merely paused.
    if (video.readyState > 0 || video.currentTime > 0 || video.paused) return false;
    // Signal two: the player's own diagnostics.
    let stats = null;
    try {
      stats = player.getStatsForNerds ? player.getStatsForNerds() : null;
    } catch {
      return false;
    }
    if (!stats) return false;
    return (
      String(stats.buffer_health_seconds || "").indexOf("0.00") === 0 &&
      String(stats.resolution || "").indexOf("0x0") !== -1
    );
  }

  function recover(player) {
    try {
      const response = player.getPlayerResponse ? player.getPlayerResponse() : null;
      const videoId = response && response.videoDetails && response.videoDetails.videoId;
      if (!videoId || typeof player.loadVideoById !== "function") {
        publishRecovery("no-api");
        return;
      }
      const start =
        (response.playerConfig &&
          response.playerConfig.playbackStartConfig &&
          response.playerConfig.playbackStartConfig.startSeconds) ||
        0;
      recoveries++;
      publishRecovery("reloading");
      player.loadVideoById(videoId, start);
    } catch {
      publishRecovery("failed");
    }
  }

  if (location.search.indexOf("ytacnorecover=1") === -1) {
    const startWatch = () => {
      const began = performance.now();
      const timer = setInterval(() => {
        try {
          if (recoveries >= MAX_RECOVERIES || performance.now() - began > WINDOW_MS) {
            clearInterval(timer);
            return;
          }
          // Never reload a backgrounded tab.
          //
          // One of the two stall signals is the player reporting 0x0
          // resolution, and a hidden tab can report that for entirely innocent
          // reasons — nothing is being composited. Someone listening to a
          // video in another tab must not have it restarted underneath them.
          // The counter resets too, so a tab that was hidden for a while does
          // not act the instant it becomes visible.
          if (document.visibilityState === "hidden") {
            stalledFor = 0;
            return;
          }

          const player = document.getElementById("movie_player");
          const video = player && player.querySelector("video");
          if (!isStalled(player, video)) {
            stalledFor = 0;
            return;
          }
          stalledFor++;
          if (stalledFor >= SETTLE_SAMPLES) {
            stalledFor = 0;
            recover(player);
          }
        } catch {
          /* a broken watcher must never break playback */
        }
      }, 1000);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startWatch, { once: true });
    } else {
      startWatch();
    }
    publishRecovery();
  } else {
    try {
      document.documentElement.setAttribute("data-ytac-norecover", "1");
    } catch {
      /* reporting only */
    }
  }

  Object.defineProperty(window, "__ytacNeutralised", { get: () => neutralised });
  publish();
})();
