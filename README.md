# YT Ad Cleaner

A Chrome extension that removes ads from YouTube.

| | |
| --- | --- |
| **Video ads** | Skip is clicked as soon as it appears; unskippable ads are fast-forwarded. See the note below on why ads are not removed outright |
| **Feed & search ads** | Homepage, sidebar, search results, masthead banner |
| **Player overlays** | Banners drawn on top of the video |
| **Merch shelves** | Product shelves under videos (optional, off by default) |

Nothing is blocked at the network level and no requests are tampered with —
ads load, they're just skipped or hidden. Everything returns the moment you
switch it off.

## Install

Not on the Chrome Web Store, so it installs unpacked:

1. Download the latest release and unzip it. You need the **folder**.
   Keep it somewhere permanent — if you move or delete it, the extension stops working.
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the folder
5. Reload any YouTube tab you already had open

Works in Chrome, Edge, Brave and other Chromium browsers.

## Options

Click the extension icon. Changes apply immediately.

| Option | Default | What it does |
| --- | --- | --- |
| Extension on | on | Master switch |
| Skip video ads | on | Clicks Skip, seeks past unskippable ads |
| Hide feed & search ads | on | Homepage, sidebar, search, masthead |
| Hide player overlays | on | Banners on top of the video |
| Hide merch shelves | off | Product shelves under videos |
| Show status badge | off | Troubleshooting overlay |

## Worth knowing

**Feed ads never paint at all.** They're hidden by a stylesheet that loads
before the page renders, so there's no flicker and no scanning.

**Why video ads are skipped, not removed.** It is possible to remove ads
entirely by stripping the ad schedule out of the player's response before the
page reads it — and this extension can do it, off by default under
**Strip ad schedule**. It works. But YouTube checks whether the schedule it
sent came back intact and, when it has not, blocks playback with the
"Ad blockers violate YouTube's Terms of Service" wall. That was confirmed by
testing on a live account: wall with it on, no wall with it off, nothing else
changed.

So the default is the quieter approach — let the ad play and get past it. Skip
is clicked the moment it appears, unskippable ads are fast-forwarded, and
seeking is a last resort that never touches anything longer than three minutes,
because that is not an ad. You will briefly see an ad start. That is the
trade-off for playback that keeps working.

**Running two ad blockers is worse than running one.** Any network-level
blocker will trigger the same wall, and with both installed you cannot tell
which caused what.

**YouTube changes its player regularly**, and when it does, skipping can break
until the extension is updated. Expected, not a regression.

## If it stops working

Click the extension icon. The version shown is the one **actually running in
the page** — if it doesn't match what you installed, Chrome is serving an old
build: hit reload on `chrome://extensions`, then reload YouTube.

The **Diagnostics** box below it reports what it has done this session and what
it can currently see in the player, with a **Copy report** button.

## Privacy

- Runs **only** on `youtube.com`. No permission to access any other site.
- Sends nothing anywhere. No server, no analytics, no account, no tracking.
- The only thing stored is your checkbox settings.
- Never modifies your YouTube account, watch history or preferences.

## Development

### Verified against real ads

The video path is not theoretical. On a live account it handled 37 ads in one
session — 35 skipped via the button, 2 fast-forwarded where no Skip existed,
2 seeked as a last resort, and **zero false seeks**, meaning the guard that
protects your own video never misfired. The selectors it relies on
(`.ytp-skip-ad-button`, `.ytp-ad-player-overlay-layout`) were confirmed against
captured markup from those ads rather than assumed.

### Tests

There's a test harness that runs the content script unmodified against a mock
page, including a **real `<video>` element** so the skip and seek logic is
genuinely exercised rather than mocked:

```bash
python3 -m http.server 8732
```

Then open <http://localhost:8732/test/mock-youtube.html>. It covers the
stylesheet hiding, the merch opt-in, a skippable ad, an unskippable ad, the
overlay-close fallback, and the master switch restoring everything.

## Diagnostics

Click the extension icon. It reports the version **actually running in the
page**, what it has done this session, and — the first time it meets an ad —
the real markup of that ad. **Copy report** puts it on the clipboard.

Two lines are worth knowing:

- `false seeks reverted` should always be **0**. Anything else means detection
  was wrong and your playhead was restored — report it.
- `feed ads: N in DOM, 0 STILL VISIBLE` is healthy. Ad elements remaining in
  the DOM is normal; the stylesheet hides them rather than removing them.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with YouTube or Google.
