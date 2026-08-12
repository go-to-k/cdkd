import { describe, expect, it } from 'vite-plus/test';
import { reconcileSgRules } from '../../../src/provisioning/providers/ec2-provider.js';

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
});
