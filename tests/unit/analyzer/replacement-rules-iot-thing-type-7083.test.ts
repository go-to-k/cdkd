import { describe, it, expect } from 'vite-plus/test';

// go-to-k/cdkd#7083: CloudFormation replaces an IoT thing type on a
// ThingTypeProperties change only when ThingTypeDescription or
// SearchableAttributes changes; a Mqtt5Configuration change applies in place
// (measured against CloudFormation, us-east-1).
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { thingTypeReplacingMemberChanged } from '../../../src/analyzer/replacement-rules/predicates.js';

const mqtt = (key: string) => ({
  PropagatingAttributes: [{ UserPropertyKey: key, ThingAttribute: 'a' }],
});

describe('thingTypeReplacingMemberChanged (go-to-k/cdkd#7083)', () => {
  it.each([
    ['a description change', { ThingTypeDescription: 'one' }, { ThingTypeDescription: 'two' }, true],
    ['a description added', {}, { ThingTypeDescription: 'one' }, true],
    ['a description removed', { ThingTypeDescription: 'one' }, {}, true],
    [
      'a searchable attribute added',
      { SearchableAttributes: ['a'] },
      { SearchableAttributes: ['a', 'b'] },
      true,
    ],
    ['searchable attributes removed', { SearchableAttributes: ['a'] }, {}, true],
    [
      'a Mqtt5Configuration change',
      { ThingTypeDescription: 'one', Mqtt5Configuration: mqtt('k1') },
      { ThingTypeDescription: 'one', Mqtt5Configuration: mqtt('k2') },
      false,
    ],
    [
      'a Mqtt5Configuration added',
      { ThingTypeDescription: 'one' },
      { ThingTypeDescription: 'one', Mqtt5Configuration: mqtt('k1') },
      false,
    ],
    [
      'equal replacing members',
      { ThingTypeDescription: 'one', SearchableAttributes: ['a'] },
      { ThingTypeDescription: 'one', SearchableAttributes: ['a'] },
      false,
    ],
    ['both absent', undefined, undefined, false],
    ['the whole block added with only Mqtt5Configuration', undefined, { Mqtt5Configuration: mqtt('k1') }, false],
    ['the whole block added with a description', undefined, { ThingTypeDescription: 'one' }, true],
    [
      'a block that is an unresolved intrinsic',
      { 'Fn::If': ['C', { ThingTypeDescription: 'a' }, { ThingTypeDescription: 'b' }] },
      { ThingTypeDescription: 'a' },
      true,
    ],
    [
      'an unchanged intrinsic block',
      { 'Fn::If': ['C', { ThingTypeDescription: 'a' }, {}] },
      { 'Fn::If': ['C', { ThingTypeDescription: 'a' }, {}] },
      false,
    ],
  ])('%s -> %s', (_label, oldValue, newValue, expected) => {
    expect(thingTypeReplacingMemberChanged(oldValue, newValue)).toBe(expected);
  });

  it('is the registry rule for AWS::IoT::ThingType ThingTypeProperties', () => {
    const rules = new ReplacementRulesRegistry();
    expect(rules.isClassified('AWS::IoT::ThingType', 'ThingTypeProperties')).toBe(true);
    expect(
      rules.requiresReplacement(
        'AWS::IoT::ThingType',
        'ThingTypeProperties',
        { SearchableAttributes: ['a'] },
        { SearchableAttributes: ['a', 'b'] }
      )
    ).toBe(true);
    expect(
      rules.requiresReplacement(
        'AWS::IoT::ThingType',
        'ThingTypeProperties',
        { Mqtt5Configuration: mqtt('k1') },
        { Mqtt5Configuration: mqtt('k2') }
      )
    ).toBe(false);
    // The schema fallback keeps deciding the create-only name.
    expect(rules.isClassified('AWS::IoT::ThingType', 'ThingTypeName')).toBe(false);
  });
});
