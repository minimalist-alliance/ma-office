#!/usr/bin/env bash
# Puts the three pages' videos from tests/perf/record.mjs side by side, as one H.264 file with no
# metadata: media/commons-three-browsers.mp4.
set -euo pipefail
cd "$(dirname "$0")/.."
v=()
for m in a b c; do v+=(-i "$(ls recording/$m/*.webm | head -1)"); done
mkdir -p media
ffmpeg -loglevel error -y -threads 4 "${v[@]}" \
  -filter_complex "[0:v][1:v][2:v]hstack=inputs=3:shortest=1,fps=30,format=yuv420p[v]" -map "[v]" \
  -c:v libx264 -preset slow -crf 27 -tune stillimage -movflags +faststart \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -metadata creation_time= \
  media/commons-three-browsers.mp4
ls -la media/commons-three-browsers.mp4
