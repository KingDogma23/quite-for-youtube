/**
 * YT Ad Cleaner — page-world ad-schedule stripper.
 *
 * This is the technique uBlock Origin actually uses, confirmed by reading its
 * live filter list:
 *
 *   www.youtube.com##+js(trusted-replace-fetch-response, '"adPlacements"', ...)
 *   www.youtube.com##+js(trusted-replace-fetch-response, '"adSlots"', ...)
 *
 * YouTube's player asks /youtubei/v1/player what to play, and the answer
 * contains the ad schedule. Remove those keys from the response and no ad is
 * ever scheduled — so there is nothing to detect, nothing to skip, and no
 * player classes to guess at. That sidesteps the entire class of problem the
 * skip/seek approach exists to work around.
 *
 * Runs in the MAIN world because it has to replace the page's own fetch/XHR.
 * Every path is wrapped so that ANY failure returns the untouched response:
 * a broken YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  const AD_KEYS = ["adPlacements", "adSlots", "playerAds", "adBreakHeartbeatParams"];
  const TARGET = /\/youtubei\/v1\/(player|next|reel_item_watch|get_watch)/;

  let stripped = 0;
  Object.defineProperty(window, "__ytacStripped", { get: () => stripped });

  /**
   * Publish results onto <html> as data attributes.
   *
   * This script runs in the PAGE world and the rest of the extension runs in
   * the isolated world, so they share no variables — but they do share the
   * DOM. Without this bridge the popup could never report whether stripping
   * worked, which is the number that matters most.
   */
  function publish(keys) {
    try {
      const root = document.documentElement;
      root.setAttribute("data-ytac-stripped", String(stripped));
      if (keys && keys.length) root.setAttribute("data-ytac-lastkeys", keys.join(","));
    } catch {
      /* attribute reporting must never break the response path */
    }
  }

  // Phrases YouTube uses when it is blocking playback BECAUSE of an ad blocker.
  // Deliberately narrow: a video that is private, age-gated, geo-blocked or
  // taken down must stay blocked. Repairing those would be breaking YouTube
  // rather than removing an ad.
  const WALL_HINTS =
    /ad ?block|allow ?list|allowlist|ads (allow|help)|violate|disable.{0,20}blocker/i;

  /** Is the extension switched on at all? Master switch, read from the DOM. */
  function enabled() {
    try {
      return !document.documentElement.hasAttribute("data-ytac-all-off");
    } catch {
      return true;
    }
  }

  let wallsCleared = 0;

  /**
   * Undo YouTube's anti-adblock block on a player response.
   *
   * `playabilityStatus` is the field that carries "playback is blocked unless
   * you allowlist us". Stripping the ad schedule does nothing about it, which
   * is why the wall survived every earlier build: the enforcement is a
   * SEPARATE response from the ads themselves, and arrives whether or not any
   * ad was removed.
   *
   * Only ad-blocker enforcement is touched, matched on the wording. Every
   * other reason a video will not play is left exactly as YouTube sent it.
   */
  /**
   * A repaired copy of a walled playabilityStatus, or null to leave it alone.
   * Pure: no side effects, so it is safe to call from a property setter.
   */
  function repairedStatus(ps) {
    if (!ps || typeof ps !== "object") return null;
    const status = String(ps.status || "");
    if (!status || status === "OK") return null;

    let blob = "";
    try {
      blob = JSON.stringify(ps);
    } catch {
      return null;
    }
    if (!WALL_HINTS.test(blob)) return null; // a genuine block: leave it alone

    return {
      status: "OK",
      playableInEmbed: ps.playableInEmbed !== false,
      ...(ps.miniplayer ? { miniplayer: ps.miniplayer } : {}),
      ...(ps.contextParams ? { contextParams: ps.contextParams } : {}),
    };
  }

  function notePlayabilityRepair() {
    wallsCleared++;
    try {
      document.documentElement.setAttribute("data-ytac-walls", String(wallsCleared));
    } catch {
      /* reporting must never break playback */
    }
  }

  /**
   * Repair the block, and KEEP it repaired.
   *
   * Observed live: the response YouTube embeds in the page arrives clean, and
   * the block is written into that same object afterwards by assigning a new
   * playabilityStatus to it. Repairing once on arrival therefore catches
   * nothing — the field has to be watched, not just read.
   *
   * The accessor is installed on the response object itself, so any later
   * replacement of that field is repaired as it lands.
   */
  function repairPlayability(data) {
    if (!data || typeof data !== "object") return false;

    let current = data.playabilityStatus;
    let repairedAny = false;

    const fix = (value) => {
      const better = repairedStatus(value);
      if (!better) return value;
      notePlayabilityRepair();
      repairedAny = true;
      return better;
    };

    current = fix(current);

    try {
      Object.defineProperty(data, "playabilityStatus", {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(value) {
          current = fix(value);
        },
      });
    } catch {
      // Cannot watch it; at least leave the one-off repair in place.
      try {
        data.playabilityStatus = current;
      } catch {
        /* nothing more to do */
      }
    }
    return repairedAny;
  }

  /**
   * Clean one parsed player response in place: ad schedule out, wall undone.
   * Returns true if anything changed.
   */
  function cleanObject(data) {
    let hit = false;
    if (!stripOff()) {
      for (const k of AD_KEYS) {
        if (k in data) {
          delete data[k];
          hit = true;
        }
      }
      if (data.playerConfig && data.playerConfig.adConfig) {
        delete data.playerConfig.adConfig;
        hit = true;
      }
      if (hit) stripped++;
    }
    // The wall is undone whenever the extension is on: it is a repair, not an
    // ad-blocking feature, and it must work even with stripping switched off.
    if (enabled() && repairPlayability(data)) hit = true;
    return hit;
  }

  /** Is ad-schedule stripping switched off? */
  function stripOff() {
    try {
      return document.documentElement.hasAttribute("data-ytac-strip-off");
    } catch {
      return false;
    }
  }

  /**
   * The initial player response is EMBEDDED IN THE HTML, not fetched — so the
   * fetch and XHR patches below never see the first video you load, which is
   * exactly when the wall appears. Intercepting the assignment catches it.
   */
  let initialResponse;
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get() {
        return initialResponse;
      },
      set(value) {
        try {
          if (value && typeof value === "object") cleanObject(value);
        } catch {
          /* never block the assignment */
        }
        initialResponse = value;
      },
    });
  } catch {
    /* if the property cannot be redefined, the fetch paths still apply */
  }

  /** Remove the ad schedule from a player response. Returns null if untouched. */
  function stripAds(text) {
    if (typeof text !== "string" || text.length < 2) return null;
    // Worth parsing if it carries an ad schedule OR a playability decision.
    if (!AD_KEYS.some((k) => text.includes(`"${k}"`)) &&
        !text.includes('"playabilityStatus"')) return null;
    try {
      const data = JSON.parse(text);
      if (!cleanObject(data)) return null;
      publish(AD_KEYS.filter((k) => text.includes(`"${k}"`)));
      return JSON.stringify(data);
    } catch {
      return null; // not JSON, or malformed — leave it completely alone
    }
  }

  const urlOf = (input) =>
    typeof input === "string" ? input : (input && (input.url || String(input))) || "";

  // ---- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (...args) {
      const res = nativeFetch.apply(this, args);
      if (!TARGET.test(urlOf(args[0]))) return res;
      return res.then((response) => {
        try {
          return response
            .clone()
            .text()
            .then((text) => {
              const cleaned = stripAds(text);
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

  // ---- XMLHttpRequest ------------------------------------------------------
  const OpenOrig = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytacTarget = TARGET.test(String(url || ""));
    return OpenOrig.call(this, method, url, ...rest);
  };

  const SendOrig = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytacTarget) {
      this.addEventListener("readystatechange", function () {
        if (this.readyState !== 4) return;
        try {
          const raw = this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : null;
          const cleaned = stripAds(raw);
          if (cleaned === null) return;
          // Shadow the native getters for this instance only.
          Object.defineProperty(this, "responseText", { value: cleaned, configurable: true });
          Object.defineProperty(this, "response", { value: cleaned, configurable: true });
        } catch {
          /* leave the response exactly as it came */
        }
      });
    }
    return SendOrig.apply(this, args);
  };
})();
