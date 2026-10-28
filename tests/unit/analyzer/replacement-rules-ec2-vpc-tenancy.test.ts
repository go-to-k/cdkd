import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * `AWS::EC2::VPC.InstanceTenancy` (go-to-k/cdkd#5449). Measured against
 * CloudFormation on a throwaway stack (us-east-1): `default` -> `dedicated`
 * created a new VPC; `dedicated` -> `default` and a removal from `dedicated`
 * kept the VPC id and changed the tenancy in place.
 */
describe('ReplacementRulesRegistry — AWS::EC2::VPC InstanceTenancy', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::EC2::VPC';
  const replaces = (oldValue: unknown, newValue: unknown): boolean =>
    registry.requiresReplacement(TYPE, 'InstanceTenancy', oldValue, newValue);

  it('replaces the VPC on a change to dedicated, from default or from absent', () => {
    expect(replaces('default', 'dedicated')).toBe(true);
    expect(replaces(undefined, 'dedicated')).toBe(true);
  });

  it('updates in place on a change to default, and on a removal', () => {
    expect(replaces('dedicated', 'default')).toBe(false);
    expect(replaces('dedicated', undefined)).toBe(false);
    expect(replaces('default', undefined)).toBe(false);
    expect(replaces(undefined, 'default')).toBe(false);
  });

  it('is no change between equal values', () => {
    expect(replaces('dedicated', 'dedicated')).toBe(false);
  });

  it('reads null as default, as the provider does', () => {
    expect(replaces(null, 'dedicated')).toBe(true);
    expect(replaces(null, 'default')).toBe(false);
    expect(replaces('dedicated', null)).toBe(false);
  });

  it('is classified, and names the schema createOnly list so a DescribeType failure still replaces', () => {
    expect(registry.isClassified(TYPE, 'InstanceTenancy')).toBe(true);
    for (const prop of ['CidrBlock', 'Ipv4IpamPoolId', 'Ipv4NetmaskLength', 'VpcEncryptionControl']) {
      expect(registry.isClassified(TYPE, prop)).toBe(true);
      expect(registry.requiresReplacement(TYPE, prop, 'a', 'b')).toBe(true);
    }
    expect(registry.requiresReplacement(TYPE, 'CidrBlock', '10.0.0.0/16', '10.1.0.0/16')).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'EnableDnsHostnames', false, true)).toBe(false);
  });
});
