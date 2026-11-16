#!/usr/bin/python3 -I
"""courier-trackers.py: ADR 0076's pinned tracker list as hosts, for desk-parse's Courier mode (its Trackers class).

  courier-trackers.py <uBOLite release zip> <out file>

The zip is the release image/recipe/adblock/blocker.pin names (build-blocker.py fetches it and checks its sha256; this reads
the same file). Of it, only the EasyPrivacy ruleset (`easyprivacy`, the "EasyPrivacy-family" list the plan's section 3.4
names), and of that only `block` rules for every site (no `initiatorDomains`) whose resource types include images or pings
or are unrestricted, and that name either whole hosts (`requestDomains`, or a `urlFilter` of exactly `||host^` or
`||host`) or a host and a literal path prefix (`||host/path`, no wildcard). Out, after a comment naming the release and
the counts: one lowercase ASCII host a line, or `host/path` for a prefix, sorted. Courier removes an image whose host is
one of these or under one, or whose host and path start with a prefix, even when the member shows images. Nothing else
of the list is used, and nothing here fetches anything."""
import hashlib, json, re, sys, zipfile

HOST = re.compile(r'^[a-z0-9_]([a-z0-9_-]{0,62}\.)*[a-z0-9_-]{1,63}$')
FILTER = re.compile(r'^\|\|([a-z0-9._-]+)\^?$')
PATH_FILTER = re.compile(r'^\|\|([a-z0-9._-]+)(/[!-~]{0,500})$')
IMAGE_TYPES = {'image', 'ping', 'other', 'media'}


def hosts_of(rule):
    if rule.get('action', {}).get('type') != 'block':
        return []
    c = rule.get('condition', {})
    if c.get('initiatorDomains') or c.get('excludedInitiatorDomains') or c.get('requestMethods') or c.get('tabIds'):
        return []
    types = c.get('resourceTypes')
    if types is not None and not IMAGE_TYPES.intersection(types):
        return []
    if c.get('excludedRequestDomains'):
        return []
    out = []
    if c.get('requestDomains') and not c.get('urlFilter') and not c.get('regexFilter'):
        out = c['requestDomains']
    elif c.get('urlFilter') and not c.get('requestDomains') and not c.get('regexFilter'):
        f = c['urlFilter']
        m = FILTER.match(f.lower())
        p = PATH_FILTER.match(f) if not m else None
        if m:
            out = [m.group(1)]
        elif p and '*' not in p.group(2) and '^' not in p.group(2) and '|' not in p.group(2):
            host = p.group(1).lower().rstrip('.')
            return [host + p.group(2)] if HOST.match(host) and '.' in host else []
    return [h.lower().rstrip('.') for h in out if HOST.match(h.lower().rstrip('.')) and '.' in h]


def main(zip_path, out_path):
    data = open(zip_path, 'rb').read()
    digest = hashlib.sha256(data).hexdigest()
    z = zipfile.ZipFile(zip_path)
    manifest = json.loads(z.read('manifest.json'))
    hosts, rules, used = set(), 0, 0
    for r in manifest['declarative_net_request']['rule_resources']:
        if r['id'] != 'easyprivacy':
            continue
        for rule in json.loads(z.read(r['path'].lstrip('/'))):
            rules += 1
            found = hosts_of(rule)
            if found:
                used += 1
                hosts.update(found)
    if not hosts:
        sys.exit('courier-trackers: no easyprivacy hosts in this release')
    with open(out_path, 'w', encoding='ascii') as f:
        prefixes = sum(1 for h in hosts if '/' in h)
        f.write(f'# ADR 0076: uBlock Origin Lite {manifest.get("version")}, sha256 {digest}; easyprivacy: '
                f'{rules} rules, {used} used: {len(hosts) - prefixes} hosts and {prefixes} host and path prefixes. '
                f'EasyPrivacy is GPLv3 or CC BY-SA 3.0.\n')
        for h in sorted(hosts):
            f.write(h + '\n')
    print(f'courier-trackers: {len(hosts)} entries from {used} of {rules} easyprivacy rules')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
