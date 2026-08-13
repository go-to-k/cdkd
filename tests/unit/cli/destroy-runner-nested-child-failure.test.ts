import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// Regression tests for https://github.com/go-to-k/cdkd/issues/1777, PARENT
// side. `NestedStackProvider.delete` now THROWS when the child stack's own
// destroy reported `errorCount > 0` (and returns `{ outcome: 'skipped' }` when
// it merely skipped / was interrupted). These tests pin what that buys at the
// runner level: the parent KEEPS its `AWS::CloudFormation::Stack` row, does NOT
// delete `state.json`, and does NOT drop the stack from the exports index.
//
// The pre-#1777 outcome was worse than a dangling pointer: with the parent's
// own errorCount still 0, `preserveState` evaluated to FALSE, so the parent
// deleted its state.json AND the exports index and exited 0 — leaving the
// child's preserved state.json describing live resources with nothing naming it
// (recovery required knowing the `<parent>~<child>` key layout by hand).
//
// The provider-side wording / semantics are pinned in
// tests/unit/provisioning/nested-stack-provider.test.ts.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Keep the import graph light: the runner only touches these on the
// cross-region path, which these tests never exercise.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const NESTED_TYPE = 'AWS::CloudFormation::Stack';

/**
 * The message `NestedStackProvider.delete` throws for a child whose own
 * destroy reported errors. Deliberately spelled out here rather than imported:
 * the point of this file is that the RUNNER preserves state for it, and the
 * runner's catch classifies by MESSAGE (a "not found" / "does not exist"
 * wording would be read as already-deleted and DROP the row). The provider
 * test pins that the real message carries none of those phrases.
 */
const CHILD_FAILURE_MESSAGE =
  'Nested stack TestStack~Child failed to destroy: 2 resource(s) failed to delete. ' +
  "The child's state is PRESERVED and still lists them — inspect it with " +
  "'cdkd state show TestStack~Child', resolve the failure, and re-run the destroy. " +
  "The parent's record of this nested stack is kept so the child stays reachable.";

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function nestedRes(): ResourceState {
  return res({
    resourceType: NESTED_TYPE,
    physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/Child',
  });
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack: a nested-stack child that did not go away (issue #1777)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const mockRemoveStack = vi.fn();

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      exportIndexStore: {
        removeStack: mockRemoveStack,
      } as unknown as ExportIndexStore,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  /** Full state object recorded in the LAST saveState call. */
  function lastSavedState(): StackState {
    return mockSaveState.mock.calls.at(-1)![2] as StackState;
  }

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockRemoveStack.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it('a THROWN nested-stack delete keeps the Child row, state.json AND the exports index', async () => {
    mockProviderDelete.mockRejectedValue(new Error(CHILD_FAILURE_MESSAGE));

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes() }),
      makeCtx()
    );

    // A failed child delete is an ERROR, not a skip and not a success.
    expect(result.errorCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    // The three things the pre-fix path destroyed.
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockRemoveStack).not.toHaveBeenCalled();
    expect(Object.keys(lastSavedState().resources)).toEqual(['Child']);
    // The pointer itself must survive intact — the synthesized ARN is what
    // names the child's `<parent>~<childLogicalId>` state key.
    expect(lastSavedState().resources['Child']!.physicalId).toBe(
      'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/Child'
    );
  }, 30_000);

  it('the failure message is not mistaken for an already-deleted resource', async () => {
    // The runner's catch reads "not found" / "does not exist" as idempotent
    // success and DROPS the row. If the provider's wording ever drifts into
    // that shape, this arm goes green on `deletedCount` and the row vanishes.
    mockProviderDelete.mockRejectedValue(new Error(CHILD_FAILURE_MESSAGE));

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes() }),
      makeCtx()
    );

    expect(result.deletedCount).toBe(0);
    expect(Object.keys(lastSavedState().resources)).toContain('Child');
  }, 30_000);

  it('a SKIPPED nested-stack delete (interrupt / child skip) preserves the same three things', async () => {
    // The #1752 / #1774 half, asserted at the same layer so both arms of the
    // issue are covered by a state-level assertion rather than by the
    // provider's return value alone.
    mockProviderDelete.mockResolvedValue({
      outcome: 'skipped',
      reason: 'nested stack TestStack~Child was interrupted',
    });

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes() }),
      makeCtx()
    );

    expect(result.skippedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockRemoveStack).not.toHaveBeenCalled();
    expect(Object.keys(lastSavedState().resources)).toEqual(['Child']);
  });

  it('control: a CLEAN nested-stack delete still drops the row and deletes state + index', async () => {
    // The inverted control. Without it, "never delete anything" passes every
    // assertion above while breaking every ordinary nested-stack destroy.
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes() }),
      makeCtx()
    );

    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalled();
    expect(mockRemoveStack).toHaveBeenCalledWith('TestStack', REGION);
  });

  it('a failed child does not stop a sibling from being deleted, but the sibling stays trimmed', async () => {
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Child'
        ? Promise.reject(new Error(CHILD_FAILURE_MESSAGE))
        : Promise.resolve(undefined)
    );

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes(), Bucket: res() }),
      makeCtx()
    );

    expect(result.errorCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(Object.keys(lastSavedState().resources)).toEqual(['Child']);
  }, 30_000);
});
