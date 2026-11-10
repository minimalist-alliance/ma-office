// Folders from a drop (`webkitGetAsEntry`) and from the directory picker: their paths, empty folders, and names the desk can't take.
import { describe, expect, it } from 'vitest';
import { fromEntries, fromInput } from './collect';

const file = (name: string, text = 'x'): File => new File([text], name);
interface E {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void) => void;
  createReader?: () => { readEntries(ok: (e: E[]) => void): void };
}
const f = (name: string): E => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
const d = (name: string, children: E[]): E => {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let given = false;
      return {
        // As the browser does: in batches, an empty one last.
        readEntries: (ok) => {
          if (given) return ok([]);
          given = true;
          ok(children);
        },
      };
    },
  };
};

describe('what was dropped', () => {
  it('a folder keeps its shape, an empty one is kept, and a file dropped alone lands at the top', async () => {
    const got = await fromEntries({ entries: [d('Trip', [f('a.txt'), d('Day 1', [f('b.txt')]), d('Empty', [])]) as never], plain: [file('loose.txt')] }, '');
    expect(got.files.map((p) => p.rel).sort()).toEqual(['Trip/Day 1/b.txt', 'Trip/a.txt', 'loose.txt']);
    expect(got.emptyDirs).toEqual(['Trip/Empty']);
    expect(got.skipped).toBe(0);
  });

  it('names the desk can not take are left out and counted, never renamed on the quiet; names are made NFC', async () => {
    const got = await fromEntries({ entries: [d('Docs', [f('ok.txt'), f('bad\\name.txt'), f('x'.repeat(300)), f('Café.txt')]) as never], plain: [] }, '');
    expect(got.files.map((p) => p.rel).sort()).toEqual(['Docs/Café.txt', 'Docs/ok.txt'].sort());
    expect(got.skipped).toBe(2);
  });

  it('the reserved names at the top are refused, and fine below it', async () => {
    const got = await fromEntries({ entries: [d('.trash', [f('a')]) as never, d('Mine', [d('.trash', [f('b')])]) as never], plain: [] }, '');
    expect(got.files.map((p) => p.rel)).toEqual(['Mine/.trash/b']);
    expect(got.skipped).toBe(1);
  });
});

describe('what the pickers gave', () => {
  it('the directory picker gives each file its relative path', () => {
    const a = file('a.txt');
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Trip/Day 1/a.txt' });
    const got = fromInput([a, file('b.txt')], 'Photos');
    expect(got.files.map((p) => p.rel)).toEqual(['Trip/Day 1/a.txt', 'b.txt']);
  });

  it('a path too long for the desk is left out', () => {
    const long = file('a.txt');
    Object.defineProperty(long, 'webkitRelativePath', { value: `${'d'.repeat(200)}/${'e'.repeat(200)}/${'f'.repeat(200)}/${'g'.repeat(200)}/${'h'.repeat(200)}/${'i'.repeat(100)}/a.txt` });
    expect(fromInput([long], '').skipped).toBe(1);
  });
});
