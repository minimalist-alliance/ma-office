// An agent's workspace, in its settings (multi-agent.md section 5): its quota (up to the tier's most), what it uses, its
// files (folders, a file read as text, delete), and which agents may read it. File names and contents are whatever an
// agent wrote: text only, never markup.
import { useId, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps, WorkspaceFile, WorkspaceView } from '../client/types';
import { errorText } from '../model/agents';
import { when } from '../model/format';
import { bytesText, fullness, fullnessText, MB, nameOf, parentOf, parseMb } from '../model/workspace';
import { Meter } from './bits';
import { useRead } from './hooks';
import { Icon } from './icons';

export function WorkspaceSection({ client, agent, agents, caps }: { client: AgentClient; agent: Agent; agents: readonly Agent[]; caps: AgentCaps | null }) {
  const ids = useId();
  const [dir, setDir] = useState('');
  const [tick, setTick] = useState(0);
  const view = useRead<WorkspaceView>(() => client.getWorkspace(agent.id, dir || undefined), [client, agent.id, dir, tick, agent.workspace?.usedBytes]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [paging, setPaging] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ws = view.value ?? agent.workspace ?? null;
  const maxMb = caps?.workspaceMaxMb ?? 1024;
  const quotaMb = ws ? Math.round(ws.quotaBytes / MB) : null;
  const [quota, setQuota] = useState(quotaMb === null ? '' : String(quotaMb));
  const [quotaNote, setQuotaNote] = useState<{ ok: boolean; text: string } | null>(null);
  const shared = ws?.sharedWith ?? [];
  const [share, setShare] = useState<string[] | null>(null);
  const others = agents.filter((a) => a.id !== agent.id);
  const shareNow = share ?? shared;

  const saveQuota = async (): Promise<void> => {
    const mb = parseMb(quota, maxMb);
    if (mb === null) {
      setQuotaNote({ ok: false, text: `Pick a whole number of MB, from 1 to ${maxMb}.` });
      return;
    }
    try {
      await client.updateAgent(agent.id, { workspaceMb: mb }, { idem: newIdem() });
      setQuotaNote({ ok: true, text: 'Saved' });
      setTick((t) => t + 1);
    } catch (err) {
      const reason = err instanceof AgentError ? err.reason : null;
      setQuotaNote({ ok: false, text: reason === 'workspace_full' ? 'It already holds more than that. Delete some files first.' : reason === 'disk_budget' || reason === 'disk_low' ? errorText(reason) : 'The desk couldn’t save this just now.' });
    }
  };

  const open = async (path: string): Promise<void> => {
    setError(null);
    try {
      setFile(await client.readWorkspace(agent.id, path));
    } catch {
      setError('That file couldn’t be read. It may have just changed.');
    }
  };

  // The next page of a long file, added to what shows.
  const more = async (): Promise<void> => {
    if (!file) return;
    setError(null);
    setPaging(true);
    try {
      const next = await client.readWorkspace(agent.id, file.path, { offset: (file.offset ?? 0) + file.text.length });
      setFile((f) => (f && f.path === next.path ? { ...next, text: f.text + next.text, offset: f.offset ?? 0 } : f));
    } catch {
      setError('The rest of that file couldn’t be read. It may have just changed.');
    } finally {
      setPaging(false);
    }
  };

  const remove = async (path: string): Promise<void> => {
    setError(null);
    try {
      await client.deleteWorkspaceEntry(agent.id, path, { idem: newIdem() });
      setConfirm(null);
      if (file?.path === path) setFile(null);
      // A folder that's now empty is gone too.
      if (dir && path !== dir && view.value?.entries.length === 1) setDir(parentOf(dir));
      setTick((t) => t + 1);
    } catch {
      setError('That couldn’t be deleted just now.');
    }
  };

  const saveShare = async (): Promise<void> => {
    setError(null);
    try {
      await client.shareWorkspace(agent.id, shareNow, { idem: newIdem() });
      setShare(null);
      setTick((t) => t + 1);
    } catch {
      setError('The desk couldn’t change who may read this workspace.');
    }
  };

  const fraction = ws && ws.quotaBytes > 0 ? ws.usedBytes / ws.quotaBytes : 0;
  const level = ws ? fullness(ws.usedBytes, ws.quotaBytes) : null;
  return (
    <div className="ag-workspace" data-testid="workspace">
      {ws && (
        <div className="ag-ws-use">
          <div className="ag-usage-head">
            <span>Used</span>
            <b data-testid="workspace-used">
              {bytesText(ws.usedBytes)} of {bytesText(ws.quotaBytes)}
            </b>
          </div>
          {level && (
            <p className={`ag-small ${level === 'full' ? 'ag-error' : 'ag-muted'}`} data-testid="workspace-fullness">
              {fullnessText(level, agent.name)}
            </p>
          )}
          <Meter fraction={fraction} level={fraction >= 1 ? 'reached' : fraction >= 0.8 ? 'near' : 'ok'} label={`${agent.name}’s workspace: ${bytesText(ws.usedBytes)} of ${bytesText(ws.quotaBytes)}`} />
        </div>
      )}
      {caps?.workspaceTotalMb != null && caps.workspaceBudgetMb != null && (
        <p className={`ag-small ${caps.workspaceTotalMb >= caps.workspaceBudgetMb ? 'ag-error' : 'ag-muted'}`} data-testid="workspace-total">
          All agents’ workspaces: {bytesText(caps.workspaceTotalMb * MB)} of the {bytesText(caps.workspaceBudgetMb * MB)} this desk can give them.
          {caps.workspaceTotalMb >= caps.workspaceBudgetMb && ' There’s no room for a bigger or a new workspace until you make one smaller.'}
        </p>
      )}
      <div className="ag-ws-quota">
        <label className="ag-field" htmlFor={`${ids}-q`}>
          <span>Size</span>
          <span className="ag-amount">
            <input id={`${ids}-q`} inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} aria-describedby={`${ids}-qh`} data-testid="workspace-quota" />
            <span aria-hidden="true">MB</span>
          </span>
          <small id={`${ids}-qh`}>Up to {bytesText(maxMb * MB)}. {agent.name} keeps the size it was made with when your plan changes.</small>
        </label>
        <button type="button" className="ag-btn sm" onClick={() => void saveQuota()} disabled={quota === String(quotaMb)} data-testid="workspace-quota-save">
          Save size
        </button>
      </div>
      {quotaNote && (
        <p className={quotaNote.ok ? 'ag-muted ag-small' : 'ag-error'} role={quotaNote.ok ? 'status' : 'alert'}>
          {quotaNote.text}
        </p>
      )}

      <div className="ag-ws-files">
        {dir && (
          <div className="ag-ws-path">
            <button type="button" className="ag-icon-btn" onClick={() => setDir(parentOf(dir))} aria-label="Up a folder">
              <Icon name="back" size={14} />
            </button>
            <span className="ag-mono">{`/${dir}`}</span>
          </div>
        )}
        {view.value && view.value.entries.length === 0 && <p className="ag-muted ag-small">Nothing here yet.</p>}
        {view.error != null && !view.value && <p className="ag-muted ag-small">The files couldn’t be listed just now.</p>}
        <ul className="ag-ws-list" aria-label={`Files in ${dir || 'the workspace'}`}>
          {(view.value?.entries ?? []).map((e) => (
            <li key={e.path} data-testid="workspace-entry">
              <button type="button" className="ag-ws-name" onClick={() => (e.dir ? (setDir(e.path), setFile(null)) : void open(e.path))} aria-label={e.dir ? `Open folder ${nameOf(e.path)}` : `View ${nameOf(e.path)}`}>
                <Icon name={e.dir ? 'folder' : 'file'} size={14} />
                <span>{nameOf(e.path)}</span>
              </button>
              <span className="ag-muted ag-small">
                {bytesText(e.bytes)} · {when(e.modifiedAt)}
              </span>
              {confirm === e.path ? (
                <span className="ag-confirm">
                  <span>Delete {e.dir ? 'this folder and all in it' : 'this file'}?</span>
                  <button type="button" className="ag-btn sm" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                  <button type="button" className="ag-btn sm danger" onClick={() => void remove(e.path)} data-testid="workspace-delete-confirm">
                    Delete
                  </button>
                </span>
              ) : (
                <button type="button" className="ag-icon-btn" onClick={() => setConfirm(e.path)} aria-label={`Delete ${nameOf(e.path)}`}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {view.value?.more && (
          <p className="ag-muted ag-small" data-testid="workspace-more">
            and more: delete some to see the rest
          </p>
        )}
        {file && (
          <div className="ag-ws-file" data-testid="workspace-file">
            <div className="ag-row-between">
              <b className="ag-mono">{file.path}</b>
              <button type="button" className="ag-icon-btn" onClick={() => setFile(null)} aria-label="Close the file">
                <Icon name="close" size={14} />
              </button>
            </div>
            <pre className="ag-ws-text" tabIndex={0} aria-label={`Contents of ${file.path}`}>
              {file.text}
            </pre>
            {(file.remaining ?? 0) > 0 && (
              <p className="ag-muted ag-small" data-testid="workspace-file-more">
                {(file.remaining ?? 0).toLocaleString('en-US')} more characters.{' '}
                <button type="button" className="ag-text-btn sm" onClick={() => void more()} disabled={paging} data-testid="workspace-file-next">
                  Show more
                </button>
              </p>
            )}
            {file.truncated && file.remaining === undefined && <p className="ag-muted ag-small">Only the start of this file shows.</p>}
          </div>
        )}
      </div>

      <fieldset className="ag-field" data-testid="workspace-share">
        <legend>Others who may read it</legend>
        {others.length === 0 && <p className="ag-muted ag-small">No other agents on this desk yet.</p>}
        {others.map((o) => (
          <label key={o.id} className="ag-check">
            <input type="checkbox" checked={shareNow.includes(o.id)} onChange={(e) => setShare(e.target.checked ? [...shareNow, o.id] : shareNow.filter((x) => x !== o.id))} />
            <span>{o.name}</span>
          </label>
        ))}
        <small>Private to {agent.name} unless you share it. Others can read it, never change it.</small>
      </fieldset>
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
      {share && (
        <div className="ag-row-end">
          <button type="button" className="ag-btn sm" onClick={() => void saveShare()} data-testid="workspace-share-save">
            Save sharing
          </button>
        </div>
      )}
    </div>
  );
}
