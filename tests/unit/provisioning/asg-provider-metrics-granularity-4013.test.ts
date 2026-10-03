import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4013: CDK renders one `MetricsCollection` entry per
// `GroupMetrics`, all at `1Minute`, while AWS holds ONE set of enabled metrics
// per granularity. The update diff keyed the raw entries by granularity, so
// only the LAST entry survived on each side; and a template-shaped drift
// baseline never matched the readback's single entry. Both now fold the list
// the way AWS holds it: the union per granularity, no Metrics meaning ALL.

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
  ASGProvider,
  foldMetricsCollection,
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
const MIN = 'GroupMinSize';
const MAX = 'GroupMaxSize';
const DESIRED = 'GroupDesiredCapacity';
const IN_SERVICE = 'GroupInServiceInstances';

function metricCalls(): Array<{ op: 'enable' | 'disable'; input: Record<string, unknown> }> {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (c) => c instanceof EnableMetricsCollectionCommand || c instanceof DisableMetricsCollectionCommand
    )
    .map((c) => ({
      op: c instanceof EnableMetricsCollectionCommand ? ('enable' as const) : ('disable' as const),
      input: (c as unknown as { input: Record<string, unknown> }).input,
    }));
}

describe('foldMetricsCollection (#4013)', () => {
  it('unions the metrics of every entry at a granularity, sorted', () => {
    expect(
      foldMetricsCollection([
        { Granularity: '1Minute', Metrics: [MIN, MAX] },
        { Granularity: '1Minute', Metrics: [DESIRED, MIN] },
      ])
    ).toEqual([{ Granularity: '1Minute', Metrics: [DESIRED, MAX, MIN] }]);
  });

  it.each([
    ['omitted', { Granularity: '1Minute' }],
    ['empty', { Granularity: '1Minute', Metrics: [] }],
    ['null', { Granularity: '1Minute', Metrics: null }],
  ])('reads an entry with %s Metrics as ALL, which absorbs the others', (_l, allEntry) => {
    expect(
      foldMetricsCollection([{ Granularity: '1Minute', Metrics: [MIN] }, allEntry])
    ).toEqual([{ Granularity: '1Minute' }]);
    expect(
      foldMetricsCollection([allEntry, { Granularity: '1Minute', Metrics: [MIN] }])
    ).toEqual([{ Granularity: '1Minute' }]);
  });

  it('is independent of entry split and order', () => {
    const a = foldMetricsCollection([
      { Granularity: '1Minute', Metrics: [MAX] },
      { Granularity: '1Minute', Metrics: [MIN, DESIRED] },
    ]);
    const b = foldMetricsCollection([{ Granularity: '1Minute', Metrics: [DESIRED, MIN, MAX] }]);
    expect(a).toEqual(b);
  });

  it('folds a non-array to the empty list and skips entries without a Granularity', () => {
    expect(foldMetricsCollection(undefined)).toEqual([]);
    expect(foldMetricsCollection({})).toEqual([]);
    expect(foldMetricsCollection([{ Metrics: [MIN] }, null])).toEqual([]);
  });
});

describe('ASGProvider update — several GroupMetrics entries (#4013)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ASGProvider();
  });

  async function update(next: unknown, prev: unknown): Promise<void> {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', MetricsCollection: next },
      { AutoScalingGroupName: 'my-asg', MetricsCollection: prev }
    );
  }

  // Pre-fix: only the LAST entry ([DESIRED]) was enabled.
  it('enables every entry when two GroupMetrics are added', async () => {
    await update(
      [
        { Granularity: '1Minute', Metrics: [MIN, MAX] },
        { Granularity: '1Minute', Metrics: [DESIRED] },
      ],
      []
    );
    expect(metricCalls()).toEqual([
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [DESIRED, MAX, MIN] },
      },
    ]);
  });

  // The integ arm's shape. Pre-fix both sides keyed to [DESIRED] (the LAST
  // entry), compared equal, and GroupMaxSize stayed enabled.
  it('disables a metric dropped from the FIRST of two entries', async () => {
    await update(
      [
        { Granularity: '1Minute', Metrics: [MIN] },
        { Granularity: '1Minute', Metrics: [DESIRED] },
      ],
      [
        { Granularity: '1Minute', Metrics: [MIN, MAX] },
        { Granularity: '1Minute', Metrics: [DESIRED] },
      ]
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [MAX] } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [DESIRED, MIN] },
      },
    ]);
  });

  it('removing an entry disables only the metrics no remaining entry names', async () => {
    await update(
      [{ Granularity: '1Minute', Metrics: [MIN, MAX] }],
      [
        { Granularity: '1Minute', Metrics: [MIN, MAX] },
        { Granularity: '1Minute', Metrics: [MAX, DESIRED] },
      ]
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [DESIRED] } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [MAX, MIN] },
      },
    ]);
  });

  it('sends nothing when only the entry split or order changed', async () => {
    await update(
      [{ Granularity: '1Minute', Metrics: [DESIRED, MIN, MAX] }],
      [
        { Granularity: '1Minute', Metrics: [MAX] },
        { Granularity: '1Minute', Metrics: [MIN, DESIRED] },
      ]
    );
    expect(metricCalls()).toEqual([]);
  });

  it('ALL to a subset clears everything, then enables the subset', async () => {
    await update([{ Granularity: '1Minute', Metrics: [IN_SERVICE] }], [{ Granularity: '1Minute' }]);
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg' } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [IN_SERVICE] },
      },
    ]);
  });

  it('a subset to ALL (one entry omitting Metrics) sends one Enable without Metrics', async () => {
    await update(
      [{ Granularity: '1Minute', Metrics: [MIN] }, { Granularity: '1Minute' }],
      [{ Granularity: '1Minute', Metrics: [MIN] }]
    );
    expect(metricCalls()).toEqual([
      { op: 'enable', input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute' } },
    ]);
  });

  it('dropping the property disables the whole union', async () => {
    await update(undefined, [
      { Granularity: '1Minute', Metrics: [MIN] },
      { Granularity: '1Minute', Metrics: [DESIRED] },
    ]);
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [DESIRED, MIN] } },
    ]);
  });
});

describe('ASGProvider update — MetricsCollection edge cases (#4013 review)', () => {
  let provider: ASGProvider;
  const SECRET = '{{resolve:secretsmanager:issue4013/metric:SecretString:v::}}';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ASGProvider();
  });

  // `cdkd drift --revert` sends the (folded) baseline as the desired bag and the
  // raw readback as the previous side; update() folds both again.
  it('a drift --revert of an out-of-band enable disables exactly the extra metric', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [{ Granularity: '1Minute', Metrics: [DESIRED, MIN] }],
      },
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [{ Granularity: '1Minute', Metrics: [DESIRED, MAX, MIN] }],
      }
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [MAX] } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [DESIRED, MIN] },
      },
    ]);
  });

  // DisableMetricsCollection has no Granularity: dropping one granularity also
  // disables a kept granularity's same metric, so the kept one is re-enabled.
  it('re-enables a kept granularity after another granularity was disabled', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [{ Granularity: '1Minute', Metrics: [MIN] }],
      },
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [
          { Granularity: '1Minute', Metrics: [MIN] },
          { Granularity: '5Minute', Metrics: [MIN] },
        ],
      }
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [MIN] } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [MIN] },
      },
    ]);
  });

  // Two KEPT granularities: one's shrink disables a metric the other still
  // wants. Every Disable goes first, then every desired granularity is enabled.
  it('sends every Disable before any Enable, so a kept granularity is not undone', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [
          { Granularity: '1Minute', Metrics: [MIN] },
          { Granularity: '5Minute', Metrics: [MAX] },
        ],
      },
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [
          { Granularity: '1Minute', Metrics: [MIN] },
          { Granularity: '5Minute', Metrics: [MIN, MAX] },
        ],
      }
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [MIN] } },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: [MIN] },
      },
      {
        op: 'enable',
        input: { AutoScalingGroupName: 'my-asg', Granularity: '5Minute', Metrics: [MAX] },
      },
    ]);
  });

  it('never sends a recorded secret-derived metric name, and drops an entry left empty', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg' },
      {
        AutoScalingGroupName: 'my-asg',
        MetricsCollection: [
          { Granularity: '1Minute', Metrics: [SECRET, MIN] },
          { Granularity: '1Minute', Metrics: [SECRET] },
        ],
      }
    );
    expect(metricCalls()).toEqual([
      { op: 'disable', input: { AutoScalingGroupName: 'my-asg', Metrics: [MIN] } },
    ]);
  });

  // Only a METRICS entry left empty is dropped (empty there means ALL); a
  // notification entry keeps its TopicARN, which alone addresses the Delete.
  it('still deletes a removed topic whose recorded NotificationTypes are all secret-derived', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', NotificationConfigurations: [] },
      {
        AutoScalingGroupName: 'my-asg',
        NotificationConfigurations: [{ TopicARN: 'arn:aws:sns:us-east-1:1:t', NotificationTypes: [SECRET] }],
      }
    );
    const deletes = mockSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((c) => c.constructor.name === 'DeleteNotificationConfigurationCommand')
      .map((c) => c.input);
    expect(deletes).toEqual([{ AutoScalingGroupName: 'my-asg', TopicARN: 'arn:aws:sns:us-east-1:1:t' }]);
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain(SECRET);
  });

  it('refuses a desired secret-derived metric name before any call', async () => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          MetricsCollection: [{ Granularity: '1Minute', Metrics: [SECRET] }],
        },
        { AutoScalingGroupName: 'my-asg' }
      )
    ).rejects.toThrow(
      /desired MetricsCollection .*MetricsCollection holds a dynamic reference or its mask where a name belongs/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names the secret-derived cause on create too, never the value', async () => {
    const error = await provider
      .create('MyAsg', TYPE, {
        AutoScalingGroupName: 'my-asg',
        MinSize: 0,
        MaxSize: 1,
        NotificationConfigurations: [{ TopicARN: 't', NotificationTypes: [SECRET] }],
      })
      .then(
        () => {
          throw new Error('expected create to fail');
        },
        (e: Error) => e
      );
    expect(error.message).toContain(
      'NotificationConfigurations holds a dynamic reference or its mask where a name belongs'
    );
    expect(error.message).not.toContain(SECRET);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Malformed for ANOTHER reason while also holding a reference somewhere:
  // the shape wording, not the secret cause.
  it('does not blame a dynamic reference for a list malformed for another reason', async () => {
    const error = await provider
      .update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          MetricsCollection: [{ Metrics: [SECRET] }],
        },
        { AutoScalingGroupName: 'my-asg' }
      )
      .then(
        () => {
          throw new Error('expected update to fail');
        },
        (e: Error) => e
      );
    expect(error.message).toContain('desired MetricsCollection');
    expect(error.message).not.toContain('dynamic reference');
    expect(error.message).not.toContain(SECRET);
  });

  it('keeps the plain shape wording for a malformed, not secret-derived, list', async () => {
    const error = await provider
      .update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', MetricsCollection: 'x' },
        { AutoScalingGroupName: 'my-asg' }
      )
      .then(
        () => {
          throw new Error('expected update to fail');
        },
        (e: Error) => e
      );
    expect(error.message).toContain('is not a list of entries with a Granularity — nothing');
    expect(error.message).not.toContain('dynamic reference');
  });
});

describe('ASGProvider.canonicalizeDriftProperties — MetricsCollection (#4013)', () => {
  const provider = new ASGProvider();

  it('folds a template-shaped baseline to the readback shape', async () => {
    // The readback for the same enabled set.
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand') {
        return Promise.resolve({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'my-asg',
              MinSize: 0,
              MaxSize: 0,
              EnabledMetrics: [
                { Metric: MIN, Granularity: '1Minute' },
                { Metric: DESIRED, Granularity: '1Minute' },
              ],
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const readback = (bagOf(await provider.readCurrentState('my-asg', 'MyAsg', TYPE)))!;
    const baseline = {
      MetricsCollection: [
        { Granularity: '1Minute', Metrics: [MIN] },
        { Granularity: '1Minute', Metrics: [DESIRED] },
      ],
    };
    const b = provider.canonicalizeDriftProperties(TYPE, baseline);
    const a = provider.canonicalizeDriftProperties(TYPE, readback);
    expect(b['MetricsCollection']).toEqual(a['MetricsCollection']);
    // Non-vacuity: the raw shapes DO differ.
    expect(baseline.MetricsCollection).not.toEqual(readback['MetricsCollection']);
  });

  it('keeps a real difference', () => {
    const b = provider.canonicalizeDriftProperties(TYPE, {
      MetricsCollection: [{ Granularity: '1Minute', Metrics: [MIN] }],
    });
    const a = provider.canonicalizeDriftProperties(TYPE, {
      MetricsCollection: [{ Granularity: '1Minute', Metrics: [MIN, MAX] }],
    });
    expect(b['MetricsCollection']).not.toEqual(a['MetricsCollection']);
  });

  // An unreadable Metrics would fold to ALL and hide a difference; it is left
  // as is, so the comparator still sees it.
  it('leaves a list with an unreadable entry unfolded', () => {
    const bad = {
      MetricsCollection: [
        { Granularity: '1Minute', Metrics: [7] },
        { Granularity: '1Minute', Metrics: [MIN] },
      ],
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bad)).toBe(bad);
  });

  it('returns the bag by identity when nothing folds, and ignores other types', () => {
    const already = { MetricsCollection: [{ Granularity: '1Minute', Metrics: [MIN] }] };
    expect(provider.canonicalizeDriftProperties(TYPE, already)).toBe(already);
    const absent = { MinSize: 1 };
    expect(provider.canonicalizeDriftProperties(TYPE, absent)).toBe(absent);
    const other = { MetricsCollection: [{ Granularity: '1Minute' }, { Granularity: '1Minute' }] };
    expect(provider.canonicalizeDriftProperties('AWS::SQS::Queue', other)).toBe(other);
  });
});
