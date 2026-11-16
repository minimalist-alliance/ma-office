// Small helpers for the command lines: flags, durations, files written whole.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `--name value` and `--flag` into an object. A flag given twice keeps every value in an array. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (booleans.includes(name)) {
      value = true;
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        value = true;
      } else {
        i++;
      }
    }
    if (out[name] === undefined) out[name] = value;
    else out[name] = [].concat(out[name], value);
  }
  return out;
}

/** "500ms", "30s", "10m", "2h", "7d", or a plain number of milliseconds. */
export function parseDuration(text) {
  if (typeof text === 'number') return text;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a duration: ${text}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 'ms'];
  return Math.round(n * unit);
}

/** Writes a file through a temporary file and a rename, so a reader never sees half of it. */
export function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small seeded random source (mulberry32), so a soak's order can be repeated. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
