/**
 * `cdkd rollback` masks a physical name derived from a secret on a journaled
 * failed-CREATE orphan's delete (go-to-k/cdkd#3869), as `cdkd destroy` does:
 * the failed-op replay runs under a printing bag judged from the journal
 * entries, and the run's events are masked by the bags bound where each is
 * recorded. The replay's op masker holds only the names an entry SPELLS, so
 * a name the orphan READ from a state record (an access key's `UserName`)
 * reached the provider's lines and the durable events.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
const events = vi.hoisted(() => [] as Array<{ eventType: string; logicalId?: string; error?: { message?: string } }>);
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({
    record: (e: (typeof events)[number]) => void events.push(e),
    finalize: vi.fn().mockResolvedValue(undefined),
  }),
}));
const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER = 'team-secret-user';

function install(userName: string, failedOperations?: unknown[], segments?: unknown[]): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            User: {
              physicalId: USER,
              resourceType: 'AWS::IAM::User',
              properties: { UserName: userName },
              attributes: {},
              dependencies: [],
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: segments ?? [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [],
            failedOperations: failedOperations ?? [
              {
                logicalId: 'Key',
                changeType: 'CREATE',
                resourceType: 'AWS::IAM::AccessKey',
                provisionedBy: 'sdk',
                physicalId: 'AKIAEXAMPLEKEY',
                physicalIdRecoveredFromError: true,
                attemptedProperties: { UserName: USER },
              },
            ],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

describe('cdkd rollback masks a name a journaled orphan read (go-to-k/cdkd#3869)', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    events.length = 0;
    provider.delete.mockReset().mockImplementation((logicalId: string, physicalId: string) => {
      const line = `Deleting access key ${logicalId} ${physicalId} of user ${USER}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.reject(new Error(`AccessDenied on user ${USER}`));
    });
  });

  it.each([
    ['a secret-named user in state', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])('on its delete line and its ROLLBACK_RESOURCE_FAILED event: %s', async (_l, userName, shown) => {
    install(userName);
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(
      () => undefined
    );
    // Premise: the plain rollback replayed the proven orphan, which logged
    // and failed quoting AWS's text.
    expect(lines).toEqual([expect.stringContaining('Deleting access key Key AKIAEXAMPLEKEY of user ')]);
    const failed = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.message).toContain('AccessDenied on user ');
    expect(lines[0]!.includes(USER)).toBe(shown);
    expect(failed[0]!.error!.message!.includes(USER)).toBe(shown);
  });
});

describe("cdkd rollback masks a journaled orphan's OWN secret-derived name (go-to-k/cdkd#3869)", () => {
  const QUEUE_REF = '{{resolve:secretsmanager:team:SecretString:queue::}}';
  const QUEUE = 'team-secret-queue';
  const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${QUEUE}`;
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    events.length = 0;
    provider.delete.mockReset().mockImplementation((logicalId: string, physicalId: string) => {
      const line = `Deleting SQS queue ${logicalId}: ${physicalId}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.resolve(undefined);
    });
  });

  it.each([
    ['a name journaled as its reference', QUEUE_REF, false],
    ['negative control, a literal name', QUEUE, true],
  ])("on its provider's delete line: %s", async (_l, queueName, shown) => {
    install('plain-user-name', [
      {
        logicalId: 'Queue',
        changeType: 'CREATE',
        resourceType: 'AWS::SQS::Queue',
        provisionedBy: 'sdk',
        physicalId: URL,
        physicalIdRecoveredFromError: true,
        attemptedProperties: { QueueName: queueName },
      },
    ]);
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(
      () => undefined
    );
    // Premise: the plain rollback deleted the proven orphan and logged its line.
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual([URL]);
    expect(lines).toEqual([expect.stringContaining('Deleting SQS queue Queue: ')]);
    expect(lines[0]!.includes(QUEUE)).toBe(shown);
  });
});

describe('cdkd rollback masks a name an orphan read from an orphan in ANOTHER segment (go-to-k/cdkd#3869)', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    events.length = 0;
    provider.delete.mockReset().mockImplementation((logicalId: string, physicalId: string) => {
      if (logicalId === 'Key') {
        const line = `Deleting access key ${physicalId} of user ${USER}`;
        lines.push(currentLogLineMasker()?.(line) ?? line);
      }
      return Promise.resolve(undefined);
    });
  });

  it.each([
    ['a secret-named user orphan', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])('%s', async (_l, userName, shown) => {
    // Two failed deploys: the older journaled a user named from a secret, the
    // newer an access key for it. The key's segment replays first, before the
    // user's, and no state record holds the user: one bag spans the batch.
    const segment = (timestamp: number, op: Record<string, unknown>) => ({
      timestamp,
      reason: 'no-rollback-failure',
      initialDeploy: false,
      operations: [],
      failedOperations: [
        { changeType: 'CREATE', provisionedBy: 'sdk', physicalIdRecoveredFromError: true, ...op },
      ],
    });
    install('unused-state-user', undefined, [
      segment(1, {
        logicalId: 'Orphaned',
        resourceType: 'AWS::IAM::User',
        physicalId: USER,
        attemptedProperties: { UserName: userName },
      }),
      segment(2, {
        logicalId: 'Key',
        resourceType: 'AWS::IAM::AccessKey',
        physicalId: 'AKIAEXAMPLEKEY',
        attemptedProperties: { UserName: USER },
      }),
    ]);
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(
      () => undefined
    );
    // Premise: the key's delete ran and logged its line.
    expect(lines).toEqual([expect.stringContaining('Deleting access key AKIAEXAMPLEKEY of user ')]);
    expect(lines[0]!.includes(USER)).toBe(shown);
  });
});
