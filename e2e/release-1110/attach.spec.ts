// Release checks for the Agent app's file attachments (S-118b) on the staging test desk, over an RPC session as the e2e test account.
// Run after the gate and never beside it:  npx playwright test -c release-1110 attach.spec.ts
// No key is held, so a real-provider answer is not tested here. No file name or content is printed to the log.
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, apiToken, loadUser, onDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[release] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

test.describe('agent attachments over an RPC session', () => {
  let context: BrowserContext;
  let page: Page;
  let client: DeskClient;
  let agentId = '';
  const tag = randomBytes(4).toString('hex');
  const fileName = `attach-name-${tag}.txt`;
  const marker = `ATTACHBODY${tag}`;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    const bearer = await apiToken(context, loadUser('desk-1'));
    page = await context.newPage();
    await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
    await page.goto(`${APP}${FIXTURE_PATH}`);
    client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
    await client.init();
    let opened: OpenResult = { ok: false };
    for (let i = 0; i < 8 && !opened.ok; i++) {
      opened = await client.open(false);
      if (!opened.ok) await sleep(5000);
    }
    if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
    const list = await client.rpc<{ agents: { id: string; name: string }[] }>('agent.list');
    agentId = list.agents[0].id;
  });
  test.afterAll(async () => {
    await client?.finish().catch(() => {});
    await context?.close();
  });

  const put = (uploadId: string, name: string, size: number, index: number, bytes: Buffer) =>
    client.rpcTry('agent.attach.put', { agentId, uploadId, name, size, index, data: bytes.toString('base64') }, { idem: true });

  test('agent.attach.caps answers', async () => {
    const caps = await client.rpc<{ caps: Record<string, number>; ceiling: unknown; chunkBytes: number; vision?: boolean }>('agent.attach.caps', { agentId });
    note('agent.attach.caps', { caps: caps.caps, chunkBytes: caps.chunkBytes, vision: caps.vision });
    expect(caps.chunkBytes).toBe(512 * 1024);
    expect(caps.caps.maxFiles).toBe(5);
  });

  test('a text file is put in chunks and removed', async () => {
    // This test channel's data channel limits a message, so chunks here are 8 KiB (the desk accepts up to 512 KiB).
    const chunk = 8 * 1024;
    const body = Buffer.concat([Buffer.from(`${marker}\n`), Buffer.alloc(chunk * 2 + 1000 - marker.length - 1, 0x61)]);
    const uploadId = `up-${tag}-1`;
    const sizes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await put(uploadId, fileName, body.length, i, body.subarray(i * chunk, Math.min(body.length, (i + 1) * chunk)));
      expect(r.ok, JSON.stringify(r.details)).toBe(true);
      sizes.push({ index: i, received: (r as never as { received?: number }).received ?? (r.result as never as { received?: number } | undefined)?.received, complete: (r.result as never as { complete?: boolean } | undefined)?.complete });
    }
    note('chunks', sizes);
    expect((sizes[2] as { complete?: boolean }).complete).toBe(true);
    await client.rpc('agent.attach.remove', { agentId, uploadId }, { idem: true });
    // Gone: the next chunk of that upload has nothing to follow.
    const after = await put(uploadId, fileName, body.length, 1, body.subarray(chunk, 2 * chunk));
    note('chunk after remove', { ok: after.ok, code: after.code, details: after.details });
    expect(after.ok).toBe(false);
  });

  test('a file over the cap is refused on its first chunk', async () => {
    const r = await put(`up-${tag}-2`, `big-${tag}.txt`, 9 * 1024 * 1024, 0, Buffer.alloc(8 * 1024, 0x61));
    note('over-cap first chunk', { ok: r.ok, code: r.code, details: r.details });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('too_large');
  });

  test('a send with an attachment and no key gets no_key', async () => {
    // This test channel's data channel limits a message, so chunks here are 8 KiB (the desk accepts up to 512 KiB).
    const chunk = 8 * 1024;
    const uploadId = `up-${tag}-3`;
    const size = chunk + 10;
    const first = await put(uploadId, fileName, size, 0, Buffer.alloc(chunk, 0x62));
    expect(first.ok, JSON.stringify(first.details)).toBe(true);
    const sent = await client.rpcTry('agent.message.send', { agentId, text: 'check', attachments: [uploadId] }, { idem: true });
    note('send with no key', { ok: sent.ok, code: sent.code, details: sent.details });
    expect(sent.ok).toBe(false);
    expect(JSON.stringify(sent.details)).toContain('no_key');
    // Is the staged half still there? The next chunk completes it if so.
    const next = await put(uploadId, fileName, size, 1, Buffer.alloc(10, 0x62));
    note('staged file after no_key (ok=still staged)', { ok: next.ok, code: next.code, details: next.details });
    await client.rpcTry('agent.attach.remove', { agentId, uploadId }, { idem: true });
  });

  test('the journals carry no file name or content', async () => {
    const out = await onDesk(
      `for pat in '${fileName}' '${marker}' 'attach-name-${tag}'; do ` +
      `echo "PAT=$pat deskd=$(journalctl -t deskd --since -20min --no-pager | grep -c "$pat") all=$(journalctl --since -20min --no-pager | grep -c "$pat")"; done; ` +
      `echo "AGENTJ=$(journalctl --since -20min --no-pager | grep -ci 'desk-agent' )"`);
    note('journals', out.replace(/\n/g, ' | ').replace(new RegExp(fileName, 'g'), '<name>').replace(new RegExp(marker, 'g'), '<marker>'));
    expect(out).toMatch(/deskd=0 all=0/);
    expect(out).not.toMatch(/all=[1-9]/);
  });
});
