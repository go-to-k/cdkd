/**
 * `Fn::Select` RESOLVES its index, then requires a non-negative integer
 * (issue [#3574](https://github.com/go-to-k/cdkd/issues/3574)).
 *
 * The index used to be the raw template operand, used as a property key:
 *
 *  - an intrinsic index (`Ref` to a parameter, `Fn::FindInMap`, both of which
 *    CloudFormation accepts) read the key `"[object Object]"` and yielded
 *    `undefined`, with no warning;
 *  - a string coercing to `NaN` passed both bounds checks, so `"constructor"`
 *    read the `Array` function off the prototype chain.
 *
 * Every refusal case names what the pre-fix resolver returned, so a revert
 * turns it red; every accepting case has a sibling selecting a DIFFERENT
 * element, so a resolver that ignored the index cannot pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  IntrinsicResolutionRefusalError,
  SelectOutOfBoundsRefusalError,
} from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const logs = vi.hoisted(() => ({ debug: [] as string[], warn: [] as string[] }));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: (m: unknown): void => void logs.debug.push(String(m)),
    info: vi.fn(),
    warn: (m: unknown): void => void logs.warn.push(String(m)),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// `AWS::StackId` names the account; STS answers a fixed one.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

const LIST = ['a', 'b', 'c'];

function context(): ResolverContext {
  return {
    template: {
      Resources: {},
      Parameters: {
        NumIdx: { Type: 'Number' },
        StrIdx: { Type: 'String' },
        BadIdx: { Type: 'String' },
      },
      Mappings: { Idx: { Env: { Prod: 2, Dev: '0', Bad: 'constructor' } } },
    } as unknown as CloudFormationTemplate,
    resources: {},
    // `NumIdx` as `resolveParameters` coerces a `Number` parameter;
    // `StrIdx` as a `String` one arrives.
    parameters: { NumIdx: 1, StrIdx: '1', BadIdx: 'constructor' },
  } as ResolverContext;
}

function select(index: unknown, list: unknown = LIST): Promise<unknown> {
  return new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false }).resolve(
    { 'Fn::Select': [index, list] },
    context()
  );
}

async function refusal(index: unknown): Promise<Error> {
  let caught: unknown;
  let value: unknown;
  try {
    value = await select(index);
  } catch (e) {
    caught = e;
  }
  expect(caught, `no refusal; resolved to ${String(value)}`).toBeInstanceOf(
    IntrinsicResolutionRefusalError
  );
  expect(isMarkedNonRetryable(caught)).toBe(true);
  expect((caught as Error).message).toMatch(
    /^Fn::Select: the index .*must resolve to a non-negative integer/
  );
  return caught as Error;
}

beforeEach(() => {
  logs.debug.length = 0;
  logs.warn.length = 0;
});

describe('an index that names an element selects it (#3574)', () => {
  it('a literal number', async () => {
    expect(await select(1)).toBe('b');
    expect(await select(0)).toBe('a');
  });

  it('a numeric string, which CloudFormation accepts', async () => {
    expect(await select('1')).toBe('b');
    expect(await select('2')).toBe('c');
    // The debug line renders the PARSED position.
    expect(logs.debug).toContain('Resolved Fn::Select: index 2 resolved to "c"');
  });

  it('a Ref to a Number parameter, coerced to a number (pre-fix: undefined)', async () => {
    expect(await select({ Ref: 'NumIdx' })).toBe('b');
  });

  it('a Ref to a parameter holding a numeric string (pre-fix: undefined)', async () => {
    expect(await select({ Ref: 'StrIdx' })).toBe('b');
  });

  it('an Fn::FindInMap, number or numeric string (pre-fix: undefined)', async () => {
    expect(await select({ 'Fn::FindInMap': ['Idx', 'Env', 'Prod'] })).toBe('c');
    expect(await select({ 'Fn::FindInMap': ['Idx', 'Env', 'Dev'] })).toBe('a');
  });
});

describe('an integer past the end is REFUSED, as CloudFormation refuses it (#6181)', () => {
  it('a literal and a resolved index both refuse, naming the index and the length, and warn nothing', async () => {
    const literal = (await select(3).then(
      () => undefined,
      (e: unknown) => e
    )) as Error;
    expect(literal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(isMarkedNonRetryable(literal)).toBe(true);
    expect(literal.message).toBe(
      'Fn::Select: the index 3 is out of bounds (array length: 3). CloudFormation refuses this ' +
        'template too ("Fn::Select cannot select nonexistent value"); select an index inside the list.'
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const pending = resolver.resolve(
      { 'Fn::Select': [{ 'Fn::FindInMap': ['Idx', 'Env', 'Prod'] }, ['only']] },
      context()
    );
    await expect(pending).rejects.toThrow('the index 2 is out of bounds (array length: 1)');
    await pending.catch((e: unknown) => {
      expect(e).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(isMarkedNonRetryable(e)).toBe(true);
    });
    expect(logs.warn).toEqual([]);
  });
});

describe('an index that names no element is REFUSED (#3574)', () => {
  it.each<[string, string, unknown]>([
    // [index as written, what the pre-fix resolver answered, index]
    ['"constructor"', 'the Array constructor', 'constructor'],
    ['"__proto__"', 'Array.prototype', '__proto__'],
    ['"length"', 'the list length, 3', 'length'],
    ['-1', 'the OutOfBounds placeholder', -1],
    ['"-1"', 'the OutOfBounds placeholder', '-1'],
    ['1.5', 'undefined', 1.5],
    ['"1.5"', 'undefined', '1.5'],
    ['""', 'undefined', ''],
    ['" 1"', 'undefined', ' 1'],
    ['"01"', 'undefined', '01'],
    ['NaN', 'undefined', Number.NaN],
    ['Infinity', 'the OutOfBounds placeholder', Number.POSITIVE_INFINITY],
    ['true', 'undefined', true],
    ['null', 'undefined', null],
    ['[1]', '"b", the array coercing to the key "1"', [1]],
  ])('index %s (pre-fix: %s)', async (_written, _prefix, index) => {
    await refusal(index);
  });

  it('names the resolved value and the intrinsic it came from', async () => {
    const error = await refusal({ Ref: 'BadIdx' });
    expect(error.message).toContain('(from Ref BadIdx)');
    expect(error.message).toContain('got string "constructor"');

    const fromMap = await refusal({ 'Fn::FindInMap': ['Idx', 'Env', 'Bad'] });
    expect(fromMap.message).toContain('(from Fn::FindInMap)');

    // A literal names no source.
    const literal = await refusal(-1);
    expect(literal.message).toContain('the index must resolve');
    expect(literal.message).toContain('got number -1');
  });
});

describe('a malformed Fn::Select operand is refused, not destructured', () => {
  it.each<[string, unknown]>([
    ['a string, whose first two characters used to be read', 'ab'],
    ['an object, which used to throw a bare TypeError', { index: 0 }],
    ['three elements, whose third used to be ignored', [0, ['a'], 'extra']],
    ['one element', [0]],
  ])('%s', async (_what, operand) => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const pending = resolver.resolve({ 'Fn::Select': operand }, context());
    await expect(pending).rejects.toThrow(/^Fn::Select takes a two-element list \[index, list\]/);
    await pending.catch((e: unknown) => {
      expect(e).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(isMarkedNonRetryable(e)).toBe(true);
    });
  });
});

describe('an index resolved from a SECRET never reaches a log line or a refusal raw', () => {
  // A nested-stack child holds its parent's resolved secret only in
  // `inheritedSecrets`; the `Ref` line masks it, and so must every later
  // render of the index it becomes.
  function secretContext(plaintext: string): ResolverContext {
    return {
      ...context(),
      parameters: { SecretIdx: plaintext },
      inheritedSecrets: new Map([[plaintext, '{{resolve:secretsmanager:idx-secret}}']]),
    } as ResolverContext;
  }

  function selectSecret(plaintext: string, list: unknown[]): Promise<unknown> {
    return new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false }).resolve(
      { 'Fn::Select': [{ Ref: 'SecretIdx' }, list] },
      secretContext(plaintext)
    );
  }

  it.each(['987654', '42'])(
    'out of bounds (secret %s): refused with the index masked',
    async (plaintext) => {
      const pending = selectSecret(plaintext, ['a', 'b']);
      await expect(pending).rejects.toThrow(
        'Fn::Select: the index *** is out of bounds (array length: 2)'
      );
      await pending.catch((e: unknown) => {
        expect(e).toBeInstanceOf(IntrinsicResolutionRefusalError);
        expect(isMarkedNonRetryable(e)).toBe(true);
        expect(String((e as Error).message)).not.toContain(plaintext);
      });
      expect(logs.warn.join('\n')).not.toContain(plaintext);
    }
  );

  it('in bounds: selects, and the debug line masks the index', async () => {
    const list = Array.from({ length: 50 }, (_, i) => `v${i}`);
    expect(await selectSecret('42', list)).toBe('v42');
    expect(logs.debug).toContain('Resolved Fn::Select: index *** resolved to "v42"');
    expect(logs.debug.join('\n')).not.toContain('index 42');
  });

  it('CONTROL: the same index from a NON-secret parameter renders in the refusal', async () => {
    const pending = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false }).resolve(
      { 'Fn::Select': [{ Ref: 'SecretIdx' }, ['a', 'b']] },
      { ...context(), parameters: { SecretIdx: '987654' } } as ResolverContext
    );
    await expect(pending).rejects.toThrow('the index 987654 is out of bounds (array length: 2)');
  });
});

describe('the two arms #6181 settles beside the refusal', () => {
  // The CDK unique-suffix idiom: the stack id's last `/` segment, then its
  // last `-` group.
  const stackIdGroup = {
    'Fn::Select': [
      4,
      { 'Fn::Split': ['-', { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] }] },
    ],
  };

  it('a list cut from a legacy `cdkd` AWS::StackId keeps the placeholder and warns (#6170)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const value = await resolver.resolve(stackIdGroup, { ...context(), stackName: 'S' });
    expect(value).toBe('{{Fn::Select:4:OutOfBounds}}');
    expect(logs.warn.join('\n')).toContain("over this stack's AWS::StackId, which ends in `cdkd`");
  });

  it('a stack whose AWS::StackId ends in a UUID selects the group', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const value = await resolver.resolve(stackIdGroup, {
      ...context(),
      stackName: 'S',
      stackIdTail: () => '2d300264-2aa0-4589-ab27-cd6e9a259f23',
    });
    expect(value).toBe('cd6e9a259f23');
  });

  it('a list that does not read AWS::StackId still refuses on a legacy stack', async () => {
    const pending = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false }).resolve(
      { 'Fn::Select': [4, { 'Fn::Split': ['-', { Ref: 'AWS::StackName' }] }] },
      { ...context(), stackName: 'S' }
    );
    await expect(pending).rejects.toBeInstanceOf(SelectOutOfBoundsRefusalError);
  });

  it('a condition selecting out of bounds fails the evaluation instead of assuming false', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const base = context();
    const pending = resolver.evaluateConditions({
      ...base,
      template: {
        ...base.template,
        Conditions: {
          HasSecond: {
            'Fn::Not': [{ 'Fn::Equals': [{ 'Fn::Select': [1, { 'Fn::Split': [',', 'only'] }] }, ''] }],
          },
          Plain: { 'Fn::Equals': ['a', 'a'] },
        },
      } as unknown as CloudFormationTemplate,
    });
    await expect(pending).rejects.toBeInstanceOf(SelectOutOfBoundsRefusalError);
    expect(logs.warn.join('\n')).not.toContain('assuming false');
  });
});
