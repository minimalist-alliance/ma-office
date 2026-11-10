import { describe, expect, it } from 'vitest';
import { appVersionFor, refusalCode, refusedLine, turnBody } from './turn';

describe('turnBody: the privacy promise', () => {
  it('is exactly these fields, and nothing else', () => {
    const body = turnBody('c_1', 'How do I wake my desk?', { appVersion: '2026.11.06-abc1234', route: 'desk', lastErrorCode: null });
    expect(body).toEqual({
      conversationId: 'c_1',
      message: 'How do I wake my desk?',
      clientContext: { surface: 'office', appVersion: '2026.11.06-abc1234', route: 'desk', lastErrorCode: null },
    });
    expect(Object.keys(body)).toEqual(['conversationId', 'message', 'clientContext']);
    expect(Object.keys(body.clientContext)).toEqual(['surface', 'appVersion', 'route', 'lastErrorCode']);
  });

  it('carries nothing extra even if the context object has more', () => {
    const ctx = { appVersion: 'v1', route: 'home' as const, lastErrorCode: null, page: 'secret page text', title: 'Window title', clipboard: 'pw' };
    expect(JSON.stringify(turnBody(null, 'hi', ctx))).not.toMatch(/secret|Window title|pw"/);
  });

  it('holds every field to its pattern', () => {
    expect(turnBody('', 'x', { appVersion: 'dev', route: 'home', lastErrorCode: null }).conversationId).toBeNull();
    expect(turnBody(null, 'x'.repeat(5000), { appVersion: 'dev', route: 'home', lastErrorCode: null }).message).toHaveLength(4000);
    expect(turnBody(null, 'x', { appVersion: 'dev', route: 'other' as 'home', lastErrorCode: null }).clientContext.route).toBe('home');
    expect(turnBody(null, 'x', { appVersion: 'dev', route: 'home', lastErrorCode: 'desk_unavailable' }).clientContext.lastErrorCode).toBe('desk_unavailable');
    expect(turnBody(null, 'x', { appVersion: 'dev', route: 'home', lastErrorCode: 'Not A Code!' }).clientContext.lastErrorCode).toBeNull();
  });

  it('appVersion matches the contract or says unknown', () => {
    expect(appVersionFor('2026.11.06-abc1234-dirty')).toBe('2026.11.06-abc1234-dirty');
    expect(appVersionFor('dev')).toBe('dev');
    expect(appVersionFor('has space')).toBe('unknown');
    expect(appVersionFor('x'.repeat(41))).toBe('unknown');
    expect(appVersionFor(undefined)).toBe('unknown');
  });

  it("lastErrorCode comes only from connect's own refusal codes", () => {
    expect(refusalCode('suspended')).toBe('account_suspended');
    expect(refusalCode('inactive')).toBe('account_inactive');
    expect(refusalCode('unavailable')).toBe('desk_unavailable');
    expect(refusalCode(null)).toBeNull();
  });
});

describe('refusedLine', () => {
  it('says each refusal plainly', () => {
    expect(refusedLine(409, 'turn_in_progress')).toMatch(/still answering/);
    expect(refusedLine(429, 'rate_limited')).toMatch(/minute/);
    expect(refusedLine(503, 'busy')).toMatch(/busy/);
    expect(refusedLine(500, null)).toMatch(/can't answer/);
  });
});

describe('turnBody with files', () => {
  const ctx = { appVersion: 'v1', route: 'home' as const, lastErrorCode: null };
  it('adds attachments only when there are some, and keeps the other fields', () => {
    expect(Object.keys(turnBody(null, 'hi', ctx, []))).toEqual(['conversationId', 'message', 'clientContext']);
    const body = turnBody('c_1', 'What is this?', ctx, [{ name: 'a.pdf', type: 'application/pdf', data: 'AQID' }]);
    expect(body).toEqual({
      conversationId: 'c_1',
      message: 'What is this?',
      clientContext: { surface: 'office', appVersion: 'v1', route: 'home', lastErrorCode: null },
      attachments: [{ name: 'a.pdf', type: 'application/pdf', data: 'AQID' }],
    });
  });
  it('carries only name, type and data of a file', () => {
    const body = turnBody(null, 'x', ctx, [{ name: 'a', type: 't', data: 'd', extra: 'nope' } as never]);
    expect(Object.keys(body.attachments![0]!)).toEqual(['name', 'type', 'data']);
  });
});
