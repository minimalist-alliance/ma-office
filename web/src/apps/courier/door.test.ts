// Courier's switch: absent follows `COURIER_READY`; client-config's `courier.enabled` overrides it both ways.
import { describe, expect, it } from 'vitest';
import { comingLater } from '../../canvas/layout';
import type { ClientConfig } from '../../platform/clientConfig';
import { COURIER_READY, courierOn } from './door';

const cfg = (courier?: { enabled?: boolean }): ClientConfig => ({ api: 'x', auth: { domain: 'd', clientId: 'c', redirectUri: 'r', logoutUri: 'l', scopes: [] }, ...(courier ? { courier } : {}) });

describe("Courier's switch", () => {
  it("is off until linked mailboxes reach main, then on: absent follows COURIER_READY", () => {
    expect(courierOn(cfg())).toBe(COURIER_READY);
    expect(courierOn(null)).toBe(COURIER_READY);
    expect(courierOn(cfg({}))).toBe(COURIER_READY);
  });
  it('turns on with enabled: true, and off with the kill switch', () => {
    expect(courierOn(cfg({ enabled: true }))).toBe(true);
    expect(courierOn(cfg({ enabled: false }))).toBe(false);
  });
  it('keeps the tile "Coming later" while it is off', () => {
    // No client-config has loaded here, so the tile follows COURIER_READY.
    expect(comingLater('courier')).toBe(!COURIER_READY);
    expect(comingLater('notebook')).toBe(false);
  });
});
