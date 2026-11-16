# Draft ADR: Documents, one index per desk that Maia sorts, finds and hands over

**Status:** Proposed (draft), Nov 15 2026, built on `sub/mm-documents`. The owner approved it on Nov 15 ("a viewer inside the office, and Maia can sort, find and hand over documents (contents read only when the member taps)"). Owners: the Desk Engineer (deskd `docs`, the sandbox's documents mode, desk-agent's reader and Maia's tools) and the UI/UX Engineer (the Documents window and the viewer).

**Reads with:** deskd `API.md` §24 (the wire), §21 (Courier), §22 (To-do), §23 (Desk Maia); the draft ADRs [Desk Maia](draft-desk-maia.md) (decisions 6, 8, 12) and [the Agent's tools and approvals](draft-agent-tools-approvals.md) (§6 taint, §13 To-do's provenance); ADR 0048 (Files), ADR 0092 (Browser downloads), ADR 0097 (the parse sandbox).

## Context

Documents live in seven places on a desk (Files, Browser downloads, Notebook, Courier, agents' workspaces and threads, Desk Maia's write-ups) and nothing ties them together. Nothing says a document matters, a member can't read a PDF inside the office (Open means download, which the phone app can't do), and Desk Maia can't see the home desk's documents at all. The owner's north star (Nov 15): bring only the important documents to the member's attention, and handle, manage and organise them best in class.

## Decisions

### 1. One index per desk, on the desk
deskd's `docs` module keeps `/data/desk/docs.db` beside `todo.db`. Every row comes from a source the desk already holds, except the member's rules, links, milestones and the reader's summaries, which the export carries (`docs.export`). The office's "All desks" view merges the desks in the browser, as To-do's does. **The Platform holds no document, name or content, and sends no document push of its own.**

### 2. Places are labels, never folders
Needs you (with Maybe inside it), Read later, Records and Working on. Documents stay where they arrived; the member's folders are never touched, and a file is renamed only on the member's tap.

### 3. Code decides the place; a model only extracts facts
The place is the first match of a fixed table (API §25): danger, the member's rules, welcome rules, strong structure (a to-do, a let-through person, a new version by someone else), weak structure (Maybe), low signals, the reader's facts, a default. **Text in a document never lifts it above Maybe from an unknown sender, and never makes anything urgent.** When unsure, Maybe; never hidden. Learning is from taps only.

### 4. The reader reads only what's about to be shown, or what the member taps
Option A of the concept: no reading on arrival. Desk-agent's `DocReader` makes one tool-less call on Desk Maia's service (task `read`, Haiku-class, her credits) for a Needs you or Maybe document about to be shown, or on "What's this?" and "What changed". One read per version, ever; at most 15 a day per desk outside taps; never on a teen's desk, a danger type or a desk where Maia is off. Every field is checked by code; there's no score.

### 5. The viewer draws pages in the sandbox and sends images and plain text only
PDF pages are drawn by PDFBox inside ADR 0097's sandbox (the Courier mode's socket for deskd, a `docs1` request family) and sent as JPEG over `bulk`; images are drawn again from their pixels (`courier1 image -`); docx, xlsx and pptx are a clean reading view of their text; text is text. **The original bytes and anything that runs never reach the browser.** Danger types are never drawn. The render cache is on the desk (7 days, 1 GiB).

### 6. Versions and copies, quietly
Exact copies stack (same SHA-256 on one desk), never across desks, never deleted on their own. A new version keeps the old bytes in `/data/desk/versions/` (10% of the drive at most); milestones name themselves only from what code can check. "What changed" diffs each version's per-page lines in code, so Maia can say "Page 3 is the change" without reading the document.

### 7. Maia's document tools see titles and structure; passages only after a tap
`docs_find`, `docs_handover`, `docs_ask` (only within 10 minutes of the member's "Ask Maia about this"; since Nov 15 the office has no such tap, see the amendment below) and `docs_offer_rule`, hosted by deskd for agent `maia` only, on the home desk. This amends Desk Maia's decision 8 ("no Files, Browser, Notebook, Courier"): she gets the index's tools, not those apps'. She can't change a place, make a rule, hide, delete, rename or stack. `office_show` gains `app: "documents"` to open the viewer in her room.

### 8. The shield decides when
The index decides what and why (place, reason, closeness facts); the focus shield decides when and where (breaks, catch-ups, caps, the Work and Personal partition). Documents add Attention kinds `doc` and `docs` (Next), `doc_return` and `doc_question` (Later) and no budget of their own: at most one document offer per break.

### 9. One person key for all the member's desks, handed desk to desk by the office (`sub/mm-documents-2`)
Each desk makes its own person-key secret at first use; the office makes one secret (32 random bytes, in the browser) and gives it to every one of the member's own desks over each desk's own channel (`docs.key.set {key, at}`). A desk opened later, or another browser, reads it back from a desk that has it (`docs.key.get`, only once the office set it; a desk-made key is never handed out); two made at once settle on the earliest made. Nothing of it is stored in the browser or reaches the Platform. A changed key re-keys each attachment's sender from Courier's own record (no bytes read), and the member's rules, let-through rows, questions and person links follow it, so a tap made before the desks agreed still holds.

### 10. Notebook pages and write-ups join the index quietly (`sub/mm-documents-2`)
Notebook pages are read by deskd's own owner calls to desk-notebook (reads only), every 5 minutes and when Notebook's tree changes; a page follows its edits in place (Notebook keeps its own history), never stacks with another page, and lands in Records unless a rule or to-do says otherwise. Desk Maia's write-ups come from desk-agent by cursor; they're agents' words (untrusted), "Made for you by {agent}", and one whose answer held the desk's private data is never given to the reader. Both arrive `seen`, never "new": they're findable and listed, never brought forward on their own (fewer words, less noise). Keeping write-ups as files in "From Maia" before their 90 days run out (the concept's §15) isn't built.

## Consequences
- The sandbox gains a request family (`docs1 read`, `docs1 render`), so documents need a desk-agent release that carries it; with an older desk-agent the index still works from structure and the viewer says it can't draw yet.
- Phase 2's write-ups and the reader's task `read` come from `sub/mm-maia-away`; until that's on a desk, write-ups aren't indexed and the reader falls back to structure. An older desk-agent answers `desk.docs.writeups` with `not_found`: no write-ups, nothing breaks.
- Cross-desk `docs_find` rides Phase 2's desk-to-desk code answers; until then her find covers the home desk and the office's Documents view covers the rest.
- Browser downloads join the index once ADR 0092 lands them in `Files/Downloads/`.

## Amendment, Nov 15: asking is the desk agent's
The owner: "the Documents app has an ask maia feature but it should really be ask desk agent, which should default to the primary agent." Documents' "Ask Maia" and "Ask Maia about this" became "Ask {lead}" and "Ask {lead} about this": the desk's lead (ADR 0047) by default, any other agent of that desk from a small arrow beside it. The question waits in that agent's composer (never sent by itself) with the document staged as a file (its text from `docs.text`; a picture's page 1 as drawn), and the agent answers in its own thread on its own key or the member's credits, like any message to it. The first time, one sheet says so. The office no longer calls `docs.ask.allow`, so Desk Maia's `docs_ask` has no tap to open it; her other document tools are unchanged, and her own room keeps what is hers. Record: `docs/sub-status/agent-icons.md`.
