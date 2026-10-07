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

  it('leaves an element of an ordinary (not NoEcho) parent value alone', async () => {
    const inherited: RecordedSecretValues = new Map([
      [`${ELEMENT_A},${ELEMENT_B}`, '{{resolve:ssm:/x}}'],
    ]);
    const recorded: RecordedSecretValues = new Map();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve({ Ref: 'ListIn' }, childContext(recorded, inherited));
    expect(recorded.get(ELEMENT_A)).toBeUndefined();
  });
});
