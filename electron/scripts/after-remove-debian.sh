#!/bin/bash
# electron-builder's default post-remove actions, plus Q-App launcher cleanup.
if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove 'qortal-hub' '/opt/qortal-hub/qortal-hub'
else
  rm -f '/usr/bin/qortal-hub'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/qortal-hub'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled >/dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# Called by the Debian post-remove hook. Never remove launchers during upgrades.
if [ "${1:-}" != remove ] && [ "${1:-}" != purge ]; then
  exit 0
fi

while IFS=: read -r _ _ uid _ _ home _; do
  [[ "$uid" =~ ^[0-9]+$ && "$home" = /* && -d "$home" ]] || continue
  support="$home/.config/qortal-hub/qapp-launchers"
  desktop_dir="$home/.local/share/applications"
  [[ -d "$support" && ! -L "$support" && -d "$desktop_dir" && ! -L "$desktop_dir" ]] || continue

  for desktop in "$desktop_dir"/qortal-qapp-*.desktop; do
    [[ -f "$desktop" && ! -L "$desktop" ]] || continue
    stem=${desktop##*/}
    stem=${stem%.desktop}
    [[ "$stem" =~ ^qortal-qapp-[a-z0-9-]+-([a-f0-9]{16})$ ]] || continue
    hash=${BASH_REMATCH[1]}
    script="$support/$stem.sh"
    icon="$support/$stem.png"
    [[ -f "$script" && ! -L "$script" ]] || continue
    grep -Fxq "X-Qortal-Hub-QApp=$hash" "$desktop" || continue
    grep -Fq "qapp-launchers/$stem.sh" "$desktop" || continue
    grep -Fq "qapp-launchers/$stem.png" "$desktop" || continue
    grep -Fq -- '--open-qapp=qortal://APP/' "$script" || continue
    rm -f -- "$desktop" "$script"
    [[ ! -L "$icon" ]] && rm -f -- "$icon"
  done
  rmdir -- "$support" 2>/dev/null || true
done < /etc/passwd
