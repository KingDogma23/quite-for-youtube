/**
 * Live audit — paste into the console on a youtube.com/watch page, or run it
 * through browser automation. Produces NUMBERS, not impressions.
 *
 * Why this exists: this extension has repeatedly been declared working on the
 * strength of a mock harness, or of a build that was not actually running. The
 * only trustworthy evidence is the real site, measured the same way every time
 * — and measured the same way for the extension being compared against, so
 * "better than uBO" is a claim with a table behind it rather than a feeling.
 *
 * Run it three ways on the SAME video ids:
 *   1. this extension enabled
 *   2. everything disabled          (baseline: what YouTube does untouched)
 *   3. the comparison blocker only  (what we have to beat)
 *
 * Usage:  await ytacAudit()            audits the current page
 *         await ytacAudit(12000)       waits up to 12s for playback
 */
(() => {
  const WALL = /Ad blockers violate|allowlisted or the ad blocker/i;

  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  window.ytacAudit = async function ytacAudit(budgetMs = 15000) {
    const started = performance.now();
    const root = document.documentElement;
    const player = () => document.getElementById("movie_player");
    const video = () => document.querySelector("video");

    let wallEverVisible = false;
    let wallFirstSeenAt = null;
    let wallClearedAt = null;
    let firstFrameAt = null;
    let adUiEverShown = false;

    while (performance.now() - started < budgetMs) {
      const body = document.body ? document.body.innerText : "";
      const errEl = document.querySelector(
        "yt-playability-error-supported-renderers, #error-screen"
      );
      const wallNow = WALL.test(body) && visible(errEl);
      if (wallNow) {
        wallEverVisible = true;
        if (wallFirstSeenAt === null) wallFirstSeenAt = Math.round(performance.now() - started);
        wallClearedAt = null;
      } else if (wallEverVisible && wallClearedAt === null) {
        wallClearedAt = Math.round(performance.now() - started);
      }

      if (document.querySelector(".ad-showing, .ad-interrupting")) adUiEverShown = true;

      const v = video();
      if (firstFrameAt === null && v && v.currentTime > 0.5 && !v.paused) {
        firstFrameAt = Math.round(performance.now() - started);
        break; // playing: nothing further to wait for
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const p = player();
    let response = null;
    try {
      response = p && p.getPlayerResponse && p.getPlayerResponse();
    } catch {
      /* ignore */
    }
    const embedded = window.ytInitialPlayerResponse;
    const v = video();
    const shape = (o) =>
      o
        ? {
            status: o.playabilityStatus && o.playabilityStatus.status,
            adPlacements: Array.isArray(o.adPlacements) ? o.adPlacements.length : "none",
            adSlots: Array.isArray(o.adSlots) ? o.adSlots.length : "none",
            playerAds: Array.isArray(o.playerAds) ? o.playerAds.length : "none",
          }
        : null;

    return {
      videoId: new URLSearchParams(location.search).get("v"),
      build: root.getAttribute("data-ytac-version") || "(not this extension)",
      flagged: root.getAttribute("data-ytac-flagged") === "1",

      // The three that decide whether it is usable at all
      playedWithin: firstFrameAt !== null ? firstFrameAt + "ms" : "DID NOT PLAY",
      wallShownToViewer: wallEverVisible
        ? `yes, ${wallFirstSeenAt}ms → ${wallClearedAt === null ? "never cleared" : wallClearedAt + "ms"}`
        : "no",
      soundOn: v ? !v.muted && v.volume > 0 : null,

      // Whether ads were actually removed, at both entry points
      embeddedPayload: shape(embedded),
      livePayload: shape(response),
      adUiDuringPlayback: adUiEverShown,

      // Extension self-report
      neutralised: root.getAttribute("data-ytac-rewrites"),
      recovered: root.getAttribute("data-ytac-recovered") === "1",
      unmuteRepaired: root.getAttribute("data-ytac-unmuted") === "1",
    };
  };

  return "ytacAudit() ready";
})();
