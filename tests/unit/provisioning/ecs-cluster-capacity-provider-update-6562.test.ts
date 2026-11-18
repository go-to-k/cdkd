import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6562: `PutClusterCapacityProviders` leaves the cluster's
 * attachments UPDATE_IN_PROGRESS for a few seconds, and ECS refuses the
 * next cluster write meanwhile (UpdateCluster with ServerException, a second
 * Put with UpdateInProgressException — both observed on a real cluster). A
 * deploy changing capacity providers and ClusterSettings together failed.
 * These cases pin that the Put is sent only on a capacity-provider change,
 * and that a write after a Put waits for the attachments to settle.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
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

import {
  DescribeClustersCommand,
  PutClusterCapacityProvidersCommand,
  UpdateClusterCommand,
} from '@aws-sdk/client-ecs';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { clusterAttachmentsWait } from '../../../src/provisioning/providers/ecs/cluster-attachments.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::ECS::Cluster';
const CLUSTER = 'my-cluster';
const ARN = `arn:aws:ecs:us-east-1:123456789012:cluster/${CLUSTER}`;

const STRATEGY = [{ CapacityProvider: 'FARGATE', Weight: 1 }];
const BEFORE = {
  CapacityProviders: ['FARGATE'],
  DefaultCapacityProviderStrategy: STRATEGY,
  ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
};
const PROVIDERS_AND_SETTINGS = {
  CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
  DefaultCapacityProviderStrategy: STRATEGY,
  ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
};
const SETTINGS_ONLY = { ...BEFORE, ClusterSettings: PROVIDERS_AND_SETTINGS.ClusterSettings };

const realSleep = clusterAttachmentsWait.sleep;
const realNow = clusterAttachmentsWait.now;

const awsError = (name: string): Error => Object.assign(new Error(name), { name });

type Sent = { name: string; input: Record<string, unknown> };
const sent = (): Sent[] =>
  mockSend.mock.calls.map((c) => ({
    name: (c[0] as { constructor: { name: string } }).constructor.name,
    input: (c[0] as { input: Record<string, unknown> }).input,
  }));
const names = (): string[] => sent().map((s) => s.name);
const isAttachmentsRead = (s: Sent): boolean =>
  s.name === 'DescribeClustersCommand' &&
  ((s.input['include'] as string[] | undefined) ?? []).includes('ATTACHMENTS');

describe('ECS Cluster update: capacity providers and settings (go-to-k/cdkd#6562)', () => {
  let provider: ECSProvider;
  let clock: number;
  let sleeps: number[];
  /** attachmentsStatus answers, consumed in order; the last one repeats. */
  let attachments: string[];
  let putFailures: Error[];
  let updateFailures: Error[];

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
    clock = 0;
    sleeps = [];
    attachments = ['UPDATE_COMPLETE'];
    putFailures = [];
    updateFailures = [];
    clusterAttachmentsWait.sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    clusterAttachmentsWait.now = () => clock;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof PutClusterCapacityProvidersCommand) {
        const failure = putFailures.shift();
        if (failure) throw failure;
        return { cluster: { clusterArn: ARN, attachmentsStatus: 'UPDATE_IN_PROGRESS' } };
      }
      if (command instanceof UpdateClusterCommand) {
        const failure = updateFailures.shift();
        if (failure) throw failure;
        return { cluster: { clusterArn: ARN } };
      }
      if (command instanceof DescribeClustersCommand) {
        const status = attachments.length > 1 ? attachments.shift() : attachments[0];
        return { clusters: [{ clusterArn: ARN, attachmentsStatus: status }] };
      }
      return {};
    });
  });

  afterEach(() => {
    clusterAttachmentsWait.sleep = realSleep;
    clusterAttachmentsWait.now = realNow;
  });

  it('sends no PutClusterCapacityProviders when only ClusterSettings changed', async () => {
    await provider.update('Cluster', CLUSTER, TYPE, SETTINGS_ONLY, BEFORE);

    expect(names()).not.toContain('PutClusterCapacityProvidersCommand');
    expect(names()).toContain('UpdateClusterCommand');
    expect(sent().filter(isAttachmentsRead)).toHaveLength(0);
  });

  it('waits for the attachments to leave UPDATE_IN_PROGRESS between the Put and UpdateCluster', async () => {
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE'];

    await provider.update('Cluster', CLUSTER, TYPE, PROVIDERS_AND_SETTINGS, BEFORE);

    const order = names();
    const put = order.indexOf('PutClusterCapacityProvidersCommand');
    const update = order.indexOf('UpdateClusterCommand');
    expect(put).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(put);
    const readsBetween = sent().slice(put + 1, update).filter(isAttachmentsRead);
    expect(readsBetween).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(names().filter((n) => n === 'UpdateClusterCommand')).toHaveLength(1);
  });

  it('re-sends a Put ECS refused with UpdateInProgressException once the attachments settle', async () => {
    putFailures = [awsError('UpdateInProgressException')];
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE'];

    await provider.update(
      'Cluster',
      CLUSTER,
      TYPE,
      { ...PROVIDERS_AND_SETTINGS, ClusterSettings: BEFORE.ClusterSettings },
      BEFORE
    );

    expect(names().filter((n) => n === 'PutClusterCapacityProvidersCommand')).toHaveLength(2);
    expect(names()).not.toContain('UpdateClusterCommand');
  });

  it('re-sends an UpdateCluster refused while a foreign Put is still attaching', async () => {
    updateFailures = [awsError('ServerException')];
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE'];

    await provider.update('Cluster', CLUSTER, TYPE, SETTINGS_ONLY, BEFORE);

    expect(names().filter((n) => n === 'UpdateClusterCommand')).toHaveLength(2);
  });

  it('rethrows a ServerException over settled attachments without re-sending', async () => {
    updateFailures = [awsError('ServerException')];

    await expect(provider.update('Cluster', CLUSTER, TYPE, SETTINGS_ONLY, BEFORE)).rejects.toThrow(
      /ServerException/
    );
    expect(names().filter((n) => n === 'UpdateClusterCommand')).toHaveLength(1);
  });

  it('still sends the Put on a rollback-shaped update whose providers differ', async () => {
    // The revert arm's desired bag is the OLD record and its previous side the
    // attempted one: the providers differ, so AWS must be put back.
    await provider.update('Cluster', CLUSTER, TYPE, BEFORE, PROVIDERS_AND_SETTINGS, {
      replayingState: true,
    });

    const put = sent().find((s) => s.name === 'PutClusterCapacityProvidersCommand');
    expect(put?.input['capacityProviders']).toEqual(['FARGATE']);
  });

  it('sends the Put when the previous side lacks the providers', async () => {
    const { CapacityProviders: _cp, DefaultCapacityProviderStrategy: _ds, ...noProviders } = BEFORE;
    await provider.update('Cluster', CLUSTER, TYPE, BEFORE, noProviders);

    expect(names()).toContain('PutClusterCapacityProvidersCommand');
  });

  it('treats a strategy entry spelled in another key order as unchanged', async () => {
    const readback = {
      ...BEFORE,
      DefaultCapacityProviderStrategy: [{ Weight: 1, CapacityProvider: 'FARGATE' }],
    };
    await provider.update('Cluster', CLUSTER, TYPE, BEFORE, readback, {
      desiredFromAwsReadback: true,
    });

    expect(names()).not.toContain('PutClusterCapacityProvidersCommand');
  });

  it('gives up non-retryably when the attachments never settle', async () => {
    attachments = ['UPDATE_IN_PROGRESS'];

    const failure = await provider
      .update('Cluster', CLUSTER, TYPE, PROVIDERS_AND_SETTINGS, BEFORE)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/still UPDATE_IN_PROGRESS after 600s/);
    expect((failure as Error).message).toMatch(/--resource-timeout AWS::ECS::Cluster=/);
    expect(isMarkedNonRetryable(failure)).toBe(true);
    expect(names()).not.toContain('UpdateClusterCommand');
  });
});
