// From answers to what the office sets up (CONCEPT.md §5, §3.1's callbacks, §12's setup notes). Pure: the words come from the
// app's templates, never from the model ("Don't put any of Maia's text in the card"); the model's plan only says which ids and
// names a custom helper, and is checked again here. `plan.test.ts` covers it.
import { CATCH_UPS, CUSTOM_APPS, HELPERS, ONE_LINE_PURPOSE, QUESTIONS, SCENES, labelsOf, type HelperTemplate, type QId } from './catalogue';
import { onlyKnown, resolved, type Answer, type Who } from './flow';
import { asksSecret } from './secret';

export interface OwnDesk {
  id: string;
  kind: string;
  name: string;
}

/** Where each template lives (§5.2): Work with two desks, else the one; Personal; the home desk is Personal, else the one. */
export function deskFor(where: HelperTemplate['desk'], desks: readonly OwnDesk[]): OwnDesk | null {
  const personal = desks.find((d) => d.kind === 'personal') ?? null;
  const work = desks.find((d) => d.kind === 'work') ?? null;
  const one = desks[0] ?? null;
  if (where === 'work') return work ?? one;
  return personal ?? one;
}

export interface Helper {
  template: HelperTemplate['id'] | 'custom';
  name: string;
  deskId: string;
  deskName: string;
  purpose: string;
  apps: HelperTemplate['apps'];
}

/** A custom helper from the model (§5.2's last row), checked: plain, short, a desk it can be on. */
export interface ModelHelper {
  name: string;
  desk: 'work' | 'personal';
  purpose: string;
}

const PLAIN = /^[\p{L}\p{N} .,'’&()/-]+$/u;
/** A link or an address in the model's words (Security's WEL-4): `example.com`, `www.`, `@`. */
const LINK = /\b[\p{L}\p{N}-]+\.(?:com|net|org|io|ai|co|app|dev|me|info|xyz|[a-z]{2})\b|www\.|@/iu;
/** Words that would make a helper promise or always act: the template's purposes never do. */
const PROMISE = /\b(?:always|never|guarantee|promise|must|ignore|instructions?)\b/i;
export function checkHelper(h: unknown, member: string | null = null): ModelHelper | null {
  if (!h || typeof h !== 'object') return null;
  const o = h as Record<string, unknown>;
  const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
  const purpose = typeof o['purpose'] === 'string' ? o['purpose'].trim() : '';
  const desk = o['desk'] === 'work' || o['desk'] === 'personal' ? o['desk'] : null;
  if (!desk || !name || name.length > 24 || !purpose || purpose.length > 140) return null;
  if (!PLAIN.test(name) || !PLAIN.test(purpose) || /maia mode/i.test(name + purpose)) return null;
  const both = `${name} ${purpose}`;
  if (LINK.test(both) || PROMISE.test(both) || asksSecret(both) || (member && both.toLowerCase().includes(member.toLowerCase()))) return null;
  return { name, desk, purpose };
}

/** The helpers Q3 sets up (at most 3), in the order picked; a custom one only from the model and only with room left. */
export function helpersFrom(q3: readonly string[], custom: ModelHelper | null, desks: readonly OwnDesk[], detail: string | undefined): Helper[] {
  const out: Helper[] = [];
  const suffix = detail === 'line' ? ` ${ONE_LINE_PURPOSE}` : '';
  for (const id of q3) {
    const t = HELPERS[id as HelperTemplate['id']];
    const desk = t ? deskFor(t.desk, desks) : null;
    if (!t || !desk || out.length >= 3) continue;
    out.push({ template: t.id, name: t.name, deskId: desk.id, deskName: desk.name, purpose: (t.purpose + suffix).slice(0, 280), apps: { ...t.apps } });
  }
  if (custom && out.length < 3 && !out.some((h) => h.name.toLowerCase() === custom.name.toLowerCase())) {
    const desk = deskFor(custom.desk, desks);
    if (desk) out.push({ template: 'custom', name: custom.name, deskId: desk.id, deskName: desk.name, purpose: (custom.purpose + suffix).slice(0, 280), apps: { ...CUSTOM_APPS } });
  }
  return out;
}

/** One line of "Here's what I heard" (§2 beat 6): the answer as what it sets, and the question to re-ask on a tap. */
export interface HeardLine {
  q: QId;
  title: string;
  sets: string;
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function heardLines(set: readonly QId[], answers: Readonly<Record<string, Answer>>, r: Partial<Record<QId, string[]>>, helpers: readonly Helper[], who: Who, scene: string | null): HeardLine[] {
  const out: HeardLine[] = [];
  const own = (q: QId): string | null => answers[q]?.text ?? null;
  for (const q of set) {
    const ids = r[q] ?? [];
    const labels = labelsOf(QUESTIONS[q], ids);
    const words = own(q);
    const said = labels.length ? list(labels.map((l, i) => (i ? lower(l) : l))) : words ? `“${short(words)}”` : 'Skipped';
    switch (q) {
      case 'q1': {
        const sceneName = ids[0] === 'zen' ? SCENES.find((s) => s.id === scene)?.label : null;
        out.push({ q, title: sceneName ? `${said}, ${sceneName}` : said, sets: 'Your office’s light' });
        break;
      }
      case 'q2':
        out.push({ q, title: said, sets: 'What I bring you first' });
        break;
      case 'q3':
        {
          // A helper named from their words shows what it's for, so "Looks right" approves it (Security's WEL-1, WEL-4).
          const custom = helpers.find((h) => h.template === 'custom');
          out.push({
            q,
            title: helpers.length ? `Helpers: ${list(helpers.map((h) => h.name))}` : said === 'Skipped' ? 'No helpers yet' : said,
            sets: custom ? `${custom.name}: ${custom.purpose.replace(` ${ONE_LINE_PURPOSE}`, '')} Each asks before it acts.` : helpers.length ? 'Each asks before it acts, and you can change them' : 'Add one any time in the Agent app',
          });
        }
        break;
      case 'q4':
        out.push({ q, title: ids.includes('nothing') ? 'Hold it all' : `Always reaches you: ${lower(said)}`, sets: 'Everything else waits for a catch-up' });
        break;
      case 'q5':
        out.push({ q, title: `Catch-ups: ${lower(said)}`, sets: who.shield ? 'When I bring you what I held' : 'How often I bring you what I gathered' });
        break;
      case 'q6':
        out.push({ q, title: `Focus: ${lower(said)}`, sets: 'I keep those hours quiet' });
        break;
      case 'q7':
        out.push({ q, title: said, sets: helpers.length ? 'How much I and your helpers bring you' : 'How much I bring you' });
        break;
      case 'q8':
        out.push({ q, title: said, sets: 'Nothing leaves a desk without asking' });
        break;
      case 't2':
        out.push({ q, title: said, sets: 'Which app is open when you arrive' });
        break;
    }
  }
  return out;
}

/** The reveal's callback (§3.1, R2): code picks the first rule that matches; the model never writes it. */
export interface Callback {
  line: string;
  app: 'notebook' | 'browser' | 'files' | 'agent' | null;
  deskId: string | null;
}

export function callbackFor(r: Partial<Record<QId, string[]>>, desks: readonly OwnDesk[], courier: boolean, helpers: readonly Helper[]): Callback | null {
  const work = deskFor('work', desks);
  const where = work ? (desks.length > 1 ? ` on ${work.name}` : '') : '';
  const q2 = r.q2 ?? [];
  const q3 = r.q3 ?? [];
  const teen = r.t2 ?? [];
  if (q2.includes('writing')) return { line: `Notebook’s open${where}, for your writing.`, app: 'notebook', deskId: work?.id ?? null };
  if (q2.includes('research')) return { line: `Browser’s open${where}, for your research.`, app: 'browser', deskId: work?.id ?? null };
  if (q3.includes('sorting') && courier && helpers.some((h) => h.template === 'sorting')) return { line: where ? `Inbox is${where}, ready for your email.` : 'Inbox is ready for your email.', app: 'agent', deskId: helpers.find((h) => h.template === 'sorting')!.deskId };
  if (q2.includes('numbers') || q2.includes('code')) return { line: `Files is open${where}.`, app: 'files', deskId: work?.id ?? null };
  const one = desks[0]?.id ?? null;
  if (teen.includes('school')) return { line: 'Notebook’s open, for school.', app: 'notebook', deskId: one };
  if (teen.includes('making')) return { line: 'Files is open, for what you make.', app: 'files', deskId: one };
  if (teen.includes('learning') || teen.includes('games')) return { line: 'Browser’s open.', app: 'browser', deskId: one };
  return null;
}

/** The model's final plan (contract: `{answers, helpers}`), checked: ids only from each question, at most one custom helper. */
export function checkModelPlan(raw: unknown, set: readonly QId[]): { answers: Partial<Record<QId, string[]>>; custom: ModelHelper | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const answers: Partial<Record<QId, string[]>> = {};
  const a = o['answers'];
  if (a && typeof a === 'object') {
    for (const q of set) {
      const v = (a as Record<string, unknown>)[q];
      if (Array.isArray(v)) answers[q] = onlyKnown(q, v.filter((x): x is string => typeof x === 'string'));
    }
  }
  const helpers = Array.isArray(o['helpers']) ? (o['helpers'] as unknown[]) : [];
  const custom = helpers.map((h) => (h && typeof h === 'object' && (h as Record<string, unknown>)['template'] === 'custom' ? checkHelper(h) : null)).find((h) => h) ?? null;
  return { answers, custom };
}

/** Q5's attention fields for Desk Maia (today's mapping), or null. */
export const attentionFor = (q5: readonly string[] | undefined): (typeof CATCH_UPS)[string] | null => (q5?.[0] ? (CATCH_UPS[q5[0]] ?? null) : null);

/** "Your setup notes" (§12.2): a Notebook page on the home desk, the member's own, as Tiptap JSON. */
export function setupNotesDoc(lines: readonly HeardLine[], extras: readonly string[], date: string): Record<string, unknown> {
  const text = (t: string) => ({ type: 'text', text: t });
  const para = (t: string) => ({ type: 'paragraph', content: [text(t)] });
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Your setup notes')] },
      para(`Set up with Maia on ${date}. Each line says what it set and where to change it.`),
      {
        type: 'bulletList',
        content: [...lines.map((l) => `${l.title}: ${l.sets.replace(/\.$/, '')}.`), ...extras].map((t) => ({ type: 'listItem', content: [para(t)] })),
      },
      para('Change your light and background in the account menu, your helpers in the Agent app, and anything else by asking Maia. Set it all up again from Maia’s menu.'),
    ],
  };
}

/**
 * The plan only reads what the member's own words left open (Security's WEL-1): a question they were asked, didn't skip and
 * tapped nothing on. Never q8, whose answers are permissions: those come from taps alone. A custom helper only from q3's words.
 */
export function mergePlan(set: readonly QId[], answers: Readonly<Record<string, Answer>>, custom: ModelHelper | null, plan: ReturnType<typeof checkModelPlan>, name: string | null = null): { r: Partial<Record<QId, string[]>>; custom: ModelHelper | null } {
  let r = resolved(set, answers);
  if (!plan) return { r, custom };
  for (const q of set) {
    const a = answers[q];
    if (q === 'q8' || !a || a.skipped || a.pre || a.choices.length || !a.text) continue;
    if (plan.answers[q]?.length) r = { ...r, [q]: plan.answers[q] };
  }
  return { r, custom: custom ?? (answers['q3']?.text && plan.custom ? checkHelper(plan.custom, name) : null) };
}
