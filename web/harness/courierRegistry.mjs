// Courier's address registry, as ma-platform's `services/courier` answers the member routes (contract relay.md 0.4.0 §4):
// GET /v1/me/courier, GET /v1/me/courier/names/{name}, PUT /v1/me/courier/desks/{deskId}/address. serve.mjs calls this for
// every signed-in call, and it answers only `/v1/me/courier…`.
//
// Steered through POST /__harness, as `courier`. Null (the default and after a reset): Courier paused, as prod answers while its
// kill switch is on (`enabled: false, reason: paused`), so the office shows no address card. `courier.absent` answers 404.
//   courier.enabled   false with courier.reason (`paused`, `courier_teen`); the other routes then answer 503 courier_paused
//   courier.domain    the Courier domain (default courier.example)
//   courier.desks     [{ deskId, name, kind, address: null | { address, name, createdAt }, closed?, keysSet?, pending? }]
//   courier.taken     names someone else has (the registry's own, plus every name ever given)
//   courier.failPut   true: the PUT answers 503
//   courierPuts       read back: every PUT's { deskId, body }, in order
const RESERVED = new Set(['postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security', 'info', 'support', 'marketing', 'sales', 'admin', 'administrator', 'root', 'mailer-daemon', 'no-reply', 'noreply', 'courier', 'ma', 'minimalist', 'alliance', 'owner', 'staff', 'team', 'official', 'help', 'billing', 'legal', 'privacy', 'system', 'maia', 'office', 'desk', 'guild', 'forums']);
const skeleton = (n) => n.toLowerCase().replace(/[.-]/g, '').replace(/0/g, 'o').replace(/1/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w');
const shape = (n) => /^[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){2,31}$/.test(n) && /[a-z]/.test(n);

function verdict(c, name, deskId) {
  const n = name.toLowerCase();
  if (!shape(n)) return 'invalid';
  if (RESERVED.has(n) || /minimalist|alliance|courier/.test(skeleton(n))) return 'reserved';
  const taken = [...(c.taken ?? []), ...(c.desks ?? []).flatMap((d) => [d.address?.name, ...(d.closed ?? []).map((x) => x.address.split('@')[0])])].filter(Boolean);
  const mine = (c.desks ?? []).filter((d) => d.deskId !== deskId && d.address).map((d) => d.address.name);
  if (taken.some((t) => skeleton(t) === skeleton(n))) return 'taken';
  // The registry refuses a stem shared with another of the member's desks (§1); the office's own note only explains it.
  const parts = (x) => x.split(/[.-]/).filter((p) => p.length >= 3);
  if (mine.some((m) => skeleton(m).length >= 3 && (skeleton(n).includes(skeleton(m)) || skeleton(m).includes(skeleton(n)) || parts(m).some((p) => parts(n).includes(p))))) return 'shares_stem';
  return null;
}

export async function courierRegistry(req, res, path, state, { json, readBody, envelope }) {
  if (!path.startsWith('/v1/me/courier')) return false;
  const c = state.courier ?? { enabled: false, reason: 'paused' };
  if (c.absent) {
    json(res, 404, envelope('not_found', 'Not found.'));
    return true;
  }
  const domain = c.domain ?? 'courier.example';
  if (c.enabled === false && path !== '/v1/me/courier') return json(res, 503, envelope('courier_paused', 'Courier is paused.', true)), true;
  if (path === '/v1/me/courier' && req.method === 'GET') {
    if (c.enabled === false) return json(res, 200, { enabled: false, domain, reason: c.reason ?? 'paused', desks: [] }), true;
    json(res, 200, { enabled: true, domain, desks: (c.desks ?? []).map((d) => ({ closed: [], keysSet: true, pending: 0, ...d })) });
    return true;
  }
  const nameRoute = /^\/v1\/me\/courier\/names\/([^/]+)$/.exec(path);
  if (nameRoute && req.method === 'GET') {
    const name = decodeURIComponent(nameRoute[1]).toLowerCase();
    const why = verdict(c, name, null);
    json(res, 200, why ? { name, available: false, reason: why } : { name, available: true });
    return true;
  }
  const put = /^\/v1\/me\/courier\/desks\/([^/]+)\/address$/.exec(path);
  if (put && req.method === 'PUT') {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.courierPuts.push({ deskId: put[1], body });
    if (c.failPut) return json(res, 503, envelope('unavailable', 'Try again.', true)), true;
    const desk = (c.desks ?? []).find((d) => d.deskId === put[1]);
    if (!desk) return json(res, 404, envelope('not_found', 'Not found.')), true;
    if (desk.address && body.replace !== true) return json(res, 409, envelope('address_exists', 'This desk has an address.')), true;
    const name = String(body.name ?? '').toLowerCase();
    const why = verdict(c, name, desk.deskId);
    const codes = { invalid: [400, 'invalid_name'], reserved: [409, 'name_reserved'], taken: [409, 'name_taken'], shares_stem: [409, 'name_shares_stem'] };
    if (why) return json(res, codes[why][0], envelope(codes[why][1], 'Refused.')), true;
    desk.address = { address: `${name}@${domain}`, name, createdAt: new Date().toISOString() };
    json(res, 201, { address: desk.address });
    return true;
  }
  json(res, 404, envelope('not_found', 'Not found.'));
  return true;
}
