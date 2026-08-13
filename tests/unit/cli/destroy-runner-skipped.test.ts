import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

// Regression tests for https://github.com/go-to-k/cdkd/issues/1752: a
// provider's warn-and-SKIP delete arm returns normally, so before the fix the
// destroy runner could not tell it apart from a completed delete — it printed
// `✓ <id> (<type>) deleted`, counted it toward `N deleted`, DROPPED the state
// record, and exited 0, over a resource no AWS call had ever touched.

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

// Keep the import graph light: the runner only touches these for the
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

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::Glue::Table',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
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

describe('runDestroyForStack skipped-delete accounting (issue #1752)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const recorded: DeploymentEvent[] = [];

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
    };
  }

  /** Full state object recorded in the LAST saveState call. */
  function lastSavedState(): StackState {
    return mockSaveState.mock.calls.at(-1)![2] as StackState;
  }

  // Counts in the summary are ANSI-colorized, so every assertion below reads
  // the stripped text — matching what a user sees in a non-TTY CI log.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = (spy: typeof infoSpy): string[] =>
    spy.mock.calls.flatMap((c) => stripAnsi(String(c[0])).split('\n'));
  const allInfo = (): string => lines(infoSpy).join('\n');
  const allWarn = (): string => lines(warnSpy).join('\n');
  /** The per-resource status line for `logicalId` (the `  <glyph> Id (Type) verb` form). */
  const resourceLine = (logicalId: string): string =>
    lines(infoSpy).find((l) => l.trimStart().startsWith('⚠ ' + logicalId) ||
      l.trimStart().startsWith('✓ ' + logicalId)) ?? '';

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    recorded.length = 0;
  });

  it('counts a skipped delete as skipped, NOT as deleted', async () => {
    mockProviderDelete.mockResolvedValue({
      outcome: 'skipped',
      reason: 'malformed physicalId in state — no delete issued',
    });

    const result = await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    expect(result.skippedCount).toBe(1);
    // The bug: this used to be 1.
    expect(result.deletedCount).toBe(0);
    // A skip is not a failure — nothing was attempted, so nothing errored.
    expect(result.errorCount).toBe(0);
    expect(result.retainedCount).toBe(0);
  });

  it('prints a ⚠ skipped line carrying the reason, never a ✓ deleted line', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'bad id' });

    await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    const line = resourceLine('Table');
    expect(line).toContain('⚠');
    expect(line).toContain('(AWS::Glue::Table)');
    expect(line).toContain('skipped (bad id)');
    // The exact assertion the issue is about: the per-resource line must not
    // assert the opposite of what happened. (`allInfo()` legitimately carries
    // the plan's "Resources to be deleted (N):" header, so the assertion is
    // scoped to the status line itself.)
    expect(line).not.toContain('deleted');
    expect(line).not.toContain('✓');
  });

  it('KEEPS the state record for a skipped resource and preserves state.json', async () => {
    // ONE resource, and it is the skipped one: no sibling delete fires an
    // incremental persist, so the only saveState call there can be is the
    // FINAL preserve-write. With a sibling present this assertion is vacuous —
    // the sibling's incremental persist writes the same snapshot, so deleting
    // the final write leaves the test green.
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'bad id' });

    const result = await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    expect(result.skippedCount).toBe(1);
    expect(result.deletedCount).toBe(0);

    // The second half of the data loss: without the record the user has
    // neither the AWS resource deleted nor an id to go and delete it with.
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = lastSavedState();
    expect(Object.keys(saved.resources)).toEqual(['Table']);
    // The physical id must survive intact — it IS the id the user needs to
    // repair (or to go and delete the resource by hand).
    expect(saved.resources['Table']!.physicalId).toBe('phys-id');
  });

  it('a skipped resource does not block a sibling from being deleted and trimmed', async () => {
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Table'
        ? Promise.resolve({ outcome: 'skipped', reason: 'bad id' })
        : Promise.resolve()
    );

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Table: res(), Bucket: res({ resourceType: 'AWS::S3::Bucket' }) }),
      makeCtx()
    );

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(Object.keys(lastSavedState().resources)).toEqual(['Table']);
  });

  it('emits RESOURCE_SKIPPED (not RESOURCE_SUCCEEDED / RESOURCE_FAILED)', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'skipped', reason: 'bad id' });

    await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    const types = recorded.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SKIPPED']);
    const skipped = recorded.find((e) => e.eventType === 'RESOURCE_SKIPPED')!;
    expect(skipped.logicalId).toBe('Table');
    expect(skipped.operation).toBe('DELETE');
    expect(skipped.resourceType).toBe('AWS::Glue::Table');
    expect(skipped.physicalId).toBe('phys-id');
    expect(typeof skipped.durationMs).toBe('number');
    // Nothing was attempted, so there is no error metadata to carry. Asserting
    // that ALONE would be unconditional (nothing on this path ever sets
    // `error`), so the control below proves the recorder does populate it when
    // a delete genuinely fails.
    expect(skipped.error).toBeUndefined();
  });

  it('control: a genuinely FAILED delete still records RESOURCE_FAILED *with* error metadata', async () => {
    // Makes the `error` assertion above meaningful rather than vacuous.
    mockProviderDelete.mockRejectedValue(new Error('kaboom'));

    await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    const failed = recorded.find((e) => e.eventType === 'RESOURCE_FAILED')!;
    expect(failed).toBeDefined();
    expect(failed.error).toBeDefined();
    expect(recorded.some((e) => e.eventType === 'RESOURCE_SKIPPED')).toBe(false);
  }, 30_000);

  it('reports "N deleted, M skipped" in the summary and does NOT claim a clean destroy', async () => {
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Table'
        ? Promise.resolve({ outcome: 'skipped', reason: 'bad id' })
        : Promise.resolve()
    );

    await runDestroyForStack(
      'TestStack',
      makeState({ Table: res(), Bucket: res({ resourceType: 'AWS::S3::Bucket' }) }),
      makeCtx()
    );

    const warn = allWarn();
    expect(warn).toContain('partially destroyed');
    expect(warn).toContain('1 skipped');
    expect(warn).toContain('0 errors');
    // Pin the SKIPPED-ONLY branch specifically. `partially destroyed` /
    // `1 skipped` / `0 errors` are all printed by the pre-existing
    // errors-present branch too (ANSI-stripped, `red(0)` reads as `0`), so
    // without these two the new branch is not distinguished at all.
    expect(warn).toContain('could not address the skipped resource(s)');
    expect(warn).toContain('Fix the physicalId in state.json');
    // ...and the separate preserve-state warning, which nothing else emits.
    expect(warn).toContain('State preserved (the records are kept');
    // The headline mis-report: the clean-destroy banner must not appear.
    expect(allInfo()).not.toContain('destroyed');
  });

  it('errors + skipped keeps the ERROR branch primary and still shows the skip count', async () => {
    mockProviderDelete.mockImplementation((logicalId: string) => {
      if (logicalId === 'Table') return Promise.resolve({ outcome: 'skipped', reason: 'bad id' });
      if (logicalId === 'Boom') return Promise.reject(new Error('kaboom'));
      return Promise.resolve();
    });

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Table: res(), Boom: res({ resourceType: 'AWS::S3::Bucket' }) }),
      makeCtx()
    );

    expect(result.skippedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    const warn = allWarn();
    expect(warn).toContain('1 skipped');
    // The error branch owns the message: a run with a real failure must lead
    // with "re-run to clean up", not with the skip remedy.
    expect(warn).toContain("re-run 'cdkd destroy'");
    expect(warn).not.toContain('could not address the skipped resource(s)');
    expect(mockDeleteState).not.toHaveBeenCalled();
  }, 30_000);

  it('is BYTE-IDENTICAL to the pre-fix behavior when no resource is skipped', async () => {
    // A provider returning void (the ~80 that never changed) still counts as
    // deleted, still drops its record, and still ends with the wholesale
    // state-file delete + the clean ✓ banner.
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    const info = allInfo();
    expect(resourceLine('Table')).toContain('✓');
    expect(resourceLine('Table')).toContain('deleted');
    expect(info).toContain('Stack TestStack destroyed');
    // No `skipped` suffix is rendered on a run with zero skips.
    expect(info).not.toContain('skipped');
  });

  it('an explicit { outcome: "deleted" } is treated exactly like a void return', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted' });

    const result = await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('a skip on a RETRIED delete does not leak the previous attempt outcome', async () => {
    // First attempt throws a retryable error, second attempt skips. The
    // outcome must reflect the LAST attempt, not be lost by an assignment
    // that lives outside the retry loop.
    mockProviderDelete
      .mockRejectedValueOnce(new Error('Rate exceeded: Too Many Requests'))
      .mockResolvedValue({ outcome: 'skipped', reason: 'bad id' });

    const result = await runDestroyForStack('TestStack', makeState({ Table: res() }), makeCtx());

    expect(result.skippedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.errorCount).toBe(0);
  }, 30_000);
});
