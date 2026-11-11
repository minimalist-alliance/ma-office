// The mock's tool calls that ask (S-14), shaped as deskd API.md section 18's approvals, for the demo, the `tools` fixture and the
// tests. Demo data only: the member is Alex Demo, sites are example.com, example.org and example.net, and no key appears.
import type { ApprovalTarget, Risk } from '../client/types';

/** One call a mock run asks the member about. */
export interface AskSpec {
  tool: string;
  risk: Risk;
  payload: Record<string, unknown>;
  context?: string;
  target?: ApprovalTarget | null;
  before?: Record<string, unknown> | null;
  untrusted?: boolean;
  /** The spec's 1.10 `reason` (not in section 18 yet). */
  reason?: string | null;
  /** Spend only: the spec's 1.10 `cost`. */
  costMicroUsd?: number;
  /** How long the approved call runs, ms; and whether it fails, with which word. */
  runMs?: number;
  fails?: string;
  /** The desk's title, for a tool this app has no template for. */
  title?: string;
  /** Short words for the running strip and the chip. */
  doing: string;
  target2: string;
  /** What the agent says next, by the answer. */
  then: { approved: string; declined: string };
}

export const ASKS = {
  /** Still 02: a Send outside, raised to `egress` because the run read pages and the member's note. */
  shop: {
    tool: 'browser_open',
    risk: 'egress',
    payload: { url: 'https://shop.example.com/compare?item=lumen-arc&width=120cm&budget=80' },
    target: { kind: 'site', origin: 'https://shop.example.com' },
    untrusted: true,
    reason: 'I want today’s price for the Lumen Arc, in the size your note gives.',
    runMs: 2000,
    doing: 'Opening a page',
    target2: 'shop.example.com/compare',
    then: {
      approved: 'It’s $74 today at shop.example.com, under your $80, and the clamp fits a 120 cm desk. Want me to add it to your Home office note?',
      declined: 'Understood. I won’t open the shop. The two reviews both put the Lumen Arc at about $70 to $80.',
    },
  },
  /** Still 01: a Change, from Notebook. */
  trash: {
    tool: 'notebook_trash',
    risk: 'delete',
    payload: { pageId: 'pg-old-drafts-spring' },
    target: { kind: 'page', pageId: 'pg-old-drafts-spring', title: 'Old drafts, spring' },
    before: { title: 'Old drafts, spring' },
    untrusted: false,
    reason: 'It hasn’t changed in over a year, and “draft” is in its title.',
    runMs: 800,
    doing: 'Moving a page to Trash',
    target2: '“Old drafts, spring”',
    then: {
      approved: 'Moved it to the Trash. Two more pages look the same: want me to ask about each?',
      declined: 'Understood. I’ll leave your drafts where they are.',
    },
  },
  /** Still 08: Spend, with its amount on Approve. */
  pictures: {
    tool: 'image_generate',
    risk: 'spend',
    title: 'Make 4 pictures of a reading corner',
    payload: { prompt: 'A reading corner with a clamp lamp on a 120 cm desk, by a window', count: 4, size: '1024x1024' },
    target: null,
    untrusted: false,
    costMicroUsd: 320_000,
    runMs: 3000,
    doing: 'Making pictures',
    target2: '4 pictures',
    then: {
      approved: 'Here are four takes on the reading corner. They’re in my workspace.',
      declined: 'Understood. No pictures.',
    },
  },
  /** A memory save in a run that read a web page: `own`, raised to asking. */
  memory: {
    tool: 'memory_save',
    risk: 'own',
    payload: { text: 'Alex likes warm light, 2700 K, for reading.' },
    target: { kind: 'memory' },
    untrusted: true,
    runMs: 300,
    doing: 'Saving a memory',
    target2: '',
    then: {
      approved: 'Saved. I’ll keep warm light in mind.',
      declined: 'Understood. I won’t remember that.',
    },
  },
} satisfies Record<string, AskSpec>;

export type AskName = keyof typeof ASKS;
