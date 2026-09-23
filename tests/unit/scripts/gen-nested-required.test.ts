/**
 * The capture (`extractNestedRequired`) and codegen (`collectNestedRequired`)
 * behind the nested `required` pre-flight (issue #1802).
 *
 * The capture's restriction to `properties` / `$ref` / `items` is the part
 * that matters: a `required` list recorded from a combinator arm or a map
 * value would put it at a path where it does not hold, and the runtime would
 * refuse a valid template.
 */
import { describe, it, expect } from 'vite-plus/test';
import { extractNestedRequired } from '../../../scripts/refresh-cfn-schemas.mjs';
import { collectNestedRequired } from '../../../scripts/gen-nested-required.ts';

describe('extractNestedRequired', () => {
  it('keys each nested required list by full dotted path, arrays transparent, $refs resolved', () => {
    const schema = JSON.stringify({
      required: ['Top'],
      properties: {
        Config: { $ref: '#/definitions/Config' },
        Items: { type: 'array', items: { $ref: '#/definitions/Item' } },
        Inline: {
          type: 'object',
          required: ['Name'],
          properties: { Name: { type: 'string' }, Deep: { $ref: '#/definitions/Item' } },
        },
        Scalar: { type: 'string' },
      },
      definitions: {
        Config: {
          type: 'object',
          required: ['Rollback', 'Enable'],
          properties: { Enable: {}, Rollback: {}, Sub: { $ref: '#/definitions/Item' } },
        },
        Item: { type: 'object', required: ['Key'], properties: { Key: {}, Value: {} } },
      },
    });
    expect(extractNestedRequired(schema)).toEqual({
      Config: ['Enable', 'Rollback'],
      'Config.Sub': ['Key'],
      Inline: ['Name'],
      'Inline.Deep': ['Key'],
      Items: ['Key'],
    });
  });

  it('records nothing from a combinator arm or a map value, and not the top-level list', () => {
    const schema = JSON.stringify({
      required: ['Top'],
      properties: {
        OneOf: { oneOf: [{ $ref: '#/definitions/A' }, { $ref: '#/definitions/B' }] },
        AnyOf: { anyOf: [{ $ref: '#/definitions/A' }] },
        AllOf: { allOf: [{ $ref: '#/definitions/A' }] },
        Map: { type: 'object', additionalProperties: { $ref: '#/definitions/A' } },
        Pattern: { type: 'object', patternProperties: { '.*': { $ref: '#/definitions/A' } } },
      },
      definitions: {
        A: { type: 'object', required: ['X'], properties: { X: {} } },
        B: { type: 'object', required: ['Y'], properties: { Y: {} } },
      },
    });
    expect(extractNestedRequired(schema)).toEqual({});
  });

  it('keeps the INTERSECTION when one path carries two lists, and drops an empty result', () => {
    const schema = JSON.stringify({
      properties: {
        Both: { $ref: '#/definitions/D', required: ['A', 'C'] },
        Disjoint: { $ref: '#/definitions/D', required: ['Z'] },
      },
      definitions: { D: { type: 'object', required: ['A', 'B'], properties: { A: {}, B: {} } } },
    });
    expect(extractNestedRequired(schema)).toEqual({ Both: ['A'] });
  });

  it('terminates on a self-referential definition', () => {
    const schema = JSON.stringify({
      properties: { Node: { $ref: '#/definitions/Node' } },
      definitions: {
        Node: { type: 'object', required: ['Id'], properties: { Id: {}, Child: { $ref: '#/definitions/Node' } } },
      },
    });
    expect(extractNestedRequired(schema)).toEqual({ Node: ['Id'] });
  });
});

describe('collectNestedRequired', () => {
  it('sorts types, paths and members, and skips fixtures without the section', () => {
    expect(
      collectNestedRequired([
        { resourceType: 'AWS::Z::T', nestedRequired: { 'B.C': ['y', 'x'], A: ['k'] } },
        { resourceType: 'AWS::A::T' },
        { resourceType: 'AWS::M::T', nestedRequired: { P: [] } },
        { nestedRequired: { P: ['q'] } },
        { resourceType: 'AWS::B::T', nestedRequired: { P: ['q'] } },
      ])
    ).toEqual([
      ['AWS::B::T', [['P', ['q']]]],
      [
        'AWS::Z::T',
        [
          ['A', ['k']],
          ['B.C', ['x', 'y']],
        ],
      ],
    ]);
  });
});
