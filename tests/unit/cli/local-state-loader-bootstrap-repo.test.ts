import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Hoisted mocks so vi.mock factories can reference them safely.
// (See feedback_vi_mock_hoisting.md.)
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  getRawObjectMock: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getRawObject: mocks.getRawObjectMock,
  })),
}));

import { loadBootstrapContainerRepo } from '../../../src/cli/commands/local-state-loader.js';
import { getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';

describe('loadBootstrapContainerRepo (issue #1025)', () => {
  beforeEach(() => {
    resetAwsClients();
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.getRawObjectMock.mockReset();
  });

  afterEach(() => {
    resetAwsClients();
  });

  it('returns the marker containerRepo when the bootstrap marker is present', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(
      JSON.stringify({
        assetBucket: 'my-custom-bucket',
        containerRepo: 'my-custom-repo',
        assetSupportVersion: 1,
        createdAt: '2026-07-17T00:00:00.000Z',
      })
    );

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBe('my-custom-repo');
    // The marker key is bucket-root-relative (outside the state prefix) —
    // no double-prefixing (see asset-storage.getBootstrapMarkerKey).
    expect(mocks.getRawObjectMock).toHaveBeenCalledWith('cdkd-bootstrap/us-east-1.json');
  });

  it('returns undefined when the marker object does not exist (null body)', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(null);

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBeUndefined();
  });

  it('returns undefined (never throws) when the state bucket cannot be resolved', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockRejectedValue(new Error('bucket lookup failed'));

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBeUndefined();
    expect(mocks.getRawObjectMock).not.toHaveBeenCalled();
  });

  it('returns undefined (never throws) when the marker body is malformed JSON', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue('{not-json');

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBeUndefined();
  });

  it('returns undefined (never throws) when the marker is missing required fields', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(JSON.stringify({ assetBucket: 'only-bucket' }));

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBeUndefined();
  });

  it('returns undefined (never throws) when the S3 read itself fails', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockRejectedValue(new Error('access denied'));

    const repo = await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(repo).toBeUndefined();
  });

  it('falls back through the region chain to the synth region for the marker key', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(null);
    const savedRegion = process.env['AWS_REGION'];
    const savedDefaultRegion = process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    try {
      await loadBootstrapContainerRepo('eu-west-1', { statePrefix: 'cdkd' });
      expect(mocks.getRawObjectMock).toHaveBeenCalledWith('cdkd-bootstrap/eu-west-1.json');
    } finally {
      if (savedRegion !== undefined) process.env['AWS_REGION'] = savedRegion;
      if (savedDefaultRegion !== undefined) process.env['AWS_DEFAULT_REGION'] = savedDefaultRegion;
    }
  });

  it('prefers --stack-region over the synth/env regions for the marker key', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(null);
    const savedRegion = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    try {
      await loadBootstrapContainerRepo('ap-northeast-1', {
        statePrefix: 'cdkd',
        stackRegion: 'eu-west-1',
      });
      // The marker records the STACK's deploy region — the explicit
      // --stack-region disambiguator wins over both the synth-derived
      // region and the ambient env region (only --region outranks it).
      expect(mocks.getRawObjectMock).toHaveBeenCalledWith('cdkd-bootstrap/eu-west-1.json');
    } finally {
      if (savedRegion !== undefined) process.env['AWS_REGION'] = savedRegion;
      else delete process.env['AWS_REGION'];
    }
  });

  it('prefers the synth region over the ambient env region for the marker key', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(null);
    const savedRegion = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    try {
      await loadBootstrapContainerRepo('ap-northeast-1', { statePrefix: 'cdkd' });
      // The synth-derived stack region names the deploy region whose
      // marker is relevant; the env region is only the last resort.
      expect(mocks.getRawObjectMock).toHaveBeenCalledWith('cdkd-bootstrap/ap-northeast-1.json');
    } finally {
      if (savedRegion !== undefined) process.env['AWS_REGION'] = savedRegion;
      else delete process.env['AWS_REGION'];
    }
  });

  it('resets globalClients after the read so no destroyed reference leaks', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.getRawObjectMock.mockResolvedValue(null);

    await loadBootstrapContainerRepo('us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    // After the helper returns, globalClients must be null — getAwsClients()
    // should construct a fresh, usable instance (same pattern as the
    // loadStateForStack lifecycle tests).
    const fresh = getAwsClients();
    expect(() => fresh.s3).not.toThrow();
  });
});
