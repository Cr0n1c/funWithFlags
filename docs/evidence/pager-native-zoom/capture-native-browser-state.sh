#!/usr/bin/env bash
set -eu

# Host diagnostics and a raw desktop screenshot only. This deliberately does
# not change browser zoom or claim to test the pager.
out="${1:-docs/evidence/pager-native-zoom/desktop-state.png}"
mkdir -p "$(dirname "$out")"
printf 'OS: '
. /etc/os-release
printf '%s\n' "$PRETTY_NAME"
if [ -x "${CHROMIUM_PATH:-chromium}" ]; then
  "${CHROMIUM_PATH:-chromium}" --version
else
  echo 'Chromium: unavailable'
fi
if command -v firefox >/dev/null 2>&1; then
  firefox --version
else
  echo 'Firefox: unavailable'
fi
printf 'DISPLAY=%s\n' "${DISPLAY:-}"
if command -v xdotool >/dev/null 2>&1; then
  printf 'X display geometry: '
  xdotool getdisplaygeometry | tr '\n' ' '
  echo
fi
if command -v import >/dev/null 2>&1; then
  import -window root "$out"
  printf 'Desktop screenshot: %s\n' "$out"
else
  echo 'Screenshot not captured: ImageMagick import is unavailable' >&2
  exit 1
fi
