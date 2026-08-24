const DEFAULTS = {
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

function render(d) {
  const on = $("enabled").checked;
  $("stateText").textContent = on ? "Protection on" : "Protection off";
  $("stateSub").textContent = on
    ? "Ads removed before they load"
    : "YouTube is showing you everything";

  if (!d) {
    $("ver").textContent = "";
    $("diag").textContent =
      "Not running on this tab.\n\nOpen a youtube.com tab, or reload it — a " +
      "content script only attaches at page load. If you just updated the " +
      "extension, reload it on chrome://extensions first.";
    lastReport = $("diag").textContent;
    return;
  }

  $("ver").textContent = "v" + d.version;

  const lt = d.lifetime || { adsBlocked: 0, secondsSaved: 0, adsSkipped: 0 };
  $("sAds").textContent = compact(lt.adsBlocked || 0);
  $("sTime").textContent = humanTime(lt.secondsSaved);
  $("sClean").textContent = compact(lt.adsSkipped || 0);

  const s = d.session;
  const reached = s.videoAdsSkipped + s.videoAdsSeeked;
  lastReport = [
    `Quiet for YouTube v${d.version}  (page ${d.url})`,
    `all time: ${lt.adsBlocked} ads stopped, ${humanTime(lt.secondsSaved)} saved, ` +
      `${lt.adsSkipped || 0} ads skipped`,
    `on: ${Object.entries(d.settings).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}`,
    `video ads reaching playback: ${reached} ` +
      `(${s.videoAdsSkipped} skipped, ${s.spedUp ?? 0} sped up, ${s.videoAdsSeeked} seeked)`,
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
  render(await tell({ type: "diagnostics" }));
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
