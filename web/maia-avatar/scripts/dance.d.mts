export const DRAFT_SHA256: { engine: string; vocab: string };
export function danceSource(dir?: string): string;
export function applyDiff(text: string, diff: string): string;
export function draftEngine(): string;
export function buildDance(name?: string, dir?: string): { dance: string; routine: string; cues: string[] };
export function buildDanceReference(dir?: string): { dataJs: string; vocabJs: string; data: string; vocab: string; vocabulary: string; engine: string; draftVocab: boolean };
