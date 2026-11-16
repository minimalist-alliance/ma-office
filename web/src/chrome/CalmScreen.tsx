// The app's non-desk screens: sign-in and refusal. Plain and calm. The office's own notice over its canvas (the membership
// cards, no desk yet, can't reach) is `DeskNotice.tsx`, a chunk of its own.
import { useEffect, useState, type ReactNode } from 'react';
import { displayText } from '../browser/address';
import { keepPending, linkFromAddress, linksOn } from '../open/intent';
import { ownSignInPath } from '../platform/auth';
import { retryConfig, signIn, signOut, useSession } from '../platform/session';
// A link pressed with Space (`spaceKey`) is the office's notice's (`DeskNotice.tsx`), Maia's widget's and the setup panel's,
// each a chunk of its own: kept in the first load here, where the notice was, so none of them waits on another for it.
import '../lib/spaceKey';

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

/** The link a sign-in card names (#9's `/open`): its host, then the whole address, both as plain text. */
export function LinkBox({ url }: { url: string }) {
  let host = '';
  try {
    host = new URL(url).hostname; // punycode for an IDN, so a lookalike shows as what it is
  } catch {
    // not a URL: the address alone
  }
  return (
    <div className="op-link" data-testid="open-link">
      {host && <div className="op-host">{host}</div>}
      <div className="op-addr" title={displayText(url)}>{displayText(url)}</div>
    </div>
  );
}

export function SignInScreen() {
  const config = useSession((s) => s.config);
  const failed = useSession((s) => s.configFailed);
  const notice = useSession((s) => s.notice);
  // Sent here to open a link (`/open`, #9): this card names it, and it waits in this tab for the trip to sign in.
  const link = linksOn(config) ? linkFromAddress() : null;
  useEffect(() => {
    if (link) keepPending(link);
  }, [link]);
  return (
    <CalmCard title={link ? 'Sign in to open this link' : 'Sign in to your office'} testId="sign-in">
      {notice && <p role="status">{notice}</p>}
      {link && (
        <>
          <LinkBox url={link} />
          <p>After you sign in, you’ll choose which desk opens it.</p>
        </>
      )}
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
