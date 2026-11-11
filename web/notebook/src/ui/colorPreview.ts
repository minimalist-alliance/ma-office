// A color under the pointer (or keyboard focus) in a menu shows on the text before it's chosen (the Product Designer's
// app-colors README: "Hovering one previews it on the text"). It's a decoration, never an edit: nothing reaches the page's
// Y.Doc, the desk, history or undo, and it's gone when the menu moves on or closes, or the page changes.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { blocksInSelection } from '../model/commands.ts';

export interface Preview {
  kind: 'highlight' | 'text' | 'callout';
  /** A palette id, or null for "none". */
  id: string | null;
}

export const previewKey = new PluginKey<Preview | null>('nbColorPreview');

const ATTR = { highlight: 'data-preview-highlight', text: 'data-preview-text', callout: 'data-preview-callout' } as const;

function decorate(state: EditorState, p: Preview | null): DecorationSet {
  if (!p) return DecorationSet.empty;
  const value = p.id ?? 'none';
  if (p.kind === 'callout') {
    return DecorationSet.create(
      state.doc,
      blocksInSelection(state).map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { [ATTR.callout]: value })),
    );
  }
  const ranges = state.selection.ranges.filter((r) => r.$from.pos < r.$to.pos);
  return DecorationSet.create(
    state.doc,
    ranges.map((r) => Decoration.inline(r.$from.pos, r.$to.pos, { [ATTR[p.kind]]: value })),
  );
}

export const ColorPreview = Extension.create({
  name: 'nbColorPreview',
  addProseMirrorPlugins() {
    return [
      new Plugin<Preview | null>({
        key: previewKey,
        state: {
          init: () => null,
          // Set only by `setPreview`; any edit or selection change ends it.
          apply: (tr, prev) => {
            const meta = tr.getMeta(previewKey) as Preview | null | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged || tr.selectionSet ? null : prev;
          },
        },
        props: {
          decorations: (state) => decorate(state, previewKey.getState(state) ?? null),
          // While previewing, the browser's own selection color steps aside, so the preview shows through it.
          attributes: (state): Record<string, string> => (previewKey.getState(state) ? { class: 'nb-previewing' } : {}),
        },
      }),
    ];
  },
});

const same = (a: Preview | null, b: Preview | null): boolean => a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);

/** Shows `p` on the selection (or its blocks), or clears it with null. A transaction with no edit in it. */
export function setPreview(view: EditorView, p: Preview | null): void {
  if (same(previewKey.getState(view.state) ?? null, p)) return;
  view.dispatch(view.state.tr.setMeta(previewKey, p).setMeta('addToHistory', false));
}
