import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Control the CFn-schema createOnly resolver so the diff fallback is exercised
// without any AWS call.
const mockGetCreateOnly = vi.fn();
vi.mock('../../../src/provisioning/create-only-properties.js', () => ({
  getTopLevelCreateOnlyProperties: (resourceType: string) => mockGetCreateOnly(resourceType),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const baseState = (): StackState => ({
  version: 1,
  stackName: 'TestStack',
  resources: {},
  outputs: {},
  lastModified: 0,
});

/**
 * CFn-schema `createOnlyProperties` fallback for replacement detection.
 * The hand-authored ReplacementRulesRegistry covers ~25 types; for every other
 * type an immutable (createOnly) property change was previously mis-classified
 * as an in-place UPDATE. The diff now consults the type's CFn registry schema
 * for any property the registry does not explicitly classify.
 */
describe('DiffCalculator - createOnly replacement fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCreateOnly.mockResolvedValue(new Set<string>());
  });

  it('marks a createOnly property change on an UNREGISTERED type as requiring replacement', async () => {
    // AWS::EFS::FileSystem has no ReplacementRulesRegistry rule; PerformanceMode
    // is createOnly per the CFn schema.
    mockGetCreateOnly.mockResolvedValue(new Set(['PerformanceMode']));

    const state = baseState();
    state.resources['Fs'] = {
      physicalId: 'fs-123',
      resourceType: 'AWS::EFS::FileSystem',
      properties: { PerformanceMode: 'maxIO' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fs: { Type: 'AWS::EFS::FileSystem', Properties: { PerformanceMode: 'generalPurpose' } },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const change = changes.get('Fs');
    expect(change?.changeType).toBe('UPDATE');
    const pc = change?.propertyChanges?.find((c) => c.path === 'PerformanceMode');
    expect(pc?.requiresReplacement).toBe(true);
    expect(mockGetCreateOnly).toHaveBeenCalledWith('AWS::EFS::FileSystem');
  });

  it('does NOT mark a non-createOnly change as replacement (mutable property)', async () => {
    // ThroughputMode is mutable (not in createOnly); only PerformanceMode is.
    mockGetCreateOnly.mockResolvedValue(new Set(['PerformanceMode']));

    const state = baseState();
    state.resources['Fs'] = {
      physicalId: 'fs-123',
      resourceType: 'AWS::EFS::FileSystem',
      properties: { ThroughputMode: 'bursting' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fs: { Type: 'AWS::EFS::FileSystem', Properties: { ThroughputMode: 'elastic' } },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const pc = changes.get('Fs')?.propertyChanges?.find((c) => c.path === 'ThroughputMode');
    expect(pc?.requiresReplacement).toBe(false);
  });

  it('does NOT override an EXPLICIT updateable classification, even if the schema lists it createOnly', async () => {
    // S3::Bucket has a registry rule; the schema fallback must not flip an
    // explicitly-updateable property to replacement. (Contrived: pretend the
    // schema reports an S3 updateable prop as createOnly — the registry wins.)
    const state = baseState();
    state.resources['Bucket'] = {
      physicalId: 'my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { VersioningConfiguration: { Status: 'Enabled' } },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { VersioningConfiguration: { Status: 'Suspended' } },
        },
      },
    };
    mockGetCreateOnly.mockResolvedValue(new Set(['VersioningConfiguration']));

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const pc = changes
      .get('Bucket')
      ?.propertyChanges?.find((c) => c.path === 'VersioningConfiguration');
    expect(pc?.requiresReplacement).toBe(false);
    // The fallback must NOT even be consulted for an explicitly-classified prop.
    expect(mockGetCreateOnly).not.toHaveBeenCalled();
  });

  it('uses the registry replacementProperties (no schema call) for a registered immutable prop', async () => {
    // S3::Bucket.BucketName is in the registry's replacementProperties.
    const state = baseState();
    state.resources['Bucket'] = {
      physicalId: 'old-name',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'old-name' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'new-name' } },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const pc = changes.get('Bucket')?.propertyChanges?.find((c) => c.path === 'BucketName');
    expect(pc?.requiresReplacement).toBe(true);
    // Registry already classified BucketName -> the schema fallback is skipped.
    expect(mockGetCreateOnly).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the schema lookup yields an empty set (no replacement)', async () => {
    // DescribeType failure surfaces as an empty set from the helper.
    mockGetCreateOnly.mockResolvedValue(new Set<string>());

    const state = baseState();
    state.resources['Fs'] = {
      physicalId: 'fs-123',
      resourceType: 'AWS::EFS::FileSystem',
      properties: { PerformanceMode: 'maxIO' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fs: { Type: 'AWS::EFS::FileSystem', Properties: { PerformanceMode: 'generalPurpose' } },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const pc = changes.get('Fs')?.propertyChanges?.find((c) => c.path === 'PerformanceMode');
    // Still an UPDATE, but no replacement (the pre-fix behavior on lookup failure).
    expect(changes.get('Fs')?.changeType).toBe('UPDATE');
    expect(pc?.requiresReplacement).toBe(false);
  });
});
