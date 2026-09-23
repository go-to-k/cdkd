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
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
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
    expect(logs.debug).toContain('Resolved Fn::Select: index 2 -> "c"');
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

describe('an integer past the end keeps the OutOfBounds placeholder', () => {
  it('a literal and a resolved index both answer the placeholder and warn', async () => {
    expect(await select(3)).toBe('{{Fn::Select:3:OutOfBounds}}');
    expect(await select({ 'Fn::FindInMap': ['Idx', 'Env', 'Prod'] }, ['only'])).toBe(
      '{{Fn::Select:2:OutOfBounds}}'
    );
    expect(logs.warn).toEqual([
      'Fn::Select: index 3 out of bounds (array length: 3)',
      'Fn::Select: index 2 out of bounds (array length: 1)',
    ]);
  });
});

describe('an index that names no element is REFUSED (#3574)', () => {
  it.each<[string, unknown]>([
    // [what the pre-fix resolver answered, index]
    ['the Array constructor', 'constructor'],
    ['Array.prototype', '__proto__'],
    ['the list length, 3', 'length'],
    ['the OutOfBounds placeholder', -1],
    ['the OutOfBounds placeholder', '-1'],
    ['undefined', 1.5],
    ['undefined', '1.5'],
    ['undefined', ''],
    ['undefined', ' 1'],
    ['undefined', Number.NaN],
    ['the OutOfBounds placeholder', Number.POSITIVE_INFINITY],
    ['undefined', true],
    ['undefined', null],
    ['undefined', [1]],
  ])('pre-fix %s: index %j', async (_prefix, index) => {
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
    await pending.catch((e: unknown) => expect(isMarkedNonRetryable(e)).toBe(true));
  });
});
