// Agent attachments through the real Agent window on the staging test desk, as the e2e test account (desk-1).
// Run after the gate, never beside it:  npx playwright test -c release-1110 attach-ui.spec.ts
// No key is held: if the agent has none, the window shows the key setup and no composer, and this spec says so.
// Only method names, chunk counts and sizes are logged; no file name or content.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loadUser, onDesk, signInApp, watch, focusTestDesk } from '../tests/lib';

const note = (k: string, v: unknown) => console.log(`[attach-ui] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

function pdf(): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 20 50 Td (release check) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

test('attach, send with no key, remove, leave the thread', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const tag = randomBytes(4).toString('hex');
  const work = mkdtempSync(join(tmpdir(), 'rel1110a-'));
  const txtName = `rel1110-${tag}.txt`;
  const pdfName = `rel1110-${tag}.pdf`;
  const marker = `ATTACHMARK${tag}`;
  const txt = Buffer.concat([Buffer.from(`${marker}\n`), Buffer.alloc(Math.floor(1.2 * 1048576) - marker.length - 1, 0x61)]);
  writeFileSync(join(work, txtName), txt);
  writeFileSync(join(work, pdfName), pdf());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const log: { m: string; n: number }[] = [];
    (window as unknown as Record<string, unknown>).__rpcLog = log;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (d: string | Blob | ArrayBuffer | ArrayBufferView) {
      try {
        const head = typeof d === 'string' ? d.slice(0, 400) : d instanceof ArrayBuffer ? new TextDecoder().decode(d.slice(0, 400)) : ArrayBuffer.isView(d) ? new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset, Math.min(400, d.byteLength))) : '';
        const m = /agent\.attach\.[a-z.]+/.exec(head);
        if (m) log.push({ m: m[0], n: typeof d === 'string' ? d.length : (d as ArrayBuffer).byteLength ?? (d as Blob).size });
      } catch { /* logging only */ }
      return (send as (x: unknown) => void).call(this, d);
    } as typeof send;
  });
  const page = await context.newPage();
  const w = watch(page);
  try {
    await signInApp(context, page, loadUser('desk-1'));
    await focusTestDesk(page, w);
    const tile = page.getByRole('group', { name: /^test-desk/ }).getByRole('button', { name: /^Agent/ });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.getByRole('dialog', { name: /Agent/ });
    await expect(win).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.ag-agent-name').first()).toBeAttached({ timeout: 60_000 });
    await page.waitForTimeout(4000);
    note('window text', (await win.innerText()).replace(/\s+/g, ' ').slice(0, 260));
    const composer = win.getByTestId('composer');
    note('composer present', await composer.count());
    const btn = win.getByTestId('attach-button');
    note('attach button count', await btn.count());
    await page.screenshot({ path: join(work, 'agent.png') });
    if ((await btn.count()) === 0) { note('stopped', 'no attach button: the agent has no key, so the window shows its key setup'); return; }
    await expect(btn).toBeVisible();
    await win.getByTestId('attach-input').setInputFiles([join(work, txtName), join(work, pdfName)]);
    const chips = win.getByTestId('staged-file');
    await expect(chips).toHaveCount(2, { timeout: 30_000 });
    await expect(win.locator('[data-testid="staged-file"][data-state="ready"]')).toHaveCount(2, { timeout: 120_000 });
    const chipText = (await chips.allInnerTexts()).map((t) => t.replace(txtName, 'TXT').replace(pdfName, 'PDF').replace(/\s+/g, ' '));
    note('chips', chipText);
    const log1 = await page.evaluate(() => (window as unknown as { __rpcLog: { m: string; n: number }[] }).__rpcLog.slice());
    note('rpc after attach', log1);
    await win.getByTestId('composer-input').fill('What is in these files?');
    await win.getByTestId('composer-send').click();
    await page.waitForTimeout(5000);
    const after = (await win.innerText()).replace(/\s+/g, ' ');
    note('after send, window text tail', after.slice(-400).replace(new RegExp(txtName, 'g'), 'TXT').replace(new RegExp(pdfName, 'g'), 'PDF'));
    note('chips after send', await chips.count());
    if ((await chips.count()) === 2) {
      await win.getByRole('button', { name: `Remove ${txtName}` }).click();
      await expect(chips).toHaveCount(1);
      await page.waitForTimeout(1500);
      note('chips after remove', await chips.count());
    }
    const log2 = await page.evaluate(() => (window as unknown as { __rpcLog: { m: string; n: number }[] }).__rpcLog.slice());
    note('rpc after remove', log2.map((e) => e.m).reduce<Record<string, number>>((a, m) => ({ ...a, [m]: (a[m] ?? 0) + 1 }), {}));
    // leave the thread: close the panel, then close the window
    await page.getByRole('button', { name: /^Close Agent/ }).first().click();
    await page.waitForTimeout(2000);
    const log3 = await page.evaluate(() => (window as unknown as { __rpcLog: { m: string; n: number }[] }).__rpcLog.slice());
    note('rpc after leaving', log3.map((e) => e.m).reduce<Record<string, number>>((a, m) => ({ ...a, [m]: (a[m] ?? 0) + 1 }), {}));
    const j = await onDesk(`echo "TXT=$(journalctl --since -15min --no-pager | grep -c '${tag}')"; echo "MARK=$(journalctl --since -15min --no-pager | grep -c '${marker}')"`);
    note('journals (whole, 15 min)', j.replace(/\n/g, ' '));
    note('console errors', w.errors);
  } finally {
    await context.close();
    rmSync(work, { recursive: true, force: true });
  }
});
