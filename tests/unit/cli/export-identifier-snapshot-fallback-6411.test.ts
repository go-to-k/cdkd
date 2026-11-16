import { describe, it, expect } from 'vite-plus/test';
import { buildImportPlan, fetchPrimaryIdentifier } from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6411: when DescribeType returns no usable schema (AWS
// Emulator's registry lacks many types), the export's identifier lookup falls
// back to cdkd's committed schema snapshot before refusing.

/** A CloudFormation client whose DescribeType knows no type, as the emulator answers. */
function registryWithoutSchemas(): AwsClients['cloudFormation'] {
  return {
    async send() {
      throw Object.assign(new Error('Type not found'), { name: 'TypeNotFoundException' });
    },
  } as unknown as AwsClients['cloudFormation'];
}

function stateWith(
  resources: Record<
    string,
    { resourceType: string; physicalId: string; properties?: Record<string, unknown> }
  >
): StackState {
  const out: StackState['resources'] = {};
  for (const [logicalId, r] of Object.entries(resources)) {
    out[logicalId] = {
      physicalId: r.physicalId,
      resourceType: r.resourceType,
      properties: r.properties ?? {},
      attributes: {},
      dependencies: [],
    };
  }
  return {
    version: 8,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: out,
    outputs: {},
    lastModified: 0,
  };
}

describe('fetchPrimaryIdentifier falls back to the schema snapshot (go-to-k/cdkd#6411)', () => {
  it('answers a single-field type the hand-kept table lacks', async () => {
    const entry = await fetchPrimaryIdentifier('AWS::S3::BucketPolicy', registryWithoutSchemas());
    expect(entry).toEqual({ fields: ['Bucket'], importSupport: 'unknown' });
  });

  it('answers a composite type with every schema field', async () => {
    const entry = await fetchPrimaryIdentifier(
      'AWS::ApiGatewayV2::Stage',
      registryWithoutSchemas()
    );
    expect([...entry.fields].sort()).toEqual(['ApiId', 'StageName']);
    expect(entry.importSupport).toBe('unknown');
  });

  it('still prefers the hand-kept table', async () => {
    const entry = await fetchPrimaryIdentifier('AWS::SQS::Queue', registryWithoutSchemas());
    expect(entry.fields).toEqual(['QueueUrl']);
  });

  it('refuses a type the snapshot does not hold, without asking for a source edit', async () => {
    const message = await fetchPrimaryIdentifier('AWS::Nope::Thing', registryWithoutSchemas()).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message
    );
    expect(message).toContain('primary identifier unknown');
    expect(message).not.toContain('PRIMARY_IDENTIFIER_FALLBACK');
  });
});

describe('buildImportPlan with no registry schemas (go-to-k/cdkd#6411)', () => {
  it('plans the types the local-aws-emulator fixture was blocked on', async () => {
    const state = stateWith({
      Policy: { resourceType: 'AWS::S3::BucketPolicy', physicalId: 'my-bucket' },
      Stage: {
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: '$default',
        properties: { ApiId: 'api123', StageName: '$default' },
      },
    });
    const template = {
      Resources: {
        Policy: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: 'my-bucket' } },
        Stage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: { ApiId: 'api123', StageName: '$default' },
        },
      },
    };
    const plan = await buildImportPlan(state, template, registryWithoutSchemas(), 'MyStack');
    expect(plan.blocked).toEqual([]);
    const ids = Object.fromEntries(
      plan.phase1Imports.map((r) => [r.logicalId, r.resourceIdentifier])
    );
    expect(ids).toEqual({
      Policy: { Bucket: 'my-bucket' },
      Stage: { ApiId: 'api123', StageName: '$default' },
    });
  });
});
