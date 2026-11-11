# 0095. Notebook tabs are section dividers: notebooks, then tabs, then pages, shown as a binder

**Status:** Accepted (the owner accepted design Q5's default; recorded in the handover of 2026-11-05). Written up 2026-11-11 (TD-49).
**Date:** 2026-11-11

## Context
The vision asks for Notebook "tabs" that can be added to specific pages. Design v1.1 asked, as Q5, which reading is meant:
- **Section dividers:** a notebook splits into tabs, and each tab holds pages.
- **Sticky bookmarks** on single pages: a page can carry several.

## Decision
The owner accepted the default, section dividers ([ADR 0015](0015-notebook-editor-tiptap-yjs.md), design §5.2):
1. **A strict hierarchy:** a notebook holds an ordered list of tabs, and each tab holds an ordered list of pages.
2. **"Add tab at this page"** starts a new tab at page P and moves P, and the pages after it up to the next tab, into the new tab.
3. **The UI is a binder** with colored tabs on its edge, and paging runs on across tab boundaries.
4. Pages can be dragged between tabs and pinned. Deleted items go to Trash for 30 days.

## Where it stands (2026-11-11)
Built in the Desk app's Notebook: the model in `web/notebook/src/model/tree.ts` ("Add tab at this page") and the binder in `web/notebook/src/ui/TabView.tsx`. The tabs' colors are [ADR 0091](0091-notebook-colors.md) (Proposed).

## Consequences
- A page belongs to exactly one tab, so moving it is one change, and the Tab view and paging have one order to follow.
- A page can't carry several tabs. Bookmark-like marking would be a separate feature, such as pins or labels (ADR 0091's labels).
- **Rejected:** tabs as sticky bookmarks on single pages. They don't give the binder's sections, and paging through a notebook would have no sections to follow.
