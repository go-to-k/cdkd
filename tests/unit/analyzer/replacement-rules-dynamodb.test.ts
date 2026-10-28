import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  attributeTypeChangedForSharedAttribute,
  globalTableLocalSecondaryIndexesRemoved,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * Regression coverage for the DynamoDB GSI-add bug: adding a Global Secondary
 * Index grows AttributeDefinitions, which the old rule treated as a blanket
 * replacement trigger — so `cdkd deploy` tried to recreate the same-named table
 * and failed with "Table already exists". AttributeDefinitions must only force
 * replacement when a shared attribute's TYPE changes.
 */
const TYPE = 'AWS::DynamoDB::Table';

describe('ReplacementRulesRegistry — DynamoDB AttributeDefinitions', () => {
  const registry = new ReplacementRulesRegistry();

  const pkOnly = [{ AttributeName: 'pk', AttributeType: 'S' }];
  const pkPlusGsi = [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'gsipk', AttributeType: 'S' },
  ];

  it('does NOT require replacement when a new attribute is added for a GSI', () => {
    expect(registry.requiresReplacement(TYPE, 'AttributeDefinitions', pkOnly, pkPlusGsi)).toBe(
      false
    );
  });

  it('does NOT require replacement when an attribute is removed (GSI dropped)', () => {
    expect(registry.requiresReplacement(TYPE, 'AttributeDefinitions', pkPlusGsi, pkOnly)).toBe(
      false
    );
  });

  it('requires replacement when a shared attribute changes type (S -> N)', () => {
    const pkNumber = [{ AttributeName: 'pk', AttributeType: 'N' }];
    expect(registry.requiresReplacement(TYPE, 'AttributeDefinitions', pkOnly, pkNumber)).toBe(
      true
    );
  });

  it('still requires replacement when KeySchema changes', () => {
    const oldKey = [{ AttributeName: 'pk', KeyType: 'HASH' }];
    const newKey = [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ];
    expect(registry.requiresReplacement(TYPE, 'KeySchema', oldKey, newKey)).toBe(true);
  });

  it('treats GlobalSecondaryIndexes changes as in-place (not replacement)', () => {
    expect(registry.requiresReplacement(TYPE, 'GlobalSecondaryIndexes', [], [{}])).toBe(false);
  });
});

describe('attributeTypeChangedForSharedAttribute', () => {
  it('returns false for add-only and remove-only diffs', () => {
    const a = [{ AttributeName: 'pk', AttributeType: 'S' }];
    const b = [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'gsipk', AttributeType: 'S' },
    ];
    expect(attributeTypeChangedForSharedAttribute(a, b)).toBe(false);
    expect(attributeTypeChangedForSharedAttribute(b, a)).toBe(false);
  });

  it('returns true when a shared attribute changes type', () => {
    const a = [{ AttributeName: 'pk', AttributeType: 'S' }];
    const b = [{ AttributeName: 'pk', AttributeType: 'N' }];
    expect(attributeTypeChangedForSharedAttribute(a, b)).toBe(true);
  });

  it('tolerates undefined / non-array inputs', () => {
    expect(attributeTypeChangedForSharedAttribute(undefined, undefined)).toBe(false);
    expect(attributeTypeChangedForSharedAttribute(null, [{ AttributeName: 'x' }])).toBe(false);
  });
});

/**
 * go-to-k/cdkd#5489: CloudFormation REPLACES a GlobalTable whose declared
 * `LocalSecondaryIndexes` list is removed, and fails the update in place for
 * an added one (CFn A/B, us-east-1 + us-west-2, 2026-10-28).
 */
describe('ReplacementRulesRegistry — DynamoDB GlobalTable LocalSecondaryIndexes', () => {
  const registry = new ReplacementRulesRegistry();
  const GT = 'AWS::DynamoDB::GlobalTable';
  const lsi = [
    {
      IndexName: 'lsi1',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'lsk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'KEYS_ONLY' },
    },
  ];
  const lsi2 = [{ ...lsi[0], IndexName: 'lsi2' }];

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
  ])('replaces when a declared list becomes %s', (_label, next) => {
    expect(registry.requiresReplacement(GT, 'LocalSecondaryIndexes', lsi, next)).toBe(true);
  });

  it.each([
    ['added to a table without one', undefined, lsi],
    ['added over an empty list', [], lsi],
    ['changed', lsi, lsi2],
    ['absent to empty', undefined, []],
  ])('stays an update (refused by the provider) when the list is %s', (_label, prev, next) => {
    expect(registry.requiresReplacement(GT, 'LocalSecondaryIndexes', prev, next)).toBe(false);
    expect(globalTableLocalSecondaryIndexesRemoved(prev, next)).toBe(false);
  });

  it("leaves TableName to the schema's createOnly fallback", () => {
    expect(registry.isClassified(GT, 'TableName')).toBe(false);
    expect(registry.isClassified(GT, 'LocalSecondaryIndexes')).toBe(true);
  });
});
