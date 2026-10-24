#!/usr/bin/env bash
# Simulates a phone camera without a phone: registers a camera through the real API and
# publishes a 720p test pattern (H.264 + AAC over SRT), exactly the stream format the
# Android and iOS apps send. Useful to test the server, OBS agent and Director app.
#
# It joins like a volunteer: with a camera join code (Tournament > Join codes in the app).
#
# Usage:
#   tools/sim-camera.sh <server-url> <camera-join-code> "<camera name>" [hole]
# Example:
#   tools/sim-camera.sh https://live.cogolfers.com K7Q-2MX "Hole 7 Green" 7
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,13p' "$0"; exit 1; }
SERVER=${1%/}; CODE=$2; NAME=$3; HOLE=${4:-null}
command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

DEVICE_ID="sim-$(echo -n "$NAME" | md5sum 2>/dev/null | cut -c1-12 || echo "$RANDOM$RANDOM")"
JOIN=$(curl -fsS -X POST "$SERVER/api/join" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceId\":\"$DEVICE_ID\",\"name\":\"$NAME (simulator)\"}")
[ "$(echo "$JOIN" | json "d['role']")" = camera ] || { echo "That is not a camera join code"; exit 1; }
TOKEN=$(echo "$JOIN" | json "d['token']")
TOURNAMENT=$(echo "$JOIN" | json "d['tournament']['id']")
REG=$(curl -fsS -X POST "$SERVER/api/tournaments/$TOURNAMENT/cameras/register" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"hole\":$HOLE,\"position\":\"Simulator\",\"deviceId\":\"$DEVICE_ID\",\"platform\":\"other\",\"deviceModel\":\"ffmpeg simulator\"}")
URL=$(echo "$REG" | json "d['publish']['srtUrl']")
# Mobile SDKs read `latency` in milliseconds; FFmpeg reads it in microseconds.
URL=$(echo "$URL" | python3 -c "import re,sys; u=sys.stdin.read().strip(); print(re.sub(r'latency=(\d+)', lambda m: 'latency=%d' % (int(m.group(1))*1000), u) + '&pkt_size=1316')")
echo "Publishing '$NAME' -> ${URL%%streamid*}… (Ctrl+C to stop)"

exec ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v main -bf 0 -g 60 -b:v 2500k -maxrate 2500k -bufsize 2500k \
  -c:a aac -b:a 128k -f mpegts "$URL"
