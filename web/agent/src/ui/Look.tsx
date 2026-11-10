// An agent's look in its settings (multi-agent.md section 7, task 49 item 6): a library icon or the member's own PNG, and a
// tone from the wheel. Each pick saves at once. An upload is checked here first (type, 256 KiB, 512 by 512 by default), and
// the desk's own refusal reason shows in the same words.
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps } from '../client/types';
import { AgentMark } from '../look/AgentMark';
import { IconPicker, ToneWheel } from '../look/Pickers';
import type { LookTheme } from '../look/tones';
import { errorText } from '../model/agents';
import { pngCheck, pngRefusalText, scalePngDown, toBase64 } from '../model/png';
import { useMaskUrl } from './hooks';
import { Icon } from './icons';

/** The biggest file this window reads to scale down; the desk's own limit applies to what it sends. */
const MAX_READ_BYTES = 12 * 1024 * 1024;
const DEFAULT_LIMITS = { maxBytes: 262_144, maxPx: 512 };

export function LookEditor({ client, agent, caps, theme }: { client: AgentClient; agent: Agent; caps: AgentCaps | null; theme: LookTheme }) {
  const ids = useId();
  const look = agent.look ?? { icon: 'spark', tone: 'graphite', png: null };
  const pngUrl = useMaskUrl(client, agent);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const limits = caps ? { maxBytes: caps.iconMaxBytes, maxPx: caps.iconMaxPx } : DEFAULT_LIMITS;

  // A pick shows at once and saves after a short pause, so arrowing through the icons sends one change, not twenty.
  const [draft, setDraftState] = useState<{ icon?: string; tone?: string }>({});
  const draftRef = useRef(draft);
  const setDraft = (d: { icon?: string; tone?: string }): void => {
    draftRef.current = d;
    setDraftState(d);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const pick = (patch: { icon?: string; tone?: string }, what: string): void => {
    setDraft({ ...draftRef.current, ...patch });
    setError(null);
    setSaved(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void send(draftRef.current, what);
    }, 400);
  };
  const send = async (patch: { icon?: string; tone?: string }, what: string): Promise<void> => {
    if (!patch.icon && !patch.tone) return;
    try {
      await client.updateAgent(agent.id, patch, { idem: newIdem() });
      setSaved(what);
      // Already what the desk says (a pick of what it had, or its word came first): nothing left to wait for.
      const now = lookRef.current;
      if (!timer.current && (patch.icon ?? now.icon) === now.icon && (patch.tone ?? now.tone) === now.tone) setDraft({});
    } catch (err) {
      setError(err instanceof AgentError ? errorText(err.reason, err.detail) : errorText(null));
      setDraft({});
    }
  };
  // The pick stays shown until the desk's own word changes, so nothing flickers back in between; then the desk's word shows.
  const lookRef = useRef(look);
  lookRef.current = look;
  useEffect(() => {
    if (!timer.current && (draftRef.current.icon !== undefined || draftRef.current.tone !== undefined)) setDraft({});
  }, [look.icon, look.tone]);
  const icon = draft.icon ?? look.icon;
  const tone = draft.tone ?? look.tone;

  const upload = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setError(null);
    setSaved(null);
    // A big export (a 2048 px logo) is common: read it, and if it is only too wide or tall, scale it down here.
    if (chosen.size > MAX_READ_BYTES) {
      setError(pngRefusalText('too_large', limits));
      return;
    }
    let bytes: Uint8Array = new Uint8Array(await chosen.arrayBuffer());
    const header = pngCheck(bytes, { maxBytes: Infinity, maxPx: limits.maxPx });
    if (!header.ok && header.reason === 'too_many_pixels') {
      const scaled = await scalePngDown(bytes, limits.maxPx);
      if (scaled) bytes = scaled;
    }
    const checked = pngCheck(bytes, limits);
    if (!checked.ok) {
      setError(pngRefusalText(checked.reason, limits));
      return;
    }
    setBusy(true);
    try {
      await client.uploadIcon(agent.id, toBase64(bytes), { idem: newIdem() });
      setSaved('Your picture is its icon now.');
    } catch (err) {
      setError(err instanceof AgentError && err.detail === 'png' ? pngRefusalText(err.reason, limits) : errorText(err instanceof AgentError ? err.reason : null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag-look-editor" data-testid="look-editor">
      <div className="ag-look-top">
        <AgentMark icon={icon} tone={tone} theme={theme} pngUrl={pngUrl} size={56} title={`${agent.name}’s icon`} />
        <div className="ag-look-upload">
          <input ref={file} id={`${ids}-png`} className="ag-sr" type="file" accept="image/png,.png" aria-label="Upload a PNG as the icon" tabIndex={-1} onChange={(e) => void upload(e)} disabled={busy} data-testid="icon-file" />
          <button type="button" className="ag-btn sm" onClick={() => file.current?.click()} disabled={busy} aria-describedby={`${ids}-png-hint`} data-testid="icon-upload">
            <Icon name="upload" size={14} /> Upload a PNG
          </button>
          <small id={`${ids}-png-hint`} className="ag-muted ag-small">
            Up to {Math.round(limits.maxBytes / 1024)} KB; a bigger picture is scaled down to {limits.maxPx} by {limits.maxPx} pixels. Only its shape is used, drawn in the standard color.
          </small>
        </div>
      </div>
      <fieldset className="ag-field">
        <legend>Icon</legend>
        <IconPicker value={icon} onChange={(next) => pick({ icon: next }, 'Icon saved')} />
      </fieldset>
      <fieldset className="ag-field">
        <legend>Color</legend>
        <ToneWheel value={tone} theme={theme} onChange={(next) => pick({ tone: next }, 'Color saved')} />
      </fieldset>
      <p className="ag-sr" role="status">
        {saved}
      </p>
      {error && (
        <p className="ag-error" role="alert" data-testid="icon-error">
          {error}
        </p>
      )}
    </div>
  );
}
