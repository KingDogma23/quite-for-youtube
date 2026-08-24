/**
 * Quiet for YouTube — outbound player-request rewrite.
 *
 * WHAT THIS IS, AND WHY IT IS NOT WHAT WAS HERE BEFORE
 *
 * Earlier versions edited the player RESPONSE: deleting the ad schedule, and
 * later rewriting playabilityStatus to undo YouTube's anti-adblock block. Both
 * failed, and failed in an instructive way:
 *
 *   - Deleting ads from the response gets the session flagged. YouTube's flag
 *     is sticky for minutes, which made every test unreadable.
 *   - Rewriting the block client-side produces a video that will not play at
 *     all, because a flagged session is not served usable stream data. The
 *     decision is made server-side; there is nothing on this end to repair.
 *
 * This takes the opposite approach, and it is the one used by the maintained
 * ad blockers: change the REQUEST, not the response. When the page serialises
 * a player request, the client screen is declared as an ad unit rather than a
 * watch page. YouTube then answers with a response that carries no ad schedule
 * of its own. Nothing is deleted, nothing is faked, and there is no mismatch
 * between what the server sent and what the player sees — which is precisely
 * what the integrity check looks for.
 *
 * Taken from uBlock Origin's `trusted-replace-outbound-text` scriptlet, which
 * is the published, open form of this technique. Only the technique is used;
 * no code was copied from any other extension.
 *
 * Every path is wrapped so any failure returns the untouched string: a broken
 * YouTube is far worse than an ad.
 */

(() => {
  "use strict";

  // The exact substitutions. Both are narrow string replacements on the
  // serialised request; anything that does not contain them is untouched.
  const REWRITES = [
    ['"clientScreen":"WATCH"', '"clientScreen":"ADUNIT"'],
    [
      'isWebNativeShareAvailable":true}}',
      'isWebNativeShareAvailable":true},"clientScreen":"ADUNIT"}',
    ],
  ];

  let rewrites = 0;

  /** Off switch, read from the DOM: chrome.storage is unreachable from here. */
  function off() {
    try {
      return (
        document.documentElement.hasAttribute("data-ytac-all-off") ||
        document.documentElement.hasAttribute("data-ytac-strip-off")
      );
    } catch {
      return false;
    }
  }

  function publish() {
    try {
      document.documentElement.setAttribute("data-ytac-rewrites", String(rewrites));
    } catch {
      /* reporting must never break a request */
    }
  }

  const nativeStringify = JSON.stringify;

  JSON.stringify = function (...args) {
    const out = nativeStringify.apply(this, args);
    try {
      if (off() || typeof out !== "string") return out;
      for (const [from, to] of REWRITES) {
        if (out.includes(from)) {
          rewrites++;
          publish();
          return out.replace(from, to);
        }
      }
    } catch {
      /* fall through to the original string */
    }
    return out;
  };

  // Keep the patched function indistinguishable from the original when the
  // page inspects it — some players check.
  try {
    Object.defineProperty(JSON.stringify, "name", { value: "stringify" });
    JSON.stringify.toString = () => nativeStringify.toString();
  } catch {
    /* cosmetic only */
  }

  Object.defineProperty(window, "__ytacRewrites", { get: () => rewrites });
})();
