/**
 * Issue [#2767](https://github.com/go-to-k/cdkd/issues/2767): the resolver's
 * reads of a bag keyed by a TEMPLATE-controlled name.
 *
 * Every site shares one shape — the bag is read (or `in`-tested) on a plain
 * object, so an `Object.prototype` member name answers where no entry exists.
 * They are swept together because a template reaches them by the same name:
 * `constructor` misses the resource bag and lands on the parameter arm one line
 * down, `Fn::GetAtt` takes a third, and `Fn::If` / `Fn::FindInMap` read their
 * own bags the same way; fixing one alone moves the wrong answer rather than
 * removing it.
 *
 * Most of them produce a WRONG RESULT rather than a refusal, which is why each
 * is pinned by the thrown message or the rendered value and not merely by
 * "does not contain a function":
 *
 * - `resolveValue`'s object walk assigned a `__proto__` property — an OWN key
 *   after `JSON.parse` — through the inherited setter, so it was silently
 *   ABSENT from the object deploy hands the provider. The remedy SHADOWS that
 *   one key with `defineProperty` rather than switching the bag to
 *   `Object.create(null)`: this bag is a resolved VALUE and callers coerce one,
 *   and `String()` on a null-prototype object THROWS where it returned
 *   `[object Object]`. That coercion is pinned below, in both directions.
 * - `resolveRef`'s resource read took the `Object` function as a resource, so
 *   `cfnRefValueFromPhysicalId` fell through every guard and returned
 *   `undefined`, which `resolveSub` `String()`s into the literal text
 *   `undefined`. The pin is the RENDERED string, since the old behaviour also
 *   satisfies any "no function source" negative.
 *
 * Reached HERE by a bare `Ref` / `Fn::GetAtt`. `Fn::Sub` reaches them too since
 * issue [#2739](https://github.com/go-to-k/cdkd/issues/2739) gave `resolveSub`'s
 * variable map a null prototype — before that, `${constructor}` was answered as
 * BOUND and never arrived. This file pins the arms themselves; the `Fn::Sub`
 * route to them is [#2776](https://github.com/go-to-k/cdkd/issues/2776)'s,
 * along with `Fn::Sub`'s own first-element guard.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// The `resolveGetAtt` attribute cases need this. With the prototype no longer
// answering, an unknown attribute name correctly falls through to the
// CONSTRUCTED-attribute path, which calls AWS through `getAwsClients()` — so
// without a mock those cases trip the suite's AWS fence instead of asserting
// anything. Every send REJECTS, which is what makes the assertion sharp: after
// the fix the resolution FAILS, where before it succeeded and returned the
// `Object` function as the attribute's value.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockRejectedValue(new Error('no AWS in unit tests')) },
    ec2: { send: vi.fn().mockRejectedValue(new Error('no AWS in unit tests')) },
    cloudformation: { send: vi.fn().mockRejectedValue(new Error('no AWS in unit tests')) },
    s3: { send: vi.fn().mockRejectedValue(new Error('no AWS in unit tests')) },
  }),
}));

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

  describe('the resolved bag stays coercible', () => {
    it('keeps String() on a resolved object at [object Object]', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // The reason the fix shadows one key instead of using
      // `Object.create(null)`: `resolveJoin` does `String(resolved)` on every
      // part, and `resolveSub` `String()`s a substituted variable, so a
      // null-prototype bag would THROW `Cannot convert object to primitive
      // value` — and inside `resolveSub` that throw is caught and laundered
      // into a retained `${...}` placeholder. Pinned through `Fn::Join`, the
      // caller that coerces without catching.
      const result = await resolver.resolve(
        { 'Fn::Join': ['-', ['a', JSON.parse('{"__proto__":"x","k":"v"}')]] },
        emptyContext()
      );

      expect(result).toBe('a-[object Object]');
    });
  });

  describe('resolveIf and condition references', () => {
    it('treats an Object.prototype member as an UNKNOWN condition, not a true one', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // The bare `in` answered true, read the `Object` FUNCTION as the
      // condition value, and — being truthy — selected the TRUE branch, while
      // the documented not-found behaviour is warn-and-assume-false.
      const result = await resolver.resolve(
        { 'Fn::If': ['constructor', 'TRUE-BRANCH', 'FALSE-BRANCH'] },
        { ...emptyContext(), conditions: {} } as ResolverContext
      );

      expect(result).toBe('FALSE-BRANCH');
    });

    // `resolveConditionReference`'s own bag read got the same treatment and is
    // NOT pinned here: its single call site gates on `context.conditionResolver`
    // being present, and that function returns through the hook for exactly that
    // case, so no context the resolver builds reaches the line. Its comment says
    // so rather than this file asserting a shape the resolver never produces.

    it('evaluates a condition DECLARED under an Object.prototype member name', async () => {
      const resolver = new IntrinsicFunctionResolver();
      // Parsed from a STRING, not an object literal: `{ __proto__: {...} }`
      // sets the prototype instead of creating an own key, so a literal would
      // make this case vacuous — the same trap the `resolveValue` case above
      // avoids the same way.
      const template = JSON.parse(
        '{"Resources":{},"Conditions":{' +
          '"constructor":{"Fn::Equals":["a","b"]},' +
          '"__proto__":{"Fn::Equals":["a","a"]}}}'
      ) as CloudFormationTemplate;

      // `evaluateConditions` PRODUCES the bag `resolveIf` reads, and its own
      // memo test and writes had the same defect: `constructor` short-circuited
      // on the first call and returned the `Object` function as its boolean
      // without evaluating the definition, and `conditions['__proto__'] = ...`
      // was lost through the inherited setter — so a resource CloudFormation
      // omits was kept by `filterResourcesByCondition`.
      const conditions = await resolver.evaluateConditions({
        template,
        resources: {},
      } as ResolverContext);

      expect(Object.keys(conditions).sort()).toEqual(['__proto__', 'constructor']);
      expect(conditions['constructor']).toBe(false);
      expect(conditions['__proto__']).toBe(true);
    });

    it('treats a REFERENCE to an undeclared Object.prototype name as not-declared', async () => {
      const resolver = new IntrinsicFunctionResolver();
      // `Conditions` declares `A` only. Resolving it reaches
      // `{Condition: "constructor"}`, and the template's own `Conditions` bag
      // is read for that name — pre-fix `bag['constructor']` answered the
      // `Object` FUNCTION, so the not-declared arm was skipped and the function
      // was handed to the resolver as a condition BODY. The declared-name case
      // above cannot discriminate this: `Object.hasOwn` and a bare index agree
      // whenever the name really is declared.
      const template = JSON.parse(
        '{"Resources":{},"Conditions":{"A":{"Fn::Not":[{"Condition":"constructor"}]}}}'
      ) as CloudFormationTemplate;

      const conditions = await resolver.evaluateConditions({
        template,
        resources: {},
      } as ResolverContext);

      // Undeclared means false, so `Fn::Not` of it is true.
      expect(conditions['A']).toBe(true);
    });

    it('still resolves a condition that is genuinely declared', async () => {
      const resolver = new IntrinsicFunctionResolver();

      // The positive twin: a mutant refusing every name passes both cases above.
      expect(
        await resolver.resolve({ 'Fn::If': ['IsProd', 'YES', 'NO'] }, {
          ...emptyContext(),
          conditions: { IsProd: true },
        } as ResolverContext)
      ).toBe('YES');
    });
  });

  describe('resolveFindInMap', () => {
    const mapContext = (): ResolverContext =>
      ({
        template: {
          Resources: {},
          Mappings: { Sizes: { small: { cpu: '256' } } },
        } as unknown as CloudFormationTemplate,
        resources: {},
      }) as ResolverContext;

    // Mapping keys are FREE-FORM text rather than logical ids, so this is the
    // most reachable site of the class. The EXACT message is asserted per case,
    // and the top-level arm uses `__proto__` rather than `constructor`, because
    // a loose `toContain('not found')` does not discriminate here — measured
    // against the pre-fix lookups: `['Sizes','constructor','cpu']` throws the
    // IDENTICAL message before and after (`map['constructor']` is a FUNCTION,
    // which fails the `typeof === 'object'` guard), and `['constructor',...]`
    // merely moves which key the message names. `['Sizes','__proto__','cpu']`
    // is the discriminating shape: `map['__proto__']` is `Object.prototype`, an
    // object, so it PASSED that guard and the failure surfaced one level down
    // naming the wrong key.
    it.each([
      [
        'the map name',
        { 'Fn::FindInMap': ['constructor', 'small', 'cpu'] },
        "Fn::FindInMap: mapping 'constructor' not found in Mappings section",
      ],
      [
        'the top-level key',
        { 'Fn::FindInMap': ['Sizes', '__proto__', 'cpu'] },
        "Fn::FindInMap: top-level key '__proto__' not found in mapping 'Sizes'",
      ],
      [
        'the second-level key',
        { 'Fn::FindInMap': ['Sizes', 'small', 'constructor'] },
        "Fn::FindInMap: second-level key 'constructor' not found in mapping 'Sizes' -> 'small'",
      ],
    ])('refuses an Object.prototype member in %s', async (_label, value, message) => {
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(resolver, value, mapContext());

      expect(error.message).toBe(message);
    });


    it('falls back to DefaultValue when Mappings is null, rather than throwing a TypeError', async () => {
      // Regression guard on the FIX, not on the original defect. The read this
      // replaced was `mappings?.[mapName]`, whose optional chain short-circuits
      // on NULL; a `!== undefined` test does not, and `Object.hasOwn(null, k)`
      // throws. A YAML `Mappings:` with an empty body parses to `null` and
      // reaches the resolver through `cdkd import --migrate-from-cloudformation`.
      const resolver = new IntrinsicFunctionResolver();
      const template = JSON.parse('{"Resources":{},"Mappings":null}') as CloudFormationTemplate;

      const result = await resolver.resolve(
        { 'Fn::FindInMap': ['Sizes', 'small', 'cpu', { DefaultValue: 'fallback' }] },
        { template, resources: {} } as ResolverContext
      );

      expect(result).toBe('fallback');
    });

    it('raises the NAMED refusal for a null Mappings with no DefaultValue', async () => {
      const resolver = new IntrinsicFunctionResolver();
      const template = JSON.parse('{"Resources":{},"Mappings":null}') as CloudFormationTemplate;

      const error = await resolveError(
        resolver,
        { 'Fn::FindInMap': ['Sizes', 'small', 'cpu'] },
        { template, resources: {} } as ResolverContext
      );

      expect(error.message).toBe('Fn::FindInMap: no Mappings section found in template');
      expect(error.message).not.toContain('Cannot convert');
    });

    it('still resolves a genuine mapping lookup', async () => {
      const resolver = new IntrinsicFunctionResolver();

      expect(
        await resolver.resolve({ 'Fn::FindInMap': ['Sizes', 'small', 'cpu'] }, mapContext())
      ).toBe('256');
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
    });
  });

  describe('resolveGetAtt attribute reads', () => {
    const withAttributes = (): ResolverContext =>
      ({
        template: {
          Resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
        } as unknown as CloudFormationTemplate,
        resources: {
          Bucket: {
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: JSON.parse('{"Arn":"arn:aws:s3:::b","Endpoint":{"Host":"h"}}') as Record<
              string,
              unknown
            >,
          },
        },
      }) as ResolverContext;

    it.each([
      ['the flat attribute read', 'constructor'],
      ['the nested-path walk', 'Endpoint.constructor'],
    ])('does not answer from Object.prototype through %s', async (_label, attributeName) => {
      const resolver = new IntrinsicFunctionResolver();

      // The RESOURCE exists, so `resolveGetAtt`'s own resource read (fixed
      // above) is not what answers here — these are the two attribute reads one
      // layer in, and each used to return the `Object` function as the resolved
      // attribute. After the fix neither finds anything, so both fall through to
      // the constructed-attribute path; the module mock above rejects its AWS
      // call, leaving the guarded physical-id fallback. The pin is that VALUE,
      // not merely "no function source": `toBe` states what the arm now answers.
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['Bucket', attributeName] },
        withAttributes()
      );

      expect(result).toBe('b');
    });
    it('still resolves genuine attributes, including one named constructor', async () => {
      const resolver = new IntrinsicFunctionResolver();
      const own = withAttributes();
      // An OWN `constructor` attribute — the shape `Object.hasOwn` must accept
      // where the prototype's member is refused.
      (own.resources['Bucket']!.attributes as Record<string, unknown>)['constructor'] = 'own-value';

      expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'Arn'] }, own)).toBe(
        'arn:aws:s3:::b'
      );
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'Endpoint.Host'] }, own)).toBe('h');
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'constructor'] }, own)).toBe(
        'own-value'
      );
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

  describe('sites the enumeration reached that no review round named', () => {
    it('treats an Object.prototype member as an UNBOUND declared parameter', async () => {
      // `isUnboundTemplateParameter`'s DECLARED side already used `Object.hasOwn`
      // while its BOUND side used a bare `in`, so a declared-but-unbound
      // parameter named `constructor` read as BOUND and the #2285 refusal it
      // exists to raise was suppressed for exactly that name.
      const template = JSON.parse(
        '{"Resources":{},"Parameters":{"constructor":{"Type":"String"}}}'
      ) as CloudFormationTemplate;
      const resolver = new IntrinsicFunctionResolver();

      const error = await resolveError(resolver, { Ref: 'constructor' }, {
        template,
        resources: {},
        parameters: {},
      } as ResolverContext);

      // Declared, no Default, unbound -> the deliberate structural refusal,
      // not the generic not-found one.
      expect(error.message).toContain('constructor');
    });

    it('does not read an Object.prototype member as a user-supplied parameter', async () => {
      // `resolveParameters`' user-value read: a bare `in` answered for
      // `constructor` and handed the `Object` FUNCTION to `coerceParameterValue`.
      const template = JSON.parse(
        '{"Resources":{},"Parameters":{"constructor":{"Type":"String","Default":"from-default"}}}'
      ) as CloudFormationTemplate;
      const resolver = new IntrinsicFunctionResolver();

      const resolved = await resolver.resolveParameters(template, {});

      // The declared Default wins, because no USER value exists for that name.
      expect(resolved['constructor']).toBe('from-default');
    });
  });
});
