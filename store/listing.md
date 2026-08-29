# Chrome Web Store submission — Quite for YouTube™

Publisher: **Quite Apps**  ·  Contact: **support@quiteapps.co.uk**
Source: **github.com/KingDogma23/quite-for-youtube**
Package: `dist/yt-ad-cleaner-<version>-store.zip` (built with `./package.sh --store`)

> The zip is named from the working directory, which is still `yt-ad-cleaner` while
> the repository is `quite-for-youtube`. Harmless, but do not let it read as a
> different extension from the one being submitted.

## Summary (132 characters max)

Removes YouTube ads: skips video ads, and hides feed, sidebar, search and
Shorts ad panels. No accounts, no tracking.

## Description

Quite for YouTube is a YouTube ad blocker that does one job. It stops most video
ads loading, skips or fast-forwards the ones that still appear, and hides the ad
panels in the feed, sidebar, search results and Shorts. It does nothing else.

- Video ads: Skip is clicked as soon as it appears, and unskippable ads are
  fast-forwarded.
- Feed, sidebar, search and Shorts ad panels are hidden before they paint, so
  the page does not jump as they disappear.
- Banner overlays on top of the video are dismissed.
- Merch shelves under videos can be hidden too (off by default).

Every option can be switched off individually, and the whole extension has a
single on/off switch.

It runs only on youtube.com. It has no account, no server and no analytics,
and it never sends anything anywhere. The only thing it stores is which of the
checkboxes you have ticked.

YouTube changes its player regularly. When that happens some skipping can stop
working until the extension is updated — the extension is built to fail
towards "an ad gets through" rather than towards a broken video.

## Trademark attribution

Include verbatim at the end of the store description:

> YouTube™ is a trademark of Google LLC. This extension is an
> independent project and is not affiliated with, endorsed by or
> sponsored by Google LLC.

## Category

Functionality & UI

## Single purpose statement

The single purpose of this extension is to remove advertising from youtube.com
— both the ad elements on the page and the ads that play before and during a
video.

## Permission justifications

- **storage** — remembers which options the user has ticked, and the counters
  shown in the popup. Nothing else is stored, and nothing leaves the browser.
- **host permission `*://*.youtube.com/*`** — the extension must read and
  modify the YouTube page in order to hide ad panels and operate the player's
  own Skip control. It requests no other site.

## Data usage disclosures

Select: **does not collect or use user data.**

- No personally identifiable information
- No health, financial, authentication, personal communications, location,
  web history or user activity collected
- No data sold or transferred to third parties
- No data used for creditworthiness or lending
- Not used for purposes unrelated to the single purpose above

## Assets

- Screenshots, 1280x800, in `store/screenshots/`:
  - `01-ads-out-of-youtube.png`
  - `02-stopped-at-source.png`
  - `03-no-account-no-tracking.png`
- 128x128 icon — already in the package
- `store/promo-tile-440x280.png`
- `store/marquee-1400x560.png`

All three are drawn from the same generator as the other Quite Apps listings
(`tools/make-shots.py` in the website project), so the three extensions present
as one publisher. Each shows the popup in a different real state — the default
options, everything on, and the pared-back set — rather than the same picture
three times.

The counters in these screenshots read 185 ads stopped / 11m saved / 185
skipped. Those are the real all-time totals, read directly from
`chrome.storage` in the author's Chrome profile on 2026-08-29 and formatted by
the same `compact()` and `humanTime()` the popup uses. They count from
2026-08-28, which is why they are modest.

A previous version of this note claimed the figures were 1,284 / 3h 41m / 412
and that those were real totals confirmed on the same date. They were not.
Every Chromium profile on the machine was searched and only one install of this
extension exists, holding `adsBlocked: 185, adsSkipped: 185, secondsSaved:
661.5`. The claimed figures are also structurally impossible: `recordAd()` in
content.js increments `adsBlocked` and `adsSkipped` on consecutive lines, so the
two can never differ, and 1,284 against 412 could not have come from this code.
They were the website's placeholders.

The two 185s are therefore not a mistake in the artwork — the popup genuinely
shows one number under two labels that promise different things. If you would
rather they read as two measurements, fix the counter and regenerate. Do not
edit the picture, which would make the screenshot disagree with the product.

Screenshots of this extension show measured totals, never invented ones. The
same rule was applied to Quite for Facebook (243 / 394 / 77) and Quite for
Cookies (357 / 45 / 228), both read from the same source on the same date.
