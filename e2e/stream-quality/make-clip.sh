#!/bin/bash
# make-clip.sh <out.webm> [seconds]: the stream quality clip. 1920x1080 at 60 fps, VP8 and Opus, so any Chromium plays it, and
# about 3 MB for 6 s, so it crosses SSM in about 75 pieces. Motion over the whole frame, as a video playing full screen has: a slow
# pan and zoom over a detailed 4K fractal still whose colours turn, a rotating test card crossing it, a ticker, and film grain that
# changes every frame (what makes real footage costly to encode). Sound: two modulated tones and a little noise. It loops.
set -euo pipefail
out=${1:?usage: make-clip.sh out.webm [seconds]}
secs=${2:-6}
font=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "mandelbrot=s=3840x2160:start_scale=0.4:end_scale=0.4:maxiter=600:inner=period" -frames:v 1 "$tmp/still.png"
ffmpeg -hide_banner -loglevel error -y -threads 6 \
  -loop 1 -framerate 60 -t "$secs" -i "$tmp/still.png" \
  -t "$secs" -f lavfi -i "testsrc2=s=480x270:r=60" \
  -t "$secs" -f lavfi -i "aevalsrc=exprs='0.25*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*3*t))+0.15*sin(2*PI*330*t+sin(2*PI*0.5*t))+0.08*(random(0)-0.5)|0.25*sin(2*PI*277*t)*(0.6+0.4*sin(2*PI*2*t))+0.15*sin(2*PI*440*t)+0.08*(random(1)-0.5)':s=48000" \
  -filter_complex "[0:v]zoompan=z='1.25+0.2*sin(on/60*1.05)':x='(iw-iw/zoom)/2+(iw-iw/zoom)/2*sin(on/60*0.9)':y='(ih-ih/zoom)/2+(ih-ih/zoom)/2*cos(on/60*0.7)':d=1:s=1920x1080:fps=60,hue=h=t*30[bg];\
[1:v]rotate=a=t*0.8:fillcolor=none[card];[bg][card]overlay=x='(W-w)/2+700*sin(t*1.3)':y='(H-h)/2+350*cos(t*1.7)':shortest=1,noise=alls=4:allf=t,\
drawtext=fontfile=$font:text='stream quality clip  frame %{frame_num}':x=w-mod(t*600\,w+tw):y=h-120:fontsize=56:fontcolor=white:box=1:boxcolor=black@0.5,format=yuv420p[v]" \
  -map '[v]' -map 2:a -t "$secs" -c:v libvpx -deadline realtime -cpu-used 8 -b:v 4M -maxrate 5M -bufsize 4M -g 120 -auto-alt-ref 0 -lag-in-frames 0 -threads 4 \
  -c:a libopus -b:a 96k -map_metadata -1 -fflags +bitexact -f webm "$out"
ls -l "$out"
