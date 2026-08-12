import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalizeIpProtocolValue,
  canonicalizeIpProtocols,
} from '../../../src/analyzer/drift-protocol-normalize.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const INGRESS = 'AWS::EC2::SecurityGroupIngress';
const EGRESS = 'AWS::EC2::SecurityGroupEgress';
const GROUP = 'AWS::EC2::SecurityGroup';

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

describe('canonicalizeIpProtocols', () => {
  it('collapses the standalone-ingress phantom drift the issue reports', () => {
    // cdkd sent and recorded '6'; AWS holds 'tcp'.
    const { baseline, aws } = canonicalizeIpProtocols(
      { IpProtocol: '6', FromPort: 443, ToPort: 443 },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
      INGRESS
    );
    expect(baseline['IpProtocol']).toBe('tcp');
    expect(aws['IpProtocol']).toBe('tcp');
    expect(calculateResourceDrift(baseline, aws)).toEqual([]);
  });

  it('collapses the same difference on the standalone egress type', () => {
    const { baseline, aws } = canonicalizeIpProtocols(
      { IpProtocol: 17 },
      { IpProtocol: 'udp' },
      EGRESS
    );
    expect(calculateResourceDrift(baseline, aws)).toEqual([]);
  });

  it('covers the inline SecurityGroup rule arrays #1633 deliberately does not touch', () => {
    const { baseline, aws } = canonicalizeIpProtocols(
      {
        GroupDescription: 'demo',
        SecurityGroupIngress: [{ IpProtocol: 6, CidrIp: '10.0.0.0/16' }, { IpProtocol: '58' }],
        SecurityGroupEgress: [{ IpProtocol: '1' }],
      },
      {
        GroupDescription: 'demo',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', CidrIp: '10.0.0.0/16' },
          { IpProtocol: 'icmpv6' },
        ],
        SecurityGroupEgress: [{ IpProtocol: 'icmp' }],
      },
      GROUP
    );
    expect(calculateResourceDrift(baseline, aws)).toEqual([]);
  });

  it('still reports a REAL protocol change instead of masking it', () => {
    const { baseline, aws } = canonicalizeIpProtocols(
      { IpProtocol: '6' },
      { IpProtocol: 'udp' },
      INGRESS
    );
    expect(calculateResourceDrift(baseline, aws)).toHaveLength(1);
  });

  it('still reports drift on a sibling property of a normalized rule', () => {
    const { baseline, aws } = canonicalizeIpProtocols(
      { IpProtocol: 6, FromPort: 443 },
      { IpProtocol: 'tcp', FromPort: 8443 },
      INGRESS
    );
    const changes = calculateResourceDrift(baseline, aws);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe('FromPort');
  });

  it('leaves an IpProtocol on an unlisted resource type untouched', () => {
    // The path table is closed on purpose: a blanket rewrite of any key named
    // IpProtocol would turn an unrelated '6' into 'tcp'.
    const before = { IpProtocol: '6' };
    const { baseline, aws } = canonicalizeIpProtocols(before, { IpProtocol: '6' }, 'AWS::S3::Bucket');
    expect(baseline).toBe(before);
    expect(baseline['IpProtocol']).toBe('6');
    expect(aws['IpProtocol']).toBe('6');
  });

  it('returns the ORIGINAL objects when nothing needs rewriting', () => {
    const baselineIn = { IpProtocol: 'tcp' };
    const awsIn = { IpProtocol: 'tcp' };
    const { baseline, aws } = canonicalizeIpProtocols(baselineIn, awsIn, INGRESS);
    expect(baseline).toBe(baselineIn);
    expect(aws).toBe(awsIn);
  });

  it('does not mutate its inputs when it does rewrite', () => {
    const baselineIn = { IpProtocol: 6 };
    const awsIn = { IpProtocol: 'tcp' };
    canonicalizeIpProtocols(baselineIn, awsIn, INGRESS);
    expect(baselineIn['IpProtocol']).toBe(6);
  });

  it('does not mutate the ARRAY branch either — the rule object, the list, or the bag', () => {
    // The top-level non-mutation test above leaves the array path unfenced:
    // rewriting `rule[key]` / `bag[arrayKey]` in place would satisfy every
    // `toEqual` assertion in this file.
    const rule = { IpProtocol: 6, CidrIp: '10.0.0.0/16' };
    const list = [rule];
    const baselineIn = { SecurityGroupIngress: list };
    const { baseline } = canonicalizeIpProtocols(baselineIn, {}, GROUP);

    expect(rule['IpProtocol']).toBe(6);
    expect(list[0]).toBe(rule);
    expect(baselineIn['SecurityGroupIngress']).toBe(list);
    // ...and the returned copy really did change.
    expect((baseline['SecurityGroupIngress'] as Array<Record<string, unknown>>)[0]).toEqual({
      IpProtocol: 'tcp',
      CidrIp: '10.0.0.0/16',
    });
  });

  it('tolerates a rule array that is missing, malformed, or holds non-object elements', () => {
    expect(() =>
      canonicalizeIpProtocols(
        { SecurityGroupIngress: 'not-an-array' },
        { SecurityGroupIngress: [null, 'x', { IpProtocol: '6' }] },
        GROUP
      )
    ).not.toThrow();
    const { aws } = canonicalizeIpProtocols(
      {},
      { SecurityGroupIngress: [null, 'x', { IpProtocol: '6' }] },
      GROUP
    );
    expect((aws['SecurityGroupIngress'] as unknown[])[2]).toEqual({ IpProtocol: 'tcp' });
  });

  it('leaves a rule element that carries no IpProtocol alone', () => {
    const ruleWithoutProtocol = { CidrIp: '10.0.0.0/16' };
    const { aws } = canonicalizeIpProtocols(
      {},
      { SecurityGroupIngress: [ruleWithoutProtocol] },
      GROUP
    );
    expect((aws['SecurityGroupIngress'] as unknown[])[0]).toBe(ruleWithoutProtocol);
  });
});
