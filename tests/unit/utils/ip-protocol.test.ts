import { describe, expect, it } from 'vite-plus/test';
import { canonicalizeIpProtocolValue } from '../../../src/utils/ip-protocol.js';

describe('canonicalizeIpProtocolValue', () => {
  // The four renames MEASURED against real AWS (us-east-1, 2026-08-12), for
  // both the string form cdkd sends and the number form an unquoted YAML
  // template parses to.
  it.each<[string, string]>([
    ['1', 'icmp'],
    ['6', 'tcp'],
    ['17', 'udp'],
    ['58', 'icmpv6'],
  ])('renames the protocol number %s to %s', (sent, canonical) => {
    expect(canonicalizeIpProtocolValue(sent)).toBe(canonical);
    expect(canonicalizeIpProtocolValue(Number(sent))).toBe(canonical);
  });

  // Everything else AWS reads back as the number it was given. These are the
  // exact values probed; a rename appearing here later would be a real AWS
  // behavior change, not something to guess at now.
  it.each<string>(['-1', '0', '2', '4', '27', '41', '47', '50', '51', '88', '89', '94', '103', '112', '132', '255'])(
    'leaves the un-renamed protocol %s as its string form',
    (sent: string) => {
      expect(canonicalizeIpProtocolValue(sent)).toBe(sent);
      expect(canonicalizeIpProtocolValue(Number(sent))).toBe(sent);
    }
  );

  // AWS collapsed `TCP` / `Tcp` / `tcp` on the same port into ONE `tcp`
  // permission in the readback, so a name is matched case-insensitively.
  it.each<[string, string]>([
    ['TCP', 'tcp'],
    ['Tcp', 'tcp'],
    ['UDP', 'udp'],
    ['ICMPv6', 'icmpv6'],
    ['ICMP', 'icmp'],
  ])('lower-cases the canonical protocol name %s', (sent: string, canonical: string) => {
    expect(canonicalizeIpProtocolValue(sent)).toBe(canonical);
  });

  it('leaves an unrecognized string exactly as-is rather than folding its case', () => {
    // Folding an arbitrary string would risk collapsing two genuinely
    // different values; only the four KNOWN names are lowered.
    expect(canonicalizeIpProtocolValue('SomethingElse')).toBe('SomethingElse');
  });

  it('leaves an unresolved intrinsic and other non-protocol shapes untouched', () => {
    const intrinsic = { Ref: 'ProtocolParam' };
    expect(canonicalizeIpProtocolValue(intrinsic)).toBe(intrinsic);
    expect(canonicalizeIpProtocolValue(undefined)).toBeUndefined();
    expect(canonicalizeIpProtocolValue(null)).toBeNull();
    expect(canonicalizeIpProtocolValue(true)).toBe(true);
  });

  it('stringifies EVERY number, not only an integer one', () => {
    // `sgProtocolKey` has stringified every number since #1633 so a legacy
    // record holding the NUMBER -1 still keys against AWS's '-1'. Narrowing
    // that to integers would regress a malformed 6.5 to a number and collapse
    // NaN / Infinity onto one JSON `null` bucket — the merging that key exists
    // to avoid.
    expect(canonicalizeIpProtocolValue(6.5)).toBe('6.5');
    expect(canonicalizeIpProtocolValue(Number.NaN)).toBe('NaN');
    expect(canonicalizeIpProtocolValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('does not recognize a non-canonical numeric spelling (recorded bound)', () => {
    // A zero-padded / hex form misses the table by design: accepting it would
    // mean parsing rather than a closed measured table.
    expect(canonicalizeIpProtocolValue('06')).toBe('06');
    expect(canonicalizeIpProtocolValue('0x6')).toBe('0x6');
  });
});
