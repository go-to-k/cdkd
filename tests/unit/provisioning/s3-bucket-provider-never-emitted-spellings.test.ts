import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketNotificationConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1748: the notification ARN aliases and the lifecycle transition
 * aliases were recorded in a spelling `readCurrentState` never emits.
 *
 * The class (`.claude/rules/providers.md` records it as the #1686
 * never-emitted-KEY class, reached through the SHAPE rather than through a
 * value): where the provider accepts more than one spelling of a key on the
 * DESIRED side but its reverse-mapper emits only ONE, a record written in the
 * other spelling can never match the readback. `cdkd drift` re-reports it
 * forever and `--revert` re-issues the same call — with NO warning anywhere,
 * because nothing is malformed and nothing is substituted.
 *
 * Rows are written so the obvious wrong implementations FAIL:
 *
 * 1. **The recorded bag is compared against what `readCurrentState` ACTUALLY
 *    EMITS** for the same configuration, not against a hand-written literal.
 *    "Records the emitted spelling" is the whole contract, so a test that pins
 *    a literal on both sides cannot see the two drifting — and this is exactly
 *    the axis the bug lived on.
 * 2. **The tolerated key must be REMOVED, not set to `undefined`.**
 *    `JSON.stringify` drops an `undefined` member but the state record survives
 *    a `structuredClone` with the key intact, so the `unionWalkObjects` drift
 *    path would still see two different key sets. Asserted with `in`, which a
 *    `toEqual` comparison cannot see.
 * 3. **The CFn-spelled polarity asserts `effectiveProperties` is ABSENT**, not
 *    equal to the desired bag. The engine gates on `??`, so an implementation
 *    that always answers is indistinguishable by value and would rewrite the
 *    record on every deploy.
 * 4. **The TWIN is asserted alongside every fold.** Recording the emitted
 *    spelling without folding the template side the same way makes an unchanged
 *    template redeploy as `1 to update` forever (issue #1717 measured that on
 *    the sibling fold) — so a fold shipped without its twin is worse than no
 *    fold at all.
 * 5. **A SKIPPED lifecycle Put must NOT be folded.** AWS still holds the
 *    previous configuration there, so folding the DESIRED bag over it would
 *    describe a call that never went out.
 */

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'never-emitted-spellings-bucket';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:topic';
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:queue';
const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:fn';
const TRANSITION_DATE = '2030-01-01T00:00:00.000Z';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

/** Walk a nested path out of a recorded / sent bag without a cast at every hop. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * What `readCurrentState` emits for a bucket whose live notification /
 * lifecycle configuration is the one the sent command carries.
 *
 * This drives the REAL reverse-mappers rather than restating them, so a row
 * asserting "the record matches the readback" keeps meaning that when either
 * side changes. The SDK response is built from the command the provider itself
 * sent, which is what makes the assertion a round-trip rather than two
 * independent literals.
 */
async function readbackOf(
  kind: 'notification' | 'lifecycle',
  sdkInput: Record<string, unknown>
): Promise<unknown> {
  const responses = new Map<unknown, unknown>([
    [GetBucketNotificationConfigurationCommand, kind === 'notification' ? sdkInput : {}],
    [
      GetBucketLifecycleConfigurationCommand,
      kind === 'lifecycle' ? sdkInput : { Rules: [] },
    ],
  ]);
  mockSend.mockImplementation((command: object) => {
    for (const [type, response] of responses) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (command instanceof (type as any)) return Promise.resolve(response);
    }
    return Promise.resolve({});
  });
  const state = await provider.readCurrentState(BUCKET, 'L', RESOURCE_TYPE);
  return kind === 'notification'
    ? at(state, 'NotificationConfiguration')
    : at(state, 'LifecycleConfiguration');
}

/**
 * Drive an UPDATE whose previous side declares nothing, and return the sent SDK
 * input alongside the effective bag the engine would record.
 */
async function update(properties: Record<string, unknown>): Promise<{
  effective: Record<string, unknown> | undefined;
  notificationInput: Record<string, unknown> | undefined;
  lifecycleInput: Record<string, unknown> | undefined;
}> {
  const result = await provider.update('L', BUCKET, RESOURCE_TYPE, properties, {
    BucketName: BUCKET,
  });
  return {
    effective: result.effectiveProperties,
    notificationInput: sentCommands(PutBucketNotificationConfigurationCommand)[0]?.['input'] as
      | unknown as Record<string, unknown>
      | undefined,
    lifecycleInput: sentCommands(PutBucketLifecycleConfigurationCommand)[0]?.['input'] as unknown as
      | Record<string, unknown>
      | undefined,
  };
}

describe('issue #1748: notification ARN aliases', () => {
  const families = [
    {
      listKey: 'TopicConfigurations',
      emitted: 'Topic',
      tolerated: 'TopicArn',
      arn: TOPIC_ARN,
    },
    {
      listKey: 'QueueConfigurations',
      emitted: 'Queue',
      tolerated: 'QueueArn',
      arn: QUEUE_ARN,
    },
    {
      listKey: 'LambdaConfigurations',
      emitted: 'Function',
      tolerated: 'LambdaFunctionArn',
      arn: LAMBDA_ARN,
    },
  ] as const;

  for (const { listKey, emitted, tolerated, arn } of families) {
    it(`records ${emitted}, the spelling readNotification emits, for a declared ${tolerated}`, async () => {
      const properties = {
        BucketName: BUCKET,
        NotificationConfiguration: {
          [listKey]: [{ [tolerated]: arn, Event: 's3:ObjectCreated:*' }],
        },
      };

      const { effective, notificationInput } = await update(properties);

      // The right ARN went on the wire — the tolerance itself is unchanged.
      const sent = at(notificationInput, 'NotificationConfiguration') as Record<string, unknown>;
      expect(JSON.stringify(sent)).toContain(arn);

      // ...and the record now carries the spelling the readback emits.
      const item = at(effective, 'NotificationConfiguration', listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(arn);
      // REMOVED, not `undefined` — a present-but-undefined key survives a
      // structuredClone and the drift walk still sees two key sets.
      expect(tolerated in item).toBe(false);

      // The fence that matters: the recorded item is what `readCurrentState`
      // ACTUALLY emits for the configuration that was just sent.
      const readback = await readbackOf('notification', sent);
      expect(at(readback, listKey, 0)).toEqual(item);
    });

    it(`folds the template side identically for a declared ${tolerated}`, () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        NotificationConfiguration: {
          [listKey]: [{ [tolerated]: arn, Event: 's3:ObjectCreated:*' }],
        },
      });

      const item = at(canonical, 'NotificationConfiguration', listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(arn);
      expect(tolerated in item).toBe(false);
    });

    it(`prefers the DECLARED ${emitted} when both spellings are present, exactly as the wire does`, async () => {
      const other = `${arn}-other`;
      const { effective, notificationInput } = await update({
        BucketName: BUCKET,
        NotificationConfiguration: {
          [listKey]: [{ [emitted]: arn, [tolerated]: other, Event: 's3:ObjectCreated:*' }],
        },
      });

      expect(JSON.stringify(at(notificationInput, 'NotificationConfiguration'))).toContain(arn);
      expect(JSON.stringify(at(notificationInput, 'NotificationConfiguration'))).not.toContain(
        other
      );
      const item = at(effective, 'NotificationConfiguration', listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(arn);
      expect(tolerated in item).toBe(false);
    });

    it(`falls through a NULLISH ${emitted} to ${tolerated}, exactly as the wire's alias read does`, () => {
      // The one place `??` is licensed in these folds: it supplies no DEFAULT,
      // it picks between two spellings of one declared value. A presence test
      // here would record `null` while the wire sent the ARN.
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        NotificationConfiguration: {
          [listKey]: [{ [emitted]: null, [tolerated]: arn, Event: 's3:ObjectCreated:*' }],
        },
      });

      const item = at(canonical, 'NotificationConfiguration', listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(arn);
      expect(tolerated in item).toBe(false);
    });

    it(`leaves an ordinary ${emitted}-spelled template completely alone`, async () => {
      const { effective } = await update({
        BucketName: BUCKET,
        NotificationConfiguration: {
          [listKey]: [{ [emitted]: arn, Event: 's3:ObjectCreated:*' }],
        },
      });

      expect(effective).toBeUndefined();
    });
  }

  it('records the fold on a template-path CREATE too', async () => {
    // A never-emitted SPELLING carries no malformed value and no downgrade, so
    // unlike the rest of this provider's create-path overrides it is reachable
    // from an ORDINARY create, not only from the rollback replay.
    const result = await provider.create('L', RESOURCE_TYPE, {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ TopicArn: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
      },
    });

    const item = at(
      result.effectiveProperties,
      'NotificationConfiguration',
      'TopicConfigurations',
      0
    ) as Record<string, unknown>;
    expect(item['Topic']).toBe(TOPIC_ARN);
    expect('TopicArn' in item).toBe(false);
  });

  it('does not mutate the caller’s own property bag', async () => {
    const properties = {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ TopicArn: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
      },
    };
    await update(properties);
    expect(properties.NotificationConfiguration.TopicConfigurations[0]).toEqual({
      TopicArn: TOPIC_ARN,
      Event: 's3:ObjectCreated:*',
    });
  });
});

describe('issue #1748: the notification Event / Events spelling', () => {
  // The WIDER half of the same item, and the one the round-trip fence above is
  // what surfaced: `TopicArn` is a cdkd-only tolerance almost nobody uses, while
  // `Event` is the member the CFn schema declares and therefore the one EVERY
  // template carries — so the readback's unconditional `Events` disagreed with
  // every notification-configured bucket's record.
  it('readNotification emits the CFn Event for a single-event live configuration', async () => {
    const readback = await readbackOf('notification', {
      TopicConfigurations: [{ Id: 't1', TopicArn: TOPIC_ARN, Events: ['s3:ObjectCreated:*'] }],
    });

    const item = at(readback, 'TopicConfigurations', 0) as Record<string, unknown>;
    expect(item['Event']).toBe('s3:ObjectCreated:*');
    expect('Events' in item).toBe(false);
  });

  it('...and keeps Events for a multi-event one, which has no CFn spelling', async () => {
    const readback = await readbackOf('notification', {
      TopicConfigurations: [
        { Id: 't1', TopicArn: TOPIC_ARN, Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'] },
      ],
    });

    const item = at(readback, 'TopicConfigurations', 0) as Record<string, unknown>;
    expect(item['Events']).toEqual(['s3:ObjectCreated:*', 's3:ObjectRemoved:*']);
    expect('Event' in item).toBe(false);
  });

  it('records Event for a declared single-element Events tolerance', async () => {
    const { effective } = await update({
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ Topic: TOPIC_ARN, Events: ['s3:ObjectCreated:*'] }],
      },
    });

    const item = at(effective, 'NotificationConfiguration', 'TopicConfigurations', 0) as Record<
      string,
      unknown
    >;
    expect(item['Event']).toBe('s3:ObjectCreated:*');
    expect('Events' in item).toBe(false);
  });

  it('leaves a multi-element Events declaration alone — both sides then hold it', async () => {
    // Folding a 2-element list onto the scalar would LOSE an event, so the
    // arity rule refuses; the readback emits `Events` for that shape too, so
    // the two still meet.
    const properties = {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [
          { Topic: TOPIC_ARN, Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'] },
        ],
      },
    };
    const { effective } = await update(properties);
    expect(effective).toBeUndefined();
    expect(
      at(
        provider.canonicalizeDesiredProperties(RESOURCE_TYPE, properties),
        'NotificationConfiguration',
        'TopicConfigurations',
        0,
        'Events'
      )
    ).toEqual(['s3:ObjectCreated:*', 's3:ObjectRemoved:*']);
  });

  it('prefers a declared Event over Events, exactly as the wire does', async () => {
    const { effective, notificationInput } = await update({
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [
          { Topic: TOPIC_ARN, Event: 's3:ObjectCreated:*', Events: ['s3:ObjectRemoved:*'] },
        ],
      },
    });

    expect(
      at(notificationInput, 'NotificationConfiguration', 'TopicConfigurations', 0, 'Events')
    ).toEqual(['s3:ObjectCreated:*']);
    const item = at(effective, 'NotificationConfiguration', 'TopicConfigurations', 0) as Record<
      string,
      unknown
    >;
    expect(item['Event']).toBe('s3:ObjectCreated:*');
    expect('Events' in item).toBe(false);
  });
});

describe('issue #1748: lifecycle transition aliases', () => {
  const rule = (extra: Record<string, unknown>) => ({
    Id: 'r1',
    Status: 'Enabled',
    Prefix: '',
    ...extra,
  });

  const cases = [
    {
      name: 'Transitions[].Days',
      listKey: 'Transitions',
      emitted: 'TransitionInDays',
      tolerated: 'Days',
      value: 30,
    },
    {
      name: 'Transitions[].Date',
      listKey: 'Transitions',
      emitted: 'TransitionDate',
      tolerated: 'Date',
      value: TRANSITION_DATE,
    },
    {
      name: 'NoncurrentVersionTransitions[].NoncurrentDays',
      listKey: 'NoncurrentVersionTransitions',
      emitted: 'TransitionInDays',
      tolerated: 'NoncurrentDays',
      value: 45,
    },
  ] as const;

  for (const { name, listKey, emitted, tolerated, value } of cases) {
    it(`records ${emitted}, the spelling readLifecycle emits, for a declared ${name}`, async () => {
      const properties = {
        BucketName: BUCKET,
        LifecycleConfiguration: {
          Rules: [rule({ [listKey]: [{ [tolerated]: value, StorageClass: 'GLACIER' }] })],
        },
      };

      const { effective, lifecycleInput } = await update(properties);

      const item = at(effective, 'LifecycleConfiguration', 'Rules', 0, listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(value);
      expect(tolerated in item).toBe(false);

      // The same round-trip fence as the notification family: compare against
      // what `readCurrentState` emits for the configuration actually sent.
      const readback = await readbackOf(
        'lifecycle',
        at(lifecycleInput, 'LifecycleConfiguration') as Record<string, unknown>
      );
      expect(at(readback, 'Rules', 0, listKey, 0)).toEqual(item);
    });

    it(`folds the template side identically for a declared ${name}`, () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        LifecycleConfiguration: {
          Rules: [rule({ [listKey]: [{ [tolerated]: value, StorageClass: 'GLACIER' }] })],
        },
      });

      const item = at(canonical, 'LifecycleConfiguration', 'Rules', 0, listKey, 0) as Record<
        string,
        unknown
      >;
      expect(item[emitted]).toBe(value);
      expect(tolerated in item).toBe(false);
    });
  }

  it('leaves an ordinary CFn-spelled lifecycle template completely alone', async () => {
    const { effective } = await update({
      BucketName: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          rule({
            Transitions: [{ TransitionInDays: 30, StorageClass: 'GLACIER' }],
            NoncurrentVersionTransitions: [
              { TransitionInDays: 45, StorageClass: 'GLACIER' },
            ],
          }),
        ],
      },
    });

    expect(effective).toBeUndefined();
  });

  it('folds BOTH aliases on one transition rather than only the first', async () => {
    // The issue named the `Date` alias; the mechanical audit found three in two
    // item shapes. A fold that stops at the first match leaves its sibling
    // broken — the "diff the WHOLE blob, not the reported key" rule.
    const { effective } = await update({
      BucketName: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          rule({
            Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
            NoncurrentVersionTransitions: [{ NoncurrentDays: 45, StorageClass: 'GLACIER' }],
          }),
        ],
      },
    });

    expect(at(effective, 'LifecycleConfiguration', 'Rules', 0, 'Transitions', 0)).toEqual({
      TransitionInDays: 30,
      StorageClass: 'GLACIER',
    });
    expect(
      at(effective, 'LifecycleConfiguration', 'Rules', 0, 'NoncurrentVersionTransitions', 0)
    ).toEqual({ TransitionInDays: 45, StorageClass: 'GLACIER' });
  });

  it('does NOT fold a SKIPPED lifecycle Put — the previous value is what AWS holds', async () => {
    // A malformed rule `Status` skips the WHOLE Put (the Put replaces every
    // rule), so AWS still holds the previously-applied configuration. Folding
    // the desired bag over that would describe a call that never went out.
    const previousLifecycle = {
      Rules: [{ Id: 'r0', Status: 'Enabled', Prefix: '', TransitionInDays: 10 }],
    };
    const result = await provider.update(
      'L',
      BUCKET,
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'r1',
              Status: null,
              Prefix: '',
              Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
            },
          ],
        },
      },
      { BucketName: BUCKET, LifecycleConfiguration: previousLifecycle }
    );

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(at(result.effectiveProperties, 'LifecycleConfiguration')).toEqual(previousLifecycle);
  });
});

describe('issue #1748: the fold and its twin converge', () => {
  // The point of shipping the twin: after one deploy, the RECORD and the
  // canonicalized TEMPLATE must be equal, or the next `cdkd diff` reports a
  // change nobody made and re-issues the same Put forever.
  it('a redeploy of the unchanged template is a no-op on both sides', async () => {
    const template = {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ TopicArn: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
        QueueConfigurations: [{ QueueArn: QUEUE_ARN, Event: 's3:ObjectRemoved:*' }],
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'r1',
            Status: 'Enabled',
            Prefix: '',
            Transitions: [{ Days: 30, Date: undefined, StorageClass: 'GLACIER' }],
            NoncurrentVersionTransitions: [{ NoncurrentDays: 45, StorageClass: 'GLACIER' }],
          },
        ],
      },
    };

    const { effective } = await update(template);
    expect(effective).toBeDefined();

    const canonicalTemplate = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, template);
    expect(canonicalTemplate['NotificationConfiguration']).toEqual(
      effective?.['NotificationConfiguration']
    );
    expect(canonicalTemplate['LifecycleConfiguration']).toEqual(
      effective?.['LifecycleConfiguration']
    );
  });
});
