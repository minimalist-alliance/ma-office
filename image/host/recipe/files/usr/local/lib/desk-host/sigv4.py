"""sigv4.py: AWS Signature Version 4 for the host link's calls (service execute-api), Python 3 standard library only.

Hand-written rather than vendored: it's the same forty lines deskd's own signer is (services/deskd, aws/SigV4.java), and the
tests hold it to AWS's published test suite (get-vanilla), AWS's documentation example (IAM ListUsers) and the vector
deskd's test holds equal to botocore's output for an agent call with a body and a session token
(image/host/tests/test_link.py). A host carries no Python package beyond the standard library.

sign() returns the headers to send: host, x-amz-date, x-amz-security-token (with a session token), authorization, and the
caller's own headers, lower-cased. Secrets never appear in an error.
"""
import datetime
import hashlib
import hmac
import urllib.parse

ALGORITHM = "AWS4-HMAC-SHA256"


def _enc(s):
    return urllib.parse.quote(s, safe="-_.~")


def _canonical_uri(path):
    if not path:
        return "/"
    return "/".join(_enc(urllib.parse.unquote(seg)) for seg in path.split("/"))


def _canonical_query(q):
    pairs = urllib.parse.parse_qsl(q, keep_blank_values=True)
    return "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(pairs))


def _hmac(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign(method, url, headers, body, service, region, access_key, secret_key, session_token=None, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz[:8]
    u = urllib.parse.urlsplit(url)
    host = u.hostname + (f":{u.port}" if u.port and not ((u.scheme == "https" and u.port == 443) or (u.scheme == "http" and u.port == 80)) else "")
    h = {k.lower(): " ".join(str(v).strip().split()) for k, v in (headers or {}).items()}
    h["host"] = host
    h["x-amz-date"] = amz
    if session_token:
        h["x-amz-security-token"] = session_token
    names = sorted(h)
    signed = ";".join(names)
    canonical = "\n".join([method.upper(), _canonical_uri(u.path), _canonical_query(u.query),
                           "".join(f"{n}:{h[n]}\n" for n in names), signed, hashlib.sha256(body or b"").hexdigest()])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join([ALGORITHM, amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = _hmac(_hmac(_hmac(_hmac(("AWS4" + secret_key).encode(), day), region), service), "aws4_request")
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    h["authorization"] = f"{ALGORITHM} Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={sig}"
    return h
