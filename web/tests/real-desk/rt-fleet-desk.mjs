// The fleet desk's housekeeping around the real-model proofs, through the Agent window's own UI and nothing else: read Lead's
// keys (last 4 and `available`, read only: nothing is ever typed in Keys), its Usage numbers and limit fields; raise limits
// for the proofs and put them back exactly as they were; remove the Harness world; close the Agent window.
//
//   flock -w 120 ~/work/.desk-d-teste5h2wnkq.lock env FLEET_DESK_LOCK=held MA_ENV=staging \
//     ~/.local/node-v24/bin/node tests/real-desk/rt-fleet-desk.mjs --read
//   ... rt-fleet-desk.mjs --raise agentDay=25,deskDay=25     (keeps the fields as found in real-model/limits-before.json first)
//   ... rt-fleet-desk.mjs --restore                          (types back every field it changed, then reads them again)
//   ... rt-fleet-desk.mjs --cleanup                          (Harness emptied to the trashes, the folder too; the window closed)
//
// The rules: only FLEET_DESK (d-teste5h2wnkq) of FLEET_ACCOUNT (fleet-officer), in staging's office; never a key typed, added,
// deleted or rotated; never an agent made or removed. Results go to MA_REAL_MODEL_OUT (~/work/maia-mode/harness/real-model).
import { argsOf } from './agent-tools/pure.mjs';
import { RESULTS, lockProblems, readJson, spendLedger, startFleet, writeJson } from './agent-tools/fleet-run.mjs';
import { ALLOWED } from './agent-tools/fleet.mjs';

const args = argsOf(process.argv.slice(2));
const problems = [...lockProblems(process.env, ALLOWED), ...((process.env.MA_ENV ?? '') === 'staging' ? [] : ['MA_ENV=staging only'])];
if (problems.length) {
  for (const p of problems) console.error(`REFUSED: ${p}`);
  process.exit(2);
}
const BEFORE = `${RESULTS}/limits-before.json`;
const SHOTS = `${RESULTS}/shots/desk`;
const { lib, driver, lead } = await startFleet({ out: SHOTS });
const report = readJson(`${RESULTS}/desk.json`, { events: [] });
const note = (what, data) => {
  report.events.push({ at: new Date().toISOString(), what, ...data });
  writeJson(`${RESULTS}/desk.json`, report);
};
let code = 0;
try {
  const keys = await driver.keys();
  const leadKey = keys?.keys?.find((k) => k.keyId === lead.keyId) ?? null;
  lib.log(`keys: ${(keys?.keys ?? []).map((k) => `${k.provider} ····${k.last4}${k.available === false ? ' (unavailable)' : ' (available)'}`).join(', ')}; Lead uses ····${leadKey?.last4 ?? '?'} on ${lead.model}`);
  note('keys', { keys: keys?.keys?.map((k) => ({ provider: k.provider, last4: k.last4, available: k.available, lead: k.keyId === lead.keyId })), leadModel: lead.model, setupSaved: Boolean(lead.setupSaved) });
  // The stored key's last 4, from the run's environment (not committed: the repo is mirrored public).
  const wantLast4 = process.env.FLEET_KEY_LAST4 ?? '';
  if (!wantLast4 || leadKey?.last4 !== wantLast4 || leadKey?.available === false) {
    lib.log('STOP: Lead’s key is not the one FLEET_KEY_LAST4 names, or not available');
    code = 3;
  }
  const usage = await driver.usage(lead.id);
  spendLedger().panel(args.raise ? 'before raise' : args.restore ? 'before restore' : args.cleanup ? 'at cleanup' : 'read', usage);
  lib.log(`usage: ${(usage?.usage ?? []).map((u) => `${u.scope} $${((u.spentMicroUsd ?? 0) / 1e6).toFixed(4)}`).join(', ')}; prices as of ${usage?.pricesAsOf}`);
  const fields = await driver.limitFields(lead.id);
  lib.log(`limit fields: ${JSON.stringify(fields)}`);
  note('limits', { policy: usage?.policy, usage: usage?.usage, fields });
  await driver.shot('usage');

  if (typeof args.raise === 'string') {
    const want = Object.fromEntries(args.raise.split(',').map((kv) => kv.split('=')));
    const before = readJson(BEFORE, null);
    if (!before) writeJson(BEFORE, { at: new Date().toISOString(), fields, policy: usage?.policy });
    else lib.log(`keeping the first record of the fields (${before.at})`);
    await driver.setLimits(lead.id, want);
    const after = await driver.limitFields(lead.id);
    lib.log(`raised: ${JSON.stringify(want)}; the fields now ${JSON.stringify(after)}`);
    note('raise', { want, after, policy: (await driver.usage(lead.id))?.policy });
  }
  if (args.restore) {
    const before = readJson(BEFORE, null);
    if (!before) throw new Error('no limits-before.json: nothing to put back');
    const now = await driver.limitFields(lead.id);
    const changed = Object.fromEntries(Object.entries(before.fields).filter(([k, v]) => now[k] !== v));
    if (Object.keys(changed).length) await driver.setLimits(lead.id, changed);
    const after = await driver.limitFields(lead.id);
    const same = Object.entries(before.fields).every(([k, v]) => after[k] === v);
    const policyAfter = (await driver.usage(lead.id))?.policy;
    lib.log(`restored ${JSON.stringify(changed)}; fields as before: ${same}`);
    note('restore', { changed, after, same, policyBefore: before.policy, policyAfter, policySame: JSON.stringify(before.policy) === JSON.stringify(policyAfter) });
    if (!same) code = 4;
  }
  if (args.cleanup) {
    await driver.reset({});
    const r = await driver.page().evaluate(() => window.__rtTools.call('files.delete', { paths: ['Harness'] }));
    lib.log(`Harness emptied; the folder to the trash: ${r.ok ? 'yes' : r.code}`);
    const t = await driver.page().evaluate(() => window.__rtTools.harnessTree());
    note('cleanup', { folderTrashed: r.ok, code: r.ok ? null : r.code, harnessTabs: t.tabs?.length ?? null, livePages: (t.pages ?? []).filter((x) => !x.deletedAt).length });
  }
  const closed = await driver.closeWindow();
  lib.log(`Agent window closed: ${closed}`);
  note('closed', { windowClosed: closed });
} catch (e) {
  lib.log(`FAILED: ${e.message}`);
  await driver.shot('error').catch(() => {});
  code = 1;
}
await lib.shutdown(code, 'done');
