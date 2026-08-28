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
 * No network blocking — and the original reason given for that was wrong.
 *
 * This file used to claim that blocking ad requests is what triggers YouTube's
 * anti-adblock detection. That was never measured, and uBlock Origin blocks
 * requests constantly without being flagged. What actually happened when
 * blocking was tried here (0.16.0, eight hand-written declarative rules) is
 * that playback stopped: readyState stayed at 0 with the rules enabled and
 * reached 4 with the same build and the rules disabled.
 *
 * The real reason there is no network blocking is that deciding which requests
 * to block is a maintained filter list's job. Eight rules written from memory
 * do not approximate one; they break the player in a way that looks like the
 * extension is faulty. The ad schedule is neutralised in the page instead.
 */

(() => {
  "use strict";

  // Read from the manifest so the reported version cannot drift from the
  // installed one — a self-diagnosing extension misreporting itself is worse
  // than useless, and this file and manifest.json had already diverged.
  const VERSION = chrome.runtime.getManifest().version;

  /**
   * Orphan guard. The Facebook build has had this since 2.4.1; this one never
   * did, and that is the whole reason its card in chrome://extensions shows an
   * Errors button while Facebook's does not.
   *
   * Pressing Reload on an unpacked extension does NOT stop the content script
   * already running in open tabs. It keeps its timers and keeps calling
   * chrome.* against a context that no longer exists — here, a storage write
   * every five seconds, forever, each one throwing "Extension context
   * invalidated". During a day of reloading, that is thousands of errors from
   * an extension that is otherwise working perfectly.
   *
   * So: every chrome.* call is guarded, and an orphaned script stands down
   * rather than shouting into a dead channel.
   */
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  let timers = [];
  let stopped = false;

  function shutdown() {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    timers = [];
    try {
      badgeEl?.remove();
      badgeEl = null;
    } catch {
      /* the page is not ours to break on the way out */
    }
  }

  /**
   * Time-to-first-frame, measured by the page rather than by polling from
   * outside it.
   *
   * Two separate failures made this necessary on 2026-08-26:
   *
   *   - Polling from a driver samples at whatever moment the driver happens to
   *     run. "readyState 0 at 5s" only means the sample landed at 5s; it says
   *     nothing about when the frame actually arrived. Media events carry
   *     their own timestamps, so this measures the event, not the sample.
   *   - Every reading that day was taken in a BACKGROUND tab, which hydrates
   *     differently, and nothing in the output said so. A whole gate run was
   *     reported before that was noticed. So visibility is now recorded
   *     alongside the timing and travels with it.
   *
   * This runs unconditionally — including under ?ytacoff=1. A measurement that
   * switches off with the thing being measured cannot produce a control arm.
   * It only reads and stamps attributes; it never touches playback.
   */
  function installTimeline() {
    const root = document.documentElement;
    let marks = Object.create(null);
    // Time is measured from the start of THIS video, not the start of the
    // document. Clicking a video on YouTube is a soft navigation: the document
    // survives, so a document-relative clock freezes at the first video and
    // every later hop reports numbers belonging to a video the viewer left
    // minutes ago. Watching a session on 2026-08-27, every hop reported
    // "playing=1128" — the first video's figure — while the player in front of
    // us was spinning. The measurement said fine; the screen said otherwise.
    let navBase = 0;
    let navCount = 0;
    const at = () => Math.round(performance.now() - navBase);
    let hiddenEver = document.visibilityState === "hidden";

    const videoId = () =>
      (location.search.match(/[?&]v=([\w-]{11})/) || [])[1] || "?";

    const publish = () => {
      try {
        root.setAttribute(
          "data-ytac-ttff",
          Object.keys(marks)
            .map((k) => `${k}=${marks[k]}`)
            .join(","),
        );
        // Any reading taken while this says 1 is void. Foreground the tab and
        // measure again.
        root.setAttribute("data-ytac-hidden", hiddenEver ? "1" : "0");
        // Which video in the session these figures belong to. 0 is the cold
        // load; anything higher came from clicking.
        root.setAttribute("data-ytac-nav", String(navCount));
      } catch {
        /* reporting must never break playback */
      }
    };

    /**
     * A rolling log of every hop, written when the hop finishes.
     *
     * Address-bar loads do not reproduce clicks: YouTube serves a soft
     * navigation a different ad schedule from a cold load of the same video —
     * measured 2026-08-27, where a clicked hop carried adSlots and six cold
     * loads of that same video did not. Every A/B run from the address bar was
     * therefore testing a path the viewer was not on.
     *
     * So the page records the real thing instead: one line per hop, kept in
     * memory and readable afterwards. An ordinary browsing session then yields
     * twenty measured hops rather than one recreated badly.
     */
    const LOG_MAX = 40;
    const hops = [];

    // Media counts are cumulative, so each hop keeps the reading it started
    // with and reports the difference.
    const readMedia = () => {
      const out = Object.create(null);
      for (const part of (root.getAttribute("data-ytac-media") || "").split(",")) {
        const [k, v] = part.split("x");
        if (k) out[k] = Number(v) || 0;
      }
      return out;
    };
    let mediaAtHopStart = readMedia();

    const mediaDelta = () => {
      const now = readMedia();
      const diff = [];
      for (const k of Object.keys(now)) {
        const d = now[k] - (mediaAtHopStart[k] || 0);
        if (d > 0) diff.push(`${k}x${d}`);
      }
      return diff.join(",") || "none";
    };

    function publishHops() {
      try {
        // Compact on purpose: this is read as text from the page.
        root.setAttribute(
          "data-ytac-hops",
          hops
            .slice(-12)
            .map(
              (h) =>
                `${h.n}:${h.id}:${h.play}ms:gap${h.gap}:${h.sched}:${h.media}:${h.stalls}:h${h.hidden}` +
                (h.health ? `:${h.health}` : ""),
            )
            .join(" | "),
        );
      } catch {
        /* reporting only */
      }
    }

    /**
     * Did it KEEP playing, with a picture and sound?
     *
     * Everything above this answers "did it start". On 2026-08-28 all eight
     * clicked hops logged a first frame inside 226ms and the viewer reported
     * two that never played and four with no sound — because `playing` fires,
     * and currentTime advances, for a black frame with a silent audio track.
     * The instrument was measuring the clock, not the film.
     *
     * So five seconds after the first frame, ask the video element what it
     * actually produced: seconds played, frames decoded and dropped, audio
     * bytes decoded, and whether it is muted, paused or has no picture.
     */
    function watchHealth(hop) {
      if (!hop) return;
      const id = hop.id;

      /**
       * Did an advert actually play on this hop?
       *
       * Until now the only witness was the viewer saying "I saw one advert
       * start", which cannot be lined up against eleven hops. YouTube marks the
       * player with `ad-showing` for the duration, so poll for it across the
       * first eight seconds — a pre-roll is over long before the health sample
       * at five, and a check taken once would miss most of them.
       *
       * This is what makes the adSlots question answerable: if the hops that
       * carry S are the hops that show AD, the remaining ad path is identified
       * rather than suspected.
       */
      let sawAd = false;
      const adPoll = setInterval(() => {
        try {
          const p = document.querySelector("#movie_player");
          if ((p && p.classList.contains("ad-showing")) || document.querySelector(".ytp-ad-player-overlay")) {
            sawAd = true;
          }
        } catch {
          /* reporting only */
        }
      }, 500);
      setTimeout(() => clearInterval(adPoll), 8000);

      setTimeout(() => {
        const a = document.querySelector("video");
        if (!a || videoId() !== id) return;
        // Absolute readings, then a one-second re-read. The first attempt took
        // deltas from the hop's start and produced negative audio byte counts:
        // webkitAudioDecodedByteCount RESTARTS when the player switches media
        // source, and YouTube reuses one <video> element across navigations, so
        // its frame counter is cumulative for the session rather than for this
        // video. Neither could answer "is it playing NOW", which is the only
        // question the viewer is asking.
        const t0 = a.currentTime;
        const audio0 = a.webkitAudioDecodedByteCount || 0;
        const frames0 = a.getVideoPlaybackQuality ? a.getVideoPlaybackQuality().totalVideoFrames : 0;
        setTimeout(() => {
          try {
            const b = document.querySelector("video");
            if (!b || videoId() !== id) return;
            const q = b.getVideoPlaybackQuality ? b.getVideoPlaybackQuality() : null;
            const moved = b.currentTime - t0;
            const audio = (b.webkitAudioDecodedByteCount || 0) - audio0;
            const frames = q ? q.totalVideoFrames - frames0 : 0;
            hop.health =
              (moved > 0.2 ? `adv${moved.toFixed(1)}s` : "STUCK") +
              `:f${frames}` +
              (q && q.droppedVideoFrames ? `/${q.droppedVideoFrames}d` : "") +
              (audio > 0 ? `:a${Math.round(audio / 1024)}k` : ":NOAUDIO") +
              (b.videoWidth ? "" : ":NOPIC") +
              (b.muted || b.volume === 0 ? ":MUTE" : "") +
              (b.paused ? ":PAUSED" : "") +
              (sawAd ? ":AD" : "");
            publishHops();
          } catch {
            /* reporting only */
          }
        }, 1000);
      }, 5000);
    }

    const logHop = () => {
      const ls = marks.loadstart;
      const meta = marks.loadedmetadata;
      const play = marks.playing;
      if (ls === undefined || play === undefined) return;
      hops.push({
        n: navCount,
        id: currentId,
        ls,
        gap: meta === undefined ? null : meta - ls,
        play,
        sched: root.getAttribute("data-ytac-adsched-fetch") || "",
        // What the media layer did during THIS hop. The tally is cumulative
        // for the session, so a slow hop showed "200x41" — the total since the
        // page opened, which says nothing about the four seconds in question.
        media: mediaDelta(),
        stalls: `${stalls ? `stall${stalls}/${stallWorst}ms` : ""}${resets ? `reset${resets}@${resetAt}ms` : ""}`,
        hidden: hiddenEver ? 1 : 0,
      });
      if (hops.length > LOG_MAX) hops.shift();
      publishHops();
      watchHealth(hops[hops.length - 1]);
    };

    /**
     * Stalls DURING playback, which is what the viewer actually sees.
     *
     * Everything above measures time-to-first-frame. On 2026-08-27 a hop was
     * logged at 188ms — a clean, fast start — while the player in front of the
     * viewer sat at readyState 0 with an empty buffer, spinning. It had
     * started and then lost its media. Start time is simply the wrong moment:
     * a video that begins instantly and rebuffers for four seconds a minute in
     * is indistinguishable, by that measure, from one that never stutters.
     *
     * The media element already announces this. "waiting" fires when playback
     * halts for want of data, "playing" when it resumes.
     */
    let stallStart = null;
    let stalls = 0;
    let stallWorst = 0;
    let stallTotal = 0;
    // A RESET is the failure actually observed: the player starts, then tears
    // the media down and returns to currentTime 0 with an empty buffer. It is
    // not rebuffering — the stall counter missed it because that counter
    // required currentTime > 0, and a reset puts currentTime back to zero.
    let resets = 0;
    let resetAt = 0;

    const publishStalls = () => {
      try {
        root.setAttribute(
          "data-ytac-rebuffer",
          `n=${stalls},worst=${stallWorst}ms,total=${stallTotal}ms,resets=${resets}`,
        );
      } catch {
        /* reporting only */
      }
    };

    // The slowest hop of the session, kept rather than sampled.
    //
    // Polling every ten seconds only catches a slow start by luck: a video
    // that spun for four seconds and then played looks identical to one that
    // never spun, unless the sample happens to land inside those four
    // seconds. Six samples missed a delay the viewer watched happen. So the
    // page records its own worst case and holds onto it.
    let worst = { id: "", ms: -1 };
    let slowCount = 0;
    const SLOW_MS = 3000;

    const mark = (name) => {
      if (name in marks) return; // first occurrence only
      marks[name] = at();
      if (name === "playing") logHop();
      if (name === "advancing") {
        const ms = marks[name];
        if (ms > worst.ms) worst = { id: videoId(), ms };
        if (ms > SLOW_MS) slowCount++;
        try {
          root.setAttribute("data-ytac-worst", `${worst.id}=${worst.ms}`);
          root.setAttribute("data-ytac-slow", String(slowCount));
        } catch {
          /* reporting only */
        }
      }
      publish();
    };

    // YouTube announces its own soft navigations. Re-arm on them, so each
    // video is timed from the moment it was asked for.
    //
    // Keyed on the video CHANGING, not on the event firing. YouTube emits
    // yt-navigate-finish during its own boot, after the media events for the
    // cold load have already been recorded — re-arming blindly wiped them, and
    // four of six measured loads came back empty. An event is not evidence
    // that the thing it is named after actually happened.
    let currentId = videoId();
    const rearm = () => {
      const id = videoId();
      if (id === currentId) return;
      // A hop the viewer abandoned mid-spin never fires playing, and those are
      // exactly the ones worth seeing. Record it as it was left.
      if (marks.loadstart !== undefined && marks.playing === undefined) {
        hops.push({
          n: navCount,
          id: currentId,
          ls: marks.loadstart,
          gap: null,
          play: null,
          sched: root.getAttribute("data-ytac-adsched-fetch") || "",
          // These were omitted, so an abandoned hop — the worst kind — logged
          // "undefined:undefined" exactly where its media counts belong.
          media: mediaDelta(),
          stalls: `${stalls ? `stall${stalls}/${stallWorst}ms` : ""}${resets ? `reset${resets}@${resetAt}ms` : ""}`,
          hidden: hiddenEver ? 1 : 0,
        });
        publishHops();
      }
      currentId = id;
      marks = Object.create(null);
      navBase = performance.now();
      navCount++;
      mediaAtHopStart = readMedia();
      stallStart = null;
      stalls = 0;
      stallWorst = 0;
      stallTotal = 0;
      resets = 0;
      resetAt = 0;
      publishStalls();
      // Visibility is judged PER VIDEO, not per document. The flag used to
      // latch for the life of the page, so one glance at another tab marked
      // every subsequent hop void — in a clicking session that is every
      // reading after the first. What matters is whether THIS video was
      // watched in the open.
      hiddenEver = document.visibilityState === "hidden";
      publish();
    };
    for (const evt of ["yt-navigate-start", "yt-navigate-finish"]) {
      try {
        document.addEventListener(evt, rearm);
      } catch {
        /* diagnostics are optional */
      }
    }

    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          hiddenEver = true;
          publish();
        }
      });

      // Media events do not bubble, but they still travel the capture phase,
      // so one listener on the document catches every <video> the player
      // creates — including ones replaced mid-session on a soft navigation.
      for (const type of ["loadstart", "loadedmetadata", "loadeddata", "playing"]) {
        document.addEventListener(type, () => mark(type), true);
      }

      document.addEventListener(
        "loadstart",
        () => {
          // Same video, already playing, and the media layer starts over.
          if (marks.playing === undefined) return;
          resets++;
          resetAt = at();
          publishStalls();
        },
        true,
      );

      // A stall only counts once playback has actually begun; "waiting" also
      // fires during a normal cold start, which is measured separately above.
      document.addEventListener(
        "waiting",
        () => {
          // Gated on playback having begun, not on currentTime — a reset puts
          // currentTime back to 0, which is exactly when this must still fire.
          if (marks.playing === undefined) return;
          if (stallStart === null) stallStart = performance.now();
        },
        true,
      );
      document.addEventListener(
        "playing",
        () => {
          if (stallStart === null) return;
          const held = Math.round(performance.now() - stallStart);
          stallStart = null;
          // Under 200ms is a seek settling, not a stall worth reporting.
          if (held < 200) return;
          stalls++;
          stallTotal += held;
          if (held > stallWorst) stallWorst = held;
          publishStalls();
        },
        true,
      );
      // The decisive number: content actually advancing, not merely a player
      // that reports itself as unpaused.
      document.addEventListener(
        "timeupdate",
        (e) => {
          if (!e.target || !(e.target.currentTime > 0)) return;
          // The video being LEFT keeps firing timeupdate for a moment after a
          // soft navigation re-arms the clock, so "advancing" was being marked
          // at ~20ms — before the new video had even issued loadstart. That
          // made the worst-case tracker read 2071ms through a spin the viewer
          // sat and watched. A hop has not advanced until it has loaded.
          if (!("loadstart" in marks) && !("loadedmetadata" in marks)) return;
          mark("advancing");
        },
        true,
      );
    } catch {
      /* diagnostics are optional; playback is not */
    }

    publish();
  }

  installTimeline();

  const DEFAULTS = {
    enabled: true,
    skipVideoAds: true,
    hideFeedAds: true,
    hideOverlays: true,
    hideMerch: false,
    // Makes the player response's ad fields read as undefined, in the page,
    // exactly as uBO does. Request shaping was tried and removed: it did not
    // rescue a flagged session, and it made YouTube answer with muteOnStart.
    // See inject.js.
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
    if (!contextAlive()) return;
    chrome.storage.local.get({ [LIFETIME_KEY]: null }, (got) => {
      if (chrome.runtime.lastError) return;
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
  timers.push(
    setInterval(() => {
      if (!contextAlive()) return shutdown();
      if (!lifetimeDirty) return;
      lifetimeDirty = false;
      try {
        chrome.storage.local.set({ [LIFETIME_KEY]: lifetime });
      } catch {
        shutdown();
      }
    }, 5000),
  );

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
    // ?ytacoff=1 disables the whole extension for one page load, so the same
    // video can be measured with it on and off. Diagnostic only.
    const bypass = location.search.indexOf("ytacoff=1") !== -1;
    const on = settings.enabled && !bypass;

    // ?ytacnocss=1 — the stylesheet stands down, the rest stays on. Every rule
    // in content.css is gated on one of these attributes, so setting them all
    // is equivalent to not shipping the CSS for this load. One of three
    // switches that let the failing subsystem be named; see inject.js.
    const noCss = location.search.indexOf("ytacnocss=1") !== -1;

    off("data-ytac-all-off", on);
    off("data-ytac-strip-off", on && settings.stripAdSchedule);

    off("data-ytac-feed-off", on && settings.hideFeedAds && !noCss);
    off("data-ytac-overlay-off", on && settings.hideOverlays && !noCss);
    // Merch is opt-IN, so the attribute is present only when it should hide.
    if (on && settings.hideMerch && !noCss) root.setAttribute("data-ytac-merch-off", "1");
    else root.removeAttribute("data-ytac-merch-off");
  }

  // ------------------------------------------------------------------- loop

  function tick() {
    if (stopped) return;
    if (!contextAlive()) return shutdown();
    // The player loop must not run during a bypass either: it clicks, seeks
    // and changes playbackRate, none of which a control arm may do.
    if (!settings.enabled || location.search.indexOf("ytacoff=1") !== -1) return;
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

    // ?ytacnoloop=1 — the player loop stands down, the stylesheet and the
    // page-world script stay on. Third of the three bisect switches.
    if (location.search.indexOf("ytacnoloop=1") !== -1) {
      try {
        document.documentElement.setAttribute("data-ytac-noloop", "1");
      } catch {
        /* reporting only */
      }
      return;
    }

    tick();
    // A timer alone, deliberately.
    //
    // A MutationObserver over YouTube's document fires constantly, and each
    // callback would run querySelectors — the same reflow-storm pattern that
    // made the Facebook build flicker. It buys nothing here: the stylesheet
    // hides feed ads with no JS at all, and player state is polled anyway.
    timers.push(setInterval(tick, 400));
  }

  loadLifetime();

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    if (chrome.runtime.lastError) return;
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
