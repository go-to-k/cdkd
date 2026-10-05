/**
 * Issue go-to-k/cdkd#3211 (destroy-runner half): a resource ROW that IS a
 * readable record — an object with a string `resourceType`, so the entry guard
 * (go-to-k/cdkd#3202, `destroy-runner-malformed-entries.test.ts`) lets it
 * through — whose `properties` or `physicalId` is not the type its declared
 * type says. Both reached `provider.delete` verbatim.
 *
 * - A torn `properties` map is REFUSED at the load, before the lock: the
 *   verdict every write-capable caller of `unreadableResourcePropertyBags`
 *   takes, since reading it as `{}` answers every key the delete reads off it
 *   (final snapshot, emptying first) as absent.
 * - A missing / non-string / empty `physicalId` is SKIPPED per resource (issue
 *   #1752's skip: record kept, state preserved, no provider call), since the
 *   entry predicate stops at `resourceType` by a recorded decision. A
 *   nested-stack row is exempt: its delete never reads the id.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
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
const TYPE = 'AWS::SSM::Parameter';

const HEALTHY = { physicalId: 'p-good', resourceType: TYPE, properties: {} };

function stateWith(resources: unknown): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx() {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const saveState = vi.fn().mockResolvedValue('"etag"');
  const acquireLock = vi.fn().mockResolvedValue(true);
  const providerDelete = vi.fn().mockResolvedValue(undefined);
  const getProviderFor = vi.fn(() => ({ provider: { delete: providerDelete } }));
  const recorded: DeploymentEvent[] = [];
  return {
    deleteState,
    saveState,
    acquireLock,
    providerDelete,
    getProviderFor,
    recorded,
    ctx: {
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock: vi.fn().mockResolvedValue(undefined),
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      eventRecorder: {
        record: (event: DeploymentEvent) => {
          recorded.push(event);
        },
        finalize: vi.fn(),
      },
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

const refusal = async (state: StackState, h = makeCtx()): Promise<CdkdError> => {
  const thrown = await runDestroyForStack(STACK, state, h.ctx).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(CdkdError);
  return thrown as CdkdError;
};

describe('runDestroyForStack refuses a torn `properties` map (go-to-k/cdkd#3211)', () => {
  beforeEach(() => vi.clearAllMocks());

  const TORN: Array<[string, unknown]> = [
    ['a string', 'abc'],
    ['null', null],
    ['a list', []],
    ['a number', 5],
    ['a boolean', true],
  ];

  for (const [label, properties] of TORN) {
    it(`refuses a row whose properties is ${label}, naming it, and touches nothing`, async () => {
      const h = makeCtx();
      const err = await refusal(
        stateWith({ Good: HEALTHY, Bad: { physicalId: 'p-bad', resourceType: TYPE, properties } }),
        h
      );
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      expect(err.message).toContain('Bad');
      expect(err.message, 'the healthy row was named as torn').not.toContain('Good');
      // DOMINANCE: a pre-flight. No lock, no record removed, no provider chosen.
      expect(h.acquireLock).not.toHaveBeenCalled();
      expect(h.deleteState).not.toHaveBeenCalled();
      expect(h.saveState).not.toHaveBeenCalled();
      expect(h.getProviderFor).not.toHaveBeenCalled();
      expect(h.providerDelete).not.toHaveBeenCalled();
    });
  }

  it('refuses a row with NO properties key — nothing cdkd writes omits it', async () => {
    const h = makeCtx();
    const err = await refusal(stateWith({ Bad: { physicalId: 'p-bad', resourceType: TYPE } }), h);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('Bad');
    expect(h.providerDelete).not.toHaveBeenCalled();
  });

  it('refuses a RETAINED row with a torn map too — the verdict is per record, not per delete', async () => {
    const h = makeCtx();
    const err = await refusal(
      stateWith({
        Kept: { physicalId: 'p', resourceType: TYPE, properties: 'abc', deletionPolicy: 'Retain' },
      }),
      h
    );
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('Kept');
  });

  it('marks the refusal non-retryable — a nested child reaches this inside its parent`s withRetry', async () => {
    const err = await refusal(
      stateWith({ Bad: { physicalId: 'p', resourceType: TYPE, properties: 'abc' } })
    );
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('names the DESTROY consequence and ends on the read command', async () => {
    const err = await refusal(
      stateWith({ Bad: { physicalId: 'p', resourceType: TYPE, properties: 'abc' } })
    );
    expect(err.message).toContain("whose 'properties' map cannot be read");
    expect(err.message).toContain('cdkd destroy');
    expect(err.message).toContain('final snapshot');
    // Not the deploy text, which describes a diff's replacement verdict.
    expect(err.message).not.toContain('REPLACEMENT');
    expect(err.message).not.toContain('--dry-run');
    expect(err.message).toMatch(
      /cdkd state show TestStack --stack-region us-east-1 --json --state-bucket test-bucket$/
    );
  });

  it('names EVERY torn row in one refusal', async () => {
    const err = await refusal(
      stateWith({
        A: { physicalId: 'a', resourceType: TYPE, properties: 'x' },
        Good: HEALTHY,
        B: { physicalId: 'b', resourceType: TYPE, properties: null },
      })
    );
    for (const id of ['A', 'B']) expect(err.message).toContain(id);
    expect(err.message).not.toContain('Good');
  });

  it('leaves a typeless row with a torn map to the ENTRY refusal, the more precise text', async () => {
    const err = await refusal(stateWith({ Bad: { physicalId: 'p', properties: 'abc' } }));
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('cannot be read as resources');
    expect(err.message).not.toContain("'properties' map cannot be read");
  });

  // THE OTHER DIRECTION.
  it('hands a readable map, an empty one included, to the provider unchanged', async () => {
    const h = makeCtx();
    const properties = { Name: 'n' };
    await runDestroyForStack(
      STACK,
      stateWith({ Good: HEALTHY, Named: { physicalId: 'p-named', resourceType: TYPE, properties } }),
      h.ctx
    );
    expect(h.providerDelete).toHaveBeenCalledWith(
      'Named',
      'p-named',
      TYPE,
      properties,
      expect.anything()
    );
    expect(h.providerDelete).toHaveBeenCalledWith('Good', 'p-good', TYPE, {}, expect.anything());
    expect(h.deleteState).toHaveBeenCalled();
  });
});

describe('runDestroyForStack skips a row with no usable `physicalId` (go-to-k/cdkd#3211)', () => {
  beforeEach(() => vi.clearAllMocks());

  const UNADDRESSABLE: Array<[string, Record<string, unknown>]> = [
    ['absent', { resourceType: TYPE, properties: {} }],
    ['an empty string', { physicalId: '', resourceType: TYPE, properties: {} }],
    ['a single space', { physicalId: ' ', resourceType: TYPE, properties: {} }],
    ['whitespace only', { physicalId: '\t\n', resourceType: TYPE, properties: {} }],
    ['a number', { physicalId: 5, resourceType: TYPE, properties: {} }],
    ['null', { physicalId: null, resourceType: TYPE, properties: {} }],
    ['an object', { physicalId: { id: 'p' }, resourceType: TYPE, properties: {} }],
  ];

  for (const [label, row] of UNADDRESSABLE) {
    it(`skips a row whose physicalId is ${label}: no provider call, record kept, state preserved`, async () => {
      const h = makeCtx();
      const result = await runDestroyForStack(STACK, stateWith({ Good: HEALTHY, Bad: row }), h.ctx);

      expect(result.skippedCount).toBe(1);
      expect(result.deletedCount).toBe(1);
      // The healthy row is still deleted; the bad one is never handed over.
      expect(h.providerDelete).toHaveBeenCalledTimes(1);
      expect(h.providerDelete.mock.calls[0]![0]).toBe('Good');
      // State preserved with the skipped record in it, never deleted.
      expect(h.deleteState).not.toHaveBeenCalled();
      const saved = h.saveState.mock.calls.at(-1)![2] as StackState;
      expect(Object.keys(saved.resources)).toEqual(['Bad']);
      // The durable record says why.
      const skipped = h.recorded.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({
        stackName: STACK,
        logicalId: 'Bad',
        resourceType: TYPE,
        operation: 'DELETE',
        reason: 'state record has no physical id',
      });
      // And the warning says repairing the record helps (SKIPPED_REMEDY's contract).
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("no non-empty string 'physicalId'");
      expect(warned).toContain('Repairing the record');
      // The run summary's remedy lines name THIS stack's record — the one
      // holding the torn field (the skip is in `skippedStateTargets`).
      expect(warned).toContain('Inspect it with: cdkd state show TestStack');
      expect(warned).toContain('Drop the record with: cdkd state orphan TestStack');
    });
  }

  it('hands a NESTED-STACK row with no physicalId to its delete — that delete never reads the id', async () => {
    // `NestedStackProvider.delete` finds the child by `<parent>~<logicalId>`.
    // Skipping the row would leave every child resource standing and point the
    // remedy at the child's record, while the torn field is the parent's.
    const h = makeCtx();
    const result = await runDestroyForStack(
      STACK,
      stateWith({ Child: { resourceType: 'AWS::CloudFormation::Stack', properties: {} } }),
      h.ctx
    );
    expect(result.skippedCount).toBe(0);
    expect(h.providerDelete).toHaveBeenCalledWith(
      'Child',
      undefined,
      'AWS::CloudFormation::Stack',
      {},
      expect.anything()
    );
    expect(h.deleteState).toHaveBeenCalled();
  });

  it('retains a RETAINED row with no physicalId rather than skipping it — retention addresses nothing', async () => {
    const h = makeCtx();
    const result = await runDestroyForStack(
      STACK,
      stateWith({ Kept: { resourceType: TYPE, properties: {}, deletionPolicy: 'Retain' } }),
      h.ctx
    );
    expect(result.retainedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(h.deleteState).toHaveBeenCalled();
  });
});
