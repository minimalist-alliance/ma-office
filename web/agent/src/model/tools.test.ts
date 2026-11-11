import { describe, expect, it } from 'vitest';
import type { RunningCall } from '../client/types';
import { alsoText, callWords, chipOf, runningFor, stripOf, toolsRunningText, wordTarget } from './tools';

const call = (over: Partial<RunningCall>): RunningCall => ({
  callId: 'c1',
  agentId: 'scout',
  runId: 'r1',
  tool: 'browser_read',
  doing: 'Reading a web page',
  target: 'reviews.example.org/lamps/2026',
  risk: 'read',
  startedAt: 1000,
  approvedBy: 'none',
  stoppable: true,
  state: 'running',
  ...over,
});

describe('the running strip (spec 2.2 to 2.4)', () => {
  const agents = [
    { id: 'scout', name: 'Scout' },
    { id: 'writer', name: 'Writer' },
  ];

  it('puts this agent’s calls first, oldest first, and groups the others by agent', () => {
    const v = stripOf([call({ callId: 'b', startedAt: 3000 }), call({ callId: 'w', agentId: 'writer', startedAt: 500 }), call({ callId: 'a', startedAt: 2000 }), call({ callId: 'w2', agentId: 'writer', startedAt: 4000 })], 'scout', agents);
    expect(v.mine.map((c) => c.callId)).toEqual(['a', 'b']);
    expect(v.others).toEqual([{ agentId: 'writer', name: 'Writer', count: 2 }]);
    expect(alsoText('Writer', 1)).toBe('Also running: Writer, 1 tool');
    expect(toolsRunningText(3)).toBe('3 tools running');
  });

  it('times by the desk’s clock', () => {
    expect(runningFor({ startedAt: 10_000 }, 50_000, 2_000)).toBe(42_000);
    expect(runningFor({ startedAt: 99_000 }, 50_000, 0)).toBe(0);
  });

  it('words a call, and an address as its host and path', () => {
    expect(callWords(call({}))).toEqual({ label: 'Reading a web page', target: 'reviews.example.org/lamps/2026', level: 'read' });
    expect(callWords(call({ doing: '', tool: 'browser_open', risk: 'egress', target: 'https://shop.example.com/compare?item=x' }))).toEqual({ label: 'Opening a page', target: 'shop.example.com/compare', level: 'send' });
  });
});

describe('a reply’s chips (spec 2.5)', () => {
  it('says what it did, on what, how long', () => {
    expect(chipOf({ name: 'browser_read', summary: 'Read a web page', ok: true, risk: 'read', path: 'reviews.example.org/lamps', durationMs: 4000 })).toEqual({ level: 'read', warn: false, word: 'Read a web page', target: 'reviews.example.org/lamps', time: '0:04', result: 'done', why: null });
    expect(chipOf({ name: 'notebook_read', summary: 'x', ok: true, target: { kind: 'page', pageId: 'p', title: 'Home office' } })?.target).toBe('“Home office”');
  });

  it('a tool it doesn’t know uses the desk’s few words', () => {
    expect(chipOf({ name: 'weather_get', summary: 'Checked the weather', ok: true })?.word).toBe('Checked the weather');
    expect(chipOf({ name: 'weather_get', summary: 'x', ok: true, durationMs: 300 })?.time).toBe('0:01');
  });

  it('a failed one says so, with the desk’s reason; a stopped one says Stopped', () => {
    expect(chipOf({ name: 'browser_open', summary: 'Opened', ok: false, risk: 'egress', reason: 'The site didn’t answer.' })).toMatchObject({ word: 'Didn’t finish', result: 'failed', why: 'The site didn’t answer.', warn: true });
    expect(chipOf({ name: 'browser_read', summary: 'Read', ok: false, stopped: true })?.word).toBe('Stopped');
  });

  it('has none for a call that was declined or never answered: its card says so', () => {
    expect(chipOf({ name: 'notebook_trash', summary: 'x', ok: false, approval: { id: 'ap', decision: 'declined' } })).toBeNull();
    expect(chipOf({ name: 'notebook_trash', summary: 'x', ok: false, approval: { id: 'ap', decision: 'expired' } })).toBeNull();
  });

  it('words a target in a few words', () => {
    expect(wordTarget({ kind: 'file', path: 'a.md', to: 'b.md' })).toBe('a.md → b.md');
    expect(wordTarget({ kind: 'element', origin: 'https://example.com', pageTitle: 'Shop', label: 'Buy', role: 'button' })).toBe('“Buy” on example.com');
    expect(wordTarget({ kind: 'site', origin: 'https://example.org' })).toBe('example.org');
    expect(wordTarget({ kind: 'memory' })).toBeNull();
    expect(wordTarget(null)).toBeNull();
  });
});
