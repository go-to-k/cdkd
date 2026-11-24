/**
 * go-to-k/cdkd#6363: `AWS::DynamoDB::GlobalTable`'s immutable-property guards
 * advise `cdkd deploy --replace --force-stateful-recreation`, but the deploy
 * engine turns an update failure into a replacement under `--replace` ONLY for
 * a `ResourceUpdateNotSupportedError` (`update-in-place.ts`). The guards threw
 * a plain `ProvisioningError`, so re-running the printed command failed with
 * the identical refusal. Measured live: a `TableV2` sort-key addition, refused
 * twice in a row.
 *
 * Its own file because the provider's client comes from `getAwsClients()`,
 * which has to be mocked at module scope. Every refusal fires before the first
 * `send`, which the mock enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: async () => 'us-east-1' } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'orders';
const PK = [{ AttributeName: 'pk', KeyType: 'HASH' }];
const PK_SK = [...PK, { AttributeName: 'sk', KeyType: 'RANGE' }];
const ATTR_PK = [{ AttributeName: 'pk', AttributeType: 'S' }];
const ATTR_PK_SK = [...ATTR_PK, { AttributeName: 'sk', AttributeType: 'S' }];
const LSI = [
  {
    IndexName: 'by-sk',
    KeySchema: PK_SK,
    Projection: { ProjectionType: 'ALL' },
  },
];

const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
  ...extra,
});

const cases: Array<{
  guard: string;
  says: RegExp;
  desired: Record<string, unknown>;
  previous: Record<string, unknown>;
}> = [
  {
    guard: 'TableName',
    says: /TableName is immutable on AWS::DynamoDB::GlobalTable/,
    desired: base({ TableName: 'renamed', KeySchema: PK, AttributeDefinitions: ATTR_PK }),
    previous: base({ KeySchema: PK, AttributeDefinitions: ATTR_PK }),
  },
  {
    guard: 'KeySchema',
    says: /KeySchema is immutable on AWS::DynamoDB::GlobalTable/,
    desired: base({ KeySchema: PK_SK, AttributeDefinitions: ATTR_PK_SK }),
    previous: base({ KeySchema: PK, AttributeDefinitions: ATTR_PK }),
  },
  {
    guard: 'LocalSecondaryIndexes',
    says: /LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable/,
    desired: base({
      KeySchema: PK_SK,
      AttributeDefinitions: ATTR_PK_SK,
      LocalSecondaryIndexes: LSI,
    }),
    previous: base({ KeySchema: PK_SK, AttributeDefinitions: ATTR_PK_SK }),
  },
];

describe('GlobalTable immutable-property refusals are the typed error --replace acts on (#6363)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockRejectedValue(new Error('the refusal must fire before any AWS call'));
  });

  for (const c of cases) {
    it(`${c.guard}: throws ResourceUpdateNotSupportedError, keeping its message and remedy`, async () => {
      const provider = new DynamoDBGlobalTableProvider();
      const error = await provider
        .update('Table', TABLE, TYPE, c.desired, c.previous)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(error).not.toBeInstanceOf(ProvisioningError);
      const typed = error as ResourceUpdateNotSupportedError;
      expect(typed.resourceType).toBe(TYPE);
      expect(typed.logicalId).toBe('Table');
      expect(typed.message).toMatch(c.says);
      // The remedy the refusal prints is the one the typed error now honours.
      expect(typed.message).toContain('--replace --force-stateful-recreation');
      expect(mockSend).not.toHaveBeenCalled();
    });
  }

  it('AttributeDefinitions removal a key still references stays a plain ProvisioningError', async () => {
    // An INVALID template (CreateTable rejects it too): the typed error would
    // let --replace delete the table and then fail the re-create.
    const provider = new DynamoDBGlobalTableProvider();
    const error = await provider
      .update(
        'Table',
        TABLE,
        TYPE,
        base({ KeySchema: PK_SK, AttributeDefinitions: ATTR_PK }),
        base({ KeySchema: PK_SK, AttributeDefinitions: ATTR_PK_SK })
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toMatch(
      /AttributeDefinitions removals are immutable .*key schema still references/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
