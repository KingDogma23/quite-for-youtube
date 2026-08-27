#!/usr/bin/env bash
#
# Package this extension for distribution.
#
#   ./package.sh
#
# Produces dist/<name>-<version>.zip containing a single folder, so that
# unzipping always yields the folder "Load unpacked" expects. Reads the version
# from manifest.json, ships only the files the extension actually needs, and
# refuses to build a zip whose manifest references something that is missing.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

NAME="$(basename "$PWD")"
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; OFF=$'\033[0m'

# --- everything that is NOT part of the shipped extension --------------------
EXCLUDE=(
  ".git" ".github" ".gitignore" ".DS_Store"
  "dist" "test" "tests" "node_modules"
  "package.sh"
)

[[ -f manifest.json ]] || { echo "${RED}No manifest.json here.${OFF}"; exit 1; }

VERSION="$(python3 -c '
import json, sys
try:
    m = json.load(open("manifest.json"))
except Exception as e:
    sys.exit("manifest.json is not valid JSON: %s" % e)
v = m.get("version")
if not v:
    sys.exit("manifest.json has no version")
print(v)
')"

STAGE="dist/${NAME}-${VERSION}"
ZIP="dist/${NAME}-${VERSION}.zip"

echo
echo "${BOLD}Packaging ${NAME} ${VERSION}${OFF}"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

# Keep build output out of git without touching the repo's own .gitignore.
printf '*\n' > dist/.gitignore

# --- copy the extension itself ----------------------------------------------
shopt -s dotglob
for item in *; do
  skip=""
  for ex in "${EXCLUDE[@]}"; do [[ "$item" == "$ex" ]] && skip=1 && break; done
  [[ -n "$skip" ]] && continue
  cp -R "$item" "$STAGE/"
done
shopt -u dotglob

find "$STAGE" -name '.DS_Store' -delete

# --- refuse to ship a manifest that points at files we did not include -------
python3 - "$STAGE" <<'PY'
import json, os, sys

stage = sys.argv[1]
m = json.load(open(os.path.join(stage, "manifest.json")))
refs = []

for cs in m.get("content_scripts", []):
    refs += cs.get("js", []) + cs.get("css", [])
for key in ("background",):
    b = m.get(key) or {}
    if b.get("service_worker"):
        refs.append(b["service_worker"])
if (m.get("action") or {}).get("default_popup"):
    refs.append(m["action"]["default_popup"])
refs += list((m.get("icons") or {}).values())
refs += list(((m.get("action") or {}).get("default_icon") or {}).values()) \
    if isinstance((m.get("action") or {}).get("default_icon"), dict) else []
for war in m.get("web_accessible_resources", []):
    refs += war.get("resources", [])

missing = sorted({r for r in refs if not os.path.exists(os.path.join(stage, r))})
if missing:
    print("\n  manifest.json references files that are not in the package:")
    for r in missing:
        print("    missing:", r)
    sys.exit(1)
print(f"  manifest references {len(set(refs))} files, all present")
PY

# --- zip --------------------------------------------------------------------
# Two layouts, because they are consumed by different things.
#
#   default   the folder is INSIDE the zip, so unzipping yields the folder
#             that "Load unpacked" expects
#   --store   the files are at the ROOT of the zip, which is what the Chrome
#             Web Store requires; a zip with a wrapping folder is rejected
#             with "Manifest file is missing or unreadable"
if [[ "${1:-}" == "--store" ]]; then
  ZIP="dist/${NAME}-${VERSION}-store.zip"
  rm -f "$ZIP"
  ( cd "$STAGE" && zip -r -q -X "../../${ZIP}" . -x '*.DS_Store' )
else
  ( cd dist && zip -r -q -X "${NAME}-${VERSION}.zip" "${NAME}-${VERSION}" -x '*.DS_Store' )
fi
rm -rf "$STAGE"

SIZE="$(du -h "$ZIP" | cut -f1 | tr -d ' ')"
COUNT="$(unzip -Z1 "$ZIP" | grep -vc '/$' || true)"
SHA="$(shasum -a 256 "$ZIP" | cut -c1-16)"

echo "  ${GRN}${ZIP}${OFF}  ${DIM}${SIZE}, ${COUNT} files, sha256 ${SHA}…${OFF}"
echo
unzip -Z1 "$ZIP" | grep -v '/$' | sed "s|^|    ${DIM}|;s|$|${OFF}|"
echo

# --- release hygiene, reported but never blocking ---------------------------
# @{u} is unset on these repos, so fall back to origin/<branch>.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
UPSTREAM="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
[[ -z "$UPSTREAM" && -n "$BRANCH" ]] && git rev-parse --verify -q "origin/$BRANCH" >/dev/null \
  && UPSTREAM="origin/$BRANCH"

warn=0
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "  ${YEL}!${OFF} working tree has uncommitted changes"; warn=1
fi
if [[ -n "$UPSTREAM" ]]; then
  AHEAD="$(git rev-list "$UPSTREAM..HEAD" --count 2>/dev/null || echo 0)"
  if [[ "$AHEAD" -gt 0 ]]; then
    echo "  ${YEL}!${OFF} ${AHEAD} commit(s) not pushed to ${UPSTREAM}"; warn=1
  fi
else
  echo "  ${YEL}!${OFF} no upstream branch found — cannot tell if this is pushed"; warn=1
fi
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "  ${YEL}!${OFF} tag v${VERSION} already exists"; warn=1
fi
if [[ $warn -eq 0 ]]; then
  echo "  ${DIM}Clean, pushed, and v${VERSION} is a new tag. To release:${OFF}"
  echo "    git tag -a v${VERSION} -m '${NAME} ${VERSION}' && git push origin v${VERSION}"
  echo "    gh release create v${VERSION} ${ZIP} --title '${NAME} ${VERSION}' --generate-notes"
fi
echo
