// The key screen (design 9.5 step 1, ADR 0012). The key is typed into a hidden field that React never holds:
// the input is uncontrolled, so the key is never in state, props or a store. Submitting takes it out of the
// field in the same task (KeySecret.takeFrom) and hands it to the client, which sends it only to the desk.
// Nothing here logs it, stores it in the browser or sends it anywhere else.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import { KeySecret, keyFormatMessage, keyFormatProblem, keyOwner, providerMismatchMessage } from '../client/keySecret';
import type { Agent, KeyMeta, ModelInfo, Provider } from '../client/types';
import { errorText, KEY_RESTART_LINE, keyLost } from '../model/agents';
import { UNPRICED } from '../model/limits';
import { when } from '../model/format';
import { ProviderBadge, Switch } from './bits';
import { useRead } from './hooks';
import { Icon } from './icons';

function failure(err: unknown): string {
  return err instanceof AgentError ? errorText(err.reason, err.detail) : errorText(null);
}

/**
 * What became of a key that was typed and didn't land. The field is empty by now, so this always says what to do, and it
 * says when the desk may have it after all: a reply that never came can hide a key that went in.
 */
export function keyFailure(err: unknown): string {
  // The form stops another provider's key first, so the desk saying so means it knows a prefix this window doesn't: no name.
  if (err instanceof AgentError && err.reason === 'key_malformed' && err.detail === 'provider_mismatch') return providerMismatchMessage(null);
  if (err instanceof AgentError && (err.reason === 'key_refused' || err.reason === 'key_malformed')) return errorText(err.reason, err.detail);
  if (err instanceof AgentError && err.reason === 'storage') return 'Your desk couldn’t save this key, and kept nothing. Paste it again.';
  const maybe = err instanceof AgentError ? err.mayHaveApplied : (err as { inFlight?: unknown } | null)?.inFlight === true;
  return maybe ? 'The connection dropped before the desk answered. If the key isn’t listed, paste it again.' : 'The desk couldn’t take this key just now, and kept nothing. Paste it again.';
}

/**
 * A key added again takes its dead row's place: whoever used it goes back to work on the same model, and the row goes. Returns
 * who went back. Going by provider and last 4, a different key leaves the old row for the member to delete.
 */
async function takeOver(client: AgentClient, agents: readonly Agent[], keys: readonly KeyMeta[], added: KeyMeta): Promise<string[]> {
  const back: string[] = [];
  for (const old of keys) {
    if (old.keyId === added.keyId || old.provider !== added.provider || old.last4 !== added.last4 || !keyLost(old, agents)) continue;
    for (const a of agents) {
      if (a.binding?.keyId !== old.keyId) continue;
      await client.bindAgent(a.id, { keyId: added.keyId, model: a.binding.model }, { idem: newIdem() });
      back.push(a.id);
    }
    // Not worth a word if it fails: the row stays, quietly saying what it is.
    await client.deleteKey(old.keyId, { idem: newIdem() }).catch(() => undefined);
  }
  return back;
}

/** Only where the desk is known not to keep keys (`keysLast` false): not while that's still unknown. */
function RestartLine({ keysLast }: { keysLast: boolean | null }) {
  return keysLast === false ? <p className="ag-note" data-testid="key-restart-line">{KEY_RESTART_LINE}</p> : null;
}

/** Tells the common password managers not to offer to save or fill this field. */
const NO_MANAGER = { 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;

export function KeyForm({ client, providers, onAdded, onFailed, again, submitLabel = 'Add key' }: {
  client: AgentClient;
  providers: Provider[];
  onAdded: (key: KeyMeta) => void | Promise<void>;
  /** The key didn't land, as far as this window knows: the list may say otherwise. */
  onFailed?: () => void;
  /** The key this is adding again, for its provider and name. */
  again?: Pick<KeyMeta, 'provider' | 'label'> | null;
  submitLabel?: string;
}) {
  const ids = useId();
  const field = useRef<HTMLInputElement>(null);
  const [providerId, setProviderId] = useState(again?.provider ?? providers[0]?.id ?? '');
  const [label, setLabel] = useState(again?.label ?? '');
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];

  // Whatever happens, the field is empty when this form goes.
  useEffect(() => {
    const el = field.current;
    return () => {
      if (el) el.value = '';
    };
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const el = field.current;
    if (busy || !el || !provider) return;
    const secret = KeySecret.takeFrom(el);
    setHasText(false);
    const problem = keyFormatProblem(secret, provider.keyPrefix);
    // Another provider's key, by the longest prefix it fits, stops here and names that provider, before the desk is asked.
    const owner = problem === null || problem === 'prefix' ? keyOwner(secret, providers) : null;
    if (owner && owner.id !== provider.id) {
      secret.wipe();
      setError(providerMismatchMessage(owner.name));
      el.focus();
      return;
    }
    if (problem) {
      secret.wipe();
      setError(keyFormatMessage(problem, provider.keyPrefix));
      el.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const key = await client.addKey({ provider: provider.id, label: label.trim(), secret }, { idem: newIdem() });
      setLabel('');
      secret.wipe();
      // The key is the desk's now, whatever comes next, so what goes wrong from here isn't about keeping it.
      await Promise.resolve(onAdded(key)).catch(() => {
        setError('The key is on this desk, but the agent couldn’t start on it yet. Pick it above in a moment.');
        onFailed?.();
      });
    } catch (err) {
      setError(keyFailure(err));
      onFailed?.();
      el.focus();
    } finally {
      secret.wipe();
      setBusy(false);
    }
  };

  if (!provider) return null;
  return (
    <form className="ag-keyform" onSubmit={(e) => void submit(e)} autoComplete="off" noValidate data-testid="key-form">
      <fieldset className="ag-field">
        <legend>Provider</legend>
        <div className="ag-seg" role="radiogroup" aria-label="Provider">
          {providers.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === provider.id} className={p.id === provider.id ? 'on' : ''} onClick={() => setProviderId(p.id)} disabled={busy}>
              {p.name}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="ag-field" htmlFor={`${ids}-key`}>
        <span>API key</span>
        <input
          ref={field}
          id={`${ids}-key`}
          name="ma-agent-provider-key"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder={`${provider.keyPrefix}…`}
          disabled={busy}
          aria-describedby={`${ids}-keyhelp${error ? ` ${ids}-err` : ''}`}
          aria-invalid={error ? true : undefined}
          onInput={(e) => setHasText(e.currentTarget.value.length > 0)}
          data-testid="key-input"
          {...NO_MANAGER}
        />
        <small id={`${ids}-keyhelp`}>
          Make one at {provider.console}. It has to be an API key: a chat app subscription can’t be used by other apps.
        </small>
      </label>
      <label className="ag-field" htmlFor={`${ids}-label`}>
        <span>Name it (optional)</span>
        <input id={`${ids}-label`} value={label} maxLength={40} placeholder="e.g. Personal" onChange={(e) => setLabel(e.target.value)} disabled={busy} autoComplete="off" {...NO_MANAGER} />
      </label>
      <p className="ag-note">
        The key goes straight to this desk over its own encrypted connection, and this window keeps no copy. The desk checks it with the provider and uses it on this desk only.
        Your prompts and replies then go to the provider, under your own agreement with them. That’s the one place desk content leaves Minimalist Alliance.
      </p>
      {error && (
        <p className="ag-error" id={`${ids}-err`} role="alert" data-testid="key-error">
          {error}
        </p>
      )}
      <div className="ag-row-end">
        <button type="submit" className="ag-btn primary" disabled={busy || !hasText} data-testid="key-submit">
          <Icon name="key" />
          {busy ? 'Checking the key…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Which key and model an agent uses, from the keys already on the desk. */
export function BindingPicker({ client, agent, keys, onBound, compact = false }: { client: AgentClient; agent: Agent; keys: KeyMeta[]; onBound?: () => void; compact?: boolean }) {
  const ids = useId();
  const [keyId, setKeyId] = useState(keys.find((k) => k.keyId === agent.binding?.keyId)?.keyId ?? keys[0]?.keyId ?? '');
  const models = useRead<ModelInfo[]>(() => (keyId ? client.listModels(keyId) : Promise.resolve([])), [client, keyId]);
  const [model, setModel] = useState(agent.binding?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = models.value ?? [];
  // A key the desk has only a row for, and no way to tell before now.
  const gone = models.error instanceof AgentError && models.error.reason === 'no_key';
  const chosen = list.some((m) => m.id === model) ? model : (list[0]?.id ?? '');
  const chosenInfo = list.find((m) => m.id === chosen);
  const unpriced = chosenInfo != null && (chosenInfo.inputMicroUsdPerMTok == null || chosenInfo.outputMicroUsdPerMTok == null);
  const unchanged = agent.binding?.keyId === keyId && agent.binding?.model === chosen;

  const save = async (): Promise<void> => {
    if (!keyId || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      await client.bindAgent(agent.id, { keyId, model: chosen }, { idem: newIdem() });
      onBound?.();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  if (!keys.length) return null;
  return (
    <div className={`ag-bind${compact ? ' compact' : ''}`}>
      <label className="ag-field" htmlFor={`${ids}-k`}>
        <span>Key</span>
        <select id={`${ids}-k`} value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={busy} data-testid="bind-key">
          {keys.map((k) => (
            <option key={k.keyId} value={k.keyId}>
              {k.label} · {k.providerName} ····{k.last4}
            </option>
          ))}
        </select>
      </label>
      <label className="ag-field" htmlFor={`${ids}-m`}>
        <span>Model</span>
        <select id={`${ids}-m`} value={chosen} onChange={(e) => setModel(e.target.value)} disabled={busy || !list.length} data-testid="bind-model">
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {unpriced && (
        <p className="ag-muted ag-small" data-testid="model-unpriced">
          {UNPRICED}
        </p>
      )}
      {gone && <p className="ag-muted ag-small" data-testid="key-again">Add this key again.</p>}
      {error && <p className="ag-error" role="alert">{error}</p>}
      <div className="ag-row-end">
        <button type="button" className="ag-btn" onClick={() => void save()} disabled={busy || unchanged || !chosen} data-testid="bind-save">
          {agent.binding ? 'Use this key and model' : `Wake ${agent.name}`}
        </button>
      </div>
    </div>
  );
}

/** A heading and its line. */
export interface KeyWords {
  title: string;
  line: string;
}

/**
 * What a dormant agent shows instead of its thread: the key screen. On a Guild Desk, where the key is the guild's, `intro` and
 * `introAgain` replace its first heading and line (a first key, and one the desk lost), and `restartLine` is the guild's own,
 * shown whatever `keysLast` says, as a Guild Desk loses its key with every sleep for now.
 */
export function KeySetup({ client, agent, agents, providers, keys, keysLast, onKeysChanged, intro = null, introAgain = null, restartLine = null }: {
  client: AgentClient;
  agent: Agent;
  agents: readonly Agent[];
  providers: Provider[];
  keys: KeyMeta[];
  keysLast: boolean | null;
  onKeysChanged: () => void;
  intro?: KeyWords | null;
  introAgain?: KeyWords | null;
  restartLine?: string | null;
}) {
  const had = agent.binding ? (keys.find((k) => k.keyId === agent.binding?.keyId) ?? null) : null;
  const usable = keys.filter((k) => !keyLost(k, agents));
  const added = async (key: KeyMeta): Promise<void> => {
    onKeysChanged();
    const back = await takeOver(client, agents, keys, key);
    onKeysChanged();
    if (back.includes(agent.id)) return;
    const models = await client.listModels(key.keyId);
    const model = models.find((m) => m.id === agent.binding?.model) ?? models[0];
    if (model) await client.bindAgent(agent.id, { keyId: key.keyId, model: model.id }, { idem: newIdem() });
  };
  return (
    <div className="ag-setup" data-testid="key-setup">
      <div className="ag-setup-card">
        {agent.binding && introAgain ? (
          <>
            <h3>{introAgain.title}</h3>
            <p className="ag-muted" data-testid="key-gone">{introAgain.line}</p>
          </>
        ) : agent.binding ? (
          <>
            <h3>{agent.name}’s key needs adding again</h3>
            <p className="ag-muted" data-testid="key-gone">
              {had?.available === false
                ? `This desk can’t read “${had.label}” (····${had.last4}) any more.`
                : had
                  ? `“${had.label}” (····${had.last4}) didn’t stay through this desk’s restart.`
                  : 'Its key didn’t stay through this desk’s restart.'}{' '}
              {agent.name}’s thread and limits are all still here.
            </p>
          </>
        ) : intro ? (
          <>
            <h3>{intro.title}</h3>
            <p className="ag-muted">{intro.line}</p>
          </>
        ) : (
          <>
            <h3>Give {agent.name} a key</h3>
            <p className="ag-muted">
              {agent.name} wakes once it has an API key from your own provider account. You pay the provider directly, and your limits here stop it before it spends more than you allow.
            </p>
          </>
        )}
        {usable.length > 0 && (
          <section className="ag-setup-section" aria-label="Use a key already on this desk">
            <h4>Use a key on this desk</h4>
            <BindingPicker client={client} agent={agent} keys={usable} />
          </section>
        )}
        <section className="ag-setup-section" aria-label="Add a key">
          {usable.length > 0 && <h4>Or add another</h4>}
          {restartLine ? <p className="ag-note" data-testid="key-restart-line">{restartLine}</p> : <RestartLine keysLast={keysLast} />}
          <KeyForm client={client} providers={providers} onAdded={added} onFailed={onKeysChanged} again={had} />
        </section>
      </div>
    </div>
  );
}

/** The drawer's Keys tab: this agent's key and model, its badge, and every key on the desk. */
export function KeysPanel({ client, agent, agents, providers, keys, keysLast, onKeysChanged, deskName }: {
  client: AgentClient;
  agent: Agent;
  agents: readonly Agent[];
  providers: Provider[];
  keys: KeyMeta[];
  /** `model/agents.ts`'s `keysLast`. */
  keysLast: boolean | null;
  onKeysChanged: () => void;
  deskName: string;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<KeyMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ again: KeyMeta | null } | null>(null);
  const usable = keys.filter((k) => !keyLost(k, agents));
  const boundLost = keys.some((k) => k.keyId === agent.binding?.keyId && keyLost(k, agents));

  const remove = async (k: KeyMeta): Promise<void> => {
    setError(null);
    try {
      await client.deleteKey(k.keyId, { idem: newIdem() });
      setDeleted(k);
      setConfirm(null);
      onKeysChanged();
    } catch (err) {
      if (err instanceof AgentError && err.code === 'step_up_required') setError('Confirm it’s you in your account first, then try again.');
      else if (err instanceof AgentError && err.reason === 'storage') setError('Your desk couldn’t finish deleting this key. Try again.');
      else setError(failure(err));
    }
  };
  const provider = (id: string): Provider | undefined => providers.find((p) => p.id === id);

  return (
    <div className="ag-panel" data-testid="keys-panel">
      <section>
        <h4>{agent.name}</h4>
        {agent.binding && !boundLost ? (
          <BindingPicker key={`${agent.id}:${agent.binding.keyId}:${agent.binding.model}`} client={client} agent={agent} keys={usable} compact />
        ) : (
          <p className="ag-muted">{boundLost ? 'Its key needs adding again. Add it below, or pick one from the list.' : 'No key yet. Add one below, or pick one from the list.'}</p>
        )}
        <Switch
          id={`ag-hide-${agent.id}`}
          label="Hide this agent’s provider badge"
          hint="The reply footer still says who answered. A new provider shows the badge again."
          checked={agent.badgeHidden}
          onChange={(v) => void client.updateAgent(agent.id, { badgeHidden: v }, { idem: newIdem() }).catch((err: unknown) => setError(failure(err)))}
        />
      </section>
      <section>
        <h4>Keys on this desk</h4>
        {keys.length === 0 && <p className="ag-muted">None yet.</p>}
        <RestartLine keysLast={keysLast} />
        <ul className="ag-keys">
          {keys.map((k) => (
            <li key={k.keyId} data-testid="key-row">
              <div className="ag-key-main">
                <span className="ag-key-label">{k.label}</span>
                <ProviderBadge badge={k} />
              </div>
              <div className="ag-key-meta">
                <span className="ag-mono">····{k.last4}</span> · added on {k.createdByDesk === deskName ? 'this desk' : `the ${k.createdByDesk} desk`}, {when(k.createdAt)}
              </div>
              {keyLost(k, agents) && (
                <button type="button" className="ag-text-btn" onClick={() => setAdding({ again: k })} data-testid="key-again">
                  Add this key again
                </button>
              )}
              {confirm === k.keyId ? (
                <div className="ag-confirm">
                  <span>Delete this key from the desk? Agents using it stop until they get another.</span>
                  <button type="button" className="ag-btn sm" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                  <button type="button" className="ag-btn sm danger" onClick={() => void remove(k)} data-testid="key-delete-confirm">
                    Delete
                  </button>
                </div>
              ) : (
                <button type="button" className="ag-text-btn" onClick={() => setConfirm(k.keyId)} aria-label={`Delete key ${k.label}`}>
                  <Icon name="trash" size={14} /> Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        {deleted && (
          <p className="ag-note" role="status" data-testid="key-deleted">
            Deleted from this desk. Revoke it at {provider(deleted.provider)?.console ?? deleted.providerName} too: that’s the only way to be sure no copy of it still works.
          </p>
        )}
        {error && <p className="ag-error" role="alert">{error}</p>}
      </section>
      <section>
        {adding ? (
          <>
            <h4>Add a key</h4>
            <KeyForm
              key={adding.again?.keyId ?? 'new'}
              client={client}
              providers={providers}
              submitLabel="Add key"
              again={adding.again}
              onFailed={onKeysChanged}
              onAdded={async (added) => {
                onKeysChanged();
                await takeOver(client, agents, keys, added);
                setAdding(null);
                onKeysChanged();
              }}
            />
          </>
        ) : (
          <button type="button" className="ag-btn" onClick={() => setAdding({ again: null })} data-testid="key-add-open">
            <Icon name="plus" /> Add a key
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * On a Guild Desk, for the Founder and an Officer with `manage_agents` only (task 48): the guild's one key, by its name and last
 * 4, with Replace and Remove. It sits above the guild's limits in the Agent's "Guild limits". Members never see it. Replace adds
 * the new key, moves this agent to it on the same model where it can, then removes the old one.
 */
export function GuildKeyPanel({ client, agent, agents, providers, keys, onKeysChanged, restartLine = null }: {
  client: AgentClient;
  agent: Agent;
  agents: readonly Agent[];
  providers: Provider[];
  keys: KeyMeta[];
  onKeysChanged: () => void;
  restartLine?: string | null;
}) {
  const key = keys.find((k) => k.keyId === agent.binding?.keyId) ?? keys[0] ?? null;
  const [mode, setMode] = useState<'idle' | 'replace' | 'remove'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<KeyMeta | null>(null);
  const provider = (id: string): Provider | undefined => providers.find((p) => p.id === id);

  const remove = async (k: KeyMeta): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteKey(k.keyId, { idem: newIdem() });
      setGone(k);
      setMode('idle');
      onKeysChanged();
    } catch (err) {
      setError(err instanceof AgentError && err.reason === 'storage' ? 'The Guild Desk couldn’t finish removing this key. Try again.' : failure(err));
    } finally {
      setBusy(false);
    }
  };

  const replaced = async (added: KeyMeta): Promise<void> => {
    onKeysChanged();
    const old = key && key.keyId !== added.keyId ? key : null;
    try {
      const models = await client.listModels(added.keyId);
      for (const a of agents) {
        if (!a.binding || (old && a.binding.keyId !== old.keyId)) continue;
        const model = models.find((m) => m.id === a.binding?.model) ?? models[0];
        if (model) await client.bindAgent(a.id, { keyId: added.keyId, model: model.id }, { idem: newIdem() });
      }
      if (old) await client.deleteKey(old.keyId, { idem: newIdem() });
      setGone(null);
      setMode('idle');
    } catch (err) {
      setError(failure(err));
    }
    onKeysChanged();
  };

  return (
    <section className="ag-panel ag-guild-key" aria-label="Guild key" data-testid="guild-key">
      <h4>Guild key</h4>
      {key ? (
        <ul className="ag-keys">
          <li data-testid="guild-key-row">
            <div className="ag-key-main">
              <span className="ag-key-label">{key.label}</span>
            </div>
            <div className="ag-key-meta">
              <span className="ag-mono">····{key.last4}</span> · added {when(key.createdAt)}
            </div>
            {mode === 'remove' ? (
              <div className="ag-confirm" role="alert">
                <span>Remove the guild’s key? Every member’s agent stops until a key is added again.</span>
                <button type="button" className="ag-btn sm" onClick={() => setMode('idle')} disabled={busy}>
                  Keep
                </button>
                <button type="button" className="ag-btn sm danger" onClick={() => void remove(key)} disabled={busy} data-testid="guild-key-remove-confirm">
                  Remove
                </button>
              </div>
            ) : mode === 'idle' ? (
              <div className="ag-key-actions">
                <button type="button" className="ag-text-btn" onClick={() => setMode('replace')} data-testid="guild-key-replace">
                  Replace
                </button>
                <button type="button" className="ag-text-btn" onClick={() => setMode('remove')} aria-label={`Remove the guild’s key, ${key.label}`} data-testid="guild-key-remove">
                  <Icon name="trash" size={14} /> Remove
                </button>
              </div>
            ) : null}
          </li>
        </ul>
      ) : (
        <p className="ag-muted" data-testid="guild-key-none">No key on the Guild Desk. Every member’s agent waits until one is added.</p>
      )}
      {mode === 'replace' && (
        <>
          {restartLine && <p className="ag-note">{restartLine}</p>}
          <KeyForm client={client} providers={providers} submitLabel="Replace key" onFailed={onKeysChanged} onAdded={replaced} />
          <button type="button" className="ag-text-btn" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </>
      )}
      {gone && (
        <p className="ag-note" role="status" data-testid="guild-key-removed">
          Removed from the Guild Desk. Revoke it at {provider(gone.provider)?.console ?? gone.providerName} too: that’s the only way to be sure no copy of it still works.
        </p>
      )}
      {error && <p className="ag-error" role="alert">{error}</p>}
    </section>
  );
}
