// The Notebook's color commands (ADR 0091), for the editor's menus. Each is a plain ProseMirror command, so it runs on any
// state (tests, headless) and through the live editor like typing: the change goes through the Yjs binding, so it syncs to
// everyone on the page and Mod-Z undoes it, and a version taken after it holds it. The `editor` wrappers at the bottom are
// what the menus call.
import { Extension, type Editor } from '@tiptap/core';
import type { Mark, Node as PMNodeT } from '@tiptap/pm/model';
import type { Command, EditorState } from '@tiptap/pm/state';
import { COLOR_BLOCK_TYPES, highlightId, isPaletteId, paletteId, type PaletteId } from './colors.ts';

/** A list item is colored on its own; anything else is colored whole at the top level (a quote with its paragraphs). */
const ITEM_TYPES = new Set(['listItem', 'taskItem']);
const COLORABLE = new Set<string>(COLOR_BLOCK_TYPES);
/** Clear formatting keeps links: a link isn't formatting. */
const KEPT_BY_CLEAR = new Set(['link']);

export type ColorMark = 'highlight' | 'textColor';
/** What the selection has: one id, none (`null`), or several (`'mixed'`), for a menu's check marks. */
export type ColorState = PaletteId | null | 'mixed';
export interface ColorsAt {
  highlight: ColorState;
  textColor: ColorState;
  block: ColorState;
}

/** The block `setBlockColor` colors, with its position (before it) and its color now. */
export interface BlockTarget {
  pos: number;
  node: PMNodeT;
  color: PaletteId | null;
}

const target = (pos: number, node: PMNodeT): BlockTarget => ({ pos, node, color: paletteId(node.attrs['color']) });

/** The block a position is in: the innermost list item around it, or else the top-level block. Null if it takes no color. */
export function blockAt(state: EditorState, pos: number): BlockTarget | null {
  const { doc } = state;
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    const node = $pos.node(d);
    if (ITEM_TYPES.has(node.type.name)) return target($pos.before(d), node);
  }
  if ($pos.depth >= 1) {
    const top = $pos.node(1);
    return COLORABLE.has(top.type.name) ? target($pos.before(1), top) : null;
  }
  // Between top-level blocks, as a block's node selection is: the block after, else the one before.
  const after = $pos.nodeAfter;
  if (after && COLORABLE.has(after.type.name)) return target(pos, after);
  const before = $pos.nodeBefore;
  if (before && COLORABLE.has(before.type.name)) return target(pos - before.nodeSize, before);
  return null;
}

/** Every block the selection touches, each once, in document order. */
export function blocksInSelection(state: EditorState): BlockTarget[] {
  const found = new Map<number, BlockTarget>();
  const add = (t: BlockTarget | null): void => {
    if (t && !found.has(t.pos)) found.set(t.pos, t);
  };
  for (const range of state.selection.ranges) {
    const from = range.$from.pos;
    const to = range.$to.pos;
    add(blockAt(state, from));
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) {
        add(blockAt(state, pos + 1));
        return false;
      }
      return true;
    });
  }
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

const colorOfMark = (name: ColorMark, marks: readonly Mark[]): PaletteId | null => {
  const m = marks.find((x) => x.type.name === name);
  if (!m) return null;
  return name === 'highlight' ? highlightId(m.attrs['color']) : paletteId(m.attrs['color']);
};

const oneOf = (seen: Set<PaletteId | null>): ColorState => (seen.size === 0 ? null : seen.size === 1 ? ([...seen][0] as PaletteId | null) : 'mixed');

/** What the selection's text and blocks have now. An empty selection reads what typing would get. */
export function colorsAt(state: EditorState): ColorsAt {
  const { selection } = state;
  const highlight = new Set<PaletteId | null>();
  const textColor = new Set<PaletteId | null>();
  if (selection.empty) {
    const marks = state.storedMarks ?? selection.$from.marks();
    highlight.add(colorOfMark('highlight', marks));
    textColor.add(colorOfMark('textColor', marks));
  } else {
    for (const range of selection.ranges) {
      state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
        if (!node.isText) return true;
        highlight.add(colorOfMark('highlight', node.marks));
        textColor.add(colorOfMark('textColor', node.marks));
        return false;
      });
    }
  }
  const blocks = new Set<PaletteId | null>(blocksInSelection(state).map((b) => b.color));
  return { highlight: oneOf(highlight), textColor: oneOf(textColor), block: oneOf(blocks) };
}

/** Sets (or with null removes) a color mark on the selection; on an empty selection, on what's typed next. */
export function colorMarkCommand(name: ColorMark, id: PaletteId | null): Command {
  return (state, dispatch) => {
    if (id !== null && !isPaletteId(id)) return false;
    const type = state.schema.marks[name];
    if (!type) return false;
    const { selection } = state;
    const tr = state.tr;
    if (selection.empty) {
      if (id === null) tr.removeStoredMark(type);
      else if (selection.$from.parent.type.allowsMarkType(type)) tr.addStoredMark(type.create({ color: id }));
      else return false;
    } else {
      for (const range of selection.ranges) {
        tr.removeMark(range.$from.pos, range.$to.pos, type);
        if (id !== null) tr.addMark(range.$from.pos, range.$to.pos, type.create({ color: id }));
      }
    }
    dispatch?.(tr);
    return true;
  };
}

/** Every mark but links off the selection, or off what's typed next. Block colors stay. */
export function clearFormattingCommand(): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    const { selection } = state;
    if (selection.empty) {
      tr.setStoredMarks((state.storedMarks ?? selection.$from.marks()).filter((m) => KEPT_BY_CLEAR.has(m.type.name)));
    } else {
      for (const range of selection.ranges) {
        for (const type of Object.values(state.schema.marks)) {
          if (!KEPT_BY_CLEAR.has(type.name)) tr.removeMark(range.$from.pos, range.$to.pos, type);
        }
      }
    }
    dispatch?.(tr);
    return true;
  };
}

/** Colors (or with null uncolors) the block at `at`, or with `at` null every block the selection touches. */
export function blockColorCommand(at: number | null, id: PaletteId | null): Command {
  return (state, dispatch) => {
    if (id !== null && !isPaletteId(id)) return false;
    const targets = at === null ? blocksInSelection(state) : [blockAt(state, at)].filter((t): t is BlockTarget => t !== null);
    if (!targets.length) return false;
    const tr = state.tr;
    for (const t of targets) if (t.node.attrs['color'] !== id) tr.setNodeAttribute(t.pos, 'color', id);
    dispatch?.(tr);
    return true;
  };
}

// ------------------------------------------------------------------ on the live editor

/** What the wrappers need of a TipTap editor. */
export type ColorEditor = Pick<Editor, 'state' | 'view' | 'isDestroyed'>;

function run(editor: ColorEditor, command: Command): boolean {
  if (editor.isDestroyed) return false;
  return command(editor.state, (tr) => editor.view.dispatch(tr));
}

/** Highlights the selection with a color (one of the six names), or removes its highlight. */
export const setHighlight = (editor: ColorEditor, id: PaletteId | null): boolean => run(editor, colorMarkCommand('highlight', id));
/** Colors the selection's text (one of the six names), or back to the default. */
export const setTextColor = (editor: ColorEditor, id: PaletteId | null): boolean => run(editor, colorMarkCommand('textColor', id));
/** Bold, italic, underline, strikethrough, code, highlight and text color off the selection. Links stay. */
export const clearFormatting = (editor: ColorEditor): boolean => run(editor, clearFormattingCommand());
/** Colors the block at `at` (a document position), or every block in the selection when `at` is null. */
export const setBlockColor = (editor: ColorEditor, at: number | null, id: PaletteId | null): boolean => run(editor, blockColorCommand(at, id));

// ------------------------------------------------------------------ as TipTap commands

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    notebookColors: {
      /** A color's name on the selection's text, or null to take it off. */
      setTextColor: (id: PaletteId | null) => ReturnType;
      /** Every mark but links off the selection. */
      clearFormatting: () => ReturnType;
      /** A color's name on the block at `at` (a position), or on every block in the selection when `at` is null. */
      setBlockColor: (at: number | null, id: PaletteId | null) => ReturnType;
    };
  }
}

/**
 * The same commands on `editor.commands` and in chains (`editor.chain().focus().setTextColor('green').run()`). The highlight is
 * TipTap's own `setHighlight({ color })` and `unsetHighlight()`. In `schemaExtensions()`, so every editor has them.
 */
export const NotebookColorCommands = Extension.create({
  name: 'notebookColors',
  addCommands() {
    return {
      setTextColor:
        (id: PaletteId | null) =>
        ({ state, dispatch }) =>
          colorMarkCommand('textColor', id)(state, dispatch),
      clearFormatting:
        () =>
        ({ state, dispatch }) =>
          clearFormattingCommand()(state, dispatch),
      setBlockColor:
        (at: number | null, id: PaletteId | null) =>
        ({ state, dispatch }) =>
          blockColorCommand(at, id)(state, dispatch),
    };
  },
});
