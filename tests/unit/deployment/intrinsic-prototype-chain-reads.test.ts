/**
 * Issue [#2767](https://github.com/go-to-k/cdkd/issues/2767): the
 * prototype-chain reads left behind by issue
 * [#2739](https://github.com/go-to-k/cdkd/issues/2739)'s `Object.create(null)`
 * fix to `resolveSub`'s variable map.
 *
 * All four sites share one shape — a bag keyed by a TEMPLATE-controlled name,
 * read (or `in`-tested) on a plain object, so an `Object.prototype` member name
 * answers where no entry exists. They are swept together because a template
 * reaches all of them by the same name: `${constructor}` misses the resource
 * bag and lands on the parameter arm one line down, and `Fn::GetAtt` takes the
 * third; fixing one alone moves the wrong answer rather than removing it.
 *
 * Two of the four produce a WRONG RESULT rather than a refusal, which is why
 * each is pinned by the rendered string / thrown message and not merely by
 * "does not contain a function":
 *
 * - `resolveValue`'s object walk built its output with `{}`, so a `__proto__`
 *   property — an OWN key after `JSON.parse` — routed through the inherited
 *   setter and was silently ABSENT from the object deploy hands the provider.
 *   Measured as the deploy-visible loss it is: the resolved properties bag.
 * - `resolveRef`'s resource read took the `Object` function as a resource, so
 *   `cfnRefValueFromPhysicalId` fell through every guard and returned
 *   `undefined`, which `resolveSub` `String()`s into the literal text
 *   `undefined`. The pin is the RENDERED string, since the old behaviour also
 *   satisfies any "no function source" negative.
 *
 * The `Fn::Sub` arms below are the two-argument and plain-string forms both, on
 * purpose: #2739 made the writer's own variable map own-keys, so from #2739
 * onward these placeholders reach `resolveRef` on EITHER form, and this file is
 * what states what they find there.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * An EMPTY bag on every axis. That is the point: every assertion below is about
 * a name the template never declared, so anything but a miss is the prototype
 * chain answering.
 */
const emptyContext = (): ResolverContext => ({
  template: { Resources: {} } as unknown as CloudFormationTemplate,
  resources: {},
});

const resolveError = async (
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<Error> => {
  try {
    await resolver.resolve(value, context);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to throw`);
};

describe('template-controlled bag reads do not walk the prototype chain (#2767)', () => {
  describe('resolveValue object walk', () => {
    it('keeps a __proto__ property in the resolved bag handed to the provider', async () => {
      const resolver = new IntrinsicFunctionResolver();
      // `JSON.parse` is how a template actually reaches this walk, and it is
      // what makes `__proto__` an OWN key rather than a prototype write. Built
      // that way here so the case cannot pass by construction: an object
      // literal `{ __proto__: 'x' }` would set the prototype instead, and
      // `Object.entries` would yield nothing at all.
      const properties = JSON.parse('{"__proto__": "kept", "Ordinary": "also-kept"}') as Record<
        string,
        unknown
      >;

      const resolved = (await resolver.resolve(properties, emptyContext())) as Record<
        string,
        unknown
      >;

      // The regression is a SILENT omission, so assert the key's presence and
      // its value, and the key list, rather than only reading the value back —
      // `resolved['__proto__']` on a plain object answers `Object.prototype`
      // for the dropped case, which is truthy and would mask the loss.
      expect(Object.keys(resolved).sort()).toEqual(['Ordinary', '__proto__']);
      expect(Object.hasOwn(resolved, '__proto__')).toBe(true);
      expect(resolved['__proto__']).toBe('kept');
      expect(resolved.Ordinary).toBe('also-kept');
    });

    it('still resolves intrinsics inside a bag carrying a __proto__ key', async () => {
      const resolver = new IntrinsicFunctionResolver();
      // `Fn::Join` rather than a pseudo parameter: `Ref: AWS::Region` reaches
      // `getAccountInfo` and trips the suite's AWS fence, and the point here is
      // only that the VALUE is resolved rather than passed through.
      const properties = JSON.parse('{"__proto__": {"Fn::Join": ["-", ["a", "b"]]}}') as Record<
        string,
        unknown
      >;

      const resolved = (await resolver.resolve(properties, emptyContext())) as Record<
        string,
        unknown
      >;

      // The value goes through `resolveValue` like any other, so the fix must
      // not have turned the key into a verbatim pass-through.
      expect(resolved['__proto__']).toBe('a-b');
    });
  });

  describe('resolveRef', () => {
    it('refuses a Ref naming an Object.prototype member instead of rendering undefined', async () => {
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(resolver, { Ref: 'constructor' }, emptyContext());

      expect(error.message).toBe('Ref constructor not found');
      // The refusal shares the marker every other template-controlled throw in
      // this file carries — `constructor` is not a retryable substring, but the
      // name is template-controlled and the classifiers match by substring.
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('does not read an Object.prototype member as a bound parameter', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // `parameters` PRESENT and empty: the old `in` test answered true here
      // and returned the `Object` function as the parameter's value, so this is
      // the arm a resource-bag-only fix would have moved the bug to.
      const error = await resolveError(resolver, { Ref: 'constructor' }, {
        ...emptyContext(),
        parameters: {},
      } as ResolverContext);

      expect(error.message).toBe('Ref constructor not found');
    });

    it('keeps a DECLARED parameter whose value is undefined on the parameter arm', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // `docs/changelog-cdkd.md`'s issue #2285 entry records this as a
      // pre-existing behaviour deliberately left alone: the parameter arm
      // tested membership, not the VALUE, so a declared-but-unbound parameter
      // returned `undefined` instead of throwing. `Object.hasOwn` answers the
      // same for a present key holding `undefined`, and this pins that — the
      // swap must narrow the INHERITED case only.
      const result = await resolver.resolve({ 'Fn::Sub': 'x-${Stage}' }, {
        template: {
          Parameters: { Stage: { Type: 'String' } },
          Resources: {},
        } as unknown as CloudFormationTemplate,
        resources: {},
        parameters: { Stage: undefined },
      } as ResolverContext);

      expect(result).toBe('x-undefined');
    });

    it.each([
      ['two-argument form', { 'Fn::Sub': ['x-${constructor}', { Lit: 'y' }] }],
      ['plain-string form', { 'Fn::Sub': 'x-${constructor}' }],
    ])('renders no substitution for ${constructor} through Fn::Sub, %s', async (_label, value) => {
      const resolver = new IntrinsicFunctionResolver();

      const result = await resolver.resolve(value, emptyContext());

      // The POSITIVE pin, and the reason this file exists: before #2767 this
      // rendered `x-undefined` — a literal shipped into a live property. The
      // `Ref` miss is not structural (the template declares no resource or
      // parameter by that name), so `resolveSub` warns and retains the
      // placeholder, exactly as it does for any other unknown name.
      expect(result).toBe('x-${constructor}');
    });

    it('resolves a Ref to a resource genuinely named constructor', async () => {
      const resolver = new IntrinsicFunctionResolver();
      const context: ResolverContext = {
        template: {
          Resources: { constructor: { Type: 'AWS::S3::Bucket' } },
        } as unknown as CloudFormationTemplate,
        resources: {
          constructor: { physicalId: 'phys-ctor', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
      };

      // The positive twin: `Object.hasOwn` must not refuse a name that IS an
      // own key merely because it collides with a prototype member. Without
      // this, a mutant returning `undefined` unconditionally passes every case
      // above.
      expect(await resolver.resolve({ Ref: 'constructor' }, context)).toBe('phys-ctor');
      expect(await resolver.resolve({ 'Fn::Sub': 'x-${constructor}' }, context)).toBe(
        'x-phys-ctor'
      );
    });
  });

  describe('Fn::Sub first element', () => {
    it.each([
      ['an intrinsic object', { Ref: 'X' }, 'object'],
      ['null', null, 'null'],
      ['a number', 7, 'number'],
      ['an array', ['a'], 'object'],
    ])('refuses a non-string template, %s', async (_label, templateElement, described) => {
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(
        resolver,
        { 'Fn::Sub': [templateElement, { Lit: 'y' }] },
        emptyContext()
      );

      // The whole message, so the type is named and the VALUE is never echoed
      // — a malformed template can put a secret in this slot.
      expect(error.message).toBe(
        `Fn::Sub: the first element must be a template string, got ${described}`
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
      // Before this guard the failure was `template.matchAll is not a
      // function`, thrown from a line that says nothing about `Fn::Sub`'s
      // shape and carrying no marker.
      expect(error.message).not.toContain('matchAll');
    });

    it('checks the first element before the second when both are wrong', async () => {
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(resolver, { 'Fn::Sub': [7, 7] }, emptyContext());

      expect(error.message).toBe('Fn::Sub: the first element must be a template string, got number');
    });

    it('still resolves the ordinary two-argument form', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // The guard must not reject its own valid input — without this, a mutant
      // refusing unconditionally passes every case above.
      expect(
        await resolver.resolve({ 'Fn::Sub': ['x-${Lit}', { Lit: 'y' }] }, emptyContext())
      ).toBe('x-y');
    });
  });

  describe('resolveGetAtt', () => {
    it('refuses a GetAtt naming an Object.prototype member with the ordinary not-found error', async () => {
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(
        resolver,
        { 'Fn::GetAtt': ['constructor', 'Arn'] },
        emptyContext()
      );

      // Before the sweep the `Object` function passed the truthiness guard and
      // was carried into the attribute lookup, where `resource.resourceType`
      // and `resource.attributes` are both `undefined` — so the failure
      // surfaced further from its cause than this throw, if at all.
      expect(error.message).toBe('Resource constructor not found for Fn::GetAtt');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('resolves a GetAtt against a resource genuinely named constructor', async () => {
      const resolver = new IntrinsicFunctionResolver();
      const context: ResolverContext = {
        template: {
          Resources: { constructor: { Type: 'AWS::S3::Bucket' } },
        } as unknown as CloudFormationTemplate,
        resources: {
          constructor: {
            physicalId: 'phys-ctor',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: { Arn: 'arn:aws:s3:::phys-ctor' },
          },
        },
      };

      expect(await resolver.resolve({ 'Fn::GetAtt': ['constructor', 'Arn'] }, context)).toBe(
        'arn:aws:s3:::phys-ctor'
      );
    });
  });
});
