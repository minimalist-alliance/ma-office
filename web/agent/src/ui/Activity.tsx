// The drawer's Activity tab: the desk's audit log (design 9.11), newest first, with its JSON export. Rows are
// ids, decisions and costs only: the log never holds a prompt, a reply or a key.
import { useEffect, useState } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { Agent, AuditEntry, AuditPage, KeyMeta, LimitScope, Provider } from '../client/types';
import { errorText } from '../model/agents';
import { usd, when } from '../model/format';
import { SCOPE_LABEL } from '../model/limits';
import { Icon } from './icons';

const keyCount = (n: number): string => `${n} ${n === 1 ? 'key' : 'keys'}`;

/**
 * The rows of the zone the window set by itself (ADR 0043), by hash, with the zone. A current `desk-agent` audits that as
 * `limits.timezone`, which names itself but not the zone (the row holds only a hash), so Activity says "Time zone set" for it
 * and, on the page that sent it, the zone too. An older one audits it as any `limits.set`, and only the window that sent it
 * knows which row it was, so there this lasts for the page's life and a reload reads "Changed limits". The `limits.set` part
 * can go once every desk runs the `desk-agent` with `limits.timezone`.
 */
const zoneSets = new Map<string, string>();

export function noteZoneSet(hash: string, zone: string): void {
  zoneSets.set(hash, zone);
}

export function actionText(e: Pick<AuditEntry, 'action' | 'decision'> & Partial<Pick<AuditEntry, 'target' | 'hash'>>): string {
  const ok = e.decision === 'ok' || (!e.decision.startsWith('error') && !e.decision.startsWith('refused'));
  switch (e.action) {
    case 'key.add':
      return ok ? 'Added a key' : 'A key was refused';
    case 'key.delete':
    case 'key.drop': {
      // A stop's drop of every key, which shows only where it was a real loss (an older desk) or isn't known yet.
      const zeroed = e.target === 'keys:all' ? /^zeroed:(\d+)$/.exec(e.decision) : null;
      return zeroed ? `A restart cleared ${keyCount(Number(zeroed[1]))}` : 'Deleted a key';
    }
    case 'llm.call':
      return e.decision === 'ok' ? 'Model call' : e.decision === 'error:cancelled' ? 'Model call, stopped' : `Model call failed (${e.decision.replace(/^error:/, '').replace(/_/g, ' ')})`;
    case 'limit.hit':
      return 'A limit stopped a call';
    case 'limits.timezone':
    case 'limits.set': {
      const zone = e.hash ? zoneSets.get(e.hash) : undefined;
      if (zone) return `Time zone set to ${zone}`;
      return e.action === 'limits.timezone' ? 'Time zone set' : 'Changed limits';
    }
    case 'agent.bind':
      return 'Changed a key or model';
    case 'agent.create':
      return 'Added an agent';
    // Task 49.
    case 'agent.update':
      return 'Changed an agent';
    case 'agent.delete':
      return 'Deleted an agent';
    case 'links.set':
      return 'Changed whom an agent may message';
    case 'proposal.make':
      return 'The lead proposed a change';
    case 'proposal.answer':
      if (e.decision === 'applied') return 'Confirmed the lead’s proposal';
      if (e.decision === 'declined') return 'Declined the lead’s proposal';
      if (e.decision === 'expired') return 'A proposal expired';
      return 'A confirmed proposal couldn’t be done';
    case 'timer.set':
      return e.decision === 'changed' ? 'Changed a timer' : 'Set a timer';
    case 'timer.delete':
      return 'Deleted a timer';
    case 'timer.fire':
      return ok ? 'A timer ran' : 'A timer was skipped';
    case 'workspace.delete':
      return 'Deleted from a workspace';
    case 'workspace.share':
      return 'Changed who may read a workspace';
    case 'icon.upload':
      return ok ? 'Uploaded an icon' : 'An icon was refused';
    case 'a2a.send':
      return 'One agent messaged another';
    case 'a2a.refuse':
      return 'A message between agents was refused';
    case 'service.start':
      return 'Desk team started';
    case 'service.stop':
      return 'Desk team stopped';
    case 'key.restore': {
      const n = unreadable(e.decision);
      return n > 0 ? `After a restart, ${keyCount(n)} couldn’t be read` : e.action;
    }
    default:
      return e.action;
  }
}

/** What the member does next, for a row that needs it: a key that couldn't be read is added again. */
export function nextStep(e: Pick<AuditEntry, 'action' | 'decision'>): string | null {
  if (e.action !== 'key.restore') return null;
  const n = unreadable(e.decision);
  return n > 0 ? (n === 1 ? 'Add it again in Keys.' : 'Add them again in Keys.') : null;
}

/** `key.restore`'s decision is `restored:<n>:unreadable:<n>`. */
function unreadable(decision: string): number {
  return Number(/(?:^|:)unreadable:(\d+)$/.exec(decision)?.[1] ?? 0);
}

/**
 * Rows that are only the key store at work (ADR 0042), which a member would read as a lost key, aren't shown: at a stop the
 * desk takes every key out of memory (`key.drop`, `keys:all`, `zeroed:<n>`), and at a start it reads them back
 * (`key.restore` with none unreadable). The drop is hidden only where the desk is known to keep keys (`keysLast`), because
 * on an older desk it's a real loss. A restore that couldn't read a key shows, as its own line. The export keeps every row.
 */
export function shownInActivity(e: Pick<AuditEntry, 'action' | 'target' | 'decision'>, keysLast: boolean | null): boolean {
  if (e.action === 'key.drop' && e.target === 'keys:all' && /^zeroed:\d+$/.test(e.decision)) return keysLast !== true;
  if (e.action === 'key.restore') return unreadable(e.decision) > 0;
  return true;
}

/**
 * A row's target in words: a key by its name, never its id (the brand review), an agent by its name, a model by its own
 * name, a provider by its name. A key no longer on the desk is "a deleted key". Anything else reads as it came.
 */
export function targetText(
  target: string,
  ctx: { agents: readonly Pick<Agent, 'id' | 'name'>[]; keys: readonly Pick<KeyMeta, 'keyId' | 'label'>[] | null; providers: readonly Pick<Provider, 'id' | 'name'>[] | null },
): string {
  return target
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':');
      const [kind, id] = i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
      switch (kind) {
        case 'key':
          return ctx.keys?.find((k) => k.keyId === id)?.label ?? 'a deleted key';
        case 'keys':
          return id === 'all' ? 'every key' : part;
        case 'agent':
          return ctx.agents.find((a) => a.id === id)?.name ?? id;
        case 'model':
          return id.slice(id.indexOf('/') + 1);
        case 'provider':
          return ctx.providers?.find((p) => p.id === id)?.name ?? id;
        case 'scope':
          return SCOPE_LABEL[id as LimitScope] ?? id;
        case 'proposal':
          return 'a proposal';
        case 'timer':
          return 'a timer';
        default:
          return part;
      }
    })
    .join(' · ');
}

export function actorText(actor: string, agents: Agent[]): string {
  if (actor === 'user') return 'You';
  if (actor === 'system') return 'Desk';
  if (actor === 'support') return 'Support';
  const m = /^agent:(.+)$/.exec(actor);
  if (m) return agents.find((a) => a.id === m[1])?.name ?? m[1] ?? actor;
  return actor;
}

function download(name: string, text: string): void {
  // A local file from memory: a blob URL, no request anywhere.
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ActivityPanel({ client, agents, keys, providers, version, keysLast }: {
  client: AgentClient;
  agents: Agent[];
  /** For a key's name in a row. */
  keys: KeyMeta[] | null;
  providers: Provider[] | null;
  version: unknown;
  keysLast: boolean | null;
}) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.listAudit({ limit: 30 }).then((p) => {
      if (!live) return;
      setPage(p);
      setOlder([]);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [client, version]);

  const entries = page ? [...page.entries, ...older] : [];
  const cursor = older.length ? older[older.length - 1]?.seq : page?.nextBeforeSeq;
  const more = async (): Promise<void> => {
    if (cursor == null) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await client.listAudit({ beforeSeq: cursor, limit: 30 });
      setOlder((o) => [...o, ...next.entries]);
      if (next.nextBeforeSeq == null) setPage((p) => (p ? { ...p, nextBeforeSeq: null } : p));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const exportAll = async (): Promise<void> => {
    const all: AuditEntry[] = [];
    let head: string | null = null;
    let before: number | undefined;
    setFailed(false);
    try {
      for (let i = 0; i < 100; i += 1) {
        const p = await client.listAudit({ ...(before != null ? { beforeSeq: before } : {}), limit: 500 });
        head ??= p.headHash;
        all.push(...p.entries);
        if (p.nextBeforeSeq == null) break;
        before = p.nextBeforeSeq;
      }
    } catch {
      setFailed(true);
      return;
    }
    // Oldest first, as a chain is checked.
    download('desk-activity.json', JSON.stringify({ headHash: head, entries: all.reverse() }, null, 2));
  };

  return (
    <div className="ag-panel" data-testid="activity-panel">
      <div className="ag-activity-head">
        <p className="ag-muted ag-small">
          Every key change, model call and limit, on this desk only. Kept a year. Never a prompt, a reply or a key.
        </p>
        <button type="button" className="ag-btn sm" onClick={() => void exportAll()} disabled={!page}>
          <Icon name="download" size={14} /> Export
        </button>
      </div>
      {!page && <p className="ag-muted">Loading…</p>}
      {failed && <p className="ag-error" role="alert">{errorText(null)}</p>}
      <ol className="ag-audit" aria-label="Activity on this desk">
        {entries.filter((e) => shownInActivity(e, keysLast)).map((e) => {
          const next = nextStep(e);
          return (
            <li key={e.seq} data-action={e.action}>
              <span className="ag-audit-what">{actionText(e)}</span>
              <span className="ag-audit-who">
                {actorText(e.actor, agents)} · {when(e.atMs)}
                {e.costMicroUsd != null && ` · est. ${usd(e.costMicroUsd)}`}
              </span>
              {next ? (
                <span className="ag-audit-next" data-testid="audit-next">{next}</span>
              ) : (
                <span className="ag-audit-target" data-testid="audit-target">{targetText(e.target, { agents, keys, providers })}</span>
              )}
            </li>
          );
        })}
      </ol>
      {cursor != null && (
        <button type="button" className="ag-text-btn" onClick={() => void more()} disabled={busy}>
          Show older
        </button>
      )}
    </div>
  );
}
