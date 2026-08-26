/**
 * Quiet for YouTube — page-world ad neutralisation.
 *
 * Deliberately minimal. This does what uBlock Origin's live YouTube rules do,
 * and nothing else:
 *
 *   set-constant  ytInitialPlayerResponse.adPlacements  undefined
 *   set-constant  ytInitialPlayerResponse.adSlots       undefined
 *   set-constant  ytInitialPlayerResponse.playerAds     undefined
 *   set-constant  playerResponse.adPlacements           undefined
 *   set-constant  google_ad_status                      1
 *
 * The equivalent of uBO's `$replace=` filters is NOT done here in page script.
 * uBO applies those in the NETWORK STACK, before the page sees the bytes. Doing
 * it in JavaScript meant wrapping fetch and waiting for the whole player
 * response to download before handing the page a rebuilt Response — a full
 * stall inserted into every player request, and the reason this felt slower
 * than uBO. Ad requests are blocked declaratively instead, in rules.json, which
 * costs nothing and never touches a response body.
 *
 * WHAT WAS REMOVED, AND WHY
 *
 * Earlier versions added recovery (forcing a player reload when YouTube walled
 * the session), a hidden error screen, a stall notice, a remembered "flagged"
 * state and request shaping. Every one of those was additive complexity that
 * uBO does not have, and every one produced a bug:
 *
 *   - recovery called loadVideoById, restarting the whole player load
 *   - the fetch wrapper buffered every player response before releasing it
 *   - the stall notice fired on a timer and appeared over videos that were
 *     merely slow to start
 *   - request shaping made YouTube answer with muteOnStart, silencing playback
 *   - neutralising adBreakHeartbeatParams, a key uBO never touches, stopped
 *     playback entirely for six versions
 *
 * None of it ever rescued a flagged session either — measured with the bypass
 * switch: with this extension fully disabled the block persisted identically.
 * The block is YouTube's, it is decided server-side, and the honest position is
 * that nothing here changes it. So none of that machinery earns its place.
 *
 * Every path is wrapped: any failure leaves the data exactly as it arrived,
 * because a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  // Exactly the keys uBO neutralises. Adding a fourth broke playback for six
  // versions; do not extend this list without measuring playback afterwards.
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
    (location.search.match(/[?&]ytacslots=(keep|delete|undef)/) || [])[1] || "undef";
  try {
    if (slotsMode !== "undef") {
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

      // adSlots is under suspicion, so it gets a switch rather than a rewrite.
      //
      // Measured on 2026-08-26 across 23 cold loads of never-visited videos:
      // every load carrying adSlots either failed to start or took 5-10s, and
      // every load without it started in about 1.5s. Nothing else separated
      // them — not adPlacements, not playerAds, not monetisation as such.
      //
      // The mechanism this tests: defining a getter leaves the KEY in place
      // while making it read undefined, so a guard of the form
      // `if ("adSlots" in response)` still passes and the player then works
      // with undefined. uBO's json-prune deletes the key outright, and that
      // guard skips. Same intent, different observable shape.
      //
      //   ?ytacslots=keep     leave adSlots untouched
      //   ?ytacslots=delete   delete the key, as json-prune does
      //   (default)           the current getter
      if (key === "adSlots" && slotsMode !== "undef") {
        if (slotsMode === "keep") continue;
        try {
          delete payload[key];
          hit = true;
        } catch {
          /* a locked property is left alone */
        }
        continue;
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
