# 0015. Notebook editor: TipTap 3 with Yjs (Hocuspocus) sync and versioned history

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0023](0023-desk-data-channel-protocol.md) (collab transport); 2026-11-07 by [0044](0044-notebook-service-hocuspocus-on-node.md) (where sync runs; noted 2026-11-09)

## Context
- Notebook must feel like Apple Notes (styles, checklists, images, attachments), merge edits from several devices and the agent, and let the agent edit the real document model on the desk.
- The Temporal view needs "created or edited on day X" and "as of that day", and agent edits must be reversible.
- A stopped desk takes 30–60 s to wake; edits typed meanwhile should not be lost.

## Decision
- **Editor:** TipTap 3 (ProseMirror) with MIT-licensed extensions only (StarterKit, Underline, Highlight, Link, nested TaskList/TaskItem, Image, Placeholder, Collaboration); no Tiptap Cloud. The same schema runs headless in deskd.
- **Sync:** page bodies are Y.Docs served by Hocuspocus inside deskd over the `collab` data channel, through a WebSocket-shaped adapter on both ends (ADR 0023); deskd is the authority. Agent edits go through `openDirectConnection`. Structural changes (notebooks, tabs, moves) are RPC with `rowVersion`. Yjs runs with `gc: true`; history does not come from Yjs.
- **History:** `page_activity` per page per local day; restorable versions at session end, every 30 min of continuous editing, at local midnight, and before every agent edit; all kept 30 days, then the last of each day indefinitely. Restore is non-destructive.
- **Tab model** (pending design Q5): notebooks → ordered tabs → ordered pages, with "Add tab at this page".

## Consequences
- No conflict dialogs for text; offline queueing on trusted devices via `y-indexeddb`.
- About 20 MB of history per year for a heavy user.
- Markdown is the agent interchange format and round-trips lossily for exotic formatting, so agent tools use targeted operations.
- Fallback if Yjs/Hocuspocus proves troublesome: prosemirror-collab with the same schema. Hocuspocus over a custom transport is verified in Phase 0; the fallback there is plain y-protocols sync over the same channel.
- Alternatives rejected: Lexical (0.x, thinner collab ecosystem), Quill/Slate, keystroke-level Yjs history (unbounded), per-day snapshots only (too coarse to undo an agent edit).
