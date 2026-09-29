/**
 * `refuseNoValueOutputs` (issue [#4077](https://github.com/go-to-k/cdkd/issues/4077)):
 * CloudFormation rejects a template whose Output Value evaluates to
 * `AWS::NoValue` ("The Value field of every Outputs member must evaluate to a
 * String"), so cdkd refuses it before provisioning — but only where the
 * evaluated conditions make the answer certain.
 */
import { describe, it, expect } from 'vite-plus/test';

import { refuseNoValueOutputs } from '../../../src/deployment/output-value-preflight.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { TemplateOutput } from '../../../src/types/resource.js';

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
});
