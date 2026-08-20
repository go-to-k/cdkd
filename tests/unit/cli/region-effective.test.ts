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

const { resolveEffectiveRegion, reconcileRegionWithLegacyDefault, LEGACY_DEFAULT_REGION } =
  await import('../../../src/cli/region-options.js');

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

  it('reads AWS_DEFAULT_REGION, which the JS SDK itself does NOT', async () => {
    // Measured: with only this variable set, `STSClient({}).config.region()`
    // returns the PROFILE's region, not the variable's. The AWS CLI honours it,
    // so reading it here is what stops cdkd disagreeing with a CLI command the
    // user just ran.
    stsRegionProvider.value = 'ap-northeast-1';
    process.env['AWS_DEFAULT_REGION'] = 'EU-CENTRAL-1';
    await expect(resolveEffectiveRegion({})).resolves.toEqual({
      region: 'eu-central-1',
      source: 'env',
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
