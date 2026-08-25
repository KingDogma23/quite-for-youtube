/**
 * Quiet for YouTube — page-world ad neutralisation.
 *
 * This follows the approach every maintained blocker actually uses, read out
 * of uBlock Origin's live YouTube rules and confirmed in the two highest-rated
 * Chrome Web Store blockers, both of which ship those same rules:
 *
 *   set-constant  ytInitialPlayerResponse.adPlacements  undefined
 *   set-constant  ytInitialPlayerResponse.adSlots       undefined
 *   set-constant  ytInitialPlayerResponse.playerAds     undefined
 *   set-constant  playerResponse.adPlacements           undefined
 *   set-constant  google_ad_status                      1
 *   json-prune    playerResponse.adPlacements … guarded on
 *                 playerResponse.streamingData.serverAbrStreamingUrl
 *
 * Three corrections to what this file used to do:
 *
 * 1. The COLD LOAD is handled. YouTube embeds the player response in the page,
 *    so there is no request to intercept — measured live, 9 ad placements and
 *    6 ad slots sitting in that embedded object. An earlier version concluded
 *    this was unreachable and gave up on it. It is reached by intercepting the
 *    assignment and neutralising the fields as they arrive.
 *
 * 2. Ad fields are set to undefined, not deleted, and network responses have
 *    the key RENAMED rather than cut out. Crude deletion is what got sessions
 *    flagged; the structure is left intact here.
 *
 * 3. Requests are no longer shaped. Declaring the load as a preview context is
 *    not what the maintained blockers do, and it is what made YouTube answer
 *    with muteOnStart — the cause of videos playing silently.
 *
 * Every path is wrapped: any failure leaves the data exactly as it arrived,
 * because a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  const AD_KEYS = ["adPlacements", "adSlots", "playerAds", "adBreakHeartbeatParams"];

  // A player response always carries one of these. Requiring one means this
  // can only ever act on a real player payload, never on something that merely
  // happens to contain a similar key.
  const isPlayerPayload = (o) =>
    !!o &&
    typeof o === "object" &&
    (!!o.playabilityStatus ||
      !!(o.streamingData && o.streamingData.serverAbrStreamingUrl));

  let neutralised = 0;

  function off() {
    try {
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
   * Make the ad fields of one player response read as undefined.
   *
   * The keys stay present as accessors rather than being deleted, and writes
   * to them are swallowed so a later assignment cannot put the schedule back.
   */
  function neutralise(payload) {
    if (off() || !isPlayerPayload(payload)) return false;
    let hit = false;
    for (const key of AD_KEYS) {
      if (!(key in payload)) continue;
      try {
        const had = payload[key];
        if (had === undefined) continue;
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
   * Watch a global for a player response being assigned to it. This is what
   * catches the cold load, where the response is embedded in the page's own
   * HTML and never fetched.
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

  guardGlobal("ytInitialPlayerResponse");
  guardGlobal("playerResponse");

  // Detection scripts read this to decide whether ads loaded. Reporting the
  // healthy value keeps that check quiet without touching any ad data.
  try {
    Object.defineProperty(window, "google_ad_status", {
      configurable: true,
      get: () => 1,
      set: () => {},
    });
  } catch {
    /* optional */
  }

  // ---- responses fetched later (in-page navigation) ------------------------
  // Renamed, not cut out, so the shape of the payload is unchanged.
  const PLAYER_URL = /\/youtubei\/v1\/(player|get_watch|reel_item_watch)/;
  const REEL_URL = /\/youtubei\/v1\/reel_watch_sequence/;

  function rewriteBody(text, url) {
    if (off() || typeof text !== "string" || text.length < 2) return null;

    if (REEL_URL.test(url)) {
      // Shorts carry their ad marker as a flag rather than a schedule.
      if (!text.includes('"isAd":true')) return null;
      neutralised++;
      publish();
      return text.split('"isAd":true').join('"isAd":false');
    }

    // Guard: only a real player payload, matching how the maintained rules
    // qualify this before touching anything.
    if (!text.includes("serverAbrStreamingUrl") && !text.includes('"playabilityStatus"')) {
      return null;
    }
    let out = text;
    let hit = false;
    for (const key of AD_KEYS) {
      const needle = `"${key}"`;
      if (!out.includes(needle)) continue;
      out = out.split(needle).join(`"no_ads_${key}"`);
      hit = true;
    }
    if (!hit) return null;
    neutralised++;
    publish();
    return out;
  }

  const urlOf = (input) =>
    typeof input === "string" ? input : (input && (input.url || String(input))) || "";

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (...args) {
      const res = nativeFetch.apply(this, args);
      const url = urlOf(args[0]);
      if (!PLAYER_URL.test(url) && !REEL_URL.test(url)) return res;
      return res.then((response) => {
        try {
          return response
            .clone()
            .text()
            .then((text) => {
              const cleaned = rewriteBody(text, url);
              if (cleaned === null) return response;
              return new Response(cleaned, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            })
            .catch(() => response);
        } catch {
          return response;
        }
      });
    };
  }

  const OpenOrig = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = String(url || "");
    this.__ytacUrl = PLAYER_URL.test(u) || REEL_URL.test(u) ? u : null;
    return OpenOrig.call(this, method, url, ...rest);
  };

  const SendOrig = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytacUrl) {
      this.addEventListener("readystatechange", function () {
        if (this.readyState !== 4) return;
        try {
          const raw =
            this.responseType === "" || this.responseType === "text" ? this.responseText : null;
          const cleaned = rewriteBody(raw, this.__ytacUrl);
          if (cleaned === null) return;
          Object.defineProperty(this, "responseText", { value: cleaned, configurable: true });
          Object.defineProperty(this, "response", { value: cleaned, configurable: true });
        } catch {
          /* leave the response exactly as it came */
        }
      });
    }
    return SendOrig.apply(this, args);
  };

  // ---- recovery from a session that is already flagged --------------------
  //
  // Kept as a safety net. Nothing above should provoke the anti-adblock wall,
  // but a session flagged earlier stays flagged for a while, and the block
  // arrives embedded in the page before any of this can act. Forcing a real
  // player request through loadVideoById gets a clean response, and the wall
  // left on screen at that point is stale markup from the failed load.
  //
  // Verified live: status ERROR with the wall showing, then after this
  // sequence status OK, no ad schedule, wall gone, video playing.

  const WALL_WORDS = /ad ?block|allow ?list|allowlist|ads (allow|help)|violate/i;
  const recovered = new Set();
  const unmuted = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let mutedBeforeRecovery = null;

  const videoIdNow = () => {
    try {
      return new URLSearchParams(location.search).get("v");
    } catch {
      return null;
    }
  };

  function wallShowing() {
    try {
      const player = document.getElementById("movie_player");
      const response = player && player.getPlayerResponse && player.getPlayerResponse();
      const ps = response && response.playabilityStatus;
      if (ps && ps.status && ps.status !== "OK" && WALL_WORDS.test(JSON.stringify(ps))) {
        return true;
      }
      const flexy = document.querySelector("ytd-watch-flexy");
      if (flexy && flexy.hasAttribute("player-unavailable")) {
        return WALL_WORDS.test(document.body.innerText || "");
      }
    } catch {
      /* never let detection throw */
    }
    return false;
  }

  function clearWallUi() {
    try {
      const flexy = document.querySelector("ytd-watch-flexy");
      if (flexy) flexy.removeAttribute("player-unavailable");
      document
        .querySelectorAll("yt-playability-error-supported-renderers, #error-screen, .ytp-error")
        .forEach((el) => el.style.setProperty("display", "none", "important"));
    } catch {
      /* cosmetic */
    }
  }

  /**
   * Restore sound the extension's own behaviour took away.
   *
   * Only when the mute was not the viewer's choice: YouTube asked for it via
   * muteOnStart, or sound was on immediately before a recovery reload and off
   * immediately after (the browser's autoplay policy can mute a programmatic
   * playVideo, and the two are indistinguishable afterwards). YouTube persists
   * whatever state a load ends in, so one silenced video would otherwise
   * silence every later one.
   */
  function undoForcedMute() {
    if (off()) return;
    const id = videoIdNow();
    if (!id || unmuted.has(id)) return;
    const player = document.getElementById("movie_player");
    if (!player || typeof player.isMuted !== "function") return;

    let response;
    try {
      response = player.getPlayerResponse && player.getPlayerResponse();
    } catch {
      return;
    }
    const audio = response && response.playerConfig && response.playerConfig.audioConfig;
    const youtubeAskedForIt = !!(audio && audio.muteOnStart === true);
    const weSilencedIt = mutedBeforeRecovery === false;
    if (!youtubeAskedForIt && !weSilencedIt) return;

    try {
      if (player.isMuted()) {
        player.unMute();
        if (typeof player.getVolume === "function" && player.getVolume() === 0) {
          player.setVolume(100);
        }
      }
      unmuted.add(id);
      document.documentElement.setAttribute("data-ytac-unmuted", "1");
    } catch {
      /* the viewer can always unmute by hand */
    }
  }

  async function recover() {
    if (off()) return;
    const id = videoIdNow();
    if (!id || recovered.has(id)) return; // one attempt per video, never a loop
    const player = document.getElementById("movie_player");
    if (!player || typeof player.loadVideoById !== "function") return;
    if (!wallShowing()) return;

    recovered.add(id);
    try {
      mutedBeforeRecovery = player.isMuted ? player.isMuted() : null;
    } catch {
      mutedBeforeRecovery = null;
    }
    try {
      player.loadVideoById(id);
    } catch {
      return;
    }

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      let response;
      try {
        response = player.getPlayerResponse && player.getPlayerResponse();
      } catch {
        return;
      }
      if (response && response.playabilityStatus && response.playabilityStatus.status === "OK") {
        clearWallUi();
        try {
          player.playVideo();
        } catch {
          /* the user can press play */
        }
        undoForcedMute();
        try {
          document.documentElement.setAttribute("data-ytac-recovered", "1");
        } catch {
          /* reporting only */
        }
        return;
      }
    }
  }

  function watchPage() {
    [1500, 3000, 5000, 8000].forEach((ms) => setTimeout(recover, ms));
    [800, 1600, 2600, 4000, 6000, 9000].forEach((ms) => setTimeout(undoForcedMute, ms));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchPage, { once: true });
  } else {
    watchPage();
  }
  window.addEventListener("yt-navigate-finish", watchPage);

  Object.defineProperty(window, "__ytacNeutralised", { get: () => neutralised });
  publish();
})();
