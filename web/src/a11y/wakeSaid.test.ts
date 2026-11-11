import { describe, expect, it } from 'vitest';
import { wakeWords } from './wakeSaid';

const s = (vm: string, phase: string | null = null) => ({ vm, phase }) as Parameters<typeof wakeWords>[2];

describe('wakeWords', () => {
  it('says nothing for a desk seen for the first time, or known only from the mirror', () => {
    expect(wakeWords('Personal', undefined, s('running'))).toBeNull();
    expect(wakeWords('Personal', s('unknown'), s('stopped'))).toBeNull();
    expect(wakeWords('Personal', s('unknown'), s('running'))).toBeNull();
    expect(wakeWords('Personal', s('running'), s('unknown'))).toBeNull();
  });

  it('a wake: waking once, not its steps, then awake', () => {
    expect(wakeWords('Personal', s('stopped'), s('starting', 'starting'))).toBe('Personal desk is waking');
    expect(wakeWords('Personal', s('starting', 'starting'), s('starting', 'booting'))).toBeNull();
    expect(wakeWords('Personal', s('starting', 'booting'), s('starting', 'connecting'))).toBeNull();
    expect(wakeWords('Personal', s('starting', 'connecting'), s('running', 'ready'))).toBe('Personal desk is awake');
  });

  it('a queue: waiting for capacity, then waking once there is room', () => {
    expect(wakeWords('Work', s('stopped'), s('starting', 'queued'))).toBe('Work desk is waiting for capacity');
    expect(wakeWords('Work', s('starting', 'queued'), s('starting', 'queued'))).toBeNull();
    expect(wakeWords('Work', s('starting', 'queued'), s('starting', 'booting'))).toBe('Work desk is waking');
  });

  it("a wake that fails says so once, and a retry wakes again", () => {
    expect(wakeWords('Personal', s('starting', 'booting'), s('starting', 'failed'))).toBe("Personal desk couldn't wake");
    expect(wakeWords('Personal', s('starting', 'booting'), s('error'))).toBe("Personal desk couldn't wake");
    expect(wakeWords('Personal', s('error'), s('error'))).toBeNull();
    expect(wakeWords('Personal', s('error'), s('starting', 'starting'))).toBe('Personal desk is waking');
    expect(wakeWords('Personal', s('error'), s('running'))).toBe('Personal desk is awake');
  });

  it('going to sleep, and asleep', () => {
    expect(wakeWords('Personal', s('running'), s('stopping'))).toBe('Personal desk is going to sleep');
    expect(wakeWords('Personal', s('stopping'), s('stopping'))).toBeNull();
    expect(wakeWords('Personal', s('stopping'), s('stopped'))).toBe('Personal desk is asleep');
    expect(wakeWords('Personal', s('running'), s('stopped'))).toBe('Personal desk is asleep');
  });

  it('a new desk that finishes setting up is ready; nothing else repeats', () => {
    expect(wakeWords('Personal', s('setting-up'), s('running'))).toBe('Personal desk is ready');
    expect(wakeWords('Personal', s('running'), s('running'))).toBeNull();
    expect(wakeWords('Personal', s('stopped'), s('stopped'))).toBeNull();
    expect(wakeWords('Personal', s('running'), s('held'))).toBeNull();
  });
});
