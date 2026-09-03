# Quite for YouTube

A Chrome extension that quiets ads on YouTube.

| | |
| --- | --- |
| **Video ads** | Muted and covered while they run, so you neither see nor hear them |
| **Feed & search ads** | Homepage, sidebar, search results, masthead banner |
| **Player overlays** | Banners drawn on top of the video |
| **Merch shelves** | Product shelves under videos (optional, off by default) |

The advert still plays, and that is deliberate. Removing it, skipping it, or
seeking past it all stop the video from starting at all, so none of those is
attempted — the trade is a video that works. While the advert runs it is
silenced and covered, and the wait is the cost. No requests are blocked and
nothing is delayed.

Skipping and fast-forwarding remain in the code behind a switch, off by
default, for measurement.

**Running two ad blockers is worse than running one.** Any network-level
blocker will trigger the same wall, and with both installed you cannot tell
which caused what.

**YouTube changes its player regularly**, and when it does, the muting and
covering can break until the extension is updated. Expected, not a regression.

## If it stops working

Click the extension icon. The version shown is the one **actually running in
the page** — if it doesn't match what you installed, Chrome is serving an old
build: hit reload on `chrome://extensions`, then reload YouTube.

The **Diagnostics** box below it reports what it has done this session and what
it can currently see in the player, with a **Copy report** button.

## Privacy

- Runs **only** on `youtube.com`. No permission to access any other site.
- No server, no analytics, no account, no tracking. Nothing is sent to us.
- Stored: your checkbox settings, and a count of what has been skipped or
  hidden. Settings use Chrome's own extension-settings sync, so with Chrome
  sync switched on they travel with your Chrome profile, as any extension's
  settings do. The per-hop diagnostic log is off unless you turn it on.
- Never modifies your YouTube account, watch history or preferences.

## Development

### Verified against real ads

The video path is not theoretical. On a live account, adverts were detected,
silenced and covered while they played, counted, and released cleanly the
moment they ended — with the video still playing throughout and **zero false
seeks**, meaning the guard that protects your own video never misfired.
Everything it relies on was confirmed against captured markup from real adverts
rather than assumed.

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

## Elsewhere

- [quiteapps.co.uk](https://quiteapps.co.uk/) — the other extensions in the family
- [facebook.com/quiteapps](https://www.facebook.com/quiteapps/) — where breakages get
  announced. When the site this extension runs on changes its markup, the fix takes
  hours and clearing store review takes days; that is where the gap gets explained.

## Licence

MIT — see [LICENSE](LICENSE).

YouTube™ is a trademark of Google LLC. This extension is an
independent project and is not affiliated with, endorsed by or sponsored
by Google LLC.
