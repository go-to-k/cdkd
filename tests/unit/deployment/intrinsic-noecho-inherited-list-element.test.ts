import { describe, it, expect } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  SECRET_MASK,
  recordNoEchoParameterFreshValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#4043: a CDK nested child's `CommaDelimitedList` parameter fed a
 * parent's `NoEcho` PARAMETER value arrives split; each element that is a
 * piece of that value persists as `***` in the child resource's record.
 */
const ELEMENT_A = 'alpha-element-secret-1';
const ELEMENT_B = 'bravo-element-secret-2';

function childContext(recorded: RecordedSecretValues, inherited: RecordedSecretValues) {
  return {
    template: { Parameters: { ListIn: { Type: 'CommaDelimitedList' } }, Resources: {} },
    resources: {},
    parameters: { ListIn: [ELEMENT_A, ELEMENT_B] },
    recordedSecretValues: recorded,
    inheritedSecrets: inherited,
  } as unknown as ResolverContext;
}

describe('a child list element of a parent NoEcho parameter value', () => {
  it('is persisted as the mask in the child record', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(`${ELEMENT_A},${ELEMENT_B}`, inherited);
    const recorded: RecordedSecretValues = new Map();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const element = await resolver.resolve(
      { 'Fn::Select': [0, { Ref: 'ListIn' }] },
      childContext(recorded, inherited)
    );
    expect(element).toBe(ELEMENT_A);
    expect(redactSecretsForState({ Value: element }, recorded)).toEqual({ Value: SECRET_MASK });
  });

  it('honours the needle floor: a 3-character element is not recorded, a 4-character one is', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue('abc,abcd', inherited);
    const recorded: RecordedSecretValues = new Map();
    const context = {
      ...childContext(recorded, inherited),
      parameters: { ListIn: ['abc', 'abcd'] },
    } as unknown as ResolverContext;
    await new IntrinsicFunctionResolver('us-east-1').resolve({ Ref: 'ListIn' }, context);
    expect(recorded.get('abc')).toBeUndefined();
    expect(recorded.get('abcd')).toBe(SECRET_MASK);
  });

  it('records nothing for a PUBLIC list whose element merely occurs inside a parent NoEcho value', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue('myprod2024-password', inherited);
    const recorded: RecordedSecretValues = new Map();
    const context = {
      ...childContext(recorded, inherited),
      parameters: { ListIn: ['prod', 'staging'] },
    } as unknown as ResolverContext;
    await new IntrinsicFunctionResolver('us-east-1').resolve({ Ref: 'ListIn' }, context);
    expect(recorded.get('prod')).toBeUndefined();
  });

  it('matches a parent value spelled with spaces after its commas, as the coercion trims them', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(`${ELEMENT_A}, ${ELEMENT_B}`, inherited);
    const recorded: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      { Ref: 'ListIn' },
      childContext(recorded, inherited)
    );
    expect(recorded.get(ELEMENT_A)).toBe(SECRET_MASK);
    expect(recorded.get(ELEMENT_B)).toBe(SECRET_MASK);
  });

  it('records nothing when nothing is inherited', async () => {
    const recorded: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver('us-east-1').resolve(
      { Ref: 'ListIn' },
      childContext(recorded, new Map())
    );
    expect(recorded.size).toBe(0);
  });

  it('leaves an element of a parent dynamic-reference secret (not a NoEcho parameter) to the expression arms', async () => {
    const inherited: RecordedSecretValues = new Map([
      [`${ELEMENT_A},${ELEMENT_B}`, '{{resolve:ssm:/x}}'],
    ]);
    const recorded: RecordedSecretValues = new Map();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve({ Ref: 'ListIn' }, childContext(recorded, inherited));
    expect(recorded.get(ELEMENT_A)).toBeUndefined();
  });
});
