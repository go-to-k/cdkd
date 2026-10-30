import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  natZoneAddressesAddedToAutomaticGateway,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * `AWS::EC2::NatGateway.AvailabilityZoneAddresses` (go-to-k/cdkd#2762). A real
 * CloudFormation A/B (posted on #2762) measured three answers: on a gateway
 * created WITH zone addresses a change updates in place and removing the
 * property fails, while ADDING it to a regional gateway created without it
 * (automatic zone expansion) creates a new gateway.
 */
describe('ReplacementRulesRegistry — AWS::EC2::NatGateway', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::EC2::NatGateway';
  const ZONE_1A = [{ AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-1'] }];
  const ZONES = [...ZONE_1A, { AvailabilityZone: 'us-east-1b', AllocationIds: ['eipalloc-2'] }];

  it('replaces an automatic-mode gateway that gains AvailabilityZoneAddresses', () => {
    expect(registry.requiresReplacement(TYPE, 'AvailabilityZoneAddresses', undefined, ZONE_1A)).toBe(
      true
    );
  });

  it('updates a manual-mode gateway in place, a removal included (the provider refuses that)', () => {
    expect(registry.requiresReplacement(TYPE, 'AvailabilityZoneAddresses', ZONE_1A, ZONES)).toBe(
      false
    );
    expect(registry.requiresReplacement(TYPE, 'AvailabilityZoneAddresses', ZONES, undefined)).toBe(
      false
    );
  });

  it('is classified, so the createOnly fallback never overrides it', () => {
    expect(registry.isClassified(TYPE, 'AvailabilityZoneAddresses')).toBe(true);
  });

  it('reads presence with == null on both sides', () => {
    expect(natZoneAddressesAddedToAutomaticGateway(null, ZONE_1A)).toBe(true);
    expect(natZoneAddressesAddedToAutomaticGateway(undefined, undefined)).toBe(false);
    expect(natZoneAddressesAddedToAutomaticGateway(ZONE_1A, null)).toBe(false);
  });

  it('leaves the create-only properties to the registry schema fallback', () => {
    for (const key of ['SubnetId', 'VpcId', 'AvailabilityMode', 'Tags']) {
      expect(registry.isClassified(TYPE, key)).toBe(false);
    }
  });
});
