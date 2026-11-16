// The viewer, inside the Documents window (the concept's §8.1 and §8.2; deskd API.md §25): a PDF's pages drawn by the desk's
// sandbox and sent as pictures over `bulk`, fetched only as they scroll into view, paper white in every theme, the lines that
// changed marked in the accent blue; a picture drawn again from its pixels; an Office file or text as a clean reading view of
// its text. Only pictures and plain text ever reach the browser: never the file itself, never markup, never anything that runs.
// A danger type is never drawn. Every word the desk sends is shown as text.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HostShell } from '../../agent/AgentWindow';
import { useDeskLink } from '../../desk/liveStore';
import { askAgent, docTextFile, useAskableAgents } from '../../agent/ask';
import { AskAgent } from './AskAgent';
import { chooseImageCheck } from '../../platform/imageCheckClient';
import type { ImageCheck } from '../../platform/imageCheck';
import { useLayoutPrefs } from '../../shell/layoutPrefs';
import { setLayoutPref } from '../../shell/layoutSync';
import { engineFor } from '../files/engines';
import { askWhere } from '../files/save';
import { toDocsError, type DocsClient, type DocsError } from './client';
import { CHIP_WORDS, downloadPath, noteFor, openingPage, pageForKey, pageInView, pageWidth } from './model';
import { PageImages } from './pages';
import type { Changes, Chip, Doc, DocDetail, DocText } from './types';
import { pageList, versionDate, W } from './words';

/**
 * The layout prefs that remember a first-time line was read (§13.2's "Got it", §8.2's sheet). The ask's sheet is the agent's
 * since Nov 15 (its own key, `docsAskAgentNoted`): what it says is new, so a member who read Maia's reads this one once.
 */
export const SUMMARY_NOTED = 'docsSummaryNoted';
export const ASK_NOTED = 'docsAskAgentNoted';

type Panel = 'changes' | 'versions' | 'copies' | null;
type Trouble = 'danger' | 'sandbox' | 'offline' | 'gone' | 'error' | null;

export interface ViewerProps {
  deskId: string;
  client: DocsClient | null;
  docId: string;
  askedPage: number | null;
  withChanges: boolean;
  offline: boolean;
  phone: boolean;
  /** Desk Maia is on: her reader's lines show. Asking is the desk's agents' (`useAskableAgents`), whatever this says. */
  maiaOn: boolean;
  /** The desk's last word that documents changed (the `docs` topic): this one's summary may have come. */
  changed: { ids: string[] | null; n: number };
  shell: HostShell;
  onClose(): void;
  say(text: string, undo?: () => void): void;
  onTap(deskId: string, doc: Doc, chip: Chip): void;
  /**
   * Inside another surface (a paper in Maia's decision tray): the page, "Read as text" and "What changed" only; no back button,
   * file name, her summary or its first-time note, and no phone bar (the host has its own foot).
   */
  compact?: boolean;
}

/** A changed line's box with a little air round it (0.6 % of the width, 0.3 % of the height), kept on the page. */
function markBox([x, y, w, h]: [number, number, number, number]): { left: string; top: string; width: string; height: string } {
  const l = Math.max(0, x - 0.006);
  const t = Math.max(0, y - 0.003);
  const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;
  return { left: pct(l), top: pct(t), width: pct(Math.min(1 - l, w + 0.012)), height: pct(Math.min(1 - t, h + 0.006)) };
}

const troubleOf = (e: DocsError): Trouble => (e.code === 'danger' ? 'danger' : e.code === 'sandbox' || e.code === 'paused' ? 'sandbox' : e.code === 'offline' ? 'offline' : e.code === 'gone' ? 'gone' : 'error');

/** Her small mark before her line: a quiet accent dot, never a star or sparkle (§13.2). */
function HerLine({ text, label }: { text: string; label: string }) {
  return (
    <p className="docs-her">
      <span className="docs-her-mark" aria-hidden="true" />
      <span className="sr-only">{label} </span>
      <i>{text}</i>
    </p>
  );
}

function ReadingView({ text, changedParagraphs }: { text: DocText; changedParagraphs: ReadonlySet<number> }) {
  if (text.sections.length) {
    let slide = 0;
    return (
      <article className="docs-reading" aria-label={W.readAsText}>
        {text.sections.map((s, i) => {
          const cls = changedParagraphs.has(i) ? 'docs-changed' : undefined;
          if (s.kind === 'h') return <h3 key={i} className={cls}>{s.text}</h3>;
          if (s.kind === 'slide') {
            slide += 1;
            return (
              <section key={i} className={`docs-slide${cls ? ` ${cls}` : ''}`} aria-label={`Slide ${slide}`}>
                <p className="docs-slide-n" aria-hidden="true">{slide}</p>
                <p>{s.text}</p>
              </section>
            );
          }
          if ((s.kind === 'table' || s.kind === 'sheet') && s.rows?.length) {
            return (
              <div key={i} className={`docs-table-wrap${cls ? ` ${cls}` : ''}`} tabIndex={0} role="region" aria-label={s.text || (s.kind === 'sheet' ? 'Sheet' : 'Table')}>
                <table className="docs-table">
                  <tbody>
                    {s.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => (
                          <td key={ci}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          return <p key={i} className={cls}>{s.text}</p>;
        })}
      </article>
    );
  }
  return (
    <article className="docs-reading" aria-label={W.readAsText}>
      {text.pages.map((p) => (
        <section key={p.n} className="docs-text-page" aria-label={`Page ${p.n}`} data-page={p.n}>
          {text.pages.length > 1 && <p className="docs-text-n" aria-hidden="true">{p.n}</p>}
          <p className="docs-pre">{p.text}</p>
        </section>
      ))}
      {!text.pages.length && <p>{W.noText}</p>}
    </article>
  );
}

export function Viewer({ deskId, client, docId, askedPage, withChanges, offline, phone, changed, shell, onClose, say, onTap, compact = false }: ViewerProps) {
  const link = useDeskLink(deskId);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [trouble, setTrouble] = useState<Trouble>(null);
  const [text, setText] = useState<DocText | null>(null);
  const [asText, setAsText] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [showName, setShowName] = useState(false);
  const [current, setCurrent] = useState(1);
  const [restoreAsk, setRestoreAsk] = useState<string | null>(null);
  // The first-time sheet, for the agent that was asked.
  const [askSheet, setAskSheet] = useState<string | null>(null);
  const agents = useAskableAgents(deskId);
  const [reading, setReading] = useState<'idle' | 'asked' | 'failed'>('idle');
  const [moreOpen, setMoreOpen] = useState(false);
  const [, setDrawn] = useState(0);
  const [imageCheck, setImageCheck] = useState<ImageCheck | null>(null);
  const summaryNoted = useLayoutPrefs((s) => s[SUMMARY_NOTED] === true);
  const askNoted = useLayoutPrefs((s) => s[ASK_NOTED] === true);
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const images = useRef<PageImages | null>(null);
  const ratios = useRef(new Map<number, number>());
  const opened = useRef<{ at: number; page: number; changedPages: number[] } | null>(null);
  const scrolledTo = useRef(false);
  /** The page the viewer last went to, and the width it was laid out at: kept in place until the member scrolls. */
  const pinned = useRef<{ page: number; width: number } | null>(null);
  const currentRef = useRef(1);
  currentRef.current = current;

  const doc = detail?.doc ?? null;
  const drawn = doc ? (doc.type === 'pdf' || doc.type === 'image') && !doc.danger : false;
  const count = images.current?.first()?.pageCount ?? doc?.pageCount ?? 1;

  // ---- the document itself, read again when the desk says it changed (a summary that came, a new version)
  const load = useCallback(async (): Promise<void> => {
    if (!client) return;
    try {
      const d = await client.get(docId);
      setDetail(d);
      if (d.doc.danger) setTrouble('danger');
    } catch (e) {
      setTrouble(troubleOf(toDocsError(e)));
    }
  }, [client, docId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!changed.n || !detail) return;
    if (changed.ids === null || changed.ids.includes(docId)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed.n]);

  // ---- opened: where it opens, and the desk told (`docs.seen` on open and on leaving)
  useEffect(() => {
    if (!doc || opened.current || !client) return;
    const page = openingPage(askedPage ?? (withChanges ? (doc.changedPages[0] ?? null) : null), doc.lastPage, doc.pageCount);
    opened.current = { at: Date.now(), page, changedPages: doc.changedPages };
    setCurrent(page);
    if (!doc.danger) void client.seen(doc.id, page, 0);
  }, [doc, client, askedPage, withChanges]);

  useEffect(
    () => () => {
      const o = opened.current;
      if (o && client && !detail?.doc.danger) void client.seen(docId, currentRef.current, Date.now() - o.at);
    },
    // Once, on leaving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- the text: the reading view of an Office file or text, a PDF's text layer for screen readers and "Read as text"
  const needText = !!doc && !doc.danger;
  useEffect(() => {
    if (!needText || !client) return;
    let live = true;
    client.text(docId).then(
      (t) => live && setText(t),
      (e: unknown) => {
        if (!live) return;
        const err = toDocsError(e);
        // A PDF can be drawn without its text; an Office file is its text.
        if (doc && !drawn) setTrouble(troubleOf(err));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needText, client, docId]);

  // ---- page images, as pages come into view
  useEffect(() => {
    if (!drawn || !client) return;
    const width = (): number => {
      const frame = scroller.current?.querySelector<HTMLElement>('.docs-page');
      return pageWidth(frame?.clientWidth || scroller.current?.clientWidth || 800, window.devicePixelRatio || 1);
    };
    const imgs = new PageImages(client, docId, width, () => setDrawn((n) => n + 1), (e) => setTrouble(troubleOf(e)));
    images.current = imgs;
    return () => {
      imgs.close();
      if (images.current === imgs) images.current = null;
    };
  }, [drawn, client, docId]);

  // Back online: try again.
  useEffect(() => {
    if (!offline && trouble === 'offline') {
      setTrouble(null);
      images.current?.retry();
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  const showPages = drawn && !asText && !trouble;
  useEffect(() => {
    const box = scroller.current;
    if (!showPages || !box || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const n = Number((en.target as HTMLElement).dataset['page']);
          if (!n) continue;
          ratios.current.set(n, en.isIntersecting ? en.intersectionRatio : 0);
          if (en.isIntersecting) {
            images.current?.want(n);
            if (n < count) images.current?.want(n + 1);
          }
        }
        if (scrolledTo.current) setCurrent((c) => pageInView(ratios.current, c));
      },
      { root: box, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of box.querySelectorAll('.docs-page')) io.observe(el);
    return () => io.disconnect();
  }, [showPages, count]);

  const scrollToPage = useCallback(
    (n: number, smooth = false): void => {
      const box = scroller.current;
      const el = box?.querySelector<HTMLElement>(`.docs-page[data-page="${n}"], .docs-text-page[data-page="${n}"]`);
      if (!box || !el) return;
      // The pages' own padding stays as a gutter above (or, on a phone, beside) the page.
      const at = phone && !asText ? { left: Math.max(0, el.offsetLeft - 12) } : { top: Math.max(0, el.offsetTop - 12) };
      box.scrollTo({ ...at, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
      pinned.current = { page: n, width: box.clientWidth };
      setCurrent(n);
      images.current?.want(n);
    },
    [phone, asText],
  );

  // A page keeps its place when the viewer's width changes (Maia's viewport settling, a window resized): every page above it
  // changes height with the width, so the page the viewer last went to is put back at the top, until the member scrolls.
  useEffect(() => {
    const box = scroller.current;
    if (!showPages || !box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const pin = pinned.current;
      if (pin && Math.abs(box.clientWidth - pin.width) >= 1) scrollToPage(pin.page);
    });
    ro.observe(box);
    const mine = (): void => void (pinned.current = null);
    box.addEventListener('wheel', mine, { passive: true });
    box.addEventListener('touchstart', mine, { passive: true });
    box.addEventListener('pointerdown', mine);
    return () => {
      ro.disconnect();
      box.removeEventListener('wheel', mine);
      box.removeEventListener('touchstart', mine);
      box.removeEventListener('pointerdown', mine);
    };
  }, [showPages, scrollToPage]);

  // The opening page, once its frame is laid out.
  useLayoutEffect(() => {
    if (!showPages || scrolledTo.current || !opened.current) return;
    scrolledTo.current = true;
    scrollToPage(opened.current.page);
  });

  // ---- What changed
  const openChanges = useCallback(async (): Promise<void> => {
    setPanel('changes');
    if (!client) return;
    try {
      const c = await client.changes(docId);
      setChanges(c);
      if (c.pages[0]) scrollToPage(c.pages[0], true);
    } catch (e) {
      setChanges({ pages: [], line: toDocsError(e).code === 'danger' ? W.danger : W.failed, changeLine: null, paragraphs: [] });
    }
  }, [client, docId, scrollToPage]);

  const askedChanges = useRef(false);
  useEffect(() => {
    if (withChanges && doc && !doc.danger && !askedChanges.current) {
      askedChanges.current = true;
      void openChanges();
    }
  }, [withChanges, doc, openChanges]);

  // ---- Download: only a copy in Files, never a danger type (Files' own download, its engine and its tray)
  const dlPath = detail && doc ? downloadPath(doc, detail.copies) : null;
  useEffect(() => {
    if (!dlPath) return;
    let live = true;
    void chooseImageCheck(shell.api).then((c) => live && setImageCheck(c));
    return () => {
      live = false;
    };
  }, [dlPath, shell.api]);
  const download = (): void => {
    if (!dlPath || !link || !imageCheck || !doc) return;
    const name = dlPath.slice(dlPath.lastIndexOf('/') + 1);
    // The save picker has to be asked from the click itself, before anything is awaited (Files' rule).
    const pick = askWhere(name, false);
    void pick.then(
      (handle) => {
        if (handle === null) return;
        engineFor(deskId, link, imageCheck, shell).engine.download({ path: dlPath, name, folder: false, size: doc.size, mtimeMs: doc.changedAt }, handle);
        shell.announce(`Downloading ${name}`);
      },
      () => say(W.failed),
    );
  };

  // ---- What's this? and Ask Maia about this
  const whatsThis = async (): Promise<void> => {
    if (!client) return;
    setReading('asked');
    try {
      await client.read(docId);
    } catch {
      setReading('failed');
    }
  };
  useEffect(() => {
    if (doc?.summary?.line) setReading('idle');
  }, [doc?.summary?.line]);

  // The desk's agent reads the document as a file in its composer: its text (a picture: page 1 as drawn), which the member sees
  // and can take off before sending. Nothing goes until they send; it answers in its own thread.
  const ask = async (agentId: string): Promise<void> => {
    if (!client || !doc) return;
    setAskSheet(null);
    if (!askNoted) setLayoutPref({ [ASK_NOTED]: true });
    let file: File | null = null;
    try {
      if (doc.type === 'image') {
        const { blob } = await client.page(doc.id, 1, 1200);
        const base = (doc.title.replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Picture');
        file = new File([blob], `${base}.png`, { type: blob.type || 'image/png' });
      } else {
        file = docTextFile(doc.title, await client.text(doc.id));
      }
    } catch {
      // The question still goes to the agent's composer, without the document.
    }
    if (!askAgent(deskId, agentId, W.askAboutDraft(doc.title), file)) say(W.askNoWindow);
  };
  const askAbout = (agentId: string): void => (askNoted ? void ask(agentId) : setAskSheet(agentId));
  const askName = (agentId: string | null): string => agents.find((a) => a.id === agentId)?.name ?? agents[0]?.name ?? '';

  // ---- Versions
  const restore = async (versionId: string): Promise<void> => {
    setRestoreAsk(null);
    if (!client) return;
    try {
      const t = await client.restore(docId, versionId);
      if (t) say(t.text, t.undo ? () => void client.undo(t.undo!).then(() => load(), () => say(W.failed)) : undefined);
      void load();
    } catch {
      say(W.failed);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (askSheet) setAskSheet(null);
      else if (moreOpen) setMoreOpen(false);
      else if (restoreAsk) setRestoreAsk(null);
      else if (panel) setPanel(null);
      else onClose();
      return;
    }
    if (!showPages) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    const next = pageForKey(e.key, current, count);
    if (next === null) return;
    e.preventDefault();
    scrollToPage(next);
  };

  const changedParagraphs = useMemo(() => new Set(changes?.paragraphs ?? []), [changes]);
  const note = doc ? noteFor(doc, true) : null;
  const firstChanged = opened.current?.changedPages ?? doc?.changedPages ?? [];
  const pagesText = text?.pages ?? [];
  const versionsOn = (detail?.versions.length ?? 0) > 1;
  const copiesOn = !!detail?.copiesText || (doc?.copies ?? 0) > 1 || (detail?.alsoIn.length ?? 0) > 0;
  const changesOn = !!doc && (doc.versions > 1 || firstChanged.length > 0);
  const whatsOn = !!doc && !doc.summary && !doc.danger && !doc.sensitive;
  const askOn = agents.length > 0 && !!doc && !doc.danger;

  const head = (
    <header className="docs-vhead">
      {!compact && (
        <button type="button" className="docs-back" onClick={onClose} aria-label={`Back to ${W.back}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="docs-i">
            <path d="M14.5 6.5 9 12l5.5 5.5" />
          </svg>
          {!phone && <span>{W.back}</span>}
        </button>
      )}
      <div className="docs-vtitle">
        <h2 className="docs-vh">{doc?.title ?? ''}</h2>
        {doc && (
          <p className="docs-vmeta">
            {doc.from?.name && <span>{doc.from.name}</span>}
            {!compact && (
              <button type="button" className="docs-link" aria-pressed={showName} onClick={() => setShowName(!showName)}>
                {W.fileName}
              </button>
            )}
            {drawn && !trouble && <span data-testid="docs-page-of">{W.page(current, count)}</span>}
          </p>
        )}
        {doc && showName && <p className="docs-orig">{doc.origName}</p>}
      </div>
    </header>
  );

  const tools = doc && !doc.danger && (
    <div className="docs-tools" role="toolbar" aria-label={doc.title}>
      {drawn && doc.type === 'pdf' && (
        <button type="button" className="docs-tool" aria-pressed={asText} onClick={() => setAsText(!asText)}>
          {W.readAsText}
        </button>
      )}
      {changesOn && (
        <button type="button" className="docs-tool" aria-expanded={panel === 'changes'} onClick={() => (panel === 'changes' ? setPanel(null) : void openChanges())}>
          {W.whatChanged}
        </button>
      )}
      {!compact && versionsOn && (
        <button type="button" className="docs-tool" aria-expanded={panel === 'versions'} onClick={() => setPanel(panel === 'versions' ? null : 'versions')}>
          {W.versions}
        </button>
      )}
      {!compact && copiesOn && (
        <button type="button" className="docs-tool" aria-expanded={panel === 'copies'} onClick={() => setPanel(panel === 'copies' ? null : 'copies')}>
          {W.copies}
        </button>
      )}
      {!compact && whatsOn && reading === 'idle' && (
        <button type="button" className="docs-tool" onClick={() => void whatsThis()}>
          {W.whatsThis}
        </button>
      )}
      {!compact && askOn && <AskAgent agents={agents} label={W.askAbout} className="docs-tool" onAsk={askAbout} />}
      {!compact && dlPath && (
        <button type="button" className="docs-tool" disabled={!imageCheck || offline} onClick={download}>
          {W.download}
        </button>
      )}
    </div>
  );

  const panelBody =
    doc && panel === 'changes' ? (
      <section className="docs-panel" aria-label={W.whatChanged}>
        {changes ? (
          <>
            <p className="docs-panel-line">{changes.line}</p>
            {changes.changeLine && <HerLine text={changes.changeLine} label={W.maiaNote} />}
          </>
        ) : (
          <p className="docs-panel-line docs-quiet">…</p>
        )}
      </section>
    ) : doc && panel === 'versions' && detail ? (
      <section className="docs-panel" aria-label={W.versions}>
        <ul className="docs-versions">
          {detail.versions.map((v) => (
            <li key={v.id}>
              <span className="docs-v-what">{v.milestoneText ?? (v.current ? W.current : versionDate(v.at))}</span>
              <span className="docs-v-meta">
                {[v.byName ?? '', versionDate(v.at)].filter(Boolean).join(' · ')}
              </span>
              {v.current ? (
                <span className="docs-v-now">{W.current}</span>
              ) : v.restorable && restoreAsk === v.id ? (
                <span className="docs-confirm" role="group" aria-label={W.restoreAsk}>
                  <span>{W.restoreAsk}</span>
                  <button type="button" className="docs-btn primary" onClick={() => void restore(v.id)}>
                    {W.restore}
                  </button>
                  <button type="button" className="docs-btn" onClick={() => setRestoreAsk(null)}>
                    {W.cancel}
                  </button>
                </span>
              ) : v.restorable ? (
                <button type="button" className="docs-btn" aria-label={`${W.restore}: ${v.milestoneText ?? versionDate(v.at)}`} onClick={() => setRestoreAsk(v.id)}>
                  {W.restore}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    ) : doc && panel === 'copies' && detail ? (
      <section className="docs-panel" aria-label={W.copies}>
        {detail.copiesText && <p className="docs-panel-line">{detail.copiesText}</p>}
        {detail.alsoIn.length > 0 && (
          <p className="docs-also">
            {W.alsoIn}: {detail.alsoIn.map((l) => l.label).join(' · ')}
          </p>
        )}
        <ul className="docs-copies">
          {detail.copies
            .filter((c) => !c.gone)
            .map((c) => (
              <li key={c.id}>
                <span>{c.label}</span>
                <span className="docs-v-meta">{versionDate(c.arrivedAt)}</span>
              </li>
            ))}
        </ul>
      </section>
    ) : null;

  let body;
  if (offline && !detail) body = <p className="docs-state" role="status">{W.offline}</p>;
  else if (trouble === 'danger' && doc) body = <p className="docs-state docs-danger" role="status" data-testid="docs-danger">{doc.reason.text || `${doc.danger ?? 'File'}. ${W.danger}`}</p>;
  else if (trouble === 'danger') body = <p className="docs-state docs-danger" role="status" data-testid="docs-danger">{W.danger}</p>;
  else if (trouble === 'sandbox') body = <p className="docs-state" role="status" data-testid="docs-sandbox">{W.sandbox}</p>;
  else if (trouble === 'offline') body = <p className="docs-state" role="status">{W.offline}</p>;
  else if (trouble === 'gone') body = <p className="docs-state" role="status">{W.gone}</p>;
  else if (trouble === 'error') body = <p className="docs-state" role="status">{W.failed}</p>;
  else if (!doc) body = null;
  else if (showPages) {
    const shape = images.current?.first();
    const ratio = shape ? `${shape.width} / ${shape.height}` : '1 / 1.4142';
    body = (
      <div className="docs-pages" ref={scroller} tabIndex={0} role="region" aria-label={W.pages} data-testid="docs-pages">
        {Array.from({ length: count }, (_, i) => {
          const n = i + 1;
          const img = images.current?.get(n) ?? null;
          const marks = img?.head.lines.filter((l) => l.changed) ?? [];
          const words = pagesText.find((p) => p.n === n)?.text ?? '';
          return (
            <figure key={n} className="docs-page" data-page={n} data-ready={!!img} role="group" aria-label={`Page ${n}`} style={{ aspectRatio: img ? `${img.head.width} / ${img.head.height}` : ratio }}>
              {img && <img src={img.url} alt={doc.type === 'image' ? doc.title : ''} draggable={false} />}
              {marks.map((l, k) => (
                <i key={k} className="docs-mark" data-testid="docs-mark" style={markBox(l.b)} />
              ))}
              {marks.length > 0 && <span className="sr-only">{W.changedHere}</span>}
              {words && <span className="sr-only">{words}</span>}
              {images.current?.isFailed(n) && (
                <button type="button" className="docs-btn docs-page-retry" onClick={() => images.current?.retry()}>
                  {W.tryAgain}
                </button>
              )}
            </figure>
          );
        })}
      </div>
    );
  } else if (text) body = <div className="docs-reading-scroll" ref={scroller} tabIndex={0} role="region" aria-label={W.readAsText}><ReadingView text={text} changedParagraphs={changedParagraphs} /></div>;
  else body = null;

  return (
    <div className="docs-viewer" ref={root} data-testid="docs-viewer" data-phone={phone || undefined} data-doc={docId} onKeyDown={onKeyDown}>
      {head}
      {(!phone || compact) && tools}
      {doc && ((note && !compact) || firstChanged.length > 0 || reading !== 'idle') && (
        <div className="docs-lines">
          {!compact && note && note.kind === 'summary' && <HerLine text={note.text} label={W.maiaNote} />}
          {!compact && note && note.kind === 'summary' && !summaryNoted && (
            <p className="docs-first">
              <span>{W.summaryFirst}</span>
              <button type="button" className="docs-link" onClick={() => setLayoutPref({ [SUMMARY_NOTED]: true })}>
                {W.gotIt}
              </button>
            </p>
          )}
          {reading === 'asked' && !note && <p className="docs-quiet" role="status">{W.reading}</p>}
          {reading === 'failed' && <p className="docs-quiet" role="status">{W.readFailed}</p>}
          {firstChanged.length > 0 && panel !== 'changes' && (
            <p className="docs-changed-line">
              <span>{W.changedSince(pageList(firstChanged))}</span>
              <button type="button" className="docs-link" onClick={() => void openChanges()}>
                {W.showChanges}
              </button>
            </p>
          )}
        </div>
      )}
      {panelBody}
      {askSheet && doc && (
        <div className="docs-sheet" role="dialog" aria-modal="false" aria-label={W.askAbout(askName(askSheet))}>
          <p>{W.askFirst(askName(askSheet))}</p>
          <div className="docs-sheet-acts">
            <button type="button" className="docs-btn primary" autoFocus onClick={() => void ask(askSheet)}>
              {W.ask}
            </button>
            <button type="button" className="docs-btn" onClick={() => setAskSheet(null)}>
              {W.notNow}
            </button>
          </div>
        </div>
      )}
      <div className="docs-vbody">{body}</div>
      {phone && !compact && doc && !doc.danger && (
        <nav className="docs-bar" aria-label={doc.title}>
          <button type="button" className="docs-bar-btn" disabled={!changesOn} onClick={() => (panel === 'changes' ? setPanel(null) : void openChanges())}>
            {W.whatChanged}
          </button>
          {askOn && <AskAgent agents={agents} label={W.askAgent} className="docs-bar-btn" onAsk={askAbout} up />}
          <button type="button" className="docs-bar-btn" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            {W.more}
          </button>
          {moreOpen && (
            <div className="docs-more" role="menu" aria-label={W.more}>
              {dlPath && (
                <button type="button" role="menuitem" disabled={!imageCheck || offline} onClick={() => (setMoreOpen(false), download())}>
                  {W.download}
                </button>
              )}
              {versionsOn && (
                <button type="button" role="menuitem" onClick={() => (setMoreOpen(false), setPanel('versions'))}>
                  {W.versions}
                </button>
              )}
              {copiesOn && (
                <button type="button" role="menuitem" onClick={() => (setMoreOpen(false), setPanel('copies'))}>
                  {W.copies}
                </button>
              )}
              {drawn && doc.type === 'pdf' && (
                <button type="button" role="menuitem" onClick={() => (setMoreOpen(false), setAsText(!asText))}>
                  {asText ? W.showPages : W.readAsText}
                </button>
              )}
              {(['not_important', 'done'] as const).map((c) => (
                <button key={c} type="button" role="menuitem" onClick={() => (setMoreOpen(false), onTap(deskId, doc, c))}>
                  {CHIP_WORDS[c]}
                </button>
              ))}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
