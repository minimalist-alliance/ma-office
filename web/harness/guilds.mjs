// The member's guilds and their Guild Desks, as the Guild Engineer's contracts have them (task 48, `~/ma-coord/guild-eng.md`
// 3.1 and 3.2): `GET /v1/guilds` from identity, and `GET /v1/guilds/{id}/desk`, `POST …/desk/wake` and `POST …/desk/token`
// from Platform's desks service. serve.mjs calls this for every signed-in call, and it answers only its own routes.
//
// Steered through POST /__harness, as `guilds`. Absent: the member is in no guild. A reset clears it.
//   guilds.list      [GuildMine]: { guildId, name, role, grants, adultsOnly?, members? }
//   guilds.desks     { [guildId]: { deskId, state, size?, connected? } }. Absent: `none`, never opened.
//   guilds.wakeMs    how long a woken Guild Desk takes to say `running` (default 1500)
//   guilds.listStatus  answer the list with this status, such as 404 for a Platform from before guilds
//   guilds.refuse    { [guildId]: status }: the desk routes answer this (403 or 404), as for a member just removed
//   guilds.guard     { [guildId]: { message, resumesAt } }: the wake and the token answer 403 data_guard, as for a member the data guard holds
//   guildTokenBodies read back: every token request's body, in order
const MEMBER_DESK = (guildId) => ({ deskId: `d-g${guildId.replace(/[^a-z0-9]/g, '').slice(-10)}`, state: 'none', size: null });

/** The mock Guild Desk's usage counts these `memberId`s (`web/src/desk/mockGuild.ts`): identity's names for them. */
const DEMO_PEOPLE = (state) => [
  { memberId: 'gm-thismember01', name: state.displayName ?? 'Test Member', role: 'lead', grants: [], badge: 'lead', joinedAt: '2026-10-01T12:00:00Z' },
  ...[['gm-priyaraman01', 'Priya Raman', 'officer'], ['gm-marcuslee002', 'Marcus Lee', 'officer'], ['gm-jordanellis3', 'Jordan Ellis', 'member'], ['gm-samokafor004', 'Sam Okafor', 'member'], ['gm-aishabello05', 'Aisha Bello', 'member']]
    .map(([memberId, name, role]) => ({ memberId, name, role, grants: [], badge: role === 'officer' ? 'officer' : null, joinedAt: '2026-10-02T12:00:00Z' })),
];

export async function guilds(req, res, path, state, { json, readBody, envelope, gatewayUrl }) {
  if (!path.startsWith('/v1/guilds')) return false;
  const g = state.guilds ?? { list: [] };
  if (path === '/v1/guilds' && req.method === 'GET') {
    if (g.listStatus && g.listStatus !== 200) {
      json(res, g.listStatus, g.listStatus === 404 ? { message: 'Not Found' } : envelope('unavailable', 'Try again.', true));
      return true;
    }
    const list = g.list ?? [];
    json(res, 200, { guilds: list.map((x) => ({ description: '', focus: '', adultsOnly: true, listed: false, joinPolicy: 'request', grants: [], members: 12, createdAt: '2026-10-01T12:00:00Z', ...x })), limits: { maxGuildsPerMember: 3, maxGuildMembers: 200, inGuilds: list.length } });
    return true;
  }
  const people = /^\/v1\/guilds\/([^/]+)\/people$/.exec(path);
  if (people && req.method === 'GET') {
    const guildId = decodeURIComponent(people[1]);
    if (!(g.list ?? []).some((x) => x.guildId === guildId)) {
      json(res, 404, envelope('not_found', 'Not found.'));
      return true;
    }
    json(res, 200, { people: g.people ?? DEMO_PEOPLE(state) });
    return true;
  }
  const m = /^\/v1\/guilds\/([^/]+)\/desk(\/wake|\/token)?$/.exec(path);
  if (!m) return false;
  const guildId = decodeURIComponent(m[1]);
  const member = (g.list ?? []).some((x) => x.guildId === guildId);
  const refuse = g.refuse?.[guildId];
  if (!member || refuse) {
    const status = refuse ?? 404;
    json(res, status, envelope(status === 403 ? 'forbidden' : 'not_found', status === 403 ? 'Not a member.' : 'Not found.'));
    return true;
  }
  g.desks ??= {};
  const desk = (g.desks[guildId] ??= MEMBER_DESK(guildId));
  if (desk.state === 'starting' && desk.readyAt && Date.now() >= desk.readyAt) {
    desk.state = 'running';
    delete desk.readyAt;
  }
  state.guilds = g;
  // As contract guild-sharing.md 0.3.30 answers it.
  const shown = () => ({
    guildId, deskId: desk.deskId, state: desk.state, phase: desk.state === 'running' ? 'ready' : desk.state === 'starting' ? 'booting' : null,
    size: desk.size ?? 't4g.small', targetSize: desk.size ?? 't4g.small', members: 18, connected: desk.state === 'running', pollAfterSeconds: desk.state === 'starting' ? 2 : 60,
  });
  if (!m[2] && req.method === 'GET') {
    json(res, 200, shown());
    return true;
  }
  // The data guard (ma-platform ADR 0110): `403 data_guard`, `details` with `resumesAt`, and `message` the words to show.
  const guard = g.guard?.[guildId];
  if (guard && (m[2] === '/wake' || m[2] === '/token') && req.method === 'POST') {
    await readBody(req);
    json(res, 403, envelope('data_guard', guard.message, false, { since: guard.since ?? null, resumesAt: guard.resumesAt ?? null, contact: 'support' }));
    return true;
  }
  if (m[2] === '/wake' && req.method === 'POST') {
    await readBody(req);
    if (desk.state === 'none' || desk.state === 'stopped') {
      desk.state = 'starting';
      desk.readyAt = Date.now() + (g.wakeMs ?? 1500);
    }
    json(res, 202, shown());
    return true;
  }
  if (m[2] === '/token' && req.method === 'POST') {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = null;
    }
    (state.guildTokenBodies ??= []).push(body);
    if (!body || typeof body.fingerprint !== 'string' || !body.fingerprint.startsWith('sha-256 ')) {
      json(res, 400, envelope('invalid_request', 'fingerprint is required.', false, { fields: { fingerprint: 'required' } }));
      return true;
    }
    if (desk.state !== 'running') {
      json(res, 409, envelope('invalid_state', 'The Guild Desk is not running.', true, { state: desk.state }));
      return true;
    }
    json(res, 200, {
      deskId: desk.deskId,
      state: 'running',
      phase: 'ready',
      scope: 'guild_member',
      deskToken: `harness.guild-token.${guildId}`,
      refreshAfter: new Date(Date.now() + 240_000).toISOString(),
      gateway: gatewayUrl(),
      deskIdentity: { fingerprintsSha256: ['sha-256 AA:BB:CC:DD'] },
    });
    return true;
  }
  json(res, 405, envelope('method_not_allowed', 'Method not allowed.'));
  return true;
}
