import { describe, expect, it } from 'vitest';
import type { BrowserDownload } from '../desk/deskLink';
import { DownloadWatch, SHOWN_AFTER_END_MS } from './downloads';

const d = (over: Partial<BrowserDownload>): BrowserDownload => ({ id: 'g1', name: 'report.pdf', state: 'inProgress', receivedBytes: 0, totalBytes: 0, ...over });

describe('DownloadWatch', () => {
  it('says a download started, shows it going with its percent, then saved for a few seconds', () => {
    const w = new DownloadWatch();
    expect(w.take([], 0)).toBeNull();
    expect(w.take([d({ receivedBytes: 1, totalBytes: 4 })], 100)).toBe('Downloading report.pdf');
    expect(w.line(100)).toEqual({ id: 'g1', kind: 'going', text: 'Downloading report.pdf', percent: 25, filesPath: null, deviceUrl: null });
    expect(w.take([d({ receivedBytes: 3, totalBytes: 4 })], 200)).toBeNull();
    expect(w.line(200)?.percent).toBe(75);
    expect(w.take([d({ state: 'completed', receivedBytes: 4, totalBytes: 4 })], 1000)).toBe('Saved report.pdf on your desk');
    expect(w.line(1000)).toMatchObject({ kind: 'saved', text: 'Saved report.pdf on your desk', percent: null, filesPath: null });
    expect(w.nextChangeAt(1000)).toBe(1000 + SHOWN_AFTER_END_MS);
    expect(w.line(1000 + SHOWN_AFTER_END_MS)).toBeNull();
    expect(w.nextChangeAt(1000 + SHOWN_AFTER_END_MS)).toBeNull();
  });

  it('has no percent when the size is unknown', () => {
    const w = new DownloadWatch();
    w.take([], 0);
    w.take([d({ receivedBytes: 500 })], 1);
    expect(w.line(1)?.percent).toBeNull();
  });

  it('says nothing of what had already ended when the window opened, and shows what was still going', () => {
    const w = new DownloadWatch();
    expect(w.take([d({ id: 'g2', name: 'new.zip' }), d({ state: 'completed' })], 0)).toBeNull();
    expect(w.line(0)).toMatchObject({ id: 'g2', kind: 'going' });
    expect(w.take([d({ id: 'g2', name: 'new.zip', state: 'completed' }), d({ state: 'completed' })], 10)).toBe('Saved new.zip on your desk');
  });

  it('a download that starts and ends between two lists is still news', () => {
    const w = new DownloadWatch();
    w.take([], 0);
    expect(w.take([d({ state: 'completed', receivedBytes: 9, totalBytes: 9 })], 5)).toBe('Saved report.pdf on your desk');
    expect(w.line(5)?.kind).toBe('saved');
  });

  it('a canceled download says so, and a file in Files says where', () => {
    const w = new DownloadWatch();
    w.take([d({})], 0);
    expect(w.take([d({ state: 'canceled' })], 1)).toBe('Download canceled: report.pdf');
    expect(w.line(1)).toMatchObject({ kind: 'canceled', filesPath: null });
    w.take([d({ id: 'g3', name: 'a.zip' }), d({ state: 'canceled' })], 2);
    expect(w.take([d({ id: 'g3', name: 'a.zip', state: 'completed', filesPath: 'Downloads/a.zip' }), d({ state: 'canceled' })], 3)).toBe('Saved a.zip to Files');
    expect(w.line(3)).toMatchObject({ kind: 'saved', filesPath: 'Downloads/a.zip' });
  });

  it('an end that just happened comes before one still going, which shows once that line has gone', () => {
    const w = new DownloadWatch();
    w.take([d({ id: 'big', name: 'big.iso' })], 0);
    w.take([d({ id: 'small', name: 'small.txt' }), d({ id: 'big', name: 'big.iso' })], 1);
    w.take([d({ id: 'small', name: 'small.txt', state: 'completed' }), d({ id: 'big', name: 'big.iso' })], 2);
    expect(w.line(2)?.text).toBe('Saved small.txt on your desk');
    expect(w.line(2 + SHOWN_AFTER_END_MS)?.text).toBe('Downloading big.iso');
  });

  it('drops anything malformed', () => {
    const w = new DownloadWatch();
    w.take([], 0);
    expect(w.take([{ id: 1 }, null, 'x', d({ state: 'weird' as never })], 1)).toBeNull();
    expect(w.take('not a list', 2)).toBeNull();
    expect(w.line(2)).toBeNull();
  });

  it("offers the finished download's own http(s) address for this device, and nothing else (#9)", () => {
    const w = new DownloadWatch();
    w.take([], 0);
    w.take([d({ id: 'g5', url: 'https://files.example.com/r.pdf' })], 1);
    expect(w.line(1)).toMatchObject({ kind: 'going', deviceUrl: null });
    w.take([d({ id: 'g5', state: 'completed', url: 'https://files.example.com/r.pdf' })], 2);
    expect(w.line(2)).toMatchObject({ kind: 'saved', deviceUrl: 'https://files.example.com/r.pdf' });
    for (const url of ['blob:https://x.example/1', 'data:text/plain,hi', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const v = new DownloadWatch();
      v.take([], 0);
      v.take([d({ id: 'g6', state: 'inProgress' })], 1);
      v.take([d({ id: 'g6', state: 'completed', url })], 2);
      expect(v.line(2)).toMatchObject({ kind: 'saved', deviceUrl: null });
    }
    const c = new DownloadWatch();
    c.take([], 0);
    c.take([d({ id: 'g7' })], 1);
    c.take([d({ id: 'g7', state: 'canceled', url: 'https://files.example.com/r.pdf' })], 2);
    expect(c.line(2)).toMatchObject({ kind: 'canceled', deviceUrl: null });
    // Not a string: the entry is dropped whole, as anything malformed is.
    const m = new DownloadWatch();
    m.take([], 0);
    m.take([{ ...d({ id: 'g8' }), url: 42 }], 1);
    expect(m.line(1)).toBeNull();
  });
});
