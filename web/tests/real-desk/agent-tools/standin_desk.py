#!/usr/bin/env python3
"""A scripted stand-in for Anthropic's streaming Messages API, for rt-agent-tools.mjs and rt-agent-perf.mjs --model standin.

It follows the release agent's stand-in for the Nov 13 tools release (docs/sub-status/agent-tools-release-1113.md, "The
real-desk proof"): on the staging TEST desk's loopback only, as nobody, reached by desk-agent through its documented
DESK_AGENT_ANTHROPIC_URL line; one made-up key; GET /v1/models with one model; each model step streamed as SSE in the
events desk-agent reads. It never reaches the internet and holds nothing real.

What it says comes from a JSON file of scripts, as tools/agent-harness/standin/standin.mjs and the harness contract
(sections 2 and 3) have them, read again whenever the file changes:

    {"canary": "mmcanary-<16 hex>" | null,
     "prompts": {"<the member's exact message>": [step, ...]}}

The member's message names the script: matched exactly, with a trailing "canary: ..." line taken off, or as the end of a
longer message. The step is the number of assistant turns after it. A step is one of
    {"calls": [{"name": tool, "input": {...}}]}   tool calls; an input value {"$re": {"step", "call", "pattern"}} is the
                                                  first capture group of the regex over that earlier step's tool result
    {"text": "..."}                               the reply
    {"readAll": {"path": p, "pattern": re, "say": "... {match} ..."}}
                                                  files_read from the start and on by each page's "next", then the reply,
                                                  with {match} the regex's first group over everything read (last step only)
Every "text" and "markdown" input it writes gets "\\n<canary>" at its end. Each request adds one line to <log dir>/log.jsonl:
the step, why, and the number of tools offered; never a message or a result.

    python3 -I standin_desk.py <port> <scripts.json> <key> <log dir>
"""
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "claude-sonnet-5-5"
UNKNOWN = "I don't know this task."
UNRESOLVED = "I couldn't find what I needed in the tool results, so I stopped here."
PAST = "Done."
CANARY_LINE = re.compile(r"(?:^|\n)canary: (mmcanary-[0-9a-f]+)[ \t]*$")
LEADS = [re.compile(r"^Approved by the member\.\n"), re.compile(r"^Approved by the member, but it failed: "), re.compile(r"^Done without asking[^\n]*\n")]
INT_KEYS = {"offset", "from", "limit", "inMinutes"}


class Unresolved(Exception):
    pass


class Scripts:
    """The scripts file, read again when it changes."""

    def __init__(self, path):
        self.path = path
        self.mtime = None
        self.data = {"canary": None, "prompts": {}}

    def get(self):
        try:
            m = os.stat(self.path).st_mtime_ns
        except OSError:
            return self.data
        if m != self.mtime:
            with open(self.path, encoding="utf-8") as f:
                self.data = json.load(f)
            self.mtime = m
        return self.data


def blocks(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return c if isinstance(c, list) else []


def message_text(msg):
    return "\n\n".join(b.get("text", "") for b in blocks(msg) if isinstance(b, dict) and b.get("type") == "text")


def result_text(block):
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def match_prompt(prompts, text):
    if not text:
        return None
    body = text
    m = CANARY_LINE.search(text)
    if m:
        body = text[: m.start()]
    for candidate in (body, body.rstrip()):
        if candidate in prompts:
            return candidate
    trimmed = body.rstrip()
    for p in sorted(prompts, key=len, reverse=True):
        if trimmed.endswith("\n" + p):
            return p
    return None


def candidates(text):
    """The texts a regex is tried on: the fenced JSON's content, the result without the loop's lead, the raw text."""
    out = []
    plain = text
    for lead in LEADS:
        plain = lead.sub("", plain, count=1)
    for line in plain.split("\n"):
        t = line.strip()
        if not t.startswith("{"):
            continue
        try:
            j = json.loads(t)
        except ValueError:
            continue
        if isinstance(j, dict) and isinstance(j.get("content"), str) and isinstance(j.get("source"), str):
            out.append(j["content"])
    out.append(plain)
    if plain != text:
        out.append(text)
    return out


def resolve_re(spec, ctx, key):
    step = spec.get("step")
    call = spec.get("call", 0)
    if step is None or step >= len(ctx["assistants"]):
        raise Unresolved(f"no step {step}")
    uses = [b for b in blocks(ctx["assistants"][step]) if isinstance(b, dict) and b.get("type") == "tool_use"]
    if call >= len(uses):
        raise Unresolved(f"no call {call} in step {step}")
    text = ctx["results"].get(uses[call].get("id"))
    if text is None:
        raise Unresolved(f"no result for step {step}")
    rx = re.compile(spec["pattern"])
    for c in candidates(text):
        m = rx.search(c)
        if m and m.group(1) is not None:
            v = m.group(1)
            if spec.get("as") == "int" or (spec.get("as") is None and key in INT_KEYS):
                return int(v)
            return v
    raise Unresolved(f"no match in step {step}")


def resolve(value, ctx, key=None):
    if isinstance(value, list):
        return [resolve(v, ctx, key) for v in value]
    if isinstance(value, dict):
        if "$re" in value:
            return resolve_re(value["$re"], ctx, key)
        return {k: resolve(v, ctx, k) for k, v in value.items()}
    return value


def plan(data, body):
    """What the model says now: (blocks, why). Blocks are ("text", str) or ("tool_use", name, input)."""
    prompts = data.get("prompts", {})
    msgs = body.get("messages", [])
    at = -1
    prompt = None
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get("role") != "user":
            continue
        p = match_prompt(prompts, message_text(msgs[i]))
        if p is not None:
            at, prompt = i, p
            break
    if prompt is None:
        return [("text", UNKNOWN)], "unknown", None
    after = msgs[at + 1:]
    assistants = [m for m in after if m.get("role") == "assistant"]
    results = {}
    for m in after:
        if m.get("role") == "user":
            for b in blocks(m):
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = result_text(b)
    ctx = {"assistants": assistants, "results": results}
    script = prompts[prompt]
    step = len(assistants)
    canary = data.get("canary")
    # A readAll step stays the step until its reads end.
    reading = next((i for i, s in enumerate(script) if "readAll" in s), None)
    if reading is not None and step >= reading:
        return read_all(script[reading]["readAll"], ctx, step - reading), f"readAll {step - reading}", step
    if step >= len(script):
        return [("text", PAST)], "past_script", step
    s = script[step]
    try:
        out = []
        if "text" in s:
            out.append(("text", s["text"]))
        for c in s.get("calls", []):
            inp = resolve(c.get("input", {}), ctx)
            if canary:
                for k in ("text", "markdown"):
                    if isinstance(inp.get(k), str):
                        inp[k] = inp[k] + "\n" + canary
            out.append(("tool_use", c["name"], inp))
        return (out or [("text", PAST)]), "script", step
    except Unresolved as e:
        return [("text", UNRESOLVED)], f"unresolved: {e}", step


def read_all(spec, ctx, reads):
    path = spec["path"]
    if reads == 0:
        return [("tool_use", "files_read", {"path": path})]
    last = ctx["assistants"][-1]
    uses = [b for b in blocks(last) if isinstance(b, dict) and b.get("type") == "tool_use"]
    text = ctx["results"].get(uses[0].get("id")) if uses else None
    nxt = None
    if text is not None:
        for c in candidates(text):
            m = re.search(r'"next"\s*:\s*(\d+)', c)
            if m:
                nxt = int(m.group(1))
                break
    if nxt is not None and reads < 400:
        return [("tool_use", "files_read", {"path": path, "offset": nxt})]
    found = None
    rx = re.compile(spec["pattern"])
    for t in ctx["results"].values():
        for c in candidates(t):
            m = rx.search(c)
            if m:
                found = m.group(1)
    return [("text", spec.get("say", "{match}").replace("{match}", found if found is not None else "(not found)"))]


def sse(kind, data):
    d = {"type": kind}
    d.update(data)
    return f"event: {kind}\ndata: {json.dumps(d)}\n\n"


def stream(parts):
    uses = any(p[0] == "tool_use" for p in parts)
    out = [sse("message_start", {"message": {"id": f"msg_rt{time.time_ns()}", "type": "message", "role": "assistant", "model": MODEL,
                                             "content": [], "stop_reason": None, "stop_sequence": None,
                                             "usage": {"input_tokens": 100, "output_tokens": 1}}})]
    for i, p in enumerate(parts):
        if p[0] == "text":
            out.append(sse("content_block_start", {"index": i, "content_block": {"type": "text", "text": ""}}))
            out.append(sse("content_block_delta", {"index": i, "delta": {"type": "text_delta", "text": p[1]}}))
        else:
            out.append(sse("content_block_start", {"index": i, "content_block": {"type": "tool_use", "id": f"toolu_rt{i}_{time.time_ns()}", "name": p[1], "input": {}}}))
            out.append(sse("content_block_delta", {"index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(p[2])}}))
        out.append(sse("content_block_stop", {"index": i}))
    out.append(sse("message_delta", {"delta": {"stop_reason": "tool_use" if uses else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 20}}))
    out.append(sse("message_stop", {}))
    return "".join(out)


def make_handler(scripts, key, logdir):
    def log(entry):
        if not logdir:
            return
        entry["t"] = round(time.time(), 3)
        try:
            with open(os.path.join(logdir, "log.jsonl"), "a") as f:
                f.write(json.dumps(entry) + "\n")
        except OSError:
            pass

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def send(self, code, ctype, body):
            data = body.encode()
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if self.headers.get("x-api-key") == key or self.headers.get("authorization") == f"Bearer {key}":
                return True
            self.send(401, "application/json", json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}))
            return False

        def do_GET(self):
            if not self.authorized():
                return
            if self.path.split("?")[0].endswith("/v1/models"):
                self.send(200, "application/json", json.dumps({"data": [{"type": "model", "id": MODEL, "display_name": "Claude Sonnet 5.5", "created_at": "2026-01-01T00:00:00Z"}],
                                                               "has_more": False, "first_id": MODEL, "last_id": MODEL}))
            else:
                self.send(404, "application/json", "{}")

        def do_POST(self):
            n = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(n)
            if not self.authorized():
                return
            try:
                body = json.loads(raw)
            except ValueError:
                self.send(400, "application/json", json.dumps({"type": "error", "error": {"type": "invalid_request_error"}}))
                return
            try:
                parts, why, step = plan(scripts.get(), body)
            except Exception as e:  # noqa: BLE001 - a broken script must still end the run with words
                parts, why, step = [("text", UNRESOLVED)], f"error {type(e).__name__}", None
            log({"step": step, "why": why, "tools": len(body.get("tools", []) or [])})
            self.send(200, "text/event-stream", stream(parts))

    return Handler


def main(argv):
    port, path, key = int(argv[1]), argv[2], argv[3]
    logdir = argv[4] if len(argv) > 4 else None
    ThreadingHTTPServer(("127.0.0.1", port), make_handler(Scripts(path), key, logdir)).serve_forever()


if __name__ == "__main__":
    main(sys.argv)
