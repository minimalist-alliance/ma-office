// validateRecipe(recipe) -> { ok: true, recipe } | { ok: false, errors: [...] }. For the server.
import { manifest } from './manifest.generated.mjs';

const KEYS = manifest.recipeKeys;
const IDS = ['face', 'eyes', 'brows', 'nose', 'hair', 'facial', 'top', 'headwear', 'glasses'];
const COLORS = { skin: 'skin', hairColor: 'hair', topColor: 'clothing', headwearColor: 'clothing', glassesColor: 'clothing', extraColor: 'metal', bg: 'bg' };
const bytes = (s) => new TextEncoder().encode(s).length;

export function validateRecipe(recipe) {
  const errors = [];
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) return { ok: false, errors: ['recipe must be an object'] };
  for (const k of Object.keys(recipe)) if (!KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  if (recipe.kind !== 'built') errors.push('kind must be "built"');
  if (recipe.kit !== 1) errors.push('kit must be 1');
  for (const k of IDS) {
    if (!(k in recipe)) continue;
    if (typeof recipe[k] !== 'string' || !manifest.categories[k].parts.some((p) => p.id === recipe[k])) errors.push(`${k}: unknown id`);
  }
  for (const [k, pal] of Object.entries(COLORS)) {
    if (!(k in recipe)) continue;
    const n = manifest.palettes[pal].length;
    if (!Number.isInteger(recipe[k]) || recipe[k] < 0 || recipe[k] >= n) errors.push(`${k}: must be an integer from 0 to ${n - 1}`);
  }
  if ('extras' in recipe) {
    const ex = recipe.extras;
    if (!Array.isArray(ex)) errors.push('extras: must be a list');
    else {
      if (ex.length > manifest.maxExtras) errors.push(`extras: at most ${manifest.maxExtras}`);
      if (new Set(ex).size !== ex.length) errors.push('extras: ids must be unique');
      for (const id of ex) if (typeof id !== 'string' || !manifest.categories.extras.parts.some((p) => p.id === id)) errors.push(`extras: unknown id ${String(id)}`);
    }
  }
  let json = '';
  try { json = JSON.stringify(recipe); } catch { errors.push('recipe is not JSON'); }
  if (json && bytes(json) > manifest.maxBytes) errors.push(`recipe is over ${manifest.maxBytes} bytes`);
  if (errors.length) return { ok: false, errors };
  const clean = {};
  for (const k of KEYS) if (k in recipe) clean[k] = k === 'extras' ? [...recipe[k]] : recipe[k];
  return { ok: true, recipe: clean };
}
