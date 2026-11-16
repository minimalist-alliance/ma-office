// Task files (contract section 3): one JSON file each, under capability/tasks/<area>/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS_ROOT = join(HARNESS, 'capability', 'tasks');

/**
 * The areas the runners know, in order. A new tool's builder adds its area here and its tasks in
 * capability/tasks/<area>/.
 */
export const AREAS = ['files', 'notebook'];

/** Every .json file under a folder, at any depth, sorted by path. */
export function taskFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function readTask(file) {
  const task = JSON.parse(readFileSync(file, 'utf8'));
  Object.defineProperty(task, 'file', { value: file, enumerable: false });
  return task;
}

/** Every task in the given folders (a folder or a list of them). */
export function loadTasks(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.flatMap((d) => taskFiles(resolve(d)).map(readTask));
}

/** One area's tasks, sorted by id. */
export function areaTasks(area, root = TASKS_ROOT) {
  return taskFiles(join(root, area))
    .map(readTask)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
