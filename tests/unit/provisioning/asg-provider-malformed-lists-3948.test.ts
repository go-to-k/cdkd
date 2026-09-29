import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3948: every ASG sub-shape diff helper derives its REMOVALS from
// the gap between the desired and the recorded list, and used to read each side
// as `Array.isArray(x) ? x : []`. A present-but-malformed value therefore read
// as EMPTY: on a rollback (desired side = a recorded bag) `TargetGroupARNs: {}`
// detached every target group. A malformed list on EITHER side is now refused
// before ANY call; absent (`undefined` / `null`) still reads as the empty list.

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

const warned: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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
  AttachLoadBalancersCommand,
  DetachLoadBalancersCommand,
  AttachLoadBalancerTargetGroupsCommand,
  DetachLoadBalancerTargetGroupsCommand,
  CreateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  DetachTrafficSourcesCommand,
  AttachTrafficSourcesCommand,
  DeleteTagsCommand,
  CreateOrUpdateTagsCommand,
  EnableMetricsCollectionCommand,
  DisableMetricsCollectionCommand,
  PutLifecycleHookCommand,
  DeleteLifecycleHookCommand,
  PutNotificationConfigurationCommand,
  DeleteNotificationConfigurationCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const TG_A = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/issue3948-a/0123abcd';
const TG_B = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/issue3948-b/4567ef01';
const SECRET_REF = '{{resolve:secretsmanager:issue3948/tg:SecretString:arn::}}';

/** A distinctive needle per malformed value, so a message echoing it is caught. */
const NEEDLE = 'issue3948-needle';

const VALID: Record<string, unknown[]> = {
  LoadBalancerNames: ['issue3948-lb'],
  TargetGroupARNs: [TG_A],
  Tags: [{ Key: 'issue3948', Value: 'v', PropagateAtLaunch: false }],
  MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMinSize'] }],
  LifecycleHookSpecificationList: [
    { LifecycleHookName: 'issue3948-hook', LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' },
  ],
  TrafficSources: [{ Identifier: 'issue3948-source', Type: 'vpc-lattice' }],
  NotificationConfigurations: [
    { TopicARN: 'arn:aws:sns:us-east-1:123456789012:issue3948', NotificationTypes: ['x'] },
  ],
};

const ATTACHMENT_KINDS: string[] = ['LoadBalancerNames', 'TargetGroupARNs'];

const ATTACHMENT_MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { [NEEDLE]: true }],
  ['a non-string entry', [TG_A, 42]],
  ['an empty-string entry', ['']],
  ['an entry holding whitespace', [`${NEEDLE} x`]],
  ['an over-long entry', ['a'.repeat(512)]],
  ['a false', false],
];

const ENTRY_MALFORMED: Record<string, Array<[string, unknown]>> = {
  Tags: [
    ['a bare string', NEEDLE],
    ['an object', { Key: NEEDLE }],
    ['an entry with no Key', [{ Value: NEEDLE }]],
    ['a string entry', [NEEDLE]],
  ],
  MetricsCollection: [
    ['an object', {}],
    ['an entry with no Granularity', [{ Metrics: [NEEDLE] }]],
    ['an entry whose Metrics is an object', [{ Granularity: '1Minute', Metrics: {} }]],
  ],
  LifecycleHookSpecificationList: [
    ['a bare string', NEEDLE],
    ['an entry with a numeric name', [{ LifecycleHookName: 7 }]],
  ],
  TrafficSources: [
    ['an object', { Identifier: NEEDLE }],
    ['an entry with no Identifier', [{ Type: 'vpc-lattice' }]],
    ['a null entry', [null]],
  ],
  NotificationConfigurations: [
    ['a bare string', NEEDLE],
    ['an entry whose NotificationTypes is a string', [{ TopicARN: 't', NotificationTypes: 'x' }]],
  ],
};

function caseTable(): Array<[string, string, unknown]> {
  const rows: Array<[string, string, unknown]> = [];
  for (const kind of ['LoadBalancerNames', 'TargetGroupARNs']) {
    for (const [label, value] of ATTACHMENT_MALFORMED) rows.push([kind, label, value]);
  }
  for (const [kind, cases] of Object.entries(ENTRY_MALFORMED)) {
    for (const [label, value] of cases) rows.push([kind, label, value]);
  }
  return rows;
}

function sent<T>(ctor: new (...args: never[]) => T): Array<{ input: Record<string, unknown> }> {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c instanceof ctor) as unknown as Array<{ input: Record<string, unknown> }>;
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to be refused');
}

describe('ASGProvider update — malformed lists are refused before any call (#3948)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    mockSend.mockResolvedValue({});
    provider = new ASGProvider();
  });

  describe.each(caseTable())('%s as %s', (kind, _label, malformed) => {
    it('on the DESIRED side sends nothing', async () => {
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', [kind]: malformed },
          { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] }
        )
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(error.message).toContain(`desired ${kind}`);
      expect(error.message).not.toContain(NEEDLE);
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

  });

  describe.each(caseTable().filter(([kind]) => !ATTACHMENT_KINDS.includes(kind)))(
    '%s as %s',
    (kind, _label, malformed) => {
      it('on the RECORDED side sends nothing and names the state.json repair', async () => {
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] },
          { AutoScalingGroupName: 'my-asg', [kind]: malformed }
        )
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(error.message).toContain(`recorded ${kind}`);
      expect(error.message).toContain(`repair the recorded ${kind} in state.json`);
      expect(error.message).not.toContain(NEEDLE);
      });
    }
  );

  // A malformed RECORDED attachment list only hides removals, and `cdkd
  // import` can leave one holding an unresolved intrinsic: it is read from the
  // live group instead, ADD-only.
  describe.each(caseTable().filter(([kind]) => ATTACHMENT_KINDS.includes(kind)))(
    '%s as %s',
    (kind, _label, malformed) => {
      it('on the RECORDED side reads the live group ADD-only, detaching nothing', async () => {
        const live = kind === 'TargetGroupARNs' ? [TG_A, TG_B] : ['issue3948-lb', 'lb-other'];
        mockSend.mockImplementation((command: unknown) => {
          if (command instanceof DescribeAutoScalingGroupsCommand) {
            return Promise.resolve({ AutoScalingGroups: [{ [kind]: live }] });
          }
          return Promise.resolve({});
        });
        await provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] },
          { AutoScalingGroupName: 'my-asg', [kind]: malformed }
        );
        expect(sent(DescribeAutoScalingGroupsCommand).length).toBeGreaterThan(0);
        expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
        expect(sent(DetachLoadBalancersCommand)).toHaveLength(0);
        expect(sent(AttachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
        expect(sent(AttachLoadBalancersCommand)).toHaveLength(0);
        const log = warned.join('\n');
        expect(log).toContain('left them attached');
        expect(log).not.toContain(NEEDLE);
      });
    }
  );

  // The issue's own failure: a rollback replays update() with the recorded bag
  // as the DESIRED side, so a planted `TargetGroupARNs: {}` there detached
  // every target group the group held.
  it('refuses a malformed DESIRED side on a rollback replay (replayingState)', async () => {
    for (const [kind, malformed] of [
      ['TargetGroupARNs', {}],
      ['LoadBalancerNames', 'my-elb'],
    ] as const) {
      mockSend.mockClear();
      await expect(
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', [kind]: malformed },
          { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] },
          { replayingState: true }
        )
      ).rejects.toThrow(`desired ${kind}`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  });

  it('refuses before the Tags diff too, so no earlier helper runs first', async () => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', Tags: [], TargetGroupARNs: {} },
        { AutoScalingGroupName: 'my-asg', Tags: VALID['Tags'], TargetGroupARNs: [TG_A] }
      )
    ).rejects.toThrow('desired TargetGroupARNs');
    expect(sent(DeleteTagsCommand)).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The other polarity, per helper: a well-formed list still sends exactly the
  // expected delta.
  it('a valid TargetGroupARNs delta sends exactly one Detach and no Attach', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [TG_A] }] });
      }
      return Promise.resolve({});
    });
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A, TG_B] }
    );
    expect(sent(DetachLoadBalancerTargetGroupsCommand).map((c) => c.input['TargetGroupARNs'])).toEqual(
      [[TG_B]]
    );
    expect(sent(AttachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
  });

  it('a valid LoadBalancerNames delta sends exactly one Attach and one Detach', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['lb-new'] },
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['lb-old'] }
    );
    expect(sent(AttachLoadBalancersCommand).map((c) => c.input['LoadBalancerNames'])).toEqual([
      ['lb-new'],
    ]);
    expect(sent(DetachLoadBalancersCommand).map((c) => c.input['LoadBalancerNames'])).toEqual([
      ['lb-old'],
    ]);
  });

  it('a valid TrafficSources delta still detaches the removed entry', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', TrafficSources: [] },
      { AutoScalingGroupName: 'my-asg', TrafficSources: VALID['TrafficSources'] }
    );
    expect(sent(DetachTrafficSourcesCommand).map((c) => c.input['TrafficSources'])).toEqual([
      [{ Identifier: 'issue3948-source', Type: 'vpc-lattice' }],
    ]);
  });

  // test-M1: each entry-list helper is wired to its own property on BOTH
  // sides. A valid desired != recorded diff sends exactly the expected inputs,
  // and an unchanged entry is neither deleted nor re-sent.
  describe('entry-list wiring (valid diffs)', () => {
    it('MetricsCollection: disables the dropped granularity only, enables the changed one', async () => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          MetricsCollection: [{ Granularity: '1Minute', Metrics: ['GroupMinSize'] }],
        },
        {
          AutoScalingGroupName: 'my-asg',
          MetricsCollection: [
            { Granularity: '1Minute', Metrics: ['GroupMinSize', 'GroupMaxSize'] },
            { Granularity: '5Minute' },
          ],
        }
      );
      expect(sent(DisableMetricsCollectionCommand).map((c) => c.input)).toEqual([
        { AutoScalingGroupName: 'my-asg' },
        { AutoScalingGroupName: 'my-asg', Metrics: ['GroupMaxSize'] },
      ]);
      expect(sent(EnableMetricsCollectionCommand).map((c) => c.input)).toEqual([
        { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: ['GroupMinSize'] },
      ]);
    });

    it('LifecycleHookSpecificationList: deletes the dropped hook, puts the changed one, leaves the kept one', async () => {
      const kept = { LifecycleHookName: 'kept', LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' };
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          LifecycleHookSpecificationList: [
            kept,
            { LifecycleHookName: 'changed', LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING', HeartbeatTimeout: 60 },
          ],
        },
        {
          AutoScalingGroupName: 'my-asg',
          LifecycleHookSpecificationList: [
            kept,
            { LifecycleHookName: 'changed', LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING' },
            { LifecycleHookName: 'dropped', LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' },
          ],
        }
      );
      expect(sent(DeleteLifecycleHookCommand).map((c) => c.input)).toEqual([
        { AutoScalingGroupName: 'my-asg', LifecycleHookName: 'dropped' },
      ]);
      expect(sent(PutLifecycleHookCommand).map((c) => c.input)).toEqual([
        {
          AutoScalingGroupName: 'my-asg',
          LifecycleHookName: 'changed',
          LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
          HeartbeatTimeout: 60,
        },
      ]);
    });

    it('NotificationConfigurations: deletes the dropped topic, puts the changed one, leaves the kept one', async () => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          NotificationConfigurations: [
            { TopicARN: 'kept', NotificationTypes: ['a'] },
            { TopicARN: 'changed', NotificationTypes: ['a', 'b'] },
          ],
        },
        {
          AutoScalingGroupName: 'my-asg',
          NotificationConfigurations: [
            { TopicARN: 'kept', NotificationTypes: ['a'] },
            { TopicARN: 'changed', NotificationTypes: ['a'] },
            { TopicARN: 'dropped', NotificationTypes: ['a'] },
          ],
        }
      );
      expect(sent(DeleteNotificationConfigurationCommand).map((c) => c.input)).toEqual([
        { AutoScalingGroupName: 'my-asg', TopicARN: 'dropped' },
      ]);
      expect(sent(PutNotificationConfigurationCommand).map((c) => c.input)).toEqual([
        { AutoScalingGroupName: 'my-asg', TopicARN: 'changed', NotificationTypes: ['a', 'b'] },
      ]);
    });

    it('TrafficSources: detaches the dropped source, attaches the new one, leaves the kept one', async () => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          TrafficSources: [
            { Identifier: 'kept', Type: 'vpc-lattice' },
            { Identifier: 'added', Type: 'vpc-lattice' },
          ],
        },
        {
          AutoScalingGroupName: 'my-asg',
          TrafficSources: [
            { Identifier: 'kept', Type: 'vpc-lattice' },
            { Identifier: 'dropped', Type: 'vpc-lattice' },
          ],
        }
      );
      expect(sent(DetachTrafficSourcesCommand).map((c) => c.input['TrafficSources'])).toEqual([
        [{ Identifier: 'dropped', Type: 'vpc-lattice' }],
      ]);
      expect(sent(AttachTrafficSourcesCommand).map((c) => c.input['TrafficSources'])).toEqual([
        [{ Identifier: 'added', Type: 'vpc-lattice' }],
      ]);
    });
  });

  // test-m2: ABSENT is the empty list on BOTH sides for the entry lists.
  describe.each([
    ['Tags', DeleteTagsCommand, CreateOrUpdateTagsCommand],
    ['MetricsCollection', DisableMetricsCollectionCommand, EnableMetricsCollectionCommand],
    ['LifecycleHookSpecificationList', DeleteLifecycleHookCommand, PutLifecycleHookCommand],
    ['TrafficSources', DetachTrafficSourcesCommand, AttachTrafficSourcesCommand],
    [
      'NotificationConfigurations',
      DeleteNotificationConfigurationCommand,
      PutNotificationConfigurationCommand,
    ],
  ] as const)('%s absent', (kind, removeCmd, addCmd) => {
    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('on the RECORDED side (%s) adds the desired entries and removes nothing', async (_l, absent) => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] },
        { AutoScalingGroupName: 'my-asg', [kind]: absent }
      );
      expect(sent(removeCmd as never)).toHaveLength(0);
      expect(sent(addCmd as never)).toHaveLength(1);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('on the DESIRED side (%s) removes what the record holds', async (_l, absent) => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', [kind]: absent },
        { AutoScalingGroupName: 'my-asg', [kind]: VALID[kind] }
      );
      expect(sent(removeCmd as never)).toHaveLength(1);
      expect(sent(addCmd as never)).toHaveLength(0);
    });
  });

  // test-m1: the AutoScalingGroupName replacement refusal runs BEFORE the list
  // reads, so an unreadable record costs no live read there.
  it.each([
    ['secret-derived', [SECRET_REF]],
    ['malformed', {}],
  ])('a name change with a %s recorded TG refuses as a replacement with no call', async (_l, rec) => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'renamed', TargetGroupARNs: [TG_A] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: rec }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // code-m1: `cdkd import`'s raw-template fallback can record an unresolved
  // intrinsic. Refusing it would wedge every later deploy; it is read live.
  it('reads an import-style recorded [{ Ref }] TargetGroupARNs from the live group ADD-only', async () => {
    let attached = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AttachLoadBalancerTargetGroupsCommand) attached = true;
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({
          AutoScalingGroups: [{ TargetGroupARNs: attached ? [TG_B, TG_A] : [TG_B] }],
        });
      }
      return Promise.resolve({});
    });
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [{ Ref: 'MyTG' }] }
    );
    expect(
      sent(AttachLoadBalancerTargetGroupsCommand).map((c) => c.input['TargetGroupARNs'])
    ).toEqual([[TG_A]]);
    expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
    expect(warned.join('\n')).toContain('left them attached');
    expect(warned.join('\n')).not.toContain('did not converge');
  });

  // The same removal filter for every other entry list: a recorded
  // secret-derived identity sends no Delete / Detach naming the literal.
  it.each([
    [
      'LifecycleHookSpecificationList',
      'LifecycleHookName',
      DeleteLifecycleHookCommand,
      (c: { input: Record<string, unknown> }) => c.input['LifecycleHookName'],
    ],
    [
      'NotificationConfigurations',
      'TopicARN',
      DeleteNotificationConfigurationCommand,
      (c: { input: Record<string, unknown> }) => c.input['TopicARN'],
    ],
    [
      'TrafficSources',
      'Identifier',
      DetachTrafficSourcesCommand,
      (c: { input: Record<string, unknown> }) =>
        (c.input['TrafficSources'] as Array<{ Identifier: string }>).map((t) => t.Identifier),
    ],
    [
      'MetricsCollection',
      'Granularity',
      DisableMetricsCollectionCommand,
      (c: { input: Record<string, unknown> }) => c.input['Metrics'] ?? 'all',
    ],
  ] as const)(
    'a recorded secret-derived %s identity is never removed',
    async (kind, identity, removeCmd, pick) => {
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', [kind]: [] },
        {
          AutoScalingGroupName: 'my-asg',
          [kind]: [
            { [identity]: SECRET_REF, ...(kind === 'MetricsCollection' ? { Metrics: ['GroupMinSize'] } : {}) },
            { [identity]: 'dropped', ...(kind === 'MetricsCollection' ? { Metrics: ['GroupMaxSize'] } : {}) },
          ],
        }
      );
      const removed = sent(removeCmd as never).map((c) => pick(c as never));
      expect(removed).toHaveLength(1);
      expect(JSON.stringify(removed)).not.toContain(SECRET_REF);
      expect(JSON.stringify(removed)).toContain(kind === 'MetricsCollection' ? 'GroupMaxSize' : 'dropped');
    }
  );

  // A `null` RECORDED attachment list is ABSENT, not malformed: it reads as the
  // empty list and takes no live read, so the desired entries are attached.
  it('a null recorded LoadBalancerNames reads as empty, with no live read', async () => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['lb-a'] },
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: null }
    );
    expect(sent(AttachLoadBalancersCommand).map((c) => c.input['LoadBalancerNames'])).toEqual([
      ['lb-a'],
    ]);
    expect(sent(DetachLoadBalancersCommand)).toHaveLength(0);
    // Only the post-update ARN read; no live read of the attachment list.
    expect(sent(DescribeAutoScalingGroupsCommand)).toHaveLength(1);
    expect(warned).toHaveLength(0);
  });

  it('a null recorded TargetGroupARNs reads as empty, with no live read', async () => {
    let attached = false;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AttachLoadBalancerTargetGroupsCommand) attached = true;
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        describes += 1;
        return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: attached ? [TG_A] : [] }] });
      }
      return Promise.resolve({});
    });
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: null }
    );
    expect(
      sent(AttachLoadBalancerTargetGroupsCommand).map((c) => c.input['TargetGroupARNs'])
    ).toEqual([[TG_A]]);
    expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
    // One converged poll plus the post-update ARN read: no live read first.
    expect(describes).toBe(2);
    expect(warned).toHaveLength(0);
  });

  // sec-n2: a dynamic reference or its mask as an entry's IDENTITY names
  // nothing AWS holds. On the DESIRED side it is malformed and refused.
  it.each([
    ['a dynamic reference', SECRET_REF],
    ['the mask', '***'],
  ])('a desired entry identity holding %s is refused', async (_l, key) => {
    const desired = await refusal(() =>
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', Tags: [{ Key: key, Value: 'v' }] },
        { AutoScalingGroupName: 'my-asg', Tags: VALID['Tags'] }
      )
    );
    expect(desired.message).toContain('desired Tags');
    expect(desired.message).not.toContain(key);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // On the RECORDED side it is what cdkd writes for a Tag Key that came from a
  // secret, so refusing it would refuse every later update. It is read, and
  // kept out of the removal set: the plaintext desired key is upserted and no
  // DeleteTags names the literal reference.
  it.each([
    ['a dynamic reference', SECRET_REF],
    ['the mask', '***'],
  ])('a recorded entry identity holding %s is read, never deleted', async (_l, key) => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      {
        AutoScalingGroupName: 'my-asg',
        Tags: [
          { Key: 'plain-from-secret', Value: 'v', PropagateAtLaunch: false },
          { Key: 'kept', Value: 'k', PropagateAtLaunch: false },
        ],
      },
      {
        AutoScalingGroupName: 'my-asg',
        Tags: [
          { Key: key, Value: 'v', PropagateAtLaunch: false },
          { Key: 'kept', Value: 'k', PropagateAtLaunch: false },
          { Key: 'dropped', Value: 'd', PropagateAtLaunch: false },
        ],
      }
    );
    // The ordinary removal still goes out; the secret-derived key does not.
    expect(sent(DeleteTagsCommand).map((c) => c.input['Tags'])).toEqual([
      [{ ResourceId: 'my-asg', ResourceType: 'auto-scaling-group', Key: 'dropped' }],
    ]);
    expect(
      sent(CreateOrUpdateTagsCommand).map((c) =>
        (c.input['Tags'] as Array<{ Key: string }>).map((t) => t.Key)
      )
    ).toEqual([['plain-from-secret']]);
  });

  // ABSENT is not malformed: a property removed from the template (undefined)
  // or a `null` in a hand-edited record still reads as the empty list.
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('an ABSENT (%s) desired list still detaches what the record holds', async (_l, absent) => {
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: absent },
      { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['lb-old'] }
    );
    expect(sent(DetachLoadBalancersCommand).map((c) => c.input['LoadBalancerNames'])).toEqual([
      ['lb-old'],
    ]);
  });

  describe('a secret-derived RECORDED attachment list', () => {
    it('is read from the live group, and nothing the desired side omits is detached', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [TG_A, TG_B] }] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
      );
      expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      expect(sent(AttachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      const log = warned.join('\n');
      expect(log).toContain('left them attached');
      expect(log).not.toContain(TG_B);
      expect(log).not.toContain(SECRET_REF);
    });

    it('attaches a desired entry the live group lacks', async () => {
      // Empty until the Attach lands, so the convergence poll then returns.
      let attached = false;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AttachLoadBalancerTargetGroupsCommand) attached = true;
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: attached ? [TG_A] : [] }] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
      );
      expect(
        sent(AttachLoadBalancerTargetGroupsCommand).map((c) => c.input['TargetGroupARNs'])
      ).toEqual([[TG_A]]);
      expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      // Nothing was left attached, so the retained-entries warning stays silent.
      expect(warned).toHaveLength(0);
    });

    // The live group holds an entry the desired side omits AND lacks one it
    // names: the attach runs, and the convergence poll must expect the retained
    // entry too, or it spins its whole budget and warns "did not converge".
    it('expects the retained live entry in the convergence poll after an attach', async () => {
      let attached = false;
      let describes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AttachLoadBalancerTargetGroupsCommand) attached = true;
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          describes += 1;
          return Promise.resolve({
            AutoScalingGroups: [{ TargetGroupARNs: attached ? [TG_B, TG_A] : [TG_B] }],
          });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
      );
      expect(
        sent(AttachLoadBalancerTargetGroupsCommand).map((c) => c.input['TargetGroupARNs'])
      ).toEqual([[TG_A]]);
      expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      // One live read, one converged poll, one post-update ARN read.
      expect(describes).toBe(3);
      expect(warned.join('\n')).not.toContain('did not converge');
    });

    it('reads a secret-derived LoadBalancerNames from the live group and detaches nothing', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [{ LoadBalancerNames: ['lb-a', 'lb-b'] }] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['lb-a'] },
        { AutoScalingGroupName: 'my-asg', LoadBalancerNames: [SECRET_REF] }
      );
      expect(sent(DetachLoadBalancersCommand)).toHaveLength(0);
      expect(sent(AttachLoadBalancersCommand)).toHaveLength(0);
      const log = warned.join('\n');
      expect(log).toContain('left them attached');
      // Neither the retained live name nor the record's reference is echoed.
      expect(log).not.toContain('lb-b');
      expect(log).not.toContain(SECRET_REF);
    });

    // A secret-derived record plus a template that REMOVED the property: the
    // ADD-only read detaches nothing, and every live entry is retained.
    it('detaches nothing when the desired list is absent, and warns', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [TG_A, TG_B] }] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg' },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
      );
      expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      expect(sent(AttachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      expect(warned.join('\n')).toContain('left them attached');
    });

    it('sends nothing but the read when the live group is not found', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg' },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
      );
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names.filter((n) => n !== 'DescribeAutoScalingGroupsCommand')).toEqual([
        'UpdateAutoScalingGroupCommand',
      ]);
      expect(warned).toHaveLength(0);
    });

    // cdkd's MASK is the other secret-derived spelling a record can carry.
    it('treats a masked (***) recorded TargetGroupARNs as secret-derived too', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: [TG_A] }] });
        }
        return Promise.resolve({});
      });
      await provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: ['***'] }
      );
      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof DescribeAutoScalingGroupsCommand)
      ).toBe(true);
      expect(sent(DetachLoadBalancerTargetGroupsCommand)).toHaveLength(0);
      // Every live entry is desired, so nothing is left attached to warn about.
      expect(warned).toHaveLength(0);
    });

    // The live read is taken only when EVERY malformed recorded list is a
    // secret-derived attachment list: a plain malformed sibling still refuses,
    // with no read at all.
    it('refuses, reading nothing, when a plain malformed recorded list sits beside it', async () => {
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A], Tags: VALID['Tags'] },
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF], Tags: NEEDLE }
        )
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(error.message).toContain('recorded Tags');
      expect(error.message).toContain('repair the recorded Tags in state.json');
      expect(error.message).not.toContain(NEEDLE);
    });

    it('refuses on a malformed desired list, telling the recorded one it needs no repair', async () => {
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A], Tags: NEEDLE },
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
        )
      );
      expect(mockSend).not.toHaveBeenCalled();
      // code-n2: the reason the live read did not happen is the DESIRED side.
      expect(error.message).toContain('desired Tags');
      expect(error.message).toContain(
        'the recorded TargetGroupARNs needs no repair: cdkd reads it from Auto Scaling instead once every desired list and every other recorded list is well-formed'
      );
      expect(error.message).not.toContain('repair the recorded TargetGroupARNs in state.json');
      expect(error.message).not.toContain('do not write the value into state.json');
      expect(error.message).not.toContain(SECRET_REF);
    });

    it('refuses, sending no Attach / Detach, when the live read fails', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.reject(new Error('AccessDenied'));
        }
        return Promise.resolve({});
      });
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
          { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] }
        )
      );
      expect(error.message).toContain('could not be read from Auto Scaling');
      // Deliberately retryable: a throttled read classifies through `cause`.
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect((error as Error & { cause?: Error }).cause?.message).toBe('AccessDenied');
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
        'DescribeAutoScalingGroupsCommand',
      ]);
    });

    it('a secret-derived RECORDED entry list is refused with the [] repair', async () => {
      const error = await refusal(() =>
        provider.update(
          'MyAsg',
          'my-asg',
          TYPE,
          { AutoScalingGroupName: 'my-asg', Tags: VALID['Tags'] },
          { AutoScalingGroupName: 'my-asg', Tags: SECRET_REF }
        )
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(error.message).toContain('set it to [] in state.json');
      expect(error.message).not.toContain(SECRET_REF);
    });
  });

  it('a masked (***) recorded entry list gets the [] repair', async () => {
    const error = await refusal(() =>
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', Tags: VALID['Tags'] },
        { AutoScalingGroupName: 'my-asg', Tags: '***' }
      )
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain('set it to [] in state.json');
  });

  // The length caps are per kind (API `XmlStringMaxLen255` / `511`).
  it('refuses a 256-character load balancer name but accepts a 511-character ARN', async () => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', LoadBalancerNames: ['a'.repeat(256)] },
        { AutoScalingGroupName: 'my-asg' }
      )
    ).rejects.toThrow('desired LoadBalancerNames');
    expect(mockSend).not.toHaveBeenCalled();

    const longArn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/x/`.padEnd(
      511,
      'f'
    );
    let attached = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AttachLoadBalancerTargetGroupsCommand) attached = true;
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({ AutoScalingGroups: [{ TargetGroupARNs: attached ? [longArn] : [] }] });
      }
      return Promise.resolve({});
    });
    await provider.update(
      'MyAsg',
      'my-asg',
      TYPE,
      { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [longArn] },
      { AutoScalingGroupName: 'my-asg' }
    );
    expect(sent(AttachLoadBalancerTargetGroupsCommand)).toHaveLength(1);
  });

  it('accepts a null Metrics / NotificationTypes member as absent', async () => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        {
          AutoScalingGroupName: 'my-asg',
          MetricsCollection: [{ Granularity: '1Minute', Metrics: null }],
          NotificationConfigurations: [{ TopicARN: 't', NotificationTypes: null }],
        },
        { AutoScalingGroupName: 'my-asg' }
      )
    ).resolves.toBeDefined();
  });

  it('a secret-derived DESIRED attachment entry is refused, not sent as a literal', async () => {
    await expect(
      provider.update(
        'MyAsg',
        'my-asg',
        TYPE,
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [SECRET_REF] },
        { AutoScalingGroupName: 'my-asg', TargetGroupARNs: [TG_A] },
        { replayingState: true }
      )
    ).rejects.toThrow('desired TargetGroupARNs');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// `drift --revert` feeds `readCurrentState`'s output through update(), so every
// list it emits must read as well-formed or the revert would refuse itself.
describe('ASGProvider readCurrentState output passes the #3948 list reads', () => {
  it('update() accepts a populated readback on both sides without refusing', async () => {
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'DescribeLifecycleHooksCommand':
          return Promise.resolve({
            LifecycleHooks: [
              { LifecycleHookName: 'hook', LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' },
            ],
          });
        case 'DescribeTrafficSourcesCommand':
          return Promise.resolve({
            TrafficSources: [{ Identifier: 'arn:aws:vpc-lattice:tg-99', Type: 'vpc-lattice' }],
          });
        case 'DescribeNotificationConfigurationsCommand':
          return Promise.resolve({
            NotificationConfigurations: [{ TopicARN: 'arn:aws:sns:t', NotificationType: 'x' }],
          });
        default:
          return Promise.resolve({
            AutoScalingGroups: [
              {
                AutoScalingGroupName: 'my-asg',
                MinSize: 0,
                MaxSize: 0,
                TargetGroupARNs: [TG_A],
                LoadBalancerNames: ['classic-elb-name'],
                EnabledMetrics: [{ Metric: 'GroupMinSize', Granularity: '1Minute' }],
                Tags: [{ Key: 'env', Value: 'dev', PropagateAtLaunch: true }],
              },
            ],
          });
      }
    });
    const provider = new ASGProvider();
    const readback = await provider.readCurrentState('my-asg', 'MyAsg', TYPE);
    expect(readback).toBeDefined();
    for (const kind of Object.keys(VALID)) {
      expect((readback?.[kind] as unknown[]).length, kind).toBeGreaterThan(0);
    }
    await expect(
      provider.update('MyAsg', 'my-asg', TYPE, readback!, { ...readback! })
    ).resolves.toBeDefined();
  });
});

describe('ASGProvider create — malformed lists are refused before any call (#3948)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new ASGProvider();
  });

  it.each(caseTable())('refuses %s as %s', async (kind, _label, malformed) => {
    const error = await refusal(() =>
      provider.create('MyAsg', TYPE, {
        AutoScalingGroupName: 'my-asg',
        MinSize: 0,
        MaxSize: 1,
        [kind]: malformed,
      })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(error.message).toContain(kind);
    expect(error.message).not.toContain(NEEDLE);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('sends a valid LoadBalancerNames / TargetGroupARNs list as given', async () => {
    await provider.create('MyAsg', TYPE, {
      AutoScalingGroupName: 'my-asg',
      MinSize: 0,
      MaxSize: 1,
      LoadBalancerNames: ['lb-1'],
      TargetGroupARNs: [TG_A, TG_B],
    });
    const [create] = sent(CreateAutoScalingGroupCommand);
    expect(create?.input['LoadBalancerNames']).toEqual(['lb-1']);
    expect(create?.input['TargetGroupARNs']).toEqual([TG_A, TG_B]);
  });

  it('omits an absent list', async () => {
    await provider.create('MyAsg', TYPE, {
      AutoScalingGroupName: 'my-asg',
      MinSize: 0,
      MaxSize: 1,
      TargetGroupARNs: null,
      LoadBalancerNames: null,
      TrafficSources: null,
      LifecycleHookSpecificationList: null,
    });
    const [create] = sent(CreateAutoScalingGroupCommand);
    expect(create?.input).not.toHaveProperty('TargetGroupARNs');
    expect(create?.input).not.toHaveProperty('LoadBalancerNames');
    expect(create?.input).not.toHaveProperty('TrafficSources');
    expect(create?.input).not.toHaveProperty('LifecycleHookSpecificationList');
  });
});
