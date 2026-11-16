// The new-agent setup screen, and the same choices in an agent's settings (draft ADR "the Agent's tools and approvals", section
// 16; deskd API.md section 18). One screen before an agent's first run: its apps, the member's other desks, and what it may do
// without asking. Nothing applies before Save, and everything on it is the member's own choice: Courier, every other desk and
// every "without asking" switch start off. The words are drafts for the Sales Engineer (`model/access.ts`).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentAccess, DeskIncomingHalf } from '../client/types';
import { grantUse } from '../model/deskMessages';
import { AnswersSection } from './DeskOffers';
import {
  accessErrorText,
  APP_ORDER,
  APP_WORDS,
  AUTO_ALWAYS,
  AUTO_APP,
  AUTO_TITLE,
  AUTO_WORDS,
  autoAllowed,
  autoLead,
  changeOf,
  deskLine,
  deskOffered,
  DESKS_TITLE,
  desksLead,
  draftOf,
  folderName,
  forGuild,
  hasChanges,
  placesToMake,
  reasonLine,
  setupIntro,
  setupTitle,
  turnOnFirst,
  withApp,
  type AccessDraft,
  type AutoName,
  type OtherDesk,
  type Place,
} from '../model/access';
import { Switch } from './bits';
import { useRead, useUnsaved } from './hooks';
import { tabLabel, type NotebookTab } from '../model/auto';

/**
 * Where a "without asking" switch's additions go, from the office: the Notebook's tabs, and a new tab or folder made when the
 * member saves. The Agent app can't reach Notebook or Files itself; without this, those two switches stay off.
 */
export interface AccessPlaces {
  notebookTabs(): Promise<NotebookTab[]>;
  /** Makes a Notebook tab with this title: its id. */
  newNotebookTab(title: string): Promise<string>;
  /** Makes a folder in Files, at the top: its path. */
  newFolder(name: string): Promise<string>;
}

export interface AccessFormProps {
  client: AgentClient;
  agent: Agent;
  access: AgentAccess;
  /** The member's other desks, never this one or a Guild Desk. */
  otherDesks: readonly OtherDesk[];
  places?: AccessPlaces | null;
  /** A guild member's own agent on a Guild Desk: Notebook alone. */
  guild?: boolean;
  mode: 'setup' | 'settings';
  onSaved: (access: AgentAccess) => void;
  onBack?: () => void;
  announce?: (text: string) => void;
  /**
   * Reads the access again when it changes (W6): each `agent.state` event, so an offer that arrives or a send half the other desk
   * allows shows here without a reload. Unset: read once.
   */
  version?: unknown;
}

const NEW = '__new__';

export function AccessForm({ client, agent, access, otherDesks, places = null, guild = false, mode, onSaved, onBack, announce }: AccessFormProps) {
  const ids = useId();
  const [draft, setDraft] = useState<AccessDraft>(() => (guild ? forGuild(draftOf(access)) : draftOf(access)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const tabs = useRead(() => (places ? places.notebookTabs() : Promise.resolve([])), [places]);
  const desks = guild ? [] : otherDesks;
  // Offers and answer halves from the member's other desks (W6): what the desk said, then each Allow, Not now and Stop here.
  const [incoming, setIncoming] = useState<DeskIncomingHalf[]>(() => (Array.isArray(access.incoming) ? access.incoming : []));
  const incomingWord = JSON.stringify(access.incoming ?? []);
  useEffect(() => {
    setIncoming(Array.isArray(access.incoming) ? access.incoming : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingWord]);
  // A send half the other desk stopped (its `revoke` came) goes from what the desk holds: its switch follows, so a Save can't
  // offer it again unasked. Only desks whose half came or went change; the member's other choices stay as they are.
  const heldWord = access.desks
    .filter((d) => d.state !== 'revoked')
    .map((d) => d.toDeskId)
    .sort()
    .join('\n');
  const heldWas = useRef(heldWord);
  useEffect(() => {
    if (heldWas.current === heldWord) return;
    const before = new Set(heldWas.current ? heldWas.current.split('\n') : []);
    const now = new Set(heldWord ? heldWord.split('\n') : []);
    heldWas.current = heldWord;
    setDraft((d) => {
      const desks = { ...d.desks };
      for (const id of new Set([...before, ...now])) if (before.has(id) !== now.has(id)) desks[id] = now.has(id);
      return { ...d, desks };
    });
  }, [heldWord]);
  const changed = hasChanges(access, draft, desks);
  useUnsaved(mode === 'settings' && changed);

  const setApp = (app: (typeof APP_ORDER)[number], on: boolean): void => {
    setSaved(false);
    setDraft((d) => withApp(d, app, on));
  };
  const setAuto = (name: AutoName, value: Place | null | boolean): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, auto: { ...d.auto, [name]: value } }));
  };
  const setDesk = (deskId: string, on: boolean): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, desks: { ...d.desks, [deskId]: on } }));
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A new tab or folder for a switch is made first, as the member saves, and only then chosen.
      const make = placesToMake(draft);
      const made: { notebook?: string; files?: string } = {};
      if ((make.notebook || make.files) && !places) throw new Error('places');
      if (make.notebook && places) made.notebook = await places.newNotebookTab(make.notebook);
      if (make.files && places) made.files = await places.newFolder(make.files);
      const next = await client.setAccess(agent.id, changeOf(access, draft, desks, made), { idem: newIdem() });
      setDraft(guild ? forGuild(draftOf(next)) : draftOf(next));
      setSaved(true);
      announce?.(mode === 'setup' ? `${agent.name} is set up.` : 'Saved');
      onSaved(next);
    } catch (err) {
      setError(err instanceof AgentError ? accessErrorText(err.reason, err.detail) : 'The new tab or folder couldn’t be made just now. Try again, or pick one that’s there.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (grantId: string): Promise<void> => {
    setStopping(grantId);
    setError(null);
    try {
      const r = await client.revokeDeskGrant(grantId, { idem: newIdem() });
      setDraft(draftOf(r.access));
      announce?.('Stopped');
      onSaved(r.access);
    } catch (err) {
      setError(err instanceof AgentError ? accessErrorText(err.reason, err.detail) : accessErrorText(null, null));
    } finally {
      setStopping(null);
    }
  };

  const reason = mode === 'setup' ? reasonLine(access.setup, agent.name) : null;
  const halves = new Map(access.desks.filter((d) => d.state !== 'revoked').map((d) => [d.toDeskId, d]));

  return (
    <form className={`ag-access ${mode}`} onSubmit={(e) => void save(e)} noValidate aria-labelledby={mode === 'setup' ? `${ids}-title` : undefined} data-testid={mode === 'setup' ? 'access-setup' : 'access-settings'}>
      {mode === 'setup' && (
        <header className="ag-access-head">
          <h3 id={`${ids}-title`}>{setupTitle(agent.name)}</h3>
          <p className="ag-muted">{setupIntro(agent.name)}</p>
          {reason && (
            <p className="ag-access-reason" data-testid="access-reason">
              {reason}
            </p>
          )}
        </header>
      )}

      <fieldset className="ag-access-section" aria-describedby={mode === 'settings' ? `${ids}-apps-note` : undefined}>
        <legend>Apps</legend>
        {mode === 'settings' && (
          <p id={`${ids}-apps-note`} className="ag-muted ag-small">
            {agent.name} stops using an app you switch off at its next step, even in a task it’s doing now.
          </p>
        )}
        {(guild ? (['notebook'] as const) : APP_ORDER).map((app) => (
          <div key={app} data-testid={`access-app-${app}`}>
            <Switch id={`${ids}-app-${app}`} label={APP_WORDS[app].name} hint={APP_WORDS[app].line} checked={draft.apps[app]} onChange={(on) => setApp(app, on)} disabled={busy} />
          </div>
        ))}
      </fieldset>

      {desks.length > 0 && (
        <fieldset className="ag-access-section" data-testid="access-desks">
          <legend>{DESKS_TITLE}</legend>
          <p className="ag-muted ag-small">{desksLead(agent.name)}</p>
          {desks.map((desk) => {
            const half = halves.get(desk.deskId);
            return (
              <div key={desk.deskId} className="ag-access-desk" data-testid={`access-desk-${desk.deskId}`}>
                <Switch id={`${ids}-desk-${desk.deskId}`} label={desk.name} hint={deskLine(agent.name, desk.name)} checked={draft.desks[desk.deskId] === true} onChange={(on) => setDesk(desk.deskId, on)} disabled={busy} />
                {mode === 'settings' && half && (
                  <div className="ag-access-grant" data-testid="access-grant">
                    <span className="ag-muted ag-small">{half.state === 'active' ? grantUse(half.count, half.lastUsedAt, half.toAgentName) : deskOffered(desk.name)}</span>
                    <button type="button" className="ag-text-btn sm" onClick={() => void stop(half.grantId)} disabled={busy || stopping !== null} data-testid="access-grant-stop">
                      Stop
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {!guild && <AnswersSection client={client} agent={agent} incoming={incoming} otherDesks={otherDesks} onChange={setIncoming} disabled={busy} {...(announce ? { announce } : {})} />}

      {!guild && (
        <fieldset className="ag-access-section" data-testid="access-auto">
          <legend>{AUTO_TITLE}</legend>
          <p className="ag-muted ag-small">{autoLead(agent.name)}</p>
          {(['notebook', 'files'] as const).map((name) => {
            const allowed = autoAllowed(draft, name);
            const place = draft.auto[name];
            const canPlace = places !== null || (place?.kind === 'existing');
            const options = placeOptions(name, agent.name, place, name === 'notebook' ? tabs.value ?? [] : []);
            return (
              <div key={name} className="ag-access-auto" data-testid={`access-auto-${name}`}>
                <Switch
                  id={`${ids}-auto-${name}`}
                  label={AUTO_WORDS[name]}
                  hint={!allowed ? turnOnFirst(AUTO_APP[name]) : !canPlace ? 'Choose this from your office.' : undefined}
                  checked={place !== null}
                  onChange={(on) => setAuto(name, on ? (options[0]?.place ?? null) : null)}
                  disabled={busy || !allowed || !canPlace}
                />
                {place !== null && (
                  <label className="ag-access-place" htmlFor={`${ids}-place-${name}`}>
                    <span className="ag-sr">{name === 'notebook' ? 'Which Notebook tab' : 'Which folder'}</span>
                    <select
                      id={`${ids}-place-${name}`}
                      value={place.kind === 'new' ? NEW : place.id}
                      onChange={(e) => setAuto(name, options.find((o) => o.value === e.target.value)?.place ?? null)}
                      disabled={busy}
                      data-testid={`access-place-${name}`}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            );
          })}
          <div data-testid="access-auto-todos">
            <Switch id={`${ids}-auto-todos`} label={AUTO_WORDS.todos} hint={autoAllowed(draft, 'todos') ? undefined : turnOnFirst('todos')} checked={draft.auto.todos} onChange={(on) => setAuto('todos', on)} disabled={busy || !autoAllowed(draft, 'todos')} />
          </div>
          <p className="ag-access-always ag-small" data-testid="access-always">
            {AUTO_ALWAYS}
          </p>
        </fieldset>
      )}

      {error && (
        <p className="ag-error" role="alert" data-testid="access-error">
          {error}
        </p>
      )}
      <div className="ag-row-end ag-access-actions">
        {saved && mode === 'settings' && (
          <span className="ag-muted ag-small" role="status">
            Saved
          </span>
        )}
        {mode === 'setup' && onBack && (
          <button type="button" className="ag-text-btn" onClick={onBack} disabled={busy} data-testid="access-back">
            Back
          </button>
        )}
        <button type="submit" className={`ag-btn sm${mode === 'setup' ? ' primary' : ''}`} disabled={busy || (mode === 'settings' && !changed)} data-testid="access-save">
          {mode === 'setup' ? 'Save' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

/** A switch's places: a new one named after the agent first, then what's there now. */
function placeOptions(name: 'notebook' | 'files', agentName: string, current: Place | null, tabs: readonly NotebookTab[]): { value: string; label: string; place: Place }[] {
  const fresh = name === 'notebook' ? agentName : folderName(agentName);
  const out: { value: string; label: string; place: Place }[] = [
    { value: NEW, label: name === 'notebook' ? `A new tab, “${fresh}”` : `A new folder, “${fresh}”`, place: { kind: 'new', name: fresh } },
  ];
  if (current?.kind === 'existing' && !tabs.some((t) => t.id === current.id)) {
    out.push({ value: current.id, label: name === 'notebook' ? current.label : `The folder “${current.label}”`, place: current });
  }
  for (const t of tabs) {
    // A title another notebook's tab shares names its notebook too (Security's AAB-I3).
    const named = tabLabel(tabs, t.id) ?? t.title;
    out.push({ value: t.id, label: `The tab “${named}”`, place: { kind: 'existing', id: t.id, label: named } });
  }
  return out;
}

/** The screen itself, where the thread would be, before an agent's first run. */
export function SetupScreen({ client, agent, otherDesks, places, guild, onBack, onSaved, announce, version }: Omit<AccessFormProps, 'access' | 'mode'>) {
  // Read once per reason it shows; the desk's own `setup` going to null is what closes it, and `onSaved` says so sooner. Read
  // again on `version`, so an offer from another desk that arrives meanwhile waits here too (W6).
  const access = useRead<AgentAccess>(() => client.getAccess(agent.id), [client, agent.id, agent.setup, version]);
  const readFailed = access.value === null && access.error !== null;
  return (
    <div className="ag-setup" data-testid="setup-screen">
      <div className="ag-setup-card ag-access-card">
        {access.value ? (
          <AccessForm
            key={`${agent.id}:${access.value.setup ?? ''}`}
            client={client}
            agent={agent}
            access={access.value}
            otherDesks={otherDesks}
            places={places ?? null}
            guild={guild ?? false}
            mode="setup"
            onSaved={onSaved}
            {...(onBack ? { onBack } : {})}
            {...(announce ? { announce } : {})}
          />
        ) : (
          <p className="ag-muted" role={readFailed ? 'alert' : undefined}>
            {readFailed ? 'This couldn’t be read just now.' : 'Reading…'}
            {readFailed && (
              <>
                {' '}
                <button type="button" className="ag-text-btn sm" onClick={access.reload}>
                  Try again
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** While a send half waits for the other desk to allow it, its line is read again this often, for a desk that says nothing of it. */
const OFFERED_READ_MS = 5_000;

/** The same choices in the agent's settings, any time later. */
export function AccessSection({ client, agent, otherDesks, places, guild, announce, version }: Omit<AccessFormProps, 'access' | 'mode' | 'onSaved'>) {
  const access = useRead<AgentAccess>(() => client.getAccess(agent.id), [client, agent.id, version]);
  // A send half offered to another desk turns `active` there, by an envelope this app never sees: each `agent.state` event reads it
  // again (`version`), and while one waits, so does a slow timer, while the page can be seen.
  const waiting = access.value?.desks.some((d) => d.state === 'offered') === true;
  const { reload } = access;
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => {
      if (!document.hidden) reload();
    }, OFFERED_READ_MS);
    return () => clearInterval(t);
  }, [waiting, reload]);
  if (!access.value) return <p className="ag-muted ag-small">{access.error ? 'This couldn’t be read just now.' : 'Reading…'}</p>;
  return (
    <AccessForm
      key={agent.id}
      client={client}
      agent={agent}
      access={access.value}
      otherDesks={otherDesks}
      places={places ?? null}
      guild={guild ?? false}
      mode="settings"
      onSaved={(next) => access.set(next)}
      {...(announce ? { announce } : {})}
    />
  );
}
