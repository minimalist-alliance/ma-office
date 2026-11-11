// What the editor's context menu offers (the Product Designer's app-colors README, "In the context menu"). On a selection:
// Highlight, Text color, Turn into callout, Clear formatting, then Cut, Copy and Paste. On the caret's block: Turn into
// callout and its style. Every color goes through colorCommands.ts, the `nb-data` commands.
import type { Editor } from '@tiptap/core';
import { copySelection, pasteFromClipboard } from './clipboard.ts';
import { editorColors, type Checked } from './colorCommands.ts';
import type { Preview } from './colorPreview.ts';
import type { MenuItem } from './menu/Menu.tsx';
import { PALETTE, SWATCH_COLUMNS, type PaletteId } from './palette.ts';

export { SWATCH_COLUMNS };

/**
 * A color submenu: one row of round swatches, each filled with its color's label and named for it ("Amber"), the current one
 * checked, then "none" at the end. A mixed selection checks nothing. With nothing set, the keyboard starts on the color
 * last used (`last`). With `preview`, a swatch under the pointer or the keyboard shows on the text before it's chosen.
 */
export function paletteItems(
  current: Checked,
  noneLabel: string,
  pick: (id: PaletteId | null) => void,
  o: { last?: PaletteId; preview?: Preview['kind']; testPrefix?: string } = {},
): MenuItem[] {
  const unset = current === null || current === 'mixed';
  const preview = (id: PaletteId | null): Preview | undefined => (o.preview ? { kind: o.preview, id } : undefined);
  return [
    ...PALETTE.map(
      (p): MenuItem => ({
        label: p.name,
        pal: p.id,
        checked: current === p.id,
        start: unset && p.id === o.last,
        preview: preview(p.id),
        onSelect: () => pick(p.id),
        testId: o.testPrefix && `${o.testPrefix}-${p.id}`,
      }),
    ),
    { label: noneLabel, pal: null, checked: current === null, preview: preview(null), onSelect: () => pick(null), testId: o.testPrefix && `${o.testPrefix}-none` },
  ];
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string): string => (MAC ? `⌘${k}` : `Ctrl+${k}`);

type BlockKind = 'title' | 'heading' | 'subheading' | 'body' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';

function blockKind(editor: Editor): BlockKind | null {
  if (editor.isActive('codeBlock')) return 'code';
  if (editor.isActive('taskList')) return 'task';
  if (editor.isActive('orderedList')) return 'ordered';
  if (editor.isActive('bulletList')) return 'bullet';
  if (editor.isActive('blockquote')) return 'quote';
  if (editor.isActive('heading', { level: 1 })) return 'title';
  if (editor.isActive('heading', { level: 2 })) return 'heading';
  if (editor.isActive('heading', { level: 3 })) return 'subheading';
  if (editor.isActive('paragraph')) return 'body';
  return null;
}

/** The block styles the toolbar and the Markdown shortcuts already offer, as one submenu. */
function blockStyles(editor: Editor): MenuItem[] {
  const kind = blockKind(editor);
  const c = () => editor.chain().focus();
  const row = (k: BlockKind, label: string, run: () => boolean): MenuItem => ({ label, checked: kind === k, onSelect: () => void (kind === k || run()) });
  return [
    row('title', 'Title', () => c().setHeading({ level: 1 }).run()),
    row('heading', 'Heading', () => c().setHeading({ level: 2 }).run()),
    row('subheading', 'Subheading', () => c().setHeading({ level: 3 }).run()),
    row('body', 'Body', () => c().setParagraph().run()),
    row('bullet', 'Bulleted list', () => c().toggleBulletList().run()),
    row('ordered', 'Numbered list', () => c().toggleOrderedList().run()),
    row('task', 'Checklist', () => c().toggleTaskList().run()),
    row('quote', 'Quote', () => c().toggleBlockquote().run()),
    row('code', 'Code block', () => c().toggleCodeBlock().run()),
  ];
}

export interface EditorMenuContext {
  /** The color last used, for this member (the host's `prefs`): Turn into callout uses it, and the rows start on it. */
  last: PaletteId;
  /** Called with each color chosen, so the next menu starts there. */
  remember: (id: PaletteId) => void;
  /** The browser wouldn't let the page read the clipboard: say which keys to press. */
  onPasteRefused: () => void;
}

export function editorMenuItems(editor: Editor, ctx: EditorMenuContext): MenuItem[] {
  const colors = editorColors(editor);
  const { empty } = editor.state.selection;
  const view = editor.view;
  const readOnly = !editor.isEditable;
  const { last, remember } = ctx;
  const chosen =
    (apply: (id: PaletteId | null) => unknown) =>
    (id: PaletteId | null): void => {
      apply(id);
      if (id) remember(id);
    };

  // Turn into callout acts at once, in the last color used (unless the block is a callout already), and then shows the
  // row to change it; Right opens the row without acting.
  const uncolored = colors.block === null;
  const callout: MenuItem = {
    label: 'Turn into callout',
    disabled: readOnly || !colors.canColorBlock,
    columns: SWATCH_COLUMNS,
    onSelect: () => {
      if (uncolored) colors.setBlockColor(last);
    },
    preview: uncolored ? ({ kind: 'callout', id: last } satisfies Preview) : undefined,
    submenu: paletteItems(colors.block, 'No callout', chosen((id) => colors.setBlockColor(id)), { last, preview: 'callout', testPrefix: 'callout' }),
  };
  const style: MenuItem = { label: 'Block style', disabled: readOnly, submenu: blockStyles(editor) };
  const paste: MenuItem = {
    label: 'Paste',
    hint: key('V'),
    disabled: readOnly,
    onSelect: () => void pasteFromClipboard(view).then((ok) => ok || ctx.onPasteRefused()),
  };

  if (empty) return [callout, style, { label: '', separator: true }, paste];

  return [
    {
      label: 'Highlight',
      disabled: readOnly,
      columns: SWATCH_COLUMNS,
      submenu: paletteItems(colors.highlight, 'No highlight', chosen((id) => colors.setHighlight(id)), { last, preview: 'highlight', testPrefix: 'highlight' }),
    },
    {
      label: 'Text color',
      disabled: readOnly,
      columns: SWATCH_COLUMNS,
      submenu: paletteItems(colors.textColor, 'Default color', chosen((id) => colors.setTextColor(id)), { last, preview: 'text', testPrefix: 'text-color' }),
    },
    callout,
    { label: 'Clear formatting', disabled: readOnly, onSelect: () => colors.clearFormatting() },
    { label: '', separator: true },
    { label: 'Cut', hint: key('X'), disabled: readOnly, onSelect: () => void copySelection(view, true) },
    { label: 'Copy', hint: key('C'), onSelect: () => void copySelection(view, false) },
    paste,
    { label: '', separator: true },
    style,
  ];
}

export const PASTE_KEYS_LINE = `Press ${key('V')} to paste.`;
