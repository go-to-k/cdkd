import { describe, it, expect } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { cfnRefValueFromPhysicalId } from '../../../src/deployment/intrinsic-resolver/ref-values.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Issue #6243 — `Ref` values measured against real CloudFormation (one template
 * deployed by cdkd and by `aws cloudformation deploy`, us-east-1, 2026-11-14)
 * that cdkd's physical id does not equal.
 */
async function resolveRef(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): Promise<unknown> {
  const template: CloudFormationTemplate = {
    Resources: { R: { Type: resourceType, Properties: {} } },
  };
  return new IntrinsicFunctionResolver().resolve(
    { Ref: 'R' },
    {
      template,
      resources: {
        R: { physicalId, resourceType, properties: {}, attributes, dependencies: [] },
      },
    }
  );
}

const TB = 'arn:aws:s3tables:us-east-1:123456789012:bucket/huntattr-35ad52db';

describe('Ref of an AWS::S3Vectors::VectorBucket (issue #6243)', () => {
  const NAME = 'stack-vecbucket-1300a6c12b83';
  const ARN = `arn:aws:s3vectors:us-east-1:123456789012:bucket/${NAME}`;

  it('returns the recorded VectorBucketArn, not the bucket-name physical id', async () => {
    expect(await resolveRef('AWS::S3Vectors::VectorBucket', NAME, { VectorBucketArn: ARN })).toBe(
      ARN
    );
  });

  it('falls back to the physical id when no ARN is recorded, never a built ARN', async () => {
    expect(await resolveRef('AWS::S3Vectors::VectorBucket', NAME)).toBe(NAME);
  });
});

describe('Ref of an AWS::AppSync::GraphQLApi (issue #6243)', () => {
  const API = 'pmc4ej3pbvhobamxss46glyj2a';
  const ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${API}`;

  it('returns the recorded Arn, not the API-id physical id', async () => {
    expect(await resolveRef('AWS::AppSync::GraphQLApi', API, { Arn: ARN, ApiId: API })).toBe(ARN);
  });

  it('does not serve a pre-#1681 placeholder ARN', async () => {
    const placeholder = `arn:aws:appsync:*:*:apis/${API}`;
    expect(await resolveRef('AWS::AppSync::GraphQLApi', API, { Arn: placeholder })).toBe(API);
  });
});

describe('Ref of an AWS::S3Tables::Namespace (issue #6243)', () => {
  it("returns the SDK provider's whole <tableBucketARN>|<namespace> composite", async () => {
    expect(await resolveRef('AWS::S3Tables::Namespace', `${TB}|huntns`)).toBe(`${TB}|huntns`);
  });

  it("reorders a Cloud Control id (<namespace>|<tableBucketARN>) into CloudFormation's order", () => {
    expect(cfnRefValueFromPhysicalId('AWS::S3Tables::Namespace', `huntns|${TB}`)).toBe(
      `${TB}|huntns`
    );
  });

  it.each([['huntns'], [`${TB}|huntns|extra`], [`|${TB}`]])(
    'passes an unrecognised id (%s) through unchanged',
    (id) => {
      expect(cfnRefValueFromPhysicalId('AWS::S3Tables::Namespace', id)).toBe(id);
    }
  );
});

describe('Ref of an AWS::EC2::VPCGatewayAttachment (issue #6243)', () => {
  it.each([
    ['igw-01e1870a6086f1ecb|vpc-0aa4cfcbafb0f55e9', 'IGW|vpc-0aa4cfcbafb0f55e9'],
    ['vgw-0123456789abcdef0|vpc-0aa4cfcbafb0f55e9', 'VGW|vpc-0aa4cfcbafb0f55e9'],
  ])('renders %s as %s', async (physicalId, expected) => {
    expect(await resolveRef('AWS::EC2::VPCGatewayAttachment', physicalId)).toBe(expected);
  });

  it.each([
    // A Cloud Control id already has CloudFormation's shape.
    ['IGW|vpc-0aa4cfcbafb0f55e9'],
    ['VGW|vpc-0aa4cfcbafb0f55e9'],
    ['igw-01e1870a6086f1ecb'],
    ['igw-01e1870a6086f1ecb|subnet-1'],
    ['tgw-0123|vpc-0aa4cfcbafb0f55e9'],
  ])('passes %s through unchanged', (id) => {
    expect(cfnRefValueFromPhysicalId('AWS::EC2::VPCGatewayAttachment', id)).toBe(id);
  });
});
