import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5790: a GlobalTable on the AWS managed key declares only the
 * top-level `SSESpecification` (`SSEEnabled: true`, `SSEType: 'KMS'`), while
 * the read-back names each replica's key ARN. A template-bag baseline takes
 * the live replica key only when KMS reports it AWS managed.
 */

const { kmsSend } = vi.hoisted(() => ({ kmsSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: vi.fn(),
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-kms', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kms')>('@aws-sdk/client-kms');
  return {
    ...actual,
    KMSClient: vi.fn().mockImplementation((cfg: { region?: string }) => ({
      send: (cmd: unknown) => kmsSend(cfg.region, cmd),
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DescribeKeyCommand } from '@aws-sdk/client-kms';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const AWS_KEY_EAST = 'arn:aws:kms:us-east-1:123456789012:key/aws-managed-east';
const AWS_KEY_WEST = 'arn:aws:kms:eu-west-1:123456789012:key/aws-managed-west';
const CMK_WEST = 'arn:aws:kms:eu-west-1:123456789012:key/customer-west';

const managers: Record<string, string> = {
  [AWS_KEY_EAST]: 'AWS',
  [AWS_KEY_WEST]: 'AWS',
  [CMK_WEST]: 'CUSTOMER',
};

let provider: DynamoDBGlobalTableProvider;
beforeEach(() => {
  kmsSend.mockReset();
  kmsSend.mockImplementation(async (_region: string, cmd: DescribeKeyCommand) => ({
    KeyMetadata: { KeyManager: managers[cmd.input.KeyId as string] },
  }));
  provider = new DynamoDBGlobalTableProvider();
});

const templateBag = (sse: Record<string, unknown> = { SSEEnabled: true, SSEType: 'KMS' }) => ({
  TableName: 'T',
  SSESpecification: sse,
  Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
});

const readback = (westKey = AWS_KEY_WEST) => ({
  TableName: 'T',
  SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
  Replicas: [
    { Region: 'us-east-1', SSESpecification: { KMSMasterKeyId: AWS_KEY_EAST } },
    { Region: 'eu-west-1', SSESpecification: { KMSMasterKeyId: westKey } },
  ],
});

const driftPaths = async (baseline: Record<string, unknown>, aws: Record<string, unknown>) => {
  const paired = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
  return calculateResourceDrift(paired.baseline, paired.aws, {
    unionWalkObjects: true,
    unorderedPaths: provider.getDriftUnorderedPaths(TYPE),
  }).map((d) => d.path);
};

describe('AWS managed replica keys on a template-bag baseline (go-to-k/cdkd#5790)', () => {
  it('reports no drift for a table on the AWS managed key, asking KMS in each key region', async () => {
    expect(await driftPaths(templateBag(), readback())).toEqual([]);
    expect(kmsSend.mock.calls.map(([region]) => region).sort()).toEqual(['eu-west-1', 'us-east-1']);
  });

  it('still reports a replica moved to a customer managed key', async () => {
    expect(await driftPaths(templateBag(), readback(CMK_WEST))).toEqual(['Replicas']);
  });

  it('completes nothing when KMS cannot be read', async () => {
    kmsSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect(await driftPaths(templateBag(), readback())).toEqual(['Replicas']);
  });

  it('asks nothing for a baseline not on the AWS managed key, or one naming a replica key', async () => {
    for (const baseline of [
      templateBag({ SSEEnabled: false }),
      templateBag({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: 'alias/mine' }),
      { TableName: 'T', Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] },
    ]) {
      await provider.canonicalizeDriftPair(TYPE, baseline, readback());
    }
    const declared = templateBag();
    declared.Replicas[1] = {
      Region: 'eu-west-1',
      SSESpecification: { KMSMasterKeyId: CMK_WEST },
    } as never;
    expect(await driftPaths(declared, readback())).toEqual(['Replicas']);
    expect(kmsSend.mock.calls.map(([, cmd]) => (cmd as DescribeKeyCommand).input.KeyId)).toEqual([
      AWS_KEY_EAST,
    ]);
  });
});
