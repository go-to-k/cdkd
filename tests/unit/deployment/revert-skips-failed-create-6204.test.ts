import { describe, it, expect } from 'vite-plus/test';
import {
  revertFailedHasNothingToDo,
  revertSkipsFailedCreate,
} from '../../../src/deployment/deploy-engine/rollback/applied-nothing.js';
import { classifyFailedOp } from '../../../src/deployment/rollback-executor/plan/failed-ops.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';

const create: FailedOperation = { logicalId: 'B', changeType: 'CREATE', resourceType: 'Custom::Thing' };

describe('revertSkipsFailedCreate (go-to-k/cdkd#6204)', () => {
  it.each<[string, Partial<FailedOperation>]>([
    ['no physical id', {}],
    ['an empty physical id', { physicalId: '' }],
    ['a name generation but no physical id', { nameGeneration: 2 }],
  ])('is true for a failed CREATE with %s, which the revert plans as skip-failed-unknown', (_l, over) => {
    const op = { ...create, ...over };
    expect(revertSkipsFailedCreate(op)).toBe(true);
    expect(revertFailedHasNothingToDo(op)).toBe(true);
    // The same op, whatever state holds, is one the revert only skips.
    expect(classifyFailedOp(op, {})).toBe('skip-failed-unknown');
  });

  it.each<[string, Partial<FailedOperation>]>([
    ['a recorded physical id', { physicalId: 'phys-B' }],
    ['a recovered physical id', { physicalId: 'phys-B', physicalIdRecoveredFromError: true }],
    ['an abandoned Cloud Control request (re-polled first)', { pendingCloudControlRequest: { requestToken: 't', abandonedAt: 1 } }],
    ['an UPDATE change type', { changeType: 'UPDATE', attemptedProperties: { p: 1 } }],
    ['a DELETE change type', { changeType: 'DELETE' }],
  ])('is false for %s', (_l, over) => {
    const op = { ...create, ...over } as FailedOperation;
    expect(revertSkipsFailedCreate(op)).toBe(false);
    expect(revertFailedHasNothingToDo(op)).toBe(false);
  });

  it('keeps the #6118 refused UPDATE as nothing to do', () => {
    expect(revertFailedHasNothingToDo({ ...create, changeType: 'UPDATE' })).toBe(true);
  });
});
