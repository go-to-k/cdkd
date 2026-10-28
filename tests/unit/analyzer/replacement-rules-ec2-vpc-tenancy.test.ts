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

  it('is classified, and leaves the other VPC properties to the createOnly fallback', () => {
    expect(registry.isClassified(TYPE, 'InstanceTenancy')).toBe(true);
    expect(registry.isClassified(TYPE, 'CidrBlock')).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'EnableDnsHostnames', false, true)).toBe(false);
  });
});
