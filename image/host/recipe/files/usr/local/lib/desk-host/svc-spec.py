#!/usr/bin/python3 -I
"""svc-spec.py <k> <service>: the OCI spec for one service's own sandbox in slot k (ADR 0072 section 2, WALL-06, RC-01).
svc-spec.py shares <k> <dir>: makes the slot's shared /run directories in <dir>, the slot's fresh host tmpfs.

Each of deskd, desk-agent, desk-notebook, desk-rtc, desk-stream and desk-data runs as a runc container of its own that joins
the desk's user namespace, and only what it needs of the desk's others, through the host-owned bind of each namespace file
desk-host made at runc create (/run/desk-host/ns/<k>/, RC-01: never /proc/<pid>/ns at a later start). Every runc input is
the host's:
- its code: the slot's copy of the host's release store (/srv/desk-host/slots/<k>/rel/<svc>, copied at prepare from
  /srv/desk-host/releases/<svc>/current, which desk-host-release filled only from artifacts whose sha256 is in the host's
  releases.pin), never the desk's /opt/ma. deskd, desk-agent and desk-notebook run on their release's own root; desk-rtc,
  desk-stream and desk-data on the slot's own template generation (ADR 0077: the one its record names, read-only, host-owned,
  never booted), desk-rtc's and desk-stream's release
  mounted at /opt/ma-host/release;
- its resolver: a service on a release's own root (deskd, desk-agent, desk-notebook) gets the template's /etc/resolv.conf bound over
  the release's empty one, read-only, and nothing else of /etc (the services on the template have it already). For desk-agent
  nothing changes in who answers: nftables redirects uid 1103's port 53 to desk-agent-filter whatever the file says (ADR 0070).
- its /run directories: binds from the slot's host-owned tmpfs, made fresh before any desk process runs;
- its /data directory: none here. mounts.py moves an open_tree() clone of the desk's own directory in after runc create,
  resolved with openat2() from the host's own detached mount of the volume (RESOLVE_IN_ROOT, no links, no crossings), over
  a placeholder each `data` entry gets here (an empty tmpfs, mode 000). deskd has two: desk and files (its Files tree, free
  walk H5); a files directory the volume hasn't yet leaves deskd its placeholder, so Files answers unavailable that run.
Docker's isolation, as each `docker run` gave it: own mount, PID, IPC, UTS and cgroup namespaces; deskd, desk-agent and
desk-rtc in the desk's network namespace, desk-notebook, desk-stream and desk-data in an empty one; desk-stream in the
desk's IPC namespace (MIT-SHM from the desk's Xorg). Read-only root, its uid, no capabilities (desk-rtc NET_BIND_SERVICE,
desk-data DAC_READ_SEARCH, each as its unit), no_new_privs, the slot's AppArmor profile, Docker's seccomp profile with no
namespaces, setns or clone3 (the unit filter) and RC-02's socket allow-list, memory, tasks and CPU weight in its own cgroup
under the desk's share, no core files. Process 1 is desk-svc, which restarts the service as its unit says; for desk-stream
it starts and stops it when desk-init asks over /run/desk-ctl (deskd's on-demand requests); for desk-data it is the
Accept=yes socket, one desk-data per connection, uid 1100 only (WALL-06: desk-data non-root, in its own container).
ADR 0036's stream profile, the host's /run/desk-host/<k>/egress, is bound read-only and noexec at /run/desk-egress in desk-stream
(its conf) and desk-rtc (0.5.1 says a member's level is held there, S-29). A live switch (ADR 0078 2.2) makes a sandbox from this
same spec; desk-host-check svc-spec compares every running sandbox's config.json with what this makes now.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wallspec  # noqa: E402

DH = wallspec.DH
DESK_DATA_UID = 1112   # desk-data, added to the template by build.sh (ADR 0072, WALL-06)
T = RESOLV = None      # set per slot by use(): the slot's own template generation (ADR 0077 1.1), never another's


def use(k):
    """The slot's template generation, as its record names it (desk-host writes the record before any runc create)."""
    global T, RESOLV
    with open(f"{os.environ.get('DESK_HOST_RECORDS', '/var/lib/desk-host/slots')}/{k}.json") as fh:
        rec = json.load(fh)
    gen = rec.get("template")
    if not isinstance(gen, str) or not gen[:1] == "g" or not gen[1:].isdigit():
        raise SystemExit(f"slot {k}: its record names no template generation")
    T = f"{wallspec.DH}/templates/{gen}"
    if not os.path.isfile(f"{T}/.complete"):
        raise SystemExit(f"slot {k}: generation {gen} isn't sealed")
    RESOLV = f"{T}/etc/resolv.conf"   # the desk's resolver: nameserver 169.254.169.253, the VPC's, which the slot's firewall lets through on 53


def ids():
    users = {l.split(":")[0]: int(l.split(":")[2]) for l in open(f"{T}/etc/passwd") if l.count(":") >= 3}
    groups = {l.split(":")[0]: int(l.split(":")[2]) for l in open(f"{T}/etc/group") if l.count(":") >= 3}
    return users, groups


def make_shares(k, d):
    use(k)
    users, groups = ids()
    base = wallspec.BASE_ID_OF(k)
    for name, (_inside, owner, group, mode) in wallspec.shares(k).items():
        p = os.path.join(d, name)
        os.mkdir(p)
        u = owner if isinstance(owner, int) else users[owner]
        g = group if isinstance(group, int) else groups[group]
        os.chown(p, base + u, base + g)
        os.chmod(p, mode)
    print(f"slot {k}: shares {' '.join(sorted(wallspec.shares(k)))}")


def env_file(path):
    out = []
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                out.append(line)
    except OSError:
        pass
    return out


def deskd_env(k):
    """deskd's endpoints from /etc/desk-host/desk-host.conf (DESKD_ENV, ';'-separated, {k} the slot)."""
    return [e.replace("{k}", str(k)) for e in wallspec.conf().get("DESKD_ENV", "").split(";") if "=" in e]


def spec(k, name):
    use(k)
    users, groups = ids()
    rel = f"{DH}/slots/{k}/rel/{name}"
    java = ["/opt/java/openjdk/bin/java"]
    release_env = lambda svc: env_file(f"{rel}/image.env") + env_file(f"{rel}/{svc}.env")   # noqa: E731
    S = {
        "deskd": dict(oom=-500, root=f"{rel}/rootfs", uid=1100, gid=1100, gids=[], cwd="/app", argv=java + ["@/app/jvm.options", "-jar", "/app/deskd.jar"],
                      sup=["-restart", "always", "-restart-sec", "3", "-stop-timeout", "60"], net="ns", ipc="new",
                      shares=["desk", "desk-agent", "desk-notebook"], data=["desk", "files"], mem="512M", pids=256, weight=20,
                      env=release_env("deskd") + deskd_env(k) + ["HOME=/tmp"] + env_file(f"{rel}/version.env")),
        "desk-agent": dict(oom=200, root=f"{rel}/rootfs", uid=1103, gid=1103, gids=[], cwd="/app", argv=java + ["@/app/jvm.options", "-jar", "/app/desk-agent.jar"],
                           sup=["-restart", "always", "-restart-sec", "3", "-stop-timeout", "30"], net="ns", ipc="new",
                           shares=["desk-agent"], data=["agent"], mem="320M", pids=128, weight=10, env=release_env("desk-agent") + ["HOME=/tmp"]),
        "desk-notebook": dict(oom=-200, root=f"{rel}/rootfs", uid=1105, gid=1105, gids=[], cwd="/app",
                              argv=["/usr/local/bin/node", "--max-old-space-size=192", "--disable-warning=ExperimentalWarning", "/app/desk-notebook.mjs"],
                              sup=["-restart", "always", "-restart-sec", "3", "-stop-timeout", "30"], net="new", ipc="new",
                              shares=["desk-notebook"], data=["notebook"], mem="320M", pids=64, weight=10, env=release_env("desk-notebook") + ["HOME=/tmp"]),
        "desk-rtc": dict(oom=-500, root=T, release=rel, uid=users["rtc"], gid=users["rtc"], gids=[groups["desk"]], cwd="/", argv=["/opt/ma-host/release/run"],
                         sup=["-restart", "always", "-restart-sec", "2", "-stop-timeout", "30"], net="ns", ipc="new",
                         shares=["desk", "desk-media", "x11"], data=["rtc"], mem="128M", pids=256, weight=400, caps=["CAP_NET_BIND_SERVICE"],
                         hostdir=True, egress=True, env=["DISPLAY=:99", "RELEASE_DIR=/opt/ma-host/release", "HOME=/tmp"]),
        "desk-stream": dict(oom=100, root=T, release=rel, uid=users["stream"], gid=users["stream"], gids=[groups["desk-audio"]], cwd="/",
                            argv=["/bin/sh", "-c", '[ -e "$GST_REGISTRY_1_0" ] || cp /usr/local/lib/ma/gst-registry.bin "$GST_REGISTRY_1_0"; '
                                  'exec /opt/ma-host/release/run'],
                            sup=["-restart", "on-failure", "-restart-sec", "1", "-stop-timeout", "30", "-ctl", "/run/desk-ctl/desk-stream.sock", "-on-demand"],
                            net="new", ipc="ns", shares=["x11", "desk-audio", "desk-media", "desk-ctl"], data=[], mem="384M", pids=256, weight=400, egress=True,
                            tmpfs={"/run/desk-stream": f"uid={users['stream']},gid={users['stream']},mode=755,size=16m"},
                            env=["DISPLAY=:99", "PULSE_SERVER=unix:/run/desk-audio/native", "RELEASE_DIR=/opt/ma-host/release",
                                 "HOME=/run/desk-stream", "GST_REGISTRY_1_0=/run/desk-stream/registry.bin"]),
        # desk-data (WALL-06): non-root, CAP_DAC_READ_SEARCH only, /data read-only but its scratch (mounts.py), no network;
        # desk-svc is systemd's Accept=yes socket. Its group is desk, so deskd can connect; desk-data itself serves uid 1100 only.
        "desk-data": dict(oom=0, root=T, uid=DESK_DATA_UID, gid=groups["desk"], gids=[], cwd="/",
                          argv=["/usr/bin/python3", "-I", "/usr/local/lib/ma/desk-data"],
                          sup=["-accept", "/run/desk/data.sock", "-accept-mode", "0660", "-max-conn", "24", "-peer-uid", "1100"],
                          net="new", ipc="new", shares=["desk"], data=[], datawhole=True, mem="512M", pids=64, weight=10, caps=["CAP_DAC_READ_SEARCH"],
                          env=["HOME=/tmp"]),
    }[name]

    d = wallspec.docker_spec()
    caps = S.get("caps", [])
    p = d["process"]
    p["terminal"] = False
    p["user"] = {"uid": S["uid"], "gid": S["gid"], **({"additionalGids": S["gids"]} if S["gids"] else {})}
    p["args"] = ["/desk-host/desk-svc", *S["sup"], "--", *S["argv"]]
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    for line in S["env"]:
        key, val = line.split("=", 1)
        env[key] = val
    p["env"] = [f"{a}={b}" for a, b in env.items()]
    p["cwd"] = S["cwd"]
    p["capabilities"] = {kind: list(caps) for kind in ("bounding", "effective", "permitted", "inheritable", "ambient")}
    p["noNewPrivileges"] = True
    p["apparmorProfile"] = f"desk-host-{k}"
    p["oomScoreAdj"] = S["oom"]   # the kill order under memory pressure (docs/interfaces/desk-runtime.md, "Restarts and memory pressure"): runc applies it to process 1 (desk-svc), which its service inherits
    p["rlimits"] = [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}, {"type": "RLIMIT_CORE", "hard": 0, "soft": 0}]
    d["root"] = {"path": S["root"], "readonly": True}
    d["hostname"] = f"desk-{k}"
    d.pop("hooks", None)
    d.pop("annotations", None)

    keep = {"/proc", "/dev", "/dev/pts", "/sys"}
    mounts = [m for m in d["mounts"] if m["destination"] in keep]
    for m in mounts:
        if m["destination"] == "/dev/pts":
            m["options"] = [o for o in m["options"] if not o.startswith("gid=")]
    mounts += [
        {"destination": "/sys/fs/cgroup", "type": "cgroup", "source": "cgroup", "options": ["nosuid", "noexec", "nodev", "relatime", "ro"]},
        {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=64m"]},
        {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=128m"]},
        {"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "noexec", "mode=755", "size=16m"]},
        wallspec.bind(f"{wallspec.LIB}/desk", "/desk-host", ro=True),
    ]
    if S.get("release"):   # desk-rtc's and desk-stream's code: the slot's copy of the host's store, never the template's /opt/ma
        mounts.append(wallspec.bind(S["release"], "/opt/ma-host/release", ro=True))
    if S.get("hostdir"):   # desk-rtc reads its port from /etc/ma/desk-rtc.conf, a link to the host's file here (ADR section 6)
        mounts.append(wallspec.bind(f"/run/desk-host/{k}", "/run/desk-host", ro=True, extra=("noexec",)))
    if S.get("egress"):   # ADR 0036's stream profile (ADR 0072 section 8): the host's file, read-only; desk-stream's run picks stream-<profile>.conf
        # from it, and desk-rtc (0.5.1, S-29) reads it to say a member's level is held (--profile-file /run/desk-egress/profile)
        mounts.append(wallspec.bind(f"/run/desk-host/{k}/egress", "/run/desk-egress", ro=True, extra=("noexec",)))
    if S["root"] != T:   # a release's own root ships an empty /etc/resolv.conf (Bug 8): the desk's resolver, the template's file, read-only
        mounts.append(wallspec.bind(RESOLV, "/etc/resolv.conf", ro=True, extra=("noexec",)))
    if S["root"] == T:   # ProtectHome, as the units have it, on the image's root
        mounts += [{"destination": h, "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "noexec", "mode=755", "size=1m"]}
                   for h in ("/home", "/root", "/data")]
    else:
        mounts.append({"destination": "/data", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "noexec", "mode=755", "size=1m"]})
    shares = wallspec.shares(k)
    for s in S["shares"]:
        mounts.append(wallspec.bind(f"/run/desk-host/share/{k}/{s}", shares[s][0], extra=("noexec",)))
    for sub in S["data"]:   # placeholders: mounts.py moves the desk's own directory over each one
        mounts.append({"destination": f"/data/{sub}", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "noexec", "mode=000", "size=4k"]})
    for dst, opts in S.get("tmpfs", {}).items():
        mounts.append({"destination": dst, "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "noexec", *opts.split(",")]})
    d["mounts"] = mounts

    lx = d["linux"]
    nsd = f"/run/desk-host/ns/{k}"
    lx["namespaces"] = [{"type": "user", "path": f"{nsd}/user"}, {"type": "pid"}, {"type": "mount"}, {"type": "uts"}, {"type": "cgroup"},
                        {"type": "network", **({"path": f"{nsd}/net"} if S["net"] == "ns" else {})},
                        {"type": "ipc", **({"path": f"{nsd}/ipc"} if S["ipc"] == "ns" else {})}]
    lx.pop("uidMappings", None)   # joined by path: the desk's own mapping (runc 1.5 warns if both are given)
    lx.pop("gidMappings", None)
    lx["cgroupsPath"] = f"/{wallspec.CGROUP}/desk-{k}/svc-{name}"
    mem = {"M": 1 << 20, "G": 1 << 30}[S["mem"][-1]] * int(S["mem"][:-1])
    lx["resources"] = {"devices": lx.get("resources", {}).get("devices", []),
                       "unified": {"memory.max": str(mem), "memory.swap.max": "0", "pids.max": str(S["pids"]), "cpu.weight": str(S["weight"])}}
    lx.pop("sysctl", None)
    lx["maskedPaths"] = wallspec.masked(lx.get("maskedPaths", []))
    wallspec.seccomp(lx["seccomp"], allow_namespaces=False)
    return d


SERVICES = ("desk-rtc", "deskd", "desk-agent", "desk-notebook", "desk-stream", "desk-data")

if __name__ == "__main__":
    if sys.argv[1] == "shares":
        make_shares(int(sys.argv[2]), sys.argv[3])
        sys.exit(0)
    k, name = int(sys.argv[1]), sys.argv[2]
    if name not in SERVICES:
        raise SystemExit(f"no service {name}")
    out = f"{DH}/slots/{k}/svc/{name}"
    os.makedirs(out, mode=0o711, exist_ok=True)
    sp = spec(k, name)
    fd = os.open(f"{out}/config.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(sp, fh, indent=1)
    print(f"slot {k} {name}: root {sp['root']['path']} (ro), uid {sp['process']['user']['uid']}, caps {sp['process']['capabilities']['bounding'] or 'none'}, "
          f"ns {' '.join(n['type'] + ('=desk' if 'path' in n else '') for n in sp['linux']['namespaces'])}, cgroup {sp['linux']['cgroupsPath']}")
