import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Hoisted mocks so vi.mock factories can reference them safely.
// (See feedback_vi_mock_hoisting.md.)
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  getRawObjectMock: vi.fn(),
  /**
   * Records every `new AwsClients(...)` config (issue #1836 round 3). This site
   * had ZERO coverage of its client region: `S3StateBackend` reads only
   * `profile` / `credentials` out of its own options bag, so the value that
   * resolves the S3 endpoint here is this constructor's `region` and nothing
   * observed it.
   */
  awsClientsCtorMock: vi.fn(),
  /**
   * Records every `parseBootstrapMarker(body, key)` call. The KEY argument is
   * diagnostics-only (it names the object in the parse-failure message), but it
   * is the one place the second, raw-spelling probe's identity is visible.
   */
  parseBootstrapMarkerMock: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getRawObject: mocks.getRawObjectMock,
  })),
}));

/**
 * The REAL `AwsClients` is kept (the lifecycle assertion at the bottom of this
 * file needs a genuine instance; the constructor only stores its config),
 * wrapped in a subclass that records it.
 */
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    AwsClients: class RecordingAwsClients extends actual.AwsClients {
      constructor(config: ConstructorParameters<typeof actual.AwsClients>[0] = {}) {
        mocks.awsClientsCtorMock(config);
        super(config);
      }
    },
  };
});

/**
 * `getBootstrapMarkerKey` is kept REAL — it is the key-shape under test — while
 * `parseBootstrapMarker` is wrapped so the key it is handed is observable
 * without changing its behavior.
 */
vi.mock('../../../src/assets/asset-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/assets/asset-storage.js')>();
  return {
    ...actual,
    parseBootstrapMarker: (body: string, key: string) => {
      mocks.parseBootstrapMarkerMock(body, key);
      return actual.parseBootstrapMarker(body, key);
    },
  };
});

import { loadBootstrapContainerRepo } from '../../../src/cli/commands/local-state-loader.js';
import { getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';

describe('loadBootstrapContainerRepo (issue #1025)', () => {
  beforeEach(() => {
    resetAwsClients();
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.getRawObjectMock.mockReset();
    mocks.awsClientsCtorMock.mockReset();
    mocks.parseBootstrapMarkerMock.mockReset();
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

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836): the marker KEY is
   * built from this chain, so an upper-cased env region used to look up
   * `cdkd-bootstrap/US-EAST-1.json`.
   *
   * BOTH spellings must resolve, because the WRITE side does not fold:
   * `cdkd bootstrap` derives its region from `options.region || AWS_REGION ||
   * 'us-east-1'` verbatim (`src/cli/commands/bootstrap.ts` — off-limits here,
   * aligned separately under issue #1820), so `AWS_REGION=US-EAST-1 cdkd
   * bootstrap` really wrote the upper-cased key. A read that folded and stopped
   * would MISS that marker and silently fall back to the conventional repo names
   * — where the pre-fold read HIT. Hence: canonical first, raw second.
   */
  describe('marker-key region case (issue #1836)', () => {
    const markerBody = JSON.stringify({
      assetBucket: 'my-custom-bucket',
      containerRepo: 'my-custom-repo',
      assetSupportVersion: 1,
      createdAt: '2026-07-17T00:00:00.000Z',
    });

    const withEnvRegion = async (value: string, fn: () => Promise<void>): Promise<void> => {
      const saved = process.env['AWS_REGION'];
      process.env['AWS_REGION'] = value;
      try {
        await fn();
      } finally {
        if (saved !== undefined) process.env['AWS_REGION'] = saved;
        else delete process.env['AWS_REGION'];
      }
    };

    it('probes the CANONICAL key first for an upper-cased region', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(markerBody);

      await withEnvRegion('CN-NORTH-1', async () => {
        const repo = await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
        expect(repo).toBe('my-custom-repo');
      });

      // Canonical FIRST, and on a hit the raw spelling is never probed: the
      // canonical key is what the write side should converge on.
      expect(mocks.getRawObjectMock.mock.calls).toEqual([['cdkd-bootstrap/cn-north-1.json']]);
    });

    it('falls back to the RAW spelling a raw-region `cdkd bootstrap` wrote', async () => {
      // The regression the fold introduced: canonical MISSES, and before this
      // fallback the run silently used the conventional repo names.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock
        .mockResolvedValueOnce(null) // cdkd-bootstrap/us-east-1.json
        .mockResolvedValueOnce(markerBody); // cdkd-bootstrap/US-EAST-1.json

      await withEnvRegion('US-EAST-1', async () => {
        const repo = await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
        expect(repo).toBe('my-custom-repo');
      });

      expect(mocks.getRawObjectMock.mock.calls).toEqual([
        ['cdkd-bootstrap/us-east-1.json'],
        ['cdkd-bootstrap/US-EAST-1.json'],
      ]);
    });

    it('returns undefined when NEITHER spelling has a marker', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await withEnvRegion('US-EAST-1', async () => {
        const repo = await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
        expect(repo).toBeUndefined();
      });

      expect(mocks.getRawObjectMock.mock.calls).toEqual([
        ['cdkd-bootstrap/us-east-1.json'],
        ['cdkd-bootstrap/US-EAST-1.json'],
      ]);
    });

    it('issues exactly ONE probe for an already-canonical region', async () => {
      // The counter-case: byte-identical behavior, and specifically no extra S3
      // round trip on the path every canonical-region user takes.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await withEnvRegion('cn-north-1', async () => {
        await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
      });

      expect(mocks.getRawObjectMock.mock.calls).toEqual([['cdkd-bootstrap/cn-north-1.json']]);
    });

    it('resolves the state bucket from the FOLDED region', async () => {
      // The bucket NAME (`cdkd-state-{acct}-{region}`) is lowercase-only, so
      // folding here can only ever resolve MORE buckets.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await withEnvRegion('CN-NORTH-1', async () => {
        await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
      });

      expect(mocks.resolveStateBucketWithDefaultMock).toHaveBeenCalledWith(
        undefined,
        'cn-north-1'
      );
      expect(mocks.resolveStateBucketWithDefaultMock).not.toHaveBeenCalledWith(
        undefined,
        'CN-NORTH-1'
      );
    });

    /**
     * Issue #1836 round 3: the raw second probe was reachable only through the
     * two env vars, because `--stack-region` arrives at this helper ALREADY
     * folded (the handler folds it on entry). So the one flag that names the
     * region explicitly could not reach the marker an upper-cased
     * `cdkd bootstrap` wrote — the exact regression the fallback exists to
     * prevent, just via a different link of the chain. `rawStackRegion` carries
     * the user's spelling for it.
     */
    it('falls back to the RAW --stack-region spelling for the second probe', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock
        .mockResolvedValueOnce(null) // cdkd-bootstrap/us-east-1.json
        .mockResolvedValueOnce(markerBody); // cdkd-bootstrap/US-EAST-1.json

      // The option pair a real `--stack-region US-EAST-1` produces.
      const repo = await loadBootstrapContainerRepo(undefined, {
        statePrefix: 'cdkd',
        stackRegion: 'us-east-1',
        rawStackRegion: 'US-EAST-1',
      });

      expect(repo).toBe('my-custom-repo');
      expect(mocks.getRawObjectMock.mock.calls).toEqual([
        ['cdkd-bootstrap/us-east-1.json'],
        ['cdkd-bootstrap/US-EAST-1.json'],
      ]);
    });

    it('issues ONE probe when the raw --stack-region was already canonical', async () => {
      // The counter-case: no extra S3 round trip on the path every
      // canonical-region user takes.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo(undefined, {
        statePrefix: 'cdkd',
        stackRegion: 'us-east-1',
        rawStackRegion: 'us-east-1',
      });

      expect(mocks.getRawObjectMock.mock.calls).toEqual([['cdkd-bootstrap/us-east-1.json']]);
    });

    it('lets --region outrank the raw --stack-region, as the chain says', async () => {
      // Ordering is `--region` > `--stack-region` > synth > env, and `--region`
      // is itself folded at the handler entry — so the raw spelling must not
      // jump the queue.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo(undefined, {
        statePrefix: 'cdkd',
        region: 'eu-west-1',
        stackRegion: 'us-east-1',
        rawStackRegion: 'US-EAST-1',
      });

      expect(mocks.getRawObjectMock.mock.calls).toEqual([['cdkd-bootstrap/eu-west-1.json']]);
    });

    it('parses the marker under the KEY the probe actually hit', async () => {
      // Diagnostics-only, but it is the only place the second probe's identity is
      // visible: a parse failure names the object the user has to look at, and
      // naming the canonical key for a marker read from the raw one sends them to
      // an object that does not exist.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(markerBody);

      await withEnvRegion('US-EAST-1', async () => {
        await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
      });

      expect(mocks.parseBootstrapMarkerMock).toHaveBeenCalledWith(
        markerBody,
        'cdkd-bootstrap/US-EAST-1.json'
      );
    });

    it('parses the marker under the CANONICAL key when the first probe hits', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(markerBody);

      await withEnvRegion('US-EAST-1', async () => {
        await loadBootstrapContainerRepo(undefined, { statePrefix: 'cdkd' });
      });

      expect(mocks.parseBootstrapMarkerMock).toHaveBeenCalledWith(
        markerBody,
        'cdkd-bootstrap/us-east-1.json'
      );
    });

    /**
     * Issue #1836 round 3, fix 3: this site's `AwsClients` region had no
     * assertion anywhere — the only client-shaped coverage was the lifecycle
     * check at the bottom of the file, which never looks at the config.
     */
    it('builds the S3 client with the FOLDED --region', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo(undefined, {
        statePrefix: 'cdkd',
        region: 'CN-NORTH-1',
      });

      const config = (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect(config['region']).toBe('cn-north-1');
      expect(config['region']).not.toBe('CN-NORTH-1');
    });

    it('leaves an already-canonical --region byte-identical on the S3 client', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo(undefined, {
        statePrefix: 'cdkd',
        region: 'cn-north-1',
      });

      const config = (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect(config['region']).toBe('cn-north-1');
    });

    it('omits the client region entirely when --region is absent', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo('us-east-1', { statePrefix: 'cdkd' });

      const config = (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect('region' in config).toBe(false);
    });

    it('treats a BLANK --region as absent on the S3 client', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.getRawObjectMock.mockResolvedValue(null);

      await loadBootstrapContainerRepo('us-east-1', { statePrefix: 'cdkd', region: '' });

      const config = (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect('region' in config).toBe(false);
    });
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
