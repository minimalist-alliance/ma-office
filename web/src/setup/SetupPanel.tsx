// The setup circle's panel, in its own chunk (the initial JS budget): "Set up your office" with the member's steps, or,
// once setup is over, "Your office" with What's new and the upgrade offer. The same panel opens from the circle and, on
// a phone too narrow for the circle, from the account menu's row. The meter panel's look; nothing here opens by itself.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { spaceKey } from '../lib/spaceKey';
import { useGuildStore } from '../guild/guildStore';
import { useSession } from '../platform/session';
import { useTierNames } from '../platform/useTiers';
import { allianceDrive, guildAppHref, membershipHref, officerWeekly } from './config';
import { offerTitle } from './labels';
import type { SetupModel } from './model';
import { markSeen, offerNotNow, setCircleHidden, skipStep, undoSkip } from './prefs';
import { canRun, openApp, runStep } from './run';
import { refreshTrial } from './signals';
import { DAY_MS, fittingIds, OFFER_NOT_NOW_DAYS, type Progress, type StepId, type WhatsNewItem } from './steps';
import {
  AFTER_FOUND,
  AFTER_TITLE,
  ALL_SET,
  doneOf,
  GOT_IT,
  HIDE_CIRCLE,
  NEW_TAB,
  NOT_NOW,
  offerLines,
  PANEL_TITLE,
  SEE_MEMBERSHIP,
  SKIP,
  SKIPPED,
  STEP_WORDS,
  TRY_IT,
  UNDO,
} from './words';

export interface PanelProps {
  model: SetupModel;
  /** What the panel shows: setup, kept on screen with "Your office is set up." once the last step settles while it's open. */
  view: 'setup' | 'after';
  /** The panel is going: `back` puts the keyboard back on what opened it. `gone` when the circle itself just went. */
  onClose: (how: { back?: boolean; gone?: boolean }) => void;
  id?: string;
}

function Mark({ state }: { state: 'open' | 'done' | 'skipped' }) {
  return (
    <svg className={`su-mark ${state}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {state === 'open' ? <circle cx="8" cy="8" r="6.25" /> : state === 'skipped' ? <path d="M5 8h6" /> : <path d="M4 8.4 6.8 11 12 5.2" />}
    </svg>
  );
}

const external = (href: string, label: string, className: string, onClick: () => void): ReactNode => (
  <a className={className} href={href} target="_blank" rel="noopener" aria-description={NEW_TAB} onClick={onClick} {...(className.includes('btn') ? spaceKey : {})}>
    {label}
  </a>
);

function StepsView({ progress, prefs, onClose, titleId }: { progress: Progress; prefs: SetupModel['prefs']; onClose: PanelProps['onClose']; titleId: string }) {
  const config = useSession((s) => s.config);
  const guilds = useGuildLinks();
  const [chosen, setChosen] = useState<StepId | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const open = progress.open;
  const expanded = chosen && open.includes(chosen) ? chosen : (open[0] ?? null);
  const focusLater = (selector: string): void => {
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(selector)?.focus());
  };

  const button = (id: StepId): ReactNode => {
    const w = STEP_WORDS[id];
    if (id === 'found-guild' || id === 'guild-join' || id === 'invite') {
      const href = id === 'found-guild' ? guildAppHref(config, '/new') : id === 'guild-join' ? guildAppHref(config, '/') : guilds.invite;
      return href ? external(href, w.button, 'btn primary su-go', () => onClose({})) : null;
    }
    if (!canRun(id)) return null;
    return (
      <button
        type="button"
        className="btn primary su-go"
        onClick={(e) => {
          onClose({});
          runStep(id, e.detail === 0);
        }}
      >
        {w.button}
      </button>
    );
  };

  return (
    <>
      <p className="su-title" id={titleId}>{PANEL_TITLE}</p>
      <p className="su-count" data-testid="setup-count">{doneOf(progress.settled, progress.steps.length)}</p>
      <ol className="su-steps" ref={listRef}>
        {progress.steps.map((id) => {
          const w = STEP_WORDS[id];
          if (prefs.done.includes(id)) {
            return (
              <li key={id} className="su-step done" data-step={id} data-state="done">
                <Mark state="done" />
                <span className="su-step-title">{w.title}</span>
              </li>
            );
          }
          if (prefs.skipped.includes(id)) {
            return (
              <li key={id} className="su-step skipped" data-step={id} data-state="skipped">
                <Mark state="skipped" />
                <span className="su-step-title">{w.title}</span>
                <span className="su-skipped">{SKIPPED}</span>
                <button
                  type="button"
                  className="btn su-quiet su-undo"
                  aria-label={`${UNDO}: ${w.title}`}
                  onClick={() => {
                    undoSkip(id);
                    setChosen(id);
                    focusLater(`[data-step="${id}"] .su-step-head`);
                  }}
                >
                  {UNDO}
                </button>
              </li>
            );
          }
          const isOpen = id === expanded;
          const bodyId = `su-body-${id}`;
          // Invite waits for the guild: no button until there's one to invite to.
          const waiting = id === 'invite' && !prefs.done.includes('found-guild');
          return (
            <li key={id} className={`su-step open${isOpen ? ' expanded' : ''}`} data-step={id} data-state="open">
              <Mark state="open" />
              <div className="su-step-main">
                <button type="button" className="su-step-head" aria-expanded={isOpen} aria-controls={isOpen ? bodyId : undefined} onClick={() => setChosen(id)}>
                  {w.title}
                </button>
                {isOpen && (
                  <div className="su-step-body" id={bodyId}>
                    <p className="su-line">{waiting ? AFTER_FOUND : w.line}</p>
                    <div className="su-actions">
                      {!waiting && button(id)}
                      <button
                        type="button"
                        className="btn su-quiet su-skip"
                        aria-label={`${SKIP}: ${w.title}`}
                        onClick={() => {
                          skipStep(id);
                          focusLater(`[data-step="${id}"] .su-undo`);
                        }}
                      >
                        {SKIP}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!open.length && (
        <p className="su-all-set" role="status" data-testid="setup-all-set">
          {ALL_SET}
        </p>
      )}
    </>
  );
}

/** The guild the member founded, for the invite step's link to its page. */
function useGuildLinks(): { invite: string | null } {
  const config = useSession((s) => s.config);
  const founded = useGuildStore((s) => s.guilds.find((g) => g.role === 'lead')?.guildId ?? null);
  return { invite: founded ? guildAppHref(config, `/${founded}/invites`) : null };
}

function WhatsNewCard({ item, alsoSeen, onClose, onGone }: { item: WhatsNewItem; alsoSeen: readonly string[]; onClose: PanelProps['onClose']; onGone: () => void }) {
  // Every item that fits now goes with it, so an older one never comes up after this one (dropped, not queued).
  const seen = (): void => markSeen([item.id, ...alsoSeen]);
  return (
    <section className="su-card" aria-labelledby="su-new-title" data-testid="whats-new">
      <p className="su-card-title" id="su-new-title">{item.title}</p>
      <p className="su-line">{item.line}</p>
      <div className="su-actions">
        {'href' in item.action
          ? external(item.action.href, TRY_IT, 'btn primary', () => {
              seen();
              onClose({});
            })
          : (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const app = (item.action as { app: 'browser' | 'notebook' | 'agent' | 'files' }).app;
                seen();
                onClose({});
                openApp(app);
              }}
            >
              {TRY_IT}
            </button>
          )}
        <button
          type="button"
          className="btn su-quiet"
          onClick={() => {
            seen();
            onGone();
          }}
        >
          {GOT_IT}
        </button>
      </div>
    </section>
  );
}

function OfferCard({ offer, onGone }: { offer: NonNullable<Extract<SetupModel['circle'], { kind: 'after' }>['offer']>; onGone: () => void }) {
  const names = useTierNames();
  const config = useSession((s) => s.config);
  const href = membershipHref(config);
  const titleId = useId();
  const lines = offerLines(offer, names, { allianceDrive: allianceDrive(config), officerWeekly: officerWeekly(config) });
  return (
    <section className="su-card" aria-labelledby={titleId} data-testid="setup-offer" data-offer={offer}>
      <p className="su-card-title" id={titleId}>{offerTitle(offer, names)}</p>
      <ul className="su-offer-lines">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div className="su-actions">
        {href && external(href, SEE_MEMBERSHIP, 'btn primary', () => undefined)}
        <button
          type="button"
          className="btn su-quiet"
          onClick={() => {
            offerNotNow(Date.now() + OFFER_NOT_NOW_DAYS * DAY_MS);
            onGone();
          }}
        >
          {NOT_NOW}
        </button>
      </div>
    </section>
  );
}

export default function SetupPanel({ model, view, onClose, id }: PanelProps) {
  const titleId = useId();
  const circle = model.circle;
  // Opening is the member asking: her trial's state is asked again, at most once a minute.
  useEffect(() => refreshTrial(), []);

  const hide = (): void => {
    setCircleHidden(true);
    onClose({ gone: true });
  };

  return (
    <div className="su-panel" id={id} role="region" aria-labelledby={titleId} data-testid="setup-panel" data-view={view}>
      {view === 'setup' && model.progress ? (
        <StepsView progress={model.progress} prefs={model.prefs} onClose={onClose} titleId={titleId} />
      ) : (
        <>
          <p className="su-title" id={titleId}>{AFTER_TITLE}</p>
          {circle.kind === 'after' && circle.whatsNew && (
            <WhatsNewCard
              item={circle.whatsNew}
              alsoSeen={model.tier ? fittingIds(model.items, { tier: model.tier, band: model.teen ? 'teen' : 'adult' }, Date.now()) : []}
              onClose={onClose}
              onGone={() => {
                // It was all the circle held: the circle goes with it.
                if (!circle.offer) onClose({ gone: true });
              }}
            />
          )}
          {circle.kind === 'after' && circle.offer && (
            <OfferCard
              offer={circle.offer}
              onGone={() => {
                // The card was all the circle held: the circle goes with it.
                if (!circle.whatsNew) onClose({ gone: true });
              }}
            />
          )}
        </>
      )}
      <button type="button" className="btn su-quiet su-hide" onClick={hide} data-testid="setup-hide">
        {HIDE_CIRCLE}
      </button>
    </div>
  );
}
