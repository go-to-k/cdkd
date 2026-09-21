/**
 * Issue go-to-k/cdkd#3379, rollback half — the PERSISTENCE case, and the reason
 * the issue is severity high.
 *
 * `orphansAfterRollback` walks the `orphans` container with `for...of`. Over
 * the string `"abc"` that yields one record per character and returns a
 * container holding `"c"`, and `cdkd rollback` SAVES the record after each
 * replayed segment — so a damaged container is rewritten into a differently
 * damaged one, by a writer, with no warning. The other unreadable shapes are
 * not iterable and throw a bare `TypeError` out of the same walk, in a command
 * that may by then have run AWS replay operations.
 *
 * So the assertions are: refuse, name the container, and save NOTHING. The
 * save is what discriminates — a guard placed after the first replay would
 * still refuse, and the record would already be rewritten.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
  create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
};
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';
const STACK = 'S';

/** One replayable segment, so the run reaches the guard rather than stopping above it. */
const JOURNAL = {
  journalVersion: 1,
  stackName: STACK,
  region: REGION,
  segments: [
    {
      operations: [
        { logicalId: 'A', operation: 'create', resourceType: 'AWS::SSM::Parameter', physicalId: 'p' },
      ],
    },
  ],
};

function install(orphans: unknown) {
  const saveState = vi.fn().mockResolvedValue('etag-1');
  const state: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {},
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 1,
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue(JOURNAL),
      saveState,
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return { saveState };
}

const BASE_OPTS = { yes: true, stateBucket: 'b', region: REGION } as unknown as Parameters<
  typeof rollbackCommand
>[1];

describe('rollbackCommand refuses a malformed `orphans` container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    // The reshaping shape: `for...of` walks it and the result is SAVED.
    ['a string container', 'abc'],
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label} before any replay, saving nothing`, async () => {
      const h = install(orphans);
      const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((thrown as CdkdError).message).toContain("'orphans'");
      // THE assertion this file exists for: a guard below the replay would
      // still refuse, having already written the reshaped container.
      expect(
        h.saveState,
        'rollback saved the record before refusing, so the damaged container was rewritten'
      ).not.toHaveBeenCalled();
      // And no AWS replay ran either.
      expect(replayProvider.delete).not.toHaveBeenCalled();
      expect(replayProvider.update).not.toHaveBeenCalled();
      expect(replayProvider.create).not.toHaveBeenCalled();
    });
  }

  it('CONTROL: a readable container is not refused over this container', async () => {
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      install(orphans);
      const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).not.toContain("'orphans'");
    }
  });
});
