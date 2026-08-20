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
  reconcileRegionWithLegacyDefault,
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

describe('reconcileRegionWithLegacyDefault', () => {
  const logger = { info: vi.fn(), debug: vi.fn() };
  const probeWith = (regionsWithState: string[]) => ({
    stateExists: vi.fn(async (_stack: string, region: string) => regionsWithState.includes(region)),
  });

  beforeEach(() => {
    logger.info.mockClear();
    logger.debug.mockClear();
  });

  it('HOLDS an existing us-east-1 stack instead of moving it to the profile region', async () => {
    // The whole reason the #2029 fix is safe to ship. Without this the upgrade
    // looks under a key nothing wrote, treats every resource as a CREATE, and
    // duplicates live infrastructure while orphaning the original stack.
    const probe = probeWith(['us-east-1']);
    await expect(
      reconcileRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        stackName: 'MyStack',
        probe,
        logger,
      })
    ).resolves.toBe('us-east-1');
    // ...and SAYS so, since this is the only place the user learns the default
    // moved and how to opt in.
    expect(logger.info).toHaveBeenCalledTimes(1);
    const said = logger.info.mock.calls[0]![0] as string;
    expect(said).toContain('ap-northeast-1');
    expect(said).toContain('--region');
  });

  it('uses the profile region when the stack already has state THERE', async () => {
    const probe = probeWith(['ap-northeast-1', 'us-east-1']);
    await expect(
      reconcileRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        stackName: 'MyStack',
        probe,
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    // The legacy key must not even be probed for an already-migrated stack:
    // its only possible effect there is a false hold.
    expect(probe.stateExists).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('uses the profile region for a FIRST deploy — nothing to strand', async () => {
    const probe = probeWith([]);
    await expect(
      reconcileRegionWithLegacyDefault({
        effective: { region: 'ap-northeast-1', source: 'profile' },
        stackName: 'MyStack',
        probe,
        logger,
      })
    ).resolves.toBe('ap-northeast-1');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('OBEYS a named region even when legacy state exists', async () => {
    // `--region X` means operate on X, not "guess what I meant". Probing at all
    // here would be wrong, so assert it does not.
    const probe = probeWith(['us-east-1']);
    for (const source of ['flag', 'env'] as const) {
      await expect(
        reconcileRegionWithLegacyDefault({
          effective: { region: 'ap-northeast-1', source },
          stackName: 'MyStack',
          probe,
          logger,
        })
      ).resolves.toBe('ap-northeast-1');
    }
    expect(probe.stateExists).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when the profile ALREADY resolves the legacy default', async () => {
    const probe = probeWith(['us-east-1']);
    await expect(
      reconcileRegionWithLegacyDefault({
        effective: { region: 'us-east-1', source: 'profile' },
        stackName: 'MyStack',
        probe,
        logger,
      })
    ).resolves.toBe('us-east-1');
    expect(probe.stateExists).not.toHaveBeenCalled();
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
    // This is the twin all three commands actually call. Its sibling
    // `reconcileRegionWithLegacyDefault` (tested above) has NO production
    // caller yet — it is staged for issue go-to-k/cdkd#2100 — so testing only
    // that one would have covered the unused function and left the shipped one
    // to indirect coverage.
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
