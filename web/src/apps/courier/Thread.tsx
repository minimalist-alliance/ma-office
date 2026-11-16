// A conversation: its people, what to do with it (Done is the main action; Requests' Let in, Not now and Block; Spam's and
// Trash's way back), its messages in order, and the reply docked under it. Opening it marks it read on the desk, so every
// device the member has sees the same.
import { noteFocusEvent, setFocusItem } from '../../state/focusItems';
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useCloseHold } from '../../shell/closeGuard';
import { askWhere, openTarget } from '../files/save';
import { toCourierError, type CourierClient, type CourierError } from './client';
import { MessageView, type MessageActions } from './Message';
import { KeyChanged, memberLine } from './Keys';
import { ago, contactName, endpointMedium, firstName, replyMedium, replySubject, rowTitle } from './model';
import { ConfirmButton, Icon, MenuButton, type Foot, type MenuItem } from './parts';
import { SuggestAsk, suggestionFor } from './People';
import type { Contact, Lane, Medium, MemberKey, Message, Row, Suggestion, Thread } from './types';
import { fileNameOf } from './wire';
import { LANE_WORDS, MEDIUM_WORDS, W } from './words';

export interface ThreadProps {
  client: CourierClient;
  channelId: string;
  lane: Lane;
  /** Bumped on each `courier.changed` that names this channel (or names none). */
  reload: number;
  /** A message to bring into view (from a search). */
  focusMessageId: string | null;
  now: number;
  narrow: boolean;
  offline: boolean;
  links: Pick<MessageActions, 'openLink' | 'copy'>;
  onBack(): void;
  /** Something changed here: the list reloads, and the line at the foot says it. */
  onChanged(foot: Foot | null): void;
  /** The conversation left this lane (Done, Spam, Let in): the list goes back to its next row. */
  onLeft(): void;
  composeRef: MutableRefObject<{ focus(): void } | null>;
  /** The line at the foot, when it's this pane's: over the scroll's foot, never over the reply. */
  foot?: ReactNode;
  /** One person across channels (flow 11). All optional, so the pane works without them. */
  suggestions?: Suggestion[] | null;
  /** The first send after a link names the endpoint the reply goes to. */
  justLinked?: boolean;
  onSent?(): void;
  onLinkSuggestion?(s: Suggestion): void;
  onNotThem?(s: Suggestion): void;
  onOpenPerson?(contactId: string): void;
  onLinkTo?(title: string, contactId: string): void;
  /** A conversation being dragged from the list: the header takes it. */
  dropping?: Row | null;
  onDropPerson?(into: { contactId: string; name: string }): void;
  /** Copies a safety number (a changed key's card). */
  copy?(text: string): void;
}

/** The conversation's one person, when it has one (a direct conversation whose endpoints are all theirs). */
function onePerson(contacts: Contact[], kind: string): { contactId: string; contacts: Contact[] } | null {
  const first = contacts[0];
  if (kind !== 'direct' || !first?.contactId || contacts.some((c) => c.contactId !== first.contactId)) return null;
  return { contactId: first.contactId, contacts };
}

/** What a refused Save to Files says (API.md §21, "Attachments"). */
function saveWords(e: CourierError): string {
  if (e.code === 'offline') return W.offline;
  if (e.code === 'no_space') return W.saveErr.space;
  if (e.code === 'too_large') return W.saveErr.large;
  if (e.code === 'conflict' && e.reason === 'folder') return W.saveErr.folder;
  if (e.code === 'unavailable' && e.reason === 'files') return W.saveErr.files;
  if (e.code === 'unavailable' && e.reason === 'busy') return W.saveErr.busy;
  if (e.code === 'unavailable' && (e.reason === 'refused' || e.reason === 'parse')) return W.saveErr.refused;
  return W.failed;
}

/** What a refused or broken Download says (API.md §21, "Attachments"). Null: say nothing (the member cancelled). */
function downloadWords(e: CourierError): string | null {
  if (e.code === 'cancelled') return null;
  if (e.code === 'offline') return W.offline;
  if (e.code === 'broken') return W.downloadErr.broken;
  if (e.code === 'stalled') return W.downloadErr.stalled;
  if (e.code === 'unavailable' && e.reason === 'bandwidth_limit') return W.downloadErr.paused;
  if (e.code === 'unavailable' && e.reason === 'busy') return W.downloadErr.busy;
  if (e.code === 'unavailable' && (e.reason === 'refused' || e.reason === 'parse')) return W.saveErr.refused;
  if (e.code === 'too_many' || e.code === 'rate_limited') return W.downloadErr.many;
  if (e.code === 'no_space') return W.downloadErr.space;
  return W.failed;
}

/** The desk wants the second press first: bytes that look like a program, or a raw message holding one. */
const wantsAsk = (e: CourierError): boolean => e.code === 'forbidden' && e.reason === 'danger';

function decideWords(code: CourierError): string {
  return code.code === 'offline' ? W.offline : W.failed;
}

export function ThreadPane(p: ThreadProps) {
  const { client, channelId, lane, reload, now } = p;
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<CourierError | null>(null);
  const [older, setOlder] = useState<{ messages: Message[]; next: string | null }>({ messages: [], next: null });
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [dropHere, setDropHere] = useState(false);
  const [keys, setKeys] = useState<MemberKey[]>([]);
  const headRef = useRef<HTMLHeadingElement>(null);
  const readFor = useRef<string | null>(null);
  // Whole-thread reads ask without a lane for People, Updates and Other (the conversation, Spam and Trash left out), and with
  // the lane for Requests, Spam and Trash, which show only what's there.
  const threadLane = lane === 'requests' || lane === 'spam' || lane === 'trash' ? lane : null;

  useEffect(() => {
    let gone = false;
    client.thread(channelId, threadLane).then(
      (t) => {
        if (gone) return;
        setError(null);
        setThread(t);
        setOlder((o) => ({ ...o, next: o.messages.length ? o.next : (t?.next ?? null) }));
      },
      (e) => !gone && setError(toCourierError(e)),
    );
    return () => {
      gone = true;
    };
  }, [client, channelId, threadLane, reload]);

  // What's open, for Desk Maia's model of now (the focus shield, `state/focusItems.ts`): this channel's id and its contacts' ids,
  // never a name, an address, a subject or a word of it.
  const focusPeople = thread?.channel.contacts.map((c) => c.contactId).join(',') ?? '';
  useEffect(() => {
    const deskId = client.deskId;
    setFocusItem(deskId, 'courier', { kind: 'channel', id: channelId }, focusPeople ? focusPeople.split(',').map((contactId) => ({ deskId, contactId })) : []);
    return () => setFocusItem(deskId, 'courier', null);
  }, [client, channelId, focusPeople]);

  // A member's keys (flow 4 and 6): how the key stands under the name, and a changed key's card, which holds private messages
  // both ways until the member checks it. Asked again on every change, as a check or a message held changes them.
  const owner = thread ? onePerson(thread.channel.contacts, thread.channel.kind) : null;
  const keysOf = owner && owner.contacts.some((c) => endpointMedium(c.endpoint) === 'ma') ? owner.contactId : null;
  useEffect(() => {
    if (!keysOf) return setKeys([]);
    let gone = false;
    client.memberKeys(keysOf).then(
      (k) => !gone && setKeys(k),
      () => !gone && setKeys([]),
    );
    return () => {
      gone = true;
    };
  }, [client, keysOf, reload]);

  // A conversation starts with its newest email open, and every unread one. (The pane is keyed by its channel, so a new one
  // starts fresh.)
  // A message that comes while it's open (a reply, the member's own send) opens too.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!thread) return;
    const ms = thread.messages;
    const first = known.current === null;
    const fresh = ms.filter((m) => !known.current?.has(m.messageId));
    known.current = new Set([...(known.current ?? []), ...ms.map((m) => m.messageId)]);
    setOpenIds((s) => {
      const open = new Set(s);
      for (const m of fresh) if (!m.read || !first) open.add(m.messageId);
      const last = ms[ms.length - 1];
      if (first && last) open.add(last.messageId);
      if (first && p.focusMessageId) open.add(p.focusMessageId);
      return open;
    });
  }, [thread, p.focusMessageId]);

  // Read on the desk once it's shown, so the member's other devices agree (the plan §2.6).
  useEffect(() => {
    if (!thread || p.offline || readFor.current === channelId) return;
    if (!thread.messages.some((m) => !m.read)) return;
    readFor.current = channelId;
    void client.setRead(channelId, lane, true).catch(() => {
      readFor.current = null;
    });
  }, [thread, channelId, lane, client, p.offline]);

  // The keyboard goes to the conversation's heading when one opens in a single column (a phone, a narrow window), once.
  const focused = useRef(false);
  useEffect(() => {
    if (!p.narrow || !thread || focused.current) return;
    focused.current = true;
    headRef.current?.focus();
  }, [thread, p.narrow]);

  useEffect(() => {
    if (!p.focusMessageId || !thread) return;
    const el = document.querySelector<HTMLElement>(`[data-message="${p.focusMessageId}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [p.focusMessageId, thread]);

  const act = useCallback(
    async (run: () => Promise<unknown>, foot: Foot | null, leaves = false): Promise<void> => {
      try {
        await run();
        p.onChanged(foot);
        if (leaves) p.onLeft();
      } catch (e) {
        p.onChanged({ text: decideWords(toCourierError(e)) });
      }
    },
    [p],
  );

  if (error && !thread) {
    return (
      <div className="courier-thread courier-center" data-testid="courier-thread">
        <p>{error.code === 'offline' ? W.offline : W.failed}</p>
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="courier-thread courier-center" data-testid="courier-thread" aria-busy="true">
        <p className="courier-quiet">{W.loading}</p>
      </div>
    );
  }

  const messages = [...older.messages, ...thread.messages];
  const title = rowTitle(thread.channel);
  const people = thread.channel.contacts;
  const addresses = people.map((c) => c.endpoint.value).filter((v) => v && !people.some((x) => contactName(x) === v));
  const sender = people[0] ?? null;
  const person = onePerson(people, thread.channel.kind);
  // "Is this also …?" at the top of an endpoint's own conversation (15).
  const ask = person && person.contacts.length === 1 && lane !== 'requests' && lane !== 'spam' && lane !== 'trash' ? suggestionFor(p.suggestions ?? null, person.contacts[0]!.endpoint) : null;
  // Under the name: the endpoint the reply will use, then "and {n} more", a way into the person view.
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in' && m.from && !m.from.me);
  const replyEndpoint = lastIn?.from && !lastIn.from.me ? lastIn.from.endpoint.value : (addresses[0] ?? '');
  const dropping = p.dropping && person && p.dropping.contacts[0]?.contactId !== person.contactId ? p.dropping : null;

  const loadOlder = async (): Promise<void> => {
    if (!older.next) return;
    try {
      const t = await client.thread(channelId, threadLane, older.next);
      if (t) setOlder((o) => ({ messages: [...t.messages, ...o.messages], next: t.next }));
    } catch {
      // Stays as it is; the button stays.
    }
  };

  /** One download into the place the member picks; `true` when the desk wants the danger ask first. */
  const fetchInto = (name: string, run: (put: (bytes: Uint8Array) => Promise<void>) => Promise<{ name: string }>): Promise<boolean> =>
    askWhere(name, false).then(
      async (handle) => {
        if (handle === null) return false;
        const target = await openTarget(handle, name);
        try {
          const d = await run((b) => target.sink.write(b));
          await target.finish();
          p.onChanged({ text: W.downloaded(d.name) });
          return false;
        } catch (e) {
          await target.abort();
          const err = toCourierError(e);
          if (wantsAsk(err)) return true;
          const words = downloadWords(err);
          if (words) p.onChanged({ text: words });
          return false;
        }
      },
      () => {
        p.onChanged({ text: W.failed });
        return false;
      },
    );

  const actions: MessageActions = {
    ...p.links,
    save: (m, a, allowDanger) =>
      client.saveAttachment(m.messageId, a.part, allowDanger).then(
        (r) => p.onChanged({ text: r.already ? W.alreadySaved(r.path) : W.saved(r.path) }),
        (e) => p.onChanged({ text: saveWords(toCourierError(e)) }),
      ),
    // Download: the save picker is asked straight from the press (before anything is awaited), then the bytes come over the
    // desk's own bulk into the chosen file (or the browser's own download), checked end to end before it's kept.
    download: (m, a, allowDanger) => {
      const name = fileNameOf(a.name, 'attachment');
      return fetchInto(name, (put) => client.download(m.messageId, a.part, allowDanger, put));
    },
    downloadRaw: (m, allowDanger) => fetchInto(`${fileNameOf(m.subject, 'message')}.eml`, (put) => client.downloadRaw(m.messageId, allowDanger, put)),
    preview: (m, a, signal) => client.preview(m.messageId, a.part, signal),
    archive: (m, a) => client.archive(m.messageId, a.part),
    markUnread: (m) => void act(() => client.setMessagesRead([m.messageId], false), { text: W.markUnread }),
    remove: (m) => void act(() => client.remove([m.messageId]), { text: `${W.toTrash}: ${m.subject || m.snippet}`, undo: () => void client.moveMessages([m.messageId], 'restore').then(() => p.onChanged(null)) }),
  };

  const who = title;
  const line = lane === 'spam' || lane === 'trash' ? null : memberLine(keys, now);
  const changed = keys.find((k) => k.state === 'changed' && k.newSafetyNumber) ?? null;
  const first = firstName(title);
  const held = keys.reduce((n, k) => n + (k.state === 'changed' ? k.held : 0), 0);
  // A known contact's mail whose sender check failed is in Requests (the coordinator's call, Nov 14): say so, and never offer
  // Block, which would block the real contact's address; Report spam takes its place.
  const forged = lane === 'requests' && !!sender?.known;
  const memberRequest = lane === 'requests' && !forged && sender?.endpoint.kind === 'ma';
  const theirIds = messages.filter((m) => m.direction === 'in').map((m) => m.messageId);
  const bar: ReactNode =
    forged ? (
      <div className="courier-decide" role="group" aria-label={W.forgedHead} data-testid="courier-forged">
        <p>
          <strong>{W.forgedHead}</strong> {W.forgedLine(contactName(sender!))}
        </p>
        <div className="courier-decide-btns">
          <button type="button" className="courier-btn" onClick={() => void act(() => client.decide(channelId, 'let_in'), { text: W.letInDone(who) }, true)}>
            {W.letIn}
          </button>
          <button type="button" className="courier-btn" onClick={() => void act(() => client.decide(channelId, 'not_now'), { text: W.notNowDone(who) }, true)}>
            {W.notNow}
          </button>
          <button type="button" className="courier-btn" onClick={() => void act(() => client.report(theirIds), { text: `${LANE_WORDS.spam}: ${title}`, undo: () => void client.moveMessages(theirIds, 'restore').then(() => p.onChanged(null)) }, true)}>
            {W.reportSpam}
          </button>
        </div>
      </div>
    ) : lane === 'requests' ? (
      <div className="courier-decide" role="group" aria-label={W.requestLine}>
        <p>{W.requestLine}</p>
        <div className="courier-decide-btns">
          <button type="button" className="courier-btn primary" onClick={() => void act(() => client.decide(channelId, 'let_in'), { text: W.letInDone(who) }, true)}>
            {W.letIn}
          </button>
          <button type="button" className="courier-btn" onClick={() => void act(() => client.decide(channelId, 'not_now'), { text: W.notNowDone(who) }, true)}>
            {W.notNow}
          </button>
          <button type="button" className="courier-btn" onClick={() => void act(() => client.decide(channelId, 'block'), { text: W.blockedDone(who) }, true)}>
            {W.block}
          </button>
        </div>
      </div>
    ) : null;

  const menu: MenuItem[] = [];
  if (lane !== 'spam' && lane !== 'trash' && lane !== 'requests') {
    menu.push({ key: 'unread', label: W.markUnread, onPick: () => void act(() => client.setRead(channelId, lane, false), { text: W.markUnread }, true) });
    // Report spam (Wave 3.2): to Spam, the filter taught, and the door told of a confirmed sender. Undo brings it back.
    const theirs = messages.filter((m) => m.direction === 'in').map((m) => m.messageId);
    menu.push({ key: 'spam', label: W.reportSpam, onPick: () => void act(() => (theirs.length ? client.report(theirs) : client.move(channelId, lane, 'spam')), { text: `${LANE_WORDS.spam}: ${title}`, undo: () => void client.move(channelId, 'spam', 'restore').then(() => p.onChanged(null)) }, true) });
    if (person && p.onLinkTo) {
      const onLinkTo = p.onLinkTo;
      menu.push({ key: 'linkto', label: W.linkTo, onPick: () => onLinkTo(title, person.contactId) });
    }
    if (thread.channel.kind === 'direct' && sender) {
      const value = sender.endpoint.value;
      menu.push({ key: 'block', label: W.blockSender, onPick: () => void act(() => client.block('address', value), { text: W.blockedDone(contactName(sender)), undo: () => void client.unblock('address', value).then(() => p.onChanged(null)) }) });
    }
    menu.push({ key: 'trash', label: W.toTrash, onPick: () => void act(() => client.move(channelId, lane, 'trash'), { text: `${W.toTrash}: ${title}`, undo: () => void client.move(channelId, 'trash', 'restore').then(() => p.onChanged(null)) }, true) });
  }

  const mainAction =
    lane === 'spam' ? (
      <button type="button" className="courier-btn" onClick={() => void act(() => client.move(channelId, 'spam', 'restore'), { text: `${W.notSpam}: ${title}` }, true)}>
        {W.notSpam}
      </button>
    ) : lane === 'trash' ? (
      <button type="button" className="courier-btn" onClick={() => void act(() => client.move(channelId, 'trash', 'restore'), { text: `${W.restore}: ${title}` }, true)}>
        {W.restore}
      </button>
    ) : lane === 'requests' ? null : (
      <button type="button" className="courier-btn primary" onClick={() => void act(() => client.done(channelId, lane, true), { text: `${W.done}: ${title}`, undo: () => void client.done(channelId, lane, false).then(() => p.onChanged(null)) }, true)}>
        <Icon name="check" />
        <span>{W.done}</span>
      </button>
    );
  const forever = lane === 'spam' || lane === 'trash';

  return (
    <div className="courier-thread" data-testid="courier-thread" data-channel={channelId}>
      <div
        className="courier-thread-head"
        data-drop={(dropping && dropHere) || undefined}
        onDragOver={
          dropping
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'link';
                setDropHere(true);
              }
            : undefined
        }
        onDragLeave={dropping ? () => setDropHere(false) : undefined}
        onDrop={
          dropping && person
            ? (e) => {
                e.preventDefault();
                setDropHere(false);
                p.onDropPerson?.({ contactId: person.contactId, name: title });
              }
            : undefined
        }
      >
        {p.narrow && (
          <button type="button" className="courier-icon-btn" onClick={p.onBack} aria-label={W.back} title={W.back}>
            <Icon name="back" />
          </button>
        )}
        <div className="courier-thread-title">
          <h2 ref={headRef} tabIndex={-1}>
            {person && p.onOpenPerson ? (
              <button type="button" className="courier-name-btn" onClick={() => p.onOpenPerson?.(person.contactId)} aria-label={W.personOpen(title)}>
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {dropping && dropHere ? (
            <p className="courier-drop-line">{W.dropTo(title)}</p>
          ) : person && person.contacts.length > 1 ? (
            <p className="courier-address">
              {replyEndpoint}{' '}
              <button type="button" className="courier-link-btn" onClick={() => p.onOpenPerson?.(person.contactId)}>
                {W.andMore(person.contacts.length - 1)}
              </button>
            </p>
          ) : line ? (
            <p className="courier-address courier-keyline" data-testid="courier-keyline">
              <Icon name={line.changed ? 'lock' : 'sealed'} />
              <span>
                {MEDIUM_WORDS.ma} ·{' '}
                {line.check && person && p.onOpenPerson ? (
                  <button type="button" className="courier-link-btn" onClick={() => p.onOpenPerson?.(person.contactId)}>
                    {line.state}
                  </button>
                ) : (
                  line.state
                )}
              </span>
            </p>
          ) : (
            addresses.length > 0 && <p className="courier-address">{addresses.slice(0, 4).join(', ')}</p>
          )}
        </div>
        <div className="courier-thread-acts">
          {mainAction}
          {forever && <ConfirmButton label={W.deleteForever} ask={W.deleteForeverAsk} onConfirm={() => void act(() => client.remove(messages.map((m) => m.messageId), true), { text: `${W.deleteForever}: ${title}` }, true)} />}
          {menu.length > 0 && <MenuButton label={W.moreActions} items={menu} />}
        </div>
      </div>
      {bar}
      <div className="courier-pane-body">
      <div className="courier-thread-scroll">
        {ask && p.onLinkSuggestion && p.onNotThem && <SuggestAsk s={ask} onLink={() => p.onLinkSuggestion?.(ask)} onNot={() => p.onNotThem?.(ask)} />}
        {memberRequest && (
          // A member's desk you haven't added (flow 7): Let in trusts its key as it is now (first use), so say so, once.
          <div className="courier-note" role="note" data-testid="courier-member-request">
            <Icon name="sealed" />
            <div>
              <strong>{W.memberRequestHead}</strong>
              <span>{W.memberRequestLine(first)}</span>
            </div>
          </div>
        )}
        {older.next && (
          <button type="button" className="courier-btn quiet courier-earlier" onClick={() => void loadOlder()}>
            {W.earlier}
          </button>
        )}
        <ol className="courier-messages" aria-label={title}>
          {messages.map((m) => (
            <MessageView
              key={m.messageId}
              m={m}
              client={client}
              actions={actions}
              now={now}
              mine={m.direction === 'out'}
              open={openIds.has(m.messageId)}
              highlight={m.messageId === p.focusMessageId}
              onToggle={() =>
                setOpenIds((s) => {
                  const n = new Set(s);
                  if (n.has(m.messageId)) n.delete(m.messageId);
                  else n.add(m.messageId);
                  return n;
                })
              }
            />
          ))}
        </ol>
        {line?.changed && held > 0 && (
          <p className="courier-held" data-testid="courier-held">
            <Icon name="lock" />
            <span>{W.keyHeldIn(held, first)}</span>
          </p>
        )}
        {changed && line && (
          <KeyChanged client={client} address={changed.address} number={changed.newSafetyNumber!} first={first} copy={(t) => p.copy?.(t)} onChanged={(f) => p.onChanged(f)} />
        )}
      </div>
      {p.foot}
      </div>
      {lane !== 'requests' && lane !== 'spam' && lane !== 'trash' && (
        <Composer client={client} channelId={channelId} messages={messages} now={now} title={title} onChanged={p.onChanged} composeRef={p.composeRef} contacts={people} justLinked={!!p.justLinked} onSent={p.onSent} heldFor={line?.changed ? first : null} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the reply

interface ComposerProps {
  client: CourierClient;
  channelId: string;
  messages: Message[];
  now: number;
  title: string;
  onChanged(foot: Foot | null): void;
  composeRef: MutableRefObject<{ focus(): void } | null>;
  contacts?: Contact[];
  justLinked?: boolean;
  onSent?(): void;
  /** A member whose key changed: a private reply can't go until it's checked (flow 6). Their first name. */
  heldFor?: string | null;
}

/** Endpoints a reply by this medium could go to: "to {endpoint}" is said when there are two or more (flow 9). */
const reachedBy = (contacts: Contact[], m: Medium): number => contacts.filter((c) => endpointMedium(c.endpoint) === m || (m === 'sms' && c.endpoint.kind === 'phone')).length;

/**
 * The reply, docked under the conversation: the medium it goes by and why (the last message received's, the plan §1.5), the
 * subject for email, and Send with 10 seconds of Undo. Saved on the desk 2 seconds after the member stops typing, so a reply
 * started on one device can be finished on another; while something typed isn't on the desk yet, closing the tab asks first.
 */
function Composer({ client, channelId, messages, now, title, onChanged, composeRef, contacts = [], justLinked = false, onSent, heldFor = null }: ComposerProps) {
  const pick = replyMedium(messages);
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in') ?? messages[messages.length - 1] ?? null;
  // Nothing yet (an invite's Add): a member's desk is written to privately.
  const medium = pick?.medium ?? (contacts.length > 0 && contacts.every((c) => endpointMedium(c.endpoint) === 'ma') ? 'ma' : 'email');
  // The reply keeps its words and can't go privately while their new key isn't checked.
  const held = medium === 'ma' && heldFor ? heldFor : null;
  const baseSubject = replySubject([...messages].reverse().find((m) => m.subject)?.subject ?? '');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState(baseSubject);
  const [draft, setDraft] = useState<{ draftId: string; version: number } | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'conflict'>('idle');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  const label = W.replyTo(title);
  composeRef.current = { focus: () => area.current?.focus() };

  useCloseHold(dirty && text.trim().length > 0);

  // A reply started on another device (or before a reload) comes back: the desk keeps drafts, saved every 2 seconds.
  useEffect(() => {
    let gone = false;
    void client
      .drafts()
      .then((ds) => {
        const d = ds.filter((x) => x.channelId === channelId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return d ? client.draft(d.draftId) : null;
      })
      .then(
        (d) => {
          if (gone || !d) return;
          setText((t) => (t ? t : d.text));
          if (d.subject) setSubject(d.subject);
          setDraft({ draftId: d.draftId, version: d.version });
          setSaved('saved');
        },
        () => undefined,
      );
    return () => {
      gone = true;
    };
  }, [client, channelId]);

  const save = useCallback(
    async (force = false): Promise<{ draftId: string; version: number } | null> => {
      if (!text.trim() && !draft) return null;
      setSaved('saving');
      try {
        const r = await client.saveDraft({
          draftId: draft?.draftId ?? null,
          channelId,
          medium,
          accountId: lastIn?.accountId ?? null,
          to: lastIn?.from && !lastIn.from.me ? [lastIn.from.endpoint.value] : [],
          ...(medium === 'email' ? { subject } : {}),
          text,
          replyTo: lastIn?.messageId ?? null,
          baseVersion: force ? null : (draft?.version ?? null),
        });
        setDraft(r);
        setSaved('saved');
        setDirty(false);
        return r;
      } catch (e) {
        const err = toCourierError(e);
        setSaved(err.code === 'conflict' && err.reason === 'version' ? 'conflict' : 'idle');
        return null;
      }
    },
    [client, draft, channelId, medium, lastIn, subject, text],
  );

  useEffect(() => {
    if (!dirty) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 2000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [dirty, text, subject, save]);

  const send = async (): Promise<void> => {
    if (!text.trim() || busy || held) return;
    setBusy(true);
    setProblem(null);
    try {
      const d = await save(saved === 'conflict');
      if (!d) throw new Error('draft');
      const sent = await client.send(d.draftId);
      // A message sent: a completed action (the focus shield's fine break, once 5 s pass with no input after it).
      noteFocusEvent('sent');
      onSent?.();
      const kept = { text, subject };
      setText('');
      setDraft(null);
      setSaved('idle');
      setDirty(false);
      onChanged({
        text: W.sentUndo,
        ms: Math.max(1000, sent.undoUntil - Date.now()),
        undo: () =>
          void client.undoSend(sent.outboundId).then(
            (draftId) => {
              setText(kept.text);
              setSubject(kept.subject);
              if (draftId) void client.draft(draftId).then((d) => d && setDraft({ draftId: d.draftId, version: d.version }), () => undefined);
              onChanged({ text: W.undone });
              area.current?.focus();
            },
            () => onChanged({ text: W.tooLate }),
          ),
      });
    } catch (e) {
      const err = toCourierError(e);
      setProblem(
        err.code === 'unavailable' && err.reason === 'medium'
          ? W.cantSendMedium
          : err.code === 'unavailable' && err.reason === 'switched_off'
            ? W.cantSendOff
            : err.code === 'forbidden' && err.reason === 'blocked'
              ? W.cantSendBlocked
              : err.code === 'offline'
                ? W.offline
                : W.failed,
      );
    } finally {
      setBusy(false);
    }
  };

  // The first send after a link, or a person with two endpoints of this medium: the line names where it goes, so a wrong link
  // shows before anything goes to the wrong person (flow 11).
  const to = lastIn?.from && !lastIn.from.me && (justLinked || reachedBy(contacts, medium) > 1) ? lastIn.from.endpoint.value : null;
  const why = held ? W.byMedium(medium, W.keyHeldChip(held)) : pick ? W.byMedium(medium, W.lastWas(medium, ago(pick.at, now)), to) : '';
  return (
    <form
      className="courier-compose"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {why && <p className="courier-compose-why">{why}</p>}
      {medium === 'email' && (
        <label className="courier-compose-subject">
          <span className="courier-sr">{W.subject}</span>
          <input
            type="text"
            value={subject}
            maxLength={300}
            placeholder={W.subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setDirty(true);
            }}
          />
        </label>
      )}
      <div className="courier-compose-row">
        <label className="courier-compose-text">
          <span className="courier-sr">{label}</span>
          <textarea
            ref={area}
            value={text}
            rows={2}
            placeholder={W.write}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </label>
        <button type="submit" className="courier-btn primary" disabled={!text.trim() || busy || !!held}>
          {W.send}
        </button>
      </div>
      <div className="courier-compose-foot">
        <span className="courier-quiet" aria-live="polite">
          {held && text.trim() ? W.keyDraftKept : saved === 'saving' ? W.draftSaving : saved === 'saved' ? W.draftSaved : saved === 'conflict' ? W.draftConflict : ''}
        </span>
        {draft && (
          <button
            type="button"
            className="courier-btn quiet"
            onClick={() => {
              const id = draft.draftId;
              setText('');
              setDraft(null);
              setDirty(false);
              setSaved('idle');
              void client.discardDraft(id).catch(() => undefined);
            }}
          >
            {W.discard}
          </button>
        )}
      </div>
      {problem && (
        <p className="courier-note" role="alert">
          <Icon name="info" />
          <span>{problem}</span>
          {problem === W.cantSendBlocked && lastIn?.from && !lastIn.from.me && (
            <button
              type="button"
              className="courier-btn"
              onClick={() => {
                const value = lastIn.from && !lastIn.from.me ? lastIn.from.endpoint.value : '';
                void client.unblock('address', value).then(
                  () => {
                    setProblem(null);
                    onChanged({ text: W.unblocked(value) });
                  },
                  () => onChanged({ text: W.failed }),
                );
              }}
            >
              {W.unblock}
            </button>
          )}
        </p>
      )}
    </form>
  );
}
