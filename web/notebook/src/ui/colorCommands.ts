// The menus' one door to the color commands and page commands, which `nb-data` owns (`model/commands.ts` and
// `NotebookBackend`, the shared interface's "Final names", ~/work/region/notebook-color-interface.md). The menus call these
// and nothing else that changes a note.
import type { Editor } from '@tiptap/core';
import type { NotebookBackend } from '../model/backend.ts';
import { blockAt, clearFormatting, colorsAt, setBlockColor, setHighlight, setTextColor, type ColorState } from '../model/commands.ts';
import { toPaletteId, type PaletteId } from './palette.ts';

/** What a color submenu checks: one color, "none" (null), or nothing at all when the selection is mixed. */
export type Checked = PaletteId | null | 'mixed';
const checked = (s: ColorState): Checked => (s === 'mixed' ? 'mixed' : s === null ? null : (toPaletteId(s) ?? 'mixed'));

/** The text and block commands, on one editor's selection. */
export function editorColors(editor: Editor) {
  // Each command runs on the editor's state as it stands, so focus goes back first: the selection is the editor's again.
  const focused = (): Editor => {
    if (!editor.isDestroyed && !editor.isFocused) editor.view.focus();
    return editor;
  };
  const now = colorsAt(editor.state);
  return {
    highlight: checked(now.highlight),
    textColor: checked(now.textColor),
    block: checked(now.block),
    /** Whether the caret's block takes a color at all (a rule, say, doesn't). */
    canColorBlock: blockAt(editor.state, editor.state.selection.from) !== null,
    setHighlight: (id: PaletteId | null): boolean => setHighlight(focused(), id),
    setTextColor: (id: PaletteId | null): boolean => setTextColor(focused(), id),
    clearFormatting: (): boolean => clearFormatting(focused()),
    /** Every block the selection touches; for a caret, its block. */
    setBlockColor: (id: PaletteId | null): boolean => setBlockColor(focused(), null, id),
  };
}
export type EditorColors = ReturnType<typeof editorColors>;

/** The page commands, on the backend. A desk older than labels refuses them; the host says so, as for any refusal. */
export function pageColors(backend: NotebookBackend) {
  return {
    setPageLabel: (pageId: string, id: PaletteId | null): Promise<void> => backend.setPageLabel(pageId, id),
    /** The copy goes right after the original; resolves to its id. */
    duplicatePage: async (pageId: string): Promise<string> => (await backend.duplicatePage(pageId)).id,
  };
}
