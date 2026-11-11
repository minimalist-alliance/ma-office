// The Notebook module's public surface. The Desk app imports from here and adds `notebook.css`
// and `virtual:ma-notebook-themes.css` (from `vite-plugins/notebookThemes.ts`) once.
export { Notebook, type NotebookProps } from './ui/Notebook.tsx';
export type { NotebookBackend, PageSession } from './model/backend.ts';
export type * from './model/types.ts';
export { TAB_COLORS } from './model/types.ts';
export { LocalBackend, type LocalBackendOptions, type ImportPage } from './local/localBackend.ts';
export { DOC_FIELD, BLANK_PAGE, schemaExtensions, notebookSchema, type PMNode } from './model/schema.ts';
export { derive } from './model/derive.ts';
export { toMarkdown, toHtmlBody, toHtmlDocument } from './model/export.ts';
export { NOTEBOOK_THEMES, notebookThemeCss, type ThemeId } from './theme/tokens.ts';
// Colors (ADR 0091): the six colors' names, the editor's color commands, labels in the page list, and the notebook file.
export { DEFAULT_HIGHLIGHT, PALETTE_IDS, isPaletteId, nearestPaletteId, paletteId, type PaletteColors, type PaletteId } from './model/colors.ts';
export { blockAt, blocksInSelection, clearFormatting, colorsAt, setBlockColor, setHighlight, setTextColor, type BlockTarget, type ColorsAt, type ColorState } from './model/commands.ts';
export { filterByLabels, labelOf, sortByLabel } from './model/tree.ts';
export { NotebookFileError, parseNotebookFile, toNotebookFile, type ImportedPage } from './model/notebookFile.ts';
export type { SchemaOptions } from './model/schema.ts';
export { collabToken, holdsNewerThan, NOTEBOOK_SCHEMA, RELOAD_REASON, schemaOfToken, tokenSaysSchema } from './model/compat.ts';
