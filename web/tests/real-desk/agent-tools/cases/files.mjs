// The Files tools on the real test desk, after the core's plan (docs/sub-status/lsub-agent-tools-core.md, "The real-desk proof:
// a plan, not run", steps 1 to 9). Each case is one thing the member types, the cards it should bring and how each is answered,
// then what the desk shows after. `{stamp}`, `{token}`, `{token2}` and `{canary}` are filled in per run; every world text gets
// the run's canary on its own last line, and checks read text with it taken out.
//
// Cases run in order, on one agent. The thread keeps a run's taint ("a thread whose earlier reply came from a U run" starts U,
// draft ADR §6), so the cases that read a file come last.

const note = 'Harness/note-{stamp}.md';
const long = 'Harness/long-{stamp}.txt';
/** What a capable model does, for --model standin: one save, and its words after the member's answer. */
const save = (path, text, replace = false) => [{ calls: [{ name: 'files_write', input: { path, text, ...(replace ? { replace: true } : {}) } }] }];
const longText = `${Array.from({ length: 2600 }, (_, i) => `Line ${i + 1}: the ferry leaves at seven forty from pier two.`).join('\n')}\nLast line: {token}`;

export default {
  tool: 'files',
  title: 'files_list, files_read, files_write and the replace binding',
  cases: [
    {
      id: 'files-1-window',
      from: 'core step 1',
      kind: 'shots',
      what: 'The Agent window opened on the real relay with no CSP violation or console error (checked for the whole run at its end), and shots of it.',
      checks: [],
    },
    {
      id: 'files-2-decline-note',
      from: 'core step 2',
      world: { files: { 'Harness/readme.md': 'This folder belongs to the harness.' } },
      ask: `Use your Files tools to save a new file at exactly ${note} with exactly this text and nothing else: Packing list {token}`,
      cards: [{ tool: 'files_write', level: 'change', titleWords: ['Save', note, 'in your Files'], payload: { path: note, textHas: ['Packing list {token}'] }, decide: { decline: 'Not now: this is a harness test.' } }],
      standIn: [...save(note, 'Packing list {token}'), { text: 'You declined, so I didn’t save it.' }],
      checks: [
        { kind: 'noFile', path: note },
        { kind: 'cards', tools: ['files_write'] },
        { kind: 'cardState', index: 0, state: 'declined' },
        { kind: 'reply', state: 'done' },
        { kind: 'audit', actions: ['approval.ask', 'approval.decide'], decision: 'declined' },
      ],
    },
    {
      id: 'files-3-approve',
      from: 'core step 3',
      world: null,
      ask: `Please save it now: a new file at exactly ${note} with exactly this text and nothing else: Packing list {token}`,
      cards: [{ tool: 'files_write', level: 'change', titleWords: ['Save', note], payload: { path: note, textHas: ['Packing list {token}'] }, decide: 'approve' }],
      standIn: [...save(note, 'Packing list {token}'), { text: `Saved ${note}.` }],
      checks: [
        { kind: 'file', path: note, contains: ['Packing list {token}'] },
        { kind: 'cardState', index: 0, state: 'done' },
        { kind: 'chip', tool: 'files_write', words: 'Saved a file' },
        { kind: 'summary', contains: ['1 approved by you'] },
        { kind: 'reply', state: 'done' },
        { kind: 'audit', actions: ['approval.ask', 'approval.decide', 'tool.call'] },
      ],
      tools: ['files_list', 'files_search', 'files_read', 'files_write'],
    },
    {
      id: 'files-4-replace-changed',
      from: 'core step 4, first half',
      world: null,
      ask: `Replace the whole text of ${note} with exactly this and nothing else: Packing list v2 {token2}`,
      cards: [
        {
          tool: 'files_write',
          titleWords: ['Replace', note],
          payload: { path: note, replace: true, textHas: ['Packing list v2 {token2}'] },
          before: { editFile: { path: note, text: 'Edited by the member while the card waited.' } },
          decide: 'approve',
        },
      ],
      standIn: [...save(note, 'Packing list v2 {token2}', true), { text: 'The file changed before it could be replaced, so I left it as it is.' }],
      checks: [
        { kind: 'cardState', index: 0, state: 'failed', error: 'changed' },
        { kind: 'file', path: note, contains: ['Edited by the member while the card waited.'], notContains: ['{token2}'] },
        { kind: 'notTrashed', name: 'note-{stamp}.md' },
      ],
      unexpected: 'decline',
    },
    {
      id: 'files-4-replace-again',
      from: 'core step 4, second half',
      world: null,
      ask: `Try that again: replace the whole text of ${note} with exactly this and nothing else: Packing list v2 {token2}`,
      cards: [{ tool: 'files_write', titleWords: ['Replace', note], payload: { path: note, replace: true, textHas: ['Packing list v2 {token2}'] }, decide: 'approve' }],
      standIn: [...save(note, 'Packing list v2 {token2}', true), { text: `Replaced ${note}.` }],
      checks: [
        { kind: 'cardState', index: 0, state: 'done' },
        { kind: 'file', path: note, contains: ['Packing list v2 {token2}'] },
        { kind: 'trashed', name: 'note-{stamp}.md' },
      ],
    },
    {
      id: 'files-7-bad-path',
      from: 'core step 7 (the FIFO half needs a shell on the desk: not here)',
      world: null,
      ask: 'Save a file at exactly the path "Harness/zero\u200Bwidth-{stamp}.md" with the text "x". Keep the invisible character after "zero" in the path exactly as I typed it.',
      cards: [],
      unexpected: 'decline',
      standIn: [...save('Harness/zero\u200Bwidth-{stamp}.md', 'x'), { text: 'Files refused that path, so nothing was saved.' }],
      checks: [
        { kind: 'noFile', path: 'Harness/zero\u200Bwidth-{stamp}.md' },
        { kind: 'reply', state: 'done' },
      ],
      note: 'deskd refuses the path with no card (`path`). A model that drops the character instead asks for a plain name: that card is declined and noted, not failed.',
    },
    {
      id: 'files-5-long-read',
      from: 'core step 5, first half',
      world: { files: { [long]: longText } },
      ask: `Read the file ${long} all the way to its end with your Files tools, then tell me the text of the line that starts with "Last line:".`,
      cards: [],
      standIn: [{ readAll: { path: long, pattern: 'Last line: (tok[0-9a-f]+)', say: 'The line is: Last line: {match}' } }],
      checks: [
        { kind: 'reply', state: 'done', contains: ['{token}'] },
        { kind: 'chip', tool: 'files_read' },
        { kind: 'untrusted', value: true },
        { kind: 'audit', actions: ['tool.call'] },
      ],
      tools: ['files_list', 'files_search', 'files_read'],
    },
    {
      id: 'files-5-write-after-read',
      from: 'core step 5, second half',
      world: null,
      ask: 'Save a one-line summary of that file at exactly Harness/long-summary-{stamp}.md.',
      cards: [{ tool: 'files_write', titleWords: ['Harness/long-summary-{stamp}.md'], untrusted: true, decide: { decline: 'Not now: this is a harness test.' } }],
      standIn: [...save('Harness/long-summary-{stamp}.md', 'Ferry times from pier two, line by line.'), { text: 'You declined, so I didn’t save the summary.' }],
      checks: [
        { kind: 'cardUntrusted', index: 0, value: true },
        { kind: 'noFile', path: 'Harness/long-summary-{stamp}.md' },
        { kind: 'cardState', index: 0, state: 'declined' },
      ],
    },
    { id: 'files-6-restarts', from: 'core step 6', skip: 'restarting desk-agent or deskd needs the Desk Engineer’s tooling on the desk; the local rig’s fault() covers it' },
    { id: 'files-8-timing', from: 'core step 8', skip: 'rt-agent-perf.mjs measures decide to done, and the rest of §17’s client-side numbers' },
    {
      id: 'files-9-themes',
      from: 'core step 9',
      kind: 'shots',
      themes: true,
      what: 'The thread with its cards in Light, Zen and Dark. Look at them for green, brown or warm tints.',
      checks: [],
    },
  ],
};
