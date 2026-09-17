/**
 * Issue go-to-k/cdkd#3207: `runDestroyForStack` read `state.outputs` to decide
 * whether the stack might be a PRODUCER, and that decision gates the
 * cross-stack scan which refuses to delete an exporter while an importer
 * exists.
 *
 * `!!(state.outputs && Object.keys(state.outputs).length > 0)` is fabricated in
 * BOTH directions on a hand-edited record: `Object.keys('abcdef')` is six
 * invented names, while a `null`, a number or a boolean reads as "exports
 * nothing" and SKIPS the check entirely. Reading the bag as empty — the
 * read-only repair used elsewhere in this class — IS that second answer, so the
 * only answer available here is to refuse.
 *
 * The cases below are DOMINANCE cases as much as verdict ones: the fixture's
 * record has zero resources, so a guard sitting below the empty-state fast path
 * would delete the record before refusing. `deleteState` not being called is
 * what discriminates.
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

const REGION = 'us-east-1';
const STACK = 'TestStack';

function stateWithOutputs(outputs: unknown): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {},
    outputs: outputs as StackState['outputs'],
    lastModified: 1,
  };
}

/** A record whose `outputs` key is genuinely absent, which is NOT a defect. */
function stateWithoutOutputs(): StackState {
  const state = stateWithOutputs({});
  delete (state as Partial<StackState>).outputs;
  return state;
}

function makeCtx() {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const listStacks = vi.fn().mockResolvedValue([]);
  return {
    deleteState,
    acquireLock,
    listStacks,
    ctx: {
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState: vi.fn(),
        listStacks,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor: vi.fn() } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack refuses a malformed `outputs` bag (go-to-k/cdkd#3207)', () => {
  beforeEach(() => vi.clearAllMocks());

  // The shapes a hand-edited or truncated record can carry. Both the
  // fabricating half (string / list) and the silently-skipping half (null,
  // number, boolean) are here — a fence covering only the first leaves the
  // DANGEROUS direction, where the cross-stack check never runs at all.
  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['a', 'b']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} with the shared code, and deletes nothing`, async () => {
      const h = makeCtx();
      let thrown: unknown;
      try {
        await runDestroyForStack(STACK, stateWithOutputs(bag), h.ctx);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // DOMINANCE. This record has zero resources, so the empty-state fast path
      // sits between the function's entry and the strong-reference decision —
      // a guard placed at that decision would have deleted the record first.
      expect(
        h.deleteState,
        'the destroy deleted the state record before refusing, so the damaged record is gone'
      ).not.toHaveBeenCalled();
      // ...and it must refuse without taking the lock either: the refusal is a
      // pre-flight, and a lock taken here is one more thing to strand.
      expect(h.acquireLock).not.toHaveBeenCalled();
    });
  }

  it('names the DESTROY consequence, not the deploy one', async () => {
    const h = makeCtx();
    const err = await runDestroyForStack(STACK, stateWithOutputs('abcdef'), h.ctx).catch(
      (e: unknown) => e
    );
    const message = (err as Error).message;
    // The two remedies differ, so the text must not be the deploy refusal's.
    expect(message).toContain('DELETES state');
    expect(message).toContain('SKIPS the check');
    expect(
      message,
      'the destroy refusal borrowed the deploy text, which claims a rebuild that never happens here'
    ).not.toContain('REBUILDS the bag before saving');
  });

  // THE OTHER DIRECTION. A fence that refuses every record would satisfy every
  // case above while making `cdkd destroy` unusable.
  const HEALTHY: Array<[string, StackState]> = [
    ['a populated bag', stateWithOutputs({ BucketArn: 'arn:aws:s3:::b' })],
    ['an EMPTY bag — a stack can legitimately export nothing', stateWithOutputs({})],
    ['an ABSENT bag — a record cdkd writes on purpose', stateWithoutOutputs()],
  ];

  for (const [label, state] of HEALTHY) {
    it(`lets ${label} through to the ordinary empty-state cleanup`, async () => {
      const h = makeCtx();
      const result = await runDestroyForStack(STACK, state, h.ctx);
      expect(result.skippedEmpty).toBe(true);
      expect(h.deleteState).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('runs the strong-reference scan for a populated bag — the decision the guard protects', async () => {
    // Without this, "a populated bag is let through" would also pass if the
    // guard had been replaced by a blanket skip of the scan.
    const h = makeCtx();
    const state = stateWithOutputs({ BucketArn: 'arn:aws:s3:::b' });
    state.resources = {
      Param: {
        physicalId: 'p',
        resourceType: 'AWS::SSM::Parameter',
        properties: {},
      },
    };
    await runDestroyForStack(STACK, state, h.ctx).catch(() => undefined);
    expect(
      h.listStacks,
      'the cross-stack consumer scan never ran for a stack that declares outputs'
    ).toHaveBeenCalled();
  });
});
