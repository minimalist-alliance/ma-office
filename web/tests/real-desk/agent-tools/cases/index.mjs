// The registration: every tool's real-desk script, one file each. Adding a tool is one new file in this folder, exporting
// `{tool, title, cases}` as `files.mjs` does, and one line below. `rt-agent-tools.mjs --tool <name>` then runs it, and
// `--dry` validates it (`validateCases` in ../pure.mjs) and prints its plan.
import browser from './browser.mjs';
import files from './files.mjs';
import notebook from './notebook.mjs';

// Coming in the next days, each its own file when its tools land on a desk:
//
// import auto from './auto.mjs';
//   Auto-approve (draft ADR §15): switch "Save new files in the folder Harness" on in the agent's settings (`access-auto-files`,
//   `access-save`); a new file is written with no card; its chip says "Done without asking · Undo"; the run summary says
//   "1 done without asking"; Activity has `approval.auto`; Undo all puts the file in Files' trash. Then: a replace, a move and
//   a trash still ask; after a files_read in the same run the next new file asks again; a path outside the folder asks.
//
// import todos from './todos.mjs';
//   To-dos (§13): todo_create asks (a card naming the text), approved it's on the member's list; todo_complete of one it made
//   ticks it; one the member wrote can't be ticked without a card; a to-do made after a Courier or web read is marked untrusted.
//
// import courier from './courier.mjs';
//   Courier, read only (§12): courier_list, courier_search and courier_read ask nothing and set U (the reply's notice); the next
//   write's card says "This agent has read web pages, files or messages in this task."; Requests and bulk mail never reach
//   courier_new; nothing can send (no send tool is offered). Needs a test desk whose Courier store has fixture messages.
//
// import deskMessages from './desk-messages.mjs';
//   Messages between the member's desks (§14): with a grant on both desks, desk_message to the other desk's agent asks when the
//   run holds S and goes without a card when it doesn't; a revoked half refuses the next one (`no_grant`); the answer arrives as
//   U. Needs a second staging test desk on desk-1's account.

/** In the order `--tool all` runs them. */
export const REGISTERED = [files, notebook, browser];
