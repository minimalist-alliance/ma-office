// The phone Paste key's read (Security's condition, Nov 11): one `readText` per call, the text straight on, and a refusal
// is the line and nothing else.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_MAX_BYTES, StreamClipboard, PASTE_TOO_BIG } from './clipboard';
import { readForPaste } from './touchPaste';

function driver() {
  return { pastePhone: vi.fn(), pasteRefused: vi.fn() };
}
function stubClipboard(readText: unknown) {
  vi.stubGlobal('navigator', { clipboard: readText === undefined ? undefined : { readText } });
}
afterEach(() => vi.unstubAllGlobals());

describe('readForPaste', () => {
  it('reads once and hands the text straight to the paste path', async () => {
    const readText = vi.fn().mockResolvedValue('hello');
    stubClipboard(readText);
    const d = driver();
    readForPaste(d);
    await Promise.resolve();
    await Promise.resolve();
    expect(readText).toHaveBeenCalledTimes(1);
    expect(d.pastePhone).toHaveBeenCalledExactlyOnceWith('hello');
    expect(d.pasteRefused).not.toHaveBeenCalled();
  });
  it('a refusal says the line and sends nothing, with no second read', async () => {
    const readText = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    stubClipboard(readText);
    const d = driver();
    readForPaste(d);
    await new Promise((r) => setTimeout(r));
    expect(readText).toHaveBeenCalledTimes(1);
    expect(d.pasteRefused).toHaveBeenCalledTimes(1);
    expect(d.pastePhone).not.toHaveBeenCalled();
  });
  it('a browser with no clipboard reading, or one that throws, is a refusal', () => {
    stubClipboard(undefined);
    const a = driver();
    readForPaste(a);
    expect(a.pasteRefused).toHaveBeenCalledTimes(1);
    stubClipboard(() => {
      throw new Error('x');
    });
    const b = driver();
    readForPaste(b);
    expect(b.pasteRefused).toHaveBeenCalledTimes(1);
    expect(b.pastePhone).not.toHaveBeenCalled();
  });
  it('nothing reads until it is called', () => {
    const readText = vi.fn().mockResolvedValue('x');
    stubClipboard(readText);
    expect(readText).not.toHaveBeenCalled();
  });
});

describe('over the cap', () => {
  it('follows StreamClipboard.paste: the too-big line, no write', async () => {
    const say = vi.fn();
    const call = vi.fn();
    const clip = new StreamClipboard({ link: () => ({ call }) as never, open: () => true, insert: vi.fn(), say });
    clip.paste('x'.repeat(CLIPBOARD_MAX_BYTES + 1), vi.fn(), false);
    await new Promise((r) => setTimeout(r));
    expect(say).toHaveBeenCalledWith(PASTE_TOO_BIG);
    expect(call).not.toHaveBeenCalled();
  });
});
