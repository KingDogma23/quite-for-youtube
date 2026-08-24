/**
 * Quiet for YouTube — outbound player-request shaping.
 *
 * THE RULE THIS FILE EXISTS TO OBEY: never modify a response.
 *
 * Two earlier approaches edited what YouTube sent back — deleting the ad
 * schedule, then rewriting playabilityStatus to undo the anti-adblock block.
 * Both failed, and the failures were diagnostic:
 *
 *   - Deleting ads from the response leaves a mismatch between what the server
 *     sent and what the player sees. That mismatch is what the integrity check
 *     looks for, and it gets the session flagged.
 *   - Rewriting the block produces a video that will not play at all: a
 *     flagged session is not served usable stream data. The decision is made
 *     server-side and there is nothing on this end to repair.
 *
 * So the request is shaped instead, and the response is only ever READ.
 *
 * These are InnerTube request parameters — the same public API surface every
 * YouTube client uses. Several shapes return a response with no ad schedule of
 * its own; which one works varies by account and changes over time, so they
 * are tried in order and the next is used when a response comes back
 * unplayable. No code was copied from any other extension.
 *
 * Every path is wrapped: any failure leaves the request exactly as the page
 * built it, because a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  const PARAMS_A = "eAFgAQ";
  const PARAMS_B = "8AUB";
  const PARAMS_KEEP = "YAHI"; // a request already carrying this is left alone
  const SCREEN = "CHANNEL";

  // Tried in order. Each shapes the outgoing player request differently; the
  // rotation moves on when YouTube answers with something unplayable.
  const STRATEGIES = ["params_a", "params_b", "client_screen", "pyv", "ad_type", "none"];
  let strategyIndex = 0;
  let lastVideoId = null;
  let shaped = 0;

  const strategy = () => STRATEGIES[strategyIndex];

  function publish() {
    try {
      const root = document.documentElement;
      root.setAttribute("data-ytac-rewrites", String(shaped));
      root.setAttribute("data-ytac-strategy", strategy());
    } catch {
      /* reporting must never break a request */
    }
  }

  function nextStrategy() {
    if (strategyIndex < STRATEGIES.length - 1) {
      strategyIndex++;
      publish();
    }
  }

  /** Off switch, read from the DOM: chrome.storage is unreachable from here. */
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

  // A backgrounded tab gets different treatment from the player; keep it
  // reporting as visible so behaviour is consistent.
  try {
    Object.defineProperty(document, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
  } catch {
    /* not essential */
  }

  function setParams(req, value) {
    if (req.params !== value) req.params = value;
    if (req.playerRequest && req.playerRequest.params !== value) {
      req.playerRequest.params = value;
    }
    if (req.playbackContext && req.playbackContext.params !== value) {
      req.playbackContext.params = value;
    }
  }

  /** Shape one outgoing player request according to the current strategy. */
  function shape(req) {
    const client = req.context && req.context.client;
    if (!client) return false;

    // A new video restarts the rotation: a shape that failed on one video is
    // not evidence about the next.
    const id = req.videoId;
    if (id && lastVideoId && id !== lastVideoId) strategyIndex = 0;
    if (id) lastVideoId = id;

    // Already carrying a params value we must not disturb.
    if (typeof req.params === "string" && req.params.startsWith(PARAMS_KEEP)) return false;

    const playback = req.contentPlaybackContext || (req.playbackContext &&
      req.playbackContext.contentPlaybackContext);

    switch (strategy()) {
      case "params_a":
        setParams(req, PARAMS_A);
        break;
      case "params_b":
        setParams(req, PARAMS_B);
        if (!req.playlistId) client.clientScreen = SCREEN;
        break;
      case "client_screen":
        if (client.clientName !== "WEB") return false;
        client.clientScreen = SCREEN;
        break;
      case "pyv":
        req.adPlaybackContext = { pyv: true };
        break;
      case "ad_type":
        req.adPlaybackContext = { adType: "AD_TYPE_INSTREAM" };
        break;
      default:
        return false; // "none": hand it over untouched
    }

    // Housekeeping the player itself does, kept consistent with the shaping.
    if (playback) playback.lactMilliseconds = String(Date.now());
    if (client.configInfo && client.configInfo.appInstallData) {
      delete client.configInfo.appInstallData;
    }

    shaped++;
    publish();
    return true;
  }

  const looksLikePlayerRequest = (v) =>
    v && typeof v === "object" && v.context && v.context.client &&
    (v.videoId || v.playbackContext || v.playerRequest);

  // ---- shape the request on its way out ------------------------------------
  const nativeStringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    try {
      if (!off() && looksLikePlayerRequest(value)) shape(value);
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

  // ---- READ the response, only to decide whether to rotate -----------------
  // Nothing here modifies anything. Reading is safe; editing is what gets a
  // session flagged.
  const UNPLAYABLE = /"status"\s*:\s*"(ERROR|UNPLAYABLE|LOGIN_REQUIRED)"/;
  const PLAYER_URL = /\/youtubei\/v1\/player/;

  function noteResponseText(text) {
    try {
      if (typeof text !== "string" || !UNPLAYABLE.test(text)) return;
      if (text.includes("CONTENT_CHECK_REQUIRED")) return; // a real gate
      nextStrategy();
    } catch {
      /* never interfere with the response */
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (...args) {
      const res = nativeFetch.apply(this, args);
      const url =
        typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      if (!PLAYER_URL.test(url)) return res;
      return res.then((response) => {
        try {
          response.clone().text().then(noteResponseText).catch(() => {});
        } catch {
          /* ignore */
        }
        return response; // handed back untouched
      });
    };
  }

  // ---- recovery from an already-flagged session ---------------------------
  //
  // Everything above can only PREVENT a session being flagged. This is what
  // gets a flagged one back, and it is the piece that was missing all along.
  //
  // On a cold page load YouTube embeds the player response in the HTML, so
  // there is no request to shape and the wall arrives before any of this can
  // speak. But the player object exposes loadVideoById, and calling it forces
  // a REAL player request — which does get shaped, and comes back OK with no
  // ad schedule. The wall left on screen at that point is stale UI from the
  // failed load, so it is cleared directly.
  //
  // Verified live on a walled session: status ERROR with the wall showing,
  // then after this sequence status OK, adPlacements absent, wall gone and
  // the video playing.

  const WALL_WORDS = /ad ?block|allow ?list|allowlist|ads (allow|help)|violate/i;
  const recovered = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const videoIdNow = () => {
    try {
      return new URLSearchParams(location.search).get("v");
    } catch {
      return null;
    }
  };

  /** Is the page blocked specifically for ad blocking? */
  function wallShowing() {
    try {
      const player = document.getElementById("movie_player");
      const status = player && player.getPlayerResponse && player.getPlayerResponse();
      const ps = status && status.playabilityStatus;
      if (ps && ps.status && ps.status !== "OK") {
        // Only ad-blocker enforcement. Private, age-gated, geo-blocked and
        // removed videos are none of our business and stay as they are.
        if (WALL_WORDS.test(JSON.stringify(ps))) return true;
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

  async function recover() {
    if (off()) return;
    const id = videoIdNow();
    if (!id || recovered.has(id)) return; // one attempt per video, never a loop
    const player = document.getElementById("movie_player");
    if (!player || typeof player.loadVideoById !== "function") return;
    if (!wallShowing()) return;

    recovered.add(id);
    try {
      player.loadVideoById(id);
    } catch {
      return;
    }

    // Wait for the fresh response, then clear the UI the failed load left.
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      let status;
      try {
        status = player.getPlayerResponse && player.getPlayerResponse();
      } catch {
        return;
      }
      if (status && status.playabilityStatus && status.playabilityStatus.status === "OK") {
        clearWallUi();
        try {
          player.playVideo();
        } catch {
          /* the user can press play */
        }
        try {
          document.documentElement.setAttribute("data-ytac-recovered", "1");
        } catch {
          /* reporting only */
        }
        return;
      }
    }
  }

  function watchForWall() {
    // The wall can be there on arrival, or appear a moment later, and YouTube
    // navigates in-page without reloading.
    [1500, 3000, 5000, 8000].forEach((ms) => setTimeout(recover, ms));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForWall, { once: true });
  } else {
    watchForWall();
  }
  window.addEventListener("yt-navigate-finish", watchForWall);

  Object.defineProperty(window, "__ytacShaped", { get: () => shaped });
  Object.defineProperty(window, "__ytacStrategy", { get: () => strategy() });
  publish();
})();
