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
    'requires replacement when create-only %s changes to a different value',
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

  describe('FunctionName re-spelled as the same function (issue #4118)', () => {
    const arn = 'arn:aws:lambda:us-east-1:123456789012:function:fn';
    it.each([
      ['name -> full ARN', 'fn', arn],
      ['full ARN -> name', arn, 'fn'],
      ['name -> partial ARN', 'fn', '123456789012:function:fn'],
      ['partial -> full ARN', '123456789012:function:fn', arn],
      ['aws-cn partition', 'fn', 'arn:aws-cn:lambda:cn-north-1:123456789012:function:fn'],
    ])('is an in-place update: %s', (_label, oldValue, newValue) => {
      expect(registry.requiresReplacement(EIC, 'FunctionName', oldValue, newValue)).toBe(false);
    });

    it.each([
      ['a different name', 'fn', 'other'],
      ['an ARN of a different name', 'fn', 'arn:aws:lambda:us-east-1:123456789012:function:other'],
      ['a qualified ARN', 'fn', `${arn}:live`],
      ['an unresolved intrinsic', 'fn', { 'Fn::GetAtt': ['Fn', 'Arn'] }],
    ])('still replaces on %s', (_label, oldValue, newValue) => {
      expect(registry.requiresReplacement(EIC, 'FunctionName', oldValue, newValue)).toBe(true);
    });

    it('does not replace on two equal intrinsics', () => {
      const ref = { Ref: 'Fn' };
      expect(registry.requiresReplacement(EIC, 'FunctionName', ref, { Ref: 'Fn' })).toBe(false);
    });
  });
});
