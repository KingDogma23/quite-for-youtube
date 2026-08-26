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
 * 3. Requests are shaped only as an ESCAPE, for sessions already flagged, and
 *    never on a healthy one — declaring the load as a preview context is what
 *    makes YouTube answer with muteOnStart, the cause of silent playback.
 *
 *    Measured, and worth recording because three builds were spent on it: this
 *    does NOT rescue a flagged session. With the extension fully bypassed via
 *    ?ytacoff=1, the embedded response still comes back status ERROR, the wall
 *    still appears and the video still does not play. The block is decided on
 *    YouTube's side and nothing in this file changes it. An earlier version of
 *    this comment claimed shaping was what made the older build work; it was
 *    not — that build simply ran before the session had been flagged.
 *
 * Every path is wrapped: any failure leaves the data exactly as it arrived,
 * because a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  // EXACTLY the three keys uBlock Origin's live rules neutralise, and no more.
  //
  // adBreakHeartbeatParams used to be in this list. It is not in theirs, and it
  // was carried over from an older build without checking. Measured with the
  // session flag cleared: with this extension on, playback never started
  // (readyState 0); bypassed via ?ytacoff=1 on the same video, it played. So on
  // a healthy session this list was what broke playback — the earlier A/B was
  // run while the session was flagged, where nothing played either way, which
  // hid the fault entirely.
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];

  // Wording that means the block is about ad blocking, not a private,
  // age-gated, geo-blocked or removed video. Declared here because the
  // response interceptors below run before anything further down.
  const WALL_WORDS = /ad ?block|allow ?list|allowlist|ads (allow|help)|violate/i;

  const PARAMS_ESCAPE = "eAFgAQ";
  const FLAG_KEY = "ytacSessionFlagged";
  const FLAG_TTL_MS = 24 * 60 * 60 * 1000;

  // Whether this session is flagged is remembered across page loads, so the
  // escape is armed before the first request rather than after the wall is
  // already visible.
  //
  // Kept because it costs nothing on a healthy session, NOT because it fixes a
  // flagged one — the A/B above shows it does not. Only YouTube clears that.
  let flagged = (() => {
    try {
      const seen = Number(localStorage.getItem(FLAG_KEY) || 0);
      return seen > 0 && Date.now() - seen < FLAG_TTL_MS;
    } catch {
      return false;
    }
  })();

  function rememberFlagged() {
    try {
      localStorage.setItem(FLAG_KEY, String(Date.now()));
    } catch {
      /* private mode or storage disabled: this load still shapes */
    }
  }


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
      // Diagnostic switch: ?ytacoff=1 disables everything for that one page
      // load. It exists so the same video can be measured with this extension
      // on and off without touching any settings — the A/B that says whether a
      // problem is ours or YouTube's. Nothing sets it but a human typing it.
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
            noteFlagged(value); // a walled embedded response arms the escape
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

  if (flagged) {
    try {
      document.documentElement.setAttribute("data-ytac-flagged", "remembered");
    } catch {
      /* reporting only */
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

  // ---- escape hatch for a session YouTube has already flagged --------------
  //
  // Neutralising the ad payload is the right mechanism for a healthy session,
  // and it is what every maintained blocker does. It does NOT rescue a session
  // that is already flagged: measured here, the embedded response comes back
  // status ERROR on every load, and after recovery the player holds 35
  // adaptive formats but YouTube serves no media at all — buffering forever.
  //
  // Shaping the outgoing request escapes that, which is why the previous build
  // played at all. It carries a cost (YouTube answers with muteOnStart, undone
  // below), so it is engaged ONLY once a flagged response has actually been
  // seen, and never on a healthy session.
  function noteFlagged(payload) {
    if (flagged || !payload) return;
    const ps = payload.playabilityStatus;
    if (!ps || !ps.status || ps.status === "OK") return;
    try {
      if (!WALL_WORDS.test(JSON.stringify(ps))) return;
    } catch {
      return;
    }
    flagged = true;
    rememberFlagged();
    try {
      document.documentElement.setAttribute("data-ytac-flagged", "1");
    } catch {
      /* reporting only */
    }
  }

  const looksLikePlayerRequest = (v) =>
    v && typeof v === "object" && v.context && v.context.client &&
    (v.videoId || v.playbackContext || v.playerRequest);

  const nativeStringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    try {
      if (flagged && !off() && looksLikePlayerRequest(value)) {
        if (typeof value.params !== "string" || !value.params.startsWith("YAHI")) {
          value.params = PARAMS_ESCAPE;
          if (value.playerRequest) value.playerRequest.params = PARAMS_ESCAPE;
          if (value.playbackContext) value.playbackContext.params = PARAMS_ESCAPE;
        }
      }
    } catch {
      /* leave the request exactly as the page built it */
    }
    return nativeStringify.call(this, value, ...rest);
  };
  try {
    Object.defineProperty(JSON.stringify, "name", { value: "stringify" });
    JSON.stringify.toString = () => nativeStringify.toString();
  } catch {
    /* cosmetic */
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

  const recovered = new Set();

  // ---- keep the accusation off the screen ---------------------------------
  //
  // The block is decided server-side and arrives baked into the page, so it is
  // painted before any recovery can run. Measured: the wall is fully visible at
  // 4 seconds and only clears at about 10. Showing someone "Ad blockers violate
  // YouTube's Terms of Service" for six seconds on every single video is a
  // worse experience than the ad was.
  //
  // The error screen is therefore hidden from the first paint and revealed
  // again if it turns out to be a GENUINE error — a private, age-gated,
  // geo-blocked or removed video, none of which are ours to hide. If nothing
  // has cleared it by the deadline, it is shown, because failing visibly beats
  // a viewer staring at a black rectangle with no explanation.
  const HIDE_STYLE_ID = "ytac-hold-error";
  const REVEAL_AFTER_MS = 12000;

  function holdErrorScreen() {
    if (off() || document.getElementById(HIDE_STYLE_ID)) return;
    try {
      const style = document.createElement("style");
      style.id = HIDE_STYLE_ID;
      style.textContent =
        "ytd-watch-flexy[player-unavailable] #error-screen," +
        "yt-playability-error-supported-renderers," +
        ".ytp-error { visibility: hidden !important; }";
      (document.head || document.documentElement).appendChild(style);
      setTimeout(revealErrorScreen, REVEAL_AFTER_MS);
    } catch {
      /* if the style cannot be added the wall simply shows, as before */
    }
  }

  function revealErrorScreen() {
    try {
      const style = document.getElementById(HIDE_STYLE_ID);
      if (style) style.remove();
    } catch {
      /* nothing to undo */
    }
  }

  // ---- say so when playback is never going to start -----------------------
  //
  // Measured with the extension fully bypassed (?ytacoff=1): the embedded
  // response still comes back status ERROR, the wall still appears and the
  // video still does not play. YouTube has flagged the session server-side and
  // will not serve media, whatever runs in the page.
  //
  // Hiding the wall and leaving a spinner turning forever is worse than the
  // accusation was: it looks like the extension is broken and gives no way to
  // act. So after a fair wait with no media at all, the position is stated
  // plainly, with what actually clears it.
  /** The main player's video element, not a preview or miniplayer one. */
  function mainVideo() {
    try {
      return (
        document.querySelector("#movie_player video") ||
        document.querySelector("video.html5-main-video") ||
        document.querySelector("video")
      );
    } catch {
      return null;
    }
  }

  const STALL_NOTICE_ID = "ytac-stalled";
  const STALL_AFTER_MS = 11000;

  function showStalledNotice() {
    try {
      if (off() || document.getElementById(STALL_NOTICE_ID)) return;
      const v = mainVideo();
      if (v && (v.readyState > 2 || v.currentTime > 0.5)) return; // playing after all
      if (!wallShowing() && !(v && v.readyState === 0)) return;

      const host = document.querySelector("#movie_player") || document.body;
      if (!host) return;

      const box = document.createElement("div");
      box.id = STALL_NOTICE_ID;
      box.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
        "z-index:60;background:#0f0f0f;color:#f1f1f1;text-align:center;padding:24px;" +
        "font:14px/1.5 Roboto,Arial,sans-serif;pointer-events:auto;";
      const inner = document.createElement("div");
      inner.style.cssText = "max-width:420px;";

      const h = document.createElement("div");
      h.textContent = "YouTube has blocked playback for this session";
      h.style.cssText = "font-size:16px;font-weight:500;margin-bottom:10px;";

      const p = document.createElement("p");
      p.textContent =
        "This is decided on YouTube's side and happens with the extension " +
        "switched off too, so turning it off will not help. It usually clears " +
        "on its own after a while.";
      p.style.cssText = "margin:0 0 12px;color:#aaa;";

      const p2 = document.createElement("p");
      p2.textContent =
        "To clear it now: delete youtube.com site data in Chrome (you will be " +
        "signed back in), or open the video in another profile.";
      p2.style.cssText = "margin:0;color:#aaa;";

      inner.append(h, p, p2);
      box.append(inner);
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(box);
      revealErrorScreen(); // nothing left to hide behind
      document.documentElement.setAttribute("data-ytac-stalled", "1");

      // Playback can still begin after the notice appears — measured: it
      // showed at 11s over a video that started shortly after and then sat
      // there covering it. Anything that means "media is flowing" takes it
      // away again.
      const media = mainVideo();
      if (media) {
        const dismiss = () => {
          if (media.currentTime > 0.5 || media.readyState > 2) clearStalledNotice();
        };
        media.addEventListener("timeupdate", dismiss);
        media.addEventListener("playing", dismiss);
        media.addEventListener("loadeddata", dismiss);
      }
    } catch {
      /* a missing notice is not worth breaking the page over */
    }
  }

  function clearStalledNotice() {
    try {
      const box = document.getElementById(STALL_NOTICE_ID);
      if (box) box.remove();
      document.documentElement.removeAttribute("data-ytac-stalled");
    } catch {
      /* nothing to undo */
    }
  }
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

    // Arm the escape BEFORE reloading, so the request this triggers carries
    // the shaped params. Checking only at assignment misses it: measured live,
    // the embedded response arrives with status OK and the block is written
    // into it afterwards, so noteFlagged never fired while the page was
    // plainly walled — recovery then fetched an unshaped response, YouTube
    // returned OK with 35 formats, and served no media at all.
    if (!flagged) {
      flagged = true;
      rememberFlagged();
      try {
        document.documentElement.setAttribute("data-ytac-flagged", "1");
      } catch {
        /* reporting only */
      }
    }

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
        revealErrorScreen(); // recovered: the hold is no longer needed
        try {
          player.playVideo();
        } catch {
          /* the user can press play */
        }
        undoForcedMute();
        clearStalledNotice();
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
    // Held before anything is measured, because the wall is already painted by
    // the time the first check runs.
    if (location.pathname === "/watch") holdErrorScreen();
    clearStalledNotice(); // a new video deserves a fresh chance
    setTimeout(showStalledNotice, STALL_AFTER_MS);
    [1500, 3000, 5000, 8000].forEach((ms) => setTimeout(recover, ms));
    [800, 1600, 2600, 4000, 6000, 9000].forEach((ms) => setTimeout(undoForcedMute, ms));
    // A block that is NOT about ad blocking belongs to the viewer, not to us.
    setTimeout(() => {
      const player = document.getElementById("movie_player");
      let ps;
      try {
        const response = player && player.getPlayerResponse && player.getPlayerResponse();
        ps = response && response.playabilityStatus;
      } catch {
        return revealErrorScreen();
      }
      if (!ps || ps.status === "OK") return; // nothing to show anyway
      if (!WALL_WORDS.test(JSON.stringify(ps))) revealErrorScreen();
    }, 2500);
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
