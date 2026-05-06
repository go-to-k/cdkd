import { describe, it, expect } from 'vitest';
import {
  stripCcApiAwsManagedFields,
  STRIPPED_FIELDS_FOR_TEST,
} from '../../../src/analyzer/cc-api-strip.js';

describe('stripCcApiAwsManagedFields', () => {
  it('removes top-level CreationDate / LastModifiedTime / OwnerId', () => {
    const input = {
      BucketName: 'b',
      CreationDate: '2024-01-01T00:00:00Z',
      LastModifiedTime: '2024-06-01T00:00:00Z',
      OwnerId: '123456789012',
    };
    expect(stripCcApiAwsManagedFields('AWS::S3::Bucket', input)).toEqual({ BucketName: 'b' });
  });

  it('walks recursively into nested objects', () => {
    const input = {
      LoggingConfiguration: {
        LogGroupName: '/aws/foo',
        LastModifiedTime: '2024-06-01T00:00:00Z',
      },
      Other: { CreationTime: '2024-01-01T00:00:00Z', Keep: 1 },
    };
    expect(stripCcApiAwsManagedFields('AWS::S3::Bucket', input)).toEqual({
      LoggingConfiguration: { LogGroupName: '/aws/foo' },
      Other: { Keep: 1 },
    });
  });

  it('walks into array elements', () => {
    const input = {
      Listeners: [
        { Port: 80, CreatedAt: '2024-01-01T00:00:00Z' },
        { Port: 443, CreatedAt: '2024-01-01T00:00:00Z' },
      ],
    };
    expect(stripCcApiAwsManagedFields('AWS::ELBv2::LoadBalancer', input)).toEqual({
      Listeners: [{ Port: 80 }, { Port: 443 }],
    });
  });

  it('preserves all non-stripped fields verbatim', () => {
    const input = {
      Name: 'thing',
      Description: 'desc',
      Properties: { Key: 'v', Nested: { Deep: 1 } },
      Tags: [{ Key: 'env', Value: 'prod' }],
      Arn: 'arn:aws:foo:::bar',
    };
    expect(stripCcApiAwsManagedFields('AWS::Foo::Bar', input)).toEqual(input);
  });

  it('does not mutate the input object', () => {
    const input = {
      BucketName: 'b',
      CreationDate: '2024-01-01T00:00:00Z',
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    stripCcApiAwsManagedFields('AWS::S3::Bucket', input);
    expect(input).toEqual(snapshot);
  });

  it('handles null / undefined / scalar values gracefully', () => {
    expect(stripCcApiAwsManagedFields('AWS::Foo::Bar', { x: null, y: undefined, z: 1 })).toEqual({
      x: null,
      y: undefined,
      z: 1,
    });
  });

  it('keeps the Arn field (settable property in many CFn types)', () => {
    // Arn is intentionally NOT in the strip list — many resources accept
    // it as input on create and cdkd state may legitimately record it
    // for drift purposes. See cc-api-strip.ts inline comment.
    expect(STRIPPED_FIELDS_FOR_TEST.has('Arn')).toBe(false);
  });

  it('strip list contains the expected timestamp / owner cluster', () => {
    // Anchor a few high-traffic strips so a future refactor that
    // accidentally drops one of them fails loudly. NOT exhaustive —
    // the strip list is allowed to grow without test churn.
    for (const f of [
      'CreationDate',
      'CreationTime',
      'LastModifiedTime',
      'LastModified',
      'OwnerId',
      'RevisionId',
    ]) {
      expect(STRIPPED_FIELDS_FOR_TEST.has(f), `expected '${f}' in strip list`).toBe(true);
    }
  });

  it('keeps Status / State name-collision-prone fields (settable in some CFn types)', () => {
    // `Status` is a settable nested input on several CFn types
    // (`ManagedScaling.Status`, `VersioningConfiguration.Status`).
    // Stripping it globally would cause false-positive drift on
    // legitimate user-managed values. The deny-list / SDK provider
    // path handles per-type runtime-`Status` cases.
    expect(STRIPPED_FIELDS_FOR_TEST.has('Status')).toBe(false);
    expect(STRIPPED_FIELDS_FOR_TEST.has('State')).toBe(false);
    expect(STRIPPED_FIELDS_FOR_TEST.has('StateReason')).toBe(false);
  });

  it('returns a fresh object (caller can mutate the result safely)', () => {
    const input = { a: 1, b: { c: 2 } };
    const result = stripCcApiAwsManagedFields('AWS::Foo::Bar', input);
    expect(result).not.toBe(input);
    expect(result['b']).not.toBe(input.b);
  });
});
