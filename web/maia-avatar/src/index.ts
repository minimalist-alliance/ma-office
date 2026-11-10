// @minimalist-alliance/maia-avatar: Maia, version 7, on Canvas 2D. No framework and no dependencies.
// The motion spec is ma-desk docs/assets/maia/README.md; this package's README says how to use it.
export { THEMES, createAvatar } from './avatar.js';
export type { AvatarOptions, AvatarState, EngineState, MaiaAvatar, Theme } from './avatar.js';
export { defineMaiaAvatar } from './element.js';
export type { MaiaAvatarElement } from './element.js';
export { parseScore } from './parse.js';
export { SLEEP_AFTER_MS } from './idle.js';
export type { Beat, Score, Vocabulary } from './score.js';
// makeParser and scoreJsonSchema, for servers, are in '@minimalist-alliance/maia-avatar/score', with no DOM code.
