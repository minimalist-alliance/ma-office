#!/bin/bash
# make-clip.sh <out.webm> [seconds]: the A/V sync clip. 1280x720 at 60 fps, VP8 and Opus, so any Chromium plays it.
# Every second, at +0.5 s, a white box (640x360, centred) shows for 6 frames (100 ms) and a 1 kHz tone plays for 100 ms,
# starting on the same instant. The rest is black and silent. A frame counter is drawn twice: as text, for eyes, and as
# 10 white-or-black blocks along the top (bit i at x = 20 + 48 i, 40x40 at y = 20), for the probe. The clip loops, so the
# events stay half a second away from the loop point.
set -euo pipefail
out=${1:?usage: make-clip.sh out.webm [seconds]}
secs=${2:-10}
font=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
bits=""
for i in $(seq 0 9); do
  bits+=",drawbox=x=$((20 + 48 * i)):y=20:w=40:h=40:color=white:t=fill:enable='eq(mod(floor(n/$((1 << i))),2),1)'"
done
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1280x720:r=60:d=$secs" \
  -f lavfi -i "aevalsrc=exprs='0.5*sin(2*PI*1000*t)*between(mod(t,1),0.5,0.59999)|0.5*sin(2*PI*1000*t)*between(mod(t,1),0.5,0.59999)':s=48000:d=$secs" \
  -filter_complex "[0:v]drawbox=x=320:y=180:w=640:h=360:color=white:t=fill:enable='lt(mod(n+30,60),6)'${bits},drawtext=fontfile=$font:text='%{frame_num}':x=20:y=650:fontsize=40:fontcolor=white,format=yuv420p[v]" \
  -map '[v]' -map 1:a -c:v libvpx -deadline realtime -cpu-used 8 -b:v 300k -g 120 -auto-alt-ref 0 -lag-in-frames 0 \
  -c:a libopus -b:a 96k -map_metadata -1 -fflags +bitexact -f webm "$out"
ls -l "$out"
