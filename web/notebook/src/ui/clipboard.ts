// Cut, copy and paste from the editor's context menu. The keyboard's own Ctrl+X, C and V never come here: ProseMirror handles
// those. A menu has no clipboard event to use, so this goes through the async Clipboard API where the browser allows it, and
// otherwise falls back quietly: copy and cut through the browser's own command, and paste by saying which keys to press.
import type { EditorView } from '@tiptap/pm/view';

type Clip = {
  write?: (items: ClipboardItem[]) => Promise<void>;
  read?: () => Promise<ClipboardItems>;
  readText?: () => Promise<string>;
};
const clip = (): Clip | undefined => (typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clip | undefined));

/** Copies the selection (and with `cut`, removes it once the clipboard has it). Returns false if nothing could. */
export async function copySelection(view: EditorView, cut: boolean): Promise<boolean> {
  const { state } = view;
  if (state.selection.empty) return false;
  const c = clip();
  if (c?.write && typeof ClipboardItem !== 'undefined') {
    const { dom, text } = view.serializeForClipboard(state.selection.content());
    try {
      // Called straight from the menu item's click, so the browser counts it as the member's gesture.
      await c.write([
        new ClipboardItem({
          'text/html': new Blob([dom.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      // Only what was copied is cut, and only if nothing else changed the page meanwhile.
      if (cut && view.state.doc === state.doc) view.dispatch(view.state.tr.setSelection(state.selection).deleteSelection().scrollIntoView());
      view.focus();
      return true;
    } catch {
      // Refused: the browser's own command below.
    }
  }
  view.focus();
  try {
    return document.execCommand(cut ? 'cut' : 'copy');
  } catch {
    return false;
  }
}

/**
 * Pastes what's on the clipboard where the caret is, as a paste would (the same handlers, the large-paste split included).
 * Returns false when the browser won't let the page read it: the caller then says to press the paste keys.
 */
export async function pasteFromClipboard(view: EditorView): Promise<boolean> {
  const c = clip();
  try {
    if (c?.read) {
      const items = await c.read();
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          view.focus();
          return view.pasteHTML(html);
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          view.focus();
          return view.pasteText(text);
        }
      }
      return true; // nothing to paste is not an error
    }
    if (c?.readText) {
      const text = await c.readText();
      view.focus();
      return text ? view.pasteText(text) : true;
    }
  } catch {
    // Permission refused or not supported.
  }
  view.focus();
  return false;
}
