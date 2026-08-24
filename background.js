/**
 * Quiet for YouTube — session recovery.
 *
 * WHY THIS EXISTS
 *
 * Everything else in this extension can only ever PREVENT YouTube flagging a
 * session. None of it can recover one that is already flagged, and a flagged
 * session is the state a user actually complains about: the anti-adblock wall
 * arrives embedded in the page's HTML, before any script here can speak, and
 * no client-side edit can undo it — a flagged session simply is not served
 * usable stream data.
 *
 * The flag is not in localStorage and not in any cookie the page can read. It
 * rides on YouTube's HttpOnly visitor cookies, which are invisible to page
 * JavaScript and reachable only from here.
 *
 * So this does by hand what "clear cookies for this site" does, narrowed to
 * the visitor identity and nothing else.
 *
 * SAFETY
 *
 * The allowlist below is exhaustive and closed. Login cookies are never
 * touched: removing SID, APISID, SAPISID or the __Secure-*PSID family would
 * sign the user out of Google, which is a far worse outcome than an ad. Any
 * cookie not named here is left alone, and there is no wildcard.
 */

// Visitor/session identity only. Nothing here carries a login.
const CLEARABLE = [
  "VISITOR_INFO1_LIVE",
  "VISITOR_PRIVACY_METADATA",
  "YSC",
  "__Secure-YEC",
  "__Secure-ROLLOUT_TOKEN",
];

// Named explicitly so the intent is auditable, and asserted against below.
const NEVER_CLEAR = [
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO", "PREF", "SIDCC",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
];

const YT_URLS = ["https://www.youtube.com/", "https://youtube.com/", "https://m.youtube.com/"];

// One recovery per this window, so a wall that survives clearing cannot put
// the tab into a reload loop.
const COOLDOWN_MS = 10 * 60 * 1000;
const LAST_KEY = "quietLastSessionReset";

async function clearVisitorSession() {
  const now = Date.now();
  const stored = await chrome.storage.local.get({ [LAST_KEY]: 0 });
  if (now - stored[LAST_KEY] < COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", waitMs: COOLDOWN_MS - (now - stored[LAST_KEY]) };
  }

  const removed = [];
  for (const name of CLEARABLE) {
    // Belt and braces: a name that is somehow on both lists is not removed.
    if (NEVER_CLEAR.includes(name)) continue;
    for (const url of YT_URLS) {
      try {
        const gone = await chrome.cookies.remove({ url, name });
        if (gone) removed.push(name);
      } catch {
        /* a cookie that isn't there is not an error */
      }
    }
  }

  await chrome.storage.local.set({ [LAST_KEY]: now });
  return { ok: true, removed: [...new Set(removed)] };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== "clearVisitorSession") return false;
  clearVisitorSession().then(respond);
  return true; // async response
});
