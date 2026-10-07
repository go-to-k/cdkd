/**
 * `cdkd rollback` masks a physical name derived from a secret on its
 * COMPLETED-op replay (go-to-k/cdkd#3869), and on a failed op whose name a
 * newer segment's completed-op revert put back in state:
 *
 *  - a completed CREATE's revert deletes the resource the failed deploy made,
 *    and its provider's delete line names it; it ran under no printing bag;
 *  - the batch bag over every segment's failed ops is judged before the loop,
 *    so a name a newer segment's revert restores is not in it; each segment's
 *    failed ops also run under a bag judged against the state as it stands.
 *
 * A `{{resolve:` reference resolves through a mocked resolver, recorded in the
 * pass's bag as the real one records a secret.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const SECRETS = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>();
  class Resolver extends actual.IntrinsicFunctionResolver {
    constructor(...args: ConstructorParameters<typeof actual.IntrinsicFunctionResolver>) {
      super(...args);
      (this as unknown as { resolveDynamicReferences: unknown }).resolveDynamicReferences = async (
        value: unknown,
        ctx?: { recordedSecretValues?: Map<string, string> }
      ): Promise<unknown> => {
        if (typeof value === 'string' && Object.hasOwn(SECRETS, value)) {
          ctx?.recordedSecretValues?.set(SECRETS[value]!, value);
          return SECRETS[value];
        }
        return value;
      };
    }
  }
  return { ...actual, IntrinsicFunctionResolver: Resolver };
});
vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({ delete: vi.fn(), update: vi.fn() }));
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

const REF = '{{resolve:secretsmanager:team:SecretString:name::}}';
const NAME = 'team-secret-name';
SECRETS[REF] = NAME;
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

function install(resources: Record<string, unknown>, segments: unknown[]): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: { version: 8, stackName: 'S', region: 'us-east-1', resources, outputs: {}, lastModified: 1 },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments,
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

const run = () =>
  rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(() => undefined);

describe("cdkd rollback masks a secret-derived name on its completed-op replay (go-to-k/cdkd#3869)", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    provider.delete.mockReset().mockImplementation((logicalId: string, physicalId: string) => {
      const line =
        logicalId === 'Key'
          ? `Deleting Key: ${physicalId} of user ${NAME}`
          : `Deleting ${logicalId}: ${physicalId}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.resolve(undefined);
    });
    provider.update.mockReset().mockImplementation((_l: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    );
  });

  it.each([
    ['a queue named by its reference', REF, false],
    ['negative control, a literal name', NAME, true],
  ])("on a completed CREATE's delete line: %s", async (_l, queueName, shown) => {
    install(
      {
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: queueName },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      },
      [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [
            {
              logicalId: 'Queue',
              changeType: 'CREATE',
              resourceType: 'AWS::SQS::Queue',
              provisionedBy: 'sdk',
              physicalId: URL,
              properties: { QueueName: queueName },
            },
          ],
        },
      ]
    );
    await run();
    // Premise: the completed CREATE was reverted by deleting it.
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual([URL]);
    expect(lines[0]!.includes(NAME)).toBe(shown);
  });

  it.each([
    ['a user name restored as its reference', REF, false],
    ['negative control, a literal name restored', NAME, true],
  ])('on an older orphan reading a name a newer revert restored: %s', async (_l, restored, shown) => {
    // The newer segment's completed UPDATE reverts the user's record to the
    // one it replaced, which spells its name as a reference; before the loop
    // the record held it in plaintext, so the batch bag cannot judge it.
    install(
      {
        User: {
          physicalId: NAME,
          resourceType: 'AWS::IAM::User',
          properties: { UserName: NAME, Path: '/now/' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      },
      [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Key',
              changeType: 'CREATE',
              resourceType: 'AWS::IAM::AccessKey',
              provisionedBy: 'sdk',
              physicalId: 'AKIAEXAMPLEKEY',
              physicalIdRecoveredFromError: true,
              attemptedProperties: { UserName: NAME },
            },
          ],
        },
        {
          timestamp: 2,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [
            {
              logicalId: 'User',
              changeType: 'UPDATE',
              resourceType: 'AWS::IAM::User',
              provisionedBy: 'sdk',
              physicalId: NAME,
              properties: { UserName: NAME, Path: '/now/' },
              previousState: {
                physicalId: NAME,
                resourceType: 'AWS::IAM::User',
                properties: { UserName: restored, Path: '/then/' },
                attributes: {},
                dependencies: [],
                provisionedBy: 'sdk',
              },
            },
          ],
        },
      ]
    );
    await run();
    // Premise: the newer segment reverted the user, then the older segment's
    // orphan key was deleted, logging the user name it read.
    expect(provider.update).toHaveBeenCalledOnce();
    const keyLines = lines.filter((l) => l.startsWith('Deleting Key: '));
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toContain('AKIAEXAMPLEKEY');
    expect(keyLines[0]!.includes(NAME)).toBe(shown);
  });
});
