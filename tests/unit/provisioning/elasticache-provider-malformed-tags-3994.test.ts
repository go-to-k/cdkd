import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AddTagsToResourceCommand,
  CreateCacheClusterCommand,
  CreateCacheSubnetGroupCommand,
  ListTagsForResourceCommand,
  ModifyCacheSubnetGroupCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-elasticache';

// go-to-k/cdkd#3994: the ElastiCache Tags diff read a malformed side as empty, so
// a malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
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

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const ARN = 'arn:aws:rds:us-east-1:123456789012:res:r';
const PHYSICAL_ID = 'r';
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

// One response carrying every shape the create / describe / wait paths read.
const RESPONSE = {
  DBCluster: {
    DBClusterIdentifier: 'r',
    DBClusterArn: ARN,
    Status: 'available',
  },
  DBClusters: [{ DBClusterIdentifier: 'r', DBClusterArn: ARN, Status: 'available' }],
  DBInstance: {
    DBInstanceIdentifier: 'r',
    DBInstanceArn: ARN,
    DBInstanceStatus: 'available',
  },
  DBInstances: [
    {
      DBInstanceIdentifier: 'r',
      DBInstanceArn: ARN,
      DBInstanceStatus: 'available',
    },
  ],
  DBSubnetGroup: { DBSubnetGroupName: 'r', DBSubnetGroupArn: ARN },
  DBSubnetGroups: [{ DBSubnetGroupName: 'r', DBSubnetGroupArn: ARN }],
  CacheCluster: { CacheClusterId: 'r', ARN, CacheClusterStatus: 'available' },
  CacheClusters: [{ CacheClusterId: 'r', ARN, CacheClusterStatus: 'available' }],
  CacheSubnetGroup: { CacheSubnetGroupName: 'r', ARN },
  MetricAlarms: [{ AlarmName: 'r', AlarmArn: ARN }],
};

const CASES = [
  {
    type: 'AWS::ElastiCache::CacheCluster',
    create: CreateCacheClusterCommand,
    props: {
      Engine: 'redis',
      CacheNodeType: 'cache.t3.micro',
      NumCacheNodes: 1,
    },
  },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof AddTagsToResourceCommand || c instanceof RemoveTagsFromResourceCommand
    ) as Array<AddTagsToResourceCommand | RemoveTagsFromResourceCommand>
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

describe.each(CASES)(
  'ElastiCacheProvider $type Tags (go-to-k/cdkd#3994)',
  ({ type, create, props }) => {
    let provider: ElastiCacheProvider;
    const savedNoWait = process.env['CDKD_NO_WAIT'];

    beforeEach(() => {
      vi.clearAllMocks();
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockImplementation(async (cmd: unknown) =>
        cmd instanceof AddTagsToResourceCommand || cmd instanceof RemoveTagsFromResourceCommand
          ? {}
          : RESPONSE
      );
      provider = new ElastiCacheProvider();
    });

    afterEach(() => {
      if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
      else process.env['CDKD_NO_WAIT'] = savedNoWait;
    });

    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on update before any call',
      async (_label, tags) => {
        const err = await refusal(() =>
          provider.update(
            'R',
            PHYSICAL_ID,
            type,
            { ...props, Tags: tags },
            { ...props, Tags: RECORDED }
          )
        );
        expect(err.message).toContain(`desired Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s on create before any call',
      async (_label, tags) => {
        const err = await refusal(() => provider.create('R', type, { ...props, Tags: tags }));
        expect(err.message).toContain(`Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_RECORDED)(
      'applies a recorded %s ADD-only: tags every desired key, untags nothing',
      async (_label, recorded) => {
        await provider.update(
          'R',
          PHYSICAL_ID,
          type,
          { ...props, Tags: DESIRED },
          { ...props, Tags: recorded }
        );
        expect(tagCalls()).toEqual([
          [
            'AddTagsToResourceCommand',
            {
              ResourceName: ARN,
              Tags: [
                { Key: 'keep', Value: 'same' },
                { Key: 'add', Value: '' },
              ],
            },
          ],
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
        expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
        // The warning names the LOGICAL id, never the ARN / URL / physical name.
        expect(String(warn.mock.calls[0]?.[0])).toContain(`${type} R is not`);
      }
    );

    it('diffs a valid pair into exact Tag / Untag calls', async () => {
      await provider.update(
        'R',
        PHYSICAL_ID,
        type,
        { ...props, Tags: DESIRED },
        { ...props, Tags: RECORDED }
      );
      expect(tagCalls()).toEqual([
        ['RemoveTagsFromResourceCommand', { ResourceName: ARN, TagKeys: ['drop'] }],
        ['AddTagsToResourceCommand', { ResourceName: ARN, Tags: [{ Key: 'add', Value: '' }] }],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never untags a recorded secret-derived key', async () => {
      await provider.update(
        'R',
        PHYSICAL_ID,
        type,
        { ...props, Tags: [] },
        {
          ...props,
          Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED],
        }
      );
      expect(tagCalls()).toEqual([
        ['RemoveTagsFromResourceCommand', { ResourceName: ARN, TagKeys: ['keep', 'drop'] }],
      ]);
    });

    it('warns about a recorded secret-derived key it cannot remove', async () => {
      await provider.update(
        'R',
        PHYSICAL_ID,
        type,
        { ...props, Tags: [{ Key: 'keep', Value: 'same' }] },
        { ...props, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
      );
      expect(tagCalls()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`${type} R holds 1 key(s) derived from a dynamic reference`)
      );
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('issue3994/tags');
    });

    it('creates with the desired tags', async () => {
      await provider.create('R', type, { ...props, Tags: DESIRED });
      const call = commands().find((c) => c instanceof create) as InstanceType<typeof create>;
      expect(call.input.Tags).toEqual(DESIRED);
    });
  }
);

// AWS::ElastiCache::SubnetGroup declared `Tags` handled and never sent it, so a
// group created before go-to-k/cdkd#3994 holds none of its recorded tags. The
// update therefore diffs the desired tags against the LIVE set.
describe('ElastiCacheProvider AWS::ElastiCache::SubnetGroup Tags (go-to-k/cdkd#3994)', () => {
  const TYPE = 'AWS::ElastiCache::SubnetGroup';
  const SG_ARN = 'arn:aws:elasticache:us-east-1:123456789012:subnetgroup:r';
  const PROPS = { Description: 'd', SubnetIds: ['subnet-1'] };
  let provider: ElastiCacheProvider;
  let live: Array<{ Key: string; Value: string }>;
  let arn: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    live = [];
    arn = SG_ARN;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ModifyCacheSubnetGroupCommand) {
        return { CacheSubnetGroup: { CacheSubnetGroupName: 'r', ARN: arn } };
      }
      if (cmd instanceof ListTagsForResourceCommand) return { TagList: live };
      return {};
    });
    provider = new ElastiCacheProvider();
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: tags }, { ...PROPS, Tags: RECORDED })
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} R`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      await refusal(() => provider.create('R', TYPE, { ...PROPS, Tags: tags }));
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('creates with the desired tags', async () => {
    await provider.create('R', TYPE, { ...PROPS, Tags: DESIRED });
    const call = commands().find(
      (c) => c instanceof CreateCacheSubnetGroupCommand
    ) as CreateCacheSubnetGroupCommand;
    expect(call.input.Tags).toEqual(DESIRED);
  });

  it('diffs the desired tags against the live set', async () => {
    live = RECORDED;
    await provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: DESIRED }, { ...PROPS, Tags: RECORDED });
    expect(tagCalls()).toEqual([
      ['RemoveTagsFromResourceCommand', { ResourceName: SG_ARN, TagKeys: ['drop'] }],
      ['AddTagsToResourceCommand', { ResourceName: SG_ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
  });

  it('applies the recorded tags a pre-fix group never received', async () => {
    live = [];
    await provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: DESIRED }, { ...PROPS, Tags: DESIRED });
    expect(tagCalls()).toEqual([['AddTagsToResourceCommand', { ResourceName: SG_ARN, Tags: DESIRED }]]);
  });

  it('never removes a recorded key the pre-fix group never held (no TagNotFoundFault)', async () => {
    live = [];
    await provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: [] }, { ...PROPS, Tags: RECORDED });
    expect(tagCalls()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['empty', { Tags: [] }],
    ['absent', {}],
  ])('never removes a live key the record does not name (desired %s)', async (_label, desired) => {
    live = [
      { Key: 'keep', Value: 'same' },
      { Key: 'access-tier', Value: 'restricted' },
    ];
    await provider.update(
      'R',
      PHYSICAL_ID,
      TYPE,
      { ...PROPS, ...desired },
      { ...PROPS, Tags: [{ Key: 'keep', Value: 'same' }] }
    );
    expect(tagCalls()).toEqual([
      ['RemoveTagsFromResourceCommand', { ResourceName: SG_ARN, TagKeys: ['keep'] }],
    ]);
  });

  it('warns about a recorded secret-derived key and removes nothing for it', async () => {
    live = [{ Key: 'keep', Value: 'same' }];
    await provider.update(
      'R',
      PHYSICAL_ID,
      TYPE,
      { ...PROPS, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...PROPS, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    expect(tagCalls()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${TYPE} R holds 1 key(s) derived from a dynamic reference`)
    );
  });

  it('throws when ModifyCacheSubnetGroup returns no ARN', async () => {
    arn = undefined;
    await expect(
      provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: DESIRED }, { ...PROPS, Tags: RECORDED })
    ).rejects.toThrow(/^Could not resolve the ARN of CacheSubnetGroup R; its Tags were not updated$/);
    expect(tagCalls()).toEqual([]);
  });

  it('flattens the logical id in the missing-ARN error', async () => {
    arn = undefined;
    await expect(
      provider.update('S\nX', PHYSICAL_ID, TYPE, { ...PROPS, Tags: DESIRED }, { ...PROPS, Tags: RECORDED })
    ).rejects.toThrow(/^Could not resolve the ARN of CacheSubnetGroup S X; its Tags were not updated$/);
  });

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: untags no live key, warns',
    async (_label, recorded) => {
      live = [
        { Key: 'keep', Value: 'same' },
        { Key: 'operator', Value: 'x' },
      ];
      await provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS, Tags: DESIRED }, { ...PROPS, Tags: recorded });
      expect(tagCalls()).toEqual([
        ['AddTagsToResourceCommand', { ResourceName: SG_ARN, Tags: [{ Key: 'add', Value: '' }] }],
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${TYPE} R is not`);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('touches no tags when neither side declares Tags', async () => {
    live = RECORDED;
    await provider.update('R', PHYSICAL_ID, TYPE, { ...PROPS }, { ...PROPS });
    expect(commands().some((c) => c instanceof ListTagsForResourceCommand)).toBe(false);
    expect(tagCalls()).toEqual([]);
  });
});
