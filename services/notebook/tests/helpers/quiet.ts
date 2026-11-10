// The service logs to stdout. In tests that run it in this process, its lines would bury the report.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  if (typeof chunk === 'string' && chunk.includes(' desk-notebook ')) return true;
  return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;
