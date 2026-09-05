import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Issue #2554: the reverse-replacement arm's stateful advisory warn had ZERO
 * tests — not for its wording, not for its gate, not for its deliberate
 * absence from `result.warnings`.
 *
 * That mattered because PR #2519 REWORDED it. It used to say the old data
 * "cannot be recovered", which became false when that PR added
 * `AWS::KMS::Key` / `AWS::KMS::ReplicaKey` to `STATEFUL_TYPES`: those delete by
 * SCHEDULING, so a recovery window may still be open. Nothing held either the
 * old wording or the new one.
 *
 * Three properties, because they fail independently:
 *
 *   1. the GATE — a stateful type warns, a non-stateful one does not. Without
 *      the negative half, a mutation to `if (true)` warns about every Lambda
 *      function in a rollback and stays green;
 *   2. the WORDING — scoped to THIS rollback, never an absolute claim about
 *      AWS. A future edit "tightening" it back to "cannot be recovered" is the
 *      regression this pins;
 *   3. that the warn does NOT reach `result.warnings`. That list maps to exit
 *      code 2, and this op SUCCEEDED — the warning is advisory. It is the kind
 *      of thing a later edit "fixes" by accident, and nothing else would notice.
 */

const STATEFUL_TYPE = 'AWS::S3::Bucket';
const EPHEMERAL_TYPE = 'AWS::Lambda::Function';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: STATEFUL_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { create?: unknown; delete?: unknown }): {
  ctx: RollbackExecutorContext;
  warns: string[];
} {
  const warns: string[] = [];
  const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    warns,
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
  };
}

/**
 * A REVERSE-REPLACEMENT op: the previous state's physical id differs from the
 * op's, which is what routes the replay into the arm that carries the warn.
 * `UpdateReplacePolicy` is deliberately absent — under `Retain` the replay
 * takes the `reverse-replacement-readopt` arm instead, which has no warn (and
 * correctly so: the old resource still exists with its data).
 */
function reverseReplacementOp(resourceType: string): {
  ops: CompletedOperation[];
  state: Record<string, ResourceState>;
} {
  return {
    ops: [
      {
        logicalId: 'Target',
        changeType: 'UPDATE',
        resourceType,
        physicalId: 'phys-NEW',
        previousState: res({ resourceType, physicalId: 'phys-OLD' }),
      },
    ],
    state: { Target: res({ resourceType, physicalId: 'phys-NEW' }) },
  };
}

async function replayReverseReplacement(resourceType: string): Promise<{
  warns: string[];
  result: Awaited<ReturnType<typeof replayRollback>>;
  create: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}> {
  const create = vi.fn(async () => ({ physicalId: 'phys-OLD' }));
  const del = vi.fn(async () => undefined);
  const { ctx, warns } = makeCtx({ create, delete: del });
  const { ops, state } = reverseReplacementOp(resourceType);
  const result = await replayRollback(ops, state, 'S', ctx);
  return { warns, result, create, del };
}

describe('the reverse-replacement stateful advisory warn (#2554)', () => {
  it('warns for a STATEFUL type, scoped to this rollback rather than claiming the data is unrecoverable', async () => {
    const { warns, create, del } = await replayReverseReplacement(STATEFUL_TYPE);

    // Non-vacuity: the replay really took the reverse-replacement arm — it
    // re-created the OLD resource and deleted the new one. Without this the
    // warn assertions could pass over an arm that did nothing.
    expect(create).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);

    const warn = warns.find((m) => m.includes('is a stateful type'));
    expect(warn, `no stateful warn in: ${JSON.stringify(warns)}`).toBeDefined();
    expect(warn).toContain('Target');
    expect(warn).toContain(STATEFUL_TYPE);
    // The wording PR #2519 moved to, and the reason it moved: scoped to this
    // rollback, not an absolute claim about what AWS can still recover.
    expect(warn).toContain('is NOT recovered by this rollback');
    expect(warn).not.toContain('CANNOT be recovered');
    expect(warn).not.toContain('cannot be recovered');
  });

  it('does NOT warn for a non-stateful type — the gate is the membership test, not the arm', async () => {
    const { warns, create, del } = await replayReverseReplacement(EPHEMERAL_TYPE);

    // Same arm, same two provider calls: the ONLY difference is the type, so a
    // warn here could come from nothing but the gate being wrong.
    expect(create).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(warns.filter((m) => m.includes('is a stateful type'))).toEqual([]);
  });

  it('keeps the advisory warn OUT of result.warnings — the op succeeded', async () => {
    const { result } = await replayReverseReplacement(STATEFUL_TYPE);

    // `result.warnings` is a COUNT, and a non-zero one maps to exit code 2.
    // This op did what it was asked to do, so a rollback that hit only this
    // path must still exit 0; folding the advisory line in here would turn
    // every stateful reverse-replacement into a failed-looking rollback.
    expect(result.warnings).toBe(0);
    expect(result.failures).toBe(0);
  });
});
