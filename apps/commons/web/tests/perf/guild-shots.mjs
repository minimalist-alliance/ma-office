// Screenshots of a guild's Commons for the guild demo: an engineering team's working session, with channels, voice,
// chat and a board, in Light, Dusk and Dark. Writes to $SHOTS (default media/shots/guild/), not committed.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { circle, launch, member, startServer, stroke, tool, color, hover } from './harness.mjs';

const out = resolve(process.env.SHOTS ?? resolve(import.meta.dirname, '../../media/shots/guild'));
mkdirSync(out, { recursive: true });
const W = 1600;
const H = 1000;
const guild = encodeURIComponent('Northwind Platform');
const server = await startServer(['-max-channels', '10']);
const browser = await launch();
const q = (s) => `&guild=${guild}&frame=0&${s}`;
try {
  const maya = await member(browser, 'Maya Chen', { width: W, height: H, dpr: 2, query: q('role=lead&badge=lead') });
  const jordan = await member(browser, 'Jordan Ellis', { query: q('role=officer&badge=officer&grants=moderate,manage_spaces') });
  const priya = await member(browser, 'Priya Raman', { query: q('role=officer&badge=officer&grants=moderate') });
  const sam = await member(browser, 'Sam Okafor', { query: q('role=member') });
  const lena = await member(browser, 'Lena Fischer', { query: q('role=member&badge=officer') });
  const diego = await member(browser, 'Diego Alvarez', { query: q('role=member') });
  const tom = await member(browser, 'Tom Becker', { query: q('role=member') });
  const ev = (m, f, arg) => m.page.evaluate(f, arg);
  const client = (m) => ev(m, () => window.commons.client.state);

  // Channels: the Founder renames Main and makes the team's channels.
  await ev(maya, () => window.commons.client.renameChannel('main', 'General'));
  for (const name of ['Upload v2', 'Design review', 'Release 4.2', 'On-call']) {
    await ev(maya, (n) => window.commons.client.createChannel(n), name);
    await maya.page.waitForTimeout(150);
  }
  await maya.page.waitForTimeout(300);
  const chans = Object.fromEntries((await client(maya)).channels.map((c) => [c.name, c.id]));
  const go = async (m, name) => {
    await ev(m, (id) => window.commons.client.openChannel(id), chans[name]);
    await m.page.waitForFunction((id) => window.commons.client.state.ch === id, chans[name]);
  };
  const joinVoice = async (m, muted = false) => {
    await m.page.locator('.ma-cm-btn-join').click();
    await m.page.locator('.ma-cm-btn-leave').waitFor();
    if (muted) await ev(m, () => window.commons.client.setMuted(true));
  };
  const say = async (m, name, text) => {
    await ev(m, ([id, t]) => window.commons.client.say(t, id), [chans[name], text]);
    await m.page.waitForTimeout(120);
  };

  // Who's where: four in Upload v2's voice, two in Design review, one looking in at General.
  for (const m of [maya, jordan, priya, sam]) await go(m, 'Upload v2');
  for (const m of [lena, diego]) await go(m, 'Design review');
  await go(tom, 'General');

  // Chat: earlier talk in General and Release 4.2, then the working thread in Upload v2.
  await say(tom, 'General', 'Morning all. Reminder: platform sync moves to 2:30 today.');
  await say(lena, 'General', 'Thanks Tom. Design review is in its channel if anyone wants to drop in.');
  await say(diego, 'Release 4.2', 'Release notes draft is up for review: https://docs.example.com/northwind/release-4-2');
  await say(jordan, 'Upload v2', 'Canary is green at 5%. p95 upload latency is 410 ms, same as v1.');
  await say(priya, 'Upload v2', 'Retry with backoff is merged: https://git.example.com/northwind/upload/pull/482');
  await say(sam, 'Upload v2', 'I’ll take the dashboards: error rate by client version, and resumes per upload.');
  await say(maya, 'Upload v2', 'Great. Let’s hold 25% until the dashboards are up, then go Wednesday morning.');
  await say(jordan, 'Upload v2', 'Works for me. The rollout steps are on the board.');
  await say(priya, 'Upload v2', 'One catch: the old SDK never sends Content-Range, so those clients can’t resume. Fine for now, but it belongs in the deprecation email.');
  await say(maya, 'Upload v2', 'Added to Later on the board. Thanks Priya.');

  // Voice.
  await joinVoice(maya);
  await joinVoice(jordan, true);
  await joinVoice(priya);
  await joinVoice(sam);
  await joinVoice(lena);
  await joinVoice(diego, true);

  // The board: a rollout plan, with an architecture sketch drawn by hand beside it.
  await ev(maya, () => window.commons.client.rename(window.commons.client.state.active, 'Rollout plan'));
  const z = 1;
  await ev(jordan, (items) => window.commons.put(items), [
    { k: 't', x: 0, y: -40, w: 0, h: 0, c: 'ink', s: 2, z: z, tx: 'Upload service v2: rollout' },
    { k: 't', x: 0, y: 40, w: 0, h: 0, c: 'green', s: 1, z: z, tx: 'Now' },
    { k: 't', x: 240, y: 40, w: 0, h: 0, c: 'blue', s: 1, z: z, tx: 'Next' },
    { k: 't', x: 480, y: 40, w: 0, h: 0, c: 'violet', s: 1, z: z, tx: 'Later' },
    { k: 'n', x: 0, y: 90, w: 200, h: 200, c: 'green', s: 1, z: z + 1, tx: 'Resumable uploads behind the upload_v2 flag' },
    { k: 'n', x: 0, y: 310, w: 200, h: 200, c: 'green', s: 1, z: z + 2, tx: 'Retry with backoff on 5xx (PR 482, merged)' },
    { k: 'n', x: 240, y: 90, w: 200, h: 200, c: 'blue', s: 1, z: z + 3, tx: 'Canary: 5% now, 25% Wed 9:00, 100% Thu' },
    { k: 'n', x: 240, y: 310, w: 200, h: 200, c: 'amber', s: 1, z: z + 4, tx: 'Dashboards: p95 latency, error rate by client, resumes (Sam)' },
    { k: 'n', x: 480, y: 90, w: 200, h: 200, c: 'violet', s: 1, z: z + 5, tx: 'Retire the v1 endpoint 30 days after 100%' },
    { k: 'n', x: 480, y: 310, w: 200, h: 200, c: 'red', s: 1, z: z + 6, tx: 'Old SDK sends no Content-Range: say so in the deprecation email' },
    { k: 't', x: 760, y: 40, w: 0, h: 0, c: 'ink', s: 1, z: z, tx: 'Request path' },
    { k: 'r', x: 760, y: 100, w: 170, h: 70, c: 'ink', s: 1, z: z },
    { k: 't', x: 800, y: 122, w: 0, h: 0, c: 'ink', s: 1, z: z + 1, tx: 'Client' },
    { k: 'a', x: 845, y: 175, w: 0, h: 70, c: 'ink', s: 1, z: z },
    { k: 'r', x: 760, y: 250, w: 170, h: 70, c: 'blue', s: 1, z: z },
    { k: 't', x: 790, y: 272, w: 0, h: 0, c: 'blue', s: 1, z: z + 1, tx: 'Upload API' },
    { k: 'a', x: 845, y: 325, w: 0, h: 70, c: 'ink', s: 1, z: z },
    { k: 'e', x: 760, y: 400, w: 170, h: 80, c: 'green', s: 1, z: z },
    { k: 't', x: 783, y: 427, w: 0, h: 0, c: 'green', s: 1, z: z + 1, tx: 'Object store' },
    { k: 'a', x: 935, y: 285, w: 90, h: 0, c: 'amber', s: 1, z: z },
    { k: 't', x: 1035, y: 271, w: 0, h: 0, c: 'amber', s: 1, z: z, tx: 'retry, 3x' },
  ]);
  await maya.page.waitForTimeout(400);
  await ev(maya, () => window.commons.engine.fit(false));
  await maya.page.waitForTimeout(300);
  // Priya circles the catch in red, by hand, on her own view of the board.
  await ev(priya, () => window.commons.engine.fit(false));
  await priya.page.waitForTimeout(200);
  await priya.page.locator('.ma-cm-board').focus();
  await tool(priya, 'p');
  await color(priya, 'Red');
  await tool(priya, 'p');
  // Board point (580, 410), the catch's note, on Priya's screen.
  const at = await ev(priya, () => ({ ...window.commons.engine.toScreen(580, 410), z: window.commons.engine.cam.z }));
  await stroke(priya, circle(at.x, at.y, 128 * at.z, 30).map(([x, y], i) => [x + Math.sin(i) * 2, y]), 2);

  // Everyone where they should be, as Maya sees it: six in voice, Tom looking in.
  await maya.page.waitForFunction(() => {
    const s = window.commons.client.state;
    return s.members.length === 7 && s.members.filter((m) => m.in).length === 6;
  });
  console.log(`items on the board: ${await ev(maya, () => window.commons.engine.itemCount)}`);
  for (const m of [jordan, sam]) await ev(m, () => window.commons.engine.fit(false));
  // Jordan, Sam and Priya point at the board, in its clear spaces, just before each picture.
  const point = async (i) => {
    for (const [m, bx, by] of [[jordan, 1010, -30], [sam, 140, 560], [priya, 650, 560]]) {
      const s = await ev(m, ([x, y]) => window.commons.engine.toScreen(x, y), [bx + i * 4, by + i * 3]);
      await hover(m, s.x, s.y, 4);
    }
  };

  for (const theme of ['light', 'dusk', 'dark']) {
    await ev(maya, (t) => document.documentElement.setAttribute('data-theme', t), theme);
    await tool(maya, 'v');
    await maya.page.mouse.move(W - 250, 26);
    await maya.page.waitForTimeout(500);
    await point(['light', 'dusk', 'dark'].indexOf(theme));
    await maya.page.waitForTimeout(250);
    await maya.page.screenshot({ path: `${out}/commons-guild-${theme}.png` });
  }
  // The settings, as the Founder sees them.
  await ev(maya, () => document.documentElement.setAttribute('data-theme', 'light'));
  await maya.page.getByRole('button', { name: 'Commons settings' }).click();
  await maya.page.waitForTimeout(300);
  await maya.page.screenshot({ path: `${out}/commons-settings-light.png` });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  await server.stop();
}
