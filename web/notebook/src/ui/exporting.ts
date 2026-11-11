// Page export from the UI (design 5.6): files are made here and handed to the browser's own
// download, from a blob: URL. Nothing is uploaded anywhere.
//
// Colors (ADR 0091): `palette` is the UI palette's light values (`ui/palette.ts`'s `exportPalette()`), so a file shows the
// colors the page had when it left. The notebook file carries the colors' names and labels exactly, and `importNotebookFile` brings it back.
import type { NotebookBackend } from '../model/backend.ts';
import type { PaletteColors } from '../model/colors.ts';
import { fileName, toHtmlDocument, toMarkdown } from '../model/export.ts';
import { NOTEBOOK_FILE_EXT, parseNotebookFile, toNotebookFile } from '../model/notebookFile.ts';
import type { PageRec } from '../model/types.ts';
import { exportCss } from '../theme/tokens.ts';

function download(text: string, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportMarkdown(backend: NotebookBackend, pageId: string, palette?: PaletteColors): Promise<void> {
  const doc = await backend.pageContent(pageId);
  const title = backend.tree().byId[pageId]?.title ?? '';
  download(toMarkdown(doc, { palette }), 'text/markdown;charset=utf-8', fileName(title, 'md'));
}

export async function exportHtml(backend: NotebookBackend, pageId: string, palette?: PaletteColors): Promise<void> {
  const doc = await backend.pageContent(pageId);
  const title = backend.tree().byId[pageId]?.title ?? '';
  download(toHtmlDocument(doc, title, exportCss(), { palette }), 'text/html;charset=utf-8', fileName(title, 'html'));
}

/**
 * Pages as one notebook file (`Plan.notebook.json`), in the order given: their text, colors and labels. `name` names the
 * file; by default the first page's title.
 */
export async function exportNotebookFile(backend: NotebookBackend, pageIds: readonly string[], o: { palette?: PaletteColors; name?: string } = {}): Promise<void> {
  const tree = backend.tree();
  const pages: { rec: PageRec; doc: Awaited<ReturnType<NotebookBackend['pageContent']>> }[] = [];
  for (const id of pageIds) {
    const rec = tree.byId[id];
    if (rec) pages.push({ rec, doc: await backend.pageContent(id) });
  }
  const name = o.name ?? pages[0]?.rec.title ?? '';
  download(toNotebookFile(pages, o.palette ? { palette: o.palette } : {}), 'application/json;charset=utf-8', fileName(name, NOTEBOOK_FILE_EXT));
}

export interface ImportResult {
  pages: PageRec[];
  /** Pages the file had that couldn't be brought in: a body the editor can't show, or one too large to send at once. */
  skipped: number;
}

/**
 * A notebook file's pages into a tab, in order, after the page `after` names (or first). Throws `NotebookFileError` for a file
 * that isn't one, with words to show. A page the desk refuses (too large, say) is skipped and counted, and the rest go on.
 */
export async function importNotebookFile(backend: NotebookBackend, tabId: string, text: string, o: { palette?: PaletteColors; after?: string } = {}): Promise<ImportResult> {
  const parsed = parseNotebookFile(text, { palette: o.palette });
  const made: PageRec[] = [];
  let skipped = parsed.skipped;
  let after = o.after;
  for (const page of parsed.pages) {
    try {
      const rec = await backend.importPage(tabId, page, after ? { after } : {});
      made.push(rec);
      after = rec.id;
    } catch {
      skipped += 1;
    }
  }
  return { pages: made, skipped };
}
