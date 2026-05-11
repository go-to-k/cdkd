import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so vi.mock factories can reference them safely.
// (See feedback_vi_mock_hoisting.md.)
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mocks.verifyBucketExistsMock,
    listStacks: mocks.listStacksMock,
    getState: mocks.getStateMock,
  })),
}));

import { loadStateForStack } from '../../../src/cli/commands/local-state-loader.js';
import { getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';

describe('loadStateForStack — globalClients lifecycle', () => {
  beforeEach(() => {
    resetAwsClients();
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
  });

  afterEach(() => {
    resetAwsClients();
  });

  it('resets globalClients after a successful load so no destroyed reference leaks', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'MyStack', resources: {} },
      etag: 'abc',
    });

    const result = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(result?.region).toBe('us-east-1');
    // After loadStateForStack returns, globalClients must be null —
    // getAwsClients() should construct a fresh instance, not return the
    // destroyed one set inside the helper.
    const fresh = getAwsClients();
    const fresh2 = getAwsClients();
    expect(fresh).toBe(fresh2); // same fresh instance returned twice
    // Sanity-check the fresh instance is usable (no thrown "client destroyed").
    expect(() => fresh.s3).not.toThrow();
  });

  it('resets globalClients after a bucket-resolution failure (warn-and-fall-back path)', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockRejectedValue(new Error('bucket lookup failed'));

    const result = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(result).toBeUndefined();
    // No AwsClients was constructed on the early-return path; the global
    // should still be null and a subsequent getAwsClients() call must
    // produce a fresh instance.
    const fresh = getAwsClients();
    expect(() => fresh.s3).not.toThrow();
  });

  it('resets globalClients after a mid-flow error (e.g. verifyBucketExists rejects)', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockRejectedValue(new Error('access denied'));

    await expect(
      loadStateForStack('MyStack', 'us-east-1', {
        statePrefix: 'cdkd',
        region: 'us-east-1',
      })
    ).rejects.toThrow('access denied');

    // Even on a thrown error, the finally must reset the global.
    const fresh = getAwsClients();
    expect(() => fresh.s3).not.toThrow();
  });
});
