import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  UpdateContributorInsightsCommand,
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift.js';

/**
 * go-to-k/cdkd#6778: the table-level Contributor Insights read omitted the
 * block while the toggle read ENABLING, which is what the post-deploy
 * `observedProperties` capture sees. The comparator walks the baseline's own
 * top-level keys, so a disable made outside cdkd was never reported.
 */

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const TYPE = 'AWS::DynamoDB::Table';
const KEY = 'ContributorInsightsSpecification';
const MODE = 'ACCESSED_AND_THROTTLED_KEYS';

const DECLARED = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  [KEY]: { Enabled: true },
};

interface Insights {
  ContributorInsightsStatus?: string;
  ContributorInsightsMode?: string;
}

function prime(insights: Insights | Error): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          KeySchema: DECLARED.KeySchema,
          AttributeDefinitions: DECLARED.AttributeDefinitions,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        },
      });
    }
    if (cmd instanceof DescribeContributorInsightsCommand) {
      return insights instanceof Error ? Promise.reject(insights) : Promise.resolve(insights);
    }
    if (cmd instanceof ListTagsOfResourceCommand) return Promise.resolve({ Tags: [] });
    if (cmd instanceof DescribeContinuousBackupsCommand) return Promise.resolve({});
    if (cmd instanceof DescribeTimeToLiveCommand) return Promise.resolve({});
    if (cmd instanceof GetResourcePolicyCommand) return Promise.resolve({});
    if (cmd instanceof DescribeKinesisStreamingDestinationCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

const ENABLING: Insights = { ContributorInsightsStatus: 'ENABLING', ContributorInsightsMode: MODE };
const ENABLED: Insights = { ContributorInsightsStatus: 'ENABLED', ContributorInsightsMode: MODE };
const DISABLED: Insights = { ContributorInsightsStatus: 'DISABLED' };

describe('DynamoDB table Contributor Insights captured while ENABLING (go-to-k/cdkd#6778)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
  });

  async function read(insights: Insights | Error): Promise<Record<string, unknown>> {
    prime(insights);
    const result = await provider.readCurrentState(TABLE_NAME, 'T', TYPE, DECLARED);
    expect(result).not.toBe(RESOURCE_NOT_FOUND);
    expect(result).toBeDefined();
    return result as Record<string, unknown>;
  }

  /** `cdkd drift`'s provider hooks around the comparator, observed baseline. */
  async function drift(
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<ReturnType<typeof calculateResourceDrift>> {
    const paired = await provider.canonicalizeDriftPair(
      TYPE,
      provider.canonicalizeDriftProperties(TYPE, baseline),
      provider.canonicalizeDriftProperties(TYPE, aws),
      DECLARED
    );
    return calculateResourceDrift(paired.baseline, paired.aws, {
      ignorePaths: provider.getDriftUnknownPaths(TYPE, DECLARED),
      unorderedPaths: provider.getDriftUnorderedPaths(TYPE),
      unionWalkObjects: true,
    });
  }

  describe('a baseline captured by this cdkd', () => {
    it('records the block while ENABLING, so a later out-of-band disable is drift', async () => {
      const observed = await read(ENABLING);
      expect(observed[KEY]).toEqual({ Enabled: true, Mode: MODE });

      const changes = await drift(observed, await read(DISABLED));
      expect(changes.map((c) => c.path)).toEqual([`${KEY}.Enabled`, `${KEY}.Mode`]);
    });

    it('compares clean once the toggle settles', async () => {
      const observed = await read(ENABLING);
      expect(await drift(observed, await read(ENABLED))).toEqual([]);
    });
  });

  describe('a baseline captured before the fix (no key)', () => {
    async function legacyObserved(): Promise<Record<string, unknown>> {
      const observed = await read(ENABLING);
      const { [KEY]: _dropped, ...legacy } = observed;
      return legacy;
    }

    it('reports an out-of-band disable against the declared block', async () => {
      const changes = await drift(await legacyObserved(), await read(DISABLED));
      expect(changes.map((c) => [c.path, c.stateValue, c.awsValue])).toEqual([
        [`${KEY}.Enabled`, true, false],
      ]);
    });

    it('compares clean when the live table is enabled with the default mode', async () => {
      expect(await drift(await legacyObserved(), await read(ENABLED))).toEqual([]);
    });

    it('rejects the read, rather than completing nothing, when the live read fails', async () => {
      // go-to-k/cdkd#6759: a failed sub-read rejects the whole read, so there is no live bag to complete.
      await expect(read(new Error('AccessDeniedException'))).rejects.toThrow(
        'AccessDeniedException'
      );
    });

    it('drift --revert re-enables Contributor Insights', async () => {
      const legacy = await legacyObserved();
      const aws = await read(DISABLED);
      const changes = await drift(legacy, aws);
      const desired = (await provider.canonicalizeDriftPair(TYPE, legacy, aws, DECLARED)).baseline;
      const newProperties = buildRevertNewProperties(changes, desired, aws);
      expect(newProperties[KEY]).toEqual({ Enabled: true });

      mockSend.mockClear();
      // The wait after the enable reads the table until Contributor Insights is ENABLED.
      prime(ENABLED);
      await provider.update('T', TABLE_NAME, TYPE, newProperties, aws);
      const sent = mockSend.mock.calls
        .map((c) => c[0] as unknown)
        .filter(
          (cmd): cmd is UpdateContributorInsightsCommand =>
            cmd instanceof UpdateContributorInsightsCommand
        )
        .map((cmd) => cmd.input);
      expect(sent).toEqual([{ TableName: TABLE_NAME, ContributorInsightsAction: 'ENABLE' }]);
    });
  });

  describe('the strict unsettled re-read', () => {
    it.each([
      ['ENABLING', { Enabled: true, Mode: MODE }],
      ['DISABLING', { Enabled: false }],
    ])('reads %s as its target', async (status, expected) => {
      prime({ ContributorInsightsStatus: status, ContributorInsightsMode: MODE });
      const live = await provider.readUnsettled(
        TABLE_NAME,
        'T',
        TYPE,
        new Set([KEY]),
        DECLARED,
        DECLARED
      );
      expect((live as Record<string, unknown>)[KEY]).toEqual(expected);
    });
  });
});
