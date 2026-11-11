import type { DatabaseSync } from 'node:sqlite';

export interface SeedOptions {
  tabId: string;
  pages: number;
  days: number;
  trashEvery?: number;
  trashedBy?: string;
  actors?: string[];
  members?: Record<string, string>;
  start?: number;
}

export interface Seeded {
  live: number;
  trashed: number;
  rows: number;
  liveRows: number;
}

export function seedPageId(i: number): string;
export function seedDay(n: number): string;
export function seedActivity(db: DatabaseSync, options: SeedOptions): Seeded;
