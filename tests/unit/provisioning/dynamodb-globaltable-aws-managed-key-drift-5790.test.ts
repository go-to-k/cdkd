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

const templateBag = (
  sse: Record<string, unknown> = { SSEEnabled: true, SSEType: 'KMS' }
): { TableName: string; SSESpecification: Record<string, unknown>; Replicas: Record<string, unknown>[] } => ({
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

  it('asks nothing and returns both inputs by identity off the AWS managed key', async () => {
    for (const baseline of [
      templateBag({ SSEEnabled: false }),
      templateBag({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: 'alias/mine' }),
      { TableName: 'T', Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] },
    ]) {
      const aws = readback();
      const paired = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
      expect(paired.baseline).toBe(baseline);
      expect(paired.aws).toBe(aws);
    }
    expect(kmsSend).not.toHaveBeenCalled();
  });

  it('asks KMS nothing when every baseline replica already names its key', async () => {
    const declared = templateBag();
    declared.Replicas = [
      { Region: 'us-east-1', SSESpecification: { KMSMasterKeyId: AWS_KEY_EAST } },
      { Region: 'eu-west-1', SSESpecification: { KMSMasterKeyId: AWS_KEY_WEST } },
    ];
    const paired = await provider.canonicalizeDriftPair(TYPE, declared, readback());
    expect(paired.baseline).toBe(declared);
    expect(kmsSend).not.toHaveBeenCalled();
  });

  it('a mixed table (one replica on a customer managed key) completes nothing', async () => {
    const declared = templateBag();
    declared.Replicas[1] = { Region: 'eu-west-1', SSESpecification: { KMSMasterKeyId: CMK_WEST } };
    // The local replica alone lacks a key, but the table is not wholly on the
    // AWS managed key: drift shows it, and `--revert` keeps re-sending it.
    expect(await driftPaths(declared, readback(CMK_WEST))).toEqual(['Replicas']);
    const paired = await provider.canonicalizeDriftPair(TYPE, declared, readback(CMK_WEST));
    expect(paired.baseline).toBe(declared);
  });

  it('accepts an omitted SSEType (KMS is its only value)', async () => {
    // The top level differs on its own (`SSEType`); the replicas no longer do.
    expect(await driftPaths(templateBag({ SSEEnabled: true }), readback())).not.toContain('Replicas');
  });

  it('asks KMS once per key and per region client, also for concurrent drifts', async () => {
    await Promise.all([
      provider.canonicalizeDriftPair(TYPE, templateBag(), readback()),
      provider.canonicalizeDriftPair(TYPE, templateBag(), readback()),
    ]);
    expect(kmsSend).toHaveBeenCalledTimes(2);
  });

  it('reads a key in its own partition region', async () => {
    const cn = 'arn:aws-cn:kms:cn-north-1:123456789012:key/aws-managed-cn';
    const gov = 'arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/aws-managed-gov';
    managers[cn] = 'AWS';
    managers[gov] = 'AWS';
    const aws = {
      TableName: 'T',
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      Replicas: [
        { Region: 'us-east-1', SSESpecification: { KMSMasterKeyId: cn } },
        { Region: 'eu-west-1', SSESpecification: { KMSMasterKeyId: gov } },
      ],
    };
    expect(await driftPaths(templateBag(), aws)).toEqual([]);
    expect(kmsSend.mock.calls.map(([region]) => region).sort()).toEqual([
      'cn-north-1',
      'us-gov-west-1',
    ]);
  });
});
