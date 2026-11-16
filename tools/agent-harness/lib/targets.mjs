// Choosing a target: the local rig (its HTTP API on 127.0.0.1) or a real test desk through helper N2's desk driver.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalDriver } from './driver-local.mjs';
import { HARNESS } from './tasks.mjs';

export const DESK_DRIVER = resolve(HARNESS, '../../web/tests/real-desk/agent-tools/driver-desk.mjs');
/** The capped staging key's parameter name. A desk run refuses to start without it. */
export const KEY_PARAM_ENV = 'MA_AGENT_TEST_KEY_PARAM';

export class TargetError extends Error {}

/**
 * The driver for a target. local: needs `rig`. desk: needs `model` 'real' and MA_AGENT_TEST_KEY_PARAM, and loads the
 * desk driver module, which exports createDriver(options) (or a default export that is a function or a class).
 */
export async function makeDriver({ target, rig, model, env = process.env, deskDriverPath = DESK_DRIVER, pollMs } = {}) {
  if (target === 'local') {
    if (!rig || typeof rig !== 'string') throw new TargetError('--target local needs --rig http://127.0.0.1:<port> (tools/agent-harness/rig.sh prints it)');
    try {
      return new LocalDriver({ rig, pollMs });
    } catch (e) {
      throw new TargetError(e.message);
    }
  }
  if (target === 'desk') {
    if (model !== 'real') throw new TargetError('--target desk needs --model real: a desk runs a real model, never the stand-in');
    const keyParam = env[KEY_PARAM_ENV];
    if (!keyParam) {
      throw new TargetError(`--target desk refuses to run without ${KEY_PARAM_ENV} (the capped staging key's parameter). Real models wait for that key.`);
    }
    if (!existsSync(deskDriverPath)) throw new TargetError(`the desk driver isn't there yet: ${deskDriverPath}`);
    let mod;
    try {
      mod = await import(pathToFileURL(deskDriverPath).href);
    } catch (e) {
      throw new TargetError(`the desk driver failed to load: ${e?.message ?? e}`);
    }
    const make = mod.createDriver ?? mod.default;
    if (typeof make !== 'function') throw new TargetError('the desk driver exports no createDriver(options) or default');
    const options = { model, keyParam, env };
    let driver;
    try {
      driver = await make(options);
    } catch (e) {
      if (e instanceof TypeError && /class constructor/i.test(String(e.message))) driver = new make(options);
      else throw e;
    }
    if (!driver || typeof driver.send !== 'function') throw new TargetError("the desk driver's createDriver didn't give a driver");
    return driver;
  }
  throw new TargetError('--target is local or desk');
}
