/**
 * Issue [#2610] sites 5-7: `AWS::DynamoDB::GlobalTable`'s three immutable
 * property guards advised `deploy with --replace`, which is wrong twice — the
 * type is in `STATEFUL_TYPES` (so the engine's replace fallback refuses it
 * again with `STATEFUL_REPLACE_BLOCKED`), and no deploy-side flag can clear
 * `DeletionProtectionEnabled`.
 *
 * Its own file because the provider's client comes from `getAwsClients()`,
 * which has to be mocked at module scope. Every assertion below is reached
 * before the first `send`, which the mock enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'MyGlobalTable';

const KEY_SCHEMA = [{ AttributeName: 'pk', KeyType: 'HASH' }];

async function refusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<string> {
  const provider = new DynamoDBGlobalTableProvider();
  try {
    await provider.update('Table', TABLE, TYPE, properties, previousProperties);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected update() to refuse, but it resolved');
}

/** The three guards, each driven by the property it is about. */
const SITES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['TableName', { TableName: 'renamed' }, { TableName: TABLE }],
  [
    'KeySchema',
    { KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }] },
    { KeySchema: KEY_SCHEMA },
  ],
  [
    'LocalSecondaryIndexes',
    { KeySchema: KEY_SCHEMA, LocalSecondaryIndexes: [{ IndexName: 'lsi2' }] },
    { KeySchema: KEY_SCHEMA, LocalSecondaryIndexes: [{ IndexName: 'lsi1' }] },
  ],
];

describe('DynamoDB GlobalTable immutable-property refusals (sites 5-7)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockRejectedValue(
      new Error('the refusal must fire before any AWS call on this path')
    );
  });

  it('is a stateful type, so every refusal must name --force-stateful-recreation', () => {
    expect(STATEFUL_TYPES.has(TYPE)).toBe(true);
  });

  for (const [label, next, prev] of SITES) {
    it(`${label}: names the deletion-protection dead end when the LOCAL replica records it`, async () => {
      const message = await refusal(next, {
        ...prev,
        Replicas: [
          { Region: 'us-east-1', DeletionProtectionEnabled: true },
          { Region: 'eu-west-1', DeletionProtectionEnabled: false },
        ],
      });
      expect(message).toContain('DeletionProtectionEnabled: true for the deploy region');
      expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
      expect(message).toContain(`--table-name '${TABLE}' --no-deletion-protection-enabled`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it(`${label}: keeps the short advice when the local replica is unprotected`, async () => {
      const message = await refusal(next, {
        ...prev,
        Replicas: [
          { Region: 'us-east-1', DeletionProtectionEnabled: false },
          // A NON-local replica carrying protection must not trip the advice:
          // the resolution is per-replica and scoped to the deploy region.
          { Region: 'eu-west-1', DeletionProtectionEnabled: true },
        ],
      });
      expect(message).toContain(
        'replacement required (deploy with cdkd deploy --replace --force-stateful-recreation'
      );
      expect(message).not.toContain('--remove-protection');
      expect(message).not.toContain('update-table');
    });
  }

  it('falls back to the TOP-LEVEL flag when the local replica declares none', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(next, { ...prev, DeletionProtectionEnabled: true });
    expect(message).toContain('DeletionProtectionEnabled: true for the deploy region');
  });

  it('keeps the short advice when nothing records protection at all', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(next, prev);
    expect(message).not.toContain('--remove-protection');
  });

  it('reads the RECORDED bag, not the desired one', async () => {
    const [, next, prev] = SITES[0]!;
    const message = await refusal(
      { ...next, Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
      { ...prev, Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] }
    );
    expect(message).not.toContain('--remove-protection');
  });
});
