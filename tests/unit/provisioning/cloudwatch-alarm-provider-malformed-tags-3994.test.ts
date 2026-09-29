import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  PutMetricAlarmCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-cloudwatch';

// go-to-k/cdkd#3994: the CloudWatch alarm Tags diff read a malformed side as empty, so
// a malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

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

import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
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
  MetricAlarms: [{ AlarmName: 'r', AlarmArn: ARN }],
};

const CASES = [
  {
    type: 'AWS::CloudWatch::Alarm',
    create: PutMetricAlarmCommand,
    props: {
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Statistic: 'Average',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 80,
      EvaluationPeriods: 1,
      Period: 60,
    },
  },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function tagCalls(): Array<[string, unknown]> {
  return (
    commands().filter(
      (c) => c instanceof TagResourceCommand || c instanceof UntagResourceCommand
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

describe.each(CASES)(
  'CloudWatchAlarmProvider $type Tags (go-to-k/cdkd#3994)',
  ({ type, create, props }) => {
    let provider: CloudWatchAlarmProvider;
    const savedNoWait = process.env['CDKD_NO_WAIT'];

    beforeEach(() => {
      vi.clearAllMocks();
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockImplementation(async (cmd: unknown) =>
        cmd instanceof TagResourceCommand || cmd instanceof UntagResourceCommand ? {} : RESPONSE
      );
      provider = new CloudWatchAlarmProvider();
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
            'TagResourceCommand',
            {
              ResourceARN: ARN,
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
        ['UntagResourceCommand', { ResourceARN: ARN, TagKeys: ['drop'] }],
        ['TagResourceCommand', { ResourceARN: ARN, Tags: [{ Key: 'add', Value: '' }] }],
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
        ['UntagResourceCommand', { ResourceARN: ARN, TagKeys: ['keep', 'drop'] }],
      ]);
    });

    it('warns about a recorded secret-derived key it cannot remove', async () => {
      await provider.update(
        'R',
        PHYSICAL_ID,
        type,
        { ...props, Tags: [{ Key: 'keep', Value: 'same' }] },
        {
          ...props,
          Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }],
        }
      );
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned).toContainEqual(
        expect.stringContaining(`${type} R holds 1 key(s) derived from a dynamic reference`)
      );
      expect(warned.join('\n')).not.toContain('issue3994/tags');
      const sent = [mockSend].flatMap((m) =>
        m.mock.calls.map((c) => (c[0] as object).constructor.name)
      );
      expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
    });

    it('creates with the desired tags', async () => {
      await provider.create('R', type, { ...props, Tags: DESIRED });
      const call = commands().find((c) => c instanceof create) as InstanceType<typeof create>;
      expect(call.input.Tags).toEqual(DESIRED);
    });
  }
);
