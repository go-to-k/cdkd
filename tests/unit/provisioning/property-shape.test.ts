/**
 * The property-shape pre-flight (issue #4357): a list where the schema wants
 * an object, or the reverse, is refused before any provider runs, in
 * CloudFormation's own words; anything the schema does not pin to exactly one
 * of the two kinds, and every intrinsic, passes.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  buildShapeTree,
  findPropertyShapeViolations,
  validatePropertyShapes,
} from '../../../src/provisioning/property-shape.js';
import { PROPERTY_SHAPES } from '../../../src/provisioning/property-shape.generated.js';

describe('findPropertyShapeViolations against the generated table', () => {
  it('the table carries the rows these cases rely on', () => {
    expect(PROPERTY_SHAPES.get('AWS::SQS::Queue')).toMatchObject({ Tags: 'array', 'Tags[]': 'object' });
    expect(PROPERTY_SHAPES.get('AWS::Lambda::Function')).toMatchObject({
      VpcConfig: 'object',
      'VpcConfig.SubnetIds': 'array',
      Environment: 'object',
    });
  });

  it('refuses an object where the schema wants a list, at top level', () => {
    expect(
      findPropertyShapeViolations('AWS::SQS::Queue', { Tags: { Key: 'a', Value: 'b' } })
    ).toEqual([{ resourceType: 'AWS::SQS::Queue', path: 'Tags', expected: 'array', found: 'object' }]);
  });

  it('refuses a list where the schema wants an object, at top level', () => {
    expect(
      findPropertyShapeViolations('AWS::Lambda::Function', { Environment: [{ Variables: {} }] })
    ).toEqual([
      { resourceType: 'AWS::Lambda::Function', path: 'Environment', expected: 'object', found: 'array' },
    ]);
  });

  it('refuses a nested object-for-list and a list-for-object inside array elements', () => {
    expect(
      findPropertyShapeViolations('AWS::Lambda::Function', {
        VpcConfig: { SubnetIds: { first: 'subnet-1' }, SecurityGroupIds: ['sg-1'] },
      })
    ).toEqual([
      {
        resourceType: 'AWS::Lambda::Function',
        path: 'VpcConfig.SubnetIds',
        expected: 'array',
        found: 'object',
      },
    ]);
    expect(
      findPropertyShapeViolations('AWS::SQS::Queue', {
        Tags: [{ Key: 'ok', Value: 'v' }, [{ Key: 'nested', Value: 'v' }]],
      })
    ).toEqual([{ resourceType: 'AWS::SQS::Queue', path: 'Tags[1]', expected: 'object', found: 'array' }]);
  });

  it('passes a correctly shaped template', () => {
    expect(
      findPropertyShapeViolations('AWS::Lambda::Function', {
        Environment: { Variables: { A: 'b' } },
        VpcConfig: { SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
        Tags: [{ Key: 'k', Value: 'v' }],
        FunctionName: 'f',
      })
    ).toEqual([]);
  });

  const INTRINSICS: Record<string, unknown> = {
    Ref: { Ref: 'SubnetsParam' },
    'Fn::If': { 'Fn::If': ['Cond', ['subnet-1'], { Ref: 'AWS::NoValue' }] },
    'Fn::Split': { 'Fn::Split': [',', 'a,b'] },
    'Fn::GetAZs': { 'Fn::GetAZs': '' },
    'Fn::Cidr': { 'Fn::Cidr': ['10.0.0.0/16', 2, 8] },
    'Fn::GetAtt': { 'Fn::GetAtt': ['Vpc', 'Subnets'] },
    'Fn::ImportValue': { 'Fn::ImportValue': 'Exported' },
    'Fn::FindInMap': { 'Fn::FindInMap': ['M', 'k', 'v'] },
    'Fn::Select': { 'Fn::Select': [0, [['a']]] },
    'Fn::Join': { 'Fn::Join': [',', ['a']] },
    'Fn::Sub': { 'Fn::Sub': 'x' },
    'Fn::Base64': { 'Fn::Base64': 'x' },
    'Fn::Transform': { 'Fn::Transform': { Name: 'AWS::Include', Parameters: {} } },
    'Fn::GetStackOutput': { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o' } },
  };

  for (const [name, intrinsic] of Object.entries(INTRINSICS)) {
    it(`passes ${name} where a list, an object or a list element is wanted`, () => {
      expect(
        findPropertyShapeViolations('AWS::Lambda::Function', {
          Environment: intrinsic,
          VpcConfig: { SubnetIds: intrinsic },
          Tags: intrinsic,
        })
      ).toEqual([]);
      expect(findPropertyShapeViolations('AWS::SQS::Queue', { Tags: [intrinsic] })).toEqual([]);
    });
  }

  it('passes a dynamic reference and any scalar, which only CloudFormation coerces', () => {
    expect(
      findPropertyShapeViolations('AWS::Lambda::Function', {
        Environment: '{{resolve:ssm:/env}}',
        VpcConfig: { SubnetIds: 'subnet-1' },
        Tags: 7,
        Layers: null,
      })
    ).toEqual([]);
  });

  it('passes an unknown type, an unknown path, and a non-object properties bag', () => {
    expect(findPropertyShapeViolations('Custom::Thing', { Tags: { Key: 'k' } })).toEqual([]);
    expect(findPropertyShapeViolations('AWS::SQS::Queue', { NotInSchema: { a: [1] } })).toEqual([]);
    expect(findPropertyShapeViolations('AWS::SQS::Queue', undefined)).toEqual([]);
    expect(
      findPropertyShapeViolations('AWS::SQS::Queue', [] as unknown as Record<string, unknown>)
    ).toEqual([]);
  });

  it('a key named after an Object.prototype member is not walked into a prototype', () => {
    expect(
      findPropertyShapeViolations('AWS::SQS::Queue', { constructor: [1], toString: { a: 1 } })
    ).toEqual([]);
  });
});

describe('buildShapeTree', () => {
  it('reads `[]` suffixes as element levels, nested ones included', () => {
    const tree = buildShapeTree({ M: 'array', 'M[]': 'array', 'M[][]': 'object', 'M[][].X': 'array' });
    expect(
      findPropertyShapeViolations('T', { M: [[{ X: { not: 'a list' } }, ['not an object']]] }, tree)
    ).toEqual([
      { resourceType: 'T', path: 'M[0][0].X', expected: 'array', found: 'object' },
      { resourceType: 'T', path: 'M[0][1]', expected: 'object', found: 'array' },
    ]);
  });
});

describe('validatePropertyShapes', () => {
  it('aggregates every violation into ONE CloudFormation-worded error naming id, type and path', () => {
    let message = '';
    try {
      validatePropertyShapes([
        { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', properties: { Tags: { Key: 'k' } } },
        { logicalId: 'Fine', resourceType: 'AWS::SQS::Queue', properties: { Tags: [] } },
        {
          logicalId: 'Fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: [], VpcConfig: { SubnetIds: {} } },
        },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Properties validation failed');
    expect(message).toContain(
      '  - Queue (AWS::SQS::Queue): #/Tags: expected type: JSONArray, found: JSONObject'
    );
    expect(message).toContain(
      '  - Fn (AWS::Lambda::Function): #/Environment: expected type: JSONObject, found: JSONArray'
    );
    expect(message).toContain(
      '  - Fn (AWS::Lambda::Function): #/VpcConfig.SubnetIds: expected type: JSONArray, found: JSONObject'
    );
    expect(message).not.toContain('Fine');
  });

  it('does not throw when nothing contradicts the schema', () => {
    expect(() =>
      validatePropertyShapes([
        { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', properties: { Tags: [] } },
        { logicalId: 'Other', resourceType: 'Custom::X', properties: undefined },
      ])
    ).not.toThrow();
  });

  it('renders a non-plain logical id through displayIdent rather than raw', () => {
    expect(() =>
      validatePropertyShapes([
        { logicalId: 'Bad\nId', resourceType: 'AWS::SQS::Queue', properties: { Tags: {} } },
      ])
    ).toThrow('  - "Bad Id" (AWS::SQS::Queue): #/Tags');
  });
});
