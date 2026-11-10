// The member's stream quality, as ma-platform's contract stream-quality.md says `services/identity` answers it:
// `streamQuality` in GET /v1/me, and PUT /v1/me/stream-quality, a merge. One document per member, who comes only
// from the token. serve.mjs calls this for every signed-in call, and it answers only its own route.
//
// Steered through POST /__harness. None of these is in serve.mjs's FRESH(), so a reset clears them all:
//   streamQualityDocs     { [sub]: { default, apps, updatedAt } }. A member with none has never chosen.
//   streamQualityMissing  true: Platform from before the contract. /v1/me says nothing, and the route is API Gateway's 404.
//   streamQualityFail     { status, code?, times? }: refuse saves, `times` of them, or for good.
//   streamQualityDelayMs  hold every save's answer this long.
//   streamQualityPuts     read back: every save so far, { user, body (as sent), status, at }.
const LEVELS = ['low', 'medium', 'high', 'max'];
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_OVERRIDES = 16;
const NEVER_SET = () => ({ default: 'high', apps: {}, updatedAt: null });

const docOf = (state, user) => state.streamQualityDocs?.[user] ?? NEVER_SET();

/** The checks in the contract's table. Returns the fields that are wrong, or null. */
function invalid(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { body: 'must be a JSON object' };
  const fields = {};
  for (const key of Object.keys(body)) if (key !== 'default' && key !== 'apps') fields[key] = 'unknown field';
  if (!('default' in body) && !('apps' in body)) fields.body = 'needs default or apps';
  if ('default' in body && !LEVELS.includes(body.default)) fields.default = 'unknown level';
  if ('apps' in body) {
    const { apps } = body;
    if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) fields.apps = 'must be an object';
    else {
      for (const [app, level] of Object.entries(apps)) {
        if (!APP_ID.test(app)) fields[`apps.${app}`] = 'bad app id';
        else if (level !== null && !LEVELS.includes(level)) fields[`apps.${app}`] = 'unknown level';
      }
    }
  }
  return Object.keys(fields).length ? fields : null;
}

/** Answers its own route and says so; for GET /v1/me, adds `streamQuality` to what serve.mjs answers. */
export async function streamQuality(req, res, path, state, { json, readBody, claimsOf, envelope }) {
  const user = claimsOf(req).sub;
  if (path === '/v1/me' && req.method === 'GET') {
    if (state.streamQualityMissing) return false;
    const end = res.end.bind(res);
    res.end = (body, ...rest) => {
      if (res.statusCode !== 200 || typeof body !== 'string' || !body) return end(body, ...rest);
      return end(JSON.stringify({ ...JSON.parse(body), streamQuality: docOf(state, user) }), ...rest);
    };
    return false;
  }
  if (path !== '/v1/me/stream-quality') return false;
  // API Gateway's own answer for a route it doesn't have, or a method the route doesn't take.
  if (state.streamQualityMissing || req.method !== 'PUT') {
    json(res, 404, { message: 'Not Found' });
    return true;
  }
  const raw = await readBody(req);
  if (state.streamQualityDelayMs) await new Promise((done) => setTimeout(done, state.streamQualityDelayMs));
  state.streamQualityPuts ??= [];
  const answer = (status, reply) => {
    state.streamQualityPuts.push({ user, body: raw, status, at: Date.now() });
    json(res, status, reply, { 'Cache-Control': 'no-store' });
    return true;
  };
  const fail = state.streamQualityFail;
  if (fail) {
    if (fail.times && --fail.times === 0) state.streamQualityFail = null;
    return answer(fail.status, envelope(fail.code ?? 'unavailable', 'Refused.', fail.status >= 500));
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return answer(400, envelope('invalid_request', 'The body is over 4 KiB.', false, { fields: { body: 'too large' } }));
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return answer(400, envelope('invalid_request', 'The body must be JSON.', false, { fields: { body: 'not JSON' } }));
  }
  const fields = invalid(body);
  if (fields) return answer(400, envelope('invalid_request', 'Check the fields.', false, { fields }));

  const was = docOf(state, user);
  const apps = { ...was.apps };
  for (const [app, level] of Object.entries(body.apps ?? {})) {
    if (level === null) delete apps[app];
    else apps[app] = level;
  }
  if (Object.keys(apps).length > MAX_OVERRIDES) return answer(400, envelope('invalid_request', 'At most 16 overrides.', false, { fields: { apps: 'too many' } }));
  // Moves on with every change, the same body twice included, even within a millisecond.
  const now = Date.now();
  const at = was.updatedAt ? Math.max(now, Date.parse(was.updatedAt) + 1) : now;
  const next = { default: body.default ?? was.default, apps, updatedAt: new Date(at).toISOString() };
  state.streamQualityDocs = { ...state.streamQualityDocs, [user]: next };
  return answer(200, next);
}
