// The Notebook's model, bundled from web/notebook as source (the contract: bundled, not copied).
export { derive, type Derived } from '../../../web/notebook/src/model/derive.ts';
export { INTERVAL_MS, KEEP_ALL_MS, SESSION_IDLE_MS, TRASH_KEEP_MS, versionAt, versionsToPrune } from '../../../web/notebook/src/model/history.ts';
export { BLANK_PAGE, DOC_FIELD, notebookSchema, type PMNode } from '../../../web/notebook/src/model/schema.ts';
export { findMatches, fold, merge, parseQuery } from '../../../web/notebook/src/model/search.ts';
export { fileName, toMarkdown } from '../../../web/notebook/src/model/export.ts';
export { keyAt, labelOf } from '../../../web/notebook/src/model/tree.ts';
export { isPaletteId, type PaletteId } from '../../../web/notebook/src/model/colors.ts';
export { cleanDoc } from '../../../web/notebook/src/model/notebookFile.ts';
export { copyState, docState, writeDoc, type NewState } from '../../../web/notebook/src/model/ydoc.ts';
export { holdsNewerThan, NOTEBOOK_SCHEMA, RELOAD_REASON, schemaOfToken, tokenSaysSchema, updateChanges } from '../../../web/notebook/src/model/compat.ts';
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
