// Dev and test fixtures only (never in a production bundle, see session.ts). Mock data stays here.
import { defaultDesk, deskFromGrid, panelH, panelW, type AppId, type LayoutDesk } from '../canvas/layout';
import { setDeskListDirect, type DeskInfo, type DeskKind } from '../state/deskStore';
import { setLayoutDirect } from '../state/layoutStore';

function info(id: string, name: string, kind: DeskKind): DeskInfo {
  return { id, name, kind, vm: 'running', phase: 'ready', queuePosition: null, stopAt: null, givebackUntil: null, badges: {} };
}

const APPS: readonly AppId[] = ['chat', 'notebook', 'browser', 'agent'];

/** Budget B1's fixture: 24 desks of 12 tiles (design 2.2). */
function perf(): { desks: DeskInfo[]; layout: LayoutDesk[] } {
  const COLS = 6;
  const desks: DeskInfo[] = [];
  const layout: LayoutDesk[] = [];
  const w = panelW(4);
  // 448 keeps the whole fixture 1672 tall, as it was with a label above each desk, so its fit lands at the
  // same zoom and the same level of detail, and perf runs across that change compare like for like.
  const rowH = panelH(3) + 120;
  for (let i = 0; i < 24; i += 1) {
    const id = `d-fix${String(i).padStart(2, '0')}`;
    const kind: DeskKind = i % 3 === 0 ? 'personal' : i % 3 === 1 ? 'work' : 'guild';
    desks.push(info(id, `Desk ${i + 1}`, kind));
    const items = Array.from({ length: 12 }, (_, n) => ({
      id: `${id}:${n}`,
      app: APPS[n % 4]!,
      // Every fourth desk leads with a widget, so the fixture draws text as well as glyphs.
      level: i % 4 === 0 && n === 0 ? ('small' as const) : ('icon' as const),
    }));
    layout.push(deskFromGrid({ id, x: (i % COLS) * (w + 72), y: Math.floor(i / COLS) * rowH, cols: 4, rows: 3, items }));
  }
  return { desks, layout };
}

function three(): { desks: DeskInfo[]; layout: LayoutDesk[] } {
  const w = panelW(6);
  return {
    desks: [info('d-personal', 'Personal', 'personal'), info('d-work', 'Work', 'work'), info('d-guild', 'Guild', 'guild')],
    layout: [defaultDesk('d-personal', 0, 0), defaultDesk('d-work', w + 72, 0), defaultDesk('d-guild', (w + 72) / 2, 320)],
  };
}

function one(): { desks: DeskInfo[]; layout: LayoutDesk[] } {
  return { desks: [info('d-personal', 'Personal', 'personal')], layout: [defaultDesk('d-personal', 0, 0)] };
}

export function makeFixture(name: string): { desks: DeskInfo[]; apply: () => void } {
  const f = name === 'perf' ? perf() : name === 'one' ? one() : three();
  return {
    desks: f.desks,
    apply: () => {
      setLayoutDirect(f.layout);
      setDeskListDirect(f.desks);
    },
  };
}
