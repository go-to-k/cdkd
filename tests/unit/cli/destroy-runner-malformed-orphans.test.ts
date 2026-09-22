/**
 * Issue go-to-k/cdkd#3379: `runDestroyForStack` reads the `orphans` CONTAINER
 * on a bare `?? []` at both of its reads, and what each shape then counts
 * splits three ways (measured): `null`, `''` and `{length: 0}` count 0; a
 * string or `{length: N}` counts non-zero; a number, an object or a boolean
 * yields `undefined`.
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
 * The assertions name `orphans` rather than only "refused": a record with no
 * resources is refused by the `resources` guard too, so a bare refusal
 * assertion would pass without this one. `null` is the shape that reaches
 * `deleteState`, and it gets its own re-read case for that reason.
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
  // The other two shapes that count 0 and so reach `deleteState`.
  ['an empty-string container', ''],
  ['an object carrying a zero length', { length: 0 }],
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
      // The CONTAINER by name. `resources: {}` is READABLE, so the resources
      // guard does not fire here — what a bare "it threw" assertion would not
      // separate is this refusal from the ordinary empty-stack path below it.
      expect((thrown as CdkdError).message).toContain("'orphans'");
      // The DESTROY text, not the generic writer one: a destroy removes the
      // record rather than writing the container back, and it owes the way out.
      expect((thrown as CdkdError).message).toContain('DELETES state');
      expect((thrown as CdkdError).message).toContain('cdkd state orphan');
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
    // The DESTROY text at THIS site too: both messages name the container, so
    // without this the re-read could revert to the writer refusal unnoticed.
    expect((thrown as CdkdError).message).toContain('DELETES state');
    // What this case pins is the NAMING above: for a string `stillEmpty` reads
    // 3, so the run stops elsewhere without the guard and a bare "refused"
    // assertion would not discriminate. The DELETION is pinned by the null
    // case below, the one shape that reaches `deleteState`.
    expect(h.deleteState).not.toHaveBeenCalled();
    // It got far enough to take the lock and re-read — otherwise the case is
    // vacuous and proves only what the entry guard already does.
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.getState).toHaveBeenCalled();
    expect(h.releaseLock, 'the lock is stranded').toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['an object carrying a zero length', { length: 0 }],
  ])('refuses %s at the re-read, a shape that would reach deleteState', async (_label, orphans) => {
    // These three count 0, so `stillEmpty` is true and `deleteState` runs on a
    // record whose orphan evidence was never read. A number or a plain object
    // yields `undefined` and a string counts its characters, so those stop the
    // run elsewhere — which is why the string case above pins the NAMING and
    // these pin the DELETION.
    const h = makeCtx(stateWith(orphans));
    const thrown = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).message).toContain("'orphans'");
    expect((thrown as CdkdError).message).toContain('DELETES state');
    expect(
      h.deleteState,
      'the destroy deleted the record the re-read exists to protect'
    ).not.toHaveBeenCalled();
    expect(h.acquireLock).toHaveBeenCalled();
  });

  it('marks the refusal non-retryable — a retry cannot change a persisted record', async () => {
    const h = makeCtx();
    const thrown = await runDestroyForStack(STACK, stateWith(5), h.ctx).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it('CONTROL: a readable or absent container runs to the delete', async () => {
    // DRIVEN rather than asserted absent: an empty record with a readable
    // container reaches `deleteState`, so an unrelated early failure cannot
    // satisfy this the way a bare `not.toContain` would.
    for (const orphans of [[], [{ logicalId: 'A' }], undefined]) {
      vi.clearAllMocks();
      const h = makeCtx(stateWith(orphans));
      const thrown = await runDestroyForStack(STACK, stateWith(orphans), h.ctx).catch(
        (e: unknown) => e
      );
      const message = thrown instanceof CdkdError ? thrown.message : '';
      expect(message).not.toContain("'orphans'");
      // An EMPTY readable container reaches the delete; a POPULATED one does
      // not (`stillEmpty` is false), and the negative matters there too — the
      // guard must not fire on a record that simply has orphans.
      if (Array.isArray(orphans) && orphans.length > 0) {
        expect(h.deleteState).not.toHaveBeenCalled();
      } else {
        expect(h.deleteState, 'the control never reached the delete, so it proves nothing').toHaveBeenCalled();
      }
    }
  });
});
