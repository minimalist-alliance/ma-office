// Fake notes for the demo and the perf fixtures. Nothing here is anyone's real data.
// Deterministic (a seeded generator), so screenshots and measurements repeat.
import { uid, type ImportPage, type LocalBackend } from '../src/local/localBackend.ts';
import { dayKey } from '../src/model/days.ts';
import type { PMNode } from '../src/model/schema.ts';
import type { ActivityRow, NotebookRec, TabColor, TabRec } from '../src/model/types.ts';

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' +
  'ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non ' +
  'proident sunt in culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sentence(r: () => number, min = 6, max = 16): string {
  const n = min + Math.floor(r() * (max - min));
  const words = Array.from({ length: n }, () => LOREM[Math.floor(r() * LOREM.length)] ?? 'lorem');
  const s = words.join(' ');
  return `${s[0]?.toUpperCase()}${s.slice(1)}.`;
}

export function paragraphText(r: () => number, sentences = 4): string {
  return Array.from({ length: sentences }, () => sentence(r)).join(' ');
}

const text = (t: string, ...marks: string[]): PMNode => ({ type: 'text', text: t, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...c: (PMNode | string)[]): PMNode => ({ type: 'paragraph', content: c.map((x) => (typeof x === 'string' ? text(x) : x)) });
const h = (level: number, t: string): PMNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const bullets = (...items: string[]): PMNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const tasks = (...items: [string, boolean][]): PMNode => ({
  type: 'taskList',
  content: items.map(([t, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [p(t)] })),
});
const numbered = (...items: string[]): PMNode => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const doc = (...blocks: PMNode[]): PMNode => ({ type: 'doc', content: blocks });

const DAY = 86_400_000;
/** A time `daysAgo` days back. Today's never lands in the future: early in the day it's just after midnight. */
const at = (daysAgo: number, hour: number, minute = 0): number => {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, minute).getTime();
  if (daysAgo > 0) return t;
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.max(midnight + 60_000 * (hour % 3), Math.min(t, Date.now() - 45 * 60_000));
};

interface Spec {
  doc: PMNode;
  created: number;
  edits?: number[];
}

/** The demo's notebooks: enough to show binder tabs, checklists, history and a busy calendar. */
const DEMO: { title: string; tabs: { title: string; color: TabColor; pages: Spec[] }[] }[] = [
  {
    title: 'Personal',
    tabs: [
      {
        title: 'Trips',
        color: 'blue',
        pages: [
          {
            doc: doc(
              h(1, 'Lake weekend'),
              p('Leave Friday after lunch. The cabin has a ', text('wood stove', 'bold'), ', so bring matches and a good book.'),
              h(2, 'Packing'),
              tasks(['Rain jacket', true], ['Hiking boots', true], ['Headlamp and spare batteries', false], ['Thermos', false]),
              h(2, 'Plan'),
              numbered('Morning loop around the lake', 'Lunch at the dock', 'Canoe if the wind is calm'),
              p(text('Check the forecast on Thursday.', 'italic')),
            ),
            created: at(9, 19, 12),
            edits: [at(6, 8, 40), at(2, 21, 5)],
          },
          {
            doc: doc(h(1, 'City break ideas'), p(paragraphText(rng(3), 3)), bullets('Old town walking tour', 'Market on Saturday', 'The small museum by the river'), p(paragraphText(rng(4), 2))),
            created: at(21, 10, 0),
            edits: [at(14, 18, 30)],
          },
        ],
      },
      {
        title: 'Recipes',
        color: 'green',
        pages: [
          {
            doc: doc(
              h(1, 'Weeknight lentil soup'),
              p('Serves four. Takes about forty minutes, most of it simmering.'),
              h(2, 'Ingredients'),
              tasks(['1 cup red lentils', false], ['1 onion, 2 carrots, 2 celery sticks', false], ['1 can tomatoes', true], ['Cumin, smoked paprika, lemon', false]),
              h(2, 'Method'),
              numbered('Soften the vegetables in olive oil.', 'Add spices for a minute, then lentils, tomatoes and a litre of stock.', 'Simmer 25 minutes. Finish with lemon.'),
              p(text('Freezes well.', 'highlight')),
            ),
            created: at(16, 17, 45),
            edits: [at(3, 18, 10)],
          },
          { doc: doc(h(1, 'Bread notes'), p(paragraphText(rng(5), 4)), p(paragraphText(rng(6), 3))), created: at(30, 9, 0) },
        ],
      },
      {
        title: 'Reading',
        color: 'amber',
        pages: [
          {
            doc: doc(h(1, 'Books for winter'), bullets('A long novel to read slowly', 'Something about the sea', 'Short essays for the train'), p(paragraphText(rng(7), 2))),
            created: at(5, 22, 15),
            edits: [at(1, 7, 50)],
          },
        ],
      },
    ],
  },
  {
    title: 'Projects',
    tabs: [
      {
        title: 'Garden',
        color: 'violet',
        pages: [
          {
            doc: doc(
              h(1, 'Spring planting'),
              p('Raised bed by the fence gets the most sun. Start seeds indoors six weeks before the last frost.'),
              tasks(['Order seeds', true], ['Build the second bed', false], ['Compost delivery', false]),
              h(3, 'Notes'),
              p(paragraphText(rng(8), 3)),
            ),
            created: at(12, 16, 0),
            edits: [at(4, 12, 20), at(0, 9, 15)],
          },
          { doc: doc(h(1, 'Shed repair'), p(paragraphText(rng(9), 4)), bullets('New hinges', 'Paint the door', 'Clear the gutter')), created: at(35, 11, 30) },
        ],
      },
      {
        title: 'Ideas',
        color: 'rose',
        pages: [
          { doc: doc(h(1, 'Small app ideas'), bullets('A calm habit tracker', 'A recipe scaler', 'Plant watering reminders'), p(paragraphText(rng(10), 2))), created: at(7, 20, 0), edits: [at(0, 8, 5)] },
        ],
      },
    ],
  },
];

function activityFor(pageId: string, created: number, edits: number[]): ActivityRow[] {
  const rows = new Map<string, ActivityRow>();
  rows.set(dayKey(created), { pageId, day: dayKey(created), created: true, firstAt: created, lastAt: created + 20 * 60_000, edits: 12, added: 600, removed: 40, actors: ['user'] });
  for (const e of edits) {
    const day = dayKey(e);
    const prev = rows.get(day);
    if (prev) prev.lastAt = Math.max(prev.lastAt, e);
    else rows.set(day, { pageId, day, created: false, firstAt: e, lastAt: e + 12 * 60_000, edits: 7, added: 140, removed: 30, actors: ['user'] });
  }
  return [...rows.values()];
}

/** A shorter body for an older version, so restoring one visibly changes the page. */
function earlier(body: PMNode): PMNode {
  const blocks = body.content ?? [];
  return { type: 'doc', content: blocks.slice(0, Math.max(1, Math.ceil(blocks.length / 2))) };
}

export async function seedDemo(backend: LocalBackend): Promise<void> {
  const notebooks: NotebookRec[] = [];
  const tabs: TabRec[] = [];
  const pages: ImportPage[] = [];
  DEMO.forEach((nb, ni) => {
    const created = at(40, 9);
    const n: NotebookRec = { id: uid(), title: nb.title, sortKey: ni, createdAt: created, updatedAt: created, rowVersion: 1 };
    notebooks.push(n);
    nb.tabs.forEach((t, ti) => {
      const tab: TabRec = { id: uid(), notebookId: n.id, title: t.title, color: t.color, sortKey: ti, createdAt: created, updatedAt: created, rowVersion: 1 };
      tabs.push(tab);
      t.pages.forEach((s, pi) => {
        const id = uid();
        const edits = s.edits ?? [];
        const last = Math.max(s.created, ...edits);
        pages.push({
          rec: { id, tabId: tab.id, sortKey: pi, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: s.created, updatedAt: last, deletedAt: null, rowVersion: 1 },
          doc: s.doc,
          activity: activityFor(id, s.created, edits),
          versions: [
            { id: uid(), createdAt: s.created + 20 * 60_000, reason: 'session', doc: earlier(s.doc) },
            ...edits.map((e) => ({ id: uid(), createdAt: e + 12 * 60_000, reason: 'session' as const, doc: s.doc })),
          ],
        });
      });
    });
  });
  await backend.importData({ notebooks, tabs, pages });
}

/**
 * The perf fixture: one page of `words` words of lorem in headings, paragraphs and lists (about 500
 * words to a printed page), and a tab of `pageCount` short pages for list scrolling and search.
 */
export async function seedLong(backend: LocalBackend, words: number, pageCount: number): Promise<void> {
  const r = rng(42);
  const created = Date.now() - 3 * DAY;
  const n: NotebookRec = { id: uid(), title: 'Perf', sortKey: 0, createdAt: created, updatedAt: created, rowVersion: 1 };
  const long: TabRec = { id: uid(), notebookId: n.id, title: 'Long page', color: 'blue', sortKey: 0, createdAt: created, updatedAt: created, rowVersion: 1 };
  const many: TabRec = { id: uid(), notebookId: n.id, title: 'Many pages', color: 'green', sortKey: 1, createdAt: created, updatedAt: created, rowVersion: 1 };
  const blocks: PMNode[] = [h(1, `Long document, ${words.toLocaleString('en-US')} words`)];
  let count = 0;
  let section = 1;
  while (count < words) {
    if (blocks.length % 12 === 1) blocks.push(h(2, `Section ${section++}`));
    const kind = r();
    if (kind < 0.12) {
      const items = Array.from({ length: 3 }, () => sentence(r, 4, 9));
      blocks.push(bullets(...items));
      count += items.join(' ').split(' ').length;
    } else if (kind < 0.18) {
      const items = Array.from({ length: 3 }, (): [string, boolean] => [sentence(r, 3, 7), r() < 0.5]);
      blocks.push(tasks(...items));
      count += items.map((i) => i[0]).join(' ').split(' ').length;
    } else {
      const t = paragraphText(r, 3 + Math.floor(r() * 3));
      blocks.push(p(t));
      count += t.split(' ').length;
    }
  }
  const pages: ImportPage[] = [
    { rec: { id: uid(), tabId: long.id, sortKey: 0, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: created, updatedAt: created, deletedAt: null, rowVersion: 1 }, doc: doc(...blocks) },
  ];
  for (let i = 0; i < pageCount; i += 1) {
    const c = created - i * 3_600_000 * 7;
    pages.push({
      rec: { id: uid(), tabId: many.id, sortKey: i, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: c, updatedAt: c, deletedAt: null, rowVersion: 1 },
      doc: doc(h(1, `Page ${i + 1}: ${sentence(r, 2, 5).slice(0, -1)}`), p(paragraphText(r, 4)), p(paragraphText(r, 3))),
    });
  }
  await backend.importData({ notebooks: [n], tabs: [long, many], pages });
}
