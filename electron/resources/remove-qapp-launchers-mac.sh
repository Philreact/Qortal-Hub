#!/bin/sh
# Run before moving Qortal Hub.app to Trash. macOS has no app-removal hook.
applications="$HOME/Applications"
[ -d "$applications" ] || exit 0

for bundle in "$applications"/*.app; do
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || continue
  marker="$bundle/Contents/Resources/qortal-hub-qapp.txt"
  [ -f "$marker" ] && [ ! -L "$marker" ] || continue
  IFS= read -r argument < "$marker" || [ -n "$argument" ]
  case "$argument" in
    --open-qapp=qortal://APP/*) rm -rf -- "$bundle" ;;
  esac
done
