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
    ECSClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

/**
 * Every interrupt watch the provider starts, until it is disposed: a watch
 * left undisposed stays live for the rest of the command, so each test
 * asserts the set is empty afterwards. A SIGINT listener count cannot pin
 * this — the shared listener outlives every watch by design.
 */
const { openWatches } = vi.hoisted(() => ({ openWatches: new Set<object>() }));

vi.mock('../../../src/provisioning/interrupt-watch.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/provisioning/interrupt-watch.js')>(
    '../../../src/provisioning/interrupt-watch.js'
  );
  return {
    ...actual,
    startInterruptWatch: (what: string) => {
      const watch = actual.startInterruptWatch(what);
      const handle = {};
      openWatches.add(handle);
      return {
        ...watch,
        dispose: () => {
          openWatches.delete(handle);
          watch.dispose();
        },
      };
    },
  };
});

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

import {
  DescribeClustersCommand,
  PutClusterCapacityProvidersCommand,
  UpdateClusterCommand,
} from '@aws-sdk/client-ecs';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { clusterAttachmentsWait } from '../../../src/provisioning/providers/ecs/cluster-attachments.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

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
  let attachmentList: Array<Record<string, unknown>>;
  /** What PutClusterCapacityProviders answers (measured: UPDATE_IN_PROGRESS). */
  let putCluster: Record<string, unknown>;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
    clock = 0;
    sleeps = [];
    attachments = ['UPDATE_COMPLETE'];
    putFailures = [];
    updateFailures = [];
    attachmentList = [];
    putCluster = { clusterArn: ARN, attachmentsStatus: 'UPDATE_IN_PROGRESS' };
    clusterAttachmentsWait.sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    clusterAttachmentsWait.now = () => clock;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof PutClusterCapacityProvidersCommand) {
        const failure = putFailures.shift();
        if (failure) throw failure;
        return { cluster: putCluster };
      }
      if (command instanceof UpdateClusterCommand) {
        const failure = updateFailures.shift();
        if (failure) throw failure;
        return { cluster: { clusterArn: ARN } };
      }
      if (command instanceof DescribeClustersCommand) {
        const status = attachments.length > 1 ? attachments.shift() : attachments[0];
        return {
          clusters: [{ clusterArn: ARN, attachmentsStatus: status, attachments: attachmentList }],
        };
      }
      return {};
    });
  });

  afterEach(() => {
    clusterAttachmentsWait.sleep = realSleep;
    clusterAttachmentsWait.now = realNow;
    // Every wait disposed its interrupt watch, on every exit path. Cleared
    // before asserting, so one leak fails only the test that leaked it.
    const leaked = openWatches.size;
    openWatches.clear();
    expect(leaked).toBe(0);
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

  const putInput = (): Record<string, unknown> | undefined =>
    sent().find((s) => s.name === 'PutClusterCapacityProvidersCommand')?.input;
  const settingsOnlyTemplate = { ClusterSettings: BEFORE.ClusterSettings };

  it('clears both lists when the template stops declaring them, as CloudFormation does', async () => {
    await provider.update('Cluster', CLUSTER, TYPE, settingsOnlyTemplate, BEFORE);

    expect(putInput()?.['capacityProviders']).toEqual([]);
    expect(putInput()?.['defaultCapacityProviderStrategy']).toEqual([]);
  });

  it('clears on a rollback whose restored record declared no providers', async () => {
    // The revert arm: desired = the old record (none), previous = attempted.
    await provider.update('Cluster', CLUSTER, TYPE, settingsOnlyTemplate, PROVIDERS_AND_SETTINGS, {
      replayingState: true,
    });

    expect(putInput()?.['capacityProviders']).toEqual([]);
  });

  it('sends no Put when neither side holds providers', async () => {
    await provider.update('Cluster', CLUSTER, TYPE, settingsOnlyTemplate, {
      ...settingsOnlyTemplate,
      CapacityProviders: [],
      DefaultCapacityProviderStrategy: [],
    });

    expect(names()).not.toContain('PutClusterCapacityProvidersCommand');
    expect(sent().filter(isAttachmentsRead)).toHaveLength(0);
  });

  it('waits for the attachments after a providers-only Put before returning', async () => {
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE'];

    await provider.update(
      'Cluster',
      CLUSTER,
      TYPE,
      { ...PROVIDERS_AND_SETTINGS, ClusterSettings: BEFORE.ClusterSettings },
      BEFORE
    );

    const put = names().indexOf('PutClusterCapacityProvidersCommand');
    expect(names()).not.toContain('UpdateClusterCommand');
    expect(sent().slice(put + 1).filter(isAttachmentsRead).length).toBeGreaterThanOrEqual(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('fails the update when its own Put ends with the attachments UPDATE_FAILED', async () => {
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_FAILED'];
    attachmentList = [
      {
        id: 'att-1',
        type: 'as_policy',
        status: 'UPDATE_FAILED',
        details: [{ name: 'reason', value: 'scaling plan missing' }],
      },
    ];

    const failure = await provider
      .update('Cluster', CLUSTER, TYPE, PROVIDERS_AND_SETTINGS, BEFORE)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/attachments UPDATE_FAILED/);
    expect((failure as Error).message).toMatch(/reason=scaling plan missing/);
    expect(isMarkedNonRetryable(failure)).toBe(true);
    expect(names()).not.toContain('UpdateClusterCommand');
  });

  const failureOf = (props: Record<string, unknown>): Promise<unknown> =>
    provider
      .update('Cluster', CLUSTER, TYPE, props, BEFORE)
      .then(() => undefined)
      .catch((error: unknown) => error);

  it('does not fail over an UPDATE_FAILED a previous Put left, when this Put never shows in progress', async () => {
    putCluster = { clusterArn: ARN };
    attachments = ['UPDATE_FAILED'];
    attachmentList = [{ id: 'att-old', type: 'as_policy', status: 'UPDATE_FAILED' }];

    await provider.update('Cluster', CLUSTER, TYPE, PROVIDERS_AND_SETTINGS, BEFORE);

    expect(names()).toContain('UpdateClusterCommand');
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(openWatches.size).toBe(0);
  });

  it('fails when a Put without a status in its response is then seen in progress and ends UPDATE_FAILED', async () => {
    putCluster = { clusterArn: ARN };
    attachments = ['UPDATE_FAILED', 'UPDATE_IN_PROGRESS', 'UPDATE_FAILED'];

    const failure = await failureOf(PROVIDERS_AND_SETTINGS);

    expect((failure as Error).message).toMatch(/attachments UPDATE_FAILED/);
    expect(names()).not.toContain('UpdateClusterCommand');
  });

  it('fails when the Put response showed in progress and the first read is already UPDATE_FAILED', async () => {
    attachments = ['UPDATE_FAILED'];

    const failure = await failureOf(PROVIDERS_AND_SETTINGS);

    expect((failure as Error).message).toMatch(/attachments UPDATE_FAILED/);
    expect(sleeps).toEqual([]);
  });

  it('names only the attachments this Put touched', async () => {
    putCluster = {
      clusterArn: ARN,
      attachmentsStatus: 'UPDATE_IN_PROGRESS',
      attachments: [{ id: 'att-new', status: 'UPDATE_IN_PROGRESS' }],
    };
    attachments = ['UPDATE_FAILED'];
    attachmentList = [
      { id: 'att-new', type: 'as_policy', status: 'UPDATE_FAILED' },
      { id: 'att-stale', type: 'as_policy', status: 'DELETE_FAILED' },
    ];

    const failure = await failureOf(PROVIDERS_AND_SETTINGS);

    expect((failure as Error).message).toMatch(/att-new UPDATE_FAILED/);
    expect((failure as Error).message).not.toMatch(/att-stale/);
  });

  it('names a failed attachment the Put response did not list when none it listed failed', async () => {
    putCluster = {
      clusterArn: ARN,
      attachmentsStatus: 'UPDATE_IN_PROGRESS',
      attachments: [{ id: 'att-kept', status: 'UPDATE_IN_PROGRESS' }],
    };
    attachments = ['UPDATE_FAILED'];
    attachmentList = [
      { id: 'att-kept', type: 'as_policy', status: 'UPDATE_COMPLETE' },
      { id: 'att-created', type: 'as_policy', status: 'CREATE_FAILED' },
    ];

    const failure = await failureOf(PROVIDERS_AND_SETTINGS);

    expect((failure as Error).message).toMatch(/att-created CREATE_FAILED/);
  });

  describe('with the command owning interrupts', () => {
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    it('stops the stale-FAILED grace re-reads on Ctrl-C', async () => {
      putCluster = { clusterArn: ARN };
      attachments = ['UPDATE_FAILED'];
      clusterAttachmentsWait.sleep = async (ms: number) => {
        sleeps.push(ms);
        process.emit('SIGINT');
      };

      const failure = await failureOf(PROVIDERS_AND_SETTINGS);

      expect(isInterruptedWaitError(failure)).toBe(true);
      expect(sleeps).toEqual([1_000]);
      expect(names()).not.toContain('UpdateClusterCommand');
    });
  });

  it('does not fail on UPDATE_FAILED reached by waiting out a Put it did not send', async () => {
    updateFailures = [awsError('ServerException')];
    attachments = ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_FAILED'];

    await provider.update('Cluster', CLUSTER, TYPE, SETTINGS_ONLY, BEFORE);

    expect(names().filter((n) => n === 'UpdateClusterCommand')).toHaveLength(2);
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
