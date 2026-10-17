#!/usr/bin/env bash
#
# Encode every sample in public/assets/samples to Opus (WebM container), next to
# the original. Players load the .webm files when their browser can decode Opus,
# and fall back to the original .mp3 / .wav files otherwise (see
# src/lib/audio-format.js), so keep the originals.
#
# Re-run after adding or replacing a sample:
#
#   tools/encode-audio.sh
#
# Requires an ffmpeg built with libopus. Set FFMPEG to use a specific binary.
#
# The hum is stereo at 128kb/s. Opus always runs at 48kHz, the AudioContext's rate.

set -euo pipefail

FFMPEG="${FFMPEG:-ffmpeg}"
SAMPLES="$(cd "$(dirname "$0")/../public/assets/samples" && pwd)"

encode() {
  local src="$1" bitrate="$2" channels="$3"
  local dst="${src%.*}.webm"
  "$FFMPEG" -v error -y -i "$src" -map_metadata -1 \
    -c:a libopus -b:a "$bitrate" -vbr on -application audio -ac "$channels" \
    "$dst"
  printf '%-44s %8s -> %8s\n' "${src#"$SAMPLES"/}" "$(du -h "$src" | cut -f1)" "$(du -h "$dst" | cut -f1)"
}

encode "$SAMPLES/hum.wav" 128k 2
