// The Files download fallback: whatever the file is called or typed, the blob handed to the browser is
// `application/octet-stream`, so no blob in the office carries a script type from desk data (ADR 0054).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTarget } from './save';

afterEach(() => vi.unstubAllGlobals());

describe('openTarget without a picker', () => {
  it.each(['page.html', 'run.js', 'image.svg', 'data.xml', 'plain.txt', 'archive.zip'])('downloads %s as application/octet-stream and keeps the name', async (name) => {
    const made: Blob[] = [];
    const clicked: string[] = [];
    const a = { href: '', download: '', rel: '', style: {} as Record<string, string>, click: () => void clicked.push(a.download), remove: () => {} };
    vi.stubGlobal('document', { createElement: () => a, body: { appendChild: () => {} } });
    vi.stubGlobal('window', { setTimeout: () => 0 });
    vi.stubGlobal('URL', { createObjectURL: (b: Blob) => (made.push(b), 'blob:x'), revokeObjectURL: () => {} });
    const t = await openTarget(null, name);
    expect(t.where).toBe('downloads');
    await t.sink.write(new TextEncoder().encode('<script>alert(1)</script>'));
    await t.finish();
    expect(made).toHaveLength(1);
    expect(made[0]!.type).toBe('application/octet-stream');
    expect(made[0]!.size).toBe(25);
    expect(clicked).toEqual([name]);
  });
});
