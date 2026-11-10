/* The desk's ad and tracker blocker (ADR 0076). Network blocking only: the rules are uBlock Origin Lite's default lists,
 * with only their block and allow rules kept (build-blocker.py), and this worker does one thing, keep the member's
 * per-site off list and the kill switch, both Chromium policy (managed storage), in effect. No host permissions and no
 * scripting: it can't touch a page, a cookie, storage or a header. */
'use strict';
const ALLOW_RULE = 1;  // and 2
const MAX_SITES = 1000;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const dnr = chrome.declarativeNetRequest;

async function apply() {
  let m = {};
  try { m = await chrome.storage.managed.get(null); } catch (e) { m = {}; }
  const given = Array.isArray(m.noFiltering) ? m.noFiltering : [];
  const sites = [...new Set(given.filter(s => typeof s === 'string' && HOST.test(s) && !/\.\d+$/.test(s)))].slice(0, MAX_SITES);
  const off = m.off === true;
  const all = chrome.runtime.getManifest().declarative_net_request.rule_resources.map(r => r.id);
  const enabled = await dnr.getEnabledRulesets();
  if (off && enabled.length) await dnr.updateEnabledRulesets({ disableRulesetIds: enabled });
  if (!off) {
    const missing = all.filter(id => !enabled.includes(id));
    if (missing.length) await dnr.updateEnabledRulesets({ enableRulesetIds: missing });
  }
  const old = await dnr.getDynamicRules();
  // A site off: everything its pages ask for, and the page itself. "allow", not "allowAllRequests", which would need host
  // permissions this has none of: so a frame from elsewhere inside the page still has its own requests filtered.
  const addRules = sites.length ? [
    { id: ALLOW_RULE, priority: 1000000, action: { type: 'allow' }, condition: { initiatorDomains: sites } },
    { id: ALLOW_RULE + 1, priority: 1000000, action: { type: 'allow' }, condition: { requestDomains: sites, resourceTypes: ['main_frame', 'sub_frame'] } },
  ] : [];
  await dnr.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules });
  await chrome.storage.local.set({ applied: { sites, off, at: Date.now() } });
}

// One at a time, in order: a change that lands while one runs is applied after it.
let queue = Promise.resolve();
function sync() { queue = queue.then(apply, apply).catch(() => {}); return queue; }

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
// Chromium fills managed storage from policy, at a start too, and says so here: so a list changed while Chromium was
// down, or read before Chromium had loaded the policy, still lands.
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'managed') sync(); });
sync();
