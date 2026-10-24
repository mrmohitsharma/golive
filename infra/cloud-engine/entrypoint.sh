#!/usr/bin/env bash
# CoGolfer cloud engine: headless OBS Studio (on a virtual display) + the CoGolfer agent.
# Used by the cloud-engine container, and by the server's "process" driver for local
# development and tests (same script, same behaviour).
#
# Required env: SERVER_URL, TOURNAMENT_ID, ENGINE_KEY
# Optional:     OBS_PASSWORD, OBS_PORT (4455), DISPLAY_NUM (99), ENGINE_HOME ($HOME),
#               AGENT_CMD ("node /opt/agent/dist/index.js"), CANVAS (1920x1080)
set -euo pipefail

: "${SERVER_URL:?SERVER_URL is required}"
: "${TOURNAMENT_ID:?TOURNAMENT_ID is required}"
: "${ENGINE_KEY:?ENGINE_KEY is required}"
OBS_PASSWORD=${OBS_PASSWORD:-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}
OBS_PORT=${OBS_PORT:-4455}
DISPLAY_NUM=${DISPLAY_NUM:-99}
ENGINE_HOME=${ENGINE_HOME:-$HOME}
AGENT_CMD=${AGENT_CMD:-node /opt/agent/dist/index.js}
CANVAS=${CANVAS:-1920x1080}

export HOME="$ENGINE_HOME"
CFG="$HOME/.config/obs-studio"
mkdir -p "$CFG"

# Skip OBS's first-run wizard and enable obs-websocket. OBS 30 reads global.ini,
# OBS 31+ reads user.ini: write both.
cat > "$CFG/global.ini" <<EOF
[General]
FirstRun=true
LastVersion=503316482
EnableAutoUpdates=false

[OBSWebSocket]
FirstLoad=false
ServerEnabled=true
ServerPort=$OBS_PORT
AlertsEnabled=false
AuthRequired=true
ServerPassword=$OBS_PASSWORD
EOF
cp "$CFG/global.ini" "$CFG/user.ini"

log() { echo "[cloud-engine] $*"; }

pids=()
cleanup() {
  log "stopping"
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

Xvfb ":$DISPLAY_NUM" -screen 0 "${CANVAS}x24" -nolisten tcp >/dev/null 2>&1 &
pids+=($!)
export DISPLAY=":$DISPLAY_NUM"
# No GPU in a standard VM: Mesa software OpenGL. With a GPU instance, drop this.
export LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
sleep 1

log "starting OBS on :$DISPLAY_NUM, websocket port $OBS_PORT"
dbus-run-session -- obs --multi --disable-shutdown-check --disable-updater --disable-missing-files-check --minimize-to-tray \
  --websocket_port "$OBS_PORT" --websocket_password "$OBS_PASSWORD" --websocket_ipv4_only \
  >"$HOME/obs.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$OBS_PORT") 2>/dev/null; then break; fi
  sleep 1
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/$OBS_PORT") 2>/dev/null; then
  log "OBS did not start. Last log lines:"
  tail -n 30 "$HOME/obs.log" || true
  exit 1
fi
log "OBS is up; starting the agent"

OBS_URL="ws://127.0.0.1:$OBS_PORT" OBS_PASSWORD="$OBS_PASSWORD" $AGENT_CMD &
pids+=($!)

# Exit (and let the platform restart/remove us) as soon as OBS or the agent stops.
wait -n
log "a process exited"
exit 1
