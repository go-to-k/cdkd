import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * Regression coverage for the LayerVersion-content-change bug: a Lambda
 * LayerVersion is fully immutable on AWS (no UpdateLayerVersion API), so in
 * CloudFormation EVERY property is "Update requires: Replacement" and a
 * `cdk deploy` after editing layer content transparently publishes a new
 * version. Without a replacement rule cdkd misclassified the change as an
 * in-place update and the provider's update() hard-failed — leaving a layer
 * content change undeployable (the suggested `--replace` flag does not even
 * exist). The fix marks every LayerVersion property (and every CREATE-ONLY
 * Version property — Version's lone in-place-mutable `FunctionScalingConfig`
 * is intentionally excluded) as replacement-triggering, so the diff drives a
 * DELETE + CREATE and promoteReplacementDependents re-points the consuming
 * function.
 */
const LAYER = 'AWS::Lambda::LayerVersion';
const VERSION = 'AWS::Lambda::Version';

describe('ReplacementRulesRegistry — Lambda LayerVersion / Version immutability', () => {
  const registry = new ReplacementRulesRegistry();

  it('requires replacement when LayerVersion Content changes', () => {
    expect(
      registry.requiresReplacement(
        LAYER,
        'Content',
        { S3Key: 'old.zip' },
        { S3Key: 'new.zip' }
      )
    ).toBe(true);
  });

  it.each(['LayerName', 'Description', 'CompatibleRuntimes', 'CompatibleArchitectures', 'LicenseInfo'])(
    'requires replacement when LayerVersion %s changes',
    (prop) => {
      expect(registry.requiresReplacement(LAYER, prop, 'old', 'new')).toBe(true);
    }
  );

  it.each(['CodeSha256', 'Description', 'FunctionName', 'RuntimePolicy'])(
    'requires replacement when Version %s changes',
    (prop) => {
      expect(registry.requiresReplacement(VERSION, prop, 'old', 'new')).toBe(true);
    }
  );

  it('requires replacement when Version ProvisionedConcurrencyConfig changes', () => {
    expect(
      registry.requiresReplacement(
        VERSION,
        'ProvisionedConcurrencyConfig',
        { ProvisionedConcurrentExecutions: 1 },
        { ProvisionedConcurrentExecutions: 2 }
      )
    ).toBe(true);
  });

  it('does NOT require replacement for the in-place-mutable Version FunctionScalingConfig', () => {
    expect(
      registry.requiresReplacement(
        VERSION,
        'FunctionScalingConfig',
        { TrustedAIToolsActions: 'Disabled' },
        { TrustedAIToolsActions: 'Enabled' }
      )
    ).toBe(false);
  });
});
