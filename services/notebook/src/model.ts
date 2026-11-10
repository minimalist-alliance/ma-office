// The Notebook's model, bundled from web/notebook as source (the contract: bundled, not copied).
export { derive, type Derived } from '../../../web/notebook/src/model/derive.ts';
export { INTERVAL_MS, KEEP_ALL_MS, SESSION_IDLE_MS, TRASH_KEEP_MS, versionAt, versionsToPrune } from '../../../web/notebook/src/model/history.ts';
export { BLANK_PAGE, DOC_FIELD, notebookSchema, type PMNode } from '../../../web/notebook/src/model/schema.ts';
export { findMatches, fold, merge, parseQuery } from '../../../web/notebook/src/model/search.ts';
export { fileName, toMarkdown } from '../../../web/notebook/src/model/export.ts';
export { keyAt } from '../../../web/notebook/src/model/tree.ts';
export {
  TAB_COLORS,
  type ActivityRow,
  type MatchRange,
  type NotebookRec,
  type PageRec,
  type SearchHit,
  type SearchOptions,
  type TabColor,
  type TabRec,
  type VersionMeta,
  type VersionReason,
} from '../../../web/notebook/src/model/types.ts';
