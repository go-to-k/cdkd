import { describe, expect, it } from 'vite-plus/test';
import {
  coerceParameterTypedValue,
  parameterTypeMayLoseSecretIdentity,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { isListParameterType } from '../../../src/utils/parameter-types.js';

/**
 * Issue #2347: `coerceParameterTypedValue` recognised exactly two list types,
 * so every `List<AWS::...>` parameter resolved to the raw comma-joined string.
 *
 * A CLASSIFIER cannot be fenced by hand-picked cases -- its defects live in the
 * spellings nobody wrote down -- so the core of this file is a DIFFERENTIAL
 * WALK over the whole declared input space against a verbatim transcription of
 * the pre-fix behaviour, with every differing cell classified BY THE VALUE the
 * function now returns -- recomputed independently, not merely shape-checked --
 * and each class carrying an ABSOLUTE floor that does not move when the input
 * pool it guards shrinks.
 */

/**
 * The pre-#2347 coercion, transcribed verbatim from
 * `git show origin/main:src/deployment/intrinsic-function-resolver.ts`
 * (commit daba7146), never from memory.
 */
function legacyCoerceParameterTypedValue(value: string, type: string): unknown {
  switch (type) {
    case 'Number':
      return Number(value);
    case 'List<Number>':
      return value.split(',').map((v) => Number(v.trim()));
    case 'CommaDelimitedList':
      return value.split(',').map((v) => v.trim());
    case 'String':
    default:
      return value;
  }
}

/**
 * The BASE types `parameters-section-structure.html` enumerates, verbatim.
 * Note `List<String>` is deliberately NOT here: the AWS page does not list it.
 */
const BASE_TYPES = ['String', 'Number', 'List<Number>', 'CommaDelimitedList'] as const;

/**
 * The ten AWS-specific SCALAR types from
 * `cloudformation-supplied-parameter-types.html`, verbatim.
 */
const AWS_SCALAR_TYPES = [
  'AWS::EC2::AvailabilityZone::Name',
  'AWS::EC2::Image::Id',
  'AWS::EC2::Instance::Id',
  'AWS::EC2::KeyPair::KeyName',
  'AWS::EC2::SecurityGroup::GroupName',
  'AWS::EC2::SecurityGroup::Id',
  'AWS::EC2::Subnet::Id',
  'AWS::EC2::Volume::Id',
  'AWS::EC2::VPC::Id',
  'AWS::Route53::HostedZone::Id',
] as const;

/**
 * The nine `List<AWS::...>` types the same page enumerates, verbatim. There is
 * no `List<AWS::EC2::KeyPair::KeyName>` in the AWS-specific list section --
 * although the Systems Manager section's own example spells
 * `AWS::SSM::Parameter::Value<List<AWS::EC2::KeyPair::KeyName>>` -- so it is
 * carried below as a doc-implied extra rather than smuggled in here.
 */
const AWS_LIST_TYPES = [
  'List<AWS::EC2::AvailabilityZone::Name>',
  'List<AWS::EC2::Image::Id>',
  'List<AWS::EC2::Instance::Id>',
  'List<AWS::EC2::SecurityGroup::GroupName>',
  'List<AWS::EC2::SecurityGroup::Id>',
  'List<AWS::EC2::Subnet::Id>',
  'List<AWS::EC2::Volume::Id>',
  'List<AWS::EC2::VPC::Id>',
  'List<AWS::Route53::HostedZone::Id>',
] as const;

/**
 * Spellings the CDK admits (`isListType` in aws-cdk-lib's `CfnParameter` is a
 * substring test) and that a synthesized template can therefore carry into
 * cdkd, even though CloudFormation's own enumeration omits them.
 */
const CDK_ADMITTED_LIST_TYPES = ['List<String>', 'List<AWS::EC2::KeyPair::KeyName>'] as const;

/**
 * The Systems Manager family. The VALUE of one of these is a Parameter Store
 * KEY, never the resolved list, so NONE of them may coerce -- including the
 * `Value<List<...>>` forms, whose list-ness is a statement about what SSM
 * holds, not about the string cdkd was handed.
 */
const SSM_TYPES = [
  'AWS::SSM::Parameter::Name',
  'AWS::SSM::Parameter::Value<String>',
  'AWS::SSM::Parameter::Value<List<String>>',
  'AWS::SSM::Parameter::Value<CommaDelimitedList>',
  ...AWS_SCALAR_TYPES.map((t) => `AWS::SSM::Parameter::Value<${t}>`),
  ...AWS_SCALAR_TYPES.map((t) => `AWS::SSM::Parameter::Value<List<${t}>>`),
];

/**
 * Malformed and adversarial spellings. None is a real CloudFormation type; the
 * point is that the classifier's answer for them is DECIDED rather than
 * incidental, and that the decision matches the pre-fix one (a scalar), which
 * is the safe direction on a path that writes state.
 */
const MALFORMED_TYPES = [
  '',
  ' ',
  'List<',
  'List<>',
  'List<String',
  'list<String>',
  'LIST<String>',
  'AList<String>',
  'MyList<String>',
  ' List<String>',
  'List<String> ',
  'CommaDelimitedListExtra',
  'ExtraCommaDelimitedList',
  'commadelimitedlist',
  'Lis<String>',
  'String<List>',
];

/**
 * Nested spellings CloudFormation rejects but that are unambiguously
 * list-SHAPED, so the predicate answers them the same way it answers a real
 * list type rather than by accident of the enumeration.
 */
const NESTED_LIST_TYPES = ['List<List<String>>', 'List<CommaDelimitedList>'];

const ALL_TYPES = [
  ...BASE_TYPES,
  ...AWS_SCALAR_TYPES,
  ...AWS_LIST_TYPES,
  ...CDK_ADMITTED_LIST_TYPES,
  ...SSM_TYPES,
  ...MALFORMED_TYPES,
  ...NESTED_LIST_TYPES,
];

/** Probe values chosen to expose splitting, trimming and single-element cases. */
const PROBE_VALUES = ['subnet-a, subnet-b', 'subnet-a', '', '1,2', 'a,  b ,c'];

/**
 * The classes of difference this change is ALLOWED to produce. A cell is
 * classified by the VALUE the new function returns, never by which input
 * produced it -- classifying by input would let a wrong answer for an unlisted
 * spelling hide inside a class named after the listed ones.
 *
 * The class pins the EXACT value, not its shape. An earlier revision asked only
 * `typeof before === 'string'` and `Array.isArray(after) && every(string)`,
 * which is a shape test wearing a value test's name: mutating the widened arm
 * to `return [type]` -- an answer with nothing to do with the input value --
 * still satisfied it, and the assertion stayed green. So the class recomputes
 * the split independently and requires equality.
 */
type DiffClass = 'string-to-comma-split-string-array';

function classifyDifference(before: unknown, after: unknown): DiffClass | 'UNCLASSIFIED' {
  if (typeof before !== 'string') return 'UNCLASSIFIED';
  const expected = before.split(',').map((v) => v.trim());
  if (JSON.stringify(after) !== JSON.stringify(expected)) return 'UNCLASSIFIED';
  return 'string-to-comma-split-string-array';
}

describe('coerceParameterTypedValue: differential walk over the declared type space', () => {
  it('produces only the one intended class of difference against the pre-fix behaviour', () => {
    const unclassified: string[] = [];
    const changedTypes = new Set<string>();
    const unchangedTypes = new Set<string>();

    for (const type of ALL_TYPES) {
      for (const value of PROBE_VALUES) {
        const before = legacyCoerceParameterTypedValue(value, type);
        const after = coerceParameterTypedValue(value, type);
        if (JSON.stringify(before) === JSON.stringify(after)) {
          unchangedTypes.add(type);
          continue;
        }
        changedTypes.add(type);
        if (classifyDifference(before, after) === 'UNCLASSIFIED') {
          unclassified.push(
            `type=${JSON.stringify(type)} value=${JSON.stringify(value)} ` +
              `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
          );
        }
      }
    }

    expect(unclassified).toEqual([]);

    // A type must not appear in both buckets: the class is a property of the
    // TYPE, so a per-value split would mean the classifier is value-sensitive.
    const both = [...changedTypes].filter((t) => unchangedTypes.has(t));
    expect(both).toEqual([]);

    // FLOORS, AS ABSOLUTE LITERALS. An earlier revision computed each floor
    // from `AWS_LIST_TYPES.length + ...` -- the very arrays the loops walk --
    // so deleting entries shrank the floor by the same amount and the fence
    // moved with the thing it fenced: replacing `AWS_LIST_TYPES` and
    // `NESTED_LIST_TYPES` with `[]` left this file fully GREEN. A floor derived
    // from its own pool is not a floor. These numbers are counted from the AWS
    // enumerations and must be edited by hand when a type is genuinely added.
    expect(BASE_TYPES.length).toBe(4);
    expect(AWS_SCALAR_TYPES.length).toBe(10);
    expect(AWS_LIST_TYPES.length).toBe(9);
    expect(CDK_ADMITTED_LIST_TYPES.length).toBe(2);
    expect(SSM_TYPES.length).toBe(24);
    expect(MALFORMED_TYPES.length).toBe(16);
    expect(NESTED_LIST_TYPES.length).toBe(2);
    expect(ALL_TYPES.length).toBe(67);
    expect(PROBE_VALUES.length).toBe(5);

    // 9 AWS list types + 2 CDK-admitted + 2 nested spellings.
    expect(changedTypes.size).toBe(13);
    // 4 base + 10 AWS scalars + 24 SSM + 16 malformed.
    expect(unchangedTypes.size).toBe(54);

    for (const type of [...AWS_LIST_TYPES, ...CDK_ADMITTED_LIST_TYPES, ...NESTED_LIST_TYPES]) {
      expect(changedTypes.has(type), `${type} must newly coerce to a list`).toBe(true);
    }
    // And the complement: every type that must NOT have moved.
    for (const type of [...BASE_TYPES, ...AWS_SCALAR_TYPES, ...SSM_TYPES, ...MALFORMED_TYPES]) {
      expect(changedTypes.has(type), `${type} must keep its pre-fix behaviour`).toBe(false);
    }
  });
});

describe('coerceParameterTypedValue: the widened list family', () => {
  it.each([...AWS_LIST_TYPES, ...CDK_ADMITTED_LIST_TYPES, ...NESTED_LIST_TYPES])(
    'splits and space-trims a %s value into an array of strings',
    (type) => {
      expect(coerceParameterTypedValue('subnet-a,  subnet-b , subnet-c', type)).toEqual([
        'subnet-a',
        'subnet-b',
        'subnet-c',
      ]);
    }
  );

  it('keeps List<Number> numeric — it is the only list type whose elements are not strings', () => {
    expect(coerceParameterTypedValue('80, 20', 'List<Number>')).toEqual([80, 20]);
  });

  it('leaves the AWS-specific SCALAR types as strings', () => {
    for (const type of AWS_SCALAR_TYPES) {
      expect(coerceParameterTypedValue('sg-a,sg-b', type)).toBe('sg-a,sg-b');
    }
  });

  it('leaves the whole SSM family as a string — its value is a Parameter Store key', () => {
    for (const type of SSM_TYPES) {
      expect(coerceParameterTypedValue('/app/subnets,/app/more', type)).toBe(
        '/app/subnets,/app/more'
      );
    }
  });
});

describe('isListParameterType', () => {
  it('accepts CommaDelimitedList and every well-formed List<...> spelling', () => {
    for (const type of [
      'CommaDelimitedList',
      'List<Number>',
      ...AWS_LIST_TYPES,
      ...CDK_ADMITTED_LIST_TYPES,
      ...NESTED_LIST_TYPES,
    ]) {
      expect(isListParameterType(type), type).toBe(true);
    }
  });

  it('rejects scalars, the SSM outer form, and malformed spellings', () => {
    for (const type of ['String', 'Number', ...AWS_SCALAR_TYPES, ...SSM_TYPES, ...MALFORMED_TYPES]) {
      expect(isListParameterType(type), type).toBe(false);
    }
  });
});

describe('parameterTypeMayLoseSecretIdentity stays DERIVED from the widened coercion', () => {
  it('reports every list type as identity-losing without being told which they are', () => {
    for (const type of [
      'CommaDelimitedList',
      'List<Number>',
      ...AWS_LIST_TYPES,
      ...CDK_ADMITTED_LIST_TYPES,
    ]) {
      expect(parameterTypeMayLoseSecretIdentity(type), type).toBe(true);
    }
  });

  it('still clears String, the AWS scalars and the SSM family', () => {
    for (const type of ['String', ...AWS_SCALAR_TYPES, ...SSM_TYPES]) {
      expect(parameterTypeMayLoseSecretIdentity(type), type).toBe(false);
    }
  });
});
