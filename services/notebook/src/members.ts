// Guild members' display names, for showing who wrote what. Only the `name` deskd sends in `caller`, kept by memberId
// and replaced when it changes. Never identity: two members can share a name.
import { type Caller } from './caller.ts';
import { type Db } from './db.ts';

export class Members {
  private names: Map<string, string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  private all(): Map<string, string> {
    if (!this.names) {
      this.names = new Map(this.db.all<{ member_id: string; name: string }>('SELECT member_id, name FROM members').map((r) => [r.member_id, r.name]));
    }
    return this.names;
  }

  /** From a hello or a `caller` frame. Owners and unchanged names write nothing. */
  remember(c: Caller): void {
    if (c.kind !== 'guild_member' || !c.memberId || !c.name) return;
    const names = this.all();
    if (names.get(c.memberId) === c.name) return;
    this.db.run(
      'INSERT INTO members (member_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
      c.memberId,
      c.name,
      this.now(),
    );
    names.set(c.memberId, c.name);
  }

  name(memberId: string): string | null {
    return this.all().get(memberId) ?? null;
  }
}
