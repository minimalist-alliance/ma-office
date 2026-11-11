// Many pages with many days of activity, written straight into notebook.db, for the tests of `notebook.activity`'s paging:
// tens of thousands of rows that a desk would take years to write. Fake text only. The service must be stopped, or be this
// process's own (desk-notebook's Vitest), and the schema must be there: start the service once first.
//
// From the command line, for deskd's RealDeskNotebookActivityIT, with the options as JSON:
//   node seed-activity.mjs <dataDir> '{"tabId":"…","pages":3000,"days":10}'
// It prints {"live":n,"trashed":n,"rows":n,"liveRows":n} on stdout.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** An id shaped like the service's own (a UUID), so rows are their real size. */
export const seedPageId = (i) => `${i.toString(16).padStart(8, '0')}-5eed-4000-8000-${i.toString(16).padStart(12, '0')}`;

/** Day `n` after 2024-01-01, as `YYYY-MM-DD`. */
export const seedDay = (n) => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * `pages` pages in `tabId`, each with `days` rows of activity on different days, spread so pages share days. Every
 * `trashEvery`th page is in Trash (by `trashedBy`), with its rows, which no reply may hold. `actors` go in every row.
 * `members` adds names for a guild desk's member ids. One transaction.
 */
export function seedActivity(db, { tabId, pages, days, trashEvery = 0, trashedBy = 'user', actors = ['user'], members = {}, start = 0 }) {
  const at = Date.UTC(2026, 10, 1, 12, 0, 0);
  const page = db.prepare(
    `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, row_version, ydoc, pm_json, plain_text)
     VALUES (?, ?, ?, ?, '', 0, 0, ?, ?, ?, ?, ?, ?, 1, X'0000', '{"type":"doc","content":[]}', '')`,
  );
  const row = db.prepare('INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const member = db.prepare('INSERT INTO members (member_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET name = excluded.name');
  const actorsJson = JSON.stringify(actors);
  let live = 0;
  let trashed = 0;
  let liveRows = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [id, name] of Object.entries(members)) member.run(id, name, at);
    for (let i = start; i < start + pages; i += 1) {
      const id = seedPageId(i);
      const inTrash = trashEvery > 0 && i % trashEvery === trashEvery - 1;
      page.run(id, tabId, 1000 + i, `Seed ${i}`, at, actors[0], at, actors[0], inTrash ? at : null, inTrash ? trashedBy : null);
      if (inTrash) trashed += 1;
      else live += 1;
      // Page i's days are distinct, and about `days` pages share each one.
      for (let j = 0; j < days; j += 1) {
        row.run(id, seedDay(j * 37 + (i % 37)), j === 0 ? 1 : 0, at + j, at + j + 60_000, 1 + (i % 9), 10 * j, j, actorsJson);
        if (!inTrash) liveRows += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { live, trashed, rows: pages * days, liveRows };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dataDir, json] = process.argv.slice(2);
  if (!dataDir || !json) {
    process.stderr.write('usage: seed-activity.mjs <dataDir> <options as JSON>\n');
    process.exit(2);
  }
  const db = new DatabaseSync(join(dataDir, 'notebook.db'));
  try {
    process.stdout.write(`${JSON.stringify(seedActivity(db, JSON.parse(json)))}\n`);
  } finally {
    db.close();
  }
}
