// The member's theme sliders, as ma-platform's contract appearance.md says `services/identity` answers them: `appearance`
// in GET /v1/me, always, defaults filled in, and PUT /v1/me/appearance, a merge of `blue` and `contrast` (integers 0..100).
// One setting per member, by the token's `sub`.
//
// State (serve.mjs's, set through POST /__harness):
//   appearanceDocs     { [sub]: { blue, contrast, updatedAt } }. A member with none never moved a slider.
//   appearanceMissing  true: a Platform from before the contract. /v1/me says nothing, and the route is API Gateway's 404.
//   appearanceFail     { status, code?, times? }: refuse saves, `times` of them, or for good.
//   appearancePuts     read back: every save so far, { user, body (as sent), status, at }.
const NEVER_SET = () => ({ blue: 100, contrast: 50, updatedAt: null });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const okInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;

const docOf = (state, user) => ({ ...NEVER_SET(), ...state.appearanceDocs?.[user] });

/** Answers its own route and says so; for GET /v1/me, adds `appearance` to what serve.mjs answers. */
export async function appearance(req, res, path, state, { json, readBody, claimsOf, envelope }) {
  const user = claimsOf(req).sub;
  if (path === '/v1/me' && req.method === 'GET') {
    if (state.appearanceMissing) return false;
    const end = res.end.bind(res);
    res.end = (body, ...rest) => {
      if (res.statusCode !== 200 || typeof body !== 'string' || !body) return end(body, ...rest);
      return end(JSON.stringify({ ...JSON.parse(body), appearance: docOf(state, user) }), ...rest);
    };
    return false;
  }
  if (path !== '/v1/me/appearance') return false;
  if (state.appearanceMissing || req.method !== 'PUT') {
    json(res, 404, { message: 'Not Found' });
    return true;
  }
  const raw = await readBody(req);
  state.appearancePuts ??= [];
  const answer = (status, reply) => {
    state.appearancePuts.push({ user, body: raw, status, at: Date.now() });
    json(res, status, reply, { 'Cache-Control': 'no-store' });
    return true;
  };
  const fail = state.appearanceFail;
  if (fail) {
    if (fail.times && --fail.times === 0) state.appearanceFail = null;
    return answer(fail.status, envelope(fail.code ?? 'unavailable', 'Refused.', fail.status >= 500));
  }
  if (Buffer.byteLength(raw) > 1024) return answer(400, envelope('invalid_request', 'Check the fields.', false, { fields: [{ field: 'body', issue: 'too_large' }] }));
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return answer(400, envelope('invalid_request', 'Check the fields.', false, { fields: [{ field: 'body', issue: 'invalid_json' }] }));
  }
  const fields = [];
  if (!isObject(body)) fields.push({ field: 'body', issue: 'must_be_object' });
  else {
    if (Object.keys(body).some((k) => k !== 'blue' && k !== 'contrast')) fields.push({ field: 'body', issue: 'unknown_field' });
    if (!('blue' in body) && !('contrast' in body)) fields.push({ field: 'body', issue: 'empty' });
    if ('blue' in body && !okInt(body.blue)) fields.push({ field: 'blue', issue: 'invalid' });
    if ('contrast' in body && !okInt(body.contrast)) fields.push({ field: 'contrast', issue: 'invalid' });
  }
  if (fields.length) return answer(400, envelope('invalid_request', 'Check the fields.', false, { fields }));
  const doc = { ...docOf(state, user), ...body, updatedAt: new Date().toISOString() };
  state.appearanceDocs = { ...state.appearanceDocs, [user]: doc };
  return answer(200, doc);
}
