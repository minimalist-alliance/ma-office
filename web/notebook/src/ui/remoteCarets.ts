// Other members' carets and selections on a shared (Guild Desk) page, each with a small name label, as in a shared document.
//
// It draws from the page's Hocuspocus awareness and nothing else. The desk's sync service has already replaced every other
// member's `user.name` and `user.memberId` with the verified caller's (services/notebook `sanitizeAwareness`), so the label
// is the server's word and a client can't set another's. The colour is not read from the awareness at all: it's one of the
// six binder-tab tokens picked from the member id, so a member looks the same to everyone and a client can't choose it.
// A page with no awareness (a member's own desk, the demo's local backend) gets no plugin, so nothing changes there.
import { Extension } from '@tiptap/core';
import { defaultAwarenessStateFilter, yCursorPlugin } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';

/** At most this many characters of a name, which is the server's word but still shown as text only. */
export const CARET_NAME_MAX = 40;
export const CARET_COLORS = 6;

/** Which of the six tab colours a member gets: a hash of the verified member id (the name if a desk sends none). Stable. */
export function caretColorIndex(user: { memberId?: unknown; name?: unknown }): number {
  const key = typeof user.memberId === 'string' && user.memberId ? user.memberId : typeof user.name === 'string' ? user.name : '';
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % CARET_COLORS;
}

export function caretName(user: { name?: unknown }): string {
  const n = typeof user.name === 'string' ? user.name.trim() : '';
  return Array.from(n || 'Member').slice(0, CARET_NAME_MAX).join('');
}

/** The caret: a bar with its label above. The label fades by CSS a few seconds after the caret was drawn, and a hover brings it back. */
export function buildCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'nb-caret';
  caret.dataset['c'] = String(caretColorIndex(user));
  caret.dataset['testid'] = 'remote-caret';
  const label = document.createElement('span');
  label.className = 'nb-caret-label';
  label.textContent = caretName(user);
  caret.append('⁠', label, '⁠');
  return caret;
}

export function buildSelection(user: Record<string, unknown>): { class: string; 'data-c': string } {
  return { class: 'nb-remote-sel', 'data-c': String(caretColorIndex(user)) };
}

/** The editor extension. `awareness` is the page session's; without one nothing is added. */
export function remoteCarets(awareness: Awareness | undefined) {
  return Extension.create({
    name: 'remoteCarets',
    addProseMirrorPlugins() {
      if (!awareness) return [];
      return [
        yCursorPlugin(awareness, {
          awarenessStateFilter: defaultAwarenessStateFilter, // never the local client's own
          cursorBuilder: (user) => buildCaret(user),
          selectionBuilder: (user) => buildSelection(user),
        }),
      ];
    },
  });
}
