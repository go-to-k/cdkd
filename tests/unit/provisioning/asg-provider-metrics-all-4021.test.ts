import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4021: a MetricsCollection entry with no Metrics enables ALL
// metrics, but AWS's EnabledMetrics (and so the readback) lists them one by
// one. A template-shaped ALL baseline therefore drifted forever. The drift
// canonicalizer now spells ALL out as the documented metric set, so ALL
// compares equal to the full enumeration and still differs from any subset.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
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
  DisableMetricsCollectionCommand,
  EnableMetricsCollectionCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  ALL_GROUP_METRICS,
  ASGProvider,
} from '../../../src/provisioning/providers/asg-provider.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';

/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';

/** What `readCurrentState` reports for a group with `metrics` enabled at 1Minute. */
async function readbackFor(provider: ASGProvider, metrics: readonly string[]) {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
      return Promise.resolve({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'my-asg',
            MinSize: 0,
            MaxSize: 0,
            // AWS's order is its own; the readback sorts.
            EnabledMetrics: [...metrics].reverse().map((Metric) => ({ Metric, Granularity: '1Minute' })),
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  return (bagOf(await provider.readCurrentState('my-asg', 'MyAsg', TYPE)))!;
}

/** What `cdkd drift` compares: the per-side pass on each bag, then the pair pass. */
async function compared(
  provider: ASGProvider,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  return provider.canonicalizeDriftPair(
    TYPE,
    provider.canonicalizeDriftProperties(TYPE, baseline),
    provider.canonicalizeDriftProperties(TYPE, aws)
  );
}

describe('ASGProvider drift — an ALL MetricsCollection baseline (#4021)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ASGProvider();
  });

  it('the known set holds the 25 live-observed metric names, distinct and sorted', () => {
    expect(ALL_GROUP_METRICS).toHaveLength(25);
    expect(new Set(ALL_GROUP_METRICS).size).toBe(25);
    expect([...ALL_GROUP_METRICS]).toEqual([...ALL_GROUP_METRICS].sort());
    // The five the SDK doc omits, observed live on 2026-09-28.
    for (const m of [
      'GroupTerminatingRetainedCapacity',
      'GroupTerminatingRetainedInstances',
      'WarmPoolMinSize',
      'WarmPoolPendingRetainedCapacity',
      'WarmPoolTerminatingRetainedCapacity',
    ]) {
      expect(ALL_GROUP_METRICS).toContain(m);
    }
  });

  it.each([
    ['omitted', { Granularity: '1Minute' }],
    ['empty', { Granularity: '1Minute', Metrics: [] }],
    ['null', { Granularity: '1Minute', Metrics: null }],
  ])('an ALL baseline (Metrics %s) compares clean against the full known readback', async (_l, entry) => {
    const readback = await readbackFor(provider, ALL_GROUP_METRICS);
    const out = await compared(provider, { MetricsCollection: [entry] }, readback);
    expect(out.baseline['MetricsCollection']).toEqual(out.aws['MetricsCollection']);
    // Non-vacuity: the raw shapes differ.
    expect([entry]).not.toEqual(readback['MetricsCollection']);
  });

  // A metric AWS adds later: the readback is a SUPERSET of the known set.
  it('an ALL baseline compares clean against the known set plus an unknown metric', async () => {
    const readback = await readbackFor(provider, [...ALL_GROUP_METRICS, 'GroupFutureMetric']);
    const out = await compared(provider, { MetricsCollection: [{ Granularity: '1Minute' }] }, readback);
    expect(out.baseline['MetricsCollection']).toEqual(out.aws['MetricsCollection']);
  });

  it('an ALL baseline differs from a readback missing one known metric, by exactly that metric', async () => {
    const readback = await readbackFor(
      provider,
      ALL_GROUP_METRICS.filter((m) => m !== 'GroupMinSize')
    );
    const out = await compared(provider, { MetricsCollection: [{ Granularity: '1Minute' }] }, readback);
    expect(out.baseline['MetricsCollection']).not.toEqual(out.aws['MetricsCollection']);
    const b = (out.baseline['MetricsCollection'] as Array<{ Metrics: string[] }>)[0]!.Metrics;
    const a = (out.aws['MetricsCollection'] as Array<{ Metrics: string[] }>)[0]!.Metrics;
    expect(b.filter((m) => !a.includes(m))).toEqual(['GroupMinSize']);
    expect(a.filter((m) => !b.includes(m))).toEqual([]);
  });

  it('only ADDS to the baseline and never rewrites the readback side', async () => {
    const readback = await readbackFor(provider, ['GroupFutureMetric', 'GroupMaxSize']);
    const canonicalAws = provider.canonicalizeDriftProperties(TYPE, readback);
    const out = await compared(provider, { MetricsCollection: [{ Granularity: '1Minute' }] }, readback);
    expect(out.aws).toBe(canonicalAws);
    const b = (out.baseline['MetricsCollection'] as Array<{ Metrics: string[] }>)[0]!.Metrics;
    expect(b).toEqual([...new Set([...ALL_GROUP_METRICS, 'GroupFutureMetric'])].sort());
  });

  it('leaves an explicit-metrics baseline and other types alone (by identity)', async () => {
    const readback = await readbackFor(provider, ALL_GROUP_METRICS);
    const explicit = { MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMinSize'] }] };
    const out = await provider.canonicalizeDriftPair(TYPE, explicit, readback);
    expect(out.baseline).toBe(explicit);
    const other = { MetricsCollection: [{ Granularity: '1Minute' }] };
    const out2 = await provider.canonicalizeDriftPair('AWS::SQS::Queue', other, readback);
    expect(out2.baseline).toBe(other);
  });
});

// `drift --revert` sends its baseline through the PAIR pass as the desired
// side (drift.ts runRevert), with the raw readback as the previous one. For a
// legacy ALL record with GroupMinSize disabled out of band that is the known set
// UNION the readback against the readback: one Enable, sent as ALL, no Disable.
describe('ASGProvider update — revert of an ALL baseline (#4021)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('re-enables the missing metric and disables nothing, an unknown live metric included', async () => {
    const provider = new ASGProvider();
    const live = [...ALL_GROUP_METRICS.filter((m) => m !== 'GroupMinSize'), 'GroupFutureMetric'];
    const readback = { MetricsCollection: [{ Granularity: '1Minute', Metrics: [...live].sort() }] };
    const desired = (
      await provider.canonicalizeDriftPair(
        TYPE,
        { AutoScalingGroupName: 'my-asg', MetricsCollection: [{ Granularity: '1Minute' }] },
        readback
      )
    ).baseline;
    await provider.update('MyAsg', 'my-asg', TYPE, desired, {
      AutoScalingGroupName: 'my-asg',
      ...readback,
    });
    const calls = mockSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c) =>
          c instanceof EnableMetricsCollectionCommand ||
          c instanceof DisableMetricsCollectionCommand
      )
      .map((c) => ({
        name: (c as { constructor: { name: string } }).constructor.name,
        input: (c as unknown as { input: Record<string, unknown> }).input,
      }));
    // Sent as AWS's own ALL (no Metrics), not as the expanded list: several
    // known names are observed, not documented as accepted.
    expect(calls).toEqual([
      {
        name: 'EnableMetricsCollectionCommand',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute' },
      },
    ]);
  });

  // A removal in the same call: ALL would re-enable the metric just disabled.
  it('sends the known set as an explicit list when the same update disables a metric', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [{ Granularity: '1Minute', Metrics: [...ALL_GROUP_METRICS] }],
      },
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [
          { Granularity: '1Minute', Metrics: [...ALL_GROUP_METRICS, 'GroupFutureMetric'] },
        ],
      }
    );
    const calls = mockSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c) =>
          c instanceof EnableMetricsCollectionCommand ||
          c instanceof DisableMetricsCollectionCommand
      )
      .map((c) => (c as unknown as { input: Record<string, unknown> }).input);
    expect(calls).toEqual([
      { AutoScalingGroupName: 'my-asg', Metrics: ['GroupFutureMetric'] },
      { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [...ALL_GROUP_METRICS] },
    ]);
  });

  it('create sends an entry listing every known metric as ALL too', async () => {
    const provider = new ASGProvider();
    await provider.create('MyAsg', TYPE, {
      AutoScalingGroupName: 'my-asg',
      MinSize: 0,
      MaxSize: 1,
      MetricsCollection: [{ Granularity: '1Minute', Metrics: [...ALL_GROUP_METRICS] }],
    });
    const enable = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof EnableMetricsCollectionCommand) as unknown as {
      input: Record<string, unknown>;
    };
    expect(enable.input).toEqual({ AutoScalingGroupName: 'my-asg', Granularity: '1Minute' });
  });

  it('still sends an explicit list that lacks a known metric as that list', async () => {
    const provider = new ASGProvider();
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMinSize', 'GroupMaxSize'] }],
      },
      { AutoScalingGroupName: 'my-asg' }
    );
    const enable = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof EnableMetricsCollectionCommand) as unknown as {
      input: Record<string, unknown>;
    };
    expect(enable.input['Metrics']).toEqual(['GroupMaxSize', 'GroupMinSize']);
  });
});
