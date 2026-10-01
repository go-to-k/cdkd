/**
 * The capture (`extractPropertyShapes`) and codegen (`collectPropertyShapes`)
 * behind the property-shape pre-flight (issue #4357).
 *
 * Every row the capture emits becomes a refusal, so the cases that matter are
 * the ones where it must emit NOTHING: a type list, an implicit type, a
 * combinator whose arms disagree or leave a key open, and a map value.
 */
import { describe, it, expect } from 'vite-plus/test';
import { extractPropertyShapes } from '../../../scripts/refresh-cfn-schemas.mjs';
import { collectPropertyShapes } from '../../../scripts/gen-property-shape.ts';

// Every case but the legacy one declares `handlers`: a handler-less schema yields nothing.
const shapes = (schema: Record<string, unknown>) =>
  extractPropertyShapes(JSON.stringify({ handlers: { create: {} }, ...schema }));

describe('extractPropertyShapes', () => {
  it('keys each array / object kind by dotted path, `[]` for elements, $refs resolved', () => {
    expect(
      shapes({
        properties: {
          Tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
          Config: { $ref: '#/definitions/Config' },
          Name: { type: 'string' },
          Matrix: { type: 'array', items: { type: 'array', items: { type: 'object' } } },
        },
        definitions: {
          Tag: { type: 'object', properties: { Key: { type: 'string' } } },
          Config: {
            type: 'object',
            properties: {
              Subnets: { type: 'array', items: { type: 'string' } },
              Inner: { type: 'object', properties: { Rules: { type: 'array' } } },
            },
          },
        },
      })
    ).toEqual({
      Config: 'object',
      'Config.Inner': 'object',
      'Config.Inner.Rules': 'array',
      'Config.Subnets': 'array',
      Matrix: 'array',
      'Matrix[]': 'array',
      'Matrix[][]': 'object',
      Tags: 'array',
      'Tags[]': 'object',
    });
  });

  it('emits no kind for a type list, an implicit type or a typeless node, but keeps their children', () => {
    expect(
      shapes({
        properties: {
          Policy: { type: ['object', 'string'] },
          Either: { type: ['array', 'object'], properties: { Inner: { type: 'array' } } },
          Implicit: { properties: { Inner: { type: 'object' } } },
          ImplicitList: { items: { type: 'object' } },
          Anything: { description: 'no type at all' },
        },
      })
    ).toEqual({
      'Either.Inner': 'array',
      'Implicit.Inner': 'object',
      'ImplicitList[]': 'object',
    });
  });

  it('keeps a oneOf / anyOf kind only when every arm agrees', () => {
    expect(
      shapes({
        properties: {
          Agree: { oneOf: [{ type: 'object' }, { $ref: '#/definitions/Obj' }] },
          Disagree: { oneOf: [{ type: 'array' }, { type: 'object' }] },
          Untyped: { anyOf: [{ type: 'object' }, { required: ['X'] }] },
        },
        definitions: { Obj: { type: 'object' } },
      })
    ).toEqual({ Agree: 'object' });
  });

  it('keeps an arm member only when no object-admitting arm leaves that key open', () => {
    expect(
      shapes({
        properties: {
          // The `string` arm cannot hold an object, so the object arm decides.
          StringOrObject: {
            oneOf: [{ type: 'string' }, { type: 'object', properties: { L: { type: 'array' } } }],
          },
          // A closed arm refuses the key outright; the other arm decides.
          ClosedArm: {
            oneOf: [
              { type: 'object', additionalProperties: false, properties: { A: { type: 'string' } } },
              { type: 'object', properties: { L: { type: 'array' } } },
            ],
          },
          // An OPEN arm without the key accepts any value there.
          OpenArm: {
            oneOf: [
              { type: 'object', properties: { A: { type: 'string' } } },
              { type: 'object', properties: { L: { type: 'array' } } },
            ],
          },
          // Both arms name it, with different kinds.
          Conflict: {
            anyOf: [
              { type: 'object', additionalProperties: false, properties: { L: { type: 'array' } } },
              { type: 'object', additionalProperties: false, properties: { L: { type: 'object' } } },
            ],
          },
        },
      })
    ).toEqual({
      ClosedArm: 'object',
      'ClosedArm.L': 'array',
      Conflict: 'object',
      OpenArm: 'object',
      'StringOrObject.L': 'array',
    });
  });

  it('adds allOf arms up, and reads a contradiction as unconstrained', () => {
    expect(
      shapes({
        properties: {
          Merged: {
            type: 'object',
            allOf: [{ properties: { A: { type: 'array' } } }, { properties: { B: { type: 'object' } } }],
          },
          Contradiction: { type: 'array', allOf: [{ type: 'object' }] },
        },
      })
    ).toEqual({ Merged: 'object', 'Merged.A': 'array', 'Merged.B': 'object' });
  });

  it('does not follow additionalProperties / patternProperties values, nor $ref siblings', () => {
    expect(
      shapes({
        properties: {
          Map: { type: 'object', additionalProperties: { type: 'array' } },
          Pattern: { type: 'object', patternProperties: { '.*': { type: 'object' } } },
          RefWithSibling: { $ref: '#/definitions/Untyped', type: 'object' },
        },
        definitions: { Untyped: { description: 'anything' } },
      })
    ).toEqual({ Map: 'object', Pattern: 'object' });
  });

  it('terminates on a self-referential definition, which constrains nothing past the cycle', () => {
    expect(
      shapes({
        properties: { Node: { $ref: '#/definitions/Node' } },
        definitions: {
          Node: {
            type: 'object',
            properties: { Children: { type: 'array', items: { $ref: '#/definitions/Node' } } },
          },
        },
      })
    ).toEqual({ Node: 'object', 'Node.Children': 'array' });
  });

  it('returns nothing for a schema without properties', () => {
    expect(shapes({ definitions: {} })).toEqual({});
  });

  it('returns nothing for a legacy schema without handlers, whose schema CloudFormation does not validate', () => {
    // The shape of AWS::CodeBuild::Project's `FilterGroup`: an empty closed
    // object in the registry schema, a list of filters in every real template.
    const legacy = {
      properties: { FilterGroups: { type: 'array', items: { $ref: '#/definitions/FilterGroup' } } },
      definitions: { FilterGroup: { type: 'object', additionalProperties: false } },
    };
    expect(extractPropertyShapes(JSON.stringify(legacy))).toEqual({});
    expect(shapes(legacy)).toEqual({ FilterGroups: 'array', 'FilterGroups[]': 'object' });
  });

  it('treats an arm with patternProperties as open even when additionalProperties is false', () => {
    expect(
      shapes({
        properties: {
          X: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                patternProperties: { '.*': {} },
                properties: { A: { type: 'string' } },
              },
              { type: 'object', properties: { L: { type: 'array' } } },
            ],
          },
        },
      })
    ).toEqual({ X: 'object' });
  });

  it('keeps element kinds only when every array-admitting arm constrains its items', () => {
    expect(
      shapes({
        properties: {
          OneHasItems: { oneOf: [{ type: 'array' }, { type: 'array', items: { type: 'object' } }] },
          BothHaveItems: {
            oneOf: [
              { type: 'array', items: { type: 'object' } },
              { type: 'array', items: { $ref: '#/definitions/Obj' } },
            ],
          },
        },
        definitions: { Obj: { type: 'object' } },
      })
    ).toEqual({ BothHaveItems: 'array', 'BothHaveItems[]': 'object', OneHasItems: 'array' });
  });

  it('counts a typeless arm as one an object can match', () => {
    expect(
      shapes({
        properties: {
          X: {
            oneOf: [
              { properties: { A: { type: 'string' } } },
              { type: 'object', properties: { L: { type: 'array' } } },
            ],
          },
        },
      })
    ).toEqual({});
  });

  it('carries closed-ness through nested combinators: a meet is closed only when every arm is, an allOf when any is', () => {
    const otherArm = { type: 'object', properties: { L: { type: 'array' } } };
    expect(
      shapes({
        properties: {
          // Inner oneOf of a closed and an open arm is OPEN, so L stays unconstrained.
          MeetOpen: {
            oneOf: [
              {
                oneOf: [
                  { type: 'object', additionalProperties: false, properties: { A: { type: 'string' } } },
                  { type: 'object', properties: { A: { type: 'string' } } },
                ],
              },
              otherArm,
            ],
          },
          // A closed node joined with an open allOf arm stays CLOSED, so the other arm decides L.
          JoinClosed: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: { A: { type: 'string' } },
                allOf: [{ properties: { B: { type: 'string' } } }],
              },
              otherArm,
            ],
          },
        },
      })
    ).toEqual({ JoinClosed: 'object', 'JoinClosed.L': 'array', MeetOpen: 'object' });
  });

  it('ignores a non-local $ref and stops at the depth cap', () => {
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 13; i >= 1; i--) deep = { type: 'object', properties: { [`L${i}`]: deep } };
    const out = shapes({
      properties: {
        // Sliced past `#/definitions/`'s length this would spell `Obj`.
        Remote: { $ref: '#/properties/xObj' },
        Deep: deep,
      },
      definitions: { Obj: { type: 'object' } },
    });
    expect(out).not.toHaveProperty('Remote');
    const depths = Object.keys(out).map((p) => p.split('.').length);
    expect(Math.max(...depths)).toBe(12);
    expect(depths).toHaveLength(12);
  });
});

describe('collectPropertyShapes', () => {
  const fixtures = [
    { resourceType: 'AWS::B::Type', propertyShapes: { Z: 'object', A: 'array', 'A[]': 'object' } },
    { resourceType: 'AWS::A::Type', propertyShapes: { Tags: 'array' } },
    { resourceType: 'AWS::C::Type', propertyShapes: {} },
    { resourceType: 'AWS::D::Type' },
    { resourceType: 'AWS::E::Type', propertyShapes: { Bogus: 'scalar', Kept: 'object' } },
    { propertyShapes: { A: 'array' } },
  ];

  it('sorts types and paths, and drops empty sections, missing types and non-kind rows', () => {
    expect(collectPropertyShapes(fixtures)).toEqual([
      ['AWS::A::Type', [['Tags', 'array']]],
      [
        'AWS::B::Type',
        [
          ['A', 'array'],
          ['A[]', 'object'],
          ['Z', 'object'],
        ],
      ],
      ['AWS::E::Type', [['Kept', 'object']]],
    ]);
  });

  it('is deterministic: the input order does not change the output', () => {
    expect(collectPropertyShapes([...fixtures].reverse())).toEqual(collectPropertyShapes(fixtures));
  });
});
