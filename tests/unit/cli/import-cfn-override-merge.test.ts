import { describe, it, expect } from 'vite-plus/test';

/**
 * Issue #1131: the CloudFormation-derived override filter used to be written
 * out twice (the `--migrate-from-cloudformation` root walk and the #1128
 * auto-mode lookup) and a third time in a reduced form for the recursive
 * nested-child walk. All three now route through `mergeCfnDerivedOverrides`.
 *
 * These tests pin the three filters and the user-precedence rule so a future
 * change to any one of them cannot silently regress a call site, plus the
 * documented second-order effect: seeding `overrides` from CloudFormation
 * makes `substituteOverrideRefs` pre-resolve `{Ref: <X>}` in a resource's
 * Properties. That effect is INTENDED (it is what makes sub-resource
 * providers like `SQSQueuePolicyProvider` importable under auto mode), so it
 * is pinned by a test rather than left as an undocumented side effect.
 */

import {
  mergeCfnDerivedOverrides,
  formatCfnOverrideMergeDetail,
  substituteOverrideRefs,
} from '../../../src/cli/commands/import.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function template(resources: Record<string, { Type: string }>): CloudFormationTemplate {
  return { Resources: resources } as unknown as CloudFormationTemplate;
}

describe('mergeCfnDerivedOverrides', () => {
  it('seeds every importable non-nested row not already overridden', () => {
    const overrides = new Map<string, string>();
    const stats = mergeCfnDerivedOverrides({
      cfnMapping: new Map([
        ['Bucket', 'my-bucket'],
        ['Queue', 'https://sqs/my-queue'],
      ]),
      template: template({
        Bucket: { Type: 'AWS::S3::Bucket' },
        Queue: { Type: 'AWS::SQS::Queue' },
      }),
      templateLogicalIds: new Set(['Bucket', 'Queue']),
      overrides,
    });

    expect(overrides).toEqual(
      new Map([
        ['Bucket', 'my-bucket'],
        ['Queue', 'https://sqs/my-queue'],
      ])
    );
    expect(stats).toEqual({
      derived: 2,
      skippedNonImportable: 0,
      skippedNestedStackRow: 0,
      overriddenByUser: 0,
    });
  });

  it('drops rows that are not importable template resources (e.g. CDKMetadata)', () => {
    const overrides = new Map<string, string>();
    const stats = mergeCfnDerivedOverrides({
      cfnMapping: new Map([
        ['Bucket', 'my-bucket'],
        ['CDKMetadata', 'AWS::CDK::Metadata'],
      ]),
      template: template({
        Bucket: { Type: 'AWS::S3::Bucket' },
        CDKMetadata: { Type: 'AWS::CDK::Metadata' },
      }),
      // `collectImportableResources` excludes the metadata sentinel.
      templateLogicalIds: new Set(['Bucket']),
      overrides,
    });

    expect(overrides.has('CDKMetadata')).toBe(false);
    expect(stats.derived).toBe(1);
    expect(stats.skippedNonImportable).toBe(1);
  });

  it('drops nested-stack rows so the AWS child ARN never overwrites the synth ARN', () => {
    const overrides = new Map<string, string>();
    const stats = mergeCfnDerivedOverrides({
      cfnMapping: new Map([
        ['Child', 'arn:aws:cloudformation:us-east-1:111122223333:stack/Parent-Child/abc'],
        ['Bucket', 'my-bucket'],
      ]),
      template: template({
        Child: { Type: 'AWS::CloudFormation::Stack' },
        Bucket: { Type: 'AWS::S3::Bucket' },
      }),
      templateLogicalIds: new Set(['Child', 'Bucket']),
      overrides,
    });

    expect(overrides.has('Child')).toBe(false);
    expect(stats.derived).toBe(1);
    expect(stats.skippedNestedStackRow).toBe(1);
  });

  it('never overwrites a user-supplied override', () => {
    const overrides = new Map([['Bucket', 'user-supplied-bucket']]);
    const stats = mergeCfnDerivedOverrides({
      cfnMapping: new Map([['Bucket', 'cfn-derived-bucket']]),
      template: template({ Bucket: { Type: 'AWS::S3::Bucket' } }),
      templateLogicalIds: new Set(['Bucket']),
      overrides,
    });

    expect(overrides.get('Bucket')).toBe('user-supplied-bucket');
    expect(stats).toEqual({
      derived: 0,
      skippedNonImportable: 0,
      skippedNestedStackRow: 0,
      overriddenByUser: 1,
    });
  });

  it('does not mutate the source mapping', () => {
    const cfnMapping = new Map([['Bucket', 'my-bucket']]);
    mergeCfnDerivedOverrides({
      cfnMapping,
      template: template({ Bucket: { Type: 'AWS::S3::Bucket' } }),
      templateLogicalIds: new Set(['Bucket']),
      overrides: new Map(),
    });
    expect(cfnMapping).toEqual(new Map([['Bucket', 'my-bucket']]));
  });
});

describe('formatCfnOverrideMergeDetail', () => {
  it('is empty when nothing was dropped', () => {
    expect(
      formatCfnOverrideMergeDetail({
        derived: 3,
        skippedNonImportable: 0,
        skippedNestedStackRow: 0,
        overriddenByUser: 0,
      })
    ).toBe('');
  });

  it('lists each non-zero filter in a stable order', () => {
    expect(
      formatCfnOverrideMergeDetail({
        derived: 1,
        skippedNonImportable: 2,
        skippedNestedStackRow: 3,
        overriddenByUser: 4,
      })
    ).toBe(
      ' (4 already overridden by --resource, 2 non-importable (e.g. CDKMetadata), ' +
        '3 nested-stack row(s) handled separately)'
    );
  });
});

describe('CFn-seeded overrides feed substituteOverrideRefs (issue #1131 item 2)', () => {
  it('pre-resolves {Ref: X} in Properties to the CFn-derived physical ID', () => {
    // This is the documented second-order effect of seeding `overrides` from
    // CloudFormation: it is what lets a sub-resource provider read
    // `properties.Queues[0]` as a literal queue URL instead of an intrinsic.
    const overrides = new Map<string, string>();
    mergeCfnDerivedOverrides({
      cfnMapping: new Map([['Queue', 'https://sqs.us-east-1.amazonaws.com/111122223333/q']]),
      template: template({
        Queue: { Type: 'AWS::SQS::Queue' },
        QueuePolicy: { Type: 'AWS::SQS::QueuePolicy' },
      }),
      templateLogicalIds: new Set(['Queue', 'QueuePolicy']),
      overrides,
    });

    const properties = substituteOverrideRefs({ Queues: [{ Ref: 'Queue' }] }, overrides);

    expect(properties).toEqual({
      Queues: ['https://sqs.us-east-1.amazonaws.com/111122223333/q'],
    });
  });

  it('leaves a Ref to a filtered-out row untouched for the post-import resolver', () => {
    // A nested-stack row is deliberately NOT seeded, so a Ref to it must
    // survive as an intrinsic rather than silently resolving to the AWS ARN.
    const overrides = new Map<string, string>();
    mergeCfnDerivedOverrides({
      cfnMapping: new Map([['Child', 'arn:aws:cloudformation:us-east-1:111122223333:stack/C/x']]),
      template: template({ Child: { Type: 'AWS::CloudFormation::Stack' } }),
      templateLogicalIds: new Set(['Child']),
      overrides,
    });

    expect(substituteOverrideRefs({ Target: { Ref: 'Child' } }, overrides)).toEqual({
      Target: { Ref: 'Child' },
    });
  });
});
