import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeContributorInsightsCommand,
  DescribeTableCommand,
  UpdateContributorInsightsCommand,
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
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/** One template GSI entry, optionally declaring the per-index block. */
function gsi(name: string, spec?: unknown): Record<string, unknown> {
  return {
    IndexName: name,
    KeySchema: [{ AttributeName: `${name}pk`, KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
    ...(spec === undefined ? {} : { ContributorInsightsSpecification: spec }),
  };
}

function tableProps(gsis: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      ...gsis.map((g) => ({ AttributeName: `${String(g['IndexName'])}pk`, AttributeType: 'S' })),
    ],
    GlobalSecondaryIndexes: gsis,
  };
}

/** What `DescribeTable` reports for those indexes once they are ACTIVE. */
function liveIndexes(names: string[]): Array<Record<string, unknown>> {
  return names.map((name) => ({
    IndexName: name,
    KeySchema: [{ AttributeName: `${name}pk`, KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
    IndexStatus: 'ACTIVE',
    ItemCount: 3,
    IndexArn: `${TABLE_ARN}/index/${name}`,
  }));
}

/**
 * Per-index `DescribeContributorInsights` answers, keyed by index name. The
 * shape is the COMMAND's documented output, not the SDK type's optional bag:
 * `ContributorInsightsStatus` is one of ENABLING / ENABLED / DISABLING /
 * DISABLED / FAILED, and `IndexName` echoes the request.
 */
type InsightsAnswer = { status: string; mode?: string } | Error;

/**
 * Dispatch by COMMAND, never `*Once`: the number of `DescribeTable` calls is
 * not the subject, and a surplus primer would leak into the next test.
 */
function primeAws(
  initialIndexNames: string[],
  insights: Record<string, InsightsAnswer> = {},
  // How many leading DescribeTable answers report every index as CREATING.
  creatingForDescribes = 0
): void {
  let describes = 0;
  // Stateful on purpose: an index a `Create` action adds must be absent from
  // the opening DescribeTable, or update() takes its already-exists recovery
  // arm and never issues the Create at all.
  const liveIndexNames = [...initialIndexNames];
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateTableCommand) {
      for (const op of cmd.input.GlobalSecondaryIndexUpdates ?? []) {
        if (op.Create?.IndexName !== undefined) liveIndexNames.push(op.Create.IndexName);
      }
      return Promise.resolve({});
    }
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          GlobalSecondaryIndexes: liveIndexes(liveIndexNames).map((index) =>
            ++describes <= creatingForDescribes ? { ...index, IndexStatus: 'CREATING' } : index
          ),
        },
      });
    }
    if (cmd instanceof DescribeContributorInsightsCommand) {
      const indexName = cmd.input.IndexName;
      if (indexName === undefined) return Promise.resolve({ ContributorInsightsStatus: 'DISABLED' });
      const answer = insights[indexName];
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer === undefined) return Promise.resolve({ ContributorInsightsStatus: 'DISABLED' });
      return Promise.resolve({
        TableName: TABLE_NAME,
        IndexName: indexName,
        ContributorInsightsStatus: answer.status,
        ...(answer.mode === undefined ? {} : { ContributorInsightsMode: answer.mode }),
      });
    }
    return Promise.resolve({});
  });
}

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

function insightsWrites(): unknown[] {
  return findCalls(UpdateContributorInsightsCommand).map((c) => c.input);
}

function warnText(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

let provider: DynamoDBTableProvider;

beforeEach(() => {
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
});

describe('DynamoDBTableProvider per-index ContributorInsightsSpecification (issue #1782)', () => {
  describe('create()', () => {
    it('sends UpdateContributorInsights WITH IndexName for a declaring index only', async () => {
      primeAws(['on', 'plain']);
      await provider.create(
        'T',
        RESOURCE_TYPE,
        tableProps([gsi('on', { Enabled: true, Mode: 'THROTTLED_KEYS' }), gsi('plain')])
      );
      expect(insightsWrites()).toEqual([
        {
          TableName: TABLE_NAME,
          IndexName: 'on',
          ContributorInsightsAction: 'ENABLE',
          ContributorInsightsMode: 'THROTTLED_KEYS',
        },
      ]);
    });

    it('does NOT forward the block to CreateTable, and leaves the caller bag intact', async () => {
      primeAws(['on']);
      const props = tableProps([gsi('on', { Enabled: true })]);
      await provider.create('T', RESOURCE_TYPE, props);
      const [create] = findCalls(CreateTableCommand);
      expect(create?.input.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: 'on',
          KeySchema: [{ AttributeName: 'onpk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ]);
      // The engine records this bag into state: it must still carry the block.
      expect(props['GlobalSecondaryIndexes']).toEqual([gsi('on', { Enabled: true })]);
    });

    it('applies the per-index block only AFTER the table was created', async () => {
      primeAws(['on']);
      await provider.create('T', RESOURCE_TYPE, tableProps([gsi('on', { Enabled: true })]));
      const order = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      expect(order.indexOf('CreateTableCommand')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('UpdateContributorInsightsCommand')).toBeGreaterThan(
        order.indexOf('CreateTableCommand')
      );
    });

    it('issues no per-index call when no index declares the block', async () => {
      primeAws(['plain']);
      await provider.create('T', RESOURCE_TYPE, tableProps([gsi('plain')]));
      expect(insightsWrites()).toEqual([]);
    });

    it('keeps the TABLE-level call free of IndexName', async () => {
      primeAws([]);
      await provider.create('T', RESOURCE_TYPE, {
        ...tableProps([]),
        GlobalSecondaryIndexes: undefined,
        ContributorInsightsSpecification: { Enabled: true },
      });
      expect(insightsWrites()).toEqual([
        { TableName: TABLE_NAME, ContributorInsightsAction: 'ENABLE' },
      ]);
    });

    it("does not ENABLE a table-level block spelled Enabled: 'false'", async () => {
      primeAws([]);
      await provider.create('T', RESOURCE_TYPE, {
        ...tableProps([]),
        GlobalSecondaryIndexes: undefined,
        ContributorInsightsSpecification: { Enabled: 'false' },
      });
      expect(insightsWrites()).toEqual([
        { TableName: TABLE_NAME, ContributorInsightsAction: 'DISABLE' },
      ]);
    });
  });

  describe('update()', () => {
    const update = (desired: Array<Record<string, unknown>>, previous: Array<Record<string, unknown>>) =>
      provider.update('T', TABLE_NAME, RESOURCE_TYPE, tableProps(desired), tableProps(previous));

    it('enables a block added to an existing index, without touching the index itself', async () => {
      primeAws(['a']);
      await update([gsi('a', { Enabled: true })], [gsi('a')]);
      expect(insightsWrites()).toEqual([
        { TableName: TABLE_NAME, IndexName: 'a', ContributorInsightsAction: 'ENABLE' },
      ]);
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([]);
    });

    it('disables on an Enabled flip and on a REMOVED block', async () => {
      primeAws(['flip', 'removed']);
      await update(
        [gsi('flip', { Enabled: false }), gsi('removed')],
        [gsi('flip', { Enabled: true }), gsi('removed', { Enabled: true })]
      );
      expect(insightsWrites()).toEqual([
        { TableName: TABLE_NAME, IndexName: 'flip', ContributorInsightsAction: 'DISABLE' },
        { TableName: TABLE_NAME, IndexName: 'removed', ContributorInsightsAction: 'DISABLE' },
      ]);
    });

    it('restores the old setting when the sides are SWAPPED (rollback)', async () => {
      primeAws(['removed']);
      // Forward: the block was removed. Rollback replays update() reversed.
      await update([gsi('removed', { Enabled: true, Mode: 'THROTTLED_KEYS' })], [gsi('removed')]);
      expect(insightsWrites()).toEqual([
        {
          TableName: TABLE_NAME,
          IndexName: 'removed',
          ContributorInsightsAction: 'ENABLE',
          ContributorInsightsMode: 'THROTTLED_KEYS',
        },
      ]);
    });

    it('re-enables with the new Mode on a Mode change', async () => {
      primeAws(['a']);
      await update(
        [gsi('a', { Enabled: true, Mode: 'THROTTLED_KEYS' })],
        [gsi('a', { Enabled: true, Mode: 'ACCESSED_AND_THROTTLED_KEYS' })]
      );
      expect(insightsWrites()).toEqual([
        {
          TableName: TABLE_NAME,
          IndexName: 'a',
          ContributorInsightsAction: 'ENABLE',
          ContributorInsightsMode: 'THROTTLED_KEYS',
        },
      ]);
    });

    it('applies the block of an index ADDED by this update, after its Create', async () => {
      primeAws(['old']);
      await update([gsi('old'), gsi('added', { Enabled: true })], [gsi('old')]);
      const order = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      const createAt = mockSend.mock.calls.findIndex(
        (c) =>
          c[0] instanceof UpdateTableCommand &&
          (c[0].input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Create?.IndexName === 'added')
      );
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('UpdateContributorInsightsCommand')).toBeGreaterThan(createAt);
      // ...and the Create action itself never carries the block.
      const createAction = findCalls(UpdateTableCommand)
        .flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
        .find((u) => u.Create !== undefined)?.Create;
      expect(createAction).not.toHaveProperty('ContributorInsightsSpecification');
      expect(insightsWrites()).toEqual([
        { TableName: TABLE_NAME, IndexName: 'added', ContributorInsightsAction: 'ENABLE' },
      ]);
    });

    it('issues nothing for an index the update REMOVED', async () => {
      primeAws(['stays', 'gone']);
      await update([gsi('stays')], [gsi('stays'), gsi('gone', { Enabled: true })]);
      expect(insightsWrites()).toEqual([]);
    });

    it('issues nothing, and no index wait, when no block changed', async () => {
      primeAws(['a']);
      await update([gsi('a', { Enabled: true })], [gsi('a', { Enabled: true })]);
      expect(insightsWrites()).toEqual([]);
      // update()'s own opening DescribeTable is the only one: the index wait
      // runs only when there is a per-index call to make.
      expect(findCalls(DescribeTableCommand)).toHaveLength(1);
    });

    it('warns and leaves the live setting alone for an unreadable block', async () => {
      primeAws(['a']);
      await update([gsi('a', { Enabled: 'yes' })], [gsi('a', { Enabled: true })]);
      expect(insightsWrites()).toEqual([]);
      expect(warnText()).toContain('GSI a on DynamoDB table my-table');
      expect(warnText()).toContain('Contributor Insights was left as it is');
    });

    it('never prints a SHORT secret index name, which only a whole-value mask can reach', async () => {
      // A 3-character name is below the substring mask's minimum needle, so the
      // masker here matches WHOLE values only — exactly what the real one can
      // do for it. The name must therefore appear in the message only where it
      // was masked as a whole, never embedded in the refusal's path.
      primeAws(['s3k']);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        tableProps([gsi('s3k', 'junk')]),
        tableProps([gsi('s3k')]),
        { maskSecrets: (text: string) => (text === 's3k' ? '***' : text) }
      );
      expect(warnText()).toContain('GSI *** on DynamoDB table my-table');
      expect(warnText()).not.toContain('s3k');
    });

    it('waits for the index to be ACTIVE before the per-index call', async () => {
      // `UpdateContributorInsights` answers ResourceNotFoundException for an
      // index that is not ACTIVE, which the transient retry does not cover.
      vi.useFakeTimers();
      try {
        // Describe 1 is update()'s own; 2 is the wait's first poll.
        primeAws(['a'], {}, 2);
        const done = update([gsi('a', { Enabled: true })], [gsi('a')]);
        await vi.advanceTimersByTimeAsync(5_000);
        await done;
      } finally {
        vi.useRealTimers();
      }
      const calls = mockSend.mock.calls.map((c) => c[0] as object);
      const writeAt = calls.findIndex((c) => c instanceof UpdateContributorInsightsCommand);
      const describesBefore = calls
        .slice(0, writeAt)
        .filter((c) => c instanceof DescribeTableCommand).length;
      expect(writeAt).toBeGreaterThanOrEqual(0);
      // Two CREATING answers, then the ACTIVE one that released the call.
      expect(describesBefore).toBe(3);
    });

    it('warns and sends nothing for an unreadable TABLE-level block', async () => {
      primeAws([]);
      await provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...tableProps([]), ContributorInsightsSpecification: { Enabled: 'yes' } },
        { ...tableProps([]), ContributorInsightsSpecification: { Enabled: true } }
      );
      expect(insightsWrites()).toEqual([]);
      expect(warnText()).toContain('ContributorInsightsSpecification.Enabled must be a boolean');
      expect(warnText()).toContain('Contributor Insights was left as it is');
    });
  });

  describe('create() with an unreadable block', () => {
    it('refuses BEFORE CreateTable, naming the index by position and never by name', async () => {
      primeAws(['s3k']);
      await expect(
        provider.create('T', RESOURCE_TYPE, tableProps([gsi('s3k', { Enabled: 'yes' })]))
      ).rejects.toThrow(
        /GlobalSecondaryIndexes\[0\]\.ContributorInsightsSpecification\.Enabled must be a boolean/
      );
      expect(findCalls(CreateTableCommand)).toEqual([]);
      await expect(
        provider.create('T', RESOURCE_TYPE, tableProps([gsi('s3k', { Enabled: 'yes' })]))
      ).rejects.not.toThrow(/s3k/);
    });

    it('refuses an unreadable TABLE-level block too', async () => {
      primeAws([]);
      await expect(
        provider.create('T', RESOURCE_TYPE, {
          ...tableProps([]),
          ContributorInsightsSpecification: 'junk',
        })
      ).rejects.toThrow(/ContributorInsightsSpecification must be an object/);
      expect(findCalls(CreateTableCommand)).toEqual([]);
    });

    it('stands down on a state replay: creates, warns, and leaves the block unsent', async () => {
      primeAws(['a']);
      await provider.create('T', RESOURCE_TYPE, tableProps([gsi('a', { Enabled: 'yes' })]), {
        replayingState: true,
      });
      expect(findCalls(CreateTableCommand)).toHaveLength(1);
      expect(insightsWrites()).toEqual([]);
      expect(warnText()).toContain('Contributor Insights was left as it is');
    });
  });

  describe('readCurrentState()', () => {
    const readBack = (desired: Record<string, unknown> | undefined) =>
      provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, desired);

    function perIndexReads(): Array<string | undefined> {
      return findCalls(DescribeContributorInsightsCommand)
        .map((c) => c.input.IndexName)
        .filter((name) => name !== undefined);
    }

    it('reads ONLY the declaring index, and emits the block on that entry alone', async () => {
      primeAws(['on', 'plain'], { on: { status: 'ENABLED', mode: 'ACCESSED_AND_THROTTLED_KEYS' } });
      const result = await readBack(tableProps([gsi('on', { Enabled: true }), gsi('plain')]));
      expect(perIndexReads()).toEqual(['on']);
      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        gsi('on', { Enabled: true }),
        gsi('plain'),
      ]);
    });

    it('emits Mode only when the desired block declares one', async () => {
      primeAws(['on'], { on: { status: 'ENABLED', mode: 'THROTTLED_KEYS' } });
      const result = await readBack(
        tableProps([gsi('on', { Enabled: true, Mode: 'THROTTLED_KEYS' })])
      );
      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        gsi('on', { Enabled: true, Mode: 'THROTTLED_KEYS' }),
      ]);
    });

    it('converges against a properties baseline, and reports an out-of-band toggle', async () => {
      const desired = tableProps([gsi('on', { Enabled: true }), gsi('plain')]);
      primeAws(['on', 'plain'], { on: { status: 'ENABLED', mode: 'ACCESSED_AND_THROTTLED_KEYS' } });
      const clean = await readBack(desired);
      expect(
        calculateResourceDrift(
          { GlobalSecondaryIndexes: desired['GlobalSecondaryIndexes'] },
          { GlobalSecondaryIndexes: clean?.['GlobalSecondaryIndexes'] }
        )
      ).toEqual([]);

      primeAws(['on', 'plain'], { on: { status: 'DISABLED' } });
      const toggled = await readBack(desired);
      const drift = calculateResourceDrift(
        { GlobalSecondaryIndexes: desired['GlobalSecondaryIndexes'] },
        { GlobalSecondaryIndexes: toggled?.['GlobalSecondaryIndexes'] }
      );
      expect(drift.map((d) => d.path)).toEqual(['GlobalSecondaryIndexes']);
    });

    it("converges for a stringly Enabled: 'true' by keeping the declared spelling", async () => {
      const desired = tableProps([gsi('on', { Enabled: 'true' })]);
      primeAws(['on'], { on: { status: 'ENABLED', mode: 'ACCESSED_AND_THROTTLED_KEYS' } });
      const result = await readBack(desired);
      expect(
        calculateResourceDrift(
          { GlobalSecondaryIndexes: desired['GlobalSecondaryIndexes'] },
          { GlobalSecondaryIndexes: result?.['GlobalSecondaryIndexes'] }
        )
      ).toEqual([]);
    });

    it('reads the declared Mode while ENABLING, so the post-deploy capture already carries it', async () => {
      primeAws(['on'], { on: { status: 'ENABLING' } });
      const result = await readBack(
        tableProps([gsi('on', { Enabled: true, Mode: 'THROTTLED_KEYS' })])
      );
      expect(result?.['GlobalSecondaryIndexes']).toEqual([
        gsi('on', { Enabled: true, Mode: 'THROTTLED_KEYS' }),
      ]);
    });

    it.each([
      ['ENABLING', true],
      ['DISABLING', false],
    ])('reads the transient %s as its target, so a post-deploy capture is stable', async (status, enabled) => {
      primeAws(['on'], { on: { status } });
      const result = await readBack(tableProps([gsi('on', { Enabled: enabled })]));
      expect(result?.['GlobalSecondaryIndexes']).toEqual([gsi('on', { Enabled: enabled })]);
    });

    it('omits the block on FAILED and on a failed read, without failing the whole read', async () => {
      const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      primeAws(['failed', 'denied'], { failed: { status: 'FAILED' }, denied });
      const result = await readBack(
        tableProps([gsi('failed', { Enabled: true }), gsi('denied', { Enabled: true })])
      );
      expect(result?.['GlobalSecondaryIndexes']).toEqual([gsi('failed'), gsi('denied')]);
    });

    it('reads nothing per index for an unreadable block or an uninformative bag', async () => {
      primeAws(['a'], { a: { status: 'ENABLED' } });
      await readBack(tableProps([gsi('a', 'junk')]));
      await readBack(undefined);
      await readBack({});
      expect(perIndexReads()).toEqual([]);
    });
  });
});
