/**
 * go-to-k/cdkd#4852: the replacement CEILING of a read-provenance promotion on
 * a create-only property the schema also lists WRITE-ONLY. As for a replaced
 * upstream (go-to-k/cdkd#4701), only a PLAIN reference to the upstream raises
 * it; any other shape keeps the write-only exclusion.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn((command: { input?: { TypeName?: string } }) =>
        command.input?.TypeName === 'AWS::DataSync::LocationS3'
          ? Promise.resolve({
              Schema: JSON.stringify({
                createOnlyProperties: ['/properties/S3BucketArn', '/properties/Subdirectory'],
                writeOnlyProperties: ['/properties/S3BucketArn'],
              }),
            })
          : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
      ),
    },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:bucket::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const ARN = `arn:aws:s3:::${REF}`;

async function ceilingOf(readerValue: unknown): Promise<boolean | undefined> {
  const state = {
    version: 12,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      Bucket: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: REF },
        attributes: { Arn: ARN },
        dependencies: [],
        referenceProvenance: { [REF]: { region: 'us-east-1', versions: [V2] } },
      },
      Location: {
        physicalId: 'loc',
        resourceType: 'AWS::DataSync::LocationS3',
        properties: { S3BucketArn: ARN },
        attributes: {},
        dependencies: ['Bucket'],
        referenceProvenance: {
          [REF]: { region: 'us-east-1', versions: [V1], readVersions: [V1] },
        },
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const template: CloudFormationTemplate = {
    Resources: {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: REF } },
      Location: { Type: 'AWS::DataSync::LocationS3', Properties: { S3BucketArn: readerValue } },
    },
  };
  const changes = await new DiffCalculator().calculateDiff(state, template, async (value) =>
    value !== null && typeof value === 'object' ? ARN : value
  );
  const change = changes.get('Location');
  expect(change?.changeType).toBe('UPDATE');
  return change?.propertyChanges?.find((pc) => pc.path === 'S3BucketArn')?.requiresReplacement;
}

describe('a write-only create-only read-derived leaf (#4852 with #4701)', () => {
  it('a plain Fn::GetAtt of the upstream raises the replacement ceiling', async () => {
    expect(await ceilingOf({ 'Fn::GetAtt': ['Bucket', 'Arn'] })).toBe(true);
  });

  it('any other shape keeps the write-only exclusion (an in-place ceiling)', async () => {
    expect(await ceilingOf({ 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }]] })).toBe(
      false
    );
  });
});
