// Whether a lock file is really held (Security's MMH-I2): the scripts are started under `flock <file>`, and an environment
// variable alone proves only the variable. A non-blocking flock of the same file from here fails while another open of it
// holds the lock.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 'held' when another open of the file holds the lock, 'free' when a non-blocking flock got it, 'unknown' without flock. */
export function probeLock(file) {
  if (!existsSync(file)) return 'free';
  const r = spawnSync('flock', ['-n', file, 'true'], { stdio: 'ignore' });
  if (r.error) return 'unknown';
  return r.status === 0 ? 'free' : 'held';
}
