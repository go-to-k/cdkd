import { describe, expect, it } from 'vite-plus/test';

import { formatAuthority, formatHostForAuthority } from '../../../src/utils/url-authority.ts';

describe('formatHostForAuthority', () => {
  it.each([
    ['::', '[::]'],
    ['::1', '[::1]'],
    ['FE80::1', '[FE80::1]'],
    ['::ffff:127.0.0.1', '[::ffff:127.0.0.1]'],
  ])('brackets the IPv6 literal %s', (host, expected) => {
    expect(formatHostForAuthority(host)).toBe(expected);
  });

  it('is idempotent on an already-bracketed literal', () => {
    expect(formatHostForAuthority('[::1]')).toBe('[::1]');
  });

  it('drops a zone id, bracketed or not', () => {
    expect(formatHostForAuthority('fe80::1%en0')).toBe('[fe80::1]');
    expect(formatHostForAuthority('[fe80::1%en0]')).toBe('[fe80::1]');
  });

  it.each(['127.0.0.1', '0.0.0.0', 'localhost', 'host.docker.internal', ''])(
    'leaves %j untouched',
    (host) => {
      expect(formatHostForAuthority(host)).toBe(host);
    }
  );

  it('does not bracket a colon-bearing string that is not an address', () => {
    expect(formatHostForAuthority('example.test\r\nx-injected: yes')).toBe(
      'example.test\r\nx-injected: yes'
    );
  });
});

describe('formatAuthority', () => {
  it.each([
    ['::', 3000, 'http://[::]:3000/'],
    ['::1', 8080, 'http://[::1]:8080/'],
    ['fe80::1%en0', 8080, 'http://[fe80::1]:8080/'],
    ['127.0.0.1', 3000, 'http://127.0.0.1:3000/'],
    ['localhost', '443', 'http://localhost:443/'],
  ] as const)('composes a WHATWG-parseable authority for %s', (host, port, href) => {
    expect(new URL(`http://${formatAuthority(host, port)}/`).href).toBe(href);
  });
});
