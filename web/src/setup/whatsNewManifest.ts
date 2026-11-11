// What's new, from the repo, for as long as Platform's `whats_new#current` (the Management Console's form, sent in
// client-config as `whatsNew.items`) doesn't exist yet. Client-config's list, when it has one, replaces this one entirely.
//
// An item goes here only when a release adds something worth trying, never for fixes or polish, and its words come from
// the Sales Engineer and the Product Designer (at most 20 words). The shape, read field by field by `readItem` in
// `steps.ts`; anything it can't use is left out:
//   { id: 'simple-view-1', title: 'A quieter Browser', line: '…', action: { app: 'browser' } | { href: 'https://platform.…' },
//     tiers?: ['free', 'alliance', 'officer', 'lead'], ages?: ['adult', 'teen'], from: ISO time, until: ISO time }
// Empty until an item's words are approved.
export const WHATS_NEW_MANIFEST: readonly unknown[] = [];
