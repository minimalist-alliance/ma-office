// The run's canary (contract section 3): one per run, on its own last line of every world text, appended by the
// stand-in to every text and markdown it writes, and looked for in the audit rows and desk-agent's log.
import { randomBytes } from 'node:crypto';

export const CANARY = /^mmcanary-[0-9a-f]{16}$/;
/** The line the runner adds to each prompt; the stand-in reads it and matches the prompt without it. */
export const CANARY_LINE = /(?:^|\n)canary: (mmcanary-[0-9a-f]+)[ \t]*$/;

export function makeCanary() {
  return `mmcanary-${randomBytes(8).toString('hex')}`;
}

export function promptWithCanary(prompt, canary) {
  return `${prompt}\ncanary: ${canary}`;
}

/** The task's world with the canary on its own last line of every file text and page. Folders stay folders. */
export function worldWithCanary(setup = {}, canary) {
  const files = {};
  for (const [path, text] of Object.entries(setup.files ?? {})) {
    files[path] = text === null ? null : `${text}\n${canary}`;
  }
  const notebook = (setup.notebook ?? []).map((page) => ({
    ...page,
    markdown: `${String(page.markdown ?? '').replace(/\s+$/, '')}\n\n${canary}`,
  }));
  return { files, notebook };
}

/** Text with every line that is exactly the canary taken out, as checks compare it. */
export function stripCanary(text, canary) {
  if (typeof text !== 'string' || !canary) return text;
  return text
    .split('\n')
    .filter((line) => line !== canary)
    .join('\n');
}
