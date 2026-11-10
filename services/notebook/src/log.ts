// One line per event on stdout, for journald. Page ids and counts are fine here. Note text, titles, tab names, search
// queries and payloads never are, and neither is an error's message: SQLite's and fs's can hold a title or a path.
const sanitize = (s: string): string => s.replace(/[^\w .:=,/()[\]-]/g, '?').slice(0, 240);

export function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} desk-notebook ${msg}\n`);
}

/** What may be said about an error: its class and code, never its message. */
export function errName(e: unknown): string {
  if (e && typeof e === 'object') {
    const { name, code, errcode } = e as { name?: unknown; code?: unknown; errcode?: unknown };
    const n = typeof name === 'string' ? name : 'Error';
    const c = typeof code === 'string' || typeof code === 'number' ? ` ${code}` : '';
    const x = typeof errcode === 'number' ? ` ${errcode}` : '';
    return sanitize(`${n}${c}${x}`);
  }
  return 'non-error';
}

/**
 * Hocuspocus and Yjs log through console, with whole Error objects. In this process that is reduced to the first
 * string, sanitised, and the class of each error. A document name a client sent is the only client text that reaches
 * those strings, and sanitize() and the length cap keep what's left of it harmless.
 */
export function guardConsole(): void {
  const say = (level: 'INFO' | 'WARN' | 'ERROR') => (...args: unknown[]): void => {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') parts.push(sanitize(a));
      else if (a instanceof Error || (a && typeof a === 'object' && 'stack' in a)) parts.push(errName(a));
      else parts.push(typeof a);
    }
    log(level, `lib: ${parts.join(' ')}`);
  };
  console.log = say('INFO');
  console.info = say('INFO');
  console.debug = () => undefined;
  console.warn = say('WARN');
  console.error = say('ERROR');
}
