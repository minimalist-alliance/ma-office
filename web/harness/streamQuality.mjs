// The member's stream quality, as ma-platform's contract stream-quality.md says `services/identity` answers it:
// `streamQuality` in GET /v1/me, and PUT /v1/me/stream-quality, a merge. One document per member, who comes only
// from the token. serve.mjs calls this for every signed-in call, and it answers only its own route.
//
// Contract 0.3.70: the document is in layers, `default` (null while not set), `apps`, and `desks`, each desk's own
// `{level, apps}`; `streamQualityBefore` plays a Platform from before it.
//
// Steered through POST /__harness. None of these is in serve.mjs's FRESH(), so a reset clears them all:
//   streamQualityDocs     { [sub]: { default, apps, desks?, updatedAt } }. A member with none has never chosen.
//   streamQualityMissing  true: Platform from before the contract. /v1/me says nothing, and the route is API Gateway's 404.
//   streamQualityBefore   true: Platform from before 0.3.70: no `desks` (and `default` "high" when never set), and a
//                         body with `desks` or a null `default` refused as the old code refuses it.
//   streamQualityFail     { status, code?, times? }: refuse saves, `times` of them, or for good.
//   streamQualityDelayMs  hold every save's answer this long.
//   streamQualityPuts     read back: every save so far, { user, body (as sent), status, at }.
const LEVELS = ['low', 'medium', 'high', 'max'];
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_BODY_BYTES = 4 * 1024;
const DESK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_OVERRIDES = 16;
const MAX_DESKS = 32;
const NEVER_SET = () => ({ default: null, apps: {}, desks: {}, updatedAt: null });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The member's document as stored, and as Platform answers it: before 0.3.70, no desks and never a null default. */
function docOf(state, user) {
  const doc = { ...NEVER_SET(), ...state.streamQualityDocs?.[user] };
  if (!state.streamQualityBefore) return doc;
  return { default: doc.default ?? 'high', apps: doc.apps, updatedAt: doc.updatedAt };
}

/** An object of app id to a level or null, checked into `fields` under `at`. */
function checkLevels(fields, at, apps) {
  if (!isObject(apps)) {
    fields[at] = 'must be an object';
    return;
  }
  for (const [app, level] of Object.entries(apps)) {
    if (!APP_ID.test(app)) fields[`${at}.${app}`] = 'bad app id';
    else if (level !== null && !LEVELS.includes(level)) fields[`${at}.${app}`] = 'unknown level';
  }
}

/** The checks in the contract's table. Returns the fields that are wrong, or null. */
function invalid(body, before) {
  if (!isObject(body)) return { body: 'must be a JSON object' };
  const fields = {};
  const keys = before ? ['default', 'apps'] : ['default', 'apps', 'desks'];
  for (const key of Object.keys(body)) if (!keys.includes(key)) fields[key] = 'unknown field';
  if (!keys.some((k) => k in body)) fields.body = 'needs default, apps or desks';
  if ('default' in body && !LEVELS.includes(body.default) && (before || body.default !== null)) fields.default = 'unknown level';
  if ('apps' in body) checkLevels(fields, 'apps', body.apps);
  if ('desks' in body && !before) {
    if (!isObject(body.desks)) fields.desks = 'must be an object';
    else {
      for (const [id, d] of Object.entries(body.desks)) {
        if (!DESK_ID.test(id)) fields.desks = 'bad desk id';
        else if (d === null) continue;
        else if (!isObject(d)) fields[`desks.${id}`] = 'must be an object';
        else {
          for (const key of Object.keys(d)) if (key !== 'level' && key !== 'apps') fields[`desks.${id}`] = 'unknown field';
          if (!('level' in d) && !('apps' in d)) fields[`desks.${id}`] = 'empty';
          if ('level' in d && d.level !== null && !LEVELS.includes(d.level)) fields[`desks.${id}.level`] = 'unknown level';
          if ('apps' in d) checkLevels(fields, `desks.${id}.apps`, d.apps);
        }
      }
    }
  }
  return Object.keys(fields).length ? fields : null;
}

/** `was` with a change of levels on top: a level sets, null removes. */
function withLevels(was, change) {
  const out = { ...was };
  for (const [app, level] of Object.entries(change ?? {})) {
    if (level === null) delete out[app];
    else out[app] = level;
  }
  return out;
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
  const fields = invalid(body, !!state.streamQualityBefore);
  if (fields) return answer(400, envelope('invalid_request', 'Check the fields.', false, { fields }));

  const was = { ...NEVER_SET(), ...state.streamQualityDocs?.[user] };
  const apps = withLevels(was.apps, body.apps);
  if (Object.keys(apps).length > MAX_OVERRIDES) return answer(400, envelope('invalid_request', 'At most 16 overrides.', false, { fields: { apps: 'too many' } }));
  const desks = { ...was.desks };
  for (const [id, d] of Object.entries(body.desks ?? {})) {
    const prev = desks[id] ?? { level: null, apps: {} };
    const own = d === null ? { level: null, apps: {} } : { level: 'level' in d ? d.level : prev.level, apps: withLevels(prev.apps, d.apps) };
    if (Object.keys(own.apps).length > MAX_OVERRIDES) return answer(400, envelope('invalid_request', 'At most 16 overrides.', false, { fields: { [`desks.${id}.apps`]: 'too many' } }));
    if (own.level === null && !Object.keys(own.apps).length) delete desks[id];
    else desks[id] = own;
  }
  if (Object.keys(desks).length > MAX_DESKS) return answer(400, envelope('invalid_request', 'At most 32 desks.', false, { fields: { desks: 'too many' } }));
  // Moves on with every change, the same body twice included, even within a millisecond.
  const now = Date.now();
  const at = was.updatedAt ? Math.max(now, Date.parse(was.updatedAt) + 1) : now;
  const def = 'default' in body ? body.default : (was.default ?? (state.streamQualityBefore ? 'high' : null));
  state.streamQualityDocs = { ...state.streamQualityDocs, [user]: { default: def, apps, desks, updatedAt: new Date(at).toISOString() } };
  return answer(200, docOf(state, user));
}
