import { describe, it, expect } from 'vite-plus/test';
import { appliedNothing } from '../../../src/deployment/deploy-engine/rollback/applied-nothing.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';

const base: FailedOperation = { logicalId: 'B', changeType: 'UPDATE', resourceType: 'AWS::SQS::Queue' };

describe('appliedNothing (go-to-k/cdkd#6118)', () => {
  it('is true for a bare UPDATE (no attempted bag, nothing made or deleted)', () => {
    expect(appliedNothing(base)).toBe(true);
  });

  it.each<[string, Partial<FailedOperation>]>([
    ['CREATE', { changeType: 'CREATE' }],
    ['DELETE', { changeType: 'DELETE' }],
    ['attemptedProperties', { attemptedProperties: { p: 1 } }],
    ['replacementOrphaned', { replacementOrphaned: 'create-first' }],
    ['oldDeletedBeforeCreate', { oldDeletedBeforeCreate: true }],
    ['physicalIdRecoveredFromError', { physicalIdRecoveredFromError: true }],
    ['pendingCloudControlRequest', { pendingCloudControlRequest: { requestToken: 't', abandonedAt: 1 } }],
    ['nameGeneration', { nameGeneration: 1 }],
  ])('is false when %s is set', (_label, over) => {
    expect(appliedNothing({ ...base, ...over })).toBe(false);
  });
});
