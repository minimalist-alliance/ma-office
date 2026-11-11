// The import-free way the desk link, the Browser and Files say a step was used.
import { describe, expect, it } from 'vitest';
import type { DeskLink } from '../desk/deskLink';
import { agentsSeen, onStepUsed, stepUsed, watchUploads } from './used';

describe('steps used elsewhere in the office', () => {
  it('what’s said before the circle listens is kept for it, and only statuses decide the Agent step', () => {
    stepUsed('browser');
    agentsSeen('d-1', [{ status: 'no_key', binding: null }]);
    agentsSeen('d-1', [{ status: 'error', binding: { keyId: 'k', provider: 'p', providerName: 'P', model: 'm' } }]);
    agentsSeen('d-2', [{ status: 'online', binding: { keyId: 'k', provider: 'p', providerName: 'P', model: 'm' } }]);
    const heard: [string, string | undefined][] = [];
    const off = onStepUsed((id, deskId) => heard.push([id, deskId]));
    expect(heard).toEqual([
      ['browser', undefined],
      ['agent-key', 'd-2'],
    ]);
    stepUsed('files', 'd-1');
    expect(heard.at(-1)).toEqual(['files', 'd-1']);
    off();
  });

  it('a finished upload on the link is the Files step, and nothing else the link does is', async () => {
    const heard: [string, string | undefined][] = [];
    const off = onStepUsed((id, deskId) => heard.push([id, deskId]));
    const answers: Record<string, () => Promise<unknown>> = {
      'files.upload.begin': () => Promise.resolve({ uploadId: 'u' }),
      'files.upload.finish': () => Promise.resolve({ path: '/x', size: 1 }),
      'files.list': () => Promise.resolve([]),
    };
    let fail = false;
    const link = {
      deskId: 'd-9',
      call: (m: string) => (fail ? Promise.reject(new Error('no')) : answers[m]!()),
    } as unknown as DeskLink;
    watchUploads(link);
    await link.call('files.upload.begin', {});
    await link.call('files.list' as never, {});
    expect(heard).toEqual([]);
    await expect(link.call('files.upload.finish', {})).resolves.toEqual({ path: '/x', size: 1 });
    await Promise.resolve();
    expect(heard).toEqual([['files', 'd-9']]);
    fail = true;
    await expect(link.call('files.upload.finish', {})).rejects.toThrow('no');
    await Promise.resolve();
    expect(heard).toHaveLength(1);
    off();
  });
});
