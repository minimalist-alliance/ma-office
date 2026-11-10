// The app's non-desk screens: sign-in, refusal, and over the office's empty canvas the membership cards, no desk yet
// and can't reach. Plain and calm.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ageBandOf } from '../platform/age';
import { ownSignInPath } from '../platform/auth';
import { accountUrl, supportAddress } from '../platform/clientConfig';
import { loadOffer, useOffer } from '../platform/membershipOffer';
import { tierNamesFrom } from '../platform/tiers';
import { retryDesks, retryConfig, signIn, signOut, useSession } from '../platform/session';
import { announce } from '../shell/announce';
import type { NoDeskNotice } from '../shell/deskNotice';
import { inactiveCard, parentCard, SOON, teenWelcomeCard, waitlistCard, welcomeCard, type NoticeCard } from './membershipCards';

export function CalmCard({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <main className="calm-screen">
      <section className="calm-card" data-testid={testId} aria-labelledby="calm-title">
        <p className="calm-brand">Minimalist Alliance</p>
        <h1 id="calm-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

export function SignInScreen() {
  const config = useSession((s) => s.config);
  const failed = useSession((s) => s.configFailed);
  const notice = useSession((s) => s.notice);
  return (
    <CalmCard title="Sign in to your office" testId="sign-in">
      {notice && <p role="status">{notice}</p>}
      {failed ? (
        <>
          <p>Sign-in can't be reached right now.</p>
          <button type="button" className="btn primary" onClick={retryConfig}>Try again</button>
        </>
      ) : (
        <div className="calm-actions">
          <button type="button" className="btn primary" disabled={!config} onClick={() => void signIn()}>Sign in</button>
          {config?.auth.googleSignIn && !ownSignInPath(config) && (
            <button type="button" className="btn" onClick={() => void signIn('Google')}>Continue with Google</button>
          )}
        </div>
      )}
    </CalmCard>
  );
}

export function RefusalScreen() {
  // As the account menu's: it says so while it's on its way, up to a few seconds, and a second press does nothing.
  const [leaving, setLeaving] = useState(false);
  return (
    <CalmCard title="This account can't open this office" testId="refusal">
      <p>You're signed in, but this account doesn't have access here.</p>
      <div className="calm-actions">
        <button
          type="button"
          className="btn"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void signOut();
          }}
        >
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </CalmCard>
  );
}

/**
 * Outside the bars, the office's own keys take Enter and Space for the desks (`shell/useKeyboard.ts`, on `window`),
 * which would stop the card's link or button from working by keyboard. A control on the card owns them.
 */
function ownKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
}

/**
 * Card A's "See membership" is a link, since it goes to another page, styled as a button, and a button is pressed with
 * Space as well as Enter. So Space presses it too, as a button does: on the key's release, with nothing scrolling on
 * the way down. Enter stays the link's own, and a screen reader still hears a link.
 */
const spaceKey = {
  onKeyDown(e: KeyboardEvent<HTMLAnchorElement>): void {
    if (e.key === ' ') e.preventDefault();
  },
  onKeyUp(e: KeyboardEvent<HTMLAnchorElement>): void {
    if (e.key !== ' ') return;
    e.preventDefault();
    e.currentTarget.click();
  },
};

/** The words of the two notices that aren't about membership: no desk yet, and Platform out of reach. */
const OTHER = {
  empty: { title: 'Your desk is on its way', body: "There's no desk on this account yet. It will appear here as soon as it's ready." },
  error: { title: "We can't reach your desks right now", body: 'This usually clears up on its own. Your desk and its data are not affected.' },
};

/**
 * Over the empty canvas, with the top bar still there: no scrim, nothing blocked, and no way to dismiss it, since
 * nothing sits behind it. The membership cards (A or a teen's, B, F), no desk yet, or Platform out of reach. Card A waits for
 * Platform to say whether Pay is open, as every card waits for `/v1/me`, so nothing on it changes once it shows.
 * A screen reader hears it once, through the shell's live region, and finds it as a region named by its title.
 */
export function DeskNotice({ kind }: { kind: NoDeskNotice }) {
  const config = useSession((s) => s.config);
  const configFailed = useSession((s) => s.configFailed);
  const teen = useSession((s) => ageBandOf(s.me) === 'teen');
  const offer = useOffer((s) => s.offer);
  const offerFailed = useOffer((s) => s.failed);
  useEffect(() => {
    if (kind === 'welcome') void loadOffer();
  }, [kind]);

  let card: NoticeCard | null = null;
  if (kind === 'welcome') {
    // In this tab: there are no desks, so no windows to lose, and the account page leads back to the office.
    const ready = (offer || offerFailed) && (config || configFailed);
    if (ready) card = (teen ? teenWelcomeCard : welcomeCard)(offer, config && accountUrl(config), tierNamesFrom(config?.tierNames));
  } else if (kind === 'parent') {
    if (config || configFailed) card = parentCard(config && accountUrl(config));
  } else if (kind === 'waitlist') card = waitlistCard();
  else if (kind === 'inactive') card = inactiveCard(supportAddress(config));
  const plain = kind === 'empty' || kind === 'error' ? OTHER[kind] : null;
  const title = card?.title ?? plain?.title ?? '';
  const said = title && `${title}. ${card?.say ?? plain?.body ?? ''}`;
  useEffect(() => {
    if (said) announce(said);
  }, [said]);

  if (!title) return null; // the canvas's own loading state, until it's known
  return (
    <section className="desk-notice" data-testid={`desks-${kind}`} data-card={card?.letter} aria-labelledby="desk-notice-title" onKeyDown={ownKeys}>
      {card?.picture && (
        <div className="desk-notice-pics" aria-hidden="true">
          <span className="desk-notice-pic">
            <span className="desk-notice-etch">Personal</span>
          </span>
          {!card.oneDesk && (
            <span className="desk-notice-pic">
              <span className="desk-notice-etch">Work</span>
            </span>
          )}
        </div>
      )}
      <h2 id="desk-notice-title">{title}</h2>
      <p>{card?.body ?? plain?.body}</p>
      {card?.action && <a className="btn primary" href={card.action.href} {...spaceKey}>{card.action.label}</a>}
      {card?.soon && <p className="desk-notice-soon">{SOON}</p>}
      {card?.link && <a className="desk-notice-link" href={card.link.href}>{card.link.label}</a>}
      {card?.alliance && <p className="desk-notice-alliance">{card.alliance}</p>}
      {kind === 'error' && <button type="button" className="btn" onClick={retryDesks}>Try again</button>}
    </section>
  );
}
