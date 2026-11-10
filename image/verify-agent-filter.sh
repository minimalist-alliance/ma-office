#!/bin/bash
# verify-agent-filter.sh: desk-agent-filter on a booted desk (ADR 0070). verify.sh pipes this to root on the box, and it
# changes nothing it doesn't put back. It prints BAD <check> and FAILED for each failure, and "ran to the end" last.
# Each check has been seen to fail with the thing it guards broken: evidence/agent-filter-2026-11-07/mutations.txt.
# No keys of any kind: a provider's 401 is the success.
set -u
LOG=/var/tmp/verify-agent-filter
mkdir -p $LOG
cat > /var/tmp/afprobe.py <<'P'
import errno, socket, ssl, struct, sys, time
cmd, args = sys.argv[1], sys.argv[2:]
def family(a): return socket.AF_INET6 if ":" in a else socket.AF_INET
def tls(sni, addr):
    # "refused": the far end said nothing and closed, as the filter does. "alert": something spoke TLS and said no.
    ctx = ssl.create_default_context()
    if sni == "-":
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        s = socket.create_connection((addr, 443), timeout=8)
        t = ctx.wrap_socket(s, server_hostname=None if sni == "-" else sni)
        print("ok", t.version())
    except ssl.SSLCertVerificationError as e:
        print("badcert", e.verify_message)
    except (ssl.SSLEOFError, ssl.SSLZeroReturnError, ConnectionError) as e:
        print("refused", type(e).__name__)
    except ssl.SSLError as e:
        print("alert", e.reason)
    except TimeoutError:
        print("timeout")
    except OSError as e:
        print("refused", type(e).__name__)
def dns(proto, server, port, name, qtype, sport=None):
    # A refusal gets one more try, from a new port, unless the test named the port: 1 query in thousands picks a source port
    # another uid just used, and conntrack then sends it the other uid's way (F-CTHOLE). That's a refused query, not the rule.
    types = {"A": 1, "AAAA": 28, "TXT": 16, "HTTPS": 65}
    q = struct.pack(">HHHHHH", 0x5151, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(l)]) + l.encode() for l in name.split(".")) + b"\0" + struct.pack(">HH", types[qtype], 1)
    for attempt in (1, 2):
        try:
            if proto == "udp":
                s = socket.socket(family(server), socket.SOCK_DGRAM); s.settimeout(3)
                if sport: s.bind(("", int(sport)))
                s.connect((server, int(port))); s.send(q); r = s.recv(4096)
            else:
                s = socket.create_connection((server, int(port)), timeout=3); s.sendall(struct.pack(">H", len(q)) + q)
                n = struct.unpack(">H", s.recv(2))[0]; r = b""
                while len(r) < n:
                    d = s.recv(n - len(r))
                    if not d: break
                    r += d
            break
        except OSError as e:
            if attempt == 2 or sport or not isinstance(e, PermissionError):
                print("none", type(e).__name__); return
    if len(r) < 12 or r[:2] != q[:2]:
        print("none", "not an answer"); return
    an = struct.unpack(">H", r[6:8])[0]
    addrs = []
    if qtype == "A":
        p = 12
        while r[p]: p += 1 + r[p]
        p += 5
        for _ in range(an):
            p += 2; t, _c, _ttl, l = struct.unpack(">HHIH", r[p:p+10]); p += 10
            if t == 1: addrs.append(".".join(str(b) for b in r[p:p+l]))
            p += l
    print(f"rcode={r[3] & 15} an={an} addrs={','.join(addrs)}")
def udp(addr, port):
    s = socket.socket(family(addr), socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.connect((addr, int(port))); s.send(b"\xc0" + bytes(1199)); s.recv(4096); print("answered")
    except TimeoutError:
        print("timeout")
    except OSError as e:
        print("refused", type(e).__name__)
def tcp(addr, port):
    try:
        socket.create_connection((addr, int(port)), timeout=6); print("connected")
    except TimeoutError:
        print("timeout")
    except OSError as e:
        print("refused", type(e).__name__)
def stand_in(addr, port, seconds):
    # Something else taking the filter's ports while it's down: it answers whatever comes.
    t = socket.socket(family(addr)); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); t.bind((addr, int(port))); t.listen(8); t.setblocking(False)
    u = None
    try:
        u = socket.socket(family(addr), socket.SOCK_DGRAM); u.bind((addr, int(port))); u.setblocking(False)
    except OSError:
        pass
    end = time.time() + float(seconds)
    while time.time() < end:
        try:
            c, _ = t.accept(); c.send(b"stand-in\n"); c.close()
        except OSError:
            pass
        if u:
            try:
                d, a = u.recvfrom(4096); u.sendto(d[:2] + b"\x81\x80" + d[4:], a)
            except OSError:
                pass
        time.sleep(0.01)
def raw_hello(sni, ech, addr):
    # A hello by hand, because no client here sends encrypted_client_hello: "answered" is anything back from a TLS server.
    def vec16(b): return struct.pack(">H", len(b)) + b
    name = sni.encode()
    exts = struct.pack(">H", 0) + vec16(vec16(b"\0" + vec16(name)))
    exts += struct.pack(">H", 10) + vec16(vec16(struct.pack(">H", 29)))                                    # groups: x25519
    exts += struct.pack(">H", 13) + vec16(vec16(struct.pack(">H", 0x0804)))                                # signatures: rsa_pss_rsae_sha256
    exts += struct.pack(">H", 43) + vec16(b"\x02\x03\x04")                                                 # versions: TLS 1.3
    exts += struct.pack(">H", 51) + vec16(vec16(struct.pack(">H", 29) + vec16(bytes(range(1, 33)))))       # key share
    if ech == "ech":
        exts += struct.pack(">H", 0xfe0d) + vec16(b"\x00\x00\x01\x00\x01\x01" + vec16(bytes(32)) + vec16(bytes(144)))
    body = b"\x03\x03" + bytes(range(32)) + b"\0" + vec16(b"\x13\x01") + b"\x01\0" + vec16(exts)
    msg = b"\x01" + len(body).to_bytes(3, "big") + body
    try:
        s = socket.create_connection((addr, 443), timeout=6); s.settimeout(6)
        s.sendall(b"\x16\x03\x01" + vec16(msg))
        print("answered" if s.recv(16) else "refused EOF")
    except TimeoutError:
        print("timeout")
    except OSError as e:
        print("refused", type(e).__name__)
def hellos(count, marker):
    # A request's bytes where a hello should be, then refused names: the journal may name the second and never holds the first.
    # The bytes go first, so they take a line of the minute's budget, and the limit can't be what hides them.
    try:
        s = socket.create_connection(("192.0.2.1", 443), timeout=3); s.sendall(f"POST / HTTP/1.1\r\nAuthorization: {marker}-contents\r\n\r\n".encode()); s.recv(16)
    except OSError:
        pass
    for i in range(int(count)):
        ctx = ssl.create_default_context()
        try:
            ctx.wrap_socket(socket.create_connection(("192.0.2.1", 443), timeout=3), server_hostname=f"{marker}-{i}.example.com")
        except OSError:
            pass
    print("sent")
def hold(sni, addr, seconds):
    # A TLS connection that stays open, so its sockets can be looked at.
    ctx = ssl.create_default_context()
    t = ctx.wrap_socket(socket.create_connection((addr, 443), timeout=8), server_hostname=sni)
    print("held", t.version(), flush=True)
    time.sleep(float(seconds))
dict(tls=tls, rawhello=raw_hello, dns=dns, udp=udp, tcp=tcp, standin=stand_in, hellos=hellos, hold=hold)[cmd](*args)
P
chmod 644 /var/tmp/afprobe.py
as() { setpriv --reuid=$1 --regid=$1 --clear-groups "${@:2}"; }
p() { local u=$1; shift; as "$u" python3 -I /var/tmp/afprobe.py "$@" 2>&1 | tail -1; }
http() { as "$1" curl -s -o /dev/null -m 8 -w '%{http_code}' "${@:2}" 2>/dev/null; }   # 000: refused or no answer
bad() { echo "BAD $1: $2"; echo FAILED; }
# want <check> <what> <value> <extended regex the whole value has to match>
want() { echo "$1 $2: $3"; [[ $3 =~ ^($4)$ ]] || bad "$1" "$2 said '$3', wanted '$4'"; }
wait_up() { local i; for i in $(seq 1 30); do ss -Hltn 'sport = :14443' | grep -q . && return 0; sleep 0.2; done; return 1; }
REFUSED='refused [A-Za-z]+'
OK='ok TLSv1\.[23]'
PLACEHOLDER=192.0.2.1
up=$(awk '$1 == "nameserver" {print $2; exit}' /run/systemd/resolve/resolv.conf)
dev=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p')
first() { p 0 dns udp 127.0.0.53 53 "$1" A | sed -n 's/.*addrs=\([^,]*\).*/\1/p'; }

echo "--- F-UNIT the unit, its uid and its sandbox"
pid=$(systemctl show -p MainPID --value desk-agent-filter.service)
want F-UNIT enabled "$(systemctl is-enabled desk-agent-filter.service)" enabled
want F-UNIT active "$(systemctl is-active desk-agent-filter.service)" active
want F-UNIT uid "$(awk '/^Uid:/ {print $2}' /proc/$pid/status 2>/dev/null)" 1106
want F-UNIT "effective capabilities" "$(awk '/^CapEff:/ {print $2}' /proc/$pid/status 2>/dev/null)" 0+
want F-UNIT "bounding capabilities" "$(awk '/^CapBnd:/ {print $2}' /proc/$pid/status 2>/dev/null)" 0+
want F-UNIT no_new_privs "$(awk '/^NoNewPrivs:/ {print $2}' /proc/$pid/status 2>/dev/null)" 1
want F-UNIT seccomp "$(awk '/^Seccomp:/ {print $2}' /proc/$pid/status 2>/dev/null)" 2
want F-UNIT MemoryMax "$(systemctl show -p MemoryMax --value desk-agent-filter.service)" 100663296
want F-UNIT Restart "$(systemctl show -p Restart --value desk-agent-filter.service)" always
want F-UNIT "/data's mode, as it sees it" "$(nsenter -t "$pid" -m stat -c %a /data 2>&1)" 0
systemctl show -p Before --value desk-agent-filter.service | grep -q desk-agent.service || bad F-UNIT "it isn't ordered before desk-agent"
listeners=$(ss -Hltnup | grep -w "pid=$pid" | awk '{print $5}' | LC_ALL=C sort -u | paste -sd' ')
want F-UNIT "its listeners" "$listeners" '127\.0\.0\.1:14053 127\.0\.0\.1:14443( \[::1\]:14053 \[::1\]:14443)?'
out=$(RELEASE_DIR=/opt/ma/desk-agent-filter/current /opt/ma/desk-agent-filter/current/health 2>&1) && echo "F-UNIT health: ok" || bad F-UNIT "health: $out"
want F-UNIT "agent-egress.conf" "$(stat -c '%U %G %a' /etc/ma/agent-egress.conf)" 'root root 644'
want F-UNIT "providers in agent-egress.conf" "$(grep -c '^api\.' /etc/ma/agent-egress.conf)" 3

echo "--- F-BUF each connection's buffers are set, not left to TCP to grow into MemoryMax: from desk-agent 16 KiB and to it 256 KiB, from the provider 256 KiB and to it 64 KiB, each doubled by the kernel"
as 1103 python3 -I /var/tmp/afprobe.py hold api.anthropic.com $PLACEHOLDER 6 > $LOG/hold.txt 2>&1 & HP=$!
for i in $(seq 1 40); do grep -q '^held' $LOG/hold.txt && break; sleep 0.2; done
socks=$(ss -HOtmnp state established 2>/dev/null | grep "pid=$pid,")
skm() { grep -E "$1" <<<"$socks" | head -1 | sed -n 's/.*skmem:([^)]*rb\([0-9]*\),[^)]*tb\([0-9]*\).*/rb\1 tb\2/p'; }
want F-BUF "towards desk-agent" "$(skm '127\.0\.0\.1:14443 ')" 'rb32768 tb524288'
want F-BUF "towards the provider" "$(skm ':443 +users:')" 'rb524288 tb131072'
kill $HP 2>/dev/null; wait $HP 2>/dev/null

echo "--- F-RULES the rules: a redirect, and no address sets"
rules=$(nft list table inet ma)
grep -q 'agent_https\|agent_dns' <<<"$rules" && bad F-RULES "the old address sets are still there"
grep -q 'type nat hook output priority' <<<"$rules" || bad F-RULES "no redirect chain"

echo "--- F-PROV uid 1103 reaches each provider, with no key: a 401 or the like is the success"
for h in api.anthropic.com api.openai.com api.x.ai; do
  c=$(http 1103 https://$h/v1/models); want F-PROV "$h" "$c" '[2-4][0-9][0-9]'
done
echo "--- F-PLACE and by the placeholder address DNS gives it, with the provider's certificate"
for h in api.anthropic.com api.openai.com api.x.ai; do want F-PLACE "$h" "$(p 1103 tls $h $PLACEHOLDER)" "$OK"; done
echo "--- F-ADDR the address uid 1103 aims at doesn't matter: aimed at 8.8.8.8, which doesn't serve it, a listed name still gets its own provider"
want F-ADDR "control: desk (1100), api.anthropic.com at 8.8.8.8" "$(p 1100 tls api.anthropic.com 8.8.8.8)" 'badcert .*|alert .*'
want F-ADDR "agent, api.anthropic.com at 8.8.8.8" "$(p 1103 tls api.anthropic.com 8.8.8.8)" "$OK"

echo "--- F-CF a Cloudflare site that isn't listed, by its own address and aimed at the listed names' addresses"
CF=www.cloudflare.com
aO=$(first api.openai.com); aX=$(first api.x.ai); aC=$(first $CF)
[ -n "$aO" ] && [ -n "$aX" ] && [ -n "$aC" ] || bad F-CF "no address to test with: $aO $aX $aC"
# The control: the same site on the same address, from a uid the filter doesn't hold, or the refusal below proves nothing.
want F-CF "control: desk (1100) to $CF on api.openai.com's address" "$(p 1100 tls $CF "$aO")" "$OK"
want F-CF "control: desk (1100) to $CF on api.x.ai's address" "$(p 1100 tls $CF "$aX")" "$OK"
want F-CF "agent to $CF on api.openai.com's address" "$(p 1103 tls $CF "$aO")" "$REFUSED"
want F-CF "agent to $CF on api.x.ai's address" "$(p 1103 tls $CF "$aX")" "$REFUSED"
want F-CF "agent to $CF on its own address" "$(p 1103 tls $CF "$aC")" "$REFUSED"
want F-CF "agent to https://$CF/" "$(http 1103 https://$CF/)" 000
want F-CF "control: desk (1100) to https://$CF/" "$(http 1100 https://$CF/)" '[2-4][0-9][0-9]'
want F-CF "agent to a name under a listed one" "$(p 1103 tls foo.api.openai.com "$aO")" "$REFUSED"

echo "--- F-NOSNI no SNI, and F-IP direct by IP"
want F-NOSNI "control: desk (1100), no SNI, 1.1.1.1" "$(p 1100 tls - 1.1.1.1)" "$OK"
want F-NOSNI "agent, no SNI, 1.1.1.1" "$(p 1103 tls - 1.1.1.1)" "$REFUSED"
want F-NOSNI "agent, no SNI, api.openai.com's address" "$(p 1103 tls - "$aO")" "$REFUSED"
want F-IP "control: desk (1100) to https://1.1.1.1/" "$(http 1100 https://1.1.1.1/)" '[2-4][0-9][0-9]'
want F-IP "agent to https://1.1.1.1/" "$(http 1103 https://1.1.1.1/)" 000

echo "--- F-ECH encrypted_client_hello: a listed name outside could hide another site inside"
want F-ECH "control: agent, a hello by hand, no ECH" "$(p 1103 rawhello api.anthropic.com plain $PLACEHOLDER)" answered
want F-ECH "control: desk (1100), the same with ECH, at the provider" "$(p 1100 rawhello api.anthropic.com ech "$(first api.anthropic.com)")" answered
want F-ECH "agent, a listed name with ECH" "$(p 1103 rawhello api.anthropic.com ech $PLACEHOLDER)" "$REFUSED"

echo "--- F-UDP UDP 443, so no QUIC"
want F-UDP "agent, UDP 443 at 1.1.1.1" "$(p 1103 udp 1.1.1.1 443)" "$REFUSED"
want F-UDP "control: desk (1100), UDP 443 at 1.1.1.1" "$(p 1100 udp 1.1.1.1 443)" 'timeout|answered'
want F-UDP "agent, UDP 443 at api.openai.com's address" "$(p 1103 udp "$aO" 443)" "$REFUSED"

echo "--- F-PORTS other ports"
for port in 80 853 8443 22; do want F-PORTS "agent, TCP $port at 1.1.1.1" "$(p 1103 tcp 1.1.1.1 $port)" "$REFUSED"; done
want F-PORTS "control: desk (1100), TCP 80 at 1.1.1.1" "$(p 1100 tcp 1.1.1.1 80)" connected
want F-PORTS "agent to http://api.anthropic.com/" "$(http 1103 http://api.anthropic.com/)" 000

echo "--- F-DNS uid 1103's DNS, wherever it aims: a placeholder for a listed name, and nothing else"
for server in 127.0.0.53 "$up" 1.1.1.1; do
  want F-DNS "agent asks $server, UDP, listed A" "$(p 1103 dns udp $server 53 api.x.ai A)" "rcode=0 an=1 addrs=$PLACEHOLDER"
  want F-DNS "agent asks $server, TCP, listed A" "$(p 1103 dns tcp $server 53 api.x.ai A)" "rcode=0 an=1 addrs=$PLACEHOLDER"
  want F-DNS "agent asks $server, UDP, listed AAAA" "$(p 1103 dns udp $server 53 api.x.ai AAAA)" 'rcode=0 an=0 addrs='
  want F-DNS "agent asks $server, UDP, unlisted A" "$(p 1103 dns udp $server 53 $CF A)" 'rcode=3 an=0 addrs='
  want F-DNS "agent asks $server, TCP, unlisted A" "$(p 1103 dns tcp $server 53 $CF A)" 'rcode=3 an=0 addrs='
  want F-DNS "agent asks $server, UDP, TXT, unlisted" "$(p 1103 dns udp $server 53 cloudflare.com TXT)" 'rcode=3 an=0 addrs='
  want F-DNS "agent asks $server, UDP, TXT, listed" "$(p 1103 dns udp $server 53 api.x.ai TXT)" 'rcode=3 an=0 addrs='
done
echo "--- F-CTHOLE another uid's conntrack entry on the same ports doesn't carry uid 1103 past the redirect to the real stub"
sport=$(shuf -i 20000-30000 -n 1)
want F-CTHOLE "control: desk (1100) asks the stub, TXT, from port $sport" "$(p 1100 dns udp 127.0.0.53 53 cloudflare.com TXT $sport)" 'rcode=0 an=[1-9][0-9]* addrs='
want F-CTHOLE "agent asks the stub, TXT, from the same port, at once" "$(p 1103 dns udp 127.0.0.53 53 cloudflare.com TXT $sport)" 'none [A-Za-z ]+'
sport=$(shuf -i 30001-32000 -n 1)
p 1106 dns udp 127.0.0.53 53 api.x.ai A $sport >/dev/null
want F-CTHOLE "agent, from a port uid 1106 just used" "$(p 1103 dns udp 127.0.0.53 53 cloudflare.com TXT $sport)" 'none [A-Za-z ]+'
want F-DNS "control: desk (1100) asks the stub, TXT" "$(p 1100 dns udp 127.0.0.53 53 cloudflare.com TXT)" 'rcode=0 an=[1-9][0-9]* addrs='
want F-DNS "control: desk (1100) asks the stub, listed A isn't the placeholder" "$(p 1100 dns udp 127.0.0.53 53 api.x.ai A | grep -c "$PLACEHOLDER")" 0
echo "--- F-LOOP loopback stays open to uid 1103, and 9222 and IMDS stay shut"
python3 -I -m http.server --bind 127.0.0.1 8131 --directory /var/tmp >/dev/null 2>&1 & H=$!; sleep 1
want F-LOOP "agent to another loopback port" "$(http 1103 http://127.0.0.1:8131/afprobe.py)" 200
kill $H; wait $H 2>/dev/null
want F-LOOP "agent to IMDS on 80" "$(p 1103 tcp 169.254.169.254 80)" "$REFUSED"
want F-LOOP "agent to 9222" "$(p 1103 tcp 127.0.0.1 9222)" "$REFUSED"

echo "--- F-UIDS only uid 1103 reaches the filter's ports"
for u in 0 1100 1101 1102 1104 1106 65534; do
  want F-UIDS "uid $u, TCP 14443" "$(p $u tcp 127.0.0.1 14443)" "$REFUSED"
  want F-UIDS "uid $u, TCP 14053" "$(p $u tcp 127.0.0.1 14053)" "$REFUSED"
  want F-UIDS "uid $u, UDP 14053" "$(p $u dns udp 127.0.0.1 14053 api.x.ai A)" 'none [A-Za-z ]+'
done
for u in 0 1102; do
  want F-UIDS "uid $u, TCP [::1]:14443" "$(p $u tcp ::1 14443)" "$REFUSED"
  want F-UIDS "uid $u, UDP [::1]:14053" "$(p $u dns udp ::1 14053 api.x.ai A)" 'none [A-Za-z ]+'
done
want F-UIDS "control: uid 1103, TCP 14443" "$(p 1103 tcp 127.0.0.1 14443)" connected
want F-UIDS "control: uid 1103, UDP 14053" "$(p 1103 dns udp 127.0.0.1 14053 api.x.ai A)" "rcode=0 an=1 addrs=$PLACEHOLDER"

echo "--- F-FUID what uid 1106 may reach: TCP 443 and the stub, nothing else"
want F-FUID "IMDS on 80" "$(p 1106 tcp 169.254.169.254 80)" "$REFUSED"
want F-FUID "IMDS on 443" "$(p 1106 tcp 169.254.169.254 443)" "$REFUSED"
want F-FUID "TCP 80 at 1.1.1.1" "$(p 1106 tcp 1.1.1.1 80)" "$REFUSED"
want F-FUID "TCP 8443 at 1.1.1.1" "$(p 1106 tcp 1.1.1.1 8443)" "$REFUSED"
want F-FUID "UDP 443 at 1.1.1.1" "$(p 1106 udp 1.1.1.1 443)" "$REFUSED"
want F-FUID "TCP 443 at a private address" "$(p 1106 tcp 10.0.0.1 443)" "$REFUSED"
want F-FUID "DNS at the resolver" "$(p 1106 dns udp "$up" 53 cloudflare.com A)" 'none [A-Za-z ]+'
want F-FUID "DNS at 1.1.1.1" "$(p 1106 dns udp 1.1.1.1 53 cloudflare.com A)" 'none [A-Za-z ]+'
want F-FUID "another loopback port" "$(p 1106 tcp 127.0.0.1 9222)" "$REFUSED"
want F-FUID "control: TCP 443 at 1.1.1.1" "$(p 1106 tcp 1.1.1.1 443)" connected
want F-FUID "control: the stub" "$(p 1106 dns udp 127.0.0.53 53 cloudflare.com A)" 'rcode=0 an=[1-9].*'
want F-FUID "control: desk (1100) reaches IMDS" "$(p 1100 tcp 169.254.169.254 80)" 'connected|refused ConnectionRefusedError'

echo "--- F-PRIV a listed name that resolves to a private address opens nothing"
cp /etc/hosts $LOG/hosts.bak; cp /etc/ma/agent-egress.conf $LOG/conf.bak
restore_conf() { cp $LOG/hosts.bak /etc/hosts; cp $LOG/conf.bak /etc/ma/agent-egress.conf; }
printf '10.1.2.3 verify-private.invalid\n169.254.169.253 verify-link.invalid\n' >> /etc/hosts
printf 'verify-private.invalid\nverify-link.invalid\n' >> /etc/ma/agent-egress.conf
systemctl restart desk-agent-filter.service; wait_up
s=$(date '+%F %T')
for n in verify-private.invalid verify-link.invalid; do
  want F-PRIV "$n" "$(p 1103 tls $n $PLACEHOLDER)" "$REFUSED"
done
sleep 0.5
said=$(journalctl -u desk-agent-filter --since "$s" --no-pager -o cat | grep -c 'no global address')
want F-PRIV "the journal says why, for both" "$said" 2
restore_conf; systemctl restart desk-agent-filter.service; wait_up

echo "--- F-LOG a limited rate of names, and never contents"
sleep "${F_LOG_WAIT:-61}" # a fresh minute's budget
s=$(date '+%F %T')
p 1103 hellos 40 verify-marker >/dev/null
sleep 0.5
logged=$(journalctl -u desk-agent-filter --since "$s" --no-pager -o cat)
want F-LOG "the refused request, with no bytes of it" "$(grep -c '^refused: malformed hello$' <<<"$logged")" 1
want F-LOG "refused names in the journal, of 40: the minute's 10 lines, less that one" "$(grep -c "verify-marker-[0-9]*.example.com isn't on the list" <<<"$logged")" 9
want F-LOG "a request's bytes in the journal" "$(grep -c 'verify-marker-contents' <<<"$logged")" 0

echo "--- F-CLASS the filter's traffic on $dev is in the shaper's default class, 1:20, not root's and deskd's 1:15 (ADR 0036)"
if tc class show dev "$dev" | grep -q 'class htb 1:20'; then
  bytes() { tc -s -j class show dev "$dev" | jq -r --arg c "$1" '.[] | select(.handle == $c) | .stats.bytes'; }
  nft insert rule inet ma output meta skuid 1106 oif "$dev" counter comment '"verify-class"'
  h=$(nft -a list chain inet ma output | sed -n 's/.*comment "verify-class" # handle \([0-9]*\).*/\1/p')
  b20=$(bytes 1:20); b15=$(bytes 1:15)
  for i in $(seq 1 40); do http 1103 https://api.anthropic.com/v1/models >/dev/null; done
  sent=$(nft -a list chain inet ma output | sed -n 's/.*counter packets [0-9]* bytes \([0-9]*\).*verify-class.*/\1/p')
  d20=$(( $(bytes 1:20) - b20 )); d15=$(( $(bytes 1:15) - b15 ))
  nft delete rule inet ma output handle "$h"
  echo "F-CLASS uid 1106 sent $sent bytes on $dev; class 1:20 moved $d20, class 1:15 moved $d15"
  [ "${sent:-0}" -gt 20000 ] || bad F-CLASS "uid 1106 sent only ${sent:-0} bytes, too few to tell"
  [ "$d20" -ge "$sent" ] || bad F-CLASS "class 1:20 moved $d20 of the $sent bytes uid 1106 sent"
else
  echo "F-CLASS no shaper on $dev here: a self-hosted desk has none, and nothing depends on one"
fi

echo "--- F-CT from a host-network container as uid 1103, as desk-agent runs: no way to resolved but through the filter"
if docker info >/dev/null 2>&1; then
  docker pull public.ecr.aws/docker/library/alpine:3 2>&1 | tail -1 || docker pull alpine:3 2>&1 | tail -1
  IMG=$(docker images -q public.ecr.aws/docker/library/alpine:3 | head -1); [ -n "$IMG" ] || IMG=$(docker images -q alpine:3 | head -1)
  docker run --rm --network host --user 1103:1103 --read-only --cap-drop=ALL --security-opt=no-new-privileges ${F_CT_ARGS:-} "$IMG" sh -c '
    echo "resolv.conf: $(grep nameserver /etc/resolv.conf | tr "\n" " ")"
    echo "listed: $(nslookup -type=a api.anthropic.com 2>&1 | grep -c "^Address: 192\.0\.2\.1$")"
    echo "unlisted: $(nslookup -type=a deb.debian.org 2>&1 | grep -c "^Address: ")"
    echo "txt: $(nslookup -type=txt cloudflare.com 2>&1 | grep -c "text = ")"
    echo "varlink: $(ls /run/systemd/resolve/ 2>/dev/null | wc -l)"
    for u in https://api.anthropic.com/v1/models https://deb.debian.org/ https://1.1.1.1/; do echo "$u: $(wget -T 6 -O /dev/null "$u" 2>&1 | tail -1)"; done' > $LOG/ct.txt 2>&1
  cat $LOG/ct.txt
  grep -q '^listed: 1$' $LOG/ct.txt || bad F-CT "the container didn't get the placeholder for a listed name"
  grep -q '^unlisted: 0$' $LOG/ct.txt || bad F-CT "the container resolved an unlisted name"
  grep -q '^txt: 0$' $LOG/ct.txt || bad F-CT "the container got a TXT answer"
  grep -q '^varlink: 0$' $LOG/ct.txt || bad F-CT "the container can see resolved's socket"
  grep '^https://api.anthropic.com' $LOG/ct.txt | grep -q ' HTTP/1\.1 [2-4][0-9][0-9]' || bad F-CT "the container can't reach a provider"
  grep '^https://deb.debian.org' $LOG/ct.txt | grep -q 'bad address' || bad F-CT "an unlisted name wasn't refused in the container"
  grep '^https://1.1.1.1' $LOG/ct.txt | grep -q -E 'HTTP/1\.1|saved' && bad F-CT "the container reached 1.1.1.1 by address"
else
  echo "F-CT no Docker here"
fi

echo "--- F-STOP with the filter stopped, uid 1103 has no way out"
systemctl stop desk-agent-filter.service
want F-STOP "stopped" "$(systemctl is-active desk-agent-filter.service)" 'inactive|failed'
out=$(RELEASE_DIR=/opt/ma/desk-agent-filter/current /opt/ma/desk-agent-filter/current/health 2>&1) && bad F-STOP "health says ok with it stopped" || echo "F-STOP health fails: $out"
want F-STOP "a provider by name" "$(http 1103 https://api.anthropic.com/v1/models)" 000
want F-STOP "the placeholder" "$(p 1103 tls api.x.ai $PLACEHOLDER)" "$REFUSED"
want F-STOP "a provider's real address" "$(p 1103 tls api.openai.com "$aO")" "$REFUSED"
want F-STOP "TCP 443 at 1.1.1.1" "$(p 1103 tcp 1.1.1.1 443)" "$REFUSED"
want F-STOP "TCP 80 at 1.1.1.1" "$(p 1103 tcp 1.1.1.1 80)" "$REFUSED"
want F-STOP "UDP 443 at 1.1.1.1" "$(p 1103 udp 1.1.1.1 443)" "$REFUSED"
want F-STOP "DNS at the stub, UDP" "$(p 1103 dns udp 127.0.0.53 53 api.x.ai A)" 'none [A-Za-z ]+'
want F-STOP "DNS at the stub, TCP" "$(p 1103 dns tcp 127.0.0.53 53 api.x.ai A)" 'none [A-Za-z ]+'
want F-STOP "DNS at 1.1.1.1" "$(p 1103 dns udp 1.1.1.1 53 api.x.ai A)" 'none [A-Za-z ]+'
echo "--- F-SQUAT and nothing else can stand in on its ports meanwhile"
as 1102 python3 -I /var/tmp/afprobe.py standin 127.0.0.1 14443 6 & SQ1=$!
as 1102 python3 -I /var/tmp/afprobe.py standin 127.0.0.1 14053 6 & SQ2=$!
sleep 1
want F-SQUAT "agent aiming at the port" "$(p 1103 tcp 127.0.0.1 14443)" "$REFUSED"
want F-SQUAT "agent's HTTPS" "$(p 1103 tcp 1.1.1.1 443)" "$REFUSED"
want F-SQUAT "agent's DNS over TCP" "$(p 1103 dns tcp 127.0.0.53 53 api.x.ai A)" 'none [A-Za-z ]+'
want F-SQUAT "agent's DNS over UDP" "$(p 1103 dns udp 127.0.0.53 53 api.x.ai A)" 'none [A-Za-z ]+'
wait $SQ1 $SQ2 2>/dev/null
echo "--- F-BACK started again, and killed outright, it's back on its own"
systemctl start desk-agent-filter.service; wait_up || bad F-BACK "nothing listens after a start"
want F-BACK "a provider, after a start" "$(http 1103 https://api.anthropic.com/v1/models)" '[2-4][0-9][0-9]'
pid=$(systemctl show -p MainPID --value desk-agent-filter.service); kill -9 "$pid"; sleep 3; wait_up
new=$(systemctl show -p MainPID --value desk-agent-filter.service)
[ "$new" != "$pid" ] && [ "$new" != 0 ] || bad F-BACK "no new process after kill -9"
want F-BACK "a provider, after kill -9" "$(http 1103 https://api.anthropic.com/v1/models)" '[2-4][0-9][0-9]'
echo "--- journal"
journalctl -u desk-agent-filter -b --no-pager -o cat | tail -4 | cut -c1-120
rm -rf /var/tmp/afprobe.py $LOG
echo "ran to the end"
