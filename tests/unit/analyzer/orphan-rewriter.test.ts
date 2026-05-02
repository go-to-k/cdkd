import { describe, it, expect, vi } from 'vitest';
import { rewriteResourceReferences } from '../../../src/analyzer/orphan-rewriter.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Build a stub ProviderRegistry that resolves every resource type to a
 * provider whose `getAttribute` is the supplied function (or returns a
 * fixed value).
 */
function fakeRegistry(
  getAttribute?: ResourceProvider['getAttribute']
): ProviderRegistry {
  const provider: Partial<ResourceProvider> = {
    ...(getAttribute && { getAttribute }),
  };
  return {
    getProvider: vi.fn(() => provider as ResourceProvider),
  } as unknown as ProviderRegistry;
}

function baseState(resources: StackState['resources'], outputs: Record<string, unknown> = {}): StackState {
  return {
    version: 2,
    stackName: 'TestStack',
    region: 'us-east-1',
    resources,
    outputs,
    lastModified: 0,
  };
}

describe('rewriteResourceReferences', () => {
  it('rewrites a {Ref: orphan} into the orphan physicalId', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: { Ref: 'Bucket' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Bucket']).toBeUndefined();
    expect(result.state.resources['Other']?.properties).toEqual({ BucketName: 'b-phys' });
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]).toMatchObject({
      logicalId: 'Other',
      kind: 'ref',
      orphanLogicalId: 'Bucket',
      after: 'b-phys',
    });
  });

  it('rewrites array-form Fn::GetAtt via live provider call', async () => {
    const getAttribute = vi.fn(async (_p: string, _t: string, attr: string) =>
      attr === 'Arn' ? 'arn:aws:s3:::b-phys' : undefined
    );
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::Lambda::Function',
        properties: { Env: { Bucket: { 'Fn::GetAtt': ['Bucket', 'Arn'] } } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(getAttribute).toHaveBeenCalledWith('b-phys', 'AWS::S3::Bucket', 'Arn');
    expect(result.state.resources['Other']?.properties).toEqual({
      Env: { Bucket: 'arn:aws:s3:::b-phys' },
    });
    expect(result.unresolvable).toEqual([]);
  });

  it('rewrites string-form Fn::GetAtt ("Logical.Attr")', async () => {
    const getAttribute = vi.fn(async () => 'arn:aws:iam::role/r');
    const state = baseState({
      Role: { physicalId: 'r', resourceType: 'AWS::IAM::Role', properties: {} },
      User: {
        physicalId: 'u',
        resourceType: 'AWS::IAM::User',
        properties: { ManagedPolicyArns: [{ 'Fn::GetAtt': 'Role.Arn' }] },
      },
    });

    const result = await rewriteResourceReferences(state, ['Role'], fakeRegistry(getAttribute));

    expect(result.state.resources['User']?.properties).toEqual({
      ManagedPolicyArns: ['arn:aws:iam::role/r'],
    });
  });

  it('substitutes ${O} and ${O.attr} placeholders inside Fn::Sub, preserving unrelated placeholders', async () => {
    const getAttribute = vi.fn(async (_p, _t, attr: string) =>
      attr === 'Arn' ? 'arn:aws:s3:::b-phys' : undefined
    );
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Fn: {
        physicalId: 'f',
        resourceType: 'AWS::Lambda::Function',
        properties: {
          Env: {
            'Fn::Sub': 'arn=${Bucket.Arn};name=${Bucket};region=${AWS::Region};other=${Other}',
          },
        },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    const env = (result.state.resources['Fn']?.properties as { Env: unknown })['Env'];
    // Has a non-orphan placeholder (${AWS::Region}, ${Other}) so wrapper preserved.
    expect(env).toEqual({
      'Fn::Sub': 'arn=arn:aws:s3:::b-phys;name=b-phys;region=${AWS::Region};other=${Other}',
    });
  });

  it('drops dependency-array entries that match an orphan', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Fn: {
        physicalId: 'f',
        resourceType: 'AWS::Lambda::Function',
        properties: {},
        dependencies: ['Bucket', 'OtherDep'],
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Fn']?.dependencies).toEqual(['OtherDep']);
    expect(result.rewrites.find((r) => r.kind === 'dependency')).toMatchObject({
      logicalId: 'Fn',
      path: 'dependencies',
      before: 'Bucket',
      after: null,
    });
  });

  it('handles multi-orphan circular references in one pass (resolves against pre-orphan snapshot)', async () => {
    // Orphan A references orphan B's attribute, AND vice versa.
    const getAttribute = vi.fn(async (_p, _t, attr: string) => `attr=${attr}`);
    const state = baseState({
      A: {
        physicalId: 'a',
        resourceType: 'AWS::S3::Bucket',
        properties: { Friend: { 'Fn::GetAtt': ['B', 'Arn'] } },
      },
      B: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: { Friend: { 'Fn::GetAtt': ['A', 'Arn'] } },
      },
      Bystander: {
        physicalId: 'c',
        resourceType: 'AWS::S3::Bucket',
        properties: { A: { Ref: 'A' }, B: { Ref: 'B' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['A', 'B'], fakeRegistry(getAttribute));

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Bystander']?.properties).toEqual({ A: 'a', B: 'b' });
    expect(result.state.resources['A']).toBeUndefined();
    expect(result.state.resources['B']).toBeUndefined();
  });

  it('reports an unresolvable reference when the provider has no getAttribute', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(undefined));

    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]).toMatchObject({
      logicalId: 'Other',
      orphanLogicalId: 'Bucket',
      attribute: 'Arn',
    });
    // Original intrinsic preserved.
    expect(result.state.resources['Other']?.properties).toEqual({
      Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
    });
  });

  it('reports unresolvable on provider error too (not just missing impl)', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('AWS API failure');
    });
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]?.reason).toMatch(/AWS API failure/);
  });

  it('--force falls back to state.attributes cache when live fetch fails', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Bucket: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: { Arn: 'arn:aws:s3:::b-cached' },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(
      state,
      ['Bucket'],
      fakeRegistry(getAttribute),
      { force: true }
    );

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({ Arn: 'arn:aws:s3:::b-cached' });
  });

  it('--force leaves the original intrinsic when both live and cache fail', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Bucket: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(
      state,
      ['Bucket'],
      fakeRegistry(getAttribute),
      { force: true }
    );

    expect(result.unresolvable).toHaveLength(1);
    // Original intrinsic preserved verbatim.
    expect(result.state.resources['Other']?.properties).toEqual({
      Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
    });
  });

  it('memoizes provider.getAttribute calls per (orphan, attr)', async () => {
    const getAttribute = vi.fn(async () => 'arn:aws:s3:::b');
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      A: {
        physicalId: 'a',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
      B: {
        physicalId: 'b2',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(getAttribute).toHaveBeenCalledTimes(1);
  });

  it('does NOT touch references to non-orphan resources', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      KeepThisRef: { physicalId: 'k', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: {
          Drop: { Ref: 'Bucket' },
          Keep: { Ref: 'KeepThisRef' },
        },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({
      Drop: 'b',
      Keep: { Ref: 'KeepThisRef' },
    });
  });

  it('rewrites references in outputs', async () => {
    const getAttribute = vi.fn(async () => 'arn');
    const state = baseState(
      {
        Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      },
      { BucketArn: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, BucketName: { Ref: 'Bucket' } }
    );

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(result.state.outputs).toEqual({ BucketArn: 'arn', BucketName: 'b' });
  });

  it('preserves original input (does not mutate)', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: { Name: { Ref: 'Bucket' } },
      },
    });
    const beforeJson = JSON.stringify(state);

    await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(JSON.stringify(state)).toBe(beforeJson);
  });

  it('throws when an orphan logicalId does not exist in state', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
    });

    await expect(
      rewriteResourceReferences(state, ['DoesNotExist'], fakeRegistry())
    ).rejects.toThrow(/orphan 'DoesNotExist' not found/);
  });

  it('Fn::Sub collapses to a plain string when no placeholders remain', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: { Url: { 'Fn::Sub': 'http://${Bucket}/path' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({ Url: 'http://b/path' });
  });
});
