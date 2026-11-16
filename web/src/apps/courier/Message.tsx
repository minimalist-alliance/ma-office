// One message in a conversation: an email as a quiet card with its subject (its HTML only in the sandboxed frame, its links
// listed under it, its attachments named), or a chat message as a plain bubble. The sender line comes from Courier's contact
// record and its sender check, never from a display name the message wrote (the launch plan §3.5).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../theme/themeStore';
import frameCssUrl from './courier-frame.css?url';
import type { CourierClient } from './client';
import { MAIL_SANDBOX, mailSrcdoc } from './frame';
import { domainOf, firstName, firstView, hasRemoteImages, linksOf, rememberView, senderAddress, senderName, sizeWords, unconfirmed, whenLong, wordsHost } from './model';
import { Icon, MediumMark, MenuButton, type MenuItem } from './parts';
import type { Archive, Attachment, MailLink, Message, Preview, Warning } from './types';
import { DANGER_WORDS, W } from './words';

export interface MessageActions {
  openLink(link: MailLink): void;
  copy(text: string): void;
  markUnread(m: Message): void;
  remove(m: Message): void;
  /** "Save to Files": resolves once the desk answered (the line at the foot says how). A dangerous type only after its ask. */
  save?(m: Message, a: Attachment, allowDanger: boolean): Promise<void>;
  /**
   * "Download", to this device over the desk's own `bulk`: resolves once it's saved or refused (the foot line says how).
   * A dangerous type only after its ask. Resolves `true` when the desk wants that ask first (bytes that look like a program).
   * Called straight from the press, so the save picker can open.
   */
  download?(m: Message, a: Attachment, allowDanger: boolean): Promise<boolean>;
  /** "Show": the picture the desk drew again from the attachment's pixels. Ended at once when `signal` aborts. */
  preview?(m: Message, a: Attachment, signal: AbortSignal): Promise<Preview>;
  /** An archive's file list, read on the desk without unpacking it. */
  archive?(m: Message, a: Attachment): Promise<Archive>;
  /** The message as it came (`.eml`): what a message that couldn't be read safely offers. `true`: the desk wants the ask first. */
  downloadRaw?(m: Message, allowDanger: boolean): Promise<boolean>;
}

/** An image the sandbox can draw again (API.md §21: PNG, JPEG, GIF and BMP), and never a dangerous type. */
export const previewable = (a: Attachment): boolean =>
  !a.danger && (/^image\/(png|jpe?g|pjpeg|gif|bmp|x-ms-bmp)$/i.test(a.type) || /\.(png|jpe?g|gif|bmp)$/i.test(a.name));
/** An archive the sandbox lists without unpacking (ZIP or tar), dangerous or not: its list is how the member sees why. */
export const listable = (a: Attachment): boolean =>
  /^application\/(zip|x-zip-compressed|x-tar)$/i.test(a.type) || /\.(zip|tar)$/i.test(a.name);

/** The frame's stylesheet as an absolute URL on the office's own origin, which the frame's policy names exactly. */
const frameCss = (): string | null => {
  try {
    return new URL(frameCssUrl, document.baseURI).href;
  } catch {
    return null;
  }
};

export function MailFrame({ html, subject }: { html: string; subject: string }) {
  // The frame's paper follows the theme (the Designer's call 1): the frame can't read the office's tokens, so its stylesheet
  // holds the three papers and the document names which.
  const paper = useTheme((s) => s.resolved);
  const doc = useMemo(() => mailSrcdoc(html, { style: frameCss(), paper }), [html, paper]);
  // `sandbox=""`: no scripts, no same origin, nothing else (Security's condition). `srcDoc` only: the frame has no URL.
  return <iframe className="courier-frame" title={W.frameTitle(subject)} sandbox={MAIL_SANDBOX} srcDoc={doc} referrerPolicy="no-referrer" loading="lazy" data-testid="courier-frame" />;
}

function LinkRow({ link, actions }: { link: MailLink; actions: MessageActions }) {
  const web = link.scheme === 'http' || link.scheme === 'https';
  const words = link.text && link.text !== link.host ? link.text : '';
  return (
    <li className="courier-link" data-warn={link.warn.length ? link.warn.join(' ') : undefined}>
      <div className="courier-link-main">
        {words && <span className="courier-link-words">{words}</span>}
        <span className="courier-link-host">{link.host}</span>
        <span className="courier-link-href" title={link.href}>
          {link.href}
        </span>
        {link.warn.filter((w) => w !== 'tracker').length > 0 && (
          <ul className="courier-link-warn">
            {link.warn.includes('mismatch') && <li>{W.warn.mismatch(wordsHost(link.text))}</li>}
            {link.warn.includes('punycode') && <li>{W.warn.punycode}</li>}
            {link.warn.includes('ip') && <li>{W.warn.ip}</li>}
            {link.warn.includes('userinfo') && <li>{W.warn.userinfo}</li>}
          </ul>
        )}
        {link.warn.includes('tracker') && <span className="courier-link-quiet">{W.warn.tracker}</span>}
      </div>
      <div className="courier-link-acts">
        {web && (
          <button type="button" className="courier-btn" onClick={() => actions.openLink(link)} aria-label={W.openInBrowserOf(link.host)}>
            <Icon name="open" />
            <span>{W.openInBrowser}</span>
          </button>
        )}
        <button type="button" className="courier-btn quiet" onClick={() => actions.copy(link.scheme === 'mailto' || link.scheme === 'tel' ? link.host : link.href)} aria-label={`${link.scheme === 'mailto' ? W.copyAddress : link.scheme === 'tel' ? W.copyNumber : W.copyLink}: ${link.host}`}>
          <Icon name="copy" />
          <span>{link.scheme === 'mailto' ? W.copyAddress : link.scheme === 'tel' ? W.copyNumber : W.copyLink}</span>
        </button>
      </div>
    </li>
  );
}

/** The message's links, outside the frame (Security's Q3): where each goes, its warnings, Open in the desk's Browser, Copy. */
export function LinksList({ links, actions }: { links: MailLink[]; actions: MessageActions }) {
  const warned = links.some((l) => l.warn.some((w) => w !== 'tracker'));
  const [open, setOpen] = useState(warned || links.length <= 5);
  const id = useId();
  if (links.length === 0) return null;
  return (
    <section className="courier-links" aria-label={W.linksHead(links.length)}>
      <button type="button" className="courier-links-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="link" />
        <span>{W.linksHead(links.length)}</span>
        <Icon name="back" className={`courier-chev${open ? ' open' : ''}`} />
      </button>
      <div id={id} hidden={!open}>
        <p className="courier-links-why">{W.linksWhy}</p>
        <ul className="courier-link-list">
          {links.map((l) => (
            <LinkRow key={l.href} link={l} actions={actions} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * One press that a dangerous type asks about first, in place (the second press): Save to Files and Download. `run` resolves
 * `true` when the desk itself wants the ask (bytes that look like a program under a harmless name).
 */
function AskFirst({ danger, label, busyLabel, icon, aria, ask, anyway, className, run }: { danger: boolean; label: string; busyLabel: string; icon: 'save' | 'download'; aria: string; ask: string; anyway: string; className: string; run(allowDanger: boolean): Promise<boolean | void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) yes.current?.focus();
    else if (asked.current) opener.current?.focus();
    asked.current = asking;
  }, [asking]);
  const go = (allowDanger: boolean): void => {
    setBusy(true);
    setAsking(false);
    // Straight from the press: Download's save picker must be asked before anything is awaited.
    void run(allowDanger)
      .then((wants) => {
        if (wants === true && !allowDanger) setAsking(true);
      })
      .finally(() => setBusy(false));
  };
  if (asking) {
    return (
      <span className="courier-ask" role="group" aria-label={ask}>
        <span>{ask}</span>
        <button ref={yes} type="button" className="courier-btn" onClick={() => go(true)}>
          {anyway}
        </button>
        <button type="button" className="courier-btn quiet" onClick={() => setAsking(false)}>
          {W.cancel}
        </button>
      </span>
    );
  }
  return (
    <button ref={opener} type="button" className={`courier-btn quiet ${className}`} disabled={busy} aria-label={aria} onClick={() => (danger ? setAsking(true) : go(false))}>
      <Icon name={icon} />
      <span>{busy ? busyLabel : label}</span>
    </button>
  );
}

/**
 * "Show": the picture the desk drew again from the attachment's pixels, fetched only on this press, shown from a blob URL
 * that's ours (never the sender's type), and let go of when it's hidden. Closing it mid-way ends the transfer on the desk.
 */
function PreviewPane({ m, a, preview }: { m: Message; a: Attachment; preview: NonNullable<MessageActions['preview']> }) {
  const [state, setState] = useState<{ url: string; width: number; height: number } | 'loading' | 'failed'>('loading');
  // Fetched once per message and part: the thread's re-renders (a new actions object each time) never start it again (CF-I4).
  const args = useRef({ m, a, preview });
  args.current = { m, a, preview };
  useEffect(() => {
    const ac = new AbortController();
    let url: string | null = null;
    const { m: msg, a: att, preview: fetchIt } = args.current;
    fetchIt(msg, att, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        url = URL.createObjectURL(p.blob);
        setState({ url, width: p.width, height: p.height });
      },
      () => !ac.signal.aborted && setState('failed'),
    );
    return () => {
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [m.messageId, a.part]);
  if (state === 'loading') return <p className="courier-quiet courier-att-more" role="status">{W.previewLoading}</p>;
  if (state === 'failed') return <p className="courier-quiet courier-att-more" role="status">{W.previewFailed}</p>;
  return (
    <div className="courier-att-more courier-att-preview" data-testid="courier-preview">
      <img src={state.url} alt={a.name} width={state.width} height={state.height} decoding="async" />
    </div>
  );
}

/** An archive's list, read on the desk without unpacking it: names as text, sizes, folders, locked and dangerous entries named. */
function ArchiveList({ m, a, archive }: { m: Message; a: Attachment; archive: NonNullable<MessageActions['archive']> }) {
  const [list, setList] = useState<Archive | 'loading' | 'failed'>('loading');
  const args = useRef({ m, a, archive });
  args.current = { m, a, archive };
  useEffect(() => {
    let gone = false;
    const { m: msg, a: att, archive: listIt } = args.current;
    listIt(msg, att).then(
      (l) => !gone && setList(l),
      () => !gone && setList('failed'),
    );
    return () => {
      gone = true;
    };
  }, [m.messageId, a.part]);
  if (list === 'loading') return <p className="courier-quiet courier-att-more" role="status">{W.loading}</p>;
  if (list === 'failed') return <p className="courier-quiet courier-att-more" role="status">{W.archiveFailed}</p>;
  return (
    <div className="courier-att-more courier-archive" data-testid="courier-archive">
      <p className="courier-quiet">{W.archiveCount(list.entries.length, list.total, list.truncated)}</p>
      <ul aria-label={W.filesIn(a.name)}>
        {list.entries.map((e, i) => (
          <li key={i} data-danger={e.danger ?? undefined}>
            <span className="courier-archive-name">{e.name}</span>
            <span className="courier-att-size">{e.dir ? W.archiveFolder : sizeWords(e.bytes)}</span>
            {e.encrypted && <span className="courier-att-size">{W.archiveLocked}</span>}
            {e.danger && (
              <span className="courier-att-danger">
                <Icon name="shield" />
                {`${DANGER_WORDS[e.danger]} ${W.dangerTail}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttachmentRow({ m, a, actions }: { m: Message; a: Attachment; actions: MessageActions }) {
  const [more, setMore] = useState<'preview' | 'files' | null>(null);
  // Nothing in Spam or Trash is fetched, opened or saved: Not spam or Restore first (as Save to Files, Wave 3.1).
  const live = m.lane !== 'spam' && m.lane !== 'trash';
  const { save, download, preview, archive } = actions;
  return (
    <li className="courier-att" data-danger={a.danger ?? undefined}>
      <span className="courier-att-name">{a.name}</span>
      <span className="courier-att-size">{sizeWords(a.bytes)}</span>
      {a.danger && (
        <span className="courier-att-danger">
          <Icon name="shield" />
          {`${DANGER_WORDS[a.danger]} ${W.dangerTail}`}
        </span>
      )}
      {live && (
        <span className="courier-att-acts">
          {preview && previewable(a) && (
            <button type="button" className="courier-btn quiet" aria-expanded={more === 'preview'} aria-label={more === 'preview' ? `${W.hide}: ${a.name}` : W.showOf(a.name)} onClick={() => setMore((x) => (x === 'preview' ? null : 'preview'))}>
              {more === 'preview' ? W.hide : W.show}
            </button>
          )}
          {archive && listable(a) && (
            <button type="button" className="courier-btn quiet" aria-expanded={more === 'files'} aria-label={more === 'files' ? `${W.hideFiles}: ${a.name}` : W.showFilesOf(a.name)} onClick={() => setMore((x) => (x === 'files' ? null : 'files'))}>
              {more === 'files' ? W.hideFiles : W.showFiles}
            </button>
          )}
          {download && (
            <AskFirst danger={!!a.danger} label={W.download} busyLabel={W.downloading} icon="download" aria={W.downloadOf(a.name)} ask={W.downloadDangerAsk} anyway={W.downloadAnyway} className="courier-att-download" run={(allow) => download(m, a, allow)} />
          )}
          {save && <AskFirst danger={!!a.danger} label={W.save} busyLabel={W.saving} icon="save" aria={W.saveOf(a.name)} ask={W.saveDangerAsk} anyway={W.saveAnyway} className="courier-att-save" run={(allow) => save(m, a, allow)} />}
        </span>
      )}
      {live && more === 'preview' && preview && <PreviewPane m={m} a={a} preview={preview} />}
      {live && more === 'files' && archive && <ArchiveList m={m} a={a} archive={archive} />}
    </li>
  );
}

function Attachments({ m, actions }: { m: Message; actions: MessageActions }) {
  if (m.attachments.length === 0) return null;
  const shown = m.attachments.filter((a) => !a.inline);
  if (shown.length === 0) return null;
  return (
    <section className="courier-atts" aria-label={W.attachmentsHead(shown.length)}>
      <h4 className="courier-atts-head">
        <Icon name="clip" />
        {W.attachmentsHead(shown.length)}
      </h4>
      <ul>
        {shown.map((a) => (
          <AttachmentRow key={a.part} m={m} a={a} actions={actions} />
        ))}
      </ul>
      {actions.save && <p className="courier-quiet">{W.attachmentsLater}</p>}
    </section>
  );
}

/** A sender warning (Wave 3.2) as a neutral card: an icon and plain words, never a warning colour. */
function WarningCard({ w }: { w: Warning }) {
  const [head, line] =
    w.kind === 'not_usual_address'
      ? [W.warn_not_usual(firstName(w.name)), W.warn_not_usual_line]
      : w.kind === 'lookalike'
        ? [W.warn_lookalike(w.like), W.warn_really(w.domain)]
        : w.kind === 'punycode'
          ? [W.warn_punycode, W.warn_really(w.domain)]
          : [W.warn_name_address, W.warn_name_address_line];
  return (
    <div className="courier-note" role="note" data-testid="courier-warning" data-kind={w.kind}>
      <Icon name="shield" />
      <div>
        <strong>{head}</strong>
        <span>{line}</span>
      </div>
    </div>
  );
}

/** What the desk saw in the sender (warnings) and where its filter put it, above the message. */
function SenderNotes({ m }: { m: Message }) {
  if (m.warnings.length === 0 && m.screen !== 'filter') return null;
  return (
    <>
      {m.warnings.map((w, i) => (
        <WarningCard key={i} w={w} />
      ))}
      {m.screen === 'filter' && m.lane === 'spam' && (
        <p className="courier-quiet courier-filtered" data-testid="courier-filtered">
          {W.filtered}
        </p>
      )}
    </>
  );
}

/** The sender check's line: neutral, an icon and plain words, never a warning colour (the plan §5). */
function Unconfirmed({ m }: { m: Message }) {
  const domain = m.from && !m.from.me ? domainOf(m.from.endpoint.value) : '';
  return (
    <div className="courier-note" role="note" data-testid="courier-unconfirmed">
      <Icon name="info" />
      <div>
        <strong>{W.unconfirmed(domain)}</strong>
        <span>{W.unconfirmedWhy}</span>
      </div>
    </div>
  );
}

function Body({ m, client, actions }: { m: Message; client: CourierClient; actions: MessageActions }) {
  // People's mail opens in Text only, Updates as sent, and the member's last choice for a sender sticks (the Designer's call 1).
  const [mode, setModeNow] = useState<'html' | 'text'>(() => (m.hasHtml ? firstView(m) : 'text'));
  const setMode = (v: 'html' | 'text'): void => {
    setModeNow(v);
    rememberView(m, v);
  };
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState<{ text: string; more: boolean }>({ text: m.text, more: m.textMore });
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setText({ text: m.text, more: m.textMore }), [m.text, m.textMore]);
  useEffect(() => {
    if (!m.hasHtml || mode !== 'html' || html !== undefined) return;
    let gone = false;
    client.html(m.messageId).then(
      (h) => !gone && setHtml(h),
      () => !gone && setHtml(null),
    );
    return () => {
      gone = true;
    };
  }, [client, m.messageId, m.hasHtml, mode, html]);
  const links = useMemo(() => (html ? linksOf(html) : []), [html]);

  if (m.parse?.state === 'refused') {
    const raw = actions.downloadRaw;
    return (
      <div className="courier-note" role="note">
        <Icon name="shield" />
        <div>
          <strong>{W.refused}</strong>
          <span>{W.refusedWhy}</span>
          {raw && m.lane !== 'spam' && m.lane !== 'trash' && (
            // The raw download a refused message offers (API.md §21). Nothing is known of what it holds (the sandbox couldn't
            // read it, so it has no attachments to look at), so it always asks first, as deskd does (Security's CF-L1).
            <AskFirst danger label={W.downloadMessage} busyLabel={W.downloading} icon="download" aria={W.downloadMessage} ask={W.downloadMessageAsk} anyway={W.downloadAnyway} className="courier-raw-download" run={(allow) => raw(m, allow)} />
          )}
        </div>
      </div>
    );
  }
  if (m.parse?.state === 'pending') return <p className="courier-quiet">{W.pending}</p>;
  const showMore = async (): Promise<void> => {
    setLoadingMore(true);
    try {
      const whole = await client.message(m.messageId);
      if (whole) setText({ text: whole.text, more: whole.textNext !== null });
    } catch {
      // The short text stays; the button stays to try again.
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <>
      {m.hasHtml && (
        <div className="courier-modes" role="group" aria-label={W.view}>
          <button type="button" aria-pressed={mode === 'html'} onClick={() => setMode('html')}>
            {W.asSent}
          </button>
          <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
            {W.textOnly}
          </button>
        </div>
      )}
      {mode === 'html' && m.hasHtml ? (
        html === undefined ? (
          <p className="courier-quiet">{W.loading}</p>
        ) : html === null ? (
          <div className="courier-text">{text.text || W.noText}</div>
        ) : (
          <>
            {hasRemoteImages(html) && (
              <p className="courier-quiet courier-images-off">
                <Icon name="shield" />
                {W.imagesOff}
              </p>
            )}
            <MailFrame html={html} subject={m.subject} />
            <LinksList links={links} actions={actions} />
          </>
        )
      ) : (
        <>
          <div className="courier-text">{text.text || W.noText}</div>
          {text.more && (
            <button type="button" className="courier-btn quiet" onClick={() => void showMore()} disabled={loadingMore}>
              {loadingMore ? W.loading : W.showAll}
            </button>
          )}
        </>
      )}
    </>
  );
}

const STATUS_WORDS: Partial<Record<Message['status'], string>> = { queued: W.queued, sending: W.sending, failed: W.sendFailed };

export function MessageView({ m, client, actions, now, open, onToggle, mine, highlight }: { m: Message; client: CourierClient; actions: MessageActions; now: number; open: boolean; onToggle(): void; mine: boolean; highlight: boolean }) {
  const who = senderName(m.from);
  const address = senderAddress(m.from);
  const when = whenLong(m.at, now);
  const status = STATUS_WORDS[m.status];
  const menu: MenuItem[] = [
    ...(!mine ? [{ key: 'unread', label: W.markUnread, onPick: () => actions.markUnread(m) }] : []),
    ...(m.lane !== 'trash' ? [{ key: 'delete', label: W.toTrash, onPick: () => actions.remove(m) }] : []),
  ];

  if (m.medium !== 'email') {
    return (
      <li className={`courier-bubble${mine ? ' mine' : ''}${highlight ? ' found' : ''}`} data-message={m.messageId} tabIndex={-1}>
        <div className="courier-bubble-head">
          <span className="courier-who">{who}</span>
          <MediumMark medium={m.medium} />
          <time dateTime={new Date(m.at).toISOString()}>{when}</time>
        </div>
        <SenderNotes m={m} />
        <div className="courier-bubble-text">{m.text || W.noText}</div>
        {status && <span className="courier-status">{status}</span>}
      </li>
    );
  }

  return (
    <li className={`courier-card${open ? ' open' : ''}${mine ? ' mine' : ''}${highlight ? ' found' : ''}`} data-message={m.messageId} tabIndex={-1}>
      <div className="courier-card-head">
        <button type="button" className="courier-card-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="courier-who">{who}</span>
          {address && <span className="courier-address">{address}</span>}
          {!open && <span className="courier-card-snippet">{status ? `${status} · ${m.snippet}` : m.snippet}</span>}
          <time dateTime={new Date(m.at).toISOString()}>{when}</time>
        </button>
        {open && <MenuButton label={W.moreActions} items={menu} />}
      </div>
      {open && (
        <div className="courier-card-body">
          {unconfirmed(m) && <Unconfirmed m={m} />}
          <SenderNotes m={m} />
          {m.subject && <h3 className="courier-subject">{m.subject}</h3>}
          {status && <span className="courier-status">{status}</span>}
          <Body m={m} client={client} actions={actions} />
          <Attachments m={m} actions={actions} />
        </div>
      )}
    </li>
  );
}
