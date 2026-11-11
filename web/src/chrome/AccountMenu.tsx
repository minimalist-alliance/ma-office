// The top bar's account menu: its button, the member's avatar with their tier's badge (task 45), and the menu's state. The
// panel itself (the member, theme, background, plain background, About this desk, keyboard shortcuts, Account settings, sign
// out and sign out everywhere) is `AccountPanel.tsx`, in the popovers chunk, since it draws nothing until it's opened.
import { useEffect, useRef, useState } from 'react';
import { useFree } from '../free/door';
import { useOnDemand } from '../lib/onDemand';
import { useSession } from '../platform/session';
import { useMyBadge, useMyTier, useTierNames } from '../platform/useTiers';
import { SetupMenuSlot } from '../setup/door';
import { isFlatGround } from '../theme/ground';
import { Avatar } from './Avatar';
import { builtRecipeOf, pictureOf } from './avatar';
import { Icon } from './icons';
import { popovers } from './popoversChunk';

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [flat, setFlat] = useState(isFlatGround);
  /** Which sign-out is on its way. Either one holds the other back; a failed "everywhere" puts it back to null. */
  const [leaving, setLeaving] = useState<'here' | 'everywhere' | null>(null);
  const [everywhereFailed, setEverywhereFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const me = useSession((s) => s.me);

  useEffect(() => {
    if (!open) return undefined;
    const el = ref.current;
    const onDown = (e: PointerEvent): void => {
      if (!el?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    el?.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el?.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const who = me?.displayName || me?.email;
  const names = useTierNames();
  const tier = useMyTier();
  const badge = useMyBadge();
  const tierName = tier && names[tier];
  // The badge's text equivalent, as its tooltip says it: "Dana Example, Officer" (contract tiers.md section 5).
  const said = who && tierName ? `${who}, ${tierName}` : who;
  // A free member's tier line is the free tier's (`free/door.ts`).
  const FreeTier = useFree((s) => s.Account);
  const leave = (): void => {
    setOpen(false);
    btnRef.current?.focus();
  };

  // The panel is the popovers chunk's (`AccountPanel.tsx`), here from the page's first idle moment.
  const Panel = useOnDemand(popovers, open && 'open')?.AccountPanel;

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn chrome account-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-controls="account-panel"
        aria-label="Account"
        // The member and their tier, as a description: no words in the top bar, and the button's name stays "Account".
        aria-description={said || undefined}
        title="Account"
        onClick={() => setOpen((v) => !v)}
      >
        {me ? <Avatar userId={me.userId} displayName={me.displayName} email={me.email} badge={badge} size={32} picture={pictureOf(me)} built={builtRecipeOf(me)} /> : <Icon name="account" />}
      </button>
      {open && Panel && (
        <Panel
          me={me}
          who={who}
          said={said}
          tierName={tierName}
          badge={badge}
          FreeTier={FreeTier}
          SetupMenuSlot={SetupMenuSlot}
          flat={flat}
          setFlat={setFlat}
          leaving={leaving}
          setLeaving={setLeaving}
          everywhereFailed={everywhereFailed}
          setEverywhereFailed={setEverywhereFailed}
          setOpen={setOpen}
          leave={leave}
          btnRef={btnRef}
        />
      )}
    </div>
  );
}
