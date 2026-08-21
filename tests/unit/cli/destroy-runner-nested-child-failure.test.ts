import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// PARENT-side tests for the nested-stack outcomes of issues #1752 / #1777.
//
// SCOPE — read this before adding to the file. These tests do NOT fence
// `NestedStackProvider`'s decision to throw: the provider is not exercised here
// (a fake provider stands in for it), so every case below passes identically
// against pre-#1777 code and neither of that fix's mutation probes turns them
// red. The fix's own fence is the provider-level rows in
// tests/unit/provisioning/nested-stack-provider.test.ts.
//
// What IS fenced here is what the throw BUYS, which the provider's return value
// cannot show: that `runDestroyForStack` responds to a failing / skipped
// nested-stack row by KEEPING the row, the `state.json` and the exports-index
// entries, and that the remedy it prints names the CHILD's state file. Pre-#1777
// the parent's own `errorCount` stayed 0, so `preserveState` was FALSE and the
// parent deleted its state.json AND the exports index while exiting 0 — leaving
// the child's preserved state.json describing live resources with nothing naming
// it (recovery meant knowing the `<parent>~<child>` key layout by hand).

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
// The REAL message builder the provider throws with — imported rather than
// hand-copied, because the runner's catch classifies a delete failure by
// MESSAGE: an already-deleted-shaped phrase (`not found` / `does not exist` /
// …) is read as idempotent success and DROPS the state row. A stale literal
// here would keep passing while the production wording drifted into that shape.
// Imported from the LEAF module rather than from the provider: the provider
// pulls in destroy-runner -> register-providers -> every provider, which both
// closes an import cycle and drags the whole registry into this unit test.
import { nestedStackChildFailureMessage } from '../../../src/provisioning/nested-stack-messages.js';

const REGION = 'us-east-1';
const NESTED_TYPE = 'AWS::CloudFormation::Stack';

/** Exactly what `NestedStackProvider.delete` throws for a 2-error child. */
const CHILD_FAILURE_MESSAGE = nestedStackChildFailureMessage('TestStack~Child', 2, 0, false);

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

describe('runDestroyForStack: a nested-stack child that did not go away (issues #1752 / #1777)', () => {
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
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({
          provider: {
            delete: mockProviderDelete,
            // The REAL NestedStackProvider sets this (its child engine has its
            // own retry / rollback machinery), and the runner honors it by
            // running the delete exactly once. Without it the fake would run
            // the runner's `maxAttempts = 3` loop — a different code path from
            // production, and the reason this file used to need 30s timeouts.
            disableOuterRetry: true,
          },
        }),
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

  // Counts + hints in the summary are ANSI-colorized, so assertions read the
  // stripped text — what a user sees in a non-TTY CI log.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const allWarn = (): string =>
    warnSpy.mock.calls.flatMap((c) => stripAnsi(String(c[0])).split('\n')).join('\n');

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
    // Production runs a nested-stack delete exactly once (`disableOuterRetry`);
    // a retry would re-enter the child's whole destroy.
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
  });

  it('the failure message is not mistaken for an already-deleted resource', async () => {
    // The runner's catch reads "not found" / "does not exist" as idempotent
    // success and DROPS the row. Driven by the REAL builder, so this is a live
    // check of the shipped wording rather than of a literal in this file.
    mockProviderDelete.mockRejectedValue(new Error(CHILD_FAILURE_MESSAGE));

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes() }),
      makeCtx()
    );

    expect(result.deletedCount).toBe(0);
    expect(Object.keys(lastSavedState().resources)).toContain('Child');
  });

  it('the last-resort orphan hint names the CHILD state file, never the parent', async () => {
    // Issue #1777: following `cdkd state orphan TestStack` would DROP the
    // `Child` row — the exact pointer the throw preserves. The failing resource
    // lives in the child's state file, so that is what the remedy must name.
    // This arm is newly reachable BECAUSE of this PR: before it, a nested-stack
    // row could not land in the error arm at all.
    mockProviderDelete.mockRejectedValue(new Error(CHILD_FAILURE_MESSAGE));

    await runDestroyForStack('TestStack', makeState({ Child: nestedRes() }), makeCtx());

    const warn = allWarn();
    expect(warn).toContain("'cdkd state orphan TestStack~Child'");
    expect(warn).not.toContain("'cdkd state orphan TestStack'");
  });

  it("control: an ordinary failing resource still names THIS stack's file", async () => {
    // Inverted control for the hint above: without it, a target builder that
    // treated EVERY failure as a nested stack (emitting `TestStack~Bucket`)
    // passes the previous test while sending the user to a state file that does
    // not exist.
    mockProviderDelete.mockRejectedValue(new Error('AccessDenied on delete'));

    await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    const warn = allWarn();
    expect(warn).toContain("'cdkd state orphan TestStack'");
    expect(warn).not.toContain('TestStack~');
  });

  it('names BOTH targets when a nested-stack row and an ordinary row both fail', async () => {
    mockProviderDelete.mockImplementation((logicalId: string) =>
      Promise.reject(
        new Error(logicalId === 'Child' ? CHILD_FAILURE_MESSAGE : 'AccessDenied on delete')
      )
    );

    await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes(), Bucket: res() }),
      makeCtx()
    );

    const warn = allWarn();
    expect(warn).toContain("'cdkd state orphan TestStack~Child'");
    expect(warn).toContain("'cdkd state orphan TestStack'");
  });

  it('a run with BOTH an error and a skip keeps #1752 guidance for the skipped row', async () => {
    // The error arm owns the both-kinds case (the skip-only arm is unreachable
    // once errorCount > 0), so naming only the failed target would print
    // `, 1 skipped` in the counters and then silently drop the skipped row's
    // remedy — which is different IN KIND: a skip is not retryable, it needs
    // the state record repaired first.
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Child'
        ? Promise.reject(new Error(CHILD_FAILURE_MESSAGE))
        : Promise.resolve({ outcome: 'skipped', reason: 'malformed physicalId in state' })
    );

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Child: nestedRes(), Table: res({ resourceType: 'AWS::Glue::Table' }) }),
      makeCtx()
    );

    expect(result.errorCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    const warn = allWarn();
    // The failure's remedy still names the child.
    expect(warn).toContain("'cdkd state orphan TestStack~Child'");
    // ...AND the skip's own guidance survives, naming ITS target.
    expect(warn).toContain("'cdkd state show TestStack'");
    expect(warn).toContain('were SKIPPED');
  });

  it('control: an error-only run prints no skipped guidance', async () => {
    // Inverted control for the clause above: an unconditional clause would
    // tell every failed destroy that resources were skipped when none were.
    mockProviderDelete.mockRejectedValue(new Error(CHILD_FAILURE_MESSAGE));

    await runDestroyForStack('TestStack', makeState({ Child: nestedRes() }), makeCtx());

    const warn = allWarn();
    expect(warn).not.toContain('were SKIPPED');
    expect(warn).not.toContain("'cdkd state show");
  });

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
  });
});
