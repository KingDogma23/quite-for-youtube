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
    if (off() || !isPlayerPayload(payload)) return false;
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
  // That is the delay Martin reported for days: a four-second wait on exactly
  // the videos where YouTube fills ad slots, on exactly the navigation path he
  // uses. adPlacements and playerAds are still renamed, and those are what
  // actually carry the ads that get removed.
  const AD_KEY_RE = /"(adPlacements|playerAds)"/g;
  // Only under ?ytacprune=1, and note adSlots is in this list where it is
  // deliberately absent from AD_KEY_RE above.
  const PRUNE_KEYS = ["adPlacements", "playerAds", "adSlots"];
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
  if (noRewrite) {
    try {
      const nativeFetch = window.fetch;
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
    } catch {
      /* observation is optional */
    }
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
