import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();
// Hoisted so the create-path refusal test can read what the provider WARNED
// (the factory-local childLogger below is not reachable from a test body).
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

const KEY_SCHEMA = [{ AttributeName: 'id', KeyType: 'HASH' }];
const ATTRIBUTE_DEFINITIONS = [{ AttributeName: 'id', AttributeType: 'S' }];

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

/**
 * WarmThroughput (issue #609 backfill) — pre-warmed read/write capacity, shape
 * `{ ReadUnitsPerSecond, WriteUnitsPerSecond }`. Like OnDemandThroughput it
 * rides DIRECTLY on CreateTable / UpdateTable (not a separate post-ACTIVE
 * control-plane API), and works with BOTH PROVISIONED and PAY_PER_REQUEST
 * billing modes.
 */
describe('DynamoDBTableProvider WarmThroughput wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties', () => {
    it('declares WarmThroughput', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled?.has('WarmThroughput')).toBe(true);
    });
  });

  describe('create', () => {
    it('passes WarmThroughput through to CreateTable when present', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive -> DescribeTable

      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      });

      const createCalls = findCalls(CreateTableCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('omits WarmThroughput from CreateTable when not specified', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
      });

      const createCall = findCalls(CreateTableCommand)[0]!;
      expect(createCall.input).not.toHaveProperty('WarmThroughput');
    });

    it('sends nothing for a FALSY WarmThroughput, which is what makes the drift gate correct', async () => {
      // Issue #1760: `create()`, `update()` and both drift-side consumers share
      // ONE send rule (`isSendableWarmThroughput`). This case pins the write
      // half of it — respelling that rule as `!== undefined` would put a null
      // on the wire here, and would simultaneously make the readback emit
      // AWS's computed 12000/4000 as though the template had asked for it.
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: null,
      });

      const createCall = findCalls(CreateTableCommand)[0]!;
      expect(createCall.input).not.toHaveProperty('WarmThroughput');
    });

    it('omits an EMPTY or NON-OBJECT WarmThroughput from CreateTable', async () => {
      // The create-side twin of the update fences in
      // `dynamodb-table-provider-warm-throughput-decrease.test.ts`: the shared
      // send rule was bare truthiness, so `{}` reached CreateTable as an empty
      // block and a string as a scalar — neither is a value AWS accepts.
      for (const junk of [{}, 'nonsense', []]) {
        mockSend.mockReset();
        vi.clearAllMocks();
        provider = new DynamoDBTableProvider();
        mockSend.mockResolvedValueOnce({}); // CreateTable
        mockSend.mockResolvedValueOnce({
          Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
        });

        await provider.create('L', RESOURCE_TYPE, {
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PAY_PER_REQUEST',
          WarmThroughput: junk,
        });

        const createCall = findCalls(CreateTableCommand)[0]!;
        expect({ junk, sent: 'WarmThroughput' in createCall.input }).toEqual({
          junk,
          sent: false,
        });
      }
    });
  });

  describe('numeric strings reach the wire as numbers (PR review round 5)', () => {
    it('COERCES a quoted WarmThroughput on CreateTable', async () => {
      // The predicate accepted `'12000'` while the send path forwarded it, so
      // the body carried a string in a Long field and DynamoDB rejected the
      // whole CreateTable — the one doomed shape the tightening exists to
      // stop. A stringly-typed CFn template is a real shape, so it is coerced
      // rather than refused.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: { ReadUnitsPerSecond: '12000', WriteUnitsPerSecond: '4000' },
      });

      expect(findCalls(CreateTableCommand)[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('COERCES a quoted WarmThroughput on UpdateTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: { ReadUnitsPerSecond: '24000', WriteUnitsPerSecond: 8000 } },
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      const sent = findCalls(UpdateTableCommand)
        .map((c) => c.input)
        .filter((i) => i.WarmThroughput !== undefined);
      expect(sent.map((i) => i.WarmThroughput)).toEqual([
        { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
      ]);
    });

    it('never puts NaN on the wire for a NON-numeric string', async () => {
      // `Number('abc')` is NaN, which serializes as `null` — worse than the
      // string. `capacityNumber` rejects it, so the member is dropped and the
      // whole block is refused when nothing is left.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: { ReadUnitsPerSecond: 'abc', WriteUnitsPerSecond: 'def' },
      });

      expect(findCalls(CreateTableCommand)[0]!.input).not.toHaveProperty('WarmThroughput');
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('carries no usable');
    });
  });

  describe('PER-INDEX WarmThroughput on the CreateTable path (PR review round 6)', () => {
    const gsi = (warm: unknown) => ({
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ...(warm === undefined ? {} : { WarmThroughput: warm }),
    });
    function primeCreate(): void {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }
    async function createWithIndex(warm: unknown): Promise<CreateTableCommand> {
      primeCreate();
      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [gsi(warm)],
      });
      return findCalls(CreateTableCommand)[0]!;
    }

    it('COERCES a quoted per-index value — the FIFTH send site', async () => {
      // `create()` forwarded the whole index array verbatim, so the same
      // template SUCCEEDED when the index was added by a later update (where
      // the Create ACTION coerces) and FAILED on a fresh create.
      const call = await createWithIndex({ ReadUnitsPerSecond: '12000' });

      expect(call.input.GlobalSecondaryIndexes).toEqual([
        { ...gsi(undefined), WarmThroughput: { ReadUnitsPerSecond: 12000 } },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('DROPS an unusable per-index block and announces it', async () => {
      const call = await createWithIndex({});

      expect(call.input.GlobalSecondaryIndexes).toEqual([gsi(undefined)]);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('carries no usable');
    });

    it('drops only the unusable MEMBER and names it', async () => {
      const call = await createWithIndex({ ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 'abc' });

      expect(call.input.GlobalSecondaryIndexes).toEqual([
        { ...gsi(undefined), WarmThroughput: { ReadUnitsPerSecond: 24000 } },
      ]);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'WriteUnitsPerSecond'
      );
    });

    it('leaves an index with NO WarmThroughput untouched and silent', async () => {
      const call = await createWithIndex(undefined);

      expect(call.input.GlobalSecondaryIndexes).toEqual([gsi(undefined)]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not MUTATE the caller\'s template bag', async () => {
      // The engine records the same resolved bag into state; editing it in
      // place would change what state reports cdkd sent.
      const declared = { GlobalSecondaryIndexes: [gsi({ ReadUnitsPerSecond: '12000' })] };
      const snapshot = JSON.stringify(declared);
      primeCreate();

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        ...declared,
      });

      expect(JSON.stringify(declared)).toBe(snapshot);
    });

    it('passes a NON-ARRAY index list through untouched — AWS names it', async () => {
      primeCreate();
      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: { Ref: 'Unresolved' },
      });

      expect(findCalls(CreateTableCommand)[0]!.input.GlobalSecondaryIndexes).toEqual({
        Ref: 'Unresolved',
      });
    });
  });

  describe('create refusal is announced', () => {
    it('WARNS when create() refuses a declared WarmThroughput', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: { ReadUnitsPerSecnd: 20000 },
      });

      const createCall = findCalls(CreateTableCommand)[0]!;
      expect(createCall.input).not.toHaveProperty('WarmThroughput');
      const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(message).toContain('carries no usable');
      expect(message).toContain('ReadUnitsPerSecnd');
    });

    it('stays SILENT on create when WarmThroughput is absent', async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    function primeDescribeTable(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }

    it('issues UpdateTable with the new WarmThroughput when it changes', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } },
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(updateCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 24000,
        WriteUnitsPerSecond: 8000,
      });
    });

    it('issues UpdateTable when WarmThroughput is newly added', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
        {}
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('makes no UpdateTable call when WarmThroughput is unchanged', async () => {
      primeDescribeTable();

      const props = { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } };
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });

    it('makes no UpdateTable call on the removal path (no spec to apply)', async () => {
      // Dropping WarmThroughput from the template: a removal carries no new
      // spec to send, so update() must not issue a malformed UpdateTable.
      primeDescribeTable();

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });

    it('issues no UpdateTable for a FALSY WarmThroughput even though the value CHANGED', async () => {
      // The update-side twin of the create case above (issue #1760). The
      // change gate fires (null vs a previous spec is a JSON diff), so only the
      // shared send rule stops the call — an `!== undefined` spelling would
      // send `WarmThroughput: null` to AWS here.
      primeDescribeTable();

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: null },
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    // Issue #1760: the emission is gated on the DESIRED bag DECLARING
    // WarmThroughput, because AWS reports a computed 12000/4000 for a table
    // that never asked (measured us-east-1, 2026-08-13). These cases pass a
    // declaring bag so they exercise the shape every production caller sends;
    // the undeclared arms and the absent-bag fallback are covered by
    // `dynamodb-table-provider-drift-phantoms.test.ts`.
    const DECLARED = { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } };

    function primeTtlPitrEmpty(): void {
      mockSend.mockResolvedValueOnce({}); // DescribeContinuousBackups (empty)
      mockSend.mockResolvedValueOnce({}); // DescribeTimeToLive (empty)
    }

    it('emits WarmThroughput when DescribeTable returns it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          WarmThroughput: {
            ReadUnitsPerSecond: 12000,
            WriteUnitsPerSecond: 4000,
            // Status is AWS-managed — must NOT be surfaced.
            Status: 'ACTIVE',
          },
        },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, DECLARED);

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
      expect(result?.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('omits WarmThroughput when DescribeTable does not return it', async () => {
      // The absent-RESPONSE branch. Note this is NOT the shape a table without
      // warm throughput has: AWS reports a computed 12000/4000 for those too
      // (issue #1760), and the undeclared case is gated on the desired bag
      // rather than on the response. This case pins the branch that still
      // fires where AWS genuinely reports nothing.
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          // WarmThroughput absent.
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, DECLARED);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('WarmThroughput');
    });

    it('emits only the units AWS actually reports (partial WarmThroughput)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          WarmThroughput: { ReadUnitsPerSecond: 12000 },
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE, DECLARED);

      expect(result?.WarmThroughput).toEqual({ ReadUnitsPerSecond: 12000 });
    });
  });
});
