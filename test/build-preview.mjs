#!/usr/bin/env node
/**
 * Build test/popup-preview.html FROM popup.html. Run with:
 *
 *     node test/build-preview.mjs
 *
 * The preview used to be a hand-maintained copy of popup.html — markup and
 * styles both — and it drifted: on 2026-09-03 it still read "Ads skipped as
 * they appear" and "Clicks Skip, fast-forwards unskippable ones" while the
 * shipped popup had said "Ads muted and hidden" for hours. Rendering it and
 * calling it "the popup" was wrong, and a "cached snapshot" was blamed for
 * the difference when the file itself was stale. A preview that is a copy
 * will always drift; a preview that is GENERATED cannot.
 *
 * verify.mjs fails the build if this file's output differs from what is on
 * disk, so drift is caught before it is looked at.
 */
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const EXT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const popup = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const stub = fs.readFileSync(path.join(EXT, 'test', 'preview-stub.js.html'), 'utf8');
export function buildPreview() {
  const marker = '    <script src="popup.js"></script>\n';
  if (!popup.includes(marker)) throw new Error('popup.html: popup.js script tag not found where expected');
  const head = '<!-- GENERATED from popup.html by test/build-preview.mjs — do not edit; edit popup.html and rebuild -->\n';
  return head + popup.replace(marker, stub + '    <script src="../popup.js"></script>\n');
}
if (process.argv[1] && process.argv[1].endsWith('build-preview.mjs')) {
  fs.writeFileSync(path.join(EXT, 'test', 'popup-preview.html'), buildPreview());
  console.log('test/popup-preview.html rebuilt from popup.html');
}
