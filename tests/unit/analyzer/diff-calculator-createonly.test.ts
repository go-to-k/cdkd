import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Control the CFn-schema createOnly resolver so the diff fallback is exercised
// without any AWS call.
const mockGetCreateOnly = vi.fn();
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    // Only the DescribeType-backed path lookup is mocked; the pure
    // createOnlyChangeRequiresReplacement comparison runs for real so the
    // path-granular semantics (issue #960) are exercised through the diff.
    getCreateOnlyPropertyPaths: (resourceType: string) => mockGetCreateOnly(resourceType),
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';
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
    mockGetCreateOnly.mockResolvedValue([]);
  });

  it('marks a createOnly property change on an UNREGISTERED type as requiring replacement', async () => {
    // AWS::EFS::FileSystem has no ReplacementRulesRegistry rule; PerformanceMode
    // is createOnly per the CFn schema.
    mockGetCreateOnly.mockResolvedValue([['PerformanceMode']]);

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
    mockGetCreateOnly.mockResolvedValue([['PerformanceMode']]);

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

  it('classifies an EC2 Volume AvailabilityZone change as a replacement even though the schema is EMPTY (#1356)', async () => {
    // The end-to-end shape of issue #1356: the AWS registry schema for
    // AWS::EC2::Volume declares NO createOnlyProperties (live-verified — the
    // empty mock below IS the real response), so the fallback finds nothing
    // and the hand-authored registry rule is the ONLY thing that can classify
    // the change. Without that rule the diff reports an in-place UPDATE and
    // AWS rejects the deploy.
    mockGetCreateOnly.mockResolvedValue([]);

    const state = baseState();
    state.resources['Vol'] = {
      physicalId: 'vol-123',
      resourceType: 'AWS::EC2::Volume',
      properties: { AvailabilityZone: 'us-east-1a', Size: 1, VolumeType: 'gp3' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Vol: {
          Type: 'AWS::EC2::Volume',
          Properties: { AvailabilityZone: 'us-east-1b', Size: 2, VolumeType: 'gp3' },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const az = changes.get('Vol')?.propertyChanges?.find((c) => c.path === 'AvailabilityZone');
    expect(az?.requiresReplacement).toBe(true);
    // The mutable sibling in the same diff stays in-place, and — being
    // explicitly classified — never reaches the (empty) schema fallback.
    const size = changes.get('Vol')?.propertyChanges?.find((c) => c.path === 'Size');
    expect(size?.requiresReplacement).toBe(false);
    expect(mockGetCreateOnly).not.toHaveBeenCalled();
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
    mockGetCreateOnly.mockResolvedValue([['VersioningConfiguration']]);

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

  it('degrades gracefully when the schema lookup yields an empty list (no replacement)', async () => {
    // DescribeType failure surfaces as an empty list from the helper.
    mockGetCreateOnly.mockResolvedValue([]);

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

  it('does NOT replace when only a NON-createOnly sub-property changes under a nested-createOnly container (issue #960, Pipes BatchSize)', async () => {
    // AWS::Pipes::Pipe: SourceParameters itself is mutable; only stream-source
    // sub-paths under it are createOnly. An SQS pipe changing BatchSize must
    // be an in-place UPDATE (CFn: "No interruption").
    mockGetCreateOnly.mockResolvedValue([
      ['Name'],
      ['Source'],
      ['SourceParameters', 'KinesisStreamParameters', 'StartingPosition'],
      ['SourceParameters', 'DynamoDBStreamParameters', 'StartingPosition'],
    ]);

    const state = baseState();
    state.resources['Pipe'] = {
      physicalId: 'my-pipe',
      resourceType: 'AWS::Pipes::Pipe',
      properties: {
        Name: 'my-pipe',
        Source: 'arn:aws:sqs:us-east-1:123:src',
        SourceParameters: { SqsQueueParameters: { BatchSize: 1 } },
      },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Pipe: {
          Type: 'AWS::Pipes::Pipe',
          Properties: {
            Name: 'my-pipe',
            Source: 'arn:aws:sqs:us-east-1:123:src',
            SourceParameters: { SqsQueueParameters: { BatchSize: 2 } },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const change = changes.get('Pipe');
    expect(change?.changeType).toBe('UPDATE');
    const pc = change?.propertyChanges?.find((c) => c.path === 'SourceParameters');
    expect(pc?.requiresReplacement).toBe(false);
  });

  it('DOES replace when the value at a nested createOnly path changes (Kinesis StartingPosition)', async () => {
    mockGetCreateOnly.mockResolvedValue([
      ['SourceParameters', 'KinesisStreamParameters', 'StartingPosition'],
    ]);

    const state = baseState();
    state.resources['Pipe'] = {
      physicalId: 'my-pipe',
      resourceType: 'AWS::Pipes::Pipe',
      properties: {
        SourceParameters: { KinesisStreamParameters: { StartingPosition: 'LATEST' } },
      },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Pipe: {
          Type: 'AWS::Pipes::Pipe',
          Properties: {
            SourceParameters: { KinesisStreamParameters: { StartingPosition: 'TRIM_HORIZON' } },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template);
    const pc = changes.get('Pipe')?.propertyChanges?.find((c) => c.path === 'SourceParameters');
    expect(pc?.requiresReplacement).toBe(true);
  });

  // Issue #2548: a nested stack CAN diff as a replacement, and replacing one
  // destroys its whole child stack, so the type must be on the stateful guard.
  // The createOnly set is read from the checked-in registry schema rather than
  // typed here, and the drop is ACCEPTED (the only way such a template deploys:
  // `StackName` is a silent drop and the type refuses the Cloud Control route),
  // so the case goes through the #2750 narrowing that keeps createOnly drops.
  describe('AWS::CloudFormation::Stack StackName (issue #2548)', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../fixtures/cfn-schemas/AWS-CloudFormation-Stack.json', import.meta.url)
        ),
        'utf8'
      )
    ) as { createOnlyProperties: string[] };
    const allowed = new Set(['AWS::CloudFormation::Stack:StackName']);

    it.each([
      ['changed', { StackName: 'old-name' }],
      ['added', {}],
    ])('a %s StackName is a replacement, and the type is guarded', async (_label, recorded) => {
      mockGetCreateOnly.mockResolvedValue(
        schema.createOnlyProperties.map((p) => p.replace(/^\/properties\//, '').split('/'))
      );
      const state = baseState();
      state.resources['Child'] = {
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/Child',
        resourceType: 'AWS::CloudFormation::Stack',
        provisionedBy: 'sdk',
        properties: { TemplateURL: 'https://example.com/child.json', ...recorded },
        attributes: {},
      };
      const template: CloudFormationTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://example.com/child.json', StackName: 'new-name' },
          },
        },
      };

      const changes = await new DiffCalculator().calculateDiff(
        state,
        template,
        undefined,
        undefined,
        allowed
      );
      const pc = changes.get('Child')?.propertyChanges?.find((c) => c.path === 'StackName');
      expect(pc?.requiresReplacement).toBe(true);
      expect(STATEFUL_TYPES.has('AWS::CloudFormation::Stack')).toBe(true);
    });
  });
});

/**
 * Issue #3769: a provider may declare that two spellings of a createOnly
 * property address the same thing (a Glue `CatalogId` absent vs the deploying
 * account's id). The hook is consulted only where the schema fallback would
 * plan a replacement, and fails closed.
 */
describe('DiffCalculator - createOnly equivalence hook (issue #3769)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCreateOnly.mockResolvedValue([['CatalogId']]);
  });

  const stateWith = (properties: Record<string, unknown>): StackState => {
    const state = baseState();
    state.resources['Tbl'] = {
      physicalId: 'db|t',
      resourceType: 'AWS::Glue::Table',
      properties,
      attributes: {},
    };
    return state;
  };
  const templateWith = (properties: Record<string, unknown>): CloudFormationTemplate => ({
    Resources: { Tbl: { Type: 'AWS::Glue::Table', Properties: properties } },
  });
  // The resolver answers AWS::AccountId; everything else passes through.
  const resolveFn = vi.fn(async (value: unknown) =>
    JSON.stringify(value) === JSON.stringify({ Ref: 'AWS::AccountId' }) ? '111111111111' : value
  );

  const diff = (equivalent: ReturnType<typeof vi.fn> | undefined, withResolver = true) =>
    new DiffCalculator().calculateDiff(
      stateWith({ DatabaseName: 'db' }),
      templateWith({ DatabaseName: 'db', CatalogId: '111111111111' }),
      withResolver ? resolveFn : undefined,
      undefined,
      undefined,
      undefined,
      equivalent as never
    );

  it('keeps a createOnly change in place when the provider calls the values equivalent', async () => {
    const equivalent = vi.fn(() => true);
    const changes = await diff(equivalent);

    const pc = changes.get('Tbl')?.propertyChanges?.find((c) => c.path === 'CatalogId');
    expect(changes.get('Tbl')?.changeType).toBe('UPDATE');
    expect(pc?.requiresReplacement).toBe(false);
    expect(equivalent).toHaveBeenCalledWith(
      'AWS::Glue::Table',
      'CatalogId',
      undefined,
      '111111111111',
      { accountId: '111111111111' }
    );
  });

  it('keeps the replacement when the provider says no, throws, or no hook is passed', async () => {
    for (const equivalent of [
      vi.fn(() => false),
      vi.fn(() => {
        throw new Error('boom');
      }),
      undefined,
    ]) {
      const changes = await diff(equivalent);
      const pc = changes.get('Tbl')?.propertyChanges?.find((c) => c.path === 'CatalogId');
      expect(pc?.requiresReplacement).toBe(true);
    }
  });

  it('hands the provider an undefined accountId when the diff has no resolver', async () => {
    const equivalent = vi.fn(() => false);
    await diff(equivalent, false);

    expect(equivalent).toHaveBeenCalledWith(
      'AWS::Glue::Table',
      'CatalogId',
      undefined,
      '111111111111',
      { accountId: undefined }
    );
  });

  it('fails closed when the account lookup throws or answers a non-string', async () => {
    for (const answer of [
      () => Promise.reject(new Error('sts down')),
      () => Promise.resolve({ Ref: 'AWS::AccountId' }),
      () => Promise.resolve(''),
    ]) {
      const equivalent = vi.fn(
        (_t: string, _k: string, _o: unknown, n: unknown, c: { accountId: string | undefined }) =>
          c.accountId !== undefined && c.accountId === n
      );
      const changes = await new DiffCalculator().calculateDiff(
        stateWith({ DatabaseName: 'db' }),
        templateWith({ DatabaseName: 'db', CatalogId: '111111111111' }),
        async (value: unknown) =>
          JSON.stringify(value) === JSON.stringify({ Ref: 'AWS::AccountId' }) ? answer() : value,
        undefined,
        undefined,
        undefined,
        equivalent as never
      );
      expect(equivalent.mock.calls[0]![4]).toEqual({ accountId: undefined });
      const pc = changes.get('Tbl')?.propertyChanges?.find((c) => c.path === 'CatalogId');
      expect(pc?.requiresReplacement).toBe(true);
    }
  });

  it('does not ask for a Cloud Control-routed record', async () => {
    const equivalent = vi.fn(() => true);
    const state = stateWith({ DatabaseName: 'db' });
    state.resources['Tbl']!.provisionedBy = 'cc-api';
    const changes = await new DiffCalculator().calculateDiff(
      state,
      templateWith({ DatabaseName: 'db', CatalogId: '111111111111' }),
      resolveFn,
      undefined,
      undefined,
      undefined,
      equivalent as never
    );

    expect(equivalent).not.toHaveBeenCalled();
    const pc = changes.get('Tbl')?.propertyChanges?.find((c) => c.path === 'CatalogId');
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('never demotes a replacement a hand-authored rule decided', async () => {
    const equivalent = vi.fn(() => true);
    const state = baseState();
    state.resources['Layer'] = {
      physicalId: 'arn:layer:1',
      resourceType: 'AWS::Lambda::LayerVersion',
      properties: { LayerName: 'a' },
      attributes: {},
    };
    const changes = await new DiffCalculator().calculateDiff(
      state,
      { Resources: { Layer: { Type: 'AWS::Lambda::LayerVersion', Properties: { LayerName: 'b' } } } },
      resolveFn,
      undefined,
      undefined,
      undefined,
      equivalent as never
    );

    expect(equivalent).not.toHaveBeenCalled();
    const pc = changes.get('Layer')?.propertyChanges?.find((c) => c.path === 'LayerName');
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('never asks about a change the schema does not call createOnly, and resolves the account once', async () => {
    mockGetCreateOnly.mockResolvedValue([['CatalogId']]);
    const equivalent = vi.fn((_t: string, _k: string, _o: unknown, _n: unknown, _c: unknown) => true);
    const state = stateWith({ DatabaseName: 'db', TableInput: { Name: 'a' } });
    state.resources['Tbl2'] = { ...state.resources['Tbl']!, physicalId: 'db|t2' };
    const template: CloudFormationTemplate = {
      Resources: {
        Tbl: {
          Type: 'AWS::Glue::Table',
          Properties: { DatabaseName: 'db', TableInput: { Name: 'b' }, CatalogId: '111111111111' },
        },
        Tbl2: {
          Type: 'AWS::Glue::Table',
          Properties: { DatabaseName: 'db', TableInput: { Name: 'a' }, CatalogId: '111111111111' },
        },
      },
    };
    resolveFn.mockClear();

    await new DiffCalculator().calculateDiff(
      state,
      template,
      resolveFn,
      undefined,
      undefined,
      undefined,
      equivalent as never
    );

    // Two CatalogId questions (one per table), none for TableInput.
    expect(equivalent).toHaveBeenCalledTimes(2);
    expect(equivalent.mock.calls.every((c) => c[1] === 'CatalogId')).toBe(true);
    const accountLookups = resolveFn.mock.calls.filter(
      (c) => JSON.stringify(c[0]) === JSON.stringify({ Ref: 'AWS::AccountId' })
    );
    expect(accountLookups).toHaveLength(1);
  });
});
