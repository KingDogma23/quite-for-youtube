const DEFAULTS = {
  enabled: true,
  skipVideoAds: true,
  hideFeedAds: true,
  hideOverlays: true,
  hideMerch: false,
  stripAdSchedule: true,
  badge: false,
};

const KEYS = Object.keys(DEFAULTS);
const countEl = document.getElementById("count");
const diagEl = document.getElementById("diag");
const verEl = document.getElementById("ver");
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

/**
 * The version shown is the one running in the page, not the manifest's — those
 * differ whenever Chrome is still serving an old build after an update.
 */
function render(d) {
  if (!d) {
    verEl.textContent = "";
    countEl.textContent = "not on YouTube";
    diagEl.textContent =
      "Not running on this tab.\n\nOpen a youtube.com tab, or reload it — a " +
      "content script only attaches at page load. If you just updated the " +
      "extension, reload it on chrome://extensions first.";
    lastReport = diagEl.textContent;
    return;
  }

  verEl.textContent = "v" + d.version;
  const s = d.session;
  const total = s.videoAdsSkipped + s.videoAdsSeeked;
  countEl.textContent = String(total);

  const on = Object.entries(d.settings).filter(([, v]) => v === true).map(([k]) => k).join(", ");

  lastReport = [
    `YT Ad Cleaner v${d.version}  (page ${d.url})`,
    `on: ${on || "nothing"}`,
    d.settings.stripAdSchedule
      ? `ad schedules stripped: ${d.stripper?.adSchedulesStripped ?? "?"} ` +
        `[${d.stripper?.lastKeysStripped ?? "?"}]   (ON - expect the anti-adblock wall)`
      : `ad schedule stripping: OFF (default - avoids the anti-adblock wall)`,
    `video ads reaching playback: ${total} ` +
      `(${s.videoAdsSkipped} skipped, ${s.spedUp ?? 0} sped up, ${s.videoAdsSeeked} seeked)`,
    `false seeks reverted: ${s.falseSeeksReverted ?? 0}   (should always be 0)`,
    (s.videoAdsSkipped + s.videoAdsSeeked + (s.spedUp ?? 0) + (s.adSightings?.length ?? 0) === 0
      ? `NOTE: no ad has appeared yet this session — these zeros mean "nothing seen",\n` +
        `      not "ads handled". The video-ad path is unproven until one appears.`
      : `video-ad path has run this session`),
    `overlays closed: ${s.overlaysClosed}`,
    `last action: ${s.lastAction}`,
    `page: player=${d.page.playerFound} adNow=${d.page.adPlayingNow} ` +
      `skipBtn=${d.page.skipButtonVisible}`,
    d.page.feedAds
      ? `feed ads: ${d.page.feedAds.inDom} in DOM, ` +
        `${d.page.feedAds.stillVisible} STILL VISIBLE   (visible should be 0)`
      : `feed ads: unavailable — the page is running an OLDER content script ` +
        `than this popup. Reload the extension on chrome://extensions, then ` +
        `reload YouTube.`,
    `ad sightings captured: ${d.session.adSightings?.length ?? 0}`,
    d.session.firstAdSeen
      ? `first ad seen:\n` +
        `  player: ${d.session.firstAdSeen.playerClasses}\n` +
        `  ad classes: ${d.session.firstAdSeen.adClassesFound.join(" ") || "(none)"}\n` +
        `  markers matched: ${d.session.firstAdSeen.markerMatched.join(" ") || "(NONE - names wrong)"}\n` +
        `  skip matched: ${d.session.firstAdSeen.skipMatched.join(" ") || "(none)"}\n` +
        `  ad duration: ${d.session.firstAdSeen.videoDuration}` +
        `${typeof d.session.firstAdSeen.videoDuration === 'number' ? 's' : ''}` +
        `  adStateClass: ${d.session.firstAdSeen.adStateClass}`
      : `first ad seen: none yet (watch a video with an ad)`,
  ].join("\n");

  diagEl.textContent = lastReport;
}

async function refresh() {
  render(await tell({ type: "diagnostics" }));
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  for (const k of KEYS) document.getElementById(k).checked = stored[k];
});

for (const k of KEYS) {
  document.getElementById(k).addEventListener("change", (e) => {
    chrome.storage.sync.set({ [k]: e.target.checked });
    setTimeout(refresh, 300);
  });
}

document.getElementById("copy").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(lastReport);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy report"), 1200);
});

refresh();
