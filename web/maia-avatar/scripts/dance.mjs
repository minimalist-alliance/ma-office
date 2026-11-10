// Maia's dance, from the Product Designer's draft (preview-dance/src/vocab.js, every change marked DANCE), never retyped.
// It writes two files: src/art/dance.json, the engine's dance settings that every routine shares, and
// src/art/routine.json, the one routine she knows with only the moves it uses. Another dance is another routine.json.
//
//   node scripts/dance.mjs [routine] [--src <folder>]          writes them (routine: party by default)
//   node scripts/dance.mjs [routine] [--src <folder>] --check  fails if they differ from what the draft gives now
//
// The folder defaults to $MAIA_DANCE_SRC, then ~/ma-design-drafts/preview-dance/src. The draft isn't in this repo,
// apart from dance/engine.diff, its engine's diff against version 7, which the tests rebuild its engine from.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { MAIA, PACKAGE, buildReference } from './art.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', 'src', 'art');
/** The draft's own files, as the Product Designer handed them over (preview-dance/src, 2026-11-07). */
export const DRAFT_SHA256 = {
  engine: 'df9e297dd925c7c3dbb58f0ab3fbf884678ce16f375b5bf35e7a7df57d3c04bc',
  vocab: '48b03a627a028b5d2221b7980f81320f5fc07bfbe8471c42857a8b0fe094d009',
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Applies a unified diff to a text, checking every context and removed line. Throws if anything doesn't match. */
export function applyDiff(text, diff) {
  const src = text.split('\n'), out = [];
  const lines = diff.split('\n');
  let at = 0, i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i += 1;
  while (i < lines.length) {
    const head = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!head) { if (lines[i] === '') { i += 1; continue; } throw new Error(`not a hunk header: ${lines[i]}`); }
    const start = Number(head[1]) - 1;
    while (at < start) out.push(src[at++]);
    i += 1;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i], tag = l[0], body = l.slice(1);
      if (tag === ' ' || tag === '-') {
        if (src[at] !== body) throw new Error(`diff doesn't apply at line ${at + 1}: ${body}`);
        if (tag === ' ') out.push(body);
        at += 1;
      } else if (tag === '+') out.push(body);
      else if (l !== '' && !l.startsWith('\\')) throw new Error(`unexpected diff line: ${l}`);
      i += 1;
    }
  }
  while (at < src.length) out.push(src[at++]);
  return out.join('\n');
}

/** The draft's engine, rebuilt from version 7 and dance/engine.diff, and checked against the draft's own hash. */
export function draftEngine() {
  const v7 = readFileSync(join(MAIA, 'engine', 'src', 'engine.js'), 'utf8');
  const engine = applyDiff(v7, readFileSync(join(PACKAGE, 'dance', 'engine.diff'), 'utf8'));
  if (sha256(engine) !== DRAFT_SHA256.engine) throw new Error('version 7 with dance/engine.diff is not the draft engine');
  return engine;
}

/**
 * The dance's reference, built as version 7's reference is (scripts/art.mjs): the draft's engine and, when the draft
 * is on this machine, its own vocab.js, through version 7's build.py. Without the draft, version 7's vocabulary
 * with the package's dance data added, which src/art's check against the draft covers where the draft exists.
 */
export function buildDanceReference(dir = danceSource()) {
  const engine = draftEngine();
  const path = join(dir, 'vocab.js');
  if (existsSync(path)) {
    const vocab = readFileSync(path, 'utf8');
    if (sha256(vocab) !== DRAFT_SHA256.vocab) throw new Error(`${path} is not the draft this package was built from`);
    return { ...buildReference({ 'engine/src/engine.js': engine, 'engine/src/vocab.js': vocab }), draftVocab: true };
  }
  const ref = buildReference({ 'engine/src/engine.js': engine });
  const dance = readFileSync(join(ART, 'dance.json'), 'utf8'), routine = JSON.parse(readFileSync(join(ART, 'routine.json'), 'utf8'));
  const add = `\nMAIA_VOCAB.dance = Object.assign(${dance.trim()}, { moves: ${JSON.stringify(routine.moves)} });\nMAIA_VOCAB.routines = { ${JSON.stringify(routine.name)}: ${JSON.stringify(routine.routine)} };`;
  return { ...ref, vocabJs: ref.vocabJs + add, draftVocab: false };
}

export function danceSource(dir) {
  return dir ?? process.env.MAIA_DANCE_SRC ?? join(homedir(), 'ma-design-drafts', 'preview-dance', 'src');
}

/** The two files' text, from the draft's vocab.js, for one routine. */
export function buildDance(name = 'party', dir = danceSource()) {
  const path = join(dir, 'vocab.js');
  if (!existsSync(path)) throw new Error(`no ${path}: set MAIA_DANCE_SRC to the draft's src folder`);
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(path, 'utf8'), ctx);
  const V = JSON.parse(JSON.stringify(ctx.MAIA_VOCAB));
  const def = V.routines?.[name];
  if (!def) throw new Error(`the draft has no routine ${name}`);
  const { moves, ...settings } = V.dance;
  const eyeBeats = new Set(Object.keys(V.beats).filter((k) => V.beats[k].track === 'eyes'));
  const used = {};
  for (const [, step] of def.steps.map((s) => [s[0], s[1]])) {
    if (eyeBeats.has(step)) continue;
    if (!moves[step]) throw new Error(`routine ${name} names a move the draft lacks: ${step}`);
    used[step] = moves[step];
  }
  // The eye beats a routine cues must be version 7's own, since the package adds no beats to her vocabulary.
  const cues = [...new Set(def.steps.map((s) => s[1]).filter((s) => eyeBeats.has(s)))];
  // `say` is the model's description of it; the engine never reads it, so the browser copy leaves it out.
  const routine = Object.fromEntries(Object.entries(def).filter(([k]) => k !== 'say'));
  return {
    dance: `${JSON.stringify(settings)}\n`,
    routine: `${JSON.stringify({ name, routine, moves: used })}\n`,
    cues,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--src');
  const dir = at >= 0 ? args[at + 1] : undefined;
  const name = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1)) ?? 'party';
  const out = buildDance(name, danceSource(dir));
  const files = { 'dance.json': out.dance, 'routine.json': out.routine };
  let drift = 0;
  for (const [file, text] of Object.entries(files)) {
    const path = join(ART, file);
    if (args.includes('--check')) {
      const now = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (now !== text) { console.error(`src/art/${file} differs from the draft's ${name}`); drift += 1; }
    } else {
      writeFileSync(path, text);
      console.log(`src/art/${file}`, text.length, 'bytes');
    }
  }
  console.log(`eye beats it cues: ${out.cues.join(', ') || 'none'}`);
  if (drift) process.exit(1);
}
