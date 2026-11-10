import { describe, expect, it } from 'vitest';
import { SUPPORT_ADDRESS, supportAddress, type ClientConfig } from './clientConfig';

const cfg = (support?: string): ClientConfig => ({ api: 'https://api.example', auth: { domain: '', clientId: '', redirectUri: '', logoutUri: '', scopes: [] }, ...(support === undefined ? {} : { links: { support } }) });

describe('supportAddress', () => {
  it("is the one mailbox when client-config has no address: today's links.support is a page", () => {
    expect(supportAddress(null)).toBe(SUPPORT_ADDRESS);
    expect(supportAddress(cfg())).toBe(SUPPORT_ADDRESS);
    expect(supportAddress(cfg('https://platform.minimalistalliance.com/support'))).toBe(SUPPORT_ADDRESS);
  });

  it('takes a mailto: there, and only a plain address', () => {
    expect(supportAddress(cfg('mailto:help@example.com'))).toBe('help@example.com');
    expect(supportAddress(cfg('mailto:help@example.com?subject=Desk'))).toBe('help@example.com');
    expect(supportAddress(cfg('mailto:a@example.com,c@example.org'))).toBe(SUPPORT_ADDRESS);
    expect(supportAddress(cfg('mailto:<script>@x'))).toBe(SUPPORT_ADDRESS);
    expect(supportAddress(cfg('mailto:%E0%A4%A'))).toBe(SUPPORT_ADDRESS);
  });
});
