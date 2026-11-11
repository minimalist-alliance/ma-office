"""idlerule.py: whether a slot's desk is idle, by desk-batch's rule (runtime spec section 6.1; ADR 0077 sections 1.5, 3 and 5).

The desk's deskd writes /run/desk/idle.json (from 2026.11.10-7e809cb). On a shared host that's the slot's /run share, host-owned
tmpfs at /run/desk-host/share/<k>/desk/idle.json, which the host reads as hostile, as desk-batch does on a desk of its own, under
RC-06's rules: opened O_NONBLOCK with openat2 from the share's directory (no link, nothing above it), a regular file of at most
64 KiB owned by the slot's uid 1100, under a timeout (the caller's). Missing, unreadable, not deskd's, or older than 60 s means
not idle. The rule is desk-batch's idle_now(), kept equal by image/host/tests/test_templates.py (it runs both on the same files):
sessions, Agent runs and exports all 0 for min(idleStopSeconds / 2, 3600) s, or 600 s without idleStopSeconds; an urgent target
after 24 h of waiting takes 15 minutes with no input (lastInputAt), after 72 h 60 s. A restart closes Chromium, so `downloads`
must also be 0 (ADR 0077 1.5).
"""
import calendar
import json
import os
import re
import stat
import time

MAX_IDLE = 64 * 1024
IDLE_FRESH_S = 60
IDLE_DEFAULT_S = 600
IDLE_MAX_S = 3600
URGENT_RELAX_S = 24 * 3600
URGENT_INPUT_S = 900
URGENT_LAST_S = 72 * 3600
URGENT_LAST_INPUT_S = 60
UTC = re.compile(r"\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z\Z")
NOW = time.time
SHARE = os.environ.get("DESK_HOST_SHARE", "/run/desk-host/share")


def parse_utc(s):
    if not isinstance(s, str):
        return None
    m = UTC.match(s)
    if not m:
        return None
    try:
        return calendar.timegm(tuple(int(x) for x in m.groups()[:6]) + (0, 0, 0)) + (float(m.group(7)) if m.group(7) else 0.0)
    except (ValueError, OverflowError):
        return None


class Unreadable(Exception):
    pass


def read_idle(k, owner=None):
    """idle.json's bytes from slot k's share, under RC-06's rules; owner is the host uid of the slot's 1100."""
    import templates   # openat2
    owner = owner if owner is not None else 100000 + k * 65536 + 1100
    d = f"{SHARE}/{k}/desk"
    try:
        dfd = os.open(d, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise FileNotFoundError(e.errno, f"{d}: {e.strerror}") from None
    try:
        fd = templates.openat2(dfd, "idle.json", os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_NOFOLLOW)
    finally:
        os.close(dfd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Unreadable("not a regular file")
        if st.st_uid != owner:
            raise Unreadable(f"owned by uid {st.st_uid}, not the slot's deskd")
        if st.st_size > MAX_IDLE:
            raise Unreadable(f"over {MAX_IDLE} bytes")
        data = os.read(fd, MAX_IDLE + 1)
        if len(data) > MAX_IDLE:
            raise Unreadable(f"over {MAX_IDLE} bytes")
        return data
    finally:
        os.close(fd)


def strict(data):
    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise Unreadable(f"key {k!r} twice")
            d[k] = v
        return d

    def constant(c):
        raise Unreadable(f"{c} isn't JSON")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise Unreadable(type(e).__name__) from None


def rule(d, pending=None, downloads=True, now=None):
    """(idle, reason) from idle.json's parsed object: desk-batch's idle_now(), plus downloads 0 when Chromium will close."""
    now = NOW() if now is None else now
    if not isinstance(d, dict):
        return False, "idle.json isn't an object"
    at = parse_utc(d.get("at"))
    if at is None:
        return False, "idle.json has no at"
    if now - at > IDLE_FRESH_S or at - now > IDLE_FRESH_S:
        return False, f"idle.json is {int(now - at)} s old"
    counts = {}
    for k in ("sessions", "agentTasks", "exports", "downloads"):
        v = d.get(k)
        if type(v) is not int or v < 0:
            return False, f"idle.json has no {k}"
        counts[k] = v
    if downloads and counts["downloads"]:
        return False, f"{counts['downloads']} downloads (Chromium would close under them)"
    stop = d.get("idleStopSeconds")
    if stop is not None and (type(stop) is not int or stop <= 0):
        return False, "bad idleStopSeconds"
    need = min(stop // 2, IDLE_MAX_S) if stop else IDLE_DEFAULT_S
    since = d.get("idleSince")
    since_t = parse_utc(since) if since is not None else None
    if since is not None and since_t is None:
        return False, "bad idleSince"
    if since_t is not None and counts["sessions"] == counts["agentTasks"] == counts["exports"] == 0 and now - since_t >= need:
        return True, f"idle {int(now - since_t)} s, {need} s needed"
    reason = (f"{counts['sessions']} sessions, {counts['agentTasks']} agent tasks, {counts['exports']} exports"
              if since_t is None or any(counts[k] for k in ("sessions", "agentTasks", "exports"))
              else f"idle {int(now - since_t)} s of {need} s")
    if pending and pending.get("urgent"):
        waited = now - (parse_utc(pending.get("offeredAt")) or now)
        last_input = parse_utc(d.get("lastInputAt")) if d.get("lastInputAt") is not None else None
        if last_input is None and since_t is not None and counts["sessions"] == 0:
            last_input = since_t
        if last_input is not None and waited >= URGENT_RELAX_S:
            quiet = URGENT_LAST_INPUT_S if waited >= URGENT_LAST_S else URGENT_INPUT_S
            if now - last_input >= quiet:
                return True, f"urgent, waited {int(waited)} s, no input for {int(now - last_input)} s"
    return False, reason


def slot_idle(k, pending=None, downloads=True, owner=None):
    """(idle, reason) for slot k, failing closed."""
    try:
        d = strict(read_idle(k, owner))
    except FileNotFoundError:
        return False, "no idle.json"
    except (OSError, Unreadable) as e:
        return False, f"idle.json unreadable: {e}"
    return rule(d, pending, downloads)
