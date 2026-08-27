# Quite for YouTube

A Chrome extension that removes ads from YouTube.

| | |
| --- | --- |
| **Video ads** | Skip is clicked as soon as it appears; unskippable ads are fast-forwarded |
| **Feed & search ads** | Homepage, sidebar, search results, masthead banner |
| **Player overlays** | Banners drawn on top of the video |
| **Merch shelves** | Product shelves under videos (optional, off by default) |

On most videos no ad is ever queued for the player. On the rest the ad plays
and is skipped instead — removing those outright stops the video from starting
at all, so it isn't attempted. No requests are blocked and nothing is delayed.

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

## Support

This is free and has no ads, no tracking and no accounts. If it saves you some
irritation, you can [buy me a coffee](https://buymeacoffee.com/kingdogma23).
It is an ordinary link — nothing is sent anywhere unless you click it.

## Licence

MIT — see [LICENSE](LICENSE).

YouTube™ is a trademark of Google LLC. This extension is an
independent project and is not affiliated with, endorsed by or sponsored
by Google LLC.
