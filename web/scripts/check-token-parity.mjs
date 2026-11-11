// Desk and landing token parity (TD-81). Compares the office's theme tokens (src/theme/tokens.ts) with the landing's
// (ma-platform web/landing/src/styles/tokens.css), per theme, for the roles the two share, and prints every pair whose
// values differ. The brand kit's docs/assets/brand/ui/tokens.json is the shared source (ADR 0065); its `final` is shown
// beside a difference so the Designer can see which side has drifted.
//
//   node scripts/check-token-parity.mjs [--landing <tokens.css>]
//
// The landing file defaults to origin/main of ma-platform ($MA_PLATFORM, else ~/minimalist-alliance), read with
// `git show`, so a stale checkout can't pass for the real thing. Needs Node 24 (it imports tokens.ts as is). No dependencies.
// Exit 1 on any difference that isn't listed in DELIBERATE with a reason; 2 if an input can't be read.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const THEMES = [['light', 'light', 'Light'], ['dusk', 'dusk', 'Zen'], ['dark', 'dark', 'Dark']]; // [desk id, landing data-theme, name]

// [desk token path, landing custom property, why they're the same role]. Shared roles only; app-only tokens (canvas,
// desks, avatars, seals, etch, elevation, backdrop, notebook, status.error/offline, badge) are out.
export const ROLES = [
  // Backgrounds
  ['surface.worldHi', '--ma-world-1', 'the ground, light stop (the landing comments it "surface.world")'],
  ['surface.worldBase', '--ma-world-2', 'the ground, middle stop'],
  ['surface.worldLo', '--ma-world-3', 'the ground, dark stop'],
  // Surfaces
  ['surface.panel', '--ma-panel', 'a panel / card ground'],
  ['surface.tile', '--ma-tile', 'a tile'],
  ['surface.window', '--ma-window', 'a window'],
  ['surface.sunken', '--ma-sunken', 'a sunken well'],
  // Text
  ['text.primary', '--ma-text', 'text'],
  ['text.secondary', '--ma-text-2', 'muted text'],
  ['text.tertiary', '--ma-text-3', 'mutest readable text'],
  ['text.link', '--ma-link', 'links'],
  ['text.onAccent', '--ma-on-accent', 'text on the accent'],
  // Accent
  ['accent.default', '--ma-accent', 'the accent'],
  ['accent.hover', '--ma-accent-hover', 'accent, hover'],
  ['accent.pressed', '--ma-accent-pressed', 'accent, pressed'],
  ['accent.subtle', '--ma-accent-subtle', 'accent wash'],
  ['focus.ring', '--ma-focus', 'the focus ring'],
  // Borders
  ['border.hairline', '--ma-hairline', 'hairline'],
  ['border.default', '--ma-border', 'border'],
  ['border.strong', '--ma-border-strong', 'strong border'],
  // The mark
  ['mark.disc', '--ma-mark-disc', 'the mark, disc'],
  ['mark.fg', '--ma-mark-fg', 'the mark, glyph'],
  // Glyph, status, switcher, active ring
  ['glyph.default', '--ma-glyph', 'icons'],
  ['status.online', '--ma-online', 'online'],
  ['status.warn', '--ma-warn', 'warning'],
  ['switcher.track', '--ma-switch-track', 'theme switcher, track'],
  ['switcher.selected', '--ma-switch-selected', 'theme switcher, selected'],
  ['switcher.text', '--ma-switch-text', 'theme switcher, text'],
  ['ring.activeDesk', '--ma-ring', 'the active ring'],
  ['ring.activeGlow', '--ma-glow', 'the active ring, glow'],
];

// A difference that is on purpose, as `<theme id>:<desk token path>` -> reason. A pair listed here is reported as
// "deliberate" and doesn't fail the check. Add one only with the Designer's word, and say who gave it and when.
export const DELIBERATE = {
  // (none yet: the first run lists the real differences for the Product Designer to decide)
};

const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, '').replace(/#([0-9a-f])([0-9a-f])([0-9a-f])(?![0-9a-f])/g, '#$1$1$2$2$3$3');
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function landingBlocks(css) {
  const blocks = {};
  for (const m of css.matchAll(/(:root(?:\[data-theme=['"](\w+)['"]\])?(?:\s*,\s*:root\[data-theme=['"](\w+)['"]\])?)\s*\{([^}]*)\}/g)) {
    const body = Object.fromEntries([...m[4].matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:\/\*.*?\*\/)?\s*;/g)].map((x) => [x[1], x[2]]));
    const theme = m[3] ?? m[2];
    if (theme) blocks[theme] = { ...(blocks[theme] ?? {}), ...body };
  }
  return blocks;
}

function readLanding() {
  const i = process.argv.indexOf('--landing');
  if (i > 0) return readFileSync(process.argv[i + 1], 'utf8');
  const repo = process.env.MA_PLATFORM || join(homedir(), 'minimalist-alliance');
  if (!existsSync(repo)) throw new Error(`no ma-platform checkout at ${repo}; pass --landing <tokens.css> or set MA_PLATFORM`);
  return execFileSync('git', ['-C', repo, 'show', 'origin/main:web/landing/src/styles/tokens.css'], { encoding: 'utf8' });
}

let desk, landing, kit;
try {
  desk = (await import(pathToFileURL(join(WEB, 'src/theme/tokens.ts')).href)).THEMES;
  landing = landingBlocks(readLanding());
  kit = JSON.parse(readFileSync(join(WEB, '..', 'docs/assets/brand/ui/tokens.json'), 'utf8')).themes;
} catch (e) {
  console.error(`check-token-parity: ${e.message}`);
  process.exit(2);
}

let bad = 0;
let deliberate = 0;
let same = 0;
for (const [deskId, landingId, name] of THEMES) {
  const lines = [];
  for (const [path, prop, why] of ROLES) {
    const a = get(desk[deskId], path);
    const b = landing[landingId]?.[prop];
    if (b === undefined) { lines.push(`  MISSING  ${path}  landing has no ${prop} in ${landingId} (${why})`); bad += 1; continue; }
    if (typeof a !== 'string') { lines.push(`  MISSING  ${path}  desk has no such token in ${deskId}`); bad += 1; continue; }
    if (norm(a) === norm(b)) { same += 1; continue; }
    const key = `${deskId}:${path}`;
    const reason = DELIBERATE[key];
    const k = kit[deskId]?.[path]?.final;
    lines.push(`  ${reason ? 'deliberate' : 'DIFFERS   '} ${path}  desk ${a}  landing ${b} (${prop})${k ? `  kit ${k}` : ''}${reason ? `  -- ${reason}` : ''}`);
    if (reason) deliberate += 1; else bad += 1;
  }
  console.log(`${name} (desk ${deskId} / landing ${landingId}): ${lines.length ? `${lines.length} to look at` : 'all shared roles match'}`);
  for (const l of lines) console.log(l);
}
console.log(`\n${ROLES.length * THEMES.length} role/theme pairs: ${same} match, ${deliberate} deliberate, ${bad} differ or missing`);
process.exit(bad ? 1 : 0);
