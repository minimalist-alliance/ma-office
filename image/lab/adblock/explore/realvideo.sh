#!/bin/bash
# realvideo.sh: each page's own video, pressed play, with blocking on and then with the site switched off (through units.sock,
# as deskd), on a lab box after apply.sh. Lab only (ADR 0076).
set -u
ask() { timeout 60 setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode() + b'\n'); print(s.recv(300).decode().strip())" "$1"; }
setlist() { printf "$1" > /data/desk/.adblock-off.v; chown desk:desk /data/desk/.adblock-off.v; chmod 0644 /data/desk/.adblock-off.v; mv -f /data/desk/.adblock-off.v /data/desk/adblock-off; }
for x in "foodnetwork.com https://www.foodnetwork.com/recipes/ina-garten/perfect-roast-chicken-recipe-1940592" \
         "allrecipes.com https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/" \
         "weather.com https://weather.com/weather/today/l/New+York+NY+USNY0996:1:US" \
         "dailymail.co.uk https://www.dailymail.co.uk/ushome/index.html" \
         "cnn.com https://www.cnn.com/" \
         "harrypotter.fandom.com https://harrypotter.fandom.com/wiki/Harry_Potter"; do
  site=${x%% *} url=${x#* }
  setlist ''; ask 'start desk-adblock' >/dev/null; echo "== $site, blocking on"; python3 -I /var/tmp/lab/realvideo.py "$url"
  setlist "$site\n"; echo "== $site, switched off: $(ask 'start desk-adblock')"; python3 -I /var/tmp/lab/realvideo.py "$url"
done
rm -f /data/desk/adblock-off; ask 'start desk-adblock' >/dev/null
