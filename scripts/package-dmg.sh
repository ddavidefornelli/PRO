#!/bin/bash
# Package an already-built app. This does not sign or notarize either artifact.
set -euo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
app="$project/src-tauri/target/release/bundle/macos/prune.app"
output="$project/prune.dmg"
[[ -d "$app" ]] || { echo 'Build prune.app first with Tauri.' >&2; exit 1; }
work=$(mktemp -d /tmp/prune-installer.XXXXXX)
work=$(cd "$work" && pwd -P)
mount="$work/mount"
cleanup() {
  if mount | grep -Fq " on $mount "; then hdiutil detach "$mount" >/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/staging/.background" "$mount"
swift "$project/scripts/dmg-background.swift" "$work/staging/.background/installer.png"
ditto "$app" "$work/staging/prune.app"
ln -s /Applications "$work/staging/Applications"
hdiutil create -size 80m -volname prune -srcfolder "$work/staging" -fs HFS+ -format UDRW "$work/layout.dmg"
hdiutil attach -readwrite -noverify -nobrowse -mountpoint "$mount" "$work/layout.dmg"
# Finder may ask for Automation permission on the first run.
osascript - "$mount" <<'APPLESCRIPT'
on run argv
    set mountPath to item 1 of argv
    set diskFolder to POSIX file mountPath as alias
    tell application "Finder"
        open diskFolder
        set installerWindow to container window of diskFolder
        set current view of installerWindow to icon view
        set toolbar visible of installerWindow to false
        set statusbar visible of installerWindow to false
        set bounds of installerWindow to {180, 140, 840, 560}
        set viewOptions to icon view options of installerWindow
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 96
        set text size of viewOptions to 14
        set background picture of viewOptions to file ".background:installer.png" of diskFolder
        set position of item "prune.app" of diskFolder to {180, 205}
        set position of item "Applications" of diskFolder to {480, 205}
        update diskFolder without registering applications
        delay 3
        close installerWindow
    end tell
end run
APPLESCRIPT
sync
hdiutil detach "$mount"
hdiutil convert "$work/layout.dmg" -format UDZO -o "$work/prune.dmg"
hdiutil verify "$work/prune.dmg"
if [[ -f "$output" ]]; then
  mv "$output" "$project/prune.backup-$(date +%Y%m%d-%H%M%S).dmg"
fi
mv "$work/prune.dmg" "$output"
printf '\nCreated: %s\nNot Developer ID–signed or notarized by this script.\n' "$output"
