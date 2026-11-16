// The office tour's steps (ADR 0056), as data. The owner, Nov 13: the first tour was "lazy and uninspired" and only four
// things, so it now walks the whole office: what a desk and an app are, moving around, Maia, setup, the privacy shield,
// the bell, the account menu and the logo's menu, where the tour lives. Each anchor is the office's own markup. A step whose
// target isn't there for this member (one desk, no guild, a phone, setup finished) is left out, and the count says so.
// The highlight's corners follow the target's own (`TourLayer.tsx` measures them); `radius` only overrides that.
import type { TourStep } from './engine';

export const STEPS: readonly TourStep[] = [
  {
    id: 'intro',
    anchor: null,
    title: 'Welcome to your office',
    body: "This is your calm corner of the internet: your desks, the apps you choose, and nothing built to pull at your attention. Here's a one-minute look around.",
  },
  // Every own desk on screen, in one hole.
  {
    id: 'desk',
    when: 'oneDesk',
    anchor: '@desks',
    pad: 10,
    title: 'Your desk',
    body: 'A desk is a desktop in the cloud, with a real browser, your files and the apps you choose. It keeps your tabs and sign-ins between visits, so you pick up where you left off on any device.',
  },
  {
    id: 'desks',
    when: 'personalAndWork',
    anchor: '@desks',
    pad: 10,
    title: 'Your desks',
    body: 'Each desk is a desktop in the cloud, with a real browser, files and apps of its own. Personal and Work keep separate tabs and sign-ins, so work stays at work, and both pick up where you left off on any device.',
  },
  // A Guild Desk on screen, for a member in a guild that has one.
  {
    id: 'guild',
    anchor: '@guild',
    pad: 10,
    title: "Your guild's desk",
    body: 'Everyone in your guild shares this desk and the apps on it. Your own desks stay yours alone.',
  },
  // The top bar's Personal, Work, Guild and All, for a member with more than one desk.
  {
    id: 'scope',
    anchor: '.topbar .segmented.scope:not(.scope-ghost)',
    pad: 4,
    title: 'Switch desks',
    body: 'Show one desk at a time, or choose All to see them side by side. The [ and ] keys move between them too.',
  },
  // The Browser's tile, on the first own desk on screen (Personal first).
  {
    id: 'app',
    anchor: '@app',
    pad: 8,
    title: 'Apps',
    body: 'Apps are the tools on your desk, like Browser, Notebook and Files. Each does one job, with no ads, and opens in its own window. Open one to start; a sleeping desk wakes as you do.',
  },
  // The bottom bar's zoom and Fit (not on a phone, which pinches).
  {
    id: 'move',
    anchor: '.bottombar .zoom-ctl',
    pad: 4,
    placement: 'above',
    title: 'Move around',
    body: 'Your office is one open canvas. Scroll or pinch to zoom, drag to move, and press Fit to bring every desk back into view.',
  },
  {
    id: 'maia',
    anchor: '.maia-launcher',
    pad: 6,
    radius: 'circle',
    title: 'Ask Maia',
    body: 'Maia is the AI assistant built into your office. Ask her how anything works, where something is, or to look something up for you.',
  },
  // Only while the member still has setup steps or something new to see.
  {
    id: 'setup',
    anchor: '.setup-circle .su-btn',
    pad: 4,
    title: 'Finish setting up',
    body: "The ring shows what's left to set up, and anything new. Open it for your next step.",
  },
  {
    id: 'shield',
    anchor: '.topbar button[aria-label="Privacy shield"]',
    pad: 4,
    title: 'Privacy shield',
    body: 'Someone looking over your shoulder? The shield blurs your open windows and hides what your apps show. Press \\ to turn it on or off.',
  },
  {
    id: 'bell',
    anchor: '.topbar [data-testid="bell"]',
    pad: 4,
    title: 'Notifications',
    body: 'What needs you, from your office, your account and the Forums, arrives here in one quiet list. No sounds, no pop-ups.',
  },
  {
    id: 'account',
    anchor: '.topbar .account-btn',
    pad: 4,
    title: 'Your account',
    body: 'Choose Light, Dark or Zen, and in Zen a background. Keyboard shortcuts, account settings and Sign out are here too.',
  },
  // The logo's menu (`office.mark`): only while it opens the menu (its kill switch on). The tour's only way back in.
  {
    id: 'help',
    anchor: '.home-mark-btn[aria-controls="mark-menu"]',
    pad: 4,
    title: 'The rest of the Alliance',
    body: 'Point at or press the logo for the Forums, Help, your account and billing, and our policies. This tour is there too, whenever you want it again.',
  },
];

/** The tour's own words. */
export const WORDS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip',
  off: "Don't show this again",
  close: 'Close the tour',
  count: (n: number, total: number): string => `${n} of ${total}`,
  offNote: "Turned off. You can take the tour again from the logo's menu, top left.",
} as const;
