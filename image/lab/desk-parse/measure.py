#!/usr/bin/env python3
"""measure.py <fixtures dir> <runs-of-pdf-500> [runs of each 20 MiB file] : on a desk-parse box (as root), the sandbox's peak memory for the worst-case files
as desk-agent asks (files_read: 2,000,000 characters, 500 pages), through desk-parse-ask as uid 1103 (the real parse path).
desk-parse is restarted before each run, so memory.peak and memory.events are that run's alone. A sampler reads the VmRSS of
every process in the container's cgroup every 10 ms (the worker JVM's whole RSS, its anonymous + file-backed split from
memory.stat at the end). Prints one 'parse-mem' line per run."""
import os, subprocess, sys, time, threading, glob

D = sys.argv[1]; N = int(sys.argv[2]) if len(sys.argv) > 2 else 5
M = int(sys.argv[3]) if len(sys.argv) > 3 else 1   # runs of each 20 MiB file
ASK = "/usr/local/lib/ma/desk-parse-ask"
AS = ["setpriv", "--reuid", "1103", "--regid", "1103", "--clear-groups", "--no-new-privs"]

def sh(*a): return subprocess.run(a, capture_output=True, text=True).stdout.strip()

def fresh():
    subprocess.run(["systemctl", "restart", "desk-parse.service"], check=True)
    for _ in range(120):
        if os.path.exists("/run/desk-parse/sock/parse.sock") and sh("docker", "inspect", "-f", "{{.State.Running}}", "desk-parse") == "true":
            break
        time.sleep(0.5)
    pid = sh("docker", "inspect", "-f", "{{.State.Pid}}", "desk-parse")
    cg = "/sys/fs/cgroup" + open(f"/proc/{pid}/cgroup").read().strip().split("::")[1]
    return cg

def run(kind, f, label, chars=2000000, pages=500):
    cg = fresh()
    stop = threading.Event(); best = [0]
    def sample():
        while not stop.is_set():
            try:
                for p in open(cg + "/cgroup.procs").read().split():
                    for l in open(f"/proc/{p}/status"):
                        if l.startswith("VmHWM:"): best[0] = max(best[0], int(l.split()[1]))
            except OSError: pass
            time.sleep(0.01)
    t = threading.Thread(target=sample); t.start()
    t0 = time.time()
    with open(os.path.join(D, f), "rb") as fh:
        r = subprocess.run(AS + [ASK, kind, str(chars), str(pages)], stdin=fh, capture_output=True)
    el = time.time() - t0
    time.sleep(0.05); stop.set(); t.join()
    peak = int(open(cg + "/memory.peak").read()); ev = dict(l.split() for l in open(cg + "/memory.events"))
    ms = dict(l.split() for l in open(cg + "/memory.stat"))
    head = r.stdout.split(b"\n")[0][:40].decode(errors="replace").replace(" ", ":")
    print(f"parse-mem {label} file={f} kind={kind} rc={r.returncode} answer={head or 'none'} out_bytes={len(r.stdout)} secs={el:.1f} "
          f"peak_mib={peak / 1048576:.1f} worker_rss_hwm_mib={best[0] / 1024:.1f} max={int(open(cg + '/memory.max').read()) >> 20} "
          f"oom={ev.get('oom', 0)} oom_kill={ev.get('oom_kill', 0)}", flush=True)

for i in range(N): run("pdf", "pdf-500.bin", f"worst-run{i + 1}")
for kind, f in (("text", "text-20.bin"), ("pdf", "pdf-text-20.bin"), ("pdf", "pdf-image-20.bin"), ("docx", "docx-20.bin"), ("xlsx", "xlsx-20.bin"), ("pptx", "pptx-20.bin")):
    for i in range(M): run(kind, f, f"20MiB-run{i + 1}")
