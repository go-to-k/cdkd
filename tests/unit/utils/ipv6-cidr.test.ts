import { describe, expect, it } from 'vite-plus/test';
import { canonicalizeIpv6Cidr } from '../../../src/utils/ipv6-cidr.js';

describe('IPv6 CIDR comparison canonicalization (#5778)', () => {
  it.each([
    ['2001:0DB8:1234:0001:0:0:0:0/64', '2001:db8:1234:1::/64'],
    ['2001:db8:1234:1::/64', '2001:db8:1234:1::/64'],
    ['2001:db8:1234:1::1234/64', '2001:db8:1234:1::/64'],
    ['::/0', '::/0'], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/0', '::/0'],
    ['::1/128', '::1/128'], ['1::/128', '1::/128'],
    ['2001:db8::ffff/127', '2001:db8::fffe/127'],
    ['2001:db8:1234:1:ffff::/65', '2001:db8:1234:1:8000::/65'],
    ['::ffff:192.0.2.128/128', '::ffff:c000:280/128'],
    ['2001:db8:0:0:1:0:0:1/128', '2001:db8::1:0:0:1/128'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(canonicalizeIpv6Cidr(input)).toBe(expected);
    expect(canonicalizeIpv6Cidr(expected)).toBe(expected);
  });
  it.each(['', '10.0.0.0/24', '2001:db8::', '2001:db8::/129', '2001:db8::/-1', '2001:db8::/64.0', '2001:db8::/64/64', '1::2::3/64', 'fe80::1%eth0/64', '[2001:db8::]/64', '::ffff:192.0.2.999/64', ' 2001:db8::/64'])('leaves unsupported or malformed input unknown: %s', input => {
    expect(canonicalizeIpv6Cidr(input)).toBeUndefined();
  });
});
