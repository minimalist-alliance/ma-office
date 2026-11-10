#!/usr/bin/env python3
# Inlines src/ and the art beside it into one page, and writes vocabulary.json. Needs Node to read vocab.js.
# Run with python3 -I engine/build.py, from anywhere. Writes ../vocabulary.json and dist/maia-preview.html. dist/ is build output: do not commit it.
import json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, '..')
def read(*p):
    with open(os.path.join(HERE, *p), encoding='utf-8') as f:
        return f.read()
parts = {}
for t in ['sm', 'md', 'lg']:
    with open(os.path.join(ART, f'parts-{t}.json')) as f:
        p = json.load(f)
    p['params'].pop('notes', None)
    parts[t] = {'tier': p['tier'], 'circle': {'center': p['circle']['center']}, 'rig': p['rig'], 'params': p['params']}
with open(os.path.join(ART, 'tokens.json')) as f:
    tokens = json.load(f)
data = {
    'parts': parts,
    'gradient': {k: tokens['gradient'][k] for k in ['x1', 'y1', 'x2', 'y2']},
    'themes': {name: {'tiers': {tier: {k: v[k] for k in ['light', 'dark', 'eye']} for tier, v in th['tiers'].items()}} for name, th in tokens['themes'].items()},
}
# lg shares md's hair outright when they are the same, and every tier shares the body's fixed run.
for t in ('sm', 'lg'):
    assert parts[t]['rig']['hair']['fixed'] == parts['md']['rig']['hair']['fixed']
    parts[t]['rig']['hair'].pop('fixed')
same = parts['lg']['rig']['hair'].get('contour') == parts['md']['rig']['hair'].get('contour') and parts['lg']['rig']['hair']['outer'] == parts['md']['rig']['hair']['outer'] and parts['lg']['rig']['hair']['inner'] == parts['md']['rig']['hair']['inner']
if same:
    parts['lg']['rig'].pop('hair')
data_js = 'globalThis.MAIA_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\nfor (const t of ["sm", "lg"]) { const b = MAIA_DATA.parts.md.rig.hair; MAIA_DATA.parts[t].rig.hair = MAIA_DATA.parts[t].rig.hair || b; MAIA_DATA.parts[t].rig.hair.fixed = b.fixed; }'
NODE = "require('vm').runInThisContext(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(MAIA_VOCAB))"
vocab = json.loads(subprocess.check_output(['node', '-e', NODE, os.path.join(HERE, 'src', 'vocab.js')]))
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in ('curve', 'note', 'moodBlend', 'loop')}
    return o
small = strip(vocab)
small['eyes']['md'].pop('lashTwo', None)  # the page never uses it
vocab_js = 'globalThis.MAIA_VOCAB = {\n' + ',\n'.join(f'{json.dumps(k)}: ' + json.dumps(v, separators=(',', ':')) for k, v in small.items()) + '\n};'
def halve(text, js=True):
    # One space per level, with the wrapping function's level dropped. The page stays readable and saves about 6 KB.
    if js:
        return re.sub(r'^( +)', lambda m: ' ' * (max(0, len(m.group(1)) - 2) // 2), text, flags=re.M)
    return text
# vocabulary.json: flat lists with a plain description per name, for the model; rules and timing beside them.
def flat(table, with_track=False):
    out = []
    for name, entry in table.items():
        e = {'name': name}
        if with_track:
            e['track'] = entry['track']
        e['description'] = entry['say']
        e.update({k: v for k, v in entry.items() if k not in ('say', 'track')})
        out.append(e)
    return out
full = {
    'v': vocab['v'], 'stage': vocab['stage'], 'moods': flat(vocab['moods']), 'rhythms': flat(vocab['rhythms']), 'beats': flat(vocab['beats'], True),
    'states': vocab['states'], 'eyes': vocab['eyes'], 'modes': vocab['modes'], 'rules': vocab['rules'], 'timing': vocab['timing'], 'limits': vocab['limits'],
    'stills': 'Every still is eyes open: reduced motion, pause, the error fallback and the over-budget fallback all draw her rest pose, looking at the person.',
}
with open(os.path.join(ART, 'vocabulary.json'), 'w') as f:
    json.dump(full, f, indent=1)
page = read('src', 'page.html')
for key, text in [('CSS', halve(read('src', 'page.css'), js=False)), ('DATA', data_js), ('VOCAB', vocab_js), ('ENGINE', halve(read('src', 'engine.js'))), ('PAGE', halve(read('src', 'page.js')))]:
    page = page.replace(f'/*{key}*/', text, 1)
bad = sorted({c for c in page if ord(c) > 126})
if bad:
    sys.exit(f'Non-ASCII characters in the page: {bad}')
if 'innerHTML' in page or 'eval(' in page:
    sys.exit('innerHTML or eval found')
os.makedirs(os.path.join(HERE, 'dist'), exist_ok=True)
with open(os.path.join(HERE, 'dist', 'maia-preview.html'), 'w', encoding='ascii') as f:
    f.write(page)
print('maia-preview.html', len(page), 'bytes; data', len(data_js))
