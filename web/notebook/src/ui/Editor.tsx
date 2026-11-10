// The page editor: TipTap 3 bound to the page's Y.Doc (design 5.1). Typing never goes through
// React: the editor doesn't re-render on transactions, the toolbar reads only the few states it
// shows, and anything derived from the whole document waits for the backend's store.
import { Extension, type Editor as TipTapEditor, type JSONContent } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import type { PageSession } from '../model/backend.ts';
import { DOC_FIELD, schemaExtensions, type PMNode } from '../model/schema.ts';
import { Icon } from './icons.tsx';
import { handleLargePaste } from './pasteSplit.ts';
import { remoteCarets } from './remoteCarets.ts';

/**
 * "Title" in an empty first line, as Apple Notes does. Only the first block is looked at, so the
 * cost doesn't grow with the page (TipTap's Placeholder walks the whole document on every keystroke).
 */
const TitlePlaceholder = Extension.create({
  name: 'titlePlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('titlePlaceholder'),
        props: {
          decorations: ({ doc }) => {
            const first = doc.firstChild;
            if (!first || !first.isTextblock || first.content.size > 0) return null;
            return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: 'nb-empty-title', 'data-placeholder': 'Title' })]);
          },
        },
      }),
    ];
  },
});

/**
 * Apple Notes' checklist shortcut. Title, Heading, Subheading and Body keep TipTap's Mod-Alt-1, 2, 3
 * and 0, and Highlight its Mod-Shift-H: Apple's Cmd-Shift-T would reopen a closed browser tab.
 */
const NotebookKeys = Extension.create({
  name: 'notebookKeys',
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.toggleTaskList(),
    };
  },
});

export interface ToolbarState {
  block: 'title' | 'heading' | 'subheading' | 'body' | 'other';
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
}

function readToolbar(editor: TipTapEditor | null): ToolbarState {
  const is = (name: string, attrs?: Record<string, unknown>) => !!editor?.isActive(name, attrs);
  const block = is('heading', { level: 1 }) ? 'title' : is('heading', { level: 2 }) ? 'heading' : is('heading', { level: 3 }) ? 'subheading' : is('paragraph') ? 'body' : 'other';
  const task = is('taskList');
  return {
    block,
    bold: is('bold'),
    italic: is('italic'),
    underline: is('underline'),
    strike: is('strike'),
    highlight: is('highlight'),
    bullet: is('bulletList') && !task,
    ordered: is('orderedList'),
    task,
  };
}

const keep = (e: ReactMouseEvent) => e.preventDefault(); // a toolbar press keeps the text selection

function Tool({ on, label, wide, onPress, children, shortcut }: { on: boolean; label: string; wide?: boolean; onPress: () => void; children: React.ReactNode; shortcut?: string }) {
  return (
    <button
      type="button"
      className={`nb-tool${on ? ' on' : ''}${wide ? ' wide' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      onMouseDown={keep}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function Toolbar({ editor }: { editor: TipTapEditor }) {
  const st = useEditorState({ editor, selector: ({ editor: e }) => readToolbar(e) });
  const chain = () => editor.chain().focus();
  return (
    <div className="nb-toolbar" role="toolbar" aria-label="Formatting">
      <div className="nb-tool-group">
        <Tool wide on={st.block === 'title'} label="Title" shortcut={`${MOD}Alt+1`} onPress={() => chain().setHeading({ level: 1 }).run()}>Title</Tool>
        <Tool wide on={st.block === 'heading'} label="Heading" onPress={() => chain().setHeading({ level: 2 }).run()}>Heading</Tool>
        <Tool wide on={st.block === 'subheading'} label="Subheading" onPress={() => chain().setHeading({ level: 3 }).run()}>Subheading</Tool>
        <Tool wide on={st.block === 'body'} label="Body" onPress={() => chain().setParagraph().run()}>Body</Tool>
      </div>
      <div className="nb-tool-group">
        <Tool on={st.bold} label="Bold" shortcut={`${MOD}B`} onPress={() => chain().toggleBold().run()}><b>B</b></Tool>
        <Tool on={st.italic} label="Italic" shortcut={`${MOD}I`} onPress={() => chain().toggleItalic().run()}><i>I</i></Tool>
        <Tool on={st.underline} label="Underline" shortcut={`${MOD}U`} onPress={() => chain().toggleUnderline().run()}><u>U</u></Tool>
        <Tool on={st.strike} label="Strikethrough" onPress={() => chain().toggleStrike().run()}><s>S</s></Tool>
        <Tool on={st.highlight} label="Highlight" shortcut={`${MOD}Shift+H`} onPress={() => chain().toggleHighlight().run()}><Icon name="highlight" /></Tool>
      </div>
      <div className="nb-tool-group">
        <Tool on={st.bullet} label="Bulleted list" onPress={() => chain().toggleBulletList().run()}><Icon name="bullets" /></Tool>
        <Tool on={st.ordered} label="Numbered list" onPress={() => chain().toggleOrderedList().run()}><Icon name="numbers" /></Tool>
        <Tool on={st.task} label="Checklist" shortcut={`${MOD}Shift+L`} onPress={() => chain().toggleTaskList().run()}><Icon name="checklist" /></Tool>
      </div>
    </div>
  );
}

/**
 * The page's title as `derive` makes it for the list, search and export: the first line with text in it, even when the
 * Title line above it is empty (LS-29). It stops at that line, so it reads only the empty lines above it.
 */
function liveTitleOf(doc: TipTapEditor['state']['doc']): string {
  let title = '';
  doc.descendants((node) => {
    if (title) return false;
    if (!node.isTextblock) return true;
    title = (node.textBetween(0, node.content.size, '\n', ' ').split('\n')[0] ?? '').trim();
    return false;
  });
  return title;
}

/** Calls back with the title whenever it changes: a read of the lines up to the first with text, per transaction. */
function watchTitle(editor: TipTapEditor, onTitle: (title: string) => void): () => void {
  let last: string | null = null;
  const read = () => {
    const t = liveTitleOf(editor.state.doc);
    if (t !== last) {
      last = t;
      onTitle(t);
    }
  };
  read();
  editor.on('transaction', read);
  return () => {
    editor.off('transaction', read);
  };
}

export function PageEditor({
  session,
  onTitle,
  onOpenLink,
  autofocus,
  onEditor,
}: {
  session: PageSession;
  /** The live first line, for the page list while typing (the backend's title follows within seconds). */
  onTitle?: (title: string) => void;
  /** Mod-click on a link. The Desk app opens it in the desk's Browser; nothing here ever fetches it. */
  onOpenLink?: (href: string) => void;
  autofocus?: boolean;
  onEditor?: (editor: TipTapEditor | null) => void;
}) {
  const linkRef = useRef(onOpenLink);
  linkRef.current = onOpenLink;
  const editor = useEditor(
    {
      extensions: [
        ...schemaExtensions(),
        Collaboration.configure({ document: session.doc, field: DOC_FIELD }),
        remoteCarets(session.awareness),
        TitlePlaceholder,
        NotebookKeys,
      ],
      // The Desk app's CSP has no style-src 'unsafe-inline': notebook.css carries TipTap's base rules.
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      immediatelyRender: true,
      autofocus: autofocus ? 'start' : false,
      editorProps: {
        attributes: { class: 'nb-prose', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note text', 'data-testid': 'note-editor', spellcheck: 'true' },
        handlePaste: (view, _event, slice) => handleLargePaste(view, slice),
        handleClick: (_view, _pos, event) => {
          const a = (event.target as HTMLElement | null)?.closest?.('a[href]');
          if (a && (event.metaKey || event.ctrlKey)) {
            linkRef.current?.(a.getAttribute('href') ?? '');
            return true;
          }
          return false;
        },
      },
    },
    [session],
  );

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  useEffect(() => (editor && onTitle ? watchTitle(editor, onTitle) : undefined), [editor, onTitle]);

  // TipTap's own autofocus runs on a timer from when the editor is made, during render. A long render, such as a desk's whole page
  // list, yields before it commits, the timer fires first, and focus on a view that isn't in the page yet goes nowhere: on a real
  // desk a new page then sat unfocused, and what was typed went to the New page button. This runs once the view is in the page.
  useEffect(() => {
    if (!editor || !autofocus) return undefined;
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed && !editor.isFocused) editor.commands.focus('start');
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, autofocus]);

  // A page the desk won't take more of: the text stays on screen, and nothing more can be typed into it.
  useEffect(
    () =>
      editor
        ? session.onReadOnly?.((readOnly) => {
            editor.setEditable(!readOnly);
            editor.view.dom.setAttribute('aria-readonly', String(readOnly));
          })
        : undefined,
    [editor, session],
  );

  if (!editor) return null;
  return (
    <div className="nb-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="nb-scroll" />
    </div>
  );
}

/** A page body shown read-only, from JSON: a version, a day's state, or the print view. No Yjs. */
export function ReadOnlyDoc({ doc, className = '' }: { doc: PMNode; className?: string }) {
  const editor = useEditor(
    {
      extensions: schemaExtensions(),
      content: doc as JSONContent,
      editable: false,
      injectCSS: false,
      shouldRerenderOnTransaction: false,
      immediatelyRender: true,
      editorProps: { attributes: { class: 'nb-prose readonly', role: 'document' } },
    },
    [doc],
  );
  return editor ? <EditorContent editor={editor} className={`nb-scroll ${className}`} /> : null;
}
