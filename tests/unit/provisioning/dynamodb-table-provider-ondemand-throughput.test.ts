import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();

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
 * OnDemandThroughput (issue #609 backfill) — capacity caps for
 * PAY_PER_REQUEST (on-demand) tables, shape
 * `{ MaxReadRequestUnits, MaxWriteRequestUnits }`. Unlike PITR / TTL it
 * rides DIRECTLY on CreateTable / UpdateTable (not a separate
 * post-ACTIVE control-plane API).
 */
describe('DynamoDBTableProvider OnDemandThroughput wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties', () => {
    it('declares OnDemandThroughput', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled?.has('OnDemandThroughput')).toBe(true);
    });
  });

  describe('create', () => {
    it('passes OnDemandThroughput through to CreateTable when present', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive -> DescribeTable

      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
      });

      const createCalls = findCalls(CreateTableCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('omits OnDemandThroughput from CreateTable when not specified', async () => {
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
      expect(createCall.input).not.toHaveProperty('OnDemandThroughput');
    });
  });

  describe('update', () => {
    function primeDescribeTable(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }

    it('issues UpdateTable with the new OnDemandThroughput when it changes', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { OnDemandThroughput: { MaxReadRequestUnits: 20, MaxWriteRequestUnits: 10 } },
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 20,
        MaxWriteRequestUnits: 10,
      });
    });

    it('issues UpdateTable when OnDemandThroughput is newly added', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } },
        {}
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('makes no UpdateTable call when OnDemandThroughput is unchanged', async () => {
      primeDescribeTable();

      const props = { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } };
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });

    it('sends the -1 removal sentinel when the template drops the block (go-to-k/cdkd#3373)', async () => {
      // INVERTED by go-to-k/cdkd#3373. This case used to pin "makes no
      // UpdateTable call on the removal path", which was the DEFECT: an absent
      // member KEEPS whatever maximum the table already carries, so dropping
      // the block deployed green, was recorded as applied, and left the live
      // maximum in force forever. `-1` is AWS's documented reset sentinel for
      // this field and is live-verified at this position (go-to-k/cdkd#1434).
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
        },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: -1,
        MaxWriteRequestUnits: -1,
      });
    });

    it('removes ONLY the member the template dropped, keeping the one it still declares', async () => {
      // PER MEMBER, never per BLOCK -- read and write maxima are independent
      // template values and the single-member drop is the likelier user edit.
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
        },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { OnDemandThroughput: { MaxReadRequestUnits: 10 } },
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: -1,
      });
    });

    it('does NOT write the -1 sentinel back into the caller\'s properties bag (go-to-k/cdkd#3401 finding 1)', async () => {
      // `withOnDemandCeilingRemovals` must COPY. The hazard is not theoretical:
      // `narrowOnDemandCeilings` returns its input BY IDENTITY when nothing
      // needed rewriting, so `coerceOnDemandCeilingsForSend` hands back the
      // very object the template declared -- and the deploy engine RECORDS
      // that bag as state. A merge-in-place would persist `MaxWriteRequestUnits: -1`,
      // which `DescribeTable` can never report (the reset reads back as
      // ABSENCE), so every later `cdkd diff` / `drift` would report a
      // permanent phantom and `--revert` would hold a change to push.
      //
      // A test reviewer measured the gap: swapping `{ ...base }` for `base`
      // left all 1274 dynamodb cases green.
      //
      // The desired bag is bound ONCE and inspected afterwards -- re-reading a
      // factory would inspect a fresh literal and assert nothing
      // (`assertion-on-a-factory-produced-object-is-vacuous`).
      const desiredCeiling: Record<string, unknown> = { MaxReadRequestUnits: 10 };
      const desired = { OnDemandThroughput: desiredCeiling };

      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
        },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, desired, {
        OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
      });

      // The WIRE carried the sentinel...
      expect(findCalls(UpdateTableCommand)[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: -1,
      });
      // ...and the caller's own object did not gain it. `toEqual` alone would
      // pass against a bag that gained an `undefined`-valued key, so the key
      // set is asserted too.
      expect(desiredCeiling).toEqual({ MaxReadRequestUnits: 10 });
      expect(Object.keys(desiredCeiling)).toEqual(['MaxReadRequestUnits']);
    });

    it('makes NO removal call on a deploy that FLIPS the table to PROVISIONED (go-to-k/cdkd#3401 M0)', async () => {
      // Condition 4 of `onDemandCeilingRemovals`, and condition 3 does NOT
      // subsume it -- believing it did was a merge blocker.
      //
      // The live snapshot is the ONE `DescribeTable` at the top of `update()`
      // and is never refreshed, while the removal arm runs AFTER the
      // BillingMode flip. So on a template that flips a live on-demand table to
      // PROVISIONED *and* drops the ceiling, neither pre-flight refusal fires
      // (neither side DECLARES a ceiling), the flip lands, and the stale
      // snapshot still reports the member live -- cdkd would send `-1` to a
      // now-PROVISIONED table, AWS would reject it, and a previously-green
      // no-op would become a HALF-APPLIED deploy.
      //
      // The discriminator is the SHAPE of the calls, not their count: the flip
      // itself is an `UpdateTable`, so "did not throw" and "exactly one call"
      // both pass against the bug.
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
        },
      });
      mockSend.mockResolvedValueOnce({}); // the flip UpdateTable
      primeDescribeTable(); // waitForTableActiveAfterUpdate

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
        },
        {
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
        }
      );

      const ceilingCalls = findCalls(UpdateTableCommand).filter(
        (c) => c.input.OnDemandThroughput !== undefined
      );
      expect(ceilingCalls).toHaveLength(0);
      // ...and the flip itself DID go out, so the case is not vacuous.
      expect(
        findCalls(UpdateTableCommand).filter((c) => c.input.BillingMode === 'PROVISIONED')
      ).toHaveLength(1);
    });

    it('makes NO call on the removal path when AWS is not observed to hold the maximum', async () => {
      // The fail-CLOSED half, and the reason the rule reads the LIVE block
      // rather than the record alone: `DescribeTable` reports
      // `OnDemandThroughput` only on a PAY_PER_REQUEST table, so "AWS holds it"
      // proves there is something to remove AND keeps a doomed `-1` off a
      // PROVISIONED table. `primeDescribeTable` reports no ceiling at all,
      // which is also what a table with no live snapshot looks like.
      primeDescribeTable();

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    function primeTtlPitrEmpty(): void {
      mockSend.mockResolvedValueOnce({}); // DescribeContinuousBackups (empty)
      mockSend.mockResolvedValueOnce({}); // DescribeTimeToLive (empty)
    }

    it('emits OnDemandThroughput when DescribeTable returns it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: {
            MaxReadRequestUnits: 10,
            MaxWriteRequestUnits: 5,
          },
        },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
      expect(result?.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('omits OnDemandThroughput when DescribeTable does not return it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          // OnDemandThroughput absent.
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('OnDemandThroughput');
    });

    it('emits only the caps AWS actually reports (partial OnDemandThroughput)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10 },
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result?.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 10 });
    });
  });
});
