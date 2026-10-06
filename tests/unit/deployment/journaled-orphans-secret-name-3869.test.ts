import { describe, it, expect, vi } from 'vite-plus/test';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

// go-to-k/cdkd#3869: a successful deploy settling its journal deletes a
// journaled orphan through `deleteJournaledOrphans`, as `cdkd destroy` does.
// Its delete lines and its rollback events are masked by the batch's printing
// bag, which carries a name the orphan READ from a state record: the op's own
// masker holds only the names its entry spells.

const REGION = 'us-east-1';
const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER = 'team-secret-user';

function settle(userName: string) {
  const lines: string[] = [];
  const events: Array<{ eventType: string; error?: { message?: string } }> = [];
  const provider = {
    delete: vi.fn((logicalId: string, physicalId: string) => {
      const line = `Deleting access key ${logicalId} ${physicalId} of user ${USER}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.reject(new Error(`AccessDenied on user ${USER}`));
    }),
  };
  const ctx = {
    providerRegistry: {
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getProvider: vi.fn().mockReturnValue(provider),
    },
    region: REGION,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    recordEvent: (e: { eventType: string; error?: { message?: string } }) => void events.push(e),
  } as unknown as RollbackExecutorContext;
  const journal = {
    journalVersion: 1,
    stackName: 'S',
    region: REGION,
    segments: [
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
            physicalId: 'AKIAEXAMPLEKEY',
            provisionedBy: 'sdk',
            physicalIdRecoveredFromError: true,
            attemptedProperties: { UserName: USER },
          },
        ],
      },
    ],
  };
  const user: ResourceState = {
    physicalId: USER,
    resourceType: 'AWS::IAM::User',
    properties: { UserName: userName },
    attributes: {},
    dependencies: [],
  };
  return {
    lines,
    events,
    run: () =>
      settleJournaledOrphansOnSuccess({
        stateBackend: {
          loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
          reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
          markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
          dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
        } as never,
        stackName: 'S',
        region: REGION,
        stateResources: { User: user },
        rollbackOrphans: undefined,
        newerOperations: [],
        foreignHolder: async () => undefined,
        ctx,
        logger: ctx.logger as never,
      }),
  };
}

describe("a successful deploy's journal settle masks a name an orphan read (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user in state', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])('on its delete line and its ROLLBACK_RESOURCE_FAILED event: %s', async (_l, userName, shown) => {
    const t = settle(userName);
    await t.run();
    // Premise: the orphan's delete ran, logged, and failed quoting AWS's text.
    expect(t.lines).toEqual([expect.stringContaining('Deleting access key Key AKIAEXAMPLEKEY of user ')]);
    const failed = t.events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.message).toContain('AccessDenied on user ');
    expect(t.lines[0]!.includes(USER)).toBe(shown);
    expect(failed[0]!.error!.message!.includes(USER)).toBe(shown);
  });
});
