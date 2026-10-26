import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// `CreateTable` goes through a dedicated client built in the shared client's
// region (issue #4639); route it to the shared double so `mockSend` sees it.
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) =>
      cfg?.region === 'us-east-1' ? getAwsClients().dynamoDB : new actual.DynamoDBClient(cfg ?? {})
    ),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TABLE_NAME = 'my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const KEY_SCHEMA = [
  { AttributeName: 'pk', KeyType: 'HASH' },
  { AttributeName: 'sk', KeyType: 'RANGE' },
];
const ATTRIBUTE_DEFINITIONS = [
  { AttributeName: 'pk', AttributeType: 'S' },
  { AttributeName: 'sk', AttributeType: 'S' },
  { AttributeName: 'lsk', AttributeType: 'S' },
];
const BASE = {
  TableName: TABLE_NAME,
  KeySchema: KEY_SCHEMA,
  AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
  BillingMode: 'PAY_PER_REQUEST',
};

const lsi = (name: string, projection: Record<string, unknown>) => ({
  IndexName: name,
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'lsk', KeyType: 'RANGE' },
  ],
  Projection: projection,
});

function primeGeneric(liveDeletionProtection?: boolean, liveLsis?: unknown[]): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          ...(liveDeletionProtection !== undefined && {
            DeletionProtectionEnabled: liveDeletionProtection,
          }),
          // A live description carries members CFn has no spelling for.
          ...(liveLsis !== undefined && {
            LocalSecondaryIndexes: liveLsis.map((l) => ({
              ...(l as object),
              IndexArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table/index/x',
              IndexSizeBytes: 0,
              ItemCount: 0,
            })),
          }),
        },
      });
    }
    return Promise.resolve({});
  });
}

const updateCalls = () =>
  mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((c): c is UpdateTableCommand => c instanceof UpdateTableCommand);
const protectionCalls = () =>
  updateCalls().filter((c) => c.input.DeletionProtectionEnabled !== undefined);
const warnings = (): string => childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('AWS::DynamoDB::Table update path (go-to-k/cdkd#5354)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new DynamoDBTableProvider();
  });

  describe('DeletionProtectionEnabled', () => {
    const cases: ReadonlyArray<{
      name: string;
      previous: unknown;
      desired: unknown;
      live: boolean;
      sent: boolean | undefined;
    }> = [
      { name: 'absent -> true turns it on', previous: undefined, desired: true, live: false, sent: true },
      { name: 'true -> false turns it off', previous: true, desired: false, live: true, sent: false },
      // CloudFormation turns protection off when the property is removed
      // (measured on #5354), so a removal sends `false`.
      { name: 'true -> removed turns it off', previous: true, desired: undefined, live: true, sent: false },
      { name: 'false -> "true" sends a boolean', previous: false, desired: 'true', live: false, sent: true },
      // Live already at the desired value: nothing to send.
      { name: 'true -> "true" sends nothing', previous: true, desired: 'true', live: true, sent: undefined },
      { name: 'unchanged true sends nothing', previous: true, desired: true, live: false, sent: undefined },
    ];

    for (const row of cases) {
      it(row.name, async () => {
        primeGeneric(row.live);
        await provider.update(
          'T',
          TABLE_NAME,
          RESOURCE_TYPE,
          { ...BASE, ...(row.desired !== undefined && { DeletionProtectionEnabled: row.desired }) },
          { ...BASE, ...(row.previous !== undefined && { DeletionProtectionEnabled: row.previous }) }
        );
        const calls = protectionCalls();
        if (row.sent === undefined) {
          expect(calls).toHaveLength(0);
        } else {
          expect(calls).toHaveLength(1);
          expect(calls[0]!.input).toEqual({
            TableName: TABLE_NAME,
            DeletionProtectionEnabled: row.sent,
          });
        }
      });
    }

    it('refuses a non-boolean value on the template path before any call', async () => {
      primeGeneric(false);
      await expect(
        provider.update(
          'T',
          TABLE_NAME,
          RESOURCE_TYPE,
          { ...BASE, DeletionProtectionEnabled: { Ref: 'Unresolved' }, Tags: [{ Key: 'a', Value: 'b' }] },
          { ...BASE, DeletionProtectionEnabled: false }
        )
      ).rejects.toThrow(/DeletionProtectionEnabled must be a boolean.*Nothing was applied/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('warns and skips a non-boolean value on a state replay', async () => {
      primeGeneric(false);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE, DeletionProtectionEnabled: 'yes' },
        { ...BASE, DeletionProtectionEnabled: false },
        { replayingState: true }
      );
      expect(protectionCalls()).toHaveLength(0);
      expect(warnings()).toContain('DeletionProtectionEnabled is not a boolean');
    });

    it('create sends a stringified boolean as a boolean', async () => {
      primeGeneric(true);
      await provider.create('T', RESOURCE_TYPE, { ...BASE, DeletionProtectionEnabled: 'True' });
      const create = mockSend.mock.calls
        .map((c) => c[0] as unknown)
        .find((c): c is CreateTableCommand => c instanceof CreateTableCommand);
      expect(create?.input.DeletionProtectionEnabled).toBe(true);
    });

    it('create refuses a non-boolean value before CreateTable', async () => {
      primeGeneric(false);
      await expect(
        provider.create('T', RESOURCE_TYPE, { ...BASE, DeletionProtectionEnabled: 'on' })
      ).rejects.toThrow(/DeletionProtectionEnabled must be a boolean.*Nothing was created/);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateTableCommand)).toBe(false);
    });
  });

  it('reads a recorded string DeletionProtectionEnabled as the boolean for drift', () => {
    expect(
      provider.canonicalizeDriftProperties(RESOURCE_TYPE, { DeletionProtectionEnabled: 'true' })
    ).toEqual({ DeletionProtectionEnabled: true });
    const readback = { DeletionProtectionEnabled: false };
    expect(provider.canonicalizeDriftProperties(RESOURCE_TYPE, readback)).toBe(readback);
  });

  describe('LocalSecondaryIndexes', () => {
    const before = [lsi('lsi1', { ProjectionType: 'KEYS_ONLY' })];
    const changes: ReadonlyArray<{ name: string; desired: unknown }> = [
      { name: 'a projection change', desired: [lsi('lsi1', { ProjectionType: 'ALL' })] },
      {
        name: 'an added index',
        desired: [...before, lsi('lsi2', { ProjectionType: 'ALL' })],
      },
      { name: 'a removed index', desired: undefined },
      { name: 'a renamed index', desired: [lsi('lsi9', { ProjectionType: 'KEYS_ONLY' })] },
    ];

    for (const row of changes) {
      it(`refuses ${row.name} before any mutating call`, async () => {
        primeGeneric(false, before);
        const run = provider.update(
          'T',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            ...BASE,
            ...(row.desired !== undefined && { LocalSecondaryIndexes: row.desired }),
            Tags: [{ Key: 'a', Value: 'b' }],
          },
          { ...BASE, LocalSecondaryIndexes: before }
        );
        await expect(run).rejects.toBeInstanceOf(ProvisioningError);
        await expect(run).rejects.toThrow(
          /LocalSecondaryIndexes changed.*Nothing was applied to the table/
        );
        // Only the DescribeTable read went out: no tag call, no UpdateTable.
        expect(mockSend.mock.calls.map((c) => c[0]?.constructor?.name)).toEqual([
          'DescribeTableCommand',
        ]);
      });
    }

    it('does not read a reordered but identical list as a change', async () => {
      const previous = [
        lsi('a', { ProjectionType: 'INCLUDE', NonKeyAttributes: ['x', 'y'] }),
        lsi('b', { ProjectionType: 'ALL' }),
      ];
      const desired = [
        {
          Projection: { ProjectionType: 'ALL' },
          IndexName: 'b',
          KeySchema: [
            { KeyType: 'HASH', AttributeName: 'pk' },
            { KeyType: 'RANGE', AttributeName: 'lsk' },
          ],
        },
        lsi('a', { NonKeyAttributes: ['y', 'x'], ProjectionType: 'INCLUDE' }),
      ];
      primeGeneric(false, previous);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE, LocalSecondaryIndexes: desired, DeletionProtectionEnabled: true },
        { ...BASE, LocalSecondaryIndexes: previous }
      );
      // The update went on to its other members.
      expect(protectionCalls()).toHaveLength(1);
    });

    it('accepts a change the live table already holds (a record the old drop left wrong)', async () => {
      const live = [lsi('lsi1', { ProjectionType: 'KEYS_ONLY' })];
      primeGeneric(false, live);
      // State says ALL (recorded by the pre-fix drop); AWS and the template say
      // KEYS_ONLY.
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE, LocalSecondaryIndexes: live },
        { ...BASE, LocalSecondaryIndexes: [lsi('lsi1', { ProjectionType: 'ALL' })] }
      );
      expect(warnings()).not.toContain('LocalSecondaryIndexes');
    });

    it('does not warn when a rollback restores the list the live table holds', async () => {
      primeGeneric(false, before);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE, LocalSecondaryIndexes: before },
        { ...BASE, LocalSecondaryIndexes: [lsi('lsi1', { ProjectionType: 'ALL' })] },
        { replayingState: true }
      );
      expect(warnings()).not.toContain('LocalSecondaryIndexes');
    });

    it('reads an empty NonKeyAttributes as an absent one', async () => {
      primeGeneric(false, before);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...BASE,
          LocalSecondaryIndexes: [lsi('lsi1', { ProjectionType: 'KEYS_ONLY', NonKeyAttributes: [] })],
        },
        { ...BASE, LocalSecondaryIndexes: before }
      );
      expect(warnings()).not.toContain('LocalSecondaryIndexes');
    });

    it('warns instead of refusing on a state replay', async () => {
      primeGeneric(false, before);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE, LocalSecondaryIndexes: [lsi('lsi1', { ProjectionType: 'ALL' })] },
        { ...BASE, LocalSecondaryIndexes: before },
        { replayingState: true }
      );
      expect(warnings()).toContain('LocalSecondaryIndexes change was not applied');
    });

    it('is classified in place, not as a replacement, matching CloudFormation', () => {
      const rules = new ReplacementRulesRegistry();
      expect(rules.isClassified(RESOURCE_TYPE, 'LocalSecondaryIndexes')).toBe(true);
      expect(
        rules.requiresReplacement(RESOURCE_TYPE, 'LocalSecondaryIndexes', before, [
          lsi('lsi1', { ProjectionType: 'ALL' }),
        ])
      ).toBe(false);
    });
  });
});
