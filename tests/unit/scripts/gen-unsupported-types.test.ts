import { describe, it, expect } from 'vite-plus/test';
import {
  REGISTRY_ROUTED_EXCLUSIONS,
  computeNonProvisionableTypes,
} from '../../../scripts/gen-unsupported-types.js';
import { NON_PROVISIONABLE_TYPES } from '../../../src/provisioning/unsupported-types.generated.js';

describe('REGISTRY_ROUTED_EXCLUSIONS', () => {
  it('excludes AWS::CloudFormation::CustomResource (routed by isCustomResource, issue #1046)', () => {
    // ProviderRegistry routes Custom::* AND AWS::CloudFormation::CustomResource
    // to CustomResourceProvider before the NON_PROVISIONABLE set is consulted
    // (src/provisioning/provider-registry.ts isCustomResource()), so a tier-3
    // entry for it would be dead and misleading.
    expect(REGISTRY_ROUTED_EXCLUSIONS.has('AWS::CloudFormation::CustomResource')).toBe(true);
  });
});

describe('computeNonProvisionableTypes', () => {
  it('drops registry-routed special cases from the raw tier-3 list', () => {
    const result = computeNonProvisionableTypes([
      'AWS::CloudFormation::CustomResource',
      'AWS::Foo::Bar',
    ]);
    expect(result).toEqual(['AWS::Foo::Bar']);
  });

  it('dedupes and sorts the remaining entries', () => {
    const result = computeNonProvisionableTypes([
      'AWS::Zeta::Type',
      'AWS::Alpha::Type',
      'AWS::Zeta::Type',
    ]);
    expect(result).toEqual(['AWS::Alpha::Type', 'AWS::Zeta::Type']);
  });

  it('keeps genuinely unsupported CloudFormation types', () => {
    const result = computeNonProvisionableTypes([
      'AWS::CloudFormation::Macro',
      'AWS::CloudFormation::WaitCondition',
      'AWS::CloudFormation::CustomResource',
    ]);
    expect(result).toEqual(['AWS::CloudFormation::Macro', 'AWS::CloudFormation::WaitCondition']);
  });
});

describe('generated NON_PROVISIONABLE_TYPES module', () => {
  it('does not contain any registry-routed exclusion (pins the regeneration)', () => {
    for (const excluded of REGISTRY_ROUTED_EXCLUSIONS) {
      expect(NON_PROVISIONABLE_TYPES.has(excluded)).toBe(false);
    }
  });

  it('does not contain exact-registered special cases like WaitConditionHandle', () => {
    // AWS::CloudFormation::WaitConditionHandle has an exact registry.register()
    // entry (no-op SDK provider), so the upstream tier classification already
    // excludes it — no REGISTRY_ROUTED_EXCLUSIONS entry needed.
    expect(NON_PROVISIONABLE_TYPES.has('AWS::CloudFormation::WaitConditionHandle')).toBe(false);
  });

  it('still contains genuinely unsupported types', () => {
    expect(NON_PROVISIONABLE_TYPES.has('AWS::CloudFormation::Macro')).toBe(true);
    expect(NON_PROVISIONABLE_TYPES.has('AWS::CloudFormation::WaitCondition')).toBe(true);
  });
});
