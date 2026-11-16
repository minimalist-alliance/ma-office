// The Notebook tools on the real test desk, in the same shape as the Files cases: read without a card, a write declined with a
// note, the same write approved (seen in the open page), the member's Undo, a new page, and the Trash declined then approved.
// What's left for production-ready in docs/sub-status/lsub-agent-tools-notebook.md ("the four tools and Undo from the Agent on
// the test desk") is this. The page's title is its first line, an h1, as the Notebook makes one.

const plan = 'Plan {stamp}';
const log = 'Log {stamp}';
// For --model standin: the Harness tab's id from notebook_list, then a page's id from that tab's list (the outline's
// `{pageId, title}`), as tools/agent-harness's capability tasks find them.
const listTabs = { calls: [{ name: 'notebook_list', input: {} }] };
const tabId = { $re: { step: 0, call: 0, pattern: '"tabId":"([^"]+)","title":"Harness"' } };
const listTab = { calls: [{ name: 'notebook_list', input: { tabId } }] };
const pageIn = (title) => ({ $re: { step: 1, call: 0, pattern: `"pageId":"([^"]+)","title":"${title}"` } });
const planPage = { tab: 'Harness', title: plan, markdown: `# ${plan}\nToken: {token}\n- pack the tent\n- check the ferry times` };

export default {
  tool: 'notebook',
  title: 'notebook_search, notebook_read, notebook_list, notebook_write, notebook_trash and Undo',
  cases: [
    {
      id: 'notebook-1-read',
      world: { notebook: [planPage] },
      ask: `Use your Notebook tools to find the page titled "${plan}" in the Harness tab and tell me its token: the word after "Token:".`,
      cards: [],
      standIn: [listTabs, listTab, { calls: [{ name: 'notebook_read', input: { pageId: pageIn(plan) } }] }, { text: 'The token is {token}.' }],
      checks: [
        { kind: 'reply', state: 'done', contains: ['{token}'] },
        { kind: 'chip', words: 'note' },
        { kind: 'audit', actions: ['tool.call'] },
        { kind: 'untrusted', value: false },
      ],
      tools: ['notebook_search', 'notebook_read', 'notebook_list'],
    },
    {
      id: 'notebook-2-append-decline',
      world: null,
      ask: `Add one line at the end of the page "${plan}" in the Harness tab with exactly this text: Appended {token2}`,
      cards: [{ tool: 'notebook_write', level: 'change', titleWords: ['Add to', plan], payload: { op: 'append', textHas: ['Appended {token2}'] }, decide: { decline: 'Not now: this is a harness test.' } }],
      standIn: [listTabs, listTab, { calls: [{ name: 'notebook_write', input: { pageId: pageIn(plan), op: 'append', markdown: 'Appended {token2}' } }] }, { text: 'You declined, so the page is as it was.' }],
      checks: [
        { kind: 'page', tab: 'Harness', title: plan, contains: ['{token}'], notContains: ['Appended {token2}'] },
        { kind: 'cardState', index: 0, state: 'declined' },
        { kind: 'audit', actions: ['approval.ask', 'approval.decide'], decision: 'declined' },
      ],
    },
    {
      id: 'notebook-3-append-approve',
      world: null,
      ask: `Please add it now: one line at the end of the page "${plan}" in the Harness tab with exactly this text: Appended {token2}`,
      cards: [{ tool: 'notebook_write', titleWords: ['Add to', plan], payload: { op: 'append', textHas: ['Appended {token2}'] }, before: { openPage: plan }, decide: 'approve' }],
      standIn: [listTabs, listTab, { calls: [{ name: 'notebook_write', input: { pageId: pageIn(plan), op: 'append', markdown: 'Appended {token2}' } }] }, { text: `Added the line to ${plan}.` }],
      checks: [
        { kind: 'page', tab: 'Harness', title: plan, contains: ['{token}', 'Appended {token2}'] },
        { kind: 'cardState', index: 0, state: 'done' },
        { kind: 'chip', tool: 'notebook_write', words: 'Changed a note' },
        { kind: 'summary', contains: ['approved by you'] },
        { kind: 'audit', actions: ['approval.ask', 'approval.decide', 'tool.call'] },
      ],
    },
    {
      id: 'notebook-4-undo',
      kind: 'member',
      do: { undoAgentEdit: plan },
      what: 'The member’s Undo of that append (the page foot’s “Edited by …” line, notebook.page.agentUndo): the line goes, the rest stays.',
      checks: [{ kind: 'page', tab: 'Harness', title: plan, contains: ['{token}', 'pack the tent'], notContains: ['Appended {token2}'] }],
    },
    {
      id: 'notebook-5-create',
      world: null,
      ask: `Make a new page in the Harness tab titled "${log}" whose only other line is exactly: Started {token2}`,
      cards: [{ tool: 'notebook_write', titleWords: ['Make the page', log], payload: { op: 'create', textHas: ['Started {token2}'] }, decide: 'approve' }],
      standIn: [listTabs, { calls: [{ name: 'notebook_write', input: { op: 'create', new: { tabId, title: log }, markdown: 'Started {token2}' } }] }, { text: `Made the page ${log}.` }],
      checks: [
        { kind: 'page', tab: 'Harness', title: log, contains: ['Started {token2}'] },
        { kind: 'cardState', index: 0, state: 'done' },
      ],
      tools: ['notebook_search', 'notebook_read', 'notebook_list', 'notebook_write'],
    },
    {
      id: 'notebook-6-trash-decline',
      world: null,
      ask: `Move the page "${log}" in the Harness tab to the Trash.`,
      cards: [{ tool: 'notebook_trash', level: 'change', titleWords: ['Move', log, 'to Trash'], decide: { decline: 'Keep it for now: this is a harness test.' } }],
      standIn: [listTabs, listTab, { calls: [{ name: 'notebook_trash', input: { pageId: pageIn(log) } }] }, { text: 'You declined, so the page stays.' }],
      checks: [
        { kind: 'page', tab: 'Harness', title: log, contains: ['Started {token2}'] },
        { kind: 'cardState', index: 0, state: 'declined' },
      ],
    },
    {
      id: 'notebook-7-trash-approve',
      world: null,
      ask: `Please move the page "${log}" in the Harness tab to the Trash now.`,
      cards: [{ tool: 'notebook_trash', titleWords: ['Move', log, 'to Trash'], decide: 'approve' }],
      standIn: [listTabs, listTab, { calls: [{ name: 'notebook_trash', input: { pageId: pageIn(log) } }] }, { text: `Moved ${log} to the Trash.` }],
      checks: [
        { kind: 'noPage', tab: 'Harness', title: log },
        { kind: 'cardState', index: 0, state: 'done' },
        { kind: 'audit', actions: ['approval.ask', 'approval.decide', 'tool.call'] },
      ],
    },
  ],
};
