// Page export from the UI (design 5.6): files are made here and handed to the browser's own
// download, from a blob: URL. Nothing is uploaded anywhere.
import type { NotebookBackend } from '../model/backend.ts';
import { fileName, toHtmlDocument, toMarkdown } from '../model/export.ts';
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

export async function exportMarkdown(backend: NotebookBackend, pageId: string): Promise<void> {
  const doc = await backend.pageContent(pageId);
  const title = backend.tree().byId[pageId]?.title ?? '';
  download(toMarkdown(doc), 'text/markdown;charset=utf-8', fileName(title, 'md'));
}

export async function exportHtml(backend: NotebookBackend, pageId: string): Promise<void> {
  const doc = await backend.pageContent(pageId);
  const title = backend.tree().byId[pageId]?.title ?? '';
  download(toHtmlDocument(doc, title, exportCss()), 'text/html;charset=utf-8', fileName(title, 'html'));
}
