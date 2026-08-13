import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { substituteAgainstState } from '../../../src/local/state-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795): the three
 * `cdkd local *` commands derive `${AWS::URLSuffix}` from the RAW `--region`
 * the user typed, and `derivePartitionAndUrlSuffix` classified a region by
 * case-SENSITIVE `startsWith`. So `--region CN-NORTH-1` fell through to the
 * COMMERCIAL partition and each command synthesized
 * `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com/...` — a `cn-` region carrying the
 * commercial suffix, a host that does not exist.
 *
 * The fix has TWO halves and both are pinned here. `canonicalizeRegion` inside
 * `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`) fixes the
 * derived SUFFIX for every caller from ONE normalization point; each of the
 * three call sites ALSO folds the region VALUE, because the raw value seeds
 * every SDK client the command builds — AWS SDK endpoint resolution is
 * case-sensitive in exactly the same way, so `CN-NORTH-1` reached the
 * COMMERCIAL `sts.CN-NORTH-1.amazonaws.com` and `GetCallerIdentity` failed —
 * and is substituted verbatim as `${AWS::Region}` into every ARN.
 *
 * So each call site is asserted three ways: the suffix, the region VALUE, and
 * the RESOLVED image `Fn::Sub` those two compose into (the assertion that would
 * have caught a fix covering only the suffix). Every one is paired with a
 * commercial counter-case pinning byte-identical behavior.
 *
 * STS is mocked because every one of the three resolvers issues a single
 * `GetCallerIdentity` for `${AWS::AccountId}` before deriving the suffix.
 */
const stsMock = vi.hoisted(() => ({
  send: vi.fn(async () => ({ Account: '123456789012' }) as unknown),
  destroy: vi.fn(),
}));

/**
 * Every config an `STSClient` was constructed with, in order. The
 * issue-[#1836](https://github.com/go-to-k/cdkd/issues/1836) assertion is about
 * the client's REGION, so the constructor argument — not just the derived
 * pseudo-parameter bag — has to be observable.
 */
const stsClientConfigs = vi.hoisted(() => [] as unknown[]);

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown, config: unknown) {
    stsClientConfigs.push(config);
    return stsMock;
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
}));

const { resolvePseudoParametersForInvoke, applyLambdaCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext, resolveEcsConsumerRegion } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { applyAgentCoreCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);

/**
 * A stack whose only ECS container image is an `Fn::Sub` over the AWS pseudo
 * parameters — the canonical `ContainerImage.fromEcrRepository` shape, and the
 * one `detectEcsImageResolutionNeeds` flags as needing pseudo parameters.
 */
function ecsStack(): StackInfo {
  return {
    stackName: 'RegionCaseStack',
    displayName: 'RegionCaseStack',
    artifactId: 'RegionCaseStack',
    dependencyNames: [],
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: {
                  'Fn::Sub':
                    '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/my-repo:latest',
                },
              },
            ],
          },
        },
      },
    },
  };
}

/**
 * `getLogger()` returns a module-global singleton and each helper calls it per
 * invocation, so spying on the instance intercepts the warnings without mocking
 * the whole logger module (which every transitive import shares).
 */
const warnSpy = vi.spyOn(getLogger(), 'warn');

beforeEach(() => {
  warnSpy.mockReset();
  warnSpy.mockImplementation(() => {});
  stsMock.send.mockClear();
  stsMock.destroy.mockClear();
  // `mockClear()` does NOT drop an implementation installed by a previous test
  // (only `mockReset()` does), so the default is restored explicitly here —
  // the AssumeRole suite below swaps it for a credentials-shaped response.
  stsMock.send.mockImplementation(async () => ({ Account: '123456789012' }));
  stsClientConfigs.length = 0;
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
});

/**
 * The `Fn::Sub` an ECS / Lambda template actually carries for the canonical
 * `ContainerImage.fromEcrRepository` shape, resolved against a pseudo-parameter
 * bag. Asserting the SUBSTITUTED host rather than the bag's individual fields
 * is what catches a bag whose `urlSuffix` is right but whose `region` is not —
 * the two compose into ONE hostname, and only the composition is the thing the
 * user's docker daemon has to resolve.
 */
const IMAGE_FN_SUB = {
  'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/my-repo:latest',
};

interface PseudoBag {
  accountId?: string | undefined;
  region?: string | undefined;
  partition?: string | undefined;
  urlSuffix?: string | undefined;
}

function resolveImageUri(pseudoParameters: PseudoBag | undefined): string {
  const result = substituteAgainstState(IMAGE_FN_SUB, {
    resources: {},
    pseudoParameters: pseudoParameters as never,
  });
  if (result.kind !== 'literal') {
    throw new Error(`image Fn::Sub did not resolve: ${result.reason}`);
  }
  return String(result.value);
}

describe('cdkd local invoke: --region case (issue #1795)', () => {
  const resolve = (region: string) =>
    resolvePseudoParametersForInvoke(undefined, { region } as never);

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1');
    const lower = await resolve('cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    // The suffix alone is only half the fix: the region value seeds every SDK
    // client the command builds (endpoint resolution is case-sensitive too) and
    // is substituted verbatim into every ARN.
    expect((await resolve('CN-NORTH-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('resolves the image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
    expect(resolveImageUri(upper)).toBe(resolveImageUri(lower));
  });
});

describe('cdkd local start-api: --region case (issue #1795)', () => {
  const resolve = (region: string, stateRegion = 'us-east-1') =>
    resolvePseudoParametersForStartApi(stateRegion, { region } as never);

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1', 'cn-north-1');
    const lower = await resolve('cn-north-1', 'cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    expect((await resolve('CN-NORTH-1', 'cn-north-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('canonicalizes an upper-cased STATE region too, not only --region', async () => {
    // The state record's region is the last of the four sources; folding only
    // the flag would leave this one raw.
    const bag = await resolvePseudoParametersForStartApi('CN-NORTH-1', {} as never);
    expect(bag?.region).toBe('cn-north-1');
    expect(bag?.urlSuffix).toBe('amazonaws.com.cn');
  });

  it('resolves the image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1', 'cn-north-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1', 'cn-north-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1', 'cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
  });
});

describe('cdkd local run-task: --region case (issue #1795)', () => {
  const resolve = async (region: string): Promise<PseudoBag | undefined> =>
    (await buildEcsImageResolutionContext(ecsStack(), undefined, { region } as never)).context
      ?.pseudoParameters;

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1');
    const lower = await resolve('cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    expect((await resolve('CN-NORTH-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('resolves the container image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
  });
});

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) item 1: `cdkd local
 * invoke --assume-role` resolves its STS region from a CHAIN, and the two
 * env-var fall-throughs are exactly the sources the handler-entry `--region`
 * fold cannot reach. So `AWS_REGION=CN-NORTH-1` with no `--region` handed the
 * RAW value both to the AssumeRole `STSClient` (case-sensitive endpoint
 * resolution → the COMMERCIAL `sts.CN-NORTH-1.amazonaws.com`) and to the
 * container's own `AWS_REGION`, i.e. to every SDK client the handler builds.
 *
 * `applyLambdaCredentialEnv` was extracted for this test, mirroring
 * `applyAgentCoreCredentialEnv` (the sibling issue #1814 fixed), so the STS
 * client's region is asserted directly instead of at one remove.
 */
describe('cdkd local invoke: --assume-role STS region case (issue #1836)', () => {
  const ROLE = 'arn:aws-cn:iam::123456789012:role/fn-exec';
  const primeAssumeRole = (): void => {
    stsMock.send.mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: 'ASIAEXAMPLE',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
      },
    }));
  };

  it('folds an upper-cased AWS_REGION for the STS client AND the container env', async () => {
    primeAssumeRole();
    process.env['AWS_REGION'] = 'CN-NORTH-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE });

    expect(stsClientConfigs).toEqual([{ region: 'cn-north-1' }]);
    // The FEARED shape, stated as its own assertion: an STSClient built with the
    // raw spelling silently talks to the commercial partition.
    expect(stsClientConfigs).not.toContainEqual({ region: 'CN-NORTH-1' });
    expect(env['AWS_REGION']).toBe('cn-north-1');
    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIAEXAMPLE');
  });

  it('folds an upper-cased AWS_DEFAULT_REGION (the last link of the chain)', async () => {
    primeAssumeRole();
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE });

    expect(stsClientConfigs).toEqual([{ region: 'cn-north-1' }]);
    expect(env['AWS_REGION']).toBe('cn-north-1');
  });

  it('folds an upper-cased region argument too (defence in depth vs the entry fold)', async () => {
    // `--region` arrives already folded from the handler entry, but this helper
    // must not DEPEND on that — it is exported and reachable on its own.
    primeAssumeRole();
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'CN-NORTH-1' });

    expect(stsClientConfigs).toEqual([{ region: 'cn-north-1' }]);
    expect(env['AWS_REGION']).toBe('cn-north-1');
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    primeAssumeRole();
    process.env['AWS_REGION'] = 'US-EAST-1';
    const upper: Record<string, string> = {};
    await applyLambdaCredentialEnv(upper, { assumeRoleArn: ROLE });
    const upperConfigs = [...stsClientConfigs];

    stsClientConfigs.length = 0;
    process.env['AWS_REGION'] = 'us-east-1';
    const lower: Record<string, string> = {};
    await applyLambdaCredentialEnv(lower, { assumeRoleArn: ROLE });

    expect(upperConfigs).toEqual([{ region: 'us-east-1' }]);
    expect(upperConfigs).toEqual(stsClientConfigs);
    expect(upper).toEqual(lower);
  });

  it('builds no region-bearing STS client when no region signal exists at all', async () => {
    // The chain can legitimately resolve to `undefined` (no flag, no env), and
    // the fold must pass that through rather than coerce it to a string — the
    // SDK's own region chain is the correct fallback there.
    primeAssumeRole();
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE });

    expect(stsClientConfigs).toEqual([{}]);
    expect(env['AWS_REGION']).toBeUndefined();
  });
});

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) review fix 4: the
 * DEFAULT path — no `--assume-role` — copies `AWS_REGION` /
 * `AWS_DEFAULT_REGION` into the container through `forwardAwsEnv`, and that copy
 * was raw. So the same `cdkd local invoke` yielded `cn-north-1` in the container
 * WITH `--assume-role` and `CN-NORTH-1` without, and the container's own SDK
 * clients (whose endpoint resolution is case-SENSITIVE) resolved the COMMERCIAL
 * partition on the path most users take.
 *
 * These cases also cover two arms of `applyLambdaCredentialEnv` nothing
 * exercised: the STS-failure `catch` (warn + dev-cred fallback) and the
 * no-assume-role ordering (`forwardAwsEnv` -> profile overlay -> creds file).
 * `local-invoke-profile-creds.test.ts` calls `applyProfileCredentialsOverlay`
 * directly, so it never saw the wrapper's composition.
 */
describe('cdkd local invoke: container AWS_REGION on the DEFAULT path (issue #1836)', () => {
  const DEV_CREDS = {
    AWS_ACCESS_KEY_ID: 'AKIADEVSHELL',
    AWS_SECRET_ACCESS_KEY: 'dev-secret',
    AWS_SESSION_TOKEN: 'dev-token',
  } as const;

  const setDevCreds = (): void => {
    for (const [k, v] of Object.entries(DEV_CREDS)) process.env[k] = v;
  };
  const clearDevCreds = (): void => {
    for (const k of Object.keys(DEV_CREDS)) delete process.env[k];
  };

  afterEach(() => {
    clearDevCreds();
  });

  it('folds an upper-cased AWS_REGION into the container env with NO --assume-role', async () => {
    process.env['AWS_REGION'] = 'US-EAST-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {});

    expect(env['AWS_REGION']).toBe('us-east-1');
    // The feared shape stated on its own: the raw spelling, which is what the
    // container's SDK clients then resolve endpoints from.
    expect(env['AWS_REGION']).not.toBe('US-EAST-1');
    // No STS client is built at all on this path.
    expect(stsClientConfigs).toEqual([]);
  });

  it('folds AWS_DEFAULT_REGION too, where the partition itself is at stake', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {});

    expect(env['AWS_DEFAULT_REGION']).toBe('cn-north-1');
  });

  it('folds BOTH region vars in one pass', async () => {
    process.env['AWS_REGION'] = 'CN-NORTH-1';
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTHWEST-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {});

    expect(env['AWS_REGION']).toBe('cn-north-1');
    expect(env['AWS_DEFAULT_REGION']).toBe('cn-northwest-1');
  });

  it('leaves already-canonical region vars byte-identical', async () => {
    process.env['AWS_REGION'] = 'cn-north-1';
    process.env['AWS_DEFAULT_REGION'] = 'cn-north-1';
    const canonical: Record<string, string> = {};
    await applyLambdaCredentialEnv(canonical, {});

    process.env['AWS_REGION'] = 'CN-NORTH-1';
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';
    const upper: Record<string, string> = {};
    await applyLambdaCredentialEnv(upper, {});

    // Asserted on the two region keys rather than on the WHOLE bag: a strict
    // `toEqual` over everything `forwardAwsEnv` copied depends on the ambient
    // shell carrying no `AWS_ACCESS_KEY_ID` — true only because a sibling
    // suite's `afterEach` deletes the ones it set, so this row failed when run
    // in isolation on a shell with exported credentials.
    expect(canonical['AWS_REGION']).toBe('cn-north-1');
    expect(canonical['AWS_DEFAULT_REGION']).toBe('cn-north-1');
    // The byte-identical claim, made key by key over the union of both bags so a
    // key present in only one of them cannot slip through.
    for (const key of new Set([...Object.keys(canonical), ...Object.keys(upper)])) {
      expect(upper[key], `env key ${key} diverged between the two spellings`).toBe(canonical[key]);
    }
  });

  it('copies the CREDENTIALS verbatim — only the region entries are folded', async () => {
    // The feared shape of an over-broad fix: lower-casing the whole pass-through
    // list would corrupt every forwarded credential (an AKID is case-SENSITIVE).
    setDevCreds();
    process.env['AWS_REGION'] = 'US-EAST-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {});

    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIADEVSHELL');
    expect(env['AWS_SESSION_TOKEN']).toBe('dev-token');
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('warns and falls back to the dev shell creds when AssumeRole FAILS', async () => {
    // The `catch` arm: a developer-loop tool degrades rather than hard-errors,
    // and the most common cause is a trust policy that does not name the dev.
    setDevCreds();
    process.env['AWS_REGION'] = 'US-EAST-1';
    stsMock.send.mockImplementation(async () => {
      throw new Error('AccessDenied: not authorized to sts:AssumeRole');
    });
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, { assumeRoleArn: 'arn:aws:iam::123456789012:role/fn' });

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('--assume-role: STS AssumeRole(arn:aws:iam::123456789012:role/fn)');
    expect(warned).toContain("Falling back to the developer's shell credentials");
    // Dev creds forwarded, and the region folded on THIS path too — the failure
    // arm lands in `forwardAwsEnv`, so a fold that lived only in the success arm
    // left the container raw exactly when the user is already debugging.
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIADEVSHELL');
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('applies forwardAwsEnv -> profile overlay -> creds file, in that order', async () => {
    // The ordering IS the behavior: the profile overlay must win over the
    // forwarded shell creds (issue #657's precedence table), and the
    // credentials-file env is additive on top of both.
    setDevCreds();
    process.env['AWS_REGION'] = 'US-EAST-1';
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profile-secret' },
      profileCredsFile: { containerPath: '/cdkd-aws/credentials', profileName: 'dev' },
    });

    // Overlay won over the forwarded value...
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('profile-secret');
    // ...and, the profile being long-lived, stripped the inherited session token.
    expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
    // ...while the creds-file env is additive.
    expect(env['AWS_SHARED_CREDENTIALS_FILE']).toBe('/cdkd-aws/credentials');
    expect(env['AWS_PROFILE']).toBe('dev');
    // ...and the region still folded (it is copied before the overlay runs, and
    // the overlay deliberately does not touch it).
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('reaches the profile overlay after an STS failure as well', async () => {
    // `--assume-role` + `--profile` together: the STS creds win when they
    // resolve, and the overlay is the documented fallback when they do not.
    stsMock.send.mockImplementation(async () => {
      throw new Error('AccessDenied');
    });
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {
      assumeRoleArn: 'arn:aws:iam::123456789012:role/fn',
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profile-secret' },
    });

    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
  });

  it('does NOT overlay the profile when AssumeRole SUCCEEDED', async () => {
    // The negative of the arm above, and the one a regression in the
    // `assumeSucceeded` flag would break: STS creds must not be clobbered.
    stsMock.send.mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: 'ASIASTS',
        SecretAccessKey: 'sts-secret',
        SessionToken: 'sts-token',
      },
    }));
    const env: Record<string, string> = {};

    await applyLambdaCredentialEnv(env, {
      assumeRoleArn: 'arn:aws:iam::123456789012:role/fn',
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profile-secret' },
      profileCredsFile: { containerPath: '/cdkd-aws/credentials', profileName: 'dev' },
    });

    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIASTS');
    expect(env['AWS_SHARED_CREDENTIALS_FILE']).toBeUndefined();
  });
});

/**
 * The three resolvers above cover the pseudo-parameter bag, but each command
 * ALSO hands `options.region` straight to SDK clients this file cannot reach
 * from a unit test — `applyRoleArnIfSet` / `assumeTaskRole` /
 * `loadBootstrapContainerRepo` in `local-run-task.ts`, and further down
 * `ecs-task-runner` -> `ecs-secrets-resolver`'s SecretsManager + SSM clients.
 * Folding once at the handler entry is what makes those canonical, so the
 * statement is pinned at source level (same pattern as the resource-timeout
 * registry seeding pin in tests/unit/provisioning/resource-timeout-registry.test.ts).
 */
describe('cdkd local *: --region is folded at the handler entry (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  // `local-invoke-agentcore.ts` was added by issue
  // [#1814](https://github.com/go-to-k/cdkd/issues/1814): it is the one
  // region-taking `cdkd local` command the #1795 sweep skipped, and its raw
  // `--region` reached three consumers that are case-SENSITIVE in the same
  // direction the partition table is — the SigV4 signing SCOPE (where
  // `--region` has the highest precedence), the `STSClient` endpoint
  // resolution, and `applyRoleArnIfSet`. None of those are reachable from a
  // unit test, which is exactly why the fold is pinned at source level here
  // rather than asserted through a behavior test.
  const FOLD = 'options.region = canonicalizeRegion(options.region)';
  const commandsDir = join(repoRoot, 'src', 'cli', 'commands');

  /**
   * LIVE lines only — a commented-out fold must FAIL this pin, not satisfy it,
   * and a JSDoc that merely MENTIONS `options.region` above the fold must not
   * false-fail the ordering check below.
   *
   * Comment lines are BLANKED rather than dropped, so indices stay aligned with
   * the real file and the failure message can quote a usable line number. Block
   * comments are blanked across their whole span for the same reason (the
   * sibling `intrinsic-image.test.ts` strips them instead — it reports no line
   * numbers, so it does not need the alignment).
   */
  const liveLinesOf = (file: string): string[] => {
    let inBlock = false;
    return readFileSync(join(commandsDir, file), 'utf8')
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart();
        if (inBlock) {
          if (trimmed.includes('*/')) inBlock = false;
          return '';
        }
        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlock = true;
          return '';
        }
        if (trimmed.startsWith('//')) return '';
        return line.replace(/\/\/.*$/, '');
      });
  };

  /**
   * DERIVED, not hand-listed. A hardcoded array cannot fail for a command that
   * does not exist yet — the same reason the #1814 binding proof sweeps `src/`
   * rather than naming its call sites. Every `local-*` command that READS
   * `options.region` must fold it; one that never reads it needs nothing.
   * (Measured 2026-08-13: exactly four do. `local-start-{cloudfront,service,alb}.ts`
   * read it zero times.)
   */
  const commands = readdirSync(commandsDir)
    .filter((f) => f.startsWith('local-') && f.endsWith('.ts'))
    .filter((f) => liveLinesOf(f).some((line) => line.includes('options.region')));

  it('the sweep found the commands it is supposed to check', () => {
    // Without a floor, a glob that matched nothing would pass every row below
    // vacuously — and this suite's whole job is to be non-vacuous.
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands).toContain('local-invoke-agentcore.ts');
  });

  it.each(commands)('%s canonicalizes options.region before using it', (file) => {
    const lines = liveLinesOf(file);
    const foldAt = lines.findIndex((line) => line.includes(FOLD));

    expect(foldAt, `${file}: live options.region canonicalization not found`).toBeGreaterThan(-1);

    /**
     * PRESENCE is not enough — the fold has to come FIRST. Moving it below
     * `applyRoleArnIfSet(...)` left every assertion green under the previous
     * `toContain` form, while the consumer this exists to protect went back to
     * receiving the raw value. So: no OTHER read of `options.region` may
     * precede the fold.
     */
    const firstOtherRead = lines.findIndex(
      (line, i) => i !== foldAt && line.includes('options.region')
    );

    if (firstOtherRead !== -1) {
      expect(
        foldAt,
        `${file}: options.region is read at line ${firstOtherRead + 1}, BEFORE the fold at line ${foldAt + 1}`
      ).toBeLessThan(firstOtherRead);
    }
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) item 2, pinned
   * the same way and for the same reason: `--stack-region`'s consumers are the
   * cdk-local CFn client's region and the S3 state read, neither reachable from
   * a unit test through the command.
   *
   * DERIVED from the flag DECLARATION, not from a read of `options.stackRegion`
   * — `local-invoke.ts` and `local-start-api.ts` never name the field, they hand
   * the whole options bag to `createLocalStateProvider`, so a read-based sweep
   * would have checked two of the four commands and reported green.
   */
  const STACK_REGION_FOLD = 'options.stackRegion = canonicalizeRegion(options.stackRegion)';
  const stackRegionCommands = readdirSync(commandsDir)
    .filter((f) => f.startsWith('local-') && f.endsWith('.ts'))
    .filter((f) => liveLinesOf(f).some((line) => line.includes("'--stack-region <region>'")));

  it('the sweep found every command that DECLARES --stack-region', () => {
    // Measured 2026-08-13: the four commands with their own handler. The engine
    // commands (start-service / start-alb / start-cloudfront / start-agentcore)
    // inherit the flag from cdk-local and declare it nowhere here — their fold
    // lives at the `--from-state` factory boundary instead, pinned by
    // `local-state-source-region-case.test.ts`.
    expect(stackRegionCommands.length).toBeGreaterThanOrEqual(4);
    expect(stackRegionCommands).toEqual(
      expect.arrayContaining([
        'local-invoke.ts',
        'local-start-api.ts',
        'local-run-task.ts',
        'local-invoke-agentcore.ts',
      ])
    );
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) review fix 5:
   * `local-run-task.ts` carries a FOURTH chain of the item-1 shape —
   * `consumerRegion`, which becomes the exports-index key
   * `cdkd/_index/{region}/exports.json` and the same-region filter of the
   * index-miss scan. It lives inside the command handler, so like the folds above
   * it is not reachable from a unit test; unlike them it is a CHAIN, so the pin is
   * derived from the ENV-VAR READS rather than from a single statement: EVERY
   * `process.env['AWS_REGION']` chain in this file must sit inside a
   * `canonicalizeRegion(...)` call.
   *
   * Scoped to this ONE file on purpose. `local-start-api.ts` has three chains of
   * the same shape that are still raw — accepted residual, filed as issue #1843 —
   * so a tree-wide sweep here would fail on another lane's open work rather than
   * on a regression in this one.
   */
  it('local-run-task.ts folds EVERY env-var region chain (issue #1836 item 5)', () => {
    // Statement granularity: the chains span several lines, so the live text is
    // re-joined and split on `;`. Every statement that READS an ambient region
    // env var must carry the fold.
    const statements = liveLinesOf('local-run-task.ts').join('\n').split(';');
    const chains = statements.filter(
      (s) => s.includes("process.env['AWS_REGION']") || s.includes("process.env['AWS_DEFAULT_REGION']")
    );

    // Floor first: a parse that finds nothing would pass every row below
    // vacuously. Measured 2026-08-13: two chains (`consumerRegion` and
    // `buildEcsImageResolutionContext`'s pseudo-parameter region).
    expect(chains.length).toBeGreaterThanOrEqual(2);

    for (const chain of chains) {
      expect(chain, `unfolded region chain in local-run-task.ts: ${chain.trim()}`).toContain(
        'canonicalizeRegion('
      );
    }
  });

  it.each(stackRegionCommands)('%s canonicalizes options.stackRegion at entry', (file) => {
    const lines = liveLinesOf(file);
    const foldAt = lines.findIndex((line) => line.includes(STACK_REGION_FOLD));

    expect(
      foldAt,
      `${file}: live options.stackRegion canonicalization not found`
    ).toBeGreaterThan(-1);

    // Same ordering rule as `--region`: no other read may precede the fold.
    // Three exclusions, each narrow on purpose:
    //   - the `.option('--stack-region <region>', ...)` registration, which
    //     reads nothing;
    //   - the fold's OWN guard line, matched by exact text rather than by
    //     "contains `!== undefined`" — the loose form would also skip a real
    //     `...(options.stackRegion !== undefined && { stackRegion: ... })`
    //     forward, which is precisely a read this pin must still catch;
    //   - the RAW CAPTURE (issue #1836 round 3), which by construction must read
    //     `options.stackRegion` BEFORE the fold and is asserted separately below.
    const isFoldGuard = (line: string): boolean =>
      line.trim() === 'if (options.stackRegion !== undefined) {';
    const isRawCapture = (line: string): boolean =>
      line.trim() === RAW_STACK_REGION_CAPTURE;
    const firstOtherRead = lines.findIndex(
      (line, i) =>
        i !== foldAt &&
        line.includes('options.stackRegion') &&
        !line.includes("'--stack-region <region>'") &&
        !isFoldGuard(line) &&
        !isRawCapture(line)
    );

    if (firstOtherRead !== -1) {
      expect(
        foldAt,
        `${file}: options.stackRegion is read at line ${firstOtherRead + 1}, BEFORE the fold at line ${foldAt + 1}`
      ).toBeLessThan(firstOtherRead);
    }
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 3: the fold
   * pinned above is what made the loader's exact-match rule PRODUCTION-DEAD —
   * every candidate reaching the state-record compare was already canonical, so
   * `--stack-region US-EAST-1` read the `us-east-1` record and the warning
   * called that the exact spelling. Each handler therefore captures the RAW
   * value first, and the capture has to come BEFORE the fold or it captures the
   * folded value and the rule is inert again while every test still passes.
   *
   * Pinned at source level for the same reason the folds are: neither statement
   * is reachable from a unit test through the command. The BEHAVIOR the pair
   * produces is fenced end to end in `local-from-state-stack-region.test.ts`.
   */
  const RAW_STACK_REGION_CAPTURE = 'options.rawStackRegion = options.stackRegion;';

  it.each(stackRegionCommands)('%s captures the RAW --stack-region before folding', (file) => {
    const lines = liveLinesOf(file);
    const captureAt = lines.findIndex((line) => line.trim() === RAW_STACK_REGION_CAPTURE);
    const foldAt = lines.findIndex((line) => line.includes(STACK_REGION_FOLD));

    expect(
      captureAt,
      `${file}: live '${RAW_STACK_REGION_CAPTURE}' not found — the state-record exact match cannot fire`
    ).toBeGreaterThan(-1);
    expect(
      captureAt,
      `${file}: the raw capture at line ${captureAt + 1} runs AFTER the fold at line ${foldAt + 1}, so it captures the FOLDED value`
    ).toBeLessThan(foldAt);
  });
});

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 4, fix 3: the
 * `rawStackRegion` DOC must name the consumers the code actually has.
 *
 * This is pinned rather than merely corrected because rounds 2 and 3 each shipped
 * a false comment about this exact field, and a comment is the only description
 * of a threading rule that spans four command files plus a shared loader —
 * nothing else says "and nothing ELSE may read this". So the doc is DERIVED
 * against the code the same way the fold sweeps above are: the file that calls
 * `loadBootstrapContainerRepo` must not claim the record match is the only
 * consumer, and the ones that do not call it may.
 *
 * The failing shape is the round-3 sentence verbatim, so a revert of the wording
 * fails this suite instead of passing it.
 */
describe('cdkd local: the rawStackRegion doc matches its real consumers (issue #1836 round 4)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const commandsDir = join(repoRoot, 'src', 'cli', 'commands');

  /**
   * The JSDoc block immediately above a `rawStackRegion?: string;` declaration,
   * flattened to ONE line. The per-line `*` continuation markers are stripped
   * BEFORE the join — leaving them in makes every assertion depend on where the
   * prose happens to wrap, so a reflow would fail the pin while the claim it
   * checks is unchanged.
   */
  const rawStackRegionDoc = (file: string): string => {
    const lines = readFileSync(join(commandsDir, file), 'utf8').split('\n');
    const declAt = lines.findIndex((line) => line.trim() === 'rawStackRegion?: string;');
    expect(declAt, `${file}: no rawStackRegion declaration found`).toBeGreaterThan(-1);
    let start = declAt - 1;
    while (start >= 0 && !lines[start]!.trim().startsWith('/**')) start -= 1;
    expect(start, `${file}: rawStackRegion carries no JSDoc block`).toBeGreaterThan(-1);
    return lines
      .slice(start, declAt)
      .map((line) => line.trim().replace(/^\/\*\*/, '').replace(/^\*\/$/, '').replace(/^\*/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  /** The round-3 claim, which is FALSE for any file that also feeds the marker probe. */
  const ONLY_RECORD_MATCH_CLAIM = 'Consumed ONLY by the state-record match';

  /**
   * The COMMAND files only — those that DECLARE the flag, i.e. the four with
   * their own handler. `local-state-loader.ts` and `local-state-source.ts` also
   * declare a `rawStackRegion` field but are not commands: the loader DEFINES
   * `loadBootstrapContainerRepo` (so a plain call-site grep would misfile it as a
   * caller) and is checked by its own row below, and the `--from-state` factory's
   * copy IS accurate (its provider only ever reaches `loadStateForStack`).
   */
  const declaringFiles = readdirSync(commandsDir)
    .filter((f) => f.startsWith('local-') && f.endsWith('.ts'))
    .filter((f) => {
      const src = readFileSync(join(commandsDir, f), 'utf8');
      return src.includes('rawStackRegion?: string;') && src.includes("'--stack-region <region>'");
    });

  const callsMarkerProbe = (file: string): boolean =>
    readFileSync(join(commandsDir, file), 'utf8').includes('loadBootstrapContainerRepo(');

  it('the sweep found the files it is supposed to check', () => {
    // Floor first: a glob that matched nothing would pass every row below
    // vacuously. Measured 2026-08-14: the four commands with their own handler,
    // and exactly ONE of them (`local-run-task.ts`) feeds the marker probe.
    expect(declaringFiles.length).toBeGreaterThanOrEqual(4);
    expect(declaringFiles).toEqual(
      expect.arrayContaining([
        'local-invoke.ts',
        'local-start-api.ts',
        'local-run-task.ts',
        'local-invoke-agentcore.ts',
      ])
    );
    expect(declaringFiles.filter(callsMarkerProbe)).toEqual(['local-run-task.ts']);
  });

  it.each(declaringFiles)('%s: the doc names every consumer the file actually has', (file) => {
    const doc = rawStackRegionDoc(file);

    if (callsMarkerProbe(file)) {
      // The round-3 shape, asserted as the regression's own text.
      expect(
        doc,
        `${file} feeds loadBootstrapContainerRepo, so "${ONLY_RECORD_MATCH_CLAIM}" is false`
      ).not.toContain(ONLY_RECORD_MATCH_CLAIM);
      expect(doc).toContain('loadBootstrapContainerRepo');
    } else {
      // The counter-case: these three copies ARE accurate, and stay pinned so
      // the correspondence is a rule rather than one file's exception.
      expect(doc).toContain(ONLY_RECORD_MATCH_CLAIM);
    }
  });

  /**
   * The shared loader's own copy of the doc. Round 3 claimed the raw spelling
   * "never reaches an SDK client, an endpoint, or an S3 key that is not a
   * record's own spelling" — but `loadBootstrapContainerRepo` builds
   * `cdkd-bootstrap/{RAW}.json`, a key no state record spells, as its SECOND
   * probe.
   */
  it('local-state-loader.ts admits the raw marker KEY the probe builds', () => {
    const doc = rawStackRegionDoc('local-state-loader.ts');

    expect(doc).not.toContain('or an S3 key that is not a record');
    expect(doc).toContain('cdkd-bootstrap/');
  });
});

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 3: the
 * `cdkd local run-task` cross-stack CONSUMER region, which had a source-level
 * co-occurrence pin and no behavioral test at all. The pin splits the file on
 * `;` and requires each env-var chain's chunk to contain `canonicalizeRegion(`,
 * which a `cond ? canonicalizeRegion(a) : process.env['AWS_REGION']` would also
 * satisfy — so it cannot show that the fold WRAPS the read.
 *
 * The value does THREE things (round 3's comment said two): it becomes the
 * exports-index KEY `cdkd/_index/{region}/exports.json`, the same-region filter
 * of the index-miss scan, and — via `SubstitutionContext.consumerRegion` —
 * cdk-local's DEFAULT producer region for an `Fn::GetStackOutput` carrying no
 * explicit `Region`, i.e. a third S3 key. All three want the STATE RECORD's own
 * spelling, which is what `local invoke` / `local invoke-agentcore` already pass
 * and this command did not; when no record was loaded it falls back to the env
 * chain (which must be FOLDED, since both env links escape the handler-entry
 * fold).
 */
describe('cdkd local run-task: cross-stack consumer region (issue #1836)', () => {
  it('prefers the state RECORD spelling over the env chain, verbatim', () => {
    // An upper-cased record is reachable: `loadStateForStack`'s exact-then-folded
    // match resolves one, and `loaded.region` is its own spelling. Folding it here
    // would key the index off an object no deploy wrote, and the index-miss
    // rebuild would then filter zero refs and PUT an empty index.
    process.env['AWS_REGION'] = 'eu-west-1';

    expect(resolveEcsConsumerRegion('US-EAST-1', {}, 'ap-northeast-1')).toBe('US-EAST-1');
  });

  it('keeps a canonical record spelling byte-identical', () => {
    expect(resolveEcsConsumerRegion('us-east-1', { region: 'eu-west-1' }, undefined)).toBe(
      'us-east-1'
    );
  });

  it('FOLDS an upper-cased AWS_REGION when no record was loaded', () => {
    // The shape the fold exists for: this env link never passes through the
    // handler-entry `--region` fold.
    process.env['AWS_REGION'] = 'US-EAST-1';

    expect(resolveEcsConsumerRegion(undefined, {}, undefined)).toBe('us-east-1');
  });

  it('FOLDS AWS_DEFAULT_REGION too, where the partition itself is at stake', () => {
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';

    expect(resolveEcsConsumerRegion(undefined, {}, undefined)).toBe('cn-north-1');
  });

  it('folds a raw --region as well (defence in depth vs the entry fold)', () => {
    expect(resolveEcsConsumerRegion(undefined, { region: 'CN-NORTH-1' }, undefined)).toBe(
      'cn-north-1'
    );
  });

  it('folds the synth-derived stack region, the fourth link', () => {
    expect(resolveEcsConsumerRegion(undefined, {}, 'US-EAST-1')).toBe('us-east-1');
  });

  it('honors the chain ORDER: --region beats both env vars, which beat synth', () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_DEFAULT_REGION'] = 'eu-central-1';

    expect(resolveEcsConsumerRegion(undefined, { region: 'us-west-2' }, 'ap-south-1')).toBe(
      'us-west-2'
    );
    expect(resolveEcsConsumerRegion(undefined, {}, 'ap-south-1')).toBe('eu-west-1');
    delete process.env['AWS_REGION'];
    expect(resolveEcsConsumerRegion(undefined, {}, 'ap-south-1')).toBe('eu-central-1');
  });

  it('falls back to us-east-1 with no signal at all', () => {
    expect(resolveEcsConsumerRegion(undefined, {}, undefined)).toBe('us-east-1');
  });

  it('leaves the whole canonical path byte-identical', () => {
    process.env['AWS_REGION'] = 'cn-north-1';

    expect(resolveEcsConsumerRegion(undefined, {}, undefined)).toBe('cn-north-1');
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 4, fix 4:
   * round 3's chain was `options.region ?? process.env['AWS_REGION'] ?? …`, so a
   * blank `--region ''` BEAT the env var and won the whole chain — yielding `''`
   * as the exports-index key AND (through `buildCrossStackResolver`) as the
   * bucket-resolution region, contradicting the blank-is-absent rule this branch
   * adopted at the four client boundaries. `||` on the flag link closes it.
   */
  describe('a blank --region is ABSENT, not a winning empty answer (round 4)', () => {
    it('lets AWS_REGION win over --region "" (the shape the regression emits: "")', () => {
      process.env['AWS_REGION'] = 'US-EAST-1';

      const got = resolveEcsConsumerRegion(undefined, { region: '' }, undefined);

      // Negative first, stated as the regression's own output: `??` returned `''`.
      expect(got).not.toBe('');
      expect(got).toBe('us-east-1');
    });

    it('falls through a blank --region to AWS_DEFAULT_REGION as well', () => {
      process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';

      expect(resolveEcsConsumerRegion(undefined, { region: '' }, undefined)).toBe('cn-north-1');
    });

    it('falls through a blank --region to the synth region, then to the default', () => {
      expect(resolveEcsConsumerRegion(undefined, { region: '' }, 'AP-SOUTH-1')).toBe('ap-south-1');
      expect(resolveEcsConsumerRegion(undefined, { region: '' }, undefined)).toBe('us-east-1');
    });

    it('still lets a NON-blank --region win, so the fix is not a demotion', () => {
      // The other polarity: `||` must not have cost the flag its precedence.
      process.env['AWS_REGION'] = 'eu-west-1';

      expect(resolveEcsConsumerRegion(undefined, { region: 'us-west-2' }, undefined)).toBe(
        'us-west-2'
      );
    });

    it('still prefers a state RECORD over a blank flag, verbatim', () => {
      expect(resolveEcsConsumerRegion('US-EAST-1', { region: '' }, undefined)).toBe('US-EAST-1');
    });
  });
});

/**
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 3, fix 4: the
 * unfixed twin of `local-invoke.ts`'s default-path container region.
 *
 * `applyAgentCoreCredentialEnv` folds `stsRegion` in its `--assume-role` arm
 * (issue #1814), but its default arm's `forwardAwsEnv` copied `AWS_REGION`
 * VERBATIM — so `cdkd local invoke-agentcore` with `AWS_REGION=CN-NORTH-1` gave
 * the container `cn-north-1` WITH `--assume-role` and `CN-NORTH-1` without, i.e.
 * the exact asymmetry `local-invoke.ts`'s own comment describes. The value lands
 * in every SDK client the agent builds, and SDK endpoint resolution is
 * case-SENSITIVE.
 */
describe('cdkd local invoke-agentcore: container AWS_REGION on the DEFAULT path (issue #1836)', () => {
  const DEV_CREDS = {
    AWS_ACCESS_KEY_ID: 'AKIADEVSHELL',
    AWS_SECRET_ACCESS_KEY: 'dev-secret',
    AWS_SESSION_TOKEN: 'dev-token',
  } as const;

  afterEach(() => {
    for (const k of Object.keys(DEV_CREDS)) delete process.env[k];
  });

  it('folds an upper-cased AWS_REGION with NO --assume-role', async () => {
    process.env['AWS_REGION'] = 'US-EAST-1';
    const env: Record<string, string> = {};

    await applyAgentCoreCredentialEnv(env, {});

    expect(env['AWS_REGION']).toBe('us-east-1');
    // The feared shape stated on its own — what the container's SDK clients
    // resolve endpoints from.
    expect(env['AWS_REGION']).not.toBe('US-EAST-1');
    // No STS client is built at all on this path.
    expect(stsClientConfigs).toEqual([]);
  });

  it('folds AWS_DEFAULT_REGION too, where the partition itself is at stake', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'CN-NORTH-1';
    const env: Record<string, string> = {};

    await applyAgentCoreCredentialEnv(env, {});

    expect(env['AWS_DEFAULT_REGION']).toBe('cn-north-1');
  });

  it('agrees with the --assume-role arm for the same shell (the asymmetry closed)', async () => {
    // The defect was not "the value is wrong" but "the value depends on a flag
    // that has nothing to do with the region", so the assertion is the two arms
    // AGREEING.
    process.env['AWS_REGION'] = 'CN-NORTH-1';
    stsMock.send.mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: 'ASIAASSUMED',
        SecretAccessKey: 'assumed-secret',
        SessionToken: 'assumed-token',
      },
    }));

    const withAssume: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(withAssume, {
      assumeRoleArn: 'arn:aws:iam::123456789012:role/AgentRole',
    });
    const withoutAssume: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(withoutAssume, {});

    expect(withAssume['AWS_REGION']).toBe('cn-north-1');
    expect(withoutAssume['AWS_REGION']).toBe(withAssume['AWS_REGION']);
  });

  it('copies the CREDENTIALS verbatim — only the region entries are folded', async () => {
    // The feared shape of an over-broad fix: lower-casing the whole pass-through
    // list would corrupt every forwarded credential (an AKID is case-SENSITIVE).
    for (const [k, v] of Object.entries(DEV_CREDS)) process.env[k] = v;
    process.env['AWS_REGION'] = 'US-EAST-1';
    const env: Record<string, string> = {};

    await applyAgentCoreCredentialEnv(env, {});

    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIADEVSHELL');
    expect(env['AWS_SESSION_TOKEN']).toBe('dev-token');
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('leaves already-canonical region vars byte-identical', async () => {
    process.env['AWS_REGION'] = 'cn-north-1';
    process.env['AWS_DEFAULT_REGION'] = 'cn-north-1';
    const env: Record<string, string> = {};

    await applyAgentCoreCredentialEnv(env, {});

    expect(env['AWS_REGION']).toBe('cn-north-1');
    expect(env['AWS_DEFAULT_REGION']).toBe('cn-north-1');
  });
});
