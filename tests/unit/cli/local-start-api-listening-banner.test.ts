import { describe, expect, it, vi } from 'vite-plus/test';

import {
  formatServerListeningBanner,
  printPerServerRouteTables,
} from '../../../src/cli/commands/local-start-api.ts';

/** The URL between `Server listening on ` and the two-space label separator. */
function bannerUrl(banner: string): string {
  const match = /^Server listening on (\S+) {2}\(.*\)\n$/.exec(banner);
  if (!match?.[1]) throw new Error(`not a listening banner: ${JSON.stringify(banner)}`);
  return match[1];
}

// go-to-k/cdkd#2338: `--host ::` printed `http://:::3000`, which no URL parser accepts.
describe('formatServerListeningBanner', () => {
  it('brackets an IPv6 host so the printed URL parses', () => {
    const banner = formatServerListeningBanner('http', '::', 3000, '', 'MyApi');
    expect(banner).toBe('Server listening on http://[::]:3000  (MyApi)\n');
    expect(new URL(bannerUrl(banner)).port).toBe('3000');
  });

  it('keeps the WebSocket path suffix after the bracketed authority', () => {
    const banner = formatServerListeningBanner('ws', '::1', 3001, '/prod', 'Ws (WebSocket API)');
    expect(banner).toBe('Server listening on ws://[::1]:3001/prod  (Ws (WebSocket API))\n');
    expect(new URL(bannerUrl(banner)).pathname).toBe('/prod');
  });

  it('leaves an IPv4 banner byte-identical', () => {
    expect(formatServerListeningBanner('https', '127.0.0.1', 3000, '', 'MyApi')).toBe(
      'Server listening on https://127.0.0.1:3000  (MyApi)\n'
    );
  });
});

describe('printPerServerRouteTables', () => {
  it('brackets an IPv6 host in the per-API section header', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printPerServerRouteTables([
        { group: { displayName: 'MyApi', routes: [] }, server: { host: '::', port: 3000 } },
      ] as never);
      expect(writeSpy.mock.calls[0]?.[0]).toBe('\nMyApi  (http://[::]:3000)\n');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
