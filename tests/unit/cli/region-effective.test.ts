import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue [#2029](https://github.com/go-to-k/cdkd/issues/2029): cdkd resolved the
 * region it OPERATES on as `--region` -> `AWS_REGION` -> `'us-east-1'`, never
 * consulting the AWS profile — while its own pre-flight clients, built
 * region-less, DID consult it. One command, two regions.
 *
 * Measured before the fix, profile `region = ap-northeast-1`, no flag, no env,
 * env-agnostic stack:
 *
 * ```text
 * State bucket '...' is in 'us-east-1' (client was 'ap-northeast-1'); rebuilding S3 client.
 * Getting state for stack: CdkdBasicExample (us-east-1)
 * Resolved Ref to pseudo parameter: AWS::Region -> us-east-1
 * ```
 */
const stsRegionProvider = vi.hoisted(() => ({ value: undefined as string | undefined }));
const stsDestroy = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        // The SDK's real contract: a region-less client REJECTS when the chain
        // answers nothing. Modelling the rejection is what makes the
        // `default` arm reachable at all.
        if (!stsRegionProvider.value) throw new Error('Region is missing');
        return stsRegionProvider.value;
      },
    },
    destroy: stsDestroy,
  })),
}));

const {
  resolveEffectiveRegion,
  stackRegionResolver,
  legacyStateBucketFallbackRegion,
  reconcileExportIndexRegion,
  withOtherIndexRemoval,
  reconcileMarkerRegionWithLegacyDefault,
  regionNeedsReconciliation,
  LEGACY_DEFAULT_REGION,
} = await import('../../../src/cli/region-options.js');

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  stsRegionProvider.value = undefined;
});
afterEach(() => {
  if (saved.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = saved.region;
  if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = saved.def;
});

describe('resolveEffectiveRegion', () => {
  it('uses the PROFILE region when the user names none — the issue #2029 fix', async () => {
    // THE discriminator. Pre-fix this returned 'us-east-1' regardless.
    stsRegionProvider.value = 'ap-northeast-1';
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'ap-northeast-1',
      source: 'profile',
    });
  });

  it('prefers the flag over everything, folded', async () => {
    stsRegionProvider.value = 'ap-northeast-1';
    process.env['AWS_REGION'] = 'eu-west-1';
    await expect(resolveEffectiveRegion({ region: 'US-EAST-2' })).resolves.toEqual({
      region: 'us-east-2',
      source: 'flag',
    });
  });

  it('prefers AWS_REGION over the profile, folded', async () => {
    stsRegionProvider.value = 'ap-northeast-1';
    process.env['AWS_REGION'] = 'EU-WEST-1';
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'eu-west-1',
      source: 'env',
    });
  });

  it('reads AWS_DEFAULT_REGION as its OWN source, not as `env`', async () => {
    // Measured: with only this variable set, `STSClient({}).config.region()`
    // returns the PROFILE's region, not the variable's. The AWS CLI honours it,
    // so reading it here is what stops cdkd disagreeing with a CLI command the
    // user just ran.
    //
    // The SOURCE is the load-bearing half. Before this change cdkd never read
    // the variable at all, so acting on it is an INFERENCE rather than
    // something the user asked cdkd for — and inferences are what the
    // reconciliation exists to hold. Classifying it as `env` would skip the
    // hold, which for a CI image that exports it means
    // `cdkd bootstrap --destroy --yes` reporting "nothing to delete" over
    // us-east-1 storage that keeps billing.
    stsRegionProvider.value = 'ap-northeast-1';
    process.env['AWS_DEFAULT_REGION'] = 'EU-CENTRAL-1';
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'eu-central-1',
      source: 'default-env',
    });
  });

  it('ranks AWS_REGION above AWS_DEFAULT_REGION', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'eu-west-1',
      source: 'env',
    });
  });

  it('falls back to the historical literal only when NOTHING answers', async () => {
    stsRegionProvider.value = undefined;
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: LEGACY_DEFAULT_REGION,
      source: 'default',
    });
  });

  it('destroys its probe client on both the answering and the rejecting path', async () => {
    stsRegionProvider.value = 'ap-northeast-1';
    await resolveEffectiveRegion({});
    stsRegionProvider.value = undefined;
    await resolveEffectiveRegion({});
    expect(stsDestroy).toHaveBeenCalledTimes(2);
  });

  it('builds NO probe client at all when the region was named', async () => {
    // The probe is a real network-capable client; a named region must not pay
    // for it. Also the ordering guarantee: nothing consults the profile when
    // the user has already said which region they mean.
    const { STSClient } = await import('@aws-sdk/client-sts');
    process.env['AWS_REGION'] = 'eu-west-1';
    await resolveEffectiveRegion({});
    await resolveEffectiveRegion({ region: 'eu-west-2' });
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
  });
});

describe('resolveEffectiveRegion forwards the profile to its probe', () => {
  it('constructs the STS probe WITH the profile, so a named profile is honoured', async () => {
    // Load-bearing, and it was untested: the real SDK merges
    // `loaderConfig = { profile }` into `NODE_REGION_CONFIG_FILE_OPTIONS`
    // (`@aws-sdk/client-sts`'s runtimeConfig), so dropping it makes
    // `cdkd gc --profile prod` resolve the DEFAULT profile's region and collect
    // - or delete - in the wrong one.
    const { STSClient } = await import('@aws-sdk/client-sts');
    stsRegionProvider.value = 'eu-west-1';
    await resolveEffectiveRegion({ profile: 'prod' });
    expect(vi.mocked(STSClient)).toHaveBeenCalledWith({ profile: 'prod' });
  });

  it('constructs it with NO profile when none was given', async () => {
    const { STSClient } = await import('@aws-sdk/client-sts');
    stsRegionProvider.value = 'eu-west-1';
    await resolveEffectiveRegion({});
    expect(vi.mocked(STSClient)).toHaveBeenCalledWith({});
  });
});

describe('exportInferredRegionForSdk', () => {
  afterEach(async () => {
  });

  it('copies an AWS_DEFAULT_REGION answer into AWS_REGION, and a second resolution stays an INFERENCE', async () => {
    // Review nit (a): without the marker a second resolveEffectiveRegion in
    // the same process would read the copy as a NAMED region and skip the hold.
    const { exportInferredRegionForSdk } = await import('../../../src/cli/region-options.js');
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    const first = await resolveEffectiveRegion({});
    expect(first).toEqual({ region: 'eu-west-1', source: 'default-env' });
    exportInferredRegionForSdk(first);
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'eu-west-1',
      source: 'default-env',
    });
  });

  it('copies nothing for a profile, flag or env answer', async () => {
    const { exportInferredRegionForSdk } = await import('../../../src/cli/region-options.js');
    for (const source of ['profile', 'flag', 'env', 'default'] as const) {
      exportInferredRegionForSdk({ region: 'eu-west-1', source });
    }
    expect(process.env['AWS_REGION']).toBeUndefined();
  });
});

describe('regionNeedsReconciliation', () => {
  it.each([
    ['flag', 'ap-northeast-1', false],
    ['env', 'ap-northeast-1', false],
    // The whole reason `default-env` is its own source: cdkd never read
    // AWS_DEFAULT_REGION before, so acting on it is an inference and must be
    // held. CI images commonly export it.
    ['default-env', 'ap-northeast-1', true],
    ['profile', 'ap-northeast-1', true],
    // Already the legacy region - nothing to reconcile against.
    ['profile', 'us-east-1', false],
    ['default', 'us-east-1', false],
  ] as const)('source=%s region=%s -> %s', (source, region, expected) => {
    expect(regionNeedsReconciliation({ region, source })).toBe(expected);
  });
});

describe('reconcileMarkerRegionWithLegacyDefault', () => {
  const logger = { info: vi.fn(), debug: vi.fn() };
  const markerKeyFor = (region: string): string => `cdkd-bootstrap/${region}.json`;
  const probeWith = (regionsWithMarker: string[]) => ({
    getRawObject: vi.fn(async (key: string) =>
      regionsWithMarker.some((r) => key === markerKeyFor(r)) ? '{"assetSupportVersion":1}' : null
    ),
  });

  beforeEach(() => {
    logger.info.mockClear();
    logger.debug.mockClear();
  });

  it('HOLDS an existing us-east-1 marker and says so', async () => {
    // The marker twin of `stackRegionResolver` (below): all three bootstrap
    // commands call it.
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe: probeWith(['us-east-1']),
        markerKeyFor,
        logger,
      })
    ).resolves.toBe('us-east-1');
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('HOLDS for an AWS_DEFAULT_REGION-sourced region too', async () => {
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'us-west-2', source: 'default-env' },
        probe: probeWith(['us-east-1']),
        markerKeyFor,
        logger,
      })
    ).resolves.toBe('us-east-1');
  });

  it('uses the resolved region when a marker exists THERE, probing once', async () => {
    const probe = probeWith(['ap-northeast-1', 'us-east-1']);
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe,
        markerKeyFor,
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    expect(probe.getRawObject).toHaveBeenCalledTimes(1);
  });

  it('OBEYS a named region without probing at all', async () => {
    const probe = probeWith(['us-east-1']);
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'flag' },
        probe,
        markerKeyFor,
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    expect(probe.getRawObject).not.toHaveBeenCalled();
  });

  it('treats NoSuchBucket as "no marker" — the first-bootstrap case', async () => {
    // On a first `cdkd bootstrap` the state bucket does not exist yet, so the
    // probe rejects. Without this arm the command would crash before creating
    // anything.
    const probe = {
      getRawObject: vi.fn(async () => {
        throw Object.assign(new Error('The specified bucket does not exist'), {
          name: 'NoSuchBucket',
        });
      }),
    };
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe,
        markerKeyFor,
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
  });

  it('RETHROWS anything else rather than holding on a transient failure', async () => {
    // The counter-case, and the reason the catch is narrow. A 403 or a throttle
    // on the PROFILE-region key would otherwise make cdkd conclude that region
    // has no storage, fall through to the legacy key and hold us-east-1 — so
    // `cdkd gc --yes` would delete in a region the user never named, off a
    // transient error, with only a debug line to show for it.
    const probe = {
      getRawObject: vi.fn(async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }),
    };
    await expect(
      reconcileMarkerRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe,
        markerKeyFor,
        logger,
      })
    ).rejects.toThrow('Access Denied');
  });
});

/**
 * go-to-k/cdkd#2100: the per-command wiring of the state-key reconciliation.
 * Every command that keys state by an env-agnostic stack's region resolves it
 * through `stackRegionResolver`, so these cases are the contract each of them
 * inherits.
 */
describe('stackRegionResolver', () => {
  const logger = { info: vi.fn(), debug: vi.fn() };
  // `stateExistsOwnedBy` is what every command hands over: the region-less
  // legacy owner is always us-east-1 for the reconciliation.
  const probeWith = (stacksWithState: Record<string, string[]>) => ({
    stateExistsOwnedBy: vi.fn(async (stack: string, region: string, owner: string) => {
      expect(owner).toBe('us-east-1');
      return (stacksWithState[stack] ?? []).includes(region);
    }),
  });
  const inferred = { region: 'ap-northeast-1', source: 'profile' } as const;
  beforeEach(() => {
    logger.info.mockClear();
    logger.debug.mockClear();
  });

  it('returns a PINNED region as given, without probing', async () => {
    const probe = probeWith({ Pinned: ['us-east-1'] });
    const regionFor = stackRegionResolver({ effective: inferred, probe, logger });
    await expect(regionFor('Pinned', 'eu-west-1')).resolves.toBe('eu-west-1');
    expect(probe.stateExistsOwnedBy).not.toHaveBeenCalled();
  });

  it('holds an env-agnostic stack with state only under the old default (old key present)', async () => {
    const regionFor = stackRegionResolver({
      effective: inferred,
      probe: probeWith({ Old: ['us-east-1'] }),
      logger,
    });
    await expect(regionFor('Old')).resolves.toBe('us-east-1');
    expect(logger.info.mock.calls[0]![0]).toContain('Continuing to use us-east-1');
  });

  it('moves an env-agnostic stack with no state anywhere to the profile region (old key absent)', async () => {
    const regionFor = stackRegionResolver({ effective: inferred, probe: probeWith({}), logger });
    await expect(regionFor('New')).resolves.toBe('ap-northeast-1');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('probes and warns ONCE per stack however often it is asked', async () => {
    // deploy asks for the same stack from two loops; the answer and the
    // warning must not be produced twice.
    const probe = probeWith({ Old: ['us-east-1'] });
    const regionFor = stackRegionResolver({ effective: inferred, probe, logger });
    await regionFor('Old');
    await regionFor('Old');
    expect(probe.stateExistsOwnedBy).toHaveBeenCalledTimes(2); // profile key and legacy key, once
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed probe rather than replaying the rejection', async () => {
    let calls = 0;
    const probe = {
      stateExistsOwnedBy: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('throttled');
        return false;
      }),
    };
    const regionFor = stackRegionResolver({ effective: inferred, probe, logger });
    await expect(regionFor('S')).rejects.toThrow('throttled');
    await expect(regionFor('S')).resolves.toBe('ap-northeast-1');
  });

  it('never probes a NAMED region', async () => {
    const probe = probeWith({ S: ['us-east-1'] });
    const regionFor = stackRegionResolver({
      effective: { region: 'ap-northeast-1', source: 'env' },
      probe,
      logger,
    });
    await expect(regionFor('S')).resolves.toBe('ap-northeast-1');
    expect(probe.stateExistsOwnedBy).not.toHaveBeenCalled();
  });

  it('the hold message names AWS_REGION both ways, never --region, and where the region came from', async () => {
    const regionFor = stackRegionResolver({
      effective: inferred,
      probe: probeWith({ Old: ['us-east-1'] }),
      logger,
    });
    await regionFor('Old');
    const said = String(logger.info.mock.calls[0]![0]);
    // `--region` is deprecated on every command that reaches this hold.
    expect(said).toContain('AWS_REGION=ap-northeast-1');
    expect(said).toContain('AWS_REGION=us-east-1');
    expect(said).not.toContain('--region');
    expect(said).toContain('your AWS profile');
  });

  it('names AWS_DEFAULT_REGION, not the profile, when that is where the region came from', async () => {
    const regionFor = stackRegionResolver({
      effective: { region: 'eu-west-1', source: 'default-env' },
      probe: probeWith({ Old: ['us-east-1'] }),
      logger,
    });
    await expect(regionFor('Old')).resolves.toBe('us-east-1');
    const said = String(logger.info.mock.calls[0]![0]);
    expect(said).toContain('AWS_DEFAULT_REGION resolves eu-west-1');
    expect(said).not.toContain('your AWS profile');
  });

  it('describes, rather than prints, a stack name that is not a plain identifier', async () => {
    const regionFor = stackRegionResolver({
      effective: inferred,
      probe: probeWith({ 'Evil\nStack': ['us-east-1'] }),
      logger,
    });
    await regionFor('Evil\nStack');
    const said = String(logger.info.mock.calls[0]![0]);
    expect(said).not.toContain('Evil');
    expect(said).toContain('a stack whose name is not a plain identifier');
  });

  it('a stack with state in BOTH regions keeps the us-east-1 one a bare command always used, and names both', async () => {
    const probe = probeWith({ Twin: ['ap-northeast-1', 'us-east-1'] });
    const regionFor = stackRegionResolver({ effective: inferred, probe, logger });
    await expect(regionFor('Twin')).resolves.toBe('us-east-1');
    const said = String(logger.info.mock.calls[0]![0]);
    expect(said).toContain('has state in both us-east-1 and ap-northeast-1');
    expect(said).toContain('AWS_REGION=ap-northeast-1');
  });

  it('uses the profile region, silently, for a stack whose state is there only', async () => {
    const regionFor = stackRegionResolver({
      effective: inferred,
      probe: probeWith({ Moved: ['ap-northeast-1'] }),
      logger,
    });
    await expect(regionFor('Moved')).resolves.toBe('ap-northeast-1');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when the profile ALREADY resolves the legacy default', async () => {
    const probe = probeWith({ Old: ['us-east-1'] });
    const regionFor = stackRegionResolver({
      effective: { region: 'us-east-1', source: 'profile' },
      probe,
      logger,
    });
    await expect(regionFor('Old')).resolves.toBe('us-east-1');
    expect(probe.stateExistsOwnedBy).not.toHaveBeenCalled();
  });

  describe('a NEW stack in an app whose other stacks are held (siblings)', () => {
    it('joins its held siblings in us-east-1, so the app is not split across regions', async () => {
      const regionFor = stackRegionResolver({
        effective: inferred,
        probe: probeWith({ Vpc: ['us-east-1'] }),
        logger,
        siblings: ['Vpc', 'Fresh'],
      });
      await expect(regionFor('Fresh')).resolves.toBe('us-east-1');
      const said = logger.info.mock.calls.map((c) => String(c[0]));
      expect(said.some((m) => m.includes('so the app stays in one region'))).toBe(true);
      // The sibling's own hold line belongs to a run that operates on it.
      expect(said.some((m) => m.includes("Stack 'Vpc'"))).toBe(false);
    });

    it('goes to the profile region when a sibling has already moved there (mixed app)', async () => {
      const regionFor = stackRegionResolver({
        effective: inferred,
        probe: probeWith({ Vpc: ['us-east-1'], Api: ['ap-northeast-1'] }),
        logger,
        siblings: ['Vpc', 'Api', 'Fresh'],
      });
      await expect(regionFor('Fresh')).resolves.toBe('ap-northeast-1');
    });

    it('goes to the profile region when no sibling has state anywhere (a first deploy)', async () => {
      const regionFor = stackRegionResolver({
        effective: inferred,
        probe: probeWith({}),
        logger,
        siblings: ['A', 'B'],
      });
      await expect(regionFor('A')).resolves.toBe('ap-northeast-1');
      await expect(regionFor('B')).resolves.toBe('ap-northeast-1');
    });
  });
});

describe('legacyStateBucketFallbackRegion', () => {
  it('names the old default only for an INFERRED region that differs from it', () => {
    expect(legacyStateBucketFallbackRegion({ region: 'ap-northeast-1', source: 'profile' })).toBe(
      'us-east-1'
    );
    expect(
      legacyStateBucketFallbackRegion({ region: 'ap-northeast-1', source: 'default-env' })
    ).toBe('us-east-1');
    expect(
      legacyStateBucketFallbackRegion({ region: 'ap-northeast-1', source: 'flag' })
    ).toBeUndefined();
    expect(
      legacyStateBucketFallbackRegion({ region: 'ap-northeast-1', source: 'env' })
    ).toBeUndefined();
    expect(legacyStateBucketFallbackRegion({ region: 'us-east-1', source: 'profile' })).toBeUndefined();
  });
});

describe('reconcileExportIndexRegion', () => {
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const probeWith = (regionsWithIndex: string[]) => ({
    rawObjectExists: vi.fn(async (key: string) =>
      regionsWithIndex.some((r) => key === `cdkd/_index/${r}/exports.json`)
    ),
  });

  it('keeps the index the old default wrote while the profile region has none', async () => {
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe: probeWith(['us-east-1']),
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('us-east-1');
  });

  it('uses the us-east-1 index whenever it exists, even when the profile region has one too', async () => {
    // One file per command, and the us-east-1 one is where every pre-#2100
    // bare run wrote: a split would leave stale entries a consumer trusts.
    const probe = probeWith(['ap-northeast-1', 'us-east-1']);
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe,
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('us-east-1');
    expect(probe.rawObjectExists).toHaveBeenCalledTimes(1);
  });

  it("uses the profile region's index when there is no us-east-1 one", async () => {
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe: probeWith(['ap-northeast-1']),
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
  });

  it('uses the profile region when neither index exists', async () => {
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe: probeWith([]),
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
  });

  it('reads nothing for a named region', async () => {
    const probe = probeWith(['us-east-1']);
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'flag' },
        probe,
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    expect(probe.rawObjectExists).not.toHaveBeenCalled();
  });

  it('a probe that FAILS answers the inferred region instead of failing the command', async () => {
    // Before #2100 these commands touched the index only on a lookup, so a
    // policy denying the index key must not start failing them here.
    const probe = {
      rawObjectExists: vi.fn(async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }),
    };
    await expect(
      reconcileExportIndexRegion({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        probe,
        statePrefix: 'cdkd',
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    // n10: said at warn, not buried in debug.
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('withOtherIndexRemoval', () => {
  const logger = { warn: vi.fn() };
  const fixture = (otherExists: boolean) => {
    const calls: string[][] = [];
    const runStore = {
      tag: 'run',
      removeStack: vi.fn(async (stack: string, region: string) => {
        calls.push(['run', stack, region]);
      }),
      lookup: vi.fn(function (this: { tag: string }) {
        return this.tag;
      }),
    };
    const createStore = vi.fn((indexRegion: string) => ({
      removeStackIfPresent: vi.fn(async (stack: string, region: string) => {
        calls.push([indexRegion, stack, region]);
      }),
    }));
    const probe = { rawObjectExists: vi.fn(async () => otherExists) };
    return { calls, runStore, createStore, probe };
  };
  beforeEach(() => logger.warn.mockClear());

  it('removes from the run file AND the other one, building the other store ONCE (R4-2)', async () => {
    const f = fixture(true);
    const store = withOtherIndexRemoval(f.runStore, {
      effective: { region: 'ap-northeast-1', source: 'profile' },
      runIndexRegion: 'us-east-1',
      statePrefix: 'cdkd',
      probe: f.probe,
      createStore: f.createStore,
      logger,
    });
    await store.removeStack('Parent', 'ap-northeast-1');
    await store.removeStack('Parent~Child', 'ap-northeast-1');
    expect(f.calls).toEqual([
      ['run', 'Parent', 'ap-northeast-1'],
      ['ap-northeast-1', 'Parent', 'ap-northeast-1'],
      ['run', 'Parent~Child', 'ap-northeast-1'],
      ['ap-northeast-1', 'Parent~Child', 'ap-northeast-1'],
    ]);
    expect(f.createStore).toHaveBeenCalledTimes(1);
    expect(f.probe.rawObjectExists).toHaveBeenCalledTimes(1);
    expect(f.probe.rawObjectExists).toHaveBeenCalledWith('cdkd/_index/ap-northeast-1/exports.json');
  });

  it('delegates every other member to the run store itself', async () => {
    const f = fixture(true);
    const store = withOtherIndexRemoval(f.runStore, {
      effective: { region: 'ap-northeast-1', source: 'profile' },
      runIndexRegion: 'ap-northeast-1',
      statePrefix: 'cdkd',
      probe: f.probe,
      createStore: f.createStore,
      logger,
    });
    expect(store.lookup()).toBe('run');
    expect(store.tag).toBe('run');
    await store.removeStack('A', 'us-east-1');
    // The run picked the profile file: the other candidate is us-east-1.
    expect(f.calls).toEqual([
      ['run', 'A', 'us-east-1'],
      ['us-east-1', 'A', 'us-east-1'],
    ]);
  });

  it('never builds a store for, and so never creates, an other file that does not exist (n11)', async () => {
    const f = fixture(false);
    const store = withOtherIndexRemoval(f.runStore, {
      effective: { region: 'ap-northeast-1', source: 'profile' },
      runIndexRegion: 'us-east-1',
      statePrefix: 'cdkd',
      probe: f.probe,
      createStore: f.createStore,
      logger,
    });
    await store.removeStack('A', 'ap-northeast-1');
    expect(f.createStore).not.toHaveBeenCalled();
    expect(f.calls).toEqual([['run', 'A', 'ap-northeast-1']]);
  });

  it('a NAMED region gets the run store unchanged', () => {
    const f = fixture(true);
    const store = withOtherIndexRemoval(f.runStore, {
      effective: { region: 'ap-northeast-1', source: 'env' },
      runIndexRegion: 'ap-northeast-1',
      statePrefix: 'cdkd',
      probe: f.probe,
      createStore: f.createStore,
      logger,
    });
    expect(store).toBe(f.runStore);
  });

  it('a failing other-file removal warns and does not throw', async () => {
    const f = fixture(true);
    f.probe.rawObjectExists.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDenied' })
    );
    const store = withOtherIndexRemoval(f.runStore, {
      effective: { region: 'ap-northeast-1', source: 'profile' },
      runIndexRegion: 'us-east-1',
      statePrefix: 'cdkd',
      probe: f.probe,
      createStore: f.createStore,
      logger,
    });
    await expect(store.removeStack('A', 'ap-northeast-1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
