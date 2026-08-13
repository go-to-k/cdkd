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

      // The Put FIRED — without this, "no effective bag" is also satisfied by
      // an applier that never ran at all, which is a different (and worse) bug.
      expect(sentCommands(PutBucketNotificationConfigurationCommand)).toHaveLength(1);
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
    const { effective, lifecycleInput } = await update({
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

    // Same vacuity guard as the notification sibling: the Put fired.
    expect(lifecycleInput).toBeDefined();
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

describe('issue #1748: the arms the update path does not reach', () => {
  const aliasRule = {
    Id: 'r1',
    Status: 'Enabled',
    Prefix: '',
    Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
  };

  // The create path has its OWN `recordEffectiveFold` and its own skip answer,
  // and only lifecycle has a skip arm there — so neither is reachable from the
  // update rows above.
  it('records the fold on a template-path CREATE', async () => {
    const result = await provider.create('L', RESOURCE_TYPE, {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [aliasRule] },
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    const item = at(
      result.effectiveProperties,
      'LifecycleConfiguration',
      'Rules',
      0,
      'Transitions',
      0
    ) as Record<string, unknown>;
    expect(item['TransitionInDays']).toBe(30);
    expect('Days' in item).toBe(false);
  });

  it('DROPS the key when the create-path Put is skipped — a fresh bucket has no previous value', async () => {
    // Reachable only from the rollback executor's reverse-replacement arm,
    // whose `replayingState` context downgrades the refusal a malformed
    // `Status` would otherwise throw. Nothing was applied, so the effective bag
    // must not describe a call that never went out — and must not fold either.
    const result = await provider.create(
      'L',
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        LifecycleConfiguration: { Rules: [{ ...aliasRule, Status: null }] },
      },
      { replayingState: true }
    );

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties).toBeDefined();
    expect('LifecycleConfiguration' in (result.effectiveProperties ?? {})).toBe(false);
  });

  it('leaves a non-array Events alone rather than reshaping it', () => {
    // The wire prefers `Event` and ignores a malformed `Events`; with neither
    // usable there is nothing to fold onto, so the item is left for the
    // applier's own handling.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      NotificationConfiguration: {
        TopicConfigurations: [{ Topic: TOPIC_ARN, Events: 'ObjectCreated' }],
      },
    });

    expect(at(canonical, 'NotificationConfiguration', 'TopicConfigurations', 0)).toEqual({
      Topic: TOPIC_ARN,
      Events: 'ObjectCreated',
    });
  });

  it('identity-returns a non-plain-object block on either fold', () => {
    // A malformed block must still reach the provider's own refusal rather than
    // being reshaped into something that looks valid.
    for (const block of ['Enabled', 42, [], null]) {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        NotificationConfiguration: block,
        LifecycleConfiguration: block,
      });
      expect(canonical['NotificationConfiguration']).toEqual(block);
      expect(canonical['LifecycleConfiguration']).toEqual(block);
    }
  });

  it('falls through a NULLISH TransitionInDays to the Days alias, as the wire does', () => {
    // The notification family pins this; the lifecycle aliases run the same
    // helper and are pinned here so a per-family regression cannot hide.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: {
        Rules: [
          {
            ...aliasRule,
            Transitions: [{ TransitionInDays: null, Days: 30, StorageClass: 'GLACIER' }],
            NoncurrentVersionTransitions: [
              { TransitionInDays: null, NoncurrentDays: 45, StorageClass: 'GLACIER' },
            ],
          },
        ],
      },
    });

    const t = at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'Transitions', 0) as Record<
      string,
      unknown
    >;
    expect(t['TransitionInDays']).toBe(30);
    expect('Days' in t).toBe(false);
    const nvt = at(
      canonical,
      'LifecycleConfiguration',
      'Rules',
      0,
      'NoncurrentVersionTransitions',
      0
    ) as Record<string, unknown>;
    expect(nvt['TransitionInDays']).toBe(45);
    expect('NoncurrentDays' in nvt).toBe(false);
  });
});

/**
 * Issues #1754 / #1755 / #1759 — the residuals the #1748 round-trip fence
 * MEASURED and this file now covers.
 *
 * Everything below keeps the five rules the header states, plus two more the
 * residuals forced:
 *
 * 6. **A WHOLE-RULE fence, not a per-key one.** The #1748 rows compared one
 *    nested item at a time, which is exactly why they missed the RULE-level
 *    divergences (`ExpirationInDays`, `NoncurrentVersionExpirationInDays`, the
 *    sent-but-unrecorded `Filter`). The rows here assert the whole recorded
 *    rule against the whole emitted one.
 * 7. **The arms that must NOT fold are pinned too**, with the reason. A fold
 *    that also folds a colliding singular, a refused value or a warned
 *    narrowing makes the comparison equal, so the provider is never called
 *    again and the warning STOPS.
 */

/** Drive an UPDATE and return the record + the readback for the same call. */
async function lifecycleRoundTrip(rules: Array<Record<string, unknown>>): Promise<{
  recorded: unknown;
  readback: unknown;
  effective: Record<string, unknown> | undefined;
}> {
  const properties = { BucketName: BUCKET, LifecycleConfiguration: { Rules: rules } };
  const { effective, lifecycleInput } = await update(properties);
  const recorded = at(effective, 'LifecycleConfiguration') ?? properties.LifecycleConfiguration;
  const readback = await readbackOf(
    'lifecycle',
    at(lifecycleInput, 'LifecycleConfiguration') as Record<string, unknown>
  );
  return { recorded, readback, effective };
}

describe('issue #1754: the legacy SINGULAR transition objects', () => {
  const singularCases = [
    {
      pluralKey: 'Transitions',
      singularKey: 'Transition',
      singular: { StorageClass: 'DEEP_ARCHIVE', TransitionInDays: 90 },
      plural: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
    },
    {
      pluralKey: 'NoncurrentVersionTransitions',
      singularKey: 'NoncurrentVersionTransition',
      singular: { StorageClass: 'DEEP_ARCHIVE', TransitionInDays: 90 },
      plural: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
    },
  ] as const;

  for (const { pluralKey, singularKey, singular, plural } of singularCases) {
    it(`merges a non-colliding ${singularKey} into ${pluralKey}, which is the only spelling readLifecycle emits`, async () => {
      const { recorded, readback } = await lifecycleRoundTrip([
        { Id: 'r1', Status: 'Enabled', Prefix: 'archive/', [pluralKey]: plural, [singularKey]: singular },
      ]);

      const rule = at(recorded, 'Rules', 0) as Record<string, unknown>;
      // REMOVED, not `undefined` — the drift walk sees a present-but-undefined key.
      expect(singularKey in rule).toBe(false);
      expect(rule[pluralKey]).toEqual([...plural, singular]);
      // The fence: the recorded rule IS what `readCurrentState` emits for the
      // configuration that was just sent.
      expect(at(readback, 'Rules', 0)).toEqual(rule);
    });

    it(`merges a ${singularKey} declared with NO plural sibling`, async () => {
      const { recorded, readback } = await lifecycleRoundTrip([
        { Id: 'r1', Status: 'Enabled', Prefix: 'archive/', [singularKey]: singular },
      ]);

      const rule = at(recorded, 'Rules', 0) as Record<string, unknown>;
      expect(singularKey in rule).toBe(false);
      expect(rule[pluralKey]).toEqual([singular]);
      expect(at(readback, 'Rules', 0)).toEqual(rule);
    });

    it(`folds the template side identically for ${singularKey}`, () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        LifecycleConfiguration: {
          Rules: [
            { Id: 'r1', Status: 'Enabled', Prefix: 'archive/', [pluralKey]: plural, [singularKey]: singular },
          ],
        },
      });

      const rule = at(canonical, 'LifecycleConfiguration', 'Rules', 0) as Record<string, unknown>;
      expect(singularKey in rule).toBe(false);
      expect(rule[pluralKey]).toEqual([...plural, singular]);
    });

    it(`leaves a COLLIDING ${singularKey} alone on BOTH sides, so the wire's warning keeps firing`, async () => {
      // The decision this issue was split out for. `mergeLegacySingular` DROPS
      // the singular and WARNS on a StorageClass collision; folding both sides
      // identically would make the comparison equal, so `update()` would never
      // be called again and that warning would stop after one deploy — the
      // #1670 finding-3 concealment. Keeping both keys leaves the difference
      // visible instead.
      const colliding = { StorageClass: 'GLACIER', TransitionInDays: 90 };
      const rules = [
        { Id: 'r1', Status: 'Enabled', Prefix: 'archive/', [pluralKey]: plural, [singularKey]: colliding },
      ];
      const { recorded } = await lifecycleRoundTrip(rules);

      const rule = at(recorded, 'Rules', 0) as Record<string, unknown>;
      expect(rule[singularKey]).toEqual(colliding);
      expect(rule[pluralKey]).toEqual(plural);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('storage class GLACIER')
      );

      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        LifecycleConfiguration: { Rules: rules },
      });
      expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, singularKey)).toEqual(colliding);
    });
  }

  it('runs the alias fold over a merged singular too, rather than only over the declared plural', async () => {
    // The singular can carry the SDK day/date spellings as well, so the merge
    // has to happen BEFORE the alias fold or a `Transition: {Days}` lands in
    // the plural array still spelled `Days`.
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'r1', Status: 'Enabled', Prefix: 'archive/', Transition: { Days: 90, StorageClass: 'GLACIER' } },
    ]);

    expect(at(recorded, 'Rules', 0, 'Transitions', 0)).toEqual({
      TransitionInDays: 90,
      StorageClass: 'GLACIER',
    });
    expect(at(readback, 'Rules', 0)).toEqual(at(recorded, 'Rules', 0));
  });

  it('leaves a non-object singular alone, exactly as mergeLegacySingular does', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: {
        Rules: [{ Id: 'r1', Status: 'Enabled', Prefix: 'archive/', Transition: 'GLACIER' }],
      },
    });
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'Transition')).toBe('GLACIER');
  });
});

describe('issue #1755: the RULE-level lifecycle divergences', () => {
  it('records the WHOLE ordinary CDK-shaped rule as readLifecycle emits it', async () => {
    // The headline measurement: an ordinary CDK-shaped rule using NO cdkd
    // tolerance at all still disagreed with the readback on three keys.
    const { recorded, readback } = await lifecycleRoundTrip([
      {
        Id: 'cdk-rule',
        Status: 'Enabled',
        ExpirationInDays: 30,
        NoncurrentVersionExpirationInDays: 7,
        Transitions: [{ TransitionInDays: 90, StorageClass: 'GLACIER' }],
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
      },
    ]);

    expect(at(recorded, 'Rules', 0)).toEqual({
      Id: 'cdk-rule',
      Status: 'Enabled',
      ExpirationInDays: 30,
      NoncurrentVersionExpiration: { NoncurrentDays: 7 },
      Transitions: [{ TransitionInDays: 90, StorageClass: 'GLACIER' }],
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
      Filter: { Prefix: '' },
    });
    // ...and the whole recorded rule is what the readback emits.
    expect(at(readback, 'Rules', 0)).toEqual(at(recorded, 'Rules', 0));
  });

  it('folds the template side to the same bag', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: {
        Rules: [{ Id: 'cdk-rule', ExpirationInDays: 30, NoncurrentVersionExpirationInDays: 7 }],
      },
    });

    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0)).toEqual({
      Id: 'cdk-rule',
      Status: 'Enabled',
      ExpirationInDays: 30,
      NoncurrentVersionExpiration: { NoncurrentDays: 7 },
      Filter: { Prefix: '' },
    });
  });

  it('moves a bare top-level Prefix under Filter when ANY rule forces the V2 form', async () => {
    // `useFilterForm` is decided across the WHOLE list, so a per-rule fold
    // cannot answer this — the second rule is what pushes the first into V2.
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'v1-ish', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 30 },
      { Id: 'scope-less', Status: 'Enabled', ExpirationInDays: 60 },
    ]);

    expect(at(recorded, 'Rules', 0, 'Filter')).toEqual({ Prefix: 'logs/' });
    expect('Prefix' in (at(recorded, 'Rules', 0) as Record<string, unknown>)).toBe(false);
    expect(at(recorded, 'Rules', 1, 'Filter')).toEqual({ Prefix: '' });
    expect(at(readback, 'Rules')).toEqual(at(recorded, 'Rules'));
  });

  it('leaves a V1 configuration completely alone — nothing moves when every rule is prefix-only', async () => {
    // The identity arm, and the vacuity guard for the row above: without it a
    // fold that ALWAYS built a Filter would look correct.
    const { recorded, readback, effective } = await lifecycleRoundTrip([
      { Id: 'a', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 30 },
      { Id: 'b', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 60 },
    ]);

    expect(effective).toBeUndefined();
    expect(at(recorded, 'Rules', 0, 'Prefix')).toBe('logs/');
    expect(at(readback, 'Rules')).toEqual(at(recorded, 'Rules'));
  });

  it('moves rule-level TagFilters and ObjectSize* under Filter, which is where the readback emits them', async () => {
    const tagFilters = [{ Key: 'env', Value: 'prod' }];
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'tagged', Status: 'Enabled', TagFilters: tagFilters, ExpirationInDays: 30 },
      {
        Id: 'combined',
        Status: 'Enabled',
        Prefix: 'big/',
        ObjectSizeGreaterThan: 1024,
        ExpirationInDays: 60,
      },
    ]);

    expect(at(recorded, 'Rules', 0, 'Filter')).toEqual({ TagFilters: tagFilters });
    expect('TagFilters' in (at(recorded, 'Rules', 0) as Record<string, unknown>)).toBe(false);
    expect(at(recorded, 'Rules', 1, 'Filter')).toEqual({
      Prefix: 'big/',
      ObjectSizeGreaterThan: 1024,
    });
    expect(at(readback, 'Rules')).toEqual(at(recorded, 'Rules'));
  });

  it('records the ISO date the readback emits for an ExpirationDate', async () => {
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'dated', Status: 'Enabled', Prefix: 'x/', ExpirationDate: '2030-01-01' },
    ]);

    expect(at(recorded, 'Rules', 0, 'ExpirationDate')).toBe('2030-01-01T00:00:00.000Z');
    expect(at(readback, 'Rules', 0)).toEqual(at(recorded, 'Rules', 0));
  });

  it('folds the cdkd-only Expiration OBJECT onto the CFn scalars', async () => {
    // The applier accepts `Expiration` as a third source; the CFn `Rule`
    // definition has no such member, so recording it would put a spelling in
    // state that no template can declare.
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'obj', Status: 'Enabled', Prefix: 'x/', Expiration: { Days: 30 } },
    ]);

    const rule = at(recorded, 'Rules', 0) as Record<string, unknown>;
    expect('Expiration' in rule).toBe(false);
    expect(rule['ExpirationInDays']).toBe(30);
    expect(at(readback, 'Rules', 0)).toEqual(rule);
  });

  it('round-trips a marker-ONLY rule, whose Expiration exists solely to carry the flag', async () => {
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'markers', Status: 'Enabled', Prefix: 'markers/', ExpiredObjectDeleteMarker: true },
    ]);

    expect(at(recorded, 'Rules', 0, 'ExpiredObjectDeleteMarker')).toBe(true);
    expect(at(readback, 'Rules', 0)).toEqual(at(recorded, 'Rules', 0));
  });

  it('coerces a stringly-typed legacy NoncurrentVersionExpirationInDays exactly as the wire does', async () => {
    const { recorded, readback } = await lifecycleRoundTrip([
      { Id: 'legacy', Status: 'Enabled', Prefix: 'x/', NoncurrentVersionExpirationInDays: '365' },
    ]);

    expect(at(recorded, 'Rules', 0, 'NoncurrentVersionExpiration')).toEqual({
      NoncurrentDays: 365,
    });
    expect(at(readback, 'Rules', 0)).toEqual(at(recorded, 'Rules', 0));
  });

  it('DROPS the legacy scalar when the modern object also wins on the wire', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'both',
            Status: 'Enabled',
            Prefix: 'x/',
            NoncurrentVersionExpirationInDays: 7,
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          },
        ],
      },
    });

    const rule = at(canonical, 'LifecycleConfiguration', 'Rules', 0) as Record<string, unknown>;
    expect('NoncurrentVersionExpirationInDays' in rule).toBe(false);
    expect(rule['NoncurrentVersionExpiration']).toEqual({ NoncurrentDays: 30 });
  });

  it('drops a declared-but-EMPTY transition list, which the applier never sends', async () => {
    const { recorded, readback } = await lifecycleRoundTrip([
      {
        Id: 'empty',
        Status: 'Enabled',
        Prefix: 'x/',
        ExpirationInDays: 30,
        Transitions: [],
        NoncurrentVersionTransitions: [],
      },
    ]);

    const rule = at(recorded, 'Rules', 0) as Record<string, unknown>;
    expect('Transitions' in rule).toBe(false);
    expect('NoncurrentVersionTransitions' in rule).toBe(false);
    expect(at(readback, 'Rules', 0)).toEqual(rule);
  });

  it('supplies the defaulted-but-SENT Status, which AWS reports on every rule', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: [{ Id: 'r', Prefix: 'x/', ExpirationInDays: 1 }] },
    });
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'Status')).toBe('Enabled');
  });

  it('leaves the WHOLE configuration alone when a rule is REFUSED', () => {
    // The Put is skipped for the whole configuration, so AWS keeps the previous
    // one; folding the desired side onto it would compare equal, `update()`
    // would never run, and the skip warning would stop.
    const rules = [
      { Id: 'ok', Status: 'Enabled', ExpirationInDays: 30 },
      { Id: 'bad', Status: null, ExpirationInDays: 60 },
    ];
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: rules },
    });
    expect(canonical['LifecycleConfiguration']).toEqual({ Rules: rules });
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'Filter')).toBeUndefined();
  });

  it('leaves the WHOLE configuration alone for a malformed Filter container', () => {
    const rules = [{ Id: 'bad', Status: 'Enabled', Filter: 'logs/' }];
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: rules },
    });
    expect(canonical['LifecycleConfiguration']).toEqual({ Rules: rules });
  });

  it('leaves an EMPTY Rules array alone — readLifecycle emits exactly that placeholder', () => {
    // Measured on the reverse-mapper, not assumed: `readLifecycle` answers
    // `{Rules: []}` for an unconfigured bucket (issue #1718), so the declared
    // placeholder ALREADY equals the readback and folding it would invent a
    // difference. The transition-list sibling above answers the OPPOSITE way
    // for exactly the same reason, measured the same way.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: [] },
    });
    expect(canonical['LifecycleConfiguration']).toEqual({ Rules: [] });
  });

  it('leaves a rule-level ExpiredObjectDeleteMarker colliding with Days ALONE (measured)', () => {
    // S3 forbids combining the marker with Days/Date; the applier WARNS and
    // applies neither. Folding the marker away on both sides would stop that
    // difference being reported, so it is left visible until the template drops
    // one of the two declarations.
    const rules = [
      { Id: 'clash', Status: 'Enabled', Prefix: 'x/', ExpirationInDays: 30, ExpiredObjectDeleteMarker: true },
    ];
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: rules },
    });
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'ExpiredObjectDeleteMarker')).toBe(
      true
    );
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'ExpirationInDays')).toBe(30);
  });

  it('leaves an UNREADABLE rule-level ExpiredObjectDeleteMarker alone', () => {
    // `coerceCfnBoolean` answers `undefined`, the wire silently ignores it, and
    // nothing warns — so the difference is the user's only signal.
    const rules = [
      { Id: 'junk', Status: 'Enabled', Prefix: 'x/', ExpirationInDays: 30, ExpiredObjectDeleteMarker: { Ref: 'P' } },
    ];
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      LifecycleConfiguration: { Rules: rules },
    });
    expect(at(canonical, 'LifecycleConfiguration', 'Rules', 0, 'ExpiredObjectDeleteMarker')).toEqual(
      { Ref: 'P' }
    );
  });
});

describe('issue #1759: the notification EventBridge / empty-family residuals', () => {
  it('records the BOOLEAN for a stringly-typed EventBridgeEnabled, which is what the readback emits', async () => {
    const properties = {
      BucketName: BUCKET,
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: 'true' } },
    };
    const { effective, notificationInput } = await update(properties);

    expect(at(effective, 'NotificationConfiguration', 'EventBridgeConfiguration')).toEqual({
      EventBridgeEnabled: true,
    });
    const sent = at(notificationInput, 'NotificationConfiguration') as Record<string, unknown>;
    const readback = await readbackOf('notification', sent);
    expect(at(readback, 'EventBridgeConfiguration')).toEqual(
      at(effective, 'NotificationConfiguration', 'EventBridgeConfiguration')
    );
  });

  it('records `false` for the stringly-typed disabled half too', async () => {
    // The vacuity guard for the row above: a fold that always answered `true`
    // would pass it.
    const { effective, notificationInput } = await update({
      BucketName: BUCKET,
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: 'FALSE' } },
    });

    expect(at(effective, 'NotificationConfiguration', 'EventBridgeConfiguration')).toEqual({
      EventBridgeEnabled: false,
    });
    const sent = at(notificationInput, 'NotificationConfiguration') as Record<string, unknown>;
    const readback = await readbackOf('notification', sent);
    expect(at(readback, 'EventBridgeConfiguration')).toEqual({ EventBridgeEnabled: false });
  });

  it('folds the template side identically', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: 'true' } },
    });
    expect(at(canonical, 'NotificationConfiguration', 'EventBridgeConfiguration')).toEqual({
      EventBridgeEnabled: true,
    });
  });

  it('folds a declared null block to the disabled boolean the wire sends', () => {
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      NotificationConfiguration: { EventBridgeConfiguration: null },
    });
    expect(at(canonical, 'NotificationConfiguration', 'EventBridgeConfiguration')).toEqual({
      EventBridgeEnabled: false,
    });
  });

  it('leaves an already-boolean block byte-for-byte alone', async () => {
    const { effective, notificationInput } = await update({
      BucketName: BUCKET,
      NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
    });
    expect(notificationInput).toBeDefined();
    expect(effective).toBeUndefined();
  });

  it('leaves a REFUSED EventBridgeEnabled completely alone on the template side', () => {
    // No patch, and the key not dropped: the wire SKIPS the whole Put for it, so
    // folding would collapse the desired side onto the retained previous value
    // and the skip warning would stop.
    const block = { EventBridgeEnabled: { Ref: 'SomeParam' } };
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      NotificationConfiguration: { EventBridgeConfiguration: block },
    });
    expect(at(canonical, 'NotificationConfiguration', 'EventBridgeConfiguration')).toEqual(block);
  });

  it('retains the PREVIOUS notification configuration when the update-path Put is skipped', async () => {
    const previous = {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ Topic: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
      },
    };
    const result = await provider.update(
      'L',
      BUCKET,
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        NotificationConfiguration: {
          EventBridgeConfiguration: { EventBridgeEnabled: 'yes' },
        },
      },
      previous
    );

    expect(sentCommands(PutBucketNotificationConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['NotificationConfiguration']).toEqual(
      previous.NotificationConfiguration
    );
  });

  it('DROPS a declared-but-EMPTY notification family, which readNotification never emits', async () => {
    const properties = {
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ Topic: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
        QueueConfigurations: [],
        LambdaConfigurations: [],
        EventBridgeConfiguration: { EventBridgeEnabled: false },
      },
    };
    const { effective, notificationInput } = await update(properties);

    const recorded = at(effective, 'NotificationConfiguration') as Record<string, unknown>;
    expect('QueueConfigurations' in recorded).toBe(false);
    expect('LambdaConfigurations' in recorded).toBe(false);
    // MEASURED, not assumed: `readNotification` emits a family only under
    // `resp.<Family>.length > 0`, so an unconfigured one comes back ABSENT —
    // the opposite of `readLifecycle`'s always-emitted `{Rules: []}`, which is
    // why the lifecycle placeholder is RECORDED (issue #1718) and this is not.
    const sent = at(notificationInput, 'NotificationConfiguration') as Record<string, unknown>;
    const readback = (await readbackOf('notification', sent)) as Record<string, unknown>;
    expect('QueueConfigurations' in readback).toBe(false);
    expect(recorded).toEqual(readback);
  });

  it('leaves a NON-array family alone rather than dropping it', () => {
    // The applier's `Array.isArray` gate skips it too, but it is MALFORMED:
    // dropping it would make the desired side compare equal and stop the
    // difference being reported.
    const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
      NotificationConfiguration: { TopicConfigurations: 'not-a-list' },
    });
    expect(at(canonical, 'NotificationConfiguration', 'TopicConfigurations')).toBe('not-a-list');
  });

  it('MEASURED: an absent EventBridge block stays absent from the record', async () => {
    // `readNotification` emits `EventBridgeConfiguration` unconditionally, so
    // the record IS one key short here. Deliberately not folded: nothing was
    // declared, so there is no spelling to normalize, and supplying the key
    // would record one the template does not have on EVERY
    // notification-configured bucket. #1430 already scopes that difference as a
    // one-time, self-clearing drift on the `properties`-fallback baseline.
    const { effective, notificationInput } = await update({
      BucketName: BUCKET,
      NotificationConfiguration: {
        TopicConfigurations: [{ Topic: TOPIC_ARN, Event: 's3:ObjectCreated:*' }],
      },
    });

    expect(effective).toBeUndefined();
    const sent = at(notificationInput, 'NotificationConfiguration') as Record<string, unknown>;
    const readback = (await readbackOf('notification', sent)) as Record<string, unknown>;
    expect(readback['EventBridgeConfiguration']).toEqual({ EventBridgeEnabled: false });
  });
});
