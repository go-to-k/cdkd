import { describe, it, expect } from 'vite-plus/test';

import { ProvisioningError, physicalIdFromError, CdkdError } from '../../../src/utils/error-handler.js';
import {
  classifyFailedOp,
  journaledFailedPhysicalId,
  type FailedOperation,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Issue #1710 — a provider whose `create()` throws AFTER its mutating AWS call
 * has already succeeded leaves a resource nothing can see.
 *
 * The failed CREATE writes no state record, so the journal's
 * `newResources[...]?.physicalId ?? previousState?.physicalId` is `undefined`
 * on BOTH sides, the rollback executor's `!op.physicalId` guard skips the op,
 * and the resource stays in AWS untracked. Where the provider derives its name
 * deterministically, the retry after the user fixes the template then collides
 * with `*AlreadyExists` and the stack is wedged.
 */

const res = (over: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'phys',
  resourceType: 'AWS::SQS::Queue',
  properties: {},
  attributes: {},
  dependencies: [],
  ...over,
});

const failedCreate = (over: Partial<FailedOperation> = {}): FailedOperation => ({
  logicalId: 'Q',
  changeType: 'CREATE',
  resourceType: 'AWS::SQS::Queue',
  ...over,
});

describe('physicalIdFromError (issue #1710)', () => {
  it('reads the id off a ProvisioningError', () => {
    const err = new ProvisioningError('boom', 'AWS::SQS::Queue', 'Q', 'https://sqs/q');
    expect(physicalIdFromError(err)).toBe('https://sqs/q');
  });

  // The engine and several providers re-wrap: the OUTERMOST error is often a
  // ProvisioningError carrying no id (every create-path catch passes
  // `undefined`), while an inner one does. Without the walk the recovery would
  // find nothing in exactly the real-world shape.
  it('walks the cause chain to an inner ProvisioningError that carries one', () => {
    const inner = new ProvisioningError('inner', 'AWS::SQS::Queue', 'Q', 'https://sqs/q');
    const outer = new ProvisioningError('outer', 'AWS::SQS::Queue', 'Q', undefined, inner);
    expect(physicalIdFromError(outer)).toBe('https://sqs/q');
  });

  it('prefers the OUTERMOST layer that knows an id', () => {
    const inner = new ProvisioningError('inner', 'T', 'Q', 'inner-id');
    const outer = new ProvisioningError('outer', 'T', 'Q', 'outer-id', inner);
    expect(physicalIdFromError(outer)).toBe('outer-id');
  });

  // A blank id identifies nothing and would reach a delete built from `''` —
  // the same reasoning as classifyFailedOp's falsy guard.
  it('treats a blank id as absent and keeps walking', () => {
    const inner = new ProvisioningError('inner', 'T', 'Q', 'real-id');
    const outer = new ProvisioningError('outer', 'T', 'Q', '', inner);
    expect(physicalIdFromError(outer)).toBe('real-id');
  });

  it.each([
    ['a plain Error', new Error('nope')],
    ['a non-Error', 'just a string' as unknown],
    ['a CdkdError with no physical id', new CdkdError('x', 'CODE')],
  ])('returns undefined for %s', (_label, err) => {
    expect(physicalIdFromError(err)).toBeUndefined();
  });

  it('is depth-bounded against a self-referencing chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(physicalIdFromError(err)).toBeUndefined();
  });
});

describe('journaledFailedPhysicalId (issue #1710)', () => {
  // The id and its provenance are decided together so a call site cannot set
  // one without the other — a physical id whose provenance is lost is exactly
  // the ambiguity the flag exists to remove.
  it('prefers the state-derived id and does NOT set the flag', () => {
    const err = new ProvisioningError('boom', 'T', 'Q', 'from-error');
    expect(journaledFailedPhysicalId('from-state', err)).toEqual({ physicalId: 'from-state' });
  });

  it('falls back to the error id and marks it recovered', () => {
    const err = new ProvisioningError('boom', 'T', 'Q', 'from-error');
    expect(journaledFailedPhysicalId(undefined, err)).toEqual({
      physicalId: 'from-error',
      physicalIdRecoveredFromError: true,
    });
  });

  it('reports no id when neither source has one', () => {
    expect(journaledFailedPhysicalId(undefined, new Error('plain'))).toEqual({
      physicalId: undefined,
    });
  });
});

describe('classifyFailedOp: failed CREATE that orphaned a resource (issue #1710)', () => {
  // THE headline case. Before #1710 this returned `skip-failed-noop`, which
  // made the delete arms unreachable for the very situation they serve: a
  // failed CREATE never has a state record.
  it('deletes an orphan recovered from the error with no state record', () => {
    const op = failedCreate({ physicalId: 'https://sqs/q', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, {})).toBe('delete-failed-create');
  });

  // The journal carries the policy because there is no state record to read it
  // off — without it a Retain / Snapshot resource would be plain-deleted.
  it.each([
    ['Retain', 'orphan-failed-create-retain'],
    ['Snapshot', 'delete-failed-create-with-final-snapshot'],
    ['Delete', 'delete-failed-create'],
    ['RetainExceptOnCreate', 'delete-failed-create'],
  ] as const)('honours the journaled DeletionPolicy %s', (policy, expected) => {
    const op = failedCreate({
      physicalId: 'https://sqs/q',
      physicalIdRecoveredFromError: true,
      deletionPolicy: policy,
    });
    expect(classifyFailedOp(op, {})).toBe(expected);
  });

  it('defaults to a plain delete when the journal carries no policy', () => {
    const op = failedCreate({ physicalId: 'https://sqs/q', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, {})).toBe('delete-failed-create');
  });

  // #1198's idempotent re-run must NOT regress: an id that came from STATE
  // with the record now gone means a previous --revert-failed already deleted
  // it. Only the provenance flag separates this from the orphan case above.
  it('still skips when the id was state-derived and the record is gone', () => {
    const op = failedCreate({ physicalId: 'phys-B' });
    expect(classifyFailedOp(op, {})).toBe('skip-failed-noop');
  });

  // A journal written by an older binary has no flag at all.
  it('keeps the pre-#1710 skip for a journal with no provenance flag', () => {
    const op = failedCreate({ physicalId: 'phys-B', deletionPolicy: 'Retain' });
    expect(classifyFailedOp(op, {})).toBe('skip-failed-noop');
  });

  // The other guards are untouched.
  it('still skips a failed CREATE with no physical id at all', () => {
    expect(classifyFailedOp(failedCreate({}), {})).toBe('skip-failed-unknown');
  });

  it('still prefers the state record when one exists and matches', () => {
    const op = failedCreate({ physicalId: 'phys-B', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { Q: res({ physicalId: 'phys-B', deletionPolicy: 'Retain' }) })).toBe(
      'orphan-failed-create-retain'
    );
  });

  it('still skips on a physical-id mismatch against an existing record', () => {
    const op = failedCreate({ physicalId: 'phys-B', physicalIdRecoveredFromError: true });
    expect(classifyFailedOp(op, { Q: res({ physicalId: 'other' }) })).toBe('skip-failed-noop');
  });
});
