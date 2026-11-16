// Documents' shapes as the window reads them (deskd API.md §25, `DocsMethods.java` where §25 is vague). Every string is desk
// text: data, shown as plain text only, never as HTML or a link.

export type Place = 'needs' | 'read' | 'records' | 'working';
export type DocKind = 'file' | 'download' | 'attachment' | 'page' | 'agent_output' | 'writeup';
export type DocType = 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'other';
export type DocState = 'new' | 'seen' | 'handled';
export type Chip = 'not_now' | 'not_important' | 'sooner' | 'done';
export type ListView = 'week' | 'people';

export interface DocSummary {
  /** The reader's one line (at most 90 characters), or empty. */
  line: string;
  what: string;
  asks: string[];
  due: string | null;
  /** Pages for each ask, as the reader named them. */
  pages: Record<string, number>;
  changeLine: string | null;
}

export interface Doc {
  id: string;
  kind: DocKind;
  type: DocType;
  title: string;
  origName: string;
  size: number;
  place: Place;
  maybe: boolean;
  reason: { code: string; text: string };
  dueAt: number | null;
  from: { name: string; personKey: string | null } | null;
  arrivedAt: number;
  changedAt: number;
  changedBy: { kind: string; name: string | null };
  state: DocState;
  heldUntil: number | null;
  copies: number;
  versions: number;
  changedPages: number[];
  lastPage: number;
  pageCount: number | null;
  viewable: boolean;
  danger: string | null;
  untrusted: boolean;
  sensitive: boolean;
  /** Code's fixed words for a sensitive document ("A letter from Rosa Ortiz. Open to read."), shown in place of the summary. */
  sensitiveText: string | null;
  summary: DocSummary | null;
  source: { kind: string; label: string };
  /** A search hit that matched inside the text (`docs.search`), never a snippet. */
  matchedText?: boolean;
}

export interface Counts {
  needs: number;
  maybe: number;
  read: number;
  records: number;
  working: number;
}

export interface DocList {
  items: Doc[];
  counts: Counts;
  cursor: string | null;
  more: boolean;
  /** "That's all for now." when nothing more needs the member, else null. */
  end: string | null;
}

export interface DocCopy {
  id: string;
  sourceKind: string;
  label: string;
  arrivedAt: number;
  gone: boolean;
  /** A Files path, for a copy in Files (the only kind Download and Restore take). */
  path: string | null;
}

export interface DocVersion {
  id: string;
  at: number;
  by: string;
  byName: string | null;
  milestone: string | null;
  milestoneText: string | null;
  pagesChanged: number[];
  current: boolean;
  restorable: boolean;
}

export interface DocLink {
  kind: string;
  ref: string;
  label: string;
}

export interface Choice {
  id: string;
  label: string;
}

export interface Question {
  id: string;
  kind: string;
  text: string;
  choices: Choice[];
  docIds: string[];
}

export interface DocDetail {
  doc: Doc;
  copies: DocCopy[];
  copiesText: string | null;
  versions: DocVersion[];
  links: DocLink[];
  alsoIn: DocLink[];
  questions: Question[];
}

export interface TextSection {
  kind: 'p' | 'h' | 'table' | 'slide' | 'sheet';
  text: string;
  rows: string[][] | null;
}

export interface DocText {
  type: DocType;
  pages: { n: number; text: string }[];
  sections: TextSection[];
  /** Why there's no text (`no_text`, or the sandbox's refusal), when there's none. */
  unread: string | null;
}

export interface LineBox {
  /** [x, y, w, h], each 0 to 1 of the page. */
  b: [number, number, number, number];
  changed: boolean;
}

export interface PageHead {
  transferId: number;
  size: number;
  sha256: string;
  format: 'jpeg' | 'png';
  width: number;
  height: number;
  pageCount: number;
  lines: LineBox[];
}

export interface Changes {
  pages: number[];
  line: string;
  changeLine: string | null;
  paragraphs: number[];
}

export interface Rule {
  id: string;
  text: string;
  effect: string;
  madeBy: string;
}

export interface Toast {
  text: string;
  undo: string | null;
}

export interface TidyPreview {
  copies: number;
  downloads: number;
  bytes: number;
  items: number;
  /** "Tidy up? 6 extra copies and …", or null when there's nothing to tidy. */
  text: string | null;
}

/** A `docs` topic message: ids and counts only, never a title (§25). `ids` null: too many, read everything again. */
export interface DocsEvent {
  type: string;
  rev: number;
  ids: string[] | null;
  counts: Counts | null;
}
