import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #1648. `canonicalizeDesiredProperties` is applied to BOTH diff sides,
 * so folding the protocol NAME here makes two spellings of one protocol compare
 * equal. Without it, a template edit `IpProtocol: 6` -> `'tcp'` reads as a
 * changed property — and because `IpProtocol` is create-only on the standalone
 * type, that classifies as a REPLACEMENT of a rule AWS already holds exactly.
 */
describe('EC2Provider.canonicalizeDesiredProperties — IpProtocol name folding (#1648)', () => {
  const provider = new EC2Provider();
  const canon = (type: string, props: Record<string, unknown>) =>
    provider.canonicalizeDesiredProperties(type, props);

  describe('AWS::EC2::SecurityGroupIngress (standalone, create-only property)', () => {
    it('folds the four numbers AWS renames, so the two spellings compare equal', () => {
      const asNumber = canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 6, FromPort: 443 });
      const asName = canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 'tcp', FromPort: 443 });
      expect(asNumber).toEqual(asName);
      expect(asNumber['IpProtocol']).toBe('tcp');
    });

    it('folds a case-different name', () => {
      expect(canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 'TCP' })['IpProtocol']).toBe(
        'tcp'
      );
    });

    it('still distinguishes two GENUINELY different protocols', () => {
      const tcp = canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 6 });
      const udp = canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 17 });
      expect(tcp).not.toEqual(udp);
    });

    it('keeps the #1633 stringification for a protocol AWS does NOT rename', () => {
      // 47 (GRE) reads back as the number, so only the TYPE fold applies.
      expect(canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: 47 })['IpProtocol']).toBe('47');
      expect(canon('AWS::EC2::SecurityGroupIngress', { IpProtocol: -1 })['IpProtocol']).toBe('-1');
    });

    it('leaves an ABSENT IpProtocol absent rather than defaulting it', () => {
      // The comparator only descends into keys present in state, so inventing
      // the default here would START comparing a key the template never had.
      expect(canon('AWS::EC2::SecurityGroupIngress', { FromPort: 443 })).not.toHaveProperty(
        'IpProtocol'
      );
    });
  });

  describe('AWS::EC2::SecurityGroup (inline rule lists)', () => {
    it('folds every element of both rule lists', () => {
      const result = canon('AWS::EC2::SecurityGroup', {
        GroupDescription: 'demo',
        SecurityGroupIngress: [{ IpProtocol: 6 }, { IpProtocol: '58' }],
        SecurityGroupEgress: [{ IpProtocol: 'UDP' }],
      });
      expect(result['SecurityGroupIngress']).toEqual([
        { IpProtocol: 'tcp' },
        { IpProtocol: 'icmpv6' },
      ]);
      expect(result['SecurityGroupEgress']).toEqual([{ IpProtocol: 'udp' }]);
    });

    it('returns the ORIGINAL object when nothing needs folding, and never mutates', () => {
      const rule = { IpProtocol: 'tcp' };
      const props = { SecurityGroupIngress: [rule] };
      expect(canon('AWS::EC2::SecurityGroup', props)).toBe(props);

      const numeric = { IpProtocol: 6 };
      const numericProps = { SecurityGroupIngress: [numeric] };
      canon('AWS::EC2::SecurityGroup', numericProps);
      expect(numeric['IpProtocol']).toBe(6);
      expect(numericProps['SecurityGroupIngress'][0]).toBe(numeric);
    });

    it('leaves a malformed rule list or element alone so AWS validation still sees it', () => {
      const bad = { SecurityGroupIngress: 'not-an-array' };
      expect(canon('AWS::EC2::SecurityGroup', bad)).toBe(bad);
      const mixed = canon('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: [null, 'x', { IpProtocol: 6 }],
      });
      const list = mixed['SecurityGroupIngress'] as unknown[];
      expect(list[0]).toBeNull();
      expect(list[1]).toBe('x');
      expect(list[2]).toEqual({ IpProtocol: 'tcp' });
    });
  });

  it('leaves an unrelated resource type untouched', () => {
    const props = { IpProtocol: 6 };
    expect(canon('AWS::S3::Bucket', props)).toBe(props);
  });
});
