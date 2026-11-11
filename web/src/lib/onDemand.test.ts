import { describe, expect, it, vi } from 'vitest';
import { onDemand } from './onDemand';

describe('onDemand', () => {
  it('is null until loaded, then the module, fetched once however often it is asked', async () => {
    const importer = vi.fn(async () => ({ part: 'here' }));
    const chunk = onDemand(importer);
    expect(chunk.get()).toBeNull();
    chunk.prefetch();
    const [a, b] = await Promise.all([chunk.load(), chunk.load()]);
    expect(a).toBe(b);
    expect(chunk.get()).toEqual({ part: 'here' });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('forgets a failure, so the next ask tries again', async () => {
    let fail = true;
    const importer = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return { part: 'here' };
    });
    const chunk = onDemand(importer);
    chunk.prefetch(); // a failed prefetch says nothing
    await expect(chunk.load()).rejects.toThrow('offline');
    expect(chunk.get()).toBeNull();
    fail = false;
    await expect(chunk.load()).resolves.toEqual({ part: 'here' });
    expect(chunk.get()).toEqual({ part: 'here' });
  });
});
