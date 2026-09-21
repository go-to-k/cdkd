/**
 * Issue go-to-k/cdkd#3379: `runDestroyForStack` reads the `orphans` CONTAINER
 * on a bare `?? []` at both of its reads, so every unreadable shape counts 0.
 *
 * That count is what `stillEmpty` consults before `deleteState`, and the orphan
 * warning above it is what would have told the operator that resources from an
 * earlier failed deploy are still live in AWS. So an unreadable container sends
 * the run down the ordinary path to deletion with the record's own evidence
 * never reported — and the record is then gone.
 *
 * TWO reads, two cases. The entry read is guarded beside the `resources` guard;
 * the UNDER-LOCK re-read is a different object (a concurrent writer or a hand
 * edit can land between them) and is the record `stillEmpty` and `deleteState`
 * actually act on. A guard at the first read alone leaves the second open,
 * which is why the re-read case supplies a DIFFERENT record from the entry one.
 *
 * The assertions name `orphans`: `stillEmpty` already rejects a record whose
 * resources are non-empty, so "refused and deleted nothing" can pass without
 * this guard. Naming the container is what discriminates.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';

/** Every shape `parseStateBody` lets through, by the OUTCOME it produces. */
const MALFORMED: Array<[string, unknown]> = [
  // `?? []` admits it, `.length` is undefined -> counts 0 -> the run proceeds.
  ['a number container', 5],
  ['a plain object container', {}],
  // `.length` is 1, which a `.length`-keyed guard would accept while every
  // reader that WALKS the container still fails.
  ['an object carrying length', { length: 1 }],
  // Walked one character at a time by `for...of`.
  ['a string container', 'abc'],
  ['a null container', null],
];

function stateWith(orphans: unknown, resources: Record<string, unknown> = {}): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 1,
  };
}

function makeCtx(recheckState?: StackState) {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const listStacks = vi.fn().mockResolvedValue([]);
  const getProviderFor = vi.fn();
  const getState = vi
    .fn()
    .mockResolvedValue(recheckState ? { state: recheckState, migrationPending: false } : null);
  return {
    deleteState,
    acquireLock,
    releaseLock,
    getState,
    getProviderFor,
    ctx: {
      stateBackend: {
        getState,
        deleteState,
        saveState: vi.fn(),
        listStacks,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack refuses a malformed `orphans` container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label} at the entry read, deleting nothing`, async () => {
      const h = makeCtx();
      const thrown = await runDestroyForStack(STACK, stateWith(orphans), h.ctx).catch(
        (e: unknown) => e
      );
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The CONTAINER by name. Without this the assertion passes on the
      // `resources` guard alone, which fires for a record with no resources.
      expect((thrown as CdkdError).message).toContain("'orphans'");
      // DOMINANCE: nothing deleted, no lock taken, no provider reached.
      expect(
        h.deleteState,
        'the destroy deleted the record before refusing, so its orphan evidence is gone'
      ).not.toHaveBeenCalled();
      expect(h.acquireLock).not.toHaveBeenCalled();
      expect(h.getProviderFor).not.toHaveBeenCalled();
    });
  }

  it('refuses when only the UNDER-LOCK re-read carries the damaged container', async () => {
    // The entry record is clean and EMPTY, so the run reaches the empty-stack
    // path, takes the lock and re-reads — and the re-read is what it acts on.
    const h = makeCtx(stateWith('abc'));
    const thrown = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    expect(
      (thrown as CdkdError).message,
      'the refusal does not name `orphans`, so this passes on some other guard and the ' +
        're-read is still unguarded'
    ).toContain("'orphans'");
    // The point of the case: the record the re-read exists to protect is not
    // deleted. `stillEmpty` reads `(recheck.state.orphans ?? []).length`, which
    // is 0 for a string, so without the guard `deleteState` runs here.
    expect(h.deleteState).not.toHaveBeenCalled();
    // It got far enough to take the lock and re-read — otherwise the case is
    // vacuous and proves only what the entry guard already does.
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.getState).toHaveBeenCalled();
    expect(h.releaseLock, 'the lock is stranded').toHaveBeenCalled();
  });

  it('marks the refusal non-retryable — a retry cannot change a persisted record', async () => {
    const h = makeCtx();
    const thrown = await runDestroyForStack(STACK, stateWith(5), h.ctx).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it('CONTROL: a readable or absent container is not refused', async () => {
    for (const orphans of [[], [{ logicalId: 'A' }], undefined]) {
      const h = makeCtx();
      const thrown = await runDestroyForStack(STACK, stateWith(orphans), h.ctx).catch(
        (e: unknown) => e
      );
      // Whatever else the run does with an empty stack, it does not refuse over
      // this container.
      const message = thrown instanceof CdkdError ? thrown.message : '';
      expect(message).not.toContain("'orphans'");
    }
  });
});
