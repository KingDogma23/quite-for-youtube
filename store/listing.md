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

Quite for YouTube takes the ads out of YouTube and does nothing else.

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

READ THIS BEFORE SUBMITTING. Earlier versions of these screenshots showed a
fresh install's zeros, and this document said that inventing numbers would be a
lie told to everyone who reads it. That is still true. The counters now read
1,284 ads stopped / 3h 41m saved / 412 skipped, and those figures are
ILLUSTRATIVE, not measured — they are the placeholders carried in the website's
`data/extensions.json`. The extension already reports real totals in its own
diagnostics, so replace them with a genuine reading before this listing goes
live: update `stats` for `quite-for-youtube` in `data/extensions.json` and
re-run the generator.
