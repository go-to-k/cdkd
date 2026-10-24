/**
 * go-to-k/cdkd#5228: `markNotGone` / `isMarkedNotGone`, the "this delete
 * failure is not proof the resource is gone" mark the already-deleted
 * classifiers refuse on. It is apart from retryability by design.
 */
import { describe, it, expect } from 'vite-plus/test';
import { isMarkedNotGone, markNotGone } from '../../../src/provisioning/not-gone.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';

describe('markNotGone / isMarkedNotGone', () => {
  it('marks the error it returns, by identity', () => {
    const error = new Error('KeyNotFoundFault');
    expect(markNotGone(error)).toBe(error);
    expect(isMarkedNotGone(error)).toBe(true);
  });

  it('an unmarked error reads unmarked', () => {
    expect(isMarkedNotGone(new Error('NotFoundException'))).toBe(false);
  });

  it('reads the mark through a wrap, on the cause chain', () => {
    const inner = markNotGone(new Error('inner'));
    const outer = new Error('outer', { cause: new Error('middle', { cause: inner }) });
    expect(isMarkedNotGone(outer)).toBe(true);
  });

  it('leaves retryability alone: a marked throttle is still retryable and not non-retryable', () => {
    const throttle = markNotGone(new Error('Rate exceeded for PageNotFound'));
    expect(isMarkedNonRetryable(throttle)).toBe(false);
    expect(isRetryableTransientError(throttle, throttle.message)).toBe(true);
  });

  it('is non-enumerable, so it never serializes', () => {
    const error = markNotGone(new Error('x'));
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe('{}');
  });

  it('a marked prototype does not mark the instances built on it', () => {
    const proto = markNotGone(Object.create(Error.prototype) as Error);
    const instance = Object.create(proto) as Error;
    expect(isMarkedNotGone(proto)).toBe(true);
    expect(isMarkedNotGone(instance)).toBe(false);
  });

  it('returns a frozen error or a primitive unmarked, without throwing', () => {
    const frozen = Object.freeze(new Error('frozen'));
    expect(markNotGone(frozen)).toBe(frozen);
    expect(isMarkedNotGone(frozen)).toBe(false);
    expect(markNotGone('boom')).toBe('boom');
    expect(isMarkedNotGone('boom')).toBe(false);
    expect(isMarkedNotGone(undefined)).toBe(false);
  });

  it('never throws on a chain whose cause getter throws', () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('getter');
      },
    });
    expect(isMarkedNotGone(hostile)).toBe(false);
  });
});
