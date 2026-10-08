/**
 * go-to-k/cdkd#4741: on the first v11 deploy over a pre-v11 record, a migration
 * witness that DIFFERS keeps the record's stored plaintext (the PREVIOUS value
 * of a `NoEcho` position) on the side handed to the provider as its previous
 * properties. It must be masked wherever it is printed: the provider's masker,
 * the deploy's own log lines, its errors and its saves. Driven through
 * `DeployEngine.deploy` with the REAL `DiffCalculator`, `DagBuilder` and
 * `IntrinsicFunctionResolver`. The provider double logs as a real provider
 * does: unmasked text through the logger, which masks it with the masker the
 * engine binds for the current resource (`currentLogLineMasker`, what
 * `ConsoleLogger` applies; the logger itself is mocked here).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const paths = CREATE_ONLY_PATHS_SNAPSHOT.get(command.input?.TypeName ?? '');
          if (paths === undefined) {
            return Promise.reject(
              Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
              })
            );
          }
          return Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
              writeOnlyProperties: [],
            }),
          });
        }),
      },
      sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'noecho-witness-log-stack';
const REGION = 'us-east-1';
const OLD = 'old-addr-4741@example.com';
const NEW = 'new-addr-4741@example.com';
// A 3-character previous value: under the needle floor, masked only as a
// whole printed text.
const OLD_SHORT = 'q7z';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:alerts';

const notifications = (subscribers: unknown[], threshold: unknown = 80): unknown[] => [
  {
    Notification: {
      NotificationType: 'ACTUAL',
      ComparisonOperator: 'GREATER_THAN',
      Threshold: threshold,
    },
    Subscribers: subscribers,
  },
];
const email = (address: unknown): unknown => ({ SubscriptionType: 'EMAIL', Address: address });

/** A record a pre-v11 binary wrote: the plaintext it last sent, no marker. */
function v10State(
  id: string,
  resourceType: string,
  properties: Record<string, unknown>
): StackState {
  return {
    version: 10 as never,
    region: REGION,
    stackName: STACK,
    resources: {
      [id]: { physicalId: `${id}-old-phys`, resourceType, properties, attributes: {}, dependencies: [] },
    },
    outputs: {},
    lastModified: 0,
  };
}

const budgetRecord = (subscribers: unknown[], threshold: unknown = 80): StackState =>
  v10State('Bud', 'AWS::Budgets::Budget', {
    Budget: { BudgetName: 'b' },
    NotificationsWithSubscribers: notifications(subscribers, threshold),
  });

function budgetTemplate(
  value: string,
  extra: { threshold?: unknown; parameters?: Record<string, unknown> } = {}
): CloudFormationTemplate {
  return {
    Parameters: { Mail: { Type: 'String', NoEcho: true, Default: value }, ...extra.parameters },
    Resources: {
      Bud: {
        Type: 'AWS::Budgets::Budget',
        Properties: {
          Budget: { BudgetName: 'b' },
          NotificationsWithSubscribers: notifications([email({ Ref: 'Mail' })], extra.threshold),
        },
      },
    },
  } as CloudFormationTemplate;
}

/** What `ConsoleLogger` does with a line: mask it with the bound masker. */
function say(text: string): void {
  const mask = currentLogLineMasker();
  getLogger().debug(mask === undefined ? text : mask(text));
}

describe('DeployEngine - a differing pre-v11 witness value is masked wherever it prints (go-to-k/cdkd#4741)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };
  const logger = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const printed = (): string =>
    JSON.stringify(
      [logger.debug, logger.info, logger.warn, logger.error].map((fn) => fn!.mock.calls)
    );
  const saved = (): string => JSON.stringify(stateBackend.saveState.mock.calls);

  beforeEach(() => {
    clearCreateOnlyPropertiesCache();
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-new-phys`, attributes: {} })
      ),
      // A reconciling provider (the Budgets provider's `Deleted subscriber
      // ${subKey}`) prints the PREVIOUS value.
      update: vi.fn(
        (
          _logicalId: string,
          physicalId: string,
          _type: string,
          _props: Record<string, unknown>,
          previous: Record<string, unknown>
        ) => {
          say(`Previous properties ${JSON.stringify(previous)}`);
          say('Kept notification ACTUAL GREATER_THAN EMAIL');
          return Promise.resolve({ physicalId, wasReplaced: false });
        }
      ),
      delete: vi.fn(
        (_logicalId: string, physicalId: string, _type: string, properties?: Record<string, unknown>) => {
          say(`Deleting ${physicalId} ${JSON.stringify(properties)}`);
          return Promise.resolve(undefined);
        }
      ),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    } as never;
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, captureObservedState: false },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  it('masks the previous value in a provider line, every log argument and every save of an in-place update', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(OLD)]), etag: 'e' });
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    const updates = provider.update.mock.calls.filter((c) => c[0] === 'Bud');
    expect(updates).toHaveLength(1);
    // The provider still receives the real previous value to reconcile with.
    expect(JSON.stringify(updates[0]![4])).toContain(OLD);
    expect(printed()).toContain('Previous properties');
    expect(printed()).not.toContain(OLD);
    // Scoped to the value: other text prints as it is.
    expect(printed()).toContain('Kept notification ACTUAL GREATER_THAN EMAIL');
    expect(saved()).not.toContain(OLD);
  });

  it("masks it in a replacement's delete of the old resource", async () => {
    stateBackend.getState.mockResolvedValue({
      state: v10State('Sub', 'AWS::SNS::Subscription', {
        Protocol: 'email',
        TopicArn: TOPIC_ARN,
        Endpoint: OLD,
      }),
      etag: 'e',
    });
    await makeEngine().deploy(STACK, {
      Parameters: { Mail: { Type: 'String', NoEcho: true, Default: NEW } },
      Resources: {
        Sub: {
          Type: 'AWS::SNS::Subscription',
          Properties: { Protocol: 'email', TopicArn: TOPIC_ARN, Endpoint: { Ref: 'Mail' } },
        },
      },
    } as CloudFormationTemplate);
    expect(provider.create.mock.calls.filter((c) => c[0] === 'Sub')).toHaveLength(1);
    const deletes = provider.delete.mock.calls.filter((c) => c[0] === 'Sub');
    expect(deletes).toHaveLength(1);
    expect(JSON.stringify(deletes[0]![3])).toContain(OLD);
    expect(printed()).toContain('Deleting Sub-old-phys');
    expect(printed()).not.toContain(OLD);
    expect(saved()).not.toContain(OLD);
  });

  it('masks it in the error a failed update raises', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(OLD)]), etag: 'e' });
    provider.update.mockImplementation(() =>
      Promise.reject(new Error(`Subscriber ${OLD} could not be removed`))
    );
    const outcome = await makeEngine()
      .deploy(STACK, budgetTemplate(NEW))
      .then(
        (result) => JSON.stringify(result),
        (error: unknown) => {
          const chain: string[] = [];
          for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
            chain.push(e.message);
          }
          return chain.join(' | ');
        }
      );
    expect(outcome).toContain('could not be removed');
    expect(outcome).not.toContain(OLD);
    expect(printed()).not.toContain(OLD);
    expect(saved()).not.toContain(OLD);
    expect(JSON.stringify(stateBackend.appendRollbackJournalSegment.mock.calls)).not.toContain(OLD);
  });

  it('records only the secret leaves of a list compared whole, and persists nothing differently', async () => {
    // Two subscribers recorded, one declared: the witness compares the list
    // whole. `EMAIL` (declared) is not the secret; the removed subscriber's
    // address may be.
    const REMOVED = 'removed-4741@example.com';
    stateBackend.getState.mockResolvedValue({
      state: budgetRecord([email(OLD), email(REMOVED)]),
      etag: 'e',
    });
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(1);
    expect(printed()).not.toContain(OLD);
    expect(printed()).not.toContain(REMOVED);
    expect(printed()).toContain('Kept notification ACTUAL GREATER_THAN EMAIL');
    // The fingerprint the save stamps is computed, not refused: nothing that
    // persists reads what was recorded.
    const record = (stateBackend.saveState.mock.calls.at(-1)![2] as StackState).resources['Bud']!;
    expect(record.maskedPropertyFingerprints?.['NotificationsWithSubscribers']).toMatch(/^sha256:/);
  });

  it('does not record a "true" string of a list compared whole, which would mask every line saying it', async () => {
    stateBackend.getState.mockResolvedValue({
      state: budgetRecord([email(OLD), email('true')]),
      etag: 'e',
    });
    provider.update.mockImplementation(
      (
        _logicalId: string,
        physicalId: string,
        _type: string,
        _props: Record<string, unknown>,
        previous: Record<string, unknown>
      ) => {
        say(`Previous properties ${JSON.stringify(previous)}`);
        say('Notifications enabled: true');
        return Promise.resolve({ physicalId, wasReplaced: false });
      }
    );
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(1);
    expect(printed()).not.toContain(OLD);
    expect(printed()).toContain('Notifications enabled: true');
  });

  it('prints it in neither the update nor its automatic rollback when a later resource fails', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(OLD)]), etag: 'e' });
    provider.update.mockImplementation(
      (
        _logicalId: string,
        physicalId: string,
        _type: string,
        props: Record<string, unknown>,
        previous: Record<string, unknown>
      ) => {
        say(`Update ${JSON.stringify(props)} from ${JSON.stringify(previous)}`);
        return Promise.resolve({ physicalId, wasReplaced: false });
      }
    );
    provider.create.mockImplementation(() => Promise.reject(new Error('create failed')));
    const tpl = budgetTemplate(NEW);
    tpl.Resources['Later'] = {
      Type: 'AWS::SNS::Topic',
      DependsOn: ['Bud'],
      Properties: { TopicName: 'later' },
    } as never;
    await makeEngine()
      .deploy(STACK, tpl)
      .catch(() => undefined);
    // The update, then the rollback re-applying the previous record.
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud').length).toBeGreaterThanOrEqual(2);
    expect(printed()).toContain('Update ');
    expect(printed()).not.toContain(OLD);
  });

  it('masks it whole after the provider capability masked a value embedded in it first', async () => {
    // The previous value embeds the current one, which the resolution bag (the
    // provider's `maskSecrets`) masks on its own: `***-rotated-away` must not
    // survive to the line.
    const EMBEDDING = `${NEW}-rotated-away`;
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(EMBEDDING)]), etag: 'e' });
    provider.update.mockImplementation(
      (
        _logicalId: string,
        physicalId: string,
        _type: string,
        _props: Record<string, unknown>,
        previous: Record<string, unknown>,
        context?: { maskSecrets?: (text: string) => string }
      ) => {
        const address = (
          previous['NotificationsWithSubscribers'] as Array<{
            Subscribers: Array<{ Address: string }>;
          }>
        )[0]!.Subscribers[0]!.Address;
        const capability = context?.maskSecrets ?? ((text: string) => text);
        say(`Removing ${capability(address)}`);
        return Promise.resolve({ physicalId, wasReplaced: false });
      }
    );
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(1);
    expect(printed()).toContain('Removing ***');
    expect(printed()).not.toContain('rotated-away');
  });

  it('masks a Number value by its printed form', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(NEW)], 73519), etag: 'e' });
    await makeEngine().deploy(
      STACK,
      budgetTemplate(NEW, {
        threshold: { Ref: 'Limit' },
        parameters: { Limit: { Type: 'Number', NoEcho: true, Default: 90 } },
      })
    );
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(1);
    expect(printed()).toContain('Previous properties');
    expect(printed()).not.toContain('73519');
  });

  it('masks a value under the needle floor where it is the whole printed text', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(OLD_SHORT)]), etag: 'e' });
    provider.update.mockImplementation((_l: string, physicalId: string) => {
      say(OLD_SHORT);
      return Promise.resolve({ physicalId, wasReplaced: false });
    });
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(1);
    const debugLines = logger.debug!.mock.calls.map((c) => String(c[0]));
    expect(debugLines).not.toContain(OLD_SHORT);
    expect(debugLines).toContain('***');
  });

  it('control: an EQUAL witness confirms the value, so nothing is sent and nothing changes', async () => {
    stateBackend.getState.mockResolvedValue({ state: budgetRecord([email(NEW)]), etag: 'e' });
    await makeEngine().deploy(STACK, budgetTemplate(NEW));
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Bud')).toHaveLength(0);
    expect(provider.create).not.toHaveBeenCalled();
    expect(printed()).not.toContain(NEW);
  });
});
