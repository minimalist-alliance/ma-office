// The guild's channels, down the left: the main channel and the extra ones the Founder or an Officer who manages
// spaces makes. Each shows who's in its voice, as a Discord server does, and whether it has chat this member hasn't
// read. Commons' settings sit at the bottom.
import { useEffect, useRef, useState } from 'react';
import type { Channel, Member, RoomClient, RoomState } from '../room/client.ts';
import { Face } from './Face.tsx';
import { IconClose, IconHash, IconMicOff, IconMinus, IconPlus, IconRename, IconSettings, IconSidebar, IconTrash, Seal } from './icons.tsx';

export function Channels({ client, st, title, onHide }: { client: RoomClient; st: RoomState; title: string; onHide: () => void }) {
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const full = st.channels.length >= st.maxChannels;
  return (
    <nav className="ma-cm-side" aria-label="Channels">
      <div className="ma-cm-side-head">
        <span className="ma-cm-side-title" title={title}>
          {title}
        </span>
        <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Hide channels" data-tip="Hide channels" onClick={onHide}>
          <IconSidebar />
        </button>
      </div>
      <div className="ma-cm-side-sub">
        <span>Channels</span>
        {st.can.manage ? (
          <button
            className="ma-cm-icon ma-cm-icon-sm"
            aria-label="New channel"
            data-tip={full ? `All ${st.maxChannels} channels are in use` : 'New channel'}
            disabled={full}
            onClick={() => setCreating(true)}
          >
            <IconPlus />
          </button>
        ) : null}
      </div>
      <ul className="ma-cm-chanlist">
        {st.channels.map((c) => (
          <ChannelRow key={c.id} client={client} st={st} c={c} />
        ))}
        {creating ? (
          <li>
            <NameInput
              placeholder="Channel name"
              label="New channel name"
              onDone={(name) => {
                if (name) client.createChannel(name);
                setCreating(false);
              }}
            />
          </li>
        ) : null}
      </ul>
      <div className="ma-cm-side-foot">
        <span className="ma-cm-muted">
          {st.channels.length} of {st.maxChannels} channels
        </span>
        <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Commons settings" aria-expanded={settingsOpen} data-tip="Settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          <IconSettings />
        </button>
        {settingsOpen ? <SettingsMenu client={client} st={st} onClose={() => setSettingsOpen(false)} /> : null}
      </div>
    </nav>
  );
}

function NameInput({ placeholder, label, initial = '', onDone }: { placeholder: string; label: string; initial?: string; onDone: (name: string) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <form
      className="ma-cm-chan-form"
      onSubmit={(e) => {
        e.preventDefault();
        finish(v.trim());
      }}
    >
      <IconHash />
      <input
        autoFocus
        className="ma-cm-chan-input"
        value={v}
        maxLength={40}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => finish(v.trim() === initial ? '' : v.trim())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') finish('');
        }}
      />
    </form>
  );
}

function ChannelRow({ client, st, c }: { client: RoomClient; st: RoomState; c: Channel }) {
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const here = c.id === st.ch;
  const voice = st.members.filter((m) => m.ch === c.id && m.in);
  const looking = new Set(st.members.filter((m) => m.ch === c.id && !m.in).map((m) => m.id)).size;
  const unread = !here && c.last > (st.read[c.id] ?? 0);
  const mySpeaking = st.joined && !st.muted && st.myLevel > 0.18;
  const shown = voice.slice(0, 8);
  return (
    <li className="ma-cm-chan" data-here={here ? '1' : '0'} data-unread={unread ? '1' : '0'}>
      {renaming ? (
        <NameInput
          placeholder="Channel name"
          label={`Rename ${c.name}`}
          initial={c.name}
          onDone={(name) => {
            if (name && name !== c.name) client.renameChannel(c.id, name);
            setRenaming(false);
          }}
        />
      ) : (
        <div className="ma-cm-chan-line">
          <button className="ma-cm-chan-btn" aria-current={here ? 'true' : undefined} onClick={() => client.openChannel(c.id)}>
            <IconHash />
            <span className="ma-cm-chan-name">{c.name}</span>
            {unread ? <span className="ma-cm-unread" aria-label="Unread messages" /> : null}
            {voice.length ? <span className="ma-cm-chan-count" aria-label={`${voice.length} in voice`}>{voice.length}</span> : null}
          </button>
          {st.can.manage && !confirm ? (
            <span className="ma-cm-rowactions">
              <button className="ma-cm-icon ma-cm-icon-sm" aria-label={`Rename ${c.name}`} data-tip="Rename" onClick={() => setRenaming(true)}>
                <IconRename />
              </button>
              {!c.main ? (
                <button className="ma-cm-icon ma-cm-icon-sm" aria-label={`Delete ${c.name}`} data-tip="Delete" onClick={() => setConfirm(true)}>
                  <IconTrash />
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      )}
      {confirm ? (
        <div className="ma-cm-chan-confirm" role="alert">
          <span>Delete #{c.name} with its boards and chat, for everyone?</span>
          <span className="ma-cm-confirm">
            <button
              className="ma-cm-btn ma-cm-btn-danger"
              onClick={() => {
                client.deleteChannel(c.id);
                setConfirm(false);
              }}
            >
              Delete
            </button>
            <button className="ma-cm-btn ma-cm-btn-quiet" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        </div>
      ) : null}
      {shown.length ? (
        <ul className="ma-cm-chan-voice" aria-label={`In voice in ${c.name}`}>
          {shown.map((m) => (
            <VoiceRow key={m.i} m={m} speaking={m.i === st.me ? mySpeaking : st.speaking.has(m.i)} you={m.i === st.me} />
          ))}
          {voice.length > shown.length ? <li className="ma-cm-muted ma-cm-chan-more">and {voice.length - shown.length} more</li> : null}
        </ul>
      ) : null}
      {looking ? <div className="ma-cm-chan-looking">{looking} looking in</div> : null}
    </li>
  );
}

function VoiceRow({ m, speaking, you }: { m: Member; speaking: boolean; you: boolean }) {
  return (
    <li>
      <span className="ma-cm-avatar" data-speaking={speaking ? '1' : '0'} style={{ ['--ma-cm-c' as string]: `var(--ma-cm-member-${m.color})`, width: 20, height: 20, fontSize: 9 }} aria-hidden="true">
        <Face name={m.name} url={m.avatarUrl} recipe={m.avatarRecipe} size={20} />
      </span>
      <span className="ma-cm-chan-person">
        {m.name}
        {you ? <span className="ma-cm-muted"> (you)</span> : null}
      </span>
      {m.badge ? <Seal badge={m.badge} size={12} /> : null}
      {m.muted ? (
        <span className="ma-cm-person-state" aria-label="Muted">
          <IconMicOff />
        </span>
      ) : null}
    </li>
  );
}

function SettingsMenu({ client, st, onClose }: { client: RoomClient; st: RoomState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const can = st.can.manage;
  // Shown at once, then whatever the server says.
  const [max, setMax] = useState(st.settings.maxChannels);
  const [muted, setMuted] = useState(st.settings.joinMuted);
  useEffect(() => setMax(st.settings.maxChannels), [st.settings.maxChannels]);
  useEffect(() => setMuted(st.settings.joinMuted), [st.settings.joinMuted]);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-label="Commons settings"]')) onClose();
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [onClose]);
  const setMaxTo = (n: number) => {
    const v = Math.max(1, Math.min(st.ceiling, n));
    setMax(v);
    if (v !== st.settings.maxChannels) client.saveSettings({ maxChannels: v });
  };
  return (
    <div className="ma-cm-menu ma-cm-settings" role="dialog" aria-label="Commons settings" ref={ref}>
      <div className="ma-cm-menu-head">
        <span>Commons settings</span>
        <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <label className="ma-cm-setting">
        <span>
          <span className="ma-cm-setting-name">Join muted</span>
          <span className="ma-cm-setting-note">Everyone starts muted when they join a channel&rsquo;s voice.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="ma-cm-switch"
          checked={muted}
          disabled={!can}
          onChange={(e) => {
            setMuted(e.target.checked);
            client.saveSettings({ joinMuted: e.target.checked });
          }}
        />
      </label>
      <div className="ma-cm-setting">
        <span>
          <span className="ma-cm-setting-name">Channels</span>
          <span className="ma-cm-setting-note">Up to {st.ceiling}, the main channel included.</span>
        </span>
        <span className="ma-cm-stepper">
          <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Fewer channels" disabled={!can || max <= 1} onClick={() => setMaxTo(max - 1)}>
            <IconMinus />
          </button>
          <span className="ma-cm-stepper-n" aria-live="polite" aria-label={`${max} channels`}>
            {max}
          </span>
          <button className="ma-cm-icon ma-cm-icon-sm" aria-label="More channels" disabled={!can || max >= st.ceiling} onClick={() => setMaxTo(max + 1)}>
            <IconPlus />
          </button>
        </span>
      </div>
      <p className="ma-cm-menu-foot">
        {can ? 'Changes apply to everyone in the guild at once.' : 'Only the Founder and Officers who manage spaces can change these.'}
      </p>
    </div>
  );
}
