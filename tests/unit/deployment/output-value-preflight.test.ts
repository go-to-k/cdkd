/**
 * `refuseNoValueOutputs` (issue [#4077](https://github.com/go-to-k/cdkd/issues/4077)):
 * CloudFormation rejects a template whose Output Value evaluates to
 * `AWS::NoValue` ("The Value field of every Outputs member must evaluate to a
 * String"), so cdkd refuses it before provisioning — but only where the
 * evaluated conditions make the answer certain.
 */
import { describe, it, expect } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { refuseNoValueOutputs } from '../../../src/deployment/output-value-preflight.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';

const NO_VALUE = { Ref: 'AWS::NoValue' };
const ifOn = (cond: string, whenTrue: unknown, whenFalse: unknown): unknown => ({
  'Fn::If': [cond, whenTrue, whenFalse],
});

function refusal(outputs: Record<string, TemplateOutput>, conditions: Record<string, boolean>) {
  try {
    refuseNoValueOutputs(outputs, conditions);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('refuseNoValueOutputs (issue #4077)', () => {
  it.each([
    ['a bare Ref', NO_VALUE, {}],
    ['the false branch of an Fn::If', ifOn('On', 'v', NO_VALUE), { On: false }],
    ['the true branch of an Fn::If', ifOn('On', NO_VALUE, 'v'), { On: true }],
    [
      'a nested Fn::If chain',
      ifOn('A', 'v', ifOn('B', NO_VALUE, 'w')),
      { A: false, B: true },
    ],
  ])('refuses %s selecting AWS::NoValue, non-retryably', (_shape, value, conditions) => {
    const error = refusal({ Out: { Value: value } }, conditions);
    expect((error as Error).message).toMatch(
      /^Output Out evaluates to AWS::NoValue, and CloudFormation rejects the template/
    );
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it.each([
    ['the branch not taken', ifOn('On', 'v', NO_VALUE), { On: true }],
    ['a condition cdkd could not evaluate', ifOn('Unknown', 'v', NO_VALUE), {}],
    ['a value that is not NoValue', { Ref: 'AWS::Region' }, {}],
    ['a malformed Fn::If', { 'Fn::If': ['On', NO_VALUE] }, { On: false }],
  ])('leaves %s alone', (_shape, value, conditions) => {
    expect(refusal({ Out: { Value: value } }, conditions)).toBeUndefined();
  });

  it('leaves an Output its own Condition suppresses alone (CloudFormation does not create it)', () => {
    expect(
      refusal({ Out: { Value: ifOn('On', 'v', NO_VALUE), Condition: 'On' } }, { On: false })
    ).toBeUndefined();
  });

  it('names every offending Output in one refusal', () => {
    const error = refusal(
      { First: { Value: NO_VALUE }, Fine: { Value: 'x' }, Second: { Value: NO_VALUE } },
      {}
    );
    expect((error as Error).message).toMatch(/^Output First, Second evaluates to AWS::NoValue/);
  });

  // The conditions come from the REAL `evaluateConditions`, which stores
  // `false` for a condition it could not evaluate: a guess the preflight must
  // not refuse on (review of #4077).
  describe('against the real evaluateConditions', () => {
    const THROWS = { 'Fn::Equals': [{ 'Fn::FindInMap': ['NoSuchMap', 'a', 'b'] }, 'x'] };
    async function evaluated(conditions: Record<string, unknown>): Promise<Record<string, boolean>> {
      const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
      return resolver.evaluateConditions({
        template: { Resources: {}, Conditions: conditions } as unknown as CloudFormationTemplate,
        resources: {},
      } as ResolverContext);
    }

    it('CONTROL: refuses on a condition that evaluated false', async () => {
      const conditions = await evaluated({ Off: { 'Fn::Equals': ['a', 'b'] } });
      expect(refusal({ Out: { Value: ifOn('Off', 'v', NO_VALUE) } }, conditions)).toBeDefined();
    });

    it.each([
      ['whose evaluation threw', { Broken: THROWS }, 'Broken'],
      // Both declaration orders: Broken first taints Composite on a memo hit,
      // Composite first on Broken's throw reaching Composite's own catch.
      [
        'that depends on one whose evaluation threw (declared after it)',
        { Broken: THROWS, Composite: { 'Fn::Not': [{ Condition: 'Broken' }] } },
        'Composite',
      ],
      [
        'that depends on one whose evaluation threw (declared before it)',
        { Composite: { 'Fn::Not': [{ Condition: 'Broken' }] }, Broken: THROWS },
        'Composite',
      ],
      [
        'that references an undeclared condition',
        { Composite: { 'Fn::Not': [{ Condition: 'Undeclared' }] } },
        'Composite',
      ],
    ])('leaves an Fn::If on a condition %s alone', async (_shape, declared, name) => {
      const conditions = await evaluated(declared);
      // PREMISE: the bag holds a boolean for it, so only the assumed-set skips it.
      expect(Object.hasOwn(conditions, name)).toBe(true);
      const value = conditions[name] ? ifOn(name, NO_VALUE, 'v') : ifOn(name, 'v', NO_VALUE);
      expect(refusal({ Out: { Value: value } }, conditions)).toBeUndefined();
    });
  });

  it('skips a malformed (null) Output entry instead of throwing a TypeError', () => {
    expect(
      refusal({ Bad: null as unknown as TemplateOutput, Out: { Value: 'x' } }, {})
    ).toBeUndefined();
  });
});
