import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * AWS::Lambda::EventInvokeConfig is keyed by (FunctionName, Qualifier), both
 * CREATE-ONLY in CloudFormation. A change to either must DELETE the old config
 * and CREATE a new one (it targets a different function/alias) rather than an
 * in-place Put that would orphan the old function's config. The three
 * remaining properties are updated in place via PutFunctionEventInvokeConfig.
 */
const EIC = 'AWS::Lambda::EventInvokeConfig';

describe('ReplacementRulesRegistry — Lambda EventInvokeConfig', () => {
  const registry = new ReplacementRulesRegistry();

  it.each(['FunctionName', 'Qualifier'])(
    'requires replacement when create-only %s changes',
    (prop) => {
      expect(registry.requiresReplacement(EIC, prop, 'old', 'new')).toBe(true);
    }
  );

  it.each(['MaximumEventAgeInSeconds', 'MaximumRetryAttempts'])(
    'does NOT require replacement for in-place-mutable %s',
    (prop) => {
      expect(registry.requiresReplacement(EIC, prop, 1, 2)).toBe(false);
    }
  );

  it('does NOT require replacement for an in-place DestinationConfig change', () => {
    expect(
      registry.requiresReplacement(
        EIC,
        'DestinationConfig',
        { OnFailure: { Destination: 'arn:aws:sqs:us-east-1:111:a' } },
        { OnFailure: { Destination: 'arn:aws:sqs:us-east-1:111:b' } }
      )
    ).toBe(false);
  });
});
