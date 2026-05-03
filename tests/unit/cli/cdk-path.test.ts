import { describe, expect, it } from 'vitest';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../../../src/cli/cdk-path.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function template(
  resources: Record<string, { Type: string; cdkPath?: string }>
): CloudFormationTemplate {
  const Resources: CloudFormationTemplate['Resources'] = {};
  for (const [logicalId, { Type, cdkPath }] of Object.entries(resources)) {
    Resources[logicalId] = {
      Type,
      ...(cdkPath !== undefined && { Metadata: { 'aws:cdk:path': cdkPath } }),
    };
  }
  return { Resources };
}

describe('buildCdkPathIndex', () => {
  it('excludes AWS::CDK::Metadata resources from the path index', () => {
    const tpl = template({
      Bucket1: { Type: 'AWS::S3::Bucket', cdkPath: 'MyStack/MyConstruct/Bucket1/Resource' },
      CDKMetadata: { Type: 'AWS::CDK::Metadata', cdkPath: 'MyStack/CDKMetadata/Default' },
    });
    const index = buildCdkPathIndex(tpl);
    expect([...index.keys()]).toEqual(['MyStack/MyConstruct/Bucket1/Resource']);
    expect(index.has('MyStack/CDKMetadata/Default')).toBe(false);
  });

  it('skips resources without an aws:cdk:path metadata entry', () => {
    const tpl = template({
      WithPath: { Type: 'AWS::S3::Bucket', cdkPath: 'MyStack/Bucket' },
      WithoutPath: { Type: 'AWS::S3::Bucket' },
    });
    const index = buildCdkPathIndex(tpl);
    expect([...index.entries()]).toEqual([['MyStack/Bucket', 'WithPath']]);
  });
});

describe('resolveCdkPathToLogicalIds', () => {
  const index = new Map<string, string>([
    ['MyStack/MyConstruct/Bucket1/Resource', 'Bucket1Resource'],
    ['MyStack/MyConstruct/Bucket2/Resource', 'Bucket2Resource'],
    ['MyStack/MyBucket', 'MyBucket'],
    ['MyStack/MyBucketBackup/Resource', 'MyBucketBackupResource'],
  ]);

  it('matches an L2 path by prefix (orphans the synthesized L1 child)', () => {
    const matches = resolveCdkPathToLogicalIds('MyStack/MyConstruct/Bucket2', index);
    expect(matches).toEqual([
      { logicalId: 'Bucket2Resource', cdkPath: 'MyStack/MyConstruct/Bucket2/Resource' },
    ]);
  });

  it('matches an exact L1 path (back-compat with full synthesized paths)', () => {
    const matches = resolveCdkPathToLogicalIds('MyStack/MyConstruct/Bucket1/Resource', index);
    expect(matches).toEqual([
      { logicalId: 'Bucket1Resource', cdkPath: 'MyStack/MyConstruct/Bucket1/Resource' },
    ]);
  });

  it('matches every child under an L2 wrapper construct', () => {
    const matches = resolveCdkPathToLogicalIds('MyStack/MyConstruct', index);
    expect(matches.map((m) => m.logicalId).sort()).toEqual(['Bucket1Resource', 'Bucket2Resource']);
  });

  it('does not partial-match a sibling whose path shares a name prefix', () => {
    // Without the trailing slash, `MyStack/MyBucket` would also match
    // `MyStack/MyBucketBackup/Resource` — the trailing slash blocks that.
    const matches = resolveCdkPathToLogicalIds('MyStack/MyBucket', index);
    expect(matches).toEqual([{ logicalId: 'MyBucket', cdkPath: 'MyStack/MyBucket' }]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(resolveCdkPathToLogicalIds('MyStack/Missing', index)).toEqual([]);
  });
});
