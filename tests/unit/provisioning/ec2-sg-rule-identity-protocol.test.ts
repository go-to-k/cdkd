import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import {
  reconcileSgRules,
  EC2Provider,
} from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #1643. `sgProtocolKey` is the ONE definition of protocol identity, and
 * it feeds three consumers: the standalone-rule lookup (covered in
 * `ec2-provider-readcurrentstate.test.ts`), the inline-rule `reconcileSgRules`
 * ordering, and the write-side revoke/authorize diff in
 * `applySecurityGroupRuleDiff`.
 *
 * Before these tests, a mutation that canonicalized ONLY inside the standalone
 * lookup left the whole suite green while the other two consumers silently lost
 * the fix — which is exactly what "one definition of identity" is supposed to
 * prevent.
 */
describe('SG rule identity across protocol spellings (#1643)', () => {
  it('reconcileSgRules matches a state rule spelled with the protocol NUMBER to the AWS rule spelled with its NAME', () => {
    const awsRules = [
      { IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '10.0.2.0/24' },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.1.0/24' },
    ];
    // State holds the template's numeric spelling, in the opposite order.
    const stateRules = [
      { IpProtocol: '6', FromPort: 443, ToPort: 443, CidrIp: '10.0.1.0/24' },
      { IpProtocol: 17, FromPort: 53, ToPort: 53, CidrIp: '10.0.2.0/24' },
    ];

    const reconciled = reconcileSgRules(awsRules, stateRules, 'ingress');

    // Both matched, so both are reordered into state's order rather than being
    // appended as unmatched leftovers.
    expect(reconciled).toEqual([
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.1.0/24' },
      { IpProtocol: 'udp', FromPort: 53, ToPort: 53, CidrIp: '10.0.2.0/24' },
    ]);
  });

  it('reconcileSgRules still leaves a genuinely different protocol unmatched', () => {
    const awsRules = [{ IpProtocol: 'udp', FromPort: 443, ToPort: 443, CidrIp: '10.0.1.0/24' }];
    // '6' is tcp, which is NOT the udp rule AWS reports.
    const stateRules = [{ IpProtocol: '6', FromPort: 443, ToPort: 443, CidrIp: '10.0.1.0/24' }];

    const reconciled = reconcileSgRules(awsRules, stateRules, 'ingress');

    // Unmatched rules are passed through at the end, unchanged.
    expect(reconciled).toEqual(awsRules);
  });

  it('reconcileSgRules treats a case-different name as the same rule', () => {
    const awsRules = [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/24' }];
    const stateRules = [{ IpProtocol: 'TCP', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/24' }];

    expect(reconcileSgRules(awsRules, stateRules, 'ingress')).toEqual(awsRules);
  });

  // The WRITE side — `applySecurityGroupRuleDiff`, reached from
  // `EC2Provider.update`. This is the destructive consumer: without the shared
  // key, a `--revert` (whose previous side is the AWS readback `tcp` and whose
  // desired side is the recorded `'6'`) keys every rule differently and revokes
  // THEN re-authorizes all of them — a window with no rules on a live group.
  // Left untested by the first pass at this fix: reverting the key to the raw
  // read kept the whole 11k-test suite green.
  describe('applySecurityGroupRuleDiff via EC2Provider.update', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockSend.mockReset();
      mockSend.mockResolvedValue({});
    });

    const sgCalls = () =>
      mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) =>
            c instanceof RevokeSecurityGroupIngressCommand ||
            c instanceof AuthorizeSecurityGroupIngressCommand
        );

    it('issues NO revoke/authorize when the only difference is the protocol SPELLING', async () => {
      const provider = new EC2Provider();
      await provider.update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: [{ IpProtocol: '6', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/24' }],
      }, {
        // What the AWS readback reports for that same rule.
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/24' },
        ],
      });

      expect(sgCalls()).toEqual([]);
    });

    it('still revokes + authorizes when the protocol GENUINELY changes', async () => {
      const provider = new EC2Provider();
      await provider.update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: [
          { IpProtocol: '17', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/24' },
        ],
      }, {
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/24' },
        ],
      });

      const calls = sgCalls();
      expect(calls.some((c) => c instanceof RevokeSecurityGroupIngressCommand)).toBe(true);
      expect(calls.some((c) => c instanceof AuthorizeSecurityGroupIngressCommand)).toBe(true);
    });
  });
});
