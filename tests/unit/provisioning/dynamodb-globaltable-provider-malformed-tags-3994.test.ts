import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-dynamodb';

// go-to-k/cdkd#3994: the GlobalTable's per-replica Tags diff read a malformed
// side as empty, so a malformed DESIRED `Replicas[].Tags` (a rollback / drift
// --revert desired bag) untagged every recorded key — on the local replica and
// on every cross-region replica alike.

const { mockSend, mockAutoScalingSend, regionalClientSpy, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  regionalClientSpy: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => {
      regionalClientSpy(cfg?.region);
      return {
        send: mockSend,
        config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
      };
    }),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table';
const EU_ARN = 'arn:aws:dynamodb:eu-west-1:123456789012:table/my-table';
const BASE = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
};
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

/** Where the tags under test sit: the local replica, or a cross-region one. */
const REPLICA_CASES: Array<[string, string, string]> = [
  ['the local replica', 'us-east-1', TABLE_ARN],
  ['a cross-region replica', 'eu-west-1', EU_ARN],
];

/** Both replicas, with `tags` on the one in `region` and none on the other. */
function withTags(region: string, tags: unknown): Record<string, unknown> {
  return {
    ...BASE,
    Replicas: [
      region === 'us-east-1' ? { Region: 'us-east-1', Tags: tags } : { Region: 'us-east-1' },
      region === 'eu-west-1' ? { Region: 'eu-west-1', Tags: tags } : { Region: 'eu-west-1' },
    ],
  };
}

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCallsOn(arn: string): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) =>
        (c instanceof TagResourceCommand || c instanceof UntagResourceCommand) &&
        c.input.ResourceArn === arn
    ) as Array<TagResourceCommand | UntagResourceCommand>
  ).map((c) => [c.constructor.name, c.input]);
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

describe('DynamoDBGlobalTableProvider Replicas[].Tags (go-to-k/cdkd#3994)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof DescribeTableCommand
        ? {
            Table: {
              TableName: TABLE_NAME,
              TableArn: TABLE_ARN,
              TableStatus: 'ACTIVE',
              Replicas: [
                { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
                { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
              ],
            },
          }
        : {}
    );
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe.each(REPLICA_CASES)('on %s', (_where, region, arn) => {
    const index = region === 'us-east-1' ? 0 : 1;

    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on update before any call',
      async (_label, tags) => {
        const err = await refusal(() =>
          provider.update(
            'G',
            TABLE_NAME,
            TYPE,
            withTags(region, tags),
            withTags(region, RECORDED)
          )
        );
        expect(err.message).toContain(`desired Replicas[${index}].Tags of ${TYPE} G`);
        expect(mockSend).not.toHaveBeenCalled();
        expect(mockAutoScalingSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on create before any call',
      async (_label, tags) => {
        const err = await refusal(() => provider.create('G', TYPE, withTags(region, tags)));
        expect(err.message).toContain(`Replicas[${index}].Tags of ${TYPE} G`);
        expect(mockSend).not.toHaveBeenCalled();
        expect(mockAutoScalingSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_RECORDED)(
      'applies a recorded %s ADD-only: tags every desired key, untags nothing',
      async (_label, recorded) => {
        await provider.update(
          'G',
          TABLE_NAME,
          TYPE,
          withTags(region, DESIRED),
          withTags(region, recorded)
        );
        expect(commands().some((c) => c instanceof UntagResourceCommand)).toBe(false);
        expect(tagCallsOn(arn)).toEqual([
          [
            'TagResourceCommand',
            {
              ResourceArn: arn,
              Tags: [
                { Key: 'keep', Value: 'same' },
                { Key: 'add', Value: '' },
              ],
            },
          ],
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
        // Names the LOGICAL id, never an ARN / URL / physical name.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} G${region === 'us-east-1' ? '' : ` (replica ${region})`} is not`));
        for (const call of warn.mock.calls) {
          expect(String(call[0])).not.toContain(TAG_FIXTURE.NEEDLE);
        }
      }
    );

    it('diffs a valid pair into exact Tag / Untag calls', async () => {
      await provider.update(
        'G',
        TABLE_NAME,
        TYPE,
        withTags(region, DESIRED),
        withTags(region, RECORDED)
      );
      expect(tagCallsOn(arn)).toEqual([
        ['UntagResourceCommand', { ResourceArn: arn, TagKeys: ['drop'] }],
        ['TagResourceCommand', { ResourceArn: arn, Tags: [{ Key: 'add', Value: '' }] }],
      ]);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
    });

    it('never untags a recorded secret-derived key', async () => {
      await provider.update(
        'G',
        TABLE_NAME,
        TYPE,
        withTags(region, []),
        withTags(region, [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED])
      );
      const untag = commands().filter(
        (c) => c instanceof UntagResourceCommand
      ) as UntagResourceCommand[];
      expect(untag.map((c) => [c.input.ResourceArn, c.input.TagKeys])).toEqual([
        [arn, ['keep', 'drop']],
      ]);
    });
  });

  it.each(REPLICA_CASES)(
    'warns about a recorded secret-derived key it cannot remove, on %s',
    async (_where, region) => {
      await provider.update(
        'G',
        TABLE_NAME,
        TYPE,
        withTags(region, [{ Key: 'keep', Value: 'same' }]),
        withTags(region, [
          { Key: TAG_FIXTURE.SECRET_REF, Value: 'v' },
          { Key: 'keep', Value: 'same' },
        ])
      );
      const warned = warn.mock.calls.map((c) => String(c[0]));
      const id = region === 'us-east-1' ? 'G' : `G (replica ${region})`;
      expect(warned).toContainEqual(
        expect.stringContaining(`${TYPE} ${id} holds 1 key(s) derived from a dynamic reference`)
      );
      expect(warned.join('\n')).not.toContain('issue3994/tags');
      const sent = [mockSend, mockAutoScalingSend].flatMap((m) =>
        m.mock.calls.map((c) => (c[0] as object).constructor.name)
      );
      expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
    }
  );

  it('creates with the desired tags on the local and the cross-region replica', async () => {
    await provider.create('G', TYPE, {
      ...BASE,
      Replicas: [
        { Region: 'us-east-1', Tags: DESIRED },
        { Region: 'eu-west-1', Tags: [{ Key: 'eu', Value: '' }] },
      ],
    });
    const create = commands().find((c) => c instanceof CreateTableCommand) as CreateTableCommand;
    expect(create.input.Tags).toEqual([
      { Key: 'keep', Value: 'same' },
      { Key: 'add', Value: '' },
    ]);
    expect(tagCallsOn(EU_ARN)).toEqual([
      ['TagResourceCommand', { ResourceArn: EU_ARN, Tags: [{ Key: 'eu', Value: '' }] }],
    ]);
  });
});
