/**
 * go-to-k/cdkd#3338: `performRollback` reports THIS replay's skips only. A
 * nested child's skips reach it as `run.warnings` and are deliberately left out
 * of `skipped`: the child's row is then not settled, so its own journal keeps
 * the record, and counting them here would also keep the parent's segment for
 * an op the parent's replay did revert.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import { getNestedRevertRun } from '../../../src/deployment/nested-child-journal.js';
import { performRollback } from '../../../src/deployment/deploy-engine/rollback.js';
import type { StackState } from '../../../src/types/state.js';

const replayRollback = vi.hoisted(() => vi.fn());
vi.mock('../../../src/deployment/rollback-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/rollback-executor.js')>()),
  replayRollback,
}));

const previousState: StackState = {
  version: 10,
  stackName: 'S',
  region: 'us-east-1',
  resources: {},
  outputs: {},
  lastModified: 0,
};

function engine() {
  return {
    options: { eventRecorder: { runId: 'run-1' } },
    rollbackExecutorContext: () => ({}),
  } as unknown as ThisParameterType<typeof performRollback>;
}

describe('performRollback counts only its own skips (go-to-k/cdkd#3338)', () => {
  it("a nested child's skip is a warning, not a skip of the parent's replay", async () => {
    replayRollback.mockImplementation(async () => {
      // What a nested row's child revert reports back through the scope.
      getNestedRevertRun()!.warnings += 2;
      return { failures: 0, warnings: 0, skipped: 0, interrupted: false, orphaned: [] };
    });
    const result = await performRollback.call(engine(), [], {}, 'S', previousState);
    expect(result).toMatchObject({ failures: 0, warnings: 2, skipped: 0 });
  });

  it("the parent replay's own skips are reported", async () => {
    replayRollback.mockResolvedValue({
      failures: 0,
      warnings: 1,
      skipped: 1,
      interrupted: false,
      orphaned: [],
    });
    const result = await performRollback.call(engine(), [], {}, 'S', previousState);
    expect(result).toMatchObject({ warnings: 1, skipped: 1 });
  });
});
