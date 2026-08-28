const DEFAULTS = {
  stripAdSchedule: true,
  enabled: true,
  skipVideoAds: true,
  hideFeedAds: true,
  hideOverlays: true,
  hideMerch: false,
  badge: false,
};

const KEYS = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);
let lastReport = "";

async function tell(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}

/** Whole minutes below an hour, then hours — no false precision. */
function humanTime(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const compact = (n) =>
  n >= 10000 ? Math.round(n / 1000) + "k" : n.toLocaleString();

/**
 * All-time totals, read from storage rather than from the page.
 *
 * They used to come only from the content script, so opening the popup on any
 * tab that is not YouTube rendered zeros — the numbers were in storage the
 * whole time. A counter that reads 0 on a working extension is worse than no
 * counter, because it looks like proof that nothing is happening.
 */
async function storedLifetime() {
  // No alive() guard here: this popup never had one. The Facebook popup does,
  // and copying its body across without checking is how popup.js:47 threw
  // "alive is not defined" the moment it was opened. try/catch covers the same
  // ground — storage is undefined after an extension reload, and that throws.
  try {
    const got = await chrome.storage.local.get({ quietLifetime: null });
    return got.quietLifetime;
  } catch {
    return null;
  }
}

function render(d, stored) {
  const on = $("enabled").checked;
  $("stateText").textContent = on ? "Protection on" : "Protection off";
  $("stateSub").textContent = on
    ? "Ads removed before they load"
    : "YouTube is showing you everything";

  // Totals first, from whichever source has them: they are all-time figures and
  // do not depend on which tab is open.
  const lt = d?.lifetime || stored || { adsBlocked: 0, secondsSaved: 0, adsSkipped: 0 };
  $("sAds").textContent = compact(lt.adsBlocked || 0);
  $("sTime").textContent = humanTime(lt.secondsSaved);
  $("sClean").textContent = compact(lt.adsSkipped || 0);

  if (!d) {
    $("ver").textContent = "";
    $("diag").textContent =
      "The totals above are all-time, and this tab is not YouTube.\n\n" +
      "Open a youtube.com tab to see what is happening right now. If you are on " +
      "YouTube and still seeing this, reload the page — a content script only " +
      "attaches at page load.";
    lastReport = $("diag").textContent;
    return;
  }

  $("ver").textContent = "v" + d.version;

  const s = d.session;
  const reached = s.videoAdsSkipped + s.videoAdsSeeked;
  lastReport = [
    `Quite for YouTube v${d.version}  (page ${d.url})`,
    `all time: ${lt.adsBlocked} ads stopped, ${humanTime(lt.secondsSaved)} saved, ` +
      `${lt.adsSkipped || 0} ads skipped`,
    `on: ${Object.entries(d.settings).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}`,
    `ad payloads neutralised: ${d.rewrites ?? 0}   (0 means ads are NOT being removed)`,
    `video ads reaching playback: ${reached} ` +
      `(${s.videoAdsSkipped} skipped, ${s.spedUp ?? 0} sped up, ${s.videoAdsSeeked} seeked)`,
    `anti-adblock wall on screen: ${d.walled ? "YES" : "no"}`,
    `false seeks reverted: ${s.falseSeeksReverted ?? 0}   (should always be 0)`,
    d.page.feedAds
      ? `feed ads: ${d.page.feedAds.inDom} in DOM, ${d.page.feedAds.stillVisible} still visible`
      : `feed ads: unavailable — the page is running an OLDER content script than ` +
        `this popup. Reload the extension, then reload YouTube.`,
    `page: player=${d.page.playerFound} adNow=${d.page.adPlayingNow}`,
    `ad sightings captured: ${s.adSightings?.length ?? 0}`,
    s.firstAdSeen
      ? `first ad seen:\n  ad classes: ${s.firstAdSeen.adClassesFound.join(" ") || "(none)"}\n` +
        `  markers matched: ${s.firstAdSeen.markerMatched.join(" ") || "(NONE)"}\n` +
        `  skip matched: ${s.firstAdSeen.skipMatched.join(" ") || "(none)"}\n` +
        `  duration: ${s.firstAdSeen.videoDuration}  adStateClass: ${s.firstAdSeen.adStateClass}`
      : `first ad seen: none yet`,
  ].join("\n");

  $("diag").textContent = lastReport;
}

async function refresh() {
  const [live, stored] = await Promise.all([tell({ type: "diagnostics" }), storedLifetime()]);
  render(live, stored);
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  for (const k of KEYS) $(k).checked = stored[k];
  refresh();
});

for (const k of KEYS) {
  $(k).addEventListener("change", (e) => {
    chrome.storage.sync.set({ [k]: e.target.checked });
    setTimeout(refresh, 250);
  });
}

$("copy").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(lastReport);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy report"), 1200);
});

$("reset").addEventListener("click", (e) => {
  chrome.storage.local.set({
    quietLifetime: { adsBlocked: 0, secondsSaved: 0, adsSkipped: 0, since: Date.now() },
  });
  e.target.textContent = "Reset";
  setTimeout(() => {
    e.target.textContent = "Reset stats";
    refresh();
  }, 900);
});
