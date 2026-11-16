// A new avatar comes in place (the owner, Nov 16): the one drawn stays until the new image is decoded, the initials come
// at once, and nothing waits while a built avatar is still being drawn.
import { describe, expect, it } from 'vitest';
import { nextDrawn } from './avatarSwap';

const OLD = 'https://api.example.org/v1/public/avatars/im_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E';
const none = (): boolean => false;
const all = (): boolean => true;

describe('nextDrawn', () => {
  it('keeps the old image while the new one decodes, then takes the new one', () => {
    expect(nextDrawn(OLD, NEW, none)).toEqual({ draw: OLD, load: NEW });
    expect(nextDrawn(OLD, NEW, (s) => s === NEW)).toEqual({ draw: NEW, load: null });
  });

  it('draws an image already decoded at once, as the menu does after the button', () => {
    expect(nextDrawn(null, NEW, all)).toEqual({ draw: NEW, load: null });
  });

  it('shows the initials until a first image is decoded', () => {
    expect(nextDrawn(null, NEW, none)).toEqual({ draw: null, load: NEW });
  });

  it('goes to the initials at once: they need nothing loaded', () => {
    expect(nextDrawn(OLD, null, all)).toEqual({ draw: null, load: null });
  });

  it('holds what it draws while a built avatar is still being drawn by the kit', () => {
    expect(nextDrawn(OLD, undefined, none)).toEqual({ draw: OLD, load: null });
    expect(nextDrawn(null, undefined, none)).toEqual({ draw: null, load: null });
  });

  it('asks nothing for the image it already draws', () => {
    expect(nextDrawn(OLD, OLD, none)).toEqual({ draw: OLD, load: null });
  });
});
