# Quiet for YouTube

A Chrome extension that removes ads from YouTube.

| | |
| --- | --- |
| **Video ads** | Skip is clicked as soon as it appears; unskippable ads are fast-forwarded. See the note below on why ads are not removed outright |
| **Feed & search ads** | Homepage, sidebar, search results, masthead banner |
| **Player overlays** | Banners drawn on top of the video |
| **Merch shelves** | Product shelves under videos (optional, off by default) |

No network-level blocking and no filter lists. Everything returns the moment
you switch it off.

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
| Strip ad schedule | on | Stops ads being queued for the player at all |
| Hide feed & search ads | on | Homepage, sidebar, search, masthead |
| Hide player overlays | on | Banners on top of the video |
| Hide merch shelves | off | Product shelves under videos |
| Show status badge | off | Troubleshooting overlay |

## Worth knowing

**Feed ads never paint at all.** They are hidden before the page renders, so
there is no flicker.

**Two ways to deal with video ads, and one is opt-in.**

The default is to let the ad start and get past it: Skip is clicked the moment
it appears, unskippable ads are fast-forwarded, and seeking is a last resort
that never touches anything longer than three minutes, because that is not an
ad. You briefly see an ad begin. Verified on live ads — 37 in one session, 35
skipped, 2 fast-forwarded, 2 seeked, zero false seeks.

**Strip ad schedule** (on by default) stops ads being queued for the player in
the first place, so most never reach playback at all. Verified against real
sessions with zero ads reaching the player. Whether YouTube reliably detects it
is unresolved: an
anti-adblock wall appeared during testing, but a second, network-blocking ad
blocker was installed at the time and YouTube's flag persists across reloads,
so the two were never cleanly separated. It has since run without a wall. If you ever see
one, turn this off first — it is the most likely cause, and the skip/fast-forward
path below keeps working without it.

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
protects your own video never misfired. Everything it relies on was confirmed
against captured markup from those ads rather than assumed.

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
