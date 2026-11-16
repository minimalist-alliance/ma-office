// Maia's web search in her chat (ma-platform ADR 0137): one card for each reply's batch of searches, the quiet line that
// says what she searched in auto mode, and the sources under her reply. Every word is the app's (`web.ts`); the queries and
// source titles are plain text, and a source opens only an http(s) address the search API gave, in its own tab.
import { useEffect, useId } from 'react';
import type { Chat } from './chat';
import { WEB_WORDS, sourceHref, webExpired, type WebAsk, type WebSource } from './web';

/** A timer can't wait longer than this. A card that far out is checked again when pressed. */
const MAX_WAIT_MS = 2 ** 31 - 1;

export function WebCard({ chat, msgKey, ask }: { chat: Chat; msgKey: number; ask: WebAsk }) {
  const hint = useId();
  const idle = chat.store((s) => s.phase === 'idle');

  // A waiting card stops offering anything once it expires.
  useEffect(() => {
    if (ask.status !== 'pending' || !ask.expiresAt) return undefined;
    const wait = Date.parse(ask.expiresAt) - Date.now();
    if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) return undefined;
    const timer = window.setTimeout(() => chat.setWeb(msgKey, { status: 'expired', line: WEB_WORDS.expired }), Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [ask.status, ask.expiresAt, chat, msgKey]);

  const live = ask.status === 'pending' || ask.status === 'busy';
  const busy = ask.status === 'busy' || !idle;
  const press = (decision: 'approve' | 'decline' | 'always') => {
    if (busy) return;
    if (webExpired(ask, Date.now())) {
      chat.setWeb(msgKey, { status: 'expired', line: WEB_WORDS.expired });
      return;
    }
    void chat.answerWeb(msgKey, decision);
  };

  return (
    <div className="maia-card maia-web" role="group" aria-label={WEB_WORDS.title} data-batch={ask.batchId} data-status={ask.status}>
      <p className="maia-card-title">{WEB_WORDS.title}</p>
      {live && <p className="maia-card-body">{WEB_WORDS.body}</p>}
      <ul className="maia-web-queries" aria-label="Searches">
        {ask.queries.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
      {live && (
        <>
          <div className="maia-card-actions">
            <button type="button" className="maia-btn primary" aria-disabled={busy} onClick={() => press('approve')}>
              {WEB_WORDS.approve}
            </button>
            <button type="button" className="maia-btn" aria-disabled={busy} onClick={() => press('decline')}>
              {WEB_WORDS.decline}
            </button>
            <button type="button" className="maia-web-always" aria-disabled={busy} aria-describedby={hint} onClick={() => press('always')}>
              {WEB_WORDS.always}
            </button>
          </div>
          <p className="maia-web-hint" id={hint}>
            {WEB_WORDS.alwaysHint}
          </p>
        </>
      )}
      {(ask.line || ask.status === 'expired') && (
        <p className="maia-card-line" role="status">
          {ask.line ?? WEB_WORDS.expired}
        </p>
      )}
    </div>
  );
}

/** Auto mode's line: what she searched, as plain text, and the way back to being asked first. */
export function Searched({ chat, queries }: { chat: Chat; queries: string[] }) {
  const mode = chat.store((s) => s.webMode);
  const line = chat.store((s) => s.webLine);
  return (
    <p className="maia-web-searched">
      {WEB_WORDS.searched} {queries.map((q) => `“${q}”`).join(', ')}.
      {mode === 'auto' && (
        <>
          {' '}
          <button type="button" className="maia-web-askfirst" onClick={() => void chat.setWebMode('ask')}>
            {WEB_WORDS.askFirst}
          </button>
        </>
      )}
      {line && (
        <span className="maia-web-modeline" role="status">
          {' '}
          {line}
        </span>
      )}
    </p>
  );
}

/** The sources under her reply. Her text marks them [n]; each opens its page in its own tab, with no referrer. */
export function Sources({ sources }: { sources: WebSource[] }) {
  const shown = sources.map((s) => ({ ...s, href: sourceHref(s.url) })).filter((s) => s.href);
  if (!shown.length) return null;
  return (
    <nav className="maia-sources" aria-label={WEB_WORDS.sources}>
      <p className="maia-sources-title">{WEB_WORDS.sources}</p>
      <ol>
        {shown.map((s) => (
          <li key={s.n} value={s.n}>
            <a href={s.href as string} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              {s.title}
            </a>{' '}
            <span className="maia-sources-domain">{s.domain}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
