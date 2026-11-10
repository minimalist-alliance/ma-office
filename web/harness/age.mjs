// `age` in POST /__harness: the fields of ma-platform contract age.md, section 3, as `GET /v1/me` sends them. Leave it
// out for today's `/v1/me`, with none of these fields and no `ageRules` in client-config, as in prod until the Alliance
// tier opens. Anything else in the same POST wins over what a name sets. Clients see `unpaid` for `parent_pending`.
const AGE_RULES = { enabled: true, minimumAge: 13, adultAge: 18 };
const teen = (status, parent) => ({ status, tier: 'alliance', ageBand: 'teen', adultFrom: '2029-08-01', parent });

const MEMBERSHIPS = {
  /** A paying teen whose state's rule needs no parent, on a desk. */
  teen: teen('active', null),
  /** A teen whose parent agreed and paid, on a desk. */
  'teen-parent-done': teen('active', 'done'),
  /** A teen who hasn't paid, and needs no parent. */
  'teen-unpaid': teen('unpaid', null),
  /** A teen whose parent agreed and hasn't paid yet. */
  'teen-unpaid-parent-done': teen('unpaid', 'done'),
  /** A teen waiting on a parent. */
  'teen-parent-pending': teen('unpaid', 'pending'),
  adult: { status: 'active', tier: 'member', ageBand: 'adult', adultFrom: null, parent: null },
  /** Hasn't answered the age question yet. */
  unanswered: { status: 'active', tier: 'member', ageBand: null, adultFrom: null, parent: null },
};

/** What the harness's state becomes for this name: nothing for no name. */
export function ageState(name) {
  if (!name) return {};
  const membership = MEMBERSHIPS[name];
  if (!membership) throw new Error(`no such age: ${name}`);
  return { membership, ageRules: AGE_RULES, ...(membership.status === 'unpaid' ? { desks: 'empty' } : {}) };
}
