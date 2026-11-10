// One proposal card under Maia's finished answer (contract maia.md, "Proposals", "Memory cards"). Its words are the
// template's (`cards.ts`); a click does what the app's own control does, then reports the decision.
import { useEffect } from 'react';
import { deskClosed, getLive } from '../desk/liveStore';
import { useSession } from '../platform/session';
import { useTierNames } from '../platform/useTiers';
import { focusDesk, goOverview } from '../shell/actions';
import { useDeskStore } from '../state/deskStore';
import { cardTemplate, expired, pageHref } from './cards';
import type { CardState, Chat } from './chat';
import { refusalCode } from './turn';

/** A timer can't wait longer than this. A card that far out is checked again when pressed. */
const MAX_WAIT_MS = 2 ** 31 - 1;


interface Props {
  chat: Chat;
  msgKey: number;
  card: CardState;
  /** After a card has taken the member somewhere on this page: on a phone, the panel steps aside. */
  onLeft: () => void;
}

export function Card({ chat, msgKey, card, onLeft }: Props) {
  const desks = useDeskStore((s) => s.desks);
  const memories = chat.store((s) => s.memories);
  const config = useSession((s) => s.config);
  const tierNames = useTierNames();
  const p = card.proposal;
  const id = p.proposalId;
  const t = cardTemplate(p, { desks, memories, tierNames, pageHref: (page) => pageHref(page, config, window.location.hostname) });

  // A pending card stops offering anything once it expires.
  useEffect(() => {
    if (card.status !== 'pending' || !p.expiresAt) return undefined;
    const wait = Date.parse(p.expiresAt) - Date.now();
    if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) return undefined;
    const timer = window.setTimeout(() => chat.setCard(msgKey, id, { status: 'expired' }), Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [card.status, p.expiresAt, chat, msgKey, id]);

  if (!t) return null;
  const live = card.status === 'pending' || card.status === 'busy';
  const busy = card.status === 'busy';

  /** True if it's still good to act on; otherwise it shows as expired. */
  const fresh = (): boolean => {
    if (!expired(p, Date.now())) return true;
    chat.setCard(msgKey, id, { status: 'expired' });
    return false;
  };

  const done = (line: string): void => chat.setCard(msgKey, id, { status: 'done', line });

  const confirm = async (): Promise<void> => {
    if (busy || !fresh()) return;
    switch (t.action) {
      case 'remember':
      case 'forget':
        await chat.decideMemory(msgKey, card, t.action);
        return;
      case 'open_desk': {
        const deskId = t.deskId!;
        const closed = deskClosed(deskId);
        // Exactly what focusing the desk does anywhere in the office: fit it, and wake it if it's stopped.
        focusDesk(deskId);
        const code = closed === 'held' ? 'desk_unavailable' : closed === 'setting-up' ? 'desk_setting_up' : closed === 'membership' || closed === 'data_guard' ? refusalCode(getLive(deskId).refusal?.kind) ?? 'account_inactive' : null;
        done(code ? "That desk can't be opened right now." : 'Opening it.');
        void chat.decide(id, { decision: 'confirmed', result: code ? 'failed' : 'ok', errorCode: code });
        onLeft();
        return;
      }
      case 'open_page':
        if (t.page === 'desks') {
          goOverview();
          done('Showing all your desks.');
          onLeft();
        } else {
          done(t.href?.startsWith('mailto:') ? 'Opened.' : 'Opened in a new tab.');
        }
        void chat.decide(id, { decision: 'confirmed', result: 'ok', errorCode: null });
        return;
      case 'lead_request':
        // A link to billing in its own tab, as open_page's.
        done('Opened in a new tab.');
        void chat.decide(id, { decision: 'confirmed', result: 'ok', errorCode: null });
        return;
    }
  };

  const decline = (): void => {
    if (busy) return;
    done(t.action === 'forget' ? 'Kept.' : 'Not now.');
    void chat.decide(id, { decision: 'declined', result: null, errorCode: null });
  };

  const offers = live && t.confirm;
  return (
    <div className="maia-card" role="group" aria-label={t.title} data-action={t.action}>
      {t.label && <p className="maia-card-label">{t.label}</p>}
      <p className="maia-card-title">{t.title}</p>
      {t.quote !== null && <blockquote className="maia-card-quote">{t.quote}</blockquote>}
      {t.body && offers && <p className="maia-card-body">{t.body}</p>}
      {offers && (
        <div className="maia-card-actions">
          {t.href ? (
            <a
              className="maia-btn primary"
              href={t.href}
              {...(t.href.startsWith('mailto:') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
              onClick={(e) => {
                if (!fresh()) {
                  e.preventDefault();
                  return;
                }
                void confirm();
              }}
            >
              {t.confirm}
            </a>
          ) : (
            <button type="button" className="maia-btn primary" aria-disabled={busy} onClick={() => void confirm()}>
              {t.confirm}
            </button>
          )}
          <button type="button" className="maia-btn" aria-disabled={busy} onClick={decline}>
            {t.decline}
          </button>
        </div>
      )}
      {card.status === 'expired' && <p className="maia-card-line">This suggestion has expired.</p>}
      {card.status === 'done' && card.line && <p className="maia-card-line" role="status">{card.line}</p>}
    </div>
  );
}
