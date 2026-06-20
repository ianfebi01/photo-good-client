#!/usr/bin/env bash
# Start `next dev` bound to this machine's LAN IP so other devices (phones,
# tablets) on the same network can reach the booth. Detects the IP behind the
# default route, with a fallback scan of common interfaces.
set -euo pipefail

detect_ip() {
  # macOS: resolve the interface backing the default route, then its IPv4.
  if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    local iface
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    if [ -n "${iface:-}" ]; then
      ipconfig getifaddr "$iface" 2>/dev/null && return 0
    fi
    # Fall back to scanning the usual Wi-Fi / Ethernet interfaces.
    for i in en0 en1 en2 en3; do
      local ip
      ip=$(ipconfig getifaddr "$i" 2>/dev/null || true)
      [ -n "$ip" ] && { echo "$ip"; return 0; }
    done
  fi

  # Linux / generic fallback.
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' && return 0
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1}' && return 0
  fi

  return 1
}

HOST="$(detect_ip || true)"

if [ -z "${HOST:-}" ]; then
  echo "⚠️  Could not detect a LAN IP — falling back to 0.0.0.0" >&2
  HOST="0.0.0.0"
else
  echo "▶  Starting dev server on http://${HOST}:3000" >&2
fi

exec pnpm exec next dev -H "$HOST" "$@"
