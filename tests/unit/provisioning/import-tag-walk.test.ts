import { describe, it, expect, vi } from 'vite-plus/test';

import {
  importTagWalk,
  isThrottlingLikeError,
  ImportTagWalkLimitError,
} from '../../../src/provisioning/import-tag-walk.js';

const CDK_PATH = 'MyStack/MyConstruct/Resource';

/** Retry options that skip real waits so the tests stay fast. */
const noSleep = { retry: { sleep: async () => {} } };

interface Summary {
  id: string;
}

/** Build an AWS-SDK-shaped throttling error (HTTP 400 + throttling name). */
function throttlingError(name = 'ThrottlingException'): Error {
  const err = new Error('Rate exceeded');
  err.name = name;
  (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
    httpStatusCode: 400,
  };
  return err;
}

describe('isThrottlingLikeError', () => {
  it('matches AWS SDK throttling error names', () => {
    expect(isThrottlingLikeError(throttlingError(), 'Rate exceeded')).toBe(true);
    expect(isThrottlingLikeError(throttlingError('TooManyRequestsException'), 'nope')).toBe(true);
  });

  it('matches a throttling name nested one cause-link deep', () => {
    const wrapped = new Error('wrapped');
    (wrapped as unknown as { cause: unknown }).cause = throttlingError('SlowDown');
    expect(isThrottlingLikeError(wrapped, 'wrapped')).toBe(true);
  });

  it('matches HTTP 429 / 503 even without a throttling name', () => {
    const err = new Error('boom');
    err.name = 'SomeServiceException';
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
      httpStatusCode: 429,
    };
    expect(isThrottlingLikeError(err, 'boom')).toBe(true);
  });

  it('matches the canonical "Rate exceeded" message as a backstop', () => {
    expect(isThrottlingLikeError(new Error('Rate exceeded'), 'Rate exceeded')).toBe(true);
  });

  // The write-path classifier (isRetryableTransientError) treats these as
  // transient; on a read-only import walk they are terminal and must surface
  // immediately instead of burning the backoff budget per candidate.
  it('does NOT match write-path eventual-consistency messages', () => {
    expect(isThrottlingLikeError(new Error('does not exist'), 'does not exist')).toBe(false);
    expect(
      isThrottlingLikeError(new Error('not authorized to perform'), 'not authorized to perform')
    ).toBe(false);
    expect(isThrottlingLikeError(new Error('AccessDenied'), 'AccessDenied')).toBe(false);
  });

  it('tolerates a cyclic cause chain without hanging', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as unknown as { cause: unknown }).cause = b;
    (b as unknown as { cause: unknown }).cause = a;
    expect(isThrottlingLikeError(a, 'a')).toBe(false);
  });
});

describe('importTagWalk', () => {
  it('returns the first candidate whose tags carry the aws:cdk:path', async () => {
    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: [{ id: 'a' }, { id: 'b' }] }),
      describe: async (s) => ({
        Tags: [{ Key: 'aws:cdk:path', Value: s.id === 'b' ? CDK_PATH : 'other' }],
      }),
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });

    expect(match?.summary.id).toBe('b');
    expect(match?.detail.Tags[0]!.Value).toBe(CDK_PATH);
  });

  it('returns null when no candidate matches', async () => {
    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: [{ id: 'a' }] }),
      describe: async () => ({ Tags: [{ Key: 'aws:cdk:path', Value: 'other' }] }),
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });
    expect(match).toBeNull();
  });

  it('short-circuits without any API call when cdkPath is empty', async () => {
    const listPage = vi.fn();
    const describe = vi.fn();
    const match = await importTagWalk<Summary, unknown>({
      cdkPath: '',
      listPage,
      describe,
      tagsOf: () => undefined,
      ...noSleep,
    });
    expect(match).toBeNull();
    expect(listPage).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  it('paginates via nextMarker until a match is found', async () => {
    const seenMarkers: Array<string | undefined> = [];
    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async (marker) => {
        seenMarkers.push(marker);
        return marker === undefined
          ? { items: [{ id: 'p1' }], nextMarker: 'next' }
          : { items: [{ id: 'p2' }] };
      },
      describe: async (s) => ({
        Tags: [{ Key: 'aws:cdk:path', Value: s.id === 'p2' ? CDK_PATH : 'other' }],
      }),
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });

    expect(match?.summary.id).toBe('p2');
    expect(seenMarkers).toEqual([undefined, 'next']);
  });

  it('skips candidates whose describe returns undefined', async () => {
    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: [{ id: 'gone' }, { id: 'b' }] }),
      describe: async (s) =>
        s.id === 'gone' ? undefined : { Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] },
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });
    expect(match?.summary.id).toBe('b');
  });

  // The regression this helper exists for: without backoff on the N+1
  // describe, ONE throttled call aborts the whole import walk.
  it('retries a throttled describe and still finds the match', async () => {
    const describe = vi
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValue({ Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] });

    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: [{ id: 'a' }] }),
      describe,
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });

    expect(match?.summary.id).toBe('a');
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('retries a throttled list page', async () => {
    const listPage = vi
      .fn()
      .mockRejectedValueOnce(throttlingError('RequestLimitExceeded'))
      .mockResolvedValue({ items: [{ id: 'a' }] });

    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage,
      describe: async () => ({ Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] }),
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });

    expect(match?.summary.id).toBe('a');
    expect(listPage).toHaveBeenCalledTimes(2);
  });

  it('gives up and rethrows once the retry budget is exhausted', async () => {
    const describe = vi.fn().mockRejectedValue(throttlingError());

    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        listPage: async () => ({ items: [{ id: 'a' }] }),
        describe,
        tagsOf: () => undefined,
        retry: { sleep: async () => {}, maxRetries: 2 },
      })
    ).rejects.toThrow(/Rate exceeded/);
    expect(describe).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-throttling error immediately without retrying', async () => {
    const describe = vi.fn().mockRejectedValue(new Error('AccessDeniedException: nope'));

    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        listPage: async () => ({ items: [{ id: 'a' }] }),
        describe,
        tagsOf: () => undefined,
        ...noSleep,
      })
    ).rejects.toThrow(/AccessDeniedException/);
    expect(describe).toHaveBeenCalledTimes(1);
  });

  // The backoff schedule is the only numeric contract in the module; without
  // this, zeroing DEFAULT_INITIAL_DELAY_MS or dropping the cap keeps the suite
  // green. withRetry sleeps in <=1000ms slices, so sum the slices per attempt.
  it('backs off on the documented 0.5s -> 1s -> 2s -> 4s -> 5s schedule', async () => {
    const perAttempt: number[] = [];
    let pending = 0;
    const describe = vi.fn().mockImplementation(async () => {
      if (pending > 0) perAttempt.push(pending);
      pending = 0;
      throw throttlingError();
    });

    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        listPage: async () => ({ items: [{ id: 'a' }] }),
        describe,
        tagsOf: () => undefined,
        retry: {
          maxRetries: 5,
          sleep: async (ms) => {
            pending += ms;
          },
        },
      })
    ).rejects.toThrow(/Rate exceeded/);

    expect(perAttempt).toEqual([500, 1000, 2000, 4000, 5000]);
    expect(describe).toHaveBeenCalledTimes(6);
  });

  it('treats an undefined items array as an empty page (empty AWS account)', async () => {
    const describe = vi.fn();
    const match = await importTagWalk<Summary, unknown>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: undefined }),
      describe,
      tagsOf: () => undefined,
      ...noSleep,
    });
    expect(match).toBeNull();
    expect(describe).not.toHaveBeenCalled();
  });

  it('walks every page and returns null when nothing matches across them', async () => {
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'p1' }], nextMarker: 'm2' })
      .mockResolvedValueOnce({ items: [{ id: 'p2' }], nextMarker: 'm3' })
      .mockResolvedValueOnce({ items: [{ id: 'p3' }] });

    const match = await importTagWalk<Summary, { Tags: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage,
      describe: async () => ({ Tags: [{ Key: 'aws:cdk:path', Value: 'other' }] }),
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });

    expect(match).toBeNull();
    expect(listPage).toHaveBeenCalledTimes(3);
  });

  // EMR DescribeCluster legitimately omits Tags on an untagged cluster.
  it('skips a candidate whose tagsOf returns undefined without throwing', async () => {
    const match = await importTagWalk<Summary, { Tags?: Array<{ Key: string; Value: string }> }>({
      cdkPath: CDK_PATH,
      listPage: async () => ({ items: [{ id: 'untagged' }, { id: 'b' }] }),
      describe: async (s) =>
        s.id === 'untagged' ? {} : { Tags: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] },
      tagsOf: (d) => d.Tags,
      ...noSleep,
    });
    expect(match?.summary.id).toBe('b');
  });

  it('aborts with ImportTagWalkLimitError when the walk exceeds its time budget', async () => {
    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        logicalId: 'MyDb',
        // Every page advances, so only the deadline can stop this walk.
        listPage: async () => ({ items: [{ id: 'a' }], nextMarker: 'next' }),
        describe: async () => ({}),
        tagsOf: () => undefined,
        retry: { sleep: async () => {}, maxWalkMs: -1 },
      })
    ).rejects.toThrow(ImportTagWalkLimitError);
  });

  it('aborts when a non-advancing pagination token would loop forever', async () => {
    const listPage = vi.fn().mockResolvedValue({ items: [], nextMarker: 'stuck' });

    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        logicalId: 'MyDb',
        listPage,
        describe: async () => ({}),
        tagsOf: () => undefined,
        retry: { sleep: async () => {}, maxPages: 3 },
      })
    ).rejects.toThrow(/after 3 pages/);
    expect(listPage).toHaveBeenCalledTimes(3);
  });

  it('honors an interrupt raised while backing off', async () => {
    await expect(
      importTagWalk<Summary, unknown>({
        cdkPath: CDK_PATH,
        listPage: async () => ({ items: [{ id: 'a' }] }),
        describe: async () => {
          throw throttlingError();
        },
        tagsOf: () => undefined,
        retry: {
          sleep: async () => {},
          isInterrupted: () => true,
          onInterrupted: () => new Error('Interrupted by SIGINT'),
        },
      })
    ).rejects.toThrow(/Interrupted by SIGINT/);
  });
});
