// Account settings is modal for the keyboard too: while it's open, the rest of the office is inert, so Tab can't leave
// it for the top bar, the desks or a window hidden behind it (WCAG 2.4.3 and 2.4.11), as a <dialog> opened with
// showModal() would be. Its siblings in the shell are made inert, and any that mount while it's open; only those this
// made inert are let go again, so something already inert for its own reason stays that way.

let made: HTMLElement[] = [];
let watch: MutationObserver | null = null;

function hold(el: Element, layer: Element): void {
  if (el === layer || !(el instanceof HTMLElement) || el.inert) return;
  el.inert = true;
  made.push(el);
}

/** Everything in the shell beside `layer` (the modal's own layer) goes inert until `releaseOffice`. */
export function holdOffice(layer: HTMLElement): void {
  releaseOffice();
  const shell = layer.parentElement;
  if (!shell) return;
  for (const el of Array.from(shell.children)) hold(el, layer);
  watch = new MutationObserver((records) => {
    for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof Element) hold(n, layer);
  });
  watch.observe(shell, { childList: true });
}

/** Lets the office go. Safe to call when nothing is held. Before focus goes back: an inert button takes no focus. */
export function releaseOffice(): void {
  watch?.disconnect();
  watch = null;
  for (const el of made) el.inert = false;
  made = [];
}
