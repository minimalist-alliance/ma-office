// desk-notebook's entry point. Everything it needs comes from the environment (docker/desk-notebook.env).
import { errName, guardConsole, log } from './log.ts';
import { NewerSchemaError } from './db.ts';
import { startService, type Service } from './service.ts';

/** Files at most 0640 and directories at most 0750. The socket's own umask is set around its bind. */
process.umask(0o027);
guardConsole();

const env = process.env;
let service: Service | null = null;
let stopping = false;

// Nothing a client sends should reach these. If something does, it's one line and the service goes on: what's committed
// is safe either way, and one session's bad message mustn't cost everyone their connection.
process.on('unhandledRejection', (e) => log('ERROR', `unhandled rejection ${errName(e)}`));
process.on('uncaughtException', (e) => log('ERROR', `uncaught exception ${errName(e)}`));

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  const t0 = performance.now();
  // Docker's stop timeout is 30 s. A store is milliseconds, so this only stops a hang.
  setTimeout(() => {
    log('ERROR', 'shutdown took too long, exiting');
    process.exit(1);
  }, 25_000).unref();
  try {
    await service?.stop();
    log('INFO', `stopped on ${signal} in ${(performance.now() - t0).toFixed(0)} ms`);
    process.exit(0);
  } catch (e) {
    log('ERROR', `stop failed ${errName(e)}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  const num = (name: string): number | undefined => (env[name] ? Number(env[name]) : undefined);
  const commitMs = num('DESK_NOTEBOOK_COMMIT_MS');
  const storeDebounceMs = num('DESK_NOTEBOOK_STORE_DEBOUNCE_MS');
  const storeMaxWaitMs = num('DESK_NOTEBOOK_STORE_MAX_MS');
  const readableDebounceMs = num('DESK_NOTEBOOK_READABLE_MS');
  const pageFullBytes = num('DESK_NOTEBOOK_PAGE_FULL_BYTES');
  const backlogPageBytes = num('DESK_NOTEBOOK_BACKLOG_PAGE_BYTES');
  const backlogTotalBytes = num('DESK_NOTEBOOK_BACKLOG_TOTAL_BYTES');
  const refuseAfterMs = num('DESK_NOTEBOOK_REFUSE_AFTER_MS');
  service = await startService({
    dataDir: env['DESK_NOTEBOOK_DATA_DIR'] || '/data/notebook',
    socketPath: env['DESK_NOTEBOOK_SOCKET'] || '/run/desk-notebook/notebook.sock',
    version: env['DESK_NOTEBOOK_VERSION'] || 'dev',
    debugStores: env['DESK_NOTEBOOK_DEBUG'] === '1',
    ...(commitMs !== undefined ? { commitMs } : {}),
    ...(storeDebounceMs !== undefined ? { storeDebounceMs } : {}),
    ...(storeMaxWaitMs !== undefined ? { storeMaxWaitMs } : {}),
    ...(readableDebounceMs !== undefined ? { readableDebounceMs } : {}),
    ...(pageFullBytes !== undefined ? { pageFullBytes } : {}),
    ...(backlogPageBytes !== undefined ? { backlogPageBytes } : {}),
    ...(backlogTotalBytes !== undefined ? { backlogTotalBytes } : {}),
    ...(refuseAfterMs !== undefined ? { refuseAfterMs } : {}),
  });
  const rssMiB = (process.memoryUsage.rss() / 1048576).toFixed(1);
  log('INFO', `ready in ${(process.uptime() * 1000).toFixed(0)} ms rss=${rssMiB}MiB node=${process.version} arch=${process.arch} version=${env['DESK_NOTEBOOK_VERSION'] || 'dev'}`);
} catch (e) {
  if (e instanceof NewerSchemaError) log('ERROR', `refusing to start: schema ${e.found} is newer than this release's ${e.supported}. Nothing was changed.`);
  else log('ERROR', `start failed ${errName(e)}`);
  process.exit(1);
}
