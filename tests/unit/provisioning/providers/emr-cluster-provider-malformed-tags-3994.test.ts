import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3994: the EMR Cluster Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { EMRClusterProvider } from '../../../../src/provisioning/providers/emr-cluster-provider.js';
import {
  AddTagsCommand,
  DescribeClusterCommand,
  RemoveTagsCommand,
  RunJobFlowCommand,
} from '@aws-sdk/client-emr';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from '../tag-list-fixtures.js';

const TYPE = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const BASE = {
  Name: 'my-emr-cluster',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: {
    Ec2SubnetId: 'subnet-abc',
    MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge' },
  },
};
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
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

describe('EMRClusterProvider Cluster Tags (go-to-k/cdkd#3994)', () => {
  let provider: EMRClusterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof RunJobFlowCommand) return { JobFlowId: CLUSTER_ID };
      if (cmd instanceof DescribeClusterCommand) {
        return { Cluster: { Id: CLUSTER_ID, Status: { State: 'WAITING' } } };
      }
      return {};
    });
    provider = new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'C',
          CLUSTER_ID,
          TYPE,
          { ...BASE, VisibleToAllUsers: false, Tags: tags },
          { ...BASE, VisibleToAllUsers: true, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('C', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update(
        'C',
        CLUSTER_ID,
        TYPE,
        { ...BASE, Tags: DESIRED },
        { ...BASE, Tags: recorded }
      );
      expect(commands().some((c) => c instanceof RemoveTagsCommand)).toBe(false);
      const add = commands().filter((c) => c instanceof AddTagsCommand) as AddTagsCommand[];
      expect(add.map((c) => c.input)).toEqual([{ ResourceId: CLUSTER_ID, Tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} C is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Add / Remove calls', async () => {
    await provider.update(
      'C',
      CLUSTER_ID,
      TYPE,
      { ...BASE, Tags: DESIRED },
      { ...BASE, Tags: RECORDED }
    );
    const tagCalls = commands().filter(
      (c) => c instanceof AddTagsCommand || c instanceof RemoveTagsCommand
    ) as Array<AddTagsCommand | RemoveTagsCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['RemoveTagsCommand', { ResourceId: CLUSTER_ID, TagKeys: ['drop'] }],
      ['AddTagsCommand', { ResourceId: CLUSTER_ID, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'C',
      CLUSTER_ID,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const remove = commands().filter((c) => c instanceof RemoveTagsCommand) as RemoveTagsCommand[];
    expect(remove.map((c) => c.input.TagKeys)).toEqual([['keep', 'drop']]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'C',
      CLUSTER_ID,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} C holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('runs the job flow with the desired tags', async () => {
    await provider.create('C', TYPE, { ...BASE, Tags: DESIRED });
    const run = commands().find((c) => c instanceof RunJobFlowCommand) as RunJobFlowCommand;
    expect(run.input.Tags).toEqual(DESIRED);
  });

  it('runs the job flow with no Tags field when Tags is absent', async () => {
    await provider.create('C', TYPE, { ...BASE });
    const run = commands().find((c) => c instanceof RunJobFlowCommand) as RunJobFlowCommand;
    expect(run.input.Tags).toBeUndefined();
  });
});
