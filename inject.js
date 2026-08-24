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

  /** Remove the ad schedule from a player response. Returns null if untouched. */
  function stripAds(text) {
    // Off switch, read from the DOM because chrome.storage is unreachable from
    // the page world. Without this the stripper ran even with the extension's
    // master switch off, which made it impossible to test what it was causing.
    try {
      if (document.documentElement.hasAttribute("data-ytac-strip-off")) return null;
    } catch {
      /* if the DOM is not ready yet, default to stripping */
    }
    if (typeof text !== "string" || text.length < 2) return null;
    if (!AD_KEYS.some((k) => text.includes(`"${k}"`))) return null;
    try {
      const data = JSON.parse(text);
      let hit = false;
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
      if (!hit) return null;
      stripped++;
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
