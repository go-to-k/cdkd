import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateClusterCommand,
  CreateServiceCommand,
  DescribeClustersCommand,
  RegisterTaskDefinitionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';

// go-to-k/cdkd#3994: the ECS Tags diff read a malformed side as empty, so a
// malformed DESIRED Tags (a rollback / drift --revert desired bag) untagged
// every recorded key. Cluster, TaskDefinition and Service all take a CFn
// `[{ Key, Value }]` list; TaskDefinition's update is always refused as
// replacement-only, so it has no update-path tag diff.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
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

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const CLUSTER_ARN = 'arn:aws:ecs:us-east-1:123456789012:cluster/c';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/c/s';
const TD_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/f:1';
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

/** The update-path types: [type, physicalId, the ARN the tag calls target, base props]. */
const UPDATE_TYPES: Array<[string, string, string, Record<string, unknown>]> = [
  ['AWS::ECS::Cluster', 'c', CLUSTER_ARN, {}],
  ['AWS::ECS::Service', SERVICE_ARN, SERVICE_ARN, { Cluster: 'c', ServiceName: 's' }],
];
const CREATE_TYPES = ['AWS::ECS::Cluster', 'AWS::ECS::TaskDefinition', 'AWS::ECS::Service'];

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

describe('ECSProvider Tags (go-to-k/cdkd#3994)', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof DescribeClustersCommand
        ? { clusters: [{ clusterArn: CLUSTER_ARN, clusterName: 'c' }] }
        : cmd instanceof CreateClusterCommand
          ? { cluster: { clusterArn: CLUSTER_ARN, clusterName: 'c' } }
          : cmd instanceof RegisterTaskDefinitionCommand
            ? { taskDefinition: { taskDefinitionArn: TD_ARN } }
            : cmd instanceof UpdateServiceCommand || cmd instanceof CreateServiceCommand
              ? { service: { serviceArn: SERVICE_ARN, serviceName: 's', status: 'ACTIVE' } }
              : {}
    );
    provider = new ECSProvider();
  });

  describe.each(CREATE_TYPES)('%s create', (type) => {
    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s before any call',
      async (_label, tags) => {
        const err = await refusal(() => provider.create('R', type, { Tags: tags }));
        expect(err.message).toContain(`Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );
  });

  describe.each(UPDATE_TYPES)('%s update', (type, physicalId, arn, base) => {
    it.each(PROVIDER_MALFORMED_DESIRED)(
      'refuses a desired %s before any call',
      async (_label, tags) => {
        const err = await refusal(() =>
          provider.update('R', physicalId, type, { ...base, Tags: tags }, { ...base, Tags: RECORDED })
        );
        expect(err.message).toContain(`desired Tags of ${type} R`);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(PROVIDER_MALFORMED_RECORDED)(
      'applies a recorded %s ADD-only: tags every desired key, untags nothing',
      async (_label, recorded) => {
        await provider.update(
          'R',
          physicalId,
          type,
          { ...base, Tags: DESIRED },
          { ...base, Tags: recorded }
        );
        expect(tagCalls()).toEqual([
          [
            'TagResourceCommand',
            {
              resourceArn: arn,
              tags: [
                { key: 'keep', value: 'same' },
                { key: 'add', value: '' },
              ],
            },
          ],
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
        // Names the LOGICAL id, never an ARN / URL / physical name.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${type} R is not`));
        expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
      }
    );

    it('diffs a valid pair into exact Tag / Untag calls', async () => {
      await provider.update(
        'R',
        physicalId,
        type,
        { ...base, Tags: DESIRED },
        { ...base, Tags: RECORDED }
      );
      expect(tagCalls()).toEqual([
        ['UntagResourceCommand', { resourceArn: arn, tagKeys: ['drop'] }],
        ['TagResourceCommand', { resourceArn: arn, tags: [{ key: 'add', value: '' }] }],
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never untags a recorded secret-derived key', async () => {
      await provider.update(
        'R',
        physicalId,
        type,
        { ...base, Tags: [] },
        { ...base, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
      );
      expect(tagCalls()).toEqual([
        ['UntagResourceCommand', { resourceArn: arn, tagKeys: ['keep', 'drop'] }],
      ]);
    });

    it('warns about a recorded secret-derived key it cannot remove', async () => {
      await provider.update(
        'R',
        physicalId,
        type,
        { ...base, Tags: [{ Key: 'keep', Value: 'same' }] },
        { ...base, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
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
  });

  it('creates a Cluster with the desired tags in ECS shape', async () => {
    await provider.create('C', 'AWS::ECS::Cluster', { ClusterName: 'c', Tags: DESIRED });
    const create = commands().find((c) => c instanceof CreateClusterCommand) as CreateClusterCommand;
    expect(create.input.tags).toEqual([
      { key: 'keep', value: 'same' },
      { key: 'add', value: '' },
    ]);
  });

  it('creates a Service with the desired tags in ECS shape', async () => {
    const saved = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
    try {
      await provider.create('S', 'AWS::ECS::Service', {
        Cluster: 'c',
        ServiceName: 's',
        TaskDefinition: TD_ARN,
        Tags: DESIRED,
      });
    } finally {
      if (saved === undefined) delete process.env['CDKD_NO_WAIT'];
      else process.env['CDKD_NO_WAIT'] = saved;
    }
    const create = commands().find((c) => c instanceof CreateServiceCommand) as CreateServiceCommand;
    expect(create.input.tags).toEqual([
      { key: 'keep', value: 'same' },
      { key: 'add', value: '' },
    ]);
  });

  it('registers a TaskDefinition with the desired tags in ECS shape', async () => {
    await provider.create('T', 'AWS::ECS::TaskDefinition', {
      Family: 'f',
      ContainerDefinitions: [{ Name: 'app', Image: 'nginx' }],
      Tags: DESIRED,
    });
    const reg = commands().find(
      (c) => c instanceof RegisterTaskDefinitionCommand
    ) as RegisterTaskDefinitionCommand;
    expect(reg.input.tags).toEqual([
      { key: 'keep', value: 'same' },
      { key: 'add', value: '' },
    ]);
  });
});
