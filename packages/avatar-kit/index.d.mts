// Types for the vendored kit (added by the vendoring repo; the kit itself is plain JS, version 1.0.0).
export type Recipe = {
  kind: 'built';
  kit: 1;
  skin?: number;
  face?: string;
  eyes?: string;
  brows?: string;
  nose?: string;
  hair?: string;
  hairColor?: number;
  facial?: string;
  top?: string;
  topColor?: number;
  headwear?: string;
  headwearColor?: number;
  glasses?: string;
  glassesColor?: number;
  extras?: string[];
  extraColor?: number;
  bg?: number;
};
export interface PartInfo { id: string; name: string; minSize?: number; hides?: string[] }
export interface Manifest {
  kit: number;
  defaults: Recipe;
  palettes: Record<string, unknown>;
  categories: Record<string, { parts: PartInfo[]; [k: string]: unknown }>;
  [k: string]: unknown;
}
export function render(recipe: unknown, size: number, idPrefix?: string): string;
export function validateRecipe(recipe: unknown): { ok: true; recipe: Recipe } | { ok: false; errors: unknown[] };
export function shuffle(seed?: number | string): Recipe;
export const manifest: Manifest;
export const defaults: Recipe;
