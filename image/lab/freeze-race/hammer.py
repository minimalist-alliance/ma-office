# hammer.py <log>: race.sh's reboot-hammer. As uid 1100, asks units.sock for a freeze every 100 ms until it's killed, one line
# per answer: <CLOCK_MONOTONIC ns> <reply>. Lab only.
import socket, sys, time

log = open(sys.argv[1], 'a', buffering=1)
while True:
    try:
        s = socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect('/run/desk/units.sock'); s.sendall(b'freeze desk-browser\n')
        r = s.recv(300).decode().strip() or 'eof'; s.close()
    except OSError as e:
        r = 'error ' + type(e).__name__
    log.write('%d %s\n' % (time.monotonic_ns(), r))
    time.sleep(0.1)
