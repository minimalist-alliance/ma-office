import { describe, expect, it } from 'vitest';
import type { AppRecord } from './store';
import { problemWords, summaryOf, widgetOf } from './widget';

const rec = (p: Partial<AppRecord>): AppRecord => ({ id: 'org.example.tally', name: 'Tally', version: '0.1.0', publisher: '', description: '', state: 'running', problem: null, summary: null, window: null, permissions: [], ...p });

describe("a tile's widget, from the app's summary (contract 3.1)", () => {
  it('the first row is the title, its detail and the other rows the body, its time the foot', () => {
    const w = widgetOf(rec({ summary: { rows: [{ text: '3', detail: 'Tally', time: '2026-11-11T21:04:05Z' }, { text: 'Second', detail: 'more' }, { text: 'Third' }] } }));
    expect(w.widget?.title).toBe('3');
    expect(w.widget?.text).toBe('Tally\nSecond · more\nThird');
    expect(w.widget?.foot).toMatch(/^Updated \d/);
  });

  it("the app's own problem line takes the foot; a badge passes through; no rows is nothing", () => {
    expect(widgetOf(rec({ summary: { badge: 2, problem: 'Disk is full', rows: [{ text: 'x' }] } }))).toEqual({ badge: 2, widget: { title: 'x', foot: 'Disk is full' } });
    expect(widgetOf(rec({ summary: { rows: [] } }))).toEqual({});
    expect(widgetOf(rec({ summary: 'nonsense' }))).toEqual({});
  });

  it('cuts what an app says to the contract: 6 rows of 120 characters, a problem of 40, a whole badge', () => {
    const s = summaryOf({ badge: 2.7, problem: 'p'.repeat(60), rows: Array.from({ length: 9 }, () => ({ text: 't'.repeat(200) })) })!;
    expect(s.rows).toHaveLength(6);
    expect(s.rows[0]!.text).toHaveLength(120);
    expect(s.problem).toHaveLength(40);
    expect(s.badge).toBe(2);
  });

  it("a stopped app's tile says why in the contract's words (section 2.6)", () => {
    expect(widgetOf(rec({ state: 'failed', problem: 'no_hello' }))).toEqual({ widget: { title: '', text: 'Couldn’t start' }, problem: 'Couldn’t start' });
    expect(problemWords({ state: 'failed', problem: 'memory' })).toBe('Stopped: used too much memory');
    expect(problemWords({ state: 'failed', problem: 'crashed' })).toBe('Stopped: it kept closing');
    expect(problemWords({ state: 'failed', problem: 'needs_update' })).toBe('Needs an update');
    expect(problemWords({ state: 'disabled', problem: 'revoked' })).toBe('Turned off by Minimalist Alliance');
    expect(problemWords({ state: 'running', problem: null })).toBeNull();
    expect(problemWords({ state: 'stopped', problem: null })).toBeNull();
  });
});
