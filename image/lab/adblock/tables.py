#!/usr/bin/python3 -I
"""tables.py <visits.jsonl> [site,site,...]: ADR 0076's tables from bench.py's results. Medians over repeats; the saving is
against "off". The sites named are listed but left out of the totals (those that refuse a cloud address in every config)."""
import json, re, statistics, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
SKIP = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else set()
starts = [r for r in rows if r.get('event') == 'start']
# A bot check in place of the page (Cloudflare's "Just a moment...", Norton's interstitial) isn't a visit to the site: dropped
# and counted, in every config alike. Without this, a site that was walled in some passes of one config has a median of nothing.
WALL = re.compile(r'^(Just a moment|Desktop Security|Attention Required|Access Denied|Pardon Our Interruption)', re.I)
visits_all = [r for r in rows if 'site' in r and 'error' not in r]
visits = [r for r in visits_all if not WALL.match(r.get('title') or '')]
walled = [r for r in visits_all if WALL.match(r.get('title') or '')]
errors = [r for r in rows if 'error' in r]
CONFIGS = ['off'] + sorted({r['config'] for r in rows if 'config' in r} - {'off'}, key=lambda c: ['ubol', 'ubol-annoy', 'ubol-basic', 'ma'].index(c) if c in ('ubol', 'ubol-annoy', 'ubol-basic', 'ma') else 9)
sites = []
for r in visits:
    if r['site'] not in sites: sites.append(r['site'])
def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return statistics.median(xs) if xs else None
def get(site, cfg, key):
    return med([r.get(key) for r in visits if r['site'] == site and r['config'] == cfg])
def mdoc(site, cfg, key):
    return med([(r.get('mdoc') or {}).get(key) for r in visits if r['site'] == site and r['config'] == cfg])
def iframes(site, cfg):
    return med([((r.get('mdoc') or {}).get('media') or {}).get('iframe', 0) for r in visits if r['site'] == site and r['config'] == cfg and 'blocks' in (r.get('mdoc') or {})])
def n(site, cfg): return sum(1 for r in visits if r['site'] == site and r['config'] == cfg)
def f(x, d=1): return '-' if x is None else ('%.*f' % (d, x))
def pct(a, b): return '-' if a is None or b in (None, 0) else '%+.0f%%' % (100 * (a - b) / b)
print('## Starts (per config, median of repeats)')
print('| Config | Blocker up after start, s | Browser PSS idle, MB | Idle CPU, % of a core |')
print('|---|---|---|---|')
for c in CONFIGS:
    s = [x for x in starts if x['config'] == c]
    print('| %s | %s | %s | %s |' % (c, f(med([x.get('ext_up_s') for x in s]), 2), f(med([x.get('idle_pss_mb') for x in s])), f(med([x.get('idle_core_pct') for x in s]), 2)))
for key, title, d in (('cpu_total_s', 'CPU-seconds per visit (load, 20 s reading, 12 s scrolling)', 1), ('rx_mb', 'MB received per visit (the interface)', 1),
                      ('pss_mb', 'Browser memory after reading, PSS MB', 0), ('scroll_fps', 'Page fps while scrolling, average', 1),
                      ('scroll_fps_min_s', 'Page fps while scrolling, worst second', 0), ('read_core_pct', 'CPU while reading, % of a core', 0)):
    print('\n## ' + title)
    print('| Site | ' + ' | '.join(CONFIGS) + ' | ' + ' | '.join('%s vs off' % c for c in CONFIGS[1:]) + ' |')
    print('|---|' + '---|' * (2 * len(CONFIGS) - 1))
    tot = {c: [] for c in CONFIGS}
    for s in sites:
        v = {c: get(s, c, key) for c in CONFIGS}
        if all(v[c] is not None for c in CONFIGS) and s not in SKIP:
            for c in CONFIGS: tot[c].append(v[c])
        print('| %s | %s | %s |' % (s, ' | '.join(f(v[c], d) for c in CONFIGS), ' | '.join(pct(v[c], v['off']) for c in CONFIGS[1:])))
    if key in ('cpu_total_s', 'rx_mb', 'pss_mb', 'scroll_fps', 'scroll_fps_min_s', 'read_core_pct'):
        if key in ('scroll_fps', 'scroll_fps_min_s', 'read_core_pct'):
            mn = {c: (sum(tot[c]) / len(tot[c]) if tot[c] else None) for c in CONFIGS}
            print('| **mean, %d sites** | %s | %s |' % (len(tot['off']), ' | '.join(f(mn[c], d) for c in CONFIGS), ' | '.join(pct(mn[c], mn['off']) for c in CONFIGS[1:])))
            continue
        sm = {c: sum(tot[c]) for c in CONFIGS}
        print('| **total, %d sites** |' % len(tot['off']) + ' %s | %s |' % (' | '.join(f(sm[c], d) for c in CONFIGS), ' | '.join(pct(sm[c], sm['off']) for c in CONFIGS[1:])))
print('\n## Blocked requests, page text and the simplified view (prototype extractor)')
print('| Site | blocked (%s) | page text chars (%s) | MDoc blocks | iframes in MDoc | ad labels |' % (' / '.join(CONFIGS[1:]), ' / '.join(CONFIGS)))
print('|---|---|---|---|---|---|')
for s in sites:
    print('| %s | %s | %s | %s | %s | %s |' % (s, ' / '.join(f(get(s, c, 'blocked'), 0) for c in CONFIGS[1:]),
          ' / '.join(f(get(s, c, 'text_chars'), 0) for c in CONFIGS), ' / '.join(f(mdoc(s, c, 'blocks'), 0) for c in CONFIGS),
          ' / '.join(f(iframes(s, c), 0) for c in CONFIGS), ' / '.join(f(mdoc(s, c, 'ad_labels'), 0) for c in CONFIGS)))
print('\nBot checks dropped, not counted as visits: %d %s' % (len(walled), sorted((r['site'], r['config'], r['rep']) for r in walled)))
print('Valid visits per site (%s): %s' % (' / '.join(CONFIGS), '; '.join('%s %s' % (s, '/'.join(str(n(s, c)) for c in CONFIGS)) for s in sites)))
print('\nVisits: %d, errors: %d %s' % (len(visits), len(errors), [(e['site'], e['config'], e['rep'], e['error'][:60]) for e in errors]))
print('Repeats per site and config: %s' % sorted({n(s, c) for s in sites for c in CONFIGS}))
