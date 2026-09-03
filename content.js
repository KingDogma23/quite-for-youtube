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

  // A LITERAL, deliberately, and package.sh refuses to build if it disagrees
  // with manifest.json.
  //
  // getManifest() returns the version of the LOADED extension, not of the code
  // executing. Reload the extension without refreshing the page and this old
  // content script reports the NEW version while running the OLD logic — it
  // lies about exactly the thing CLAUDE.md's first gate exists to check, and
  // twice a result was reported from a build that was not running.
  const VERSION = "0.31.36";

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
        // EVER hidden and hidden RIGHT NOW are different questions, and only
        // publishing the first made every reading after one backgrounding look
        // void. Measured 2026-08-29: data-ytac-hidden read 1 on a foreground
        // tab whose readings were fine. A validity flag that never clears gets
        // ignored, and then it protects nothing.
        root.setAttribute(
          "data-ytac-hidden-now",
          document.visibilityState === "hidden" ? "1" : "0",
        );
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

    /**
     * A day's worth of hops, not the last twelve.
     *
     * The hop log lives in a page attribute, so it dies on every page load and
     * holds twelve entries. Adverts are occasional — twelve clicked hops
     * produced none — so answering "do the hops carrying adSlots show ads"
     * needs a record spanning hours, gathered from whichever tab the viewer
     * actually used rather than the one instrumented for a test.
     *
     * chrome.storage is shared by every tab's content script, so the history
     * accumulates from all of them.
     *
     * It used to be mirrored onto the page as data-ytac-history so it could be
     * read without opening the extension. That was convenient for me and wrong
     * for the user: it handed YouTube's own scripts — and any other extension
     * on the page — up to four hundred entries of what had been watched, in one
     * attribute, which is exactly the record someone who turns YouTube's watch
     * history off has decided not to hand over. Worse, historyOn lives in
     * storage.session and the log lives in storage.local, so after a restart
     * the switch read off while the log was still there and still being
     * published. Only the COUNT is published now. Nothing in this extension
     * ever read the full attribute; it existed solely for reading off the DOM.
     */
    const HISTORY_KEY = "ytacHistory";
    const HISTORY_MAX = 400;

    /**
     * Off unless asked for.
     *
     * This record contains the video id and timestamp of every hop, which is a
     * viewing history. It was built to answer a question about adverts on one
     * machine, with the owner's knowledge. Shipping it on by default would mean
     * an extension whose listing says it collects nothing quietly keeping four
     * hundred entries of what its users watched.
     *
     * ?ytachistory=1 turns it on for the browser session — storage.session
     * clears itself when Chrome closes, so it cannot be left on by accident.
     */
    let historyOn = false;
    if (contextAlive()) {
      try {
        if (location.search.indexOf("ytachistory=1") !== -1) {
          historyOn = true;
          chrome.storage.session.set({ ytacHistoryOn: true });
        } else {
          chrome.storage.session.get({ ytacHistoryOn: false }, (got) => {
            historyOn = !!got.ytacHistoryOn;
          });
        }
      } catch {
        /* stays off */
      }
    }
    let historyChain = Promise.resolve();

    function remember(hop) {
      if (!historyOn || !contextAlive()) return;
      historyChain = historyChain
        .then(
          () =>
            new Promise((done) => {
              chrome.storage.local.get({ [HISTORY_KEY]: [] }, (got) => {
                // Serialised: concurrent hops each doing get-then-set lose
                // entries, which is how the cookie extension's log quietly
                // dropped its own readings under load.
                const log = got[HISTORY_KEY] || [];
                log.push(
                  [
                    new Date().toISOString().slice(11, 19),
                    hop.id,
                    hop.play === null ? "abandoned" : `${hop.play}ms`,
                    hop.sched || "-",
                    hop.health || "-",
                  ].join("|"),
                );
                chrome.storage.local.set(
                  { [HISTORY_KEY]: log.slice(-HISTORY_MAX) },
                  () => done(),
                );
              });
            }),
        )
        .catch(() => {});
    }

    function mirrorHistory() {
      if (!contextAlive()) return;
      try {
        chrome.storage.local.get({ [HISTORY_KEY]: [] }, (got) => {
          try {
            const log = got[HISTORY_KEY] || [];
            root.setAttribute("data-ytac-history-n", String(log.length));
            // The log itself is deliberately NOT published — see above. Read it
            // from chrome.storage.local under "ytacHistory" instead, which the
            // page cannot reach.
            root.removeAttribute("data-ytac-history");
          } catch {
            /* reporting only */
          }
        });
      } catch {
        /* reporting only */
      }
    }

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
            remember(hop);
            mirrorHistory();
          } catch {
            /* reporting only */
          }
        }, 1000);
      }, 5000);
    }

    // Mirror once on load, and periodically. The first version only mirrored
    // after a hop completed, so a feed page — or any page where nothing was
    // watched — carried no history attribute at all, and a reader defaulting a
    // missing attribute to "0" reported an empty day when the day was recorded.
    mirrorHistory();
    setInterval(mirrorHistory, 30000);

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
      const hop = hops[hops.length - 1];
      watchHealth(hop);
      // A hop the viewer leaves before six seconds never gets a health reading,
      // and those are worth keeping too — recorded here, overwritten above if
      // the reading does arrive.
      setTimeout(() => {
        if (!hop.health) {
          remember(hop);
          mirrorHistory();
        }
      }, 9000);
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

  // The watch id, falling back to the path so two different non-watch pages
  // are not mistaken for the same "video".
  const currentVideoId = () =>
    (location.search.match(/[?&]v=([\w-]{11})/) || [])[1] || location.pathname;
  let lifetime = { adsBlocked: 0, leaked: 0, secondsSaved: 0, adsSkipped: 0,
    adsPlayedThrough: 0, since: null, blockedFixed: false };
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
      // Before 0.31.0 adsBlocked was incremented alongside adsSkipped, so every
      // stored value is a copy of the skip count rather than a measurement of
      // anything. Carrying it forward would leave the popup showing a number
      // that was never true under a label that now means something specific.
      // Zeroed once, and only once — `blockedFixed` marks the profile done, so
      // a genuine count is never wiped by a later reload.
      if (!lifetime.blockedFixed) {
        lifetime.adsBlocked = 0;
        lifetime.blockedFixed = true;
        lifetimeDirty = true;
      }
    });
  }

  /**
   * An ad that got through and was dealt with in the player.
   *
   * Both callers are that case — Skip was clicked, or the ad was
   * fast-forwarded. This used to increment adsBlocked on the line above as
   * well, so the two counters could never diverge and the popup showed one
   * number under two labels that promise different things. adsBlocked is now
   * credited by creditStoppedSchedules(), which watches a different event
   * entirely: ads stopped before they ever reached the player.
   */
  // Declared above its first use in recordAd(): `let` has a temporal dead
  // zone, so a declaration further down the file throws if an ad is recorded
  // during init rather than merely reading as undefined.
  let vid = { id: null, rewrote: false, adSeen: false };

  // One advert, one credit.
  //
  // handleVideoAd() runs on every tick while an advert is on screen, and both
  // its branches called recordAd(). A skip button that stays visible for two
  // ticks, or a seek that needs a second attempt, therefore counted the SAME
  // advert again — and again. Measured 2026-08-30 on the test profile: about
  // 400 automated loads produced "6,354 ads skipped" and "245h 48m saved",
  // against a measured advert rate of roughly 6%. The figure was impossible.
  //
  // vid.adSeen existed and was set here, but nothing ever read it to stop the
  // double count; it feeds the protected/leaked verdict only. adCredited is
  // reset when the advert clears (see tick), so a genuine mid-roll later in the
  // same video is still counted once.
  let adCredited = false;
  // When the advert state last went quiet. adIsPlaying() flickers while a skip
  // or a seek lands — the overlay disappears for a tick and comes back — so a
  // flag reset the instant it reads false credits the SAME advert several
  // times. Measured 2026-08-30 over 35 loads: 9 adverts produced 28 credits
  // with a bare flag, against 148 with no guard at all. An advert only counts
  // as finished once it has been absent for this long.
  let adGoneSince = 0;
  const AD_GAP_MS = 3000;

  /**
   * The played-through count, on the page.
   *
   * Everything else about this build can be read from an attribute; this — the
   * number that says what the trade COSTS — could only be read by copying a
   * popup report by hand, which is why a false 0 survived a live test.
   */
  /**
   * Published as "0" at start, deliberately.
   *
   * An ABSENT attribute and a zero count are different states — "no advert has
   * appeared yet" versus "this code never ran" — and letting them collapse into
   * one reading is what produced two false verdicts today. Presence proves the
   * counter is live; the value is the count.
   */
  /**
   * QUIET ADS — mute and cover the advert instead of removing it.
   *
   * Every mechanism that REMOVES the advert was measured on 2026-09-03 to wall
   * the video: the parse-time prune, the response rewrite, the skip/seek loop,
   * and display:none on the ad containers. What did NOT wall it was hiding the
   * containers with opacity — leaving YouTube's own machinery reading normal
   * and changing only what the viewer sees.
   *
   * This is that same idea applied to the video advert. The advert plays in
   * full: nothing is skipped, no field is deleted, no request is touched, the
   * duration and the telemetry are exactly what they would be with no
   * extension installed. It is muted and covered, so it is not heard and not
   * seen.
   *
   * The wait remains, and that is the honest limit of it — this does not get
   * the viewer's time back, it gets their attention back.
   *
   * ?ytacnoquiet=1 turns it off.
   */
  const QUIET_OFF = location.search.indexOf("ytacnoquiet=1") !== -1;
  let coverEl = null;
  let mutedByUs = false;
  let priorMuted = null;

  function quietAd(p, video) {
    if (QUIET_OFF || !p || !video) return;

    if (!mutedByUs) {
      priorMuted = video.muted;
      mutedByUs = true;
    }
    // Re-asserted every tick: the player restores its own volume state at ad
    // boundaries, and a one-shot mute is silently undone a second later.
    if (!video.muted) video.muted = true;

    if (!coverEl || !coverEl.isConnected) {
      coverEl = document.createElement("div");
      coverEl.id = "ytac-ad-cover";
      const label = document.createElement("div");
      label.className = "ytac-ad-cover__label";
      label.textContent = "Ad — muted and hidden";
      coverEl.appendChild(label);
      p.appendChild(coverEl);
    }
    // During a genuine advert video.duration IS the advert's length, because the
    // player swaps the media. On a live stream it is the whole broadcast, and
    // the first version of this label read "· 8725s" on a 2h26m stream. Show a
    // countdown only when the number is plausible for an advert; anything above
    // MAX_AD_SECONDS means duration is not measuring what this assumes, and a
    // wrong number is worse than no number.
    //
    // Verified on the page that produced the fault — the same 2h26m stream,
    // video.duration 8772, ad condition set: the cover read "Ad — muted and
    // hidden" with no seconds at all, where the previous build read "· 8725s".
    const raw = Number.isFinite(video.duration)
      ? Math.max(Math.ceil(video.duration - video.currentTime), 0)
      : null;
    const left = raw !== null && raw <= MAX_AD_SECONDS ? raw : null;
    const label = coverEl.firstChild;
    if (label) {
      label.textContent =
        left === null ? "Ad — muted and hidden" : `Ad — muted and hidden · ${left}s`;
    }
  }

  /** Undo it the moment the advert is gone, and restore the viewer's own mute. */
  function unquietAd() {
    if (coverEl) {
      coverEl.remove();
      coverEl = null;
    }
    if (mutedByUs) {
      const v = document.querySelector(".html5-video-player video");
      // Only hand back the state we found. If the viewer muted it themselves
      // mid-advert, priorMuted is what they had BEFORE, so honour their action
      // instead: leave a muted player muted only if that is what they chose.
      if (v && priorMuted === false && v.muted) v.muted = false;
      mutedByUs = false;
      priorMuted = null;
    }
  }

  function publishPlayedThrough() {
    try {
      document.documentElement.setAttribute(
        "data-ytac-adsplayed",
        String(session.videoAdsPlayedThrough),
      );
    } catch {
      /* reporting only */
    }
  }

  function recordAd(seconds) {
    vid.adSeen = true;
    if (adCredited) return;
    adCredited = true;
    lifetime.adsSkipped = (lifetime.adsSkipped || 0) + 1;
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 600) {
      lifetime.secondsSaved += seconds;
    }
    lifetimeDirty = true;
  }

  /**
   * Videos whose ad keys were neutralised in the player response.
   *
   * This used to say "stopped at source, before the player saw it", which the
   * measurements of 2026-08-30 disproved. Neutralising the keys does NOT stop
   * the advert: on load fLexgOxsZu0 every key this extension knows about had
   * been neutralised and the advert played anyway, and across 200 controlled
   * loads the rewrite made no difference to whether one appeared (1/20 escaped
   * with it against 1/35 without, p = 0.60). What the advert costs is the SABR
   * backoff, and that is a separate mechanism behind ?ytacsabr=.
   *
   * So this counts responses this extension rewrote — real work, honestly
   * counted — and not adverts prevented. Nothing user-facing should describe it
   * as the latter.
   *
   * inject.js runs in the page and cannot reach chrome.storage, but it already
   * publishes a monotonic count of neutralised player responses on
   * data-ytac-rewrites. Read the RISE in that number rather than the number
   * itself, so a count that was already there before this script started
   * polling is still picked up.
   *
   * Credited once per video. One video can produce several neutralised
   * responses — the client-identity retry is one, returning to the same watch
   * page is another — and counting each would inflate the figure with work
   * done twice on a single video. The unit is therefore the video, which is
   * what the "Videos protected" label promises.
   */
  let lastRewrites = 0;

  /**
   * Neutralisations across EVERY path. Reading data-ytac-rewrites alone was why
   * this credited nothing: that attribute counts cold loads, and a CLICKED video
   * is rewritten on the fetch path, which publishes to data-ytac-rewrote. The
   * counter was blind to the only path real use takes. Measured 2026-08-29
   * on 0.31.1: fetch=3 neutralised, 0 videos credited.
   */
  function totalRewrites() {
    const root = document.documentElement;
    const cold = Number(root.getAttribute("data-ytac-rewrites") || 0);
    const net = String(root.getAttribute("data-ytac-rewrote") || "").match(
      /\d+/g,
    );
    const sum = (net || []).reduce((a, b) => a + Number(b), 0);
    return (Number.isFinite(cold) ? cold : 0) + sum;
  }

  /**
   * Per-video verdict, settled against what was WITNESSED.
   *
   * A neutralised payload is not proof an ad was stopped. The same 0.31.1
   * session recorded fetch=3 neutralisations and 19 ads reaching playback, so
   * crediting on the rewrite alone would build a counter that flatters — the
   * exact fault this file has now shipped twice. Each video is therefore settled
   * on the way out:
   *
   *   rewrote && !adSeen  -> protected  (the only claim we are entitled to make)
   *   rewrote &&  adSeen  -> leaked     (rewrite fired, the ad played anyway)
   *
   * Both are stored. If "leaked" outruns "protected", the response rewrite is
   * not doing the job the store summary claims, and the summary is what changes.
   *
   * Settling happens when the video id changes, which is the common case here
   * (clicking on from a watch page). A tab closed mid-video may lose its last
   * verdict to the 5s storage flush; that undercounts both sides equally and is
   * not worth a synchronous write to fix.
   */

  function settleVideo() {
    if (!vid.id || !vid.rewrote) return;
    if (vid.adSeen) lifetime.leaked = (lifetime.leaked || 0) + 1;
    else lifetime.adsBlocked = (lifetime.adsBlocked || 0) + 1;
    lifetimeDirty = true;
  }

  function creditStoppedSchedules() {
    const id = currentVideoId();
    if (id !== vid.id) {
      settleVideo();
      vid = { id, rewrote: false, adSeen: false };
    }
    const n = totalRewrites();
    if (!Number.isFinite(n)) return;
    if (n > lastRewrites) vid.rewrote = true;
    lastRewrites = n;
  }

  addEventListener("pagehide", settleVideo);

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
    // Adverts that reached playback and were NOT acted on. This is the headline
    // cost of the current default and it needs its own counter: the popup used
    // to derive "video ads reaching playback" as skipped + seeked, which with
    // skipping off is permanently 0 — a number that could never report the
    // thing it named. Two mid-rolls were sat through and the report said 0.
    videoAdsPlayedThrough: 0,
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

  /**
   * Skipping and seeking past a video advert is OFF by default since 0.31.25,
   * and gated here rather than on settings.skipVideoAds so a stored setting
   * cannot switch it back on.
   *
   * Bisected on the live site 2026-09-03, each arm against a clean baseline
   * confirmed immediately before it:
   *
   *   inject OFF, stylesheet ON,  loop ON   WALL, readyState 0
   *   inject OFF, stylesheet OFF, loop ON   WALL — and ttff shows the video
   *                                         PLAYED first (playing=4604,
   *                                         advancing=4853) and was walled
   *                                         afterwards
   *
   * The second arm has inject.js off and every CSS gate set, so the loop is
   * the only thing left running, and it walls on its own. The ttff shape says
   * how: the advert starts, this function seeks past it, and the wall replaces
   * a player that was already advancing.
   *
   * That is the whole trade. Skipping the advert is what costs the video, and
   * ~60 versions aimed at the response and network path never touched the part
   * that actually trips it. ?ytacskip=1 turns it back on for measurement.
   */
  const SKIP_ON = location.search.indexOf("ytacskip=1") !== -1;

  function handleVideoAd() {
    if (!settings.skipVideoAds || !adIsPlaying()) {
      // Only treat the advert as finished after a sustained gap, so the flicker
      // around a skip or seek does not re-open crediting mid-advert. A genuine
      // second advert — a pod, or a mid-roll later on — is still counted, since
      // the gap between them exceeds this.
      if (!adGoneSince) adGoneSince = Date.now();
      else if (Date.now() - adGoneSince > AD_GAP_MS) adCredited = false;
      unquietAd();
      return;
    }
    adGoneSince = 0;

    const p = player();

    // COUNT FIRST, ACT SECOND. 0.31.25 gated the whole function on SKIP_ON, so
    // with skipping off the extension stopped counting the adverts it could
    // plainly see: a report on 2026-09-03 said "video ads reaching playback: 0"
    // while carrying 3 ad sightings and a matched .ytp-skip-ad-button. An
    // advert that reaches playback is the headline number of this build — it is
    // what the trade COSTS — so it is recorded whether or not we may act.
    if (!SKIP_ON) {
      // NOT recordAd(): that credits lifetime.adsSkipped and secondsSaved, and
      // nothing was skipped and no time was saved. Claiming either would be the
      // extension taking credit for an advert the viewer sat through.
      quietAd(p, p.querySelector("video"));
      vid.adSeen = true;
      if (!adCredited) {
        adCredited = true;
        session.videoAdsPlayedThrough++;
        lifetime.adsPlayedThrough = (lifetime.adsPlayedThrough || 0) + 1;
        lifetimeDirty = true;
        publishPlayedThrough();
      }
      session.lastAction = "ad played through (skipping off — it triggers the wall)";
      return;
    }

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

    // ?ytacnocss=1 takes down the feed rules and the in-player overlay rules
    // together, and they are very different things: the feed rules hide ad
    // containers out in the page, the overlay rules hide nodes INSIDE the
    // player. On 2026-09-03 the stylesheet as a whole was measured to wall the
    // video before it ever starts (ttff empty, readyState 0), so these two
    // switches exist to say WHICH half does it — the feed hiding is the only
    // function of this extension that is not implicated in the wall, and it
    // should not be thrown away on a guess.

    // The watch page's ad slots are hidden with opacity instead of display, so
    // offsetHeight and offsetParent still read normal. ON by default since
    // 0.31.32, measured on three videos; ?ytacnosofthide=1 turns it off.
    if (location.search.indexOf("ytacnosofthide=1") !== -1) {
      root.setAttribute("data-ytac-nosofthide", "1");
    } else {
      root.removeAttribute("data-ytac-nosofthide");
    }

    const noFeed = location.search.indexOf("ytacnofeed=1") !== -1;
    const noOverlay = location.search.indexOf("ytacnooverlay=1") !== -1;

    off("data-ytac-feed-off", on && settings.hideFeedAds && !noCss && !noFeed);
    off("data-ytac-overlay-off", on && settings.hideOverlays && !noCss && !noOverlay);
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
      creditStoppedSchedules();
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
    // Stamp the counter at zero so "no advert yet" cannot read as "never ran".
    publishPlayedThrough();

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

    // Chrome throttles setInterval in a hidden tab — to once a second, and in a
    // heavily throttled tab once a MINUTE. The skip below runs on a 400ms tick,
    // so an advert that appears while you are in another tab can sit unskipped
    // for up to a minute, and is still sitting there when you come back. That is
    // the shape of the complaint on 2026-08-29: an advert on screen with its
    // Skip button already showing, on a report whose own validity line read
    // hidden=1.
    //
    // Ticking on visibilitychange costs nothing and fires the moment the tab is
    // looked at, instead of whenever the throttled timer next happens to run.
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") tick();
      });
    } catch {
      /* the timer below still covers it, just later */
    }

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
        // WHICH ARM THIS IS. Without these two the report cannot tell a
        // bypassed run from a live one, and on 2026-09-02 a set of skip/rate
        // numbers was reported from a rig where the content script had never
        // run at all. A hidden tab reads zero-size rects and a frozen player,
        // so a reading taken in one is VOID, not merely odd.
        bypassed:
          document.documentElement.getAttribute("data-ytac-bypassed") === "1",
        tabHidden: document.documentElement.getAttribute("data-ytac-hidden"),
        settings: { ...settings },
        session: { ...session },
        lifetime: { ...lifetime },
        rewrites: Number(
          document.documentElement.getAttribute("data-ytac-rewrites") || 0
        ),
        // The cold-load counter above is not the whole story, and reporting it
        // alone has misled twice now. data-ytac-rewrote counts the fetch and XHR
        // path — where a CLICKED video goes, and where the cold-load counter is
        // legitimately zero. Read both or neither.
        rewrote:
          document.documentElement.getAttribute("data-ytac-rewrote") || "fetch=0,xhr=0",
        switches:
          document.documentElement.getAttribute("data-ytac-switches") || "none",
        hiddenNow:
          document.documentElement.getAttribute("data-ytac-hidden-now") || "?",
        hiddenEver:
          document.documentElement.getAttribute("data-ytac-hidden") || "?",
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
          // Container rules hide a whole section so no empty gap is left, which
          // is only safe while the section holds nothing but ads. On 2026-08-29
          // the ytd-item-section-renderer rule was measured hiding the watch
          // sidebar with 24 real videos inside it, and nothing reported that —
          // it surfaced as "the videos list disappeared". This counts what our
          // OWN rules are swallowing, so a recurrence arrives as a number.
          swallowed: (() => {
            // A hidden subtree swallowed content if it holds a link to a real
            // video that is not part of an ad. Counting VIDEO IDS, not elements
            // or links: one search result carries several links, and a link
            // count reported 108 on a 24-result page during the red team.
            //
            // The list below is every rule in content.css that hides something
            // larger than the ad itself. It was three; a red team on 2026-08-29
            // found the other four unwatched, so a swallow by any of them would
            // have been reported as "none" — the instrument unable to report
            // the one fault it exists for.
            const CONTAINERS = [
              "ytd-item-section-renderer:has(> #contents > ytd-ad-slot-renderer):not(:has(> #contents > *:not(ytd-ad-slot-renderer)))",
              "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)",
              "ytd-engagement-panel-section-list-renderer:has(ytd-ad-slot-renderer)",
              "ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)",
              "#contents > ytd-rich-item-renderer:has(> ytd-ad-slot-renderer)",
              "ytd-compact-video-renderer:has(ytd-ad-slot-renderer)",
              "#shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)",
            ];
            const idsIn = (el) => {
              const found = [];
              for (const a of el.querySelectorAll(
                'a[href*="/watch?v="], a[href^="/shorts/"]',
              )) {
                if (a.closest("ytd-ad-slot-renderer, ad-slot-renderer")) continue;
                const m = (a.getAttribute("href") || "").match(
                  /(?:v=|\/shorts\/)([\w-]{6,})/,
                );
                if (m) found.push(m[1]);
              }
              return found;
            };
            const hits = [];
            for (const sel of CONTAINERS) {
              const seen = new Set();
              try {
                for (const el of document.querySelectorAll(sel))
                  for (const id of idsIn(el)) seen.add(id);
              } catch {
                continue;
              }
              if (seen.size) hits.push(`${sel.split(":")[0].trim()}=${seen.size}`);
            }
            return hits.length ? hits.join(" ") : "none";
          })(),
        },
      });
    }
    return true;
  });
})();
