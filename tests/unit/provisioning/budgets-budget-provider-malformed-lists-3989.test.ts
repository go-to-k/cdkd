import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3989: `reconcileNotifications` / `reconcileResourceTags` derive
// their deletes from the gap between the desired and the recorded list, and
// both lists used to read a present-but-malformed value (or a malformed entry)
// as empty. On a rollback (desired side = a recorded bag)
// `NotificationsWithSubscribers: {}` deleted every notification. A malformed
// DESIRED list is now refused before any call; a malformed RECORDED list is
// applied ADD-only.

const mockSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());
const warned = vi.hoisted(() => [] as string[]);

vi.mock('@aws-sdk/client-budgets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-budgets')>();
  return {
    ...actual,
    BudgetsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
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
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DuplicateRecordException } from '@aws-sdk/client-budgets';
import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Budgets::Budget';
const ACCOUNT = '123456789012';
const ARN = `arn:aws:budgets::${ACCOUNT}:budget/issue3989`;
const SECRET_REF = '{{resolve:secretsmanager:issue3989/address:SecretString:email::}}';
/** A distinctive needle per malformed value, so a message echoing it is caught. */
const NEEDLE = 'issue3989-needle';

const BUDGET = {
  Budget: {
    BudgetName: 'issue3989',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: 10, Unit: 'USD' },
  },
};

const notification = (threshold: number, ...addresses: string[]): Record<string, unknown> => ({
  Notification: {
    NotificationType: 'ACTUAL',
    ComparisonOperator: 'GREATER_THAN',
    Threshold: threshold,
  },
  Subscribers: addresses.map((Address) => ({ SubscriptionType: 'EMAIL', Address })),
});

const sdkNotification = (threshold: number): Record<string, unknown> => ({
  NotificationType: 'ACTUAL',
  ComparisonOperator: 'GREATER_THAN',
  Threshold: threshold,
});

const NOTIFICATIONS_MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Notification: NEEDLE }],
  ['a false', false],
  ['a null entry', [null]],
  ['an entry with no Notification', [{ Subscribers: [] }]],
  [
    'an entry whose Threshold is not numeric',
    [{ Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GT', Threshold: NEEDLE } }],
  ],
  [
    'an entry with no NotificationType',
    [{ Notification: { ComparisonOperator: 'GREATER_THAN', Threshold: 80 } }],
  ],
  ['an entry whose Subscribers is an object', [{ ...notification(80), Subscribers: { NEEDLE } }]],
  [
    'a subscriber with no Address',
    [{ ...notification(80), Subscribers: [{ SubscriptionType: 'EMAIL' }] }],
  ],
  [
    'an entry with no ComparisonOperator',
    [{ Notification: { NotificationType: 'ACTUAL', Threshold: 80 } }],
  ],
  [
    'an entry whose ThresholdType is not a string',
    [{ ...notification(80), Notification: { ...sdkNotification(80), ThresholdType: 7 } }],
  ],
  [
    'a subscriber with no SubscriptionType',
    [{ ...notification(80), Subscribers: [{ Address: NEEDLE }] }],
  ],
  ['a valid entry beside a malformed one', [notification(80, 'a@example.com'), 7]],
];

const TAGS_MALFORMED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an object', { Key: NEEDLE }],
  ['an entry with no Key', [{ Value: NEEDLE }]],
  ['an entry with an empty Key', [{ Key: '', Value: NEEDLE }]],
  ['a string entry', [NEEDLE]],
];

function sent(name: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input as Record<string, unknown>);
}

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => c[0].constructor.name as string);
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

let provider: BudgetsBudgetProvider;

beforeEach(() => {
  mockSend.mockReset();
  mockStsSend.mockReset();
  warned.length = 0;
  mockSend.mockResolvedValue({});
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  provider = new BudgetsBudgetProvider();
});

describe('Budget update — a malformed DESIRED list is refused before any call (#3989)', () => {
  it.each(NOTIFICATIONS_MALFORMED)('NotificationsWithSubscribers: %s', async (_l, value) => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, NotificationsWithSubscribers: value },
        { ...BUDGET, NotificationsWithSubscribers: [notification(80, 'a@example.com')] }
      )
    );
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err.message).toMatch(
      /^desired NotificationsWithSubscribers of budget Budget is not a list of entries/
    );
    expect(err.message).toContain('the budget was not updated');
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it.each(TAGS_MALFORMED)('ResourceTags: %s', async (_l, value) => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, ResourceTags: value },
        { ...BUDGET, ResourceTags: [{ Key: 'team', Value: 'a' }] }
      )
    );
    expect(err.message).toMatch(/^desired ResourceTags of budget Budget is not a list of tags/);
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('names both lists when both are malformed', async () => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, NotificationsWithSubscribers: {}, ResourceTags: {} },
        BUDGET
      )
    );
    expect(err.message).toMatch(/^desired NotificationsWithSubscribers \/ ResourceTags of budget/);
  });

  it.each([
    ['a rollback replay (replayingState)', { replayingState: true }],
    ['drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('refuses on %s too', async (_l, context) => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, NotificationsWithSubscribers: {} },
        { ...BUDGET, NotificationsWithSubscribers: [notification(80, 'a@example.com')] },
        context
      )
    );
    expect(err.message).toMatch(/^desired NotificationsWithSubscribers/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a dynamic reference', SECRET_REF],
    ['its mask', '***'],
  ])('refuses a desired subscriber Address holding %s, naming the cause', async (_l, address) => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, NotificationsWithSubscribers: [notification(80, address)] },
        BUDGET
      )
    );
    expect(err.message).toContain('holds a dynamic reference or its mask');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a desired Notification member holding a dynamic reference', async () => {
    const entry = notification(80, 'a@example.com');
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        {
          ...BUDGET,
          NotificationsWithSubscribers: [
            {
              ...entry,
              Notification: {
                ...(entry['Notification'] as Record<string, unknown>),
                NotificationType: SECRET_REF,
              },
            },
          ],
        },
        BUDGET
      )
    );
    expect(err.message).toContain('NotificationsWithSubscribers holds a dynamic reference');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a desired tag Key holding a dynamic reference', async () => {
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, ResourceTags: [{ Key: SECRET_REF, Value: 'v' }] },
        BUDGET
      )
    );
    expect(err.message).toContain('ResourceTags holds a dynamic reference or its mask');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('Budget update — valid lists (#3989 positive polarity)', () => {
  it('sends exactly UpdateBudget, the notification delete + create, and the tag diff', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      {
        ...BUDGET,
        NotificationsWithSubscribers: [notification(90, 'a@example.com')],
        ResourceTags: [{ Key: 'env', Value: 'prod' }],
      },
      {
        ...BUDGET,
        NotificationsWithSubscribers: [notification(80, 'a@example.com')],
        ResourceTags: [
          { Key: 'env', Value: 'dev' },
          { Key: 'team', Value: 'a' },
        ],
      }
    );
    expect(sentNames()).toEqual([
      'UpdateBudgetCommand',
      'DeleteNotificationCommand',
      'CreateNotificationCommand',
      'UntagResourceCommand',
      'TagResourceCommand',
    ]);
    expect(sent('DeleteNotificationCommand')[0]!['Notification']).toEqual(sdkNotification(80));
    expect(sent('UntagResourceCommand')[0]).toEqual({
      ResourceARN: ARN,
      ResourceTagKeys: ['team'],
    });
  });

  it('a null desired list still removes every recorded entry (absent semantics)', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, NotificationsWithSubscribers: null, ResourceTags: null },
      {
        ...BUDGET,
        NotificationsWithSubscribers: [notification(80, 'a@example.com')],
        ResourceTags: [{ Key: 'team', Value: 'a' }],
      }
    );
    expect(sent('DeleteNotificationCommand')).toHaveLength(1);
    expect(sent('UntagResourceCommand')[0]!['ResourceTagKeys']).toEqual(['team']);
  });

  it('keeps a recorded secret-derived subscriber Address out of the delete set', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, NotificationsWithSubscribers: [notification(80, 'a@example.com')] },
      {
        ...BUDGET,
        NotificationsWithSubscribers: [notification(80, 'a@example.com', SECRET_REF, '***')],
      }
    );
    // Exactly the reconcile of an unchanged notification: read as a WELL-FORMED
    // record (not the ADD-only arm, which would send CreateNotification and warn).
    expect(sentNames()).toEqual(['UpdateBudgetCommand']);
    expect(warned.some((w) => w.includes('recorded NotificationsWithSubscribers'))).toBe(false);
  });

  it('keeps a recorded secret-derived notification and tag Key out of the delete set', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, NotificationsWithSubscribers: [], ResourceTags: [] },
      {
        ...BUDGET,
        NotificationsWithSubscribers: [
          {
            Notification: {
              NotificationType: 'ACTUAL',
              ComparisonOperator: SECRET_REF,
              Threshold: 80,
            },
            Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }],
          },
        ],
        ResourceTags: [
          { Key: SECRET_REF, Value: 'v' },
          { Key: 'team', Value: 'a' },
        ],
      }
    );
    expect(sentNames()).toEqual(['UpdateBudgetCommand', 'UntagResourceCommand']);
    expect(sent('UntagResourceCommand')).toEqual([{ ResourceARN: ARN, ResourceTagKeys: ['team'] }]);
    expect(warned.some((w) => w.includes('is not a list cdkd can read'))).toBe(false);
  });

  it('reads a legitimate a***b tag key as a plain key: it is untagged when dropped', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, ResourceTags: [] },
      { ...BUDGET, ResourceTags: [{ Key: 'a***b', Value: 'v' }] }
    );
    expect(sent('UntagResourceCommand')).toEqual([{ ResourceARN: ARN, ResourceTagKeys: ['a***b'] }]);
  });
});

describe('Budget update — the reconciler on a notification that already exists (#3989 review)', () => {
  it('an added notification that already exists gets its desired subscribers', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'CreateNotificationCommand'
        ? Promise.reject(new DuplicateRecordException({ message: 'exists', $metadata: {} }))
        : Promise.resolve({})
    );
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, NotificationsWithSubscribers: [notification(80, 'a@example.com')] },
      { ...BUDGET, NotificationsWithSubscribers: [] }
    );
    expect(sent('CreateSubscriberCommand').map((i) => i['Subscriber'])).toEqual([
      { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
    ]);
  });

  it('accepts an entry with no Subscribers as a notification with none', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, NotificationsWithSubscribers: [{ Notification: sdkNotification(80) }] },
      BUDGET
    );
    expect(sent('CreateNotificationCommand')).toEqual([
      {
        AccountId: ACCOUNT,
        BudgetName: 'issue3989',
        Notification: sdkNotification(80),
        Subscribers: undefined,
      },
    ]);
  });
});

describe('Budget update — a malformed RECORDED list is applied ADD-only (#3989)', () => {
  it('NotificationsWithSubscribers: creates every desired notification and deletes nothing', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      {
        ...BUDGET,
        NotificationsWithSubscribers: [
          notification(80, 'a@example.com'),
          notification(90, 'b@example.com'),
        ],
      },
      { ...BUDGET, NotificationsWithSubscribers: [{ Notification: { Ref: 'Unresolved' } }] }
    );
    expect(sentNames()).toEqual([
      'UpdateBudgetCommand',
      'CreateNotificationCommand',
      'CreateNotificationCommand',
    ]);
    expect(sent('CreateNotificationCommand').map((i) => i['Notification'])).toEqual([
      sdkNotification(80),
      sdkNotification(90),
    ]);
    expect(
      warned.some((w) =>
        w.includes('recorded NotificationsWithSubscribers of budget Budget is not a list')
      )
    ).toBe(true);
  });

  it('adds each desired subscriber to a notification that already exists', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'CreateNotificationCommand'
        ? Promise.reject(new DuplicateRecordException({ message: 'exists', $metadata: {} }))
        : Promise.resolve({})
    );
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      {
        ...BUDGET,
        NotificationsWithSubscribers: [notification(80, 'a@example.com', 'b@example.com')],
      },
      { ...BUDGET, NotificationsWithSubscribers: 'unreadable' }
    );
    expect(sentNames()).toEqual([
      'UpdateBudgetCommand',
      'CreateNotificationCommand',
      'CreateSubscriberCommand',
      'CreateSubscriberCommand',
    ]);
    expect(sent('CreateSubscriberCommand').map((i) => i['Subscriber'])).toEqual([
      { SubscriptionType: 'EMAIL', Address: 'a@example.com' },
      { SubscriptionType: 'EMAIL', Address: 'b@example.com' },
    ]);
  });

  it('propagates a non-duplicate CreateNotification failure', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'CreateNotificationCommand'
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({})
    );
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        { ...BUDGET, NotificationsWithSubscribers: [notification(80, 'a@example.com')] },
        { ...BUDGET, NotificationsWithSubscribers: {} }
      )
    );
    expect(err.message).toContain('AccessDenied');
    expect(sent('CreateSubscriberCommand')).toHaveLength(0);
  });

  it('names the ADD-only context when a create fails, e.g. on the notification limit', async () => {
    const quota = new Error('You have exceeded the notification limit');
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'CreateNotificationCommand'
        ? Promise.reject(quota)
        : Promise.resolve({})
    );
    const err = await rejection(
      provider.update(
        'Budget',
        'issue3989',
        TYPE,
        {
          ...BUDGET,
          NotificationsWithSubscribers: [
            notification(80, 'a@example.com'),
            notification(90, 'a@example.com'),
          ],
        },
        { ...BUDGET, NotificationsWithSubscribers: {} }
      )
    );
    expect(err.message).toContain('adding 2 desired notification(s)');
    expect(err.message).toContain('none was deleted');
    expect(err.message).toContain('at most 5 notifications');
    expect(err.message).toContain('exceeded the notification limit');
    expect((err as ProvisioningError).cause).toBe(quota);
  });

  it('ResourceTags: tags the desired set and untags nothing', async () => {
    await provider.update(
      'Budget',
      'issue3989',
      TYPE,
      { ...BUDGET, ResourceTags: [{ Key: 'env', Value: 'prod' }] },
      { ...BUDGET, ResourceTags: [{ Key: { Ref: 'Unresolved' }, Value: 'x' }] }
    );
    expect(sentNames()).toEqual(['UpdateBudgetCommand', 'TagResourceCommand']);
    expect(sent('TagResourceCommand')[0]).toEqual({
      ResourceARN: ARN,
      ResourceTags: [{ Key: 'env', Value: 'prod' }],
    });
    expect(warned.some((w) => w.includes('recorded ResourceTags of budget Budget'))).toBe(true);
  });

  it('ResourceTags: sends nothing when the desired set is empty', async () => {
    await provider.update('Budget', 'issue3989', TYPE, BUDGET, { ...BUDGET, ResourceTags: {} });
    expect(sentNames()).toEqual(['UpdateBudgetCommand']);
    expect(warned.some((w) => w.includes('recorded ResourceTags of budget Budget'))).toBe(true);
  });
});

describe('Budget create — a malformed list is refused before any call (#3989)', () => {
  it.each([
    ...NOTIFICATIONS_MALFORMED.map(([l, v]) => [`NotificationsWithSubscribers: ${l}`, { NotificationsWithSubscribers: v }] as const),
    ...TAGS_MALFORMED.map(([l, v]) => [`ResourceTags: ${l}`, { ResourceTags: v }] as const),
  ])('%s', async (_l, props) => {
    const err = await rejection(provider.create('Budget', TYPE, { ...BUDGET, ...props }));
    expect(err.message).toMatch(/of budget Budget is not a list of/);
    expect(err.message).toContain('the budget was not created');
    expect(err.message).not.toContain(NEEDLE);
    expect(err.message).not.toContain('dynamic reference');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a subscriber Address', { NotificationsWithSubscribers: [notification(80, SECRET_REF)] }, 'NotificationsWithSubscribers'],
    ['a tag Key', { ResourceTags: [{ Key: SECRET_REF, Value: 'v' }] }, 'ResourceTags'],
  ])('names the dynamic-reference cause when %s holds one', async (_l, props, kind) => {
    const err = await rejection(provider.create('Budget', TYPE, { ...BUDGET, ...props }));
    expect(err.message).toContain(`${kind} holds a dynamic reference or its mask`);
    expect(err.message).toContain('the budget was not created');
    expect(err.message).not.toContain('secretsmanager');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('passes valid lists through CreateBudget', async () => {
    await provider.create('Budget', TYPE, {
      ...BUDGET,
      NotificationsWithSubscribers: [
        { ...notification(80, 'a@example.com'), Notification: { ...sdkNotification(80), Threshold: '80' } },
      ],
      ResourceTags: [{ Key: 'env', Value: 'dev' }],
    });
    expect(sentNames()).toEqual(['CreateBudgetCommand']);
    const input = sent('CreateBudgetCommand')[0]!;
    expect(input['NotificationsWithSubscribers']).toEqual([
      {
        Notification: sdkNotification(80),
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'a@example.com' }],
      },
    ]);
    expect(input['ResourceTags']).toEqual([{ Key: 'env', Value: 'dev' }]);
  });
});
