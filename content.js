/**
 * YT Ad Cleaner — content script
 *
 * Two jobs, and they are genuinely different problems:
 *
 *   1. Feed / sidebar / search / overlay ads are DOM elements. YouTube names
 *      them honestly (ytd-display-ad-renderer and friends), so content.css
 *      hides them statically at document_start — they never paint, and no
 *      scanning is involved. Nothing here has to do that work.
 *
 *   2. Video ads are NOT DOM. A pre-roll is the same <video> element playing
 *      different content from the same domain, so no selector can hide it.
 *      The only lever is the player: click Skip when it appears, and seek past
 *      anything unskippable. That is what most of this file does.
 *
 * Deliberately no network blocking. Blocking ad REQUESTS is what YouTube's
 * anti-adblock detection looks for; letting the request succeed and skipping
 * the playback keeps that quiet.
 */

(() => {
  "use strict";

  // Read from the manifest so the reported version cannot drift from the
  // installed one — a self-diagnosing extension misreporting itself is worse
  // than useless, and this file and manifest.json had already diverged.
  const VERSION = chrome.runtime.getManifest().version;

  const DEFAULTS = {
    enabled: true,
    skipVideoAds: true,
    hideFeedAds: true,
    hideOverlays: true,
    hideMerch: false,
    // Rewrites the OUTGOING player request so YouTube answers without an ad
    // schedule. Nothing in the response is edited, which is what kept every
    // earlier attempt detectable. See inject.js.
    stripAdSchedule: true,
    badge: false,
  };

  // Player states and controls. Kept in one place because these are the names
  // most likely to change when YouTube reshuffles the player.
  const AD_PLAYING = ".ad-showing, .ad-interrupting";

  // A second, independent confirmation that an ad is really on screen.
  //
  // Clicking Skip on a false positive is harmless — the button only exists
  // during an ad. SEEKING is not: it would send the video the viewer is
  // actually watching to its end. So the seek requires two agreeing signals,
  // and if these names ever change the extension simply stops seeking rather
  // than destroying playback. Failing towards "ads get through" is the correct
  // direction for this one.
  // Every entry here was OBSERVED on a real ad and reported by the extension's
  // own capture — none are guesses. Two distinct ad layouts have been seen:
  // one carrying ytp-ad-player-overlay-layout, and one carrying only the badge
  // and hover-text furniture. The second matched nothing on the original list,
  // so seeking was refused on it while skipping still worked.
  const AD_MARKERS = [
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-layout",
    ".ytp-ad-preview-container",
    ".ytp-ad-simple-ad-badge",
    ".ytp-ad-duration-remaining",
    // observed on the second layout
    ".ytp-ad-badge--clean-player",
    ".ytp-ad-info-hover-text-button",
    ".ytp-ad-details-line",
    ".ytp-ad-avatar",
    ".ytp-ad-module",
    ".video-ads",
  ].join(", ");
  const SKIP_BUTTONS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button",
  ].join(", ");
  const OVERLAY_CLOSE = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-overlay-close-container",
  ].join(", ");

  let settings = { ...DEFAULTS };

  // Seeks per ad break. Reset the moment the ad clears, so this bounds a stuck
  // ad without ever permanently disabling skipping.
  // Ads are short. A long video is, by construction, not an ad — this bound
  // holds regardless of whether any selector name is right, which is what
  // makes it worth having alongside the DOM signals.
  const MAX_AD_SECONDS = 180;
  const MAX_SEEK_ATTEMPTS = 6;
  let seekAttempts = 0;
  let seekGuard = null;

  // Session counters — the Facebook build proved these are worth having from
  // the first version, not bolted on after a week of guessing.
  /**
   * Lifetime totals, persisted to chrome.storage.local.
   *
   * Only things actually measured are recorded. Notably absent is "data
   * blocked": this extension does not block requests, so any megabyte figure
   * would be invented. Time saved IS real — each ad's duration is known from
   * the player at the moment it is skipped, so it is summed rather than
   * estimated from an average.
   */
  const LIFETIME_KEY = "quietLifetime";
  let lifetime = { adsBlocked: 0, secondsSaved: 0, adsSkipped: 0, since: null };
  let lifetimeDirty = false;

  function loadLifetime() {
    chrome.storage.local.get({ [LIFETIME_KEY]: null }, (got) => {
      const stored = got[LIFETIME_KEY];
      if (stored) lifetime = { ...lifetime, ...stored };
      if (!lifetime.since) {
        lifetime.since = Date.now();
        lifetimeDirty = true;
      }
    });
  }

  function recordAd(seconds) {
    lifetime.adsBlocked++;
    lifetime.adsSkipped = (lifetime.adsSkipped || 0) + 1;
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 600) {
      lifetime.secondsSaved += seconds;
    }
    lifetimeDirty = true;
  }

  // Batched: writing on every ad would hammer storage during a long session.
  setInterval(() => {
    if (!lifetimeDirty) return;
    lifetimeDirty = false;
    chrome.storage.local.set({ [LIFETIME_KEY]: lifetime });
  }, 5000);

  const session = {
    videoAdsSkipped: 0,
    videoAdsSeeked: 0,
    overlaysClosed: 0,
    seekBlocked: 0,
    spedUp: 0,
    falseSeeksReverted: 0,
    // Verified against live YouTube before release: during normal playback
    // NONE of the AD_MARKERS exist in the DOM. That makes a false seek
    // impossible, but it also means their names during a real ad are still
    // unverified. So the first ad encountered is recorded verbatim — the same
    // instrument-don't-assume approach that eventually cracked the Facebook
    // build, fitted before shipping this time rather than after.
    firstAdSeen: null,
    adSightings: [],
    lastAction: "none yet",
  };

  // ---------------------------------------------------------------- helpers

  const player = () => document.querySelector(".html5-video-player");

  function adIsPlaying() {
    const p = player();
    return !!(p && p.matches(AD_PLAYING));
  }

  /**
   * Two agreeing signals — required before anything that alters playback.
   *
   * The marker must be VISIBLE, not merely present. YouTube keeps these ad
   * overlay elements in the DOM permanently and hides them between ads, so
   * querySelector alone matches all the time and confirms nothing — which
   * made this check pure decoration until a test caught it.
   */
  function adConfirmed() {
    const p = player();
    if (!p || !p.matches(AD_PLAYING)) return false;
    for (const el of p.querySelectorAll(AD_MARKERS)) {
      if (isVisible(el)) return true;
    }
    return false;
  }

  /**
   * offsetParent is null for position:fixed elements, so it wrongly reports a
   * fixed skip button as invisible. Measure the box instead.
   */
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // --------------------------------------------------------------- video ads

  /**
   * Deal with an ad that is currently playing.
   *
   * Skip button first — it is what YouTube itself offers, so it is the least
   * intrusive. Failing that, seek to the end: an unskippable ad still has a
   * finite duration, and moving the playhead there ends it.
   */
  /** Record what an ad actually looks like, once per session. */
  function captureAdShape(p) {
    // Keep the most recent few rather than only the first: a single spurious
    // sighting must not lock out the real one.
    if (session.adSightings.length >= 3) session.adSightings.shift();
    const adClasses = [...new Set(
      [...p.querySelectorAll('[class*="ytp-ad"], [class*="video-ads"]')]
        .map((e) => (typeof e.className === "string" ? e.className : ""))
        .join(" ")
        .split(/\s+/)
        .filter((c) => c.startsWith("ytp-ad") || c.startsWith("video-ads"))
    )].slice(0, 20);

    const video = p.querySelector("video");
    const shape = {
      playerClasses: (p.className || "").slice(0, 160),
      adClassesFound: adClasses,
      markerMatched: AD_MARKERS.split(", ").filter((sel) => {
        const el = p.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
      skipMatched: SKIP_BUTTONS.split(", ").filter((sel) => p.querySelector(sel)),
      videoDuration:
        video && Number.isFinite(video.duration)
          ? Math.round(video.duration * 10) / 10
          : "unknown",
      adStateClass: p.matches(AD_PLAYING),
    };
    session.adSightings.push(shape);
    session.firstAdSeen = session.adSightings[0];
  }

  /**
   * Watch the player from OUTSIDE every assumption this file makes.
   *
   * captureAdShape used to be called from inside handleVideoAd, which returns
   * early unless .ad-showing matched — so on the one run that matters, where
   * that class is the thing that changed, the extension would do nothing AND
   * report "no ad seen". The diagnostic shared the detector's single point of
   * failure. It now triggers on any ad-ish class appearing, whatever it is.
   */
  let lastPlayerClasses = "";

  function observePlayer() {
    const p = player();
    if (!p) return;
    const cls = p.className || "";
    if (cls === lastPlayerClasses) return;
    lastPlayerClasses = cls;

    // Presence is not evidence. ytp-ad-progress-list is ordinary player
    // furniture that exists all the time — matching on it burned the capture
    // slot on a non-ad and then reported "names wrong", which was doubly
    // misleading. Require the ad state, or an ad element that is actually
    // being rendered.
    if (p.matches(AD_PLAYING)) return captureAdShape(p);

    for (const el of p.querySelectorAll('[class*="ytp-ad"], [class*="video-ads"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return captureAdShape(p);
    }
  }

  function handleVideoAd() {
    if (!settings.skipVideoAds || !adIsPlaying()) return;

    const p = player();

    const skip = p.querySelector(SKIP_BUTTONS);
    if (isVisible(skip)) {
      const v = p.querySelector("video");
      // Seconds actually avoided: what was left of the ad when Skip was hit.
      const remaining =
        v && Number.isFinite(v.duration) ? Math.max(v.duration - v.currentTime, 0) : 0;
      skip.click();
      session.videoAdsSkipped++;
      recordAd(remaining);
      session.lastAction = "clicked skip";
      return;
    }

    // Everything below alters playback, so it needs the second signal.
    if (!adConfirmed()) {
      session.seekBlocked++;
      return;
    }

    const video = p.querySelector("video");
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

    // Anything longer than an ad is not an ad. This bound does not depend on a
    // single selector name being right, so it still holds if every DOM
    // assumption in this file turns out to be wrong.
    if (video.duration > MAX_AD_SECONDS) {
      session.seekBlocked++;
      session.lastAction = `refused: ${Math.round(video.duration)}s is too long to be an ad`;
      return;
    }

    // Fast-forward FIRST. If the detection is wrong, the viewer sees their own
    // video briefly play fast — annoying and instantly recoverable. Seeking is
    // held back as the last resort precisely because getting it wrong is not.
    if (video.playbackRate < 8) {
      video.playbackRate = 16;
      video.muted = true;
      session.spedUp++;
      recordAd(Math.max(video.duration - video.currentTime, 0));
      session.lastAction = "fast-forwarding through ad";
      return;
    }

    // Already sent to the end and the ad has not cleared: seeking again every
    // tick would achieve nothing and spin the counters, so stop.
    if (video.currentTime >= video.duration - 0.5) return;
    if (seekAttempts >= MAX_SEEK_ATTEMPTS) {
      session.lastAction = "gave up seeking after repeated attempts";
      return;
    }

    // Remember where we were. If this turns out to have been the viewer's real
    // video, the next tick puts the playhead back — which converts the one
    // catastrophic failure mode into a blip.
    seekGuard = { duration: video.duration, from: video.currentTime };

    // Just under the end rather than exactly at it: some players ignore a seek
    // to precisely duration and stall on the final frame.
    video.currentTime = Math.max(video.duration - 0.1, 0);
    seekAttempts++;
    session.videoAdsSeeked++;
    session.lastAction = "seeked past unskippable ad";
  }

  /**
   * Undo a seek that turned out to be wrong.
   *
   * When a real ad ends, the player loads different media and the duration
   * CHANGES. So if the ad state has cleared and the duration is identical to
   * what it was when we seeked, we never left the same video — meaning we
   * fast-forwarded the viewer's own content to its end. Put it back.
   */
  function revertFalseSeek() {
    if (!seekGuard) return;
    if (adIsPlaying()) return; // still mid-break, nothing to judge yet

    const video = player()?.querySelector("video");
    const g = seekGuard;
    seekGuard = null;
    if (!video) return;

    if (video.duration === g.duration && video.currentTime >= video.duration - 1) {
      video.currentTime = g.from;
      session.falseSeeksReverted++;
      session.lastAction = "REVERTED a false seek — restored your position";
    }
  }

  /** Playback speed is ours only while an ad runs; hand it back afterwards. */
  function restoreSpeed() {
    if (adIsPlaying()) return;
    const video = player()?.querySelector("video");
    if (video && video.playbackRate > 8) {
      video.playbackRate = 1;
      video.muted = false;
    }
  }

  /** Dismiss the banner overlays that sit on top of the video. */
  const clickedCloses = new WeakSet();

  function closeOverlays() {
    if (!settings.hideOverlays) return;
    for (const btn of document.querySelectorAll(OVERLAY_CLOSE)) {
      if (!isVisible(btn)) continue;
      // Without this, a close button that survives its own click gets clicked
      // again on every tick — several times a second, indefinitely.
      if (clickedCloses.has(btn)) continue;
      clickedCloses.add(btn);
      btn.click();
      session.overlaysClosed++;
      session.lastAction = "closed an overlay";
    }
  }

  // ------------------------------------------------------------------ badge

  let badgeEl = null;

  function updateBadge() {
    if (!settings.badge) {
      badgeEl?.remove();
      badgeEl = null;
      return;
    }
    if (!document.body) return;
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "ytac-badge";
      badgeEl.title = "YT Ad Cleaner — click to dismiss";
      badgeEl.addEventListener("click", () => {
        badgeEl.remove();
        badgeEl = null;
        settings.badge = false;
      });
      document.body.appendChild(badgeEl);
    }
    const total = session.videoAdsSkipped + session.videoAdsSeeked;
    badgeEl.textContent =
      `YT Ad Cleaner ${VERSION} · video ads ${total} ` +
      `(${session.videoAdsSkipped} skipped, ${session.videoAdsSeeked} seeked) · ` +
      `overlays ${session.overlaysClosed}`;
    badgeEl.dataset.state = settings.enabled ? "ok" : "warn";
  }

  // --------------------------------------------------------------- settings

  /**
   * The CSS does the hiding, so switching a category off means switching the
   * stylesheet off — done with an attribute on <html> that the rules test for.
   */
  function applyCssToggles() {
    const root = document.documentElement;
    const off = (name, on) =>
      on ? root.removeAttribute(name) : root.setAttribute(name, "1");

    // Stamp the running version onto the page. An unpacked extension keeps
    // serving its old code until Reload is pressed, and results were twice
    // reported from a build that was not actually running. This makes "which
    // build is live" readable without guessing.
    try {
      root.setAttribute("data-ytac-version", VERSION);
    } catch {
      /* reporting only */
    }

    // Master switch, so the page-world script can tell "extension off" from
    // "this one feature off". The wall repair keys off this and nothing else.
    off("data-ytac-all-off", settings.enabled);

    off("data-ytac-strip-off", settings.enabled && settings.stripAdSchedule);

    off("data-ytac-feed-off", settings.enabled && settings.hideFeedAds);
    off("data-ytac-overlay-off", settings.enabled && settings.hideOverlays);
    // Merch is opt-IN, so the attribute is present only when it should hide.
    if (settings.enabled && settings.hideMerch) root.setAttribute("data-ytac-merch-off", "1");
    else root.removeAttribute("data-ytac-merch-off");
  }

  // ------------------------------------------------------------------- loop

  function tick() {
    if (!settings.enabled) return;
    try {
      if (!adIsPlaying()) seekAttempts = 0; // ad break over; restore the budget
      revertFalseSeek();
      restoreSpeed();
      observePlayer();
      handleVideoAd();
      closeOverlays();
      updateBadge();
    } catch (err) {
      console.warn(`[YT Ad Cleaner ${VERSION}] tick failed:`, err);
    }
  }

  /**
   * A timer, not just a MutationObserver.
   *
   * Ad state lives in a class on the player and in the video's own playback,
   * neither of which reliably produces mutations at the moment that matters —
   * a skip button can become clickable without the DOM changing around it.
   * 400ms is frequent enough to catch a skip button within a blink and cheap
   * enough to be invisible: each tick is two querySelectors.
   */
  function start() {
    console.log(`[YT Ad Cleaner ${VERSION}] active on ${location.pathname}`);
    applyCssToggles();
    tick();
    // A timer alone, deliberately.
    //
    // A MutationObserver over YouTube's document fires constantly, and each
    // callback would run querySelectors — the same reflow-storm pattern that
    // made the Facebook build flicker. It buys nothing here: the stylesheet
    // hides feed ads with no JS at all, and player state is polled anyway.
    setInterval(tick, 400);
  }

  loadLifetime();

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    applyCssToggles();
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // Resetting the counters from the popup writes to local; without this the
    // running page keeps its old totals until the tab is reloaded.
    if (area === "local" && changes[LIFETIME_KEY]) {
      lifetime = { ...lifetime, ...(changes[LIFETIME_KEY].newValue || {}) };
      return;
    }
    if (area !== "sync") return;
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    applyCssToggles();
    updateBadge();
  });

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg?.type === "diagnostics") {
      respond({
        version: VERSION,
        url: location.pathname,
        settings: { ...settings },
        session: { ...session },
        lifetime: { ...lifetime },
        rewrites: Number(
          document.documentElement.getAttribute("data-ytac-rewrites") || 0
        ),
        strategy:
          document.documentElement.getAttribute("data-ytac-strategy") || "none yet",
        walled: /Ad blockers violate/i.test(document.body?.innerText || ""),
        page: {
          playerFound: !!player(),
          adPlayingNow: adIsPlaying(),
          skipButtonVisible: !!document.querySelector(SKIP_BUTTONS),
          // Presence and VISIBILITY, separately. The old counter reported only
          // that ad elements existed in the DOM, which is expected — the
          // stylesheet hides them, it does not remove them. Reporting "2 ads
          // on page" when both were already hidden reads as a failure when it
          // is actually the system working.
          feedAds: (() => {
            const els = document.querySelectorAll(
              "ytd-ad-slot-renderer, ad-slot-renderer, ytd-display-ad-renderer, " +
                "ytd-in-feed-ad-layout-renderer, ytd-companion-slot-renderer, " +
                "ytd-action-companion-ad-renderer"
            );
            let visible = 0;
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) visible++;
            }
            return { inDom: els.length, stillVisible: visible };
          })(),
        },
      });
    }
    return true;
  });
})();
