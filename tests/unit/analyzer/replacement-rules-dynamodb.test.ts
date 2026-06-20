import { describe, it, expect } from 'vite-plus/test';
import {
  ReplacementRulesRegistry,
  attributeTypeChangedForSharedAttribute,
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
