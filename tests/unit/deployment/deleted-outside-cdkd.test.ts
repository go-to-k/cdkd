/**
 * go-to-k/cdkd#6106: which failed ops count as "deleted outside cdkd". Only a
 * failed UPDATE whose provider read answers `RESOURCE_NOT_FOUND`, and never a
 * replacement that deleted the old resource itself.
 */
import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  DELETED_OUTSIDE_READ_TIMEOUT_MS,
  deletedOutsideCdkdMessage,
  failedUpdateResourceIsGone,
  partitionDeletedOutsideCdkd,
} from '../../../src/deployment/deleted-outside-cdkd.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

function op(overrides: Partial<FailedOperation> = {}): FailedOperation {
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType: 'AWS::SQS::Queue',
    provisionedBy: 'sdk',
    physicalId: 'phys-Q',
    previousState: {
      physicalId: 'phys-Q',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'cc-api',
      properties: { p: 'old' },
      attributes: {},
      dependencies: [],
    },
    ...overrides,
  };
}

function deps(readCurrentState?: (...args: unknown[]) => Promise<unknown>) {
  const getProviderFor = vi.fn(() => ({
    provider: readCurrentState === undefined ? {} : { readCurrentState: vi.fn(readCurrentState) },
    provisionedBy: 'sdk',
  }));
  return { providerRegistry: { getProviderFor } as never, getProviderFor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('failedUpdateResourceIsGone', () => {
  it('is true only on the provider read answering RESOURCE_NOT_FOUND, routed by the record', async () => {
    const d = deps(() => Promise.resolve(RESOURCE_NOT_FOUND));
    expect(await failedUpdateResourceIsGone(d, op())).toBe(true);
    // The record's route, never the op's: the record is what the read addresses.
    expect(d.getProviderFor).toHaveBeenCalledWith({
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'cc-api',
    });
  });

  it.each([
    ['returns properties', () => Promise.resolve({ p: 'old' })],
    ['returns nothing', () => Promise.resolve(undefined)],
    ['throws', () => Promise.reject(new Error('AccessDenied'))],
  ] as const)('is false when the read %s', async (_label, read) => {
    expect(await failedUpdateResourceIsGone(deps(read), op())).toBe(false);
  });

  it('is false for a type with no read path', async () => {
    expect(await failedUpdateResourceIsGone(deps(undefined), op())).toBe(false);
  });

  it.each([
    ['a CREATE', { changeType: 'CREATE' as const }],
    ['a DELETE', { changeType: 'DELETE' as const }],
    ['an UPDATE with no previous state', { previousState: undefined }],
    // cdkd removed the old resource itself: not "deleted outside cdkd".
    ['a replacement that deleted the old resource first', { oldDeletedBeforeCreate: true }],
    ['a replacement journaled with its orphan', { replacementOrphaned: 'delete-first' as const }],
  ])('is false, with no read, for %s', async (_label, overrides) => {
    const d = deps(() => Promise.resolve(RESOURCE_NOT_FOUND));
    expect(await failedUpdateResourceIsGone(d, op(overrides))).toBe(false);
    expect(d.getProviderFor).not.toHaveBeenCalled();
  });

  it('is false when the read outlives its bound', async () => {
    vi.useFakeTimers();
    const verdict = failedUpdateResourceIsGone(
      deps(() => new Promise(() => {})),
      op()
    );
    await vi.advanceTimersByTimeAsync(DELETED_OUTSIDE_READ_TIMEOUT_MS);
    expect(await verdict).toBe(false);
  });

  it('runs the read under the caller printing scope', async () => {
    const seen: string[] = [];
    const d = {
      ...deps(() => Promise.resolve(RESOURCE_NOT_FOUND)),
      withPrinting: <T>(logicalId: string, read: () => Promise<T>) => {
        seen.push(logicalId);
        return read();
      },
    };
    expect(await failedUpdateResourceIsGone(d, op())).toBe(true);
    expect(seen).toEqual(['Q']);
  });
});

describe('partitionDeletedOutsideCdkd', () => {
  it('splits in input order', async () => {
    const d = deps((physicalId: unknown) =>
      Promise.resolve(physicalId === 'phys-B' ? RESOURCE_NOT_FOUND : {})
    );
    const at = (id: string) =>
      op({ logicalId: id, previousState: { ...op().previousState!, physicalId: `phys-${id}` } });
    const [a, b, c] = [at('A'), at('B'), at('C')];
    expect(await partitionDeletedOutsideCdkd(d, [a, b, c])).toEqual({ gone: [b], kept: [a, c] });
  });
});

describe('deletedOutsideCdkdMessage', () => {
  it('says whether the record was dropped, and carries the remedy', () => {
    expect(deletedOutsideCdkdMessage(op(), true)).toContain('no rollback record is kept for it.');
    expect(deletedOutsideCdkdMessage(op(), false)).toContain(
      "'cdkd rollback --revert-failed' drops its record."
    );
    expect(deletedOutsideCdkdMessage(op(), true)).toContain(
      'remove it from the CDK app and deploy, then restore it and deploy again'
    );
  });
});
